import { useMemo } from 'react';
import { useAccount, useReadContracts, usePublicClient } from 'wagmi';
import { useState, useEffect } from 'react';
import { parseAbiItem } from 'viem';
import { useUserPosition } from './useUserPosition';
import { usePoints } from './usePoints';
import { COMMUNITY_GRANTS_ABI, MEME_BOUNTY_BOARD_ABI } from '../lib/contracts';
import {
  COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  isDeployed as checkDeployed,
} from '../lib/constants';

export interface TegridyScoreBreakdown {
  stakingScore: number;      // 25% weight — on-chain verified
  lockScore: number;         // 20% weight — on-chain verified
  activityScore: number;     // 15% weight — on-chain verified (swap count + staking)
  governanceScore: number;   // 15% weight — on-chain verified (CommunityGrants votes)
  communityScore: number;    // 15% weight — on-chain verified (bounties + referrals)
  loyaltyScore: number;      // 10% weight — on-chain verified (earliest Staked event)
}

export interface TegridyScoreResult {
  score: number;
  breakdown: TegridyScoreBreakdown;
  rank: string;
  percentile: string;
  tips: string[];
  selfReported: string[];
}

const WEIGHTS = {
  staking: 0.25,
  lock: 0.20,
  activity: 0.15,
  governance: 0.15,
  community: 0.15,
  loyalty: 0.10,
};

function calcStakingScore(stakedAmount: bigint, walletBalance: bigint): number {
  if (stakedAmount === 0n) return 0;
  const total = stakedAmount + walletBalance;
  if (total === 0n) return 50;
  // Safe: ratio is always <= 10000 because stakedAmount <= total
  const ratioBps = Number(stakedAmount * 10000n / total);
  if (!Number.isFinite(ratioBps) || ratioBps < 0) return 0;
  const ratio = Math.min(ratioBps, 10000) / 10000;
  if (ratio >= 0.8) return 100;
  if (ratio >= 0.5) return 80;
  return 50;
}

function calcLockScore(lockDuration: number): number {
  if (lockDuration <= 0) return 0;
  const days = lockDuration / 86400;
  const breakpoints = [
    { d: 7, s: 10 },
    { d: 30, s: 25 },
    { d: 90, s: 40 },
    { d: 180, s: 60 },
    { d: 365, s: 80 },
    { d: 1460, s: 100 },
  ];
  if (days <= breakpoints[0].d) {
    return Math.round((days / breakpoints[0].d) * breakpoints[0].s);
  }
  for (let i = 1; i < breakpoints.length; i++) {
    if (days <= breakpoints[i].d) {
      const prev = breakpoints[i - 1];
      const curr = breakpoints[i];
      const t = (days - prev.d) / (curr.d - prev.d);
      return Math.round(prev.s + t * (curr.s - prev.s));
    }
  }
  return 100;
}

function calcActivityScore(onChainPoints: number): number {
  if (onChainPoints <= 0) return 0;
  const breakpoints = [
    { p: 100, s: 25 },
    { p: 500, s: 50 },
    { p: 2000, s: 75 },
    { p: 5000, s: 100 },
  ];
  if (onChainPoints <= breakpoints[0].p) {
    return Math.round((onChainPoints / breakpoints[0].p) * breakpoints[0].s);
  }
  for (let i = 1; i < breakpoints.length; i++) {
    if (onChainPoints <= breakpoints[i].p) {
      const prev = breakpoints[i - 1];
      const curr = breakpoints[i];
      const t = (onChainPoints - prev.p) / (curr.p - prev.p);
      return Math.round(prev.s + t * (curr.s - prev.s));
    }
  }
  return 100;
}

function calcGovernanceScoreFromChain(votedProposalCount: number, proposedCount: number): number {
  if (proposedCount > 0 && votedProposalCount > 0) return 100;
  if (votedProposalCount >= 3) return 75;
  if (votedProposalCount >= 1) return 50;
  return 0;
}

function calcCommunityScoreFromChain(bountiesCreated: number, referralCount: number): number {
  const total = bountiesCreated * 25 + referralCount * 25;
  return Math.min(100, total);
}

function calcLoyaltyScoreFromTimestamp(firstInteractionTs: number): number {
  if (firstInteractionTs === 0) return 0;
  const nowSec = Date.now() / 1000;
  // Guard: timestamp in the future means bad data or clock skew
  if (firstInteractionTs > nowSec) return 0;
  const daysSince = Math.max(0, (nowSec - firstInteractionTs) / 86400);
  // Cap at 4 years to prevent absurd values from malformed timestamps
  const clampedDays = Math.min(daysSince, 1460);
  if (clampedDays >= 365) return 100;
  if (clampedDays >= 180) return 75;
  if (clampedDays >= 90) return 50;
  if (clampedDays >= 30) return 25;
  return Math.round((clampedDays / 30) * 25);
}

function getRank(score: number): string {
  if (score >= 90) return 'Tegridy Legend \u{1F451}';
  if (score >= 80) return 'Diamond Farmer \u{1F48E}';
  if (score >= 60) return 'Farmer \u{1F9D1}\u200D\u{1F33E}';
  if (score >= 40) return 'Grower \u{1F333}';
  if (score >= 20) return 'Sprout \u{1F33F}';
  return 'Seedling \u{1F331}';
}

function getPercentile(score: number): string {
  if (score >= 95) return 'Top 1%';
  if (score >= 90) return 'Top 3%';
  if (score >= 85) return 'Top 5%';
  if (score >= 80) return 'Top 8%';
  if (score >= 70) return 'Top 12%';
  if (score >= 60) return 'Top 20%';
  if (score >= 50) return 'Top 35%';
  if (score >= 40) return 'Top 50%';
  if (score >= 30) return 'Top 65%';
  if (score >= 20) return 'Top 80%';
  return 'Top 95%';
}

function getTips(breakdown: TegridyScoreBreakdown): string[] {
  const tipMap: { key: keyof TegridyScoreBreakdown; tip: string }[] = [
    { key: 'stakingScore', tip: 'Tip: Stake more TOWELI to boost your score' },
    { key: 'lockScore', tip: 'Tip: Lock for longer to increase your Tegridy Score' },
    { key: 'activityScore', tip: 'Tip: Visit daily and swap to build your streak' },
    { key: 'governanceScore', tip: 'Tip: Vote on grant proposals to improve your score' },
    { key: 'communityScore', tip: 'Tip: Post a bounty or refer friends' },
  ];

  const lowScoring = tipMap
    .filter(t => breakdown[t.key] < 50)
    .sort((a, b) => breakdown[a.key] - breakdown[b.key])
    .slice(0, 2)
    .map(t => t.tip);

  return lowScoring;
}

const STAKED_EVENT = parseAbiItem(
  'event Staked(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 lockDuration, uint256 boostBps)'
);

export function useTegridyScore(): TegridyScoreResult {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const pos = useUserPosition();
  const points = usePoints();

  const grantsDeployed = checkDeployed(COMMUNITY_GRANTS_ADDRESS);
  const bountyDeployed = checkDeployed(MEME_BOUNTY_BOARD_ADDRESS);

  const { data: grantsData } = useReadContracts({
    contracts: [
      { address: COMMUNITY_GRANTS_ADDRESS, abi: COMMUNITY_GRANTS_ABI, functionName: 'proposalCount' },
    ],
    query: { enabled: grantsDeployed && !!address, refetchInterval: 60_000 },
  });

  const proposalCount = grantsData?.[0]?.status === 'success' ? Number(grantsData[0].result as bigint) : 0;

  const [votedCount, setVotedCount] = useState(0);
  const [proposedCount, setProposedCount] = useState(0);

  useEffect(() => {
    if (!address || !grantsDeployed || proposalCount === 0 || !publicClient) {
      setVotedCount(0);
      setProposedCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      let voted = 0;
      let proposed = 0;
      const batchSize = 10;
      const count = Math.min(proposalCount, 50);
      for (let i = 0; i < count; i += batchSize) {
        const batch = Array.from({ length: Math.min(batchSize, count - i) }, (_, k) => i + k);
        const results = await Promise.all(
          batch.map(id =>
            publicClient.readContract({
              address: COMMUNITY_GRANTS_ADDRESS,
              abi: COMMUNITY_GRANTS_ABI,
              functionName: 'hasVotedOnProposal',
              args: [BigInt(id), address],
            }).catch(() => false)
          )
        );
        const proposals = await Promise.all(
          batch.map(id =>
            publicClient.readContract({
              address: COMMUNITY_GRANTS_ADDRESS,
              abi: COMMUNITY_GRANTS_ABI,
              functionName: 'getProposal',
              args: [BigInt(id)],
            }).catch(() => null)
          )
        );
        if (cancelled) return;
        for (const r of results) if (r) voted++;
        for (const p of proposals) {
          if (p && (p as any)[0]?.toLowerCase() === address.toLowerCase()) proposed++;
        }
      }
      if (!cancelled) {
        setVotedCount(voted);
        setProposedCount(proposed);
      }
    })();
    return () => { cancelled = true; };
  }, [address, grantsDeployed, proposalCount, publicClient]);

  const { data: bountyData } = useReadContracts({
    contracts: [
      { address: MEME_BOUNTY_BOARD_ADDRESS, abi: MEME_BOUNTY_BOARD_ABI, functionName: 'bountyCount' },
    ],
    query: { enabled: bountyDeployed && !!address, refetchInterval: 60_000 },
  });

  const bountyCount = bountyData?.[0]?.status === 'success' ? Number(bountyData[0].result as bigint) : 0;

  const [bountiesCreated, setBountiesCreated] = useState(0);

  useEffect(() => {
    if (!address || !bountyDeployed || bountyCount === 0 || !publicClient) {
      setBountiesCreated(0);
      return;
    }
    let cancelled = false;
    (async () => {
      let created = 0;
      const count = Math.min(bountyCount, 50);
      for (let i = 0; i < count; i += 10) {
        const batch = Array.from({ length: Math.min(10, count - i) }, (_, k) => i + k);
        const results = await Promise.all(
          batch.map(id =>
            publicClient.readContract({
              address: MEME_BOUNTY_BOARD_ADDRESS,
              abi: MEME_BOUNTY_BOARD_ABI,
              functionName: 'getBounty',
              args: [BigInt(id)],
            }).catch(() => null)
          )
        );
        if (cancelled) return;
        for (const r of results) {
          if (r && (r as any)[0]?.toLowerCase() === address.toLowerCase()) created++;
        }
      }
      if (!cancelled) setBountiesCreated(created);
    })();
    return () => { cancelled = true; };
  }, [address, bountyDeployed, bountyCount, publicClient]);

  const onChainReferralCount = points.onChainMetrics?.referralCount ?? 0;

  const [firstInteractionTs, setFirstInteractionTs] = useState(0);

  useEffect(() => {
    if (!address || !publicClient || !checkDeployed(TEGRIDY_STAKING_ADDRESS)) {
      setFirstInteractionTs(0);
      return;
    }
    let cancelled = false;
    publicClient.getLogs({
      address: TEGRIDY_STAKING_ADDRESS,
      event: STAKED_EVENT,
      args: { user: address },
      fromBlock: 'earliest',
      toBlock: 'latest',
    }).then(async (logs) => {
      if (cancelled) return;
      if (logs.length > 0) {
        const block = await publicClient.getBlock({ blockNumber: logs[0].blockNumber });
        if (!cancelled) setFirstInteractionTs(Number(block.timestamp));
      }
    }).catch(() => {
      if (!cancelled) setFirstInteractionTs(0);
    });
    return () => { cancelled = true; };
  }, [address, publicClient]);

  return useMemo(() => {
    const stakingScore = address ? calcStakingScore(pos.stakedAmount, pos.walletBalance) : 0;
    const lockScore = calcLockScore(pos.lockDuration);
    const activityScore = calcActivityScore(points.data?.onChainPoints ?? 0);
    const governanceScore = calcGovernanceScoreFromChain(votedCount, proposedCount);
    const communityScore = calcCommunityScoreFromChain(bountiesCreated, onChainReferralCount);
    const loyaltyScore = calcLoyaltyScoreFromTimestamp(firstInteractionTs);

    const breakdown: TegridyScoreBreakdown = {
      stakingScore,
      lockScore,
      activityScore,
      governanceScore,
      communityScore,
      loyaltyScore,
    };

    const score = Math.round(
      stakingScore * WEIGHTS.staking +
      lockScore * WEIGHTS.lock +
      activityScore * WEIGHTS.activity +
      governanceScore * WEIGHTS.governance +
      communityScore * WEIGHTS.community +
      loyaltyScore * WEIGHTS.loyalty
    );

    const selfReported: string[] = [];

    return {
      score,
      breakdown,
      rank: getRank(score),
      percentile: getPercentile(score),
      tips: getTips(breakdown),
      selfReported,
    };
  }, [
    address, pos.stakedAmount, pos.walletBalance, pos.lockDuration,
    points.data?.onChainPoints, votedCount, proposedCount,
    bountiesCreated, onChainReferralCount, firstInteractionTs,
  ]);
}
