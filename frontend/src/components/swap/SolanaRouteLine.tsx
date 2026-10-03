import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { browserCurveRpc } from '../../lib/launcher/solana/curve/rpc';
import {
  readVenue,
  readPoolForPair,
  quoteOwnPool,
  type VenueStatus,
} from '../../lib/solana/cpswap/read';
import { deriveAmmConfig, DEFAULT_AMM_CONFIG_INDEX } from '../../lib/solana/cpswap/program';
import {
  chooseRoute,
  ownPoolCandidate,
  aggregatorCandidate,
  type RouteCandidate,
  type RouteDecision,
} from '../../lib/solana/route';

/**
 * The route line under the Solana swap's quote. It compares the venue's own pool quote
 * with the aggregator's (`lib/solana/route.ts`) and says where the swap is sent: through
 * the aggregator, because SolanaSwapPage submits only the aggregator's transaction.
 * Shown in every state, including the ones where our pool loses or has nothing to offer.
 * The venue read is cached in module scope: its deployment state does not change between
 * two quotes.
 */

let venueCache: Promise<VenueStatus> | null = null;
function venueStatusOnce(): Promise<VenueStatus> {
  venueCache ??= readVenue(browserCurveRpc())
    .catch((): VenueStatus => ({ kind: 'unreadable', detail: 'the RPC proxy did not answer' }))
    .then((v) => {
      // A transient read failure must not become the session-long truth: an
      // 'unreadable' cached forever would render "not deployed yet" for the
      // rest of the SPA session over a venue that is merely briefly
      // unreachable. Drop the cache so the next mount retries.
      if (v.kind === 'unreadable') venueCache = null;
      return v;
    });
  return venueCache;
}

export interface SolanaRouteLineProps {
  inputMint: string;
  outputMint: string;
  /** Raw input base units. Zero/absent means "no quote yet". */
  amountInRaw: bigint | null;
  /** The aggregator's quote, as returned. Null while loading or on failure. */
  aggregatorQuote: { outAmount: string; priceImpactPct?: string } | null;
  aggregatorLabel?: string;
}

export function SolanaRouteLine({
  inputMint,
  outputMint,
  amountInRaw,
  aggregatorQuote,
  aggregatorLabel = 'Jupiter',
}: SolanaRouteLineProps) {
  const [venue, setVenue] = useState<VenueStatus | null>(null);
  // The own-pool read outcome is the only asynchronous input, so it is the only state, and
  // it is keyed: an answer for an earlier pair or amount is dropped by derivation, not by
  // a setState in an effect (react-hooks/set-state-in-effect). 'absent' and 'error' stay
  // apart: a read in flight or failed is never "this venue has no pool for this pair".
  const [ownRead, setOwnRead] = useState<{
    key: string;
    state: 'absent' | 'error' | 'quoted';
    candidate: RouteCandidate | null;
  }>({ key: '', state: 'error', candidate: null });

  const quoteKey = `${inputMint}|${outputMint}|${amountInRaw ?? 0n}`;

  useEffect(() => {
    let cancelled = false;
    venueStatusOnce().then((v) => { if (!cancelled) setVenue(v); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!venue || venue.kind !== 'live' || !amountInRaw || amountInRaw <= 0n) return;
    let cancelled = false;
    (async () => {
      const programId = new PublicKey(venue.programId);
      const configAddress = deriveAmmConfig(programId, DEFAULT_AMM_CONFIG_INDEX);
      let state: 'absent' | 'error' | 'quoted';
      let candidate: RouteCandidate | null = null;
      try {
        const read = await readPoolForPair(
          browserCurveRpc(), programId, configAddress,
          new PublicKey(inputMint), new PublicKey(outputMint),
        );
        if (read.kind === 'ok') {
          candidate = ownPoolCandidate(quoteOwnPool(read.value, venue.config, inputMint, amountInRaw));
          // A pool that exists but quotes nothing (drained reserves) is a
          // failed quote, not a missing pool.
          state = candidate ? 'quoted' : 'error';
        } else if (read.kind === 'absent') {
          state = 'absent';
        } else {
          // 'unreadable' / 'not-a-pool': the read failed or the address is
          // occupied by something else — neither is proof of absence.
          state = 'error';
        }
      } catch {
        // A failed own-pool read must never block the trade — it only means we
        // could not offer a competing quote this time.
        state = 'error';
      }
      if (!cancelled) setOwnRead({ key: quoteKey, state, candidate });
    })();
    return () => { cancelled = true; };
  }, [venue, inputMint, outputMint, amountInRaw, quoteKey]);

  // Only an own-pool outcome for THIS pair and amount may enter the decision;
  // anything else is 'pending' (in flight, or superseded by a keystroke). A
  // venue that is provably not deployed has no pools ('absent'); an UNREADABLE
  // venue status proves nothing and must degrade to 'error', never 'absent'.
  const ownState: 'pending' | 'absent' | 'error' | 'quoted' =
    venue?.kind === 'live'
      ? (ownRead.key === quoteKey ? ownRead.state : 'pending')
      : venue?.kind === 'unreadable'
        ? 'error'
        : 'absent';

  const decision: RouteDecision | null = useMemo(() => {
    if (!venue || !amountInRaw || amountInRaw <= 0n) return null;
    const agg = aggregatorCandidate(aggregatorQuote, aggregatorLabel);
    const own = ownState === 'quoted' ? ownRead.candidate : null;
    const candidates = [own, agg].filter((c): c is RouteCandidate => c !== null);
    return candidates.length ? chooseRoute(candidates) : null;
  }, [venue, amountInRaw, aggregatorQuote, aggregatorLabel, ownRead, ownState]);

  if (!venue) return null;

  // SolanaSwapPage.handleSwap submits the aggregator's transaction whatever chooseRoute()
  // picks: no own-pool execution path exists yet. So every line here is a comparison of
  // quotes plus where the swap is sent, never decision.reason, which reads as execution.
  // When own-pool execution lands, send the winner's transaction and render
  // decision.reason again, in the same change.
  const sentThrough = `For now, every swap on this page is sent through ${aggregatorLabel}.`;

  // Before there is an amount, still say what this page does with a quote. One quiet line.
  if (!decision?.chosen) {
    return (
      <RouteShell>
        {venue.kind === 'live'
          ? <>We compare quotes from our own pools and {aggregatorLabel}. {sentThrough}</>
          : venue.kind === 'unreadable'
            ? <>Quoting {aggregatorLabel}. Our own pools could not be checked just now.</>
            : <>
                Quoting {aggregatorLabel}. Our own pools are{' '}
                <Link to="/pools" className="underline underline-offset-2 hover:text-white inline-block px-1 -mx-1 py-2 -my-2">not deployed yet</Link>.
              </>}
      </RouteShell>
    );
  }

  const won = decision.chosen.venue === 'own-pool';

  let reason: string;
  if (won) {
    const pct =
      decision.edge !== null && decision.edge > 0
        ? `${(decision.edge * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}% more output`
        : 'the same or better output';
    reason = decision.runnerUp
      ? `Our own pool quotes ${pct} than ${decision.runnerUp.label} — own-pool routing isn't wired into this swap yet, so it still executes via ${aggregatorLabel}.`
      : `Only our own pool quoted this pair, and this swap executes via ${aggregatorLabel} — so it cannot fill right now.`;
  } else if (decision.runnerUp) {
    // Our pool quoted less. A tie goes to our pool, so the edge here is above zero.
    const pct = ((decision.edge ?? 0) * 100).toLocaleString(undefined, { maximumFractionDigits: 3 });
    reason = `${decision.chosen.label} quotes ${pct}% more output than our own pool. ${sentThrough}`;
  } else {
    // The aggregator's is the only quote. Our pool is absent only when a read proved it:
    // a read in flight or failed says so instead.
    const ownPool =
      ownState === 'pending'
        ? 'Checking our own pool…'
        : ownState === 'error'
          ? 'Our own pool could not be quoted this time.'
          : 'This venue has no pool for this pair.';
    reason = `${ownPool} ${sentThrough}`;
  }

  return (
    <RouteShell tone={won ? 'good' : undefined}>
      <span className="text-white/80">{reason}</span>
      {venue.kind !== 'live' && (
        <>
          {' '}
          <Link to="/pools" className="underline underline-offset-2 hover:text-white inline-block px-1 -mx-1 py-2 -my-2">Why?</Link>
        </>
      )}
      {decision.runnerUp && (
        <span className="text-white/40">
          {' '}Checked {decision.candidates.length} venues.
        </span>
      )}
    </RouteShell>
  );
}

function RouteShell({ children, tone }: { children: React.ReactNode; tone?: 'good' }) {
  return (
    <p
      className="text-[10px] leading-relaxed mt-2 rounded-lg px-2.5 py-1.5"
      style={{
        background: tone === 'good' ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.35)',
        border: `1px solid ${tone === 'good' ? 'rgba(34,197,94,0.30)' : 'rgba(255,255,255,0.10)'}`,
        color: 'rgba(255,255,255,0.55)',
      }}
    >
      <span className="uppercase tracking-wider mr-1.5" style={{ color: 'var(--color-kyle)' }}>Route</span>
      {children}
    </p>
  );
}
