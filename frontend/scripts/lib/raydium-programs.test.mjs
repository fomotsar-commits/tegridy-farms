// @vitest-environment node
//
// The price keeper's own list of Raydium's programs, refused whatever Jupiter's venue list says.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { RAYDIUM_AMM_V4, RAYDIUM_AMM_V4_AUTHORITY, RAYDIUM_CPMM, RAYDIUM_PROGRAMS } from './raydium-programs.mjs';

describe('RAYDIUM_PROGRAMS', () => {
  it('names Raydium’s four programs, each a whole address, and cannot be changed at run time', () => {
    expect(RAYDIUM_PROGRAMS).toHaveLength(4);
    for (const id of RAYDIUM_PROGRAMS) expect(new PublicKey(id).toBase58()).toBe(id);
    expect(Object.isFrozen(RAYDIUM_PROGRAMS)).toBe(true);
  });
});

describe('the programs the robot builds swaps for (keeper/directLegs.ts takes them as inputs)', () => {
  it('are two of the four, and the AMM v4 authority is its PDA ["amm authority"]', () => {
    expect(RAYDIUM_PROGRAMS).toContain(RAYDIUM_CPMM);
    expect(RAYDIUM_PROGRAMS).toContain(RAYDIUM_AMM_V4);
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('amm authority')], new PublicKey(RAYDIUM_AMM_V4));
    expect(authority.toBase58()).toBe(RAYDIUM_AMM_V4_AUTHORITY);
  });
});
