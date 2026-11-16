// @vitest-environment node
//
// The ledger (BUILD-SPEC 3.5 step 7): append-only lines, the trades CSV, the status file, and
// daily caps that come back from the CHAIN's fills when the ledger file has been rolled back.
import { describe, it, expect } from 'vitest';
import { createLedger, readLedger, dailyTotals, knownFills, stolenInMonth, maxTxCostWei, TRADES_HEADER } from '../ledger.mjs';
import { fakeClock, memFs, milli, testPolicy } from './fakes.mjs';

const paths = { ledger: 'K/ledger.jsonl', trades: 'K/trades.csv', status: 'K/status.json' };
const DAY_START = Date.parse('2026-11-16T00:00:00Z');
const fill = (n, over = {}) => ({ txHash: `0x${String(n).padStart(64, '0')}`, orderHash: `0x${'01'.repeat(32)}`, tokenId: String(n), slug: 'junglebay', unitPriceWei: milli(35), time: DAY_START / 1000 + 3600 * n, seller: '0x3333333333333333333333333333333333333333', fulfiller: '0x3333333333333333333333333333333333333333', ...over });

describe('ledger file', () => {
  it('appends lines (bigints as decimal strings) and never rewrites earlier ones', () => {
    const fs = memFs();
    const clock = fakeClock();
    const l = createLedger({ paths, fs, now: clock.now });
    l.append('post', { unitPriceWei: milli(35) });
    const first = fs.store.get(paths.ledger);
    l.append('cancel', { reason: 'stop' });
    expect(fs.store.get(paths.ledger).startsWith(first)).toBe(true);
    expect(l.read().map((e) => [e.kind, e.unitPriceWei ?? e.reason])).toEqual([
      ['post', '35000000000000000'],
      ['cancel', 'stop'],
    ]);
  });

  it('marks shadow lines, and refuses a field that would rewrite the line’s own kind', () => {
    const fs = memFs();
    const l = createLedger({ paths, fs, now: () => 0, shadow: true });
    expect(l.append('post', {}).shadow).toBe(true);
    expect(() => l.append('tx', { kind: 'approveWeth' })).toThrow(/own "kind"/);
  });

  it('skips a torn last line instead of failing', () => {
    const fs = memFs({ [paths.ledger]: '{"kind":"post","at":1}\n{"kind":"canc' });
    expect(readLedger(fs, paths.ledger)).toEqual([{ kind: 'post', at: 1 }]);
  });

  it('writes the trades CSV with its header once', () => {
    const fs = memFs();
    const l = createLedger({ paths, fs, now: () => DAY_START });
    l.trade(fill(1));
    l.trade(fill(2));
    const lines = fs.store.get(paths.trades).trim().split('\n');
    expect(lines[0]).toBe(TRADES_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',junglebay,1,0.035,35000000000000000,');
  });

  it('replaces status.json whole', () => {
    const fs = memFs();
    const l = createLedger({ paths, fs, now: () => 0 });
    l.writeStatus({ a: 1n });
    l.writeStatus({ a: 2n });
    expect(JSON.parse(fs.store.get(paths.status))).toEqual({ a: '2' });
    expect(fs.store.has(`${paths.status}.tmp`)).toBe(false);
  });
});

describe('daily caps re-seeded from the chain too', () => {
  it('counts a chain fill the ledger lost (a rolled-back file), and each fill once', () => {
    const entries = [{ kind: 'fill', at: DAY_START + 3600_000, ...fill(1) }];
    const chainFills = [fill(1), fill(2)];
    const d = dailyTotals({ entries, chainFills, dayMs: DAY_START + 10 * 3600_000, gasPerTxWei: 0n });
    expect(d.units).toBe(2);
    expect(d.wethSpent).toBe(2n * milli(35));
    expect(knownFills({ entries, chainFills })).toHaveLength(2);
  });

  it('counts only the UTC day asked for, and shadow fills only for shadow', () => {
    const entries = [
      { kind: 'fill', at: 0, ...fill(1, { time: DAY_START / 1000 - 60 }) },
      { kind: 'fill', at: 0, shadow: true, ...fill(2) },
    ];
    expect(dailyTotals({ entries, dayMs: DAY_START, gasPerTxWei: 0n }).units).toBe(0);
    expect(dailyTotals({ entries, dayMs: DAY_START, shadow: true, gasPerTxWei: 0n }).units).toBe(1);
  });

  it('counts gas at what the signer reported, else at the policy’s most per transaction', () => {
    const per = maxTxCostWei(testPolicy('0x2222222222222222222222222222222222222222'));
    expect(per).toBe(300_000n * 20_000_000_000n);
    const entries = [
      { kind: 'tx', at: DAY_START + 1, gasCostWei: '1000' },
      { kind: 'tx', at: DAY_START + 2 },
    ];
    expect(dailyTotals({ entries, dayMs: DAY_START, gasPerTxWei: per })).toMatchObject({ gasSpent: 1000n + per, txs: 2 });
  });

  it('counts flagged items bought in the month', () => {
    const at = Date.parse('2026-11-20T00:00:00Z');
    const entries = [{ kind: 'quarantine', at }, { kind: 'quarantine', at: Date.parse('2026-10-31T23:00:00Z') }];
    expect(stolenInMonth(entries, at)).toBe(1);
  });
});
