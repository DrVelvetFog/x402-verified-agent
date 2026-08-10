/**
 * setup-hybrid — stand up a REAL positive-hybrid fixture on Sui testnet.
 *
 * A "hybrid" caller is an agent key that is an authorized delegate of a
 * MemWalAccount whose OWNER holds PoR. We build exactly that:
 *
 *   owner       = the `verified-agent` demo key (already holds PoR L0)
 *   account     = a MemWalAccount created + owned by that key
 *   agent-body  = a fresh Ed25519 key added as a delegate of that account
 *
 * Then classifyCaller(agent-body, {memwalAccountId: account}) === "hybrid".
 * Idempotent: persists the account id under .secrets/ and reuses it.
 *
 *   node --import tsx src/setup-hybrid.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getClient, loadKeypair, ensureGas, short } from "./lib.js";
import { classifyCaller, MEMWAL_PACKAGE_ID } from "./caller-kind.js";

const PKG = MEMWAL_PACKAGE_ID;
const REGISTRY = process.env.MEMWAL_REGISTRY_ID ?? "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";
const REGISTRY_INIT_VERSION = Number(process.env.MEMWAL_REGISTRY_INIT_VERSION ?? "800466325");
const CLOCK = "0x6";

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const acctFile = path.join(secretsDir, "hybrid-account.json");

async function initialSharedVersion(client: any, id: string): Promise<number> {
  const o = await client.getObject({ id, options: { showOwner: true } });
  const shared = o?.data?.owner?.Shared;
  if (!shared) throw new Error(`${id} is not a shared object`);
  return Number(shared.initial_shared_version);
}

async function main() {
  const client = getClient("sui:testnet");
  const owner = loadKeypair("verified-agent");     // PoR human
  const agentBody = loadKeypair("agent-body");     // the hybrid caller (delegate)
  const ownerAddr = owner.toSuiAddress();
  const bodyAddr = agentBody.toSuiAddress();

  console.log(`\n  Setting up a positive-hybrid fixture on testnet`);
  console.log(`    owner (PoR human) : ${ownerAddr}`);
  console.log(`    agent-body (delegate): ${bodyAddr}\n`);

  await ensureGas(client, ownerAddr);

  // ── 1. account: reuse persisted, else create_account ──────────────────────
  let accountId: string | undefined;
  if (fs.existsSync(acctFile)) {
    accountId = JSON.parse(fs.readFileSync(acctFile, "utf8")).accountId;
    console.log(`  · reusing MemWalAccount ${short(accountId!)} (from .secrets)`);
  } else {
    const tx = new Transaction();
    tx.setSender(ownerAddr);
    tx.moveCall({
      target: `${PKG}::account::create_account`,
      arguments: [
        tx.sharedObjectRef({ objectId: REGISTRY, initialSharedVersion: REGISTRY_INIT_VERSION, mutable: true }),
        tx.object(CLOCK),
      ],
    });
    const res: any = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: owner,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (res.effects?.status?.status !== "success") {
      throw new Error(`create_account failed: ${res.effects?.status?.error ?? JSON.stringify(res.effects?.status)}`);
    }
    const created = (res.objectChanges ?? []).find(
      (c: any) => c.type === "created" && String(c.objectType).endsWith("::account::MemWalAccount"),
    );
    accountId = created?.objectId;
    if (!accountId) throw new Error("could not find created MemWalAccount in objectChanges");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(acctFile, JSON.stringify({ accountId, owner: ownerAddr }, null, 2));
    console.log(`  ✓ created MemWalAccount ${short(accountId)} (owned by PoR human)`);
  }

  // ── 2. delegate: add agent-body if not already a delegate ─────────────────
  const acc = await client.getObject({ id: accountId!, options: { showContent: true } });
  const dks: any[] = (acc?.data?.content as any)?.fields?.delegate_keys ?? [];
  const already = dks.some(
    (k) => (k?.fields?.sui_address ?? k?.sui_address ?? "").toLowerCase() === bodyAddr.toLowerCase(),
  );
  if (already) {
    console.log(`  · agent-body already a delegate`);
  } else {
    const accVersion = await initialSharedVersion(client, accountId!);
    const pubkey = Array.from(agentBody.getPublicKey().toRawBytes()); // 32-byte Ed25519
    const tx = new Transaction();
    tx.setSender(ownerAddr);
    tx.moveCall({
      target: `${PKG}::account::add_delegate_key`,
      arguments: [
        tx.sharedObjectRef({ objectId: accountId!, initialSharedVersion: accVersion, mutable: true }),
        tx.pure.vector("u8", pubkey),
        tx.pure.address(bodyAddr),
        tx.pure.string("agent-body"),
        tx.object(CLOCK),
      ],
    });
    const res: any = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: owner,
      options: { showEffects: true },
    });
    if (res.effects?.status?.status !== "success") {
      throw new Error(`add_delegate_key failed: ${res.effects?.status?.error ?? JSON.stringify(res.effects?.status)}`);
    }
    console.log(`  ✓ added agent-body as delegate (tx ${short(res.digest)})`);
  }

  // ── 3. prove: the agent-body now classifies as HYBRID ─────────────────────
  console.log(`\n  Verifying classification…`);
  const cls = await classifyCaller(bodyAddr, { memwalAccountId: accountId });
  const ok = cls.kind === "hybrid";
  console.log(`  ${ok ? "✓" : "✗"} agent-body → ${cls.kind.toUpperCase()}  (${cls.reason})`);
  console.log(`\n  For the demo / kind-check:`);
  console.log(`    HYBRID_ACCOUNT=${accountId}`);
  console.log(`    HYBRID_DELEGATE=${bodyAddr}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("\n  setup-hybrid failed:", e?.message ?? e, "\n");
  process.exit(1);
});
