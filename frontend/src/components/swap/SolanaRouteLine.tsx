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
  venueCache ??= readVenue(browserCurveRpc()).catch(
    (): VenueStatus => ({ kind: 'unreadable', detail: 'the RPC proxy did not answer' }),
  );
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
  // The own-pool quote is the only asynchronous input, so it is the only thing
  // held in state — and it is KEYED, so a stale answer for a previous pair or
  // amount is discarded by derivation rather than by a synchronous setState in
  // an effect (react-hooks/set-state-in-effect). Everything else below is
  // computed during render.
  const [ownQuote, setOwnQuote] = useState<{ key: string; candidate: RouteCandidate | null }>(
    { key: '', candidate: null },
  );

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
      let candidate: RouteCandidate | null = null;
      try {
        const read = await readPoolForPair(
          browserCurveRpc(), programId, configAddress,
          new PublicKey(inputMint), new PublicKey(outputMint),
        );
        if (read.kind === 'ok') {
          candidate = ownPoolCandidate(quoteOwnPool(read.value, venue.config, inputMint, amountInRaw));
        }
      } catch {
        // A failed own-pool read must never block the trade — it only means we
        // could not offer a competing quote this time.
        candidate = null;
      }
      if (!cancelled) setOwnQuote({ key: quoteKey, candidate });
    })();
    return () => { cancelled = true; };
  }, [venue, inputMint, outputMint, amountInRaw, quoteKey]);

  const decision: RouteDecision | null = useMemo(() => {
    if (!venue || !amountInRaw || amountInRaw <= 0n) return null;
    const agg = aggregatorCandidate(aggregatorQuote, aggregatorLabel);
    // Only an own-pool quote for THIS pair and amount may enter the decision.
    const own = ownQuote.key === quoteKey ? ownQuote.candidate : null;
    const candidates = [own, agg].filter((c): c is RouteCandidate => c !== null);
    return candidates.length ? chooseRoute(candidates) : null;
  }, [venue, amountInRaw, aggregatorQuote, aggregatorLabel, ownQuote, quoteKey]);

  if (!venue) return null;

  // Before there is an amount, still say what the router will do — this is the
  // showcase half, and it costs one quiet line.
  if (!decision?.chosen) {
    return (
      <RouteShell>
        {venue.kind === 'live'
          ? <>Quotes are taken from our own pools and {aggregatorLabel}, whichever pays more.</>
          : <>
              Quoting {aggregatorLabel}. Our own pools are{' '}
              <Link to="/pools" className="underline underline-offset-2 hover:text-white">not deployed yet</Link>.
            </>}
      </RouteShell>
    );
  }

  const won = decision.chosen.venue === 'own-pool';
  return (
    <RouteShell tone={won ? 'good' : undefined}>
      <span className="text-white/80">{decision.reason}</span>
      {venue.kind !== 'live' && (
        <>
          {' '}
          <Link to="/pools" className="underline underline-offset-2 hover:text-white">Why?</Link>
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
