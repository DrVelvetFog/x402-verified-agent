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
