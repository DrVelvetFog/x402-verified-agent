/**
 * caller-kind.ts — the Agent Passport "Kind" claim.
 *
 * Classifies the entity behind a paying key into one of three caller kinds,
 * derived entirely from the on-chain identity graph — NO new credential type,
 * NO on-chain contract change:
 *
 *   human       — the paying address itself holds a PoR RealHumanCredential
 *   hybrid      — the paying address is an authorized *delegate* of a MemWalAccount
 *                 whose OWNER holds PoR (a human-piloted agent — Alien: Earth's "Wendy")
 *   autonomous  — neither: a bare agent key with no human in its identity graph
 *
 * The hybrid check reuses MemWal's delegate-key binding (the same primitive that
 * proves memory continuity in MemWal.verify()). The caller PRESENTS its
 * MemWalAccount id as a hint — the same pattern the MemWal relayer prefers over an
 * expensive registry scan — and we VERIFY on-chain that:
 *   (a) the object is a genuine MemWalAccount from the PINNED package id,
 *   (b) the paying address is in its delegate_keys, and
 *   (c) the account owner holds PoR.
 * You cannot claim `hybrid` unless a real PoR human actually delegated to your key,
 * so the discount is unspoofable.
 */
import { PorClient, TESTNET } from "por-sdk";
import { getClient } from "./lib.js";
import { checkPersonhood } from "./por-gate.js";

export type CallerKind = "human" | "hybrid" | "autonomous";

/**
 * Pinned MemWal package id (Sui testnet). Pinning is a security requirement: a
 * caller could otherwise deploy a look-alike `::account::MemWalAccount` type,
 * set `owner` to any PoR human and add itself as a delegate, and falsely claim
 * `hybrid`. We only trust accounts from this package. Override via env for other
 * deployments.
 */
export const MEMWAL_PACKAGE_ID =
  process.env.MEMWAL_PACKAGE_ID ??
  "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";
const MEMWAL_ACCOUNT_TYPE = `${MEMWAL_PACKAGE_ID}::account::MemWalAccount`;

export type CallerClass = {
  kind: CallerKind;
  address: string;
  /** The human behind the key: self (human) or the account owner (hybrid). */
  human?: string;
  /** PoR assurance level of `human`, when present. */
  porLevel?: number;
  /** The MemWalAccount proving the delegation (hybrid only). */
  memwalAccountId?: string;
  /** Human-readable why. */
  reason: string;
};

const por = new PorClient({ deployment: TESTNET, suiClient: getClient("sui:testnet") as any });
void por; // reserved for future direct reads; personhood goes through checkPersonhood

const normAddr = (a: string) => (a ?? "").toLowerCase();

/**
 * If `callerAddress` is a delegate of the pinned MemWalAccount at `accountId`,
 * return the account's owner address; otherwise null. Reads one object; pins the
 * package id so look-alike objects are rejected.
 */
async function delegationOwner(accountId: string, callerAddress: string): Promise<string | null> {
  const client = getClient("sui:testnet");
  let obj: any;
  try {
    obj = await client.getObject({ id: accountId, options: { showContent: true, showType: true } });
  } catch {
    return null;
  }
  const data = obj?.data;
  if (!data) return null;

  const type: string = data.type ?? data.content?.type ?? "";
  if (type !== MEMWAL_ACCOUNT_TYPE) return null; // not the pinned MemWalAccount — reject spoofs

  const fields: any = data.content?.fields;
  if (!fields || fields.active === false) return null;

  const owner: string | undefined = fields.owner;
  if (!owner) return null;

  const dks: any[] = fields.delegate_keys ?? [];
  const isDelegate = dks.some(
    (k) => normAddr(k?.fields?.sui_address ?? k?.sui_address ?? "") === normAddr(callerAddress),
  );
  return isDelegate ? owner : null;
}

/**
 * Classify the caller behind `address`. `opts.memwalAccountId` is the account
 * hint a hybrid caller presents to prove its human-delegation.
 */
export async function classifyCaller(
  address: string,
  opts: { memwalAccountId?: string } = {},
): Promise<CallerClass> {
  // 1. human — the paying key itself is a PoR-verified human.
  const self = await checkPersonhood(address);
  if (self.verified) {
    return {
      kind: "human",
      address,
      human: address,
      porLevel: self.level,
      reason: `key holds PoR${self.level !== undefined ? ` L${self.level}` : ""}`,
    };
  }

  // 2. hybrid — the paying key is a delegate of a MemWalAccount owned by a PoR human.
  if (opts.memwalAccountId) {
    const owner = await delegationOwner(opts.memwalAccountId, address);
    if (owner) {
      const ownerPor = await checkPersonhood(owner);
      if (ownerPor.verified) {
        return {
          kind: "hybrid",
          address,
          human: owner,
          porLevel: ownerPor.level,
          memwalAccountId: opts.memwalAccountId,
          reason: `delegate of PoR human ${owner.slice(0, 10)}… (via MemWal account)`,
        };
      }
      return {
        kind: "autonomous",
        address,
        memwalAccountId: opts.memwalAccountId,
        reason: "delegate of a MemWal account whose owner is NOT PoR-verified",
      };
    }
  }

  // 3. autonomous — no human anywhere in the graph.
  return {
    kind: "autonomous",
    address,
    reason: opts.memwalAccountId
      ? "not a delegate of the presented MemWal account"
      : "no PoR credential and no human-delegation presented",
  };
}
