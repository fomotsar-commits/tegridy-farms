// Where the Solana swap's Buy sends a trade, decided from what is on screen, and the one
// sentence that says so. The Buy press settles it again on fresh numbers (settleVenue.ts)
// before anything is built, so these words are in the future tense: nothing is "routed"
// before it is sent. "No pool" is said only after a search that read everything.

import { QUOTE_COINS_OR } from '../lp/quotes';
import { chooseRoute } from '../route';
import type { OwnCandidate, OwnQuotes } from './ownPools';

export type JupiterSide =
  | { kind: 'pending' }
  /** `feeBps`: the site fee priced into this quote, or null when it carries none. */
  | { kind: 'route'; outAmount: bigint; feeBps: number | null }
  /** Jupiter's own answer that it has no route (lib/jupiter.ts NoRouteError), and nothing else. */
  | { kind: 'no-route' }
  | { kind: 'unavailable' };

export type OwnSide =
  /** This build names no pool program of ours. */
  | { kind: 'absent' }
  /** Neither side is a pairing coin, so no pool of ours can hold the pair. */
  | { kind: 'not-a-pair' }
  | { kind: 'pending' }
  | { kind: 'unread' }
  | { kind: 'ok'; quotes: OwnQuotes };

/** Whether a trade in our pool can be sent from this page now. `reason` reads after "but". */
export type OwnSend = { kind: 'yes' } | { kind: 'checking' } | { kind: 'no'; reason: string };

export type VenueChoice =
  /** `closeCall`: our pool beats Jupiter's fee-bearing quote by less than the site fee, so the press decides. */
  | { venue: 'own'; best: OwnCandidate; edge: number | null; closeCall: boolean }
  | { venue: 'jupiter' }
  /** Something still being read could decide it. */
  | { venue: 'wait' }
  /** Nothing here can fill it now. */
  | { venue: 'none' };

/** Our pool's quote against Jupiter's: a tie is ours; `closeCall` when the site fee could swing it. */
function against(best: OwnCandidate, jupiter: { outAmount: bigint; feeBps: number | null }) {
  const d = chooseRoute([
    { venue: 'own-pool', outAmount: best.quote.outAmount, label: 'our pool' },
    { venue: 'aggregator', outAmount: jupiter.outAmount, label: 'Jupiter' },
  ]);
  const bps = BigInt(jupiter.feeBps ?? 0);
  const ownWins = d.chosen?.venue === 'own-pool';
  return { ownWins, edge: d.edge ?? 0, closeCall: ownWins && bps > 0n && best.quote.outAmount * (10_000n - bps) < jupiter.outAmount * 10_000n };
}

export function chooseVenue(jupiter: JupiterSide, own: OwnSide, send: OwnSend): VenueChoice {
  const best = own.kind === 'ok' ? own.quotes.best : null;
  if (own.kind === 'pending' || jupiter.kind === 'pending') return { venue: 'wait' };
  if (!best) return jupiter.kind === 'route' ? { venue: 'jupiter' } : { venue: 'none' };
  // Our pool quotes it. Without Jupiter's answer the two cannot be compared.
  if (jupiter.kind === 'unavailable') return { venue: 'none' };
  const vs = jupiter.kind === 'route' ? against(best, jupiter) : null;
  if (vs && !vs.ownWins) return { venue: 'jupiter' };
  if (send.kind === 'checking') return { venue: 'wait' };
  if (send.kind === 'no') return jupiter.kind === 'route' ? { venue: 'jupiter' } : { venue: 'none' };
  return { venue: 'own', best, edge: vs ? vs.edge : null, closeCall: vs?.closeCall ?? false };
}

function pct(edge: number): string {
  const text = (edge * 100).toLocaleString('en-US', { maximumFractionDigits: 3 });
  return text === '0' ? 'a little' : `${text}%`;
}

/** Why our pools take no part, or null when one of them quotes this trade. */
function ownNote(own: OwnSide): string | null {
  switch (own.kind) {
    case 'absent':
      return 'This site has no pools of its own on this network yet';
    case 'not-a-pair':
      return `Our pools pair a token with ${QUOTE_COINS_OR}, and this pair has none of them`;
    case 'unread':
      return 'Our pools could not be read just now';
    case 'pending':
      return null;
    case 'ok': {
      const q = own.quotes;
      if (q.best) return null;
      if (q.found === 0) {
        return q.gaps.length ? `No pool of ours was found for this pair, but the search did not finish (${q.gaps.join('; ')})` : 'We have no pool for this pair';
      }
      const reasons = [...new Set(q.excluded.map((e) => e.reason))].join('; ');
      const unfinished = q.gaps.length ? `, and the search did not finish (${q.gaps.join('; ')})` : '';
      return q.found === 1
        ? `Our pool for this pair cannot take this trade: ${reasons}${unfinished}`
        : `None of our ${q.found} pools for this pair can take this trade: ${reasons}${unfinished}`;
    }
  }
}

const CHECKING_WALLET = 'Checking this wallet can trade in our pool…';

/** The route line for a trade with an amount. */
export function routeSentence(jupiter: JupiterSide, own: OwnSide, send: OwnSend): string {
  if (own.kind === 'pending') return jupiter.kind === 'pending' ? 'Checking our pools and Jupiter for this trade…' : 'Checking our pools for this trade…';
  const note = ownNote(own);
  const best = own.kind === 'ok' ? own.quotes.best : null;
  if (note !== null || !best) {
    const n = note ?? 'Our pools take no part in this trade';
    if (jupiter.kind === 'pending') return `${n}. Checking Jupiter for this trade…`;
    if (jupiter.kind === 'route') return `${n}, so Buy sends this trade to Jupiter.`;
    if (jupiter.kind === 'no-route') return `${n}, and Jupiter has no route for this pair and amount.`;
    return `${n}, and Jupiter could not be asked for a quote just now.`;
  }
  if (jupiter.kind === 'pending') return 'Our pool quotes this trade. Checking Jupiter…';
  if (jupiter.kind === 'unavailable') {
    return "Jupiter could not be asked for a quote just now, so our pool's quote cannot be checked against it. Nothing is sent until it can.";
  }
  if (jupiter.kind === 'no-route') {
    const head = 'Jupiter has no route for this trade, and our pool quotes it';
    if (send.kind === 'checking') return `${head}. ${CHECKING_WALLET}`;
    return send.kind === 'no' ? `${head}, but ${send.reason}, so it cannot be made here right now.` : `${head}, so Buy sends it to our pool.`;
  }
  const vs = against(best, jupiter);
  if (!vs.ownWins) return `Jupiter quotes ${pct(vs.edge)} more than our pool, so Buy sends this trade to Jupiter.`;
  const wins = vs.edge === 0 ? 'Our pool and Jupiter quote the same for this trade' : `Our pool quotes ${pct(vs.edge)} more than Jupiter`;
  if (send.kind === 'checking') return `${wins}. ${CHECKING_WALLET}`;
  if (send.kind === 'no') return `${wins}, but ${send.reason}, so Buy sends this trade to Jupiter.`;
  if (vs.closeCall) {
    const lead = vs.edge === 0 ? "Our pool quotes the same as Jupiter's quote" : `Our pool quotes ${pct(vs.edge)} more than Jupiter's quote`;
    return `${lead}, which includes this site's fee. Buy asks Jupiter again and sends whichever pays you more.`;
  }
  return `${wins}, so Buy sends it to our pool.`;
}

/** The route line before an amount is typed. */
export function standingSentence(own: OwnSide): string {
  return own.kind === 'absent'
    ? 'Quotes come from Jupiter. This site has no pools of its own on this network yet.'
    : 'Buy goes to one of our pools when it pays you at least as much as Jupiter, and to Jupiter otherwise.';
}
