import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import { useTokenScan } from '../../hooks/useTokenScan';
import { bungalowScanRoute } from '../../lib/bungalows';

/**
 * Who holds the bungalow's token — distribution, in the bungalow.
 *
 * REUSE, NOT A SECOND READER: this runs the venue's OWN scanner
 * (`useTokenScan` → `scanTokenLive` → `fetchSolanaScan`), the same audited path
 * `/scan` uses, through the same hardened `/api/solrpc` proxy. Writing a fresh
 * holder reader here would have duplicated the exclusion rules, the gate and
 * the caveat set — the three things that make this number honest.
 *
 * The coverage limit is stated, not hidden: Solana's `getTokenLargestAccounts`
 * caps at the top 20 accounts, so every concentration figure here is an UPPER
 * BOUND, and the card says so in the scanner's own words (`coverageNotes`).
 * There is deliberately no "holders: N" headline — a top-20 read cannot know
 * the total holder count, and inventing one is exactly the kind of number this
 * venue refuses to print.
 *
 * READ ON DEMAND, not on mount. One distribution read is a batched RPC scan
 * (getTokenLargestAccounts + an owner lookup per account), and the free Solana
 * endpoint rate-limits that method hard enough that a SINGLE call trips it —
 * measured 2026-08-28. Auto-running it from two pages would spend the venue's
 * RPC budget on readers who never asked, and would show them a red 429 for the
 * privilege. So the card asks first. The market strip above it stays automatic:
 * that is one cheap HTTP read, not a scan.
 */
export function BungalowHolders({ bungalow }: { bungalow: Bungalow }) {
  const address = bungalow.address ?? '';
  // Pass the chain through — collapsing base to 'ethereum' would scan a Base
  // token's 0x address on the wrong chain (the scan rail reads all three).
  // 'tbd' never reaches the hook: a tbd slot has no address, so the empty
  // address parks the hook in `idle` and the component renders null below.
  const chain = bungalow.chain === 'tbd' ? 'ethereum' : bungalow.chain;
  const [armed, setArmed] = useState(false);
  // Empty address ⇒ the hook parks in `idle` and issues nothing.
  const { status, outcome, errorMessage, reload } = useTokenScan(armed ? address : '', chain);

  if (!address) return null;

  const a = outcome?.analysis ?? null;
  const m = a?.metrics ?? null;

  return (
    <section
      className="rounded-2xl p-6"
      style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
      aria-label={`${bungalow.symbol} holder distribution`}
    >
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
          Who holds her
        </p>
        <h2 className="heading-luxury text-xl text-white">Distribution</h2>
        <div className="flex-1" />
        <Link
          to={bungalowScanRoute(bungalow) ?? `/scan?token=${address}`}
          className="text-[11px] px-3 py-1 rounded border border-white/10 bg-white/5 text-white/70 hover:text-white"
        >
          Full scan →
        </Link>
        <button
          onClick={() => (armed ? reload() : setArmed(true))}
          disabled={status === 'loading'}
          className="text-[11px] px-3 py-1 rounded border border-white/10 bg-white/5 text-white/70 hover:text-white disabled:opacity-50"
        >
          {status === 'loading' ? 'Reading…' : armed ? 'Refresh' : 'Read distribution'}
        </button>
      </div>

      {status === 'success' && outcome && a && m ? (
        <>
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <span
              className="text-[11px] px-2.5 py-1 rounded-full border"
              style={bandStyle(a.band)}
            >
              {a.band.replace('-', ' ')}
            </span>
            <p className="text-white/85 text-[13px] flex-1 min-w-[240px]">{a.headline}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Top 1" value={pct(m.topN.top1)} />
            <Stat label="Top 5" value={pct(m.topN.top5)} />
            <Stat label="Top 10" value={pct(m.topN.top10)} />
            <Stat
              label="Nakamoto"
              value={String(m.nakamotoCoefficient)}
              title="Fewest holders whose combined share exceeds 50%. Higher is more distributed."
            />
          </div>

          {/* The scanner's own limits, in its own words. */}
          {(outcome.coverageNotes.length > 0 || a.caveats.length > 0) && (
            <ul className="mt-4 space-y-1 text-[11px] text-white/50 list-disc pl-4">
              {outcome.coverageNotes.slice(0, 3).map((n) => <li key={n}>{n}</li>)}
              {a.caveats.slice(0, 2).map((c) => <li key={c}>{c}</li>)}
            </ul>
          )}

          <p className="text-[10px] text-white/40 mt-3">
            Read from {outcome.source} — {outcome.enumeratedHolders} accounts
            {outcome.holderCoverage === 'top-n' ? ' (largest only, so these shares are an upper bound)' : ''}.
          </p>
        </>
      ) : status === 'loading' ? (
        <p className="text-[12px] text-white/55">Reading holders…</p>
      ) : !armed ? (
        <p className="text-[12px] text-white/55">
          Reads the largest {bungalow.symbol} accounts on demand and measures concentration
          with the venue's own scanner. Not run automatically — it is a real chain scan.
        </p>
      ) : (
        <p className="text-[12px]" style={{ color: '#f0b26b' }}>
          {errorMessage ?? 'Holders could not be read right now — that is an outage, not a distribution.'}
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
      title={title}
    >
      <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">{label}</p>
      <p className="text-white text-[15px] tabular-nums">{value}</p>
    </div>
  );
}

function pct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

function bandStyle(band: string): { color: string; borderColor: string; background: string } {
  if (band === 'well-distributed') {
    return { color: '#22c55e', borderColor: 'rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.08)' };
  }
  if (band === 'concentrated') {
    return { color: '#ef4444', borderColor: 'rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)' };
  }
  return { color: '#f0b26b', borderColor: 'rgba(240,178,107,0.35)', background: 'rgba(240,178,107,0.08)' };
}
