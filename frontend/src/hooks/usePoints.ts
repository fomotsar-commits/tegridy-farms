import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { getAddress } from 'viem';
import {
  getPointsData, recordAction, recordDailyVisit, setReferrer,
  getTier, getNextTier, getStreakMultiplier, getEarnedBadges,
  type PointsData,
} from '../lib/pointsEngine';

export function usePoints() {
  const { address } = useAccount();
  const [data, setData] = useState<PointsData | null>(null);

  // Load points and record daily visit on mount
  useEffect(() => {
    if (!address) { setData(null); return; }
    const d = recordDailyVisit(address);
    setData(d);
  }, [address]);

  // Check for referrer in URL
  useEffect(() => {
    if (!address) return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref && ref.startsWith('0x') && ref.length === 42) {
      try {
        const checksummed = getAddress(ref);
        setReferrer(address, checksummed);
      } catch {
        // Invalid address — silently ignore
      }
    }
  }, [address]);

  const logAction = useCallback((actionType: string, goldCardBoost = false) => {
    if (!address) return;
    const updated = recordAction(address, actionType, goldCardBoost);
    setData({ ...updated });
  }, [address]);

  const refresh = useCallback(() => {
    if (!address) return;
    setData({ ...getPointsData(address) });
  }, [address]);

  const tier = data ? getTier(data.points) : null;
  const nextTier = data ? getNextTier(data.points) : null;
  const streakMultiplier = data ? getStreakMultiplier(data.streak.current) : 1;
  const badges = data ? getEarnedBadges(data) : [];

  const referralLink = address ? `${window.location.origin}/swap?ref=${address}` : '';

  return {
    data,
    tier,
    nextTier,
    streakMultiplier,
    badges,
    logAction,
    refresh,
    referralLink,
  };
}
