// Tegridy launch policy over the Doppler SDK — encodes OUR config, integrator
// address, and fee constitution onto the real builder API.
//
// API grounded in the real SDK (whetstoneresearch/doppler-sdk, examples/
// dynamic-auction-v4.ts + docs/api-builders.md, read 2026-07-17):
//   sdk.buildDynamicAuction() | buildStaticAuction()
//     .tokenConfig({ name, symbol, tokenURI })
//     .saleConfig({ initialSupply, numTokensToSell, numeraire })
//     .withMarketCapRange({ marketCap, numerairePrice, minProceeds, maxProceeds })
//     .withGovernance({ type })
//     .withMigration({ type:'uniswapV4', fee, tickSpacing, streamableFees:{ lockDuration, beneficiaries } })
//     .withIntegrator(address)      <-- our fee capture
//     .withUserAddress(address)
//     .build()
//   sdk.factory.createDynamicAuction(params) -> { hookAddress, tokenAddress, poolId, transactionHash }
//
// SPIKE NOTE: to avoid mutating the shared frontend lockfile with the heavy SDK
// (it ships Solana codecs) during the spike, we type against a faithful FAÇADE
// of the real surface. Swap `DopplerEvmSdkLike` for
// `import { DopplerSDK } from '@whetstone-research/doppler-sdk/evm'` when the
// dependency is added — the call sites are already correct.

import type { Address } from 'viem';
import type { FeeConstitutionLine, LaunchTier } from './factSheet';
import { DOPPLER_MAINNET } from './doppler.constants';

/** Canonical WETH on Ethereum mainnet (numeraire for our launches). */
export const WETH_MAINNET: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/** WAD (1e18) — the Doppler locker requires beneficiary shares to sum to exactly this. */
const WAD = 10n ** 18n;
const BPS_TOTAL = 10_000n;
/** Doppler enforces the Airlock owner (protocol) receives >= 5% of streamed fees. */
const DOPPLER_MIN_SHARE_BPS = 500;

export interface StreamBeneficiary {
  beneficiary: Address;
  /** WAD share of the streamed LP fees; the set sums to exactly 1e18. */
  shares: bigint;
}

/**
 * Convert a bps fee constitution into Doppler StreamableFeesLocker beneficiaries.
 * - bps must sum to 10000.
 * - shares are WAD and sum to exactly 1e18 (1e18/10000 = 1e14 is integral, so exact).
 * - the Doppler/airlock-owner line must be >= 5% or the locker rejects the launch.
 * - beneficiaries are returned sorted ascending by address (locker dedupe/order safety).
 */
export function feeConstitutionToBeneficiaries(
  lines: readonly (FeeConstitutionLine & { address: Address })[],
): StreamBeneficiary[] {
  const totalBps = lines.reduce((n, l) => n + l.shareBps, 0);
  if (totalBps !== Number(BPS_TOTAL)) {
    throw new Error(`fee constitution must sum to 10000 bps, got ${totalBps}`);
  }
  const dopplerBps = lines.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
  if (dopplerBps < DOPPLER_MIN_SHARE_BPS) {
    throw new Error(`Doppler/protocol beneficiary must be >= ${DOPPLER_MIN_SHARE_BPS} bps, got ${dopplerBps}`);
  }
  const beneficiaries = lines.map((l) => ({
    beneficiary: l.address,
    shares: (BigInt(l.shareBps) * WAD) / BPS_TOTAL,
  }));
  const sum = beneficiaries.reduce((n, b) => n + b.shares, 0n);
  if (sum !== WAD) throw new Error(`beneficiary shares must sum to 1e18, got ${sum}`);
  return beneficiaries.sort((a, b) => (a.beneficiary.toLowerCase() < b.beneficiary.toLowerCase() ? -1 : 1));
}

export interface TegridyLaunchConfig {
  tier: Extract<LaunchTier, 'flagship' | 'listable'>;
  token: { name: string; symbol: string; tokenURI: string };
  initialSupply: bigint;
  numTokensToSell: bigint;
  /** Target market cap band (numeraire units) + numeraire price in USD, per SDK withMarketCapRange. */
  marketCap: { start: number; end: number };
  numerairePriceUsd: number;
  minProceeds: bigint;
  maxProceeds: bigint;
  /** Our fee constitution WITH resolved addresses (creator/attention/protocol/doppler). */
  feeConstitution: (FeeConstitutionLine & { address: Address })[];
  /** The integrator address that captures the integrator fee share (a Tegridy multisig). */
  integrator: Address;
  /** LP fee-stream lock (seconds). Flagship default 365d. */
  lockDurationSeconds: number;
  /** Creator / launcher user address. */
  userAddress: Address;
}

/** Pool params per tier (flagship uses the dynamic Dutch-auction curve; both graduate to V4). */
function poolParamsForTier(tier: TegridyLaunchConfig['tier']): { fee: number; tickSpacing: number } {
  // 0.30% / 60 is the Doppler example default and a sane meme/utility pool.
  return tier === 'flagship' ? { fee: 3000, tickSpacing: 60 } : { fee: 3000, tickSpacing: 60 };
}

/** Minimal faithful façade of the real doppler-sdk/evm surface we call. */
export interface DopplerAuctionBuilder {
  tokenConfig(c: { name: string; symbol: string; tokenURI: string }): DopplerAuctionBuilder;
  saleConfig(c: { initialSupply: bigint; numTokensToSell: bigint; numeraire: Address }): DopplerAuctionBuilder;
  withMarketCapRange(c: {
    marketCap: { start: number; end: number };
    numerairePrice: number;
    minProceeds: bigint;
    maxProceeds: bigint;
  }): DopplerAuctionBuilder;
  poolConfig(c: { fee: number; tickSpacing: number }): DopplerAuctionBuilder;
  withMigration(c: {
    type: 'uniswapV4';
    fee: number;
    tickSpacing: number;
    streamableFees: { lockDuration: number; beneficiaries: StreamBeneficiary[] };
  }): DopplerAuctionBuilder;
  withGovernance(c: { type: 'default' | 'noOp' | 'launchpad' | 'custom' }): DopplerAuctionBuilder;
  withIntegrator(address: Address): DopplerAuctionBuilder;
  withUserAddress(address: Address): DopplerAuctionBuilder;
  build(): unknown;
}

export interface DopplerEvmSdkLike {
  buildDynamicAuction(): DopplerAuctionBuilder;
  factory: {
    createDynamicAuction(params: unknown): Promise<{
      hookAddress: Address;
      tokenAddress: Address;
      poolId: string;
      transactionHash: Address;
    }>;
    simulateCreateDynamicAuction?(params: unknown): Promise<unknown>;
  };
}

/**
 * Build (but do not submit) the Doppler create-params for a Tegridy launch.
 * Pure orchestration over the SDK builder — encodes our policy; returns the
 * built params ready for `sdk.factory.createDynamicAuction` (or simulate first).
 */
export function buildTegridyLaunchParams(sdk: DopplerEvmSdkLike, cfg: TegridyLaunchConfig): unknown {
  const pool = poolParamsForTier(cfg.tier);
  const beneficiaries = feeConstitutionToBeneficiaries(cfg.feeConstitution);
  return sdk
    .buildDynamicAuction()
    .tokenConfig(cfg.token)
    .saleConfig({ initialSupply: cfg.initialSupply, numTokensToSell: cfg.numTokensToSell, numeraire: WETH_MAINNET })
    .withMarketCapRange({
      marketCap: cfg.marketCap,
      numerairePrice: cfg.numerairePriceUsd,
      minProceeds: cfg.minProceeds,
      maxProceeds: cfg.maxProceeds,
    })
    .poolConfig(pool)
    .withMigration({
      type: 'uniswapV4',
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      streamableFees: { lockDuration: cfg.lockDurationSeconds, beneficiaries },
    })
    .withGovernance({ type: cfg.tier === 'flagship' ? 'default' : 'noOp' })
    .withIntegrator(cfg.integrator)
    .withUserAddress(cfg.userAddress)
    .build();
}

/** Convenience: the Doppler/protocol beneficiary line pointed at the Airlock owner (>=5% required). */
export function dopplerBeneficiaryLine(shareBps = DOPPLER_MIN_SHARE_BPS): FeeConstitutionLine & { address: Address } {
  return { recipient: 'Doppler', role: 'doppler', shareBps, address: DOPPLER_MAINNET.airlockOwner };
}
