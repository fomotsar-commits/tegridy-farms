// Launch discovery / outcomes surface (docs/LAUNCHER_STRATEGY.md §2.5 + §2.7).
//
// This is the read-only counterpart to the wizard: it renders launches in the
// DETERMINISTIC, published order from ordering.ts (no pay-to-rank field can
// enter the score — see ordering.ts), alongside each launch's DISCLOSED-risk
// outcome flags from outcomes.ts. Every string it renders is factual; nothing
// here endorses a token or calls one "safe" / "rug" / "guaranteed".
//
// Gate-safe + testable by construction: this component fetches NOTHING. The
// parent supplies `launches` (and optional `outcomes`) so the surface degrades
// to a clean empty state while the launcher is gated, and the ordering/outcome
// logic stays pure and unit-testable.

import { useMemo } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import type { LaunchTier } from '../../lib/launcher/factSheet';
import { ArtCard } from '../ui/ArtCard';
import {
  orderLaunches,
  defaultOrderingConfig,
  type LaunchSummary,
  type RankedLaunch,
} from '../../lib/launcher/ordering';
import {
  deriveOutcomeFlags,
  priceReturn,
  type OutcomeRecord,
} from '../../lib/launcher/outcomes';

export interface LaunchExplorerProps {
  /** Launches to render. Parent-supplied; this component never fetches. */
  launches: LaunchSummary[];
  /** Optional post-launch outcome snapshots, keyed by token address. */
  outcomes?: Record<string, OutcomeRecord>;
  /** Injectable clock (unix seconds) so ordering/recency are deterministic in tests. */
  now?: number;
}

/** Look up an outcome by token address (checked as-given, then lowercased). */
export function outcomeFor(
  token: Address,
  outcomes?: Record<string, OutcomeRecord>,
): OutcomeRecord | undefined {
  if (!outcomes) return undefined;
  return outcomes[token] ?? outcomes[token.toLowerCase()];
}

/** Factual, signed price-move label (never editorialised). Pure — exported for tests. */
export function formatPriceReturn(r: OutcomeRecord): string {
  const ret = priceReturn(r);
  const pct = Math.round(ret * 1000) / 10;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}% vs launch`;
}

const tierBadge: Record<LaunchTier, { label: string; cls: string }> = {
  flagship: { label: 'FLAGSHIP', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  listable: { label: 'COMMUNITY', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
  none: { label: 'BELOW BAR', cls: 'bg-white/10 text-white/60 border-white/20' },
};

function shortAddr(a: Address): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function LaunchExplorer({ launches, outcomes, now }: LaunchExplorerProps) {
  const ranked = useMemo<RankedLaunch[]>(() => {
    const cfg = defaultOrderingConfig(now ?? Math.floor(Date.now() / 1000));
    return orderLaunches(launches, cfg);
  }, [launches, now]);

  return (
    <section aria-label="Launch outcomes" className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Launches &amp; outcomes</h2>
          <p className="text-white/50 text-xs mt-1 max-w-lg leading-relaxed">
            Ordered by a published, deterministic score — tier, recency, and log-scaled on-chain
            activity. Rank cannot be bought. Post-launch outcomes below are factual disclosures, not
            safety judgements.
          </p>
        </div>
      </header>

      {ranked.length === 0 ? (
        <ArtCard pageId="launch" idx={42} padding="p-8" className="text-center">
          <p className="text-white/80 text-sm font-medium">No launches yet</p>
          <p className="text-white/50 text-xs mt-1">
            Graduated launches will appear here with their transparent score and tracked outcomes.
          </p>
        </ArtCard>
      ) : (
        <ol className="space-y-3">
          {ranked.map((r, i) => (
            <LaunchRow
              key={r.summary.token}
              rank={i + 1}
              ranked={r}
              outcome={outcomeFor(r.summary.token, outcomes)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function LaunchRow({
  rank,
  ranked,
  outcome,
}: {
  rank: number;
  ranked: RankedLaunch;
  outcome?: OutcomeRecord;
}) {
  const { summary, score, breakdown } = ranked;
  const badge = tierBadge[summary.tier];
  // marketObserved === false means the last snapshot couldn't read live market data —
  // its price/liquidity mirror the baseline, so we render "unavailable" rather than
  // deriving (and showing) a misleading "no adverse signals".
  const marketUnavailable = outcome?.marketObserved === false;
  const flags = outcome && !marketUnavailable ? deriveOutcomeFlags(outcome) : null;

  return (
    <m.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(rank, 8) * 0.03 }}
      className="rounded-2xl p-4 sm:p-5"
      style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-white/30 tabular-nums text-sm w-6 shrink-0">#{rank}</span>
          {/* Rows used to be dead ends. They now open the token's permanent record —
              its provenance, disclosures, attestation and post-graduation state. */}
          <Link
            to={`/launch/${summary.token}`}
            className="text-white/80 hover:text-white text-sm font-mono truncate underline underline-offset-2 decoration-white/25 hover:decoration-white/60"
            title={`Open the record for ${summary.token}`}
          >
            {shortAddr(summary.token)}
          </Link>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border shrink-0 ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Transparent score breakdown — the published formula, shown openly. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/50">
        <span className="text-white/70">
          score <span className="tabular-nums text-white/90">{score.toFixed(1)}</span>
        </span>
        <span className="tabular-nums">tier {breakdown.tier.toFixed(0)}</span>
        <span className="tabular-nums">recency {breakdown.recency.toFixed(1)}</span>
        <span className="tabular-nums">activity {breakdown.activity.toFixed(1)}</span>
        {/* OUTAGE-AS-ZERO. holderCount was 0 for every count we could not read — Etherscan
            Pro-gates the stat — so a graduated token with a live pool was published to
            every visitor as "· 0 holders". A count we did not read says so, in the same
            register as the "Market data unavailable" line below. */}
        <span className="tabular-nums">
          · {summary.holderCount == null ? 'holders unavailable' : `${summary.holderCount.toLocaleString()} holders`}
        </span>
        <span className="tabular-nums">· {summary.liquidityEth.toLocaleString()} ETH liq</span>
      </div>

      {/* Disclosed-risk outcome lines (factual). */}
      <div className="mt-3 border-t border-white/8 pt-3">
        {marketUnavailable ? (
          <p className="text-white/35 text-xs">Market data unavailable at last check.</p>
        ) : flags ? (
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2 text-xs">
              <span className="text-white/40">Price</span>
              <span className="text-white/70 tabular-nums">{formatPriceReturn(outcome!)}</span>
            </li>
            {flags.disclosures.map((d, idx) => {
              const adverse = flags.liquidityDrained || flags.unlockDumped || flags.likelyAbandoned;
              return (
                <li key={idx} className="flex items-start gap-2 text-xs">
                  <span className={adverse ? 'text-amber-400/80' : 'text-emerald-400/70'}>
                    {adverse ? '!' : '✓'}
                  </span>
                  <span className="text-white/60 leading-relaxed">{d}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-white/35 text-xs">No outcome snapshot recorded yet.</p>
        )}
      </div>
    </m.li>
  );
}

export default LaunchExplorer;
