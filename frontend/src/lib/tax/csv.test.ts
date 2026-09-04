// THE EXPORT IS AN ATTACK SURFACE, BECAUSE THE TOKEN NAMES IN IT ARE.
//
// Everything else in lib/tax guards against a wrong NUMBER. This file guards
// against a wrong PROGRAM: a symbol column is whatever some contract's
// `symbol()` returned, anyone can deploy an ERC-20 called
// `=HYPERLINK("http://evil","Refund")` and airdrop it into a stranger's wallet,
// and Excel, LibreOffice and Sheets all execute a cell that starts with `=`,
// `+`, `-`, `@`, a tab or a carriage return on import. So "read my own history"
// would end as "run a stranger's code in my accountant's spreadsheet".
//
// The exemption for numeric cells is not a convenience: every loss this file
// writes starts with `-`, and text-quoting those would make the losses
// unsummable in the spreadsheet somebody actually files from.

import { describe, it, expect } from 'vitest';
import { capitalGainsCsv, csvField, formatScaled, incomeCsv } from './csv';
import { buildTaxReport, type TaxReportInput } from './report';

const YEAR_START = Date.UTC(2025, 0, 1) / 1000;
const YEAR_END = Date.UTC(2025, 11, 31, 23, 59, 59) / 1000;
const HOSTILE = '=HYPERLINK("http://evil","Refund")';

function baseInput(over: Partial<TaxReportInput> = {}): TaxReportInput {
  return {
    periodStart: YEAR_START,
    periodEnd: YEAR_END,
    method: 'fifo',
    quoteCurrency: 'ETH',
    quoteScale: 18,
    indexed: { lotEvents: [], income: [], informational: [], limitations: [] },
    coverage: [
      { source: 'explorer', status: 'ready', syncedAt: YEAR_END, oldestRowAt: null, truncated: false, indexedFrom: null },
    ],
    generatedAt: YEAR_END,
    account: '0x2222222222222222222222222222222222222222',
    ...over,
  };
}

describe('a cell is data, never a formula', () => {
  it('neutralises every character a spreadsheet treats as a formula lead', () => {
    expect(csvField(HOSTILE).startsWith('"\'=')).toBe(true);
    expect(csvField('+cmd')).toBe("'+cmd");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('\tinjected')).toBe("'\tinjected");
    expect(csvField('\rinjected')).toBe('"\'\rinjected"');
  });

  it('leaves a NEGATIVE NUMBER alone, so a loss stays a number', () => {
    expect(csvField(formatScaled(-5n, 2))).toBe('-0.05');
    expect(csvField(formatScaled(-5n, 18))).toBe('-0.000000000000000005');
    expect(csvField('-12')).toBe('-12');
  });

  it('still does plain RFC4180 quoting', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('plain')).toBe('plain');
  });

  it('emits no data cell beginning with a formula lead, even from a hostile symbol', () => {
    const report = buildTaxReport(
      baseInput({
        supplied: {
          lotEvents: [
            {
              kind: 'dispose',
              id: 'sale-1',
              asset: '0xbad',
              assetSymbol: HOSTILE,
              quantity: 1n,
              decimals: 0,
              proceeds: null,
              timestamp: YEAR_START + 86_400,
              txHash: '0xb',
            },
          ],
          income: [],
        },
      }),
    );
    const dataCells = capitalGainsCsv(report)
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .flatMap((l) => l.split(','));
    expect(dataCells.some((c) => c.startsWith('='))).toBe(false);
    expect(capitalGainsCsv(report)).toContain('"\'=HYPERLINK');
  });
});

describe('the income file carries what was refused, not only what was counted', () => {
  it('prints an informational row with its category, its source and its legs', () => {
    const report = buildTaxReport(
      baseInput({
        indexed: {
          lotEvents: [],
          income: [],
          informational: [
            {
              id: 'i1',
              timestamp: YEAR_START + 86_400,
              txHash: '0xc',
              source: 'explorer',
              category: 'third-party-tx',
              label: 'Assets moved without this wallet sending the transaction',
              detail: 'Listed, not classified.',
              legs: [{ asset: '0xbad', symbol: 'SCAM', delta: -1n, decimals: 18 }],
            },
          ],
          limitations: [],
        },
      }),
    );
    const line = incomeCsv(report)
      .split('\n')
      .find((l) => l.startsWith('i1'))!;
    expect(line).toContain('third-party-tx');
    expect(line).toContain('explorer');
    expect(line).toContain('-1 SCAM [0xbad]');
    // The pre-change writer hardcoded 'indexer' in the source column of every
    // informational row, which would have labelled an explorer finding as
    // coming from a service this deployment does not host.
    expect(line).not.toContain(',indexer,');
  });
});
