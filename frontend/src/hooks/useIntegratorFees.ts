// Reads what our launcher integrator can currently withdraw from the Doppler Airlock.
//
// `integratorFees.ts` has existed — and been correct — with ZERO consumers. Its own
// header records that `Airlock.collectIntegratorFees` was live on-chain with nothing in
// the repo calling it; the module was written to fix that and was then never wired to a
// surface, so the same gap simply moved up a layer. This hook closes it.
//
// WHICH CURRENCIES. Airlock fees accrue per (integrator, token) pair, and `token` is
// both the NUMERAIRE a launch was paired against AND the launched asset itself. Reading
// only the numeraires would under-report revenue — the precise failure mode the
// getIntegratorFees fix just removed — so the asset side is enumerated too, via the same
// `readOurLaunches` the Launch page already uses.
//
// Asset discovery degrades to empty rather than throwing (an `eth_getLogs` window can
// fail or be capped), and that degradation is REPORTED: `assetsUnavailable` lets the UI
// say "numeraires only" instead of implying the list is complete. "We could not look"
// and "there is nothing there" must never render the same, which is the whole ethos of
// the module underneath.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address, PublicClient } from 'viem';
import { readClaimableFees, NATIVE_CURRENCY } from '../lib/launcher/integratorFees';
import { readOurLaunches } from '../lib/launcher/ourLaunches';
import { allowedNumeraires } from '../lib/launcher/config';
import { ERC20_ABI } from '../lib/contracts';
import { TOWELI_ADDRESS, TOWELI_DECIMALS, CHAIN_ID } from '../lib/constants';

/** A claimable balance, decorated with what the UI needs to render it honestly. */
export interface DecoratedFee {
  currency: Address;
  amount: bigint;
  /** Ticker for display. Falls back to a shortened address when unreadable. */
  symbol: string;
  /** ERC20 decimals; 18 for native ETH. */
  decimals: number;
}

export interface UseIntegratorFeesResult {
  fees: DecoratedFee[];
  isLoading: boolean;
  /** Set when the fee read itself failed — distinct from "read fine, nothing owed". */
  error: string | null;
  /** True when launch-asset discovery failed, so only numeraires were checked. */
  assetsUnavailable: boolean;
  /** How many currencies were actually queried, for an honest empty state. */
  checkedCount: number;
  /**
   * Currencies whose balance could not be read. An empty `fees` list means "nothing to
   * claim" ONLY when this is also empty — otherwise the truthful statement is "we do not
   * know", and the UI must say so rather than showing a confident zero.
   */
  unreadable: Address[];
  refetch: () => void;
}

/** Native ETH renders as ETH/18 — it has no contract to read metadata from. */
const NATIVE_META = { symbol: 'ETH', decimals: 18 };

/**
 * Resolve `symbol`/`decimals` for the currencies that have a contract.
 * A failed metadata read is cosmetic, never fatal: the balance is still real and still
 * withdrawable, so it falls back to a shortened address and 18 decimals rather than
 * dropping the row. TOWELI is known statically and costs no call.
 */
async function decorate(
  client: PublicClient,
  fees: readonly { currency: Address; amount: bigint }[],
): Promise<DecoratedFee[]> {
  const needsRead = fees.filter(
    (f) =>
      f.currency.toLowerCase() !== NATIVE_CURRENCY.toLowerCase() &&
      f.currency.toLowerCase() !== TOWELI_ADDRESS.toLowerCase(),
  );

  const meta = new Map<string, { symbol: string; decimals: number }>();
  if (needsRead.length > 0) {
    try {
      const results = await client.multicall({
        contracts: needsRead.flatMap((f) => [
          { address: f.currency, abi: ERC20_ABI, functionName: 'symbol' as const },
          { address: f.currency, abi: ERC20_ABI, functionName: 'decimals' as const },
        ]),
        allowFailure: true,
      });
      needsRead.forEach((f, i) => {
        const sym = results[i * 2];
        const dec = results[i * 2 + 1];
        meta.set(f.currency.toLowerCase(), {
          symbol: sym?.status === 'success' && typeof sym.result === 'string' ? sym.result : shortCurrency(f.currency),
          decimals: dec?.status === 'success' && typeof dec.result === 'number' ? dec.result : 18,
        });
      });
    } catch {
      // Leave `meta` empty — every row falls through to the address/18 default below.
    }
  }

  return fees.map((f) => {
    const key = f.currency.toLowerCase();
    if (key === NATIVE_CURRENCY.toLowerCase()) return { ...f, ...NATIVE_META };
    if (key === TOWELI_ADDRESS.toLowerCase()) return { ...f, symbol: 'TOWELI', decimals: TOWELI_DECIMALS };
    return { ...f, ...(meta.get(key) ?? { symbol: shortCurrency(f.currency), decimals: 18 }) };
  });
}

function shortCurrency(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Claimable integrator fees for {@link LAUNCHER_INTEGRATOR_ADDRESS}.
 *
 * Always reads OUR integrator's row regardless of which wallet is connected — the
 * balance is public on-chain state, and showing it to an operator who cannot yet sign
 * is strictly better than hiding revenue behind a wallet switch. Only the WITHDRAW is
 * restricted, and that restriction is the contract's own (`collectIntegratorFees`
 * debits `msg.sender`), not something this hook has to enforce.
 */
export function useIntegratorFees(enabled: boolean): UseIntegratorFeesResult {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [fees, setFees] = useState<DecoratedFee[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetsUnavailable, setAssetsUnavailable] = useState(false);
  const [checkedCount, setCheckedCount] = useState(0);
  const [unreadable, setUnreadable] = useState<Address[]>([]);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // Guards against a slow in-flight read landing after unmount or after a newer read.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !publicClient) return;
    const runId = ++runIdRef.current;
    const ac = new AbortController();

    void (async () => {
      // Inside the async body, not the effect body: setState directly in an effect
      // triggers the cascading-render lint (react-hooks/set-state-in-effect), and the
      // loading flag belongs to the fetch's lifecycle rather than to mounting.
      setIsLoading(true);
      setError(null);
      try {
        const numeraires = allowedNumeraires();

        // Asset side. `readOurLaunches` NEVER throws — every failure degrades to an
        // empty result — so a try/catch here would be dead code and `assetsFailed` would
        // be permanently false. Its `complete` flag is the only real signal, and it is
        // false whenever the scan could not finish (getLogs failed, aborted, or any one
        // asset's provenance was unreadable under its all-or-nothing rule).
        const { baselines, complete } = await readOurLaunches({
          client: publicClient,
          signal: ac.signal,
        });
        const assets: Address[] = baselines.map((b) => b.token as Address);
        const assetsFailed = !complete;
        if (ac.signal.aborted || runIdRef.current !== runId) return;

        // De-dupe case-insensitively: an asset could equal a numeraire in principle,
        // and a duplicated contract entry would double-count the same balance.
        const seen = new Set<string>();
        const currencies: Address[] = [];
        for (const c of [...numeraires, ...assets]) {
          const k = c.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          currencies.push(c);
        }

        const { fees: raw, unreadable: failed } = await readClaimableFees(publicClient, currencies);
        if (ac.signal.aborted || runIdRef.current !== runId) return;

        const decorated = await decorate(publicClient, raw);
        if (ac.signal.aborted || runIdRef.current !== runId) return;

        setFees(decorated);
        setCheckedCount(currencies.length);
        setAssetsUnavailable(assetsFailed);
        setUnreadable(failed);
      } catch (e) {
        if (ac.signal.aborted || runIdRef.current !== runId) return;
        setError((e as { shortMessage?: string; message?: string })?.shortMessage
          || (e as { message?: string })?.message
          || 'Could not read integrator fees.');
      } finally {
        if (runIdRef.current === runId) setIsLoading(false);
      }
    })();

    return () => ac.abort();
  }, [enabled, publicClient, nonce]);

  return { fees, isLoading, error, assetsUnavailable, checkedCount, unreadable, refetch };
}
