import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { SIGNAL_CLOCK_INTERVAL_MS, useTapeSignals } from './useTapeSignals';
import { MAX_SIGNAL_AGE_SECONDS } from '../lib/copytrade/mirror';
import type { FollowConfig } from '../lib/copytrade/follows';
import type { IslandPool, IslandTape, TapeFill } from '../lib/copytrade/tape';
import { WETH_ADDRESS } from '../lib/constants';

const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW_MS = 1_780_000_000_000;
const NOW = NOW_MS / 1000;

const pool: IslandPool = {
  bungalowId: 'pepe',
  symbol: 'PEPE',
  network: 'eth',
  family: 'evm',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  baseToken: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
  quoteToken: WETH_ADDRESS.toLowerCase(),
};

const fill: TapeFill = {
  pool,
  txHash: `0x${'ab'.repeat(32)}`,
  wallet: LEADER,
  side: 'buy',
  at: NOW - MAX_SIGNAL_AGE_SECONDS + 10,
  usd: 100,
  quoteAmount: '0.05',
  blockNumber: null,
};

const tape: IslandTape = {
  fetchedAt: NOW_MS,
  stoppedEarly: false,
  reads: [
    {
      status: 'read',
      pool,
      fills: [fill],
      fetchedAt: NOW_MS,
      newestAt: fill.at,
      oldestAt: fill.at,
      capped: false,
      undated: 0,
    },
  ],
};

const follow: FollowConfig = {
  venue: 'evm',
  leader: LEADER,
  quoteToken: WETH_ADDRESS.toLowerCase(),
  maxNotionalWei: 10n ** 18n,
  slippageBps: 100,
  createdAt: NOW - 1000,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTapeSignals', () => {
  it('re-judges a fill as the clock moves past the signal window', () => {
    const { result } = renderHook(() => useTapeSignals({ tape, follows: [follow] }));
    expect(result.current.candidates[0]!.outcome.ok).toBe(true);

    // Past the window. A `now` captured at mount would keep this labelled fresh
    // for anyone who left the tab open — the page telling a reader they are
    // about to copy something they are not.
    act(() => {
      vi.setSystemTime(NOW_MS + (MAX_SIGNAL_AGE_SECONDS + 60) * 1000);
      vi.advanceTimersByTime(SIGNAL_CLOCK_INTERVAL_MS);
    });

    const outcome = result.current.candidates[0]!.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('stale-signal');
  });

  it('produces nothing at all before the tape lands', () => {
    const { result } = renderHook(() => useTapeSignals({ tape: null, follows: [follow] }));
    expect(result.current.candidates).toEqual([]);
  });

  it('issues no request of its own', () => {
    // The tape's window is anchored by the walk that produced it. Re-reading on
    // this timer would poll a keyless upstream and imply a stream that does not
    // exist.
    const src = readFileSync(join(process.cwd(), 'src', 'hooks', 'useTapeSignals.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/readIslandTape|readPoolTrades/);
  });
});
