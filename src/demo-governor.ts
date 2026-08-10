/**
 * demo-governor — M2.2: the human-signed spending policy, enforced on-chain-of-trust.
 *
 * The agent's human owner signs a GovernorPolicy (spend cap + approval threshold)
 * and, for higher-value calls, a standing approval. The seller enforces it BEFORE
 * settlement — and crucially, only honors a policy signed by the very human the
 * classifier proved is behind the agent (the on-chain MemWal owner). A blocked
 * call never settles (costs nothing).
 *
 * Prereq: `node --import tsx src/setup-hybrid.ts` (creates the hybrid).
 *
 *   node --import tsx src/demo-governor.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  getClient, loadKeypair, ensureGas, SUI, short, explorerUrl,
  buildPayment, encodeHeader, decodeHeader, type Requirements,
} from "./lib.js";
import { startVerifiedSeller } from "./verified-seller.js";
import { signPolicy, signApproval, verifyAttestation, type SignedAttestation } from "./governor.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const PRICES = { human: "200000", hybrid: "500000", autonomous: "1000000" } as const;
const RESOURCE_URL = "http://seller/premium";
const NOW = Date.now();
const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

function govHeaders(policy?: SignedAttestation, approval?: SignedAttestation): Record<string, string> {
  const h: Record<string, string> = {};
  if (policy) Object.assign(h, { "governor-policy": policy.payload, "governor-policy-sig": policy.sig, "governor-policy-by": policy.by });
  if (approval) Object.assign(h, { "governor-approval": approval.payload, "governor-approval-sig": approval.sig, "governor-approval-by": approval.by });
  return h;
}

async function call(
  url: string, client: SuiJsonRpcClient, payer: Ed25519Keypair,
  memwalAccount: string, extra: Record<string, string>,
): Promise<{ served: boolean; status: number; governor?: any; error?: string; digest?: string }> {
  const first = await fetch(url);
  const body: any = decodeHeader(first.headers.get("payment-required")!);
  const req: Requirements = (body.accepts as Requirements[]).find((a) => (a.extra as any)?.callerKind === "hybrid")!;
  const payload = await buildPayment(client, payer, req.payTo, BigInt(req.amount));
  const headers: Record<string, string> = {
    "payment-signature": encodeHeader({ x402Version: 2, resource: body.resource, accepted: req, payload }),
    "memwal-account": memwalAccount,
    ...extra,
  };
  const paid = await fetch(url, { headers });
  if (paid.status === 200) {
    const v = await verifyAttestation({
      payload: paid.headers.get("agent-passport")!, sig: paid.headers.get("agent-passport-sig")!, by: paid.headers.get("agent-passport-by")!,
    });
    const settle: any = decodeHeader(paid.headers.get("payment-response")!);
    return { served: true, status: 200, governor: v.attestation.governor, digest: settle.transaction };
  }
  const err: any = await paid.json().catch(() => ({}));
  return { served: false, status: paid.status, error: err.error };
}

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");
  const owner = loadKeypair("verified-agent"); // the human behind the agent
  const body = loadKeypair("agent-body");        // the hybrid agent
  const bodyAddr = body.toSuiAddress();

  const acctFile = path.join(secretsDir, "hybrid-account.json");
  if (!fs.existsSync(acctFile)) throw new Error("run `node --import tsx src/setup-hybrid.ts` first");
  const account = JSON.parse(fs.readFileSync(acctFile, "utf8")).accountId as string;
  await ensureGas(client, bodyAddr);

  const srv = await startVerifiedSeller(
    {
      facilitatorUrl: FACILITATOR, network: NETWORK, asset: SUI, amount: PRICES.autonomous,
      payTo: seller.toSuiAddress(), prices: { ...PRICES }, requireUnique: false,
      signer: seller, requireGovernor: true,
      resource: { url: RESOURCE_URL, description: "premium data feed", mimeType: "application/json" },
      data: { alpha: "governed access" },
    },
    (m) => console.log(`         · ${m}`),
  );
  const url = `${srv.url}/premium`;
  const HYBRID = BigInt(PRICES.hybrid); // 500000

  // Policies + approval signed by the owner (the proven human behind the agent).
  const goodPolicy = await signPolicy(owner, { agent: bodyAddr, spendCapMist: "600000", approvalThresholdMist: "400000", killAuthority: owner.toSuiAddress(), issuedAtMs: NOW });
  const tightPolicy = await signPolicy(owner, { agent: bodyAddr, spendCapMist: "400000", approvalThresholdMist: "400000", killAuthority: owner.toSuiAddress(), issuedAtMs: NOW });
  const approval = await signApproval(owner, { agent: bodyAddr, resource: RESOURCE_URL, maxAmountMist: "500000", issuedAtMs: NOW });
  // An impostor policy signed by someone who ISN'T the agent's human.
  const impostorPolicy = await signPolicy(new Ed25519Keypair(), { agent: bodyAddr, spendCapMist: "9999999", approvalThresholdMist: "9999999", killAuthority: bodyAddr, issuedAtMs: NOW });

  console.log(`\n╔══ GOVERNOR · human-signed spending policy, enforced before settlement ══╗`);
  console.log(`  agent ${short(bodyAddr)} · human ${short(owner.toSuiAddress())} · hybrid price ${HYBRID} MIST`);
  console.log(`  requireGovernor=true — a call needs a valid policy from the agent's proven human.\n`);

  const cases: Array<{ label: string; extra: Record<string, string>; expectServed: boolean }> = [
    { label: "policy (cap 600k, thr 400k) + human approval → within cap, approved", extra: govHeaders(goodPolicy, approval), expectServed: true },
    { label: "policy but NO approval on a call above the 400k threshold", extra: govHeaders(goodPolicy), expectServed: false },
    { label: "tighter policy (cap 400k) — 500k call exceeds the spend cap", extra: govHeaders(tightPolicy, approval), expectServed: false },
    { label: "no policy presented at all (requireGovernor)", extra: {}, expectServed: false },
    { label: "policy signed by an IMPOSTOR (not the agent's proven human)", extra: govHeaders(impostorPolicy, approval), expectServed: false },
  ];

  let allOk = true;
  for (const c of cases) {
    const r = await call(url, client, body, account, c.extra);
    const ok = r.served === c.expectServed;
    allOk = allOk && ok;
    console.log(`  ${ok ? "✓" : "✗"} ${c.label}`);
    if (r.served) {
      console.log(`      → 200 SERVED · governor spendCapOk=${r.governor?.spendCapOk} approvalOk=${r.governor?.approvalOk} · policy by ${short(r.governor?.policyBy ?? "")}`);
      console.log(`        settled ${explorerUrl(NETWORK, r.digest!)}`);
    } else {
      console.log(`      → ${r.status} BLOCKED before settlement · ${r.error}`);
    }
    console.log();
  }

  await srv.close();
  console.log(allOk ? "╚══ governor enforced: only a call within a policy signed by the agent's proven human settles ══╝\n" : "╚══ MISMATCH — see above ══╝\n");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("\n  demo-governor failed:", e?.message ?? e, "\n");
  process.exit(1);
});
