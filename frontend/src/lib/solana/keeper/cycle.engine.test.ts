// @vitest-environment node
//
// A trip the engine handed over, through the robot's own send step: the legs in order, each
// spending exactly what the one before pays by the robot's own quote, the last leg's minimum and
// the Lighthouse floor; a transfer-fee coin left to the pass; the engine's size held to the cap;
// and one trip at a time through the step. The chain is made up here (a test run that gains what
// the legs say); the step itself runs as it does live, as a dry run.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { DEFAULT_SETTINGS, engineTrip, tripInstructions, withTripLock, type KeeperIo, type KeeperSettings } from './cycle';
import type { EngineRecord, RouteLeg } from './engine';
import { LIGHTHOUSE_PROGRAM, floorOfCheck } from './lighthouse';
import { DEFAULT_LIMITS, lastPoolMinimum } from './plan';
import { coinBounds } from './rule';

const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const SOL = 10n ** 9n;
const HELD = 100n * SOL;
const MINT = Keypair.generate().publicKey.toBase58();
const PROGRAMS = { A: Keypair.generate().publicKey, M: Keypair.generate().publicKey, B: Keypair.generate().publicKey };
const s: KeeperSettings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, raydiumPrograms: [], directLookupTables: [], maxTradeUsd: 10_000, lighthouseProven: true, payNewAccountRent: true };
const usd = new Map([[SOL_QUOTE.mint, 200], [USDC_QUOTE.mint, 1]]);
const FLOOR = (coinBounds(SOL_QUOTE, 200, 200, s) as { floor: bigint }).floor;

const token = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
};
/** A plain token mint: 6 decimals, initialized, no freeze authority, no extensions. */
const mintAccount = () => {
  const data = new Uint8Array(82);
  data[44] = 6;
  data[45] = 1;
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 1_461_600, executable: false, rentEpoch: 0 };
};
const wallet = { data: ['', 'base64'], owner: SYSTEM, lamports: 50_000_000, executable: false, rentEpoch: 0 };

/** A made-up leg: `out` as given, each build recorded under `tag`. */
function leg(tag: keyof typeof PROGRAMS, pool: string, from: string, to: string, out: (x: bigint) => bigint | null, calls: { tag: string; amountIn: bigint; minOut: bigint }[]): RouteLeg {
  return {
    pool, dex: 'ours', venue: `Venue ${tag}`, from, to, fromProgram: TOKEN_PROGRAM_ID, toProgram: TOKEN_PROGRAM_ID, out,
    ix: (amountIn, minOut) => {
      calls.push({ tag, amountIn, minOut });
      return new TransactionInstruction({ programId: PROGRAMS[tag], keys: [], data: Buffer.from(tag) });
    },
  };
}

function record(legs: RouteLeg[], over: Partial<EngineRecord> = {}): EngineRecord {
  const now = Date.now();
  return {
    id: `${legs.map((l) => l.pool).join('>')}@1@${now}`, route: legs.map((l) => l.pool).join('>'), at: now, slot: 1, expiresAt: now + 800,
    coinMint: SOL_QUOTE.mint, tokenMint: MINT, symbol: 'X', decimals: 6,
    legs: legs.map((l) => ({ pool: l.pool, dex: 'ours' as const, from: l.from, to: l.to, fee: 0.003, inCut: 0, outCut: 0, accounts: [] })),
    inRaw: SOL, outs: [2n * SOL, SOL + 1_000_000n], netUsd: 0.1, netAllUsd: 0.08, tipUsd: 0.01, gapPct: 1, mints: {}, usd,
    ...over,
  };
}

/** The robot's io on a made-up chain whose test run gains `gain`; the transactions it test-ran are kept, and every read is noted. */
function rig(legs: RouteLeg[], gain: bigint, simDelayMs = 0) {
  const ran: VersionedTransaction[] = [];
  const events: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
    if (method === 'getMultipleAccounts') {
      const addresses = params[0] as string[];
      if (addresses[0] === MINT) return { value: [mintAccount(), null] };
      events.push('balances');
      return { value: [token(HELD), null, token(0n), wallet] };
    }
    if (method === 'simulateTransaction') {
      events.push('sim');
      if (simDelayMs) await new Promise((r) => setTimeout(r, simDelayMs));
      ran.push(VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64')));
      return { value: { err: null, unitsConsumed: 150_000, accounts: [token(HELD + gain), token(0n), token(0n), wallet] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const io = { rpc, owner: Keypair.generate().publicKey, log: vi.fn(), routeLegs: vi.fn(async () => ({ legs, slot: 1 })) } as unknown as KeeperIo;
  const programs = (i = 0) => TransactionMessage.decompile(ran[i]!.message).instructions.map((x) => x.programId.toBase58());
  const check = (i = 0) => floorOfCheck(TransactionMessage.decompile(ran[i]!.message).instructions.at(-1)!);
  return { io, ran, events, programs, check };
}

describe('engineTrip: a handed-over trip through the send step', () => {
  it('two legs: each spends exactly what the one before pays by the robot’s own quote; the last is held to what went in plus the floor', async () => {
    const calls: { tag: string; amountIn: bigint; minOut: bigint }[] = [];
    const gain = 1_000_000n;
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x * 2n, calls), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (t) => t / 2n + gain, calls)];
    const r = rig(legs, gain);
    expect(await engineTrip(r.io, s, record(legs), 'X')).toBe('not-sent');
    expect(r.programs().slice(-3)).toEqual([PROGRAMS.A.toBase58(), PROGRAMS.B.toBase58(), LIGHTHOUSE_PROGRAM.toBase58()]);
    const lastMin = lastPoolMinimum(SOL + gain, SOL + FLOOR, s.slippageBps)!;
    expect(calls).toEqual([{ tag: 'A', amountIn: SOL, minOut: 2n * SOL }, { tag: 'B', amountIn: 2n * SOL, minOut: lastMin }]);
    expect(lastMin).toBeGreaterThanOrEqual(SOL + FLOOR);
    expect(r.check()!.min).toBe(HELD + FLOOR);
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('Venue A > Venue B'));
  });
  it('three legs through the robot’s other coin: that coin’s account is opened first, and watched in the other’s place', async () => {
    const calls: { tag: string; amountIn: bigint; minOut: bigint }[] = [];
    const gain = 2_000_000n;
    const legs = [
      leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x * 2n, calls),
      leg('M', 'poolM', MINT, USDC_QUOTE.mint, (t) => t / 10n, calls),
      leg('B', 'poolB', USDC_QUOTE.mint, SOL_QUOTE.mint, (u) => u * 5n + gain, calls),
    ];
    const r = rig(legs, gain);
    const rec = record(legs, { outs: [2n * SOL, SOL / 5n, SOL + gain] });
    expect(await engineTrip(r.io, s, rec, 'X')).toBe('not-sent');
    expect(r.programs().slice(-5)).toEqual([ATA_PROGRAM, PROGRAMS.A.toBase58(), PROGRAMS.M.toBase58(), PROGRAMS.B.toBase58(), LIGHTHOUSE_PROGRAM.toBase58()]);
    expect(calls.map((c) => c.amountIn)).toEqual([SOL, 2n * SOL, SOL / 5n]);
    expect(calls[1]!.minOut).toBe(SOL / 5n);
    expect(r.check()!.min).toBe(HELD + FLOOR);
  });
  it('holds the engine’s size to the rule’s cap', async () => {
    const calls: { tag: string; amountIn: bigint; minOut: bigint }[] = [];
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x * 2n, calls), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (t) => t / 2n + 10_000_000n, calls)];
    const r = rig(legs, 10_000_000n);
    // $10,000 at $200: 50 SOL; the engine asked for 80.
    await engineTrip(r.io, s, record(legs, { inRaw: 80n * SOL }), 'X');
    expect(calls[0]!.amountIn).toBe(50n * SOL);
  });
  it('leaves a transfer-fee coin to the pass, asking the chain nothing', async () => {
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x, []), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (x) => x, [])];
    const r = rig(legs, 0n);
    const rec = record(legs);
    rec.legs[0]!.outCut = 0.03;
    expect(await engineTrip(r.io, s, rec, 'X')).toBe('no-plan');
    expect(r.io.rpc).not.toHaveBeenCalled();
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('transfer fee'));
  });
  it('is quote-short when its own quotes do not bring back what went in plus the floor, and test-runs nothing', async () => {
    const calls: { tag: string; amountIn: bigint; minOut: bigint }[] = [];
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x * 2n, calls), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (t) => t / 2n + FLOOR - 1n, calls)];
    const r = rig(legs, 0n);
    expect(await engineTrip(r.io, s, record(legs), 'X')).toBe('quote-short');
    expect(r.events).toEqual(['balances']);
    expect(calls).toEqual([]);
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('under the floor'));
  });
  it('refuses legs that do not match the record’s route', async () => {
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x, []), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (x) => x, [])];
    const r = rig(legs, 0n);
    const rec = record(legs);
    rec.legs[1]!.pool = 'poolC';
    expect(await engineTrip(r.io, s, rec, 'X')).toBe('no-plan');
    expect(r.events).toEqual([]);
  });
  it('skips a trip the reader cannot build, saying why', async () => {
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x, []), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (x) => x, [])];
    const r = rig(legs, 0n);
    (r.io.routeLegs as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce('pool poolB is not a Meteora DLMM pool');
    expect(await engineTrip(r.io, s, record(legs), 'X')).toBe('no-plan');
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('not a Meteora DLMM pool'));
  });
  it('runs one trip at a time through the step: the second reads its balances only after the first’s test run', async () => {
    const gain = 1_000_000n;
    const legs = [leg('A', 'poolA', SOL_QUOTE.mint, MINT, (x) => x * 2n, []), leg('B', 'poolB', MINT, SOL_QUOTE.mint, (t) => t / 2n + gain, [])];
    const r = rig(legs, gain, 20);
    const results = await Promise.all([engineTrip(r.io, s, record(legs), 'first'), engineTrip(r.io, s, record(legs, { route: 'other' }), 'second')]);
    expect(results).toEqual(['not-sent', 'not-sent']);
    expect(r.events).toEqual(['balances', 'sim', 'balances', 'sim']);
  });
});

describe('tripInstructions, given the balances read before the trip', () => {
  const owner = Keypair.generate().publicKey;
  const swap = new TransactionInstruction({ programId: owner, keys: [], data: Buffer.from([1]) });
  const accounts = { coinAta: Keypair.generate().publicKey, tokenAta: Keypair.generate().publicKey, otherAta: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, coinMint: new PublicKey(SOL_QUOTE.mint) };
  const before = { coin: 1n, token: 0n, tokenExists: true, other: 0n, otherExists: true, lamports: 1n };
  const opens = (ixs: TransactionInstruction[]) => ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM).length;
  it('opens neither account when both exist, only the token’s when it is new, and both when nothing was read', () => {
    expect(opens(tripInstructions(owner, { accounts, legs: [swap], floor: 1n, before }, 1, 1, 0n))).toBe(0);
    expect(opens(tripInstructions(owner, { accounts, legs: [swap], floor: 1n, before: { ...before, tokenExists: false } }, 1, 1, 0n))).toBe(1);
    expect(opens(tripInstructions(owner, { accounts, legs: [swap], floor: 1n }, 1, 1, 0n))).toBe(2);
  });
  it('still ends with the Lighthouse check, and a loan’s repayment still names the borrow’s place', () => {
    const ixs = tripInstructions(owner, { accounts, legs: [swap, swap], floor: 5n, loan: 7n, before }, 1, 1, 100n);
    expect(floorOfCheck(ixs.at(-1)!)).toEqual({ account: accounts.coinAta, min: 105n });
    const at = ixs.findIndex((ix) => !ix.programId.equals(owner) && ix.data.length === 16);
    expect(at).toBe(2);
    expect(ixs.at(-2)!.data[16]).toBe(at);
  });
});

describe('withTripLock', () => {
  it('runs each piece after the one before, and a failure does not hold the lock', async () => {
    const order: string[] = [];
    const slow = withTripLock(async () => {
      order.push('a starts');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a ends');
      throw new Error('a fails');
    });
    const quick = withTripLock(async () => {
      order.push('b');
      return 'b';
    });
    await expect(slow).rejects.toThrow('a fails');
    expect(await quick).toBe('b');
    expect(order).toEqual(['a starts', 'a ends', 'b']);
  });
});

// `PublicKey` is used by the made-up chain's types only.
void PublicKey;
