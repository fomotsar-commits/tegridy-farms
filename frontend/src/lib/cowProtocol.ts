// CoW Protocol (CoW Swap) limit-order primitives.
//
// Battle-tested source: CoW Protocol's GPv2 settlement EIP-712 order schema +
// the public orderbook API (https://docs.cow.fi). A CoW limit order is a real,
// decentralized, gasless order — the user signs an EIP-712 `Order`, it goes to
// CoW's orderbook, and CoW solvers settle it on-chain when the limit price is
// met. Unlike the browser-resident keeper path, it survives tab close and needs
// no per-fill signature.
//
// This module is the PURE core (addresses, EIP-712 types, order construction,
// appData hashing, the proxy URL). The signing + approval + submission lifecycle
// lives in hooks/useCowLimitOrder.ts. ERC-20 sell tokens only — native-ETH sells
// require CoW's separate EthFlow contract and are intentionally out of scope.

import { keccak256, stringToHex, type Address } from 'viem';

// ─── GPv2 contracts (deterministic; identical across mainnet/gnosis/arbitrum/base) ──
// The settlement contract is the EIP-712 verifyingContract.
export const COW_SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as Address;
// The spender users must approve for the SELL token (NOT the settlement contract).
export const COW_VAULT_RELAYER_ADDRESS = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as Address;

// EIP-712 domain. `verifyingContract` = the settlement contract.
export function cowDomain(chainId: number) {
  return {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId,
    verifyingContract: COW_SETTLEMENT_ADDRESS,
  } as const;
}

// The canonical GPv2 `Order` EIP-712 type. Field ORDER is consensus-critical —
// it must match the settlement contract + CoW SDK byte-for-byte.
export const COW_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

// appData: a JSON document describing order provenance. CoW re-hashes the
// submitted string and requires it to equal `appDataHash` (= the bytes32 used in
// the signed Order.appData field). Any valid JSON works as long as the hash
// matches; we use a stable, minimal document so the hash is deterministic.
export const COW_APP_DATA_DOC = JSON.stringify({
  appCode: 'Tegridy Farms',
  metadata: {},
  version: '1.1.0',
});
export const COW_APP_DATA_HASH: `0x${string}` = keccak256(stringToHex(COW_APP_DATA_DOC));

// The signed order message (EIP-712 `Order`). Amounts are base-unit bigints.
export interface CowOrder {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number; // uint32 unix seconds
  appData: `0x${string}`; // = COW_APP_DATA_HASH
  feeAmount: bigint;
  kind: 'sell' | 'buy';
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
}

/**
 * Build a canonical CoW limit SELL order: sell exactly `sellAmount` of `sellToken`
 * for AT LEAST `buyAmount` of `buyToken` (the limit price), valid until `validTo`.
 * `feeAmount` is 0 under CoW's surplus-fee model — `buyAmount` is the floor the
 * user is guaranteed; solvers keep any positive spread.
 */
export function buildLimitSellOrder(params: {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  receiver: Address;
}): CowOrder {
  return {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmount,
    validTo: params.validTo,
    appData: COW_APP_DATA_HASH,
    feeAmount: 0n,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };
}

// The orderbook `POST /orders` body. Bigints are stringified; the signature, the
// signing scheme, the submitter, and BOTH the appData doc + its hash are attached.
export interface CowOrderSubmission {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  feeAmount: string;
  kind: 'sell' | 'buy';
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
  signingScheme: 'eip712';
  signature: `0x${string}`;
  from: Address;
  appData: string; // the JSON doc string
  appDataHash: `0x${string}`;
}

export function toOrderSubmission(
  order: CowOrder,
  signature: `0x${string}`,
  from: Address,
): CowOrderSubmission {
  return {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    validTo: order.validTo,
    feeAmount: order.feeAmount.toString(),
    kind: order.kind,
    partiallyFillable: order.partiallyFillable,
    sellTokenBalance: order.sellTokenBalance,
    buyTokenBalance: order.buyTokenBalance,
    signingScheme: 'eip712',
    signature,
    from,
    appData: COW_APP_DATA_DOC,
    appDataHash: COW_APP_DATA_HASH,
  };
}

// URL for the CoW mainnet orderbook, routed through the hardened aggregator proxy.
// `path` is e.g. "orders" or "orders/<uid>".
//
// MUST be the `/api/cow/...` alias, NOT `/api/aggregator/cow/...`. The proxy is a
// FLAT function (api/aggregator.js) that only serves `/api/aggregator` exactly —
// nested `/api/aggregator/<provider>/...` never routed reliably, which is why
// frontend/vercel.json rewrites `/api/cow/:path*` → `/api/aggregator?provider=cow&p=:path*`
// (and the vite dev proxy likewise only knows `/api/cow`). Until 2026-07-22 this
// returned the nested form and silently 404/405'd in prod; the alias is the same
// base the live price-comparison quote (lib/aggregator.ts getCowSwapQuote) uses,
// so it is confirmed to route from the browser. Both hit the identical
// per-provider allowlist in api/_lib/aggregator-proxy.js once routed.
export function cowOrderbookUrl(path: string): string {
  return `/api/cow/mainnet/api/v1/${path}`;
}

// Order status as returned by GET /orders/{uid}.status.
export type CowOrderStatus =
  | 'open'
  | 'scheduled'
  | 'active'
  | 'solved'
  | 'executing'
  | 'traded'
  | 'fulfilled'
  | 'cancelled'
  | 'expired'
  | 'presignaturePending';

// A status from which the order will never progress further.
export function isTerminalStatus(s: string): boolean {
  return s === 'fulfilled' || s === 'traded' || s === 'cancelled' || s === 'expired';
}
