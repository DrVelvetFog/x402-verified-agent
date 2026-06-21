/**
 * Verified Agent — Phase B2: the brain (memory-driven spend control).
 *
 * Before paying, the agent recalls its memory and a local LLM decides whether it
 * must PAY (x402) for the request, or can SKIP because memory already covers it.
 * The agent pays only for what it doesn't already know — "more useful because it
 * remembers." Reasoning runs on a LOCAL model (Ollama) → no centralized LLM
 * dependency anywhere: PoR identity + x402 payment + Walrus memory + local brain.
 *
 *   node --env-file=.env --import tsx src/demo-b2.ts
 *   BRAIN_PROVIDER=anthropic ANTHROPIC_API_KEY=... node --env-file=.env --import tsx src/demo-b2.ts
 */
import { getClient, loadKeypair, ensureGas, SUI, short } from "./lib.js";
import { startVerifiedSeller } from "./verified-seller.js";
import { agentBuy } from "./agent.js";
import { AgentMemory } from "./memory.js";
import { decide } from "./brain.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const AMOUNT = process.env.AMOUNT ?? "1000000";

// A run of requests for durable facts about the data service. #3 repeats #1 — the
// agent should recognize it already knows that and skip the payment.
const REQUESTS = [
  "spec: what fields does the seller's premium feed return?",
  "ops: which network and asset does the seller settle payments on?",
  "spec: what fields does the seller's premium feed return?", // repeat of #1
];

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");
  const agent = loadKeypair("verified-agent");
  const agentAddr = agent.toSuiAddress();
  const memory = new AgentMemory(agentAddr, "b2"); // isolated namespace for a clean run

  console.log(`\n  VERIFIED AGENT · Phase B2 — local brain, memory-driven spend control`);
  console.log(`  agent ${short(agentAddr)}  ·  brain ${process.env.BRAIN_PROVIDER ?? "ollama"}  ·  ns "${memory.namespace}"\n`);

  await ensureGas(client, agentAddr);

  const srv = await startVerifiedSeller({
    facilitatorUrl: FACILITATOR, network: NETWORK, asset: SUI, amount: AMOUNT,
    payTo: seller.toSuiAddress(), requireUnique: true,
    resource: { url: "http://seller/premium", description: "premium data feed", mimeType: "application/json" },
    data: { fields: ["alpha", "servedAt"], alpha: "agents that remember compound", servedAt: new Date().toISOString() },
  });

  let paid = 0, skipped = 0;
  for (const [i, request] of REQUESTS.entries()) {
    console.log(`  request ${i + 1}: ${request}`);
    const mems = (await memory.recall(request)).map((m) => m.text);
    const d = await decide(request, mems);
    console.log(`     brain [${d.model}] → ${d.decision.toUpperCase()} — ${d.reason}`);

    if (d.decision === "skip") {
      skipped++;
      console.log(`     ✓ SKIPPED payment — reused memory: ${(mems[0] ?? "").slice(0, 88)}…\n`);
      continue;
    }
    const r = await agentBuy(`${srv.url}/premium`, client, agent, () => {});
    if (!r.served) { console.log(`     ✗ purchase failed: ${(r as any).reason}\n`); continue; }
    paid++;
    const note = `Re "${request}": paid ${AMOUNT} MIST SUI (settled ${r.digest}); received ${JSON.stringify(r.data)}.`;
    console.log(`     ✓ PAID + remembered — settled ${short(r.digest)} (writing memory…)`);
    await memory.remember(note);
    console.log();
  }

  await srv.close();
  console.log(`  ════ B2 result ════`);
  console.log(`  ${REQUESTS.length} requests · ${paid} paid · ${skipped} skipped by memory`);
  console.log(`  the agent paid only for what it didn't already know — verified, self-funding, and it remembers.\n`);
}

main().catch((e) => {
  console.error("\n  B2 demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
