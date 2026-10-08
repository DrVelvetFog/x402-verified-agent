/**
 * plummy-passport — Agent Passport for Plummy, the Mac assistant.
 *
 * Plummy is a "hybrid" caller in the Agent Passport taxonomy: an agent key
 * that is an authorized delegate of a MemWalAccount whose OWNER holds PoR.
 * This script gives her that identity and lets her present it:
 *
 *   setup         create/load Plummy's key, bind it as a delegate of a
 *                 MemWalAccount owned by the PoR human key (idempotent)
 *   show          classify Plummy's key and print her passport as JSON
 *   verify-human  check the human behind her holds a live PoR credential
 *
 * Output is a single JSON object on stdout (the Mac app parses it).
 *
 *   node --import tsx src/plummy-passport.ts <setup|show|verify-human>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { getClient, loadKeypair, ensureGas } from "./lib.js";
import { classifyCaller, MEMWAL_PACKAGE_ID } from "./caller-kind.js";
import { checkPersonhood, levelName } from "./por-gate.js";

const REGISTRY =
  process.env.MEMWAL_REGISTRY_ID ?? "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";
const REGISTRY_INIT_VERSION = Number(process.env.MEMWAL_REGISTRY_INIT_VERSION ?? "800466325");
const CLOCK = "0x6";

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const passportFile = path.join(secretsDir, "plummy-passport.json");

async function initialSharedVersion(client: any, id: string): Promise<number> {
  const o = await client.getObject({ id, options: { showOwner: true } });
  const shared = o?.data?.owner?.Shared;
  if (!shared) throw new Error(`${id} is not a shared object`);
  return Number(shared.initial_shared_version);
}

async function setup() {
  const client = getClient("sui:testnet");
  const owner = loadKeypair("verified-agent"); // the PoR human behind Plummy
  const plummy = loadKeypair("plummy"); // created + persisted on first use
  const ownerAddr = owner.toSuiAddress();
  const plummyAddr = plummy.toSuiAddress();

  await ensureGas(client, ownerAddr);

  let accountId: string | undefined;
  if (fs.existsSync(passportFile)) {
    accountId = JSON.parse(fs.readFileSync(passportFile, "utf8")).accountId;
  }
  // One human, one MemWalAccount, many agent bodies: the registry allows a single
  // account per owner, so reuse the owner's existing account when there is one.
  const hybridFile = path.join(secretsDir, "hybrid-account.json");
  if (!accountId && fs.existsSync(hybridFile)) {
    const h = JSON.parse(fs.readFileSync(hybridFile, "utf8"));
    if ((h.owner ?? "").toLowerCase() === ownerAddr.toLowerCase()) accountId = h.accountId;
  }
  if (!accountId) {
    const tx = new Transaction();
    tx.setSender(ownerAddr);
    tx.moveCall({
      target: `${MEMWAL_PACKAGE_ID}::account::create_account`,
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
  }

  const acc = await client.getObject({ id: accountId, options: { showContent: true } });
  const dks: any[] = (acc?.data?.content as any)?.fields?.delegate_keys ?? [];
  const already = dks.some(
    (k) => (k?.fields?.sui_address ?? k?.sui_address ?? "").toLowerCase() === plummyAddr.toLowerCase(),
  );
  if (!already) {
    const accVersion = await initialSharedVersion(client, accountId);
    const pubkey = Array.from(plummy.getPublicKey().toRawBytes());
    const tx = new Transaction();
    tx.setSender(ownerAddr);
    tx.moveCall({
      target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
      arguments: [
        tx.sharedObjectRef({ objectId: accountId, initialSharedVersion: accVersion, mutable: true }),
        tx.pure.vector("u8", pubkey),
        tx.pure.address(plummyAddr),
        tx.pure.string("plummy"),
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
  }

  fs.writeFileSync(
    passportFile,
    JSON.stringify({ agent: "plummy", agentAddress: plummyAddr, accountId, owner: ownerAddr, network: "sui:testnet" }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, agentAddress: plummyAddr, accountId, owner: ownerAddr, delegateAlready: already }));
}

function readPassportFile(): { agentAddress: string; accountId: string; owner: string } {
  if (!fs.existsSync(passportFile)) {
    throw new Error("no passport yet — run `plummy-passport setup` first");
  }
  return JSON.parse(fs.readFileSync(passportFile, "utf8"));
}

async function show() {
  const p = readPassportFile();
  const cls = await classifyCaller(p.agentAddress, { memwalAccountId: p.accountId });
  console.log(
    JSON.stringify({
      ok: true,
      agent: "Plummy",
      kind: cls.kind,
      agentAddress: p.agentAddress,
      human: cls.human ?? null,
      porLevel: cls.porLevel ?? null,
      porLevelName: cls.porLevel !== undefined ? levelName(cls.porLevel) : "none",
      memwalAccountId: cls.memwalAccountId ?? p.accountId,
      network: "sui:testnet",
      reason: cls.reason,
      checkedAt: new Date().toISOString(),
    }),
  );
}

async function verifyHuman() {
  const p = readPassportFile();
  const check = await checkPersonhood(p.owner);
  console.log(
    JSON.stringify({
      ok: true,
      human: p.owner,
      verified: check.verified,
      level: check.level ?? null,
      levelName: check.level !== undefined ? levelName(check.level) : "none",
      credentialId: check.credentialId ?? null,
      reason: check.reason ?? null,
      network: "sui:testnet",
      checkedAt: new Date().toISOString(),
    }),
  );
}

const cmd = process.argv[2];
const run = cmd === "setup" ? setup : cmd === "show" ? show : cmd === "verify-human" ? verifyHuman : null;
if (!run) {
  console.error("usage: plummy-passport <setup|show|verify-human>");
  process.exit(2);
}
run().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
