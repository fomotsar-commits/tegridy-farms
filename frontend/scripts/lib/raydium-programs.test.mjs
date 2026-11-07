// @vitest-environment node
//
// The price keeper's own list of Raydium's programs, refused whatever Jupiter's venue list says.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { RAYDIUM_PROGRAMS } from './raydium-programs.mjs';

describe('RAYDIUM_PROGRAMS', () => {
  it('names Raydium’s four programs, each a whole address, and cannot be changed at run time', () => {
    expect(RAYDIUM_PROGRAMS).toHaveLength(4);
    for (const id of RAYDIUM_PROGRAMS) expect(new PublicKey(id).toBase58()).toBe(id);
    expect(Object.isFrozen(RAYDIUM_PROGRAMS)).toBe(true);
  });
});
