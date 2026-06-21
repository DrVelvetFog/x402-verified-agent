/**
 * The agent's brain — a provider-agnostic structured-decision module.
 *
 * Given the agent's recalled memory + a current request, decide PAY or SKIP:
 * the agent should only pay (x402) for data its memory doesn't already cover.
 * This is what makes the agent "more useful because it remembers" — it stops
 * paying twice for what it already knows.
 *
 * Default backend: local Ollama (self-sovereign, free, no API key). The agent's
 * reasoning runs on-device — no centralized LLM dependency anywhere in the stack.
 * Optional fallback: Anthropic (set BRAIN_PROVIDER=anthropic + ANTHROPIC_API_KEY).
 *
 * We use a strict structured decision (JSON schema), NOT a fragile native
 * tool-calling loop — robust across every local model.
 */
export type Decision = { decision: "pay" | "skip"; reason: string };
export type BrainResult = Decision & { provider: string; model: string };
export type BrainOpts = { provider?: string; model?: string; ollamaUrl?: string };

const SYSTEM =
  "You are the decision module of an autonomous agent that pays a micropayment for each data request. " +
  "Decide whether the agent MUST PAY for the current request, or can SKIP paying because its existing memory " +
  "already specifically answers it. Rules: SKIP only if a memory clearly and specifically covers THIS exact " +
  "request. If memory is missing, unrelated, or only loosely related, PAY. Be strict: paying twice wastes money, " +
  "but skipping when you don't actually know the answer is worse.";

const JSON_SHAPE = 'Respond ONLY with JSON: {"decision":"pay"|"skip","reason":"<one sentence>"}.';

const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["pay", "skip"] }, reason: { type: "string" } },
  required: ["decision", "reason"],
};

function userPrompt(request: string, memories: string[]): string {
  const mem = memories.length ? memories.map((m, i) => `  [${i + 1}] ${m}`).join("\n") : "  (no memory)";
  return `Current request:\n  ${request}\n\nAgent memory (things it already paid to learn):\n${mem}\n\nPay or skip? ${JSON_SHAPE}`;
}

function normalize(raw: any, provider: string, model: string): BrainResult {
  const decision = String(raw?.decision).toLowerCase() === "skip" ? "skip" : "pay";
  return { decision, reason: String(raw?.reason ?? ""), provider, model };
}

const firstJson = (s: string) => JSON.parse(s.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

export async function decide(request: string, memories: string[], opts: BrainOpts = {}): Promise<BrainResult> {
  const provider = opts.provider ?? process.env.BRAIN_PROVIDER ?? "ollama";
  return provider === "anthropic"
    ? decideAnthropic(request, memories, opts)
    : decideOllama(request, memories, opts);
}

async function decideOllama(request: string, memories: string[], opts: BrainOpts): Promise<BrainResult> {
  // qwen2.5-coder:14b judged 4/4 in brain-check (incl. stale-data nuance); hermes3
  // was reliable on speed but too conservative (always PAY) → useless for spend control.
  const model = opts.model ?? process.env.BRAIN_MODEL ?? "qwen2.5-coder:14b";
  const base = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt(request, memories) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return normalize(firstJson(json?.message?.content ?? "{}"), "ollama", model);
}

async function decideAnthropic(request: string, memories: string[], opts: BrainOpts): Promise<BrainResult> {
  const model = opts.model ?? process.env.BRAIN_MODEL ?? "claude-sonnet-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set (BRAIN_PROVIDER=anthropic)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: `${SYSTEM} ${JSON_SHAPE}`,
      messages: [{ role: "user", content: userPrompt(request, memories) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return normalize(firstJson(json?.content?.[0]?.text ?? "{}"), "anthropic", model);
}
