/**
 * governor-check — offline proof that the signed attestation is MEANINGFUL:
 * a genuine seller signature verifies, but tampering with the attested content
 * OR claiming a different signer breaks verification.
 *
 *   node --import tsx src/governor-check.ts
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";
import { signAttestation, verifyAttestation } from "./governor.js";

async function main() {
  const seller = new Ed25519Keypair();
  const attestation = { kind: "hybrid", human: "0xfe71…", recomputedNet: "500000", digest: "0xdead" };

  const signed = await signAttestation(seller, attestation);

  // 1. genuine signature verifies
  const good = await verifyAttestation(signed);

  // 2. tamper with the attested content (e.g. lie that only 1 MIST was paid),
  //    keep the original signature -> must FAIL
  const tamperedPayload = toBase64(
    new TextEncoder().encode(JSON.stringify({ ...attestation, recomputedNet: "1" })),
  );
  const tampered = await verifyAttestation({ ...signed, payload: tamperedPayload });

  // 3. claim a different signer -> must FAIL
  const wrongBy = await verifyAttestation({ ...signed, by: new Ed25519Keypair().toSuiAddress() });

  console.log("\n  Governor · signed attestation — meaningfulness proof\n");
  console.log(`  ${good.ok ? "✓" : "✗"} genuine seller signature verifies            → ok=${good.ok}`);
  console.log(`  ${!tampered.ok ? "✓" : "✗"} tampered content (paid 500000→1) rejected     → ok=${tampered.ok}`);
  console.log(`  ${!wrongBy.ok ? "✓" : "✗"} forged signer identity rejected               → ok=${wrongBy.ok}\n`);

  const pass = good.ok && !tampered.ok && !wrongBy.ok;
  console.log(pass ? "  signature binds the attestation content + signer.\n" : "  UNEXPECTED — signature does not bind as required.\n");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("governor-check failed:", e?.message ?? e);
  process.exit(1);
});
