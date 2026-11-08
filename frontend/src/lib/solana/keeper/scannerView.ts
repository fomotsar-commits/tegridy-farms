import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { isAddress, isObject } from './takes';

/**
 * The arbitrage scanner's page (scripts/arb-scanner.mjs, `/state.json`) as the robot's dashboard
 * shows it. The page is another program's answer on this computer, and every coin name in it is
 * the coin's own claim, so nothing passes but what is checked here: addresses that are addresses,
 * numbers that are numbers, names cut short and stripped of the characters that can disguise them
 * (a right-to-left mark can make "YOS" read "SOY"). The dashboard's page writes all of it as text.
 * A row that is not a whole trip is left out and counted.
 */

/** What limited a trip's size: the whole gap, all the robot holds, or the robot's cap. */
export type SizedBy = 'gap' | 'float' | 'cap';

export interface ScannerLeg {
  pool: string;
  /** The exchange's own name, as the scanner gives it (text only). */
  venue: string;
  /** Our venue's own pool: its fee is shared with the venue. */
  ours: boolean;
  from: string;
  to: string;
  fromTicker: string;
  toTicker: string;
  /** The pool's fee, as a share (0.003 = 0.3%). */
  fee: number;
  /** Depth read roughly (a price-bin pool). */
  rough: boolean;
}

export interface ScannerProof {
  ok: boolean;
  /** A pool in it has not traded for about an hour: not tried. */
  quiet: boolean;
  why: string | null;
  at: number;
  slot: number | null;
  units: number | null;
  gainedUsd: number | null;
}

export interface ScannerTrip {
  mint: string;
  /** The ticker the coin claims: shown beside its whole address, never alone. */
  symbol: string;
  /** The coin is in one of our pools. */
  ours: boolean;
  /** The coin the trip starts and ends in (SOL or USDC). */
  coin: string;
  coinTicker: string;
  legs: ScannerLeg[];
  gapPct: number;
  /** The pools' fees, together. */
  costPct: number;
  /** How far the gap is under the fees (0 when it clears them). */
  shortPct: number;
  inUsd: number;
  sizedBy: SizedBy | null;
  gapInUsd: number | null;
  floatUsd: number | null;
  capUsd: number | null;
  netUsd: number;
  roiPct: number;
  gapNetUsd: number | null;
  /** The robot trades a trip of this shape today. */
  robotTakes: boolean;
  threeSwap: boolean;
  why: string | null;
  slot: number | null;
  scannedAt: number | null;
  proof: ScannerProof | null;
}

export interface ScannerView {
  at: number;
  slot: number | null;
  note: string | null;
  solUsd: number | null;
  /** The robot's coins as the scanner read them, by ticker. */
  holds: { ticker: string; amount: number; usd: number | null }[];
  rule: {
    capUsd: number | null;
    settingUsd: number | null;
    safeCapUsd: number | null;
    minProfitUsd: number | null;
    feeLamports: number | null;
    floorUsd: { SOL: number | null; USDC: number | null };
    lighthouse: { proven: boolean; why: string | null };
  };
  coins: number | null;
  pools: number | null;
  looked: number | null;
  cycleAt: number | null;
  stats: {
    scans: number;
    paying: number;
    tried: number;
    passed: number;
    routesPassed: number;
    hours: number;
    /** Each of the above an hour, since the scanner started. */
    perHour: { scans: number; paying: number; tried: number; passed: number };
  } | null;
  take: ScannerTrip[];
  watch: ScannerTrip[];
  closest: ScannerTrip[];
  refused: { mint: string; symbol: string; problem: string }[];
  /** Rows left out as not whole trips. */
  dropped: number;
}

/** At most this many of each list are passed on: the scanner sends 60 to watch and 20 closest. */
export const MAX_ROWS = { take: 30, watch: 60, closest: 20, refused: 60 } as const;

const FIXED: Readonly<Record<string, string>> = { [SOL_QUOTE.mint]: 'SOL', [USDC_QUOTE.mint]: 'USDC' };

// Control characters, and the invisible marks that reorder or hide text.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Variation_Selector}\u{115F}\u{1160}\u{3164}]/gu;

/** Text another program wrote: a string, its hidden marks taken out, cut to `max` characters. */
export function plainText(x: unknown, max: number): string | null {
  if (typeof x !== 'string') return null;
  const s = [...x.replace(HIDDEN, '').trim()].slice(0, max).join('');
  return s === '' ? null : s;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const count = (x: unknown): number | null => {
  const n = num(x);
  return n !== null && n >= 0 ? Math.floor(n) : null;
};
const SIZED: readonly string[] = ['gap', 'float', 'cap'];

function legOf(l: unknown, token: string, symbol: string): ScannerLeg | null {
  if (!isObject(l) || !isAddress(l.pool) || !isAddress(l.from) || !isAddress(l.to)) return null;
  const fee = num(l.fee);
  if (fee === null || fee < 0 || fee >= 1) return null;
  const ticker = (m: string) => FIXED[m] ?? (m === token ? symbol : '?');
  const dex = plainText(l.dex, 24);
  return {
    pool: l.pool,
    venue: plainText(l.venue, 40) ?? dex ?? '?',
    ours: dex === 'ours',
    from: l.from,
    to: l.to,
    fromTicker: ticker(l.from),
    toTicker: ticker(l.to),
    fee,
    rough: l.rough === true,
  };
}

function proofOf(p: unknown): ScannerProof | null {
  if (!isObject(p) || typeof p.ok !== 'boolean') return null;
  const at = num(p.at);
  if (at === null) return null;
  return { ok: p.ok, quiet: p.quiet === true, why: plainText(p.why, 240), at, slot: count(p.slot), units: count(p.units), gainedUsd: num(p.gainedUsd) };
}

/** One scanner row as a whole trip, or null: a coin, two or three legs chaining from its start coin back to it, and its figures. */
export function tripOf(row: unknown): ScannerTrip | null {
  if (!isObject(row) || !isAddress(row.mint) || !isAddress(row.coin) || !FIXED[row.coin] || !Array.isArray(row.legs)) return null;
  if (row.legs.length < 2 || row.legs.length > 3) return null;
  const symbol = plainText(row.symbol, 24) ?? '?';
  const legs: ScannerLeg[] = [];
  for (const l of row.legs) {
    const leg = legOf(l, row.mint, symbol);
    if (!leg) return null;
    legs.push(leg);
  }
  // A round trip: each leg starts where the one before it ended, from the start coin back to it.
  if (legs[0]!.from !== row.coin || legs[legs.length - 1]!.to !== row.coin) return null;
  if (legs.some((l, i) => i > 0 && l.from !== legs[i - 1]!.to)) return null;
  const [gapPct, costPct, inUsd, netUsd, roiPct] = [num(row.gapPct), num(row.costPct), num(row.inUsd), num(row.netUsd), num(row.roiPct)];
  if (gapPct === null || costPct === null || inUsd === null || netUsd === null || roiPct === null) return null;
  return {
    mint: row.mint,
    symbol,
    ours: row.ours === true,
    coin: row.coin,
    coinTicker: FIXED[row.coin]!,
    legs,
    gapPct,
    costPct,
    shortPct: Math.max(0, costPct - gapPct),
    inUsd,
    sizedBy: typeof row.sizedBy === 'string' && SIZED.includes(row.sizedBy) ? (row.sizedBy as SizedBy) : null,
    gapInUsd: num(row.gapInUsd),
    floatUsd: num(row.floatUsd),
    capUsd: num(row.capUsd),
    netUsd,
    roiPct,
    gapNetUsd: num(row.gapNetUsd),
    robotTakes: row.robotTakes === true,
    threeSwap: legs.length === 3,
    why: plainText(row.why, 240),
    slot: count(row.slot),
    scannedAt: num(row.scannedAt),
    proof: proofOf(row.proof),
  };
}

/** The scanner's `/state.json` as the dashboard shows it, or a plain reason it cannot be. */
export function scannerView(state: unknown): ScannerView | string {
  if (!isObject(state)) return 'its page is not a scanner’s page';
  const at = num(state.at);
  if (at === null || !isObject(state.rule)) return 'its page is not a scanner’s page';
  let dropped = 0;
  const rows = (x: unknown, max: number) => {
    const out: ScannerTrip[] = [];
    for (const r of Array.isArray(x) ? x : []) {
      const t = tripOf(r);
      if (t && out.length < max) out.push(t);
      else if (!t) dropped++;
    }
    return out;
  };
  const rule = state.rule;
  const floor = isObject(rule.floorUsd) ? rule.floorUsd : {};
  const lh = isObject(rule.lighthouse) ? rule.lighthouse : {};
  const st = isObject(state.stats) ? state.stats : null;
  let stats: ScannerView['stats'] = null;
  if (st) {
    const [scans, paying, tried, passed] = [count(st.scans), count(st.paying), count(st.tried), count(st.passed)];
    const hours = num(st.hours);
    if (scans !== null && paying !== null && tried !== null && passed !== null && hours !== null && hours > 0) {
      // As the scanner's own page counts them: never less than a minute, so a fresh start is not a spike.
      const h = Math.max(hours, 1 / 60);
      stats = { scans, paying, tried, passed, routesPassed: count(st.routesPassed) ?? 0, hours, perHour: { scans: scans / h, paying: paying / h, tried: tried / h, passed: passed / h } };
    }
  }
  const holdsUsd = isObject(state.holdsUsd) ? state.holdsUsd : {};
  const holds = Object.entries(isObject(state.holds) ? state.holds : {})
    .slice(0, 8)
    .flatMap(([k, v]) => {
      const ticker = plainText(k, 12);
      const amount = num(v);
      return ticker && amount !== null ? [{ ticker, amount, usd: num(holdsUsd[k]) }] : [];
    });
  const refused = (Array.isArray(state.refused) ? state.refused : []).flatMap((c: unknown) =>
    isObject(c) && isAddress(c.mint) ? [{ mint: c.mint, symbol: plainText(c.symbol, 24) ?? '?', problem: plainText(c.problem, 160) ?? 'refused' }] : [],
  ).slice(0, MAX_ROWS.refused);
  const view: ScannerView = {
    at,
    slot: count(state.slot),
    note: plainText(state.note, 200),
    solUsd: num(state.solUsd),
    holds,
    rule: {
      capUsd: num(rule.capUsd),
      settingUsd: num(rule.settingUsd),
      safeCapUsd: num(rule.safeCapUsd),
      minProfitUsd: num(rule.minProfitUsd),
      feeLamports: count(rule.feeLamports),
      floorUsd: { SOL: num(floor.SOL), USDC: num(floor.USDC) },
      lighthouse: { proven: lh.proven === true, why: plainText(lh.why, 200) },
    },
    coins: count(state.coins),
    pools: count(state.pools),
    looked: count(state.looked),
    cycleAt: num(state.cycleAt),
    stats,
    take: rows(state.take, MAX_ROWS.take),
    watch: rows(state.watch, MAX_ROWS.watch),
    closest: rows(state.closest, MAX_ROWS.closest),
    refused,
    dropped: 0,
  };
  view.dropped = dropped;
  return view;
}

/** What the dashboard knows of the scanner: its latest view, and why the latest read failed. */
export interface ScannerFeed {
  /** The page read, as shown (no path, no query). Null when KEEPER_SCANNER_URL is not set. */
  page: string | null;
  view: ScannerView | null;
  /** When `view` was read. */
  readAt: number | null;
  /** Why the latest read failed; null when it did not. */
  problem: string | null;
}

/** A view is shown this long after the scanner stops answering, marked old; then it is dropped (its trips are long gone). */
export const SCANNER_KEEP_MS = 2 * 60_000;

/** The feed after one read: a view replaces the last; a failure keeps the last view a while, saying why. */
export function nextScannerFeed(prev: ScannerFeed, read: ScannerView | string, now: number): ScannerFeed {
  if (typeof read !== 'string') return { ...prev, view: read, readAt: now, problem: null };
  const keep = prev.view !== null && prev.readAt !== null && now - prev.readAt < SCANNER_KEEP_MS;
  return { ...prev, view: keep ? prev.view : null, readAt: keep ? prev.readAt : null, problem: read };
}
