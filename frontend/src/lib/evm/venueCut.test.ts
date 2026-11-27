import { describe, expect, it } from 'vitest';
import { hopsOf, readRouteCut, routeCutOf, venueCutOf } from './venueCut';

const FACTORY = '0xfac0000000000000000000000000000000000001' as const;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const W = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const PAIR_AW = '0x00000000000000000000000000000000000000a1';
const PAIR_WB = '0x00000000000000000000000000000000000000b2';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('venueCutOf', () => {
  it('reads kLast: non-zero is on, 0 is off, anything else did not land', () => {
    expect(venueCutOf(1n)).toBe('on');
    expect(venueCutOf(0n)).toBe('off');
    for (const unread of [null, undefined, '7', 7]) expect(venueCutOf(unread)).toBe('unread');
  });
});

describe('routeCutOf', () => {
  it('is on only when every pool is on; one off pool makes it off; else one unread makes it unread', () => {
    expect(routeCutOf(['on', 'on'])).toBe('on');
    expect(routeCutOf(['on', 'off'])).toBe('off');
    expect(routeCutOf(['unread', 'off'])).toBe('off');
    expect(routeCutOf(['on', 'unread'])).toBe('unread');
    expect(routeCutOf([])).toBe('unread');
  });
});

describe('readRouteCut', () => {
  /** A chain: getPair by its two tokens, kLast by pair; a missing answer throws as a revert would. */
  function chain(answers: Record<string, unknown>) {
    return {
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
        const key = `${address}:${functionName}:${(args ?? []).join(',')}`;
        if (!(key in answers)) throw new Error('execution reverted');
        return answers[key];
      },
    };
  }
  const both = (aw: unknown, wb: unknown) => chain({
    [`${FACTORY}:getPair:${A},${W}`]: PAIR_AW,
    [`${FACTORY}:getPair:${W},${B}`]: PAIR_WB,
    ...(aw === undefined ? {} : { [`${PAIR_AW}:kLast:`]: aw }),
    ...(wb === undefined ? {} : { [`${PAIR_WB}:kLast:`]: wb }),
  });

  it('reads one pool per hop', async () => {
    expect(hopsOf([A, W, B])).toEqual([[A, W], [W, B]]);
    expect(await readRouteCut(both(5n, 6n), FACTORY, [A, W, B])).toBe('on');
  });

  it('is off when any pool on the path has its cut off, or there is no pool', async () => {
    expect(await readRouteCut(both(5n, 0n), FACTORY, [A, W, B])).toBe('off');
    expect(await readRouteCut(chain({ [`${FACTORY}:getPair:${A},${W}`]: ZERO }), FACTORY, [A, W])).toBe('off');
  });

  it('is unread, never on, when a kLast or getPair read fails', async () => {
    expect(await readRouteCut(both(5n, undefined), FACTORY, [A, W, B])).toBe('unread');
    expect(await readRouteCut(chain({}), FACTORY, [A, W])).toBe('unread');
    expect(await readRouteCut(chain({ [`${FACTORY}:getPair:${A},${W}`]: 'nonsense' }), FACTORY, [A, W])).toBe('unread');
  });
});
