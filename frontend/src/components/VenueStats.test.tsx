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
const tvl = (over: Record<string, unknown> = {}) => ({ state: 'current', usd: 11734.62, chains: chains(), readAt: '2026-10-19T16:29:30.000Z', ...over });

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
  it('reads a whole answer, every chain in order', () => {
    const t = parseVenueTvl(tvl());
    expect(t).toMatchObject({ state: 'current', usd: 11734.62 });
    expect(t.state !== 'unread' && t.chains.map((c) => c.chain)).toEqual(['solana', 'ethereum', 'base', 'robinhood']);
  });

  it('reads "current" with a chain missing or a pool left out as partial, never whole', () => {
    const missing = chains();
    missing[2] = { chain: 'base', read: false } as never;
    expect(parseVenueTvl(tvl({ chains: missing })).state).toBe('partial');
    const left = chains();
    left[0].unvalued = 1;
    expect(parseVenueTvl(tvl({ chains: left })).state).toBe('partial');
  });

  it('reads anything it cannot trust as unread, never as a number', () => {
    const short = chains().slice(1);
    const swapped = [chains()[1], chains()[0], ...chains().slice(2)];
    const bad = chains();
    bad[1].usd = -5;
    for (const body of [null, 'html', { state: 'unread' }, tvl({ usd: null }), tvl({ usd: -1 }), tvl({ readAt: 'x' }), tvl({ chains: short }), tvl({ chains: swapped }), tvl({ chains: bad })]) {
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

  it('shows the TVL, live, and the all-time volume, with each chain in the small print', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve({ tvl: [tvl(), 200], volume: [volume(), 200] });
    render(<VenueStats />);
    expect(await screen.findByText('$11,735')).toBeTruthy();
    expect(await screen.findByText('$2,481')).toBeTruthy();
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $11,735');
    expect(screen.getByTestId('venue-tvl').querySelector('.rounded-full')).toBeTruthy();
    expect(screen.getByTestId('venue-tvl-chains').textContent).toBe('Solana $11,060 · Ethereum $442 · Base $233 · Robinhood $0');
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
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $11,735');
    const tvlCalls = () => f.mock.calls.filter(([u]) => u === VENUE_TVL_URL).length;
    expect(tvlCalls()).toBe(1);

    answers.tvl = [{ state: 'unread' }, 502];
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(tvlCalls()).toBe(4);
    // Three minutes of failed reads: the figure stays, says when it was read, and is no longer live.
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $11,735');
    await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(screen.getByTestId('venue-tvl').textContent).toMatch(/^TVL \$11,735 as of /);
    expect(screen.getByTestId('venue-tvl').querySelector('.rounded-full')).toBeNull();

    // Out of view, nothing is asked.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => vi.advanceTimersByTime(POLL_MS * 3));
    expect(tvlCalls()).toBe(5);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    answers.tvl = [tvl(), 200];
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(tvlCalls()).toBe(6);
    expect(screen.getByTestId('venue-tvl').textContent).toBe('TVL $11,735');
  });
});
