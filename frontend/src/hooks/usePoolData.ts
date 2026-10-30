import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';

export function usePoolData() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);

  // R043 H-062-02: chainId pin on every entry — a wrong-chain wallet must not
  // read another chain's storage and render fabricated figures. The pin is the
  // whole fix. NOT gated on useChainId() === CHAIN_ID: since the multichain
  // config that gate disabled these reads off mainnet and handed FarmStatsRow a
  // "0%" APR (see useLPFarming.ts).
  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalBoostedStake', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalPenaltiesCollected', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalUnsettledRewards', chainId: CHAIN_ID },
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr], chainId: CHAIN_ID },
      // Staking release 1 (this address) pays its pot out over a four-year schedule that ends
      // at periodFinish; nothing accrues after it, whatever rewardRate still reads.
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'periodFinish', chainId: CHAIN_ID },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  // OUTAGE-AS-ZERO (scripts/check-unread-signal.mjs): the 0n collapse below is
  // the house display default and stays. What was missing is the second,
  // separately-named value telling a caller the collapse HAPPENED, so a claim
  // or a control can gate on that instead of on the zero.
  const readOk = (i: number): boolean => data?.[i]?.status === 'success';
  const readAt = (i: number): bigint => {
    const entry = data?.[i];
    return entry?.status === 'success' ? (entry.result as bigint) : 0n;
  };

  const totalStaked = readAt(0);
  const totalBoostedStake = readAt(1);
  const rewardRate = readAt(2);
  const totalRewardsFunded = readAt(3);
  const totalPenalties = readAt(4);
  const totalUnsettled = readAt(5);
  const stakingBalance = readAt(6);
  const scheduleEnd = readAt(7);

  const totalStakedUnread = !readOk(0);
  const boostedStakeUnread = !readOk(1);
  const rewardRateUnread = !readOk(2);
  const rewardsFundedUnread = !readOk(3);
  const penaltiesUnread = !readOk(4);
  const unsettledUnread = !readOk(5);
  const stakingBalanceUnread = !readOk(6);
  const scheduleUnread = !readOk(7);

  // HONESTY PASS 2026-06-11: totalRewardsFunded is CUMULATIVE (never
  // decreases), so it must not be displayed as "rewards remaining".
  // The TOWELI left in the contract beyond stakes is the StakingRewardLib formula:
  //   balanceOf(staking) − totalStaked − totalUnsettledRewards
  // (it still includes rewards earned and not yet claimed).
  // 2026-10-18: staking release 1 IS Synthetix-style. Each funding spreads the pot over
  // four years and periodFinish is read from the contract: that, not pot ÷ rate, is when
  // payouts end.
  //
  // T18 2026-09-10: that formula is a DIFFERENCE, so a failed read does not
  // make the answer smaller or vaguer — it makes it BIGGER and entirely
  // plausible. With totalStaked unread and collapsed to 0n, every staked token
  // in the contract was counted as spendable reward reserve and divided by the
  // rate into a concrete dry-date. Measured pre-fix: balance 1,000,000 TOWELI
  // with totalStaked failing reported rewardsRemaining "1000000", a 1,000,000s
  // runway, and a real future periodFinish. So the formula does not run at all
  // unless all three legs landed, and says which case it is.
  const rewardsRemainingUnread = stakingBalanceUnread || totalStakedUnread || unsettledUnread;
  const rawRemaining = stakingBalance - totalStaked - totalUnsettled;
  const rewardsRemaining = !rewardsRemainingUnread && rawRemaining > 0n ? rawRemaining : 0n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const periodFinish = !scheduleUnread ? scheduleEnd : 0n;
  const secondsRemaining = periodFinish > nowSec ? periodFinish - nowSec : 0n;
  // Read and over (or never funded: periodFinish 0): the contract pays nothing more.
  const scheduleEnded = !scheduleUnread && periodFinish <= nowSec;

  // An APR of '0' had two causes that printed identically: a pool paying
  // nothing, and a pool nobody could read. Every leg of the ratio is needed,
  // and the schedule's end too: a rate past it is not paying.
  const aprUnread = rewardRateUnread || boostedStakeUnread || scheduleUnread;

  // STAKING_LOOK §2.2: once the reserve is EMPTY, on-chain accrual is clamped
  // to zero (StakingRewardLib caps every tick to the pool), so a nominal
  // rate-derived APR is a lie the moment isDry flips. Clamp at the SOURCE so
  // every consumer (farm strip, stat tiles, home pill, projections) inherits
  // the honest zero with no per-surface edits.
  //
  // T18: the old test for "did the reads land?" was `stakingBalance > 0n` — a
  // value proxy, not a read status. A truthfully-empty reserve fails it, so the
  // dry clamp never armed on the single day it exists for: measured pre-fix, a
  // read-and-empty pool still rendered a live 100% APR. It now keys on read
  // status, which an empty reserve passes and an outage does not.
  const isDry = !rewardsRemainingUnread && rewardsRemaining === 0n;

  let apr = '0';
  // Numeric APR % for any math. Consumers MUST use this, not parseFloat(apr): once
  // apr >= 10000 the display string is comma-formatted ("28,567") and parseFloat
  // would silently truncate it to 28, breaking every projection ~1000x low.
  let aprNum = 0;
  const aprCapped = false;
  if (rewardRate > 0n && totalBoostedStake > 0n && !isDry && !scheduleUnread && !scheduleEnded) {
    // Scale up before dividing to preserve precision for low APRs
    const aprScaled = rewardRate * 31536000n * 10000n * 10n ** 18n;
    const aprBps = aprScaled / totalBoostedStake;
    const aprPct = Number(aprBps) / 1e18 / 100; // REAL APR in %
    aprNum = aprPct;
    // Operator decision (2026-06-07): show the REAL APR — no ">9,999%" ceiling.
    // At bootstrap TVL this is very large and falls toward the steady-state as
    // stake grows. >=10,000% rendered as comma integers; smaller keeps 2 decimals.
    apr = aprPct >= 10000 ? Math.round(aprPct).toLocaleString() : aprPct.toFixed(2);
  }

  return {
    totalStaked: formatEther(totalStaked),
    totalStakedRaw: totalStaked,
    totalBoostedStake: formatEther(totalBoostedStake),
    rewardRate: formatEther(rewardRate),
    totalRewardsFunded: formatEther(totalRewardsFunded),
    totalPenalties: formatEther(totalPenalties),
    /** Unix seconds when the four-year reward schedule ends, read from the contract (0 if unread or never funded). */
    periodFinish: Number(periodFinish),
    /** Seconds until the schedule ends (0 once it has, or if unread). */
    secondsRemaining: Number(secondsRemaining),
    /** True once periodFinish was read and has passed (or the pool was never funded): nothing more is paid. */
    scheduleEnded,
    /** periodFinish did not land: neither "running" nor "ended" is known. */
    scheduleUnread,
    /** TOWELI actually left in the reward pool — the honest "remaining" figure. */
    rewardsRemaining: formatEther(rewardsRemaining),
    /** True once reads landed and the reward pool is EMPTY — emissions are 0, whatever the rate says. */
    isDry,
    apr,
    aprNum,
    aprCapped,

    // ── Unread signals ──────────────────────────────────────────────────────
    // Every zero above is a DISPLAY default. Gate any claim, control or
    // arithmetic on these instead, so an outage never renders as a real figure.
    /** totalStaked/totalStakedRaw did not land — the '0' TVL is not a measured zero. */
    totalStakedUnread,
    /** totalBoostedStake did not land. */
    boostedStakeUnread,
    /** rewardRate did not land — the '0' emission rate is not a measured zero. */
    rewardRateUnread,
    /** totalRewardsFunded did not land. */
    rewardsFundedUnread,
    /** totalPenaltiesCollected did not land. */
    penaltiesUnread,
    /** At least one leg of balance − staked − unsettled did not land, so
     *  rewardsRemaining/secondsRemaining/periodFinish are all a forced 0 and
     *  mean NOTHING. Distinct from isDry, which means read-and-empty. */
    rewardsRemainingUnread,
    /** rewardRate or totalBoostedStake did not land, so apr/aprNum of 0 is
     *  "unknown", not "this pool pays nothing". */
    aprUnread,
    /** Display alongside APR values */
    aprDisclaimer: 'Bootstrap rate — falls as staking grows',
    isDeployed,
    isLoading,
  };
}
