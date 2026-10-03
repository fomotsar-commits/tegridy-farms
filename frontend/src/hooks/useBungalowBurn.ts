import { useCallback, useEffect, useState } from 'react';
import { useReadContracts } from 'wagmi';
import type { Bungalow } from '../lib/bungalows';
import { ERC20_ABI } from '../lib/contracts';
import {
  EVM_BURN_ADDRESS,
  burnFactFor,
  tallyBurn,
  type BurnMismatch,
  type BurnReading,
  type BurnTally,
} from '../lib/bungalowBurn';
import { readSolanaSupply } from '../lib/bungalowBurnSolana';

const EVM_CHAIN_IDS: Partial<Record<Bungalow['chain'], number>> = { ethereum: 1, base: 8453 };
const PLACEHOLDER_ADDR = '0x0000000000000000000000000000000000000001' as const;

/**
 * A bungalow token's burn, read from its own chain with no wallet.
 * `idle` = no token or no record. `unread` = the chain did not answer in full.
 * `mismatch` = it answered, and the answer contradicts the minted record.
 */
export type BungalowBurn =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unread' }
  | { status: 'mismatch'; reason: BurnMismatch }
  | { status: 'read'; tally: Extract<BurnTally, { ok: true }> };

export interface BungalowBurnResult {
  burn: BungalowBurn;
  /** A read is in flight, first or repeat. */
  isReading: boolean;
  /** Read again on demand. Nothing here reads on a timer or on tab focus. */
  refresh: () => void;
}

type SolanaOutcome = { mint: string; reading: BurnReading | null };

/** `null` (no bungalow) is idle, like a lot with no token: nothing is read. */
export function useBungalowBurn(bungalow: Bungalow | null): BungalowBurnResult {
  const fact = bungalow ? burnFactFor(bungalow) : null;
  const evmChainId = (bungalow && EVM_CHAIN_IDS[bungalow.chain]) ?? null;
  const evmEnabled = fact !== null && evmChainId !== null;
  const solanaMint = fact !== null && bungalow?.chain === 'solana' ? (bungalow.address ?? null) : null;

  // EVM: one multicall on the TOKEN's chain, whatever chain the visitor's wallet is on.
  // The batch shape is static, since a conditional entry collapses wagmi's tuple types.
  const token = (evmEnabled ? bungalow?.address : PLACEHOLDER_ADDR) as `0x${string}`;
  const chainId = evmChainId ?? 1;
  const { data, isError, isFetching, refetch } = useReadContracts({
    contracts: [
      { address: token, abi: ERC20_ABI, chainId, functionName: 'totalSupply' },
      { address: token, abi: ERC20_ABI, chainId, functionName: 'decimals' },
      { address: token, abi: ERC20_ABI, chainId, functionName: 'balanceOf', args: [EVM_BURN_ADDRESS] },
      // The contract's balance of its own token. Always asked, used only where the record counts it.
      { address: token, abi: ERC20_ABI, chainId, functionName: 'balanceOf', args: [token] },
    ],
    // staleTime 0: every mount reads, even when another mount of this token left a figure cached.
    query: { enabled: evmEnabled, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false },
  });

  // Solana: one getTokenSupply. `reading: null` is a failed read, kept apart from "not yet".
  const [solana, setSolana] = useState<SolanaOutcome | null>(null);
  const [solanaReading, setSolanaReading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!solanaMint) return;
    const controller = new AbortController();
    let cancelled = false;
    // Deferred so the first setState is not synchronous inside the effect body.
    queueMicrotask(async () => {
      if (cancelled) return;
      setSolanaReading(true);
      let reading: BurnReading | null;
      try {
        reading = await readSolanaSupply(solanaMint, controller.signal);
      } catch {
        reading = null;
      }
      if (cancelled) return;
      setSolana({ mint: solanaMint, reading });
      setSolanaReading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [solanaMint, nonce]);

  const refresh = useCallback(() => {
    if (evmEnabled) void refetch();
    else setNonce((n) => n + 1);
  }, [evmEnabled, refetch]);

  if (!fact) return { burn: { status: 'idle' }, isReading: false, refresh };

  if (evmEnabled) {
    // A read that failed as a whole is unread even if an older answer is still held.
    if (isError) return { burn: { status: 'unread' }, isReading: isFetching, refresh };
    if (!data) return { burn: { status: 'loading' }, isReading: isFetching, refresh };
    // Per-entry status is the signal: a dead RPC comes back as failed entries, not as isError.
    const supply = data[0]?.status === 'success' ? data[0].result : null;
    const decimals = data[1]?.status === 'success' ? data[1].result : null;
    const atBurnAddress = data[2]?.status === 'success' ? data[2].result : null;
    const inOwnContract = data[3]?.status === 'success' ? data[3].result : null;
    if (typeof supply !== 'bigint' || typeof decimals !== 'number' || typeof atBurnAddress !== 'bigint') {
      return { burn: { status: 'unread' }, isReading: isFetching, refresh };
    }
    const reading: BurnReading = { supplyRaw: supply, decimals, atBurnAddressRaw: atBurnAddress };
    if (fact.countsOwnBalance) {
      // A counted leg that did not land makes the burn unread, never smaller.
      if (typeof inOwnContract !== 'bigint') return { burn: { status: 'unread' }, isReading: isFetching, refresh };
      reading.inOwnContractRaw = inOwnContract;
    }
    return { burn: toBurn(tallyBurn(fact, reading)), isReading: isFetching, refresh };
  }

  if (!solanaMint) return { burn: { status: 'idle' }, isReading: false, refresh };
  const mine = solana && solana.mint === solanaMint ? solana : null;
  if (!mine) return { burn: { status: 'loading' }, isReading: true, refresh };
  if (!mine.reading) return { burn: { status: 'unread' }, isReading: solanaReading, refresh };
  return { burn: toBurn(tallyBurn(fact, mine.reading)), isReading: solanaReading, refresh };
}

function toBurn(tally: BurnTally): BungalowBurn {
  return tally.ok ? { status: 'read', tally } : { status: 'mismatch', reason: tally.reason };
}
