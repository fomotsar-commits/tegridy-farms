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
// FAÇADE SEAM: `@whetstone-research/doppler-sdk` IS a dependency (see
// launchService.ts, which imports the real `DopplerSDK` and casts it through the
// `DopplerEvmSdkLike` façade below). The façade is retained deliberately — it is the
// tested boundary this policy is written against and keeps airlock.ts free of the
// heavy SDK's runtime weight (it ships Solana codecs). The call sites match the real
// surface, verified end-to-end on a mainnet fork.

import type { Address } from 'viem';
import type { FeeConstitutionLine, LaunchTier } from './factSheet';
import { DOPPLER_MAINNET } from './doppler.constants';

/** Canonical WETH on Ethereum mainnet (numeraire for our launches). */
export const WETH_MAINNET: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
/**
 * Native ETH — the DEFAULT numeraire for Doppler dynamic auctions. Verified on a
 * mainnet fork (2026-07-17): pairing against WETH reverts `InvalidTokenOrder()`
 * (V4 currency ordering / CREATE2 token-address mining). address(0) is always
 * currency0, so the launched token sorts deterministically. Use native ETH.
 */
export const NATIVE_ETH: Address = '0x0000000000000000000000000000000000000000';

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
  /**
   * Dutch-auction market-cap band in USD: `start` (launch cap) DESCENDS to `min`
   * (floor). Verified: dynamic auctions use start/min (not start/end) — the SDK
   * derives a gamma-valid, tickSpacing<=30 curve from this + numerairePrice.
   */
  marketCap: { start: number; min: number };
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
  /** Numeraire to pair against. Default native ETH (address(0)); WETH reverts InvalidTokenOrder. */
  numeraire?: Address;
  /** Trade-fee tier (hundredths of a bip). Default 10000 = 1%, auto-derives a valid tickSpacing. */
  feeTier?: number;
  /**
   * Seconds to schedule the auction start ahead of `now`. REQUIRED buffer: the
   * start is fixed at build time, and if block.timestamp passes it before the tx
   * mines, the hook reverts `InvalidStartTime()`. Default 600s (>> mainnet latency).
   */
  startTimeOffsetSeconds?: number;
  /**
   * OPTIONAL premine placed under an ON-CHAIN Doppler vesting schedule to the
   * creator (`userAddress`). `amount` is the reserved premine — expected to be
   * `initialSupply - numTokensToSell` (the DopplerERC20V1 template mints the
   * non-sold remainder and the locker holds it under this schedule). When absent
   * (or amount is 0), we DO NOT call `.withVesting` — a pure fair launch, byte-for-byte
   * identical to the no-premine path. This is what lets the Fact Sheet truthfully
   * claim "vested": the tokens are locked by the on-chain schedule, not merely promised.
   */
  vesting?: { amount: bigint; durationSeconds: number; cliffSeconds?: number };
}

/** Migration (graduated) V4 pool params. Unlike the auction pool, this has no <=30 constraint. */
const MIGRATION_POOL = { fee: 3000, tickSpacing: 60 } as const;

/**
 * Doppler `BuilderVestingInput` (simple recipients/amounts form), mirrored from
 * `@whetstone-research/doppler-sdk/dist/evm` (BuilderVestingInput, read 2026-07-17).
 * `duration` is a bigint (seconds); `cliffDuration` is a number (seconds). We use the
 * recipients/amounts variant — one creator recipient — not the `allocations[]` variant.
 */
export interface BuilderVestingInput {
  duration?: bigint;
  cliffDuration?: number;
  recipients?: Address[];
  amounts?: bigint[];
}

/** Minimal faithful façade of the real doppler-sdk/evm surface we call. */
export interface DopplerAuctionBuilder {
  tokenConfig(c: { type?: 'dopplerERC20V1'; name: string; symbol: string; tokenURI: string }): DopplerAuctionBuilder;
  saleConfig(c: { initialSupply: bigint; numTokensToSell: bigint; numeraire: Address }): DopplerAuctionBuilder;
  /** Configure on-chain vesting for a premine. Omitted entirely on a fair launch. */
  withVesting(params: BuilderVestingInput): DopplerAuctionBuilder;
  withMarketCapRange(c: {
    marketCap: { start: number; min: number };
    numerairePrice: number;
    minProceeds: bigint;
    maxProceeds: bigint;
    fee: number;
  }): DopplerAuctionBuilder;
  withTime(c: { startTimeOffset: number }): DopplerAuctionBuilder;
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
  const beneficiaries = feeConstitutionToBeneficiaries(cfg.feeConstitution);
  // withMarketCapRange handles the auction pool (tickSpacing<=30, tick direction,
  // gamma) from the fee tier — so we do NOT call poolConfig (which reverts on a
  // >30 tickSpacing). The migration pool is configured separately below.
  let builder = sdk
    .buildDynamicAuction()
    // Pin the VERIFIED-SAFE template. Without `type: 'dopplerERC20V1'` the SDK
    // defaults to a StandardToken (CloneERC20) that our gate does not whitelist;
    // DopplerERC20V1 is the audited no-mint/no-tax/pool-lock/vesting template.
    .tokenConfig({ type: 'dopplerERC20V1', ...cfg.token })
    .saleConfig({
      initialSupply: cfg.initialSupply,
      numTokensToSell: cfg.numTokensToSell,
      numeraire: cfg.numeraire ?? NATIVE_ETH,
    });
  // ON-CHAIN premine vesting: only when a premine is actually reserved. This is
  // the sole path that makes a "vested" Fact Sheet claim TRUE — the reserved
  // premine (initialSupply - numTokensToSell) is locked to the creator under a
  // Doppler vesting schedule. Absent/zero => never called => byte-identical fair launch.
  if (cfg.vesting && cfg.vesting.amount > 0n) {
    builder = builder.withVesting({
      recipients: [cfg.userAddress],
      amounts: [cfg.vesting.amount],
      duration: BigInt(cfg.vesting.durationSeconds),
      cliffDuration: cfg.vesting.cliffSeconds ?? 0,
    });
  }
  return builder
    .withMarketCapRange({
      marketCap: cfg.marketCap,
      numerairePrice: cfg.numerairePriceUsd,
      minProceeds: cfg.minProceeds,
      maxProceeds: cfg.maxProceeds,
      fee: cfg.feeTier ?? 10_000, // 1% — our constitution's trade fee
    })
    .withTime({ startTimeOffset: cfg.startTimeOffsetSeconds ?? 600 })
    .withMigration({
      type: 'uniswapV4',
      fee: MIGRATION_POOL.fee,
      tickSpacing: MIGRATION_POOL.tickSpacing,
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
