// THE UNAVAILABLE PATH IS THE POINT.
//
// The indexer is deployed nowhere today, so `unavailable` is not an edge case
// here — it is the state every consumer of this hook is in right now, and the
// state it will fall back to on every outage after that. These tests pin that
// the hook never lets an outage, a misconfiguration, or a half-finished
// backfill leave the caller holding an empty array with nothing to distinguish
// it from a genuinely empty history.
//
// `classifyResponse` is tested directly as well, because the rule it encodes —
// answered-but-not-synced is its OWN state, not `ready` and not `unavailable` —
// is the one a future refactor is most likely to flatten away.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// `vi.hoisted` because the factory below runs during this file's own import of
// the mocked module, which is hoisted above plain top-level declarations.
const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return {
    ...actual,
    indexerQuery: indexerQueryMock,
    isIndexerConfigured: isIndexerConfiguredMock,
  };
});

import { IndexerUnavailableError } from '../lib/indexer/client';
import { classifyResponse } from './useIndexedQuery';
import { useIndexedSwaps } from './useIndexedSwaps';

const WALLET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

const SWAP = {
  id: '0xdead-0',
  user: WALLET.toLowerCase(),
  tokenIn: '0x0000000000000000000000000000000000000001',
  tokenOut: '0x0000000000000000000000000000000000000002',
  amountIn: 10n ** 18n,
  fee: 25n * 10n ** 14n,
  timestamp: 1_780_000_000n,
  txHash: `0x${'ab'.repeat(32)}`,
};

function answer(items: unknown[], meta: unknown) {
  return { data: { swaps: { items, pageInfo: { hasNextPage: false, endCursor: null } } }, meta };
}

const READY = { ready: true, syncedBlock: 25_300_000, syncedAt: 1_780_000_100 };
const SYNCING = { ready: false, syncedBlock: 25_000_000, syncedAt: 1_770_000_000 };

beforeEach(() => {
  indexerQueryMock.mockReset();
  isIndexerConfiguredMock.mockReset();
  isIndexerConfiguredMock.mockReturnValue(true);
  vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useIndexedSwaps — with no indexer configured', () => {
  it('is unavailable without issuing a request', async () => {
    // The state the whole app is in until the operator finishes
    // indexer/DEPLOY.md. It must not spin, and it must not look like zero.
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();

    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.items).toEqual([]);
    expect(result.current.detail).toMatch(/no indexer configured/i);
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });
});

describe('useIndexedSwaps — with an indexer that answers', () => {
  it('reports ready and hands back the rows', async () => {
    indexerQueryMock.mockResolvedValue(answer([SWAP], READY));

    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual([SWAP]);
    expect(result.current.syncedBlock).toBe(25_300_000);
    expect(result.current.detail).toBeNull();
  });

  it('filters by the lower-cased wallet', async () => {
    indexerQueryMock.mockResolvedValue(answer([], READY));
    renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    expect(indexerQueryMock.mock.calls[0]![0].variables).toEqual({
      limit: 25,
      where: { user: WALLET.toLowerCase() },
    });
  });

  it('an empty page from a SYNCED indexer is a real zero', async () => {
    indexerQueryMock.mockResolvedValue(answer([], READY));
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual([]);
  });

  it('an empty page from a BACKFILLING indexer is not', async () => {
    // ⚠ THE ONE THAT MATTERS. Same 200, same empty array, entirely different
    // fact. Rendered as `ready` this says "you have never traded here" on
    // behalf of an indexer that has not reached those blocks yet.
    indexerQueryMock.mockResolvedValue(answer([], SYNCING));
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('backfilling'));
    expect(result.current.detail).toMatch(/still replaying history/i);
  });

  it('treats an unreported sync position as unknown, never as ready', async () => {
    indexerQueryMock.mockResolvedValue(answer([SWAP], null));
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('backfilling'));
    expect(result.current.detail).toMatch(/did not report its sync position/i);
    // The rows that DID arrive are real and still surfaced — the caveat is on
    // completeness, not on the rows.
    expect(result.current.items).toEqual([SWAP]);
  });
});

describe('useIndexedSwaps — when the read fails', () => {
  it('carries the client’s own reason through', async () => {
    indexerQueryMock.mockRejectedValue(
      new IndexerUnavailableError('unreachable', 'The indexer is rate-limiting right now.'),
    );
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.items).toEqual([]);
    expect(result.current.detail).toMatch(/rate-limiting/i);
  });

  it('still self-gates on an error it does not recognise', async () => {
    indexerQueryMock.mockRejectedValue(new Error('something else entirely'));
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.detail).toMatch(/could not be read/i);
  });
});

describe('useIndexedSwaps — disabled', () => {
  it('stays idle and asks nothing', async () => {
    const { result } = renderHook(() => useIndexedSwaps({ user: WALLET, enabled: false }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });
});

describe('classifyResponse', () => {
  it('never calls an unsynced answer ready, and never discards its rows', () => {
    expect(classifyResponse([SWAP], false, READY).status).toBe('ready');
    const syncing = classifyResponse([SWAP], true, SYNCING);
    expect(syncing.status).toBe('backfilling');
    expect(syncing.items).toEqual([SWAP]);
    expect(syncing.hasMore).toBe(true);
    expect(classifyResponse([], false, null).status).toBe('backfilling');
  });
});
