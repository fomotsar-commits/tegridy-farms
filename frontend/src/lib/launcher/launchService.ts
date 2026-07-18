// Live Doppler launch submit path — the seam between the wizard and the real
// on-chain create. Kept behind isLauncherEnabled() (false today): this module is
// COMPLETE but dormant. It instantiates the real DopplerSDK and drives it through
// airlock.ts's tested policy (buildTegridyLaunchParams), which is the single place
// our fork-verified constraints live — this file never re-derives them.
//
// Flow: wizard state -> wizardConfigToLaunchConfig -> TegridyLaunchConfig ->
//   buildTegridyLaunchParams(sdk) -> simulate (surfaces reverts) -> create.

import { parseEther, type Address, type PublicClient, type WalletClient } from 'viem';
import { DopplerSDK, type CreateDynamicAuctionParams } from '@whetstone-research/doppler-sdk/evm';
import {
  buildTegridyLaunchParams,
  dopplerBeneficiaryLine,
  type DopplerEvmSdkLike,
  type TegridyLaunchConfig,
} from './airlock';
import { DOPPLER_MAINNET } from './doppler.constants';
import {
  DEFAULT_FEE_CONSTITUTION,
  LAUNCHER_INTEGRATOR_ADDRESS,
  LAUNCH_FEE_TIER,
  isLauncherEnabled,
} from './config';
import type { FeeConstitutionLine } from './factSheet';
import { REVENUE_DISTRIBUTOR_ADDRESS } from '../constants';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** 365/12 days per month (matches LaunchPage's MONTH), so a "12-month lock" is exactly 365 days. */
const MONTH_SECONDS = (365 / 12) * 86_400;

/**
 * Conservative policy cap on the insider premine (20%). The premine is placed under
 * an on-chain vesting schedule (see airlock.ts), but a large insider allocation is a
 * structural risk regardless of vesting — cap it, consistent with the minimal-surface
 * stance. A creator wanting more must do it outside this rail. Exported so the wizard
 * slider and this mapper share one source of truth.
 */
export const MAX_PREMINE_BPS = 2000;

/** Auction-start buffer; the auction start is fixed at build time (see airlock.ts). */
const START_TIME_OFFSET_SECONDS = 600;

/** Sane default proceeds band (numeraire = native ETH, wei). Overridable via opts. */
const DEFAULT_MIN_PROCEEDS = parseEther('1'); // 1 ETH raise floor
const DEFAULT_MAX_PROCEEDS = parseEther('1000'); // 1000 ETH raise cap

/** The successful create() result the SDK returns. */
export interface LaunchResult {
  tokenAddress: Address;
  hookAddress: Address;
  poolId: string;
  transactionHash: string;
}

/** Discriminated failure reasons, so the UI can render a specific message. */
export type LaunchErrorCode =
  | 'launcher-disabled' // gate is shut (isLauncherEnabled() === false)
  | 'invalid-integrator' // integrator is the zero address (defense in depth)
  | 'invalid-config' // params could not be built from the config (bad tier/fee/tick input)
  | 'simulation-failed' // simulateCreateDynamicAuction reverted (bad config / on-chain preconditions)
  | 'submit-failed'; // createDynamicAuction failed (user rejected / tx reverted)

/** Typed error thrown by launchToken — always carries a machine-readable `code`. */
export class LaunchError extends Error {
  readonly code: LaunchErrorCode;
  readonly cause?: unknown;
  constructor(code: LaunchErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Structural subset of the LaunchPage wizard state that the mapper consumes.
 * Declared here (not imported from the page) so this lib has no page dependency;
 * LaunchPage's WizardState structurally satisfies it.
 */
export interface LaunchWizardInput {
  name: string;
  symbol: string;
  tokenURI: string;
  tier: TegridyLaunchConfig['tier'];
  /** Whole tokens (no decimals) — scaled to 18-decimal base units by the mapper. */
  totalSupply: string;
  /** Insider allocation in bps; reserved out of the auctioned amount and on-chain vested. */
  premineBps: number;
  /**
   * On-chain vesting duration for the premine, in months. Required (> 0) whenever
   * `premineBps > 0` — the reserved premine is locked to the creator under a Doppler
   * vesting schedule for this long, which is what makes the Fact Sheet's "vested"
   * disclosure truthful. Ignored when `premineBps === 0`.
   */
  vestMonths: number;
  /** Optional cliff (months) before premine vesting begins; 0..vestMonths. */
  cliffMonths?: number;
  /** Dutch-auction START (high) market cap, in $ thousands. */
  mcapStartK: number;
  /** Descends toward this FLOOR market cap, in $ thousands. */
  mcapFloorK: number;
  lpLockMonths: number;
}

/**
 * A creator-directed beneficiary that carves part of the creator's launch share
 * to a KOL / community address (the Bags-style perpetual-split lever). Its bps
 * come OUT OF the combined creator+attention pool (never out of protocol/Doppler).
 */
export interface AttentionSplit {
  address: Address;
  /** Basis points directed to this beneficiary, out of the creator+attention pool. */
  shareBps: number;
}

export interface LaunchMapOptions {
  /** Creator / launcher (connected wallet). Receives the creator fee line. */
  userAddress: Address;
  /** Current ETH/USD price — the numeraire price the market-cap curve is derived from. */
  numerairePriceUsd: number;
  /**
   * Creator-directed KOL/community beneficiaries. Each shareBps is carved out of
   * the combined creator+attention pool (8000 bps); the creator keeps the
   * remainder. Omitted/empty => the whole pool stays with the creator. A split
   * pointed at the creator's own address simply merges back into the creator line.
   */
  attentionSplits?: readonly AttentionSplit[];
  /** Override the default proceeds band (numeraire wei). */
  minProceeds?: bigint;
  maxProceeds?: bigint;
}

type ResolvedLine = FeeConstitutionLine & { address: Address };

/** The combined creator+attention pool (bps) — the only creator-directable portion. */
const CREATOR_ATTENTION_POOL_BPS = DEFAULT_FEE_CONSTITUTION.filter(
  (l) => l.role === 'creator' || l.role === 'attention-beneficiary',
).reduce((n, l) => n + l.shareBps, 0);

/**
 * Resolve DEFAULT_FEE_CONSTITUTION to concrete addresses, carving the creator's
 * attention splits out of the combined creator+attention pool, then COALESCE
 * lines that resolve to the same address (summing bps).
 *
 * The creator+attention pool (8000 bps) is split as (8000 - sum(splits)) to the
 * creator plus each split to its address; the protocol (1500) and Doppler (500)
 * lines are FIXED and never touched. The StreamableFeesLocker requires unique
 * beneficiaries, so coalescing keeps the set unique (a KOL == creator merges)
 * while preserving the 10000-bps total and the >=500-bps Doppler floor.
 */
function resolveFeeConstitution(userAddress: Address, attentionSplits: readonly AttentionSplit[] = []): ResolvedLine[] {
  // Validate the creator's carve-out: non-negative whole bps that don't over-allocate.
  let splitSum = 0;
  for (const s of attentionSplits) {
    if (!Number.isInteger(s.shareBps) || s.shareBps < 0) {
      throw new Error('Attention split shares must be non-negative whole basis points.');
    }
    splitSum += s.shareBps;
  }
  if (splitSum > CREATOR_ATTENTION_POOL_BPS) {
    throw new Error(
      `Attention splits over-allocate the creator pool: ${splitSum} bps directed of ${CREATOR_ATTENTION_POOL_BPS} bps available.`,
    );
  }

  // FIXED protocol + Doppler lines (resolved addresses; never touched by the carve-out).
  const fixedLines: ResolvedLine[] = [];
  for (const line of DEFAULT_FEE_CONSTITUTION) {
    if (line.role === 'protocol-stakers') fixedLines.push({ ...line, address: REVENUE_DISTRIBUTOR_ADDRESS });
    // Carries the Airlock owner + enforces the >=5% floor.
    else if (line.role === 'doppler') fixedLines.push(dopplerBeneficiaryLine(line.shareBps));
  }

  // A creator-directed split must NOT target a fixed protocol/Doppler beneficiary:
  // coalescing would silently fold the carve into that payout AND mislabel the line
  // (the protocol/Doppler role masked as 'attention-beneficiary'), skimming the
  // creator's directed share into the protocol Safe with no error. There is no
  // legitimate reason to direct a KOL carve to those addresses — reject it.
  const fixedAddrs = new Set(fixedLines.map((l) => l.address.toLowerCase()));
  for (const s of attentionSplits) {
    if (fixedAddrs.has(s.address.toLowerCase())) {
      throw new Error('An attention split cannot be directed to the protocol or Doppler beneficiary address.');
    }
  }

  const resolved: ResolvedLine[] = [];
  // Creator keeps the pool remainder after the directed carve-outs.
  resolved.push({
    recipient: 'Creator',
    role: 'creator',
    shareBps: CREATOR_ATTENTION_POOL_BPS - splitSum,
    address: userAddress,
  });
  // Each creator-directed KOL/community beneficiary.
  for (const s of attentionSplits) {
    resolved.push({ recipient: s.address, role: 'attention-beneficiary', shareBps: s.shareBps, address: s.address });
  }
  resolved.push(...fixedLines);

  // Coalesce by address (case-insensitive), summing bps. A FIXED role (protocol-stakers
  // / doppler) must SURVIVE a merge so the disclosure stays truthful and airlock.ts's
  // >=500 doppler-floor check still sees the doppler line — preserved symmetrically,
  // not just for 'doppler'.
  const FIXED_ROLES: ReadonlySet<ResolvedLine['role']> = new Set(['protocol-stakers', 'doppler']);
  const byAddress = new Map<string, ResolvedLine>();
  for (const line of resolved) {
    const key = line.address.toLowerCase();
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, { ...line });
    } else {
      existing.shareBps += line.shareBps;
      if (FIXED_ROLES.has(line.role)) existing.role = line.role;
    }
  }
  // Drop any fully-carved-away line (e.g. creator directed its entire pool to KOLs),
  // so the locker never sees a zero-share beneficiary.
  return [...byAddress.values()].filter((l) => l.shareBps > 0);
}

/**
 * Turn wizard state into a fully-resolved TegridyLaunchConfig. Pure — no chain
 * access. The resulting config is what buildTegridyLaunchParams consumes.
 */
export function wizardConfigToLaunchConfig(w: LaunchWizardInput, opts: LaunchMapOptions): TegridyLaunchConfig {
  // Premine is placed under an ON-CHAIN Doppler vesting schedule to the creator
  // (see airlock.ts `withVesting`), so the Fact Sheet's teamAllocationVestedBps =
  // premineBps is backed by a real lock, not a promise. Bound it conservatively.
  if (!Number.isInteger(w.premineBps) || w.premineBps < 0 || w.premineBps > MAX_PREMINE_BPS) {
    throw new Error(`Team allocation must be a whole number of bps between 0% and ${MAX_PREMINE_BPS / 100}%.`);
  }
  // A premine with no vesting window would be an instant unlock — that is not "vested".
  if (w.premineBps > 0 && !(Number.isFinite(w.vestMonths) && w.vestMonths > 0)) {
    throw new Error('A team allocation requires a positive on-chain vesting duration (months).');
  }
  if (w.cliffMonths != null && (!Number.isFinite(w.cliffMonths) || w.cliffMonths < 0 || w.cliffMonths > w.vestMonths)) {
    throw new Error('Vesting cliff (months) must be between 0 and the vesting duration.');
  }

  // 18-decimal base units. The sale auctions (10000 - premineBps); the reserved
  // premine is exactly the non-sold remainder — the DopplerERC20V1 template mints it
  // and the locker holds it under the vesting schedule (see airlock.ts).
  const initialSupply = parseEther(w.totalSupply || '0');
  const sellBps = BigInt(10_000 - w.premineBps);
  const numTokensToSell = (initialSupply * sellBps) / 10_000n;
  const premineAmount = initialSupply - numTokensToSell;

  // Fail fast on invalid wizard state rather than shipping bad params deep into the SDK.
  if (initialSupply <= 0n || numTokensToSell <= 0n) {
    throw new Error('Total supply must be a positive number.');
  }
  const marketCap = { start: w.mcapStartK * 1000, min: w.mcapFloorK * 1000 };
  if (!(marketCap.start > marketCap.min && marketCap.min > 0)) {
    throw new Error('Market cap must descend from a positive start to a lower positive floor.');
  }
  if (!Number.isFinite(opts.numerairePriceUsd) || opts.numerairePriceUsd <= 0) {
    throw new Error('A valid ETH price is required to build the launch.');
  }

  // Enforce the per-tier LP-lock floor at build time, so a launch can never ship
  // with lockDuration below its tier minimum relying only on gate.ts's post-hoc
  // reclassifier. gate.ts's floors are listable >= 30 days and flagship >= 365
  // days (defaultGateConfig); expressed in whole months at 365/12 days/month
  // (1mo = 365/12 d >= 30 d; 12mo = 365 d), that is listable >= 1 and flagship
  // >= 12 months. Keep these in sync with gate.ts if those constants change.
  if (!(Number.isFinite(w.lpLockMonths) && w.lpLockMonths >= 0)) {
    throw new Error('LP lock duration (months) must be a non-negative finite number.');
  }
  const minLpLockMonths = w.tier === 'flagship' ? 12 : 1;
  if (w.lpLockMonths < minLpLockMonths) {
    throw new Error(
      w.tier === 'flagship'
        ? 'A flagship launch requires an LP lock of at least 12 months.'
        : 'A listable launch requires an LP lock of at least 1 month.',
    );
  }

  return {
    tier: w.tier,
    token: { name: w.name, symbol: w.symbol, tokenURI: w.tokenURI },
    initialSupply,
    numTokensToSell,
    marketCap,
    numerairePriceUsd: opts.numerairePriceUsd,
    minProceeds: opts.minProceeds ?? DEFAULT_MIN_PROCEEDS,
    maxProceeds: opts.maxProceeds ?? DEFAULT_MAX_PROCEEDS,
    feeConstitution: resolveFeeConstitution(opts.userAddress, opts.attentionSplits),
    integrator: LAUNCHER_INTEGRATOR_ADDRESS,
    lockDurationSeconds: Math.round(w.lpLockMonths * MONTH_SECONDS),
    userAddress: opts.userAddress,
    feeTier: LAUNCH_FEE_TIER,
    startTimeOffsetSeconds: START_TIME_OFFSET_SECONDS,
    // On-chain vesting of the reserved premine to the creator. Omitted entirely on a
    // fair launch (premineBps === 0), so the no-premine path is byte-identical to before.
    vesting:
      w.premineBps > 0
        ? {
            amount: premineAmount,
            durationSeconds: Math.round(w.vestMonths * MONTH_SECONDS),
            cliffSeconds: w.cliffMonths ? Math.round(w.cliffMonths * MONTH_SECONDS) : undefined,
          }
        : undefined,
  };
}

/**
 * Submit a real Doppler dynamic-auction launch. Guards the gate + integrator FIRST
 * (throws before any chain access), then simulates (to surface reverts cleanly),
 * then creates. Throws a typed LaunchError on any failure.
 */
export async function launchToken(
  walletClient: WalletClient,
  publicClient: PublicClient,
  cfg: TegridyLaunchConfig,
): Promise<LaunchResult> {
  if (!isLauncherEnabled()) {
    throw new LaunchError('launcher-disabled', 'The launch rail is not enabled yet.');
  }
  if (cfg.integrator === ZERO) {
    throw new LaunchError('invalid-integrator', 'No integrator address is configured; refusing to launch.');
  }

  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: DOPPLER_MAINNET.chainId });

  // buildTegridyLaunchParams applies OUR policy over the SDK builder. The real SDK
  // structurally satisfies the DopplerEvmSdkLike façade; the cast is the tested seam.
  // Wrapped so a build/tick/fee error still surfaces as a typed LaunchError (contract).
  let params: CreateDynamicAuctionParams;
  try {
    params = buildTegridyLaunchParams(sdk as unknown as DopplerEvmSdkLike, cfg) as CreateDynamicAuctionParams;
  } catch (e) {
    throw new LaunchError('invalid-config', `Could not build launch parameters: ${errText(e)}`, e);
  }

  try {
    await sdk.factory.simulateCreateDynamicAuction(params);
  } catch (e) {
    throw new LaunchError('simulation-failed', `Launch simulation reverted: ${errText(e)}`, e);
  }

  try {
    const r = await sdk.factory.createDynamicAuction(params);
    return {
      tokenAddress: r.tokenAddress,
      hookAddress: r.hookAddress,
      poolId: r.poolId,
      transactionHash: r.transactionHash,
    };
  } catch (e) {
    throw new LaunchError('submit-failed', `Launch transaction failed: ${errText(e)}`, e);
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
