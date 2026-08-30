/**
 * Pure view-model math for the EVM lighthouse (vendored Synthetix
 * StakingRewards — contracts/src/vendor/synthetix-staking-rewards/, provenance
 * D8). Kept free of wagmi so every honesty rule here is unit-testable.
 *
 * THE HONESTY RULES (the Solana card's contract, re-derived for this program):
 *  - THE VAULT IS balance − principal. Same-token pools hold staked principal
 *    in the reward token, so the raw pool balance is a LIE as a vault number —
 *    printing it would count other people's stake as funding (VENDOR.md's
 *    same-token law, the display half).
 *  - A rate only counts while the period runs: paying-now is 0 the second
 *    `periodFinish` passes — a real, labeled zero — while "configured" keeps
 *    stating what the last notify set.
 *  - A failed read is an OUTAGE, never a zero. Callers hand in `null` for
 *    anything unreadable and every derived figure that touches it goes null.
 *  - No locks exist on this program: stake/withdraw are always free, withdraw
 *    moves principal only. (The Solana lighthouse's 6012 hostage class is
 *    structurally impossible here — that is WHY this contract was chosen.)
 */

export interface EvmLighthouseReads {
  /** pool.totalSupply() — staked principal. */
  totalStakedRaw: bigint | null;
  /** token.balanceOf(pool) — principal + funded rewards, undivided. */
  poolTokenBalanceRaw: bigint | null;
  /** pool.rewardRate() — reward raw units per second, pool-wide. */
  rewardRateRaw: bigint | null;
  /** pool.periodFinish() — unix seconds; 0 = never funded. */
  periodFinishSecs: bigint | null;
  /** pool.rewardsDuration() — seconds per notify cycle (canonical 60d). */
  rewardsDurationSecs: bigint | null;
  /** pool.balanceOf(user); null when disconnected or unreadable. */
  userStakedRaw: bigint | null;
  /** pool.earned(user); null when disconnected or unreadable. */
  userEarnedRaw: bigint | null;
}

export interface EvmLighthouseView {
  /** Funded rewards = balance − principal, clamped at 0. Null on outage. */
  vaultRaw: bigint | null;
  /** True while now < periodFinish (a live reward period). */
  periodActive: boolean | null;
  /** Rate actually paying THIS second (0 after periodFinish — honest zero). */
  payingNowRawPerSec: bigint | null;
  /** What the last notify configured, regardless of period state. */
  configuredRawPerSec: bigint | null;
  /** Seconds until periodFinish; 0 when over/never funded. Null on outage. */
  runwaySecs: bigint | null;
  /** Core reads all present (page can render figures, not the outage card). */
  coreKnown: boolean;
}

export function deriveEvmLighthouse(r: EvmLighthouseReads, nowSecs: bigint): EvmLighthouseView {
  const coreKnown =
    r.totalStakedRaw !== null &&
    r.poolTokenBalanceRaw !== null &&
    r.rewardRateRaw !== null &&
    r.periodFinishSecs !== null &&
    r.rewardsDurationSecs !== null;

  let vaultRaw: bigint | null = null;
  if (r.poolTokenBalanceRaw !== null && r.totalStakedRaw !== null) {
    vaultRaw = r.poolTokenBalanceRaw > r.totalStakedRaw ? r.poolTokenBalanceRaw - r.totalStakedRaw : 0n;
  }

  let periodActive: boolean | null = null;
  let payingNowRawPerSec: bigint | null = null;
  let runwaySecs: bigint | null = null;
  if (r.periodFinishSecs !== null) {
    periodActive = nowSecs < r.periodFinishSecs;
    runwaySecs = periodActive ? r.periodFinishSecs - nowSecs : 0n;
    if (r.rewardRateRaw !== null) {
      payingNowRawPerSec = periodActive ? r.rewardRateRaw : 0n;
    }
  }

  return {
    vaultRaw,
    periodActive,
    payingNowRawPerSec,
    configuredRawPerSec: r.rewardRateRaw,
    runwaySecs,
    coreKnown,
  };
}

/** Whole-token formatter for raw base units; keeps small figures readable. */
export function fmtRaw(raw: bigint | null, decimals: number, maxFrac = 2): string {
  if (raw === null) return '—';
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fracRaw = abs % base;
  if (maxFrac === 0 || fracRaw === 0n) return `${neg ? '-' : ''}${whole.toLocaleString()}`;
  const fracStr = (fracRaw + base).toString().slice(1, 1 + maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString()}${fracStr ? `.${fracStr}` : ''}`;
}

/** "Nd Nh" runway text; never invents precision. */
export function fmtRunway(secs: bigint | null): string {
  if (secs === null) return '—';
  if (secs <= 0n) return 'ended';
  const days = secs / 86_400n;
  const hours = (secs % 86_400n) / 3_600n;
  if (days > 0n) return `${days}d ${hours}h`;
  const mins = (secs % 3_600n) / 60n;
  return `${hours}h ${mins}m`;
}
