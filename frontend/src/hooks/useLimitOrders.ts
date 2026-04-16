import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, useWriteContract, usePublicClient, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI, ERC20_ABI } from '../lib/contracts';
import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, WETH_ADDRESS, CHAIN_ID } from '../lib/constants';
import { isValidAddress as isValidTokenAddress } from '../lib/tokenList';

export interface LimitOrder {
  id: string;
  fromToken: { symbol: string; address: string; decimals: number; isNative?: boolean };
  toToken: { symbol: string; address: string; decimals: number; isNative?: boolean };
  amount: string;
  targetPrice: string; // price of toToken in fromToken terms (e.g. TOWELI per ETH)
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'filled' | 'executing';
}

interface StoragePayload {
  version: number;
  orders: LimitOrder[];
}

const STORAGE_VERSION = 1;
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const PRICE_POLL_INTERVAL = 15_000;
const SLIPPAGE_BPS = 500n; // 5% slippage tolerance (500 / 10000)
const MAX_FEE_BPS = 100n; // 1% max fee tolerance for SwapFeeRouter
const MAX_ORDERS = 50;
const MAX_AMOUNT = 1e15; // sanity cap for amount string parsing

// Multi-tab mutex: prevent duplicate limit order execution across browser tabs.
function claimTabLock(orderId: string): boolean {
  try {
    const key = `tegridy_limit_lock_${orderId}`;
    const now = Date.now();
    const existing = localStorage.getItem(key);
    if (existing) {
      const lockTime = parseInt(existing, 10);
      if (now - lockTime < 60_000) return false;
    }
    localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function releaseTabLock(orderId: string) {
  try { localStorage.removeItem(`tegridy_limit_lock_${orderId}`); } catch {}
}

function getStorageKey(address: string) {
  return `tegridy_limit_v${STORAGE_VERSION}_${address.toLowerCase()}`;
}

const VALID_ORDER_STATUSES = new Set(['active', 'expired', 'filled', 'executing']);

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

function isValidOrder(o: unknown): o is LimitOrder {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 100) return false;
  if (typeof r.amount !== 'string') return false;
  const amt = parseFloat(r.amount as string);
  if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) return false;
  if (typeof r.targetPrice !== 'string') return false;
  const tp = parseFloat(r.targetPrice as string);
  if (!Number.isFinite(tp) || tp <= 0) return false;
  if (typeof r.createdAt !== 'number' || r.createdAt <= 0) return false;
  if (typeof r.expiresAt !== 'number' || r.expiresAt <= 0) return false;
  if (typeof r.status !== 'string' || !VALID_ORDER_STATUSES.has(r.status as string)) return false;
  if (!isValidTokenObj(r.fromToken) || !isValidTokenObj(r.toToken)) return false;
  return true;
}

function loadOrders(address: string): LimitOrder[] {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (!raw) return [];
    const parsed: StoragePayload = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.orders)) return [];
    const now = Date.now();
    return parsed.orders.filter(isValidOrder).map(o => ({
      ...o,
      status: o.status === 'active' && o.expiresAt <= now ? 'expired' as const : o.status,
    }));
  } catch {
    return [];
  }
}

function saveOrders(address: string, orders: LimitOrder[]) {
  try {
    const payload: StoragePayload = { version: STORAGE_VERSION, orders };
    localStorage.setItem(getStorageKey(address), JSON.stringify(payload));
  } catch {}
}

function buildPath(fromToken: LimitOrder['fromToken'], toToken: LimitOrder['toToken']): `0x${string}`[] {
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

export function useLimitOrders() {
  const chainId = useChainId();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const ordersRef = useRef<LimitOrder[]>([]);
  const executingRef = useRef<Set<string>>(new Set());
  const { writeContract } = useWriteContract();

  useEffect(() => {
    if (!address) { setOrders([]); ordersRef.current = []; return; }
    const loaded = loadOrders(address);
    setOrders(loaded);
    ordersRef.current = loaded;
    requestNotificationPermission();
  }, [address]);

  useEffect(() => { ordersRef.current = orders; }, [orders]);

  const persist = useCallback((updated: LimitOrder[]) => {
    setOrders(updated);
    ordersRef.current = updated;
    if (address) saveOrders(address, updated);
  }, [address]);

  const createOrder = useCallback((order: Omit<LimitOrder, 'id' | 'createdAt' | 'status'>) => {
    if (!address) return;
    // Input validation
    const amt = parseFloat(order.amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) {
      toast.error('Invalid order amount.');
      return;
    }
    const tp = parseFloat(order.targetPrice);
    if (!Number.isFinite(tp) || tp <= 0) {
      toast.error('Invalid target price.');
      return;
    }
    const activeCount = orders.filter(o => o.status === 'active' || o.status === 'executing').length;
    if (activeCount >= MAX_ORDERS) {
      toast.error(`Maximum ${MAX_ORDERS} active orders allowed.`);
      return;
    }
    const newOrder: LimitOrder = {
      ...order,
      expiresAt: order.expiresAt || Date.now() + DEFAULT_EXPIRY_MS,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      status: 'active',
    };
    persist([newOrder, ...orders]);
  }, [address, orders, persist]);

  const cancelOrder = useCallback((id: string) => {
    if (!address) return;
    persist(orders.filter(o => o.id !== id));
  }, [address, orders, persist]);

  const markFilled = useCallback((id: string) => {
    executingRef.current.delete(id);
    releaseTabLock(id);
    setOrders(prev => {
      const updated = prev.map(o => o.id === id ? { ...o, status: 'filled' as const } : o);
      if (address) saveOrders(address, updated);
      return updated;
    });
    toast.success('Limit order confirmed on-chain!');
  }, [address]);

  const revertOrderStatus = useCallback((orderId: string) => {
    executingRef.current.delete(orderId);
    releaseTabLock(orderId);
    setOrders(prev => {
      const updated = prev.map(o => o.id === orderId ? { ...o, status: 'active' as const } : o);
      if (address) saveOrders(address, updated);
      return updated;
    });
  }, [address]);

  const waitForReceipt = useCallback(async (hash: `0x${string}`, orderId: string) => {
    if (!publicClient) return;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        markFilled(orderId);
      } else {
        revertOrderStatus(orderId);
        toast.error('Limit order transaction reverted on-chain.');
      }
    } catch (err) {
      revertOrderStatus(orderId);
      toast.error('Limit order failed: could not confirm transaction.');
      if (import.meta.env.DEV) console.error('Limit order waitForTransactionReceipt error:', err);
    }
  }, [publicClient, markFilled, revertOrderStatus]);

  const executeOrder = useCallback(async (order: LimitOrder) => {
    if (!address || !writeContract || !publicClient) return;
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (executingRef.current.has(order.id)) return;
    if (!claimTabLock(order.id)) return;
    executingRef.current.add(order.id);

    setOrders(prev => {
      const updated = prev.map(o => o.id === order.id ? { ...o, status: 'executing' as const } : o);
      if (address) saveOrders(address, updated);
      return updated;
    });

    const path = buildPath(order.fromToken, order.toToken);
    const parsedAmount = parseUnits(order.amount, order.fromToken.decimals);
    if (parsedAmount === 0n) { revertOrderStatus(order.id); return; }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Compute minOut with slippage from the user's target price
    // The target price is in toToken per fromToken units
    const targetPriceNum = parseFloat(order.targetPrice);
    const amountNum = parseFloat(order.amount);
    if (!Number.isFinite(targetPriceNum) || targetPriceNum <= 0 || !Number.isFinite(amountNum) || amountNum <= 0) {
      revertOrderStatus(order.id);
      return;
    }
    // Use BigInt math to avoid floating-point precision loss on large values.
    // Scale both values by 1e12, multiply together with token decimals, then divide by 1e24 once.
    const PRECISION = 1000000000000n; // 1e12
    const targetPriceScaled = BigInt(Math.round(targetPriceNum * 1e12));
    const amountScaled = BigInt(Math.round(amountNum * 1e12));
    const expectedOut = (targetPriceScaled * amountScaled * (10n ** BigInt(order.toToken.decimals))) / (PRECISION * PRECISION);
    const minOut = expectedOut - (expectedOut * SLIPPAGE_BPS / 10000n);

    sendNotification(
      'Limit Order Triggered',
      `Target price reached! Swapping ${order.amount} ${order.fromToken.symbol} → ${order.toToken.symbol}`
    );
    toast.info(`Limit order triggered: ${order.amount} ${order.fromToken.symbol} → ${order.toToken.symbol}`, {
      description: 'Please approve the transaction in your wallet.',
    });

    const isFromNative = order.fromToken.isNative || order.fromToken.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    // Check ERC-20 allowance before attempting swap (non-native tokens only)
    if (!isFromNative) {
      try {
        const allowance = await publicClient.readContract({
          address: order.fromToken.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, SWAP_FEE_ROUTER_ADDRESS],
        }) as bigint;
        if (allowance < parsedAmount) {
          toast.error(`Limit order: Insufficient ${order.fromToken.symbol} approval. Please approve the token first.`);
          revertOrderStatus(order.id);
          return;
        }
      } catch {
        toast.error(`Limit order: Could not check ${order.fromToken.symbol} allowance.`);
        revertOrderStatus(order.id);
        return;
      }
    }

    const onTxSubmitted = (hash: `0x${string}`) => {
      toast.info('Limit order submitted, waiting for on-chain confirmation...');
      waitForReceipt(hash, order.id);
    };
    const onTxError = (err: Error) => {
      revertOrderStatus(order.id);
      const msg = (err as Error & { shortMessage?: string }).shortMessage || err.message || 'Transaction rejected';
      toast.error(`Limit order failed: ${msg}`);
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
      } else if (order.toToken.isNative) {
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
      revertOrderStatus(order.id);
    }
  }, [address, chainId, writeContract, publicClient, markFilled, revertOrderStatus, waitForReceipt]);

  // Price polling: check active orders against on-chain price
  useEffect(() => {
    if (!address || !publicClient) return;

    let isChecking = false;

    const checkPrices = async () => {
      if (isChecking) return; // prevent overlapping async calls
      isChecking = true;

      try {
        const currentOrders = ordersRef.current;
        const now = Date.now();

        // Expire stale orders
        let hasExpired = false;
        const updated = currentOrders.map(o => {
          if (o.status === 'active' && o.expiresAt < now) {
            hasExpired = true;
            return { ...o, status: 'expired' as const };
          }
          return o;
        });
        if (hasExpired) {
          persist(updated);
        }

        const activeList = (hasExpired ? updated : currentOrders).filter(
          o => o.status === 'active' && o.expiresAt > now
        );
        if (activeList.length === 0) return;

        for (const order of activeList) {
          if (executingRef.current.has(order.id)) continue;

          const path = buildPath(order.fromToken, order.toToken);
          const parsedAmount = parseUnits(order.amount, order.fromToken.decimals);
          if (parsedAmount === 0n) continue;

          try {
            const result = await publicClient.readContract({
              address: UNISWAP_V2_ROUTER,
              abi: UNISWAP_V2_ROUTER_ABI,
              functionName: 'getAmountsOut',
              args: [parsedAmount, path],
            });
            const amountsOut = result as bigint[];
            const outputAmount = amountsOut[amountsOut.length - 1] ?? 0n;
            // NOTE: Number() precision risk for very large values (>2^53); acceptable for price comparison heuristic
            const currentPrice = Number(formatUnits(outputAmount, order.toToken.decimals)) / Number(order.amount);
            const targetPriceNum = parseFloat(order.targetPrice);

            if (targetPriceNum > 0 && currentPrice >= targetPriceNum) {
              executeOrder(order);
            }
          } catch (err) {
            console.error(`Limit order price poll failed for ${order.fromToken.symbol} → ${order.toToken.symbol}:`, err);
          }
        }
      } finally {
        isChecking = false;
      }
    };

    checkPrices();
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      checkPrices();
    }, PRICE_POLL_INTERVAL);
    return () => {
      clearInterval(timer);
      executingRef.current.clear();
    };
  }, [address, publicClient, persist, executeOrder]);

  const activeOrders = orders.filter(o => o.status === 'active' || o.status === 'executing');
  const pastOrders = orders.filter(o => o.status === 'expired' || o.status === 'filled');

  return { orders, activeOrders, pastOrders, createOrder, cancelOrder };
}
