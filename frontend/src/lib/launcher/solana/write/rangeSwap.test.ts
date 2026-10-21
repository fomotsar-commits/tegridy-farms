// @vitest-environment node
//
// A swap in a range pool, against a fake chain whose simulator walks the pool's bands with
// the program's own swap maths (solana/clmm/quote.ts, held to the program's Rust and to 23
// replayed mainnet swaps) and refuses below the floor. Then the checker: every change a
// wallet or a stranger could make to the swap is refused.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { BPF_LOADER_UPGRADEABLE_ID } from '../curve/read';
import { associatedTokenAddress } from '../curve/ix';
import {
  FEE_ON_TOKEN_0_ONLY,
  IX_SWAP_V2,
  POOL_STATUS_BIT,
  decodePoolState,
  decodeTickArray,
  deriveAmmConfig,
  deriveObservation,
  derivePool,
  deriveTickArray,
  deriveVault,
  sortMints,
} from '../../../solana/clmm/program';
import { getSqrtPriceAtTick } from '../../../solana/clmm/math';
import { quoteSwap } from '../../../solana/clmm/quote';
import { encodeAmmConfig, encodePool, encodeTickArray } from '../../../solana/clmm/encode.fixture';
import { decodeIntent } from './intent';
import { RANGE_SWAP_COPY, prepareRangeSwap, rangeSwapStepsProblem } from './rangeSwap';
import { RANGE_COPY } from './range';
import { VENUE_SWAP_COPY } from './venueSwap';
import { FakeChain, cfgLocal, openAccount, rent, setClock, type SimHandler } from './testkit.fixture';
import type { AggregatorSeen, IntentStep, PreparedTx, RangeIntent, RangeSwapSummary, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const PROG = Keypair.generate().publicKey;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const TOKEN = Keypair.generate().publicKey;
const SPACING = 120;
const { token0: MINT0, token1: MINT1 } = sortMints(WSOL_MINT, TOKEN);
const TOKEN_IS_0 = MINT0.equals(TOKEN);
const CONFIG = deriveAmmConfig(PROG, 0);
const POOL = derivePool(PROG, CONFIG, MINT0, MINT1);
const TICK = 600;
const SQRT = getSqrtPriceAtTick(TICK) + 12_345n;
const L = 10n ** 13n;
const TOKEN_ATA = associatedTokenAddress(TOKEN, ME, TOKEN_PROGRAM_ID);
/** The wallet's account for the token when the token is a Token-2022 coin (170 bytes, not 165). */
const TOKEN_ATA_2022 = associatedTokenAddress(TOKEN, ME, TOKEN_2022_PROGRAM_ID);
const tokenAtaOf = (c: FakeChain) => (c.accounts.get(TOKEN.toBase58())!.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_ATA_2022 : TOKEN_ATA);
const WSOL_ATA = associatedTokenAddress(WSOL_MINT, ME);
const NOW = 1_800_000_000n;
const NOT_ASKED: AggregatorSeen = { kind: 'unreachable' };

function chainWith(o: { status?: number; deploy?: boolean; bandMissing?: boolean; frozenVault?: 0 | 1; token2022?: boolean; tokens?: bigint | null; feeOn?: number } = {}): FakeChain {
  const c = new FakeChain();
  if (o.deploy !== false) {
    const pd = Keypair.generate().publicKey;
    const stub = new Uint8Array(36);
    new DataView(stub.buffer).setUint32(0, 2, true);
    stub.set(pd.toBytes(), 4);
    c.set(PROG, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: stub, executable: true });
  }
  c.set(CONFIG, { lamports: rent(117), owner: PROG, data: encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0, tickSpacing: SPACING }) });
  c.set(POOL, {
    lamports: rent(1544),
    owner: PROG,
    data: encodePool({
      ammConfig: CONFIG, mint0: MINT0, mint1: MINT1,
      vault0: deriveVault(PROG, POOL, MINT0), vault1: deriveVault(PROG, POOL, MINT1), observation: deriveObservation(PROG, POOL),
      decimals0: TOKEN_IS_0 ? 6 : 9, decimals1: TOKEN_IS_0 ? 9 : 6, tickSpacing: SPACING, liquidity: L, sqrtPriceX64: SQRT, tickCurrent: TICK,
      status: o.status, bitmapBits: [512], feeOn: o.feeOn,
    }),
  });
  // The pool's two vaults: a frozen one moves nothing in or out.
  [MINT0, MINT1].forEach((mint, i) => {
    const vault = deriveVault(PROG, POOL, mint);
    const state = { state: o.frozenVault === i ? (2 as const) : (1 as const) };
    if (mint.equals(TOKEN) && o.token2022) c.token2022Account(vault, mint, POOL, 10n ** 15n, state);
    else c.tokenAccount(vault, mint, POOL, 10n ** 15n, state);
  });
  // One position across ticks 0 to 1200: the liquidity a small swap walks through.
  if (!o.bandMissing) {
    c.set(deriveTickArray(PROG, POOL, 0), {
      lamports: rent(10_240),
      owner: PROG,
      data: encodeTickArray(POOL, 0, SPACING, [
        { tick: 0, liquidityNet: L, liquidityGross: L },
        { tick: 1200, liquidityNet: -L, liquidityGross: L },
      ]),
    });
  }
  if (o.token2022) c.mint2022(TOKEN, [], { decimals: 6 });
  else c.mint(TOKEN, { decimals: 6 });
  c.mint(WSOL_MINT, { decimals: 9 });
  c.fund(ME, 50_000_000_000);
  if (o.tokens !== null) {
    if (o.token2022) c.token2022Account(TOKEN_ATA_2022, TOKEN, ME, o.tokens ?? 1_000_000_000_000n);
    else c.tokenAccount(TOKEN_ATA, TOKEN, ME, o.tokens ?? 1_000_000_000_000n);
  }
  setClock(c, NOW);
  c.simulate = swapSim;
  return c;
}

const amountAt = (c: FakeChain, k: PublicKey) => {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};

/** The program's swap on the chain's accounts: what it takes, pays and refuses. */
const swapSim: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const r = ixs.find((i) => i.program.equals(PROG));
  if (!r || !IX_SWAP_V2.every((b, i) => r.data[i] === b)) return { err: 'no swap', logs: [], unitsConsumed: 1 };
  const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  const pool = decodePoolState(POOL.toBase58(), chain.accounts.get(POOL.toBase58())!.data)!;
  if ((pool.status & (1 << POOL_STATUS_BIT.swap)) !== 0) return { err: { InstructionError: [2, { Custom: 6000 }] }, logs: [], unitsConsumed: 1 };
  const amount = dv.getBigUint64(8, true);
  const floor = dv.getBigUint64(16, true);
  const zeroForOne = r.accounts[11]!.equals(MINT0);
  const bandAt = (s: number) => {
    const a = chain.accounts.get(deriveTickArray(PROG, POOL, s).toBase58());
    return a ? (decodeTickArray('', a.data) ?? undefined) : undefined;
  };
  const q = quoteSwap({ pool, config: { tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0 }, band: bandAt, extension: null, zeroForOne, isBaseInput: true, amount, sqrtPriceLimitX64: 0n, blockTimestamp: Number(NOW) });
  if (q.kind !== 'ok') return { err: { InstructionError: [2, { Custom: 6029 }] }, logs: [], unitsConsumed: 1 };
  if (q.amountOut < floor) return { err: { InstructionError: [2, { Custom: 6022 }] }, logs: [`Program ${PROG.toBase58()} failed: TooLittleOutputReceived`], unitsConsumed: 40_000 };
  const wrapped = ixs.filter((i) => i.program.equals(SystemProgram.programId)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
  const tokenAta = tokenAtaOf(chain);
  const paidToOpen = ixs.filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[1]!.equals(TOKEN_ATA_2022) ? 170 : 165).paid, 0);
  const closesWsol = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  const wsolBefore = amountAt(chain, WSOL_ATA) ?? 0n;
  const wsolLamports = openAccount(chain, WSOL_ATA).lamports;
  const paysToken = zeroForOne === TOKEN_IS_0;
  const dToken = paysToken ? -amount : q.amountOut;
  const dSol = paysToken ? q.amountOut : -amount;
  const tokenBefore = amountAt(chain, tokenAta) ?? 0n;
  if (tokenBefore + dToken < 0n || wsolBefore + wrapped + dSol < 0n) return { err: { InstructionError: [2, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 90_000 };
  const wsolAfter = wsolBefore + wrapped + dSol;
  const signerDelta = -Number(wrapped) - paidToOpen + (closesWsol ? wsolLamports + Number(wsolAfter) : 0);
  return {
    err: null,
    logs: [],
    unitsConsumed: 90_000,
    accounts: chain.post(config.accounts.addresses, {
      [ME.toBase58()]: { lamportsDelta: signerDelta },
      [tokenAta.toBase58()]: { tokenAmount: tokenBefore + dToken, mint: TOKEN, owner: ME },
      [WSOL_ATA.toBase58()]: closesWsol ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: ME },
    }),
  };
};

const ok = (r: Awaited<ReturnType<typeof prepareRangeSwap>>): PreparedTx => {
  if (!r.ok) throw new Error(`not built: ${r.outcome.message}`);
  return r.prepared;
};
const body = (p: PreparedTx) => p.tx.instructions;
const intentOf = (p: PreparedTx) => p.check.intent as RangeIntent;
const sell = (aggregator: AggregatorSeen = NOT_ASKED, amountIn = 50_000_000n) =>
  ({ owner: ME, pool: POOL, inputMint: TOKEN, outputMint: WSOL_MINT, amountIn, slippageBps: 100n, aggregator });
const buy = (aggregator: AggregatorSeen = NOT_ASKED, amountIn = 10_000_000n) =>
  ({ owner: ME, pool: POOL, inputMint: WSOL_MINT, outputMint: TOKEN, amountIn, slippageBps: 100n, aggregator });

describe('a swap in a range pool', () => {
  it('selling the token: the walk’s quote, a floor 1% under it, SOL back as plain SOL, the fee and the venue’s share from the tier', async () => {
    const c = chainWith();
    const p = ok(await prepareRangeSwap(W(c), cfgLocal, PROG, sell()));
    expect(p.kind).toBe('range-swap');
    const s = p.summary as RangeSwapSummary;
    const pool = decodePoolState(POOL.toBase58(), c.accounts.get(POOL.toBase58())!.data)!;
    const q = quoteSwap({ pool, config: { tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0 }, band: (x) => (x === 0 ? decodeTickArray('', c.accounts.get(deriveTickArray(PROG, POOL, 0).toBase58())!.data)! : undefined), extension: null, zeroForOne: TOKEN_IS_0, isBaseInput: true, amount: 50_000_000n, sqrtPriceLimitX64: 0n, blockTimestamp: Number(NOW) });
    if (q.kind !== 'ok') throw new Error('quote');
    expect(s.quotedOut).toBe(q.amountOut);
    expect(s.minimumAmountOut).toBe((q.amountOut * 9_900n) / 10_000n);
    expect([s.paysCoin, s.unwrapsWsol, s.bandsCrossed]).toEqual([false, true, 1]);
    expect([s.poolLine.tradeFeeRate, s.poolLine.venueShareRate]).toEqual([10_000, 160_000]);
    expect(intentOf(p).swap!.bands.map((b) => b.toBase58())).toEqual([deriveTickArray(PROG, POOL, 0).toBase58()]);
  });

  it('buying the token with SOL: SOL is wrapped for exactly the amount and the token account receives', async () => {
    const p = ok(await prepareRangeSwap(W(chainWith()), cfgLocal, PROG, buy()));
    const steps = p.steps.map((x) => x.kind).filter((k) => !k.startsWith('compute'));
    expect(steps).toEqual(['create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'range-swap', 'close-wsol']);
    const wrap = p.steps.find((x) => x.kind === 'wrap-sol');
    expect(wrap?.kind === 'wrap-sol' && wrap.lamports).toBe(10_000_000n);
    expect((p.summary as RangeSwapSummary).paysCoin).toBe(true);
  });

  it('is held to what Jupiter was seen to pay, and says which way it moved', async () => {
    const c = chainWith();
    const s = (ok(await prepareRangeSwap(W(c), cfgLocal, PROG, sell())).summary as RangeSwapSummary).quotedOut;
    const now = await prepareRangeSwap(W(c), cfgLocal, PROG, sell({ kind: 'quoted', out: s + 1n, when: 'now' }));
    expect(now.ok ? null : now.outcome.message).toBe(VENUE_SWAP_COPY.routeMoved);
    const earlier = await prepareRangeSwap(W(c), cfgLocal, PROG, sell({ kind: 'quoted', out: s + 1n, when: 'earlier' }));
    expect(earlier.ok ? null : earlier.outcome.message).toBe(VENUE_SWAP_COPY.underLastQuote);
    expect((await prepareRangeSwap(W(c), cfgLocal, PROG, sell({ kind: 'quoted', out: s, when: 'now' }))).ok).toBe(true);
  });

  it('refuses before building: no program, swaps switched off, a band the pool marks that does not read, a trade past the bands', async () => {
    const msg = async (c: FakeChain, a = sell()) => {
      const r = await prepareRangeSwap(W(c), cfgLocal, PROG, a);
      return r.ok ? 'built' : r.outcome.message;
    };
    expect(await msg(chainWith({ deploy: false }))).toMatch(/not on this network yet/);
    expect(await msg(chainWith({ status: 1 << POOL_STATUS_BIT.swap }))).toBe(RANGE_SWAP_COPY.swapsPaused);
    expect(await msg(chainWith({ bandMissing: true }))).toBe(RANGE_SWAP_COPY.bandUnread);
    // Far more than the one band's liquidity: the walk runs off the bands read.
    expect(await msg(chainWith(), sell(NOT_ASKED, 10n ** 18n))).toMatch(/price bands|cannot fill|cannot price/);
    const noClock = chainWith();
    setClock(noClock, null);
    expect(await msg(noClock)).toBe(VENUE_SWAP_COPY.noClock);
  });

  it('refuses a pool whose vault is frozen: nothing moves in or out of it', async () => {
    for (const frozenVault of [0, 1] as const) {
      const r = await prepareRangeSwap(W(chainWith({ frozenVault })), cfgLocal, PROG, sell());
      expect(r.ok ? null : r.outcome.message, `vault ${frozenVault}`).toBe(RANGE_COPY.vaultFrozen);
    }
  });

  it('buying a Token-2022 token into a new account pays that account’s own deposit: 170 bytes, not 165', async () => {
    const p = ok(await prepareRangeSwap(W(chainWith({ token2022: true, tokens: null })), cfgLocal, PROG, buy()));
    expect(p.steps.some((x) => x.kind === 'create-token-account' && x.address.equals(TOKEN_ATA_2022))).toBe(true);
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
  });

  it('says which side the pool fee comes out of, from the pool’s fee_on and the direction', async () => {
    const side = async (feeOn: number | undefined, a: ReturnType<typeof sell>) => (ok(await prepareRangeSwap(W(chainWith({ feeOn })), cfgLocal, PROG, a)).summary as RangeSwapSummary).feeOnInput;
    expect(await side(undefined, sell())).toBe(true);
    expect(await side(undefined, buy())).toBe(true);
    // Fees in token 0 only: paying token 0 in, it comes out of what is paid; paying token 1, out of what comes out.
    const pays0 = TOKEN_IS_0 ? sell() : buy();
    const pays1 = TOKEN_IS_0 ? buy() : sell();
    expect(await side(FEE_ON_TOKEN_0_ONLY, pays0)).toBe(true);
    expect(await side(FEE_ON_TOKEN_0_ONLY, pays1)).toBe(false);
  });
});

describe('the checker refuses every change to a range swap', () => {
  it('passes what was built; refuses a stranger’s account, another band, a price limit, exact-out, a zero floor, or a swap in a non-swap transaction', async () => {
    const p = ok(await prepareRangeSwap(W(chainWith()), cfgLocal, PROG, sell()));
    expect(decodeIntent(body(p), intentOf(p)).ok).toBe(true);
    const i = body(p).findIndex((ix) => ix.programId.equals(PROG));
    const ix = body(p)[i]!;
    const swapIx = (v: TransactionInstruction) => body(p).map((x, j) => (j === i ? v : x));
    const withKey = (slot: number, k: PublicKey) => new TransactionInstruction({ programId: PROG, data: ix.data, keys: ix.keys.map((x, j) => (j === slot ? { ...x, pubkey: k } : x)) });
    const withByte = (at: number, b: number) => new TransactionInstruction({ programId: PROG, keys: ix.keys, data: Buffer.from(ix.data.map((x, j) => (j === at ? b : x))) });
    const outSlot = 4; // payer, tier, pool, input account, OUTPUT account
    const variants = [
      withKey(outSlot, associatedTokenAddress(WSOL_MINT, STRANGER)),
      withKey(ix.keys.length - 1, deriveTickArray(PROG, POOL, -7_200)),
      withByte(24, 1), // a price limit
      withByte(40, 0), // exact out
      new TransactionInstruction({ programId: PROG, keys: ix.keys, data: Buffer.from(ix.data.map((x, j) => (j >= 16 && j < 24 ? 0 : x))) }), // a zero floor
    ];
    for (const v of variants) expect(decodeIntent(swapIx(v), intentOf(p)).ok, `variant ${variants.indexOf(v)}`).toBe(false);
    // Something added: a SOL transfer to a stranger, or a second swap.
    expect(decodeIntent([...body(p), SystemProgram.transfer({ fromPubkey: ME, toPubkey: STRANGER, lamports: 1 })], intentOf(p)).ok).toBe(false);
    expect(decodeIntent([...body(p), ix], intentOf(p)).ok).toBe(false);
    // The same swap under an opening's intent.
    expect(decodeIntent(body(p), { ...intentOf(p), kind: 'range-open', nftMint: Keypair.generate().publicKey }).ok).toBe(false);
  });

  it('a swap paying in the token wraps no SOL', async () => {
    const p = ok(await prepareRangeSwap(W(chainWith()), cfgLocal, PROG, sell()));
    const wrap = SystemProgram.transfer({ fromPubkey: ME, toPubkey: WSOL_ATA, lamports: 5 });
    expect(decodeIntent([wrap, ...body(p)], intentOf(p)).ok).toBe(false);
  });
});

describe('the review holds the decoded swap to the plan', () => {
  it('the built swap matches; another amount, floor, pool or coin, a different wrap, or a missing account does not', async () => {
    const p = ok(await prepareRangeSwap(W(chainWith()), cfgLocal, PROG, buy()));
    const steps = p.steps;
    const sw = steps.find((x) => x.kind === 'range-swap') as Extract<IntentStep, { kind: 'range-swap' }>;
    const wrap = steps.find((x) => x.kind === 'wrap-sol') as Extract<IntentStep, { kind: 'wrap-sol' }>;
    const opens = steps.filter((x) => x.kind === 'create-token-account').map((x) => (x as Extract<IntentStep, { kind: 'create-token-account' }>).address);
    const want = { pool: POOL, inputMint: WSOL_MINT, outputMint: TOKEN, amountIn: sw.amountIn, minimumAmountOut: sw.minimumAmountOut, wraps: wrap.lamports, opens, closes: true };
    expect(rangeSwapStepsProblem(steps, want)).toBeNull();
    const swap = (from: IntentStep, to: IntentStep) => steps.map((x) => (x === from ? to : x));
    expect(rangeSwapStepsProblem(swap(sw, { ...sw, amountIn: sw.amountIn + 1n }), want)).not.toBeNull();
    expect(rangeSwapStepsProblem(swap(sw, { ...sw, minimumAmountOut: sw.minimumAmountOut - 1n }), want)).not.toBeNull();
    expect(rangeSwapStepsProblem(swap(sw, { ...sw, pool: STRANGER }), want)).not.toBeNull();
    expect(rangeSwapStepsProblem(swap(sw, { ...sw, outputMint: STRANGER }), want)).not.toBeNull();
    expect(rangeSwapStepsProblem(swap(wrap, { ...wrap, lamports: wrap.lamports + 1n }), want)).not.toBeNull();
    expect(rangeSwapStepsProblem(steps, { ...want, opens: opens.slice(1) })).not.toBeNull();
    expect(rangeSwapStepsProblem(steps, { ...want, closes: false })).not.toBeNull();
  });
});
