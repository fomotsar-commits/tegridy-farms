// @vitest-environment node
//
// The fast path (KEEPER_FAST; owner 2026-11-10, against a rival bot that lands in the same block as
// the trades it follows): an engine trip in SOL through Jito, its swaps built from the engine's copy
// of the pools, sent with NO test run and no second balance read, the tip sized from the robot's
// own quote, each swap's minimum and the Lighthouse floor still in it; and every case that must
// still take the usual test run. The chain is made up (keeper/cycle.engine.test.ts's way).
import { describe, it, expect, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { DEFAULT_SETTINGS, FAST_SNAPSHOT_MAX_AGE_SLOTS, engineTrip, fastUnits, type KeeperIo, type KeeperSettings } from './cycle';
import type { EngineRecord, EngineSnapshot, RouteLeg } from './engine';
import { JITO_TIP_ACCOUNTS } from './jito';
import { floorOfCheck } from './lighthouse';
import { DEFAULT_LIMITS } from './plan';
import { coinBounds } from './rule';

const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const SYSTEM = '11111111111111111111111111111111';
const SOL = 10n ** 9n;
const HELD = 100n * SOL;
const MINT = Keypair.generate().publicKey.toBase58();
const usd = new Map([[SOL_QUOTE.mint, 200], [USDC_QUOTE.mint, 1]]);
const base: KeeperSettings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, raydiumPrograms: [], directLookupTables: [], maxTradeUsd: 10_000, lighthouseProven: true, payNewAccountRent: true, jito: true, fast: true };
const FLOOR = (coinBounds(SOL_QUOTE, 200, 200, base) as { floor: bigint }).floor;

const token = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
};
const mintAccount = () => {
  const data = new Uint8Array(82);
  data[44] = 6;
  data[45] = 1;
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 1_461_600, executable: false, rentEpoch: 0 };
};
const wallet = { data: ['', 'base64'], owner: SYSTEM, lamports: 50_000_000, executable: false, rentEpoch: 0 };

/** Two of our pools: SOL in, the token, SOL back with `gain` more. */
function legsFor(gain: bigint): RouteLeg[] {
  const ix = (tag: string) => () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from(tag) });
  return [
    { pool: Keypair.generate().publicKey.toBase58(), dex: 'ours', venue: 'A', from: SOL_QUOTE.mint, to: MINT, fromProgram: TOKEN_PROGRAM_ID, toProgram: TOKEN_PROGRAM_ID, out: (x) => 2n * x, ix: ix('a') },
    { pool: Keypair.generate().publicKey.toBase58(), dex: 'ours', venue: 'B', from: MINT, to: SOL_QUOTE.mint, fromProgram: TOKEN_PROGRAM_ID, toProgram: TOKEN_PROGRAM_ID, out: (y) => y / 2n + gain, ix: ix('b') },
  ];
}
const snapshotAt = (slot: number): EngineSnapshot => ({ slot, accounts: new Map([[Keypair.generate().publicKey.toBase58(), { owner: SYSTEM, data: new Uint8Array([1]) }]]) });
function record(legs: RouteLeg[], over: Partial<EngineRecord> = {}): EngineRecord {
  const now = Date.now();
  return {
    id: `r@100@${now}`, route: legs.map((l) => l.pool).join('>'), at: now, slot: 100, expiresAt: now + 800,
    coinMint: SOL_QUOTE.mint, tokenMint: MINT, symbol: 'X', decimals: 6,
    legs: legs.map((l) => ({ pool: l.pool, dex: 'ours' as const, from: l.from, to: l.to, fee: 0.003, inCut: 0, outCut: 0, accounts: [] })),
    inRaw: SOL, outs: [2n * SOL, SOL + 1_000_000n], netUsd: 0.1, netAllUsd: 0.08, tipUsd: 0.01, gapPct: 1, mints: {}, usd,
    snapshot: snapshotAt(98),
    ...over,
  };
}

function rig(legs: RouteLeg[], gain: bigint) {
  const calls: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
    if (method === 'getMultipleAccounts') {
      if ((params[0] as string[])[0] === MINT) return { value: [mintAccount(), null] };
      calls.push('balances');
      return { value: [token(HELD), null, token(0n), wallet] };
    }
    if (method === 'simulateTransaction') return { value: { err: null, unitsConsumed: 150_000, accounts: [token(HELD + gain), token(0n), token(0n), wallet] } };
    throw new Error(`unexpected ${method}`);
  });
  const toJito: VersionedTransaction[] = [];
  const routeLegs = vi.fn(async () => ({ legs, slot: 100, reads: 0 }));
  const io = {
    rpc, owner: Keypair.generate().publicKey, log: vi.fn(), routeLegs,
    send: vi.fn(async () => ({ signature: 'S', outcome: 'confirmed' as const })),
    sendJito: vi.fn(async (tx: VersionedTransaction) => (toJito.push(tx), { signature: 'J', outcome: 'confirmed' as const })),
    recentBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58() })),
  } as unknown as KeeperIo;
  const said = () => (io.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');
  return { io, calls, toJito, routeLegs, said };
}
const GAIN = 1_000_000n;

describe('the fast path (KEEPER_FAST)', () => {
  it('sends an engine trip in SOL through Jito with no test run, no second balance read and no blockhash asked for at the send', async () => {
    const legs = legsFor(GAIN);
    const r = rig(legs, GAIN);
    const rec = record(legs);
    expect(await engineTrip(r.io, base, rec, 'T')).toBe('sent');
    // Built from the engine's copy, at the slot it judged at.
    expect(r.routeLegs.mock.calls[0]![3]).toEqual({ snapshot: rec.snapshot, slot: 100 });
    expect(r.calls).not.toContain('simulateTransaction');
    expect(r.calls).not.toContain('getLatestBlockhash');
    // One balance read before the trip (the floor counts from it); one after, for the log.
    expect(r.calls.filter((c) => c === 'balances')).toHaveLength(2);
    expect(r.io.send).not.toHaveBeenCalled();
    expect(r.toJito).toHaveLength(1);
    const ixs = TransactionMessage.decompile(r.toJito[0]!.message).instructions;
    // The compute limit: two of our swaps, the token's new account and the rest (fastUnits).
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(new DataView(ixs[0]!.data.buffer, ixs[0]!.data.byteOffset).getUint32(1, true)).toBe(fastUnits(['ours', 'ours'], 1, false));
    // The tip: 30% of the robot's own quoted gain; the floor holds the coin to held + floor + tip.
    const tipIx = ixs.at(-2)!;
    expect(JITO_TIP_ACCOUNTS).toContain(tipIx.keys[1]!.pubkey.toBase58());
    const tip = new DataView(tipIx.data.buffer, tipIx.data.byteOffset).getBigUint64(4, true);
    expect(tip).toBe((GAIN * 30n) / 100n);
    const check = floorOfCheck(ixs.at(-1)!)!;
    expect(check.min - HELD - tip).toBeGreaterThanOrEqual(FLOOR);
    expect(r.said()).toMatch(/fast, no test run/);
  });

  it.each([
    ['KEEPER_FAST off', { ...base, fast: false }, {}],
    ['Jito off', { ...base, jito: false }, {}],
    ['no copy from the engine', base, { snapshot: undefined }],
    ['a copy too old to build from', base, { snapshot: snapshotAt(100 - FAST_SNAPSHOT_MAX_AGE_SLOTS - 1) }],
  ])('takes the usual test run with %s, and reads the pools itself', async (_what, s, over) => {
    const legs = legsFor(GAIN);
    const r = rig(legs, GAIN);
    await engineTrip(r.io, s, record(legs, over), 'T');
    expect(r.calls).toContain('simulateTransaction');
    expect(r.routeLegs.mock.calls[0]![3]).toBeUndefined();
    expect(r.said()).not.toMatch(/fast, no test run/);
  });

  it('takes the usual test run when its quoted gain is too small to tip', async () => {
    // Over the floor by 2,000 lamports: a tip may not eat into the floor, so the most it could be is
    // 2,000, under Jito's least tip that lands (20,000 lamports).
    const small = FLOOR + 2_000n;
    expect(small - FLOOR).toBeLessThan(20_000n);
    const legs = legsFor(small);
    const r = rig(legs, small);
    await engineTrip(r.io, base, record(legs), 'T');
    expect(r.calls).toContain('simulateTransaction');
    expect(r.said()).toMatch(/leaves no Jito tip, so not fast/);
  });

  it('asks for room by the exchanges a trip swaps on, never past the most a transaction may use', () => {
    expect(fastUnits(['ours', 'ours'], 0, false)).toBe(220_000);
    expect(fastUnits(['ammV4', 'ours'], 1, true)).toBe(80_000 + 90_000 + 30_000 + 80_000 + 40_000);
    expect(fastUnits(['clmm', 'clmm', 'clmm', 'clmm'], 2, true)).toBe(1_400_000);
    expect(fastUnits(['somewhere-new'], 0, false)).toBe(400_000);
    expect(new PublicKey(SYSTEM).toBase58()).toBe(SYSTEM);
  });
});
