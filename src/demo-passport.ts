/**
 * demo-passport — Agent Passport caller-type pricing, END TO END on Sui testnet.
 *
 * One seller, three callers. Each is classified on-chain by Kind and pays a
 * DIFFERENT price; every payment is settled through the facilitator and the net
 * is recomputed on-chain by the seller before serving.
 *
 *   human       (verified-agent key, holds PoR)          → cheapest
 *   hybrid      (agent-body, delegate of a PoR human)     → middle  (+ MEMWAL-ACCOUNT header)
 *   autonomous  (unverified-agent, no human in its graph) → full
 *
 * Prereq: run `node --import tsx src/setup-hybrid.ts` once (creates the hybrid).
 *
 *   node --env-file=.env --import tsx src/demo-passport.ts
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
import type { CallerKind } from "./caller-kind.js";
import { verifyAttestation } from "./governor.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const PRICES: Record<CallerKind, string> = { human: "200000", hybrid: "500000", autonomous: "1000000" };

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

/** Pricing-aware buy: pick the tier for my Kind, pay it, (hybrid) present the account hint. */
async function buyAsKind(
  url: string,
  client: SuiJsonRpcClient,
  payer: Ed25519Keypair,
  myKind: CallerKind,
  memwalAccount: string | undefined,
  onStep: (m: string) => void,
): Promise<{ served: boolean; status: number; passport?: any; digest?: string; error?: string; sigOk?: boolean; by?: string }> {
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const h = first.headers.get("payment-required");
  const body: any = h ? decodeHeader(h) : await first.json();
  const req: Requirements =
    (body.accepts as Requirements[]).find((a) => (a.extra as any)?.callerKind === myKind) ?? body.accepts[0];
  onStep(`402 — ${(body.accepts as any[]).length} tiers offered; paying the ${myKind} tier: ${req.amount} MIST`);

  const payload = await buildPayment(client, payer, req.payTo, BigInt(req.amount));
  const paymentPayload = { x402Version: 2, resource: body.resource, accepted: req, payload };
  const headers: Record<string, string> = { "payment-signature": encodeHeader(paymentPayload) };
  if (memwalAccount) headers["memwal-account"] = memwalAccount;

  const paid = await fetch(url, { headers });
  if (paid.status === 200) {
    const ph = paid.headers.get("agent-passport");
    const sig = paid.headers.get("agent-passport-sig");
    const by = paid.headers.get("agent-passport-by");
    const rh = paid.headers.get("payment-response");
    let passport: any = ph ? decodeHeader(ph) : {};
    let sigOk: boolean | undefined;
    if (ph && sig && by) {
      const v = await verifyAttestation({ payload: ph, sig, by });
      sigOk = v.ok;
      passport = v.attestation;
    }
    const settle: any = rh ? decodeHeader(rh) : {};
    const sigNote = sigOk === undefined ? " · attestation UNSIGNED" : ` · attestation sig ${sigOk ? "✓ verified" : "✗ INVALID"}`;
    onStep(`200 OK — served as ${String(passport.kind).toUpperCase()}, settled ${short(settle.transaction ?? "")}${sigNote}`);
    return { served: true, status: 200, passport, digest: settle.transaction, sigOk, by: by ?? undefined };
  }
  const err: any = await paid.json().catch(() => ({}));
  onStep(`${paid.status} — ${err.error ?? "rejected"}`);
  return { served: false, status: paid.status, error: err.error };
}

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");

  const acctFile = path.join(secretsDir, "hybrid-account.json");
  if (!fs.existsSync(acctFile)) throw new Error("run `node --import tsx src/setup-hybrid.ts` first to create the hybrid");
  const hybridAccount = JSON.parse(fs.readFileSync(acctFile, "utf8")).accountId as string;

  console.log(`\n╔══ AGENT PASSPORT · caller-type pricing on ${NETWORK} ══╗`);
  console.log(`  One resource. Price depends on WHAT you are — human, hybrid, or autonomous —`);
  console.log(`  classified on-chain from the PoR + MemWal identity graph. facilitator ${FACILITATOR}`);
  console.log(`  tiers: human ${PRICES.human} · hybrid ${PRICES.hybrid} · autonomous ${PRICES.autonomous} MIST SUI\n`);

  const srv = await startVerifiedSeller(
    {
      facilitatorUrl: FACILITATOR, network: NETWORK, asset: SUI, amount: PRICES.autonomous,
      payTo: seller.toSuiAddress(), prices: PRICES, requireUnique: false, signer: seller,
      resource: { url: "http://seller/premium", description: "premium data feed", mimeType: "application/json" },
      data: { alpha: "agents that remember compound", servedAt: new Date().toISOString() },
    },
    (m) => console.log(`         · ${m}`),
  );

  const callers: Array<{ name: string; kp: Ed25519Keypair; kind: CallerKind; hint?: string }> = [
    { name: "agent A — verified human", kp: loadKeypair("verified-agent"), kind: "human" },
    { name: "agent B — hybrid (human-piloted)", kp: loadKeypair("agent-body"), kind: "hybrid", hint: hybridAccount },
    { name: "agent C — autonomous bot", kp: loadKeypair("unverified-agent"), kind: "autonomous" },
  ];
  for (const c of callers) await ensureGas(client, c.kp.toSuiAddress());

  console.log(`▌ three callers, one resource, three prices\n`);
  for (const c of callers) {
    console.log(`  ${c.name}  (${short(c.kp.toSuiAddress())})`);
    const r = await buyAsKind(`${srv.url}/premium`, client, c.kp, c.kind, c.hint, (m) => console.log(`      ${m}`));
    if (r.served) {
      console.log(`    → ✅ ${String(r.passport.kind).toUpperCase()} · paid ${PRICES[r.passport.kind as CallerKind]} MIST · net ${r.passport.recomputedNet} recomputed on-chain`);
      if (r.passport.human) console.log(`       human behind it: ${short(r.passport.human)}${r.passport.porLevel !== undefined ? ` (PoR L${r.passport.porLevel})` : ""}`);
      console.log(`       governor: attestation ${r.sigOk ? "✓ signed + verified" : "✗ signature INVALID"} by seller ${short(r.by ?? "")}`);
      console.log(`       ${explorerUrl(NETWORK, r.digest!)}\n`);
    } else {
      console.log(`    → ⛔ ${r.status} — ${r.error}\n`);
    }
  }

  await srv.close();
  console.log(`╚══ same resource, three prices — set by verifiable Kind, not by trust ══╝\n`);
}

main().catch((e) => {
  console.error("\n  demo-passport failed:", e?.message ?? e, "\n");
  process.exit(1);
});
