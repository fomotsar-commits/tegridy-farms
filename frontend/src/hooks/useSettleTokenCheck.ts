import { useCallback, useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { ERC20_ABI } from '../lib/contracts';
import type { Invoice } from '../lib/commerce/invoice';
import {
  judgeSettleToken,
  type SettleTokenRead,
  type SettleTokenStanding,
} from '../lib/commerce/settleTokens';

// Asking the chain whether the address the invoice signed really is the token
// the invoice named.
//
// ─── WHY `getCode` AND NOT JUST `symbol()` ──────────────────────────────────
//
// If nothing is deployed at the address, `symbol()` and `decimals()` both revert
// — and a reverted call is indistinguishable from an RPC that did not answer if
// you only look at the failure. That would collapse "there is no contract there"
// (a fact about the chain, and a refusal) into "we could not ask" (a fact about
// this browser, and a retry). So the code read comes first and answers the
// question the other two cannot.
//
// ─── WHY BOTH READS ARE SETTLED, NOT RACED ──────────────────────────────────
//
// `allSettled`, so one call failing does not erase the other's answer. A token
// whose `symbol()` reverts but whose `decimals()` returns 6 is a PARTIAL read,
// and settleTokens.ts judges a partial read as `unread` rather than convicting
// on the half it has.

export interface SettleTokenCheck {
  status: 'idle' | 'reading' | 'done';
  /** Null until `done`. Never a default — 'matches' is a claim, not a placeholder. */
  verdict: SettleTokenStanding | null;
  retry: () => void;
}

export function useSettleTokenCheck(invoice: Invoice | null, enabled = true): SettleTokenCheck {
  const publicClient = usePublicClient({ chainId: invoice?.chainId });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const [state, setState] = useState<{ status: SettleTokenCheck['status']; verdict: SettleTokenStanding | null }>({
    status: 'idle',
    verdict: null,
  });

  const token = invoice?.settleToken ?? null;
  const chainId = invoice?.chainId ?? null;
  const symbol = invoice?.settleSymbol ?? null;
  const decimals = invoice?.settleDecimals ?? null;

  useEffect(() => {
    if (!enabled || !invoice) {
      setState({ status: 'idle', verdict: null });
      return;
    }
    const client = publicClient;
    if (!client) {
      setState({
        status: 'done',
        verdict: judgeSettleToken(invoice, {
          kind: 'unread',
          detail: `this build has no RPC for chain ${invoice.chainId}`,
        }),
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'reading', verdict: null });

    void (async () => {
      let read: SettleTokenRead;
      try {
        const code = await client.getCode({ address: invoice.settleToken });
        const hasCode = typeof code === 'string' && code !== '0x' && !/^0x0*$/.test(code);
        if (!hasCode) {
          read = { kind: 'read', hasCode: false, symbol: null, decimals: null };
        } else {
          const [sym, dec] = await Promise.allSettled([
            client.readContract({ address: invoice.settleToken, abi: ERC20_ABI, functionName: 'symbol' }),
            client.readContract({ address: invoice.settleToken, abi: ERC20_ABI, functionName: 'decimals' }),
          ]);
          read = {
            kind: 'read',
            hasCode: true,
            symbol: sym.status === 'fulfilled' && typeof sym.value === 'string' ? sym.value : null,
            decimals: dec.status === 'fulfilled' && typeof dec.value === 'number' ? dec.value : null,
          };
        }
      } catch (err) {
        // The code read itself failed, so nothing at all is known.
        read = { kind: 'unread', detail: (err as Error)?.message ?? 'the token could not be read' };
      }
      if (cancelled) return;
      setState({ status: 'done', verdict: judgeSettleToken(invoice, read) });
    })();

    return () => {
      cancelled = true;
    };
    // The four SIGNED fields the verdict is computed from, plus the transport.
    // Listing `invoice` itself would re-read on every render of a caller that
    // rebuilds the object, and every field of it except these four is irrelevant
    // to what the chain is being asked.
    //
    // wagmi memoises `publicClient` per chain, so it is a real dependency rather
    // than a re-render trigger. A test double that rebuilt it each render would
    // be LESS stable than the thing it stands in for, and would loop here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, chainId, symbol, decimals, publicClient, enabled, attempt]);

  return { ...state, retry };
}
