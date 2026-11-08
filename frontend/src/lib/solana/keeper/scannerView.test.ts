// @vitest-environment node
//
// The scanner's page as the robot's dashboard shows it: only whole trips, checked addresses,
// finite figures and names stripped of what can disguise them; a scanner that stops answering
// is said, its last view kept a short while and then dropped.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { MAX_ROWS, SCANNER_KEEP_MS, nextScannerFeed, plainText, scannerView, tripOf, type ScannerFeed, type ScannerView } from './scannerView';
import { scannerPageUrl } from './takes';

const addr = () => Keypair.generate().publicKey.toBase58();
const TOKEN = addr();
const P1 = addr();
const P2 = addr();
const SOL = SOL_QUOTE.mint;
const USDC = USDC_QUOTE.mint;

const row = (over: Record<string, unknown> = {}) => ({
  mint: TOKEN,
  symbol: 'SOY',
  ours: true,
  slot: 466_006_468,
  scannedAt: 1_793_945_982_350,
  coin: SOL,
  legs: [
    { pool: P1, dex: 'pumpswap', from: SOL, to: TOKEN, fee: 0.003, rough: false, venue: 'PumpSwap' },
    { pool: P2, dex: 'ours', from: TOKEN, to: SOL, fee: 0.01, rough: false, venue: 'Tegriddy Farms (ours)' },
  ],
  gapPct: 19.58,
  costPct: 1.3,
  inUsd: 10.39,
  netUsd: 0.896,
  roiPct: 8.63,
  gapInUsd: 10.39,
  gapNetUsd: 0.896,
  capUsd: 25,
  floatUsd: 60.86,
  sizedBy: 'gap',
  robotTakes: true,
  why: null,
  proof: { ok: false, why: 'a pool has not traded in about an hour', quiet: true, at: 1_793_945_968_346 },
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  at: 1_793_945_977_100,
  slot: 466_006_442,
  note: null,
  solUsd: 89.5,
  holds: { SOL: 0.68, USDC: 11.9 },
  holdsUsd: { SOL: 60.85, USDC: 11.9 },
  rule: { capUsd: 25, settingUsd: 100, safeCapUsd: 25, minProfitUsd: 0.01, feeLamports: 19_000, floorUsd: { SOL: 0.0117, USDC: 0.0117 }, lighthouse: { proven: true, why: null } },
  coins: 70,
  refused: [{ mint: addr(), symbol: 'GROYPER', problem: 'it keeps a fee out of every transfer' }],
  pools: 120,
  looked: 70,
  cycleAt: 1_793_945_970_000,
  stats: { scans: 21_429, paying: 392, tried: 0, passed: 0, routesPassed: 0, hours: 6.6 },
  take: [],
  watch: [row()],
  closest: [],
  ...over,
});

const view = (over: Record<string, unknown> = {}) => {
  const v = scannerView(page(over));
  if (typeof v === 'string') throw new Error(v);
  return v;
};

describe('tripOf: one scanner row as a whole trip', () => {
  it('reads every figure, each leg’s tickers, and whether a leg is our pool', () => {
    const t = tripOf(row())!;
    expect(t.symbol).toBe('SOY');
    expect(t.mint).toBe(TOKEN);
    expect(t.coinTicker).toBe('SOL');
    expect(t.legs.map((l) => [l.fromTicker, l.toTicker, l.venue, l.ours, l.fee])).toEqual([
      ['SOL', 'SOY', 'PumpSwap', false, 0.003],
      ['SOY', 'SOL', 'Tegriddy Farms (ours)', true, 0.01],
    ]);
    expect(t).toMatchObject({ sizedBy: 'gap', gapInUsd: 10.39, floatUsd: 60.86, capUsd: 25, netUsd: 0.896, roiPct: 8.63, robotTakes: true, threeSwap: false, shortPct: 0 });
    expect(t.proof).toEqual({ ok: false, quiet: true, why: 'a pool has not traded in about an hour', at: 1_793_945_968_346, slot: null, units: null, gainedUsd: null });
  });

  it('says how far a gap is under the pools’ fees', () => {
    expect(tripOf(row({ gapPct: 0.578, costPct: 1.25 }))!.shortPct).toBeCloseTo(0.672, 9);
  });

  it('reads a three-swap trip that closes through USDC', () => {
    const bridge = addr();
    const t = tripOf(row({
      legs: [
        { pool: P1, dex: 'pumpswap', from: SOL, to: TOKEN, fee: 0.003, venue: 'PumpSwap' },
        { pool: P2, dex: 'whirlpool', from: TOKEN, to: USDC, fee: 0.003, venue: 'Orca' },
        { pool: bridge, dex: 'whirlpool', from: USDC, to: SOL, fee: 0.0004, venue: 'Orca' },
      ],
    }))!;
    expect(t.threeSwap).toBe(true);
    expect(t.legs.map((l) => `${l.fromTicker}>${l.toTicker}`)).toEqual(['SOL>SOY', 'SOY>USDC', 'USDC>SOL']);
  });

  it('leaves out a row that is not a whole round trip', () => {
    const [l1, l2] = row().legs;
    for (const bad of [
      { mint: 'not an address' },
      { mint: `${TOKEN}<img>` },
      { coin: TOKEN }, // a trip starts in SOL or USDC
      { legs: [l1] },
      { legs: [l1, l2, l2, l2] },
      { legs: [l1, { ...l2, to: USDC }] }, // does not come back to SOL
      { legs: [{ ...l1, from: USDC }, l2] }, // does not start in SOL
      { legs: [l1, { ...l2, from: addr() }] }, // the second leg does not start where the first ended
      { legs: [l1, { ...l2, pool: 'javascript:alert(1)' }] },
      { legs: [l1, { ...l2, fee: 1.5 }] },
      { legs: [l1, { ...l2, fee: '0.01' }] },
      { netUsd: Number.NaN },
      { inUsd: Infinity },
      { roiPct: '8%' },
      { gapPct: undefined },
    ]) {
      expect(tripOf(row(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(tripOf(null)).toBeNull();
    expect(tripOf([row()])).toBeNull();
  });

  it('takes nothing it does not know as a size limit or a proof', () => {
    const t = tripOf(row({ sizedBy: 'everything', proof: { ok: 'yes', at: 1 }, gapInUsd: 'lots', ours: 'true', robotTakes: 1 }))!;
    expect(t.sizedBy).toBeNull();
    expect(t.proof).toBeNull();
    expect(t.gapInUsd).toBeNull();
    expect(t.ours).toBe(false);
    expect(t.robotTakes).toBe(false);
  });
});

describe('plainText: a name another program wrote', () => {
  it('takes out the marks that reorder or hide text, and cuts it short', () => {
    expect(plainText('\u202eYOS', 24)).toBe('YOS');
    expect(plainText('S\u200bO\u200dY\ufeff', 24)).toBe('SOY');
    expect(plainText('\u0000SOY\n', 24)).toBe('SOY');
    expect(plainText('A'.repeat(100), 24)).toBe('A'.repeat(24));
    expect(plainText('🐸'.repeat(30), 24)).toBe('🐸'.repeat(24)); // cut by character, never inside one
    expect(plainText('\u202e\u200b', 24)).toBeNull();
    expect(plainText(42, 24)).toBeNull();
  });

  it('keeps a hostile name as the text it is (the page writes it as text)', () => {
    expect(tripOf(row({ symbol: '<b>x</b>' }))!.symbol).toBe('<b>x</b>');
  });
});

describe('scannerView: the scanner’s page', () => {
  it('reads the rule, the run figures an hour and the robot’s holdings', () => {
    const v = view();
    expect(v.rule).toEqual({ capUsd: 25, settingUsd: 100, safeCapUsd: 25, minProfitUsd: 0.01, feeLamports: 19_000, floorUsd: { SOL: 0.0117, USDC: 0.0117 }, lighthouse: { proven: true, why: null } });
    expect(v.stats).toMatchObject({ scans: 21_429, paying: 392, tried: 0, passed: 0, routesPassed: 0, hours: 6.6 });
    expect(v.stats!.perHour.paying).toBeCloseTo(392 / 6.6, 9);
    expect(v.stats!.perHour.scans).toBeCloseTo(21_429 / 6.6, 9);
    expect(v.holds).toEqual([{ ticker: 'SOL', amount: 0.68, usd: 60.85 }, { ticker: 'USDC', amount: 11.9, usd: 11.9 }]);
    expect(v.watch).toHaveLength(1);
    expect(v.refused).toHaveLength(1);
    expect(v.dropped).toBe(0);
  });

  it('counts a fresh start’s figures over a minute, not over the seconds it has run', () => {
    expect(view({ stats: { scans: 10, paying: 2, tried: 1, passed: 1, routesPassed: 1, hours: 0.001 } }).stats!.perHour.paying).toBeCloseTo(120, 9);
  });

  it('leaves out bad rows, counts them, and keeps each list to its most', () => {
    const v = view({ watch: [row(), row({ mint: 'x' }), 'row', null], take: Array.from({ length: MAX_ROWS.take + 5 }, () => row()), refused: [{ mint: 'x' }, { mint: addr(), symbol: '\u202eYOS' }] });
    expect(v.watch).toHaveLength(1);
    expect(v.take).toHaveLength(MAX_ROWS.take);
    expect(v.dropped).toBe(3);
    expect(v.refused).toEqual([expect.objectContaining({ symbol: 'YOS', problem: 'refused' })]);
  });

  it('says plainly when the page is not a scanner’s', () => {
    for (const bad of [null, [], 'text', {}, { at: 1 }, { rule: {} }, { at: 'now', rule: {} }]) expect(typeof scannerView(bad)).toBe('string');
  });

  it('shows the Lighthouse check unproven unless the page says proven, with its reason', () => {
    expect(view({ rule: { lighthouse: { proven: 'true', why: 'not run yet' } } }).rule.lighthouse).toEqual({ proven: false, why: 'not run yet' });
  });
});

describe('nextScannerFeed: what the dashboard keeps of the scanner', () => {
  const empty: ScannerFeed = { page: '127.0.0.1:8795', view: null, readAt: null, problem: null };
  const v = view() as ScannerView;
  it('takes a new view and clears the last failure', () => {
    expect(nextScannerFeed({ ...empty, problem: 'not answering' }, v, 1000)).toEqual({ page: '127.0.0.1:8795', view: v, readAt: 1000, problem: null });
  });
  it('keeps the last view a short while after a failed read, saying why', () => {
    const had = nextScannerFeed(empty, v, 1000);
    expect(nextScannerFeed(had, 'not answering', 1000 + SCANNER_KEEP_MS - 1)).toEqual({ ...had, problem: 'not answering' });
  });
  it('then drops it: its trips are long gone', () => {
    const had = nextScannerFeed(empty, v, 1000);
    expect(nextScannerFeed(had, 'not answering', 1000 + SCANNER_KEEP_MS)).toEqual({ ...empty, problem: 'not answering' });
  });
});

describe('scannerPageUrl: the scanner’s page on this computer only', () => {
  it('takes a page on this computer', () => {
    for (const ok of ['http://127.0.0.1:8795/state.json', 'http://localhost:8795/state.json', 'http://[::1]:8795/state.json']) expect(scannerPageUrl(ok).href).toBe(ok);
  });
  it('refuses anywhere else, and anything not a plain http address', () => {
    for (const bad of ['https://127.0.0.1:8795/state.json', 'http://127.0.0.2:8795/state.json', 'http://example.com/state.json', 'http://127.0.0.1.example.com/', 'file:///C:/state.json', 'not a url', '']) {
      expect(() => scannerPageUrl(bad), bad).toThrow(/on this computer/);
    }
  });
});
