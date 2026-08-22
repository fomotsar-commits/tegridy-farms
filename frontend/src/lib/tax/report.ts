// One report object: the period, the method, the gaps, and the two schedules.
//
// Everything a surface or an export needs is decided HERE and read from the
// result. Nothing downstream re-derives a figure from the inputs, because a CSV
// that computes its own total and a screen that computes its own total are two
// implementations of the same number, and they will disagree exactly once — in
// the document somebody files.
//
// The two honesty invariants the whole directory serves are enforced at this
// layer and asserted in report.test.ts:
//
//   1. Every stretch of the requested period that could not be read appears in
//      `coverage.gaps`, and lib/tax/csv.ts writes those onto the export itself.
//      A report is never silently narrowed to the part that happened to load.
//   2. Every total carries a `complete` flag, false whenever a row was excluded
//      for having an unknown figure. An unknown is never summed as zero.

import { computeCoverage, type Coverage, type CoverageInput } from './coverage';
import { mergeEventSets, withinPeriod, type AdapterLimitation, type IncomeEvent, type InformationalRow, type TaxEventSet } from './events';
import { matchLots, type TaxLotEvent, type TaxLotResult } from './lots';
import type { CostBasisMethod } from './methods';

export interface IncomeSchedule {
  rows: IncomeEvent[];
  /** Sum of `value` over rows that have one, in the quote currency's minor units. */
  valueTotal: bigint;
  /** Rows with no fair-market value. Reported as a count, never valued at zero. */
  unpricedRows: number;
  /** False whenever `unpricedRows > 0`. */
  complete: boolean;
}

export interface TaxReportInput {
  /** Unix seconds, inclusive both ends. */
  periodStart: number;
  periodEnd: number;
  method: CostBasisMethod;
  /** Named once and stamped on the export; every value is its minor units. */
  quoteCurrency: string;
  /** What the indexer produced, via lib/tax/events.ts adapters. */
  indexed: TaxEventSet;
  /** What the filer pasted, via lib/tax/import.ts. Never mixed with the above silently. */
  supplied?: { lotEvents: TaxLotEvent[]; income: IncomeEvent[] };
  /** How far the indexed read actually got. Period fields are filled in here. */
  coverage: Omit<CoverageInput, 'periodStart' | 'periodEnd'>;
  /** Unix seconds. Written onto the export so a stale file can be spotted. */
  generatedAt: number;
  /** Wallet the report is about, for the export header. Null when none. */
  account: `0x${string}` | null;
}

export interface TaxReport {
  periodStart: number;
  periodEnd: number;
  method: CostBasisMethod;
  quoteCurrency: string;
  generatedAt: number;
  account: `0x${string}` | null;
  coverage: Coverage;
  capitalGains: TaxLotResult;
  income: IncomeSchedule;
  informational: InformationalRow[];
  limitations: AdapterLimitation[];
  /**
   * True when the report can be relied on as a complete account of the period:
   * no coverage gap AND every row priced. Almost always false on this
   * deployment, and that is the correct answer rather than a defect — see
   * lib/tax/events.ts on the missing swap output amount.
   */
  usableAsFiled: boolean;
}

const SUPPLIED_LIMITATION: AdapterLimitation = {
  code: 'supplied-rows-unverified',
  detail:
    'Some rows in this report were pasted in by hand and are marked "supplied". Nothing checked them ' +
    'against a chain, a broker or each other. They are exactly as good as the records they came from.',
};

export function buildTaxReport(input: TaxReportInput): TaxReport {
  const coverage = computeCoverage({
    ...input.coverage,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });

  const supplied: TaxEventSet = {
    lotEvents: input.supplied?.lotEvents ?? [],
    income: input.supplied?.income ?? [],
    informational: [],
    limitations:
      (input.supplied?.lotEvents.length ?? 0) + (input.supplied?.income.length ?? 0) > 0
        ? [SUPPLIED_LIMITATION]
        : [],
  };

  const merged = withinPeriod(
    mergeEventSets(input.indexed, supplied),
    input.periodStart,
    input.periodEnd,
  );

  const capitalGains = matchLots({
    events: merged.lotEvents,
    method: input.method,
    quoteCurrency: input.quoteCurrency,
  });

  let valueTotal = 0n;
  let unpricedRows = 0;
  for (const row of merged.income) {
    if (row.value === null) {
      unpricedRows++;
      continue;
    }
    valueTotal += row.value;
  }

  const income: IncomeSchedule = {
    rows: [...merged.income].sort((a, b) => a.timestamp - b.timestamp),
    valueTotal,
    unpricedRows,
    complete: unpricedRows === 0,
  };

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    method: input.method,
    quoteCurrency: input.quoteCurrency,
    generatedAt: input.generatedAt,
    account: input.account,
    coverage,
    capitalGains,
    income,
    informational: [...merged.informational].sort((a, b) => a.timestamp - b.timestamp),
    limitations: merged.limitations,
    usableAsFiled: coverage.complete && capitalGains.totals.complete && income.complete,
  };
}

/**
 * The one-line verdict a surface must show above the figures.
 *
 * Returned as a sentence rather than a boolean so no component gets to choose
 * the wording for "the totals below omit rows".
 */
export function reportStandingText(report: TaxReport): string {
  if (report.usableAsFiled) {
    return 'Every part of the requested period was read and every row carries a value. Still check it against your own records.';
  }
  const parts: string[] = [];
  if (!report.coverage.complete) {
    const days = Math.ceil(report.coverage.gapSeconds / 86_400);
    parts.push(`${days} day${days === 1 ? '' : 's'} of the requested period could not be read`);
  }
  if (!report.capitalGains.totals.complete) {
    parts.push(
      `${report.capitalGains.totals.incompleteRows} disposal row${
        report.capitalGains.totals.incompleteRows === 1 ? '' : 's'
      } have no gain figure and are excluded from the totals`,
    );
  }
  if (!report.income.complete) {
    parts.push(`${report.income.unpricedRows} income row${report.income.unpricedRows === 1 ? '' : 's'} have no value`);
  }
  return `INCOMPLETE — ${parts.join('; ')}. The totals below are NOT a complete account of the period, and the missing figures are unknown, not zero.`;
}
