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
import { classifyCaller, type CallerClass, type CallerKind } from "./caller-kind.js";
import { signAttestation, enforceGovernor } from "./governor.js";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export type VerifiedSellerConfig = {
  facilitatorUrl: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  minLevel?: Level;
  requireUnique?: boolean;
  /**
   * Agent Passport caller-type pricing. When set, the seller serves EVERYONE but
   * prices by the payer's Kind (human / hybrid / autonomous), classified on-chain
   * from the identity graph. When omitted, the seller keeps its original behavior:
   * a PoR-verified-human-only gate at the flat `amount`.
   */
  prices?: Record<CallerKind, string>;
  /**
   * Governor (M2): when set, the seller SIGNS its AGENT-PASSPORT attestation with
   * this key so a client can verify the gate was enforced, rather than trusting
   * the operator. Without it, the attestation is returned unsigned (back-compat).
   */
  signer?: Ed25519Keypair;
  /**
   * Governor (M2.2): when true, a caller must present a valid human-signed
   * GovernorPolicy (bound to the on-chain human behind it) or be rejected before
   * settlement. When false, a presented policy is still enforced, but its absence
   * is allowed. Pricing mode only.
   */
  requireGovernor?: boolean;
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

  const reqFor = (amount: string, kindTag?: CallerKind): Requirements => ({
    scheme: "exact",
    network: cfg.network,
    amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    // advertise the personhood requirement so an agent knows what it needs
    extra: {
      personhood: { scheme: "por", network: cfg.network, minLevel, unique: requireUnique },
      ...(kindTag ? { callerKind: kindTag } : {}),
    },
  });
  const requirements = (): Requirements => reqFor(cfg.amount);

  const server = http.createServer(async (req, res) => {
    const send = (code: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    const sig = req.headers["payment-signature"];

    // unpaid -> 402 with terms. In pricing mode, advertise one tier per Kind so a
    // caller knows what it must pay; otherwise the single flat requirement.
    if (typeof sig !== "string" || !sig.length) {
      const accepts = cfg.prices
        ? (Object.keys(cfg.prices) as CallerKind[]).map((k) => reqFor(cfg.prices![k], k))
        : [requirements()];
      const body = {
        x402Version: 2,
        error: cfg.prices
          ? "PAYMENT-SIGNATURE header is required; price depends on your Agent Passport Kind (human/hybrid/autonomous). Present a MEMWAL-ACCOUNT header to claim the hybrid tier."
          : "PAYMENT-SIGNATURE header is required; this resource also requires a PoR-verified payer",
        resource: cfg.resource,
        accepts,
      };
      return send(402, { "PAYMENT-REQUIRED": encodeHeader(body) }, body);
    }

    let client: PaymentPayload;
    try {
      client = decodeHeader<PaymentPayload>(sig);
    } catch {
      return send(400, {}, { error: "PAYMENT-SIGNATURE is not valid base64 JSON" });
    }

    // ── identity gate (runs BEFORE settlement) ────────────────────────────
    let payer: string;
    try {
      payer = payerOf(client.payload);
    } catch (e: any) {
      return send(400, {}, { error: `could not read payer from payment: ${e?.message ?? e}` });
    }

    // What must this caller pay, and (legacy mode) may it buy at all?
    let required = cfg.amount;
    let passport: CallerClass | undefined;
    let por: Awaited<ReturnType<typeof checkPersonhood>> | undefined;

    if (cfg.prices) {
      // Agent Passport pricing: serve everyone, priced by Kind (classified on-chain).
      const hint = req.headers["memwal-account"];
      passport = await classifyCaller(payer, {
        memwalAccountId: typeof hint === "string" && hint.length ? hint : undefined,
      });
      required = cfg.prices[passport.kind];
      log(`gate: payer ${short(payer)} → Kind ${passport.kind.toUpperCase()} (${passport.reason}) · price ${required}`);
    } else {
      // Legacy: PoR-verified-human-only gate — reject before settling.
      por = await checkPersonhood(payer, minLevel, requireUnique);
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
    }

    // ── governor gate (M2.2): enforce the human-signed spending policy ────────
    let governor: Record<string, unknown> | undefined;
    if (passport) {
      const g = await enforceGovernor(
        (n) => {
          const h = req.headers[n];
          return typeof h === "string" ? h : undefined;
        },
        { payer, human: passport.human, required, resourceUrl: cfg.resource.url },
      );
      if (g.present && !g.ok) {
        log(`governor: ✗ ${g.reason} — refusing before settlement`);
        return send(403, {}, { x402Version: 2, error: `governor blocked: ${g.reason}`, kind: passport.kind });
      }
      if (!g.present && cfg.requireGovernor) {
        log(`governor: ✗ required but no policy presented`);
        return send(403, {}, { x402Version: 2, error: "governor policy required but none presented", kind: passport.kind });
      }
      if (g.present && g.ok) {
        governor = g.governor as Record<string, unknown>;
        log(`governor: ✓ policy by ${short(String(governor.policyBy))} · spendCapOk ${governor.spendCapOk} · approvalOk ${governor.approvalOk}`);
      }
    }

    // ── payment gate: settle the signed tx against the price for this caller ──
    const reqs = reqFor(required, passport?.kind);
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
    if (net < BigInt(required)) {
      log(`recompute: ✗ net ${net} < required ${required} — refusing to serve`);
      return send(402, {}, { x402Version: 2, error: "settlement recompute mismatch", recomputedNet: net.toString(), required });
    }
    log(`recompute: ✓ net ${net} to payTo matches required ${required}`);

    // gate passed + settlement verified -> serve
    if (passport) {
      const attestation = {
        kind: passport.kind,
        human: passport.human,
        porLevel: passport.porLevel,
        memwalAccountId: passport.memwalAccountId,
        reason: passport.reason,
        recomputedNet: net.toString(),
        digest,
        resource: cfg.resource.url,
        ...(governor ? { governor } : {}),
      };
      const headers: Record<string, string> = { "PAYMENT-RESPONSE": encodeHeader(settle) };
      if (cfg.signer) {
        // Governor: sign the attestation so the client can verify enforcement.
        const signed = await signAttestation(cfg.signer, attestation);
        headers["AGENT-PASSPORT"] = signed.payload;
        headers["AGENT-PASSPORT-SIG"] = signed.sig;
        headers["AGENT-PASSPORT-BY"] = signed.by;
        log(`served: paid (digest ${short(digest)}) as Kind ${passport.kind.toUpperCase()} · attestation signed by ${short(signed.by)}`);
      } else {
        headers["AGENT-PASSPORT"] = encodeHeader(attestation);
        log(`served: paid (digest ${short(digest)}) as Kind ${passport.kind.toUpperCase()} (attestation UNSIGNED)`);
      }
      return send(200, headers, cfg.data);
    }
    log(`served: paid (digest ${short(digest)}) AND verified (${levelName(por!.level)}${por!.unique ? " · unique human" : ""})`);
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
