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
