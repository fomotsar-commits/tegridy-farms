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
import { isDeployed } from '../constants';
import { TEGRIDY_V4_MIGRATOR_ADDRESS } from './constants';

/** Canonical WETH on Ethereum mainnet. */
export const WETH_MAINNET: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
/**
 * Native ETH — the DEFAULT numeraire for Doppler dynamic auctions.
 *
 * The numeraire is NOT restricted to ETH. Doppler's dynamic-auction create flow mines
 * the token's CREATE2 address (`mineHookAddress`) to sort correctly against ANY
 * numeraire, and `UniswapV4Initializer` enforces only a SYMMETRIC ordering check
 * (`isToken0 && asset > numeraire || !isToken0 && asset < numeraire` reverts) — no
 * allowlist, no `require(numeraire == address(0))`. Verified against SDK v1.0.29 +
 * the deployed initializer, 2026-07-26.
 *
 * The earlier "pairing against WETH reverts InvalidTokenOrder()" note was a
 * MISDIAGNOSIS: WETH's high address (`0xC0…`, above 2^159) forces the token to the
 * opposite pool side (token = currency0), and the historical revert was that ordering
 * assumption breaking — NOT ERC20-ness. A LOW-address numeraire like TOWELI (`0x42…`)
 * takes ETH's exact path (numeraire = currency0, token = currency1), so an ERC20
 * numeraire is supported for our TOWELI-pegged exotic launches. See config.ts
 * TOWELI_NUMERAIRE / EXOTIC_LAUNCHES_ENABLED.
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
  /**
   * Numeraire to pair against. Default native ETH (address(0)). A LOW-address ERC20
   * (e.g. TOWELI) is supported and sorts like ETH; the SDK mines the token to satisfy
   * the initializer's ordering check. (Avoid a HIGH-address numeraire like WETH unless
   * you have re-verified the flipped ordering path.)
   */
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
  /**
   * OPTIONAL per-launch ECOSYSTEM RESERVE (owner directive 2026-08-22: "reserve
   * 5% off of each launch" for that pool's LP incentives / bribes / bounties).
   * Same on-chain mechanism as the creator premine — a DopplerERC20V1 pre-mint
   * vesting allocation, enforced by the token factory itself — but to a
   * PROTOCOL-CONTROLLED custody rather than the creator. The caller owns the
   * supply math: `initialSupply - numTokensToSell` must cover premine + reserve,
   * and this facade fails fast when it does not.
   *
   * DARK UNTIL CUSTODY EXISTS: nothing constructs this while
   * `ECOSYSTEM_RESERVE_RECIPIENT` (config.ts) is the zero address, and this
   * facade refuses a zero recipient outright — a reserve routed to 0x0 would be
   * a burn wearing an incentives label. Enabling is one change-set: custody
   * deploy → recipient constant → wizard supply math → Fact Sheet line (the
   * reserve must be disclosed as its own line, never lumped into
   * teamAllocationVestedBps — that field means CREATOR allocation and the
   * truth suite pins it). See docs/ULTIMATE_LAUNCHPAD_PLAN.md.
   */
  ecosystemReserve?: { recipient: Address; amount: bigint; durationSeconds: number; cliffSeconds?: number };
}

/**
 * Migration (graduated) V4 pool params. Unlike the auction pool, this has no <=30
 * constraint. Exported so the post-graduation locker read derives the migration
 * PoolId from the SAME fee/tickSpacing this launch config commits — the two can
 * never drift (a mismatch would compute a PoolId with no stream and silently read
 * nothing). Verified on-chain 2026-07-26: fee 3000 / tickSpacing 60.
 */
export const MIGRATION_POOL = { fee: 3000, tickSpacing: 60 } as const;

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
  /**
   * Override which LiquidityMigrator module the launch graduates through.
   *
   * WITHOUT this call the SDK resolves the chain default —
   * `overrides?.v4Migrator ?? addresses.v4Migrator` — i.e. Doppler's own
   * 0x0820…205f5, and the launch graduates into a hookless canonical pool. That
   * is the status quo and stays the behaviour until
   * `TEGRIDY_V4_MIGRATOR_ADDRESS` is set.
   *
   * Real SDK surface: `withV4Migrator(address)` on the dynamic-auction builder
   * (dist/evm/index.d.ts:2680), backed by `ModuleAddressOverrides.v4Migrator`
   * (d.ts:817).
   */
  withV4Migrator(address: Address): DopplerAuctionBuilder;
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
    // DEFENSE-IN-DEPTH (audit 2026-07-22): spread cfg.token FIRST so the pinned
    // `type` always wins and can never be spread-overridden — cfg.token is typed
    // without a `type` field today, so this is belt-and-suspenders, not a live hole.
    .tokenConfig({ ...cfg.token, type: 'dopplerERC20V1' })
    .saleConfig({
      initialSupply: cfg.initialSupply,
      numTokensToSell: cfg.numTokensToSell,
      numeraire: cfg.numeraire ?? NATIVE_ETH,
    });
  // ON-CHAIN premine vesting: only when a premine is actually reserved. This is
  // the sole path that makes a "vested" Fact Sheet claim TRUE — the reserved
  // premine (initialSupply - numTokensToSell) is locked to the creator under a
  // Doppler vesting schedule. Absent/zero => never called => byte-identical fair launch.
  const reserve = cfg.ecosystemReserve;
  if (reserve && reserve.amount > 0n) {
    // The ecosystem reserve rides the SAME factory-enforced pre-mint vesting the
    // creator premine uses — but the two lines carry different schedules and
    // different recipients, which is what the SDK's `allocations` variant is for.
    // Guard rails, both fail-fast: a zero recipient is a mislabeled burn, and an
    // allocation total exceeding the unsold remainder would revert on-chain deep
    // inside create() with a decoder error instead of a sentence.
    if (!isDeployed(reserve.recipient)) {
      throw new Error(
        'Ecosystem reserve recipient is unset (zero address). The reserve ships dark until its custody is deployed and ECOSYSTEM_RESERVE_RECIPIENT is filled — refusing to burn 5% of a launch.',
      );
    }
    const creatorPremine = cfg.vesting && cfg.vesting.amount > 0n ? cfg.vesting.amount : 0n;
    const unsold = cfg.initialSupply - cfg.numTokensToSell;
    if (creatorPremine + reserve.amount > unsold) {
      throw new Error(
        `Vesting allocations (creator ${creatorPremine} + reserve ${reserve.amount}) exceed the unsold remainder (${unsold}). The wizard's supply math must reserve both before the sale amount is derived.`,
      );
    }
    const allocations = [
      ...(creatorPremine > 0n
        ? [{
            recipient: cfg.userAddress,
            amount: creatorPremine,
            schedule: {
              duration: BigInt(cfg.vesting!.durationSeconds),
              cliffDuration: cfg.vesting!.cliffSeconds ?? 0,
            },
          }]
        : []),
      {
        recipient: reserve.recipient,
        amount: reserve.amount,
        schedule: {
          duration: BigInt(reserve.durationSeconds),
          cliffDuration: reserve.cliffSeconds ?? 0,
        },
      },
    ];
    builder = builder.withVesting({ allocations });
  } else if (cfg.vesting && cfg.vesting.amount > 0n) {
    // No reserve: the legacy single-recipient shape, byte-identical to every
    // launch shipped to date (and pinned by the existing tests).
    builder = builder.withVesting({
      recipients: [cfg.userAddress],
      amounts: [cfg.vesting.amount],
      duration: BigInt(cfg.vesting.durationSeconds),
      cliffDuration: cfg.vesting.cliffSeconds ?? 0,
    });
  }
  let withMigrator = builder
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
    .withUserAddress(cfg.userAddress);

  // OWN-VENUE GRADUATION. Point the launch at TegridyLiquidityMigrator so it
  // graduates into a canonical V4 pool carrying TegridyV4Hook — a venue the
  // protocol owns — instead of Doppler's hookless one.
  //
  // Gated on `isDeployed` and NOT called while the address is zero, which keeps
  // the status quo exactly: the SDK falls back to `addresses.v4Migrator`
  // (Doppler's 0x0820…205f5) and nothing about a launch changes. That fallback is
  // the honest default — flipping the constant before the module is whitelisted
  // AND granted the hook's initializer allowance would make every graduation
  // revert, and `Airlock.migrate` has already moved the funds by then.
  //
  // See TEGRIDY_V4_MIGRATOR_ADDRESS for the two preconditions.
  if (isDeployed(TEGRIDY_V4_MIGRATOR_ADDRESS)) {
    withMigrator = withMigrator.withV4Migrator(TEGRIDY_V4_MIGRATOR_ADDRESS);
  }

  const params = withMigrator.build();

  // Runs on the FINAL params — after the migrator is wired — so the band that
  // gets validated is the one actually going on-chain.
  assertMarketCapBandRoundTrips(params, cfg);
  return params;
}

/** Fractional tolerance for the market-cap round-trip. Absorbs tick-spacing rounding. */
const MARKET_CAP_ROUND_TRIP_TOLERANCE = 0.02;

/**
 * Local mirror of the SDK's `tickToMarketCap`
 * (node_modules/@whetstone-research/doppler-sdk/dist/evm/index.js, `function tickToMarketCap`).
 *
 * Reimplemented rather than imported to preserve this module's façade seam — a static SDK
 * import here would pull the heavy SDK (it ships Solana codecs) into every chunk that
 * touches airlock.ts, including launchBuy.ts and lockerStream.ts. The math is six lines and
 * stable. `airlock.test.ts` pins this against the REAL SDK function so drift fails CI; tests
 * may import the SDK freely because they do not ship.
 *
 * The `Math.abs` is faithful to the SDK, and is the whole point: it reports the band the
 * pool will ACTUALLY price at, which is what we need to compare against the declared band.
 */
export function tickToMarketCapUsd(
  tick: number,
  tokenSupply: bigint,
  numerairePriceUSD: number,
  tokenDecimals = 18,
  numeraireDecimals = 18,
): number {
  const ratio = Math.pow(1.0001, Math.abs(tick));
  const decimalAdjustment = 10 ** (tokenDecimals - numeraireDecimals);
  const tokenPriceUSD = numerairePriceUSD / (ratio / decimalAdjustment);
  const supplyNum = Number(tokenSupply) / 10 ** tokenDecimals;
  return tokenPriceUSD * supplyNum;
}

/**
 * Assert the ticks we are about to SUBMIT actually encode the band we DECLARED.
 *
 * The SDK's `marketCapToTicksForDynamicAuction` takes `Math.abs()` of both raw ticks and
 * then min/maxes them. When the two raw ticks straddle zero — i.e. the implied token price
 * crosses the numeraire price, which happens routinely on a cheap numeraire like TOWELI —
 * that `abs()` destroys the ordering and the resulting band is unrelated to the request.
 *
 * Measured on the shipped wizard defaults against a live TOWELI price: a declared
 * $300k -> $30k went on-chain as roughly $30.1k -> $8.3k, and `Airlock.create` SIMULATED
 * SUCCESSFULLY. Nothing on-chain rejects it, so without this guard the first exotic launch
 * would have been mispriced by ~10x, irreversibly, with no error shown to the creator.
 * The same class is reachable on the ETH rail at small supplies.
 *
 * We reverse the built ticks with the SDK's OWN `tickToMarketCap` — deliberately, because
 * it applies the same `abs()` and therefore reports the band the pool will actually price
 * at, not the band we wished for. Any material disagreement means the forward conversion
 * mangled the request, and we refuse BEFORE the user signs.
 */
function assertMarketCapBandRoundTrips(params: unknown, cfg: TegridyLaunchConfig): void {
  const auction = (params as { auction?: { startTick?: unknown; endTick?: unknown } })?.auction;
  const startTick = auction?.startTick;
  const endTick = auction?.endTick;
  // Defensive: if the SDK ever stops exposing ticks here, fail LOUD rather than
  // silently skipping the check that stands between us and a 10x mispriced launch.
  if (typeof startTick !== 'number' || typeof endTick !== 'number') {
    throw new Error(
      'Could not read the built auction ticks to verify the market-cap band. Refusing to launch unverified.',
    );
  }

  const toMarketCap = (tick: number): number =>
    tickToMarketCapUsd(tick, cfg.initialSupply, cfg.numerairePriceUsd);

  // The auction descends, so the higher-market-cap end is the start of the band.
  const a = toMarketCap(startTick);
  const b = toMarketCap(endTick);
  const actualStart = Math.max(a, b);
  const actualMin = Math.min(a, b);

  const off = (actual: number, declared: number): boolean =>
    !Number.isFinite(actual) || declared <= 0 || Math.abs(actual - declared) / declared > MARKET_CAP_ROUND_TRIP_TOLERANCE;

  if (off(actualStart, cfg.marketCap.start) || off(actualMin, cfg.marketCap.min)) {
    const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
    throw new Error(
      `Auction price band does not match what was configured. You asked for ` +
        `${fmt(cfg.marketCap.start)} -> ${fmt(cfg.marketCap.min)}, but these settings would go ` +
        `on-chain as ${fmt(actualStart)} -> ${fmt(actualMin)}. This is a known conversion defect ` +
        `that hits certain supply / numeraire-price combinations. Adjust the total supply or the ` +
        `market-cap range — or launch against ETH instead of TOWELI — and try again.`,
    );
  }
}

/** Convenience: the Doppler/protocol beneficiary line pointed at the Airlock owner (>=5% required). */
export function dopplerBeneficiaryLine(shareBps = DOPPLER_MIN_SHARE_BPS): FeeConstitutionLine & { address: Address } {
  return { recipient: 'Doppler', role: 'doppler', shareBps, address: DOPPLER_MAINNET.airlockOwner };
}
