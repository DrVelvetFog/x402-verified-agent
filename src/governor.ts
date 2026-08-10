/**
 * governor.ts — M2: the Agent Passport "Governor" claim.
 *
 * Today the seller enforces its gate locally and returns an UNSIGNED attestation,
 * so a client must TRUST the operator actually ran the checks (verified-agent
 * spec, open question #4). The governor makes the claim VERIFIABLE: the seller
 * signs its attestation with its own key, and any client can confirm the
 * signature before believing "this Kind was checked / this policy was enforced".
 *
 * Signature is a Sui personal-message signature over the exact attestation bytes
 * carried in the header, so verification needs only the signer's Sui address —
 * the same pattern PoR uses for its real-action vouches.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

/** A seller-signed attestation: the exact bytes (base64), the signature, the signer. */
export type SignedAttestation = { payload: string; sig: string; by: string };

/**
 * Sign an attestation object. Returns the base64 of the exact JSON bytes that
 * were signed (goes in the AGENT-PASSPORT header), the signature, and the signer
 * Sui address. The bytes travel verbatim, so there is no canonicalization gap.
 */
export async function signAttestation(
  signer: Ed25519Keypair,
  attestation: unknown,
): Promise<SignedAttestation> {
  const payload = toBase64(new TextEncoder().encode(JSON.stringify(attestation)));
  const bytes = fromBase64(payload);
  const { signature } = await signer.signPersonalMessage(bytes);
  return { payload, sig: signature, by: signer.toSuiAddress() };
}

/**
 * Verify a seller-signed attestation. `ok` is true only when the signature over
 * the carried bytes recovers `by`. Returns the decoded attestation regardless so
 * callers can inspect it, but they must gate trust on `ok`.
 */
export async function verifyAttestation(
  a: SignedAttestation,
): Promise<{ ok: boolean; attestation: any }> {
  const bytes = fromBase64(a.payload);
  let ok = false;
  try {
    const pk = await verifyPersonalMessageSignature(bytes, a.sig, { address: a.by });
    ok = pk.toSuiAddress() === a.by;
  } catch {
    ok = false;
  }
  let attestation: any = {};
  try {
    attestation = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* leave empty */
  }
  return { ok, attestation };
}

// ── M2.2: governor policy ──────────────────────────────────────────────────

/**
 * A spending policy the ACCOUNTABLE HUMAN signs for an agent. It's meaningful
 * because the seller cross-checks the signer against the on-chain identity graph
 * — a hybrid's policy must be signed by the very MemWal owner the classifier
 * proved is behind the agent, not by whoever the agent claims.
 */
export type GovernorPolicy = {
  /** The agent (delegate) address this policy governs. */
  agent: string;
  /** Max the agent may pay per call (atomic units). */
  spendCapMist: string;
  /** Above this per-call amount, an explicit human approval is required. */
  approvalThresholdMist: string;
  /** Who can revoke the agent (for a hybrid: the MemWal owner). */
  killAuthority: string;
  issuedAtMs: number;
};

/** A standing human approval for higher-value calls, bound to (agent, resource). */
export type GovernorApproval = { agent: string; resource: string; maxAmountMist: string; issuedAtMs: number };

/** The human signs a policy (thin wrapper over signAttestation for a typed shape). */
export const signPolicy = (human: Ed25519Keypair, p: GovernorPolicy) => signAttestation(human, p);
/** The human signs a standing approval for higher-value calls. */
export const signApproval = (human: Ed25519Keypair, a: GovernorApproval) => signAttestation(human, a);

export type GovernorResult =
  | { present: false }
  | {
      present: true;
      ok: boolean;
      reason?: string;
      governor?: {
        policyBy: string;
        spendCapMist: string;
        spendCapOk: boolean;
        thresholdMist: string;
        approvalOk: boolean;
      };
    };

const eqAddr = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Enforce the governor policy carried on a request, if any. `get(name)` reads a
 * header. `ctx.human` is the identity the classifier independently proved is
 * behind `ctx.payer` (undefined for a bare autonomous caller). Returns whether
 * the call may proceed and the governor facts to attest.
 */
export async function enforceGovernor(
  get: (name: string) => string | undefined,
  ctx: { payer: string; human?: string; required: string; resourceUrl: string },
): Promise<GovernorResult> {
  const payload = get("governor-policy");
  if (!payload) return { present: false };

  const sig = get("governor-policy-sig");
  const by = get("governor-policy-by");
  if (!sig || !by) return { present: true, ok: false, reason: "governor policy is missing its signature/signer" };

  const v = await verifyAttestation({ payload, sig, by });
  if (!v.ok) return { present: true, ok: false, reason: "governor policy signature is invalid" };
  const policy = v.attestation as GovernorPolicy;

  if (!eqAddr(policy.agent, ctx.payer))
    return { present: true, ok: false, reason: "governor policy is not bound to this agent" };

  // The signer must be the on-chain human the classifier proved is behind the agent.
  if (!ctx.human || !eqAddr(by, ctx.human))
    return { present: true, ok: false, reason: "governor policy is not signed by the human proven to control this agent" };

  const spendCapOk = BigInt(ctx.required) <= BigInt(policy.spendCapMist);
  if (!spendCapOk)
    return { present: true, ok: false, reason: `call price ${ctx.required} exceeds governor spend cap ${policy.spendCapMist}` };

  // Higher-value calls need an explicit standing approval from the same human.
  let approvalOk = true;
  if (BigInt(ctx.required) > BigInt(policy.approvalThresholdMist)) {
    const aPayload = get("governor-approval");
    const aSig = get("governor-approval-sig");
    const aBy = get("governor-approval-by");
    approvalOk = false;
    if (aPayload && aSig && aBy) {
      const av = await verifyAttestation({ payload: aPayload, sig: aSig, by: aBy });
      const approval = av.attestation as GovernorApproval;
      approvalOk =
        av.ok &&
        eqAddr(aBy, ctx.human) &&
        eqAddr(approval.agent, ctx.payer) &&
        approval.resource === ctx.resourceUrl &&
        BigInt(approval.maxAmountMist ?? "0") >= BigInt(ctx.required);
    }
    if (!approvalOk)
      return {
        present: true,
        ok: false,
        reason: `call ${ctx.required} exceeds approval threshold ${policy.approvalThresholdMist} and lacks a valid human approval`,
      };
  }

  return {
    present: true,
    ok: true,
    governor: {
      policyBy: by,
      spendCapMist: policy.spendCapMist,
      spendCapOk,
      thresholdMist: policy.approvalThresholdMist,
      approvalOk,
    },
  };
}
