import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { CostBasisPicker } from '../components/tax/CostBasisPicker';
import { LedgerStatusCard } from '../components/tax/LedgerStatusCard';
import { TaxReportPanel } from '../components/tax/TaxReportPanel';
import { useTaxReport } from '../hooks/useTaxReport';
import { importTaxRows, IMPORT_TEMPLATE, type ImportError } from '../lib/tax/import';
import type { IncomeEvent } from '../lib/tax/events';
import type { TaxLotEvent } from '../lib/tax/lots';
import { NOT_TAX_ADVICE } from '../lib/tax/methods';
import type { CostBasisMethod } from '../lib/tax/methods';

// TAX REPORTS — capital gains and income, read from the wallet's own history.
//
// Three properties this page exists to hold, all enforced in lib/tax:
//
//   1. The cost-basis method is SELECTED and is stamped on every export. FIFO
//      and specific identification produce different numbers from identical
//      history, and an unlabelled report cannot be reproduced by anyone
//      downstream — methods.ts.
//   2. Any stretch of the requested period the venue could not read is a GAP
//      written onto the export itself, above the data. A report that quietly
//      drops six weeks is worse than no report — coverage.ts.
//   3. An unknown is never a zero. Ethereum-mainnet history is read through
//      this deployment's explorer proxy, which returns BOTH legs of a trade in
//      the same transaction, so a disposal gets real proceeds — but only where
//      the counter-leg was actually read. Anything else (third-party fills,
//      multi-leg transactions, token-for-token trades in an ETH-quoted report)
//      is listed, excluded from the totals, and carries its reason — ledger.ts
//      and lots.ts. The matcher produces real numbers as soon as a filer
//      supplies real numbers, which is what the import box is for.
//
// SCALE. The report is quoted in ETH at 18 decimals, so the paste box parses
// its `value` column at 18 too. A pasted `0.5` and a read 5e17 must be the same
// number inside one matcher, or a filer's own row silently arrives sixteen
// orders of magnitude out.

const YEARS = [2023, 2024, 2025, 2026];

/** ETH, so a pasted value and a read value meet on the same scale. */
const QUOTE_SCALE = 18;

export default function TaxPage() {
  usePageTitle(
    'Tax Reports',
    'Capital-gains and income reports read from your wallet’s Ethereum mainnet history through this ' +
      'deployment’s explorer proxy, priced in ETH from both legs of each trade, with a selectable ' +
      'cost-basis method and every unread stretch declared on the file itself. Not tax advice.',
  );

  const { address } = useAccount();
  const [year, setYear] = useState(2025);
  const [method, setMethod] = useState<CostBasisMethod>('fifo');
  const [pasted, setPasted] = useState('');
  const [imported, setImported] = useState<{ lotEvents: TaxLotEvent[]; income: IncomeEvent[] } | null>(null);
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);

  const periodStart = useMemo(() => Math.floor(Date.UTC(year, 0, 1) / 1000), [year]);
  const periodEnd = useMemo(() => Math.floor(Date.UTC(year, 11, 31, 23, 59, 59) / 1000), [year]);

  const { report, ledger, reload, cooldownSeconds } = useTaxReport({
    account: address ?? null,
    periodStart,
    periodEnd,
    method,
    quoteCurrency: 'ETH',
    quoteScale: QUOTE_SCALE,
    supplied: imported ?? undefined,
  });

  function runImport() {
    const res = importTaxRows(pasted, QUOTE_SCALE);
    setImportErrors(res.errors);
    // A partial import is a silently wrong filing, so an errored parse replaces
    // nothing — the previously imported set is cleared too, rather than left
    // sitting under a list of errors as though it were still current.
    setImported(res.errors.length === 0 ? { lotEvents: res.lotEvents, income: res.income } : null);
  }

  const cooling = cooldownSeconds > 0;

  return (
    <div className="relative">
      <PageArtBackdrop pageId="tax" />
      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Tax Reports</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            Capital gains and income for one wallet and one period, read from your Ethereum mainnet history
            and matched by a cost-basis method you pick and that is written onto every file. Trades are
            priced in ETH from both legs of the transaction they happened in. Anything this venue could not
            read, or would not classify, is marked on the export rather than left out of it.
          </p>
          <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-amber-200/80">{NOT_TAX_ADVICE}</p>
        </header>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
          <div className="space-y-4">
            <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
              <label htmlFor="tax-year" className="text-[11px] uppercase tracking-wide text-white/55">
                Period
                <select
                  id="tax-year"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="mt-1 block min-h-[44px] w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                >
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y} (UTC calendar year)
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-[11px] leading-relaxed text-white/50">
                {address
                  ? `Wallet ${address} · Ethereum mainnet only. Base and other chains were not read.`
                  : 'No wallet connected — nothing has been read for anyone.'}
              </p>
              <button
                type="button"
                onClick={reload}
                disabled={cooling}
                className="btn-secondary mt-3 min-h-[44px] px-4 py-1.5 text-[12px] disabled:opacity-50"
              >
                {cooling ? `Re-read available in ${cooldownSeconds}s` : 'Re-read history'}
              </button>
            </section>

            <CostBasisPicker method={method} onChange={setMethod} />

            <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
              <h2 className="text-sm font-semibold text-white">Bring your own lots</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-white/60">
                Trades this venue read are priced from their own counter-leg. Anything it could not read or
                classify — third-party fills, multi-leg transactions, other chains — is listed, not priced.
                Paste the rows you hold and the same matcher prices them; nothing here guesses a value.
                Values are read as ETH, to {QUOTE_SCALE} decimal places.
              </p>
              <label htmlFor="tax-import" className="sr-only">
                Paste rows to import
              </label>
              <textarea
                id="tax-import"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={6}
                placeholder={IMPORT_TEMPLATE}
                className="mt-2 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 font-mono text-[11px] text-white"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={runImport}
                  className="btn-secondary min-h-[44px] px-4 py-1.5 text-[12px]"
                >
                  Import
                </button>
                <button
                  type="button"
                  onClick={() => setPasted(IMPORT_TEMPLATE)}
                  className="btn-secondary min-h-[44px] px-4 py-1.5 text-[12px]"
                >
                  Use the template
                </button>
              </div>
              {importErrors.length > 0 ? (
                <>
                  <p className="mt-3 text-[12px] font-medium text-rose-200/90">
                    Nothing was imported. One bad row fails the whole sheet — a partial import is a filing
                    with a transaction silently missing.
                  </p>
                  <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-white/70">
                    {importErrors.map((e) => (
                      <li key={`${e.line}-${e.message}`}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                </>
              ) : imported ? (
                <p className="mt-3 text-[12px] text-white/70">
                  {imported.lotEvents.length} lot row(s) and {imported.income.length} income row(s) imported.
                  They are marked <code className="text-white/85">supplied</code> on every export — nothing
                  checked them.
                </p>
              ) : null}
            </section>
          </div>

          <div className="space-y-4">
            <LedgerStatusCard read={ledger} />
            <p className="text-[12px] leading-relaxed text-white/60">
              Values are in ETH, read from both legs of each trade. Most jurisdictions require fiat: convert
              with your own rates — nothing here converts silently.
            </p>
            <TaxReportPanel report={report} />
          </div>
        </div>
      </div>
    </div>
  );
}
