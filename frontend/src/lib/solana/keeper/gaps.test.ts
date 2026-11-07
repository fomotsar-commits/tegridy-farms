import { describe, it, expect } from 'vitest';
import { GAP_HEADER, foldGaps, gapLine, gapReport, type ClosedGap, type GapRun, type GapSeen } from './gaps';

const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const OTHER = 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm';
const TOKEN = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const T0 = Date.UTC(2026, 10, 5, 4, 0, 0);
const sec = (s: number) => T0 + s * 1000;

const gap = (over: Partial<GapSeen> = {}): GapSeen => ({ pool: POOL, tokenMint: TOKEN, coin: 'SOL', at: T0, listedUsd: 0.2, wantUsd: 40, outcome: 'sent', ...over });
const none = new Map<string, GapRun>();

describe('foldGaps', () => {
  it('opens a gap when a pass first sees it, at the moment the pass weighed the pool', () => {
    const { open, closed } = foldGaps(none, { looked: [POOL], seen: [gap({ at: sec(3), outcome: 'quote-short' })] }, sec(9));
    expect(closed).toEqual([]);
    expect(open.get(POOL)).toEqual({ pool: POOL, tokenMint: TOKEN, coin: 'SOL', opened: sec(3), passes: 1, bestListedUsd: 0.2, wantUsd: 40, firstTrip: null, outcomes: { 'quote-short': 1 } });
  });

  it('keeps the best listed profit with the trip it wanted, counts each ending, and keeps the FIRST trip’s time', () => {
    let open: Map<string, GapRun> = none;
    open = foldGaps(open, { looked: [POOL], seen: [gap({ at: sec(0), listedUsd: 0.1, wantUsd: 20, outcome: 'quote-short' })] }, sec(5)).open;
    open = foldGaps(open, { looked: [POOL], seen: [gap({ at: sec(20), listedUsd: 0.3, wantUsd: 60, outcome: 'sent' })] }, sec(25)).open;
    open = foldGaps(open, { looked: [POOL], seen: [gap({ at: sec(40), listedUsd: 0.2, wantUsd: 45, outcome: 'sent' })] }, sec(45)).open;
    expect(open.get(POOL)).toMatchObject({ opened: sec(0), passes: 3, bestListedUsd: 0.3, wantUsd: 60, firstTrip: sec(20), outcomes: { 'quote-short': 1, sent: 2 } });
  });

  it('counts a trip whose ending is unknown as a trip', () => {
    const { open } = foldGaps(none, { looked: [POOL], seen: [gap({ at: sec(7), outcome: 'unsure' })] }, sec(9));
    expect(open.get(POOL)?.firstTrip).toBe(sec(7));
  });

  it('closes a gap when a pass weighs its pool and finds none, at that pass', () => {
    const first = foldGaps(none, { looked: [POOL, OTHER], seen: [gap(), gap({ pool: OTHER, coin: 'USDC' })] }, sec(5));
    const { open, closed } = foldGaps(first.open, { looked: [POOL, OTHER], seen: [gap({ pool: OTHER, coin: 'USDC', at: sec(60) })] }, sec(65));
    expect(closed.map((g) => [g.pool, g.closed])).toEqual([[POOL, sec(65)]]);
    expect([...open.keys()]).toEqual([OTHER]);
  });

  it('keeps a gap open when the pass did not weigh its pool (moved by a trip, or the pass stopped)', () => {
    const first = foldGaps(none, { looked: [POOL], seen: [gap()] }, sec(5));
    const { open, closed } = foldGaps(first.open, { looked: [OTHER], seen: [] }, sec(65));
    expect(closed).toEqual([]);
    expect(open.get(POOL)?.passes).toBe(1);
    expect(foldGaps(first.open, { looked: [], seen: [] }, sec(65)).open.has(POOL)).toBe(true);
  });

  it('changes nothing it is handed', () => {
    const first = foldGaps(none, { looked: [POOL], seen: [gap()] }, sec(5)).open;
    const before = structuredClone(first);
    foldGaps(first, { looked: [POOL], seen: [gap({ outcome: 'no-route' })] }, sec(65));
    foldGaps(first, { looked: [POOL], seen: [] }, sec(65));
    expect(first).toEqual(before);
    expect(none.size).toBe(0);
  });
});

const closedGap = (over: Partial<ClosedGap> = {}): ClosedGap => ({
  pool: POOL,
  tokenMint: TOKEN,
  coin: 'SOL',
  opened: sec(0),
  closed: sec(95),
  passes: 4,
  bestListedUsd: 0.31234,
  wantUsd: 61.5,
  firstTrip: sec(2),
  outcomes: { sent: 3, 'quote-short': 1 },
  ...over,
});

describe('gapLine', () => {
  it('writes one line in the header’s order', () => {
    expect(GAP_HEADER.split(',')).toHaveLength(12);
    expect(gapLine(closedGap(), 25)).toBe(`2026-11-05T04:00:00.000Z,2026-11-05T04:01:35.000Z,95,2,4,SOL,0.3123,61.50,25,sent 3 quote-short 1,${TOKEN},${POOL}`);
  });

  it('leaves the first trip empty when no trip went out', () => {
    expect(gapLine(closedGap({ firstTrip: null, outcomes: { 'no-route': 2 } }), 25).split(',').slice(3, 4)).toEqual(['']);
  });

  it('writes nothing but address letters where an address goes, and letters for the coin', () => {
    const cells = gapLine(closedGap({ pool: `=HYPERLINK("x"),${POOL}`, tokenMint: `${TOKEN}\n=1+1`, coin: '=SOL,' }), 25).split(',');
    expect(cells).toHaveLength(12);
    expect(cells[5]).toBe('SOL');
    expect(cells[10]).toBe(`${TOKEN}11`);
    // Base58 has no capital I.
    expect(cells[11]).toBe(`HYPERLNKx${POOL}`);
  });
});

describe('gapReport', () => {
  const log = (...gaps: ClosedGap[]) => [GAP_HEADER, ...gaps.map((g) => gapLine(g, 25))].join('\n');

  it('says nothing for an empty or missing log', () => {
    expect(gapReport('')).toEqual([]);
    expect(gapReport(GAP_HEADER)).toEqual([]);
  });

  it('splits traded gaps from the ones left alone, with medians, the cap, and the reasons in words', () => {
    const lines = gapReport(
      log(
        closedGap({ firstTrip: sec(0), closed: sec(40), wantUsd: 60 }),
        closedGap({ firstTrip: sec(10), closed: sec(100), wantUsd: 20, opened: sec(1) }),
        closedGap({ firstTrip: sec(30), closed: sec(80), wantUsd: 80 }),
        closedGap({ firstTrip: null, closed: sec(20), bestListedUsd: 0.5, outcomes: { 'quote-short': 2 } }),
        closedGap({ firstTrip: null, closed: sec(60), bestListedUsd: 0.25, outcomes: { 'no-route': 1, 'quote-short': 1 } }),
      ),
    );
    expect(lines).toEqual([
      'Gaps seen: 5, 2026-11-05T04:00 to 2026-11-05T04:00 UTC',
      '  traded: 3 · first trip a median 9 s after the keeper saw it · open a median 80 s · 2 wanted more than the cap (median $70 against $25)',
      '  left alone: 2 · open a median 40 s · passes that skipped them: the real price was worse than the listed one 3, Jupiter had no route 1',
      '  their best listed profits add to $0.75: an upper bound, the real price on a thin coin is often worse',
    ]);
  });

  it('leaves out a line that does not read, and says nothing of the cap when no trip wanted more', () => {
    const lines = gapReport(`${log(closedGap({ wantUsd: 10 }))}\nnot,a,line\n,,,`);
    expect(lines[0]).toMatch(/^Gaps seen: 1,/);
    expect(lines[1]).not.toMatch(/cap/);
    expect(lines).toHaveLength(2);
  });
});
