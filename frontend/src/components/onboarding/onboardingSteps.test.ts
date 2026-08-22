// HONESTY GUARD — the onboarding copy against what the venue actually runs.
//
// The failure being pinned is specific and has a bad shape: onboarding is read literally by
// people with no context, and it sits far away from the gates that decide what is live.
// Several contracts in constants.ts are the zero address ON PURPOSE, and their pages render
// placeholders. A welcome flow that routes a first-timer at one of those, or merely names it
// in a paragraph, has promised a feature the venue does not have — with better production
// values than any other surface, because a first-run flow is where the reader trusts most.
//
// Three pins:
//   1. Every action a step offers passes the SAME liveness predicate its destination page
//      reads. Not a hardcoded list — the predicate itself.
//   2. No dark surface is named in prose either. A paragraph is a promise without a link.
//   3. No return-language. Nothing in this flow may say guaranteed, risk-free, APY, or
//      passive income; and the risk step must actually state the risks, not gesture at them.

import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_SURFACES,
  liveSurfaces,
  onboardingSteps,
  type OnboardingStep,
} from './onboardingSteps';
import {
  AIRDROP_FACTORY_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
  LAUNCH_LOCK_VIEW_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  TEGRIDY_LOCK_VAULT_ADDRESS,
  TEGRIDY_PRO_PASS_ADDRESS,
  TEGRIDY_RESTAKING_ADDRESS,
  VESTING_FACTORY_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  isDeployed,
} from '../../lib/constants';

const steps = () => onboardingSteps();
const allCopy = (list: OnboardingStep[] = steps()) =>
  list.flatMap((s) => [s.title, ...s.body, ...s.actions.map((a) => `${a.label} ${a.blurb}`)]).join('\n').toLowerCase();

describe('the flow exists and is shaped like a flow', () => {
  it('has a funding step and a risk step, and only one of each', () => {
    const list = steps();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.filter((s) => s.showOnramp).length).toBe(1);
    expect(list.filter((s) => s.id === 'risks').length).toBe(1);
  });

  it('gives every step something to say', () => {
    for (const step of steps()) {
      expect(step.title.length, `step ${step.id} has no title`).toBeGreaterThan(0);
      expect(step.body.length, `step ${step.id} has no body`).toBeGreaterThan(0);
    }
  });

  it('places the risk disclosure before the last step, where a reader is still reading', () => {
    const list = steps();
    const riskIndex = list.findIndex((s) => s.id === 'risks');
    expect(riskIndex).toBeGreaterThanOrEqual(0);
    expect(riskIndex).toBeLessThan(list.length - 1);
  });
});

describe('every destination is live, by its own gate', () => {
  it('routes only to surfaces whose predicate says they are running', () => {
    for (const step of steps()) {
      for (const action of step.actions) {
        expect(action.isLive(), `${step.id} routes at ${action.route}, which its own gate reports dark`).toBe(true);
      }
    }
  });

  it('keeps every route in-app — onboarding cannot send anyone off-site', () => {
    for (const surface of ONBOARDING_SURFACES) {
      expect(surface.route.startsWith('/'), `${surface.id} is not an in-app route`).toBe(true);
      expect(surface.route.startsWith('//')).toBe(false);
    }
  });

  it('drops a surface from the flow the moment its gate goes dark', () => {
    const live = new Set(liveSurfaces().map((s) => s.id));
    const dark = ONBOARDING_SURFACES.filter((s) => !live.has(s.id));
    const routed = new Set(steps().flatMap((s) => s.actions.map((a) => a.id)));
    for (const surface of dark) {
      expect(routed.has(surface.id), `${surface.id} is dark but still routed`).toBe(false);
    }
  });

  it('offers at least one first move — an empty last step would be its own kind of lie', () => {
    const last = steps().at(-1);
    expect(last?.actions.length).toBeGreaterThan(0);
  });
});

describe('the copy names no surface this deployment does not run', () => {
  // Keyed to the contracts constants.ts deliberately zeroes. Read as: if this address is
  // NOT deployed, the word must not appear anywhere in the flow's copy. When a rail is
  // un-gated, its entry here stops applying automatically — this list does not need editing.
  const gated: { word: string; address: string }[] = [
    { word: 'restak', address: TEGRIDY_RESTAKING_ADDRESS },
    { word: 'gauge', address: GAUGE_CONTROLLER_ADDRESS },
    { word: 'bribe', address: VOTE_INCENTIVES_ADDRESS },
    { word: 'vote incentive', address: VOTE_INCENTIVES_ADDRESS },
    { word: 'grant', address: COMMUNITY_GRANTS_ADDRESS },
    { word: 'bounty', address: MEME_BOUNTY_BOARD_ADDRESS },
    { word: 'airdrop', address: AIRDROP_FACTORY_ADDRESS },
    { word: 'vesting', address: VESTING_FACTORY_ADDRESS },
    { word: 'lock vault', address: TEGRIDY_LOCK_VAULT_ADDRESS },
    { word: 'lock viewer', address: LAUNCH_LOCK_VIEW_ADDRESS },
    { word: 'pro pass', address: TEGRIDY_PRO_PASS_ADDRESS },
  ];

  it('is exercised against rails that really are dark (guards the guard)', () => {
    expect(gated.some((g) => !isDeployed(g.address))).toBe(true);
  });

  for (const { word, address } of gated) {
    it(`does not mention "${word}" while its contract is undeployed`, () => {
      if (isDeployed(address)) return;
      expect(allCopy()).not.toContain(word);
    });
  }
});

describe('no return language, anywhere', () => {
  const forbidden = [
    'guaranteed', 'guarantee', 'risk-free', 'riskless', 'no risk',
    'apy', 'apr', 'passive income', 'safe investment', 'get rich', 'to the moon',
  ];

  for (const phrase of forbidden) {
    it(`never says "${phrase}"`, () => {
      expect(allCopy()).not.toContain(phrase);
    });
  }

  it('quotes no figure at all — every number a user acts on is read by the page that owns it', () => {
    // Digits are allowed nowhere in the copy: a rate, a cap, a lock length or a fee written
    // here is a second source of truth that drifts the moment the chain or a dial moves.
    expect(allCopy()).not.toMatch(/\d/);
  });
});

describe('the risk step states risks, and does not merely gesture at them', () => {
  const riskCopy = () => {
    const step = steps().find((s) => s.id === 'risks');
    return (step ? [step.title, ...step.body].join('\n') : '').toLowerCase();
  };

  for (const required of ['experimental', 'permanent', 'zero', 'audit', 'penalty', 'placeholder']) {
    it(`says "${required}"`, () => {
      expect(riskCopy()).toContain(required);
    });
  }
});
