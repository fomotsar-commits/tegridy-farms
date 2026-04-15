import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useWriteContract, usePublicClient } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from 'sonner';
import { SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI, ERC20_ABI } from '../lib/contracts';
import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, WETH_ADDRESS } from '../lib/constants';

export interface DCASchedule {
  id: string;
  fromToken: { symbol: string; address: string; decimals: number; isNative?: boolean };
  toToken: { symbol: string; address: string; decimals: number; isNative?: boolean };
  amountPerSwap: string;
  interval: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  totalSwaps: number;
  completedSwaps: number;
  createdAt: number;
  lastSwapAt: number;
  status: 'active' | 'paused' | 'completed';
}

interface StoragePayload {
  version: number;
  schedules: DCASchedule[];
}

const STORAGE_VERSION = 1;
const POLL_INTERVAL = 30_000;
const SLIPPAGE_BPS = 500n; // 5% default slippage (500 / 10000)
const MAX_FEE_BPS = 100n; // 1% max fee tolerance for SwapFeeRouter
const MAX_SCHEDULES = 20;
const MAX_AMOUNT_ETH = 100; // sanity cap per-swap
const MAX_TOTAL_SWAPS = 365;

const INTERVAL_MS: Record<string, number> = {
  daily: 86400000,
  weekly: 604800000,
  biweekly: 1209600000,
  monthly: 2592000000,
};

function getStorageKey(address: string) {
  return `tegridy_dca_v${STORAGE_VERSION}_${address.toLowerCase()}`;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const VALID_INTERVALS = new Set(['daily', 'weekly', 'biweekly', 'monthly']);
const VALID_STATUSES = new Set(['active', 'paused', 'completed']);

function isValidAddress(addr: unknown): boolean {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

function isValidTokenObj(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const tok = t as Record<string, unknown>;
  return (
    typeof tok.symbol === 'string' && tok.symbol.length > 0 && tok.symbol.length <= 20 &&
    typeof tok.decimals === 'number' && tok.decimals >= 0 && tok.decimals <= 18 &&
    (tok.isNative === true || isValidAddress(tok.address))
  );
}

function isValidSchedule(s: unknown): s is DCASchedule {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 100) return false;
  if (typeof o.amountPerSwap !== 'string') return false;
  const amt = parseFloat(o.amountPerSwap as string);
  if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT_ETH) return false;
  if (typeof o.interval !== 'string' || !VALID_INTERVALS.has(o.interval as string)) return false;
  if (typeof o.totalSwaps !== 'number' || !Number.isInteger(o.totalSwaps) || o.totalSwaps < 1 || o.totalSwaps > MAX_TOTAL_SWAPS) return false;
  if (typeof o.completedSwaps !== 'number' || !Number.isInteger(o.completedSwaps) || o.completedSwaps < 0) return false;
  if (typeof o.createdAt !== 'number' || o.createdAt <= 0) return false;
  if (typeof o.lastSwapAt !== 'number' || o.lastSwapAt < 0) return false;
  if (typeof o.status !== 'string' || !VALID_STATUSES.has(o.status as string)) return false;
  if (!isValidTokenObj(o.fromToken) || !isValidTokenObj(o.toToken)) return false;
  return true;
}

function loadSchedules(address: string): DCASchedule[] {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (!raw) return [];
    const parsed: StoragePayload = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.schedules)) return [];
    return parsed.schedules.filter(isValidSchedule);
  } catch {
    return [];
  }
}

function saveSchedules(address: string, schedules: DCASchedule[]) {
  try {
    const payload: StoragePayload = { version: STORAGE_VERSION, schedules };
    localStorage.setItem(getStorageKey(address), JSON.stringify(payload));
  } catch {}
}

function buildPath(fromToken: DCASchedule['fromToken'], toToken: DCASchedule['toToken']): `0x${string}`[] {
  const fromAddr = (fromToken.isNative ? WETH_ADDRESS : fromToken.address) as `0x${string}`;
  const toAddr = (toToken.isNative ? WETH_ADDRESS : toToken.address) as `0x${string}`;
  if (fromAddr.toLowerCase() === WETH_ADDRESS.toLowerCase() || toAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return [fromAddr, toAddr];
  }
  return [fromAddr, WETH_ADDRESS, toAddr];
}

function sendNotification(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
}

function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

export function useDCA() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [schedules, setSchedules] = useState<DCASchedule[]>([]);
  const schedulesRef = useRef<DCASchedule[]>([]);
  const executingRef = useRef<Set<string>>(new Set());
  const { writeContract } = useWriteContract();

  useEffect(() => {
    if (!address) { setSchedules([]); schedulesRef.current = []; return; }
    const loaded = loadSchedules(address);
    setSchedules(loaded);
    schedulesRef.current = loaded;
    requestNotificationPermission();
  }, [address]);

  // Keep ref in sync with state
  useEffect(() => { schedulesRef.current = schedules; }, [schedules]);

  const persist = useCallback((updated: DCASchedule[]) => {
    setSchedules(updated);
    schedulesRef.current = updated;
    if (address) saveSchedules(address, updated);
  }, [address]);

  const createSchedule = useCallback((schedule: Omit<DCASchedule, 'id' | 'createdAt' | 'lastSwapAt' | 'completedSwaps' | 'status'>) => {
    if (!address) return;
    // Input validation
    const amt = parseFloat(schedule.amountPerSwap);
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT_ETH) {
      toast.error(`Amount must be between 0 and ${MAX_AMOUNT_ETH}`);
      return;
    }
    if (!Number.isInteger(schedule.totalSwaps) || schedule.totalSwaps < 1 || schedule.totalSwaps > MAX_TOTAL_SWAPS) {
      toast.error(`Total swaps must be between 1 and ${MAX_TOTAL_SWAPS}`);
      return;
    }
    const activeCount = schedules.filter(s => s.status === 'active' || s.status === 'paused').length;
    if (activeCount >= MAX_SCHEDULES) {
      toast.error(`Maximum ${MAX_SCHEDULES} active schedules allowed.`);
      return;
    }
    const newSchedule: DCASchedule = {
      ...schedule,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      lastSwapAt: 0, // allow first swap to execute immediately
      completedSwaps: 0,
      status: 'active',
    };
    const updated = [newSchedule, ...schedules];
    persist(updated);
  }, [address, schedules, persist]);

  const cancelSchedule = useCallback((id: string) => {
    if (!address) return;
    persist(schedules.filter(s => s.id !== id));
  }, [address, schedules, persist]);

  const pauseSchedule = useCallback((id: string) => {
    if (!address) return;
    persist(schedules.map(s => s.id === id && s.status === 'active' ? { ...s, status: 'paused' as const } : s));
  }, [address, schedules, persist]);

  const resumeSchedule = useCallback((id: string) => {
    if (!address) return;
    persist(schedules.map(s => s.id === id && s.status === 'paused' ? { ...s, status: 'active' as const } : s));
  }, [address, schedules, persist]);

  const markComplete = useCallback((id: string) => {
    executingRef.current.delete(id);
    setSchedules(prev => {
      const updated = prev.map(s => {
        if (s.id !== id) return s;
        const completed = s.completedSwaps + 1;
        return {
          ...s,
          completedSwaps: completed,
          lastSwapAt: Date.now(),
          status: completed >= s.totalSwaps ? 'completed' as const : s.status,
        };
      });
      if (address) saveSchedules(address, updated);
      return updated;
    });
    toast.success('DCA swap confirmed on-chain!');
  }, [address]);

  const waitForReceipt = useCallback(async (hash: `0x${string}`, scheduleId: string) => {
    if (!publicClient) return;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        markComplete(scheduleId);
      } else {
        executingRef.current.delete(scheduleId);
        toast.error('DCA swap transaction reverted on-chain.');
      }
    } catch (err) {
      executingRef.current.delete(scheduleId);
      toast.error('DCA swap failed: could not confirm transaction.');
      if (import.meta.env.DEV) console.error('DCA waitForTransactionReceipt error:', err);
    }
  }, [publicClient, markComplete]);

  const executeDCASwap = useCallback(async (schedule: DCASchedule) => {
    if (!address || !writeContract || !publicClient) return;
    if (executingRef.current.has(schedule.id)) return;
    executingRef.current.add(schedule.id);

    const path = buildPath(schedule.fromToken, schedule.toToken);
    const parsedAmount = parseUnits(schedule.amountPerSwap, schedule.fromToken.decimals);
    if (parsedAmount === 0n) { executingRef.current.delete(schedule.id); return; }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Fetch on-chain quote and apply slippage tolerance
    let minOut = 0n;
    try {
      const result = await publicClient.readContract({
        address: UNISWAP_V2_ROUTER,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [parsedAmount, path],
      });
      const amountsOut = result as bigint[];
      const expectedOut = amountsOut[amountsOut.length - 1] ?? 0n;
      minOut = expectedOut - (expectedOut * SLIPPAGE_BPS / 10000n);
    } catch {
      // If quote fails, do not proceed with 0 slippage -- abort
      executingRef.current.delete(schedule.id);
      toast.error(`DCA: Could not fetch price quote for ${schedule.fromToken.symbol} → ${schedule.toToken.symbol}. Swap skipped.`);
      return;
    }

    sendNotification(
      'DCA Swap Triggered',
      `Swapping ${schedule.amountPerSwap} ${schedule.fromToken.symbol} → ${schedule.toToken.symbol}`
    );
    toast.info(`DCA: Swapping ${schedule.amountPerSwap} ${schedule.fromToken.symbol} → ${schedule.toToken.symbol}`, {
      description: 'Please approve the transaction in your wallet.',
    });

    const isFromNative = schedule.fromToken.isNative || schedule.fromToken.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    // Check ERC-20 allowance before attempting swap (non-native tokens only)
    if (!isFromNative) {
      try {
        const allowance = await publicClient.readContract({
          address: schedule.fromToken.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, SWAP_FEE_ROUTER_ADDRESS],
        }) as bigint;
        if (allowance < parsedAmount) {
          executingRef.current.delete(schedule.id);
          toast.error(`DCA: Insufficient ${schedule.fromToken.symbol} approval for SwapFeeRouter. Please approve the token first.`);
          return;
        }
      } catch {
        executingRef.current.delete(schedule.id);
        toast.error(`DCA: Could not check ${schedule.fromToken.symbol} allowance. Swap skipped.`);
        return;
      }
    }

    const onTxSubmitted = (hash: `0x${string}`) => {
      toast.info('DCA swap submitted, waiting for on-chain confirmation...');
      waitForReceipt(hash, schedule.id);
    };
    const onTxError = (err: Error) => {
      executingRef.current.delete(schedule.id);
      const msg = (err as Error & { shortMessage?: string }).shortMessage || err.message || 'Transaction rejected';
      toast.error(`DCA swap failed: ${msg}`);
    };

    try {
      if (isFromNative) {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactETHForTokens',
          args: [minOut, path, address, deadlineTs, MAX_FEE_BPS],
          value: parsedAmount,
        }, {
          onSuccess: onTxSubmitted,
          onError: onTxError,
        });
      } else if (schedule.toToken.isNative) {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minOut, path, address, deadlineTs, MAX_FEE_BPS],
        }, {
          onSuccess: onTxSubmitted,
          onError: onTxError,
        });
      } else {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minOut, path, address, deadlineTs, MAX_FEE_BPS],
        }, {
          onSuccess: onTxSubmitted,
          onError: onTxError,
        });
      }
    } catch {
      executingRef.current.delete(schedule.id);
    }
  }, [address, writeContract, publicClient, markComplete, waitForReceipt]);

  // Polling: check for due schedules and auto-execute
  useEffect(() => {
    if (!address) return;

    const checkDue = () => {
      const current = schedulesRef.current;
      const now = Date.now();
      for (const s of current) {
        if (s.status !== 'active') continue;
        if (s.completedSwaps >= s.totalSwaps) continue;
        if (executingRef.current.has(s.id)) continue;
        const intervalMs = INTERVAL_MS[s.interval] ?? INTERVAL_MS.daily ?? 86400000;
        if (now - s.lastSwapAt >= intervalMs) {
          executeDCASwap(s);
        }
      }
    };

    checkDue();
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      checkDue();
    }, POLL_INTERVAL);
    return () => {
      clearInterval(timer);
      executingRef.current.clear();
    };
  }, [address, executeDCASwap]);

  const dueSchedules = schedules.filter(s => {
    if (s.status !== 'active') return false;
    if (s.completedSwaps >= s.totalSwaps) return false;
    const intervalMs = INTERVAL_MS[s.interval] ?? INTERVAL_MS.daily ?? 86400000;
    return Date.now() - s.lastSwapAt >= intervalMs;
  });

  const activeSchedules = schedules.filter(s => s.status === 'active' || s.status === 'paused');

  return {
    schedules,
    activeSchedules,
    dueSchedules,
    createSchedule,
    cancelSchedule,
    pauseSchedule,
    resumeSchedule,
    markSwapComplete: markComplete,
  };
}
