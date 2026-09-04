// The three failure states are the whole point of this hook, so each one is
// driven by a DIFFERENT cause and asserted not to render as either of the others.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Swapped per test to model "this build has an RPC for that chain" or not. */
let publicClientStub: { verifyTypedData: (args: unknown) => Promise<boolean> } | undefined;

vi.mock('wagmi', () => ({
  usePublicClient: () => publicClientStub,
}));

import { encodePaymentLink, invoiceTypedData } from '../lib/commerce/paymentLink';
import type { Invoice } from '../lib/commerce/invoice';
import { usePaymentLink } from './usePaymentLink';

const merchant = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const NOW = 1_760_000_000;

const invoice: Invoice = {
  id: 'inv-abc234def567',
  merchant: merchant.address,
  chainId: 1,
  settleToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  settleSymbol: 'USDC',
  settleDecimals: 6,
  settleAmount: 100_000_000n,
  memo: 'one towel',
  expiresAt: NOW + 900,
  createdAt: NOW - 60,
};

let fragment = '';

beforeEach(async () => {
  publicClientStub = { verifyTypedData: () => Promise.resolve(true) };
  const typed = invoiceTypedData(invoice);
  const signature = await merchant.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  fragment = `#i=${encodePaymentLink(invoice, signature)}`;
});

describe('reading a signed invoice out of the fragment', () => {
  it('reports no link at all as none, which is not a failure', () => {
    const { result } = renderHook(() => usePaymentLink(''));
    expect(result.current.status).toBe('none');
  });

  it('reports an unparseable fragment as unreadable, never as forged', async () => {
    const { result } = renderHook(() => usePaymentLink('#i=garbage'));
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.status).not.toBe('forged');
  });

  it('verifies a real signature through the public client', async () => {
    const { result } = renderHook(() => usePaymentLink(fragment));
    await waitFor(() => expect(result.current.status).toBe('verified'));
    if (result.current.status !== 'verified') return;
    expect(result.current.invoice.settleAmount).toBe(100_000_000n);
  });
});

describe('verified, forged and unverifiable are three different answers', () => {
  it('reports a verifier that says NO as forged', async () => {
    publicClientStub = { verifyTypedData: () => Promise.resolve(false) };
    const { result } = renderHook(() => usePaymentLink(fragment));
    await waitFor(() => expect(result.current.status).toBe('forged'));
    if (result.current.status !== 'forged') return;
    expect(result.current.merchant).toBe(merchant.address);
  });

  it('reports a verifier that THREW as unverifiable, and offers a retry that re-asks', async () => {
    // The damaging collapse: an RPC rate limit rendered as "this link does not
    // verify" accuses an honest merchant of a forgery.
    const verify = vi.fn().mockRejectedValue(new Error('rpc: 429 rate limited'));
    publicClientStub = { verifyTypedData: verify };

    const { result } = renderHook(() => usePaymentLink(fragment));
    await waitFor(() => expect(result.current.status).toBe('unverifiable'));
    if (result.current.status !== 'unverifiable') return;
    expect(result.current.detail).toContain('429');
    expect(verify).toHaveBeenCalledTimes(1);

    act(() => {
      if (result.current.status === 'unverifiable') result.current.retry();
    });
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
  });

  it('reports a chain this build has no RPC for as unverifiable, naming the chain', async () => {
    publicClientStub = undefined;
    const { result } = renderHook(() => usePaymentLink(fragment));
    await waitFor(() => expect(result.current.status).toBe('unverifiable'));
    if (result.current.status !== 'unverifiable') return;
    expect(result.current.detail).toMatch(/no RPC for chain 1/i);
    // Not forged, and not verified: nothing ran.
    expect(result.current.invoice.id).toBe('inv-abc234def567');
  });

  it('does not report a valid link as forged when the verifier is real', async () => {
    // The control for the two above, using viem's real offline verifier through
    // the injection seam — so a bug that always answered 'forged' would fail here.
    const { result } = renderHook(() =>
      usePaymentLink(fragment, { verifier: (args) => verifyTypedData(args) }),
    );
    await waitFor(() => expect(result.current.status).toBe('verified'));
  });

  it('answers forged for a link edited after signing, through the real verifier', async () => {
    const typed = invoiceTypedData(invoice);
    const signature = await merchant.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const tampered = `#i=${encodePaymentLink({ ...invoice, settleAmount: 1n }, signature)}`;
    const { result } = renderHook(() => usePaymentLink(tampered, { verifier: (args) => verifyTypedData(args) }));
    await waitFor(() => expect(result.current.status).toBe('forged'));
  });
});
