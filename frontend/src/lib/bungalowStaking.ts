import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { solanaRpcEndpoint } from './solana';

/**
 * Bungalow staking adapter — the venue's thin seam over the Streamflow
 * staking SDK (@streamflow/staking 13.3.1, verified against its shipped
 * type definitions and README 2026-08-26).
 *
 * WHY THIS FILE EXISTS (and stays thin): the house rule is battle-tested
 * code only — the pool program, accounting and grouped flows are
 * Streamflow's, audited and SDK-shipped. Everything here is mapping,
 * defensive reads and honest error wrapping; there is deliberately NO math
 * of ours on the money path.
 *
 * The ONE apparent exception, and why it is not one: `stakeWeightScaled` and
 * `rewardRatePerPeriod` are DISPLAY math (what a lock is worth before the
 * user signs). They are exact transcriptions of the SDK's own
 * `calculateStakeWeight` / `calculateRewardRateFromAmount`, pinned against
 * the SDK's implementations by bungalowStakingRates.test.ts. They compute
 * nothing that rides a transaction — the amounts and durations the wallet
 * signs still come straight from the SDK's prepare paths below.
 *
 * FUNDING-LAST CONTRACT: the pool is expected to go live with an EMPTY
 * reward vault (the operator funds last). readPool() therefore reports the
 * vault balance as its own first-class fact — 0 renders as a real, labeled
 * zero, "could not read" stays an outage, and no rate shown anywhere is
 * presented as a yield the pool is actually paying while the vault is dry.
 *
 * Every @streamflow/* import is DYNAMIC: the SDK loads only after a pool
 * address is configured and the live section actually mounts — no bungalow
 * pool, no bytes.
 *
 * All calls resolve, never throw: `{ ok: false, reason }` is the only
 * failure shape, so render paths cannot crash on RPC weather.
 */

/** The program's fixed-point scale for weights (1e9 = a 1.00x multiplier). */
export const WEIGHT_SCALE = 1_000_000_000n;

/** `reward_amount` is quoted as a fraction of 1 / 10^9 (SDK REWARD_AMOUNT_DECIMALS). */
export const REWARD_AMOUNT_DECIMALS = 9;

export const SECONDS_PER_YEAR = 365 * 86_400;

export interface RewardPoolView {
  address: string;
  mint: string;
  /**
   * WHICH reward program owns this pool, and therefore how it pays.
   *
   * 'fixed'   — RWRDdfRbi…: carries `rewardAmount`/`rewardPeriod` and pays a
   *             RATE PER STAKED TOKEN. Each staker's rate is independent of
   *             everyone else's, so pool-wide emission scales without bound as
   *             TVL grows.
   * 'dynamic' — RWRDyfZa…: has NO rate fields at all. It carries
   *             `fundedAmount`/`claimedAmount` and splits a FUNDED BUDGET pro
   *             rata across effective stake, so total emission is bounded by
   *             what was funded and each staker's share DILUTES as stake joins.
   *             That is TOWELI's model.
   *
   * Load-bearing on every write: the SDK routes claim / create-entry /
   * close-entry / fund to a DIFFERENT PROGRAM based on this, and the wrong one
   * addresses a PDA that does not exist. It is also why reads must query both
   * programs — `client.searchRewardPools` only ever searches the fixed one.
   */
  kind: 'fixed' | 'dynamic';
  nonce: number;
  /** Escrow token account the rewards are paid out of. */
  vault: string;
  /** Decimals of the reward mint, read on-chain (never assumed). */
  decimals: number;
  /** Raw reward-vault balance (base units of the reward mint); null = unreadable. */
  fundedRaw: bigint | null;
  /** Whether ANYONE may top this vault up, or only the pool authority. */
  permissionless: boolean;
  /**
   * On-chain configured rate parts (raw, 1e9-scaled amount per effective token
   * per period). FIXED pools only — a dynamic pool has no rate and reports
   * '0' / 0 here. Check `kind` before quoting these as a rate anywhere.
   */
  rewardAmountRaw: string;
  rewardPeriodSecs: number;
  /**
   * DYNAMIC pools only: the program's own budget accounting, in raw units of
   * the reward mint. `fundedRaw` above is the live vault balance; these are
   * what the schedule says. null on a fixed pool, where they do not exist.
   */
  fundedAmountRaw: bigint | null;
  claimedAmountRaw: bigint | null;
  /** DYNAMIC pools only: how often a claim may be taken. 0 on fixed pools. */
  claimPeriodSecs: number;
}

export interface PoolView {
  address: string;
  mint: string;
  /** Decimals of the stake mint, read on-chain (never assumed). */
  decimals: number;
  /**
   * The mint's OWNER program (legacy SPL or Token-2022), detected at read
   * time and threaded through every write — BAYLA is Token-2022, and the
   * first mainnet broadcast died with IncorrectProgramId for assuming
   * legacy (2026-08-26). Never assume; always detect.
   */
  tokenProgram: string;
  minDurationSecs: number;
  maxDurationSecs: number;
  /**
   * Lock-weight bounds, 1e9-scaled: `1e9` = a 1.00x multiplier. When the two
   * are equal the pool grants NO duration bonus — a longer lock earns exactly
   * the same rate as the shortest one, and the UI has to say so rather than
   * imply a boost curve that does not exist. (The RETIRED first BAYLA pool
   * was this case: minWeight = maxWeight = 1e9, read on mainnet 2026-08-28.
   * The live replacement pool carries a real ladder — 1.00x min to 5.00x max
   * at 365d, re-pinned 2026-08-29 — so both branches of this UI rule are
   * exercised in production.)
   */
  minWeightScaled: bigint;
  maxWeightScaled: bigint;
  /** Cool-down between requesting an unstake and taking the tokens; 0 = none. */
  unstakePeriodSecs: number;
  /** Raw total staked (base units of the stake mint); null = unreadable. */
  totalStakeRaw: bigint | null;
  /**
   * Total staked NORMALISED back to raw stake units after each entry's weight
   * (the chain stores it as the sum of amount x weight, i.e. scaled by 1e9 —
   * see the program's own field docs). Null = unreadable.
   */
  totalEffectiveStakeRaw: bigint | null;
  rewardPools: RewardPoolView[];
}

export interface StakeEntryView {
  address: string;
  nonce: number;
  amountRaw: bigint;
  durationSecs: number;
  createdTs: number;
  /** 0 = still open. */
  closedTs: number;
  /** Weight-adjusted stake in raw stake units (what rewards are paid on). */
  effectiveAmountRaw: bigint;
  /**
   * Rewards accrued and not yet claimed, keyed by reward-pool nonce, in raw
   * units of that reward mint. `null` = the reward entry could not be read —
   * an outage, never a zero. Computed by the SDK's own `calcRewards`.
   */
  pendingRaw: Record<number, bigint | null>;
  /**
   * The reward entry's LIFETIME `accountedAmount`, keyed by reward-pool nonce.
   * `null` = no reward entry exists yet, or it could not be read.
   *
   * This is the field the u64 ceiling below is measured against — see
   * `claimCeilingReached`. It is deliberately separate from `pendingRaw`:
   * pending is what you are owed, `accountedRaw` is the cumulative counter that
   * decides whether the program can still do the arithmetic to pay it.
   */
  accountedRaw: Record<number, bigint | null>;
}

/**
 * The hard ceiling on a CLASSIC reward entry's `accountedAmount`.
 *
 * WHY IT MATTERS. `accountedAmount` is cumulative and monotonic — a claim pays
 * out but never resets it — and the classic program's claim path narrows it to
 * a u64. Once it passes this value, `claim_rewards` reverts with Anchor error
 * 6000 (`ArithmeticError`) and CAN NEVER SUCCEED AGAIN for that entry, because
 * the number only ever grows.
 *
 * PROVEN ON MAINNET 2026-09-06 against pool EFWpSpH9… / reward pool 3ysyH5py…:
 * simulating the real `claim_rewards` for all eight live entries, every entry
 * above this value reverted 6000 and every entry below it succeeded. A repo-wide
 * scan of the classic program found 5,859 of 13,808 reward entries (42.4%)
 * already past it, so this is a property of the program, not of one pool.
 *
 * It applies ONLY to `kind: 'fixed'` pools. The dynamic program tracks
 * rewards-per-share rather than per-position-times-time and does not accumulate
 * this way (verified against live pool HBLhyss5…, four months old, at 0.0000%).
 */
export const CLASSIC_ACCOUNTED_CEILING = (1n << 64n) - 1n;

/**
 * True when this entry's classic reward accounting has passed the ceiling, so a
 * claim from `rp` is permanently impossible. `false` when the counter is
 * unreadable — an unknown must never render as a verdict, and the honest
 * failure here is to let the claim be attempted and report what the chain says.
 */
export function claimCeilingReached(
  entry: Pick<StakeEntryView, 'accountedRaw'>,
  rp: Pick<RewardPoolView, 'nonce' | 'kind'>,
): boolean {
  if (rp.kind !== 'fixed') return false;
  const accounted = entry.accountedRaw?.[rp.nonce];
  if (accounted === null || accounted === undefined) return false;
  return accounted > CLASSIC_ACCOUNTED_CEILING;
}

/** True when ANY reward pool on this entry is past the ceiling. */
export function anyClaimCeilingReached(
  entry: Pick<StakeEntryView, 'accountedRaw'>,
  rewardPools: Pick<RewardPoolView, 'nonce' | 'kind'>[],
): boolean {
  return rewardPools.some((rp) => claimCeilingReached(entry, rp));
}

export type Result<T> = { ok: true } & T;
export type Failure = { ok: false; reason: string };

const READ_FAIL = 'The pool could not be read right now — that is an outage, not a zero.';

/* eslint-disable @typescript-eslint/no-explicit-any -- SDK account structs are
   IDL-derived; every access below is defensive against field drift. */

// ONE dynamic-import site for the SDK, shared by every call below — both so
// the chunk graph stays predictable and so tests mock a single seam.
async function loadSdk() {
  const [staking, { ICluster }] = await Promise.all([
    import('@streamflow/staking'),
    import('@streamflow/common'),
  ]);
  const client = new staking.SolanaStakingClient({
    clusterUrl: solanaRpcEndpoint(),
    cluster: ICluster.Mainnet,
  });
  return { client, staking };
}

async function makeClient() {
  return (await loadSdk()).client;
}

function bnToBigint(v: unknown): bigint | null {
  try {
    if (v === null || v === undefined) return null;
    return BigInt((v as { toString(): string }).toString());
  } catch {
    return null;
  }
}

function bnToNumber(v: unknown, fallback = 0): number {
  const b = bnToBigint(v);
  if (b === null) return fallback;
  const n = Number(b);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * Reward pools for a stake pool, from BOTH reward programs, each tagged with
 * which one it came from.
 *
 * WHY THIS EXISTS. `client.searchRewardPools` is hardwired to the FIXED
 * program — its body is `this.programs.rewardPoolProgram.account.rewardPool
 * .all(...)`. A dynamic pool attached to the same stake pool is therefore
 * INVISIBLE to it, and every number derived from it would silently omit the
 * pool that is actually paying. So the dynamic program is queried directly.
 *
 * The memcmp offset is 10 (Anchor's 8-byte discriminator + bump + nonce), the
 * same layout the SDK uses for the fixed program — verified empirically
 * against a live dynamic pool (stake pool Fgwemm7V…, reward pool HBLhyss5…),
 * because sharing a struct shape across sibling programs is an assumption, not
 * a guarantee. A filtered query is also required rather than a bare scan: the
 * venue's own RPC proxy caps response size and an unfiltered
 * getProgramAccounts over this program exceeds it.
 *
 * Either half failing is survivable and does NOT fail the read — a pool we
 * cannot see is reported as absent by the caller, never as a zero rate.
 */
async function searchAllRewardPools(client: any, stakePool: string): Promise<{ acc: any; kind: 'fixed' | 'dynamic' }[]> {
  const out: { acc: any; kind: 'fixed' | 'dynamic' }[] = [];
  try {
    const fixed: any[] = await client.searchRewardPools({ stakePool });
    for (const acc of fixed ?? []) out.push({ acc, kind: 'fixed' });
  } catch { /* fixed unreadable — the dynamic half may still answer */ }
  try {
    const dyn = client.getRewardProgram('dynamic');
    const found: any[] = await dyn.account.rewardPool.all([
      { memcmp: { offset: 10, bytes: stakePool } },
    ]);
    for (const acc of found ?? []) out.push({ acc, kind: 'dynamic' });
  } catch { /* dynamic unreadable — the fixed half may still answer */ }
  return out;
}

/** Mint decimals, read on-chain. Falls back to `fallback` when unreadable. */
async function readMintDecimals(client: any, mint: string, fallback: number): Promise<number> {
  try {
    if (!mint) return fallback;
    const { PublicKey } = await import('@solana/web3.js');
    const info: any = await client.connection.getParsedAccountInfo(new PublicKey(mint));
    const d = info?.value?.data?.parsed?.info?.decimals;
    return typeof d === 'number' && d >= 0 && d <= 18 ? d : fallback;
  } catch {
    return fallback;
  }
}

/* ───────────────────────── display math (SDK-pinned) ─────────────────────── */

/**
 * The lock weight for `durationSecs`, 1e9-scaled — an exact transcription of
 * the SDK's `calculateStakeWeight(minDuration, maxDuration, maxWeight,
 * duration)`, pinned against it by test. Clamps to >= 1.00x exactly as the
 * program does, so a flat-weight pool always reports 1e9.
 */
export function stakeWeightScaled(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'>,
  durationSecs: number,
): bigint {
  const span = BigInt(pool.maxDurationSecs) - BigInt(pool.minDurationSecs);
  if (span <= 0n) return WEIGHT_SCALE;
  const over = BigInt(Math.trunc(durationSecs)) - BigInt(pool.minDurationSecs);
  if (over <= 0n) return WEIGHT_SCALE;
  const normalized = (over * WEIGHT_SCALE) / span;
  const weightDiff = pool.maxWeightScaled - WEIGHT_SCALE;
  const w = WEIGHT_SCALE + (normalized * weightDiff) / WEIGHT_SCALE;
  return w > WEIGHT_SCALE ? w : WEIGHT_SCALE;
}

/**
 * The largest stake that can survive its OWN lock on a classic reward pool
 * before `accountedAmount` passes `CLASSIC_ACCOUNTED_CEILING`, in raw stake
 * units. `null` when the question does not apply — a dynamic pool, a zero
 * rate, or an unreadable configuration (never guess a cap from a number we
 * could not read).
 *
 * THE ARITHMETIC, transcribed from the program's own logs (mainnet, pool
 * 3ysyH5py…, tx 2VD1bTMR…):
 *
 *     accountable = effective_amount x reward_amount x periods / 1e9
 *     effective_amount = amountRaw x weightScaled          (weightScaled = weight x 1e9)
 *
 * so `accountedAmount` after `durationSecs` at one accrual period is
 *
 *     amountRaw x weightScaled x rewardAmount x durationSecs / (rewardPeriod x 1e9)
 *
 * and requiring that to stay under the ceiling rearranges to the return value
 * below. Checked against the live pool: at 365 days and 5.00x with
 * rewardAmount=7 / rewardPeriod=1 it yields 16,712 BAYLA, which matches the
 * observed break times of all eight live entries.
 *
 * WHY A CAP AND NOT A WARNING. Above this size the position is guaranteed to
 * stop being able to claim BEFORE its lock lets the holder leave — the ladder
 * pays more for locking longer, and locking longer is exactly what guarantees
 * the counter runs out first. Selling that lock is selling something that
 * cannot be delivered.
 */
export function maxSafeStakeRaw(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'>,
  rp: Pick<RewardPoolView, 'kind' | 'rewardAmountRaw' | 'rewardPeriodSecs'>,
  durationSecs: number,
): bigint | null {
  if (rp.kind !== 'fixed') return null;
  const rewardAmount = BigInt(rp.rewardAmountRaw || '0');
  const period = BigInt(Math.trunc(rp.rewardPeriodSecs));
  const secs = BigInt(Math.trunc(durationSecs));
  if (rewardAmount <= 0n || period <= 0n || secs <= 0n) return null;
  const weightScaled = stakeWeightScaled(pool, durationSecs);
  if (weightScaled <= 0n) return null;
  const denom = weightScaled * rewardAmount * secs;
  if (denom <= 0n) return null;
  return (CLASSIC_ACCOUNTED_CEILING * period * WEIGHT_SCALE) / denom;
}

/**
 * The tightest cap across every reward pool on this stake pool, or `null` when
 * no pool imposes one.
 */
export function maxSafeStakeAcrossPools(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'> & { rewardPools: RewardPoolView[] },
  durationSecs: number,
): bigint | null {
  let cap: bigint | null = null;
  for (const rp of pool.rewardPools) {
    const c = maxSafeStakeRaw(pool, rp, durationSecs);
    if (c === null) continue;
    if (cap === null || c < cap) cap = c;
  }
  return cap;
}

/** The same weight as a human multiplier (1.00 = no bonus). */
export function stakeWeight(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'>,
  durationSecs: number,
): number {
  return Number(stakeWeightScaled(pool, durationSecs)) / Number(WEIGHT_SCALE);
}

/** True when the pool grants no duration bonus at all (min weight == max weight). */
export function isFlatWeight(pool: Pick<PoolView, 'minWeightScaled' | 'maxWeightScaled'>): boolean {
  return pool.minWeightScaled === pool.maxWeightScaled;
}

/**
 * Whether this reward pool has a CONFIGURED RATE that can honestly be quoted.
 *
 * Only fixed pools do. A dynamic pool has no rate fields at all, so
 * `rewardAmountRaw` reads '0' and every rate helper below would return 0 —
 * which the UI would render as a confident "0% APR". That is a lie of a
 * familiar kind: reporting an ABSENT figure as a measured zero, the same
 * failure this file's outage-vs-zero rule exists to prevent.
 *
 * A dynamic pool's yield is `funded budget / total effective stake`, which is
 * an OBSERVATION that moves whenever anyone stakes — not a configured rate.
 * Callers must branch on this and present the two differently.
 */
export function quotesAConfiguredRate(rp: Pick<RewardPoolView, 'kind'>): boolean {
  return rp.kind === 'fixed';
}

/**
 * Reward tokens paid per ONE stake token per reward period, at 1.00x weight —
 * a transcription of the SDK's `calculateRewardRateFromAmount(rewardAmount,
 * stakeDecimals, rewardDecimals)`.
 */
export function rewardRatePerPeriod(
  pool: Pick<PoolView, 'decimals'>,
  rp: Pick<RewardPoolView, 'decimals' | 'rewardAmountRaw'>,
): number {
  const scale = rp.decimals + REWARD_AMOUNT_DECIMALS - pool.decimals;
  const raw = Number(rp.rewardAmountRaw || '0');
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** scale;
}

/**
 * The pool's CONFIGURED annual rate for a lock of `durationSecs`: reward
 * tokens per one staked token per year, weight applied. This is the rate the
 * program is set to pay — it is NOT a claim that the vault can pay it, which
 * is why every caller renders it beside the vault balance.
 */
export function configuredAnnualRate(pool: PoolView, rp: RewardPoolView, durationSecs: number): number {
  if (rp.rewardPeriodSecs <= 0) return 0;
  const periodsPerYear = SECONDS_PER_YEAR / rp.rewardPeriodSecs;
  return rewardRatePerPeriod(pool, rp) * periodsPerYear * stakeWeight(pool, durationSecs);
}

/**
 * True when the reward mint IS the stake mint — the only case where the rate
 * above is a percentage of the deposit and may be printed as an APR. Any other
 * pair needs two prices to become a percentage, and this venue does not invent
 * prices, so those render as "x REWARD per BAYLA per year" instead.
 */
export function rateIsPercent(pool: Pick<PoolView, 'mint'>, rp: Pick<RewardPoolView, 'mint'>): boolean {
  return rp.mint !== '' && rp.mint === pool.mint;
}

/**
 * How long the vault can pay at the CURRENT effective stake, in seconds, or
 * null when that cannot be stated honestly (nothing staked, vault unreadable
 * or empty, zero rate). Nothing here extrapolates: it answers "at today's
 * stake and today's rate", which is the only runway a pool can be held to.
 */
export function vaultRunwaySecs(pool: PoolView, rp: RewardPoolView): number | null {
  if (rp.fundedRaw === null || rp.fundedRaw === 0n) return null;
  const effective = pool.totalEffectiveStakeRaw;
  if (effective === null || effective === 0n) return null;
  const stakedTokens = Number(effective) / 10 ** pool.decimals;
  const perPeriodRaw = stakedTokens * rewardRatePerPeriod(pool, rp) * 10 ** rp.decimals;
  if (!(perPeriodRaw > 0)) return null;
  const periods = Number(rp.fundedRaw) / perPeriodRaw;
  if (!Number.isFinite(periods)) return null;
  return Math.floor(periods * rp.rewardPeriodSecs);
}

/**
 * Unix seconds at which an entry's lock expires. The program refuses an
 * unstake before this ("Stake is locked, unstake is not possible"), so the UI
 * has to disable the button rather than let the wallet eat the refusal.
 */
export function unlockTs(entry: Pick<StakeEntryView, 'createdTs' | 'durationSecs'>): number {
  return entry.createdTs + entry.durationSecs;
}

export interface LockPreset {
  label: string;
  days: number;
  seconds: number;
}

const DAY = 86_400;

/**
 * The lock-duration buttons, in the venue's own LOCK_OPTIONS idiom (7 Days /
 * 30 Days / 90 Days / 6 Months / 1 Year …) but CLAMPED to what this pool will
 * actually accept: the program rejects anything under `minDuration`, and the
 * weight stops growing at `maxDuration`.
 *
 * The pool's own bounds always appear as the first and last button even when
 * they are not round numbers, so "the shortest lock this pool allows" and "the
 * longest lock that still counts" are always one click away.
 */
/**
 * The longest lock the VENUE will offer, regardless of what the pool allows.
 *
 * WHY THIS EXISTS (2026-09-06). Two independent reasons, both about the same
 * cohort — people who cannot leave:
 *
 *  1. THE CEILING. On a classic reward pool a position's cumulative counter
 *     overflows u64 after `30,501,000 / (weight x days)` days (see
 *     `maxSafeStakeRaw`). At the 365d/5.00x rung that is ~16,700 BAYLA — so the
 *     longest, best-paid rung is the one that breaks soonest, and it breaks
 *     while the holder is still locked in. `maxSafeStakeRaw` already refuses an
 *     oversized position; this refuses the tail of the ladder outright.
 *  2. THE TRAPPED COHORT. The reward rail is moving to the dynamic program, and
 *     Streamflow has no migration between pools — `migrate_entry` only moves
 *     between two Streamflow STREAM pools, and the receipt mint is frozen. So
 *     anyone who locks for a year today cannot follow the venue anywhere until
 *     2027. Every long lock sold now is a person who has to be carried.
 *
 * THIS IS A UI GATE, NOT AN ON-CHAIN ONE. The stake program has no
 * `update_pool` at all — `min_duration` and `max_duration` are create-only and
 * immutable — so the pool will still accept a 365-day stake from anyone who
 * builds the instruction themselves. The venue simply stops offering it, and
 * the copy has to say exactly that rather than implying the pool changed.
 *
 * It costs the top of the ladder: at 90 days the weight is ~1.98x against the
 * 5.00x a year would earn. That is the price of not selling a lock the rail
 * cannot honour, and it is worth paying until `bayla-ladder` exists.
 */
export const OFFERED_LOCK_CEILING_DAYS = 90;

/** The pool's own maximum, clamped to what the venue is willing to offer. */
export function offeredMaxLockDays(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs'>,
): number {
  const minDays = Math.max(1, Math.ceil(pool.minDurationSecs / DAY));
  const poolMax = Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY));
  // Never below the pool's OWN minimum: a pool whose min_duration exceeds the
  // ceiling would otherwise offer an empty ladder and no stake at all.
  return Math.max(minDays, Math.min(poolMax, OFFERED_LOCK_CEILING_DAYS));
}

/** True when the venue is holding the ladder short of what the pool allows. */
export function lockCeilingApplies(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs'>,
): boolean {
  return offeredMaxLockDays(pool) < Math.floor(pool.maxDurationSecs / DAY);
}

/**
 * `ceilingDays` is the VENUE's policy, not the pool's. It defaults to no cap so
 * that this function keeps meaning exactly what its tests say it means — the
 * ladder the POOL will accept — and a caller that wants the shorter, offered
 * ladder asks for it explicitly. Keeping the two separable matters: the copy
 * next to the picker has to be able to say "the pool allows X, we offer Y",
 * which is impossible if the pool's own range has already been thrown away.
 */
export function lockPresets(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs'>,
  ceilingDays?: number,
): LockPreset[] {
  const minDays = Math.max(1, Math.ceil(pool.minDurationSecs / DAY));
  const poolMax = Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY));
  const maxDays = ceilingDays === undefined
    ? poolMax
    : Math.max(minDays, Math.min(poolMax, ceilingDays));
  const candidates = [
    { label: '1 Day', days: 1 },
    { label: '7 Days', days: 7 },
    { label: '30 Days', days: 30 },
    { label: '90 Days', days: 90 },
    { label: '6 Months', days: 180 },
    { label: '1 Year', days: 365 },
    { label: '2 Years', days: 730 },
    { label: '4 Years', days: 1460 },
  ].filter((c) => c.days >= minDays && c.days <= maxDays);

  const byDays = new Map<number, LockPreset>();
  const put = (label: string, days: number) => {
    if (!byDays.has(days)) byDays.set(days, { label, days, seconds: days * DAY });
  };
  put(labelForDays(minDays), minDays);
  for (const c of candidates) put(c.label, c.days);
  put(labelForDays(maxDays), maxDays);
  return [...byDays.values()].sort((a, b) => a.days - b.days);
}

/**
 * The lock a staker gets if they touch nothing: ALWAYS the shortest the pool
 * allows.
 *
 * This is a safety invariant, not a style choice. The stake program has no
 * early exit — not for a penalty, not by the pool authority — and a locked
 * position cannot even be sold (the entry PDA hashes the staker's own wallet
 * and the stake mint is frozen). So whatever is pre-selected is what an
 * inattentive staker is held to, with no recourse, for its whole duration.
 * The longer, better-paying locks stay one click away; they just have to be
 * chosen deliberately. Do NOT "improve" this into a mid-range default.
 */
export function defaultLockDays(presets: LockPreset[], minDays: number): number {
  if (!presets.length) return minDays;
  return Math.min(...presets.map((p) => p.days));
}

/** "30 Days" / "6 Months" / "1 Year" for an arbitrary day count. */
export function labelForDays(days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const y = days / 365;
    return y === 1 ? '1 Year' : `${y} Years`;
  }
  if (days >= 30 && days % 30 === 0) {
    const m = days / 30;
    return m === 1 ? '1 Month' : `${m} Months`;
  }
  return days === 1 ? '1 Day' : `${days} Days`;
}

/* ──────────────────────────────── reads ─────────────────────────────────── */

/** Read the configured stake pool + its reward pools + each reward vault's balance. */
export async function readPool(stakePool: string): Promise<Result<{ pool: PoolView }> | Failure> {
  try {
    const client = await makeClient();
    const pool: any = await client.getStakePool(stakePool);
    // Account-not-found is NOT RPC weather: the address is wrong or the pool
    // is gone. Saying "could not be read right now" there disguises a
    // permanent misconfig as a transient outage.
    if (!pool) return { ok: false, reason: 'No stake pool exists at this address. If this persists, the configured pool address is wrong.' };
    // BOTH programs — the SDK's own search covers only the fixed one.
    const rewardAccounts = await searchAllRewardPools(client, stakePool);

    const stakeMint = String(pool?.mint ?? '');
    // Decimals decide every human number on this surface (and the reward RATE,
    // which is quoted per raw unit) — read them, never assume 6.
    const stakeDecimals = await readMintDecimals(client, stakeMint, 6);

    const rewardPools: RewardPoolView[] = [];
    for (const { acc, kind } of rewardAccounts) {
      const rp = acc?.account ?? acc;
      const address = String(acc?.publicKey ?? '');
      const rewardMint = String(rp?.mint ?? '');
      let fundedRaw: bigint | null = null;
      try {
        const vault = rp?.vault;
        if (vault) {
          const bal = await client.connection.getTokenAccountBalance(vault);
          fundedRaw = BigInt(bal.value.amount);
        }
      } catch { /* vault unreadable → stays null (outage, not zero) */ }
      rewardPools.push({
        address,
        mint: rewardMint,
        kind,
        nonce: bnToNumber(rp?.nonce),
        vault: String(rp?.vault ?? ''),
        decimals: rewardMint === stakeMint
          ? stakeDecimals
          : await readMintDecimals(client, rewardMint, stakeDecimals),
        fundedRaw,
        permissionless: Boolean(rp?.permissionless),
        // A dynamic pool has NO rate fields — these read 0 there, and callers
        // must branch on `kind` rather than quoting a zero rate as a fact.
        rewardAmountRaw: String(bnToBigint(rp?.rewardAmount) ?? '0'),
        rewardPeriodSecs: bnToNumber(rp?.rewardPeriod),
        fundedAmountRaw: kind === 'dynamic' ? bnToBigint(rp?.fundedAmount) : null,
        claimedAmountRaw: kind === 'dynamic' ? bnToBigint(rp?.claimedAmount) : null,
        claimPeriodSecs: kind === 'dynamic' ? bnToNumber(rp?.claimPeriod) : 0,
      });
    }

    // Detect the mint's owner program (Token-2022 vs legacy) for the writes.
    let tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const mintInfo = await client.connection.getAccountInfo(new PublicKey(stakeMint));
      if (mintInfo?.owner) tokenProgram = mintInfo.owner.toBase58();
    } catch { /* keep legacy default; writes against the wrong program fail loudly, never silently */ }

    const totalEffectiveScaled = bnToBigint(pool?.totalEffectiveStake);

    return {
      ok: true,
      pool: {
        address: stakePool,
        mint: stakeMint,
        decimals: stakeDecimals,
        tokenProgram,
        minDurationSecs: bnToNumber(pool?.minDuration),
        maxDurationSecs: bnToNumber(pool?.maxDuration),
        minWeightScaled: bnToBigint(pool?.minWeight) ?? WEIGHT_SCALE,
        maxWeightScaled: bnToBigint(pool?.maxWeight) ?? WEIGHT_SCALE,
        unstakePeriodSecs: bnToNumber(pool?.unstakePeriod),
        totalStakeRaw: bnToBigint(pool?.totalStake),
        totalEffectiveStakeRaw:
          totalEffectiveScaled === null ? null : totalEffectiveScaled / WEIGHT_SCALE,
        rewardPools,
      },
    };
  } catch (err) {
    // The UI copy stays honest and generic, but a bare catch left NOBODY able to
    // say why the lighthouse read failed — the cause never reached a console.
    // Warn with the real error (same-origin proxy URL, no secret to leak).
    console.warn('[bungalowStaking] readPool failed', err);
    return { ok: false, reason: READ_FAIL };
  }
}

/** Free-balance read for the stake mint — what the amount field's MAX fills in. */
export async function readWalletBalance(
  mint: string,
  owner: string,
): Promise<Result<{ raw: bigint }> | Failure> {
  try {
    const client = await makeClient();
    const { PublicKey } = await import('@solana/web3.js');
    const resp: any = await client.connection.getParsedTokenAccountsByOwner(
      new PublicKey(owner),
      { mint: new PublicKey(mint) },
    );
    const raw = (resp?.value ?? []).reduce((sum: bigint, a: any) => {
      const v = a?.account?.data?.parsed?.info?.tokenAmount?.amount;
      return sum + (v ? BigInt(v) : 0n);
    }, 0n);
    return { ok: true, raw };
  } catch {
    return { ok: false, reason: 'Your balance could not be read right now.' };
  }
}

/**
 * The connected wallet's stake entries for this pool (open ones first), each
 * with the rewards it has accrued per reward pool.
 *
 * Pending rewards come from the SDK's own `calcRewards` over the real
 * on-chain reward entry — no accrual math of ours. A reward entry that cannot
 * be read leaves that pool's number `null` (unknown), never 0.
 */
export async function readEntries(
  stakePool: string,
  owner: string,
): Promise<Result<{ entries: StakeEntryView[] }> | Failure> {
  try {
    const { client, staking } = await loadSdk();
    const accounts: any[] = await client.searchStakeEntries({
      stakePool: stakePool as any,
      payer: owner as any,
    });

    // Reward pools are needed to price the accrual; a failed read just leaves
    // every pending number unknown.
    let rewardAccounts: any[] = [];
    try {
      // BOTH programs: a dynamic pool is invisible to client.searchRewardPools,
      // and omitting it would silently under-report every pending figure.
      rewardAccounts = (await searchAllRewardPools(client, stakePool)).map((r) => r.acc);
    } catch { /* pending stays null below */ }

    const raw = accounts.map((acc) => ({ acc, e: acc?.account ?? acc }));
    // Only OPEN entries accrue, and only a handful ever exist per wallet; the
    // cap keeps a pathological wallet from firing 256 x N account scans.
    const accruing = raw.filter(({ e }) => bnToNumber(e?.closedTs) === 0).slice(0, 8);
    const pendingByEntry = new Map<string, Record<number, bigint | null>>();
    const accountedByEntry = new Map<string, Record<number, bigint | null>>();
    for (const { acc } of accruing) {
      const perPool: Record<number, bigint | null> = {};
      const perPoolAccounted: Record<number, bigint | null> = {};
      for (const rpAcc of rewardAccounts) {
        const nonce = bnToNumber((rpAcc?.account ?? rpAcc)?.nonce);
        try {
          const found: any[] = await client.searchRewardEntries({
            stakeEntry: String(acc?.publicKey ?? '') as any,
            rewardPool: String(rpAcc?.publicKey ?? '') as any,
          });
          perPool[nonce] = bnToBigint(staking.calcRewards(found[0], acc, rpAcc));
          // The RAW cumulative counter, straight off the entry — NOT via
          // calcRewards, which synthesises a default entry when none is found
          // and would hand us a fabricated number to gate a button on. An
          // entry that does not exist has no counter, and `null` says so.
          const entryAcc = found[0]?.account ?? found[0];
          perPoolAccounted[nonce] = entryAcc ? bnToBigint(entryAcc.accountedAmount) : null;
        } catch {
          perPool[nonce] = null;
          perPoolAccounted[nonce] = null;
        }
      }
      pendingByEntry.set(String(acc?.publicKey ?? ''), perPool);
      accountedByEntry.set(String(acc?.publicKey ?? ''), perPoolAccounted);
    }

    const entries = raw
      .map(({ acc, e }) => {
        const address = String(acc?.publicKey ?? '');
        const amountRaw = bnToBigint(e?.amount) ?? 0n;
        return {
          address,
          nonce: bnToNumber(e?.nonce),
          amountRaw,
          durationSecs: bnToNumber(e?.duration),
          createdTs: bnToNumber(e?.createdTs),
          closedTs: bnToNumber(e?.closedTs),
          effectiveAmountRaw: bnToBigint(e?.effectiveAmount) ?? amountRaw,
          pendingRaw: pendingByEntry.get(address) ?? {},
          accountedRaw: accountedByEntry.get(address) ?? {},
        };
      })
      .sort((a, b) => (a.closedTs === 0 ? -1 : 1) - (b.closedTs === 0 ? -1 : 1) || b.createdTs - a.createdTs);
    return { ok: true, entries };
  } catch {
    return { ok: false, reason: 'Your stakes could not be read right now.' };
  }
}

/** Lowest nonce in [0,255] not used by an OPEN entry (closed entries free theirs). */
export function nextVacantNonce(entries: StakeEntryView[]): number | null {
  // AUDIT (2026-09-01): this used to skip CLOSED entries, on the assumption
  // that closing frees the nonce. It does not. A closed entry is still an
  // ACCOUNT — StakeEntryView carries `closedTs` precisely because the record
  // survives its close — and the entry PDA is derived from
  // (stakePool, authority, nonce). Re-using the nonce therefore tries to
  // initialise an address that is already in use, and the stake reverts. Left
  // as it was, a returning staker's second position could never be opened.
  //
  // So EVERY entry the search returns occupies its nonce, open or closed. The
  // asymmetry makes this the safe direction: wrongly skipping a free nonce
  // costs nothing out of 256, while wrongly re-using a taken one is a failed
  // transaction the user pays for and cannot diagnose.
  const used = new Set(entries.map((e) => e.nonce));
  for (let n = 0; n < 256; n++) {
    if (!used.has(n)) return n;
  }
  return null;
}

/* ──────────────────────────────── writes ────────────────────────────────── */

function writeFailure(err: unknown, fallback: string): Failure {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/reject|declin|denied/i.test(msg)) return { ok: false, reason: 'You declined the signature — nothing moved.' };
  // Streamflow custom error 6012 = the reward vault cannot cover the rewards
  // this action must pay out. PROVEN ON DEVNET (2026-08-28, same program ids
  // as mainnet): while accrued > vault, claim AND unstake&claim both revert —
  // principal stays locked until the vault is topped up, and the backlog is
  // NOT forfeited (a post-funding claim paid the full dry-window accrual).
  if (/\b6012\b/.test(msg)) {
    return {
      ok: false,
      reason:
        'The reward vault cannot cover the accrued rewards this action pays out, so it reverted — nothing moved, nothing is lost. ' +
        'Claims and exits work again once the vault is topped up; rewards keep accruing meanwhile.',
    };
  }
  // Streamflow custom error 6000 = ArithmeticError on the CLASSIC reward
  // program. On the claim path it means one thing and only one thing: this
  // entry's cumulative `accountedAmount` has passed u64::MAX, so the program
  // can no longer compute the payout. PROVEN ON MAINNET (2026-09-06): the real
  // `claim_rewards` instruction was simulated for all eight live entries on
  // pool EFWpSpH9…; every entry above the ceiling returned exactly this error
  // and every entry below it succeeded.
  //
  // It is PERMANENT — the counter is cumulative and a claim does not reset it,
  // so it can never come back under the ceiling. Say so, because "try again
  // later" is the one thing a reader must not conclude. Principal is NOT at
  // risk: the stake program's `unstake` does not take the reward entry as an
  // account at all, and a real overflowed position was seen exiting on mainnet
  // (tx 2eLftTr3…, 2026-09-04) with no reward instruction in the transaction.
  if (/\b6000\b/.test(msg) || /ArithmeticError/i.test(msg)) {
    return {
      ok: false,
      reason:
        'This position has passed a hard limit inside the reward program, so it can no longer pay out — nothing moved, and this will not clear by retrying. ' +
        'Your staked BAYLA is safe and still returns in full when the lock ends; it is the unclaimed rewards on this position that can no longer be collected.',
    };
  }
  // A confirmation timeout is NOT "nothing moved": web3's TransactionExpired*
  // errors fire AFTER the transaction was broadcast, and it may still land.
  // Asserting "nothing moved" there invites a duplicate stake (a second
  // 1–365-day lock of real funds). Say the outcome is unknown and carry the
  // signature when the error object has one, so the user can check first.
  const sig = (err as { signature?: unknown } | null)?.signature;
  if (typeof sig === 'string' && sig !== '' || /not confirmed|expired|block ?height exceeded|timed? ?out/i.test(msg)) {
    const sigNote = typeof sig === 'string' && sig ? ` Signature: ${sig}` : '';
    return {
      ok: false,
      reason: `Outcome unknown — the transaction was sent and may still land. Check your wallet or Solscan before retrying.${sigNote}`,
    };
  }
  return { ok: false, reason: `${fallback}${msg ? ` (${msg.slice(0, 140)})` : ''}` };
}

/**
 * Stake — the SDK's prepare-path with one extra instruction in FRONT: an
 * idempotent create of the staker's ATA for the stake-mint PDA (the receipt
 * token the pool mints). PROVEN NECESSARY on devnet: without it, Stake dies
 * with AccountNotInitialized on the `to` account for every first-time
 * staker (rehearsal tx 4B8hFc…KJRu). Everything rides ONE transaction via
 * the SDK's own execute() (bundling + compute budget are theirs).
 */
export async function stake(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  amountRaw: bigint;
  durationSecs: number;
  entries: StakeEntryView[];
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const nonce = nextVacantNonce(args.entries);
    if (nonce === null) return { ok: false, reason: 'All 256 stake slots are in use for this wallet.' };
    const staker = args.invoker.publicKey;
    if (!staker) return { ok: false, reason: 'Connect a wallet first.' };
    const [{ client, staking }, { default: BN }, web3, splToken] = await Promise.all([
      loadSdk(),
      import('bn.js'),
      import('@solana/web3.js'),
      import('@solana/spl-token'),
    ]);
    const ext = { invoker: args.invoker };
    const stakeMintPda = staking.deriveStakeMintPDA(
      client.getCurrentProgramId('stakePoolProgram' as any),
      new web3.PublicKey(args.pool.address),
    );
    // The receipt mint is created BY the pool program — read its owner
    // program from the chain rather than assuming it matches the stake
    // token's (Token-2022 pools may differ; detection is always right).
    let receiptProgram = new web3.PublicKey(args.pool.tokenProgram);
    try {
      const info = await client.connection.getAccountInfo(stakeMintPda);
      if (info?.owner) receiptProgram = info.owner as any;
    } catch { /* fall back to the pool's token program */ }
    const receiptAta = splToken.getAssociatedTokenAddressSync(stakeMintPda, staker, false, receiptProgram);
    const ataIx = splToken.createAssociatedTokenAccountIdempotentInstruction(staker, receiptAta, staker, stakeMintPda, receiptProgram);
    const stakePrep: any = await client.prepareStakeInstructions(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        amount: new BN(args.amountRaw.toString()),
        duration: new BN(String(args.durationSecs)),
        nonce,
        tokenProgramId: args.pool.tokenProgram as any,
      },
      ext,
    );
    const rewardIxs: any[] = [];
    for (const rp of args.pool.rewardPools) {
      const prep: any = await client.prepareCreateRewardEntryInstructions(
        {
          stakePool: args.pool.address as any,
          stakePoolMint: args.pool.mint as any,
          rewardPoolNonce: rp.nonce,
          depositNonce: nonce,
          rewardMint: rp.mint as any,
          // The pool's OWN program — a dynamic pool's entry PDA lives under a
          // different program id, so a hardcoded 'fixed' addresses nothing.
          rewardPoolType: rp.kind,
          tokenProgramId: args.pool.tokenProgram as any,
        } as any,
        ext,
      );
      rewardIxs.push(...(prep?.ixs ?? []));
    }
    const res: any = await client.execute([ataIx, ...(stakePrep?.ixs ?? []), ...rewardIxs], ext);
    return { ok: true, txId: String(res?.txId ?? res?.signature ?? '') };
  } catch (err) {
    return writeFailure(err, 'The stake did not go through — nothing moved.');
  }
}

/** Unstake + claim + close entries via the SDK's grouped flow. */
export async function unstakeAndClaim(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  entryNonce: number;
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const client = await makeClient();
    const res: any = await client.unstakeAndClaim(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        nonce: args.entryNonce,
        tokenProgramId: args.pool.tokenProgram as any,
        rewardPools: args.pool.rewardPools.map((rp) => ({
          nonce: rp.nonce,
          mint: rp.mint as any,
          rewardPoolType: rp.kind,
          tokenProgramId: args.pool.tokenProgram as any,
        })),
      },
      { invoker: args.invoker },
    );
    return { ok: true, txId: String(res?.txId ?? '') };
  } catch (err) {
    return writeFailure(err, 'The unstake did not go through — your stake is untouched.');
  }
}

/**
 * PRINCIPAL RESCUE — unstake a MATURED entry WITHOUT claiming rewards.
 *
 * WHY THIS EXISTS. `unstakeAndClaim` above settles rewards in the same
 * transaction, so when accrued rewards exceed the reward vault the program
 * reverts the WHOLE transaction with error 6012 (`RewardPoolDrained`) — and a
 * funding gap therefore holds *principal* hostage even after the lock has
 * fully expired. That is the failure this function exists to defeat. The SDK
 * always had it; the venue simply never wired it (found 2026-09-02, with
 * 2,022,682 BAYLA and eight stakers live on the pool).
 *
 * WHAT IT COSTS, and it must be said in the UI, not buried here: the SDK's
 * `unstakeAndClose` is `unstake(shouldClose: true)` + `closeRewardEntry` — it
 * CLOSES the reward entry rather than claiming it, which is exactly why it
 * never touches the reward vault and so cannot hit 6012. Closing the entry
 * abandons whatever had accrued. This is a way to get PRINCIPAL out of a pool
 * whose reward vault is short; it is not a free alternative to a normal exit.
 *
 * WHAT IT IS NOT. It is not an early exit. The lock is still enforced by
 * `unstake` (error 6013 `LockedStake`) exactly as before, so this cannot be
 * used to leave before maturity. Streamflow has no early exit at any price and
 * this does not add one.
 */
export async function unstakeAndCloseForfeitingRewards(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  entryNonce: number;
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const client = await makeClient();
    // Same argument shape as unstakeAndClaim — the SDK aliases
    // UnstakeAndClaimArgs = UnstakeAndCloseArgs.
    const res: any = await client.unstakeAndClose(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        nonce: args.entryNonce,
        tokenProgramId: args.pool.tokenProgram as any,
        rewardPools: args.pool.rewardPools.map((rp) => ({
          nonce: rp.nonce,
          mint: rp.mint as any,
          rewardPoolType: rp.kind,
          tokenProgramId: args.pool.tokenProgram as any,
        })),
      },
      { invoker: args.invoker },
    );
    return { ok: true, txId: String(res?.txId ?? '') };
  } catch (err) {
    return writeFailure(err, 'The rescue unstake did not go through — your stake is untouched.');
  }
}

/** Claim rewards from one reward pool for one stake entry. */
export async function claimRewards(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  rewardPool: RewardPoolView;
  entryNonce: number;
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const client = await makeClient();
    const res: any = await client.claimRewards(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        rewardPoolNonce: args.rewardPool.nonce,
        depositNonce: args.entryNonce,
        rewardMint: args.rewardPool.mint as any,
        rewardPoolType: args.rewardPool.kind,
        tokenProgramId: args.pool.tokenProgram as any,
      },
      { invoker: args.invoker },
    );
    return { ok: true, txId: String(res?.txId ?? '') };
  } catch (err) {
    return writeFailure(err, 'The claim did not go through — your rewards are untouched.');
  }
}

/**
 * True while the vault is too thin to make staking EXIT-SAFE: empty, below
 * one whole reward token (the 1-raw-unit "dust defeats the empty banner"
 * grief), or covering less than one day at the current stake. PROVEN
 * LOAD-BEARING (devnet 2026-08-28, Streamflow error 6012, same program ids
 * as mainnet): while accrued rewards exceed the vault, claim AND
 * unstake&claim REVERT — principal is locked until the vault is topped up
 * past accrual (the backlog itself survives; a post-funding claim paid the
 * full dry window). Built on `vaultRunwaySecs` so there is exactly ONE
 * runway computation in this file. An unreadable vault is an OUTAGE, not a
 * verdict — the caller renders the outage state instead.
 */
/**
 * What the pool is ACTUALLY paying right now, as opposed to what it is
 * configured to pay. The distinction is the whole honesty contract of the
 * staking card, and it must be decided by ONE predicate everywhere:
 *
 *   2026-08-30 defect — the card derived this from `funded > 0n` while its own
 *   banner, stake gate and projections used `vaultIsMateriallyEmpty`. The two
 *   disagree in exactly the states that predicate exists for (dust below one
 *   whole token, or under a day of runway), so a dust-funded pool printed the
 *   full configured APR in green DIRECTLY ABOVE a banner reading "Paying now
 *   is 0% because the reward vault is effectively empty."
 *
 * `vaultDry` is false when the vault is UNREADABLE, so an outage never lands
 * in the zero branch — an unreadable vault is an outage, never a real zero.
 */
export function payingNowRate(
  configuredRate: number,
  fundedRaw: bigint | null,
  vaultDry: boolean,
): number {
  if (fundedRaw === null) return 0;
  return vaultDry ? 0 : configuredRate;
}

export function vaultIsMateriallyEmpty(pool: PoolView, rp: RewardPoolView): boolean {
  if (rp.fundedRaw === null) return false;
  if (rp.fundedRaw === 0n) return true;
  if (rp.fundedRaw < 10n ** BigInt(rp.decimals)) return true;
  const runwaySecs = vaultRunwaySecs(pool, rp);
  return runwaySecs !== null && runwaySecs < 86_400;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
