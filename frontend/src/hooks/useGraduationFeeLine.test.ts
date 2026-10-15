// The graduation fee line enumerates the launch assets with the same `readOurLaunches`
// scan as the Launch page, so it needs the same log source. Handed the raw client, the
// scan asked the browser's RPC for the Airlock's Create history from block 21,000,000 and
// was refused by every provider (measured on the live site 2026-10-14), which left the
// line permanently "base pairs only".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Address } from 'viem';

const ASSET = '0x00000000000000000000000000000000000000aa' as Address;

const multicall = vi.fn();
const getLogs = vi.fn();
const publicClient = { multicall, getLogs };

vi.mock('wagmi', () => ({
  usePublicClient: () => publicClient,
}));

const readFeeLine = vi.fn();
vi.mock('../lib/launcher/graduation', () => ({
  readFeeLine: (...a: unknown[]) => readFeeLine(...a),
}));

const readOurLaunches = vi.fn();
vi.mock('../lib/launcher/ourLaunches', () => ({
  readOurLaunches: (...a: unknown[]) => readOurLaunches(...a),
}));

import { useGraduationFeeLine } from './useGraduationFeeLine';

describe('useGraduationFeeLine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOurLaunches.mockResolvedValue({ baselines: [], poolByToken: {}, complete: true });
    readFeeLine.mockResolvedValue({ rows: [] });
  });

  it('reads the launch history from our backend, never the browser RPC', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ assets: [ASSET] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { result } = renderHook(() => useGraduationFeeLine(true));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const client = readOurLaunches.mock.calls.at(-1)?.[0]?.client;
      await expect(client.getLogs()).resolves.toEqual([{ args: { asset: ASSET } }]);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('resource=launch-cohort');
      expect(getLogs).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('checks the launch assets as well as the base pairs', async () => {
    readOurLaunches.mockResolvedValue({ baselines: [{ token: ASSET }], poolByToken: {}, complete: true });
    const { result } = renderHook(() => useGraduationFeeLine(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const currencies = (readFeeLine.mock.calls.at(-1)?.[1] ?? []) as Address[];
    expect(currencies.map((c) => c.toLowerCase())).toContain(ASSET.toLowerCase());
    expect(result.current.assetsUnavailable).toBe(false);
  });

  it('still reports an incomplete scan as assetsUnavailable', async () => {
    readOurLaunches.mockResolvedValue({ baselines: [], poolByToken: {}, complete: false });
    const { result } = renderHook(() => useGraduationFeeLine(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.assetsUnavailable).toBe(true);
  });
});
