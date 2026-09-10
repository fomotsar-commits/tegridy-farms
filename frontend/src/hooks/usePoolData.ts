import { useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';

export function usePoolData() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;

  // R043 H-062-02: chainId pin on every entry, gate on onMainnet — a wrong-chain
  // wallet must not read another chain's storage and render fabricated figures.
  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalBoostedStake', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalPenaltiesCollected', chainId: CHAIN_ID },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalUnsettledRewards', chainId: CHAIN_ID },
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr], chainId: CHAIN_ID },
    ],
    query: { enabled: isDeployed && onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
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

  const totalStakedUnread = !readOk(0);
  const boostedStakeUnread = !readOk(1);
  const rewardRateUnread = !readOk(2);
  const rewardsFundedUnread = !readOk(3);
  const penaltiesUnread = !readOk(4);
  const unsettledUnread = !readOk(5);
  const stakingBalanceUnread = !readOk(6);

  // HONESTY PASS 2026-06-11: totalRewardsFunded is CUMULATIVE (never
  // decreases), so it must not be displayed as "rewards remaining".
  // TegridyStaking is NOT Synthetix-style — there is no periodFinish on the
  // contract; emission runs continuously at rewardRate against whatever is
  // actually funded. The true remaining pool is the StakingRewardLib formula:
  //   balanceOf(staking) − totalStaked − totalUnsettledRewards
  // and the runway is that pool divided by rewardRate.
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
  const secondsRemaining =
    !rewardsRemainingUnread && !rewardRateUnread && rewardRate > 0n ? rewardsRemaining / rewardRate : 0n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const periodFinish = secondsRemaining > 0n ? nowSec + secondsRemaining : 0n;

  // An APR of '0' had two causes that printed identically: a pool paying
  // nothing, and a pool nobody could read. Both legs of the ratio are needed.
  const aprUnread = rewardRateUnread || boostedStakeUnread;

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
  if (rewardRate > 0n && totalBoostedStake > 0n && !isDry) {
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
    /** Unix seconds when the reward pool runs dry at the current rate (derived; 0 if unread). */
    periodFinish: Number(periodFinish),
    /** Seconds of emission runway left at the current rate (0 once dry/unread). */
    secondsRemaining: Number(secondsRemaining),
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
