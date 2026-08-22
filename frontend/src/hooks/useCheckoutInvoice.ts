import { useCallback, useEffect, useState } from 'react';
import { CommerceStoreError, fetchInvoice, type CommerceStoreReason } from '../lib/commerce/store';
import { invoiceLifecycle, type Invoice, type InvoiceLifecycle } from '../lib/commerce/invoice';

// Resolving a payment link to the invoice behind it.
//
// FOUR STATES, and the two failure ones are kept apart on purpose:
//
//   `missing`     the store looked and has no such invoice. A fact about the id.
//   `unavailable` the store could not be asked — outage, no configuration, or a
//                 table that was never created. A fact about this deployment.
//
// Collapsing those is the damaging bug on a checkout. A buyer who followed a
// real link from a real merchant would be told the invoice does not exist, would
// conclude they had been phished, and the merchant would see a customer who
// never tried to pay. lib/commerce/store.ts throws on every failure precisely so
// this hook has to name which one it is.
//
// THE STORE IS BEHIND A MIGRATION APPLIED BY HAND. Until `021_commerce.sql` is
// run, every call answers 503 `schema-missing`, and this reports `unavailable`
// with the operator's next step attached — never "no such invoice".

export type CheckoutInvoiceStatus = 'idle' | 'loading' | 'found' | 'missing' | 'unavailable';

export interface UseCheckoutInvoiceState {
  status: CheckoutInvoiceStatus;
  /** Non-null only in `found`. */
  invoice: Invoice | null;
  /** Null until an invoice is in hand. */
  lifecycle: InvoiceLifecycle | null;
  /** Plain-language reason, set in `missing` and `unavailable`. */
  detail: string | null;
  /** Which failure it is, for callers that branch on more than the sentence. */
  reason: CommerceStoreReason | null;
  /** The operator's next step when the server named one. */
  operatorStep: string | null;
  reload: () => void;
}

export interface UseCheckoutInvoiceOptions {
  /** Null parks the hook in `idle` without asking anything. */
  invoiceId: string | null;
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
}

export function useCheckoutInvoice(opts: UseCheckoutInvoiceOptions): UseCheckoutInvoiceState {
  const { invoiceId, fetchImpl } = opts;
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [state, setState] = useState<Omit<UseCheckoutInvoiceState, 'reload'>>({
    status: 'idle',
    invoice: null,
    lifecycle: null,
    detail: null,
    reason: null,
    operatorStep: null,
  });

  useEffect(() => {
    if (!invoiceId) {
      setState({ status: 'idle', invoice: null, lifecycle: null, detail: null, reason: null, operatorStep: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading', invoice: null, lifecycle: null, detail: null, reason: null, operatorStep: null });

    (async () => {
      try {
        const invoice = await fetchInvoice(invoiceId, { signal: controller.signal, fetchImpl });
        if (cancelled) return;
        setState({
          status: 'found',
          invoice,
          // Evaluated once here rather than on every render: a lifecycle that
          // flips mid-render would let a surface draw a pay button beside an
          // expired banner. The page re-checks against its own clock before it
          // builds a plan — see lib/commerce/settlement.ts.
          lifecycle: invoiceLifecycle(invoice, Math.floor(Date.now() / 1000)),
          detail: null,
          reason: null,
          operatorStep: null,
        });
      } catch (err) {
        if (cancelled) return;
        const storeErr = err instanceof CommerceStoreError ? err : null;
        const isMissing = storeErr?.reason === 'not-found';
        setState({
          status: isMissing ? 'missing' : 'unavailable',
          invoice: null,
          lifecycle: null,
          detail:
            storeErr?.message ??
            'The invoice store could not be read. Nothing here is a statement about whether this invoice exists.',
          reason: storeErr?.reason ?? 'unreachable',
          operatorStep: storeErr?.operatorStep ?? null,
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [invoiceId, reloadKey, fetchImpl]);

  return { ...state, reload };
}
