// Island answer twenty-four, build 4: the table test, every state of Bayla's line.
import { describe, it, expect } from 'vitest';
import { baylaLine, intelLine, type BaylaInputs } from './baylaLine';
import { BAYLA_LINES } from './arrival';
import type { HeatReading } from './heat/heatOracle';

const TO = { pools: '/pools?mint=7hmV', buy: '/solana?out=7hmV', launch: '/launch', read: '/', pick: '/#hall', receipt: '/dashboard' };

function reading(over: Partial<HeatReading> = {}): HeatReading {
  return {
    address: '0x1111111111111111111111111111111111111111',
    degrees: 12.34,
    tier: 'Observer',
    isCold: false,
    heldSinceUnix: 1_700_000_000,
    asOfUnix: 1_762_000_000,
    tokenCount: 2,
    breakdown: [],
    observedAt: 1_762_000_000,
    xHandle: null,
    daysToNextTier: null,
    daysToPlant: null,
    ...over,
  };
}
const base = (over: Partial<BaylaInputs> = {}): BaylaInputs => ({ reading: null, room: null, floor: 80, landed: null, slow: null, to: TO, ...over });
const BAYLA = { coin: 'BAYLA', solanaPool: true };

describe('baylaLine: every state, the island’s words', () => {
  it('no wallet, nothing pasted', () => {
    expect(baylaLine(base())).toEqual({ text: 'Your held time already has a number. Paste any wallet.', button: { label: 'Read heat', to: '/' } });
  });
  it('a cold wallet opens Buy on the room’s coin', () => {
    expect(baylaLine(base({ reading: reading({ isCold: true, degrees: 0, tier: 'Drifter' }), room: BAYLA }))).toEqual({
      text: '0° today. Hold any island coin and your clock starts tonight.',
      button: { label: 'Start the clock', to: TO.buy },
    });
    // Zero degrees with rows is cold too: never "0.00° Drifter".
    expect(baylaLine(base({ reading: reading({ degrees: 0, tier: 'Drifter' }) })).text).toBe(BAYLA_LINES.cold);
  });
  it('warm, under the floor, in a room', () => {
    expect(baylaLine(base({ reading: reading(), room: BAYLA }))).toEqual({
      text: '12.34° Observer. Every day in this pool counts double.',
      button: { label: 'Add BAYLA', to: TO.pools },
    });
  });
  it('warm, under the floor, no room: the island’s days when served, else pick a bungalow', () => {
    expect(baylaLine(base({ reading: reading({ daysToPlant: 41 }) }))).toEqual({ text: '12.34° Observer. Resident in 41 days.', button: { label: 'Pick', to: '/#hall' } });
    expect(baylaLine(base({ reading: reading() }))).toEqual({ text: '12.34° Observer. Pick a bungalow and add to its pool.', button: { label: 'Pick', to: '/#hall' } });
    // Zero days served is not a countdown worth a sentence.
    expect(baylaLine(base({ reading: reading({ daysToPlant: 0 }) })).text).toBe('12.34° Observer. Pick a bungalow and add to its pool.');
  });
  it('a room on an EVM rail with no Solana pool reads as no room', () => {
    expect(baylaLine(base({ reading: reading(), room: { coin: 'PEPE', solanaPool: false } })).button.label).toBe('Pick');
  });
  it('at the floor and up: Launch, or Add in a room', () => {
    const warm = reading({ degrees: 80, tier: 'Resident' });
    expect(baylaLine(base({ reading: warm }))).toEqual({ text: '80.00° Resident. The launch door is open to you.', button: { label: 'Launch', to: '/launch' } });
    expect(baylaLine(base({ reading: warm, room: BAYLA })).button).toEqual({ label: 'Add BAYLA', to: TO.pools });
    expect(baylaLine(base({ reading: reading({ degrees: 79.99, tier: 'Observer' }) })).button.label).toBe('Pick');
  });
  it('the outside price not read, in a room: the pool’s own price and its age, adding stays open', () => {
    expect(baylaLine(base({ reading: reading(), room: BAYLA, slow: { price: '0.00000474 SOL', age: '3 min' } }))).toEqual({
      text: "Jupiter is slow. The pool's own price is 0.00000474 SOL, read 3 min ago. Adding stays open.",
      button: { label: 'Add BAYLA', to: TO.pools },
    });
    // Out of a room there is no pool to speak of: the wallet's own line.
    expect(baylaLine(base({ reading: reading(), slow: { price: 'x', age: 'y' } })).text).toBe('12.34° Observer. Pick a bungalow and add to its pool.');
  });
  it('after a trade or an add', () => {
    for (const landed of ['trade', 'add'] as const) {
      expect(baylaLine(base({ reading: reading(), room: BAYLA, landed }))).toEqual({ text: 'Done. Your fee went to the island. Read it.', button: { label: 'Receipt', to: '/dashboard' } });
    }
  });
  it('every line is one or two sentences and never a paragraph', () => {
    const all = [
      baylaLine(base()),
      baylaLine(base({ reading: reading({ isCold: true, degrees: 0, tier: 'Drifter' }) })),
      baylaLine(base({ reading: reading(), room: BAYLA })),
      baylaLine(base({ reading: reading({ daysToPlant: 3 }) })),
      baylaLine(base({ reading: reading({ degrees: 90, tier: 'Resident' }) })),
      baylaLine(base({ reading: reading(), room: BAYLA, slow: { price: '0.001 SOL', age: '4 min' } })),
      baylaLine(base({ landed: 'add' })),
    ];
    for (const l of all) {
      expect(l.text.split(/[.!?]\s/).length, l.text).toBeLessThanOrEqual(3);
      expect(l.text.length, l.text).toBeLessThan(110);
      expect(l.text).not.toMatch(/—/);
    }
  });
});

describe('the intel line: a fact read, never a zero', () => {
  it('names the fire’s week', () => {
    expect(intelLine({ burned: 339866 })).toBe('The fire took 339,866 $BAYLA this week.');
  });
  it('is left out when unread or zero', () => {
    expect(intelLine(null)).toBeNull();
    expect(intelLine({ burned: 0 })).toBeNull();
    expect(intelLine({ burned: Number.NaN })).toBeNull();
  });
});
