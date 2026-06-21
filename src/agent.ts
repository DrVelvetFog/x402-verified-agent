/**
 * The agent (buyer) half: hit a resource, get 402, pay on Sui, retry.
 * Unlike the plain x402 buyer, this one does NOT throw on rejection — a 403 at
 * the personhood gate is an expected outcome we want to report, not an error.
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Requirements, buildPayment, encodeHeader, decodeHeader, short } from "./lib.js";

export type AgentResult =
  | { served: true; data: unknown; digest: string; verified: any }
  | { served: false; status: number; reason: string; body: any };

export async function agentBuy(
  resourceUrl: string,
  client: SuiJsonRpcClient,
  payer: Ed25519Keypair,
  onStep: (msg: string) => void = () => {},
): Promise<AgentResult> {
  // 1. unpaid -> 402 + terms
  const first = await fetch(resourceUrl);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const header = first.headers.get("payment-required");
  const body: any = header ? decodeHeader(header) : await first.json();
  const requirements: Requirements = body.accepts[0];
  const personhood = (requirements.extra as any)?.personhood;
  onStep(
    `402 — pay ${requirements.amount} MIST SUI to ${short(requirements.payTo)}` +
      (personhood ? ` · personhood required (${personhood.scheme})` : ""),
  );

  // 2. build + sign the exact payment with the agent's own key
  const payload = await buildPayment(client, payer, requirements.payTo, BigInt(requirements.amount));
  onStep(`signed payment from ${short(payer.toSuiAddress())}`);

  // 3. retry with the signed payment
  const paymentPayload = { x402Version: 2, resource: body.resource, accepted: requirements, payload };
  const paid = await fetch(resourceUrl, { headers: { "payment-signature": encodeHeader(paymentPayload) } });

  if (paid.status === 200) {
    const rh = paid.headers.get("payment-response");
    const vh = paid.headers.get("por-verified");
    const settle: any = rh ? decodeHeader(rh) : {};
    const verified: any = vh ? decodeHeader(vh) : {};
    const data = await paid.json();
    onStep(`200 OK — served; settled on Sui, digest ${short(settle.transaction ?? "")}`);
    return { served: true, data, digest: settle.transaction, verified };
  }

  const errBody: any = await paid.json().catch(() => ({}));
  onStep(`${paid.status} — rejected: ${errBody.error ?? `HTTP ${paid.status}`}`);
  return { served: false, status: paid.status, reason: errBody.error ?? `HTTP ${paid.status}`, body: errBody };
}
