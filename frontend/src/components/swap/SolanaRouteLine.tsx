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
 * "Where is this trade going, and why?" — rendered on the Solana swap under the
 * quote.
 *
 * The venue quotes its OWN pools alongside the aggregator and takes whichever
 * pays the trader more (`lib/solana/route.ts`). This is the line that says so,
 * and it is deliberately shown in every state, including the ones where we
 * lose or have nothing to offer — a routing disclosure that only appears when
 * the house wins is an advertisement, not a disclosure.
 *
 * The venue read is done once per mount and cached in module scope: the AMM's
 * deployment state does not change between two quotes, and re-probing it on
 * every keystroke would put a ProgramData read behind the amount field.
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
  // The own-pool READ OUTCOME is the only asynchronous input, so it is the
  // only thing held in state — and it is KEYED, so a stale answer for a
  // previous pair or amount is discarded by derivation rather than by a
  // synchronous setState in an effect (react-hooks/set-state-in-effect).
  // The outcome distinguishes "the pool is absent" from "the read failed":
  // collapsing those used to render a fabricated "this venue has no pool for
  // this pair" while the read was merely in flight or erroring — exactly the
  // degraded-read-as-finding class lib/solana/cpswap/read.ts prohibits.
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
      let state: 'absent' | 'error' | 'quoted' = 'error';
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

  // Before there is an amount, still say what the router will do — this is the
  // showcase half, and it costs one quiet line.
  if (!decision?.chosen) {
    return (
      <RouteShell>
        {venue.kind === 'live'
          ? <>Quotes are taken from our own pools and {aggregatorLabel}, whichever pays more.</>
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

  // EXECUTION HONESTY: the page this renders under submits the AGGREGATOR
  // transaction unconditionally (SolanaSwapPage.handleSwap →
  // buildSwapTransaction) — no own-pool execution path exists in the app yet.
  // chooseRoute() says which venue SHOULD win; until execution follows the
  // decision, an own-pool win must render as a price comparison, never as
  // "routed to the venue pool". When own-pool execution lands, route the
  // winning venue's transaction AND restore decision.reason here in the SAME
  // change.
  let reason: string = decision.reason;
  if (won) {
    const pct =
      decision.edge !== null && decision.edge > 0
        ? `${(decision.edge * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}% more output`
        : 'the same or better output';
    reason = decision.runnerUp
      ? `Our own pool quotes ${pct} than ${decision.runnerUp.label} — own-pool routing isn't wired into this swap yet, so it still executes via ${aggregatorLabel}.`
      : `Only our own pool quoted this pair, and this swap executes via ${aggregatorLabel} — so it cannot fill right now.`;
  } else if (!decision.runnerUp && (ownState === 'pending' || ownState === 'error')) {
    // Jupiter is the only candidate but our pool wasn't PROVEN absent — an
    // in-flight or failed read must not render as "this venue has no pool".
    reason =
      ownState === 'pending'
        ? `Routed to ${decision.chosen.label}. Checking our own pool…`
        : `Routed to ${decision.chosen.label}. Our own pool could not be quoted this time.`;
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
