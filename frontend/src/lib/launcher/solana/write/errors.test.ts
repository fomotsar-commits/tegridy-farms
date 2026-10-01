// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { describeFailure, explainFailure } from './errors';
import { computeLimitFromSimulation, maxPriceForCap, percentile75, priorityLamports } from './budget';
import { CPSWAP, LAUNCH, cfgLocal } from './testkit.fixture';

const failed = (id: string, hex: string) => `Program ${id} failed: custom program error: 0x${hex}`;

describe('whose error, in plain English', () => {
  it('6005 is "already graduated" from the launch program but "price moved" from the pool program', () => {
    expect(describeFailure('launch', 6005)).toMatch(/already graduated/);
    expect(describeFailure('cp-swap', 6005)).toMatch(/price moved/);
  });

  it('a pool-program refusal INSIDE graduation is named as the pool program’s (innermost failure first)', () => {
    const logs = [
      `Program ${LAUNCH.toBase58()} invoke [1]`,
      `Program ${CPSWAP.toBase58()} invoke [2]`,
      failed(CPSWAP.toBase58(), '1770'),
      failed(LAUNCH.toBase58(), '1770'),
    ];
    expect(explainFailure({ InstructionError: [2, { Custom: 6000 }] }, logs, cfgLocal)).toMatchObject({
      program: 'cp-swap',
      code: 6000,
      message: expect.stringMatching(/not taking swaps/),
    });
  });

  it('not enough SOL, in the forms the network reports it', () => {
    expect(explainFailure('AccountNotFound', [], cfgLocal).message).toMatch(/not have enough SOL/);
    expect(explainFailure('InsufficientFundsForFee', null, cfgLocal).message).toMatch(/not have enough SOL/);
    expect(
      explainFailure({ InstructionError: [0, { Custom: 1 }] }, ['Transfer: insufficient lamports 5, need 10', failed('11111111111111111111111111111111', '1')], cfgLocal).message,
    ).toMatch(/not have enough SOL/);
  });

  it('the token program’s "insufficient funds" is "you do not hold that many tokens"', () => {
    expect(explainFailure({ InstructionError: [2, { Custom: 1 }] }, [failed('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '1')], cfgLocal).message).toMatch(/do not hold that many tokens/);
  });

  it('no logs: falls back to the error object, and never invents a launch-program reason', () => {
    expect(explainFailure({ InstructionError: [3, { Custom: 6007 }] }, undefined, cfgLocal)).toMatchObject({ program: 'other', code: 6007 });
    expect(explainFailure({ weird: true }, [], cfgLocal).message).toBe('The transaction could not run.');
  });

  it('an unknown code from another program is said as such, with its number', () => {
    expect(describeFailure('other', 42)).toBe('A Solana program refused this transaction (error 42).');
    expect(describeFailure('launch', 9999)).toMatch(/error 9999/);
  });
});

describe('budget', () => {
  it('limit = used + 15%, at least used + 1,000, capped at 1.4M; a migrate floor wins', () => {
    expect(computeLimitFromSimulation(60_000)).toBe(69_000);
    expect(computeLimitFromSimulation(2_000)).toBe(3_000);
    expect(computeLimitFromSimulation(1_300_000)).toBe(1_400_000);
    expect(computeLimitFromSimulation(264_128, 400_000)).toBe(400_000);
    expect(computeLimitFromSimulation(undefined)).toBe(1_400_000);
  });
  it('the price never lets the priority fee pass the cap', () => {
    for (const limit of [1_000, 69_000, 400_000, 1_400_000]) {
      expect(priorityLamports(maxPriceForCap(limit, 1_000_000n), limit)).toBeLessThanOrEqual(1_000_000n);
    }
  });
  it('75th percentile', () => {
    expect(percentile75([])).toBe(0n);
    expect(percentile75([0, 0, 10_000, 20_000])).toBe(10_000n);
    expect(percentile75([5])).toBe(5n);
  });
});

// D27: the same refusal from the newer token program read "error 1".
describe('both token programs say "not enough tokens" the same way', () => {
  it('Token-2022 error 1 reads "You do not hold that many tokens."', () => {
    const logs = [failed('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '1')];
    expect(explainFailure({ InstructionError: [2, { Custom: 1 }] }, logs, cfgLocal)).toMatchObject({
      program: 'other',
      code: 1,
      message: 'You do not hold that many tokens.',
    });
  });

  it('error 1 from any other program is still said by its number', () => {
    const logs = [failed('BPFLoaderUpgradeab1e11111111111111111111111', '1')];
    expect(explainFailure({ InstructionError: [2, { Custom: 1 }] }, logs, cfgLocal).message).toBe(
      'A Solana program refused this transaction (error 1).',
    );
  });
});

// Spec 3.9: the pool's own codes mean something different to someone adding than to
// someone taking out, so a liquidity kind gets its own sentence, and only a liquidity
// kind does. The copy is final, so it is pinned word for word.
describe('liquidity failures, in the words of what the person was doing', () => {
  const CP = CPSWAP.toBase58();
  const err = (code: number) => ({ InstructionError: [3, { Custom: code }] });
  const say = (id: string, code: number, kind?: 'lp-deposit' | 'lp-withdraw' | 'pool-buy' | 'buy') =>
    explainFailure(err(code), [failed(id, code.toString(16))], cfgLocal, kind).message;

  it.each([
    [6000, 'lp-deposit', "Deposits were switched off on this pool by the pool program's admin (the team's vault) before this ran. Nothing was added."],
    [6000, 'lp-withdraw', "Withdrawals are switched off on this pool by the pool program's admin (the team's vault). Only the vault can switch them back on. Your pool shares are still in your wallet."],
    [6005, 'lp-deposit', "The pool's price moved past your tolerance before this ran, so it would have cost more than your maximum. Start over to see the new amounts."],
    [6005, 'lp-withdraw', "The pool's price moved past your tolerance before this ran, so you would have received less than your minimum. Start over to see the new amounts."],
    [6006, 'lp-deposit', "Too small: at this pool's size one side would round to zero. Add a larger amount."],
    [6006, 'lp-withdraw', 'Too small: one side would round to zero. Take out a larger share, or all of it.'],
    [6011, 'lp-deposit', "The pool's books did not add up when this ran (error 6011). Do not add to this pool; tell us."],
    [6012, 'lp-deposit', "The pool's books did not add up when this ran (error 6012). Do not add to this pool; tell us."],
    [6011, 'lp-withdraw', "The pool's books did not add up when this ran (error 6011). Your shares are still in your wallet; tell us."],
    [6012, 'lp-withdraw', "The pool's books did not add up when this ran (error 6012). Your shares are still in your wallet; tell us."],
    [2506, 'lp-withdraw', 'Your wallet held fewer pool shares than this tried to take out when it ran. Read your positions again.'],
  ] as const)('cp-swap %i, %s', (code, kind, copy) => {
    expect(say(CP, code, kind)).toBe(copy);
  });

  it('Anchor 2506 on a deposit has no liquidity sentence: it is said by its number', () => {
    expect(say(CP, 2506, 'lp-deposit')).toBe('A Solana program refused this transaction (error 2506).');
  });

  it('a frozen account (either token program, 17) and a reassigned account (associated-token program, 0), for both kinds', () => {
    const frozen =
      "The token's issuer has frozen an account this needs (the pool's vault or your token account), so nothing can move. That is the issuer's doing, not the pool program's.";
    const reassigned = 'One of your token accounts now belongs to another wallet, so this was stopped before anything moved.';
    for (const kind of ['lp-deposit', 'lp-withdraw'] as const) {
      expect(say('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 17, kind)).toBe(frozen);
      expect(say('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 17, kind)).toBe(frozen);
      expect(say('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 0, kind)).toBe(reassigned);
      // "Not enough tokens" is the same for every kind.
      expect(say('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 1, kind)).toBe('You do not hold that many tokens.');
    }
  });

  it('the swap and curve kinds, and no kind at all, keep the general copy for the same codes', () => {
    for (const kind of ['pool-buy', 'buy', undefined] as const) {
      expect(say(CP, 6000, kind)).toMatch(/not taking swaps/);
      expect(say(CP, 6005, kind)).toBe('The price moved past your limit before this landed. Get a new quote and try again.');
      expect(say('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 17, kind)).toBe('A Solana program refused this transaction (error 17).');
      expect(say('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 0, kind)).toBe('A Solana program refused this transaction (error 0).');
    }
  });

  it('a liquidity code from a program that is not the pool program is not read as the pool’s', () => {
    expect(say(LAUNCH.toBase58(), 6000, 'lp-withdraw')).toMatch(/not taking|launch|refused/i);
    expect(say(LAUNCH.toBase58(), 6000, 'lp-withdraw')).not.toMatch(/Withdrawals are switched off/);
  });
});
