// Whether a trigger order is actually armed — the honesty core of this surface.
//
// A stop-loss the user believes is watching the market, and which nothing is
// watching, is worse than no stop-loss: it replaces a decision with a false one and
// is discovered only by the loss it was meant to cap. So `armed` is computed here,
// once, from facts that were checked — never inferred from the order having been
// built, saved, or displayed — and every path that is not armed carries the reason
// in words a trader can act on.
//
// Two executors exist in principle and exactly one exists in fact:
//
//   safe-composable-cow — CoW's watchtower polls the registered conditional order
//     and posts it when the strike is reached. Real, running, free, and narrow: it
//     needs an ERC-1271 wallet, a deployed StopLoss handler, price feeds for both
//     sides, and it can only express a falling strike.
//
//   keeper — the venue's own executor (docs/BATTLE_PLAN.md F4). NOT BUILT. Every
//     kind CoW's handler cannot express, and every EOA, lands here, and therefore
//     lands unarmed. `KEEPER_AVAILABLE` is the single switch; it is a constant
//     rather than a dial because an operator cannot make a keeper exist by setting
//     an env var, and a dial would invite exactly that.

import type { Address } from 'viem';
import { stopLossHandlerAddress, feedFor, type PriceFeedRef } from './stopLossHandler';
import { TRIGGER_KIND_LABELS, type TriggerKind } from './triggerPlan';

export type TriggerWalletKind = 'unknown' | 'eoa' | 'contract';
export type TriggerPath = 'safe-composable-cow' | 'keeper';

/**
 * Flips only when F4 ships a keeper that actually watches prices and submits.
 * See KEEPER_REQUIREMENTS for what "actually" means here.
 */
export const KEEPER_AVAILABLE = false;

/**
 * What the F4 keeper has to provide before the EOA path may arm. This list is
 * exported so the surface prints it verbatim: a user asking "why can't I place
 * this" gets the same answer as the operator asking "what is left to build".
 */
export const KEEPER_REQUIREMENTS: readonly string[] = [
  'A price watcher on the pair, reading the same source the order quotes its trigger against, with its own staleness bound.',
  'A pre-authorised execution credential scoped to {router, token pair, max size, expiry} — the keeper never holds user funds.',
  'Per-attempt receipts, including failures, readable back into this UI: an order that did not fire must be visible as not fired.',
  'Cancellation that provably revokes execution authority, not just a row deleted from a table.',
  'Idempotency per order-attempt, so a retry cannot double-sell the position.',
];

export type TriggerBlockerCode =
  | 'wallet-unknown'
  | 'wallet-eoa'
  | 'wrong-chain'
  | 'kind-needs-keeper'
  | 'keeper-not-deployed'
  | 'handler-not-configured'
  | 'sell-feed-missing'
  | 'buy-feed-missing';

export interface TriggerBlocker {
  code: TriggerBlockerCode;
  /** Rendered verbatim. States what is missing and who supplies it. */
  message: string;
}

export interface TriggerArmInput {
  kind: TriggerKind;
  walletKind: TriggerWalletKind;
  onExpectedChain: boolean;
  sellToken?: string | null;
  buyToken?: string | null;
}

export interface TriggerArmState {
  /** True only when a named executor will actually poll this order. */
  armed: boolean;
  /** The executor this order WOULD use — not a claim that it will run. */
  path: TriggerPath;
  blockers: TriggerBlocker[];
  handler: Address | null;
  sellFeed: PriceFeedRef | null;
  buyFeed: PriceFeedRef | null;
  /** Short status word. Never optimistic — there is no "pending" here. */
  statusLabel: 'Armed' | 'Not armed';
  /** One sentence naming the executor, or naming the absence of one. Never empty. */
  statusDetail: string;
}

/**
 * CoW's StopLoss handler compares a falling ratio against a fixed strike. That
 * covers a stop-loss and nothing else on this surface: a take-profit needs the
 * opposite comparison, a trail needs the strike rewritten as the market moves, and
 * an OCO needs the losing leg cancelled when the winner fills. None of those are
 * things a registered conditional order does.
 */
export function kindNeedsKeeper(kind: TriggerKind): boolean {
  return kind !== 'stop-loss';
}

const KIND_KEEPER_REASON: Record<Exclude<TriggerKind, 'stop-loss'>, string> = {
  'take-profit':
    'CoW’s stop-loss handler only fires on a FALLING price. A take-profit needs the opposite comparison, which no deployed CoW handler expresses, so it needs the venue keeper.',
  'trailing-stop':
    'A trail moves its stop as the price makes new highs. Nothing rewrites a registered CoW order, so the trail needs the venue keeper to hold the high-water mark.',
  oco: 'An OCO must cancel its losing leg the moment the winner fills. Two independent CoW orders cannot do that — both could fill — so an OCO needs the venue keeper.',
};

export function triggerArmState(input: TriggerArmInput): TriggerArmState {
  const { kind, walletKind, onExpectedChain } = input;
  const needsKeeper = kindNeedsKeeper(kind) || walletKind !== 'contract';
  const path: TriggerPath = needsKeeper ? 'keeper' : 'safe-composable-cow';

  const blockers: TriggerBlocker[] = [];
  if (!onExpectedChain) {
    blockers.push({
      code: 'wrong-chain',
      message: 'Switch to Ethereum Mainnet — this surface reads and registers orders there only.',
    });
  }

  if (kindNeedsKeeper(kind)) {
    blockers.push({
      code: 'kind-needs-keeper',
      message: KIND_KEEPER_REASON[kind as Exclude<TriggerKind, 'stop-loss'>],
    });
  }

  let handler: Address | null = null;
  let sellFeed: PriceFeedRef | null = null;
  let buyFeed: PriceFeedRef | null = null;

  if (path === 'keeper') {
    if (walletKind === 'unknown') {
      blockers.push({
        code: 'wallet-unknown',
        message: 'Connect a wallet — until then this surface cannot tell which executor your order would use.',
      });
    } else if (walletKind === 'eoa' && !kindNeedsKeeper(kind)) {
      blockers.push({
        code: 'wallet-eoa',
        message:
          'A regular wallet (EOA) cannot register a CoW conditional order — it cannot sign for itself the way a Safe contract can — so this order would need the venue keeper.',
      });
    }
    if (!KEEPER_AVAILABLE) {
      blockers.push({
        code: 'keeper-not-deployed',
        message:
          'The venue runs no keeper yet, so nothing would watch this order or submit it. It would not fire. Nothing is placed and nothing is charged.',
      });
    }
  } else {
    handler = stopLossHandlerAddress();
    if (!handler) {
      blockers.push({
        code: 'handler-not-configured',
        message:
          'No CoW stop-loss handler is configured for this deployment. Registering against an unverified handler would create an order that never fires, so placement stays closed until an operator sets a verified address.',
      });
    }
    sellFeed = input.sellToken ? feedFor(input.sellToken) : null;
    buyFeed = input.buyToken ? feedFor(input.buyToken) : null;
    if (!sellFeed) {
      blockers.push({
        code: 'sell-feed-missing',
        message:
          'No price feed is configured for the token you are selling. CoW’s handler reads an on-chain feed for BOTH sides of the pair; most launched tokens have none, and without one the order can never become tradeable.',
      });
    }
    if (!buyFeed) {
      blockers.push({
        code: 'buy-feed-missing',
        message: 'No price feed is configured for the token you are buying, which the handler also reads.',
      });
    }
  }

  const armed = blockers.length === 0 && path === 'safe-composable-cow';

  return {
    armed,
    path,
    blockers,
    handler,
    sellFeed,
    buyFeed,
    statusLabel: armed ? 'Armed' : 'Not armed',
    statusDetail: armed
      ? 'CoW’s watchtower polls this order and posts it to the solver auction when your stop is reached. Fills are best-effort — a solver still has to want the trade — so this is not a guaranteed exit.'
      : `Nothing is watching this ${TRIGGER_KIND_LABELS[kind].toLowerCase()}. It will not fire.`,
  };
}
