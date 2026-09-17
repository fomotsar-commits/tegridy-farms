import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { useRevenueStats } from './useRevenueStats';
import { CHAIN_ID } from '../lib/constants';

const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
const REFERRER = '0xdddddddddddddddddddddddddddddddddddddddd';

/**
 * Two batches here, and `isDataError` is `isGlobalError || isUserError` — the
 * QUERY-level flags. useReadContracts defaults allowFailure to true, so a single
 * failed leg resolves the query successfully and leaves both false. Every test
 * below stubs the other legs so exactly one is unanswered: that is the shape the
 * error branches cannot see, and the only shape that matters.
 */
function stubAll() {
  wagmiMock.setReadResult({ functionName: 'totalDistributed', result: parseEther('42') });
  wagmiMock.setReadResult({ functionName: 'totalClaimed', result: parseEther('10') });
  wagmiMock.setReadResult({ functionName: 'epochCount', result: 7n });
  wagmiMock.setReadResult({ functionName: 'totalReferralsPaid', result: parseEther('3') });
  wagmiMock.setReadResult({ functionName: 'pendingETH', result: parseEther('1.5') });
  wagmiMock.setReadResult({ functionName: 'getReferralInfo', result: [3n, parseEther('2'), parseEther('0.5')] });
  wagmiMock.setReadResult({ functionName: 'referrerOf', result: REFERRER });
}

describe('useRevenueStats — an unread balance is not "nothing to claim"', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('everything landed: nothing is unread', () => {
    stubAll();
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.pendingUnread).toBe(false);
    expect(result.current.referrerUnread).toBe(false);
    expect(result.current.globalUnread).toBe(false);
    expect(result.current.hasReferrer).toBe(true);
  });

  it('an unread pendingETH is not a zero balance', () => {
    // THE FORFEITURE ONE. DashboardPage's "All caught up — nothing to claim
    // right now" panel is the surface a user acts on by doing NOTHING, and
    // claiming is what resets RevenueDistributor's 7d CLAIM_GRACE_PERIOD / 14d
    // DUST_RECLAIM_GRACE and ReferralSplitter's 90d FORFEITURE_PERIOD.
    stubAll();
    wagmiMock.setReadResult({ functionName: 'pendingETH', result: 0n, status: 'failure' });
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.pendingUnread).toBe(true);
    // The collapse is kept, as the convention requires.
    expect(result.current.pendingRevenue).toBe(0);
    // And the query-level flag STILL cannot see it — which is the whole point.
    expect(result.current.isDataError).toBe(false);
  });

  it('an unread getReferralInfo poisons the pending view too', () => {
    // It supplies the fallback that referralPending reads when its own leg fails.
    stubAll();
    wagmiMock.setReadResult({ functionName: 'getReferralInfo', result: null, status: 'failure' });
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.pendingUnread).toBe(true);
  });

  it('an unread referrerOf is not "not yet referred"', () => {
    // referrerOf is ONE-TIME AND PERMANENT on-chain. Acting on the collapse
    // offers a Link button whose setReferrer reverts AlreadyReferred.
    stubAll();
    wagmiMock.setReadResult({ functionName: 'referrerOf', result: null, status: 'failure' });
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.referrerUnread).toBe(true);
    expect(result.current.hasReferrer).toBe(false);
    // Separate axis from the claim balances.
    expect(result.current.pendingUnread).toBe(false);
  });

  it('the lifetime figures are their own axis', () => {
    stubAll();
    wagmiMock.setReadResult({ functionName: 'epochCount', result: 0n, status: 'failure' });
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.globalUnread).toBe(true);
    expect(result.current.pendingUnread).toBe(false);
    expect(result.current.referrerUnread).toBe(false);
  });

  it('a disconnected visitor is not an outage', () => {
    // The user batch is gated on !!address, so nothing was asked of it. The
    // landing hero renders this hook for logged-out visitors.
    wagmiMock.setAccount({ address: undefined, isConnected: false });
    const { result } = renderHook(() => useRevenueStats());
    expect(result.current.pendingUnread).toBe(false);
    expect(result.current.referrerUnread).toBe(false);
  });
});
