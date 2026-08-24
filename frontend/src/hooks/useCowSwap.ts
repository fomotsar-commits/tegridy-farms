// useCowSwap — execute a single MEV-protected market swap through CoW Protocol.
//
// Why this exists alongside useSwap: the on-chain swap path (Uniswap / Tegridy /
// SwapFeeRouter) broadcasts to the PUBLIC mempool, where a searcher can sandwich
// it. Routing the same trade through CoW instead means the user signs ONE
// EIP-712 order (no gas), CoW's batch-auction solvers settle it at or above the
// quoted price, and the order never sits in the public mempool — no sandwich
// surface, and an unfilled order costs nothing.
//
// It reuses the GPv2 order schema + hardened orderbook proxy from
// lib/cowProtocol.ts and the pure quote/order math from lib/cowSwap.ts. It is the
// market-order sibling of useCowLimitOrder (which places resting limit orders).
// ERC-20 sell tokens only — native-ETH sells need CoW's EthFlow contract (out of
// scope); the panel tells the user to wrap ETH to WETH first.

import { useCallback, useEffect, useState } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
} from 'wagmi';
import { maxUint256, type Address } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import {
  COW_VAULT_RELAYER_ADDRESS,
  COW_ORDER_TYPES,
  cowDomain,
  toOrderSubmission,
  isTerminalStatus,
} from '../lib/cowProtocol';
import {
  buildCowSwapQuoteBody,
  parseCowSwapQuote,
  buildCowSwapOrder,
  requiredSellBalance,
  slippagePctToBps,
  cowApiUrl,
  type ParsedCowSwapQuote,
} from '../lib/cowSwap';

interface TokenRef {
  symbol: string;
  address: string;
  decimals: number;
  isNative?: boolean;
}

export interface CowSwapRecord {
  uid: string;
  sellToken: { symbol: string; address: string; decimals: number };
  buyToken: { symbol: string; address: string; decimals: number };
  sellAmount: string; // base units
  buyAmountMin: string; // base units (the signed floor)
  createdAt: number;
  status: string;
}

const STORAGE_VERSION = 1;
const MAX_RECORDS = 25;
const POLL_INTERVAL_MS = 15_000;

function storageKey(owner: string): string {
  return `tegridy_cow_swaps_${CHAIN_ID}_${owner.toLowerCase()}`;
}

function loadRecords(owner: string): CowSwapRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version: number; orders: CowSwapRecord[] };
    if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.orders)) return [];
    return parsed.orders;
  } catch {
    return [];
  }
}

function saveRecords(owner: string, orders: CowSwapRecord[]): void {
  try {
    localStorage.setItem(
      storageKey(owner),
      JSON.stringify({ version: STORAGE_VERSION, orders: orders.slice(0, MAX_RECORDS) }),
    );
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/** Fetch + parse a fresh CoW sell quote. Returns null (never a fake number) on any failure. */
async function fetchCowQuote(
  sellToken: Address,
  buyToken: Address,
  owner: Address,
  sellAmount: bigint,
  signal?: AbortSignal,
): Promise<ParsedCowSwapQuote | null> {
  try {
    const res = await fetch(cowApiUrl('quote'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCowSwapQuoteBody({ sellToken, buyToken, owner, sellAmount })),
      signal,
    });
    if (!res.ok) return null;
    return parseCowSwapQuote(await res.json());
  } catch {
    return null;
  }
}

export function useCowSwap() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [isPlacing, setIsPlacing] = useState(false);
  const [records, setRecords] = useState<CowSwapRecord[]>([]);

  useEffect(() => {
    setRecords(address ? loadRecords(address) : []);
  }, [address]);

  /**
   * Read-only indicative quote for the panel to display. Callers pass ERC-20
   * addresses (WETH, never native ETH). Returns null when no quote is available.
   */
  const getQuote = useCallback(
    async (
      sellToken: string,
      buyToken: string,
      sellAmount: bigint,
      signal?: AbortSignal,
    ): Promise<ParsedCowSwapQuote | null> => {
      if (!address || sellAmount <= 0n) return null;
      if (chainId !== CHAIN_ID) return null;
      return fetchCowQuote(sellToken as Address, buyToken as Address, address, sellAmount, signal);
    },
    [address, chainId],
  );

  const placeSwap = useCallback(
    async (params: {
      sellToken: TokenRef;
      buyToken: TokenRef;
      sellAmount: bigint;
      slippagePct: number;
    }): Promise<string | null> => {
      if (!address) {
        toast.error('Connect your wallet');
        return null;
      }
      if (chainId !== CHAIN_ID) {
        toast.error('Switch to Ethereum Mainnet to swap via CoW');
        return null;
      }
      if (params.sellToken.isNative) {
        toast.error('CoW sells ERC-20s — wrap ETH to WETH first');
        return null;
      }
      if (!publicClient) {
        toast.error('No RPC connection');
        return null;
      }
      if (params.sellAmount <= 0n) {
        toast.error('Enter an amount to swap');
        return null;
      }

      const sellToken = params.sellToken.address as Address;
      const buyToken = params.buyToken.address as Address;
      setIsPlacing(true);
      try {
        // 1. Fetch a FRESH quote at submit time so we sign against the current
        //    price, not a stale display quote.
        const quote = await fetchCowQuote(sellToken, buyToken, address, params.sellAmount, undefined);
        if (!quote) {
          toast.error('CoW has no quote for this pair/size right now');
          return null;
        }

        // 2. Must hold sellAmount + fee, else the signed order can never settle.
        const needed = requiredSellBalance(quote);
        const balance = (await publicClient.readContract({
          address: sellToken,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint;
        if (balance < needed) {
          toast.error(`Insufficient ${params.sellToken.symbol} balance`);
          return null;
        }

        // 3. Ensure the vault relayer can pull the sell token (one-time per token).
        const allowance = (await publicClient.readContract({
          address: sellToken,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, COW_VAULT_RELAYER_ADDRESS],
        })) as bigint;
        if (allowance < needed) {
          toast.info(`Approve CoW to spend your ${params.sellToken.symbol} (one-time)`);
          const approveHash = await writeContractAsync({
            chainId: CHAIN_ID,
            address: sellToken,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [COW_VAULT_RELAYER_ADDRESS, maxUint256],
          });
          // AUDIT (receipt-status, 2026-08-24): waitForTransactionReceipt
          // RESOLVES for reverted txs. Pre-fix, a reverted approve fell through
          // to signing + submitting an order the vault relayer could never pull
          // — an open order guaranteed to expire unfilled.
          const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
          if (approveReceipt.status !== 'success') {
            throw new Error('Token approval reverted on-chain — the order was not submitted.');
          }
        }

        // 4. Build + sign the market order (buyAmount = quote − slippage floor).
        const { order, buyAmountMin } = buildCowSwapOrder({
          sellToken,
          buyToken,
          receiver: address,
          quote,
          slippageBps: slippagePctToBps(params.slippagePct),
        });
        if (order.validTo > 0xffffffff) {
          toast.error('Order expiry overflow');
          return null;
        }
        const signature = await signTypedDataAsync({
          domain: cowDomain(CHAIN_ID),
          types: COW_ORDER_TYPES,
          primaryType: 'Order',
          message: order,
        });

        // 5. Submit to the orderbook. Returns the order UID as a quoted string.
        const submission = {
          ...toOrderSubmission(order, signature, address),
          ...(quote.quoteId !== null ? { quoteId: quote.quoteId } : {}),
        };
        const res = await fetch(cowApiUrl('orders'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission),
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = 'CoW rejected the swap';
          try {
            const j = JSON.parse(text);
            msg = j.description || j.errorType || msg;
          } catch {
            /* keep default */
          }
          throw new Error(msg);
        }
        const uid = JSON.parse(text) as string;

        const rec: CowSwapRecord = {
          uid,
          sellToken: {
            symbol: params.sellToken.symbol,
            address: params.sellToken.address,
            decimals: params.sellToken.decimals,
          },
          buyToken: {
            symbol: params.buyToken.symbol,
            address: params.buyToken.address,
            decimals: params.buyToken.decimals,
          },
          sellAmount: params.sellAmount.toString(),
          buyAmountMin: buyAmountMin.toString(),
          createdAt: Date.now(),
          status: 'open',
        };
        const next = [rec, ...loadRecords(address)].slice(0, MAX_RECORDS);
        saveRecords(address, next);
        setRecords(next);
        toast.success('Swap sent to CoW — solvers settle it MEV-protected. You can close the tab.');
        return uid;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to place swap';
        if (/reject|denied|user denied|user rejected/i.test(msg)) {
          toast.error('Signature rejected');
        } else {
          toast.error(msg.slice(0, 140));
        }
        return null;
      } finally {
        setIsPlacing(false);
      }
    },
    [address, chainId, publicClient, signTypedDataAsync, writeContractAsync],
  );

  // Poll open orders for their settlement status.
  const refreshStatuses = useCallback(async () => {
    if (!address) return;
    const current = loadRecords(address);
    if (current.length === 0 || current.every((r) => isTerminalStatus(r.status))) return;
    const updated = await Promise.all(
      current.map(async (r) => {
        if (isTerminalStatus(r.status)) return r;
        try {
          const res = await fetch(cowApiUrl(`orders/${r.uid}`));
          if (!res.ok) return r;
          const j = (await res.json()) as { status?: string };
          return typeof j?.status === 'string' ? { ...r, status: j.status } : r;
        } catch {
          return r;
        }
      }),
    );
    saveRecords(address, updated);
    setRecords(updated);
  }, [address]);

  useEffect(() => {
    if (!address) return;
    void refreshStatuses();
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refreshStatuses();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [address, refreshStatuses]);

  return { getQuote, placeSwap, isPlacing, records, refreshStatuses };
}
