/**
 * Verified Agent — Phase B0 demo: the personhood gate.
 *
 * Stands up a resource that requires BOTH payment (x402 on Sui) AND a PoR-verified
 * payer, then runs two agents against it:
 *   run 1 — a verified agent (holds a PoR cred) → pays → SERVED
 *   run 2 — an unverified agent (no PoR cred)   → REJECTED before it pays
 * The point: "verified ≠ just paid."
 *
 *   pnpm demo
 */
import { getClient, loadKeypair, ensureGas, SUI, short } from "./lib.js";
import { startVerifiedSeller } from "./verified-seller.js";
import { agentBuy } from "./agent.js";
import { checkPersonhood, levelName, Level } from "./por-gate.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const AMOUNT = process.env.AMOUNT ?? "1000000"; // 0.001 SUI

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");
  const verified = loadKeypair("verified-agent");
  const unverified = loadKeypair("unverified-agent");

  console.log(`\n  VERIFIED AGENT · Phase B0 — x402 payment + PoR UNIQUE-HUMAN gate`);
  console.log(`  network ${NETWORK}  ·  facilitator ${FACILITATOR}\n`);

  await ensureGas(client, verified.toSuiAddress());
  await ensureGas(client, unverified.toSuiAddress());

  const status = (p: Awaited<ReturnType<typeof checkPersonhood>>) =>
    p.verified ? `✓ ${levelName(p.level)}${p.unique ? " · unique human" : ""}` : "✗ none";
  const vPor = await checkPersonhood(verified.toSuiAddress(), Level.DeviceHuman, true);
  const uPor = await checkPersonhood(unverified.toSuiAddress(), Level.DeviceHuman, true);
  console.log(`  verified-agent    ${short(verified.toSuiAddress())}  PoR ${status(vPor)}`);
  console.log(`  unverified-agent  ${short(unverified.toSuiAddress())}  PoR ${status(uPor)}`);
  if (!vPor.verified) {
    console.log(`\n  ⚠️  verified-agent has no PoR credential yet — mint one first:`);
    console.log(`      cd ~/por/attestor && node scripts/test-mint.js ${verified.toSuiAddress()}`);
    console.log(`  (running anyway to show the gate rejecting both)\n`);
  }

  const srv = await startVerifiedSeller(
    {
      facilitatorUrl: FACILITATOR,
      network: NETWORK,
      asset: SUI,
      amount: AMOUNT,
      payTo: seller.toSuiAddress(),
      requireUnique: true,
      resource: { url: "http://seller/premium", description: "premium data feed", mimeType: "application/json" },
      data: { alpha: "agents that remember compound", servedAt: new Date().toISOString() },
    },
    (m) => console.log(`       [seller] ${m}`),
  );

  console.log(`\n  ── run 1: VERIFIED agent buys ──────────────────────────────`);
  const r1 = await agentBuy(`${srv.url}/premium`, client, verified, (m) => console.log(`       [agent]  ${m}`));
  console.log(
    r1.served
      ? `  ✅ SERVED — paid + verified unique human (${levelName(r1.verified?.level)}${r1.verified?.unique ? " · unique" : ""}), digest ${short(r1.digest)}`
      : `  ⚠️  rejected (${(r1 as any).status}): ${(r1 as any).reason}` +
        (!vPor.verified ? "  ← expected until you mint its PoR cred" : ""),
  );

  console.log(`\n  ── run 2: UNVERIFIED agent buys (pays, but has no PoR) ─────`);
  const r2 = await agentBuy(`${srv.url}/premium`, client, unverified, (m) => console.log(`       [agent]  ${m}`));
  const gateHeld = !r2.served && (r2 as any).status === 403;
  console.log(
    gateHeld
      ? `  ✅ REJECTED at the gate, before settlement — ${(r2 as any).reason}`
      : `  ❌ GATE LEAK — expected 403, got ${r2.served ? "200 SERVED" : (r2 as any).status}`,
  );

  console.log(`\n  ════ B0 result ════`);
  console.log(`  verified agent:   ${r1.served ? "paid + personhood-proven → SERVED ✅" : "not served (mint its PoR cred, then re-run)"}`);
  console.log(`  unverified agent: ${gateHeld ? "rejected before paying → VERIFIED ≠ JUST PAID ✅" : "GATE LEAK ❌"}\n`);

  await srv.close();
}

main().catch((e) => {
  console.error("\n  demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
