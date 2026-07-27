// Tegridy launch policy over Meteora's Dynamic Bonding Curve (DBC) — Solana leg.
//
// DOCTRINE (hard rules, docs/SOLANA_FEE_CAPTURE_PLAN.md + project memory):
//   • Solana is FEE CAPTURE ONLY. TOWELI never touches Solana.
//   • Zero-Rust: we deploy NO custom program. We integrate the audited DBC
//     program (dbcij3…SMaqN, identical on mainnet-beta + devnet) via its TS SDK.
//   • The `claimPartnerTradingFee` signer has FULL custody of accrued fees (it
//     can redirect them to ANY receiver). Therefore the `feeClaimer` MUST be a
//     Squads v4 multisig vault — NEVER an EOA. This module gates every fee
//     authority behind a `SquadsVault` brand + an `asSquadsVault` shape/affirmation
//     check. That is NOT proof of multisig custody (it cannot be, off-chain), so the
//     operator's signing wrapper MUST verify it on-chain before the first real
//     launch. NOTE: the real Squads v4 vault is a SYSTEM-owned PDA derived from the
//     multisig (not the Squads-owned config account) — so verification derives that
//     vault PDA from the multisig + index and confirms the fee address equals it
//     (see squads.ts `verifySquadsVault` + README §Squads-vault invariant).
//   • Sub-brand, GATED: SOLANA_LAUNCHER_ENABLED stays false; the operator submit
//     path is unreachable until an operator flips it AND supplies a real vault.
//
// This file is a PURE PARAM BUILDER. It never opens a Connection, never signs,
// never imports the SDK at runtime — it only produces typed descriptors that the
// operator's thin, out-of-band signing wrapper feeds into the real SDK:
//
//     import { DynamicBondingCurveClient, buildCurveWithMarketCap }
//       from '@meteora-ag/dynamic-bonding-curve-sdk';
//     const client = DynamicBondingCurveClient.create(connection, 'confirmed');
//     const { curve, accounts } = buildDbcPartnerConfig({ … });
//     const configParams = buildCurveWithMarketCap(curve);          // ConfigParameters
//     const tx = await client.partner.createConfig({
//       config, feeClaimer, leftoverReceiver, quoteMint, payer,     // → PublicKey
//       ...configParams,
//     });
//
// Types are checked against the REAL SDK curve types via a type-only import
// (100% erased at compile → this module carries ZERO runtime SDK weight, matching
// the airlock.ts façade doctrine). Account addresses are modelled as base58
// strings here (the browser/operator layer holds strings; the wrapper maps them
// to web3.js PublicKey / BN just before signing). See ./README.md for the flow.
//
// API grounded in the installed SDK types
//   frontend/node_modules/@meteora-ag/dynamic-bonding-curve-sdk/dist/index.d.ts
//   (+ index.js address/const literals), read 2026-07-17.

import type {
  BuildCurveWithMarketCapParams,
  BaseFeeParams,
  ActivationType,
  TokenType,
  TokenDecimal,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  TokenAuthorityOption,
  BaseFeeMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SOL_MINT, USDC_MINT } from '../../solana';

// ── Feature gate ────────────────────────────────────────────────────────────
//
// Local gate (we do NOT own config.ts). The pure builders below are always safe
// to call (tests exercise them); the *operator submit path* — and any wired UI —
// must guard on isSolanaLauncherEnabled().
//
// ENABLED 2026-07-27 (operator confirmed the Squads v4 vault is set up). This makes the
// /solana-launch PREVIEW page live — a config preview only; there is NO in-app submit or
// signer (verified: SolanaLaunchPage has no sendTransaction/createConfig path). Real
// launches still go through the operator's out-of-band CLI wrapper (dbcClient.ts / README),
// which verifies the feeClaimer IS the derived Squads vault PDA on-chain (squads.ts
// verifySquadsVault) and enforces multisig threshold >= 2 before the first real create.
// Doctrine intact: fee-capture only, zero custom program, TOWELI never on Solana.
// Reversible: set false + redeploy.
export const SOLANA_LAUNCHER_ENABLED = true;

/** The Solana launcher submit path is reachable only when this is true. */
export function isSolanaLauncherEnabled(): boolean {
  return SOLANA_LAUNCHER_ENABLED;
}

// ── Canonical program / mint constants (verified against SDK index.js) ────────
//
// Meteora deploys the SAME DBC program id on mainnet-beta AND devnet.
export const DYNAMIC_BONDING_CURVE_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const LOCKER_PROGRAM_ID = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';

/** Meteora's protocol take of ALL trading fees, in percent (SDK PROTOCOL_FEE_PERCENT). */
export const METEORA_PROTOCOL_FEE_PERCENT = 20;
/** Fee-bps bounds enforced by the DBC program (SDK MIN_FEE_BPS / MAX_FEE_BPS). */
export const MIN_FEE_BPS = 25;
export const MAX_FEE_BPS = 9900;
/**
 * Self-imposed conservative cap on the anti-snipe decay window (12h). Borrowed from
 * the SDK's rate-limiter constant (MAX_RATE_LIMITER_DURATION_IN_SECONDS); the fee
 * SCHEDULER path we use imposes no max totalDuration of its own.
 */
export const MAX_ANTI_SNIPE_DURATION_SECONDS = 43200; // 12h
/** SDK MIN_LOCKED_LIQUIDITY_BPS (1000 = 10%) as a percent — min migrated-LP permanently locked. */
export const MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT = 10;
export const SECONDS_PER_DAY = 86400;
/** u64 max — the "claim everything available" sentinel for trading-fee claims. */
export const U64_MAX = 2n ** 64n - 1n;

/** The all-zero / system-program pubkey — an unset fee authority. Rejected. */
const DEFAULT_PUBKEY = '11111111111111111111111111111111';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// SDK numeric-enum values, re-declared as typed literals. `import type` erases
// the enums, so we cannot reference `TokenType.SPLToken` at runtime — we cast the
// literal to the enum TYPE instead (keeps full field-level type-checking, zero
// runtime SDK weight). Discriminant fields cast to the exact member type.
const SPL_TOKEN = 0 as TokenType;
const DECIMAL: Record<6 | 7 | 8 | 9, TokenDecimal> = {
  6: 6 as TokenDecimal,
  7: 7 as TokenDecimal,
  8: 8 as TokenDecimal,
  9: 9 as TokenDecimal,
};
const AUTHORITY_IMMUTABLE = 1 as TokenAuthorityOption; // no mint / no update authority
const COLLECT_IN_QUOTE = 0 as CollectFeeMode; // fees accrue in the quote (SOL/USDC)
const MIGRATE_TO_DAMM_V2 = 1 as MigrationOption;
const MIGRATION_FEE_FIXED_100_BPS = 2 as MigrationFeeOption; // 1% post-migration pool fee
const ACTIVATION_TIMESTAMP = 1 as ActivationType;
const FEE_SCHEDULER_EXPONENTIAL = 1 as BaseFeeMode.FeeSchedulerExponential;
const FEE_SCHEDULER_LINEAR = 0 as BaseFeeMode.FeeSchedulerLinear;

// ── Squads-vault invariant ────────────────────────────────────────────────────

/**
 * A base58 address the operator has AFFIRMED is a Squads v4 multisig vault.
 * Branded so the type system forces every fee-authority argument through the
 * `asSquadsVault` gate — a raw string will not type-check where a SquadsVault is
 * required. (Off-chain we cannot prove multisig ownership without RPC; this pairs
 * a syntactic guard with an explicit operator affirmation. The wrapper SHOULD
 * additionally verify on-chain that the account is owned by the Squads program
 * before its first real launch.)
 */
export type SquadsVault = string & { readonly __squadsVault: unique symbol };

export function isLikelyBase58Pubkey(addr: string): boolean {
  return BASE58_RE.test(addr) && addr !== DEFAULT_PUBKEY;
}

/**
 * Affirm + validate a Squads vault address. Throws on empty, malformed, or the
 * default/system pubkey (an EOA-shaped-unset value). The operator calls this at
 * the edge to mint the brand the builders require.
 */
export function asSquadsVault(addr: string): SquadsVault {
  const a = (addr ?? '').trim();
  if (a.length === 0) {
    throw new Error('feeClaimer/receiver must be a Squads vault — got an empty address');
  }
  if (a === DEFAULT_PUBKEY) {
    throw new Error('feeClaimer/receiver must be a Squads vault — got the default/system pubkey (unset)');
  }
  if (!BASE58_RE.test(a)) {
    throw new Error(`feeClaimer/receiver must be a valid base58 Solana address — got "${addr}"`);
  }
  return a as SquadsVault;
}

// ── Quote mint ────────────────────────────────────────────────────────────────

/**
 * A quote mint to launch against — ANY valid SPL mint (an "exotic pair"). SOL and
 * USDC are the curated, known-liquid defaults; any other mint is permitted but is
 * exotic (illiquidity / dead-market risk) and MUST supply its on-chain decimals.
 * NOTE: there is deliberately NO TOWELI here — TOWELI is EVM-only, never bridged to
 * Solana ([[project_2026_06_18_solana_fee_capture]]); Solana is fee-capture only.
 */
export type QuoteMint = string;

/** Curated quote mints and their decimals. A mint in this table needs no override. */
export const KNOWN_QUOTE_MINTS: Readonly<Record<string, 6 | 9>> = {
  [SOL_MINT]: 9,
  [USDC_MINT]: 6,
};

/** True for SOL/USDC — the vetted, deep-liquidity quote mints. The UI warns on the rest. */
export function isKnownQuoteMint(mint: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_QUOTE_MINTS, mint);
}

/**
 * Resolve the quote-token decimals. Curated mints come from KNOWN_QUOTE_MINTS; a
 * CUSTOM (exotic) mint must pass its real on-chain decimals, which — like the base
 * token — must be 6–9 (the DBC DECIMAL map's supported range; every real quote token
 * fits). A wrong decimal count silently mis-scales the entire bonding curve, so this
 * is required, not guessed.
 */
function resolveQuoteDecimals(quoteMint: QuoteMint, override?: number): 6 | 7 | 8 | 9 {
  const known = KNOWN_QUOTE_MINTS[quoteMint];
  if (known !== undefined) return known;
  if (override === undefined) {
    throw new Error(`a custom (non-SOL/USDC) quote mint requires its on-chain decimals (6–9) — none supplied for "${quoteMint}"`);
  }
  if (!Number.isInteger(override) || override < 6 || override > 9) {
    throw new Error(`custom quote-mint decimals must be an integer 6–9 (DBC-supported range), got ${override}`);
  }
  return override as 6 | 7 | 8 | 9;
}

/** Validate a quote mint is a real base58 SPL mint (not the system/default pubkey). */
function assertQuoteMint(quoteMint: string): asserts quoteMint is QuoteMint {
  const m = (quoteMint ?? '').trim();
  if (m.length === 0 || m === DEFAULT_PUBKEY || !BASE58_RE.test(m)) {
    throw new Error(`quoteMint must be a valid base58 SPL mint address — got "${quoteMint}"`);
  }
}

// ── Fee-split disclosure math ─────────────────────────────────────────────────

export interface TradingFeeSplit {
  /** Meteora's fixed protocol take (20% of the total trade fee). */
  meteoraBps: number;
  /** The partner (Tegridy) share of the non-protocol 80%. */
  partnerBps: number;
  /** The creator share of the non-protocol 80%. */
  creatorBps: number;
}

/**
 * Split a total trade fee (bps) the way the DBC program does: Meteora takes a
 * fixed 20%; the remaining 80% is divided between creator and partner by
 * `creatorTradingFeePercentage` (creator's % of that 80%). Pure disclosure math
 * — surfaced in the Fact Sheet so the split is published, never a hidden dial.
 */
export function splitTradingFee(totalFeeBps: number, creatorTradingFeePercentage: number): TradingFeeSplit {
  if (!Number.isFinite(totalFeeBps) || totalFeeBps < 0) {
    throw new Error(`totalFeeBps must be >= 0, got ${totalFeeBps}`);
  }
  if (!Number.isInteger(creatorTradingFeePercentage) || creatorTradingFeePercentage < 0 || creatorTradingFeePercentage > 100) {
    throw new Error(`creatorTradingFeePercentage must be an integer in [0,100], got ${creatorTradingFeePercentage}`);
  }
  const meteoraBps = (totalFeeBps * METEORA_PROTOCOL_FEE_PERCENT) / 100;
  const nonProtocol = totalFeeBps - meteoraBps;
  const creatorBps = (nonProtocol * creatorTradingFeePercentage) / 100;
  const partnerBps = nonProtocol - creatorBps;
  return { meteoraBps, partnerBps, creatorBps };
}

// ── Anti-snipe fee scheduler ──────────────────────────────────────────────────

export interface AntiSnipeSchedule {
  /** High opening fee that decays away snipers, in bps (<= MAX_FEE_BPS). */
  startingFeeBps: number;
  /** Resting fee after the decay completes, in bps (>= MIN_FEE_BPS). */
  endingFeeBps: number;
  /** Number of decay steps. */
  numberOfPeriod: number;
  /** Total decay window in seconds (<= MAX_ANTI_SNIPE_DURATION_SECONDS). */
  totalDuration: number;
  /** Exponential (Jupiter-Studio style) by default; linear optional. */
  mode?: 'exponential' | 'linear';
}

/**
 * Jupiter-Studio-style anti-snipe default: open very high (99%) and decay
 * exponentially to the 1% resting platform fee over 6 hours. The opening fee
 * makes block-0 sniping unprofitable; honest buyers arrive after the decay.
 */
export const DEFAULT_ANTI_SNIPE: AntiSnipeSchedule = {
  startingFeeBps: MAX_FEE_BPS, // 99%
  endingFeeBps: 100, // 1% resting fee
  numberOfPeriod: 120,
  totalDuration: 6 * 60 * 60, // 6h, within the 12h cap
  mode: 'exponential',
};

function toBaseFeeParams(s: AntiSnipeSchedule): BaseFeeParams {
  if (!Number.isInteger(s.startingFeeBps) || !Number.isInteger(s.endingFeeBps)) {
    throw new Error('anti-snipe fee bps must be integers');
  }
  if (s.endingFeeBps < MIN_FEE_BPS || s.startingFeeBps > MAX_FEE_BPS) {
    throw new Error(`anti-snipe fees must be within [${MIN_FEE_BPS}, ${MAX_FEE_BPS}] bps`);
  }
  if (s.startingFeeBps <= s.endingFeeBps) {
    throw new Error(
      `anti-snipe schedule must DECAY: startingFeeBps (${s.startingFeeBps}) must exceed endingFeeBps (${s.endingFeeBps})`,
    );
  }
  if (!Number.isInteger(s.numberOfPeriod) || s.numberOfPeriod <= 0) {
    throw new Error(`anti-snipe numberOfPeriod must be a positive integer, got ${s.numberOfPeriod}`);
  }
  if (!Number.isInteger(s.totalDuration) || s.totalDuration <= 0) {
    throw new Error(`anti-snipe totalDuration must be a positive integer, got ${s.totalDuration}`);
  }
  if (s.totalDuration > MAX_ANTI_SNIPE_DURATION_SECONDS) {
    throw new Error(`anti-snipe totalDuration must be <= ${MAX_ANTI_SNIPE_DURATION_SECONDS}s, got ${s.totalDuration}`);
  }
  // The SDK derives periodFrequency = BN(totalDuration / numberOfPeriod) — a non-integer
  // truncates, silently shortening the decay window vs the disclosed one. Require exactness.
  if (s.totalDuration % s.numberOfPeriod !== 0) {
    throw new Error(
      `anti-snipe totalDuration (${s.totalDuration}) must be divisible by numberOfPeriod (${s.numberOfPeriod}) so the on-chain window matches the disclosed one`,
    );
  }
  return {
    baseFeeMode: s.mode === 'linear' ? FEE_SCHEDULER_LINEAR : FEE_SCHEDULER_EXPONENTIAL,
    feeSchedulerParam: {
      startingFeeBps: s.startingFeeBps,
      endingFeeBps: s.endingFeeBps,
      numberOfPeriod: s.numberOfPeriod,
      totalDuration: s.totalDuration,
    },
  };
}

// ── Partner config builder ────────────────────────────────────────────────────

/** The createConfig account inputs (base58; the wrapper maps them → PublicKey). */
export interface DbcConfigAccounts {
  /** NEW keypair; its pubkey becomes the reusable config-key address (must sign). */
  config: string;
  /** Partner fee authority — MUST be a Squads vault (full fee custody). */
  feeClaimer: SquadsVault;
  /** Receives leftover base tokens post-migration. Vault by default. */
  leftoverReceiver: SquadsVault;
  /** Quote mint (SOL/USDC or a custom SPL mint). */
  quoteMint: QuoteMint;
  /** Fee-payer for the createConfig tx. */
  payer: string;
}

export interface BuildDbcPartnerConfigOpts {
  /** Partner fee authority (Squads vault). Fees are fully custodied by this key. */
  feeClaimer: SquadsVault;
  /** Config-key account pubkey (a fresh keypair the operator generates). */
  config: string;
  /** Fee-payer. */
  payer: string;
  /** Leftover-base receiver post-migration. Defaults to feeClaimer (the vault). */
  leftoverReceiver?: SquadsVault;
  /** Quote mint. SOL (default) or USDC are curated; any other valid SPL mint is an
   *  exotic pair and additionally requires `quoteDecimals`. */
  quoteMint?: QuoteMint;
  /** On-chain decimals (6–9) of a CUSTOM quote mint. Ignored for SOL/USDC (known). */
  quoteDecimals?: number;
  /**
   * Creator's share of the non-protocol 80% of trading fees, in percent [0,100].
   * Default 60 → creator-majority (60% of 80% = 48% of total; partner 32%).
   */
  creatorTradingFeePercentage?: number;
  /** Anti-snipe fee-decay schedule. Defaults to DEFAULT_ANTI_SNIPE (99%→1% / 6h). */
  antiSnipe?: AntiSnipeSchedule;
  /** Total base-token supply (whole tokens). Default 1e9. */
  totalTokenSupply?: number;
  /** Base-token decimals (6–9). Default 6 (pump.fun-style). */
  tokenBaseDecimal?: 6 | 7 | 8 | 9;
  /** Market cap (in quote-token units) at launch. */
  initialMarketCap: number;
  /** Market cap (in quote-token units) that triggers graduation/migration. */
  migrationMarketCap: number;
  /** Base tokens left un-distributed by the curve. Default 0. */
  leftover?: number;
  /**
   * Migrated-LP distribution (must sum to 100). Default: 100% partner-permanent-
   * locked — LP is locked forever and its fees stream to the feeClaimer vault
   * (the fee-capture flywheel). Override to hand LP to the creator.
   */
  liquidityDistribution?: {
    partnerPermanentLockedLiquidityPercentage: number;
    partnerLiquidityPercentage: number;
    creatorPermanentLockedLiquidityPercentage: number;
    creatorLiquidityPercentage: number;
  };
}

export interface DbcPartnerConfig {
  /** Feed to `buildCurveWithMarketCap(curve)` → ConfigParameters, then createConfig. */
  curve: BuildCurveWithMarketCapParams;
  /** createConfig account inputs (base58). */
  accounts: DbcConfigAccounts;
  /** Published fee-split disclosure (Meteora 20% / partner / creator). */
  feeSplit: TradingFeeSplit;
}

const DEFAULT_LIQUIDITY_DISTRIBUTION = {
  partnerPermanentLockedLiquidityPercentage: 100,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 0,
  creatorLiquidityPercentage: 0,
} as const;

/** No locked vesting (SDK isDefaultLockedVesting == all zero). */
const NO_LOCKED_VESTING = {
  totalLockedVestingAmount: 0,
  numberOfVestingPeriod: 0,
  cliffUnlockAmount: 0,
  totalVestingDuration: 0,
  cliffDurationFromMigrationTime: 0,
} as const;

/**
 * Build (but do not submit) the reusable DBC partner config-key params.
 *
 * Returns `{ curve, accounts, feeSplit }`. The operator's signing wrapper runs
 * `buildCurveWithMarketCap(curve)` then `client.partner.createConfig({ ...accounts→PublicKey, ...configParams })`.
 *
 * Refuses to build unless `feeClaimer` (and `leftoverReceiver`) are affirmed
 * Squads vaults, the quote mint is a valid SPL mint (SOL/USDC, or a custom exotic
 * mint WITH its decimals), the anti-snipe schedule decays, and the LP sums to 100.
 */
export function buildDbcPartnerConfig(opts: BuildDbcPartnerConfigOpts): DbcPartnerConfig {
  // The type system already forces SquadsVault; re-affirm at runtime so a value
  // cast around the types (or arriving from JS) still cannot slip an EOA through.
  const feeClaimer = asSquadsVault(opts.feeClaimer);
  const leftoverReceiver = asSquadsVault(opts.leftoverReceiver ?? opts.feeClaimer);

  const quoteMint = opts.quoteMint ?? SOL_MINT;
  assertQuoteMint(quoteMint);
  const quoteDec = resolveQuoteDecimals(quoteMint, opts.quoteDecimals);

  if (!opts.config || !isLikelyBase58Pubkey(opts.config.trim())) {
    throw new Error('config must be a fresh base58 keypair pubkey');
  }
  if (!opts.payer || !isLikelyBase58Pubkey(opts.payer.trim())) {
    throw new Error('payer must be a valid base58 address');
  }

  const creatorTradingFeePercentage = opts.creatorTradingFeePercentage ?? 60;
  const antiSnipe = opts.antiSnipe ?? DEFAULT_ANTI_SNIPE;
  const baseDecimals = opts.tokenBaseDecimal ?? 6;
  const totalTokenSupply = opts.totalTokenSupply ?? 1_000_000_000;
  const leftover = opts.leftover ?? 0;

  if (!Number.isFinite(totalTokenSupply) || totalTokenSupply <= 0) {
    throw new Error(`totalTokenSupply must be > 0, got ${totalTokenSupply}`);
  }
  if (leftover < 0 || leftover >= totalTokenSupply) {
    throw new Error(`leftover must be in [0, totalTokenSupply), got ${leftover}`);
  }
  if (!Number.isFinite(opts.initialMarketCap) || opts.initialMarketCap <= 0) {
    throw new Error(`initialMarketCap must be > 0, got ${opts.initialMarketCap}`);
  }
  if (!Number.isFinite(opts.migrationMarketCap) || opts.migrationMarketCap <= opts.initialMarketCap) {
    throw new Error(
      `migrationMarketCap (${opts.migrationMarketCap}) must exceed initialMarketCap (${opts.initialMarketCap})`,
    );
  }

  const liq = opts.liquidityDistribution ?? DEFAULT_LIQUIDITY_DISTRIBUTION;
  const liqSum =
    liq.partnerPermanentLockedLiquidityPercentage +
    liq.partnerLiquidityPercentage +
    liq.creatorPermanentLockedLiquidityPercentage +
    liq.creatorLiquidityPercentage;
  if (liqSum !== 100) {
    throw new Error(`liquidityDistribution percentages must sum to 100, got ${liqSum}`);
  }
  // The DBC program requires a minimum permanently-locked share (validateMinimumLockedLiquidity);
  // a "hand LP to the creator" override that sums to 100 but locks < 10% builds cleanly here then
  // reverts inside buildCurveWithMarketCap — reject it up front.
  const permanentLocked =
    liq.partnerPermanentLockedLiquidityPercentage + liq.creatorPermanentLockedLiquidityPercentage;
  if (permanentLocked < MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT) {
    throw new Error(
      `>= ${MIN_PERMANENT_LOCKED_LIQUIDITY_PERCENT}% of migrated LP must be permanently locked (SDK MIN_LOCKED_LIQUIDITY), got ${permanentLocked}%`,
    );
  }

  // Validate + disclose the fee split (also throws on bad creator %).
  const feeSplit = splitTradingFee(antiSnipe.endingFeeBps, creatorTradingFeePercentage);
  const baseFeeParams = toBaseFeeParams(antiSnipe);

  const curve: BuildCurveWithMarketCapParams = {
    token: {
      tokenType: SPL_TOKEN,
      tokenBaseDecimal: DECIMAL[baseDecimals],
      tokenQuoteDecimal: DECIMAL[quoteDec],
      tokenAuthorityOption: AUTHORITY_IMMUTABLE, // no mint / no update authority
      totalTokenSupply,
      leftover,
    },
    fee: {
      baseFeeParams,
      dynamicFeeEnabled: false, // anti-snipe is the scheduler; keep the curve deterministic
      collectFeeMode: COLLECT_IN_QUOTE,
      creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MIGRATE_TO_DAMM_V2,
      migrationFeeOption: MIGRATION_FEE_FIXED_100_BPS,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: liq.partnerPermanentLockedLiquidityPercentage,
      partnerLiquidityPercentage: liq.partnerLiquidityPercentage,
      creatorPermanentLockedLiquidityPercentage: liq.creatorPermanentLockedLiquidityPercentage,
      creatorLiquidityPercentage: liq.creatorLiquidityPercentage,
    },
    lockedVesting: { ...NO_LOCKED_VESTING },
    activationType: ACTIVATION_TIMESTAMP,
    initialMarketCap: opts.initialMarketCap,
    migrationMarketCap: opts.migrationMarketCap,
  };

  return {
    curve,
    accounts: { config: opts.config.trim(), feeClaimer, leftoverReceiver, quoteMint, payer: opts.payer.trim() },
    feeSplit,
  };
}

// ── Token launch (create pool against a config key) ───────────────────────────

export interface TokenMeta {
  name: string;
  symbol: string;
  /** Metadata URI (ipfs/arweave/https). */
  uri: string;
}

export interface BuildLaunchParamsOpts {
  /** The reusable config-key pubkey a partner config was created under. */
  config: string;
  /** NEW base-mint keypair pubkey for the launched token (operator generates it). */
  baseMint: string;
  /** The launching creator (pool creator). */
  poolCreator: string;
  /** Fee-payer for the createPool tx. */
  payer: string;
}

/** Mirrors the SDK's CreatePoolParams (base58; wrapper maps → PublicKey). */
export interface DbcLaunchParams {
  name: string;
  symbol: string;
  uri: string;
  config: string;
  baseMint: string;
  poolCreator: string;
  payer: string;
}

/**
 * Build (but do not submit) the params to launch a token through an existing
 * config key. The operator wrapper feeds these to `client.pool.createPool(...)`.
 */
export function buildLaunchParams(opts: BuildLaunchParamsOpts, tokenMeta: TokenMeta): DbcLaunchParams {
  const name = (tokenMeta.name ?? '').trim();
  const symbol = (tokenMeta.symbol ?? '').trim();
  const uri = (tokenMeta.uri ?? '').trim();
  if (!name) throw new Error('token name is required');
  if (!symbol) throw new Error('token symbol is required');
  if (!uri) throw new Error('token metadata uri is required');
  for (const [label, addr] of [
    ['config', opts.config],
    ['baseMint', opts.baseMint],
    ['poolCreator', opts.poolCreator],
    ['payer', opts.payer],
  ] as const) {
    if (!addr || !isLikelyBase58Pubkey(addr.trim())) {
      throw new Error(`${label} must be a valid base58 address`);
    }
  }
  return {
    name,
    symbol,
    uri,
    config: opts.config.trim(),
    baseMint: opts.baseMint.trim(),
    poolCreator: opts.poolCreator.trim(),
    payer: opts.payer.trim(),
  };
}

// ── Partner fee claim ─────────────────────────────────────────────────────────

export interface ClaimPartnerFeesOpts {
  /** The partner fee authority — MUST be the Squads vault. Signs the claim. */
  feeClaimer: SquadsVault;
  /** The DBC pool to claim from. */
  pool: string;
  /** Fee-payer for the claim tx. */
  payer: string;
  /**
   * Where claimed fees land. MUST also be a Squads vault (the claim signer has
   * full custody and could redirect to an EOA — we forbid that). Defaults to the
   * feeClaimer vault.
   */
  receiver?: SquadsVault;
  /** Max base tokens to claim. Default U64_MAX ("claim all available"). */
  maxBaseAmount?: bigint;
  /** Max quote tokens to claim. Default U64_MAX ("claim all available"). */
  maxQuoteAmount?: bigint;
}

/** Mirrors the SDK's ClaimPartnerTradingFeeToReceiverParams (base58/bigint). */
export interface DbcClaimPartnerFeesParams {
  feeClaimer: SquadsVault;
  payer: string;
  pool: string;
  receiver: SquadsVault;
  maxBaseAmount: bigint;
  maxQuoteAmount: bigint;
}

/**
 * Build (but do not submit) a partner trading-fee claim. Asserts the fee
 * authority AND the receiver are Squads vaults so accrued fees can never be
 * redirected to an EOA. The operator wrapper maps this to
 * `client.partner.claimPartnerTradingFee({ ...→PublicKey, ...→BN })`.
 */
export function claimPartnerFeesParams(opts: ClaimPartnerFeesOpts): DbcClaimPartnerFeesParams {
  const feeClaimer = asSquadsVault(opts.feeClaimer);
  const receiver = asSquadsVault(opts.receiver ?? opts.feeClaimer);
  if (!opts.pool || !isLikelyBase58Pubkey(opts.pool.trim())) {
    throw new Error('pool must be a valid base58 address');
  }
  if (!opts.payer || !isLikelyBase58Pubkey(opts.payer.trim())) {
    throw new Error('payer must be a valid base58 address');
  }
  const maxBaseAmount = opts.maxBaseAmount ?? U64_MAX;
  const maxQuoteAmount = opts.maxQuoteAmount ?? U64_MAX;
  if (maxBaseAmount < 0n || maxBaseAmount > U64_MAX) {
    throw new Error(`maxBaseAmount must be in [0, U64_MAX], got ${maxBaseAmount}`);
  }
  if (maxQuoteAmount < 0n || maxQuoteAmount > U64_MAX) {
    throw new Error(`maxQuoteAmount must be in [0, U64_MAX], got ${maxQuoteAmount}`);
  }
  return { feeClaimer, payer: opts.payer.trim(), pool: opts.pool.trim(), receiver, maxBaseAmount, maxQuoteAmount };
}
