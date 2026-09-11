// OUTAGE-AS-ZERO — usePoints' contract half.
//
// `swapCountUnread` covered the one getLogs scan. The four contract reads that
// also feed computeOnChainPoints collapsed with no signal, and each one's
// collapse UNDERSTATES points exactly as a refused scan did:
//   [0] userTokenId   -> 0n: the position is never asked for; stake + lock-day points vanish
//   [1] LP balanceOf  -> 0n: LP points vanish
//   [2] getReferralInfo -> undefined: zero referrals
//   getPosition       -> undefined: stake points vanish for a wallet whose token id DID land
// Both directions are pinned: a wallet that READ as holding nothing has zero
// points and no outage.
//
// The shared wagmi mock has no usePublicClient and ignores `query.enabled`, and
// this hook depends on both (the position read is enabled only once a token id
// lands), so it gets its own mock: reads answered by functionName, a disabled
// query answered with `data: undefined` as real wagmi does.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

type Answer = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

const h = vi.hoisted(() => ({
  reads: new Map<string, Answer>(),
  address: undefined as string | undefined,
  logs: [] as unknown[] | 'reject',
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address, isConnected: !!h.address }),
  useChainId: () => 1,
  usePublicClient: () => ({
    getLogs: () => (h.logs === 'reject' ? Promise.reject(new Error('range refused')) : Promise.resolve(h.logs)),
  }),
  useReadContracts: ({ contracts, query }: { contracts: Array<{ functionName: string }>; query?: { enabled?: boolean } }) => {
    if (query?.enabled === false) return { data: undefined };
    return {
      data: contracts.map((c) => h.reads.get(c.functionName) ?? ({ status: 'failure', error: new Error('no stub') } as Answer)),
    };
  },
}));

import { usePoints } from './usePoints';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd';

function ok(functionName: string, result: unknown) {
  h.reads.set(functionName, { status: 'success', result });
}
function failed(functionName: string) {
  h.reads.set(functionName, { status: 'failure', error: new Error('read failed') });
}
/** A staker with an LP position and two referrals — every read landed. */
function stubActiveWallet() {
  ok('userTokenId', 7n);
  ok('balanceOf', 5n * 10n ** 18n);
  ok('getReferralInfo', [2n, 0n, 0n]);
  ok('getPosition', [1_000n * 10n ** 18n, 0n, 0n, 30n * 86_400n, false, false]);
}

beforeEach(() => {
  h.reads.clear();
  h.address = USER;
  h.logs = [];
  localStorage.clear();
});

describe('usePoints — the contract reads are signalled, not silently zeroed', () => {
  // One case per batch index, so dropping any from the check fails exactly one.
  it.each(['userTokenId', 'balanceOf', 'getReferralInfo'])(
    'an unread %s understates points, and says so',
    async (functionName) => {
      stubActiveWallet();
      failed(functionName);
      const { result } = renderHook(() => usePoints());

      expect(result.current.metricsUnread).toBe(true);
      expect(result.current.pointsUnread).toBe(true);
      // The swap half answered; this is the contract half alone.
      await waitFor(() => expect(result.current.swapCountUnread).toBe(false));
    },
  );

  it('an unread getPosition for a wallet whose token id DID land is unread too', () => {
    stubActiveWallet();
    failed('getPosition');
    const { result } = renderHook(() => usePoints());

    expect(result.current.metricsUnread).toBe(true);
    expect(result.current.pointsUnread).toBe(true);
  });

  it('a wallet that READ as holding nothing has zero points, and no outage', async () => {
    // No token id (so the position is never asked for), no LP, no referrals — all read.
    ok('userTokenId', 0n);
    ok('balanceOf', 0n);
    ok('getReferralInfo', [0n, 0n, 0n]);
    const { result } = renderHook(() => usePoints());

    expect(result.current.metricsUnread).toBe(false);
    await waitFor(() => expect(result.current.data?.points).toBe(0));
    expect(result.current.pointsUnread).toBe(false);
  });

  it('a fully read active wallet has its points, and no outage', async () => {
    stubActiveWallet();
    const { result } = renderHook(() => usePoints());

    expect(result.current.metricsUnread).toBe(false);
    await waitFor(() => expect(result.current.data?.points).toBeGreaterThan(0));
    expect(result.current.pointsUnread).toBe(false);
  });

  it('with no wallet nothing was issued, so nothing is unread', () => {
    h.address = undefined;
    const { result } = renderHook(() => usePoints());

    expect(result.current.metricsUnread).toBe(false);
    expect(result.current.pointsUnread).toBe(false);
  });

  it('a refused swap scan alone also withholds points', async () => {
    // pointsUnread is the union: the existing swap signal must still reach it.
    stubActiveWallet();
    h.logs = 'reject';
    const { result } = renderHook(() => usePoints());

    await waitFor(() => expect(result.current.swapCountUnread).toBe(true));
    expect(result.current.metricsUnread).toBe(false);
    expect(result.current.pointsUnread).toBe(true);
  });
});
