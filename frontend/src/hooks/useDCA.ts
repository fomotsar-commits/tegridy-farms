import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useWriteContract, usePublicClient, useChainId } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from 'sonner';
import { SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI, ERC20_ABI } from '../lib/contracts';
import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, WETH_ADDRESS, CHAIN_ID } from '../lib/constants';
import { isValidAddress as isValidTokenAddress } from '../lib/tokenList';

const DCA_CHANNEL = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tegridy_dca_sync') : null;

// R042 MED-6: dedicated cross-tab lock channel. The localStorage TTL alone
// is racey under hardware-wallet sign latency >20s; broadcasting claim/release
// closes the window between "lock expired in localStorage" and "another tab
// claimed but hasn't yet hit setItem".
const DCA_LOCK_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('tegridy-dca-lock')
  : null;
const TAB_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const REMOTE_CLAIM_WINDOW_MS = 20_000;

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

// Multi-tab mutex: prevent duplicate DCA execution across browser tabs.
// Uses BroadcastChannel to claim a lock before executing — if another tab
// already claimed it, this tab skips the execution.
// BroadcastChannel mutex name — used by claimTabLock below
// const DCA_CHANNEL_NAME = 'tegridy_dca_mutex';

// AUDIT DCA-LOCK: shortened from 60s → 20s. A crashed tab used to leave
// the lock orphaned for a full minute; 20s is still well above any
// realistic tx-signing round-trip (wallet sign → broadcast → first
// confirmation on a fast block) and refreshed inline during long ops
// via `refreshTabLock` below. Explicit tab-close also releases via the
// window-level beforeunload hook in the main hook body.
const LOCK_TTL_MS = 20_000;

function claimTabLock(scheduleId: string): boolean {
  try {
    const key = `tegridy_dca_lock_${scheduleId}`;
    const now = Date.now();
    const existing = localStorage.getItem(key);
    if (existing) {
      const lockTime = parseInt(existing, 10);
      if (now - lockTime < LOCK_TTL_MS) return false;
    }
    localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true; // If localStorage fails, allow execution
  }
}

/** Bump the lock timestamp during a long operation so it doesn't expire
 *  mid-tx while the wallet is waiting for user signature. */
function refreshTabLock(scheduleId: string) {
  try {
    localStorage.setItem(`tegridy_dca_lock_${scheduleId}`, String(Date.now()));
  } catch {}
}

function releaseTabLock(scheduleId: string) {
  try { localStorage.removeItem(`tegridy_dca_lock_${scheduleId}`); } catch {}
}

// R042 MED-6: broadcast lock claim/release across tabs.
type LockMsg = { type: 'lock_claim' | 'lock_release'; scheduleId: string; tabId: string; ts: number };
function broadcastLockMsg(msg: LockMsg) {
  try { DCA_LOCK_CHANNEL?.postMessage(msg); } catch {}
}

const INTERVAL_MS: Record<string, number> = {
  daily: 86400000,
  weekly: 604800000,
  biweekly: 1209600000,
  monthly: 2592000000,
};

function getStorageKey(address: string) {
  return `tegridy_dca_v${STORAGE_VERSION}_${address.toLowerCase()}`;
}

const VALID_INTERVALS = new Set(['daily', 'weekly', 'biweekly', 'monthly']);
const VALID_STATUSES = new Set(['active', 'paused', 'completed']);

function isValidAddress(addr: unknown): boolean {
  return typeof addr === 'string' && isValidTokenAddress(addr);
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
    DCA_CHANNEL?.postMessage({ type: 'dca_updated', address });
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
  const chainId = useChainId();
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

  // Cross-tab sync: reload schedules when another tab updates them
  useEffect(() => {
    if (!DCA_CHANNEL || !address) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'dca_updated' && e.data?.address?.toLowerCase() === address.toLowerCase()) {
        setSchedules(loadSchedules(address));
      }
    };
    DCA_CHANNEL.addEventListener('message', handler);
    return () => DCA_CHANNEL.removeEventListener('message', handler);
  }, [address]);

  // R042 MED-6: subscribe to peer claim/release messages on the dedicated
  // lock channel; record claims so we can reject our own claim if a peer
  // beat us within the window.
  const remoteClaimsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!DCA_LOCK_CHANNEL) return;
    const handler = (e: MessageEvent<LockMsg>) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.tabId === TAB_ID) return; // ignore our own broadcasts
      if (msg.type === 'lock_claim') {
        remoteClaimsRef.current.set(msg.scheduleId, msg.ts);
      } else if (msg.type === 'lock_release') {
        remoteClaimsRef.current.delete(msg.scheduleId);
      }
    };
    DCA_LOCK_CHANNEL.addEventListener('message', handler);
    return () => DCA_LOCK_CHANNEL.removeEventListener('message', handler);
  }, []);

  /** Combined claim: rejects if any peer broadcast a claim within the window,
   *  then claimTabLock, then broadcast our claim. */
  const claimWithBroadcast = useCallback((scheduleId: string): boolean => {
    const peerTs = remoteClaimsRef.current.get(scheduleId) ?? 0;
    if (peerTs > 0 && Date.now() - peerTs < REMOTE_CLAIM_WINDOW_MS) {
      return false;
    }
    if (!claimTabLock(scheduleId)) return false;
    broadcastLockMsg({ type: 'lock_claim', scheduleId, tabId: TAB_ID, ts: Date.now() });
    return true;
  }, []);

  const releaseWithBroadcast = useCallback((scheduleId: string) => {
    releaseTabLock(scheduleId);
    broadcastLockMsg({ type: 'lock_release', scheduleId, tabId: TAB_ID, ts: Date.now() });
  }, []);

  // AUDIT DCA-LOCK: release all currently-executing locks on explicit
  // tab close. beforeunload fires reliably for user-initiated navigation
  // + close; it does NOT fire on hard crashes (kill -9, power loss) —
  // for those the 20s TTL is the backstop. Together they collapse the
  // orphan window from "60s always" to "sub-second on close, 20s on crash."
  useEffect(() => {
    const onBeforeUnload = () => {
      executingRef.current.forEach((id) => {
        releaseTabLock(id);
        broadcastLockMsg({ type: 'lock_release', scheduleId: id, tabId: TAB_ID, ts: Date.now() });
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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
    releaseWithBroadcast(id);
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
  }, [address, releaseWithBroadcast]);

  const waitForReceipt = useCallback(async (hash: `0x${string}`, scheduleId: string) => {
    if (!publicClient) return;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        markComplete(scheduleId);
      } else {
        executingRef.current.delete(scheduleId); releaseWithBroadcast(scheduleId);
        toast.error('DCA swap transaction reverted on-chain.');
      }
    } catch (err) {
      executingRef.current.delete(scheduleId); releaseWithBroadcast(scheduleId);
      toast.error('DCA swap failed: could not confirm transaction.');
      if (import.meta.env.DEV) console.error('DCA waitForTransactionReceipt error:', err);
    }
  }, [publicClient, markComplete, releaseWithBroadcast]);

  const executeDCASwap = useCallback(async (schedule: DCASchedule) => {
    if (!address || !writeContract || !publicClient) return;
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (executingRef.current.has(schedule.id)) return;
    // Multi-tab mutex: skip if a peer broadcast OR localStorage lock claims it.
    if (!claimWithBroadcast(schedule.id)) return;
    executingRef.current.add(schedule.id);

    const path = buildPath(schedule.fromToken, schedule.toToken);
    const parsedAmount = parseUnits(schedule.amountPerSwap, schedule.fromToken.decimals);
    if (parsedAmount === 0n) { executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id); return; }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Refresh the lock timestamp at each async boundary so a wallet that
    // sits on the signing prompt for >20s doesn't lose the lock to another
    // tab mid-flow. Shorter TTL + refreshes gives us the best of both
    // worlds: fast orphan recovery without accidentally stomping
    // legitimate slow signs.
    refreshTabLock(schedule.id);

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
      executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id);
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
          executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id);
          toast.error(`DCA: Insufficient ${schedule.fromToken.symbol} approval for SwapFeeRouter. Please approve the token first.`);
          return;
        }
      } catch {
        executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id);
        toast.error(`DCA: Could not check ${schedule.fromToken.symbol} allowance. Swap skipped.`);
        return;
      }
    }

    // Second refresh before handing off to writeContract — between the
    // allowance read and the wallet popup the user may take a moment.
    refreshTabLock(schedule.id);

    const onTxSubmitted = (hash: `0x${string}`) => {
      toast.info('DCA swap submitted, waiting for on-chain confirmation...');
      waitForReceipt(hash, schedule.id);
    };
    const onTxError = (err: Error) => {
      executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id);
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
      executingRef.current.delete(schedule.id); releaseWithBroadcast(schedule.id);
    }
  }, [address, chainId, writeContract, publicClient, markComplete, waitForReceipt, claimWithBroadcast, releaseWithBroadcast]);

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
