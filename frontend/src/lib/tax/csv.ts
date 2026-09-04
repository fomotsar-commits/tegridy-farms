// Serialising a report to CSV — with everything that qualifies it in the FILE,
// not in the page that produced it.
//
// A CSV outlives the screen. It gets mailed to an accountant, opened in a
// spreadsheet six months later, and read by someone who never saw the banner
// that said which cost-basis method was picked or which six weeks were missing.
// So the method statement, every coverage gap, every adapter limitation and the
// not-tax-advice notice are written as comment lines at the TOP of the file,
// above the header row, where a reader cannot get to the numbers without
// scrolling past them.
//
// Comment lines are prefixed `#`. Spreadsheets import them as a text column
// rather than dropping them, which is the point: a qualifier that vanishes on
// import is a qualifier that was never delivered.
//
// EMPTY IS NEVER A CLEAN ZERO. A report whose indexer was unavailable produces a
// file with a full header block, the gap lines that say the whole period is
// uncovered, and no data rows. It must never be mistaken for "this wallet did
// nothing that year", which is what a bare header row with no explanation is.

import { gapLines } from './coverage';
import { INCOMPLETE_REASON_TEXT } from './lots';
import { NOT_TAX_ADVICE, methodStatement } from './methods';
import type { TaxReport } from './report';

/**
 * Exact smallest-unit integer → decimal string.
 *
 * String arithmetic, never `Number`. A quantity of 18-decimal token past 2^53
 * loses its low digits the moment it becomes a float, and those digits are the
 * ones that decide whether a lot matches.
 */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  const body = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}

/**
 * A cell that is only ever data — never a formula.
 *
 * RFC4180 quoting first, and then the part that is not about RFC4180 at all: a
 * cell whose first character is `=`, `+`, `-`, `@`, a tab or a carriage return
 * is executed as a formula by Excel, LibreOffice and Sheets on import. Token
 * names in this file are ATTACKER-AUTHORED — anyone can deploy an ERC-20 whose
 * `symbol()` returns `=HYPERLINK("http://evil","click")` and airdrop it into a
 * stranger's wallet — so an unguarded export turns "read my own history" into
 * "run a stranger's code in my accountant's spreadsheet". The leading
 * apostrophe is the OWASP-documented neutraliser: spreadsheets treat the rest
 * of the cell as literal text and the character is not part of the value.
 *
 * Numeric cells are EXEMPT, and that exemption is the whole reason the test is
 * written as a whole-cell match rather than a first-character one: every
 * negative figure this file writes starts with `-`, and quoting those as text
 * would make a loss unsummable in the spreadsheet somebody is filing from.
 */
const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const neutralised = FORMULA_LEAD.test(value) && !NUMERIC_CELL.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

function csvRow(cells: string[]): string {
  return cells.map(csvField).join(',');
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * The block every export in this directory starts with.
 *
 * One function, used by both exports, so the two files can never disagree about
 * which method produced them or which period they cover.
 */
export function reportHeaderLines(report: TaxReport, exportName: string): string[] {
  const lines = [
    `# ${exportName}`,
    `# Generated ${iso(report.generatedAt)} by memetic.fun. Wallet: ${report.account ?? '(none connected)'}`,
    `# Period ${iso(report.periodStart)} → ${iso(report.periodEnd)} (inclusive, UTC)`,
    `# ${methodStatement(report.method)}`,
    `# Values are ${report.quoteCurrency} to ${report.quoteScale} decimal places. An empty value column means ` +
      'the figure is UNKNOWN — it is not zero.',
    '# Every money column has a _source column beside it saying where the figure came from. An empty source ' +
      'is an unpriced row.',
    '#',
  ];

  for (const line of gapLines(report.coverage)) lines.push(`# ${line}`);
  lines.push('#');

  if (report.limitations.length > 0) {
    for (const l of report.limitations) lines.push(`# LIMITATION [${l.code}] ${l.detail}`);
    lines.push('#');
  }

  if (!report.capitalGains.totals.complete) {
    lines.push(
      `# INCOMPLETE: ${report.capitalGains.totals.incompleteRows} disposal row(s) could not be given a gain ` +
        'figure and are EXCLUDED from the totals below. Their figures are unknown, not zero.',
    );
  }
  if (!report.income.complete) {
    lines.push(
      `# INCOMPLETE: ${report.income.unpricedRows} income row(s) have no fair-market value. They are listed ` +
        'with an empty value column and are excluded from the income total.',
    );
  }
  lines.push('#');
  lines.push(`# ${NOT_TAX_ADVICE}`);
  lines.push('#');
  return lines;
}

export const CAPITAL_GAINS_COLUMNS = [
  'disposal_id',
  'asset',
  'symbol',
  'disposed_at',
  'tx_hash',
  'quantity',
  'unmatched_quantity',
  'acquired_at_earliest',
  'held_days',
  'proceeds',
  'cost_basis',
  'gain',
  'lots_consumed',
  'status',
  'notes',
  // Appended rather than inserted: an importer or a script reading the money
  // columns by position keeps working, and a human reading the row still gets
  // the provenance beside the reasons.
  'proceeds_source',
  'cost_basis_source',
  'initiator',
] as const;

export function capitalGainsCsv(report: TaxReport): string {
  const lines = reportHeaderLines(report, 'Capital gains — disposals matched to lots');
  lines.push(csvRow([...CAPITAL_GAINS_COLUMNS]));

  for (const d of report.capitalGains.disposals) {
    const earliest = d.lots.length > 0 ? Math.min(...d.lots.map((l) => l.acquiredAt)) : null;
    const complete = d.gain !== null;
    lines.push(
      csvRow([
        d.disposalId,
        d.asset,
        d.assetSymbol,
        iso(d.disposedAt),
        d.txHash,
        formatScaled(d.quantity, d.decimals),
        d.unmatchedQuantity > 0n ? formatScaled(d.unmatchedQuantity, d.decimals) : '0',
        earliest === null ? '' : iso(earliest),
        d.heldDays === null ? '' : String(d.heldDays),
        d.proceeds === null ? '' : formatScaled(d.proceeds, report.quoteScale),
        d.costBasis === null ? '' : formatScaled(d.costBasis, report.quoteScale),
        d.gain === null ? '' : formatScaled(d.gain, report.quoteScale),
        String(d.lots.length),
        complete ? 'complete' : 'incomplete',
        d.incompleteReasons.map((r) => INCOMPLETE_REASON_TEXT[r]).join(' '),
        d.proceedsSource ?? '',
        d.costBasisSource ?? '',
        d.initiator ?? '',
      ]),
    );
  }

  // Totals go in a comment block, not in a data row. A trailing "TOTAL" row in
  // the data gets summed again by anyone who selects the column, and it would
  // silently double the figure in whatever it is pasted into.
  lines.push('#');
  lines.push(
    `# TOTALS over ${report.capitalGains.totals.countedRows} complete row(s): ` +
      `proceeds ${formatScaled(report.capitalGains.totals.proceeds, report.quoteScale)} ${report.quoteCurrency}, ` +
      `cost basis ${formatScaled(report.capitalGains.totals.costBasis, report.quoteScale)} ${report.quoteCurrency}, ` +
      `realised gain ${formatScaled(report.capitalGains.totals.realisedGain, report.quoteScale)} ${report.quoteCurrency}.`,
  );
  lines.push(
    report.capitalGains.totals.complete
      ? '# Every disposal row is included in the totals above.'
      : `# ${report.capitalGains.totals.incompleteRows} row(s) are EXCLUDED from the totals above.`,
  );

  return lines.join('\n') + '\n';
}

export const INCOME_COLUMNS = [
  'income_id',
  'received_at',
  'tx_hash',
  'asset',
  'symbol',
  'quantity',
  'value',
  'kind',
  'source',
  'notes',
  'value_source',
  'category',
] as const;

export function incomeCsv(report: TaxReport): string {
  const lines = reportHeaderLines(report, 'Income — tokens received');
  lines.push(csvRow([...INCOME_COLUMNS]));

  for (const row of report.income.rows) {
    lines.push(
      csvRow([
        row.id,
        iso(row.timestamp),
        row.txHash,
        row.asset,
        row.assetSymbol,
        formatScaled(row.quantity, row.decimals),
        row.value === null ? '' : formatScaled(row.value, report.quoteScale),
        row.kind,
        row.source,
        row.value === null
          ? 'No fair-market value is recorded for this receipt. The value is unknown, not zero — price it from your own source.'
          : '',
        row.valueSource ?? '',
        'income',
      ]),
    );
  }

  // Informational rows ride in the income file rather than in a file of their
  // own: they are the transactions this venue read and REFUSED to classify, and
  // a filer who never opens the second attachment is a filer who never learns
  // that a third of their year was left unclassified. Their legs travel with
  // them, in smallest units beside the asset that moved.
  for (const info of report.informational) {
    const legs = (info.legs ?? [])
      .map((l) => `${l.delta > 0n ? '+' : ''}${l.delta.toString()} ${l.symbol} [${l.asset}]`)
      .join('; ');
    lines.push(
      csvRow([
        info.id,
        iso(info.timestamp),
        info.txHash,
        '',
        '',
        '',
        '',
        info.category ?? 'informational',
        info.source,
        `${info.label} — ${info.detail}${legs.length > 0 ? ` Legs: ${legs}` : ''}`,
        '',
        info.category ?? 'informational',
      ]),
    );
  }

  lines.push('#');
  lines.push(
    `# TOTAL over ${report.income.rows.length - report.income.unpricedRows} priced row(s): ` +
      `${formatScaled(report.income.valueTotal, report.quoteScale)} ${report.quoteCurrency}.`,
  );
  if (!report.income.complete) {
    lines.push(`# ${report.income.unpricedRows} row(s) carry no value and are EXCLUDED from that total.`);
  }
  return lines.join('\n') + '\n';
}
