// useCowLimitOrder — place + track real CoW Protocol limit orders.
//
// Flow (CoW's documented order lifecycle):
//   1. Approve the GPv2VaultRelayer to pull the SELL token (one-time per token).
//   2. Build the canonical GPv2 Order and sign it EIP-712 (one signature, no gas).
//   3. POST it to CoW's orderbook (through the hardened /api/cow proxy alias).
//   4. CoW solvers settle it on-chain when the limit price is met — it survives
//      tab close and needs no per-fill signature (vs. the browser-keeper path).
//
// ERC-20 sell tokens only; native-ETH sells need CoW's EthFlow contract (out of
// scope — the caller falls back to wrapping or the keeper).
import { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi';
import { maxUint256, type Address } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import {
  COW_VAULT_RELAYER_ADDRESS,
  COW_ORDER_TYPES,
  cowDomain,
  buildLimitSellOrder,
  toOrderSubmission,
  cowOrderbookUrl,
  isTerminalStatus,
} from '../lib/cowProtocol';

interface TokenRef {
  symbol: string;
  address: string;
  decimals: number;
  isNative?: boolean;
}

export interface CowLimitRecord {
  uid: string;
  sellToken: { symbol: string; address: string; decimals: number };
  buyToken: { symbol: string; address: string; decimals: number };
  sellAmount: string; // base units
  buyAmount: string; // base units (the limit)
  createdAt: number;
  validTo: number;
  status: string; // last-known CoW status
}

const STORAGE_VERSION = 1;
const MAX_RECORDS = 50;
const POLL_INTERVAL_MS = 30_000;

function storageKey(owner: string): string {
  // chain-scoped + owner-scoped (mainnet-only feature, but keep the shape future-proof)
  return `tegridy_cow_orders_${CHAIN_ID}_${owner.toLowerCase()}`;
}

function loadRecords(owner: string): CowLimitRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version: number; orders: CowLimitRecord[] };
    if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.orders)) return [];
    return parsed.orders;
  } catch {
    return [];
  }
}

function saveRecords(owner: string, orders: CowLimitRecord[]): void {
  try {
    localStorage.setItem(
      storageKey(owner),
      JSON.stringify({ version: STORAGE_VERSION, orders: orders.slice(0, MAX_RECORDS) }),
    );
  } catch {
    /* quota / private mode — non-fatal */
  }
}

export function useCowLimitOrder() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [isPlacing, setIsPlacing] = useState(false);
  const [records, setRecords] = useState<CowLimitRecord[]>([]);

  // Hydrate from storage on connect / wallet change.
  useEffect(() => {
    setRecords(address ? loadRecords(address) : []);
  }, [address]);

  const placeOrder = useCallback(
    async (params: {
      sellToken: TokenRef;
      buyToken: TokenRef;
      sellAmount: bigint;
      buyAmount: bigint; // the minimum (limit) the user will accept
      expirySeconds: number;
    }): Promise<string | null> => {
      if (!address) {
        toast.error('Connect your wallet');
        return null;
      }
      if (chainId !== CHAIN_ID) {
        toast.error('Switch to Ethereum Mainnet to use CoW orders');
        return null;
      }
      if (params.sellToken.isNative) {
        toast.error('CoW limit orders need an ERC-20 sell token — wrap ETH to WETH first');
        return null;
      }
      if (!publicClient) {
        toast.error('No RPC connection');
        return null;
      }
      if (params.sellAmount <= 0n || params.buyAmount <= 0n) {
        toast.error('Enter a valid amount and limit price');
        return null;
      }

      const sellToken = params.sellToken.address as Address;
      const buyToken = params.buyToken.address as Address;
      setIsPlacing(true);
      try {
        // 0. Must actually hold the sell token, else the signed order can never fill.
        const balance = (await publicClient.readContract({
          address: sellToken,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint;
        if (balance < params.sellAmount) {
          toast.error(`Insufficient ${params.sellToken.symbol} balance`);
          return null;
        }

        // 1. Ensure the vault relayer can pull the sell token.
        const allowance = (await publicClient.readContract({
          address: sellToken,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, COW_VAULT_RELAYER_ADDRESS],
        })) as bigint;
        if (allowance < params.sellAmount) {
          toast.info('Approve CoW to spend your sell token (one-time)');
          const approveHash = await writeContractAsync({
            chainId: CHAIN_ID,
            address: sellToken,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [COW_VAULT_RELAYER_ADDRESS, maxUint256],
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        // 2. Build + EIP-712 sign the order.
        const validTo = Math.floor(Date.now() / 1000) + params.expirySeconds;
        if (validTo > 0xffffffff) {
          // validTo is a uint32 in the signed order; refuse rather than silently wrap.
          toast.error('Expiry too far in the future');
          return null;
        }
        const order = buildLimitSellOrder({
          sellToken,
          buyToken,
          sellAmount: params.sellAmount,
          buyAmount: params.buyAmount,
          validTo,
          receiver: address,
        });
        const signature = await signTypedDataAsync({
          domain: cowDomain(CHAIN_ID),
          types: COW_ORDER_TYPES,
          primaryType: 'Order',
          message: order,
        });

        // 3. Submit to the orderbook (returns the order UID as a quoted string).
        const submission = toOrderSubmission(order, signature, address);
        const res = await fetch(cowOrderbookUrl('orders'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission),
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = 'CoW rejected the order';
          try {
            const j = JSON.parse(text);
            msg = j.description || j.errorType || msg;
          } catch {
            /* keep default */
          }
          throw new Error(msg);
        }
        const uid = JSON.parse(text) as string;

        const rec: CowLimitRecord = {
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
          buyAmount: params.buyAmount.toString(),
          createdAt: Date.now(),
          validTo,
          status: 'open',
        };
        const next = [rec, ...loadRecords(address)].slice(0, MAX_RECORDS);
        saveRecords(address, next);
        setRecords(next);
        toast.success('Limit order placed on CoW — it fills when your price is met. You can close the tab.');
        return uid;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to place order';
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

  // Poll CoW for open-order statuses; persist + surface to the UI.
  const refreshStatuses = useCallback(async () => {
    if (!address) return;
    const current = loadRecords(address);
    if (current.length === 0 || current.every((r) => isTerminalStatus(r.status))) return;
    const updated = await Promise.all(
      current.map(async (r) => {
        if (isTerminalStatus(r.status)) return r;
        try {
          const res = await fetch(cowOrderbookUrl(`orders/${r.uid}`));
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
      // Skip polling while the tab is hidden — mirrors the visibility gate in
      // useDCA / useLimitOrders so background tabs don't hammer the orderbook.
      if (document.visibilityState === 'hidden') return;
      void refreshStatuses();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [address, refreshStatuses]);

  return { placeOrder, isPlacing, records, refreshStatuses };
}
