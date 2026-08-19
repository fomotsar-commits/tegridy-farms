// The execution fee.
//
// One dial, inherited: if lib/fees/swapFee.ts says off, this says off. What is
// pinned here beyond that is the published rate acting as a CEILING — an operator
// who sets the swap surface's higher rate has not thereby raised what a triggered
// order pays — and the zero state naming WHICH zero it is. "We turned the fee off",
// "nothing executes these yet" and "we cannot attach a fee to a CoW order" are three
// different facts, and a surface that renders them all as a bare 0 has told the user
// nothing they can act on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TRIGGER_EXECUTION_FEE_BPS,
  triggerExecutionFee,
  triggerFeeDisclosure,
} from './triggerFee';
import { PROVIDER_FEE_LEGS } from '../fees/swapFee';

const RECIPIENT = '0x6d5791A660e79175F74C6D639584C98422d5956E';

function enableFee(bps: string) {
  vi.stubEnv('VITE_SWAP_FEE_BPS', bps);
  vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('the published rate', () => {
  it('is the 0.1% the plan published', () => {
    expect(TRIGGER_EXECUTION_FEE_BPS).toBe(10);
  });
});

describe('it inherits the swap-fee dial rather than adding a second one', () => {
  it('charges nothing with the dial off, and says the dial is off', () => {
    const fee = triggerExecutionFee('safe-composable-cow');
    expect(fee.charged).toBe(false);
    expect(fee.bps).toBe(0);
    if (!fee.charged) expect(fee.reason).toMatch(/switched off/i);
  });

  it('charges nothing with a rate but no recipient', () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    expect(triggerExecutionFee('safe-composable-cow').charged).toBe(false);
  });

  it('charges nothing with a recipient but no rate', () => {
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    expect(triggerExecutionFee('safe-composable-cow').charged).toBe(false);
  });
});

describe('nothing is charged for an order nothing executes', () => {
  it('the keeper path charges nothing even with the dial fully on', () => {
    enableFee('25');
    const fee = triggerExecutionFee('keeper');
    expect(fee.charged).toBe(false);
    if (!fee.charged) expect(fee.reason).toMatch(/no keeper/i);
  });
});

describe('the CoW leg is withheld, and the zero says which zero it is', () => {
  it('reports the blocked leg’s own reason rather than a bare zero', () => {
    enableFee('25');
    const fee = triggerExecutionFee('safe-composable-cow');
    // The CoW leg is `blocked` in the policy table; that is the fact under test.
    expect(PROVIDER_FEE_LEGS.cowswap.status).toBe('blocked');
    expect(fee.charged).toBe(false);
    if (!fee.charged) expect(fee.reason).toMatch(/appData|partner-fee|hash/i);
  });

  it('caps the charge at the published rate when the leg does become ready', () => {
    // Exercised through the same code path the leg would take, by swapping the leg
    // in place: this pins the ceiling rule, not the current blocked status.
    const original = PROVIDER_FEE_LEGS.cowswap;
    try {
      (PROVIDER_FEE_LEGS as Record<string, unknown>).cowswap = {
        status: 'ready',
        params: ['partnerFeeBps'],
        query: (p: { bps: number; recipient: string }) => ({ partnerFeeBps: String(p.bps) }),
      };
      enableFee('25'); // the swap surface's rate, well above the trigger schedule
      const fee = triggerExecutionFee('safe-composable-cow');
      expect(fee.charged).toBe(true);
      if (fee.charged) {
        expect(fee.bps).toBe(TRIGGER_EXECUTION_FEE_BPS);
        // What is displayed is what would be sent.
        expect(fee.params.partnerFeeBps).toBe(String(TRIGGER_EXECUTION_FEE_BPS));
        expect(fee.recipient).toBe(RECIPIENT);
      }
    } finally {
      (PROVIDER_FEE_LEGS as Record<string, unknown>).cowswap = original;
    }
  });

  it('lets a dial BELOW the published rate lower the charge', () => {
    const original = PROVIDER_FEE_LEGS.cowswap;
    try {
      (PROVIDER_FEE_LEGS as Record<string, unknown>).cowswap = {
        status: 'ready',
        params: ['partnerFeeBps'],
        query: (p: { bps: number; recipient: string }) => ({ partnerFeeBps: String(p.bps) }),
      };
      enableFee('4');
      const fee = triggerExecutionFee('safe-composable-cow');
      expect(fee.charged).toBe(true);
      if (fee.charged) expect(fee.bps).toBe(4);
    } finally {
      (PROVIDER_FEE_LEGS as Record<string, unknown>).cowswap = original;
    }
  });
});

describe('the disclosure never reads as "free"', () => {
  it('renders None, not a zero percentage', () => {
    const d = triggerFeeDisclosure('keeper');
    expect(d.value).toBe('None');
    expect(d.value).not.toMatch(/0\s*%/);
  });

  it('still states the published rate so the schedule is not a surprise later', () => {
    expect(triggerFeeDisclosure('keeper').note).toContain('0.1%');
  });

  it('says an untriggered order costs nothing', () => {
    expect(triggerFeeDisclosure('keeper').note).toMatch(/only when an order actually fills/i);
  });

  it('names the costs this figure does NOT cover', () => {
    for (const path of ['keeper', 'safe-composable-cow'] as const) {
      const note = triggerFeeDisclosure(path).note;
      expect(note).toMatch(/solver/i);
      expect(note).toMatch(/pool/i);
      expect(note).toMatch(/gas/i);
    }
  });
});
