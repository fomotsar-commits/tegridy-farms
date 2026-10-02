/**
 * OUTAGE-AS-SEEDLING — the Venue Score's six inputs.
 *
 * Every input collapses to 0 on a failed read, and six 0s compose into a score
 * of 0, rank "Seedling 🌱" and "Tier: Seedling" — told to a wallet whose reads
 * simply did not land. The inputs fail independently:
 *
 *   staking + lock  <- useUserPosition (its own positionUnread)
 *   activity        <- usePoints (swapCountUnread today; #518 adds pointsUnread)
 *   governance      <- proposalCount [0] AND the per-proposal scan, which
 *                      `.catch`es each read and silently UNDER-COUNTS votes
 *   community       <- bountyCount [0] AND the per-bounty scan, same shape
 *   loyalty         <- a getLogs range that public RPCs refuse
 *
 * Both governance rails are 0x0 in production, so their reads are disabled and
 * dormancy is not an outage. This file mocks the two addresses as deployed to
 * exercise the code that ships the day they are filled in — dormant is a reason
 * the flag cannot fire yet, not a reason to leave the claim unguarded.
 *
 * Both directions are pinned: a wallet that READ as having no history is a real
 * Seedling and must still score 0 with no outage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

type Answer = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

const h = vi.hoisted(() => ({
  address: '0xdddddddddddddddddddddddddddddddddddddddd' as string | undefined,
  reads: new Map<string, Answer>(),
  /** publicClient.readContract, keyed by functionName: 'ok' resolves, 'reject' throws. */
  itemReads: new Map<string, 'ok' | 'reject'>(),
  logs: [] as unknown[] | 'reject',
  position: { positionUnread: false, stakedAmount: 0n, walletBalance: 0n, lockDuration: 0 },
  points: { data: { onChainPoints: 0 }, onChainMetrics: { referralCount: 0 }, swapCountUnread: false },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address, isConnected: !!h.address }),
  useReadContracts: ({ contracts, query }: { contracts: Array<{ functionName: string }>; query?: { enabled?: boolean } }) => {
    if (query?.enabled === false) return { data: undefined };
    return {
      data: contracts.map((c) => h.reads.get(c.functionName) ?? ({ status: 'failure', error: new Error('no stub') } as Answer)),
    };
  },
  usePublicClient: () => ({
    getLogs: () => (h.logs === 'reject' ? Promise.reject(new Error('range refused')) : Promise.resolve(h.logs)),
    getBlock: () => Promise.resolve({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 400 * 86_400) }),
    readContract: ({ functionName }: { functionName: string }) =>
      h.itemReads.get(functionName) === 'reject'
        ? Promise.reject(new Error('refused'))
        : Promise.resolve(functionName === 'hasVotedOnProposal' ? true : ['0x0000000000000000000000000000000000000000']),
  }),
}));
vi.mock('./useUserPosition', () => ({ useUserPosition: () => h.position }));
vi.mock('./usePoints', () => ({ usePoints: () => h.points }));
// The two governance rails are 0x0 in production. Mocked as deployed so the
// flags written for their launch day are exercised rather than skipped.
vi.mock('../lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/constants')>()),
  COMMUNITY_GRANTS_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  MEME_BOUNTY_BOARD_ADDRESS: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
}));

import { useTegridyScore } from './useTegridyScore';

function ok(functionName: string, result: unknown) {
  h.reads.set(functionName, { status: 'success', result });
}
function failed(functionName: string) {
  h.reads.set(functionName, { status: 'failure', error: new Error('read failed') });
}
/** Every read lands: no proposals, no bounties, no staking history. */
function stubQuietChain() {
  ok('proposalCount', 0n);
  ok('bountyCount', 0n);
  h.logs = [];
}

beforeEach(() => {
  localStorage.clear();
  h.address = '0xdddddddddddddddddddddddddddddddddddddddd';
  h.reads.clear();
  h.itemReads.clear();
  h.logs = [];
  h.position = { positionUnread: false, stakedAmount: 0n, walletBalance: 0n, lockDuration: 0 };
  h.points = { data: { onChainPoints: 0 }, onChainMetrics: { referralCount: 0 }, swapCountUnread: false };
});

describe('useTegridyScore — an input that did not land is not a zero', () => {
  it('an unread position withholds staking and lock, and nothing else', () => {
    stubQuietChain();
    h.position = { ...h.position, positionUnread: true };
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.scoreUnread).toBe(true);
    expect(result.current.breakdownUnread.stakingScore).toBe(true);
    expect(result.current.breakdownUnread.lockScore).toBe(true);
    // Independent inputs stay readable — one outage must not blank the lot.
    expect(result.current.breakdownUnread.activityScore).toBe(false);
    expect(result.current.breakdownUnread.governanceScore).toBe(false);
  });

  it('a refused swap-log scan withholds activity', () => {
    stubQuietChain();
    h.points = { ...h.points, swapCountUnread: true };
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.breakdownUnread.activityScore).toBe(true);
    expect(result.current.scoreUnread).toBe(true);
  });

  it('a refused first-interaction log scan withholds loyalty', async () => {
    stubQuietChain();
    h.logs = 'reject';
    const { result } = renderHook(() => useTegridyScore());

    await waitFor(() => expect(result.current.breakdownUnread.loyaltyScore).toBe(true));
    expect(result.current.scoreUnread).toBe(true);
    // The collapse itself is kept, and that is exactly why the flag must exist.
    expect(result.current.breakdown.loyaltyScore).toBe(0);
  });

  it('an unread proposalCount withholds governance', () => {
    stubQuietChain();
    failed('proposalCount');
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.breakdownUnread.governanceScore).toBe(true);
    expect(result.current.scoreUnread).toBe(true);
  });

  it('a per-proposal scan that swallowed a refusal withholds governance', async () => {
    // The reads `.catch` to false/null, so votes are UNDER-COUNTED rather than
    // failed: "could not look" arriving as "did not vote".
    stubQuietChain();
    ok('proposalCount', 3n);
    h.itemReads.set('hasVotedOnProposal', 'reject');
    const { result } = renderHook(() => useTegridyScore());

    await waitFor(() => expect(result.current.breakdownUnread.governanceScore).toBe(true));
  });

  it('an unread bountyCount withholds community', () => {
    stubQuietChain();
    failed('bountyCount');
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.breakdownUnread.communityScore).toBe(true);
  });

  it('a per-bounty scan that swallowed a refusal withholds community', async () => {
    stubQuietChain();
    ok('bountyCount', 2n);
    h.itemReads.set('getBounty', 'reject');
    const { result } = renderHook(() => useTegridyScore());

    await waitFor(() => expect(result.current.breakdownUnread.communityScore).toBe(true));
  });

  it('withholds the tip that would be advice off an unread number', () => {
    stubQuietChain();
    h.position = { ...h.position, positionUnread: true };
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.tips.join(' ')).not.toMatch(/stake more toweli/i);
  });
});

describe('useTegridyScore — GENUINE zeros and reads never issued', () => {
  // NOT DISCRIMINATING against the old code — identical before and after. They
  // fail if the fix is ever widened into treating a real zero as an outage.
  it('a wallet that READ as having no history is a real Seedling', async () => {
    stubQuietChain();
    const { result } = renderHook(() => useTegridyScore());

    await waitFor(() => expect(result.current.scoreUnread).toBe(false));
    expect(result.current.score).toBe(0);
    expect(result.current.rank).toMatch(/seedling/i);
    expect(Object.values(result.current.breakdownUnread).every((v) => v === false)).toBe(true);
  });

  it('a wallet with a read position scores it, with no outage', async () => {
    stubQuietChain();
    h.position = {
      positionUnread: false,
      stakedAmount: 900n * 10n ** 18n,
      walletBalance: 100n * 10n ** 18n,
      lockDuration: 365 * 86_400,
    };
    h.points = { ...h.points, data: { onChainPoints: 500 } };
    const { result } = renderHook(() => useTegridyScore());

    await waitFor(() => expect(result.current.score).toBeGreaterThan(0));
    expect(result.current.scoreUnread).toBe(false);
    expect(result.current.breakdown.stakingScore).toBeGreaterThan(0);
  });

  it('with no wallet the reads were never issued, so nothing is unread', () => {
    h.address = undefined;
    const { result } = renderHook(() => useTegridyScore());

    expect(result.current.scoreUnread).toBe(false);
    expect(result.current.score).toBe(0);
  });
});
