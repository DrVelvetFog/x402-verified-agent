/**
 * A VERIFIED-AGENT-gated resource server.
 *
 * Extends the plain x402 seller with a personhood gate: a request must be BOTH
 *   (1) paid    — a signed Sui payment settled through the facilitator, and
 *   (2) verified — the paying key holds a valid PoR credential on-chain.
 *
 * The gate runs the PoR check FIRST, on the address derived from the signed
 * payment (no client-claimed identity). An un-verified payer is rejected with
 * 403 BEFORE settlement — so it never even pays. "Verified ≠ just paid."
 */
import http from "node:http";
import { Requirements, SignedPayment, encodeHeader, decodeHeader, payerOf, short, rpcFor, onchainNetToPayTo } from "./lib.js";
import { checkPersonhood, levelName, Level } from "./por-gate.js";

export type VerifiedSellerConfig = {
  facilitatorUrl: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  minLevel?: Level;
  requireUnique?: boolean;
  resource: { url: string; description: string; mimeType: string };
  data: unknown;
};

type PaymentPayload = {
  x402Version: 2;
  resource: VerifiedSellerConfig["resource"];
  accepted: Requirements;
  payload: SignedPayment;
};

export async function startVerifiedSeller(
  cfg: VerifiedSellerConfig,
  log: (msg: string) => void = () => {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const minLevel = cfg.minLevel ?? Level.DeviceHuman;
  const requireUnique = cfg.requireUnique ?? false;

  const requirements = (): Requirements => ({
    scheme: "exact",
    network: cfg.network,
    amount: cfg.amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    // advertise the personhood requirement so an agent knows what it needs
    extra: { personhood: { scheme: "por", network: cfg.network, minLevel, unique: requireUnique } },
  });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    const sig = req.headers["payment-signature"];

    // unpaid -> 402 with terms (incl. the personhood requirement)
    if (typeof sig !== "string" || !sig.length) {
      const body = {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required; this resource also requires a PoR-verified payer",
        resource: cfg.resource,
        accepts: [requirements()],
      };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    let client: PaymentPayload;
    try {
      client = decodeHeader<PaymentPayload>(sig);
    } catch {
      return send(400, {}, { error: "PAYMENT-SIGNATURE is not valid base64 JSON" });
    }

    // ── personhood gate (runs BEFORE settlement) ──────────────────────────
    let payer: string;
    try {
      payer = payerOf(client.payload);
    } catch (e: any) {
      return send(400, {}, { error: `could not read payer from payment: ${e?.message ?? e}` });
    }
    const por = await checkPersonhood(payer, minLevel, requireUnique);
    log(`gate: payer ${short(payer)} → PoR ${por.verified ? `✓ ${levelName(por.level)}${por.unique ? " · unique" : ""}` : "✗ " + por.reason}`);
    if (!por.verified) {
      // reject without settling — the un-verified agent does not pay
      return send(403, {}, {
        x402Version: 2,
        error: "verified-agent gate: payer is not a PoR-verified human",
        payer,
        personhood: por,
        required: { scheme: "por", minLevel: levelName(minLevel) },
      });
    }

    // ── payment gate: settle the signed tx against OUR terms ──────────────
    const reqs = requirements();
    const settleBody = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource: cfg.resource, accepted: reqs, payload: client.payload },
      paymentRequirements: reqs,
    };
    let settle: any;
    try {
      settle = await (
        await fetch(`${cfg.facilitatorUrl}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settleBody),
        })
      ).json();
    } catch (e: any) {
      return send(502, {}, { error: `facilitator unreachable: ${e?.message ?? e}` });
    }
    if (!settle?.success) {
      const body = {
        x402Version: 2,
        error: settle?.errorReason ?? "settlement failed",
        resource: cfg.resource,
        accepts: [reqs],
      };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    // don't trust the facilitator — recompute the settlement on-chain
    const digest: string = settle.transaction;
    let net = 0n;
    try {
      net = await onchainNetToPayTo(rpcFor(cfg.network), digest, cfg.payTo, cfg.asset);
    } catch (e: any) {
      return send(502, {}, { error: `settlement recompute failed: ${e?.message ?? e}` });
    }
    if (net < BigInt(cfg.amount)) {
      log(`recompute: ✗ net ${net} < required ${cfg.amount} — refusing to serve`);
      return send(402, {}, { x402Version: 2, error: "settlement recompute mismatch", recomputedNet: net.toString(), required: cfg.amount });
    }
    log(`recompute: ✓ net ${net} to payTo matches required ${cfg.amount}`);

    // both gates passed + settlement verified -> serve
    log(`served: paid (digest ${short(digest)}) AND verified (${levelName(por.level)}${por.unique ? " · unique human" : ""})`);
    return send(
      200,
      { "PAYMENT-RESPONSE": encodeHeader(settle), "POR-VERIFIED": encodeHeader({ ...por, recomputedNet: net.toString() }) },
      cfg.data,
    );
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
