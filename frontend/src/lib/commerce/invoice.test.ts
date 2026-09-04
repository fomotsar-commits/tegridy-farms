import { describe, it, expect } from 'vitest';
import { invoiceLifecycle, MAX_CLOCK_SKEW_SECONDS, type Invoice } from './invoice';

const NOW = 1_760_000_000;

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-abc234def567',
    merchant: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    settleToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    settleSymbol: 'USDC',
    settleDecimals: 6,
    settleAmount: 100_000_000n,
    memo: '',
    expiresAt: NOW + 900,
    createdAt: NOW - 60,
    ...over,
  };
}

// The other lifecycle states are covered from the plan's side in
// settlement.test.ts. This file exists for the one a self-carrying invoice made
// reachable: before payment links, `createdAt` came from a server that set it,
// so nothing could claim a birthday. Now the document sets its own.
describe('an invoice that dates itself in the future is not open', () => {
  it('refuses a document whose creation time has not arrived', () => {
    const created = NOW + 10 * 24 * 3600;
    expect(invoiceLifecycle(invoice({ createdAt: created, expiresAt: created + 3600 }), NOW)).toBe('future-dated');
  });

  it('still tolerates ordinary clock skew between two consumer devices', () => {
    const created = NOW + MAX_CLOCK_SKEW_SECONDS - 1;
    expect(invoiceLifecycle(invoice({ createdAt: created, expiresAt: created + 3600 }), NOW)).toBe('open');
  });

  it('turns future-dated the moment the skew allowance is exceeded', () => {
    const created = NOW + MAX_CLOCK_SKEW_SECONDS + 1;
    expect(invoiceLifecycle(invoice({ createdAt: created, expiresAt: created + 3600 }), NOW)).toBe('future-dated');
  });

  it('leaves the ordinary states alone', () => {
    expect(invoiceLifecycle(invoice(), NOW)).toBe('open');
    expect(invoiceLifecycle(invoice(), NOW + 901)).toBe('expired');
    // Malformed still wins: a document that is structurally unpayable is not
    // interesting for what its clock says.
    expect(invoiceLifecycle(invoice({ id: 'x', createdAt: NOW + 999_999 }), NOW)).toBe('malformed');
  });
});
