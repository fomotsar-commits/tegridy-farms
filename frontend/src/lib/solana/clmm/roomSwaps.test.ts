import { describe, expect, it } from 'vitest';
import type { ParsedTx, SigEntry } from '../lp/txHistory';
import { classifyRoomSwap } from './roomSwaps';

const pool = { tokenVault0: 'V0', tokenVault1: 'V1' };
const sig = (err: unknown = null): SigEntry => ({ signature: 'sig', slot: 7, blockTime: 1_700_000_000, err, confirmationStatus: 'finalized' });

/** A transaction in which vault 0 changes by `d0` and vault 1 by `d1`. */
function tx(d0: bigint, d1: bigint, err: unknown = null): ParsedTx {
  const bal = (accountIndex: number, amount: bigint) => ({ accountIndex, mint: 'm', owner: 'pool', amount });
  return {
    signature: 'sig',
    slot: 7,
    blockTime: 1_700_000_000,
    err,
    keys: ['payer', 'V0', 'V1'],
    signers: ['payer'],
    instructions: [],
    inner: [],
    pre: [bal(1, 1_000n), bal(2, 1_000n)],
    post: [bal(1, 1_000n + d0), bal(2, 1_000n + d1)],
    preLamports: [],
    postLamports: [],
  };
}

describe('classifyRoomSwap', () => {
  it('reads a swap by which vault gained: the token in is a sell', () => {
    expect(classifyRoomSwap(sig(), tx(40n, -3n), pool, { tokenIsToken0: true })).toEqual({ signature: 'sig', slot: 7, blockTime: 1_700_000_000, inSide: 'token', inAmount: 40n });
  });

  it('reads the pairing coin in as a buy, whichever side of the pool it is', () => {
    expect(classifyRoomSwap(sig(), tx(-40n, 3n), pool, { tokenIsToken0: true })).toMatchObject({ inSide: 'coin', inAmount: 3n });
    expect(classifyRoomSwap(sig(), tx(40n, -3n), pool, { tokenIsToken0: false })).toMatchObject({ inSide: 'coin', inAmount: 40n });
    expect(classifyRoomSwap(sig(), tx(-40n, 3n), pool, { tokenIsToken0: false })).toMatchObject({ inSide: 'token', inAmount: 3n });
  });

  it('is not a swap when both vaults fill (a deposit) or both drain (a withdrawal, a collection)', () => {
    expect(classifyRoomSwap(sig(), tx(40n, 3n), pool, { tokenIsToken0: true })).toBeNull();
    expect(classifyRoomSwap(sig(), tx(-40n, -3n), pool, { tokenIsToken0: true })).toBeNull();
    expect(classifyRoomSwap(sig(), tx(40n, 0n), pool, { tokenIsToken0: true })).toBeNull();
    expect(classifyRoomSwap(sig(), tx(0n, 0n), pool, { tokenIsToken0: true })).toBeNull();
  });

  it('never draws a failed transaction or one that was not read', () => {
    expect(classifyRoomSwap(sig({ InstructionError: [0, 'Custom'] }), tx(40n, -3n), pool, { tokenIsToken0: true })).toBeNull();
    expect(classifyRoomSwap(sig(), tx(40n, -3n, { InstructionError: [0, 'Custom'] }), pool, { tokenIsToken0: true })).toBeNull();
    expect(classifyRoomSwap(sig(), null, pool, { tokenIsToken0: true })).toBeNull();
  });
});
