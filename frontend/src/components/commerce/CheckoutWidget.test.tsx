// The buyer's screen, tested for the collapses rather than for the happy path.
//
// Every case below is a pair of states that a naive implementation renders
// identically — forged vs unverifiable, no-code vs unread, a short balance vs a
// balance nobody read, a confirmed transfer vs one that delivered less — and
// each assertion checks BOTH that the right sentence is there and that the wrong
// one is not.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, type Log } from 'viem';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;
const BUYER = '0x2222222222222222222222222222222222222222' as const;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

// ─── The wagmi surface, entirely under this file's control ──────────────────

interface Harness {
  chainId: number;
  code: string | Promise<string>;
  symbol: unknown;
  decimals: unknown;
  readFails: boolean;
  balance: bigint | undefined;
  balanceLoading: boolean;
  balanceError: boolean;
  receipt: { status: 'success' | 'reverted'; logs: Log[]; blockNumber: bigint } | undefined;
  block: { timestamp: bigint } | undefined;
}

const h: Harness = {
  chainId: 1,
  code: '0x60006000',
  symbol: 'WETH',
  decimals: 18,
  readFails: false,
  balance: undefined,
  balanceLoading: false,
  balanceError: false,
  receipt: undefined,
  block: undefined,
};

// ONE object for the whole file, because real wagmi memoises its public client
// per chain. A double that returned a fresh object each render would be less
// stable than the thing it stands in for and would manufacture a render loop
// that cannot happen in production.
const publicClient = {
  getCode: () => Promise.resolve(h.code),
  readContract: ({ functionName }: { functionName: string }) =>
    h.readFails
      ? Promise.reject(new Error('rpc did not answer'))
      : Promise.resolve(functionName === 'symbol' ? h.symbol : h.decimals),
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: BUYER, isConnected: true, chain: { id: h.chainId } }),
  useChainId: () => h.chainId,
  usePublicClient: () => publicClient,
  useReadContract: () => ({
    data: h.balance,
    isLoading: h.balanceLoading,
    isError: h.balanceError,
    refetch: vi.fn(),
  }),
  useWriteContract: () => ({
    writeContract: vi.fn(),
    data: h.receipt ? HASH : undefined,
    isPending: false,
    reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: h.receipt,
    isLoading: false,
    isSuccess: h.receipt !== undefined,
    isError: false,
    error: null,
  }),
  useBlock: () => ({ data: h.block }),
}));

import type { Invoice } from '../../lib/commerce/invoice';
import type { PaymentLinkState } from '../../hooks/usePaymentLink';
import { CheckoutWidget } from './CheckoutWidget';

const HASH = `0x${'ab'.repeat(32)}` as const;
const NOW = Math.floor(Date.now() / 1000);

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-abc234def567',
    merchant: MERCHANT,
    chainId: 1,
    // WETH so the default pay token IS the settlement asset: the same-asset
    // branch needs no route and therefore no network in any of these tests.
    settleToken: WETH,
    settleSymbol: 'WETH',
    settleDecimals: 18,
    settleAmount: 10n ** 18n,
    memo: 'one towel, delivered',
    expiresAt: NOW + 900,
    createdAt: NOW - 60,
    ...over,
  };
}

function verified(over: Partial<Invoice> = {}): PaymentLinkState {
  return {
    status: 'verified',
    invoice: invoice(over),
    signature: `0x${'cd'.repeat(65)}`,
    payload: 'PAYLOAD',
    tx: null,
  };
}

function transferLog(value: bigint, token: `0x${string}` = WETH): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: BUYER, to: MERCHANT } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: 21_000_000n,
    blockHash: pad('0x01', { size: 32 }),
    transactionHash: HASH,
    transactionIndex: 1,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function draw(link: PaymentLinkState, invoiceId: string | null = null) {
  return render(
    <MemoryRouter>
      <CheckoutWidget invoiceId={invoiceId} link={link} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.chainId = 1;
  h.code = '0x60006000';
  h.symbol = 'WETH';
  h.decimals = 18;
  h.readFails = false;
  h.balance = 10n ** 18n;
  h.balanceLoading = false;
  h.balanceError = false;
  h.receipt = undefined;
  h.block = undefined;
});

describe('the link is judged before any figure is a debt', () => {
  it('says there is nothing to pay when no link arrived', () => {
    draw({ status: 'none' });
    expect(screen.getByText('No invoice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
  });

  it('refuses a forged link in rose, with no pay control anywhere', async () => {
    draw({ status: 'forged', merchant: MERCHANT });
    expect(await screen.findByText('This link does not verify')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(MERCHANT))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
    // Not the "no link at all" copy: this link exists and was checked.
    expect(screen.queryByText('No invoice')).toBeNull();
  });

  it('offers a retry for an unverifiable link and never says forged', async () => {
    draw({
      status: 'unverifiable',
      invoice: invoice(),
      detail: 'rpc: 429 rate limited',
      retry: vi.fn(),
    });
    const retry = await screen.findByRole('button', { name: /try again/i });
    expect(retry).toBeInTheDocument();
    expect(retry.className).toContain('min-h-11');
    expect(screen.getByText(/about this browser's connection/i)).toBeInTheDocument();
    // The collapse: an outage rendered as an accusation.
    expect(document.body.textContent ?? '').not.toMatch(/does not verify/i);
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
  });

  it('shows the FULL merchant address and labels the memo as unchecked', async () => {
    draw(verified());
    expect(await screen.findByText(/Signed by 0x[a-fA-F0-9]{40} on chain 1/)).toBeInTheDocument();
    expect(screen.getByText(/compare the address with the one your merchant gave you/i)).toBeInTheDocument();
    expect(screen.getByText("Merchant's note — signed, not checked")).toBeInTheDocument();
    expect(screen.getByText('one towel, delivered')).toBeInTheDocument();
  });
});

describe('the signed token is re-read, and the failures stay apart', () => {
  it('refuses an address with no bytecode and offers nothing to sign', async () => {
    h.code = '0x';
    draw(verified());
    expect(await screen.findByText('There is no contract at that address')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
    // NOT the mismatch sentence: nothing is there to have the wrong symbol.
    expect(document.body.textContent ?? '').not.toMatch(/not the token this invoice names/i);
  });

  it('offers a retry when the token reads fail, and does not call it a mismatch', async () => {
    h.readFails = true;
    draw(verified());
    expect(await screen.findByText('The settlement token could not be read')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /try again/i });
    expect(retry.className).toContain('min-h-11');
    expect(document.body.textContent ?? '').not.toMatch(/not the token this invoice names/i);
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
  });

  it('refuses a contract whose decimals disagree with the signed figure', async () => {
    h.decimals = 6;
    draw(verified());
    expect(await screen.findByText('That address is not the token this invoice names')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
  });

  it('offers the pay control once the chain agrees with the document', async () => {
    draw(verified());
    const pay = await screen.findByRole('button', { name: /pay the exact amount/i });
    expect(pay.className).toContain('min-h-11');
  });
});

describe('a balance nobody read is not a balance of zero', () => {
  it('never sends the buyer to the trade page on a failed read', async () => {
    h.balance = undefined;
    h.balanceError = true;
    draw(verified());
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i }).className).toContain('min-h-11');
    // The original bug: `undefined` treated as a short balance.
    expect(document.body.textContent ?? '').not.toMatch(/the trade page/i);
    expect(screen.queryByRole('button', { name: /pay the exact amount/i })).toBeNull();
  });

  it('sends the buyer to the trade page only when a real balance came back short', async () => {
    h.balance = 10n ** 18n - 1n;
    draw(verified());
    expect(await screen.findByText(/Step 1 happens on the trade surface/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /the trade page/i })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/could not be read/i);
  });
});

describe('a chain the routers were never asked about is not the routers\' fault', () => {
  it('offers only the settlement asset on chain 8453 and says why', async () => {
    h.chainId = 8453;
    h.symbol = 'USDC';
    h.decimals = 6;
    h.balance = 100_000_000n;
    const base = invoice({
      chainId: 8453,
      settleToken: USDC,
      settleSymbol: 'USDC',
      settleDecimals: 6,
      settleAmount: 100_000_000n,
    });
    draw({ status: 'verified', invoice: base, signature: `0x${'cd'.repeat(65)}`, payload: 'P', tx: null });
    const select = await screen.findByLabelText(/pay in/i);
    const options = within(select as HTMLElement).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('USDC');
    expect(screen.getByText(/Routes are quoted on Ethereum only in this build/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/statement about the routers/i);
  });
});

describe('the receipt is judged from its logs, not announced from its status', () => {
  it('refutes a transfer that delivered less than the invoice, naming both figures', async () => {
    h.receipt = { status: 'success', logs: [transferLog(10n ** 18n - 1n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(NOW) };
    draw(verified());
    expect(await screen.findByText(/does NOT contain the transfer to you/i)).toBeInTheDocument();
    expect(screen.getByText(/fee on transfer/i)).toBeInTheDocument();
    // The sentence a status-only implementation would have printed.
    expect(document.body.textContent ?? '').not.toMatch(/the transfer to you was found in it/i);
  });

  it('confirms an exact transfer and dates it by the BLOCK, not by this clock', async () => {
    // Inside the invoice's own window: a timestamp before `createdAt` is a
    // refutation, which receiptProof.test.ts pins separately.
    const minedAt = NOW + 30;
    h.receipt = { status: 'success', logs: [transferLog(10n ** 18n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(minedAt) };
    draw(verified());
    expect(await screen.findByText(/the transfer to you was found in it/i)).toBeInTheDocument();
    expect(screen.getByText(/As of block 21000000/)).toBeInTheDocument();
    // The BLOCK's time, rendered exactly — a surface that printed Date.now()
    // would drift from this by however long the test took to get here.
    expect(screen.getByText(new RegExp(new Date(minedAt * 1000).toISOString()))).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/block time not read/i);
  });

  it('says the block time was not read rather than filling in the reader\'s clock', async () => {
    h.receipt = { status: 'success', logs: [transferLog(10n ** 18n)], blockNumber: 21_000_000n };
    h.block = undefined;
    draw(verified());
    expect(await screen.findByText(/block time not read/i)).toBeInTheDocument();
  });

  it('hands the buyer a proof link that carries the hash', async () => {
    h.receipt = { status: 'success', logs: [transferLog(10n ** 18n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(NOW) };
    draw(verified());
    expect(await screen.findByText('Proof of payment')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`#i=PAYLOAD&tx=${HASH}`))).toBeInTheDocument();
  });
});
