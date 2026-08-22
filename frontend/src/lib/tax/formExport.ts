// The generic capital-gains worksheet export.
//
// ─── WHAT THIS IS, AND WHAT IT IS CAREFULLY NOT ─────────────────────────────
//
// It is a worksheet whose columns are the six that essentially every
// capital-gains form and every tax package asks for: what was sold, when it was
// acquired, when it was sold, what it fetched, what it cost, and the difference.
// The column ORDER matches the common (a)–(h) layout so a package that expects
// it can ingest the file without re-mapping.
//
// It is NOT a completed tax form, it is not jurisdiction-specific, and it does
// not classify anything as short- or long-term — that classification is a
// holding-period threshold set by a jurisdiction, and this venue does not know
// anybody's. `held_days` is given instead, which is the arithmetic, and the
// threshold is left to whoever is actually filing.
//
// ─── WHY UNPRICED ROWS ARE STILL WRITTEN ────────────────────────────────────
//
// A row with no proceeds and no basis cannot be filed as-is, and it is still
// written out — with its money columns EMPTY and a `status` of `incomplete`
// carrying the reason. Dropping it would hand the filer a worksheet that omits a
// disposal that really happened, which is the more dangerous of the two
// failures: a missing sale is invisible, while an empty cell is a question.

import { formatScaled, csvField, reportHeaderLines } from './csv';
import { INCOMPLETE_REASON_TEXT } from './lots';
import type { TaxReport } from './report';

/**
 * The column layout, in the order the common capital-gains worksheet uses.
 *
 * Two extra columns follow it — `held_days` and `status` — deliberately at the
 * END, so an importer reading the first six positionally is unaffected while a
 * human reading the file still sees whether a row is complete.
 */
export const FORM_COLUMNS = [
  'description',
  'date_acquired',
  'date_sold',
  'proceeds',
  'cost_basis',
  'gain_or_loss',
  'held_days',
  'status',
  'notes',
] as const;

const FORM_NOTICE =
  'This is a WORKSHEET, not a filed form. Columns 1–6 are the ones a capital-gains form and most tax ' +
  'software ask for, in the usual order. Nothing here is classified as short- or long-term: that threshold ' +
  'is set by your jurisdiction and this file does not know it — use the held_days column.';

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function capitalGainsFormExport(report: TaxReport): string {
  const lines = reportHeaderLines(report, 'Capital gains worksheet (generic form layout)');
  lines.push(`# ${FORM_NOTICE}`);
  lines.push('#');
  lines.push(FORM_COLUMNS.map(csvField).join(','));

  for (const d of report.capitalGains.disposals) {
    const earliest = d.lots.length > 0 ? Math.min(...d.lots.map((l) => l.acquiredAt)) : null;
    const description = `${formatScaled(d.quantity, d.decimals)} ${d.assetSymbol}`;
    // The unmatched portion is named IN the description rather than as a
    // separate column: a filer reading a row on paper must not have to
    // cross-reference a column to learn that part of the quantity has no lot.
    const suffix =
      d.unmatchedQuantity > 0n
        ? ` (${formatScaled(d.unmatchedQuantity, d.decimals)} of this has no acquiring lot)`
        : '';

    lines.push(
      [
        `${description}${suffix}`,
        earliest === null ? '' : iso(earliest),
        iso(d.disposedAt),
        d.proceeds === null ? '' : formatScaled(d.proceeds, 2),
        d.costBasis === null ? '' : formatScaled(d.costBasis, 2),
        d.gain === null ? '' : formatScaled(d.gain, 2),
        d.heldDays === null ? '' : String(d.heldDays),
        d.gain === null ? 'incomplete' : 'complete',
        d.incompleteReasons.map((r) => INCOMPLETE_REASON_TEXT[r]).join(' '),
      ]
        .map(csvField)
        .join(','),
    );
  }

  lines.push('#');
  lines.push(
    `# Subtotal of the ${report.capitalGains.totals.countedRows} complete row(s): proceeds ` +
      `${formatScaled(report.capitalGains.totals.proceeds, 2)}, cost basis ` +
      `${formatScaled(report.capitalGains.totals.costBasis, 2)}, gain or loss ` +
      `${formatScaled(report.capitalGains.totals.realisedGain, 2)} ${report.quoteCurrency}.`,
  );
  if (!report.capitalGains.totals.complete) {
    lines.push(
      `# ${report.capitalGains.totals.incompleteRows} row(s) above are marked incomplete and are NOT in ` +
        'that subtotal. Fill in their missing figures before transcribing anything onto a form.',
    );
  }
  return lines.join('\n') + '\n';
}
