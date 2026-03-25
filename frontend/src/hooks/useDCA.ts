import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';

export interface DCASchedule {
  id: string;
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  amountPerSwap: string; // human-readable amount per interval
  interval: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  totalSwaps: number;
  completedSwaps: number;
  createdAt: number;
  lastSwapAt: number;
  status: 'active' | 'paused' | 'completed';
}

const INTERVAL_MS: Record<string, number> = {
  daily: 86400000,
  weekly: 604800000,
  biweekly: 1209600000,
  monthly: 2592000000,
};

function getStorageKey(address: string) {
  return `tegridy_dca_${address.toLowerCase()}`;
}

function loadSchedules(address: string): DCASchedule[] {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveSchedules(address: string, schedules: DCASchedule[]) {
  try {
    localStorage.setItem(getStorageKey(address), JSON.stringify(schedules));
  } catch {}
}

export function useDCA() {
  const { address } = useAccount();
  const [schedules, setSchedules] = useState<DCASchedule[]>([]);

  useEffect(() => {
    if (!address) { setSchedules([]); return; }
    setSchedules(loadSchedules(address));
  }, [address]);

  const createSchedule = useCallback((schedule: Omit<DCASchedule, 'id' | 'createdAt' | 'lastSwapAt' | 'completedSwaps' | 'status'>) => {
    if (!address) return;
    const newSchedule: DCASchedule = {
      ...schedule,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      lastSwapAt: 0,
      completedSwaps: 0,
      status: 'active',
    };
    const updated = [newSchedule, ...schedules];
    setSchedules(updated);
    saveSchedules(address, updated);
  }, [address, schedules]);

  const markSwapComplete = useCallback((id: string) => {
    if (!address) return;
    const updated = schedules.map(s => {
      if (s.id !== id) return s;
      const completed = s.completedSwaps + 1;
      return {
        ...s,
        completedSwaps: completed,
        lastSwapAt: Date.now(),
        status: completed >= s.totalSwaps ? 'completed' as const : s.status,
      };
    });
    setSchedules(updated);
    saveSchedules(address, updated);
  }, [address, schedules]);

  const cancelSchedule = useCallback((id: string) => {
    if (!address) return;
    const updated = schedules.filter(s => s.id !== id);
    setSchedules(updated);
    saveSchedules(address, updated);
  }, [address, schedules]);

  // Check which schedules are due for a swap
  const dueSchedules = schedules.filter(s => {
    if (s.status !== 'active') return false;
    if (s.completedSwaps >= s.totalSwaps) return false;
    const intervalMs = INTERVAL_MS[s.interval] || INTERVAL_MS.daily;
    return Date.now() - s.lastSwapAt >= intervalMs;
  });

  const activeSchedules = schedules.filter(s => s.status === 'active');

  return { schedules, activeSchedules, dueSchedules, createSchedule, markSwapComplete, cancelSchedule };
}
