import { capitalGainsCsv, formatScaled, incomeCsv } from '../../lib/tax/csv';
import { capitalGainsFormExport } from '../../lib/tax/formExport';
import { INCOMPLETE_REASON_TEXT } from '../../lib/tax/lots';
import { NOT_TAX_ADVICE } from '../../lib/tax/methods';
import { reportStandingText, type TaxReport } from '../../lib/tax/report';

// The report, on screen, with the same qualifiers the file carries.
//
// ─── THE STANDING LINE GOES ABOVE THE FIGURES ───────────────────────────────
//
// `reportStandingText` is rendered first, not as a footnote, because the figure
// a reader takes away is the one they see first. A total that excludes rows it
// could not price is a smaller, cleaner, wrong number, and it is exactly the one
// somebody would quote.
//
// ─── NO NUMBER IS INVENTED HERE ─────────────────────────────────────────────
//
// Every figure comes off the report object. A missing value renders as an em
// dash with its reason attached, never as 0.00 — the difference between "this
// disposal made nothing" and "nobody knows what this disposal made" is the whole
// difference between a usable report and a misleading one.

/**
 * Hand the file to the browser.
 *
 * A Blob and an object URL rather than a `data:` href: a year of rows exceeds
 * what several browsers will follow in a data URL, and the failure there is a
 * silently truncated download — a tax file missing its tail, with nothing
 * marking it.
 */
function downloadCsv(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function periodSlug(report: TaxReport): string {
  return `${new Date(report.periodStart * 1000).toISOString().slice(0, 10)}_${new Date(
    report.periodEnd * 1000,
  )
    .toISOString()
    .slice(0, 10)}`;
}

/**
 * How many unclassified rows are drawn on screen.
 *
 * A busy wallet produces a fee row per transaction and a listing per transfer,
 * which is thousands of list items — a page that stops scrolling. The count is
 * always stated in full, the remainder is named rather than dropped, and the
 * file has every one of them; what is capped is the drawing, not the report.
 */
const INFORMATIONAL_ON_SCREEN = 50;

export function TaxReportPanel({ report }: { report: TaxReport }) {
  const cg = report.capitalGains;

  return (
    <div className="space-y-4">
      <section
        className={`rounded-xl border p-4 ${
          report.usableAsFiled ? 'border-emerald-400/25 bg-emerald-400/[0.06]' : 'border-amber-400/30 bg-amber-400/[0.06]'
        }`}
      >
        <h2 className="text-sm font-semibold text-white">Standing of this report</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/85">{reportStandingText(report)}</p>
      </section>

      {report.coverage.complete ? null : (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          <h2 className="text-sm font-semibold text-white">
            Coverage gaps — {report.coverage.gaps.length} stretch
            {report.coverage.gaps.length === 1 ? '' : 'es'} of this period could not be read
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-white/60">
            Each of these is written onto the export itself, above the data, so it travels with the file.
          </p>
          <ul className="mt-3 space-y-2">
            {report.coverage.gaps.map((g) => (
              <li key={`${g.reason}-${g.from}`} className="rounded-lg border border-white/10 bg-black/25 p-3">
                <p className="text-[12px] font-medium text-white/85">
                  {new Date(g.from * 1000).toISOString().slice(0, 10)} →{' '}
                  {new Date(g.to * 1000).toISOString().slice(0, 10)}{' '}
                  <span className="text-white/45">[{g.reason}]</span>
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-white/70">{g.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.limitations.length > 0 ? (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          <h2 className="text-sm font-semibold text-white">What this venue cannot tell you</h2>
          <ul className="mt-2 space-y-2 text-[12px] leading-relaxed text-white/75">
            {report.limitations.map((l) => (
              <li key={l.code}>
                <span className="text-white/45">[{l.code}]</span> {l.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Capital gains</h2>
        <dl className="mt-2 grid gap-2 text-[12px] sm:grid-cols-3">
          <div>
            <dt className="text-white/50">Proceeds (counted rows)</dt>
            <dd className="text-white/90">
              {formatScaled(cg.totals.proceeds, report.quoteScale)} {report.quoteCurrency}
            </dd>
          </div>
          <div>
            <dt className="text-white/50">Cost basis (counted rows)</dt>
            <dd className="text-white/90">
              {formatScaled(cg.totals.costBasis, report.quoteScale)} {report.quoteCurrency}
            </dd>
          </div>
          <div>
            <dt className="text-white/50">Realised gain (counted rows)</dt>
            <dd className="text-white/90">
              {formatScaled(cg.totals.realisedGain, report.quoteScale)} {report.quoteCurrency}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[12px] text-white/60">
          {cg.totals.countedRows} row(s) counted, {cg.totals.incompleteRows} excluded for having a figure
          nobody knows.
        </p>

        {cg.disposals.length === 0 ? (
          <p className="mt-3 text-[13px] leading-relaxed text-white/70">
            No disposals were read for this period. Read the standing line above before taking that as "there
            were none".
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-[12px]">
              <thead className="text-white/50">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Disposed</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Asset</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Quantity</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Proceeds</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Basis</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Gain</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Held</th>
                  <th scope="col" className="py-1 font-medium">Figure from</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {cg.disposals.map((d) => (
                  <tr key={d.disposalId} className="border-t border-white/10 align-top">
                    <td className="py-1.5 pr-3">{new Date(d.disposedAt * 1000).toISOString().slice(0, 10)}</td>
                    <td className="py-1.5 pr-3">{d.assetSymbol}</td>
                    <td className="py-1.5 pr-3">{formatScaled(d.quantity, d.decimals)}</td>
                    <td className="py-1.5 pr-3">{d.proceeds === null ? '—' : formatScaled(d.proceeds, report.quoteScale)}</td>
                    <td className="py-1.5 pr-3">{d.costBasis === null ? '—' : formatScaled(d.costBasis, report.quoteScale)}</td>
                    <td className="py-1.5 pr-3">{d.gain === null ? '—' : formatScaled(d.gain, report.quoteScale)}</td>
                    <td className="py-1.5 pr-3">{d.heldDays === null ? '—' : `${d.heldDays}d`}</td>
                    <td className="py-1.5 text-white/60">
                      {[d.proceedsSource, d.costBasisSource].filter(Boolean).join(' / ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cg.disposals.some((d) => d.incompleteReasons.length > 0) ? (
          <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-white/55">
            {[...new Set(cg.disposals.flatMap((d) => d.incompleteReasons))].map((r) => (
              <li key={r}>{INCOMPLETE_REASON_TEXT[r]}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Income</h2>
        <p className="mt-2 text-[12px] text-white/60">
          {report.income.rows.length} receipt(s), {report.income.unpricedRows} of them with no value attached.
          Priced total: {formatScaled(report.income.valueTotal, report.quoteScale)} {report.quoteCurrency}.
        </p>
        {report.income.rows.length === 0 ? (
          <p className="mt-2 text-[13px] leading-relaxed text-white/70">
            No income receipts were read for this period.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-[12px]">
              <thead className="text-white/50">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Received</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Asset</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Quantity</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Value</th>
                  <th scope="col" className="py-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {report.income.rows.map((row) => (
                  <tr key={row.id} className="border-t border-white/10">
                    <td className="py-1.5 pr-3">{new Date(row.timestamp * 1000).toISOString().slice(0, 10)}</td>
                    <td className="py-1.5 pr-3">{row.assetSymbol}</td>
                    <td className="py-1.5 pr-3">{formatScaled(row.quantity, row.decimals)}</td>
                    <td className="py-1.5 pr-3">{row.value === null ? '—' : formatScaled(row.value, report.quoteScale)}</td>
                    <td className="py-1.5">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report.informational.length > 0 ? (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          <h2 className="text-sm font-semibold text-white">
            Recorded, but not classified — {report.informational.length} row(s)
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-white/60">
            Every one of these is in the income export in full, with its legs. They are transactions this
            venue read and refused to turn into a trade, which is not the same as transactions it missed.
          </p>
          <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-white/75">
            {report.informational.slice(0, INFORMATIONAL_ON_SCREEN).map((i) => (
              <li key={i.id}>
                <span className="text-white/90">{i.label}</span> — {i.detail}
                {i.legs && i.legs.length > 0 ? (
                  <span className="mt-1 block font-mono text-[11px] text-white/55">
                    {i.legs
                      .map((l) => `${l.delta > 0n ? '+' : ''}${formatScaled(l.delta, l.decimals ?? 18)} ${l.symbol}`)
                      .join('  ·  ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {report.informational.length > INFORMATIONAL_ON_SCREEN ? (
            <p className="mt-3 text-[12px] leading-relaxed text-white/60">
              {report.informational.length - INFORMATIONAL_ON_SCREEN} more row(s) are not drawn here. They are
              NOT missing: every one is in the income export, which is where a list this long is readable.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Export</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-white/60">
          Every file starts with the method, the period, each coverage gap and this notice, above the header
          row — and every money column has a source column beside it, so the chain scope and where each
          figure came from travel in the file. A CSV outlives the screen it was made on.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => downloadCsv(`capital-gains_${report.method}_${periodSlug(report)}.csv`, capitalGainsCsv(report))}
            className="btn-secondary min-h-[44px] px-4 py-1.5 text-[12px]"
          >
            Capital gains (CSV)
          </button>
          <button
            type="button"
            onClick={() => downloadCsv(`income_${periodSlug(report)}.csv`, incomeCsv(report))}
            className="btn-secondary min-h-[44px] px-4 py-1.5 text-[12px]"
          >
            Income (CSV)
          </button>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                `capital-gains-worksheet_${report.method}_${periodSlug(report)}.csv`,
                capitalGainsFormExport(report),
              )
            }
            className="btn-secondary min-h-[44px] px-4 py-1.5 text-[12px]"
          >
            Capital gains (form layout)
          </button>
        </div>
      </section>

      <p className="text-[11px] leading-relaxed text-white/50">{NOT_TAX_ADVICE}</p>
    </div>
  );
}

export default TaxReportPanel;
