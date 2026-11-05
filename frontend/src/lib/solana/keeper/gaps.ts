/**
 * The gap log (owner, 2026-11-05: "log every gap it skips"): one line per gap the keeper saw
 * against Jupiter, written once a pass finds it closed. How long it stayed open, how soon the
 * keeper traded it, how big a trip it wanted beside the cap, and why each pass that left it did.
 * It measures what a faster or bigger keeper would add before anyone pays for one.
 *
 * What it cannot see: a gap opens at the first pass that sees it, not when it appeared. A pass
 * runs when the quick check (every 10 s) finds a change, and at least every minute, so a gap is
 * seen up to that late, and one that came and went between two checks is not seen at all. Trips
 * between two of our own pools are not here (the trades log has them), nor are gaps still open
 * when the robot stops.
 */

/** Why a pass left a gap against Jupiter untraded. The pass's own log line says it in full. */
export type Skip =
  /** planFor refused it: no price for the coin, too small to trade. */
  | 'no-plan'
  /** The keeper held none of the pool's coin. */
  | 'no-coin'
  /** No SOL price to count a new token account's rent. */
  | 'no-sol-price'
  /** At Jupiter's real quote, or our pool's, the trip makes less than the floor. */
  | 'quote-short'
  /** The test run failed. */
  | 'test-failed'
  /** The test run did not pass its checks: almost always, it made less than the floor. */
  | 'test-checks'
  /** It passed, but nothing may be sent now: a dry run, the stop file, the day's cap. */
  | 'not-sent'
  /** Jupiter found no route (that avoids the refused venues). */
  | 'no-route'
  | 'error';

/** A gap one pass found worth the floor at Jupiter's listed price, and what came of it. */
export interface GapSeen {
  pool: string;
  tokenMint: string;
  /** The pool's coin, SOL or USDC: a name the keeper sets itself, never the token's. */
  coin: string;
  /** When the pass weighed the pool, in ms. */
  at: number;
  /** `arbitrage`'s profit at Jupiter's LISTED price, before the other leg's cost: an upper bound. */
  listedUsd: number;
  /** The trip the gap wants, in USD, before the cap or the keeper's holdings cut it. */
  wantUsd: number;
  outcome: 'sent' | 'unsure' | Skip;
}

/** One gap, from the first pass that saw it to the latest. */
export interface GapRun {
  pool: string;
  tokenMint: string;
  coin: string;
  opened: number;
  passes: number;
  bestListedUsd: number;
  /** The trip wanted at the pass with the best listed profit. */
  wantUsd: number;
  /** When the first trip was sent, or null. */
  firstTrip: number | null;
  /** How many passes ended each way. */
  outcomes: Partial<Record<GapSeen['outcome'], number>>;
}

export interface ClosedGap extends GapRun {
  closed: number;
}

const traded = (o: GapSeen['outcome']) => o === 'sent' || o === 'unsure';

/**
 * Fold one pass into the open gaps. A pool the pass weighed (`looked`) with no gap in `seen` has
 * closed at `at`; a pool it did not weigh (moved by a trip this pass, or the pass stopped early)
 * keeps its gap open. Nothing is changed in place.
 */
export function foldGaps(
  open: ReadonlyMap<string, GapRun>,
  pass: { looked: readonly string[]; seen: readonly GapSeen[] },
  at: number,
): { open: Map<string, GapRun>; closed: ClosedGap[] } {
  const next = new Map(open);
  const closed: ClosedGap[] = [];
  const seen = new Map(pass.seen.map((g) => [g.pool, g]));
  for (const pool of new Set([...pass.looked, ...seen.keys()])) {
    const g = seen.get(pool);
    const run = next.get(pool);
    if (!g) {
      if (run) {
        closed.push({ ...run, closed: at });
        next.delete(pool);
      }
      continue;
    }
    const was: GapRun = run ?? { pool, tokenMint: g.tokenMint, coin: g.coin, opened: g.at, passes: 0, bestListedUsd: -Infinity, wantUsd: 0, firstTrip: null, outcomes: {} };
    const best = g.listedUsd > was.bestListedUsd;
    next.set(pool, {
      ...was,
      passes: was.passes + 1,
      bestListedUsd: best ? g.listedUsd : was.bestListedUsd,
      wantUsd: best ? g.wantUsd : was.wantUsd,
      firstTrip: was.firstTrip ?? (traded(g.outcome) ? g.at : null),
      outcomes: { ...was.outcomes, [g.outcome]: (was.outcomes[g.outcome] ?? 0) + 1 },
    });
  }
  return { open: next, closed };
}

export const GAP_HEADER = 'opened,closed,open_sec,first_trip_sec,passes,coin,best_listed_usd,want_usd,cap_usd,what_happened,token,pool';

const BASE58_ONLY = /[^1-9A-HJ-NP-Za-km-z]/g;
const seconds = (ms: number) => String(Math.max(0, Math.round(ms / 1000)));

/**
 * One closed gap as a line of the gap log. Times, numbers, the keeper's own words and addresses
 * only: nothing a token chose is written, so the file opens safely anywhere, a spreadsheet included.
 */
export function gapLine(g: ClosedGap, capUsd: number): string {
  const what = Object.entries(g.outcomes).map(([o, n]) => `${o} ${n}`).join(' ');
  return [
    new Date(g.opened).toISOString(),
    new Date(g.closed).toISOString(),
    seconds(g.closed - g.opened),
    g.firstTrip === null ? '' : seconds(g.firstTrip - g.opened),
    g.passes,
    g.coin.replace(/[^A-Za-z]/g, ''),
    g.bestListedUsd.toFixed(4),
    g.wantUsd.toFixed(2),
    capUsd,
    what,
    g.tokenMint.replace(BASE58_ONLY, ''),
    g.pool.replace(BASE58_ONLY, ''),
  ].join(',');
}

/** Each reason, as the report says it. */
const SAID: Record<Skip, string> = {
  'no-plan': 'could not size the trip',
  'no-coin': 'held none of the coin',
  'no-sol-price': 'no SOL price',
  'quote-short': 'the real price was worse than the listed one',
  'test-failed': 'the test run failed',
  'test-checks': 'the test run made too little',
  'not-sent': 'paused, or a dry run',
  'no-route': 'Jupiter had no route',
  error: 'an error',
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The `report` command's lines for the gap log's text. A line that does not read (a hand edit) is left out. */
export function gapReport(text: string): string[] {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [opened, , openSec, firstTripSec, , , listed, want, cap, what] = line.split(',');
      const outcomes = new Map<string, number>();
      for (const [o, n] of (what ?? '').match(/[a-z-]+ \d+/g)?.map((p) => p.split(' ')) ?? []) outcomes.set(o!, Number(n));
      return { opened: opened ?? '', open: Number(openSec), firstTrip: firstTripSec ? Number(firstTripSec) : null, listed: Number(listed), want: Number(want), cap: Number(cap), outcomes };
    })
    .filter((r) => r.opened && [r.open, r.listed, r.want, r.cap].every(Number.isFinite));
  if (!rows.length) return [];
  const took = rows.filter((r) => r.firstTrip !== null);
  const left = rows.filter((r) => r.firstTrip === null);
  const out = [`Gaps seen: ${rows.length}, ${rows[0]!.opened.slice(0, 16)} to ${rows.at(-1)!.opened.slice(0, 16)} UTC`];
  if (took.length) {
    const capped = took.filter((r) => r.want > r.cap);
    out.push(
      `  traded: ${took.length} · first trip a median ${median(took.map((r) => r.firstTrip!))} s after the keeper saw it · open a median ${median(took.map((r) => r.open))} s` +
        (capped.length ? ` · ${capped.length} wanted more than the cap (median $${median(capped.map((r) => r.want)).toFixed(0)} against $${median(capped.map((r) => r.cap))})` : ''),
    );
  }
  if (left.length) {
    const why = new Map<string, number>();
    for (const r of left) for (const [o, n] of r.outcomes) why.set(o, (why.get(o) ?? 0) + n);
    const said = [...why].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${SAID[o as Skip] ?? o} ${n}`);
    out.push(`  left alone: ${left.length} · open a median ${median(left.map((r) => r.open))} s · passes that skipped them: ${said.join(', ')}`);
    out.push(`  their best listed profits add to $${left.reduce((sum, r) => sum + r.listed, 0).toFixed(2)}: an upper bound, the real price on a thin coin is often worse`);
  }
  return out;
}
