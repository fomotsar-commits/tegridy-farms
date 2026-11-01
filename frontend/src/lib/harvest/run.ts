// Harvest's run: every claim in order, chain by chain, on as few wallet prompts as each
// wallet allows. Pure orchestration, so the order, the network switches and where a run
// stops are tested without a wallet; the sends are the card's (components/farm/HarvestCard.tsx).
import { orderClaims, type ClaimResult, type ClaimState, type HarvestChain, type HarvestClaim } from './types';

export type SwitchResult = { kind: 'ok' } | { kind: 'declined' } | { kind: 'failed'; reason: string };

/**
 * One chain's claims on ONE wallet prompt, each still its own transaction. `settle` takes
 * each claim's answer as it comes. 'one-by-one': the wallet would not take them together
 * and nothing was sent, so each goes through `send` on a prompt of its own.
 */
export type SendTogether<C> = (claims: readonly C[], settle: (key: string, r: ClaimResult) => void) => Promise<'done' | 'one-by-one'>;

export interface RunDeps<C extends HarvestClaim> {
  /** Sends one claim. Resolves with what it came to. */
  send: (claim: C) => Promise<ClaimResult>;
  /** This chain's claims together, when its wallet can sign them on one prompt; null: one prompt per claim. */
  together?: (chain: HarvestChain) => SendTogether<C> | null;
  /** Puts the EVM wallet on this chain before that chain's first claim. */
  switchTo: (chain: Exclude<HarvestChain, 'solana'>) => Promise<SwitchResult>;
  onState: (key: string, state: ClaimState) => void;
}

const stops = (s: ClaimState | undefined) => s?.kind === 'declined' || (s?.kind === 'unconfirmed' && s.stop === true);

const stoppedEarly = (e: unknown): ClaimResult => {
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: 'unconfirmed', reason: `It stopped before an answer came back (${msg.slice(0, 140)}). Check your wallet before trying again.`, stop: true };
};

/**
 * Sends every claim, Solana first and then each EVM chain (orderClaims). A chain with two
 * or more claims goes on one prompt when `together` offers it; otherwise, and for a chain
 * with one claim, each claim is its own prompt.
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

  /** One chain's claims. True when the run stops here. */
  const sendChain = async (group: readonly C[]): Promise<boolean> => {
    const together = group.length > 1 ? deps.together?.(group[0]!.chain) ?? null : null;
    if (together) {
      for (const c of group) set(c.key, { kind: 'sending' });
      let how: 'done' | 'one-by-one';
      try {
        how = await together(group, (key, r) => {
          if (states.get(key)?.kind === 'sending') set(key, r);
        });
      } catch (e) {
        // Every batch resolves; a throw is unexpected, so nothing is assumed about it.
        how = 'done';
        for (const c of group) if (states.get(c.key)?.kind === 'sending') set(c.key, stoppedEarly(e));
      }
      if (how === 'done') {
        for (const c of group) {
          if (states.get(c.key)?.kind === 'sending') {
            set(c.key, { kind: 'unconfirmed', reason: 'No answer came back for it. Check your wallet before trying again.', stop: true });
          }
        }
        return group.some((c) => stops(states.get(c.key)));
      }
      for (const c of group) set(c.key, { kind: 'waiting' });
    }
    for (let k = 0; k < group.length; k++) {
      const c = group[k]!;
      set(c.key, { kind: 'sending' });
      let r: ClaimResult;
      try {
        r = await deps.send(c);
      } catch (e) {
        // Every send resolves; a throw is unexpected, so nothing is assumed about it.
        r = stoppedEarly(e);
      }
      set(c.key, r);
      if (stops(r)) return true;
    }
    return false;
  };

  let on: HarvestChain | null = evmChain;
  for (let i = 0; i < ordered.length; ) {
    const chain = ordered[i]!.chain;
    let end = i;
    while (end < ordered.length && ordered[end]!.chain === chain) end++;
    const group = ordered.slice(i, end);
    i = end;
    if (chain !== 'solana' && chain !== on) {
      const sw = await deps.switchTo(chain);
      if (sw.kind === 'declined') {
        stopFrom(end - group.length);
        break;
      }
      if (sw.kind === 'failed') {
        for (const c of group) set(c.key, { kind: 'unconfirmed', reason: `Your wallet did not switch network (${sw.reason}), so nothing was sent.` });
        continue;
      }
      on = chain;
    }
    if (await sendChain(group)) {
      stopFrom(end - group.length);
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

/**
 * How many times the wallets will ask: one per chain whose claims go together, one per
 * claim elsewhere, and one per network switch. For the line under the button.
 */
export function promptCount(claims: readonly HarvestClaim[], evmChain: HarvestChain | null, canTogether: (chain: HarvestChain) => boolean): number {
  const per = new Map<HarvestChain, number>();
  for (const c of claims) per.set(c.chain, (per.get(c.chain) ?? 0) + 1);
  let asks = 0;
  for (const [chain, n] of per) asks += (n > 1 && canTogether(chain) ? 1 : n) + (chain !== 'solana' && chain !== evmChain ? 1 : 0);
  return asks;
}
