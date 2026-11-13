import { describe, it, expect } from 'vitest';
import { howCalled, payerSolChange, refusedByGuard, summarize } from './rival-watch.mjs';

const OURS = 'OURS';
const ROBOT = 'ROBOT';
const ctx = { ours: OURS, robot: ROBOT, exchanges: new Set(['RAYDIUM', 'PUMP']) };
/** A parsed transaction: its payer, its top-level programs, and inner calls as [top index, program]. */
const tx = (payer, top, inner = [], meta = {}) => ({
  transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }], instructions: top.map((programId) => ({ programId })) } },
  meta: { err: null, innerInstructions: inner.map(([index, programId]) => ({ index, instructions: [{ programId }] })), ...meta },
});

describe('howCalled: how a transaction reached our pool program', () => {
  it('is a user’s swap when ours is called alone at the top', () => {
    expect(howCalled(tx('U', ['COMPUTE', 'ATA', OURS]), ctx)).toEqual({ payer: 'U', how: 'direct', via: null });
  });
  it('is a bot from inside its own program (what the guard refuses)', () => {
    expect(howCalled(tx('B', ['COMPUTE', 'BOTPROG'], [[1, 'RAYDIUM'], [1, OURS]]), ctx)).toEqual({ payer: 'B', how: 'inside', via: 'BOTPROG' });
  });
  it('is a bot that adapted when ours sits at the top beside another exchange’s swap', () => {
    expect(howCalled(tx('B', ['COMPUTE', 'RAYDIUM', OURS]), ctx)).toEqual({ payer: 'B', how: 'beside', via: 'RAYDIUM' });
  });
  it('is our robot whatever it calls, and nothing when ours is not reached', () => {
    expect(howCalled(tx(ROBOT, ['PUMP', OURS]), ctx).how).toBe('robot');
    expect(howCalled(tx('X', ['RAYDIUM']), ctx).how).toBeNull();
  });
  it('does not count our program’s own inner calls as from inside another program', () => {
    expect(howCalled(tx('U', [OURS], [[0, OURS]]), ctx).how).toBe('direct');
  });
});

describe('payerSolChange: what the payer gained in SOL, plain and wrapped, after its fee', () => {
  it('adds the wrapped SOL the payer owns to its lamports', () => {
    const t = tx('B', [OURS], [], {
      preBalances: [1_000_000], postBalances: [994_000],
      preTokenBalances: [{ owner: 'B', mint: 'So11111111111111111111111111111111111111112', uiTokenAmount: { amount: '500000' } }, { owner: 'B', mint: 'OTHER', uiTokenAmount: { amount: '9' } }],
      postTokenBalances: [{ owner: 'B', mint: 'So11111111111111111111111111111111111111112', uiTokenAmount: { amount: '520000' } }],
    });
    expect(payerSolChange(t, 'B')).toBe(-6_000 + 20_000);
  });
});

describe('refusedByGuard', () => {
  it('reads SwapNotDirect (6015) from the error or the logs', () => {
    expect(refusedByGuard({ meta: { err: { InstructionError: [2, { Custom: 6015 }] } } })).toBe(true);
    expect(refusedByGuard({ meta: { err: { InstructionError: [2, { Custom: 1 }] }, logMessages: ['Program log: AnchorError ... SwapNotDirect'] } })).toBe(true);
    expect(refusedByGuard({ meta: { err: { InstructionError: [2, { Custom: 6005 }] } } })).toBe(false);
    expect(refusedByGuard({ meta: { err: null } })).toBe(false);
  });
});

describe('summarize', () => {
  it('counts each payer’s trades, how and through what, and its SOL, biggest take first', () => {
    const rows = [
      { payer: 'B', ok: true, how: 'inside', via: 'BOTPROG', lamports: 300, refusedByGuard: false },
      { payer: 'B', ok: false, how: 'inside', via: 'BOTPROG', lamports: -5, refusedByGuard: true },
      { payer: 'R', ok: true, how: 'robot', via: null, lamports: 100, refusedByGuard: false },
    ];
    expect(summarize(rows)).toEqual([
      { payer: 'B', landed: 1, failed: 1, refusedByGuard: 1, how: { inside: 2 }, via: { BOTPROG: 2 }, lamports: 295 },
      { payer: 'R', landed: 1, failed: 0, refusedByGuard: 0, how: { robot: 1 }, via: {}, lamports: 100 },
    ]);
  });
});
