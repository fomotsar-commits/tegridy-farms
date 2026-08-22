import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMetaAggregatorQuotes, DEFAULT_MAX_SLIPPAGE_PCT, type AggregatorQuote } from '../lib/aggregator';
import { buildSettlementPlan, sizePayAmount, type SettlementPlan } from '../lib/commerce/settlement';
import type { Invoice } from '../lib/commerce/invoice';

// Sizing an exact-out payment on exact-in rails, in two round trips.
//
// Every aggregator this venue proxies is EXACT-IN: you say how much goes in and
// it estimates what comes out. A checkout needs the opposite — the merchant is
// owed an exact amount — so the size of the buyer's leg has to be solved for.
//
//   1. PROBE. One quote at a nominal size, used for one thing only: implying a
//      rate. Nothing from the probe is ever shown.
//   2. QUOTE. A second, real quote at the size that rate implies plus headroom.
//      THIS is the only quote `buildSettlementPlan` sees, and every figure on
//      screen comes from it.
//
// The loop stops there. It does not re-size and re-quote until something clears
// the guarantee check, because a solver that iterates toward an acceptable
// number is a solver that will eventually find one the market does not support.
// If the real quote's floored output still falls short of the invoice, the plan
// refuses and says so.
//
// A STALE QUOTE IS A REFUSAL, NOT A STALENESS BADGE. Past MAX_QUOTE_AGE_SECONDS
// the plan refuses on its own and the surface offers a refresh. Nothing here
// silently re-quotes underneath a buyer who is reading a number.

/** Nominal probe size: one whole unit of the pay token. */
function probeAmount(payDecimals: number): bigint {
  return 10n ** BigInt(Math.max(0, Math.min(36, payDecimals)));
}

/** Extra above the implied cost, so ordinary drift does not fail the guarantee. */
export const SIZING_HEADROOM_BPS = 150;

export type CheckoutQuoteStatus = 'idle' | 'quoting' | 'ready' | 'unavailable';

export interface UseCheckoutQuoteOptions {
  /** Null parks the hook in `idle`. */
  invoice: Invoice | null;
  buyer: `0x${string}` | null;
  payToken: `0x${string}` | null;
  paySymbol: string;
  payDecimals: number;
  slippagePct?: number;
  connectedChainId: number | null;
  enabled?: boolean;
}

export interface UseCheckoutQuoteState {
  status: CheckoutQuoteStatus;
  /**
   * Null only in `idle` and `quoting`. In every other state it is a real plan —
   * including a refusing one, which carries the numbers the refusal was made on.
   */
  plan: SettlementPlan | null;
  /** The winning route, for disclosure. Null in the same-asset case. */
  quote: AggregatorQuote | null;
  detail: string | null;
  refresh: () => void;
}

export function useCheckoutQuote(opts: UseCheckoutQuoteOptions): UseCheckoutQuoteState {
  const {
    invoice,
    buyer,
    payToken,
    paySymbol,
    payDecimals,
    slippagePct = DEFAULT_MAX_SLIPPAGE_PCT,
    connectedChainId,
    enabled = true,
  } = opts;

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [state, setState] = useState<Omit<UseCheckoutQuoteState, 'refresh'>>({
    status: 'idle',
    plan: null,
    quote: null,
    detail: null,
  });

  const key = useMemo(
    () =>
      JSON.stringify({
        id: invoice?.id ?? null,
        amount: invoice?.settleAmount.toString() ?? null,
        settle: invoice?.settleToken ?? null,
        chain: invoice?.chainId ?? null,
        payToken,
        payDecimals,
        buyer,
        slippagePct,
        connectedChainId,
      }),
    [invoice, payToken, payDecimals, buyer, slippagePct, connectedChainId],
  );

  useEffect(() => {
    if (!enabled || !invoice || !payToken) {
      setState({ status: 'idle', plan: null, quote: null, detail: null });
      return;
    }

    const sameAsset = payToken.toLowerCase() === invoice.settleToken.toLowerCase();

    // Same asset: there is no route, so there is nothing to quote. Building a
    // plan from a quote here would attach a route's uncertainty to a payment
    // that has none.
    if (sameAsset) {
      const now = Math.floor(Date.now() / 1000);
      setState({
        status: 'ready',
        plan: buildSettlementPlan({
          invoice,
          buyer,
          payToken,
          paySymbol,
          payDecimals,
          payAmount: invoice.settleAmount,
          quote: null,
          quotedAt: now,
          slippagePct,
          now,
          connectedChainId,
        }),
        quote: null,
        detail: null,
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'quoting', plan: null, quote: null, detail: null });

    (async () => {
      const sender = buyer ?? '0x0000000000000000000000000000000000000000';
      try {
        const probe = await getMetaAggregatorQuotes(
          payToken,
          invoice.settleToken,
          probeAmount(payDecimals).toString(),
          sender,
          invoice.chainId,
          slippagePct,
          payDecimals,
          controller.signal,
        );
        if (cancelled) return;

        const sized =
          probe.best === null
            ? null
            : sizePayAmount(
                { amountIn: probeAmount(payDecimals), amountOut: BigInt(probe.best.amountOut) },
                invoice.settleAmount,
                SIZING_HEADROOM_BPS,
              );

        if (sized === null) {
          // No rate could be implied at all. This is not "the price is bad" and
          // must not render as one — the plan refuses with the no-route wording.
          const now = Math.floor(Date.now() / 1000);
          setState({
            status: 'unavailable',
            plan: buildSettlementPlan({
              invoice,
              buyer,
              payToken,
              paySymbol,
              payDecimals,
              payAmount: 0n,
              quote: null,
              quotedAt: now,
              slippagePct,
              now,
              connectedChainId,
            }),
            quote: null,
            detail:
              'No route could price this pair, so no payment amount could be worked out. This is a statement ' +
              'about the routers, not about your balance.',
          });
          return;
        }

        const real = await getMetaAggregatorQuotes(
          payToken,
          invoice.settleToken,
          sized.toString(),
          sender,
          invoice.chainId,
          slippagePct,
          payDecimals,
          controller.signal,
        );
        if (cancelled) return;

        const now = Math.floor(Date.now() / 1000);
        const plan = buildSettlementPlan({
          invoice,
          buyer,
          payToken,
          paySymbol,
          payDecimals,
          payAmount: sized,
          quote: real.best,
          quotedAt: now,
          slippagePct,
          now,
          connectedChainId,
        });
        setState({
          status: real.best === null ? 'unavailable' : 'ready',
          plan,
          quote: real.best,
          detail: real.best === null ? 'No route answered at the size this payment needs.' : null,
        });
      } catch {
        if (cancelled) return;
        const now = Math.floor(Date.now() / 1000);
        setState({
          status: 'unavailable',
          plan: buildSettlementPlan({
            invoice,
            buyer,
            payToken,
            paySymbol,
            payDecimals,
            payAmount: 0n,
            quote: null,
            quotedAt: now,
            slippagePct,
            now,
            connectedChainId,
          }),
          quote: null,
          detail: 'The routers could not be reached, so nothing was priced and nothing is offered to sign.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `key` carries every input that changes the quote; listing the objects
    // themselves would re-quote on every render of a caller that rebuilds one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey, enabled]);

  return { ...state, refresh };
}
