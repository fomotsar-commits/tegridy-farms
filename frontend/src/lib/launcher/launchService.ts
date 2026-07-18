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
  /** Insider allocation in bps; reserved out of the auctioned amount. */
  premineBps: number;
  /** Dutch-auction START (high) market cap, in $ thousands. */
  mcapStartK: number;
  /** Descends toward this FLOOR market cap, in $ thousands. */
  mcapFloorK: number;
  lpLockMonths: number;
}

export interface LaunchMapOptions {
  /** Creator / launcher (connected wallet). Receives the creator fee line. */
  userAddress: Address;
  /** Current ETH/USD price — the numeraire price the market-cap curve is derived from. */
  numerairePriceUsd: number;
  /** Optional attention-beneficiary/KOL address; defaults to userAddress (merged into creator). */
  kolAddress?: Address;
  /** Override the default proceeds band (numeraire wei). */
  minProceeds?: bigint;
  maxProceeds?: bigint;
}

type ResolvedLine = FeeConstitutionLine & { address: Address };

/**
 * Resolve DEFAULT_FEE_CONSTITUTION's roles to concrete addresses, then COALESCE
 * lines that resolve to the same address (summing bps). The StreamableFeesLocker
 * requires unique beneficiaries — without merging, a launch with no distinct KOL
 * would submit two lines at the creator's address (creator + attention) and could
 * revert. Coalescing keeps the set unique while preserving the 10000-bps total and
 * the >=500-bps Doppler floor.
 */
function resolveFeeConstitution(userAddress: Address, kolAddress: Address): ResolvedLine[] {
  const resolved: ResolvedLine[] = DEFAULT_FEE_CONSTITUTION.map((line): ResolvedLine => {
    switch (line.role) {
      case 'creator':
        return { ...line, address: userAddress };
      case 'attention-beneficiary':
        return { ...line, address: kolAddress };
      case 'protocol-stakers':
        return { ...line, address: REVENUE_DISTRIBUTOR_ADDRESS };
      case 'doppler':
        // Carries the Airlock owner + enforces the >=5% floor.
        return dopplerBeneficiaryLine(line.shareBps);
      default:
        return { ...line, address: userAddress };
    }
  });

  // Coalesce by address (case-insensitive), summing bps. Preserve a 'doppler' role
  // if any merged line held it (so the >=500 floor check in airlock.ts still sees it).
  const byAddress = new Map<string, ResolvedLine>();
  for (const line of resolved) {
    const key = line.address.toLowerCase();
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, { ...line });
    } else {
      existing.shareBps += line.shareBps;
      if (line.role === 'doppler') existing.role = 'doppler';
    }
  }
  return [...byAddress.values()];
}

/**
 * Turn wizard state into a fully-resolved TegridyLaunchConfig. Pure — no chain
 * access. The resulting config is what buildTegridyLaunchParams consumes.
 */
export function wizardConfigToLaunchConfig(w: LaunchWizardInput, opts: LaunchMapOptions): TegridyLaunchConfig {
  const kol = opts.kolAddress ?? opts.userAddress;

  // HONESTY GUARD: airlock.ts does not (yet) wire Doppler's on-chain VestingConfig,
  // so a premine would be reserved out of the sale but NOT actually vested — while
  // the Fact Sheet's gate reports teamAllocationVestedBps = premineBps ("vested").
  // Refuse rather than ship a false "vested" disclosure. Re-enable only once the
  // token's VestingConfig is wired end-to-end (see launcher README follow-up).
  if (w.premineBps > 0) {
    throw new Error(
      'Team allocation / premine is not supported yet (on-chain vesting is not wired) — launch with 0% team allocation.',
    );
  }

  // 18-decimal base units. With premine blocked, numTokensToSell == initialSupply.
  const initialSupply = parseEther(w.totalSupply || '0');
  const sellBps = BigInt(Math.max(0, 10_000 - w.premineBps));
  const numTokensToSell = (initialSupply * sellBps) / 10_000n;

  return {
    tier: w.tier,
    token: { name: w.name, symbol: w.symbol, tokenURI: w.tokenURI },
    initialSupply,
    numTokensToSell,
    marketCap: { start: w.mcapStartK * 1000, min: w.mcapFloorK * 1000 },
    numerairePriceUsd: opts.numerairePriceUsd,
    minProceeds: opts.minProceeds ?? DEFAULT_MIN_PROCEEDS,
    maxProceeds: opts.maxProceeds ?? DEFAULT_MAX_PROCEEDS,
    feeConstitution: resolveFeeConstitution(opts.userAddress, kol),
    integrator: LAUNCHER_INTEGRATOR_ADDRESS,
    lockDurationSeconds: Math.round(w.lpLockMonths * MONTH_SECONDS),
    userAddress: opts.userAddress,
    feeTier: LAUNCH_FEE_TIER,
    startTimeOffsetSeconds: START_TIME_OFFSET_SECONDS,
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
  const params = buildTegridyLaunchParams(
    sdk as unknown as DopplerEvmSdkLike,
    cfg,
  ) as CreateDynamicAuctionParams;

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
