import { describe, it, expect } from 'vitest';
import { computeCoverage, gapLines } from './coverage';
import { capitalGainsCsv, csvField, formatScaled, incomeCsv } from './csv';
import { capitalGainsFormExport } from './formExport';
import { NO_PRICE_ORACLE_LIMITATION, SWAP_PROCEEDS_LIMITATION, stakingToEvents, swapsToEvents, withinPeriod } from './events';
import { importTaxRows, parseScaledDecimal, parseTimestamp } from './import';
import { buildTaxReport, reportStandingText, type TaxReportInput } from './report';
import type { IndexedStakingAction, IndexedSwap } from '../indexer/queries';

const DAY = 86_400;
const YEAR_START = Date.UTC(2025, 0, 1) / 1000;
const YEAR_END = Date.UTC(2025, 11, 31, 23, 59, 59) / 1000;

const ACCOUNT = '0x2222222222222222222222222222222222222222' as const;

function baseInput(over: Partial<TaxReportInput> = {}): TaxReportInput {
  return {
    periodStart: YEAR_START,
    periodEnd: YEAR_END,
    method: 'fifo',
    quoteCurrency: 'USD',
    indexed: { lotEvents: [], income: [], informational: [], limitations: [] },
    coverage: { status: 'ready', syncedAt: YEAR_END, oldestRowAt: null, truncated: false, indexedFrom: null },
    generatedAt: YEAR_END,
    account: ACCOUNT,
    ...over,
  };
}

// ─── Coverage ────────────────────────────────────────────────────────────────

describe('a period the venue could not read is a GAP on the export, never an omission', () => {
  it('marks the WHOLE period when the indexer is unavailable', () => {
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'unavailable',
      syncedAt: null,
      oldestRowAt: null,
      truncated: false,
      indexedFrom: null,
    });
    expect(c.complete).toBe(false);
    expect(c.gaps[0]).toMatchObject({ from: YEAR_START, to: YEAR_END, reason: 'indexer-unavailable' });
    expect(c.gaps[0]!.detail).toMatch(/does not mean there were no transactions/i);
  });

  it('marks the whole period while backfilling, because the hole is not at a known end', () => {
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'backfilling',
      syncedAt: YEAR_END,
      oldestRowAt: YEAR_START,
      truncated: false,
      indexedFrom: null,
    });
    expect(c.gaps.some((g) => g.reason === 'indexer-backfilling')).toBe(true);
  });

  it('marks everything before the oldest row read when the page was truncated', () => {
    const oldest = YEAR_START + 200 * DAY;
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'ready',
      syncedAt: YEAR_END,
      oldestRowAt: oldest,
      truncated: true,
      indexedFrom: null,
    });
    const gap = c.gaps.find((g) => g.reason === 'page-truncated')!;
    expect(gap.from).toBe(YEAR_START);
    expect(gap.to).toBe(oldest - 1);
  });

  it('marks the tail past the synced head', () => {
    const head = YEAR_START + 100 * DAY;
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'ready',
      syncedAt: head,
      oldestRowAt: YEAR_START,
      truncated: false,
      indexedFrom: null,
    });
    expect(c.gaps.find((g) => g.reason === 'after-sync-head')!.from).toBe(head + 1);
  });

  it('treats an unreported sync position as unknown coverage, not as full coverage', () => {
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'ready',
      syncedAt: null,
      oldestRowAt: YEAR_START,
      truncated: false,
      indexedFrom: null,
    });
    expect(c.complete).toBe(false);
  });

  it('marks anything before the indexer ever existed as permanently uncoverable', () => {
    const from = YEAR_START + 30 * DAY;
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'ready',
      syncedAt: YEAR_END,
      oldestRowAt: from,
      truncated: false,
      indexedFrom: from,
    });
    const gap = c.gaps.find((g) => g.reason === 'before-indexed-range')!;
    expect(gap.detail).toMatch(/never held history/i);
  });

  it('reports gap seconds as a UNION, so overlapping gaps cannot exceed the period', () => {
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'unavailable',
      syncedAt: null,
      oldestRowAt: null,
      truncated: true,
      indexedFrom: YEAR_END,
    });
    expect(c.gapSeconds).toBeLessThanOrEqual(YEAR_END - YEAR_START + 1);
  });

  it('says so plainly when there is nothing missing', () => {
    const c = computeCoverage({
      periodStart: YEAR_START,
      periodEnd: YEAR_END,
      status: 'ready',
      syncedAt: YEAR_END,
      oldestRowAt: YEAR_START,
      truncated: false,
      indexedFrom: null,
    });
    expect(c.complete).toBe(true);
    expect(gapLines(c)[0]).toMatch(/no gaps/i);
  });
});

// ─── Indexer adapters ────────────────────────────────────────────────────────

const swap: IndexedSwap = {
  id: 's1',
  user: ACCOUNT,
  tokenIn: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  tokenOut: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  amountIn: 10n ** 18n,
  fee: 0n,
  timestamp: BigInt(YEAR_START + DAY),
  txHash: `0x${'11'.repeat(32)}`,
};

describe('the adapter refuses to invent the fields the indexer does not hold', () => {
  it('emits a disposal with UNKNOWN proceeds, never zero', () => {
    const set = swapsToEvents([swap]);
    expect(set.lotEvents).toHaveLength(1);
    const d = set.lotEvents[0]!;
    expect(d.kind).toBe('dispose');
    expect(d.kind === 'dispose' && d.proceeds).toBeNull();
  });

  it('emits NO acquisition for the output side, because the quantity is unrecorded', () => {
    expect(swapsToEvents([swap]).lotEvents.some((e) => e.kind === 'acquire')).toBe(false);
  });

  it('declares the missing field as a limitation carried onto the export', () => {
    expect(swapsToEvents([swap]).limitations).toContainEqual(SWAP_PROCEEDS_LIMITATION);
  });

  it('labels an unresolved asset by address rather than guessing a ticker', () => {
    expect(swapsToEvents([swap]).lotEvents[0]!.assetSymbol).toMatch(/^0xc02a…6cc2$/);
  });

  it('uses a supplied symbol when there is one', () => {
    const set = swapsToEvents([swap], { symbols: { '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH' } });
    expect(set.lotEvents[0]!.assetSymbol).toBe('WETH');
  });
});

function action(over: Partial<IndexedStakingAction>): IndexedStakingAction {
  return {
    id: 'a1',
    user: ACCOUNT,
    tokenId: 1n,
    type: 'claim',
    amount: 5n * 10n ** 18n,
    penalty: null,
    timestamp: BigInt(YEAR_START + 2 * DAY),
    txHash: `0x${'22'.repeat(32)}`,
    ...over,
  };
}

describe('staking rows become income only where income really happened', () => {
  it('turns a claim into an unpriced income row', () => {
    const set = stakingToEvents([action({})]);
    expect(set.income).toHaveLength(1);
    expect(set.income[0]!.value).toBeNull();
    expect(set.income[0]!.kind).toBe('staking-reward');
    expect(set.limitations).toContainEqual(NO_PRICE_ORACLE_LIMITATION);
  });

  it('does NOT treat a stake or a withdraw as a disposal', () => {
    const set = stakingToEvents([action({ type: 'stake' }), action({ id: 'a2', type: 'withdraw' })]);
    expect(set.income).toEqual([]);
    expect(set.lotEvents).toEqual([]);
  });

  it('reports an early-withdrawal penalty as informational, not as a capital loss', () => {
    const set = stakingToEvents([action({ type: 'earlyWithdraw', penalty: 10n ** 18n })]);
    expect(set.informational).toHaveLength(1);
    expect(set.informational[0]!.detail).toMatch(/NOT counted as a capital loss/i);
  });

  it('skips position-NFT transfers, which are custody changes at amount zero', () => {
    expect(stakingToEvents([action({ type: 'transfer', amount: 0n })]).income).toEqual([]);
  });
});

describe('the period filter keeps prior-year lots available to the matcher', () => {
  it('keeps an acquisition from before the period but drops one after it', () => {
    const set = withinPeriod(
      {
        lotEvents: [
          { kind: 'acquire', id: 'old', asset: 't', assetSymbol: 'T', quantity: 1n, decimals: 0, costBasis: 1n, timestamp: YEAR_START - 5 * DAY, txHash: '0x' },
          { kind: 'acquire', id: 'future', asset: 't', assetSymbol: 'T', quantity: 1n, decimals: 0, costBasis: 1n, timestamp: YEAR_END + DAY, txHash: '0x' },
          { kind: 'dispose', id: 'early', asset: 't', assetSymbol: 'T', quantity: 1n, decimals: 0, proceeds: 1n, timestamp: YEAR_START - DAY, txHash: '0x' },
        ],
        income: [],
        informational: [],
        limitations: [],
      },
      YEAR_START,
      YEAR_END,
    );
    expect(set.lotEvents.map((e) => e.id)).toEqual(['old']);
  });
});

// ─── Import ──────────────────────────────────────────────────────────────────

describe('imported rows are parsed exactly or not at all', () => {
  it('parses decimals by digit shifting, with no float anywhere near it', () => {
    expect(parseScaledDecimal('1000.00', 2)).toBe(100_000n);
    expect(parseScaledDecimal('0.1', 18)).toBe(10n ** 17n);
    expect(parseScaledDecimal('-12.34', 2)).toBe(-1234n);
  });

  it('REFUSES a value with more precision than its scale rather than rounding a cost basis', () => {
    expect(parseScaledDecimal('1.005', 2)).toBeNull();
  });

  it('accepts ISO-8601 and unix seconds and nothing else', () => {
    expect(parseTimestamp('2025-06-02T14:30:00Z')).toBe(Date.UTC(2025, 5, 2, 14, 30) / 1000);
    expect(parseTimestamp('1760000000')).toBe(1_760_000_000);
    expect(parseTimestamp('last tuesday')).toBeNull();
  });

  it('imports a well-formed sheet', () => {
    const res = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'acquire,0xabc,USDC,6,1000.00,900.00,2025-01-14T10:00:00Z,0xa,lot-1,\n' +
        'dispose,0xabc,USDC,6,400.00,455.10,2025-06-02T14:30:00Z,0xb,sale-1,lot-1\n',
    );
    expect(res.errors).toEqual([]);
    expect(res.lotEvents).toHaveLength(2);
  });

  it('fails the WHOLE import on one bad row, and reports every problem at once', () => {
    const res = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'acquire,0xabc,USDC,6,1000.00,900.00,2025-01-14T10:00:00Z,0xa,lot-1,\n' +
        'dispose,0xabc,USDC,6,nope,455.10,2025-06-02T14:30:00Z,0xb,sale-1,\n' +
        'weird,0xabc,USDC,6,1,1,2025-06-02T14:30:00Z,0xc,x,\n',
    );
    expect(res.errors).toHaveLength(2);
    // Nothing at all is imported — a partial import is a silently wrong filing.
    expect(res.lotEvents).toEqual([]);
    expect(res.income).toEqual([]);
  });

  it('rejects a duplicate id, which would make a nomination ambiguous', () => {
    const res = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'acquire,0xabc,USDC,6,1,1,1760000000,0xa,dup,\n' +
        'acquire,0xabc,USDC,6,1,1,1760000000,0xb,dup,\n',
    );
    expect(res.errors[0]!.message).toMatch(/more than once/i);
  });

  it('names a missing header column', () => {
    expect(importTaxRows('kind,asset\nacquire,0xabc\n').errors[0]!.message).toMatch(/missing the "symbol" column/);
  });

  it('treats a blank value as unknown rather than as zero', () => {
    const res = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'income,0xabc,TOWELI,18,12.5,,1760000000,0xa,r1,\n',
    );
    expect(res.income[0]!.value).toBeNull();
  });
});

// ─── The report and its exports ──────────────────────────────────────────────

describe('the report is honest about being incomplete, in the file as well as on screen', () => {
  it('an unavailable indexer produces a full header and no rows, not a clean zero', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: { status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
      }),
    );
    expect(report.usableAsFiled).toBe(false);
    const csv = capitalGainsCsv(report);
    expect(csv).toMatch(/GAP /);
    expect(csv).toMatch(/entire period is uncovered/i);
    expect(csv).toMatch(/not tax advice/i);
    expect(reportStandingText(report)).toMatch(/^INCOMPLETE/);
  });

  it('stamps the SELECTED method on every export', () => {
    for (const method of ['fifo', 'lifo', 'hifo', 'spec-id'] as const) {
      const report = buildTaxReport(baseInput({ method }));
      expect(capitalGainsCsv(report)).toMatch(/# Cost-basis method:/);
      expect(incomeCsv(report)).toMatch(/# Cost-basis method:/);
      expect(capitalGainsFormExport(report)).toMatch(/# Cost-basis method:/);
    }
    expect(capitalGainsCsv(buildTaxReport(baseInput({ method: 'hifo' })))).toMatch(/HIFO/);
  });

  it('writes every coverage gap into the file body, above the data', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: {
          status: 'ready',
          syncedAt: YEAR_START + 100 * DAY,
          oldestRowAt: YEAR_START,
          truncated: false,
          indexedFrom: null,
        },
      }),
    );
    const csv = capitalGainsCsv(report);
    const headerRow = csv.indexOf('disposal_id');
    const gapLine = csv.indexOf('GAP ');
    expect(gapLine).toBeGreaterThan(-1);
    expect(gapLine).toBeLessThan(headerRow);
  });

  it('carries the swap-proceeds limitation through to the export', () => {
    const report = buildTaxReport(baseInput({ indexed: swapsToEvents([swap]) }));
    expect(capitalGainsCsv(report)).toMatch(/swap-proceeds-unrecorded/);
    expect(report.capitalGains.totals.complete).toBe(false);
  });

  it('leaves an unknown money column EMPTY rather than writing 0.00', () => {
    const report = buildTaxReport(baseInput({ indexed: swapsToEvents([swap]) }));
    const dataLine = capitalGainsCsv(report)
      .split('\n')
      .find((l) => l.startsWith('swap:s1'))!;
    const cells = dataLine.split(',');
    // proceeds, cost_basis and gain sit at fixed positions and must be blank.
    expect(cells[9]).toBe('');
    expect(cells[10]).toBe('');
    expect(cells[11]).toBe('');
    expect(dataLine).toMatch(/incomplete/);
  });

  it('keeps totals out of the data rows so nobody double-sums them', () => {
    const report = buildTaxReport(baseInput({ indexed: swapsToEvents([swap]) }));
    const csv = capitalGainsCsv(report);
    expect(csv).toMatch(/# TOTALS over 0 complete row\(s\)/);
    expect(csv.split('\n').filter((l) => !l.startsWith('#') && /TOTAL/i.test(l))).toEqual([]);
  });

  it('computes real numbers as soon as it is given real numbers', () => {
    const supplied = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'acquire,0xabc,USDC,6,1000.00,900.00,2025-01-14T10:00:00Z,0xa,lot-1,\n' +
        'dispose,0xabc,USDC,6,400.00,455.10,2025-06-02T14:30:00Z,0xb,sale-1,\n',
    );
    const report = buildTaxReport(baseInput({ supplied: { lotEvents: supplied.lotEvents, income: [] } }));
    // 400 of a 1000 lot costing 900.00 -> basis 360.00; proceeds 455.10 -> 95.10.
    expect(report.capitalGains.disposals[0]!.costBasis).toBe(36_000n);
    expect(report.capitalGains.totals.realisedGain).toBe(9_510n);
    expect(report.capitalGains.totals.complete).toBe(true);
    expect(report.limitations.map((l) => l.code)).toContain('supplied-rows-unverified');
  });

  it('never declares itself usable while a gap or an unpriced row survives', () => {
    const good = buildTaxReport(baseInput());
    expect(good.usableAsFiled).toBe(true);
    const gapped = buildTaxReport(
      baseInput({ coverage: { status: 'ready', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null } }),
    );
    expect(gapped.usableAsFiled).toBe(false);
  });

  it('reports income quantities with an empty value column and says why', () => {
    const report = buildTaxReport(baseInput({ indexed: stakingToEvents([action({})]) }));
    const csv = incomeCsv(report);
    expect(csv).toMatch(/unknown, not zero/i);
    expect(report.income.complete).toBe(false);
    expect(report.income.valueTotal).toBe(0n);
    expect(report.income.unpricedRows).toBe(1);
  });

  it('marks the form export as a worksheet and classifies no holding period', () => {
    const form = capitalGainsFormExport(buildTaxReport(baseInput()));
    expect(form).toMatch(/WORKSHEET, not a filed form/i);
    // The only mention of the classification is the line refusing to make it.
    expect(form.split('\n').filter((l) => /short- or long-term/.test(l))).toHaveLength(1);
    expect(form).toMatch(/use the held_days column/i);
    expect(form.split('\n').find((l) => l.startsWith('description'))).toBe(
      'description,date_acquired,date_sold,proceeds,cost_basis,gain_or_loss,held_days,status,notes',
    );
  });

  it('writes an unpriced disposal into the worksheet rather than dropping the sale', () => {
    const report = buildTaxReport(baseInput({ indexed: swapsToEvents([swap]) }));
    const rows = capitalGainsFormExport(report)
      .split('\n')
      .filter((l) => l.includes('incomplete'));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('CSV mechanics', () => {
  it('formats a smallest-unit integer exactly, with no float step', () => {
    expect(formatScaled(123_456_789n, 6)).toBe('123.456789');
    expect(formatScaled(1n, 18)).toBe('0.000000000000000001');
    expect(formatScaled(-5n, 2)).toBe('-0.05');
    expect(formatScaled(500n, 0)).toBe('500');
  });

  it('quotes a field that would otherwise break the row', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('plain')).toBe('plain');
  });
});
