import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FillScoreLine } from './FillScoreLine';
import { againstQuote, parseFillScoreboard } from '../../lib/fillScoreboard';

const NOW = Date.parse('2026-10-22T12:00:00Z');
// The dry run over mainnet of 2026-10-22, as the read serves it.
const answer = (over: Record<string, unknown> = {}) => ({
  state: 'current',
  asOf: '2026-10-22T11:41:00.000Z',
  staleAt: '2026-10-22T14:41:00.000Z',
  windowDays: 30,
  trades: 38,
  unscored: 0,
  medianFillBps: 0.04,
  worstFillBps: -2.32,
  atOrAboveQuote: 35,
  nearFloor: 0,
  deposits: { trades: 2, lamports: '2946400' },
  ...over,
});

describe('parseFillScoreboard', () => {
  it('turns a cached "current" answer behind once its staleAt has passed', () => {
    expect(parseFillScoreboard(answer(), NOW).state).toBe('current');
    expect(parseFillScoreboard(answer(), Date.parse('2026-10-22T14:41:01Z')).state).toBe('behind');
    expect(parseFillScoreboard(answer({ state: 'behind' }), NOW).state).toBe('behind');
  });

  it('reads anything it cannot trust as unread, never as a figure', () => {
    for (const bad of [
      null,
      'html',
      { state: 'unread' },
      answer({ trades: -1 }),
      answer({ trades: 1.5 }),
      answer({ atOrAboveQuote: 39 }),
      answer({ nearFloor: 39 }),
      answer({ medianFillBps: 'x' }),
      answer({ deposits: { trades: 2, lamports: 2946400 } }),
      answer({ asOf: 'x' }),
    ]) {
      expect(parseFillScoreboard(bad, NOW)).toEqual({ state: 'unread' });
    }
  });

  it('keeps the deposit lamports exact', () => {
    const r = parseFillScoreboard(answer({ deposits: { trades: 1, lamports: '9007199254740993' } }), NOW);
    expect(r.state !== 'unread' && r.deposits.lamports).toBe(9007199254740993n);
  });
});

describe('againstQuote', () => {
  it('says "at the quote" inside half a basis point, else the percent and the side', () => {
    expect(againstQuote(0.04)).toBe('at the quote');
    expect(againstQuote(-2.32)).toBe('0.02% under the quote');
    expect(againstQuote(12.5)).toBe('0.13% over the quote');
  });
});

describe('<FillScoreLine />', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('says how many trades got at least the quote and how many landed near the floor', async () => {
    serve(answer());
    render(<FillScoreLine />);
    expect(await screen.findByText(/35 of 38 got at least the quote, none near the slippage floor/)).toBeTruthy();
    expect(screen.getByText(/Typical trade: at the quote\. Worst: 0\.02% under the quote\./)).toBeTruthy();
    expect(screen.getByText(/2 also left 0\.0029 SOL as deposits/)).toBeTruthy();
    expect(screen.queryByText(/Not up to date/)).toBeNull();
  });

  it('says a late record is not up to date', async () => {
    serve(answer({ state: 'behind' }));
    render(<FillScoreLine />);
    expect(await screen.findByText(/Not up to date, last read/)).toBeTruthy();
  });

  it('shows nothing when the record could not be read, so no figure is claimed', async () => {
    const fetchMock = vi.fn(async () => new Response('{"state":"unread"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<FillScoreLine />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });
});
