import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { VenueStats, POLL_MS } from './VenueStats';
import { parseVenueVolume, VENUE_VOLUME_URL } from '../lib/venueVolume';
import { parseVenueTvl, VENUE_TVL_URL } from '../lib/venueTvl';

const NOW = Date.parse('2026-10-19T16:30:00Z');
const volume = (over: Record<string, unknown> = {}) => ({
  state: 'current',
  usd: 2481.26,
  swaps: 67,
  unpricedSwaps: 0,
  asOf: '2026-10-19T16:00:00.000Z',
  staleAt: '2026-10-20T01:00:00.000Z',
  ...over,
});
const chains = () => [
  { chain: 'solana', read: true, usd: 11059.52, pools: 10, unvalued: 0 },
  { chain: 'ethereum', read: true, usd: 441.66, pools: 1, unvalued: 0 },
  { chain: 'base', read: true, usd: 233.44, pools: 3, unvalued: 0 },
  { chain: 'robinhood', read: true, usd: 0, pools: 0, unvalued: 0 },
];
const staking = () => [
  { chain: 'solana', read: true, usd: 22440.26, vaults: 3, unvalued: 0 },
  { chain: 'ethereum', read: true, usd: 64.79, vaults: 3, unvalued: 0 },
  { chain: 'base', read: true, usd: 0, vaults: 0, unvalued: 0 },
];
const tvl = (over: Record<string, unknown> = {}) => ({ state: 'current', usd: 34239.67, chains: chains(), staking: staking(), readAt: '2026-10-19T16:29:30.000Z', ...over });

describe('parseVenueVolume', () => {
  it('turns a cached "current" answer behind once its staleAt has passed', () => {
    expect(parseVenueVolume(volume(), NOW).state).toBe('current');
    expect(parseVenueVolume(volume(), Date.parse('2026-10-20T01:00:01Z')).state).toBe('behind');
    expect(parseVenueVolume(volume({ state: 'behind' }), NOW).state).toBe('behind');
  });

  it('reads anything it cannot trust as unread, never as a number', () => {
    for (const bad of [null, 'html', { state: 'unread' }, volume({ usd: null }), volume({ usd: -1 }), volume({ asOf: 'x' }), volume({ staleAt: undefined })]) {
      expect(parseVenueVolume(bad, NOW)).toEqual({ state: 'unread' });
    }
  });
});

describe('parseVenueTvl', () => {
  it('reads a whole answer, every chain in order, pools and staking', () => {
    const t = parseVenueTvl(tvl());
    expect(t).toMatchObject({ state: 'current', usd: 34239.67 });
    expect(t.state !== 'unread' && t.chains.map((c) => c.chain)).toEqual(['solana', 'ethereum', 'base', 'robinhood']);
    expect(t.state !== 'unread' && t.staking).toEqual(staking());
  });

  it('reads an answer from before staking was counted as partial, its staking unread', () => {
    const t = parseVenueTvl(tvl({ staking: undefined }));
    expect(t).toMatchObject({ state: 'partial', usd: 34239.67 });
    expect(t.state !== 'unread' && t.staking).toEqual([
      { chain: 'solana', read: false },
      { chain: 'ethereum', read: false },
      { chain: 'base', read: false },
    ]);
  });

  it('reads "current" with a chain missing or a pool left out as partial, never whole', () => {
    const missing = chains();
    missing[2] = { chain: 'base', read: false } as never;
    expect(parseVenueTvl(tvl({ chains: missing })).state).toBe('partial');
    const left = chains();
    left[0].unvalued = 1;
    expect(parseVenueTvl(tvl({ chains: left })).state).toBe('partial');
    const unstaked = staking();
    unstaked[1] = { chain: 'ethereum', read: false } as never;
    expect(parseVenueTvl(tvl({ staking: unstaked })).state).toBe('partial');
    const unpriced = staking();
    unpriced[0].unvalued = 1;
    expect(parseVenueTvl(tvl({ staking: unpriced })).state).toBe('partial');
  });

  it('reads anything it cannot trust as unread, never as a number', () => {
    const short = chains().slice(1);
    const swapped = [chains()[1], chains()[0], ...chains().slice(2)];
    const bad = chains();
    bad[1].usd = -5;
    const badStake = staking();
    badStake[0].vaults = 1.5;
    const stakeSwapped = [staking()[1], staking()[0], staking()[2]];
    for (const body of [
      null,
      'html',
      { state: 'unread' },
      tvl({ usd: null }),
      tvl({ usd: -1 }),
      tvl({ readAt: 'x' }),
      tvl({ chains: short }),
      tvl({ chains: swapped }),
      tvl({ chains: bad }),
      tvl({ staking: staking().slice(1) }),
      tvl({ staking: stakeSwapped }),
      tvl({ staking: badStake }),
      tvl({ staking: null }),
    ]) {
      expect(parseVenueTvl(body)).toEqual({ state: 'unread' });
    }
  });
});

describe('<VenueStats />', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  /** Serves the two reads; `answers` can be changed between polls. */
  const serve = (answers: { tvl: [unknown, number]; volume: [unknown, number] }) => {
    const f = vi.fn(async (url: string) => {
      const [body, status] = url === VENUE_TVL_URL ? answers.tvl : url === VENUE_VOLUME_URL ? answers.volume : [{}, 404];
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('shows the TVL, live, and the all-time volume, with each chain in the small print, pools and staking apart', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve({ tvl: [tvl(), 200], volume: [volume(), 200] });
    render(<VenueStats />);
    expect(await screen.findByText('$34,240')).toBeTruthy();
    expect(await screen.findByText('$2,481')).toBeTruthy();
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $34,240');
    expect(screen.getByTestId('venue-tvl').querySelector('.rounded-full')).toBeTruthy();
    expect(screen.getByTestId('venue-tvl-chains').textContent).toBe('Pools: Solana $11,060 · Ethereum $442 · Base $233 · Robinhood $0');
    expect(screen.getByTestId('venue-tvl-staking').textContent).toBe('Staked: Solana $22,440 · Ethereum $65 · Base $0');
    expect(screen.getByText(/plus what is staked in our staking pools/)).toBeTruthy();
    expect(screen.queryByText(/staked coin with no market price/)).toBeNull();
    expect(screen.getByText(/Last counted /)).toBeTruthy();
    expect(screen.getByText(/our pools on Ethereum, Base and Robinhood\./)).toBeTruthy();
    expect(screen.queryByText(/not up to date/)).toBeNull();
  });

  it('says "at least" for a partial TVL, with no live dot, and names the chain it could not read', async () => {
    const missing = chains();
    missing[2] = { chain: 'base', read: false } as never;
    serve({ tvl: [tvl({ state: 'partial', usd: 11501.18, chains: missing }), 200], volume: [volume(), 200] });
    render(<VenueStats />);
    expect(await screen.findByText(/TVL at least/)).toBeTruthy();
    expect(screen.getByTestId('venue-tvl').querySelector('.rounded-full')).toBeNull();
    expect(screen.getByTestId('venue-tvl-chains').textContent).toContain('Base could not be read just now');
  });

  it('names a chain whose staking could not be read, and says when a staked coin had no price', async () => {
    const stakes = staking();
    stakes[2] = { chain: 'base', read: false } as never;
    stakes[0].unvalued = 1;
    serve({ tvl: [tvl({ state: 'partial', staking: stakes }), 200], volume: [volume(), 200] });
    render(<VenueStats />);
    expect(await screen.findByText(/TVL at least/)).toBeTruthy();
    expect(screen.getByTestId('venue-tvl-staking').textContent).toBe('Staked: Solana $22,440 · Ethereum $65 · Base could not be read just now');
    expect(screen.getByText('A staked coin with no market price just now is left out.')).toBeTruthy();
  });

  it('says a late volume count is not up to date', async () => {
    serve({ tvl: [tvl(), 200], volume: [volume({ state: 'behind' }), 200] });
    render(<VenueStats />);
    expect(await screen.findByText(/not up to date, last counted/)).toBeTruthy();
  });

  it('says a failed read could not be read, and shows no dollar figure', async () => {
    serve({ tvl: [{ state: 'unread' }, 502], volume: [{ state: 'unread' }, 502] });
    const { container } = render(<VenueStats />);
    expect(await screen.findByText('TVL could not be read')).toBeTruthy();
    expect(await screen.findByText('All-time volume could not be read')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('asks again every minute while in view, keeps the last TVL through failures, and then says how old it is', async () => {
    vi.useFakeTimers({ now: NOW });
    const answers = { tvl: [tvl(), 200] as [unknown, number], volume: [volume(), 200] as [unknown, number] };
    const f = serve(answers);
    render(<VenueStats />);
    await act(async () => {});
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $34,240');
    const tvlCalls = () => f.mock.calls.filter(([u]) => u === VENUE_TVL_URL).length;
    expect(tvlCalls()).toBe(1);

    answers.tvl = [{ state: 'unread' }, 502];
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(tvlCalls()).toBe(4);
    // Three minutes of failed reads: the figure stays, says when it was read, and is no longer live.
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $34,240');
    await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(screen.getByTestId('venue-tvl').textContent).toMatch(/^TVL \$34,240 as of /);
    expect(screen.getByTestId('venue-tvl').querySelector('.rounded-full')).toBeNull();

    // Out of view, nothing is asked.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => vi.advanceTimersByTime(POLL_MS * 3));
    expect(tvlCalls()).toBe(5);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    answers.tvl = [tvl(), 200];
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(tvlCalls()).toBe(6);
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $34,240');
  });
});
