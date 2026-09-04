// The panel a merchant reads before they ship. Every test here is about a
// sentence somebody acts on, so each one checks the wrong sentence is ABSENT as
// well as that the right one is present.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, type Log } from 'viem';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;
const BUYER = '0x2222222222222222222222222222222222222222' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;

interface Harness {
  receipt: { status: 'success' | 'reverted'; logs: Log[]; blockNumber: bigint } | undefined;
  block: { timestamp: bigint } | undefined;
  isError: boolean;
  errorName: string;
}

const h: Harness = { receipt: undefined, block: undefined, isError: false, errorName: '' };

vi.mock('wagmi', () => ({
  useWaitForTransactionReceipt: () => ({
    data: h.receipt,
    isLoading: false,
    isSuccess: h.receipt !== undefined,
    isError: h.isError,
    error: h.isError ? Object.assign(new Error(h.errorName), { name: h.errorName }) : null,
  }),
  useBlock: () => ({ data: h.block }),
}));

import type { Invoice } from '../../lib/commerce/invoice';
import { recordAccepted } from '../../lib/commerce/acceptedHashes';
import { ProofOfPaymentPanel } from './ProofOfPaymentPanel';

const CREATED = 1_760_000_000;

const invoice: Invoice = {
  id: 'inv-abc234def567',
  merchant: MERCHANT,
  chainId: 1,
  settleToken: USDC,
  settleSymbol: 'USDC',
  settleDecimals: 6,
  settleAmount: 100_000_000n,
  memo: '',
  expiresAt: CREATED + 900,
  createdAt: CREATED,
};

function transferLog(value: bigint): Log {
  return {
    address: USDC,
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

beforeEach(() => {
  h.receipt = undefined;
  h.block = undefined;
  h.isError = false;
  h.errorName = '';
  localStorage.clear();
});

describe('a hash nobody found is not a refutation', () => {
  it('says the RPC did not answer, and prints no standing text at all', () => {
    h.isError = true;
    h.errorName = 'TransactionNotFoundError';
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);

    expect(screen.getByText(/No transaction with this hash was found on chain 1/i)).toBeInTheDocument();
    expect(screen.getByText(/it is not a refutation of one/i)).toBeInTheDocument();
    // The collapse this guards: an unanswered RPC telling a merchant they were
    // not paid is the sentence they refuse to ship on.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/does NOT contain the transfer to you/i);
    expect(text).not.toMatch(/the transfer to you was found in it/i);
  });
});

describe('a confirmed receipt states what it does and does not bind', () => {
  beforeEach(() => {
    h.receipt = { status: 'success', logs: [transferLog(100_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
  });

  it('leads with the sender, then the standing, then the block it was read at', () => {
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);
    expect(screen.getByText(`From ${BUYER}`)).toBeInTheDocument();
    expect(screen.getByText(/the transfer to you was found in it/i)).toBeInTheDocument();
    expect(screen.getByText(/at block 21000000/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(new Date((CREATED + 30) * 1000).toISOString()))).toBeInTheDocument();
  });

  it('discloses that the hash is NOT bound to this invoice id', () => {
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);
    expect(screen.getByText(/not bound to invoice inv-abc234def567/i)).toBeInTheDocument();
    expect(screen.getByText(/would confirm any invoice of yours for 100\.000000 USDC/i)).toBeInTheDocument();
  });

  it('flags a payment mined after the invoice lapsed without refusing it', () => {
    h.block = { timestamp: BigInt(CREATED + 5000) };
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);
    expect(screen.getByText(/Mined after the invoice expired/i)).toBeInTheDocument();
    expect(screen.getByText(/the transfer to you was found in it/i)).toBeInTheDocument();
  });

  it('says the block time was not read rather than substituting this clock', () => {
    h.block = undefined;
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);
    expect(screen.getByText(/block time not read/i)).toBeInTheDocument();
  });
});

describe('a receipt that does not match is refuted, with the reason', () => {
  it('names both figures on a shortfall', () => {
    h.receipt = { status: 'success', logs: [transferLog(99_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);

    expect(screen.getByText(/Do not release anything against this/i)).toBeInTheDocument();
    expect(screen.getByText(/99\.000000 USDC/)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/the transfer to you was found in it/i);
  });
});

describe('the merchant\'s ledger flags a hash presented twice', () => {
  it('says which invoice it was already counted for', () => {
    recordAccepted(MERCHANT, 1, HASH, 'inv-earlier00000', CREATED);
    h.receipt = { status: 'success', logs: [transferLog(100_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} merchant={MERCHANT} />);

    expect(screen.getByText(/Already accepted for invoice inv-earlier00000/i)).toBeInTheDocument();
    // And no accept control, so it cannot be counted a second time by reflex.
    expect(screen.queryByRole('button', { name: /^accept for invoice/i })).toBeNull();
  });

  it('offers the accept control on a fresh hash and says the ledger is local', () => {
    h.receipt = { status: 'success', logs: [transferLog(100_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} merchant={MERCHANT} />);

    const accept = screen.getByRole('button', { name: /accept for invoice inv-abc234def567/i });
    expect(accept.className).toContain('min-h-11');
    expect(screen.getByText(/lives in THIS browser only/i)).toBeInTheDocument();
    expect(screen.getByText(/its silence is not evidence a hash is new/i)).toBeInTheDocument();

    fireEvent.click(accept);
    expect(screen.getByText(/Already accepted for invoice inv-abc234def567/i)).toBeInTheDocument();
  });

  it('shows no ledger at all on the buyer\'s side', () => {
    recordAccepted(MERCHANT, 1, HASH, 'inv-earlier00000', CREATED);
    h.receipt = { status: 'success', logs: [transferLog(100_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
    render(<ProofOfPaymentPanel invoice={invoice} txHash={HASH} />);
    // A buyer's browser holds a different ledger; showing it would be meaningless.
    expect(screen.queryByText(/Already accepted/i)).toBeNull();
  });
});

describe('the merchant\'s own hash input', () => {
  it('looks nothing up until what was typed is a 32-byte hash', () => {
    render(<ProofOfPaymentPanel invoice={invoice} merchant={MERCHANT} />);
    const input = screen.getByLabelText(/transaction hash/i);
    expect(input.className).toContain('min-h-11');

    fireEvent.change(input, { target: { value: '0xdead' } });
    expect(screen.getByText(/not a 32-byte transaction hash/i)).toBeInTheDocument();
    expect(screen.getByText(/not about any payment/i)).toBeInTheDocument();

    h.receipt = { status: 'success', logs: [transferLog(100_000_000n)], blockNumber: 21_000_000n };
    h.block = { timestamp: BigInt(CREATED + 30) };
    fireEvent.change(input, { target: { value: HASH } });
    expect(screen.getByText(`From ${BUYER}`)).toBeInTheDocument();
  });
});
