// @vitest-environment node
//
// What a refused swap through one of our pools SAYS (SPEC_S3 3.10). The copy is final,
// so it is pinned word for word, and "Nothing was swapped" is true on every row: the
// whole transaction reverts, the site fee with it. The other liquidity kinds' rows are
// pinned, unedited, in errors.test.ts.
import { describe, it, expect } from 'vitest';
import { LP_FAILURE_COPY, explainFailure } from './errors';
import { CPSWAP, LAUNCH, cfgLocal } from './testkit.fixture';

const failed = (id: string, hex: string) => `Program ${id} failed: custom program error: 0x${hex}`;
const err = (code: number) => ({ InstructionError: [3, { Custom: code }] });
const say = (id: string, code: number, kind: 'lp-swap' | 'lp-deposit' | 'pool-buy' = 'lp-swap') =>
  explainFailure(err(code), [failed(id, code.toString(16))], cfgLocal, kind).message;

const CP = CPSWAP.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

describe('a swap through one of our pools: failures in the swapper’s words', () => {
  it.each([
    [6000, "Swaps on this pool are switched off by the pool program's admin (the team's vault), or the pool is not open yet. Nothing was swapped."],
    [6005, "The pool's price moved past your limit before this ran, so you would have received less than your minimum. Nothing was swapped. Start over for a fresh price."],
    [6006, "Too small: at this pool's size the swap would round to nothing. Try a larger amount."],
    [6011, "The pool's books did not add up when this ran (error 6011). Nothing was swapped; tell us."],
    [6012, "The pool's books did not add up when this ran (error 6012). Nothing was swapped; tell us."],
  ] as const)('cp-swap %i', (code, copy) => {
    expect(say(CP, code)).toBe(copy);
  });

  it('Anchor 2506 has no sentence of its own: it is said by its number', () => {
    expect(LP_FAILURE_COPY['lp-swap'].heldTooFew).toBeNull();
    expect(say(CP, 2506)).toBe('A Solana program refused this transaction (error 2506).');
  });

  it('a frozen account (either token program, 17) and a reassigned account (associated-token program, 0)', () => {
    const frozen =
      "The token's issuer has frozen an account this needs (the pool's vault or your token account), so nothing can move. That is the issuer's doing, not the pool program's.";
    expect(say(TOKEN, 17)).toBe(frozen);
    expect(say(TOKEN_2022, 17)).toBe(frozen);
    expect(say(ATA, 0)).toBe('One of your token accounts now belongs to another wallet, so this was stopped before anything moved.');
    // "Not enough tokens" is the same for every kind.
    expect(say(TOKEN, 1)).toBe('You do not hold that many tokens.');
  });

  it('the swap’s words are its own: not a deposit’s, and not the launch pool swap’s', () => {
    expect(say(CP, 6000)).not.toBe(say(CP, 6000, 'lp-deposit'));
    expect(say(CP, 6005)).not.toBe(say(CP, 6005, 'lp-deposit'));
    expect(say(CP, 6005)).not.toBe(say(CP, 6005, 'pool-buy'));
    // The launch pool's swap keeps the general copy, exactly as before.
    expect(say(CP, 6005, 'pool-buy')).toBe('The price moved past your limit before this landed. Get a new quote and try again.');
  });

  it('a code from a program that is not the pool program is not read as the pool’s', () => {
    expect(say(LAUNCH.toBase58(), 6000)).not.toMatch(/Swaps on this pool are switched off/);
  });

  it('no row says "failed", and none has an em dash', () => {
    for (const v of Object.values(LP_FAILURE_COPY['lp-swap'])) {
      if (v === null) continue;
      expect(v).not.toMatch(/fail/i);
      expect(v).not.toContain('—');
    }
  });
});
