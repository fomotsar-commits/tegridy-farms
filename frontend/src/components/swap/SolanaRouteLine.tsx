import { Link } from 'react-router-dom';
import { edgePercent } from '../../lib/solana/route';
import { QUOTE_COINS_OR } from '../../lib/solana/lp/quotes';
import type { SolanaRoute } from './useSolanaRoute';

/**
 * "Where is this trade going, and why?", under the quote on the Solana swap, in every
 * state: the ones where our pool loses or has nothing to offer included. EXECUTION
 * HONESTY: "Routed to the venue pool" is said only when the page will send the trade
 * there. `ownUnavailable` is why it cannot right now; the line then says the pool quoted
 * more and that this swap goes through the aggregator all the same.
 */

const LINK = 'underline underline-offset-2 hover:text-white inline-block px-1 -mx-1 py-2 -my-2';

export interface SolanaRouteLineProps {
  route: SolanaRoute;
  /** Why a swap in our own pool cannot be prepared on this page right now; null when it can. */
  ownUnavailable?: string | null;
}

export function SolanaRouteLine({ route, ownUnavailable = null }: SolanaRouteLineProps) {
  const { venue, own, decision, aggregatorLabel } = route;
  if (!venue) return null;

  // Before there is an amount, still say what the router will do.
  if (!decision?.chosen) {
    return (
      <RouteShell>
        {venue.kind === 'live'
          ? <>Quotes are taken from our own pools and {aggregatorLabel}, whichever pays more.</>
          : venue.kind === 'unreadable'
            ? <>Quoting {aggregatorLabel}. Our own pools could not be checked just now.</>
            : <>
                Quoting {aggregatorLabel}. Our own pools are{' '}
                <Link to="/pools" className={LINK}>not deployed yet</Link>.
              </>}
      </RouteShell>
    );
  }

  const won = decision.chosen.venue === 'own-pool';
  const ours = decision.candidates.filter((c) => c.venue === 'own-pool').length;

  let reason: string = decision.reason;
  if (won && ownUnavailable) {
    const more =
      decision.edge !== null && decision.edge > 0 ? `${edgePercent(decision.edge)} more output than` : 'the same output as';
    reason = decision.runnerUp
      ? `Our own pool quotes ${more} ${decision.runnerUp.label}, but a swap in it cannot be prepared here right now (${ownUnavailable}), so this swap executes via ${aggregatorLabel}.`
      : `Only our own pool quoted this pair, and a swap in it cannot be prepared here right now (${ownUnavailable}), so it cannot fill.`;
  } else if (!won && !decision.runnerUp) {
    // The aggregator is the only candidate. "No pool" is said only when that was FOUND:
    // a read in flight, a read that failed, a pool that cannot be traded and a pair
    // never looked for each say their own.
    const to = `Routed to ${decision.chosen.label}.`;
    if (own === 'pending') reason = `${to} Checking our own pools…`;
    else if (own === 'error') reason = `${to} Our own pool could not be quoted this time.`;
    else if (own === 'unquotable') reason = `${to} Our own pool for this pair cannot be traded right now.`;
    else if (own === 'not-searched') reason = `${to} Our own pools pair a token with ${QUOTE_COINS_OR}, so there is none to check for this pair.`;
  }

  return (
    <RouteShell tone={won && !ownUnavailable ? 'good' : undefined}>
      <span className="text-white/80">{reason}</span>
      {venue.kind !== 'live' && (
        <>
          {' '}
          <Link to="/pools" className={LINK}>Why?</Link>
        </>
      )}
      {decision.runnerUp && (
        <span className="text-white/40">
          {' '}Checked {ours === 1 ? 'our pool' : `${ours} of our pools`} and {aggregatorLabel}.
        </span>
      )}
    </RouteShell>
  );
}

function RouteShell({ children, tone }: { children: React.ReactNode; tone?: 'good' }) {
  return (
    <p
      className="text-[10px] leading-relaxed mt-2 rounded-lg px-2.5 py-1.5"
      data-testid="solana-route-line"
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
