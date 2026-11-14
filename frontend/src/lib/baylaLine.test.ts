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
// The door is closed, as it is on the venue today (lib/launcher/door.ts): a test of the open door says so.
const base = (over: Partial<BaylaInputs> = {}): BaylaInputs => ({ reading: null, room: null, floor: 80, doorOpen: false, landed: null, slow: null, to: TO, ...over });
const BAYLA = { coin: 'BAYLA', solanaPool: true };

describe('baylaLine: every state, the island’s words', () => {
  it('no wallet, nothing pasted', () => {
    expect(baylaLine(base())).toEqual({ text: 'Your held time already has a number. Paste any wallet.', button: { label: 'Read heat', to: '/', move: 'read' }, sameMove: false });
  });
  it('a cold wallet opens Buy on the room’s coin', () => {
    expect(baylaLine(base({ reading: reading({ isCold: true, degrees: 0, tier: 'Drifter' }), room: BAYLA }))).toEqual({
      text: '0° today. Hold any island coin and your clock starts tonight.',
      button: { label: 'Start the clock', to: TO.buy, move: 'start' },
      sameMove: false,
    });
    // Zero degrees with rows is cold too: never "0.00° Drifter".
    expect(baylaLine(base({ reading: reading({ degrees: 0, tier: 'Drifter' }) })).text).toBe(BAYLA_LINES.cold);
  });
  it('warm, under the floor, in a room', () => {
    expect(baylaLine(base({ reading: reading(), room: BAYLA }))).toEqual({
      text: '12.34° Observer. Every day in this pool counts double.',
      button: { label: 'Add BAYLA', to: TO.pools, move: 'add' },
      sameMove: false,
    });
  });
  it('warm, under the floor, no room: the island’s days when served, else pick a bungalow', () => {
    expect(baylaLine(base({ reading: reading({ daysToPlant: 41 }) }))).toEqual({ text: '12.34° Observer. Resident in 41 days.', button: { label: 'Pick', to: '/#hall', move: 'pick' }, sameMove: false });
    expect(baylaLine(base({ reading: reading() }))).toEqual({ text: '12.34° Observer. Pick a bungalow and add to its pool.', button: { label: 'Pick', to: '/#hall', move: 'pick' }, sameMove: false });
    // Zero days served is not a countdown worth a sentence.
    expect(baylaLine(base({ reading: reading({ daysToPlant: 0 }) })).text).toBe('12.34° Observer. Pick a bungalow and add to its pool.');
  });
  it('a room on an EVM rail with no Solana pool reads as no room', () => {
    expect(baylaLine(base({ reading: reading(), room: { coin: 'PEPE', solanaPool: false } })).button.label).toBe('Pick');
  });
  it('at the floor and up, the door closed: the move that is live, never Launch (the owner, 2026-11-11)', () => {
    const warm = reading({ degrees: 80, tier: 'Resident', daysToPlant: 0 });
    expect(baylaLine(base({ reading: warm }))).toEqual({ text: '80.00° Resident. Pick a bungalow and add to its pool.', button: { label: 'Pick', to: '/#hall', move: 'pick' }, sameMove: false });
    expect(baylaLine(base({ reading: warm, room: BAYLA }))).toEqual({ text: '80.00° Resident. Every day in this pool counts double.', button: { label: 'Add BAYLA', to: TO.pools, move: 'add' }, sameMove: false });
    expect(baylaLine(base({ reading: reading({ degrees: 79.99, tier: 'Observer' }) })).button.label).toBe('Pick');
    // The owner's own screen: an Elder, on the home, in a room with a pool, and in a room with none.
    const elder = reading({ degrees: 1862.42, tier: 'Elder', daysToPlant: 0 });
    for (const room of [null, BAYLA, { coin: 'PEPE', solanaPool: false }]) {
      const line = baylaLine(base({ reading: elder, room }));
      expect(line.button.move, JSON.stringify(room)).not.toBe('launch');
      expect(line.button.label, JSON.stringify(room)).not.toBe('Launch');
      expect(line.text, JSON.stringify(room)).not.toMatch(/door|launch/i);
      expect(line.text.startsWith('1862.42° Elder. '), line.text).toBe(true);
    }
    // At the floor no days are left to count, whatever is served.
    expect(baylaLine(base({ reading: reading({ degrees: 80, tier: 'Resident', daysToPlant: 3 }) })).text).toBe('80.00° Resident. Pick a bungalow and add to its pool.');
  });
  it('at the floor and up, the door open: Launch, or Add in a room', () => {
    const warm = reading({ degrees: 80, tier: 'Resident' });
    expect(baylaLine(base({ reading: warm, doorOpen: true }))).toEqual({ text: "80.00° Resident. Warm enough. The door opens on the island's word.", button: { label: 'Launch', to: '/launch', move: 'launch' }, sameMove: false });
    expect(baylaLine(base({ reading: warm, room: BAYLA, doorOpen: true })).button).toEqual({ label: 'Add BAYLA', to: TO.pools, move: 'add' });
    // Under the floor an open door changes nothing.
    expect(baylaLine(base({ reading: reading({ degrees: 79.99, tier: 'Observer' }), doorOpen: true })).button.label).toBe('Pick');
  });
  it('the outside price not read, in a room: the pool’s own price and its age, adding stays open', () => {
    expect(baylaLine(base({ reading: reading(), room: BAYLA, slow: { price: '0.00000474 SOL', age: '3 min' } }))).toEqual({
      text: "Jupiter is slow. The pool's own price is 0.00000474 SOL, read 3 min ago. Adding stays open.",
      button: { label: 'Add BAYLA', to: TO.pools, move: 'add' },
      sameMove: false,
    });
    // Out of a room there is no pool to speak of: the wallet's own line.
    expect(baylaLine(base({ reading: reading(), slow: { price: 'x', age: 'y' } })).text).toBe('12.34° Observer. Pick a bungalow and add to its pool.');
  });
  it('after a trade or an add', () => {
    for (const landed of ['trade', 'add'] as const) {
      expect(baylaLine(base({ reading: reading(), room: BAYLA, landed }))).toEqual({ text: 'Done. Your fee went to the island. Read it.', button: { label: 'Receipt', to: '/dashboard', move: 'receipt' }, sameMove: false });
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

// One green button per screen (island answer twenty-five, §2): the rule is the screen's (answer
// twenty-eight, §2.2). Wherever the screen draws its own green button her line's button goes
// quiet, whatever move it makes; one row per state.
describe('sameMove: her button goes quiet wherever the screen draws its own green button', () => {
  const cold = reading({ isCold: true, degrees: 0, tier: 'Drifter' });
  it.each([
    ['the countdown or the Buy sheet, a cold wallet', base({ reading: cold, room: BAYLA, screenMove: 'start' }), true],
    ['the Add sheet, a warm wallet in the room', base({ reading: reading(), room: BAYLA, screenMove: 'add' }), true],
    ['the Add sheet, Jupiter slow in the room', base({ reading: reading(), room: BAYLA, slow: { price: '0.001 SOL', age: '4 min' }, screenMove: 'add' }), true],
    ['the receipt card, after a trade', base({ reading: reading(), room: BAYLA, landed: 'trade', screenMove: 'receipt' }), true],
    ['the receipt card, after an add', base({ landed: 'add', screenMove: 'receipt' }), true],
    ['the countdown, a warm wallet in the room: her Add, another move', base({ reading: reading(), room: BAYLA, screenMove: 'start' }), true],
    ['the home after a read, under the floor: her Pick, another move', base({ reading: reading({ daysToPlant: 102 }), screenMove: 'start' }), true],
    ['the Add sheet, a cold wallet: her Start the clock, another move', base({ reading: cold, room: BAYLA, screenMove: 'add' }), true],
    ['the countdown, no wallet read', base({ screenMove: 'start' }), true],
    ['the countdown, a Resident: her Pick, another move', base({ reading: reading({ degrees: 90, tier: 'Resident' }), screenMove: 'start' }), true],
    ['a screen with no green button of its own', base({ reading: cold, room: BAYLA }), false],
    ['a screen that says null', base({ reading: cold, room: BAYLA, screenMove: null }), false],
    ['the sheet, a stranger: her Read heat is under its veil', base({ screenMove: 'sheet' }), true],
    ['the sheet, a cold wallet', base({ reading: cold, room: BAYLA, screenMove: 'sheet' }), true],
    ['the sheet, a Resident with no room: her Pick', base({ reading: reading({ degrees: 90, tier: 'Resident' }), screenMove: 'sheet' }), true],
  ] as const)('%s', (_name, inputs, quiet) => {
    expect(baylaLine(inputs).sameMove).toBe(quiet);
  });
  it('a quiet button keeps its words and its press: the same move, drawn quiet', () => {
    const loud = baylaLine(base({ reading: reading(), room: BAYLA }));
    const quiet = baylaLine(base({ reading: reading(), room: BAYLA, screenMove: 'add' }));
    expect(quiet.text).toBe(loud.text);
    expect(quiet.button).toEqual(loud.button);
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

describe('the door is not open yet (island answer twenty-six)', () => {
  const cold = reading({ isCold: true, degrees: 0, tier: 'Drifter' });

  it('never prints Drifter: under Observer the degrees stand alone', () => {
    const low = reading({ degrees: 12.34, tier: 'Drifter' });
    expect(baylaLine(base({ reading: low, room: BAYLA })).text).toBe('12.34°. Every day in this pool counts double.');
    expect(baylaLine(base({ reading: low })).text).toBe('12.34°. Pick a bungalow and add to its pool.');
    expect(baylaLine(base({ reading: reading({ degrees: 12.34, tier: 'Drifter', daysToPlant: 41 }) })).text).toBe('12.34°. Resident in 41 days.');
  });

  it('says “1 day” at one, in the singular, on the home and on the door (answer twenty-eight, §2.1)', () => {
    const one = reading({ degrees: 79.33, tier: 'Observer', daysToPlant: 1 });
    expect(baylaLine(base({ reading: one })).text).toBe('79.33° Observer. Resident in 1 day.');
    expect(baylaLine(base({ reading: one, screenMove: 'door' })).text).toBe('79.33°. Resident in 1 day.');
  });

  it('never says the door is open, and off the door’s own screen does not speak of it (the owner, 2026-11-11)', () => {
    for (const room of [null, BAYLA]) {
      const off = baylaLine(base({ reading: reading({ degrees: 120, tier: 'Resident' }), room }));
      expect(off.text).not.toMatch(/open to you|lane is open|door|launch/i);
      expect(off.button.move).not.toBe('launch');
      const on = baylaLine(base({ reading: reading({ degrees: 120, tier: 'Resident' }), room, screenMove: 'door' }));
      expect(on.text).toBe("120.00° Resident. Warm enough. The door opens on the island's word.");
    }
  });

  it.each([
    ['a stranger', base({ screenMove: 'door' }), BAYLA_LINES.noWallet],
    ['a cold wallet', base({ reading: cold, room: BAYLA, screenMove: 'door' }), '0° today. Hold any island coin and your clock starts tonight.'],
    ['under the floor with days served', base({ reading: reading({ degrees: 41.2, tier: 'Observer', daysToPlant: 41 }), screenMove: 'door' }), '41.20°. Resident in 41 days.'],
    ['under the floor with none', base({ reading: reading({ degrees: 41.2, tier: 'Observer' }), room: BAYLA, screenMove: 'door' }), '41.20°. Every held day counts toward the door.'],
    ['at the floor and up', base({ reading: reading({ degrees: 80, tier: 'Resident' }), screenMove: 'door' }), "80.00° Resident. Warm enough. The door opens on the island's word."],
  ] as const)('on the launch door, %s: the door words, and her button quiet', (_name, inputs, text) => {
    const line = baylaLine(inputs);
    expect(line.text).toBe(text);
    expect(line.sameMove).toBe(true);
  });

  // Her quiet button makes the screen's own move (answer twenty-six, §2.7): never Launch, the page
  // she is on, beside "Warm enough" on a door that says it is not open.
  it.each([
    ['a cold wallet', base({ reading: cold, room: BAYLA, screenMove: 'door' }), { label: 'Start the clock', to: TO.buy, move: 'start' }],
    ['under the floor', base({ reading: reading({ degrees: 41.2, tier: 'Observer', daysToPlant: 41 }), screenMove: 'door' }), { label: 'Start the clock', to: TO.buy, move: 'start' }],
    ['under the floor in a room', base({ reading: reading({ degrees: 41.2, tier: 'Observer' }), room: BAYLA, screenMove: 'door' }), { label: 'Start the clock', to: TO.buy, move: 'start' }],
    ['at the floor and up in a room', base({ reading: reading({ degrees: 92, tier: 'Resident' }), room: BAYLA, screenMove: 'door' }), { label: 'Add BAYLA', to: TO.pools, move: 'add' }],
    ['at the floor and up outside one', base({ reading: reading({ degrees: 92, tier: 'Resident' }), screenMove: 'door' }), { label: 'Pick', to: TO.pools, move: 'pick' }],
  ] as const)('on the launch door, %s: her button is the screen move', (_name, inputs, button) => {
    expect(baylaLine(inputs).button).toEqual(button);
  });
});
