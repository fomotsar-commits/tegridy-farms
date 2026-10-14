import { OWN_ROUTE_COPY } from '../../lib/solana/swap/ownPoolRoute';
import { DECLINED_IN_WALLET, HELD_NOT_SENT } from '../../lib/solana/swap/walletCopy';
import type { TxOutcome } from '../solana/curve/ports';

// THE QUIET ENDING. Every swap in our own pool stops on its review before the wallet is
// asked (owner, 2026-10-13). After the wallet, an ending one line can say skips the
// outcome card and the form comes back by itself. Anything else holds the screen.

export type QuietEnding =
  | { kind: 'confirmed'; signature: string }
  /** Nothing left the page: the trader said no in their wallet, or a swap this wallet sent holds it. */
  | { kind: 'not-signed'; message: string }
  /** The route was checked again at the press and is no longer our pool. */
  | { kind: 'route-changed'; message: string };

const ROUTE_CHANGED: ReadonlySet<string> = new Set([OWN_ROUTE_COPY.routeMoved, OWN_ROUTE_COPY.underLastQuote, OWN_ROUTE_COPY.poolGone]);

/**
 * An ending that one line can say, so the form comes back by itself. Never `unknown`
 * (the swap may still land: its card holds the screen), and never a refusal by the
 * network, by the test run, or of what a wallet handed back: each has a reason to read.
 */
export function quietEnding(o: TxOutcome): QuietEnding | null {
  if (o.status === 'confirmed') return { kind: 'confirmed', signature: o.signature };
  if (o.status !== 'not-sent') return null;
  if (o.stage === 'sign' && (o.message === DECLINED_IN_WALLET || o.message === HELD_NOT_SENT)) return { kind: 'not-signed', message: o.message };
  if (o.stage === 'build' && ROUTE_CHANGED.has(o.message)) return { kind: 'route-changed', message: o.message };
  return null;
}
