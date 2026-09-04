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
    coverage: { source: 'indexer', status: 'ready', syncedAt: YEAR_END, oldestRowAt: null, truncated: false, indexedFrom: null },
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
      source: 'indexer',
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
        coverage: { source: 'indexer', status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
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
          source: 'indexer',
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
      baseInput({ coverage: { source: 'indexer', status: 'ready', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null } }),
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

// ─── Quote scale ─────────────────────────────────────────────────────────────

describe('the report formats money at the scale its own currency actually has', () => {
  const ethSupplied = {
    lotEvents: [
      {
        kind: 'acquire' as const,
        id: 'lot-eth',
        asset: '0xabc',
        assetSymbol: 'TKN',
        quantity: 1_000n,
        decimals: 0,
        costBasis: 2n * 10n ** 17n,
        costSource: 'supplied' as const,
        timestamp: YEAR_START + DAY,
        txHash: '0xa',
      },
      {
        kind: 'dispose' as const,
        id: 'sale-eth',
        asset: '0xabc',
        assetSymbol: 'TKN',
        quantity: 1_000n,
        decimals: 0,
        proceeds: 5n * 10n ** 17n,
        proceedsSource: 'settle-leg' as const,
        timestamp: YEAR_START + 2 * DAY,
        txHash: '0xb',
      },
    ],
    income: [],
  };

  // Pinned because the pre-change writer formatted every money column with a
  // literal 2: 5e17 wei printed as "5000000000000000.00", which is a wrong
  // number in a filing and looks like a plausible one.
  it('prints an ETH figure at 18 places, in the CSV, the worksheet and the header', () => {
    const report = buildTaxReport(
      baseInput({ quoteCurrency: 'ETH', quoteScale: 18, supplied: ethSupplied }),
    );
    expect(report.capitalGains.disposals[0]!.proceeds).toBe(5n * 10n ** 17n);
    const csv = capitalGainsCsv(report);
    expect(csv).toContain('0.500000000000000000');
    expect(csv).not.toContain('5000000000000000.00');
    expect(csv).toMatch(/# Values are ETH to 18 decimal places/);
    expect(capitalGainsFormExport(report)).toContain('0.500000000000000000');
  });

  it('still prints 2 places when no scale is named, so existing callers are unchanged', () => {
    expect(buildTaxReport(baseInput()).quoteScale).toBe(2);
  });

  it('carries each figure’s provenance onto the row, not just into the total', () => {
    const report = buildTaxReport(
      baseInput({ quoteCurrency: 'ETH', quoteScale: 18, supplied: ethSupplied }),
    );
    const row = capitalGainsCsv(report)
      .split('\n')
      .find((l) => l.startsWith('sale-eth'))!;
    expect(row).toContain('settle-leg');
    expect(row).toContain('supplied');
    expect(capitalGainsFormExport(report)).toMatch(/Proceeds source: settle-leg\./);
  });
});

// ─── Coverage per source ─────────────────────────────────────────────────────

describe('coverage is stated per READ, so one source cannot vouch for another', () => {
  it('an explorer read that covered the period leaves no indexer gap behind it', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: [
          { source: 'explorer', status: 'ready', syncedAt: YEAR_END, oldestRowAt: null, truncated: false, indexedFrom: null },
        ],
      }),
    );
    expect(report.coverage.complete).toBe(true);
    expect(report.coverage.gaps).toEqual([]);
  });

  it('names the EXPLORER in its own failure, and says an empty file is not an empty year', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: [
          { source: 'explorer', status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
        ],
      }),
    );
    const gap = report.coverage.gaps[0]!;
    expect(gap.reason).toBe('explorer-unavailable');
    expect(gap.source).toBe('explorer');
    expect(gap.detail).toMatch(/explorer proxy/i);
    expect(gap.detail).toMatch(/does not mean there were no transactions/i);
    expect(capitalGainsCsv(report)).toMatch(/GAP .*\[explorer\/explorer-unavailable\]/);
  });

  it('keeps the indexer’s own wording when the indexer is the source that failed', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: [
          { source: 'indexer', status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
        ],
      }),
    );
    expect(report.coverage.gaps[0]!.reason).toBe('indexer-unavailable');
    expect(report.coverage.gaps[0]!.detail).toMatch(/indexed history could not be read/i);
  });

  it('reports two failed sources as two gaps but counts the period ONCE', () => {
    const report = buildTaxReport(
      baseInput({
        coverage: [
          { source: 'explorer', status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
          { source: 'indexer', status: 'unavailable', syncedAt: null, oldestRowAt: null, truncated: false, indexedFrom: null },
        ],
      }),
    );
    expect(report.coverage.gaps).toHaveLength(2);
    expect(report.coverage.gapSeconds).toBe(YEAR_END - YEAR_START + 1);
  });

  it('an explorer cut is a gap that names the stretch nobody looked at', () => {
    const cut = YEAR_START + 100 * DAY;
    const report = buildTaxReport(
      baseInput({
        coverage: [
          { source: 'explorer', status: 'ready', syncedAt: YEAR_END, oldestRowAt: cut, truncated: true, indexedFrom: null },
        ],
      }),
    );
    const gap = report.coverage.gaps.find((g) => g.reason === 'page-truncated')!;
    expect(gap.from).toBe(YEAR_START);
    expect(gap.to).toBe(cut - 1);
    expect(gap.detail).toMatch(/at least one of the transaction lists/i);
  });
});

// ─── The paste path shares the report's scale ────────────────────────────────

describe('a pasted value is parsed at the scale the report is stamped with', () => {
  const sheet =
    'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
    'acquire,0xabc,TKN,0,1000,0.5,2025-01-14T10:00:00Z,0xa,lot-1,\n';

  // Pre-change VALUE_SCALE was hard-wired to 2, so an ETH-quoted report parsed
  // a pasted 0.5 ETH as 50 wei and put it into the same matcher as a leg read
  // at 5e17. The two rows were sixteen orders of magnitude apart and the
  // resulting gain was arithmetic nobody could trace back to a mistake.
  it('parses 0.5 as 5e17 at ETH scale and as 50 at the default scale', () => {
    expect(importTaxRows(sheet, 18).lotEvents[0]!).toMatchObject({ costBasis: 5n * 10n ** 17n });
    expect(importTaxRows(sheet).lotEvents[0]!).toMatchObject({ costBasis: 50n });
  });

  it('stamps a pasted figure as supplied, which is not a compliment', () => {
    expect(importTaxRows(sheet, 18).lotEvents[0]!).toMatchObject({ costSource: 'supplied' });
  });

  it('names the scale it refused a row at', () => {
    const res = importTaxRows(
      'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
        'acquire,0xabc,TKN,0,1000,0.5,2025-01-14T10:00:00Z,0xa,lot-1,\n',
      0,
    );
    expect(res.errors[0]!.message).toMatch(/at most 0 fractional digits/);
  });
});
