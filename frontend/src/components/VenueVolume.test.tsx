import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VenueVolume } from './VenueVolume';
import { parseVenueVolume } from '../lib/venueVolume';

const NOW = Date.parse('2026-10-19T16:30:00Z');
const answer = (over: Record<string, unknown> = {}) => ({
  state: 'current',
  usd: 2481.26,
  swaps: 67,
  unpricedSwaps: 0,
  asOf: '2026-10-19T16:00:00.000Z',
  staleAt: '2026-10-20T01:00:00.000Z',
  ...over,
});

describe('parseVenueVolume', () => {
  it('turns a cached "current" answer behind once its staleAt has passed', () => {
    expect(parseVenueVolume(answer(), NOW).state).toBe('current');
    expect(parseVenueVolume(answer(), Date.parse('2026-10-20T01:00:01Z')).state).toBe('behind');
    expect(parseVenueVolume(answer({ state: 'behind' }), NOW).state).toBe('behind');
  });

  it('reads anything it cannot trust as unread, never as a number', () => {
    for (const bad of [null, 'html', { state: 'unread' }, answer({ usd: null }), answer({ usd: -1 }), answer({ asOf: 'x' }), answer({ staleAt: undefined })]) {
      expect(parseVenueVolume(bad, NOW)).toEqual({ state: 'unread' });
    }
  });
});

describe('<VenueVolume />', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('shows the dollars and when they were counted', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve(answer());
    render(<VenueVolume />);
    expect(await screen.findByText('$2,481')).toBeTruthy();
    expect(screen.getByText(/^as of /)).toBeTruthy();
    expect(screen.queryByText(/not up to date/)).toBeNull();
    // GitHub fires the "hourly" job every few hours, so the small print says that.
    expect(screen.getByText(/Counted every few hours\./)).toBeTruthy();
    // The job counts our factory's pools on every EVM chain it reads, Base included.
    expect(screen.getByText(/our pools on Ethereum, Base and Robinhood\./)).toBeTruthy();
    vi.useRealTimers();
  });

  it('says a late count is not up to date', async () => {
    serve(answer({ state: 'behind' }));
    render(<VenueVolume />);
    expect(await screen.findByText(/not up to date, last counted/)).toBeTruthy();
    expect(screen.queryByText(/^as of /)).toBeNull();
  });

  it('says a failed read could not be read, and shows no dollar figure', async () => {
    serve({ state: 'unread' }, 502);
    const { container } = render(<VenueVolume />);
    expect(await screen.findByText('All-time volume could not be read')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$/);
  });
});
