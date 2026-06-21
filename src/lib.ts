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
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

export const SUI = "0x2::sui::SUI";
export const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
export const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";

const isMainnet = (network: string) => network === "sui:mainnet";
export const rpcFor = (network: string) => (isMainnet(network) ? MAINNET_RPC : TESTNET_RPC);

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

export function getClient(network = "sui:testnet"): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    url: process.env.SUI_RPC ?? rpcFor(network),
    network: isMainnet(network) ? "mainnet" : "testnet",
  });
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
export async function ensureGas(client: SuiJsonRpcClient, addr: string): Promise<bigint> {
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
  client: SuiJsonRpcClient,
  payer: Ed25519Keypair,
  to: string,
  amount: bigint,
): Promise<SignedPayment> {
  const tx = new Transaction();
  tx.setSender(payer.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], to);
  const bytes = await tx.build({ client });
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
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getTransactionBlock",
      params: [digest, { showBalanceChanges: true, showEffects: true }],
    }),
  });
  const json: any = await res.json();
  const bc: any[] = json?.result?.balanceChanges ?? [];
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
