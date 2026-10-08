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
  /** The aggregator's answer when it gave no quote: its own "no route", or it could not be asked. */
  aggregatorFail?: 'no-route' | 'unavailable' | null;
}

export function SolanaRouteLine({ route, ownUnavailable = null, aggregatorFail = null }: SolanaRouteLineProps) {
  const { venue, own, decision, aggregatorLabel, asking } = route;
  if (!venue) return asking ? <RouteShell>Comparing our pools with {aggregatorLabel}…</RouteShell> : null;

  // Before there is an amount there is no route to name. With the venue live the page's
  // own subtitle says the rule; a venue that could not be read, or is not there, is said.
  if (!decision?.chosen) {
    // One standing line while the quote is on its way, so the form does not jump on every keystroke.
    if (venue.kind === 'live' && asking) return <RouteShell>Comparing our pools with {aggregatorLabel}…</RouteShell>;
    // Nothing quoted the trade: say what each side found, and never a read that failed as "no route".
    if (aggregatorFail) {
      const agg = aggregatorFail === 'no-route' ? `${aggregatorLabel} has no route for this pair and amount` : `${aggregatorLabel} could not be asked for a quote just now`;
      if (own === 'pending') return <RouteShell><span className="text-white/80">Checking our pools. {agg}.</span></RouteShell>;
      if (own === 'absent' && venue.kind !== 'live') {
        return <RouteShell><span className="text-white/80">Our own pools are <Link to="/pools" className={LINK}>not deployed yet</Link>, and {agg}.</span></RouteShell>;
      }
      const ours = own === 'error' ? 'Our pool could not be quoted this time'
        : own === 'unquotable' ? 'Our pool for this pair cannot be traded right now'
        : own === 'not-searched' ? `Our pools pair a token with ${QUOTE_COINS_OR}, so there is none for this pair`
        : 'We have no pool for this pair';
      return <RouteShell><span className="text-white/80">{ours}, and {agg}.</span></RouteShell>;
    }
    if (venue.kind === 'live') return null;
    return (
      <RouteShell>
        {venue.kind === 'unreadable'
            ? <>Quoting {aggregatorLabel}. Our own pools could not be checked just now.</>
            : <>
                Quoting {aggregatorLabel}. Our own pools are{' '}
                <Link to="/pools" className={LINK}>not deployed yet</Link>.
              </>}
      </RouteShell>
    );
  }

  const won = decision.chosen.venue === 'own-pool';

  let reason: string = decision.reason;
  if (won && ownUnavailable) {
    const more =
      decision.edge !== null && decision.edge > 0 ? `${edgePercent(decision.edge)} more output than` : 'the same output as';
    reason = decision.runnerUp
      ? `Our own pool quotes ${more} ${decision.runnerUp.label}, but a swap in it cannot be prepared here right now (${ownUnavailable}), so this swap executes via ${aggregatorLabel}.`
      : aggregatorFail === 'unavailable'
        ? `Our pool quotes this pair, but a swap in it cannot be prepared here right now (${ownUnavailable}), and ${aggregatorLabel} could not be asked for a quote just now, so nothing can be sent until ${aggregatorLabel} answers or a swap in our pool can be prepared here.`
        : `Only our own pool quoted this pair, and a swap in it cannot be prepared here right now (${ownUnavailable}), so it cannot fill.`;
  } else if (!won && !decision.runnerUp) {
    // The aggregator is the only candidate. "No pool" is said only when that was FOUND:
    // a read in flight, a read that failed, a pool that cannot be traded and a pair
    // never looked for each say their own.
    const to = `${decision.chosen.label}.`;
    if (own === 'pending') reason = `${to} Checking our pools…`;
    else if (own === 'error') reason = `${to} Our pool could not be quoted this time.`;
    else if (own === 'unquotable') reason = `${to} Our pool for this pair cannot be traded right now.`;
    else if (own === 'not-searched') reason = `${to} Our pools pair a token with ${QUOTE_COINS_OR}, so there is none for this pair.`;
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
