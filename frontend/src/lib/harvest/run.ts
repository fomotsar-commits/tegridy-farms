// Harvest's run: every claim in order, one wallet approval each. Pure orchestration, so
// the order, the network switches and where a run stops are tested without a wallet;
// the sends are the card's (components/farm/HarvestCard.tsx).
import { orderClaims, type ClaimResult, type ClaimState, type HarvestChain, type HarvestClaim } from './types';

export type SwitchResult = { kind: 'ok' } | { kind: 'declined' } | { kind: 'failed'; reason: string };

export interface RunDeps<C extends HarvestClaim> {
  /** Sends one claim. Resolves with what it came to. */
  send: (claim: C) => Promise<ClaimResult>;
  /** Puts the EVM wallet on this chain before that chain's first claim. */
  switchTo: (chain: Exclude<HarvestChain, 'solana'>) => Promise<SwitchResult>;
  onState: (key: string, state: ClaimState) => void;
}

/**
 * Sends every claim, Solana first and then each EVM chain (orderClaims).
 *
 * It STOPS, leaving the rest unsent, on the two answers the Buy-all order stops on
 * (IslandBasketEvm): a cancel in the wallet, which is the visitor saying no, and a sent
 * claim whose outcome is unknown (`stop`). A claim that did not go through, or reverted,
 * belongs to its own pool alone, so the next pool's claim still goes. A network switch
 * the wallet refuses skips that chain's claims and moves on; a declined one stops.
 *
 * `evmChain` is the chain the EVM wallet is on now: its claims go first and need no switch.
 */
export async function runHarvest<C extends HarvestClaim>(claims: readonly C[], evmChain: HarvestChain | null, deps: RunDeps<C>): Promise<ClaimState[]> {
  const ordered = orderClaims(claims, evmChain);
  const states = new Map<string, ClaimState>(ordered.map((c) => [c.key, { kind: 'waiting' }]));
  const set = (key: string, s: ClaimState) => {
    states.set(key, s);
    deps.onState(key, s);
  };
  for (const c of ordered) deps.onState(c.key, { kind: 'waiting' });
  const stopFrom = (i: number) => {
    for (const c of ordered.slice(i)) if (states.get(c.key)?.kind === 'waiting') set(c.key, { kind: 'not-sent' });
  };

  let on: HarvestChain | null = evmChain;
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    if (states.get(c.key)?.kind !== 'waiting') continue;
    if (c.chain !== 'solana' && c.chain !== on) {
      const sw = await deps.switchTo(c.chain);
      if (sw.kind === 'declined') {
        stopFrom(i);
        break;
      }
      if (sw.kind === 'failed') {
        for (const d of ordered.slice(i)) {
          if (d.chain === c.chain) set(d.key, { kind: 'unconfirmed', reason: `Your wallet did not switch network (${sw.reason}), so nothing was sent.` });
        }
        continue;
      }
      on = c.chain;
    }
    set(c.key, { kind: 'sending' });
    let r: ClaimResult;
    try {
      r = await deps.send(c);
    } catch (e) {
      // Every send resolves; a throw is unexpected, so nothing is assumed about it.
      const msg = e instanceof Error ? e.message : String(e);
      r = { kind: 'unconfirmed', reason: `It stopped before an answer came back (${msg.slice(0, 140)}). Check your wallet before trying again.`, stop: true };
    }
    set(c.key, r);
    if (r.kind === 'declined' || (r.kind === 'unconfirmed' && r.stop)) {
      stopFrom(i + 1);
      break;
    }
  }
  return ordered.map((c) => states.get(c.key)!);
}

/** "3 claimed · 1 not confirmed", for the run's closing line. */
export function runSummary(states: readonly ClaimState[]): string {
  const n = (k: ClaimState['kind']) => states.filter((s) => s.kind === k).length;
  const parts = [
    [n('claimed'), 'claimed'],
    [n('reverted'), 'reverted'],
    [n('unconfirmed'), 'not confirmed'],
    [n('declined'), 'cancelled'],
    [n('not-sent'), 'not sent'],
  ] as const;
  return parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(' · ');
}
