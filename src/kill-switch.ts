/**
 * kill-switch — M2.3: the on-chain, non-custodial kill switch.
 *
 * A hybrid's authority is a MemWal delegate key that its HUMAN OWNER granted.
 * The owner can revoke it at any time (`remove_delegate_key`) — instantly
 * demoting the agent from HYBRID back to AUTONOMOUS, so it loses the hybrid tier
 * and any access that rode on it. No custodian and no server in the loop: the
 * kill switch IS the owner's on-chain authority, and a counterparty sees the
 * effect immediately because classification reads the live delegate set.
 *
 * Proves: hybrid → KILL (revoke) → autonomous → RESTORE (re-grant).
 *
 *   node --import tsx src/kill-switch.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { getClient, loadKeypair, ensureGas, short } from "./lib.js";
import { classifyCaller, MEMWAL_PACKAGE_ID, type CallerKind } from "./caller-kind.js";

const PKG = MEMWAL_PACKAGE_ID;
const CLOCK = "0x6";
const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

async function sharedAccountRef(client: any, id: string) {
  const o = await client.getObject({ id, options: { showOwner: true } });
  const initialSharedVersion = Number(o?.data?.owner?.Shared?.initial_shared_version);
  if (!initialSharedVersion) throw new Error(`${id} is not shared`);
  return { objectId: id, initialSharedVersion, mutable: true as const };
}

/** Poll classifyCaller until it reports `want` (tolerates RPC read lag), else the last seen. */
async function waitKind(addr: string, accountId: string, want: CallerKind, tries = 20): Promise<CallerKind> {
  let last: CallerKind = "autonomous";
  for (let i = 0; i < tries; i++) {
    last = (await classifyCaller(addr, { memwalAccountId: accountId })).kind;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

async function main() {
  const client = getClient("sui:testnet");
  const owner = loadKeypair("verified-agent"); // the PoR human who granted the delegate
  const body = loadKeypair("agent-body");       // the hybrid agent
  const bodyAddr = body.toSuiAddress();
  const pubkey = Array.from(body.getPublicKey().toRawBytes());

  const acctFile = path.join(secretsDir, "hybrid-account.json");
  if (!fs.existsSync(acctFile)) throw new Error("run `node --import tsx src/setup-hybrid.ts` first");
  const accountId = JSON.parse(fs.readFileSync(acctFile, "utf8")).accountId as string;
  const accRef = await sharedAccountRef(client, accountId);

  console.log(`\n  Kill switch — on-chain, non-custodial (owner ${short(owner.toSuiAddress())} controls agent ${short(bodyAddr)})\n`);
  await ensureGas(client, owner.toSuiAddress());

  const before = (await classifyCaller(bodyAddr, { memwalAccountId: accountId })).kind;
  console.log(`  before      : agent classifies ${before.toUpperCase()}`);
  if (before !== "hybrid") console.log(`    (expected HYBRID — run setup-hybrid.ts if this is AUTONOMOUS)`);

  // ── KILL: owner revokes the delegate key ──────────────────────────────────
  {
    const tx = new Transaction();
    tx.setSender(owner.toSuiAddress());
    tx.moveCall({
      target: `${PKG}::account::remove_delegate_key`,
      arguments: [tx.sharedObjectRef(accRef), tx.pure.vector("u8", pubkey)],
    });
    const res: any = await client.signAndExecuteTransaction({ transaction: tx, signer: owner, options: { showEffects: true } });
    if (res.effects?.status?.status !== "success") throw new Error(`revoke failed: ${JSON.stringify(res.effects?.status)}`);
    console.log(`  KILL        : owner revoked the delegate (tx ${short(res.digest)})`);
  }
  const afterKill = await waitKind(bodyAddr, accountId, "autonomous");
  console.log(`  after kill  : agent classifies ${afterKill.toUpperCase()}${afterKill === "autonomous" ? "  ← demoted; hybrid tier revoked" : ""}`);

  // ── RESTORE: owner re-grants the delegate (keep the fixture usable) ────────
  {
    const tx = new Transaction();
    tx.setSender(owner.toSuiAddress());
    tx.moveCall({
      target: `${PKG}::account::add_delegate_key`,
      arguments: [tx.sharedObjectRef(accRef), tx.pure.vector("u8", pubkey), tx.pure.address(bodyAddr), tx.pure.string("agent-body"), tx.object(CLOCK)],
    });
    const res: any = await client.signAndExecuteTransaction({ transaction: tx, signer: owner, options: { showEffects: true } });
    if (res.effects?.status?.status !== "success") throw new Error(`restore failed: ${JSON.stringify(res.effects?.status)}`);
    console.log(`  RESTORE     : owner re-granted the delegate (tx ${short(res.digest)})`);
  }
  const afterRestore = await waitKind(bodyAddr, accountId, "hybrid");
  console.log(`  after restore: agent classifies ${afterRestore.toUpperCase()}${afterRestore === "hybrid" ? "  ← reinstated" : ""}\n`);

  const pass = before === "hybrid" && afterKill === "autonomous" && afterRestore === "hybrid";
  console.log(pass ? "  ✓ kill switch works: the human owner alone flips the agent's authority, on-chain.\n" : "  ✗ unexpected sequence — see above.\n");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("\n  kill-switch failed:", e?.message ?? e, "\n");
  process.exit(1);
});
