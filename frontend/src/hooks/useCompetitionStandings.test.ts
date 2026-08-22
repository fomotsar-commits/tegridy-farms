// An unread season must not render as an empty competition.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return { ...actual, indexerQuery: indexerQueryMock, isIndexerConfigured: isIndexerConfiguredMock };
});

import { useCompetitionStandings } from './useCompetitionStandings';
import { SEASONS } from '../lib/competitions/season';

const season = SEASONS[0]!;
const TOKEN = '0x1111111111111111111111111111111111111111';
const WASHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a',
    user: WASHER,
    tokenIn: season.quoteToken.toLowerCase(),
    tokenOut: TOKEN,
    amountIn: 10n ** 18n,
    fee: 0n,
    timestamp: BigInt(season.startsAt + 10),
    txHash: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

function answer(items: unknown[], hasNextPage = false) {
  return {
    data: { swaps: { items, pageInfo: { hasNextPage, endCursor: null } } },
    meta: { ready: true, syncedBlock: 25_300_000, syncedAt: season.startsAt + 100 },
  };
}

beforeEach(() => {
  indexerQueryMock.mockReset();
  isIndexerConfiguredMock.mockReset();
  isIndexerConfiguredMock.mockReturnValue(true);
  vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useCompetitionStandings', () => {
  it('has no standings at all when the indexer is not configured', async () => {
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();

    const { result } = renderHook(() => useCompetitionStandings({ season }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.standings).toBeNull();
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('parks in idle and asks nothing when no season is declared', async () => {
    const { result } = renderHook(() => useCompetitionStandings({ season: null }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.standings).toBeNull();
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('bounds the read to the season’s own dates', async () => {
    indexerQueryMock.mockResolvedValue(answer([]));
    renderHook(() => useCompetitionStandings({ season }));
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    expect(indexerQueryMock.mock.calls[0]![0].variables).toEqual({
      limit: 100,
      where: { timestamp_gte: String(season.startsAt), timestamp_lte: String(season.endsAt) },
    });
  });

  it('applies the wash rule to a ready page', async () => {
    indexerQueryMock.mockResolvedValue(
      answer([
        row({ id: 'buy', timestamp: BigInt(season.startsAt + 10) }),
        row({
          id: 'sell',
          tokenIn: TOKEN,
          tokenOut: season.quoteToken.toLowerCase(),
          timestamp: BigInt(season.startsAt + 70),
        }),
      ]),
    );
    const { result } = renderHook(() => useCompetitionStandings({ season }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.standings!.rows[0]!.countedVolume).toBe(0n);
    expect(result.current.standings!.washedLegs).toBe(2);
  });

  it('reports a truncated page as a provisional ranking', async () => {
    indexerQueryMock.mockResolvedValue(answer([row()], true));
    const { result } = renderHook(() => useCompetitionStandings({ season }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.standings!.truncated).toBe(true);
  });
});
