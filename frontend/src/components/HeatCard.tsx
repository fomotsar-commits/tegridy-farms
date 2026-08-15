// Heat — Jungle Bay Island's held-time reading for a wallet, and a plain-English
// account of how it was arrived at.
//
// HONESTY RULES BAKED INTO THIS COMPONENT (do not "simplify" them away):
//  1. Heat is the ISLAND'S measurement, not ours. The panel says so, every time.
//  2. Tier words render VERBATIM (Elder / Builder / Resident / Observer / Drifter)
//     and are never translated into yield, APR, rewards or points language. Heat is
//     held time. It pays nothing.
//  3. The reckoning date is always on screen. A stale ruler certifies nothing, so a
//     stale reading is labelled as stale rather than quietly shown as current.
//  4. "The instrument is unreachable" and "this wallet is cold" are DIFFERENT states
//     with different copy. An outage must never render as a zero score.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { fetchHeat, isSupportedHeatAddress, HeatUnavailableError } from '../lib/heat/heatClient';
import {
  isStale,
  nextTier,
  shareForDegrees,
  gateDecision,
  TIER_FLOORS,
  HEAT_K,
  type HeatReading,
  type HeatTier,
} from '../lib/heat/heatOracle';
import { heatLaunchFloor, heatGateMaxAgeDays } from '../lib/heat/heatGateConfig';
import { shortenAddress } from '../lib/formatting';

const TIER_COLOR: Record<HeatTier, string> = {
  Elder: '#f5e4b8',
  Builder: '#4CAF50',
  Resident: '#31d0aa',
  Observer: '#8b5cf6',
  Drifter: 'rgba(255,255,255,0.55)',
};

const DAY = 86_400;

function agoLabel(unix: number, now: number): string {
  const s = Math.max(0, now - unix);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < DAY) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / DAY);
  if (d < 60) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 24 ? `${mo}mo ago` : `${Math.floor(d / 365)}y ago`;
}

function heldForLabel(unix: number, now: number): string {
  const d = Math.max(0, Math.floor((now - unix) / DAY));
  if (d < 60) return `${d} days`;
  const mo = Math.floor(d / 30);
  return mo < 24 ? `${mo} months` : `${(d / 365).toFixed(1)} years`;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; reading: HeatReading };

export interface HeatCardProps {
  /**
   * Read THIS wallet instead of whatever is connected, and hide the lookup form.
   *
   * This is what makes one component serve every surface. The leaderboard wants a
   * free-text instrument anyone can point at any wallet; the gate's COLD state wants
   * the connected wallet's own reading and nothing else — "the wallet sees its own
   * degrees and what warmth is". Same card, same copy, same tier words.
   */
  address?: string;
  /**
   * Drop the outer panel chrome and the explainer paragraph, for embedding inside a
   * surface that has already introduced itself (the gate). The READING is unchanged:
   * degrees, tier word, held-since, reckoning date and the per-token breakdown all
   * still render. Nothing that constitutes the judgment is ever hidden by a variant.
   */
  variant?: 'panel' | 'embedded';
  /** Hide the launch-floor line, for surfaces where launching is not the subject. */
  showEligibility?: boolean;
}

export function HeatCard({ address: pinned, variant = 'panel', showEligibility = true }: HeatCardProps = {}) {
  const { address: connected } = useAccount();
  const embedded = variant === 'embedded';
  // `draft` is null until the user types. The field's value is DERIVED from that plus
  // the connected wallet, rather than mirrored into state by an effect — so connecting,
  // switching accounts, or disconnecting needs no state sync and cannot desync.
  const [draft, setDraft] = useState<string | null>(null);
  const subject = pinned ?? connected ?? '';
  const input = pinned ?? draft ?? connected ?? '';
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [showMath, setShowMath] = useState(false);
  // Frozen per lookup so every relative label on screen is measured from one instant.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const abortRef = useRef<AbortController | null>(null);

  const look = useCallback(async (raw: string) => {
    const addr = raw.trim();
    if (!addr) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setNow(Math.floor(Date.now() / 1000));
    setState({ kind: 'loading' });
    try {
      const reading = await fetchHeat(addr, { signal: ac.signal });
      if (!ac.signal.aborted) setState({ kind: 'ready', reading });
    } catch (e) {
      if (ac.signal.aborted) return;
      setState({
        kind: 'error',
        message: e instanceof HeatUnavailableError ? e.message : 'The instrument is unreachable. Try again in a moment.',
      });
    }
  }, []);

  // Auto-read the subject wallet (pinned, else connected), so the common case needs no
  // typing. Keyed on the address itself, so switching accounts re-reads; guarded by a
  // ref so a re-render cannot re-fire the same lookup. No setState here — the field is
  // derived above. A user-typed draft suspends the auto-read; a PINNED address does not,
  // because there is no form to type into.
  const autoReadFor = useRef<string | null>(null);
  useEffect(() => {
    if (!subject) return;
    if (!pinned && draft !== null) return;
    if (autoReadFor.current === subject) return;
    autoReadFor.current = subject;
    void look(subject);
  }, [subject, pinned, draft, look]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const valid = isSupportedHeatAddress(input);

  return (
    <div
      className={embedded ? '' : 'rounded-2xl p-5 md:p-6'}
      style={
        embedded
          ? undefined
          : {
              background: 'rgba(6,12,26,0.78)',
              border: '1px solid var(--color-purple-40)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
            }
      }
    >
      {!embedded && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
            <h2 className="heading-luxury text-xl text-white tracking-tight">Heat</h2>
            <span className="text-[10px] uppercase tracking-[0.16em] text-white/45">
              Jungle Bay Island · held time
            </span>
          </div>
          <p className="text-white/60 text-[12.5px] leading-relaxed mb-4 max-w-2xl">
            Heat measures <strong className="text-white/85">how much of a token you held, and for how long</strong>.
            It is not a Tegridy score and it pays nothing — it is the island&apos;s own instrument, read live.
            Price never enters it, a fresh bag starts near zero however big it is, and trading in and out earns nothing.
          </p>
        </>
      )}

      {/* The free-text instrument. Suppressed when the card is pinned to one wallet —
          the gate reads the connected wallet and nothing else. */}
      {!pinned && (
        <form
          className="flex flex-wrap gap-2 mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void look(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Wallet address to read Heat for (Ethereum or Solana)"
            placeholder="0x… or a Solana address"
            className="flex-1 min-w-0 sm:min-w-[280px] px-3 py-2 rounded-lg font-mono text-[12.5px] text-white outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
            style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-purple-40)' }}
          />
          <button
            type="submit"
            disabled={!valid || state.kind === 'loading'}
            className="btn-primary px-5 py-2 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed"
            title={valid ? 'Read this wallet' : 'Enter an Ethereum or Solana address'}
          >
            {state.kind === 'loading' ? 'Reading…' : 'Read Heat'}
          </button>
        </form>
      )}

      <AnimatePresence mode="wait">
        {state.kind === 'loading' && pinned && (
          <m.p
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-[12.5px] text-white/50 animate-pulse"
          >
            Reading the island&apos;s instrument…
          </m.p>
        )}

        {state.kind === 'error' && (
          <m.div
            key="err"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-lg p-3 text-[13px]"
            style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)', color: '#fca5a5' }}
          >
            {/* Deliberately NOT a zero reading. We could not ask; that is a different
                fact from a cold wallet, and collapsing the two would be a lie. */}
            {state.message}
          </m.div>
        )}

        {state.kind === 'ready' && (
          <m.div key={state.reading.address} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Reading
              reading={state.reading}
              now={now}
              showMath={showMath}
              onToggleMath={() => setShowMath((v) => !v)}
              showEligibility={showEligibility}
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Reading({
  reading,
  now,
  showMath,
  onToggleMath,
  showEligibility = true,
}: {
  reading: HeatReading;
  now: number;
  showMath: boolean;
  onToggleMath: () => void;
  showEligibility?: boolean;
}) {
  const stale = isStale(reading, now);
  const next = nextTier(reading.degrees);
  const color = TIER_COLOR[reading.tier];

  const rows = useMemo(
    () => [...reading.breakdown].sort((a, b) => b.degrees - a.degrees),
    [reading.breakdown],
  );
  const max = rows[0]?.degrees || 1;
  // The island states island_heat as the SUM of the rows. Recomputing it here is a
  // display-side CHECK, not a second source of truth — if they disagree we show
  // theirs and flag it, because the oracle is the ruler.
  const summed = rows.reduce((a, r) => a + r.degrees, 0);
  const mismatch = rows.length > 0 && Math.abs(summed - reading.degrees) > 0.05;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2 mb-4">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="stat-value text-[40px] leading-none" style={{ color }}>
              {reading.degrees.toFixed(2)}
            </span>
            <span className="text-[20px]" style={{ color }}>°</span>
          </div>
          <div className="text-[11px] uppercase tracking-[0.16em] mt-1" style={{ color }}>
            {reading.tier}
          </div>
        </div>

        <div className="text-[12px] text-white/55 leading-relaxed">
          <div className="font-mono text-white/70">{shortenAddress(reading.address, 6)}</div>
          <div>
            {reading.isCold
              ? 'No measured tokens held'
              : `${reading.tokenCount} measured token${reading.tokenCount === 1 ? '' : 's'}`}
            {reading.heldSinceUnix !== null && ` · held ${heldForLabel(reading.heldSinceUnix, now)}`}
          </div>
        </div>
      </div>

      {/* THE FRESHNESS LAW, on screen. Surfacing the reckoning date honestly is part
          of the instrument — not a footnote. */}
      <div
        className="rounded-lg px-3 py-2 mb-4 text-[11.5px] flex flex-wrap items-center gap-x-3 gap-y-1"
        style={{
          background: stale ? 'rgba(234,179,8,0.10)' : 'rgba(0,0,0,0.45)',
          border: `1px solid ${stale ? 'rgba(234,179,8,0.35)' : 'var(--color-purple-25)'}`,
          color: stale ? '#fbbf24' : 'rgba(255,255,255,0.55)',
        }}
      >
        <span>
          {reading.asOfUnix === null
            ? 'Reckoned: never — this wallet has no measured holdings'
            : `Reckoned ${agoLabel(reading.asOfUnix, now)}`}
        </span>
        {stale && <span className="font-semibold">Stale — older than 7 days, so it decides nothing</span>}
      </div>

      {/* LAUNCH ELIGIBILITY, from the same primitive the launch paths enforce with, so
          what a wallet is told here and what happens at submit cannot drift. */}
      {showEligibility && <Eligibility reading={reading} now={now} />}

      {next && !reading.isCold && (
        <div className="mb-4">
          <div className="flex justify-between text-[11px] text-white/50 mb-1">
            <span>Toward {next.tier}</span>
            <span>{next.remaining.toFixed(2)}° to go</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.10)' }}>
            <div
              className="h-full rounded-full transition-[width] duration-700"
              style={{ width: `${Math.min(100, (reading.degrees / next.floor) * 100)}%`, background: color }}
            />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-[0.16em] text-white/45 mb-2">
            Where the {reading.degrees.toFixed(2)}° comes from
          </div>
          <ul className="space-y-1.5 mb-2">
            {rows.map((r) => (
              <li key={`${r.chain}:${r.tokenAddress}`} className="flex items-center gap-2 text-[12.5px]">
                <span className="w-[86px] shrink-0 text-white/85 font-medium truncate" title={r.name}>
                  {r.symbol}
                </span>
                <span className="w-[62px] shrink-0 text-white/40 text-[10.5px] uppercase tracking-wider">
                  {r.chain}
                </span>
                <span className="flex-1 min-w-[40px] h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                  <span className="block h-full rounded-full" style={{ width: `${(r.degrees / max) * 100}%`, background: color, opacity: 0.75 }} />
                </span>
                <span className="w-[58px] shrink-0 text-right stat-value text-white/85">
                  {r.degrees.toFixed(2)}°
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-[12px] pt-2 mb-4" style={{ borderTop: '1px solid var(--color-purple-25)' }}>
            <span className="text-white/50">Sum across {rows.length} token{rows.length === 1 ? '' : 's'}</span>
            <span className="stat-value" style={{ color }}>{summed.toFixed(2)}°</span>
          </div>
          {mismatch && (
            <p className="text-[11px] mb-4" style={{ color: '#fbbf24' }}>
              These rows sum to {summed.toFixed(2)}°, but the island reports {reading.degrees.toFixed(2)}°.
              The island&apos;s number is the one that counts.
            </p>
          )}
        </>
      )}

      {reading.isCold && (
        <p className="text-white/55 text-[12.5px] leading-relaxed mb-4">
          This wallet holds none of the tokens the island measures, so it has no warmth yet.
          That is a cold reading, not an error — and it is not a judgement about the wallet.
          Heat only starts accruing once a measured token is held, and it accrues with time, not with size.
        </p>
      )}

      <button
        onClick={onToggleMath}
        aria-expanded={showMath}
        className="text-[12px] underline underline-offset-2 transition-colors"
        style={{ color: 'var(--color-kyle)' }}
      >
        {showMath ? 'Hide the maths' : 'How is this calculated?'}
      </button>

      {showMath && <Maths degrees={reading.degrees} />}
    </div>
  );
}

/**
 * The launch floor, on the card.
 *
 * Rendered from `gateDecision` — the SAME primitive the launch paths enforce with — so
 * what a wallet is told here and what happens at submit cannot drift. It reads DEGREES,
 * not tenure: held time is already priced inside the number (see LAUNCH_FLOOR).
 */
function Eligibility({ reading, now }: { reading: HeatReading; now: number }) {
  const floor = heatLaunchFloor();
  const d = gateDecision(reading.address, reading, now, floor, heatGateMaxAgeDays());
  const warm = d.state === 'WARM';
  const pct = Math.min(100, (reading.degrees / floor) * 100);

  return (
    <div
      className="rounded-lg px-3 py-2.5 mb-4"
      style={{
        background: warm ? 'rgba(76,175,80,0.10)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${warm ? 'var(--color-kyle-40)' : 'var(--color-purple-25)'}`,
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-1.5">
        <span className="text-[12.5px] font-semibold" style={{ color: warm ? 'var(--color-kyle)' : 'rgba(255,255,255,0.75)' }}>
          {warm ? '✓ Can launch a token here' : 'Cannot launch a token yet'}
        </span>
        {/* Tier word VERBATIM. "Residents may plant" is the door's own sentence. */}
        <span className="text-[11px] text-white/45">
          the door opens at {floor}° · Resident
        </span>
      </div>

      {d.state !== 'STALE' && (
        <div className="h-1 rounded-full overflow-hidden mb-1.5" style={{ background: 'rgba(255,255,255,0.10)' }}>
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{ width: `${pct}%`, background: warm ? 'var(--color-kyle)' : 'var(--color-purple-70)' }}
          />
        </div>
      )}

      <p className="text-[11.5px] text-white/55 leading-relaxed">{d.detail}</p>

      {/* The one thing this venue must never imply. Both rails sign client-side, so
          the door raises the floor on the path we control and proves nothing about
          the path we do not. */}
      {warm && (
        <p className="text-[10.5px] text-white/35 leading-relaxed mt-1.5">
          Read live from the island at the moment you launch, not stored here.
        </p>
      )}
    </div>
  );
}

function Maths({ degrees }: { degrees: number }) {
  const examples = [0.001, 0.005, 0.01, 0.02, 0.05];
  return (
    <div className="mt-3 rounded-xl p-4 text-[12.5px] leading-relaxed" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}>
      <p className="text-white/75 mb-3">
        For each measured token you hold, the island works out your{' '}
        <strong className="text-white">time-weighted average balance</strong> — your balance at every
        moment, not a snapshot — as a share of that token&apos;s total supply. It puts that share
        through one curve:
      </p>

      <div className="rounded-lg px-3 py-2.5 mb-3 font-mono text-[12px] overflow-x-auto" style={{ background: 'rgba(0,0,0,0.55)', color: 'var(--color-kyle)' }}>
        degrees = 100 × ( 1 − e<sup>−{HEAT_K} × share</sup> )
      </div>

      <p className="text-white/60 mb-3">
        Each token gives you between 0 and 100 degrees. Your total — <strong className="text-white/85">island heat</strong> — is
        those per-token numbers <strong className="text-white/85">added together</strong>, which is why the
        higher tiers need several tokens: one token alone can never exceed 100.
      </p>

      <div className="mb-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-white/45 mb-1.5">What the curve pays</div>
        <ul className="space-y-1">
          {examples.map((s) => (
            <li key={s} className="flex justify-between text-white/70 max-w-[300px]">
              <span>{(s * 100).toFixed(s < 0.01 ? 1 : 0)}% of supply, held throughout</span>
              <span className="stat-value">{(100 * (1 - Math.exp(-HEAT_K * s))).toFixed(1)}°</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mb-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-white/45 mb-1.5">The tiers, on your total</div>
        <ul className="space-y-1">
          {TIER_FLOORS.filter((t) => t.floor > 0).map((t) => (
            <li key={t.tier} className="flex items-baseline gap-2 text-white/70">
              <span className="w-[68px] shrink-0" style={{ color: TIER_COLOR[t.tier] }}>{t.tier}</span>
              <span className="w-[46px] shrink-0 stat-value">{t.floor}°</span>
              <span className="text-white/45 text-[11.5px]">{t.meaning}</span>
              {degrees >= t.floor && <span className="text-[10px]" style={{ color: TIER_COLOR[t.tier] }}>✓ reached</span>}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-white/50 text-[11.5px] mb-2">
        To reach {TIER_FLOORS.find((t) => t.tier === 'Observer')!.floor}° on a{' '}
        <em>single</em> token you would need about{' '}
        <strong className="text-white/75">{((shareForDegrees(30) ?? 0) * 100).toFixed(2)}% of its whole supply</strong>,
        held steadily rather than traded. Most wallets get there by holding several
        measured tokens instead.
      </p>

      <p className="text-white/50 text-[11.5px] mb-2">
        The island has published three properties of the instrument and no others: it is{' '}
        <strong className="text-white/75">continuous</strong> (your balance at every moment, not a
        snapshot), <strong className="text-white/75">zero-anchored</strong> (time before you first
        held counts as zero), and <strong className="text-white/75">velocity-blind</strong> (churn
        earns nothing). The period the average is taken over has not been published, so this page
        does not state one — and cannot reproduce the curve until it is.
      </p>

      <p className="text-white/40 text-[11px]">
        Three properties make it hard to fake: time before you first held counts as zero, so a new
        bag starts cold however large; churn earns nothing, only balance held across time; and price
        never enters the formula at all. Tegridy reads this number — the island computes it, and
        wherever the two disagree, the island is right.
      </p>
    </div>
  );
}
