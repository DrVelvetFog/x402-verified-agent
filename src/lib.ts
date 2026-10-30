/**
 * x402-on-Sui helpers for the Verified Agent.
 *
 * The payment-building path (buildPayment) is reused from the proven x402-sui-stack
 * quickstart (itself adapted from the facilitator's e2e test). `payerOf` derives
 * the on-chain payer from the signed payment — the identity we then PoR-gate, so
 * the SAME key that pays is the one that must prove personhood.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

export const SUI = "0x2::sui::SUI";
// Sui JSON-RPC is fully retired (official fullnodes ~Jul 2026, publicnode
// ~Oct 2026). gRPC on the official fullnode hosts is the supported transport;
// override with SUI_RPC (a gRPC base URL).
export const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
export const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";

const isMainnet = (network: string) => network === "sui:mainnet";
export const rpcFor = (network: string) =>
  process.env.SUI_RPC ?? (isMainnet(network) ? MAINNET_RPC : TESTNET_RPC);

export type Requirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};
export type SignedPayment = { transaction: string; signature: string };

const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".secrets");

/**
 * gRPC client behind the small JSON-RPC-shaped surface this repo already
 * consumes, so call sites didn't have to change when JSON-RPC was retired:
 * getBalance/getLatestSuiSystemState/getChainIdentifier/getObject/
 * signAndExecuteTransaction keep their old shapes; `grpc` is the real client
 * (what `tx.build({ client })` takes).
 */
export class VaClient {
  readonly grpc: SuiGrpcClient;
  constructor(network: "mainnet" | "testnet", baseUrl: string) {
    this.grpc = new SuiGrpcClient({ network, baseUrl });
  }
  get core() { return this.grpc.core; }

  async getBalance(input: { owner: string; coinType?: string }): Promise<{ totalBalance: string }> {
    const r = await this.grpc.core.getBalance(input);
    return { totalBalance: r.balance.balance };
  }
  async getLatestSuiSystemState(): Promise<{ epoch: string }> {
    const r = await this.grpc.core.getCurrentSystemState();
    return { epoch: String(r.systemState.epoch) };
  }
  async getChainIdentifier(): Promise<string> {
    return (await this.grpc.core.getChainIdentifier()).chainIdentifier;
  }
  /** JSON-RPC getObject shape, for the fields this repo reads (owner, type). */
  async getObject(input: { id: string; options?: unknown }): Promise<any> {
    const r = await this.grpc.core.getObject({ objectId: input.id });
    const o: any = r.object;
    const owner = o?.owner?.$kind === "Shared"
      ? { Shared: { initial_shared_version: o.owner.Shared?.initialSharedVersion } }
      : o?.owner;
    return { data: { objectId: o?.objectId, type: o?.type, owner } };
  }
  /** JSON-RPC signAndExecuteTransaction shape: effects.status, digest, and
   * objectChanges with `type: "created"` + objectType (fetched per id). */
  async signAndExecuteTransaction(input: { transaction: Transaction; signer: Ed25519Keypair; options?: unknown }): Promise<any> {
    const r: any = await this.grpc.signAndExecuteTransaction({
      transaction: input.transaction,
      signer: input.signer,
      include: { effects: true },
    });
    const tx: any = r?.$kind === "Transaction" ? r.Transaction : r?.FailedTransaction ?? r;
    const ok = tx?.status?.success === true;
    const createdIds: string[] = (tx?.effects?.changedObjects ?? [])
      .filter((c: any) => c.idOperation === "Created")
      .map((c: any) => c.objectId);
    let objectChanges: any[] = [];
    if (ok && createdIds.length) {
      const objs = await this.grpc.core.getObjects({ objectIds: createdIds });
      objectChanges = (objs.objects as any[]).map((o: any) =>
        ({ type: "created", objectId: o?.objectId, objectType: o?.type }));
    }
    return {
      digest: tx?.digest,
      effects: { status: { status: ok ? "success" : "failure", error: tx?.status?.error?.message } },
      objectChanges,
    };
  }
}

export function getClient(network = "sui:testnet"): VaClient {
  return new VaClient(isMainnet(network) ? "mainnet" : "testnet", process.env.SUI_RPC ?? rpcFor(network));
}

/** Load (or create) a persisted testnet keypair under .secrets/ (gitignored). */
export function loadKeypair(name: string): Ed25519Keypair {
  const file = path.join(secretsDir, `${name}.key`);
  if (fs.existsSync(file)) return Ed25519Keypair.fromSecretKey(fs.readFileSync(file, "utf8").trim());
  fs.mkdirSync(secretsDir, { recursive: true });
  const kp = new Ed25519Keypair();
  fs.writeFileSync(file, kp.getSecretKey(), { mode: 0o600 });
  return kp;
}

/** Best-effort testnet SUI faucet so an address has gas (and SUI to spend). */
export async function ensureGas(client: VaClient, addr: string): Promise<bigint> {
  let bal = BigInt((await client.getBalance({ owner: addr })).totalBalance);
  if (bal >= 50_000_000n) return bal;
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: addr });
    await new Promise((r) => setTimeout(r, 3000));
    bal = BigInt((await client.getBalance({ owner: addr })).totalBalance);
  } catch (e: any) {
    if (bal < 10_000_000n) throw new Error(`${addr} is dry and the faucet refused: ${e?.message ?? e}`);
  }
  return bal;
}

/** Build + sign a SUI payment of `amount` from `payer` to `to`. */
export async function buildPayment(
  client: VaClient,
  payer: Ed25519Keypair,
  to: string,
  amount: bigint,
): Promise<SignedPayment> {
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  // The Sui exact scheme (x402 #3081) requires a ValidDuring expiration with
  // both epochs set and a span of at most one; conformant facilitators reject
  // a payment without one. Same construction the SDK's own resolver uses.
  const [state, chain] = await Promise.all([
    client.getLatestSuiSystemState(),
    client.getChainIdentifier(),
  ]);
  const epoch = BigInt(state.epoch);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain,
      nonce: Math.floor(Math.random() * 4294967296),
    },
  });
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], to);
  const bytes = await tx.build({ client: client.grpc });
  const { signature } = await payer.signTransaction(bytes);
  return { transaction: toBase64(bytes), signature };
}

/** Derive the on-chain payer (sender) from a signed payment — no client claims. */
export function payerOf(payload: SignedPayment): string {
  const tx = Transaction.from(fromBase64(payload.transaction));
  const sender = tx.getData().sender;
  if (!sender) throw new Error("could not derive payer from signed payment");
  return sender;
}

/** x402 carries JSON in HTTP headers as base64. */
export const encodeHeader = (obj: unknown): string =>
  toBase64(new TextEncoder().encode(JSON.stringify(obj)));
export const decodeHeader = <T>(b64: string): T =>
  JSON.parse(new TextDecoder().decode(fromBase64(b64))) as T;

/**
 * Independent on-chain recompute: net `asset` credited to `payTo` by `digest`.
 * Raw JSON-RPC — the same "don't trust the facilitator, recompute it" check the
 * x402 conformance MCP makes. Returns the net amount (atomic units) actually moved.
 */
export async function onchainNetToPayTo(
  rpcUrl: string,
  digest: string,
  payTo: string,
  asset: string,
): Promise<bigint> {
  // gRPC: JSON-RPC's sui_getTransactionBlock is retired everywhere.
  const grpc = new SuiGrpcClient({
    network: rpcUrl.includes("testnet") ? "testnet" : "mainnet",
    baseUrl: rpcUrl,
  });
  const r: any = await grpc.getTransaction({ digest, include: { balanceChanges: true } });
  const tx: any = r?.$kind === "Transaction" ? r.Transaction : r?.FailedTransaction ?? r;
  const bc: any[] = (tx?.balanceChanges ?? []).map((b: any) => ({
    coinType: b.coinType, amount: b.amount, owner: { AddressOwner: b.address },
  }));
  const eq = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  let net = 0n;
  for (const c of bc) {
    const owner = c?.owner?.AddressOwner ?? c?.owner?.addressOwner ?? c?.owner;
    if (eq(owner, payTo) && eq(c?.coinType, asset)) net += BigInt(c.amount);
  }
  return net;
}

export const explorerUrl = (network: string, digest: string) =>
  isMainnet(network)
    ? `https://suivision.xyz/txblock/${digest}`
    : `https://testnet.suivision.xyz/txblock/${digest}`;
export const short = (s: string) => (s && s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
