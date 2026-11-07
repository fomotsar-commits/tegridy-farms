// @vitest-environment node
//
// A direct trip through the robot's own send step: the legs in order, the last leg's minimum,
// and the Lighthouse floor, as directTrip hands them to sendChecked. The chain is made up here
// (a test run that gains what the plan says); the step itself runs as it does live, as a dry run.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { REGISTERED_PROGRAM_ID } from '../cpswap/program';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import { SOL_QUOTE } from '../lp/quotes';
import { DEFAULT_SETTINGS, directTrip, type KeeperIo, type KeeperSettings } from './cycle';
import { directPlan, type DirectPool } from './direct';
import { LIGHTHOUSE_PROGRAM, floorOfCheck } from './lighthouse';
import { DEFAULT_LIMITS, lastPoolMinimum } from './plan';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const NOW = 10_000_000n;
const SOL = 10n ** 9n;
const HELD = 100n * SOL;
const usd = new Map([[SOL_QUOTE.mint, 200]]);
const OUTSIDE_PROGRAM = Keypair.generate().publicKey;
const token = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
};
const wallet = { data: ['', 'base64'], owner: SYSTEM, lamports: 50_000_000, executable: false, rentEpoch: 0 };

const mint = key();
const view = viewOf(buildPool({ mint, address: key(), quoteReserve: 50n * SOL, tokenReserve: 10n ** 9n }), { sol: 50n * SOL, tok: 10n ** 9n });
const s: KeeperSettings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, raydiumPrograms: [], direct: true, directLookupTables: [], maxTradeUsd: 10_000, lighthouseProven: true, payNewAccountRent: true };

/** An outside x·y = k pool (0.25% fee) whose swaps are marked instructions, each call recorded. */
function outside(sol: bigint, tok: bigint) {
  const out = (rin: bigint, rout: bigint, x: bigint) => {
    const xin = x - (x * 25n + 9_999n) / 10_000n;
    return (rout * xin) / (rin + xin);
  };
  const calls: { side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint }[] = [];
  const ix = (side: 'buy' | 'sell') => new TransactionInstruction({ programId: OUTSIDE_PROGRAM, keys: [], data: Buffer.from(side) });
  const d: DirectPool = {
    address: key().toBase58(), venue: 'PumpSwap', tokenMint: mint.toBase58(),
    buy: (x) => ({ tokens: out(sol, tok, x), spent: x }),
    sell: (t) => out(tok, sol, t),
    buyIx: (_, amountIn, minOut) => (calls.push({ side: 'buy', amountIn, minOut }), ix('buy')),
    sellIx: (_, amountIn, minOut) => (calls.push({ side: 'sell', amountIn, minOut }), ix('sell')),
  };
  return { d, calls };
}

/** The robot's io on a made-up chain whose test run gains `gain`; the transaction it test-ran is kept. */
function rig(gain: bigint) {
  const ran: VersionedTransaction[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getLatestBlockhash') return { value: { blockhash: key().toBase58() } };
    if (method === 'getMultipleAccounts') return { value: [token(HELD), null, token(0n), wallet] };
    if (method === 'simulateTransaction') {
      ran.push(VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64')));
      return { value: { err: null, unitsConsumed: 150_000, accounts: [token(HELD + gain), token(0n), token(0n), wallet] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const io = { rpc, owner: key(), log: vi.fn() } as unknown as KeeperIo;
  const programs = () => TransactionMessage.decompile(ran[0]!.message).instructions.map((i) => i.programId.toBase58());
  const check = () => floorOfCheck(TransactionMessage.decompile(ran[0]!.message).instructions.at(-1)!);
  return { io, ran, programs, check };
}

describe('directTrip: our pool against an outside pool, through the send step', () => {
  it('coin dearer outside: buys in our pool, sells all of it outside, last leg held to what went in plus the floor', async () => {
    const { d, calls } = outside(50n * SOL, 9n * 10n ** 8n);
    const plan = directPlan(view, d, Number(NOW), usd, s, HELD)!;
    const r = rig(plan.profit);
    expect(await directTrip(r.io, s, view, d, NOW, usd, 'X')).toBe('not-sent');
    expect(r.programs().slice(-3)).toEqual([REGISTERED_PROGRAM_ID.toBase58(), OUTSIDE_PROGRAM.toBase58(), LIGHTHOUSE_PROGRAM.toBase58()]);
    expect(calls).toEqual([{ side: 'sell', amountIn: plan.tokens, minOut: lastPoolMinimum(plan.coinOut, plan.spent + plan.minProfit, s.slippageBps) }]);
    expect(calls[0]!.minOut).toBeGreaterThanOrEqual(plan.coinIn + plan.minProfit);
    expect(r.check()!.min).toBe(HELD + plan.minProfit);
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('buy here, sell in PumpSwap'));
  });
  it('coin cheaper outside: buys outside first, exactly the coins our pool then sells', async () => {
    const { d, calls } = outside(50n * SOL, 11n * 10n ** 8n);
    const plan = directPlan(view, d, Number(NOW), usd, s, HELD)!;
    const r = rig(plan.profit);
    expect(await directTrip(r.io, s, view, d, NOW, usd, 'X')).toBe('not-sent');
    expect(r.programs().slice(-3)).toEqual([OUTSIDE_PROGRAM.toBase58(), REGISTERED_PROGRAM_ID.toBase58(), LIGHTHOUSE_PROGRAM.toBase58()]);
    expect(calls).toEqual([{ side: 'buy', amountIn: plan.coinIn, minOut: plan.tokens }]);
    expect(r.check()!.min).toBe(HELD + plan.minProfit);
  });
  it('on a thin gap the last leg must still bring back what went in plus the floor, past the slippage allowance', async () => {
    // A gap whose profit is under 0.5% of what the last leg pays: there the allowance alone would accept a loss.
    let thin: { plan: NonNullable<ReturnType<typeof directPlan>>; o: ReturnType<typeof outside> } | null = null;
    for (let tok = 990_000_000n; tok >= 900_000_000n && !thin; tok -= 500_000n) {
      const o = outside(50n * SOL, tok);
      const plan = directPlan(view, o.d, Number(NOW), usd, s, HELD);
      if (plan && (plan.coinOut * (10_000n - BigInt(s.slippageBps))) / 10_000n < plan.spent + plan.minProfit) thin = { plan, o };
    }
    expect(thin).not.toBeNull();
    const r = rig(thin!.plan.profit);
    await directTrip(r.io, s, view, thin!.o.d, NOW, usd, 'X');
    expect(thin!.o.calls[0]!.minOut).toBe(thin!.plan.spent + thin!.plan.minProfit);
  });
  it('asks the chain nothing when no trip clears the floor', async () => {
    const { d, calls } = outside(50n * SOL, 10n ** 9n);
    const r = rig(0n);
    expect(await directTrip(r.io, s, view, d, NOW, usd, 'X')).toBe('none');
    expect(r.io.rpc).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it('a new coin account’s rent must be earned unless the owner pays it', async () => {
    const RENT = 2_074_080n;
    const strict = { ...s, payNewAccountRent: false };
    // A gap that clears the floor but not the floor and the rent of the coin account it opens.
    let found: { d: DirectPool; calls: unknown[] } | null = null;
    for (let tok = 990_000_000n; tok >= 900_000_000n && !found; tok -= 1_000_000n) {
      const o = outside(50n * SOL, tok);
      const p = directPlan(view, o.d, Number(NOW), usd, strict, HELD);
      if (p && p.profit < p.minProfit + RENT) found = o;
    }
    expect(found).not.toBeNull();
    const r = rig(0n);
    expect(await directTrip(r.io, strict, view, found!.d, NOW, usd, 'X')).toBe('none');
    expect(r.io.log).toHaveBeenCalledWith(expect.stringContaining('under the floor'));
    expect(found!.calls).toEqual([]);
    // The owner paying it (KEEPER_PAY_SETUP), the same trip goes to its test run.
    expect(await directTrip(rig(1n).io, s, view, found!.d, NOW, usd, 'X')).not.toBe('none');
  });
});
