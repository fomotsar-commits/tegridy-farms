// Launch Radar — MARKET-WIDE new pools, pointed at our detection engine.
//
// HONESTY BOUNDARY (the reason this is a separate component, not more rows in
// LaunchExplorer): the explorer and the Afterlife ledger promise tokens that
// launched and graduated through THE TEGRIDY RAIL. They stay integrator-filtered
// and honestly empty until a real one does. This surface is the OPPOSITE claim —
// "here is what the whole market just launched, measured by our engine" — and it
// says so in its own header. Never merge the two data sets: doing so would
// fabricate a track record, which is the one thing the moat cannot survive.
//
// It endorses nothing. A row is a pool that exists, its age, and whatever price /
// liquidity the upstream actually reported (0 renders as "—", never a guess). The
// only judgement offered is a link to /scan, where the disclosed-method read lives.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { fetchLaunchRadar, type RadarEntry } from '../../lib/launcher/radarClient';
import { formatTimeAgo } from '../../lib/formatting';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; entries: RadarEntry[]; observedAt: number; poolsReadFailed: boolean }
  | { phase: 'unavailable' };

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** ETH amounts, or an em dash when the upstream didn't report a usable number. */
function eth(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 100) return `${n.toFixed(0)} ETH`;
  if (n >= 1) return `${n.toFixed(2)} ETH`;
  if (n >= 0.0001) return `${n.toFixed(4)} ETH`;
  return `${n.toExponential(1)} ETH`;
}

export function LaunchRadar() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetchLaunchRadar({ signal: ac.signal });
        // OUTAGE-AS-ZERO. A short window with rows is still a truthful radar and says so
        // in the footer. A short window with NOTHING to show is not the "no new pools in
        // the current window" answer below, and must never render as one.
        if (!ac.signal.aborted) {
          setState(
            r.entries.length === 0 && r.poolsReadFailed
              ? { phase: 'unavailable' }
              : { phase: 'ready', entries: r.entries, observedAt: r.observedAt, poolsReadFailed: r.poolsReadFailed },
          );
        }
      } catch {
        // Network/HTTP failure (or abort) — degrade to an honest "unavailable",
        // never a fabricated or stale-but-unlabelled list.
        if (!ac.signal.aborted) setState({ phase: 'unavailable' });
      }
    })();
    return () => ac.abort();
  }, []);

  return (
    <section aria-label="Launch Radar" className="space-y-4">
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-white">Launch Radar</h2>
          <span className="text-[10px] uppercase tracking-wider text-white/45 border border-white/15 rounded px-1.5 py-0.5">
            Market-wide
          </span>
        </div>
        <p className="text-white/50 text-xs mt-1 max-w-lg leading-relaxed">
          New Ethereum pools from across the whole market — <span className="text-white/70">not</span> launches from this
          rail. Nothing here is endorsed, ranked or vetted; it is a feed you can point our detection engine at. Open any
          row in the Token Scanner for a holder-concentration read with its method and exclusions.
        </p>
      </header>

      {state.phase === 'loading' && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ border: '1px dashed rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
        >
          <p className="text-white/50 text-xs animate-pulse">Reading new pools…</p>
        </div>
      )}

      {state.phase === 'unavailable' && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ border: '1px dashed rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
        >
          <p className="text-white/70 text-sm font-medium">Radar unavailable right now</p>
          <p className="text-white/40 text-xs mt-1">
            The new-pool feed didn&apos;t respond. That&apos;s a data outage on our side, not a signal about any token —
            you can still scan any address directly in the{' '}
            <Link to="/scan" className="text-emerald-400/80 hover:text-emerald-300 underline transition-colors">
              Token Scanner
            </Link>
            .
          </p>
        </div>
      )}

      {state.phase === 'ready' && state.entries.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center"
          style={{ border: '1px dashed rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
        >
          <p className="text-white/70 text-sm font-medium">No new pools in the current window</p>
          <p className="text-white/40 text-xs mt-1">The upstream returned nothing to show right now.</p>
        </div>
      )}

      {state.phase === 'ready' && state.entries.length > 0 && (
        <>
          <ol className="space-y-2">
            {state.entries.map((e, i) => (
              <m.li
                key={e.token}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 8) * 0.02 }}
                className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(6,12,26,0.6)' }}
              >
                <div className="min-w-0">
                  <div className="text-white text-[13px] font-medium truncate">{e.name ?? shortAddr(e.token)}</div>
                  <div className="text-white/40 text-[11px] tabular-nums">
                    {shortAddr(e.token)}
                    {e.launchedAt > 0 && <> · {formatTimeAgo(e.launchedAt)}</>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-white/70 text-[12px] tabular-nums">{eth(e.liquidityEth)}</div>
                  <Link to={`/scan?token=${e.token}`} className="text-emerald-400/80 hover:text-emerald-300 text-[11px]">
                    Scan →
                  </Link>
                </div>
              </m.li>
            ))}
          </ol>
          <p className="text-white/30 text-[11px]">
            Liquidity is the pool reserve as reported upstream. &ldquo;—&rdquo; means we have no figure we trust — either
            none was reported, or what was reported isn&apos;t a believable market price — never that it is zero.
            {state.poolsReadFailed && (
              <> Part of the window could not be read, so this list is short — it is not everything that launched.</>
            )}
            {state.observedAt > 0 && <> Read {formatTimeAgo(state.observedAt)}.</>}
          </p>
        </>
      )}
    </section>
  );
}

export default LaunchRadar;
