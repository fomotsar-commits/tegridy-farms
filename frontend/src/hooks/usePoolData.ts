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

  // Safely extract results — if contract call fails, use 0n
  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalBoostedStake = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const rewardRate = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);
  const totalRewardsFunded = (data?.[3]?.status === 'success' ? data[3].result as bigint : 0n);
  const totalPenalties = (data?.[4]?.status === 'success' ? data[4].result as bigint : 0n);
  const totalUnsettled = (data?.[5]?.status === 'success' ? data[5].result as bigint : 0n);
  const stakingBalance = (data?.[6]?.status === 'success' ? data[6].result as bigint : 0n);

  // HONESTY PASS 2026-06-11: totalRewardsFunded is CUMULATIVE (never
  // decreases), so it must not be displayed as "rewards remaining".
  // TegridyStaking is NOT Synthetix-style — there is no periodFinish on the
  // contract; emission runs continuously at rewardRate against whatever is
  // actually funded. The true remaining pool is the StakingRewardLib formula:
  //   balanceOf(staking) − totalStaked − totalUnsettledRewards
  // and the runway is that pool divided by rewardRate.
  // `haveReads` TESTED A VALUE, NOT A READ, and its name said otherwise.
  //
  // It was `stakingBalance > 0n` — entry [6] alone, and only that it came back
  // NON-ZERO. The very next line subtracts entries [0] and [5], which it never
  // looked at. So on the partial failure where balanceOf lands and totalStaked
  // does not, `haveReads` is true, totalStaked collapses to 0n, and
  // `rawRemaining` becomes the contract's ENTIRE token balance — every staker's
  // PRINCIPAL, advertised as reward reserve. With 6.0M staked over 400k of real
  // reserve, /tokenomics reports 6,400,000 TOWELI remaining and ~1,041 days of
  // runway against a true ~65.
  //
  // That number passes every hedge downstream, which is why nothing caught it:
  // TokenomicsPage:231 and :240 correctly print '–' for an UNREAD zero, but a
  // large plausible WRONG figure sails through `rewardsRemaining > 0`. The
  // guards were built for a total outage; this is a partial one.
  const batchRan = isDeployed && onMainnet && !isLoading;
  const entryUnread = (i: number) => batchRan && data?.[i]?.status !== 'success';

  /** The reserve arithmetic subtracts three separate reads. Any one missing
   *  makes the difference meaningless, not merely imprecise. */
  const reserveUnread = entryUnread(0) || entryUnread(5) || entryUnread(6);

  /** APR is rewardRate over totalBoostedStake — entries [2] and [1]. Separate
   *  from the reserve because they fail independently and gate different
   *  surfaces; a dark APR must not blank a runway that was read fine. */
  const aprUnread = entryUnread(1) || entryUnread(2);

  const rawRemaining = stakingBalance - totalStaked - totalUnsettled;
  const rewardsRemaining = !reserveUnread && stakingBalance > 0n && rawRemaining > 0n ? rawRemaining : 0n;
  const secondsRemaining = rewardRate > 0n ? rewardsRemaining / rewardRate : 0n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const periodFinish = secondsRemaining > 0n ? nowSec + secondsRemaining : 0n;

  // STAKING_LOOK §2.2: once the reserve is EMPTY, on-chain accrual is clamped
  // to zero (StakingRewardLib caps every tick to the pool), so a nominal
  // rate-derived APR is a lie the moment isDry flips. Clamp at the SOURCE so
  // every consumer (farm strip, stat tiles, home pill, projections) inherits
  // the honest zero with no per-surface edits.
  // "Genuinely empty", which is a CLAIM, so it needs the reads to have landed —
  // not merely a non-zero balance. It clamps APR to 0 and prints "reserve empty"
  // copy across four surfaces; asserting that on an unread reserve would tell a
  // staker emissions had stopped when they had not.
  const isDry = !reserveUnread && stakingBalance > 0n && rewardsRemaining === 0n;

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
    /** The reserve arithmetic (balance − staked − unsettled) could not be completed.
     *  Gate every remaining/runway/"period ended" CLAIM on this: an unread reserve
     *  is not an exhausted one, and a partial read makes a plausible wrong number. */
    reserveUnread,
    /** rewardRate or totalBoostedStake did not land, so `apr`/`aprNum` are not a rate. */
    aprUnread,
    apr,
    aprNum,
    aprCapped,
    /** Display alongside APR values */
    aprDisclaimer: 'Bootstrap rate — falls as staking grows',
    isDeployed,
    isLoading,
  };
}
