/**
 * VERIFIED AGENT — the verified-resource gate for the Sui agent economy.
 *
 * Not "an agent" — infrastructure for safely SELLING to agents: a resource that
 * serves only requests that are PAID (x402 on Sui) AND backed by a proven UNIQUE
 * human (PoR), then lets the agent REMEMBER (Walrus) and REASON about it (local
 * LLM). Trust-minimized: non-custodial + on-chain-verifiable, with local inference
 * (verification is trustless; liveness still uses hosted facilitator + relayer).
 *
 *   node --env-file=.env --import tsx src/demo.ts
 *
 * Spec sketch: spec/x402-personhood-gated-resource.md
 */
import { getClient, loadKeypair, ensureGas, SUI, short, explorerUrl } from "./lib.js";
import { startVerifiedSeller } from "./verified-seller.js";
import { agentBuy } from "./agent.js";
import { AgentMemory } from "./memory.js";
import { decide } from "./brain.js";
import { checkPersonhood, levelName, Level } from "./por-gate.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const AMOUNT = process.env.AMOUNT ?? "1000000";

const statusLine = (p: Awaited<ReturnType<typeof checkPersonhood>>) =>
  p.verified ? `✓ verified UNIQUE human (${levelName(p.level)})`
    : p.level !== undefined ? `⚠ has ${levelName(p.level)} cred but NOT unique-registered`
    : `✗ no PoR credential`;

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");
  const verified = loadKeypair("verified-agent");

  console.log(`\n╔══ VERIFIED AGENT · the verified-resource gate for the Sui agent economy ══╗`);
  console.log(`  A resource that sells only to agents that are PAID (x402) AND a proven`);
  console.log(`  UNIQUE human (PoR) — then remembers (Walrus) and reasons (local LLM).`);
  console.log(`  network ${NETWORK} · facilitator ${FACILITATOR}\n`);

  const agents = [
    { name: "agent A — verified unique human", kp: verified },
    { name: "agent B — real human, not unique", kp: loadKeypair("plain-human-agent") },
    { name: "agent C — no credential", kp: loadKeypair("unverified-agent") },
  ];
  for (const a of agents) await ensureGas(client, a.kp.toSuiAddress());

  const srv = await startVerifiedSeller(
    {
      facilitatorUrl: FACILITATOR, network: NETWORK, asset: SUI, amount: AMOUNT,
      payTo: seller.toSuiAddress(), requireUnique: true,
      resource: { url: "http://seller/premium", description: "premium data feed", mimeType: "application/json" },
      data: { fields: ["alpha", "servedAt"], alpha: "agents that remember compound", servedAt: new Date().toISOString() },
    },
    (m) => console.log(`         · ${m}`),
  );

  // ── ACT 1: THE GATE — who may buy? ─────────────────────────────────────
  console.log(`▌ ACT 1 — the gate: payment is necessary, not sufficient\n`);
  for (const a of agents) {
    const addr = a.kp.toSuiAddress();
    const por = await checkPersonhood(addr, Level.DeviceHuman, true);
    console.log(`  ${a.name}`);
    console.log(`    ${short(addr)} · PoR ${statusLine(por)}`);
    const r = await agentBuy(`${srv.url}/premium`, client, a.kp);
    if (r.served) {
      console.log(`    → ✅ SERVED — paid + unique-human, settlement recomputed on-chain`);
      console.log(`       ${explorerUrl(NETWORK, r.digest)}\n`);
    } else {
      const why = (r as any).body?.personhood?.reason ?? (r as any).reason;
      console.log(`    → ⛔ REJECTED (${(r as any).status}) — ${why}\n`);
    }
  }
  console.log(`  ↳ only the PAID *and* UNIQUE-HUMAN agent got in. Sybils and bots can't buy.\n`);

  // SKIP_ACT2=1 stops after the gate (e.g. while the Walrus Memory relayer is
  // down, or to record just the identity+payments story).
  if (process.env.SKIP_ACT2) {
    await srv.close();
    console.log(`  (Act 2 — cross-session memory + local-brain spend control — is also built; skipped here.)\n`);
    return;
  }

  // ── ACT 2: MEMORY + LOCAL BRAIN — the verified agent gets smarter ──────
  console.log(`▌ ACT 2 — the verified agent remembers, and reasons locally about spending\n`);
  const memory = new AgentMemory(verified.toSuiAddress(), "flagship");
  const request = "spec: what fields does the seller's premium feed return?";

  for (const pass of [1, 2]) {
    const mems = (await memory.recall(request)).map((m) => m.text);
    const d = await decide(request, mems);
    console.log(`  pass ${pass}: "${request}"`);
    console.log(`    brain [${d.model}, local] → ${d.decision.toUpperCase()} — ${d.reason}`);
    if (d.decision === "skip") {
      console.log(`    → 💡 SKIPPED payment — already knew it from a prior session\n`);
    } else {
      const r = await agentBuy(`${srv.url}/premium`, client, verified);
      if (r.served) {
        await memory.remember(`Re "${request}": paid ${AMOUNT} MIST SUI (settled ${r.digest}); received ${JSON.stringify(r.data)}.`);
        console.log(`    → 💸 PAID + remembered (settled ${short(r.digest)}) — next time it'll skip\n`);
      }
    }
  }

  await srv.close();
  console.log(`╚══ the full stack: PoR identity · x402 payment · Walrus memory · local brain ══╝`);
  console.log(`    trust-minimized — non-custodial, on-chain-verifiable, local inference. See spec/ for the proposed x402 extension.\n`);
}

main().catch((e) => {
  console.error("\n  demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
