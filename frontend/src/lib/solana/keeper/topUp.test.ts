// @vitest-environment node
//
// The plain-SOL top-up: when it runs, what it moves, the one transaction it builds (the robot to
// itself), and how a sent one is logged. The chain is made up here; the step itself (read, test
// run, verdict, send, read-back) runs as it does live.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, TransactionMessage, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { KeeperIo, TripRecord } from './cycle';
import { TOP_UP_MOST_COST, topUp, topUpInstructions, topUpNeed, topUpProblem, type Held, type TopUpSettings } from './topUp';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const RENT = 1_488_440n; // a token account's rent on mainnet, read 2026-11-08
const SOL = 1_000_000_000n;

const S: TopUpSettings = { belowLamports: SOL / 50n, amountLamports: (3n * SOL) / 100n, dayLamports: SOL / 4n, microLamports: 10_000 };
// The robot on 2026-11-08: 796,203 lamports plain, 0.2076 SOL wrapped.
const PLAIN = 796_203n;
const WRAPPED = 207_632_869n;
const held = (plain: bigint, wrapped: bigint | null): Held => ({ plain, wrapped, wrappedLamports: wrapped === null ? 0n : wrapped + RENT });

const wallet = (lamports: bigint) => ({ data: ['', 'base64'], owner: SYSTEM, lamports: Number(lamports), executable: false, rentEpoch: 0 });
const wsol = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: Number(amount + RENT), executable: false, rentEpoch: 0 };
};

describe('topUpNeed', () => {
  it('moves the amount once plain SOL is under the line, from wrapped SOL that holds more', () => {
    expect(topUpNeed(held(PLAIN, WRAPPED), S, 0n)).toEqual({ move: S.amountLamports });
    expect(topUpNeed(held(S.belowLamports - 1n, WRAPPED), S, 0n)).toEqual({ move: S.amountLamports });
  });

  it('does nothing at or over the line, or with top-ups off', () => {
    expect(topUpNeed(held(S.belowLamports, WRAPPED), S, 0n)).toBeNull();
    expect(topUpNeed(held(SOL, WRAPPED), S, 0n)).toBeNull();
    expect(topUpNeed(held(0n, WRAPPED), { ...S, belowLamports: 0n }, 0n)).toBeNull();
  });

  it('says why not when there is no wrapped SOL to move, or not more than the amount', () => {
    expect(topUpNeed(held(PLAIN, null), S, 0n)).toEqual({ skip: expect.stringContaining('no wrapped SOL') });
    expect(topUpNeed(held(PLAIN, S.amountLamports), S, 0n)).toEqual({ skip: expect.stringContaining('send it plain SOL') });
    expect(topUpNeed(held(PLAIN, S.amountLamports + 1n), S, 0n)).toEqual({ move: S.amountLamports });
  });

  it('moves at most the day’s most, all top-ups together', () => {
    expect(topUpNeed(held(PLAIN, WRAPPED), S, S.dayLamports - S.amountLamports)).toEqual({ move: S.amountLamports });
    expect(topUpNeed(held(PLAIN, WRAPPED), S, S.dayLamports - S.amountLamports + 1n)).toEqual({ skip: expect.stringContaining('until tomorrow') });
  });
});

describe('topUpInstructions', () => {
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);

  it('closes the wrapped-SOL account to the robot, opens it again, and wraps back all but the amount', () => {
    const ixs = topUpInstructions(owner, WRAPPED, S.amountLamports, S.microLamports, 60_000);
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM, TOKEN_PROGRAM]);
    const [, , close, open, send, sync] = ixs;
    // CloseAccount (9): the account, where its lamports go, who may close it.
    expect(close!.data).toEqual(Buffer.from([9]));
    expect(close!.keys.map((k) => k.pubkey.toBase58())).toEqual([ata, owner, owner].map((k) => k.toBase58()));
    // The associated account program's idempotent create (1), paid by the robot, for the robot, in wrapped SOL.
    expect(open!.data).toEqual(Buffer.from([1]));
    expect(open!.keys.slice(0, 4).map((k) => k.pubkey.toBase58())).toEqual([owner, ata, owner, NATIVE_MINT].map((k) => k.toBase58()));
    expect(send!.keys.map((k) => k.pubkey.toBase58())).toEqual([owner, ata].map((k) => k.toBase58()));
    expect(new DataView(send!.data.buffer, send!.data.byteOffset).getBigUint64(4, true)).toBe(WRAPPED - S.amountLamports);
    // SyncNative (17): the account's amount follows its lamports again.
    expect(sync!.data).toEqual(Buffer.from([17]));
    expect(sync!.keys.map((k) => k.pubkey.toBase58())).toEqual([ata.toBase58()]);
  });

  it('names no account but the robot, its wrapped-SOL account, the SOL mint and the programs', () => {
    const named = new Set(topUpInstructions(owner, WRAPPED, S.amountLamports, S.microLamports, 60_000).flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())));
    expect([...named].sort()).toEqual([owner, ata, NATIVE_MINT].map((k) => k.toBase58()).concat(SYSTEM, TOKEN_PROGRAM).sort());
  });

  it('never moves none or all of the wrapped SOL', () => {
    expect(() => topUpInstructions(owner, WRAPPED, 0n, S.microLamports, 60_000)).toThrow();
    expect(() => topUpInstructions(owner, WRAPPED, WRAPPED, S.microLamports, 60_000)).toThrow();
  });
});

describe('topUpProblem', () => {
  const before = held(PLAIN, WRAPPED);
  const fee = 5_600n;
  const after = (plain: bigint, wrapped: bigint | null) => held(plain, wrapped);

  it('passes the amount moved from wrapped to plain, less the fee', () => {
    expect(topUpProblem(before, after(PLAIN + S.amountLamports - fee, WRAPPED - S.amountLamports), S.amountLamports)).toBeNull();
  });

  it('refuses a closed account, more taken from the wrapped SOL, too little plain, or a cost past a fee', () => {
    expect(topUpProblem(before, after(PLAIN + S.amountLamports - fee, null), S.amountLamports)).toMatch(/closed/);
    expect(topUpProblem(before, after(PLAIN + S.amountLamports - fee, WRAPPED - S.amountLamports - 1n), S.amountLamports)).toMatch(/more than the top-up/);
    expect(topUpProblem(before, after(PLAIN + S.amountLamports - TOP_UP_MOST_COST - 1n, WRAPPED - S.amountLamports), S.amountLamports)).toMatch(/not rise/);
    expect(topUpProblem(before, { plain: PLAIN + S.amountLamports, wrapped: WRAPPED - S.amountLamports, wrappedLamports: WRAPPED - S.amountLamports + RENT - TOP_UP_MOST_COST - 1n }, S.amountLamports)).toMatch(/more than a fee/);
  });
});

/** The robot's chain: reads give `reads` in turn (the last one repeats); the test run leaves `simAfter`. */
function rig(reads: { plain: bigint; wrapped: bigint | null }[], simAfter = { plain: PLAIN + S.amountLamports - 5_600n, wrapped: WRAPPED - S.amountLamports as bigint | null }, simErr: unknown = null) {
  const owner = Keypair.generate().publicKey;
  let n = 0;
  const simulated: VersionedTransaction[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
    if (method === 'getMultipleAccounts') {
      const r = reads[Math.min(n++, reads.length - 1)]!;
      return { value: [wallet(r.plain), r.wrapped === null ? null : wsol(r.wrapped)] };
    }
    if (method === 'simulateTransaction') {
      simulated.push(VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64')));
      return { value: { err: simErr, logs: simErr ? ['Program log: Error: insufficient lamports'] : [], unitsConsumed: 30_000, accounts: [wallet(simAfter.plain), simAfter.wrapped === null ? null : wsol(simAfter.wrapped)] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const records: TripRecord[] = [];
  const sent: VersionedTransaction[] = [];
  const io = { rpc, owner, log: vi.fn(), record: (r: TripRecord) => records.push(r) } as unknown as Pick<KeeperIo, 'rpc' | 'owner' | 'send' | 'record' | 'log'>;
  const sendAs = (outcome: 'confirmed' | 'reverted' | 'unknown') =>
    (io.send = vi.fn(async (tx: VersionedTransaction) => {
      sent.push(tx);
      return { signature: 'sig', outcome };
    }));
  const methods = () => rpc.mock.calls.map((c) => c[0]);
  return { io, owner, records, sent, simulated, sendAs, methods };
}

const instructionsOf = (tx: VersionedTransaction) => TransactionMessage.decompile(tx.message).instructions;
const transferOf = (tx: VersionedTransaction) => {
  const ix = instructionsOf(tx).find((i) => i.programId.toBase58() === SYSTEM)!;
  return new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true);
};
const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true).toBase58();

describe('topUp', () => {
  it('reads plain SOL and stops there when it is not low: no test run', async () => {
    const r = rig([{ plain: S.belowLamports, wrapped: WRAPPED }]);
    expect(await topUp(r.io, S, 0n)).toEqual({ kind: 'enough', plain: S.belowLamports });
    expect(r.methods()).toEqual(['getMultipleAccounts']);
  });

  it('on a dry run, test-runs the top-up and sends nothing', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }]);
    expect(await topUp(r.io, S, 0n)).toEqual({ kind: 'tested', move: S.amountLamports });
    expect(r.simulated).toHaveLength(1);
    expect(transferOf(r.simulated[0]!)).toBe(WRAPPED - S.amountLamports);
    expect(r.records).toEqual([]);
  });

  it('live, sends it, reads back its cost, and logs it as a top-up, not a gain', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }, { plain: PLAIN + S.amountLamports - 5_600n, wrapped: WRAPPED - S.amountLamports }]);
    r.sendAs('confirmed');
    expect(await topUp(r.io, S, 0n)).toEqual({ kind: 'sent', move: S.amountLamports, moved: S.amountLamports, outcome: 'confirmed', signature: 'sig' });
    expect(r.sent).toHaveLength(1);
    expect(transferOf(r.sent[0]!)).toBe(WRAPPED - S.amountLamports);
    expect(r.sent[0]!.message.staticAccountKeys[0]!.equals(r.owner)).toBe(true);
    expect(r.records).toEqual([expect.objectContaining({ kind: 'top-up', pool: ataOf(r.owner), coinIn: S.amountLamports, gained: 0n, lamportsSpent: 5_600n, outcome: 'confirmed', signature: 'sig' })]);
    expect(r.records[0]!.coin.symbol).toBe('SOL');
  });

  it('counts a refused one as nothing moved, its fee spent', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }, { plain: PLAIN - 5_600n, wrapped: WRAPPED }]);
    r.sendAs('reverted');
    expect(await topUp(r.io, S, 0n)).toMatchObject({ kind: 'sent', moved: 0n, outcome: 'reverted' });
    expect(r.records[0]).toMatchObject({ kind: 'top-up', lamportsSpent: 5_600n, outcome: 'reverted' });
  });

  it('counts an unknown one as moved, and as its fee spent, without a read-back', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }]);
    r.sendAs('unknown');
    expect(await topUp(r.io, S, 0n)).toMatchObject({ kind: 'sent', moved: S.amountLamports, outcome: 'unknown' });
    // 5,000 a signature plus 46,000 units (30,000 used, a fifth more, 10,000 spare) at 10,000 micro-lamports.
    expect(r.records[0]).toMatchObject({ lamportsSpent: 5_460n, outcome: 'unknown' });
    expect(r.methods().filter((m) => m === 'getMultipleAccounts')).toHaveLength(1);
  });

  it('sends nothing when the test run is refused', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }], undefined, { InstructionError: [3, 'Custom'] });
    r.sendAs('confirmed');
    expect(await topUp(r.io, S, 0n)).toEqual({ kind: 'refused', why: expect.stringContaining('test run refused') });
    expect(r.sent).toEqual([]);
  });

  it('sends nothing when the test run does not move the amount to plain', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }], { plain: PLAIN, wrapped: WRAPPED - S.amountLamports });
    r.sendAs('confirmed');
    expect(await topUp(r.io, S, 0n)).toEqual({ kind: 'refused', why: expect.stringContaining('not rise') });
    expect(r.sent).toEqual([]);
  });

  it('test-runs nothing once the day’s most is moved', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }]);
    r.sendAs('confirmed');
    expect(await topUp(r.io, S, S.dayLamports)).toEqual({ kind: 'skipped', why: expect.stringContaining('until tomorrow') });
    expect(r.methods()).toEqual(['getMultipleAccounts']);
  });

  it('logs nothing when the send is held (the stop file, the day’s cap): the hold is the caller’s to say', async () => {
    const r = rig([{ plain: PLAIN, wrapped: WRAPPED }]);
    r.io.send = vi.fn(async () => {
      throw new Error('paused: price-keeper-STOP exists');
    });
    await expect(topUp(r.io, S, 0n)).rejects.toThrow('paused');
    expect(r.records).toEqual([]);
  });
});
