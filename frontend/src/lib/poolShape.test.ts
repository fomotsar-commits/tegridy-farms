// @vitest-environment node
//
// What the venue's front-door table is allowed to say about a pool it has not read.
//
// Two separate risks, one file:
//
//  1. NAMING THE WRONG PROGRAM. A Solana row used to return "Streamflow" from `chain`
//     alone. Once a bungalow can also carry a `ladderPool` that is a claim about
//     which program holds someone's money, made without looking.
//
//  2. THE TWO BOOST TABLES DRIFTING APART. This component derives its ladder
//     endpoints from lib/constants (the EVM contract's), while the Solana card
//     derives its own from lib/ladder/program. They are equal today by coincidence
//     and nothing enforced it — so a re-tune of either would leave the venue table
//     quoting the other rail's numbers, silently. VenuePoolIndex cannot import the
//     ladder module (it would pull @solana/web3.js into a chunk that
//     check-dist-graph.mjs keeps clean), so the parity is pinned HERE instead, where
//     importing both costs nothing.
import { describe, it, expect } from 'vitest';
import { poolShape } from './poolShape';
import { MIN_BOOST_BPS as EVM_MIN, MAX_BOOST_BPS as EVM_MAX } from './constants';
import {
  MIN_BOOST_BPS as SOL_MIN, MAX_BOOST_BPS as SOL_MAX,
  MIN_LOCK_SECS, MAX_LOCK_SECS,
} from './ladder/program';

describe('poolShape names the program, never guesses it', () => {
  it('a Solana bungalow with only a Streamflow pool is Streamflow', () => {
    expect(poolShape({ chain: 'solana', stakePool: 'POOL' })).toBe('Streamflow');
  });

  it('a Solana bungalow with only a ladder pool states the ladder terms', () => {
    const s = poolShape({ chain: 'solana', ladderPool: 'LADDER' });
    expect(s).toMatch(/Lock ladder/);
    expect(s).toMatch(/7d–4y/);
    expect(s).not.toBe('Streamflow');
  });

  it('⚠️ a bungalow MID-MIGRATION names both, and drops neither', () => {
    // A pool listed nowhere is a pool a staker cannot find their way back to. During
    // a migration both are live and both hold real principal.
    const s = poolShape({ chain: 'solana', stakePool: 'POOL', ladderPool: 'LADDER' });
    expect(s).toMatch(/Streamflow/);
    expect(s).toMatch(/ladder/);
  });

  it('never claims a Streamflow pool is locked', () => {
    // The registry records the PROGRAM and nothing about lock terms, and the retired
    // BAYLA pool ran flat weights. venueVoice.test.tsx pins this from the other side.
    expect(poolShape({ chain: 'solana', stakePool: 'POOL' })).not.toMatch(/lock/i);
  });

  it('is unchanged for every EVM shape', () => {
    expect(poolShape({ chain: 'base', stakePool: '0x' })).toBe('No lock');
    expect(poolShape({ chain: 'ethereum', poolKind: 'plain', stakePool: '0x' })).toBe('No lock');
    expect(poolShape({ chain: 'ethereum', poolKind: 'ladder', stakePool: '0x' })).toMatch(/Lock ladder/);
  });

  it('a Solana ladder row does NOT depend on poolKind', () => {
    // poolKind stays EVM-only on purpose: scripts/verify-ladder-builds.mjs reads it
    // to decide what to verify on chain and requires a 0x-40-hex address beside it,
    // so a Solana row carrying poolKind:'ladder' would be dropped by that parser with
    // no output and no failure — a gate silently covering nothing.
    expect(poolShape({ chain: 'solana', stakePool: 'POOL', poolKind: 'ladder' })).toBe('Streamflow');
  });
});

describe('the two ladder boost tables have not drifted', () => {
  it('the EVM constants and the Solana program agree on both endpoints', () => {
    // If this ever fails, the fix is NOT to change the numbers until it passes — it
    // is to decide which rail this table is describing and say so on the row.
    expect(SOL_MIN).toBe(EVM_MIN);
    expect(SOL_MAX).toBe(EVM_MAX);
  });

  it('and the floor really is 0.40x at seven days, on both', () => {
    // Shipped once as a 1.00x floor, which overstates a short-lock staker's share by
    // two and a half times.
    expect(EVM_MIN).toBe(4_000);
    expect(SOL_MIN).toBe(4_000);
    expect(EVM_MAX).toBe(40_000);
  });

  it('the lock range the row quotes is the range the program enforces', () => {
    expect(MIN_LOCK_SECS).toBe(7 * 86_400);
    expect(MAX_LOCK_SECS).toBe(4 * 365 * 86_400);
    expect(poolShape({ chain: 'solana', ladderPool: 'L' })).toContain('7d–4y');
  });
});
