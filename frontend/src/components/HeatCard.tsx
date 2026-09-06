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
import { Link } from 'react-router-dom';
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

/**
 * The days the ISLAND has measured: held_since_unix to as_of_unix.
 *
 * NOT to our clock. The span between the island's last reckoning and this moment is
 * time the island has not counted yet, and quietly adding it would make the venue
 * state a number the oracle never served — the one thing §5 forbids. It also keeps
 * the figure stable: two people reading the same wallet an hour apart see the same
 * day count, because both are reading the same reckoning.
 *
 * Days are the unit a stranger can compare without being taught anything; degrees are
 * the island's grammar. Both render, and this is the one that leads.
 */
function daysHeld(heldSinceUnix: number | null, asOfUnix: number | null): number | null {
  if (heldSinceUnix === null || asOfUnix === null) return null;
  return Math.max(0, Math.floor((asOfUnix - heldSinceUnix) / DAY));
}

/** "on the island since <month year>". UTC so the month cannot shift by viewer. */
function sinceLabel(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The short date the delta is measured from. UTC, same reason. */
function deltaDateLabel(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ── The delta ───────────────────────────────────────────────────────────────
// "+2.3° since Sep 3" is ARITHMETIC ON TWO SERVED NUMBERS, and nothing more. It is
// not a projection, not a rate, and not a trend: it is this reckoning's degrees minus
// the last reckoning's degrees, labelled with the date it is measured from. Cleared
// storage prints nothing, because with no prior read there is nothing true to say.
const DELTA_STORE_KEY = 'tf_heat_last_read';
const DELTA_STORE_CAP = 24;

interface LastRead {
  degrees: number;
  asOf: number | null;
}

function readDeltaStore(): Record<string, LastRead> {
  try {
    const raw = localStorage.getItem(DELTA_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LastRead>) : {};
  } catch {
    // Private mode, disabled storage, or a corrupt blob. No prior read is a valid
    // state that renders nothing — never an error the visitor has to read.
    return {};
  }
}

function rememberRead(address: string, entry: LastRead): void {
  try {
    const store = readDeltaStore();
    store[address.toLowerCase()] = entry;
    // Bounded: an instrument anyone can point at any wallet would otherwise grow this
    // blob without limit. Oldest keys drop first; losing one only costs a delta line.
    const keys = Object.keys(store);
    if (keys.length > DELTA_STORE_CAP) {
      for (const k of keys.slice(0, keys.length - DELTA_STORE_CAP)) delete store[k];
    }
    localStorage.setItem(DELTA_STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — the delta is a nicety, never a blocker */
  }
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
            It is not a venue score and it pays nothing — it is the island&apos;s own instrument, read live.
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
  const days = daysHeld(reading.heldSinceUnix, reading.asOfUnix);

  // The delta is DERIVED from the reading, not a second fact about it, so it is
  // computed during render rather than pushed into state by an effect. This also
  // fixes the ordering for free: the memo reads the PREVIOUS entry while rendering,
  // and the effect below writes THIS one afterwards — so the first read of an address
  // prints nothing and the second prints the change. A cold read never compares:
  // there is no number to have moved.
  const delta = useMemo(() => {
    if (reading.isCold) return null;
    const prior = readDeltaStore()[reading.address.toLowerCase()];
    if (!prior || typeof prior.degrees !== 'number' || typeof prior.asOf !== 'number') return null;
    const diff = reading.degrees - prior.degrees;
    const from = deltaDateLabel(prior.asOf);
    return Math.abs(diff) < 0.05
      ? { text: `unchanged since ${from}`, rose: false }
      : { text: `${diff > 0 ? '+' : '-'}${Math.abs(diff).toFixed(1)}° since ${from}`, rose: diff > 0 };
  }, [reading.address, reading.degrees, reading.isCold]);

  // Remember this reading, after the delta above has read the previous one.
  useEffect(() => {
    if (reading.isCold) return;
    rememberRead(reading.address, { degrees: reading.degrees, asOf: reading.asOfUnix });
  }, [reading.address, reading.degrees, reading.asOfUnix, reading.isCold]);

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
      {/* THE ISLAND'S ORDER, and it is the design rather than a layout preference:
          tier, then days, then degrees, then since, then tokens.

          The TIER leads because it is a word a stranger already understands. The DAYS
          lead the numbers because days are the unit the whole world can compare
          without being taught anything — degrees are the island's grammar, and they
          come second so nobody has to learn a new unit to feel the number. Both
          render; neither is dropped. */}
      <div className="mb-4">
        <div
          className="text-[22px] leading-none tracking-[0.10em] uppercase font-semibold"
          style={{ color }}
        >
          {reading.tier}
        </div>

        {days !== null && (
          <div className="flex items-baseline gap-2 mt-2">
            <span className="stat-value text-[40px] leading-none" style={{ color }}>
              {days.toLocaleString('en-US')}
            </span>
            <span className="text-[15px] text-white/70">days held</span>
          </div>
        )}

        <div className="flex items-baseline gap-1 mt-2">
          <span className="stat-value text-[20px] leading-none" style={{ color }}>
            {reading.degrees.toFixed(2)}
          </span>
          <span className="text-[13px]" style={{ color }}>°</span>
        </div>

        <div className="text-[12px] text-white/55 leading-relaxed mt-2">
          {reading.heldSinceUnix !== null && (
            <div>on the island since {sinceLabel(reading.heldSinceUnix)}</div>
          )}
          <div>
            {reading.isCold
              ? 'No measured tokens held'
              : `${reading.tokenCount} token${reading.tokenCount === 1 ? '' : 's'} counted`}
          </div>
          <div className="font-mono text-white/40 mt-1">{shortenAddress(reading.address, 6)}</div>
        </div>

        {/* THE DELTA. Two served numbers subtracted, labelled with the date it is
            measured from. Never a projection, never a rate, and absent entirely when
            there is no prior read to compare against. */}
        {delta && (
          <div className="text-[12.5px] mt-2" style={{ color: delta.rose ? color : 'rgba(255,255,255,0.55)' }}>
            {delta.text}
          </div>
        )}
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

      {/* THE NAME, OR THE DOOR. A number nobody can see is a private fact; a number
          with a name on it is a place in public. `xHandle` arrives already stripped and
          validated (normalizeXHandle), so painting adds the single @ and the href can
          never be anything but an x.com profile. An unnamed flame gets the door, not an
          apology. Cold reads get neither: they have no flame yet. */}
      {!reading.isCold && (
        <div className="text-[12.5px] leading-relaxed mb-4">
          {reading.xHandle ? (
            <>
              <a
                href={`https://x.com/${reading.xHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 font-medium"
                style={{ color }}
              >
                @{reading.xHandle}
              </a>
              <span className="text-white/55">
                {' · '}
                <a
                  href="https://memetics.wtf/flames"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  On the board.
                </a>
              </span>
            </>
          ) : (
            <span className="text-white/55">
              No name on this flame yet.{' '}
              <a
                href="https://memetics.wtf/register"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
                style={{ color: 'var(--color-kyle)' }}
              >
                Put yours on it
              </a>
            </span>
          )}
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

      {/* THE COLD READ is the most important copy on the site. A stranger who reads 0°
          must not be shamed and must not be left standing there: the sentence says
          where their clock STARTS, and the only thing under it is the door that starts
          it. No ladder (suppressed above), no delta, no share. Nothing to feel behind
          on, and exactly one thing to do. */}
      {reading.isCold && (
        <div className="mb-4">
          <p className="text-white/70 text-[13px] leading-relaxed">
            Cold. Nothing measured here yet. Your clock starts at your first buy of an
            island token and never stops while you hold.
          </p>
          <Link
            to="/#hall"
            className="inline-block mt-2 text-[13px] underline underline-offset-4"
            style={{ color: 'var(--color-kyle)' }}
          >
            Pick a bungalow
          </Link>
        </div>
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
        never enters the formula at all. The venue reads this number — the island computes it, and
        wherever the two disagree, the island is right.
      </p>
    </div>
  );
}
