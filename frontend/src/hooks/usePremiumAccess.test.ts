import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { usePremiumAccess } from './usePremiumAccess';
import { PREMIUM_ACCESS_ADDRESS, TOWELI_ADDRESS, JBAC_NFT_ADDRESS, CHAIN_ID } from '../lib/constants';

const USER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

/**
 * The batch is seven entries and `useReadContracts` defaults allowFailure to
 * TRUE, so ONE failed entry still resolves the query successfully — isDataError
 * stays false and every skeleton and error banner on PremiumPage stays hidden.
 * These helpers stub the six OTHER entries so each test isolates a SINGLE
 * unanswered read, which is the shape that hid this: a whole-batch outage would
 * have been caught by the banner that already exists.
 */
function stubAll() {
  wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'hasPremium', result: true });
  wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'getSubscription', result: [0n, true, true] });
  wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'monthlyFeeToweli', result: parseEther('100') });
  wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'totalSubscribers', result: 42n });
  wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'totalRevenue', result: parseEther('5000') });
  wagmiMock.setReadResult({ address: TOWELI_ADDRESS, functionName: 'balanceOf', result: parseEther('9999') });
  wagmiMock.setReadResult({ address: TOWELI_ADDRESS, functionName: 'allowance', result: parseEther('9999') });
}

describe('usePremiumAccess — a partial batch failure is not a fact', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('an unread JBAC balance is not "you own no ape"', () => {
    // THE LEG THE FIRST PASS MISSED. This is a SEPARATE useReadContract, not
    // part of the seven-entry batch, and it originally destructured only
    // `data` — so a failed read read as "owns zero apes".
    //
    // It LOOKS fail-closed because the collapse HIDES the Activate button. It
    // is not: the copy beside that button still promises the access is free,
    // and the paid grid is gated on `!hasPremium && !premiumUnread` — both
    // false here — so Subscribe stays armed at a correct price. A holder is
    // told it is free, given no way to take it, and sold it anyway.
    stubAll();
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC_NFT_ADDRESS, result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.jbacUnread).toBe(true);
    expect(result.current.holdsJBAC).toBe(false);
  });

  it('a read JBAC balance of zero is not unread', () => {
    stubAll();
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: JBAC_NFT_ADDRESS, result: 0n });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.jbacUnread).toBe(false);
    expect(result.current.holdsJBAC).toBe(false);
  });

  it('everything landed: nothing is unread', () => {
    stubAll();
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.premiumUnread).toBe(false);
    expect(result.current.quoteUnread).toBe(false);
    expect(result.current.statsUnread).toBe(false);
    expect(result.current.hasPremium).toBe(true);
  });

  it('an unread membership is not "no membership"', () => {
    // THE EXPENSIVE ONE. A JBAC holder with free LIFETIME access, whose
    // hasPremium entry alone fails, was shown the sales section and could buy
    // 12 months of what they already own. The transaction SUCCEEDS, so the only
    // recovery is a pro-rata refund that is net-lossy.
    stubAll();
    wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'hasPremium', result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.premiumUnread).toBe(true);
    // The collapse stays, as the house convention requires — the signal is what
    // is new, not a changed default.
    expect(result.current.hasPremium).toBe(false);
    // And it is specifically NOT the quote that failed.
    expect(result.current.quoteUnread).toBe(false);
  });

  it('an unread price is unread, and does not read as free', () => {
    // monthlyFee collapses to 0n, which made PremiumPage's totalCostRaw 0n and
    // `canAfford = userBalance >= 0n` unconditionally true — the "Insufficient
    // TOWELI Balance" cap stopped capping for every wallet, empty ones included.
    stubAll();
    wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'monthlyFeeToweli', result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.quoteUnread).toBe(true);
    expect(result.current.monthlyFee).toBe(0n);
    expect(result.current.premiumUnread).toBe(false);
  });

  it('an unread balance poisons the quote too', () => {
    stubAll();
    wagmiMock.setReadResult({ address: TOWELI_ADDRESS, functionName: 'balanceOf', result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.quoteUnread).toBe(true);
  });

  it('an unread allowance poisons the quote too — it routes Approve vs Subscribe', () => {
    stubAll();
    wagmiMock.setReadResult({ address: TOWELI_ADDRESS, functionName: 'allowance', result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.quoteUnread).toBe(true);
  });

  it('unread global stats are display-only and do not touch the quote', () => {
    // The separation is the point: a failed totalRevenue read must not disable
    // a purchase, and a failed price read must not be hidden behind a tile.
    stubAll();
    wagmiMock.setReadResult({ address: PREMIUM_ACCESS_ADDRESS, functionName: 'totalRevenue', result: null, status: 'failure' });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.statsUnread).toBe(true);
    expect(result.current.quoteUnread).toBe(false);
    expect(result.current.premiumUnread).toBe(false);
  });

  it('a disconnected visitor is not an outage', () => {
    // Nothing was asked, so nothing failed. A not-attempted read must never
    // render as a failed one — the page would otherwise open on an amber
    // banner for every logged-out visitor.
    wagmiMock.setAccount({ address: undefined, isConnected: false });
    const { result } = renderHook(() => usePremiumAccess());
    expect(result.current.premiumUnread).toBe(false);
    expect(result.current.quoteUnread).toBe(false);
    expect(result.current.statsUnread).toBe(false);
  });
});
