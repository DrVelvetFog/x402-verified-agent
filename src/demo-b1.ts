/**
 * Verified Agent — Phase B1: memory.
 *
 * The agent writes each verified purchase to Walrus Memory and recalls its own
 * history at the start of every session. Run it repeatedly — the agent remembers
 * more each time, across sessions, from portable on-chain-owned memory.
 *
 *   node --env-file=.env --import tsx src/demo-b1.ts
 */
import { getClient, loadKeypair, ensureGas, SUI, short } from "./lib.js";
import { startVerifiedSeller } from "./verified-seller.js";
import { agentBuy } from "./agent.js";
import { AgentMemory } from "./memory.js";

const NETWORK = "sui:testnet";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://sui-facilitator.onrender.com";
const AMOUNT = process.env.AMOUNT ?? "1000000";

async function main() {
  const client = getClient(NETWORK);
  const seller = loadKeypair("seller");
  const agent = loadKeypair("verified-agent");
  const agentAddr = agent.toSuiAddress();
  const sellerAddr = seller.toSuiAddress();
  const memory = new AgentMemory(agentAddr);

  console.log(`\n  VERIFIED AGENT · Phase B1 — memory (Walrus Memory)`);
  console.log(`  agent ${short(agentAddr)}  ·  memory ns "${memory.namespace}"  ·  network ${NETWORK}\n`);

  await ensureGas(client, agentAddr);

  // ① session start: recall prior history with this seller
  console.log(`  ① recall — what do I remember about seller ${short(sellerAddr)}?`);
  const before = await memory.recall(`purchases and what I learned from seller ${sellerAddr}`);
  console.log(`     ↳ ${before.length} prior interaction(s) remembered`);
  before.slice(0, 3).forEach((m) => console.log(`        · ${m.text}`));

  // ② buy through the verified unique-human gate
  const srv = await startVerifiedSeller({
    facilitatorUrl: FACILITATOR, network: NETWORK, asset: SUI, amount: AMOUNT,
    payTo: sellerAddr, requireUnique: true,
    resource: { url: "http://seller/premium", description: "premium data feed", mimeType: "application/json" },
    data: { alpha: "agents that remember compound", servedAt: new Date().toISOString() },
  });
  console.log(`\n  ② buy — verified purchase`);
  const r = await agentBuy(`${srv.url}/premium`, client, agent, (m) => console.log(`        ${m}`));
  await srv.close();
  if (!r.served) {
    console.log(`  ✗ not served: ${(r as any).reason}`);
    process.exit(1);
  }

  // ③ remember this interaction
  const note =
    `Purchased "premium data feed" from seller ${sellerAddr} for ${AMOUNT} MIST SUI ` +
    `on ${new Date().toISOString()}. Settlement digest ${r.digest}. ` +
    `Learned alpha: "${(r.data as any)?.alpha}".`;
  console.log(`\n  ③ remember — writing this purchase to Walrus Memory (…~30s)`);
  const stored = await memory.remember(note);
  console.log(`     ↳ stored (blob ${short(stored.blob_id ?? "")})`);

  // ④ recall again — now it includes this purchase
  console.log(`\n  ④ recall — what do I remember now?`);
  const after = await memory.recall(`purchases and what I learned from seller ${sellerAddr}`);
  console.log(`     ↳ ${after.length} interaction(s) remembered:`);
  after.slice(0, 5).forEach((m) => console.log(`        · ${m.text}`));

  console.log(`\n  ════ B1 result ════`);
  console.log(`  the agent remembers ${after.length} verified purchase(s) across sessions — run again, it grows.\n`);
}

main().catch((e) => {
  console.error("\n  B1 demo failed:", e?.message ?? e, "\n");
  process.exit(1);
});
