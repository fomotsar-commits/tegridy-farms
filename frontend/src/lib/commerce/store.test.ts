import { describe, it, expect } from 'vitest';
import {
  CommerceStoreError,
  fetchInvoice,
  fetchSettlements,
  publishInvoice,
  recordSettlement,
} from './store';
import { invoiceToWire, type Invoice } from './invoice';

// The distinction this file exists to hold:
//
//   "no invoice is published under that id"  — the store looked. An ANSWER.
//   "the store could not be asked"           — outage, no config, no migration.
//
// A buyer told the first when the second is true concludes their merchant's
// payment link is a phishing attempt, and the merchant sees a customer who never
// tried to pay. Every failure below therefore throws with its own reason, and
// only one of those reasons is `not-found`.

const INVOICE: Invoice = {
  id: 'order-10231',
  merchant: '0x1111111111111111111111111111111111111111',
  chainId: 1,
  settleToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  settleSymbol: 'USDC',
  settleDecimals: 6,
  settleAmount: 100_000_000n,
  memo: 'one towel',
  expiresAt: 1_760_000_900,
  createdAt: 1_760_000_000,
};

function stub(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

/** Records the URL and init the client actually sent. */
function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof CommerceStoreError ? err.reason : 'not-a-store-error';
  }
}

describe('the four ways a lookup can end are four different answers', () => {
  it('returns the invoice on a 200', async () => {
    const inv = await fetchInvoice('order-10231', {
      fetchImpl: stub(200, { invoice: invoiceToWire(INVOICE) }),
    });
    expect(inv.settleAmount).toBe(100_000_000n);
    expect(inv.merchant).toBe(INVOICE.merchant);
  });

  it('reports not-found ONLY for the 404 the server marks as an answer', async () => {
    expect(
      await reasonOf(
        fetchInvoice('order-10231', {
          fetchImpl: stub(404, { error: 'No invoice is published under that id.', code: 'not-found' }),
        }),
      ),
    ).toBe('not-found');
  });

  it('reports a missing migration as schema-missing, never as not-found', async () => {
    expect(
      await reasonOf(
        fetchInvoice('order-10231', {
          fetchImpl: stub(503, { error: 'tables do not exist', code: 'schema-missing', operatorStep: 'apply 021' }),
        }),
      ),
    ).toBe('schema-missing');
  });

  it('carries the operator step so the fix is attached to the failure', async () => {
    try {
      await fetchInvoice('order-10231', {
        fetchImpl: stub(503, { error: 'tables do not exist', code: 'schema-missing', operatorStep: 'apply 021' }),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CommerceStoreError).operatorStep).toBe('apply 021');
    }
  });

  it('reports an unconfigured deployment as not-configured', async () => {
    expect(
      await reasonOf(
        fetchInvoice('x', { fetchImpl: stub(503, { error: 'no store', code: 'not-configured' }) }),
      ),
    ).toBe('not-configured');
  });

  it('reports a network failure as unreachable', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await reasonOf(fetchInvoice('x', { fetchImpl: boom }))).toBe('unreachable');
  });

  it('refuses a row it cannot parse rather than returning a half invoice', async () => {
    expect(
      await reasonOf(
        fetchInvoice('x', {
          fetchImpl: stub(200, { invoice: { ...invoiceToWire(INVOICE), settleAmount: '12.5' } }),
        }),
      ),
    ).toBe('malformed');
  });

  it('never resolves to null — a caller must catch not-found to get one', async () => {
    expect(
      await reasonOf(fetchInvoice('x', { fetchImpl: stub(404, { error: 'gone', code: 'not-found' }) })),
    ).not.toBe('resolved');
  });
});

describe('publishing never lets a caller name somebody else as payee', () => {
  it('sends no merchant field — the server takes it from the session', async () => {
    const { calls, fetchImpl } = recorder(201, { invoice: invoiceToWire(INVOICE) });
    await publishInvoice(
      {
        id: INVOICE.id,
        chainId: 1,
        settleToken: INVOICE.settleToken,
        settleSymbol: 'USDC',
        settleDecimals: 6,
        settleAmount: '100000000',
        memo: '',
        expiresAt: INVOICE.expiresAt,
      },
      { fetchImpl },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Object.keys(body)).not.toContain('merchant');
  });

  it('returns what the DATABASE stored, not what was asked for', async () => {
    const stored = { ...INVOICE, settleAmount: 99_000_000n };
    const stored2 = await publishInvoice(
      {
        id: INVOICE.id,
        chainId: 1,
        settleToken: INVOICE.settleToken,
        settleSymbol: 'USDC',
        settleDecimals: 6,
        settleAmount: '100000000',
        memo: '',
        expiresAt: INVOICE.expiresAt,
      },
      { fetchImpl: stub(201, { invoice: invoiceToWire(stored) }) },
    );
    expect(stored2.settleAmount).toBe(99_000_000n);
  });
});

describe('a settlement is echoed as whatever the server was willing to call it', () => {
  it('does not upgrade the verification the server returned', async () => {
    const res = await recordSettlement(
      { invoiceId: 'order-10231', txHash: `0x${'ab'.repeat(32)}`, payer: INVOICE.merchant },
      { fetchImpl: stub(201, { verification: 'client-reported', webhook: null }) },
    );
    expect(res.verification).toBe('client-reported');
  });

  it('falls back to client-reported when the server says nothing, never to confirmed', async () => {
    const res = await recordSettlement(
      { invoiceId: 'order-10231', txHash: `0x${'ab'.repeat(32)}`, payer: INVOICE.merchant },
      { fetchImpl: stub(201, {}) },
    );
    expect(res.verification).toBe('client-reported');
  });

  it('carries the webhook outcome verbatim, including that it will not be retried', async () => {
    const res = await recordSettlement(
      { invoiceId: 'order-10231', txHash: `0x${'ab'.repeat(32)}`, payer: INVOICE.merchant },
      {
        fetchImpl: stub(201, {
          verification: 'client-reported',
          webhook: { attempted: true, delivered: false, retries: 'none', detail: 'answered 500' },
        }),
      },
    );
    expect(res.webhook).toEqual({ attempted: true, delivered: false, retries: 'none', detail: 'answered 500' });
  });
});

describe('an empty settlement list is an answer; a failed read is not', () => {
  it('returns an empty list on a successful read', async () => {
    const res = await fetchSettlements('order-10231', {
      fetchImpl: stub(200, { settlements: [], notice: 'claims only' }),
    });
    expect(res.settlements).toEqual([]);
    expect(res.notice).toBe('claims only');
  });

  it('throws rather than returning an empty list when the store could not be read', async () => {
    expect(await reasonOf(fetchSettlements('order-10231', { fetchImpl: stub(502, { error: 'down' }) }))).toBe(
      'unreachable',
    );
  });

  it('echoes each row’s verification rather than defaulting it to something friendlier', async () => {
    const res = await fetchSettlements('order-10231', {
      fetchImpl: stub(200, {
        settlements: [{ invoice_id: 'order-10231', tx_hash: '0xabc', payer: '0xdef', verification: 'chain-refuted', recorded_at: 1 }],
        notice: 'claims only',
      }),
    });
    expect(res.settlements[0]!.verification).toBe('chain-refuted');
  });

  it('asks for exactly one invoice id, never for a list', async () => {
    const { calls, fetchImpl } = recorder(200, { settlements: [], notice: '' });
    await fetchSettlements('order-10231', { fetchImpl });
    expect(calls[0]!.url).toContain('action=settlements');
    expect(calls[0]!.url).toContain('id=order-10231');
  });
});
