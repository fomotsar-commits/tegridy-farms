// The honesty guard for the trigger surface.
//
// This module's only product is the word "Armed", and the test's job is to make that
// word expensive. Every assertion below is a way the surface could claim an order is
// being watched when nothing is watching it:
//
//   - a kind CoW's handler cannot express
//   - an EOA, which cannot host a conditional order at all
//   - the keeper that would cover both, which does not exist
//   - a handler address nobody verified
//   - a pair with no price feed for the handler to read
//
// The exhaustive sweep at the bottom is the real guard: it asserts that across every
// combination of kind and wallet type, `armed` is true only on the one path where a
// named, running executor polls the order — and that a false `armed` always arrives
// with a reason attached.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KEEPER_AVAILABLE,
  KEEPER_REQUIREMENTS,
  kindNeedsKeeper,
  triggerArmState,
  type TriggerWalletKind,
} from './armState';
import { TRIGGER_KINDS, type TriggerKind } from './triggerPlan';

const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as const;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const FEED_A = '0x2222222222222222222222222222222222222222' as const;
const FEED_B = '0x3333333333333333333333333333333333333333' as const;
const HANDLER = '0x4444444444444444444444444444444444444444' as const;

const WALLET_KINDS: TriggerWalletKind[] = ['unknown', 'eoa', 'contract'];

/** The only configuration in which anything on this surface can arm today. */
function configureSafePath() {
  vi.stubEnv('VITE_COW_STOP_LOSS_HANDLER', HANDLER);
  vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${FEED_A}:8,${WETH}:${FEED_B}:8`);
}

const PAIR = { sellToken: TOWELI, buyToken: WETH } as const;

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('the keeper is absent, and the surface says so', () => {
  it('is not available', () => {
    expect(KEEPER_AVAILABLE).toBe(false);
  });

  it('an EOA stop-loss is never armed, whatever else is configured', () => {
    configureSafePath();
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'eoa', onExpectedChain: true, ...PAIR });
    expect(state.armed).toBe(false);
    expect(state.path).toBe('keeper');
    expect(state.blockers.map((b) => b.code)).toContain('keeper-not-deployed');
  });

  it('says the order would not fire, in those words — not "pending" or "queued"', () => {
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'eoa', onExpectedChain: true, ...PAIR });
    expect(state.statusLabel).toBe('Not armed');
    expect(state.statusDetail).toMatch(/will not fire/i);
    expect(state.statusDetail).not.toMatch(/pending|queued|active|monitoring/i);
    const keeperBlocker = state.blockers.find((b) => b.code === 'keeper-not-deployed')!;
    expect(keeperBlocker.message).toMatch(/no keeper/i);
    expect(keeperBlocker.message).toMatch(/would not fire/i);
  });

  it('states that an unplaced order costs nothing, so the refusal is not read as a charge', () => {
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'eoa', onExpectedChain: true, ...PAIR });
    expect(state.blockers.find((b) => b.code === 'keeper-not-deployed')!.message).toMatch(/nothing is charged/i);
  });

  it('publishes what the keeper would have to provide', () => {
    expect(KEEPER_REQUIREMENTS.length).toBeGreaterThanOrEqual(4);
    const all = KEEPER_REQUIREMENTS.join(' ').toLowerCase();
    expect(all).toMatch(/receipt/);
    expect(all).toMatch(/cancel/);
    expect(all).toMatch(/idempot/);
    expect(all).toMatch(/never holds user funds/);
  });
});

describe('only a stop-loss maps onto CoW’s handler', () => {
  it('routes take-profit, trailing and OCO to the keeper', () => {
    expect(kindNeedsKeeper('stop-loss')).toBe(false);
    for (const kind of ['take-profit', 'trailing-stop', 'oco'] as TriggerKind[]) {
      expect(kindNeedsKeeper(kind)).toBe(true);
      configureSafePath();
      const state = triggerArmState({ kind, walletKind: 'contract', onExpectedChain: true, ...PAIR });
      expect(state.armed).toBe(false);
      expect(state.path).toBe('keeper');
      expect(state.blockers.map((b) => b.code)).toContain('kind-needs-keeper');
    }
  });

  it('explains the mechanism, not just the verdict', () => {
    const reasonFor = (kind: TriggerKind) =>
      triggerArmState({ kind, walletKind: 'contract', onExpectedChain: true, ...PAIR }).blockers.find(
        (b) => b.code === 'kind-needs-keeper',
      )!.message;
    expect(reasonFor('take-profit')).toMatch(/falling/i);
    expect(reasonFor('trailing-stop')).toMatch(/high-water|rewrite/i);
    expect(reasonFor('oco')).toMatch(/cancel/i);
  });
});

describe('the Safe path arms only when every precondition is a checked fact', () => {
  it('arms with handler, feeds, a contract wallet and the right chain', () => {
    configureSafePath();
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: true, ...PAIR });
    expect(state.armed).toBe(true);
    expect(state.path).toBe('safe-composable-cow');
    expect(state.blockers).toEqual([]);
    expect(state.handler).toBe(HANDLER);
    expect(state.sellFeed?.feed).toBe(FEED_A);
    expect(state.buyFeed?.feed).toBe(FEED_B);
  });

  it('still calls the armed fill best-effort rather than guaranteed', () => {
    configureSafePath();
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: true, ...PAIR });
    expect(state.statusDetail).toMatch(/best-effort/i);
    expect(state.statusDetail).toMatch(/not a guaranteed/i);
  });

  it('does not arm without a configured handler', () => {
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${FEED_A}:8,${WETH}:${FEED_B}:8`);
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: true, ...PAIR });
    expect(state.armed).toBe(false);
    expect(state.handler).toBeNull();
    expect(state.blockers.map((b) => b.code)).toContain('handler-not-configured');
  });

  it('does not arm when either side of the pair has no feed', () => {
    vi.stubEnv('VITE_COW_STOP_LOSS_HANDLER', HANDLER);
    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${TOWELI}:${FEED_A}:8`);
    const sellOnly = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: true, ...PAIR });
    expect(sellOnly.armed).toBe(false);
    expect(sellOnly.blockers.map((b) => b.code)).toContain('buy-feed-missing');

    vi.stubEnv('VITE_TRIGGER_PRICE_FEEDS', `${WETH}:${FEED_B}:8`);
    const buyOnly = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: true, ...PAIR });
    expect(buyOnly.armed).toBe(false);
    expect(buyOnly.blockers.map((b) => b.code)).toContain('sell-feed-missing');
  });

  it('does not arm on the wrong chain', () => {
    configureSafePath();
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'contract', onExpectedChain: false, ...PAIR });
    expect(state.armed).toBe(false);
    expect(state.blockers.map((b) => b.code)).toContain('wrong-chain');
  });

  it('does not arm from an unclassified wallet — an RPC failure is not a Safe', () => {
    configureSafePath();
    const state = triggerArmState({ kind: 'stop-loss', walletKind: 'unknown', onExpectedChain: true, ...PAIR });
    expect(state.armed).toBe(false);
    expect(state.blockers.map((b) => b.code)).toContain('wallet-unknown');
  });
});

describe('exhaustive: nothing arms outside the one live path', () => {
  it('with everything configured, only Safe + stop-loss arms', () => {
    configureSafePath();
    for (const kind of TRIGGER_KINDS) {
      for (const walletKind of WALLET_KINDS) {
        for (const onExpectedChain of [true, false]) {
          const state = triggerArmState({ kind, walletKind, onExpectedChain, ...PAIR });
          const shouldArm = kind === 'stop-loss' && walletKind === 'contract' && onExpectedChain;
          expect(state.armed).toBe(shouldArm);
          if (state.armed) {
            expect(state.path).toBe('safe-composable-cow');
            expect(state.handler).not.toBeNull();
          } else {
            // A refusal always carries at least one reason the user can read.
            expect(state.blockers.length).toBeGreaterThan(0);
            for (const b of state.blockers) expect(b.message.trim().length).toBeGreaterThan(20);
          }
        }
      }
    }
  });

  it('with nothing configured, nothing arms at all', () => {
    for (const kind of TRIGGER_KINDS) {
      for (const walletKind of WALLET_KINDS) {
        const state = triggerArmState({ kind, walletKind, onExpectedChain: true, ...PAIR });
        expect(state.armed).toBe(false);
        expect(state.statusLabel).toBe('Not armed');
      }
    }
  });

  it('never arms when the pair is unknown, whatever the dials say', () => {
    configureSafePath();
    const state = triggerArmState({
      kind: 'stop-loss',
      walletKind: 'contract',
      onExpectedChain: true,
      sellToken: null,
      buyToken: null,
    });
    expect(state.armed).toBe(false);
  });
});
