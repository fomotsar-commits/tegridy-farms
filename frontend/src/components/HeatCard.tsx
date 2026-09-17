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

import { daysHeld } from '../lib/heat/daysHeld';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { fetchHeat, isSupportedHeatAddress, HeatUnavailableError } from '../lib/heat/heatClient';
import {
  isStale,
  nextTier,
  tierFor,
  tierAtFloor,
  gateDecision,
  TIER_FLOORS,
  type HeatReading,
  type HeatTier,
} from '../lib/heat/heatOracle';
import { fetchFlames, insertionRank } from '../lib/heat/flamesClient';
import { heatLaunchFloor, heatGateMaxAgeDays } from '../lib/heat/heatGateConfig';
import { shortenAddress } from '../lib/formatting';
import { heatExampleLine } from '../lib/arrival';
import { hasInjectedWallet, readInjectedAddress } from '../lib/heat/walletFill';
import { SITE_URL } from '../lib/constants';

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
   * Seed the lookup field and read it on mount, WITHOUT hiding the form.
   *
   * This is how a shared link arrives: `/read/<address>` and `/?heat=<address>` both
   * land here, so the reader sees the number they were shown rather than an empty
   * field they have to be told about. Distinct from `address` on purpose — `address`
   * pins the card to one wallet and removes the form, which is right for the gate and
   * wrong for a share, where the next thing a stranger does is read their own.
   */
  initialAddress?: string | null;
  /**
   * Put a value in the field WITHOUT reading it: what a visitor typed and did not
   * submit before this card existed (the venue's first frame, answer ten). It counts
   * as typed, so it suspends the auto-read exactly as typing does; a draft equal to
   * `initialAddress` (an untouched ?heat= prefill) does not.
   */
  initialDraft?: string | null;
  /** Take focus on mount: the field this card replaced had it. */
  focusField?: boolean;
  /**
   * Drop the outer panel chrome and the explainer paragraph, for embedding inside a
   * surface that has already introduced itself (the gate). The READING is unchanged:
   * degrees, tier word, held-since, reckoning date and the per-token breakdown all
   * still render. Nothing that constitutes the judgment is ever hidden by a variant.
   */
  variant?: 'panel' | 'embedded';
  /** Hide the launch-floor line, for surfaces where launching is not the subject. */
  showEligibility?: boolean;
  /**
   * READ THE SAME WALLET, BUT ANSWER ONE TOKEN'S QUESTION (wave seven, element D).
   *
   * A bungalow room asks something narrower than the venue does: not "what is
   * this wallet's whole flame", but "what is this visitor's held time HERE".
   * The reading is identical — same address, same fetch, same freshness, same
   * failure sentences — so this is a presentation of it, not a second source.
   * The directive's own words are "the instrument, element B, scoped".
   *
   * Everything that decides anything is untouched: the form, the loading arm,
   * and the error arm all render exactly as they do on the venue, because an
   * unreadable instrument in a room must fail the same way it fails anywhere
   * else and must never read as a zero.
   */
  scopeTo?: { address: string; symbol: string };
}

export function HeatCard({
  address: pinned,
  initialAddress = null,
  initialDraft = null,
  focusField = false,
  variant = 'panel',
  showEligibility = true,
  scopeTo,
}: HeatCardProps = {}) {
  const { address: connected } = useAccount();
  const embedded = variant === 'embedded';
  // `draft` is null until the user types. The field's value is DERIVED from that plus
  // the connected wallet, rather than mirrored into state by an effect — so connecting,
  // switching accounts, or disconnecting needs no state sync and cannot desync.
  // Seeded from `initialAddress` so a shared link arrives already reading. The field
  // stays EDITABLE (unlike `pinned`) — someone who followed a stranger's number should
  // be one paste away from their own.
  const [draft, setDraft] = useState<string | null>(initialDraft ?? initialAddress);
  const subject = pinned ?? initialAddress ?? connected ?? '';
  const input = pinned ?? draft ?? connected ?? '';
  const [state, setState] = useState<State>({ kind: 'idle' });
  // WALLET FILL (element B). `canFill` is read once per mount rather than on
  // every render: an extension that injects late is caught by the next mount,
  // and a button that appears mid-interaction under the visitor's finger is
  // worse than one that arrives a navigation later.
  const [canFill] = useState(() => hasInjectedWallet());
  const [fillFailed, setFillFailed] = useState(false);
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
    // A user-typed draft suspends the auto-read; the SEEDED one does not, or a shared
    // link would arrive with the address in the field and nothing read.
    if (!pinned && draft !== null && draft !== initialAddress) return;
    if (autoReadFor.current === subject) return;
    autoReadFor.current = subject;
    void look(subject);
  }, [subject, pinned, draft, initialAddress, look]);

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
      {/* THE ROOM'S HEADING, and it has to sit OUTSIDE the ready state.
          `embedded` deliberately drops the card's own title, which is right in
          the gate (the gate introduces itself). In a room it left a cold
          visitor looking at a bare address field and a Read button with
          nothing saying what it reads — the question only appeared once the
          answer did. */}
      {scopeTo && (
        <div className="mb-3">
          <p className="text-[11px] uppercase tracking-[0.16em] text-white/55">
            Your held time in {scopeTo.symbol}
          </p>
          <p className="text-white/55 text-[12px] mt-0.5">
            Read any wallet. Held time is the island's, not this room's: the
            same number the venue reads, answered for {scopeTo.symbol}.
          </p>
        </div>
      )}

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
            autoFocus={focusField}
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
          {/* THE WALLET FILL (element B). Shown only when something in the
              browser can answer, so a visitor without a wallet is never offered
              a button that cannot work. type="button": it must not submit the
              form, and it never reads the chain or asks for a signature -
              lib/heat/walletFill.ts says exactly what it does ask for. */}
          {canFill && (
            <button
              type="button"
              onClick={() => {
                setFillFailed(false);
                void readInjectedAddress().then((addr) => {
                  if (addr) setDraft(addr);
                  else setFillFailed(true);
                });
              }}
              className="px-3 py-2 rounded-lg text-[12px] text-white/80 hover:text-white transition-colors"
              style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}
            >
              Use my wallet
            </button>
          )}
          {/* One sentence, and nothing else: no error code, no retry, no reason.
              A locked wallet, a declined prompt and an untrusted origin are the
              same thing to the visitor - the field still takes a paste. */}
          {fillFailed && (
            <p className="w-full text-[12px] text-white/60">Paste the address instead.</p>
          )}
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
            {scopeTo ? (
              <ScopedReading reading={state.reading} scopeTo={scopeTo} />
            ) : (
              <Reading
                reading={state.reading}
                now={now}
                showMath={showMath}
                onToggleMath={() => setShowMath((v) => !v)}
                showEligibility={showEligibility}
              />
            )}
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

  // The post, built from served numbers only. SITE_URL rather than a literal host, so
  // the link cannot drift from the venue's own canonical origin.
  const shareIntent = useMemo(() => {
    const text =
      `${reading.tier}. ${days} days held. ${reading.degrees.toFixed(1)}° on Jungle Bay ` +
      `Island's instrument. Held time counts here. ${SITE_URL}/read/${reading.address}`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }, [reading.tier, reading.degrees, reading.address, days]);

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

  // WHERE THIS NUMBER WOULD SIT. Only for an UNNAMED flame, because a named one is
  // already on the board and its real position is the island's to state, not ours to
  // simulate. This is the line that turns a private number into a public place, and
  // the place is claimed at the island's door.
  //
  // The result is tagged with the address it was computed for, so a rank can never be
  // painted beside a different wallet's reading while the next board read is in
  // flight, and nothing has to be synchronously cleared on the way through.
  const [rank, setRank] = useState<{ forAddress: string; rank: number; of: number } | null>(null);
  useEffect(() => {
    if (reading.isCold || reading.xHandle) return;
    const ac = new AbortController();
    let live = true;
    // limit=500 and NOT claimed: the rank is against the whole board, named or not.
    // flamesClient caches for five minutes, so a page carrying both the card and the
    // board costs one read between them.
    fetchFlames({ limit: 500, signal: ac.signal })
      .then((board) => {
        if (!live || !board) return; // board off: the line is simply absent
        const r = insertionRank(reading.degrees, board.flames);
        setRank({ forAddress: reading.address, ...r });
      })
      .catch(() => {
        /* unreachable: absent, never a fabricated position */
      });
    return () => {
      live = false;
      ac.abort();
    };
  }, [reading.address, reading.degrees, reading.isCold, reading.xHandle]);

  // WAVE SEVEN, row R: A RETIRED ROW IS LABELED, NOT COUNTED, NOT SUMMED.
  // The island sets `retired: true` on a mint it no longer scans (a migrated or
  // scrapped token's history). Those rows sort after the live ones, render
  // greyed with the word, and stay out of both the token count and the sum line
  // below. Their own degrees are still printed: that number is the island's,
  // painted as served.
  const rows = useMemo(
    () =>
      [...reading.breakdown].sort(
        (a, b) => Number(a.retired) - Number(b.retired) || b.degrees - a.degrees,
      ),
    [reading.breakdown],
  );
  const liveRows = rows.filter((r) => !r.retired);
  const retiredCount = rows.length - liveRows.length;
  const max = liveRows[0]?.degrees || 1;
  // The island states island_heat as the SUM of its rows, and its number is the
  // ruler: it is painted as served and never replaced. The sum line prints the
  // LIVE rows only, and what follows only decides which true sentence to print
  // under it.
  const summed = liveRows.reduce((a, r) => a + r.degrees, 0);
  const matchesLive = Math.abs(summed - reading.degrees) <= 0.05;
  // THE ISLAND'S DROP LANDED 2026-09-16, and this stays anyway, as the guard for
  // the next retirement. Measured through our own proxy that day: the envelope
  // serves 10 rows, none retired, degrees 1341.7, and the rows sum to 1341.7 -
  // so matchesLive is true and nothing below it renders.
  //
  // While a retired row DOES arrive inside the total (as it did for months), its
  // sum is not a mismatch and must not be flagged as one, or every holder of a
  // retired token is told the island disagrees with itself. So the envelope is
  // added up once, here, only to tell those two cases apart, and never printed.
  const matchesEnvelope =
    Math.abs(rows.reduce((a, r) => a + r.degrees, 0) - reading.degrees) <= 0.05;
  const includesRetired = retiredCount > 0 && !matchesLive && matchesEnvelope;
  const mismatch = rows.length > 0 && !matchesLive && !includesRetired;
  // The count under the number. token_count equalled the row count on the live
  // 18-row read, retired rows included, so the retired rows come off it. With
  // the drop landed retiredCount is 0 and this IS token_count, which the same
  // proxy read confirms: 10 rows, token_count 10.
  const countedTokens = Math.max(0, reading.tokenCount - retiredCount);

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
              : `${countedTokens} token${countedTokens === 1 ? '' : 's'} counted`}
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

      {/* THE LADDER (element B). It replaces the single "Toward <tier>" bar that
          stood here: the bar showed one rung and the ladder shows all five, and
          carries the same arithmetic under the next one. Two surfaces for one
          fact is how they drift. Suppressed on a cold read, with the delta and
          the share, by the island's own rule: nothing to feel behind. */}
      {!reading.isCold && <TierLadder degrees={reading.degrees} next={next} />}

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
            <>
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

              {/* Arithmetic on served numbers, and said so. Absent entirely when the
                  board is off or unreadable: a position we could not compute is never
                  guessed at. */}
              {rank && rank.forAddress === reading.address && (
                <div className="text-white/45 mt-1">
                  Against the island&apos;s board right now, this wallet&apos;s number would
                  sit at #{rank.rank} of {rank.of}.
                </div>
              )}
            </>
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
              <li
                key={`${r.chain}:${r.tokenAddress}`}
                className="flex items-center gap-2 text-[12.5px]"
                data-retired={r.retired ? 'true' : undefined}
              >
                <span
                  className={`w-[86px] shrink-0 font-medium truncate ${r.retired ? 'text-white/40' : 'text-white/85'}`}
                  title={r.name}
                >
                  {r.symbol}
                </span>
                <span className="w-[62px] shrink-0 text-white/40 text-[10.5px] uppercase tracking-wider">
                  {r.chain}
                </span>
                {r.retired ? (
                  <span className="flex-1 min-w-[40px] text-white/40 text-[11px]" title="The island no longer scans this token.">
                    retired
                  </span>
                ) : (
                  <span className="flex-1 min-w-[40px] h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <span className="block h-full rounded-full" style={{ width: `${(r.degrees / max) * 100}%`, background: color, opacity: 0.75 }} />
                  </span>
                )}
                <span className={`w-[58px] shrink-0 text-right stat-value ${r.retired ? 'text-white/40' : 'text-white/85'}`}>
                  {r.degrees.toFixed(2)}°
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-[12px] pt-2 mb-4" style={{ borderTop: '1px solid var(--color-purple-25)' }}>
            <span className="text-white/50">Sum across {liveRows.length} token{liveRows.length === 1 ? '' : 's'}</span>
            <span className="stat-value" style={{ color }}>{summed.toFixed(2)}°</span>
          </div>
          {mismatch && (
            <p className="text-[11px] mb-4" style={{ color: '#fbbf24' }}>
              These rows sum to {summed.toFixed(2)}°, but the island reports {reading.degrees.toFixed(2)}°.
              The island&apos;s number is the one that counts.
            </p>
          )}
          {includesRetired && (
            <p className="text-[11px] text-white/50 mb-4">
              The island&apos;s {reading.degrees.toFixed(2)}&deg; still includes the retired {retiredCount === 1 ? 'row' : 'rows'}.
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

      {/* THE SHARE. One button, under a WARM read only: a cold wallet has nothing to
          post and asking it to would be the one moment this instrument shames someone.
          The tier and the days lead the text because they are legible to a stranger who
          has never heard of a degree; the number rides in the sentence; and the single
          link is element M's read link, which unfurls as this holder's own card. The
          holder chose to post their address, so nothing here is published on their
          behalf — this only opens the composer. */}
      {!reading.isCold && days !== null && (
        <a
          href={shareIntent}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mb-4 px-5 py-2 text-[13px] font-semibold rounded-lg transition-all hover:brightness-110"
          style={{ background: 'rgba(0,0,0,0.72)', border: `1px solid ${color}`, color }}
        >
          Post my number
        </a>
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
/**
 * THE ROOM'S OWN READ — wave seven, element D.
 *
 * Two lines, in the order the directive sets: the row for THIS room's contract
 * first, the whole flame second. The scoped number leads because it is the
 * question the room asks; the flame follows so the visitor is never shown a
 * small number without being told it is one token's share of a bigger one.
 *
 * MATCHED BY CONTRACT, CASE-INSENSITIVELY, and that is not a nicety: the
 * registry stores EVM addresses lowercase and Solana mints in base58 with real
 * capitals, while the island echoes back whatever it holds. A case-sensitive
 * compare would silently find no row for every Solana room and print "holds no
 * measured BAYLA yet" to somebody holding plenty.
 *
 * A RETIRED ROW IS GREYED AND LABELED (row R). The island answered what the
 * word means: a mint it no longer scans, a migrated or scrapped token's
 * history. The row's own degrees stay on screen because they are the island's
 * number, painted as served; the whole-flame line under it is the island's
 * total, never a venue sum.
 */
function ScopedReading({
  reading,
  scopeTo,
}: {
  reading: HeatReading;
  scopeTo: { address: string; symbol: string };
}) {
  const want = scopeTo.address.trim().toLowerCase();
  const row = reading.breakdown.find((r) => r.tokenAddress.trim().toLowerCase() === want) ?? null;
  const days = row?.firstSeenAtUnix != null ? daysHeld(row.firstSeenAtUnix, reading.asOfUnix) : null;
  const rowColor = row?.retired ? 'rgba(255,255,255,0.45)' : TIER_COLOR[reading.tier];

  return (
    <div>
      {row ? (
        <div className="mb-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="stat-value text-[26px] leading-none" style={{ color: rowColor }}>
              {row.degrees.toFixed(2)}
            </span>
            <span className="text-[15px]" style={{ color: rowColor }}>&deg;</span>
            {row.retired && (
              <span className="text-[12px] text-white/45" title="The island no longer scans this token.">
                retired
              </span>
            )}
          </div>
          {days !== null && (
            <p className="text-white/80 text-[13px] mt-1">
              {days.toLocaleString('en-US')} {days === 1 ? 'day' : 'days'} held
              {row.firstSeenAtUnix != null && <> &middot; since {sinceLabel(row.firstSeenAtUnix)}</>}
            </p>
          )}
        </div>
      ) : (
        <p className="text-white/80 text-[13px] mb-3">
          This wallet holds no measured {scopeTo.symbol} yet.
        </p>
      )}

      <p className="text-white/60 text-[12px]">
        your whole flame reads {reading.degrees.toFixed(2)}&deg; {reading.tier}
      </p>
    </div>
  );
}

/**
 * WAVE SEVEN, element B: THE LADDER, FIVE RUNGS, FROM THE ISLAND'S OWN DIALS.
 *
 * Drifter 0 - Observer 30 - Resident 80 - Builder 150 - Elder 250, read from
 * TIER_FLOORS rather than typed, so a dial the island moves moves this. FIVE
 * rungs, not the four the explainer fold shows: that one drops Drifter because
 * 0 is not a threshold to aim at, but a ladder is where you are STANDING, and a
 * warm wallet below 30 stands on Drifter. Hiding the rung under someone's feet
 * is how a ladder starts lying about where they are.
 *
 * REACHED RUNGS ARE LIT, and under the next one, one line of arithmetic on two
 * served numbers: the rung's floor minus the degrees the island served. No
 * projection, no date, no rate - the instrument never computes a degree.
 *
 * THE LAUNCH FLOOR'S RUNG CARRIES ITS OWN SENTENCE, and the number in it is READ
 * at render time from heatLaunchFloor(), the same helper the launch gate
 * enforces with. Typing 80 would make this line disagree with the gate the day
 * an operator sets VITE_HEAT_LAUNCH_FLOOR.
 *
 * BOTH DIALS ARE CANONICAL (answer ten, ruling 4), which settles the drift this
 * comment used to name. TIER_FLOORS is the island's standard: what tier a number
 * is. heatLaunchFloor() is the venue's policy: what number opens the launch door.
 * Neither answers the other's question, so neither yields. The defect was the
 * word "Resident", TYPED beside a number that was read. So the sentence hangs
 * under the rung tierFor(floor) returns, and names a tier only when
 * tierAtFloor(floor) finds the floor exactly on one: 150 says Builder under
 * Builder, 123 names nothing under Resident.
 */
function TierLadder({ degrees, next }: { degrees: number; next: ReturnType<typeof nextTier> }) {
  const launchFloor = heatLaunchFloor();
  const launchRung = tierFor(launchFloor);
  const launchTier = tierAtFloor(launchFloor);
  // TIER_FLOORS is published high-to-low; a ladder is climbed low-to-high.
  const rungs = [...TIER_FLOORS].reverse();
  return (
    <div className="mb-4" data-element="b-ladder">
      <div className="text-[11px] uppercase tracking-[0.16em] text-white/45 mb-1.5">The ladder</div>
      <ul className="space-y-1.5">
        {rungs.map((rung) => {
          const reached = degrees >= rung.floor;
          const isNext = next !== null && next.tier === rung.tier;
          const dim = reached ? undefined : 'rgba(255,255,255,0.35)';
          return (
            <li key={rung.tier}>
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="w-[68px] shrink-0" style={{ color: reached ? TIER_COLOR[rung.tier] : dim }}>
                  {rung.tier}
                </span>
                <span className="w-[46px] shrink-0 stat-value" style={{ color: dim }}>{rung.floor}&deg;</span>
                {reached && (
                  <span className="text-[10px]" style={{ color: TIER_COLOR[rung.tier] }}>&#10003; reached</span>
                )}
              </div>
              {isNext && (
                <p className="text-[11.5px] text-white/65 mt-0.5 ml-[76px]">
                  {(rung.floor - degrees).toFixed(2)}&deg; to {rung.tier}
                </p>
              )}
              {rung.tier === launchRung && (
                <p className="text-[11.5px] mt-0.5 ml-[76px]" style={{ color: 'var(--color-kyle)' }}>
                  {heatExampleLine(launchFloor, launchTier)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Eligibility({ reading, now }: { reading: HeatReading; now: number }) {
  const floor = heatLaunchFloor();
  const floorTier = tierAtFloor(floor);
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
        {/* The tier is named only when the floor sits exactly on its rung
            (answer ten, ruling 4). Between rungs the number stands alone,
            because no tier opens a door at 123. */}
        <span className="text-[11px] text-white/45">
          the door opens at {floor}°{floorTier ? ` · ${floorTier}` : ''}
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
  return (
    <div className="mt-3 rounded-xl p-4 text-[12.5px] leading-relaxed" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}>
      {/* WAVE SEVEN, element K: THE WHOLE LAW, AS THE ISLAND PUBLISHES IT.
          This block taught the SIZE TERM as if it were the entire formula, and
          then did arithmetic on it: a what-the-curve-pays table and a
          single-token share needed for Observer. Under weight and loyalty
          neither of those is anybody's number, so both are retired rather than
          corrected. The oracle's served figure is the only complete truth, and
          the venue quotes the law rather than reproducing it. */}
      <p className="text-white/75 mb-3">
        The island measures one thing: <strong className="text-white">held time</strong>. Your heat
        is read per token and summed across everything you hold, and each token&apos;s number is
        built from three published terms:
      </p>

      <div className="rounded-lg px-3 py-2.5 mb-3 font-mono text-[12px] overflow-x-auto" style={{ background: 'rgba(0,0,0,0.55)', color: 'var(--color-kyle)' }}>
        heat = weight × ( size + loyalty )
      </div>

      <ul className="space-y-1.5 mb-3 text-white/70">
        <li>
          <strong className="text-white/85">Size</strong> is the share curve: your time-weighted
          average balance as a share of that token&apos;s supply.{' '}
          <span className="text-white/50">
            TWAB is your balance at every moment rather than a snapshot.
          </span>
        </li>
        <li>
          <strong className="text-white/85">Loyalty</strong> is held days and nothing else.{' '}
          <span className="text-white/50">It anchors to your first hold and only climbs.</span>
        </li>
        <li>
          <strong className="text-white/85">Weight</strong> is the island&apos;s published
          multiplier.{' '}
          <span className="text-white/50">
            The Apes carry triple weight, JBM and BAYLA carry their edge, the home team leans warm,
            and every measured token counts.
          </span>
        </li>
      </ul>

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
        The instrument is{' '}
        <strong className="text-white/75">continuous</strong> (your balance at every moment, not a
        snapshot), <strong className="text-white/75">zero-anchored</strong> (time before you first
        held counts as zero), and <strong className="text-white/75">velocity-blind</strong> (churn
        earns nothing). The average is taken over{' '}
        <strong className="text-white/75">your whole held time</strong>, which is the island&apos;s
        own grammar for it: earned in days of staying, never in a single trade.
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
