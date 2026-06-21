/**
 * Sanity-check the brain's pay/skip judgment before the demo trusts it.
 * Verify, don't assume: exact-repeat → skip; unrelated/loosely-related/no-memory → pay.
 *   node_modules/.bin/tsx src/brain-check.ts        (BRAIN_MODEL=qwen2.5-coder:14b to step up)
 */
import { decide } from "./brain.js";

// Durable knowledge (reuse is genuinely correct) vs. a time-sensitive fact.
const M_SCHEMA = "Re 'seller premium-feed output schema': the feed returns JSON {alpha: string, servedAt: ISO timestamp}. Stable fact (digest abc123).";
const M_PRICE = "Re 'spot price of SUI in USD': learned SUI ≈ $3.40 at 09:00 (digest def456).";
const cases = [
  { name: "durable repeat",   req: "what is the seller's premium-feed output schema?", mem: [M_SCHEMA],          expect: "skip" },
  { name: "unrelated topic",  req: "what are the seller's rate limits?",               mem: [M_SCHEMA],          expect: "pay" },
  { name: "no memory at all", req: "what is the seller's premium-feed output schema?", mem: [],                  expect: "pay" },
  { name: "stale price",      req: "current spot price of SUI in USD right now",       mem: [M_PRICE, M_SCHEMA], expect: "pay" },
];

let pass = 0;
for (const c of cases) {
  const t0 = Date.now();
  const r = await decide(c.req, c.mem);
  const ok = r.decision === c.expect;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.name.padEnd(18)} → ${r.decision.toUpperCase().padEnd(4)} ${Date.now() - t0}ms [${r.model}]${ok ? "" : `  EXPECTED ${c.expect.toUpperCase()}`}`);
  console.log(`     ${r.reason}`);
}
console.log(`\n${pass}/${cases.length} judgments correct`);
process.exit(pass === cases.length ? 0 : 1);
