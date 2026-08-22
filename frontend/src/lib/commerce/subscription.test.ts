import { describe, it, expect } from 'vitest';
import {
  allowanceForPeriods,
  chargeVerdict,
  periodStart,
  pullTrustNotice,
  pushLapseNotice,
  renewalNotice,
  type Subscription,
} from './subscription';

const MONTH = 30 * 86_400;
const START = 1_760_000_000;

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    payer: '0x2222222222222222222222222222222222222222',
    merchant: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    amountPerPeriod: 10_000_000n,
    periodSeconds: MONTH,
    startedAt: START,
    periodsCharged: 0,
    periodsAgreed: null,
    initiator: 'merchant-pull',
    cancelledAt: null,
    ...over,
  };
}

const RICH = { allowance: 120_000_000n, balance: 500_000_000n };

describe('nothing fires on its own, and every verdict says so', () => {
  it('returns `due` and never anything that reads as "charged"', () => {
    const state = chargeVerdict(sub(), START, RICH);
    expect(state.verdict).toBe('due');
    expect(state.detail).toMatch(/Nothing charges this automatically/i);
  });

  it('says the same for the push shape, where the payer is the one who acts', () => {
    const state = chargeVerdict(sub({ initiator: 'payer-push' }), START, RICH);
    expect(state.verdict).toBe('due');
    expect(state.detail).toMatch(/payer has to sign/i);
  });

  it('states the no-keeper fact even while a period is paid', () => {
    const state = chargeVerdict(sub({ periodsCharged: 1 }), START + 10, RICH);
    expect(state.verdict).toBe('not-due');
    expect(state.detail).toMatch(/runs no keeper/i);
  });

  it('never presents either shape as auto-renewing', () => {
    expect(renewalNotice(sub())).toMatch(/does not renew on its own/i);
    expect(renewalNotice(sub({ initiator: 'payer-push' }))).toMatch(/does not renew on its own/i);
  });
});

describe('period arithmetic anchors to the start, so a late charge cannot shorten the year', () => {
  it('spaces periods at a fixed interval from startedAt', () => {
    const s = sub();
    expect(periodStart(s, 0)).toBe(START);
    expect(periodStart(s, 12)).toBe(START + 12 * MONTH);
  });

  it('counts periods that opened and were never charged', () => {
    // Three periods have opened; one was charged. Two behind, one of which is
    // the one now due, so one is "missed".
    const state = chargeVerdict(sub({ periodsCharged: 1 }), START + 2 * MONTH + 5, RICH);
    expect(state.verdict).toBe('due');
    expect(state.missedPeriods).toBe(1);
    expect(state.nextChargeAt).toBe(START + MONTH);
  });

  it('reports no arrears while up to date', () => {
    expect(chargeVerdict(sub({ periodsCharged: 3 }), START + 2 * MONTH, RICH).missedPeriods).toBe(0);
  });
});

describe('the allowance is the only cap, and the surface is made to say it', () => {
  it('reports how many whole periods the standing allowance still covers', () => {
    const state = chargeVerdict(sub(), START, { allowance: 35_000_000n, balance: 500_000_000n });
    expect(state.periodsCoveredByAllowance).toBe(3);
  });

  it('reports no allowance coverage at all for the push shape, where none exists', () => {
    const state = chargeVerdict(sub({ initiator: 'payer-push' }), START, RICH);
    expect(state.periodsCoveredByAllowance).toBeNull();
  });

  it('blocks a pull charge the allowance cannot cover', () => {
    const state = chargeVerdict(sub(), START, { allowance: 1n, balance: 500_000_000n });
    expect(state.verdict).toBe('allowance-short');
  });

  it('does not block a push charge on an allowance, which governs nothing there', () => {
    const state = chargeVerdict(sub({ initiator: 'payer-push' }), START, { allowance: 0n, balance: 500_000_000n });
    expect(state.verdict).toBe('due');
  });

  it('blocks a charge the payer cannot fund, so nobody burns gas on a revert', () => {
    expect(chargeVerdict(sub(), START, { allowance: 120_000_000n, balance: 1n }).verdict).toBe('balance-short');
  });

  it('offers no unlimited allowance', () => {
    expect(allowanceForPeriods(sub(), 12)).toBe(120_000_000n);
    expect(allowanceForPeriods(sub(), 0)).toBeNull();
    expect(allowanceForPeriods(sub(), 10_000)).toBeNull();
  });

  it('warns that no contract enforces the schedule', () => {
    const notice = pullTrustNotice(sub(), 12);
    expect(notice).toMatch(/No contract enforces the schedule/i);
    expect(notice).toMatch(/all of it being taken at once/i);
    expect(notice).toMatch(/12/);
  });

  it('warns the push payer about lapsing rather than about theft', () => {
    const notice = pushLapseNotice(sub({ initiator: 'payer-push' }));
    expect(notice).toMatch(/simply lapses/i);
    expect(notice).toMatch(/without you signing/i);
  });
});

describe('lifecycle ends', () => {
  it('says a cancelled pull is not cancelled until the allowance is revoked', () => {
    const state = chargeVerdict(sub({ cancelledAt: START + 5 }), START + 10, RICH);
    expect(state.verdict).toBe('cancelled');
    expect(state.detail).toMatch(/until the allowance is revoked/i);
  });

  it('completes at the agreed period count', () => {
    const state = chargeVerdict(sub({ periodsAgreed: 3, periodsCharged: 3 }), START + 10 * MONTH, RICH);
    expect(state.verdict).toBe('completed');
    expect(state.nextChargeAt).toBeNull();
  });

  it('refuses to evaluate a malformed subscription rather than guessing', () => {
    expect(chargeVerdict(sub({ amountPerPeriod: 0n }), START, RICH).verdict).toBe('invalid');
    expect(chargeVerdict(sub({ periodSeconds: 60 }), START, RICH).verdict).toBe('invalid');
  });
});
