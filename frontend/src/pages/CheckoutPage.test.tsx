// The page's own job is small and load-bearing: read BOTH halves of the URL,
// refuse the ambiguous case, and open on the right tab.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined }),
  useChainId: () => 1,
  usePublicClient: () => undefined,
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  useReadContract: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false, error: null }),
  useBlock: () => ({ data: undefined }),
  useWatchContractEvent: () => undefined,
}));

import { encodePaymentLink } from '../lib/commerce/paymentLink';
import type { Invoice } from '../lib/commerce/invoice';
import CheckoutPage from './CheckoutPage';

const NOW = Math.floor(Date.now() / 1000);

const invoice: Invoice = {
  id: 'inv-abc234def567',
  merchant: MERCHANT,
  chainId: 1,
  settleToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  settleSymbol: 'USDC',
  settleDecimals: 6,
  settleAmount: 100_000_000n,
  memo: '',
  expiresAt: NOW + 900,
  createdAt: NOW - 60,
};

const PAYLOAD = encodePaymentLink(invoice, `0x${'cd'.repeat(65)}`);

function draw(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <CheckoutPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());

describe('a URL that names two invoices is refused, not resolved', () => {
  it('renders the refusal and offers no pay controls', () => {
    draw(`/checkout?invoice=order-1#i=${PAYLOAD}`);
    expect(screen.getByText('This link names two invoices')).toBeInTheDocument();
    expect(screen.getByText(/this page will not choose between them/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
    // Neither document's figures are shown, so nothing can be read off one and
    // paid against the other.
    expect(screen.queryByText(/Invoice inv-abc234def567/)).toBeNull();
  });
});

describe('the tab a visitor lands on follows the link they followed', () => {
  it('opens on Pay for a signed fragment', () => {
    draw(`/checkout#i=${PAYLOAD}`);
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('This link names two invoices')).toBeNull();
  });

  it('opens on Pay for a short link', () => {
    draw('/checkout?invoice=order-1');
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens on Get paid for a merchant arriving cold', () => {
    draw('/checkout');
    expect(screen.getByRole('button', { name: 'Get paid' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /sign the invoice/i })).toBeInTheDocument();
  });

  it('reads an unreadable fragment as a link this build cannot read, never as forged', async () => {
    draw('/checkout#i=garbage');
    expect(await screen.findByText(/This is not a payment link this build can read/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/does not verify/i);
    expect(screen.queryByText('No invoice')).toBeNull();
  });
});

describe('page-level accessibility', () => {
  it('has exactly one h1 and 44px tab targets', () => {
    draw('/checkout');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Checkout');
    for (const label of ['Pay', 'Get paid', 'Subscriptions']) {
      expect(screen.getByRole('button', { name: label }).className).toContain('min-h-11');
    }
  });

  it('never renders the retired brand word', () => {
    draw('/checkout');
    expect(document.body.textContent ?? '').not.toMatch(/tegridy/i);
  });
});
