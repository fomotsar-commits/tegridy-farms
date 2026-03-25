// Points engine — localStorage-based tracking per wallet address
// Season-based system with streak multipliers

export interface PointsData {
  points: number;
  actions: { type: string; pts: number; ts: number }[];
  streak: { current: number; lastVisit: string; longest: number };
  season: number;
  seasonStart: number;
  referrer?: string;
  referralCount: number;
}

const POINTS_MAP: Record<string, number> = {
  swap: 10,
  stake: 25,
  unstake: 25,
  claim: 15,
  lp_provide: 50,
  daily_visit: 5,
  referral_swap: 5,
};

export const STREAK_MULTIPLIERS: Record<number, number> = {
  7: 1.5,
  14: 2,
  30: 3,
};

export const TIER_THRESHOLDS = [
  { name: 'Bronze', min: 0, color: '#cd7f32' },
  { name: 'Silver', min: 500, color: '#c0c0c0' },
  { name: 'Gold', min: 2000, color: '#ffd700' },
  { name: 'Diamond', min: 5000, color: '#b9f2ff' },
];

function getStorageKey(address: string) {
  return `tegridy_points_${address.toLowerCase()}`;
}

export function getPointsData(address: string): PointsData {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    points: 0,
    actions: [],
    streak: { current: 0, lastVisit: '', longest: 0 },
    season: 1,
    seasonStart: Date.now(),
    referralCount: 0,
  };
}

function savePointsData(address: string, data: PointsData) {
  try {
    localStorage.setItem(getStorageKey(address), JSON.stringify(data));
  } catch {}
}

export function getStreakMultiplier(streak: number): number {
  if (streak >= 30) return 3;
  if (streak >= 14) return 2;
  if (streak >= 7) return 1.5;
  return 1;
}

export function getTier(points: number) {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= TIER_THRESHOLDS[i].min) return TIER_THRESHOLDS[i];
  }
  return TIER_THRESHOLDS[0];
}

export function getNextTier(points: number) {
  for (const tier of TIER_THRESHOLDS) {
    if (points < tier.min) return tier;
  }
  return null; // already at max
}

export function recordAction(address: string, actionType: string, goldCardBoost: boolean = false): PointsData {
  const data = getPointsData(address);
  const basePoints = POINTS_MAP[actionType] ?? 0;
  if (basePoints === 0) return data;

  const streakMult = getStreakMultiplier(data.streak.current);
  const goldMult = goldCardBoost ? 2 : 1;
  const totalPts = Math.round(basePoints * streakMult * goldMult);

  data.points += totalPts;
  data.actions.push({ type: actionType, pts: totalPts, ts: Date.now() });
  // Keep last 100 actions only
  if (data.actions.length > 100) data.actions = data.actions.slice(-100);

  savePointsData(address, data);
  return data;
}

export function recordDailyVisit(address: string): PointsData {
  const data = getPointsData(address);
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

  if (data.streak.lastVisit === today) return data; // Already visited today

  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');

  if (data.streak.lastVisit === yesterday) {
    // Continue streak
    data.streak.current += 1;
  } else if (data.streak.lastVisit && data.streak.lastVisit !== today) {
    // Broken streak
    data.streak.current = 1;
  } else {
    // First visit ever
    data.streak.current = 1;
  }

  data.streak.lastVisit = today;
  if (data.streak.current > data.streak.longest) {
    data.streak.longest = data.streak.current;
  }

  // Award daily visit points
  const basePoints = POINTS_MAP.daily_visit;
  const streakMult = getStreakMultiplier(data.streak.current);
  const totalPts = Math.round(basePoints * streakMult);
  data.points += totalPts;
  data.actions.push({ type: 'daily_visit', pts: totalPts, ts: Date.now() });

  savePointsData(address, data);
  return data;
}

export function setReferrer(address: string, referrer: string) {
  if (address.toLowerCase() === referrer.toLowerCase()) return;
  const data = getPointsData(address);
  if (!data.referrer) {
    data.referrer = referrer;
    savePointsData(address, data);
  }
}

export function incrementReferralCount(referrerAddress: string) {
  const data = getPointsData(referrerAddress);
  data.referralCount += 1;
  data.points += POINTS_MAP.referral_swap;
  data.actions.push({ type: 'referral_swap', pts: POINTS_MAP.referral_swap, ts: Date.now() });
  savePointsData(referrerAddress, data);
}

// Badge definitions
export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  check: (data: PointsData, extra?: { stakedAmount?: number; swapCount?: number }) => boolean;
}

export const BADGES: Badge[] = [
  { id: 'first_swap', name: 'First Swap', description: 'Completed your first swap', icon: '🔄',
    check: (d) => d.actions.some(a => a.type === 'swap') },
  { id: 'farmer', name: 'Farmer', description: 'Staked tokens in a pool', icon: '🌱',
    check: (d) => d.actions.some(a => a.type === 'stake') },
  { id: 'streak_7', name: 'Week Warrior', description: '7-day activity streak', icon: '🔥',
    check: (d) => d.streak.longest >= 7 },
  { id: 'streak_30', name: 'Streak Master', description: '30-day activity streak', icon: '💎',
    check: (d) => d.streak.longest >= 30 },
  { id: 'silver', name: 'Silver Tier', description: 'Reached 500 points', icon: '🥈',
    check: (d) => d.points >= 500 },
  { id: 'gold', name: 'Gold Tier', description: 'Reached 2,000 points', icon: '🥇',
    check: (d) => d.points >= 2000 },
  { id: 'diamond', name: 'Diamond Hands', description: 'Reached 5,000 points', icon: '💠',
    check: (d) => d.points >= 5000 },
  { id: 'degen', name: 'Degen', description: 'Made 10+ swaps', icon: '🎰',
    check: (d) => d.actions.filter(a => a.type === 'swap').length >= 10 },
  { id: 'referrer', name: 'Connector', description: 'Referred 3+ users', icon: '🤝',
    check: (d) => d.referralCount >= 3 },
];

export function getEarnedBadges(data: PointsData): Badge[] {
  return BADGES.filter(b => b.check(data));
}
