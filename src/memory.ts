/**
 * The agent's memory — Walrus Memory (MemWal): portable, encrypted, on-chain-owned,
 * verifiable. Namespaced by the agent's Sui address so each agent's memory is its own.
 * This is the "M" of the Verified Agent: PoR identity + x402 payment + Walrus memory.
 */
import { MemWal } from "@mysten-incubation/memwal";

export class AgentMemory {
  private mw: ReturnType<typeof MemWal.create>;
  readonly namespace: string;

  constructor(agentAddress: string, nsSuffix = "") {
    const { MEMWAL_PRIVATE_KEY, MEMWAL_ACCOUNT_ID, MEMWAL_SERVER_URL } = process.env;
    if (!MEMWAL_PRIVATE_KEY || !MEMWAL_ACCOUNT_ID) {
      throw new Error("MemWal creds missing — set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID in .env");
    }
    this.namespace = `agent-${agentAddress.slice(0, 12)}${nsSuffix ? `-${nsSuffix}` : ""}`;
    this.mw = MemWal.create({
      key: MEMWAL_PRIVATE_KEY,
      accountId: MEMWAL_ACCOUNT_ID,
      serverUrl: MEMWAL_SERVER_URL ?? "https://relayer-staging.memory.walrus.xyz",
      namespace: this.namespace,
    });
  }

  /** Persist a memory and wait until it's indexed (write latency ~30s on staging). */
  async remember(text: string): Promise<{ blob_id?: string }> {
    return this.mw.rememberAndWait(text, undefined, { timeoutMs: 120_000 });
  }

  /** Semantic recall over the agent's own memories. */
  async recall(query: string, limit = 10): Promise<Array<{ text: string; blob_id: string; distance: number }>> {
    const r = await this.mw.recall({ query, limit });
    return r.results ?? [];
  }
}
