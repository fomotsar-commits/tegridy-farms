// Points engine — on-chain activity as source of truth, localStorage as verified cache
//
// SECURITY NOTE: All client-side integrity checks are defense-in-depth only.
// On-chain points are authoritative and re-derived from contract reads every
// session. The localStorage cache only stores streak/daily-visit bonus data
// between sessions. Any future airdrop or reward distribution MUST use on-chain
// data exclusively, never trust client-reported points.

import { safeSetItem, safeGetItem } from './storage';

export interface OnChainMetrics {
  swapCount: number;
  stakedAmount: bigint;
  stakeDurationSec: number;
  lpBalance: bigint;
  referralCount: number;
}

export interface PointsData {
  points: number;
  onChainPoints: number;
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

/** Maximum allowed value for any single points field to prevent overflow. */
const MAX_POINTS = 1_000_000;

/** Maximum allowed streak length (days). Prevents clock-manipulation abuse. */
const MAX_STREAK = 365;

/** Maximum daily visit actions retained in history. */
const MAX_ACTIONS = 100;

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

// --- Integrity check using Web Crypto with per-session nonce ---
// The session nonce makes it harder to pre-compute hashes outside the browser,
// though a determined attacker with DevTools access can still bypass this.
// This is defense-in-depth; on-chain reconciliation is the real safeguard.

let sessionNonce: string | null = null;

function getSessionNonce(): string {
  if (!sessionNonce) {
    // Generate a random nonce per page session (not persisted to localStorage)
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    sessionNonce = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }
  return sessionNonce;
}

// @ts-ignore reserved for future async hash path
async function _computeHashAsync(data: string): Promise<string> { // eslint-disable-line @typescript-eslint/no-unused-vars
  const encoder = new TextEncoder();
  const combined = encoder.encode(getSessionNonce() + data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Synchronous fallback for reads (uses cached hash from the write path)
function computeHashSync(data: string): string {
  // djb2 with session nonce — only used for same-session verification
  let hash = 5381;
  const combined = getSessionNonce() + data;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) | 0;
  }
  return 's1_' + (hash >>> 0).toString(36);
}

function getStorageKey(address: string) {
  return `tegridy_points_${address.toLowerCase()}`;
}

function getIntegrityKey(address: string) {
  return `tegridy_points_hash_${address.toLowerCase()}`;
}

function verifyCacheIntegrity(address: string, raw: string): boolean {
  try {
    const storedHash = safeGetItem(getIntegrityKey(address));
    if (!storedHash) return false;
    return storedHash === computeHashSync(raw);
  } catch {
    return false;
  }
}

/** Clamp a number to a safe range to prevent overflow / abuse. */
function clampPoints(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_POINTS, Math.round(value)));
}

/** Safely convert bigint to number with a ceiling cap. */
function safeBigintToNumber(value: bigint, max: number = Number.MAX_SAFE_INTEGER): number {
  if (value <= 0n) return 0;
  if (value > BigInt(max)) return max;
  return Number(value);
}

/** Validate parsed PointsData from cache to prevent corrupted data injection. */
function validatePointsData(data: unknown): data is PointsData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.points !== 'number' || !Number.isFinite(d.points)) return false;
  if (typeof d.onChainPoints !== 'number' || !Number.isFinite(d.onChainPoints)) return false;
  if (!Array.isArray(d.actions)) return false;
  if (typeof d.streak !== 'object' || d.streak === null) return false;
  const s = d.streak as Record<string, unknown>;
  if (typeof s.current !== 'number' || typeof s.lastVisit !== 'string') return false;
  if (typeof s.longest !== 'number') return false;
  // Sanity: streaks cannot exceed MAX_STREAK
  if (s.current > MAX_STREAK || s.longest > MAX_STREAK) return false;
  // Sanity: points must be non-negative and within cap
  if (d.points < 0 || d.points > MAX_POINTS) return false;
  if (d.onChainPoints < 0 || d.onChainPoints > MAX_POINTS) return false;
  return true;
}

const FRESH_DATA = (): PointsData => ({
  points: 0,
  onChainPoints: 0,
  actions: [],
  streak: { current: 0, lastVisit: '', longest: 0 },
  season: 1,
  seasonStart: Date.now(),
  referralCount: 0,
});

export function getPointsData(address: string): PointsData {
  try {
    const raw = safeGetItem(getStorageKey(address));
    if (raw && verifyCacheIntegrity(address, raw)) {
      const parsed = JSON.parse(raw);
      if (validatePointsData(parsed)) return parsed;
    }
  } catch { /* cache miss — return fresh data */ }
  return FRESH_DATA();
}

function savePointsData(address: string, data: PointsData) {
  try {
    const raw = JSON.stringify(data);
    safeSetItem(getStorageKey(address), raw);
    safeSetItem(getIntegrityKey(address), computeHashSync(raw));
  } catch { /* storage full or unavailable */ }
}

export function computeOnChainPoints(metrics: OnChainMetrics): number {
  let pts = 0;
  // Clamp swap count to prevent overflow from unexpectedly large values
  const safeSwapCount = Math.min(metrics.swapCount, 100_000);
  pts += safeSwapCount * POINTS_MAP.swap;
  if (metrics.stakedAmount > 0n) {
    pts += POINTS_MAP.stake;
    const stakeDays = Math.min(Math.floor(metrics.stakeDurationSec / 86400), 1460);
    pts += stakeDays * 2;
  }
  if (metrics.lpBalance > 0n) {
    pts += POINTS_MAP.lp_provide;
    // Safe bigint-to-number conversion with ceiling cap
    const lpTokens = safeBigintToNumber(metrics.lpBalance / (10n ** 18n), 1_000_000);
    const lpScore = Math.min(200, lpTokens * 5);
    pts += Math.floor(lpScore);
  }
  const safeReferralCount = Math.min(metrics.referralCount, 10_000);
  pts += safeReferralCount * POINTS_MAP.referral_swap;
  return clampPoints(pts);
}

export function reconcilePoints(address: string, onChainPts: number): PointsData {
  const data = getPointsData(address);
  data.onChainPoints = clampPoints(onChainPts);
  const streakBonusActions = data.actions.filter(a => a.type === 'daily_visit');
  const streakBonus = streakBonusActions.reduce((sum, a) => sum + a.pts, 0);
  data.points = clampPoints(data.onChainPoints + streakBonus);
  savePointsData(address, data);
  return data;
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

export function recordAction(address: string, actionType: string, _goldCardBoost: boolean = false): PointsData {
  const data = getPointsData(address);
  const basePoints = POINTS_MAP[actionType] ?? 0;
  if (basePoints === 0) return data;

  data.actions.push({ type: actionType, pts: basePoints, ts: Date.now() });
  if (data.actions.length > 100) data.actions = data.actions.slice(-100);

  savePointsData(address, data);
  return data;
}

export function recordDailyVisit(address: string): PointsData {
  const data = getPointsData(address);
  // NOTE: Using client-side Date means a user can manipulate their system clock
  // to manufacture streaks. For any reward distribution, streaks should be
  // validated server-side or derived from on-chain block timestamps.
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

  if (data.streak.lastVisit === today) return data; // Already visited today

  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');

  // Sanity check: if lastVisit is in the future, reset streak (clock tampering)
  if (data.streak.lastVisit > today) {
    data.streak.current = 1;
  } else if (data.streak.lastVisit === yesterday) {
    // Continue streak
    data.streak.current += 1;
  } else if (data.streak.lastVisit && data.streak.lastVisit !== today) {
    // Broken streak
    data.streak.current = 1;
  } else {
    // First visit ever
    data.streak.current = 1;
  }

  // Clamp streak to prevent abuse
  data.streak.current = Math.min(data.streak.current, MAX_STREAK);
  data.streak.lastVisit = today;
  if (data.streak.current > data.streak.longest) {
    data.streak.longest = Math.min(data.streak.current, MAX_STREAK);
  }

  const basePoints = POINTS_MAP.daily_visit;
  const streakMult = getStreakMultiplier(data.streak.current);
  const totalPts = Math.round(basePoints * streakMult);
  data.actions.push({ type: 'daily_visit', pts: totalPts, ts: Date.now() });
  if (data.actions.length > MAX_ACTIONS) data.actions = data.actions.slice(-MAX_ACTIONS);

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
  data.referralCount = Math.min(data.referralCount + 1, 10_000);
  data.points = clampPoints(data.points + POINTS_MAP.referral_swap);
  data.actions.push({ type: 'referral_swap', pts: POINTS_MAP.referral_swap, ts: Date.now() });
  if (data.actions.length > MAX_ACTIONS) data.actions = data.actions.slice(-MAX_ACTIONS);
  savePointsData(referrerAddress, data);
}

// Badge definitions
export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  check: (data: PointsData, metrics?: OnChainMetrics) => boolean;
}

export const BADGES: Badge[] = [
  { id: 'first_swap', name: 'First Swap', description: 'Completed your first swap', icon: '\u{1F504}',
    check: (_d, m) => (m?.swapCount ?? 0) >= 1 },
  { id: 'farmer', name: 'Farmer', description: 'Staked tokens in a pool', icon: '\u{1F331}',
    check: (_d, m) => (m?.stakedAmount ?? 0n) > 0n },
  { id: 'streak_7', name: 'Week Warrior', description: '7-day activity streak', icon: '\u{1F525}',
    check: (d) => d.streak.longest >= 7 },
  { id: 'streak_30', name: 'Streak Master', description: '30-day activity streak', icon: '\u{1F48E}',
    check: (d) => d.streak.longest >= 30 },
  { id: 'silver', name: 'Silver Tier', description: 'Reached 500 points', icon: '\u{1F948}',
    check: (d) => d.points >= 500 },
  { id: 'gold', name: 'Gold Tier', description: 'Reached 2,000 points', icon: '\u{1F947}',
    check: (d) => d.points >= 2000 },
  { id: 'diamond', name: 'Diamond Hands', description: 'Reached 5,000 points', icon: '\u{1FAA8}',
    check: (d) => d.points >= 5000 },
  { id: 'degen', name: 'Degen', description: 'Made 10+ swaps', icon: '\u{1F3B0}',
    check: (_d, m) => (m?.swapCount ?? 0) >= 10 },
  { id: 'referrer', name: 'Connector', description: 'Referred 3+ users', icon: '\u{1F91D}',
    check: (_d, m) => (m?.referralCount ?? 0) >= 3 },
];

export function getEarnedBadges(data: PointsData, metrics?: OnChainMetrics): Badge[] {
  return BADGES.filter(b => b.check(data, metrics));
}
