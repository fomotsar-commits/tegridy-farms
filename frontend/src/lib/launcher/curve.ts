// TegridyCurveLauncher — the client interface to the own zero-toll launch curve.
//
// This is the PURE core: the ABI, per-chain address resolution, exact bigint
// mirrors of the on-chain curve math (so the UI can quote a buy/sell instantly
// without an RPC round-trip and still agree with the contract to the wei), and
// typed descriptors for the write calls a wagmi hook submits. No React, no chain
// access. The contract is contracts/src/curve/TegridyCurveLauncher.sol.
//
// WHY MIRROR THE MATH. The contract prices on a constant product over VIRTUAL
// reserves, and every rounding direction is load-bearing (buys round tokens-out
// DOWN, sells round eth-out DOWN — both grow k, keeping the curve solvent). A
// preview that rounds differently would show a quote the transaction then
// misses. These functions reproduce the Solidity exactly: same operations, same
// integer floor division (bigint `/` truncates toward zero, which equals floor
// for the non-negative operands here). curve.test.ts pins them against the
// contract's own formula.

import type { Address } from 'viem';
import { contractOn } from '../chains/registry';
import type { ContractAvailability } from '../chains/types';

// ─────────────────────────── constants (mirror the contract) ───────────────────────────

export const CURVE_BPS = 10_000n;
/** Every launch mints exactly 1B tokens, 18 decimals. */
export const CURVE_TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
/** graduationEth must be >= 19 * virtualEth (the 5% price-continuity band). */
export const CURVE_CONTINUITY_MULTIPLE = 19n;

// ─────────────────────────────── address resolution ────────────────────────────────

/**
 * Resolve the curve launcher on `chainId`, using the same three-state answer as
 * every other contract: 'deployed' (live), 'not-deployed' (served chain, not
 * live yet), or 'chain-unconfigured' (we don't serve this chain). The UI shows
 * "coming soon" for not-deployed and nothing for chain-unconfigured.
 */
export function curveLauncherOn(chainId: number | undefined | null): ContractAvailability {
  return contractOn(chainId, 'curveLauncher');
}

// ──────────────────────────────────── types ─────────────────────────────────────────

/** A launch's snapshotted economics + live curve state (the Launch struct). */
export interface CurveLaunch {
  creator: Address;
  virtualEth: bigint;
  graduationEth: bigint;
  feeBps: number;
  creatorFeeShareBps: number;
  treasuryFeeShareBps: number;
  reserveRecipient: Address;
  saleSupply: bigint;
  reserveAmount: bigint;
  ethReserve: bigint;
  tokenReserve: bigint;
  graduated: boolean;
}

/** The owner-tunable economics applied to FUTURE launches (the LaunchConfig struct). */
export interface CurveLaunchConfig {
  virtualEth: bigint;
  graduationEth: bigint;
  feeBps: number;
  creatorFeeShareBps: number;
  treasuryFeeShareBps: number;
  reserveBps: number;
  reserveRecipient: Address;
}

// ───────────────────────────── pure curve math (bigint) ─────────────────────────────

export interface BuyQuote {
  /** Fee skimmed off the ETH in, before the curve sees it. */
  fee: bigint;
  /** ETH that actually moves along the curve (ethGross - fee). */
  ethIn: bigint;
  /** Tokens the buyer receives (rounds DOWN, curve-favoring). */
  tokensOut: bigint;
  /** True if this buy would lift the reserve to the graduation target. */
  wouldGraduate: boolean;
}

/**
 * Quote a buy of `ethGross` wei against a live curve — the exact mirror of
 * TegridyCurveLauncher.previewBuy / _buy. Returns tokensOut === 0n for a dust
 * buy that prices to nothing (the contract reverts that; the UI should disable
 * the button rather than submit a reverting tx).
 */
export function previewBuy(launch: Pick<CurveLaunch, 'virtualEth' | 'ethReserve' | 'tokenReserve' | 'feeBps' | 'graduationEth'>, ethGross: bigint): BuyQuote {
  if (ethGross <= 0n) return { fee: 0n, ethIn: 0n, tokensOut: 0n, wouldGraduate: false };
  const feeBps = BigInt(launch.feeBps);
  const fee = (ethGross * feeBps) / CURVE_BPS;
  const ethIn = ethGross - fee;
  const x = launch.virtualEth + launch.ethReserve;
  const tokensOut = (launch.tokenReserve * ethIn) / (x + ethIn);
  const wouldGraduate = launch.ethReserve + ethIn >= launch.graduationEth;
  return { fee, ethIn, tokensOut, wouldGraduate };
}

export interface SellQuote {
  /** Gross ETH the curve releases, before the fee. */
  grossOut: bigint;
  /** Fee skimmed off the ETH out. */
  fee: bigint;
  /** NET ETH the seller receives (grossOut - fee), rounds DOWN. */
  ethOut: bigint;
}

/**
 * Quote a sell of `tokensIn` back to a live curve — the exact mirror of
 * TegridyCurveLauncher.previewSell / sell.
 */
export function previewSell(launch: Pick<CurveLaunch, 'virtualEth' | 'ethReserve' | 'tokenReserve' | 'feeBps'>, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) return { grossOut: 0n, fee: 0n, ethOut: 0n };
  const x = launch.virtualEth + launch.ethReserve;
  const grossOut = (x * tokensIn) / (launch.tokenReserve + tokensIn);
  const fee = (grossOut * BigInt(launch.feeBps)) / CURVE_BPS;
  const ethOut = grossOut - fee;
  return { grossOut, fee, ethOut };
}

export interface FeeSplit {
  creatorCut: bigint;
  treasuryCut: bigint;
  protocolCut: bigint;
}

/**
 * Split a fee three ways — the exact mirror of _accrueFee. Creator and treasury
 * round DOWN at their exact shares; protocol keeps the remainder, so the three
 * always sum to exactly `fee`.
 */
export function splitFee(fee: bigint, creatorFeeShareBps: number, treasuryFeeShareBps: number): FeeSplit {
  const creatorCut = (fee * BigInt(creatorFeeShareBps)) / CURVE_BPS;
  const treasuryCut = (fee * BigInt(treasuryFeeShareBps)) / CURVE_BPS;
  return { creatorCut, treasuryCut, protocolCut: fee - creatorCut - treasuryCut };
}

/**
 * How close a curve is to graduation, in bps of the target (0..10000, clamped).
 * Useful for a progress bar. graduationEth is never zero on a live launch.
 */
export function graduationProgressBps(ethReserve: bigint, graduationEth: bigint): number {
  if (graduationEth <= 0n) return 0;
  const raw = (ethReserve * CURVE_BPS) / graduationEth;
  return Number(raw > CURVE_BPS ? CURVE_BPS : raw);
}

/**
 * The pool's listing price as a fraction of the curve's final spot price, in bps
 * (the continuity metric). For this curve shape it is exactly
 * ethReserve / (virtualEth + ethReserve); the config guarantees it lands within
 * the 5% band at graduation (>= 9500).
 */
export function listingRatioBps(virtualEth: bigint, ethReserve: bigint): number {
  const denom = virtualEth + ethReserve;
  if (denom <= 0n) return 0;
  return Number((ethReserve * CURVE_BPS) / denom);
}

/** The sale supply a launch opens with, given a reserve carve in bps. */
export function saleSupplyForReserveBps(reserveBps: number): bigint {
  const reserveAmount = (CURVE_TOTAL_SUPPLY * BigInt(reserveBps)) / CURVE_BPS;
  return CURVE_TOTAL_SUPPLY - reserveAmount;
}

/**
 * Spot price of ONE whole token (1e18 units) in wei, from the same virtual
 * reserves the contract trades on. Floors, like every read here. Returns 0n for
 * an emptied tokenReserve (post-graduation state) rather than dividing by zero.
 */
export function curveSpotPriceWei(
  launch: Pick<CurveLaunch, 'virtualEth' | 'ethReserve' | 'tokenReserve'>,
): bigint {
  if (launch.tokenReserve <= 0n) return 0n;
  return ((launch.virtualEth + launch.ethReserve) * 10n ** 18n) / launch.tokenReserve;
}

/**
 * Market cap in wei: spot price x the FIXED total supply, computed in one
 * division so the only floor is the last one. This is an honest client-side
 * number on the EVM curve — supply is a compile-time constant and both reserves
 * come from one getLaunch read — unlike the Solana surface, whose no-fabricated-
 * FDV rule (OWN_CURVE_FRONTEND_CONTRACT §9) exists because neither is readable
 * there. Returns 0n post-graduation; the pool prices it from then on.
 */
export function curveMarketCapWei(
  launch: Pick<CurveLaunch, 'virtualEth' | 'ethReserve' | 'tokenReserve'>,
): bigint {
  if (launch.tokenReserve <= 0n) return 0n;
  return ((launch.virtualEth + launch.ethReserve) * CURVE_TOTAL_SUPPLY) / launch.tokenReserve;
}

/**
 * Pick which chain a curve token lives on from per-chain getLaunch probe
 * results. A token address does not name its chain — and the same address IS a
 * different contract on another chain in this very deploy history — so the
 * token page probes every deployed launcher and picks here:
 *   - `preferred` (the ?c= query param) wins when its probe succeeded;
 *   - otherwise the first success in probe order;
 *   - null when every probe failed (honest not-found, never a guess).
 * Pure so the tie-break is testable without wagmi.
 */
export function pickResolvedCurveChain(
  probes: ReadonlyArray<{ chainId: number; ok: boolean }>,
  preferred?: number,
): number | null {
  if (preferred !== undefined && probes.some((p) => p.chainId === preferred && p.ok)) {
    return preferred;
  }
  return probes.find((p) => p.ok)?.chainId ?? null;
}

// ─────────────────────────── write-call descriptors (for wagmi) ────────────────────────

/**
 * A ready-to-submit contract write: the address, function, args and (for
 * payable calls) the ETH value. A component passes the spread of one of these
 * straight into `writeContract`. Keeping them here means the argument order and
 * payability live next to the ABI, not scattered through components.
 */
export interface CurveWrite {
  address: Address;
  abi: typeof CURVE_LAUNCHER_ABI;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export function createLaunchCall(launcher: Address, name: string, symbol: string, openingBuyWei = 0n): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'create', args: [name, symbol], value: openingBuyWei };
}

export function buyCall(launcher: Address, token: Address, ethGross: bigint, minTokensOut: bigint): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'buy', args: [token, minTokensOut], value: ethGross };
}

export function sellCall(launcher: Address, token: Address, tokensIn: bigint, minEthOut: bigint): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'sell', args: [token, tokensIn, minEthOut] };
}

export function claimCreatorFeesCall(launcher: Address, token: Address): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'claimCreatorFees', args: [token] };
}

export function sweepTreasuryFeesCall(launcher: Address): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'sweepTreasuryFees', args: [] };
}

export function finalizeGraduationCall(launcher: Address, token: Address): CurveWrite {
  return { address: launcher, abi: CURVE_LAUNCHER_ABI, functionName: 'finalizeGraduation', args: [token] };
}

/**
 * Apply a slippage tolerance (in bps) to a quoted output to get the on-chain
 * `minOut` floor. Rounds DOWN so the floor is never above the quote.
 */
export function withSlippage(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * (CURVE_BPS - BigInt(slippageBps))) / CURVE_BPS;
}

// ──────────────────────────────────── ABI ───────────────────────────────────────────

export const CURVE_LAUNCHER_ABI = [
  { type: 'function', name: 'create', stateMutability: 'payable', inputs: [{ name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }], outputs: [{ name: 'token', type: 'address' }] },
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'minTokensOut', type: 'uint256' }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensIn', type: 'uint256' }, { name: 'minEthOut', type: 'uint256' }], outputs: [{ name: 'ethOut', type: 'uint256' }] },
  { type: 'function', name: 'claimCreatorFees', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'sweepTreasuryFees', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'finalizeGraduation', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  {
    type: 'function', name: 'getLaunch', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }],
    outputs: [{
      name: '', type: 'tuple', components: [
        { name: 'creator', type: 'address' },
        { name: 'virtualEth', type: 'uint128' },
        { name: 'graduationEth', type: 'uint128' },
        { name: 'feeBps', type: 'uint16' },
        { name: 'creatorFeeShareBps', type: 'uint16' },
        { name: 'treasuryFeeShareBps', type: 'uint16' },
        { name: 'reserveRecipient', type: 'address' },
        { name: 'saleSupply', type: 'uint256' },
        { name: 'reserveAmount', type: 'uint256' },
        { name: 'ethReserve', type: 'uint256' },
        { name: 'tokenReserve', type: 'uint256' },
        { name: 'graduated', type: 'bool' },
      ],
    }],
  },
  { type: 'function', name: 'previewBuy', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'ethGross', type: 'uint256' }], outputs: [{ name: 'tokensOut', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'wouldGraduate', type: 'bool' }] },
  { type: 'function', name: 'previewSell', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensIn', type: 'uint256' }], outputs: [{ name: 'ethOut', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
  {
    type: 'function', name: 'launchConfig', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'virtualEth', type: 'uint128' },
      { name: 'graduationEth', type: 'uint128' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'creatorFeeShareBps', type: 'uint16' },
      { name: 'treasuryFeeShareBps', type: 'uint16' },
      { name: 'reserveBps', type: 'uint16' },
      { name: 'reserveRecipient', type: 'address' },
    ],
  },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'creatorFeeOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'protocolFees', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'treasuryFees', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'launchCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allLaunches', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'allLaunchesPaginated', stateMutability: 'view', inputs: [{ name: 'start', type: 'uint256' }, { name: 'count', type: 'uint256' }], outputs: [{ name: 'page', type: 'address[]' }] },
  { type: 'function', name: 'TOTAL_SUPPLY', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'event', name: 'LaunchCreated', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'saleSupply', type: 'uint256', indexed: false },
      { name: 'reserveAmount', type: 'uint256', indexed: false },
      { name: 'virtualEth', type: 'uint128', indexed: false },
      { name: 'graduationEth', type: 'uint128', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
      { name: 'creatorFeeShareBps', type: 'uint16', indexed: false },
      { name: 'treasuryFeeShareBps', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event', name: 'CurveBuy', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'ethIn', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
      { name: 'ethReserve', type: 'uint256', indexed: false },
      { name: 'tokenReserve', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Graduated', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'pair', type: 'address', indexed: true },
      { name: 'ethToPool', type: 'uint256', indexed: false },
      { name: 'tokensToPool', type: 'uint256', indexed: false },
      { name: 'reserveToCustody', type: 'uint256', indexed: false },
      { name: 'reserveRecipient', type: 'address', indexed: false },
    ],
  },
] as const;
