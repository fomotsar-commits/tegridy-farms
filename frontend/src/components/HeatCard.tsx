// Heat: Jungle Bay Island's held-time reading for a wallet, and how it is read.
// The island measures, and the panel says so. Tier words render verbatim, never as yield
// or points. The reckoning date is always on screen, and a stale reading says so.
// "The instrument is unreachable" and "this wallet is cold" are different states with
// different copy: an outage never renders as a zero.

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
  tierAbove,
  gateDecision,
  TIER_FLOORS,
  type HeatReading,
  type HeatTier,
} from '../lib/heat/heatOracle';
import { fetchFlames, insertionRank } from '../lib/heat/flamesClient';
import { roomRankLine } from '../lib/heat/roomRank';
import { heatLaunchFloor, heatGateMaxAgeDays } from '../lib/heat/heatGateConfig';
import { shortenAddress } from '../lib/formatting';
import { heatExampleLine, VENUE } from '../lib/arrival';
import { injectedNetworks, readInjectedAddress, type FillNetwork } from '../lib/heat/walletFill';
import { useSolanaSurface } from '../lib/solanaSurface';
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

/** "Resident in 14 days.": the island's served days toward the tier above the served
 *  word. Absent until the island serves the field, at Elder, and on the day itself. */
function nextTierLine(reading: HeatReading): string | null {
  const days = reading.daysToNextTier;
  const above = tierAbove(reading.tier);
  if (days === null || days < 1 || above === null) return null;
  return `${above} in ${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}.`;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; reading: HeatReading };

export interface HeatCardProps {
  /** Read THIS wallet and hide the lookup form: the gate's COLD state shows the connected
   *  wallet its own reading, with the same copy and tier words as everywhere else. */
  address?: string;
  /** Seed the lookup field and read it on mount, keeping the form: how a shared link
   *  (`/read/<address>`, `/?heat=<address>`) arrives already reading, one paste from the
   *  reader's own. `address` instead pins one wallet and removes the form. */
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
  /** Answer one token's question from the same reading: a room shows its own row, then the
   *  whole flame. Same address, fetch, freshness and failure sentences; the form, loading
   *  and error arms render as they do on the venue, so an unreadable instrument in a room
   *  never reads as a zero. */
  scopeTo?: { address: string; symbol: string };
  /** The one network the wallet fill may read, for a page that is about one network
   *  (the Solana launch door). Without it the card offers every network it can read. */
  fillFrom?: FillNetwork;
}

const FILL_LABEL: Record<FillNetwork, string> = {
  ethereum: 'Use my Ethereum address',
  solana: 'Use my Solana address',
};

export function HeatCard({
  address: pinned,
  initialAddress = null,
  initialDraft = null,
  focusField = false,
  variant = 'panel',
  showEligibility = true,
  scopeTo,
  fillFrom,
}: HeatCardProps = {}) {
  const { address: connected } = useAccount();
  const solanaConnected = useSolanaSurface().surface?.address ?? null;
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
  // WALLET FILL: the networks the fill can read now. The page's own if it names one. Else
  // a Solana wallet connected to the site, with no Ethereum account connected, is the
  // visitor's wallet. Else every network that can answer: the card never picks Ethereum
  // for a visitor who also carries Solana.
  const fillNetworks = (): FillNetwork[] => {
    const injected = injectedNetworks();
    const can = { ethereum: injected.ethereum, solana: injected.solana || solanaConnected !== null };
    const asked: FillNetwork[] = fillFrom
      ? [fillFrom]
      : solanaConnected !== null && !connected
        ? ['solana']
        : ['ethereum', 'solana'];
    return asked.filter((network) => can[network]);
  };
  // The buttons are settled once per mount: a label that changes under the visitor's
  // finger is worse than a button that arrives a navigation later.
  const [fillOffers, setFillOffers] = useState(fillNetworks);
  const [fillFailed, setFillFailed] = useState(false);
  // A wallet can answer long after it was asked (its prompt stays open). Its answer is
  // dropped once the field has been written since, by typing or by another fill.
  const fieldWrites = useRef(0);
  const fill = (offered: FillNetwork) => {
    let network = offered;
    if (fillOffers.length === 1) {
      // The lone button says "my wallet": which one is settled at the press. When two
      // can answer by then, the visitor picks: the buttons are named and nothing is asked.
      const now = fillNetworks();
      if (now.length > 1) {
        setFillOffers(now);
        return;
      }
      network = now[0] ?? offered;
    }
    setFillFailed(false);
    if (network === 'solana' && solanaConnected) {
      fieldWrites.current += 1;
      setDraft(solanaConnected);
      return;
    }
    const writesAtPress = fieldWrites.current;
    void readInjectedAddress(network).then((addr) => {
      if (fieldWrites.current !== writesAtPress) return;
      if (!addr) {
        setFillFailed(true);
        return;
      }
      fieldWrites.current += 1;
      setDraft(addr);
      setFillFailed(false);
    });
  };
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
            {VENUE.heatPlain} It is not a venue score and it pays nothing: it is the island&apos;s own
            instrument, read live. Price never enters it, a fresh bag starts near zero however big it is,
            and trading in and out earns nothing.
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
            onChange={(e) => {
              fieldWrites.current += 1;
              setDraft(e.target.value);
            }}
            autoFocus={focusField}
            spellCheck={false}
            autoComplete="off"
            aria-label="Wallet address to read Heat for (Ethereum, Base, or Solana)"
            placeholder="0x… or a Solana address"
            className="flex-1 min-w-0 sm:min-w-[280px] px-3 py-2 rounded-lg font-mono text-[12.5px] text-white outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
            style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid var(--color-purple-40)' }}
          />
          <button
            type="submit"
            disabled={!valid || state.kind === 'loading'}
            className="btn-primary px-5 py-2 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed"
            title={valid ? 'Read this wallet' : 'Enter an Ethereum, Base, or Solana address'}
          >
            {state.kind === 'loading' ? 'Reading…' : 'Read Heat'}
          </button>
          {/* THE WALLET FILL. Shown only when something can answer. type="button": it must
              not submit the form. A Solana address the site already holds is filled with
              no provider asked; lib/heat/walletFill.ts says what is asked otherwise. On a
              phone the buttons take their own row, so the field keeps its whole hint. */}
          {fillOffers.length > 0 && (
            <div className="w-full sm:w-auto flex flex-wrap gap-2">
              {fillOffers.map((network) => (
                <button
                  key={network}
                  type="button"
                  onClick={() => fill(network)}
                  className="px-3 py-2 rounded-lg text-[12px] text-white/80 hover:text-white transition-colors"
                  style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-25)' }}
                >
                  {fillOffers.length > 1 ? FILL_LABEL[network] : 'Use my wallet'}
                </button>
              ))}
            </div>
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

  // Retired rows sort last, grey, and leave the token count; every row prints the
  // degrees the island served. The rooms are never added up: the served number rules.
  const rows = useMemo(
    () =>
      [...reading.breakdown].sort(
        (a, b) => Number(a.retired) - Number(b.retired) || b.degrees - a.degrees,
      ),
    [reading.breakdown],
  );
  const liveRows = rows.filter((r) => !r.retired);
  const deepest = liveRows[0] ?? null;

  // The post, built from served numbers only, and the number leads. The rank is the
  // deepest live room's, named by its room, and absent when the island served none.
  // SITE_URL rather than a literal host, so the link cannot drift from the venue's own.
  const shareIntent = useMemo(() => {
    const rank = deepest ? roomRankLine(deepest.roomRank, deepest.roomHolders) : null;
    const text =
      `${reading.degrees.toFixed(1)}° on Jungle Bay Island's instrument. ` +
      `${reading.tier}. ${days} days held. ` +
      (rank && deepest ? `${rank} in the ${deepest.symbol} room. ` : '') +
      `Held time counts here. ${SITE_URL}/read/${reading.address}`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }, [reading.tier, reading.degrees, reading.address, deepest, days]);

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

  // Where this number would sit, for an UNNAMED flame only: a named one is on the board and
  // its position is the island's to state. Tagged with the address it was computed for, so
  // a rank is never painted beside another wallet's reading.
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

  const retiredCount = rows.length - liveRows.length;
  const max = liveRows[0]?.degrees || 1;
  // token_count includes the retired rows, so they come off the count under the number.
  const countedTokens = Math.max(0, reading.tokenCount - retiredCount);

  return (
    <div>
      {/* The island's order: tier, days, degrees, since, tokens. The word a stranger knows
          leads, days are the unit anyone compares, and degrees follow. */}
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

        {nextTierLine(reading) && (
          <div className="text-[12.5px] text-white/75 mt-1.5">{nextTierLine(reading)}</div>
        )}

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
            ? 'Reckoned: never. This wallet has no measured holdings'
            : `Reckoned ${agoLabel(reading.asOfUnix, now)}`}
        </span>
        {stale && <span className="font-semibold">Stale: older than 7 days, so it decides nothing</span>}
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
            Your rooms, deepest first
          </div>
          <ul className="space-y-1.5 mb-4">
            {rows.map((r) => (
              <li key={`${r.chain}:${r.tokenAddress}`} data-retired={r.retired ? 'true' : undefined}>
                <div className="flex items-center gap-2 text-[12.5px]">
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
                </div>
                {/* The island's place for this wallet in this room, as served. */}
                {roomRankLine(r.roomRank, r.roomHolders) && (
                  <div className="text-[11px] text-white/50 mt-0.5">{roomRankLine(r.roomRank, r.roomHolders)}</div>
                )}
              </li>
            ))}
          </ul>
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
            Cold. Nothing measured here yet. {VENUE.heatDays}
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

      {/* The share: one button, under a WARM read only, since a cold wallet has nothing to
          post. It opens the composer with served numbers and the read link; nothing is
          posted on the holder's behalf. */}
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
        {showMath ? 'Hide' : 'How heat is earned'}
      </button>

      {showMath && <Maths degrees={reading.degrees} />}
    </div>
  );
}

/**
 * A room's own read: this room's row first, then the whole flame as served. Matched by
 * contract case-insensitively, because the registry keeps Solana mints in base58 with
 * capitals and the island echoes whatever it holds. A retired row is greyed and labeled,
 * with its own served degrees.
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
          {/* The island's place for this wallet in this room, as served. */}
          {roomRankLine(row.roomRank, row.roomHolders) && (
            <p className="text-white/70 text-[13px] mt-1">{roomRankLine(row.roomRank, row.roomHolders)}</p>
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
      {nextTierLine(reading) && <p className="text-white/60 text-[12px] mt-1">{nextTierLine(reading)}</p>}
    </div>
  );
}

/** The ladder: every rung of TIER_FLOORS, lowest first (Drifter too: a wallet below the
 *  first threshold stands on it). Reached rungs are lit; the next shows its floor minus the
 *  served degrees. The launch sentence hangs under tierFor(heatLaunchFloor()) and names a
 *  tier only when tierAtFloor finds the floor on one. The wallet's tier word is served. */
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

/** The launch floor on the card, from gateDecision: what the launch paths enforce with. */
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

      {/* The island's own countdown to the floor, when it serves one. A stale reading
          decides nothing and a warm one has nothing to wait for. */}
      {d.state === 'COLD' && reading.daysToPlant !== null && reading.daysToPlant >= 1 && (
        <p className="text-[11.5px] text-white/75 leading-relaxed mt-1">
          You may plant in {reading.daysToPlant.toLocaleString('en-US')} {reading.daysToPlant === 1 ? 'day' : 'days'}.
        </p>
      )}

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
      {/* The island's sentences, never its formula: the island's law page carries that. */}
      <p className="text-white/85 mb-3">{VENUE.heatParagraph}</p>

      <ul className="space-y-1.5 mb-3 text-white/70">
        <li>
          <strong className="text-white/85">Days</strong> <span>{VENUE.heatDays}</span>
        </li>
        <li>
          <strong className="text-white/85">Size</strong> <span>{VENUE.heatSize}</span>
        </li>
        <li>
          <strong className="text-white/85">Weight</strong> is the island&apos;s published
          multiplier.{' '}
          <span className="text-white/50">
            The island&apos;s own weigh heavier: the Apes, JBM and BAYLA carry the island&apos;s edge,
            the home team leans warm. An Ape counts by the piece.
          </span>
        </li>
      </ul>

      <div className="mb-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-white/45 mb-1.5">The tiers, on your heat</div>
        <ul className="space-y-1">
          {TIER_FLOORS.filter((t) => t.floor > 0).map((t) => (
            <li key={t.tier} className="flex items-baseline gap-2 text-white/70">
              <span className="w-[68px] shrink-0" style={{ color: TIER_COLOR[t.tier] }}>{t.tier}</span>
              <span className="w-[46px] shrink-0 stat-value">{t.floor}°</span>
              {degrees >= t.floor && <span className="text-[10px]" style={{ color: TIER_COLOR[t.tier] }}>✓ reached</span>}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-white/50 text-[11.5px] mb-2">
        The instrument is{' '}
        <strong className="text-white/75">continuous</strong>,{' '}
        <strong className="text-white/75">zero-anchored</strong> (time before you first held counts
        as zero), and <strong className="text-white/75">velocity-blind</strong> (churn earns nothing).
      </p>

      <p className="text-white/40 text-[11px]">
        Three properties make it hard to fake: time before you first held counts as zero, so a new
        bag starts cold however large; churn earns nothing; and price never enters it. The venue
        reads this number. The island computes it, and wherever the two disagree, the island is right.
      </p>
    </div>
  );
}
