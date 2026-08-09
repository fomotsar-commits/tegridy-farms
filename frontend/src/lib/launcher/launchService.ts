// Live Doppler launch submit path — the seam between the wizard and the real
// on-chain create. Kept behind isLauncherEnabled() (false today): this module is
// COMPLETE but dormant. It instantiates the real DopplerSDK and drives it through
// airlock.ts's tested policy (buildTegridyLaunchParams), which is the single place
// our fork-verified constraints live — this file never re-derives them.
//
// Flow: wizard state -> wizardConfigToLaunchConfig -> TegridyLaunchConfig ->
//   buildTegridyLaunchParams(sdk) -> simulate (surfaces reverts) -> create.

import { parseEther, type Address, type PublicClient, type WalletClient } from 'viem';
// DopplerSDK is dynamically imported inside launchToken() so the ~589KB SDK becomes
// its own lazy chunk instead of loading with the gated LaunchPage. The type import is
// erased at build time (zero runtime weight), so pure helpers (wizardConfigToLaunchConfig)
// can be imported from this module without dragging in the SDK.
import type { CreateDynamicAuctionParams } from '@whetstone-research/doppler-sdk/evm';
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
  ETH_NUMERAIRE,
  isLauncherEnabled,
  isAllowedNumeraire,
} from './config';
import type { FeeConstitutionLine } from './factSheet';
import { LOCKER_CLAIMER_ADDRESS } from '../constants';
import { assertMayLaunch, HeatGateDenied } from '../heat/launchGate';
import type { GateAuditRow } from '../heat/gateAudit';

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

/**
 * Exotic-numeraire (TOWELI) raise band, in USD. The proceeds band is denominated in
 * the NUMERAIRE, so an ERC20 numeraire can't reuse the 1–1000 ETH defaults. TOWELI's
 * thin market (~$25k liquidity) makes a multi-$M raise impossible and a graduation
 * target that can never fill; this band is deliberately modest and USD-anchored, then
 * converted to TOWELI base units via the live TOWELI/USD price. Tunable.
 */
const EXOTIC_RAISE_USD = { min: 1_000, max: 50_000 } as const;

/**
 * USD → numeraire base units (18-dec). Both supported numeraires are 18-decimal
 * (native ETH; TOWELI verified 18 on-chain), so 1e18 base units == 1 whole numeraire.
 * Float math is fine for a proceeds BOUND — precision beyond ~15 digits is irrelevant
 * to a raise floor/cap.
 */
function usdToNumeraireWei(usd: number, numerairePriceUsd: number): bigint {
  return BigInt(Math.floor((usd / numerairePriceUsd) * 1e18));
}

/** The successful create() result the SDK returns. */
export interface LaunchResult {
  tokenAddress: Address;
  hookAddress: Address;
  poolId: string;
  transactionHash: string;
  /**
   * The RESOLVED fee constitution actually deployed with this launch (creator
   * remainder + directed attention carve-outs + fixed protocol/Doppler lines) —
   * captured at launch time from the immutable config, NOT the aspirational
   * static DEFAULT_FEE_CONSTITUTION and NOT the still-mutable wizard state. This
   * is the truthful split to display post-launch and to attest.
   */
  feeConstitution: TegridyLaunchConfig['feeConstitution'];
  /**
   * The base pair this launch settled in (native ETH, or TOWELI for an exotic launch).
   * Determines the migration PoolId the post-graduation re-attestation reads, and lets
   * the UI show "token/ETH" vs "token/TOWELI".
   */
  numeraire: Address;
  /**
   * `gate_decision_id` — the id of the Heat gate audit row that permitted this launch.
   *
   * Carried on the birth notify so the island can replay the decision against the
   * instrument that produced it. Null only when the local audit store was unavailable
   * (private-mode browser); a missing id degrades the record, and is never allowed to
   * block a launch the door already passed.
   */
  gateDecisionId: string | null;
}

/** Discriminated failure reasons, so the UI can render a specific message. */
export type LaunchErrorCode =
  | 'launcher-disabled' // gate is shut (isLauncherEnabled() === false)
  | 'invalid-integrator' // integrator is the zero address (defense in depth)
  | 'heat-denied' // the island's launch floor was not cleared (see lib/heat/launchGate.ts)
  | 'invalid-config' // params could not be built from the config (bad tier/fee/tick input)
  | 'simulation-failed' // simulateCreateDynamicAuction reverted (bad config / on-chain preconditions)
  | 'submit-failed'; // createDynamicAuction failed (user rejected / tx reverted)

/** Typed error thrown by launchToken — always carries a machine-readable `code`. */
export class LaunchError extends Error {
  readonly code: LaunchErrorCode;
  readonly cause?: unknown;
  /**
   * True when the failure happened AFTER the launch tx was broadcast (so it may be
   * mined, or still pending). The UI MUST NOT offer a blind retry in that case — a
   * second launch would mint a DUPLICATE token, split the liquidity and double the
   * payment, all while the first token's Fact Sheet is already attested. Pre-broadcast
   * failures (gate / integrator / config / simulation / a user-rejected signature) are
   * safe to retry and leave this false. CONSERVATIVE: an unclassified submit failure
   * (e.g. a receipt-wait timeout, where the tx may well already be mined) defaults to
   * TRUE — over-warning is harmless, under-warning risks the duplicate.
   */
  readonly broadcast: boolean;
  /** The launch tx hash when the SDK/RPC surfaced it before the failure (a receipt-wait
   *  timeout carries it), so the UI can link the pending tx to Etherscan. */
  readonly txHash?: string;
  constructor(
    code: LaunchErrorCode,
    message: string,
    opts?: { cause?: unknown; broadcast?: boolean; txHash?: string },
  ) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
    this.cause = opts?.cause;
    this.broadcast = opts?.broadcast ?? false;
    this.txHash = opts?.txHash;
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
  /**
   * USD price of the SELECTED numeraire — the price the market-cap curve is derived
   * from. For an ETH launch this is ETH/USD; for a TOWELI launch it MUST be TOWELI/USD.
   * A mismatched numeraire price silently mis-prices the entire auction curve, so the
   * caller must pass the price for `numeraire` below (not always ETH/USD).
   */
  numerairePriceUsd: number;
  /**
   * Base pair to launch against. Defaults to native ETH. Only ETH or, when exotic
   * launches are enabled, TOWELI are accepted (validated against isAllowedNumeraire).
   */
  numeraire?: Address;
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
 * The protocol's 15% fee line is streamed by the locker, so its sink must be able to
 * actually CLAIM what it is credited. Both numeraires route to the protocol Treasury.
 *
 * ## Why NOT RevenueDistributor, despite it being the "real yield to stakers" contract
 *
 * The locker is pull-based and self-addressed. `StreamableFeesLocker.releaseFees(tokenId)`
 * requires `msg.sender` to be in `position.beneficiaries` and pays `msg.sender` ONLY;
 * `_distributeFees` merely CREDITS `beneficiariesClaims[beneficiary][currency]`. So a
 * beneficiary that cannot originate a call to the locker can never be paid — the credit
 * accrues and sits there forever.
 *
 * RevenueDistributor cannot originate that call. Its deployed verified ABI exposes 35
 * non-view functions and not one of them is an arbitrary external call, multicall, or
 * exec(target, data). No transaction can ever exist with `msg.sender ==
 * RevenueDistributor` calling `locker.releaseFees`. Pointing the beneficiary at it
 * therefore STRANDS 100% of the protocol fee line, permanently and silently.
 *
 * The interim answer was the Treasury Safe: it CAN originate `execTransaction ->
 * locker.releaseFees(tokenId)`, so nothing stranded — but the protocol's cut stopped being
 * staker yield and became treasury revenue, and the Fact Sheet had to say so.
 *
 * ## What it points at now
 *
 * `LockerClaimer` — DEPLOYED + Etherscan-VERIFIED 2026-08-01 at 0xD2Ac…E6C7. Permissionless
 * `claim(tokenId)` pulls from the locker and pushes the ETH leg to RevenueDistributor, where
 * veTOWELI stakers actually earn it; `sweepToken` sends any ERC20 leg to the Treasury,
 * because RevenueDistributor is ETH-ONLY and an ERC20 pushed into it is dead weight rather
 * than yield. No owner, no setter, no upgrade path — read back on-chain before wiring.
 *
 * ## Why the LABEL stays numeraire-aware even though the ADDRESS no longer is
 *
 * A locker position carries TWO currencies. On an ETH launch the numeraire leg is ETH, so it
 * reaches stakers and "Tegridy stakers" is true. On an exotic (TOWELI) launch BOTH legs are
 * ERC20, so everything sweeps to the Safe and claiming staker yield would be false. Same
 * address, honest label per pair.
 *
 * The display label follows the sink so the Fact Sheet never claims staker yield the routing
 * cannot deliver. Shared by the forward resolver and the post-graduation re-attestation
 * labeler so the on-chain split and its disclosure always agree.
 */
export function protocolFeeSink(numeraire: Address = ETH_NUMERAIRE): { address: Address; recipient: string } {
  const isEth = numeraire.toLowerCase() === ETH_NUMERAIRE.toLowerCase();
  return {
    address: LOCKER_CLAIMER_ADDRESS,
    recipient: isEth ? 'Tegridy stakers' : 'Tegridy treasury',
  };
}

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
export function resolveFeeConstitution(
  userAddress: Address,
  attentionSplits: readonly AttentionSplit[] = [],
  numeraire: Address = ETH_NUMERAIRE,
): ResolvedLine[] {
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
    if (line.role === 'protocol-stakers') {
      // Numeraire-aware sink + honest label (RevenueDistributor/ETH-yield vs Treasury/exotic).
      const sink = protocolFeeSink(numeraire);
      fixedLines.push({ ...line, recipient: sink.recipient, address: sink.address });
    }
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

/** The three FIXED-role addresses needed to label locker beneficiaries back to roles. */
export interface FeeRoleAddresses {
  /** The launching wallet — the creator line resolves here (mirrors resolveFeeConstitution). */
  creator: Address;
  /** The protocol fee sink for THIS launch's numeraire — RevenueDistributor for an ETH
   *  pair, Treasury for an exotic (TOWELI) pair. Get it from {@link protocolFeeSink} so
   *  the reverse label matches the address that was actually streamed on-chain. */
  protocolStakers: Address;
  /** Display label for the protocol line, matching the sink. Defaults to the ETH-pair
   *  "Tegridy stakers"; an exotic launch passes "Tegridy treasury". */
  protocolRecipient?: string;
  /** Doppler / Airlock owner — the 'doppler' line. */
  doppler: Address;
}

/** WAD (1e18) — the locker stores beneficiary shares as this-denominated fractions. */
const WAD_NUMBER = 1e18;

/**
 * REVERSE of {@link resolveFeeConstitution} + airlock's feeConstitutionToBeneficiaries:
 * turn the REAL on-chain StreamableFeesLocker beneficiary set (address + WAD share)
 * back into a labelled FeeConstitutionLine[]. This is the fully-verifiable fee
 * disclosure — read from the graduated pool's locker, not a launch-time snapshot.
 *
 * Pure: (locker beneficiaries + the three fixed role addresses) -> lines. No chain
 * access, so it is unit-tested in isolation; the chain read lives in lockerStream.ts.
 *
 * WAD -> bps: `Math.round(Number(shares) * 10000 / 1e18)`. The forward map is
 * `shares = bps * 1e14` (airlock.ts), so every honest share is `bps * 1e14`, whose
 * Number() is EXACT (it factors as bps·5^14·2^14 with bps·5^14 < 2^53) and round-trips
 * to `bps` precisely. Math.round (not floor/trunc) is deliberate insurance: if a future
 * SDK normalise path leaves a few-wei remainder on a share, rounding still recovers the
 * intended bps, whereas truncation would drop a whole basis point.
 *
 * Labelling mirrors the forward resolver EXACTLY (case-insensitive address match):
 *   protocolStakers -> 'Tegridy stakers' / protocol-stakers
 *   doppler         -> 'Doppler' / doppler
 *   creator         -> 'Creator' / creator
 *   anything else   -> the address itself / attention-beneficiary
 * Order is preserved from the locker (which stores beneficiaries address-sorted), so
 * the resulting disclosure — and its attestation digest — is deterministic.
 */
export function beneficiariesToFeeConstitution(
  beneficiaries: readonly { beneficiary: Address; shares: bigint }[],
  roles: FeeRoleAddresses,
): FeeConstitutionLine[] {
  const creator = roles.creator.toLowerCase();
  const protocolStakers = roles.protocolStakers.toLowerCase();
  const doppler = roles.doppler.toLowerCase();
  return beneficiaries.map(({ beneficiary, shares }) => {
    const shareBps = Math.round((Number(shares) * 10_000) / WAD_NUMBER);
    const key = beneficiary.toLowerCase();
    // Default to protocolFeeSink()'s label, never a hardcoded one. This function feeds the
    // POST-GRADUATION re-attestation — a permanent on-chain disclosure — so a stale literal
    // here republishes a false recipient forever. (It did: this read 'Tegridy stakers' while
    // the sink was Treasury.) Caller may still override via roles.protocolRecipient.
    if (key === protocolStakers) return { recipient: roles.protocolRecipient ?? protocolFeeSink().recipient, role: 'protocol-stakers', shareBps };
    if (key === doppler) return { recipient: 'Doppler', role: 'doppler', shareBps };
    if (key === creator) return { recipient: 'Creator', role: 'creator', shareBps };
    return { recipient: beneficiary, role: 'attention-beneficiary', shareBps };
  });
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
    throw new Error('A valid numeraire price is required to build the launch.');
  }

  // Resolve + validate the base pair. Defaults to native ETH; TOWELI only passes when
  // exotic launches are enabled (isAllowedNumeraire encodes the gate), so a disabled
  // flag can never ship a TOWELI launch even if a caller forces the address.
  const numeraire = opts.numeraire ?? ETH_NUMERAIRE;
  if (!isAllowedNumeraire(numeraire)) {
    throw new Error('That base pair is not available. Launches settle in ETH (or TOWELI when exotic launches are enabled).');
  }
  // Proceeds band is denominated in the NUMERAIRE. ETH keeps its 1–1000 ETH defaults;
  // a non-ETH numeraire (TOWELI) derives a modest USD-anchored band from its own price.
  const isEth = numeraire.toLowerCase() === ETH_NUMERAIRE.toLowerCase();
  const defaultMinProceeds = isEth ? DEFAULT_MIN_PROCEEDS : usdToNumeraireWei(EXOTIC_RAISE_USD.min, opts.numerairePriceUsd);
  const defaultMaxProceeds = isEth ? DEFAULT_MAX_PROCEEDS : usdToNumeraireWei(EXOTIC_RAISE_USD.max, opts.numerairePriceUsd);

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
    numeraire,
    minProceeds: opts.minProceeds ?? defaultMinProceeds,
    maxProceeds: opts.maxProceeds ?? defaultMaxProceeds,
    feeConstitution: resolveFeeConstitution(opts.userAddress, opts.attentionSplits, numeraire),
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

  // THE SEEDLING GATE. Read live, here, at the moment of launching — not trusted from
  // whatever the door rendered minutes ago on a page that has since been left open.
  //
  // Position matters: after the cheap local guards and BEFORE any SDK work, any
  // signature request, and any chain access. A denial at this point is provably
  // pre-broadcast, which is why `broadcast: false` below is a fact and not a hope.
  //
  // `assertMayLaunch` fails closed: an unreachable oracle throws exactly as a cold
  // wallet does. It returns the audit row, whose id becomes `gate_decision_id` on the
  // birth notify — that is how a token is tied back to the decision that permitted it.
  let gateRow: GateAuditRow | null = null;
  try {
    gateRow = await assertMayLaunch(cfg.userAddress);
  } catch (e) {
    if (e instanceof HeatGateDenied) {
      throw new LaunchError('heat-denied', e.message, { cause: e, broadcast: false });
    }
    throw e;
  }

  const { DopplerSDK } = await import('@whetstone-research/doppler-sdk/evm');
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: DOPPLER_MAINNET.chainId });

  // buildTegridyLaunchParams applies OUR policy over the SDK builder. The real SDK
  // structurally satisfies the DopplerEvmSdkLike façade; the cast is the tested seam.
  // Wrapped so a build/tick/fee error still surfaces as a typed LaunchError (contract).
  let params: CreateDynamicAuctionParams;
  try {
    params = buildTegridyLaunchParams(sdk as unknown as DopplerEvmSdkLike, cfg) as CreateDynamicAuctionParams;
  } catch (e) {
    throw new LaunchError('invalid-config', `Could not build launch parameters: ${errText(e)}`, { cause: e });
  }

  try {
    await sdk.factory.simulateCreateDynamicAuction(params);
  } catch (e) {
    throw new LaunchError('simulation-failed', `Launch simulation reverted: ${errText(e)}`, { cause: e });
  }

  try {
    const r = await sdk.factory.createDynamicAuction(params);
    return {
      tokenAddress: r.tokenAddress,
      hookAddress: r.hookAddress,
      poolId: r.poolId,
      transactionHash: r.transactionHash,
      // The split that was actually deployed (cfg is immutable at this point).
      feeConstitution: cfg.feeConstitution,
      // The base pair actually used (ETH default, or TOWELI for an exotic launch).
      numeraire: cfg.numeraire ?? ETH_NUMERAIRE,
      // The gate row that permitted this launch. Rides the birth notify so the island
      // can replay the decision against the instrument. Null only when the audit could
      // not be stored locally (private-mode browser) — never a reason to block a launch.
      gateDecisionId: gateRow?.id ?? null,
    };
  } catch (e) {
    // create() broadcasts AND waits for the receipt in one step, so a throw here may
    // mean the tx is already on-chain (classically: a receipt-wait timeout). Only a
    // user-rejected signature is provably pre-broadcast; everything else is treated as
    // possibly-broadcast so the UI refuses to invite a duplicate launch.
    const broadcast = !isUserRejection(e);
    throw new LaunchError('submit-failed', `Launch transaction failed: ${errText(e)}`, {
      cause: e,
      broadcast,
      txHash: broadcast ? extractTxHash(e) : undefined,
    });
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * A user rejecting the signature in their wallet is the one submit-path failure we can
 * be SURE never reached the chain (viem's UserRejectedRequestError / EIP-1193 code 4001).
 * Everything else in the create() catch is treated as possibly-broadcast (see
 * {@link LaunchError.broadcast}). Walks the cause chain so it survives SDK error-wrapping.
 */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const o = cur as { name?: string; code?: unknown; message?: string; cause?: unknown };
    if (o.name === 'UserRejectedRequestError') return true;
    if (o.code === 4001 || o.code === 'ACTION_REJECTED') return true;
    if (typeof o.message === 'string' && /user rejected|user denied|rejected the request/i.test(o.message)) return true;
    cur = o.cause;
  }
  return false;
}

/**
 * Best-effort extraction of the broadcast tx hash from a create()-path error (a
 * receipt-wait timeout carries it), so the UI can point the user at the pending tx.
 * Returns undefined unless it finds a well-formed 32-byte hash.
 */
export function extractTxHash(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const o = cur as { transactionHash?: unknown; hash?: unknown; cause?: unknown };
    const h = o.transactionHash ?? o.hash;
    if (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)) return h;
    cur = o.cause;
  }
  return undefined;
}
