/**
 * One-time setup: create the agent + seller keypairs, faucet testnet gas, and
 * print each address with its current PoR status. Use the printed verified-agent
 * address with the PoR attestor to grant it a credential (see the final hint).
 */
import { getClient, loadKeypair, ensureGas } from "./lib.js";
import { checkPersonhood, levelName } from "./por-gate.js";

const NETWORK = "sui:testnet";
const client = getClient(NETWORK);

console.log(`\n  Verified Agent — identities (network ${NETWORK})\n`);

let verifiedAddr = "";
for (const name of ["verified-agent", "unverified-agent", "seller"]) {
  const kp = loadKeypair(name);
  const addr = kp.toSuiAddress();
  if (name === "verified-agent") verifiedAddr = addr;
  const bal = await ensureGas(client, addr);
  const por = await checkPersonhood(addr);
  console.log(`  ${name.padEnd(17)} ${addr}`);
  console.log(
    `  ${" ".repeat(17)} gas ${(Number(bal) / 1e9).toFixed(3)} SUI · PoR ` +
      (por.verified ? `✓ ${levelName(por.level)}` : `✗ (${por.reason})`),
  );
}

console.log("\n  To grant the verified agent a PoR credential (one-time):");
console.log(`    cd ~/por/attestor && node scripts/test-mint.js ${verifiedAddr}`);
console.log("\n  Then run:  pnpm demo\n");
