// @vitest-environment node
//
// Opening a pool's failures, said in its own words (spec 3.5). The log lines are the
// ones the network writes: a front-run at the standard address fails inside Anchor's
// `init` of the pool's share token, so the System program fails FIRST with custom 0
// ("account already in use"), and the innermost failing program speaks first. The same
// codes under adding liquidity, and under a swap, keep the words they always had.
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../curve/program';
import { CREATE_FAILURE_COPY, LP_FAILURE_COPY, createFailure, explainFailure } from './errors';
import { CP_SWAP_ERROR_COPY } from '../../../solana/cpswap/errors';
import { CPSWAP, cfgLocal } from './testkit.fixture';
import type { TxKind } from './types';

const CP = CPSWAP.toBase58();
const SYS = SYSTEM_PROGRAM_ID.toBase58();
const failed = (id: string, hex: string) => `Program ${id} failed: custom program error: 0x${hex}`;

/** cp-swap's own failure, as its logs show it inside `initialize`. */
const cpLogs = (hex: string) => [
  `Program ${CP} invoke [1]`,
  'Program log: Instruction: Initialize',
  `Program ${CP} consumed 41234 of 200000 compute units`,
  failed(CP, hex),
];

/** A pool already at the address: Anchor's `init` of the share token asks System to allocate it. */
const frontRunLogs = [
  `Program ${CP} invoke [1]`,
  'Program log: Instruction: Initialize',
  `Program ${SYS} invoke [2]`,
  'Allocate: account Address { address: 4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM, base: None } already in use',
  failed(SYS, '0'),
  `Program ${CP} consumed 20345 of 200000 compute units`,
  failed(CP, '0'),
];

const say = (logs: string[], code: number, kind?: TxKind) =>
  explainFailure({ InstructionError: [4, { Custom: code }] }, logs, cfgLocal, kind).message;

describe('opening a pool: every failure row in its own words', () => {
  it('a front-run at the standard address is the System program’s custom 0, said as such', () => {
    expect(say(frontRunLogs, 0, 'lp-create')).toBe(
      'Someone opened a pool at this address first. Nothing was opened. Start over: the site will use a new address.',
    );
  });

  it('cp-swap 6000 at an opening is the fee tier switched off, never the deposit switch', () => {
    const m = say(cpLogs('1770'), 6000, 'lp-create');
    expect(m).toBe(CREATE_FAILURE_COPY.notApproved);
    expect(m).toMatch(/Opening new pools on the public fee tier was switched off/);
    expect(m).not.toBe(LP_FAILURE_COPY['lp-deposit'].notApproved);
  });

  it.each([
    ['1772', 6002, CREATE_FAILURE_COPY.emptySupply],
    ['1777', 6007, CREATE_FAILURE_COPY.notSupportMint],
    ['1779', 6009, CREATE_FAILURE_COPY.initLpAmountTooLess],
    ['7df', 2015, CREATE_FAILURE_COPY.tokenOwner],
    ['bbf', 3007, CREATE_FAILURE_COPY.accountMissing],
    ['bc4', 3012, CREATE_FAILURE_COPY.accountMissing],
    ['9c5', 2501, CREATE_FAILURE_COPY.constraint],
    ['7d3', 2003, CREATE_FAILURE_COPY.constraint],
  ])('cp-swap 0x%s (%i)', (hex, code, copy) => {
    expect(say(cpLogs(hex), code, 'lp-create')).toBe(copy);
  });

  it('a frozen token account, under either token program', () => {
    for (const id of [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]) {
      const logs = [`Program ${CP} invoke [1]`, `Program ${id} invoke [2]`, failed(id, '11'), failed(CP, '11')];
      expect(say(logs, 17, 'lp-create')).toBe(CREATE_FAILURE_COPY.accountFrozen);
    }
  });

  it('the general rules still answer the rest: too few tokens, too little SOL', () => {
    const id = TOKEN_PROGRAM_ID.toBase58();
    expect(say([`Program ${id} invoke [2]`, failed(id, '1'), failed(CP, '1')], 1, 'lp-create')).toBe('You do not hold that many tokens.');
    const poor = [`Program ${SYS} invoke [2]`, 'Transfer: insufficient lamports 5, need 150000000', failed(SYS, '1'), failed(CP, '1')];
    expect(say(poor, 1, 'lp-create')).toMatch(/does not have enough SOL/);
  });

  it('a cp-swap code with no opening row falls back to the general copy', () => {
    expect(createFailure('cp-swap', CP, 6005)).toBeNull();
    expect(createFailure('other', SYS, 1)).toBeNull();
  });
});

describe('the same codes elsewhere keep their old words', () => {
  it('adding liquidity: 6000 is the deposit switch, and a System 0 is the general line', () => {
    expect(say(cpLogs('1770'), 6000, 'lp-deposit')).toBe(LP_FAILURE_COPY['lp-deposit'].notApproved);
    expect(say(frontRunLogs, 0, 'lp-deposit')).toBe('A Solana program refused this transaction (error 0).');
  });

  it('a swap, and a transaction with no kind, still get the swap table', () => {
    expect(say(cpLogs('1770'), 6000, 'pool-buy')).toBe(CP_SWAP_ERROR_COPY.NotApproved);
    expect(say(cpLogs('1779'), 6009)).toBe(CP_SWAP_ERROR_COPY.InitLpAmountTooLess);
  });
});
