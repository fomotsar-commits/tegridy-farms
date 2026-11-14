import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BUSY_SWAPS, GUARD_ON, OUR_INSTRUCTIONS, alertsFor, didInOurs, foldSentinel, howCalled, kindOf, payerSolChange, refusedByGuard, summarize } from './rival-watch.mjs';

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

describe('the sentinel: who a transaction is, and what the owner hears of', () => {
  const LOAN = 'KAMINO';
  const AGG = 'JUPITER';
  const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
  // "Base58" here is the hex itself: the decoding is handed in, and not what is under test.
  const decode = (data) => bytes(data);
  const sctx = { ...ctx, decode, plumbing: ['COMPUTE', 'ATA', 'LIGHTHOUSE'] };
  const SWAP = '8fbe5adac41e33de' + '00'.repeat(16);
  const DEPOSIT = 'f223c68952e1f2b6' + '00'.repeat(24);
  /** A transaction whose top-level instructions are [program, data?] and inner ones [top index, program, data?]. */
  const full = (payer, top, inner = [], meta = {}) => ({
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }], instructions: top.map(([programId, data]) => ({ programId, ...(data ? { data } : {}) })) } },
    meta: { err: null, innerInstructions: inner.map(([index, programId, data]) => ({ index, instructions: [{ programId, ...(data ? { data } : {}) }] })), ...meta },
  });

  it('holds our program’s instruction tags to Anchor’s rule, sha256("global:<name>")', () => {
    for (const [tag, name] of Object.entries(OUR_INSTRUCTIONS)) expect(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex')).toBe(tag);
    expect(Object.values(OUR_INSTRUCTIONS)).toEqual(expect.arrayContaining(['swap_base_input', 'swap_base_output', 'deposit', 'withdraw']));
  });

  it('reads what it did in our program: a swap, liquidity, or neither', () => {
    expect(didInOurs(full('U', [[OURS, SWAP]]), OURS, decode)).toBe('swap');
    expect(didInOurs(full('U', [[OURS, DEPOSIT]]), OURS, decode)).toBe('liquidity');
    expect(didInOurs(full('B', [['BOTPROG']], [[0, OURS, SWAP]]), OURS, decode)).toBe('swap');
    expect(didInOurs(full('U', [[OURS, 'ffffffffffffffff']]), OURS, decode)).toBe('other');
  });

  it('a visitor: a swap with ours and plumbing alone', () => {
    expect(kindOf(full('U', [['COMPUTE'], ['ATA'], [OURS, SWAP], ['LIGHTHOUSE']]), sctx)).toEqual({ payer: 'U', kind: 'user', via: null, did: 'swap' });
  });

  it('a liquidity provider: a deposit, whatever stands beside it', () => {
    expect(kindOf(full('L', [['COMPUTE'], [OURS, DEPOSIT]]), sctx).kind).toBe('lp');
  });

  it('a bot the guard refuses: ours from inside its own program', () => {
    expect(kindOf(full('B', [['COMPUTE'], ['BOTPROG']], [[1, OURS, SWAP]]), sctx)).toEqual({ payer: 'B', kind: 'bot-inside', via: 'BOTPROG', did: 'swap' });
  });

  it('a bot the guard lets through: ours at the top beside a loan and an aggregator (Cn8LrZZn…, 2026-11-14)', () => {
    // Its real shape: budget, budget, two token accounts, Kamino borrow, Jupiter, OURS, Kamino repay, token.
    const t = full('C', [['COMPUTE'], ['COMPUTE'], ['ATA'], ['ATA'], [LOAN], [AGG], [OURS, SWAP], [LOAN]]);
    expect(kindOf(t, sctx)).toEqual({ payer: 'C', kind: 'bot-beside', via: LOAN, did: 'swap' });
    // A loan alone is enough: it need not be an exchange the scanner knows.
    expect(kindOf(full('C', [[LOAN], [OURS, SWAP], [LOAN]]), sctx).kind).toBe('bot-beside');
  });

  it('our robot whatever it stands beside, and nothing when ours is not reached', () => {
    expect(kindOf(full(ROBOT, [[LOAN], [AGG], [OURS, SWAP], ['LIGHTHOUSE']]), sctx).kind).toBe('robot');
    expect(kindOf(full('X', [[AGG]]), sctx).kind).toBeNull();
  });

  const row = (payer, kind, more = {}) => ({ payer, at: 1000, ok: true, kind, via: null, refusedByGuard: false, lamports: 0, ...more });

  it('remembers each wallet: first and last seen, landed, failed, refused, its SOL, and how it came', () => {
    const one = foldSentinel(null, [row('B', 'bot-inside', { at: 50, via: 'BOTPROG', lamports: 300 }), row('B', 'bot-inside', { at: 90, ok: false, refusedByGuard: true, via: 'BOTPROG', lamports: -5 })]);
    expect(one.payers.B).toEqual({ first: 50, last: 90, landed: 1, failed: 1, refused: 1, lamports: 295, kinds: { 'bot-inside': 2 }, via: { BOTPROG: 2 } });
    const two = foldSentinel(one, [row('B', 'bot-beside', { at: 120, via: LOAN, lamports: 10 }), row('U', 'user', { at: 130 })]);
    expect(two.payers.B).toMatchObject({ first: 50, last: 120, landed: 2, lamports: 305, kinds: { 'bot-inside': 2, 'bot-beside': 1 }, via: { BOTPROG: 2, [LOAN]: 1 } });
    expect(two.payers.U).toMatchObject({ first: 130, landed: 1 });
    // The state handed in is not changed.
    expect(one.payers.B.landed).toBe(1);
    expect(one.payers.U).toBeUndefined();
  });

  it('says a bot past the guard first, with what its wallet gained, and marks one never seen NEW', () => {
    const state = foldSentinel(null, [row('OLD', 'bot-beside', { via: LOAN })]);
    const alerts = alertsFor(state, [row('OLD', 'bot-beside', { via: LOAN, lamports: 750_000 }), row('C', 'bot-beside', { via: LOAN, lamports: 1_338_000 }), row('C', 'bot-beside', { via: LOAN, ok: false, lamports: -6_000 })], { OLD: 'the loan bot' });
    expect(alerts).toEqual([
      { why: 'passed-guard', payer: 'OLD', at: 1000, text: `bot past the guard: the loan bot (OLD) landed 1 trade(s) beside ${LOAN}, wallet change +0.000750 SOL` },
      { why: 'passed-guard', payer: 'C', at: 1000, text: `NEW bot past the guard: C landed 1 trade(s) beside ${LOAN}, wallet change +0.001338 SOL` },
    ]);
  });

  it('shouts when a trade from inside a bot’s program lands: the guard is off or was passed', () => {
    const after = GUARD_ON.at + 60;
    const a = alertsFor(null, [row('G', 'bot-inside', { via: 'BOTPROG', at: after }), row('G', 'bot-inside', { via: 'BOTPROG', at: after + 5 })], { G: 'GLiCi' });
    expect(a[0]).toMatchObject({ why: 'inside-landed', payer: 'G', at: after + 5 });
    expect(a[0].text).toMatch(/^GUARD PASSED FROM INSIDE: GLiCi \(G\) landed 2 trade\(s\) from inside its program BOTPROG/);
  });

  it('says nothing of a trade from inside that landed before the guard went on: history, not a breach', () => {
    // The guard: proposal #33, slot 469,178,423, 2026-11-14T03:32:44Z.
    expect(new Date(GUARD_ON.at * 1000).toISOString()).toBe('2026-11-14T03:32:44.000Z');
    expect(alertsFor(null, [row('G', 'bot-inside', { via: 'BOTPROG', at: GUARD_ON.at - 1 })], { G: 'GLiCi' })).toEqual([]);
    expect(alertsFor(null, [row('G', 'bot-inside', { via: 'BOTPROG', at: GUARD_ON.at })])).toHaveLength(1);
    // Another switch-on time can be handed in (a guard switched off and on again).
    expect(alertsFor(null, [row('G', 'bot-inside', { via: 'BOTPROG', at: 500 })], {}, { guardOnAt: 400 })).toHaveLength(1);
  });

  it('says the guard’s refusals, a new visitor once, a busy plain trader, and nothing of the robot or of liquidity', () => {
    const state = foldSentinel(null, [row('U', 'user')]);
    const rows = [
      row('G', 'bot-inside', { ok: false, refusedByGuard: true, via: 'BOTPROG' }),
      row('G', 'bot-inside', { ok: false, refusedByGuard: true, via: 'BOTPROG' }),
      row('U', 'user'),
      row('V', 'user'),
      ...Array.from({ length: BUSY_SWAPS }, () => row('S', 'user')),
      row(ROBOT, 'robot'),
      row('L', 'lp'),
    ];
    const alerts = alertsFor(state, rows);
    expect(alerts.map((a) => `${a.why} ${a.payer}`)).toEqual(['new-wallet V', 'new-wallet S', 'busy S', 'guard-refused G']);
    expect(alerts.at(-1).text).toBe('guard refused G 2 time(s) (from inside BOTPROG): still trying');
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
