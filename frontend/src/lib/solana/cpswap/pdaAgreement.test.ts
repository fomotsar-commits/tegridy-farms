// @vitest-environment node
// PDA derivation is realm-sensitive under jsdom — see program.test.ts.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  deriveAmmConfig,
  deriveAuthority,
  deriveLpMint,
  deriveVault,
  deriveObservation,
} from './program';
import {
  cpAmmConfigPda,
  cpAmmAuthorityPda,
  cpLpMintPda,
  cpPoolVaultPda,
  cpObservationPda,
} from '../../launcher/solana/curve/program';

/**
 * THE REPO HAS TWO IMPLEMENTATIONS OF CP-SWAP PDA DERIVATION, AND THIS PINS
 * THEM EQUAL.
 *
 * `lib/launcher/solana/curve/program.ts` grew cp-swap helpers because
 * `migrate_to_amm` has to derive the pool it migrates INTO. `lib/solana/cpswap/`
 * (2026-08-29) is the dedicated cp-swap client and derived them again — I did
 * not spot the existing ones. That is the third time this repo has grown two
 * implementations of one thing, and the earlier two are recorded in
 * TODO_OPERATOR as "pick one".
 *
 * Consolidating is the right end state and it is written up as a follow-up, but
 * it is NOT safe to do right now: the launcher half sits on the money path of
 * `migrateToAmmIx`, and an unmerged branch (`claude/create-amm-config-builder`)
 * is adding more code to that exact file. Refactoring underneath an open branch
 * is how the divergence becomes a conflict nobody can review.
 *
 * So the duplication is made SAFE instead of pretended away: if the two ever
 * disagree by a byte, this fails. Whichever one is deleted in the consolidation,
 * this test proves the survivor derives the same addresses the other did.
 *
 * (The one deliberate difference, which is not a disagreement about derivation:
 * the launcher helpers DEFAULT to `CP_SWAP_PROGRAM_ID`, the spent id. The
 * cpswap client refuses to default to a spent program at all — see
 * `LIVE_PROGRAM_ID`. Every case below passes the program id explicitly, so the
 * comparison is of the derivation and nothing else.)
 */

// Any program id works: derivation is pure. Using the spent id keeps the two
// sides on the same footing without either of them defaulting.
const PID = new PublicKey('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');
const OTHER_PID = new PublicKey('BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL');
const POOL = new PublicKey('8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n');
const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('the two cp-swap PDA implementations agree', () => {
  it('authority', () => {
    for (const pid of [PID, OTHER_PID]) {
      expect(deriveAuthority(pid).toBase58()).toBe(cpAmmAuthorityPda(pid).toBase58());
    }
  });

  it('amm config — across the whole u16 index range, where the BE/LE trap lives', () => {
    // A little-endian seed would collide 1 with 256 in the low byte. Both sides
    // must be big-endian, and the boundaries are where that shows.
    for (const index of [0, 1, 2, 255, 256, 257, 1000, 0xfffe, 0xffff]) {
      expect(deriveAmmConfig(PID, index).toBase58(), `index ${index}`)
        .toBe(cpAmmConfigPda(index, PID).toBase58());
    }
  });

  it('lp mint', () => {
    expect(deriveLpMint(PID, POOL).toBase58()).toBe(cpLpMintPda(POOL, PID).toBase58());
  });

  it('pool vaults, both sides of a pair', () => {
    expect(deriveVault(PID, POOL, SOL).toBase58()).toBe(cpPoolVaultPda(POOL, SOL, PID).toBase58());
    expect(deriveVault(PID, POOL, USDC).toBase58()).toBe(cpPoolVaultPda(POOL, USDC, PID).toBase58());
    // …and the two vaults are distinct, so a swapped mint cannot silently alias.
    expect(deriveVault(PID, POOL, SOL).toBase58()).not.toBe(deriveVault(PID, POOL, USDC).toBase58());
  });

  it('observation', () => {
    expect(deriveObservation(PID, POOL).toBase58()).toBe(cpObservationPda(POOL, PID).toBase58());
  });

  it('every role is a DIFFERENT address — agreement must not mean collapse', () => {
    const all = [
      deriveAuthority(PID), deriveAmmConfig(PID, 0), deriveLpMint(PID, POOL),
      deriveVault(PID, POOL, SOL), deriveVault(PID, POOL, USDC), deriveObservation(PID, POOL),
    ].map((k) => k.toBase58());
    expect(new Set(all).size).toBe(all.length);
  });
});
