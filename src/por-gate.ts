/**
 * The identity half of the Verified Agent: prove a real human stands behind the
 * paying key. Uses por-sdk to check that an address holds a valid PoR credential
 * (on-chain, no centralized trust) at a minimum assurance level.
 */
import { PorClient, TESTNET, Level } from "por-sdk";

const por = new PorClient({ deployment: TESTNET });

export { Level };

export type PorCheck = {
  verified: boolean;
  level?: number;
  unique?: boolean;
  credentialId?: string;
  reason?: string;
};

const LEVEL_NAME: Record<number, string> = {
  0: "DeviceHuman (L0)",
  1: "Phone (L1)",
  2: "RealAction (L2)",
  3: "UniquePerson (L3)",
};

export const levelName = (lvl?: number) =>
  lvl === undefined ? "none" : (LEVEL_NAME[lvl] ?? `L${lvl}`);

/**
 * Does `address` hold a PoR credential meeting `minLevel` (and, if `requireUnique`,
 * registered as a unique human)? The uniqueness check is what makes the gate
 * sybil-resistant — one credential per real person.
 */
export async function checkPersonhood(
  address: string,
  minLevel: Level = Level.DeviceHuman,
  requireUnique = false,
): Promise<PorCheck> {
  const cred: any = await por.getCredential(address);
  if (!cred) return { verified: false, reason: "no PoR credential on this address" };
  const credId = cred.id ?? cred.objectId;
  if (!(await por.isVerified(address, minLevel))) {
    return { verified: false, level: cred.level, credentialId: credId, reason: `credential is below required level ${levelName(minLevel)} or expired` };
  }
  if (requireUnique) {
    const unique = await por.isUniqueCredId(credId);
    if (!unique) {
      return { verified: false, level: cred.level, unique: false, credentialId: credId, reason: "credential is not registered as a unique human (sybil-resistant gate)" };
    }
    return { verified: true, level: cred.level, unique: true, credentialId: credId };
  }
  return { verified: true, level: cred.level, credentialId: credId };
}
