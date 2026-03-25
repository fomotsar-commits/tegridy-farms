import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useUserPosition } from './useUserPosition';
import { usePoints } from './usePoints';


export interface TegridyScoreBreakdown {
  stakingScore: number;      // 25% weight
  lockScore: number;         // 20% weight
  activityScore: number;     // 15% weight
  governanceScore: number;   // 15% weight
  communityScore: number;    // 15% weight
  loyaltyScore: number;      // 10% weight
}

export interface TegridyScoreResult {
  score: number;
  breakdown: TegridyScoreBreakdown;
  rank: string;
  percentile: string;
  tips: string[];
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
  const ratio = Number(stakedAmount * 10000n / total) / 10000;
  if (ratio >= 0.8) return 100;
  if (ratio >= 0.5) return 80;
  return 50;
}

function calcLockScore(lockDuration: number): number {
  if (lockDuration <= 0) return 0;
  const days = lockDuration / 86400;
  // Piecewise linear interpolation
  const breakpoints = [
    { d: 7, s: 10 },
    { d: 30, s: 25 },
    { d: 90, s: 40 },
    { d: 180, s: 60 },
    { d: 365, s: 80 },
    { d: 1460, s: 100 }, // 4 years
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

function calcActivityScore(points: number): number {
  if (points <= 0) return 0;
  const breakpoints = [
    { p: 100, s: 25 },
    { p: 500, s: 50 },
    { p: 2000, s: 75 },
    { p: 5000, s: 100 },
  ];
  if (points <= breakpoints[0].p) {
    return Math.round((points / breakpoints[0].p) * breakpoints[0].s);
  }
  for (let i = 1; i < breakpoints.length; i++) {
    if (points <= breakpoints[i].p) {
      const prev = breakpoints[i - 1];
      const curr = breakpoints[i];
      const t = (points - prev.p) / (curr.p - prev.p);
      return Math.round(prev.s + t * (curr.s - prev.s));
    }
  }
  return 100;
}

function calcGovernanceScore(): number {
  // Mock: check localStorage for governance participation
  try {
    const voted = localStorage.getItem('tegridy_voted');
    const votedEpoch = localStorage.getItem('tegridy_voted_epoch');
    const proposalSubmitted = localStorage.getItem('tegridy_proposal_submitted');
    const currentEpoch = Math.floor(Date.now() / (7 * 86400 * 1000)).toString();

    if (proposalSubmitted && voted) return 100;
    if (votedEpoch === currentEpoch) return 75;
    if (voted) return 50;
  } catch { /* noop */ }
  return 0;
}

function calcCommunityScore(): number {
  try {
    const bountiesPosted = parseInt(localStorage.getItem('tegridy_bounties_posted') || '0', 10);
    const bountiesCompleted = parseInt(localStorage.getItem('tegridy_bounties_completed') || '0', 10);
    const referrals = parseInt(localStorage.getItem('tegridy_referral_count') || '0', 10);
    const total = (bountiesPosted + bountiesCompleted) * 25 + referrals * 25;
    return Math.min(100, total);
  } catch { /* noop */ }
  return 0;
}

function calcLoyaltyScore(): number {
  try {
    const firstVisit = localStorage.getItem('tegridy_first_visit');
    if (!firstVisit) return 0;
    const daysSince = (Date.now() - parseInt(firstVisit, 10)) / (86400 * 1000);
    if (daysSince >= 365) return 100;
    if (daysSince >= 180) return 75;
    if (daysSince >= 90) return 50;
    if (daysSince >= 30) return 25;
    return Math.round((daysSince / 30) * 25);
  } catch { /* noop */ }
  return 0;
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
  // Mock percentile based on score curve
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
    { key: 'governanceScore', tip: 'Tip: Vote on gauge weights to improve your score' },
    { key: 'communityScore', tip: 'Tip: Post a bounty or refer friends' },
  ];

  const lowScoring = tipMap
    .filter(t => breakdown[t.key] < 50)
    .sort((a, b) => breakdown[a.key] - breakdown[b.key])
    .slice(0, 2)
    .map(t => t.tip);

  return lowScoring;
}

export function useTegridyScore(): TegridyScoreResult {
  const { address } = useAccount();
  const pos = useUserPosition();
  const points = usePoints();

  return useMemo(() => {
    const stakingScore = address ? calcStakingScore(pos.stakedAmount, pos.walletBalance) : 0;
    const lockScore = calcLockScore(pos.lockDuration);
    const activityScore = calcActivityScore(points.data?.points ?? 0);
    const governanceScore = calcGovernanceScore();
    const communityScore = calcCommunityScore();
    const loyaltyScore = calcLoyaltyScore();

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

    return {
      score,
      breakdown,
      rank: getRank(score),
      percentile: getPercentile(score),
      tips: getTips(breakdown),
    };
  }, [address, pos.stakedAmount, pos.walletBalance, pos.lockDuration, points.data?.points]);
}
