/**
 * kind-check — live proof of the Agent Passport "Kind" classifier against real
 * Sui testnet state. No payments, no relayer: just classifyCaller() reads.
 *
 *   node --import tsx src/kind-check.ts
 *
 * Cases:
 *   human       — the verified-agent demo key (holds PoR)
 *   autonomous  — the unverified-agent demo key (no PoR, no delegation)
 *   hybrid?     — the real MemWal account's delegate key + account hint. Its owner
 *                 does NOT hold PoR, so it correctly classifies AUTONOMOUS — the
 *                 anti-spoof negative test (you can't buy the hybrid tier without a
 *                 real PoR human behind the account).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKeypair } from "./lib.js";
import { classifyCaller } from "./caller-kind.js";

// A real MemWalAccount on testnet + one of its delegate keys (owner has no PoR).
const REAL_MEMWAL_ACCOUNT = "0x9c6caf5d3b02593137f510b3492a33e5cc04955b70b9995e650edf85c37ad935";
const REAL_MEMWAL_DELEGATE = "0x622890bab53c11092d167bb92f00fc528bbeecb2df6901a333c3bda70124b670";

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s);

async function main() {
  const human = loadKeypair("verified-agent").toSuiAddress();
  const auto = loadKeypair("unverified-agent").toSuiAddress();

  const cases: Array<{ label: string; address: string; memwalAccountId?: string; expect: string }> = [
    { label: "verified-agent key (PoR human)", address: human, expect: "human" },
    { label: "unverified-agent key (no PoR)", address: auto, expect: "autonomous" },
    {
      label: "real MemWal delegate + account hint (owner has no PoR)",
      address: REAL_MEMWAL_DELEGATE,
      memwalAccountId: REAL_MEMWAL_ACCOUNT,
      expect: "autonomous",
    },
  ];

  // positive hybrid — present iff setup-hybrid.ts has been run
  const acctFile = path.join(secretsDir, "hybrid-account.json");
  if (fs.existsSync(acctFile) && fs.existsSync(path.join(secretsDir, "agent-body.key"))) {
    const { accountId } = JSON.parse(fs.readFileSync(acctFile, "utf8"));
    cases.push({
      label: "agent-body delegate + account hint (owner IS a PoR human)",
      address: loadKeypair("agent-body").toSuiAddress(),
      memwalAccountId: accountId,
      expect: "hybrid",
    });
  }

  console.log("\n  Agent Passport · Kind classifier — live on Sui testnet\n");
  let allOk = true;
  for (const c of cases) {
    const r = await classifyCaller(c.address, { memwalAccountId: c.memwalAccountId });
    const ok = r.kind === c.expect;
    allOk = allOk && ok;
    console.log(`  ${ok ? "✓" : "✗"} ${c.label}`);
    console.log(`      ${short(c.address)} → ${r.kind.toUpperCase()}  (${r.reason})`);
    if (!ok) console.log(`      EXPECTED ${c.expect}`);
    console.log();
  }
  console.log(allOk ? "  all cases classified as expected.\n" : "  MISMATCH — see above.\n");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("kind-check failed:", e?.message ?? e);
  process.exit(1);
});
