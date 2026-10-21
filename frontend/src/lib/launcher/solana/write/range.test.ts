// @vitest-environment node
//
// Range positions, against a fake chain whose simulator runs the range program's own
// deposit and withdrawal sums (solana/clmm/math.ts, held to the program's Rust) and its
// slippage rule. Then the checker: every built transaction decodes, and every change a
// wallet or a stranger could make to one is refused.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { BPF_LOADER_UPGRADEABLE_ID } from '../curve/read';
import { associatedTokenAddress } from '../curve/ix';
import {
  IX_DECREASE_LIQUIDITY_V2,
  IX_OPEN_POSITION_WITH_TOKEN22_NFT,
  POOL_STATE_OFFSETS,
  POOL_STATUS_BIT,
  decodePersonalPosition,
  decodePoolState,
  deriveAmmConfig,
  deriveObservation,
  derivePersonalPosition,
  derivePool,
  deriveTickArray,
  deriveVault,
  sortMints,
} from '../../../solana/clmm/program';
import { getDeltaAmountsSigned, getLiquidityFromSingleAmount0, getLiquidityFromSingleAmount1, getSqrtPriceAtTick } from '../../../solana/clmm/math';
import { positionNftAccount } from '../../../solana/clmm/ix';
import { encodeAmmConfig, encodePool, encodePosition, encodeTickArray } from '../../../solana/clmm/encode.fixture';
import { pairOf, priceAtSqrt, priceNumber } from '../../../solana/clmm/rangeMath';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { decodeIntent } from './intent';
import { RANGE_COPY, prepareRangeClose, prepareRangeOpen, prepareRangeRemove, stepsProblem, type RangeOpenReads } from './range';
import { FakeChain, cfgLocal, openAccount, rent, type SimHandler } from './testkit.fixture';
import type { IntentStep, PreparedTx, RangeIntent, RangeSummary, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const PROG = Keypair.generate().publicKey;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
/** The two wallets the fee tier names: the one that collects the protocol part, and the fund part's. */
const TIER_OWNER = Keypair.generate().publicKey;
const FUND_OWNER = Keypair.generate().publicKey;
const TOKEN = Keypair.generate().publicKey;
const SPACING = 120;
const { token0: MINT0, token1: MINT1 } = sortMints(WSOL_MINT, TOKEN);
const TOKEN_IS_0 = MINT0.equals(TOKEN);
const CONFIG = deriveAmmConfig(PROG, 0);
const POOL = derivePool(PROG, CONFIG, MINT0, MINT1);
const TICK = 600; // the price sits inside the band starting at 0
const SQRT = getSqrtPriceAtTick(TICK) + 12_345n;
const L_POOL = 10n ** 15n;
const D0 = TOKEN_IS_0 ? 6 : 9;
const D1 = TOKEN_IS_0 ? 9 : 6;
const TOKEN_ATA = associatedTokenAddress(TOKEN, ME, TOKEN_PROGRAM_ID);
/** The wallet's account for the token when the token is a Token-2022 coin (170 bytes, not 165). */
const TOKEN_ATA_2022 = associatedTokenAddress(TOKEN, ME, TOKEN_2022_PROGRAM_ID);
const WSOL_ATA = associatedTokenAddress(WSOL_MINT, ME);
const own = (m: PublicKey) => (m.equals(WSOL_MINT) ? WSOL_ATA : TOKEN_ATA);
const is2022 = (c: FakeChain) => c.accounts.get(TOKEN.toBase58())!.owner.equals(TOKEN_2022_PROGRAM_ID);
const tokenAtaOf = (c: FakeChain) => (is2022(c) ? TOKEN_ATA_2022 : TOKEN_ATA);
const VAULT0 = deriveVault(PROG, POOL, MINT0);
const VAULT1 = deriveVault(PROG, POOL, MINT1);

function deployed(chain: FakeChain, program: PublicKey) {
  const pd = Keypair.generate().publicKey;
  const stub = new Uint8Array(36);
  new DataView(stub.buffer).setUint32(0, 2, true);
  stub.set(pd.toBytes(), 4);
  chain.set(program, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: stub, executable: true });
  chain.set(pd, { lamports: 10_000_000, owner: BPF_LOADER_UPGRADEABLE_ID, data: new Uint8Array(64) });
}

function chainWith(o: { status?: number; deploy?: boolean; tokens?: bigint | null; token2022?: boolean; frozenVault?: 0 | 1; vaultMissing?: boolean; reward?: boolean } = {}): FakeChain {
  const c = new FakeChain();
  if (o.deploy !== false) deployed(c, PROG);
  c.set(CONFIG, { lamports: rent(117), owner: PROG, data: encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, tickSpacing: SPACING, owner: TIER_OWNER, fundOwner: FUND_OWNER }) });
  c.set(POOL, {
    lamports: rent(1544),
    owner: PROG,
    data: encodePool({
      ammConfig: CONFIG, mint0: MINT0, mint1: MINT1,
      vault0: VAULT0, vault1: VAULT1,
      observation: deriveObservation(PROG, POOL),
      decimals0: D0, decimals1: D1, tickSpacing: SPACING, liquidity: L_POOL, sqrtPriceX64: SQRT, tickCurrent: TICK, status: o.status,
      // A reward the vault set up on the pool: its mint and vault.
      rewards: o.reward ? [{ mint: Keypair.generate().publicKey, vault: Keypair.generate().publicKey }] : undefined,
    }),
  });
  if (o.token2022) c.mint2022(TOKEN, [], { decimals: 6 });
  else c.mint(TOKEN, { decimals: 6 });
  c.mint(WSOL_MINT, { decimals: 9 });
  // The pool's two vaults: either one frozen by its coin's issuer stops every deposit and withdrawal.
  [VAULT0, VAULT1].forEach((v, i) => {
    if (o.vaultMissing && i === 1) return;
    const mint = i === 0 ? MINT0 : MINT1;
    const state = { state: o.frozenVault === i ? (2 as const) : (1 as const) };
    if (mint.equals(TOKEN) && o.token2022) c.token2022Account(v, mint, POOL, 10n ** 12n, state);
    else c.tokenAccount(v, mint, POOL, 10n ** 12n, state);
  });
  c.fund(ME, 50_000_000_000);
  if (o.tokens !== null) {
    if (o.token2022) c.token2022Account(TOKEN_ATA_2022, TOKEN, ME, o.tokens ?? 1_000_000_000_000n);
    else c.tokenAccount(TOKEN_ATA, TOKEN, ME, o.tokens ?? 1_000_000_000_000n);
  }
  // The band holding the price exists; the others are made by the first position that needs them.
  c.set(deriveTickArray(PROG, POOL, 0), { lamports: rent(10_240), owner: PROG, data: encodeTickArray(POOL, 0, SPACING, []) });
  return c;
}

const fail = (code: number) => ({ err: { InstructionError: [2, { Custom: code }] }, logs: [`Program ${PROG.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 40_000 });
const amountAt = (c: FakeChain, k: PublicKey) => {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};

/**
 * What the range program's `add_liquidity` takes for an opening's data at a pool price, or
 * null when it refuses it (PriceSlippageCheck): liquidity 0 with a base side works the
 * liquidity out from that side's maximum; a named liquidity is taken as it is. Both
 * maxima are checked either way (open_position.rs).
 */
function programTakes(data: Uint8Array, sqrt: bigint, tick: number): [bigint, bigint] | 'no-base' | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lower = dv.getInt32(8, true);
  const upper = dv.getInt32(12, true);
  const named = dv.getBigUint64(24, true) | (dv.getBigUint64(32, true) << 64n);
  const max0 = dv.getBigUint64(40, true);
  const max1 = dv.getBigUint64(48, true);
  const [a, b] = [getSqrtPriceAtTick(lower), getSqrtPriceAtTick(upper)];
  let L = named;
  if (L === 0n) {
    if (data[57] !== 1) return 'no-base';
    L = data[58] === 1 ? getLiquidityFromSingleAmount0(sqrt, a, b, max0) : getLiquidityFromSingleAmount1(sqrt, a, b, max1);
  }
  const [need0, need1] = getDeltaAmountsSigned(tick, sqrt, lower, upper, L);
  return need0 > max0 || need1 > max1 ? null : [need0, need1];
}

/** The range program's own sums, on the chain's accounts: what it takes, pays and refuses. */
const rangeSim: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const r = ixs.find((i) => i.program.equals(PROG));
  if (!r) return { err: 'no range instruction', logs: [], unitsConsumed: 1 };
  const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  const pool = decodePoolState(POOL.toBase58(), chain.accounts.get(POOL.toBase58())!.data)!;
  const wrapped = ixs.filter((i) => i.program.equals(SystemProgram.programId)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
  const tokenAta = tokenAtaOf(chain);
  const sizeOf = (k: PublicKey) => (k.equals(TOKEN_ATA_2022) ? 170 : 165);
  const paidToOpen = ixs.filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).reduce((n, i) => n + openAccount(chain, i.accounts[1]!, sizeOf(i.accounts[1]!)).paid, 0);
  const closesWsol = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  const wsolBefore = amountAt(chain, WSOL_ATA) ?? 0n;
  const wsolLamports = openAccount(chain, WSOL_ATA).lamports;
  let d0: bigint;
  let d1: bigint;
  let programLamports = 0;
  if (IX_OPEN_POSITION_WITH_TOKEN22_NFT.every((b, i) => r.data[i] === b)) {
    if ((pool.status & (1 << POOL_STATUS_BIT.openPositionOrIncreaseLiquidity)) !== 0) return fail(6000);
    const lower = dv.getInt32(8, true);
    const upper = dv.getInt32(12, true);
    const took = programTakes(r.data, pool.sqrtPriceX64, pool.tickCurrent);
    if (took === 'no-base') return fail(6024); // ForbidBothZeroForSupplyLiquidity
    if (took === null) return fail(6021); // PriceSlippageCheck
    const [need0, need1] = took;
    d0 = -need0;
    d1 = -need1;
    const newBands = [...new Set([Math.floor(lower / 7200) * 7200, Math.floor(upper / 7200) * 7200])].filter((s) => !chain.accounts.get(deriveTickArray(PROG, POOL, s).toBase58())).length;
    programLamports = -(rent(281) + rent(469) + rent(170) + newBands * rent(10_240));
  } else if (IX_DECREASE_LIQUIDITY_V2.every((b, i) => r.data[i] === b)) {
    const pos = decodePersonalPosition('', chain.accounts.get(r.accounts[2]!.toBase58())!.data)!;
    const liq = dv.getBigUint64(8, true) | (dv.getBigUint64(16, true) << 64n);
    const [out0, out1] = liq > 0n ? getDeltaAmountsSigned(pool.tickCurrent, pool.sqrtPriceX64, pos.tickLowerIndex, pos.tickUpperIndex, -liq) : [0n, 0n];
    if (liq > 0n && (out0 < dv.getBigUint64(24, true) || out1 < dv.getBigUint64(32, true))) return fail(6021);
    d0 = out0 + pos.tokenFeesOwed0;
    d1 = out1 + pos.tokenFeesOwed1;
    // Closing hands back the record's, the NFT mint's and the NFT account's deposits.
    if (ixs.some((i) => i.program.equals(PROG) && i.data[0] === 123)) programLamports = rent(281) + rent(469) + rent(170);
  } else {
    return { err: 'unknown range instruction', logs: [], unitsConsumed: 1 };
  }
  const [dToken, dSol] = TOKEN_IS_0 ? [d0, d1] : [d1, d0];
  const tokenBefore = amountAt(chain, tokenAta) ?? 0n;
  if (tokenBefore + dToken < 0n || wsolBefore + wrapped + dSol < 0n) return { err: { InstructionError: [2, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 120_000 };
  const wsolAfter = wsolBefore + wrapped + dSol;
  const signerDelta = -Number(wrapped) - paidToOpen + programLamports + (closesWsol ? wsolLamports + Number(wsolAfter) : 0);
  const changes: Parameters<FakeChain['post']>[1] = {
    [ME.toBase58()]: { lamportsDelta: signerDelta },
    [tokenAta.toBase58()]: { tokenAmount: tokenBefore + dToken, mint: TOKEN, owner: ME },
    [WSOL_ATA.toBase58()]: closesWsol ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: ME },
  };
  return { err: null, logs: [], unitsConsumed: 120_000, accounts: chain.post(config.accounts.addresses, changes) };
};

function ready(c: FakeChain): FakeChain {
  c.simulate = rangeSim;
  return c;
}

/** The pool's own price in SOL per token, as the outside market would quote it when it agrees. */
const POOL_PRICE = (() => {
  const view = decodePoolState(POOL.toBase58(), chainWith().accounts.get(POOL.toBase58())!.data)!;
  return priceNumber(priceAtSqrt(pairOf(view)!, SQRT));
})();
const asked: Array<{ mint: string; fresh: boolean }> = [];
const readsAt = (answer: OutsidePrice): RangeOpenReads => ({
  outsidePrice: async (mint, _decimals, opts) => {
    asked.push({ mint, fresh: opts?.fresh === true });
    return answer;
  },
});
/** The outside market agrees with the pool. */
const READS = readsAt({ kind: 'ok', solPerToken: POOL_PRICE, source: 'Jupiter' });

const ok = (r: Awaited<ReturnType<typeof prepareRangeOpen>>): PreparedTx => {
  if (!r.ok) throw new Error(`not built: ${r.outcome.message}`);
  return r.prepared;
};

const inRange = { tickLower: 0, tickUpper: 1_200 };
const above = { tickLower: 1_200, tickUpper: 2_400 };
const below = { tickLower: -1_200, tickUpper: 0 };
const tokenOnly = TOKEN_IS_0 ? above : below;
const coinOnly = TOKEN_IS_0 ? below : above;

describe('opening a range position', () => {
  it('in range, from an amount of the token: the NFT signs, SOL is wrapped for the other side and unwrapped after', async () => {
    const c = ready(chainWith());
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    expect(p.kind).toBe('range-open');
    expect(p.extraSigners).toHaveLength(1);
    const s = p.summary as Extract<RangeSummary, { kind: 'range-open' }>;
    expect(s.max.token).toBe(5_000_000n);
    expect(s.quoted.quote > 0n && s.max.quote >= s.quoted.quote).toBe(true);
    expect(s.range.holds).toBe('both');
    expect(s.poolLine.tradeFeeRate).toBe(10_000);
    // The tier's own parts and the wallets that collect them, for the review's split line.
    expect([s.poolLine.protocolFeeRate, s.poolLine.fundFeeRate, s.poolLine.owner, s.poolLine.fundOwner]).toEqual([104_000, 56_000, TIER_OWNER.toBase58(), FUND_OWNER.toBase58()]);
    expect(s.poolLine.venueShareRate).toBe(160_000);
    expect(s.unwrapsWsol).toBe(true);
    const kinds = p.steps.map((x) => x.kind).filter((k) => !k.startsWith('compute'));
    expect(kinds).toEqual(['create-token-account', 'wrap-sol', 'sync-wsol', 'range-open', 'close-wsol']);
    const open = p.steps.find((x) => x.kind === 'range-open');
    expect(open?.kind === 'range-open' && open.nftMint.equals(p.extraSigners[0]!.publicKey)).toBe(true);
    // The deposits: the position and its NFT. Both ends sit in the band at 0, which exists.
    expect(s.rentLamports).toBe(BigInt(rent(281) + rent(512) + rent(170)));
  });

  it('a range whose end is in a band nobody has used yet pays that band’s deposit too', async () => {
    const wide = TOKEN_IS_0 ? { tickLower: 0, tickUpper: 7_200 } : { tickLower: -7_200, tickUpper: 1_200 };
    const p = ok(await prepareRangeOpen(W(ready(chainWith())), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...wide, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    expect((p.summary as Extract<RangeSummary, { kind: 'range-open' }>).rentLamports).toBe(BigInt(rent(281) + rent(512) + rent(170) + rent(10_240)));
  });

  it('the token only, above the price: nothing is wrapped, and the review says it earns nothing until the price rises into it', async () => {
    const c = ready(chainWith());
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...tokenOnly, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    const s = p.summary as Extract<RangeSummary, { kind: 'range-open' }>;
    expect(s.max.quote).toBe(0n);
    expect(s.range.holds).toBe('token-only');
    expect(p.steps.some((x) => x.kind === 'wrap-sol')).toBe(false);
  });

  it('refuses SOL for a range that takes the token only, and says why', async () => {
    const r = await prepareRangeOpen(W(ready(chainWith())), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...tokenOnly, side: 'coin', amount: 1_000_000_000n, toleranceBps: 100 });
    expect(r.ok ? null : r.outcome.message).toBe(RANGE_COPY.buysNothing);
  });

  it('SOL only, below the price: SOL is wrapped and the token is not touched', async () => {
    const p = ok(await prepareRangeOpen(W(ready(chainWith())), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...coinOnly, side: 'coin', amount: 2_000_000_000n, toleranceBps: 100 }));
    const s = p.summary as Extract<RangeSummary, { kind: 'range-open' }>;
    expect(s.max).toEqual({ token: 0n, quote: 2_000_000_000n });
    expect(s.range.holds).toBe('coin-only');
  });

  it('refuses before reading on: no program, a paused pool, a range off the spacing, too little of the token', async () => {
    const args = { owner: ME, pool: POOL, ...inRange, side: 'token' as const, amount: 5_000_000n, toleranceBps: 100 };
    const msg = async (c: FakeChain, a = args) => {
      const r = await prepareRangeOpen(W(ready(c)), cfgLocal, PROG, READS, a);
      return r.ok ? null : r.outcome.message;
    };
    expect(await msg(chainWith({ deploy: false }))).toBe(RANGE_COPY.notDeployed);
    expect(await msg(chainWith({ status: 1 }))).toBe(RANGE_COPY.addingPaused);
    expect(await msg(chainWith(), { ...args, tickLower: 60 })).toBe(RANGE_COPY.badRange);
    expect(await msg(chainWith({ tokens: 10n }))).toMatch(/This needs up to/);
    expect(await msg(chainWith(), { ...args, toleranceBps: 9_000 })).toBe(RANGE_COPY.badTolerance);
  });

  it('refuses a pool whose withdrawals are switched off, or whose vault is frozen: money put in could not come out', async () => {
    const args = { owner: ME, pool: POOL, ...inRange, side: 'token' as const, amount: 5_000_000n, toleranceBps: 100 };
    const msg = async (c: FakeChain) => {
      const r = await prepareRangeOpen(W(ready(c)), cfgLocal, PROG, READS, args);
      return r.ok ? null : r.outcome.message;
    };
    expect(await msg(chainWith({ status: 1 << POOL_STATUS_BIT.decreaseLiquidity }))).toBe(RANGE_COPY.withdrawalsOff);
    expect(await msg(chainWith({ frozenVault: 0 }))).toBe(RANGE_COPY.vaultFrozen);
    expect(await msg(chainWith({ frozenVault: 1 }))).toBe(RANGE_COPY.vaultFrozen);
    // A vault that did not read is never taken as open.
    expect(await msg(chainWith({ vaultMissing: true }))).toBe(RANGE_COPY.poolChanged('its vaults'));
  });

  it('a pool that pays a reward opens like any other: an opening carries no reward account', async () => {
    const c = ready(chainWith({ reward: true }));
    const view = decodePoolState(POOL.toBase58(), c.accounts.get(POOL.toBase58())!.data)!;
    expect(view.rewardInfos.filter((r) => r.initialized)).toHaveLength(1);
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    expect(p.kind).toBe('range-open');
    expect(decodeIntent(body(p), intentOf(p)).ok).toBe(true);
  });

  it('names a fixed liquidity with a ceiling on both coins, so a price pushed either way past the tolerance is refused', async () => {
    const p = ok(await prepareRangeOpen(W(ready(chainWith())), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    const data = body(p)[rangeIndex(p)]!.data;
    expect(programTakes(data, SQRT, TICK)).not.toBeNull();
    // A sandwich moves the price before the opening and back after: each way is refused.
    for (const dt of [-300, 300]) expect(programTakes(data, getSqrtPriceAtTick(TICK + dt), TICK + dt), `moved ${dt} ticks`).toBeNull();
    // The amount typed stays the most it takes of that coin.
    const s = p.summary as Extract<RangeSummary, { kind: 'range-open' }>;
    expect(s.max.token <= 5_000_000n && s.max.token >= 4_999_000n).toBe(true);
  });
});

describe('the pool’s price against the outside market, asked fresh at Review', () => {
  const notices = async (reads: RangeOpenReads) => {
    const p = ok(await prepareRangeOpen(W(ready(chainWith())), cfgLocal, PROG, reads, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    return (p.summary as Extract<RangeSummary, { kind: 'range-open' }>).notices;
  };
  const priceLine = (n: string[]) => n.find((x) => /outside price|Anyone can open a range pool/.test(x)) ?? null;

  it('agrees (within 3%): no warning, and the token’s price was asked fresh', async () => {
    asked.length = 0;
    expect(priceLine(await notices(READS))).toBeNull();
    expect(asked).toEqual([{ mint: TOKEN.toBase58(), fresh: true }]);
    expect(priceLine(await notices(readsAt({ kind: 'ok', solPerToken: POOL_PRICE * 1.02, source: 'Jupiter' })))).toBeNull();
  });

  it('off by more: how far, which way, what a move back would cost, and that anyone can open a pool at any price', async () => {
    const line = priceLine(await notices(readsAt({ kind: 'ok', solPerToken: POOL_PRICE * 1.1, source: 'Jupiter' })));
    expect(line).toMatch(/^This pool’s price is 9\.1% below the outside price/);
    expect(line).toMatch(/Anyone can open a range pool at any price/);
    expect(line).toMatch(/would take up to about [\d.,]+ SOL of what you put in/);
    expect(priceLine(await notices(readsAt({ kind: 'ok', solPerToken: POOL_PRICE / 1.1, source: 'Jupiter' })))).toMatch(/10% above the outside price/);
  });

  it('no outside market, or a read that failed, is said too: never read as agreeing', async () => {
    expect(priceLine(await notices(readsAt({ kind: 'no-route', detail: 'Jupiter has no route for this token' })))).toBe(RANGE_COPY.noMarket);
    expect(priceLine(await notices(readsAt({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 500)' })))).toBe(RANGE_COPY.priceUnread('Jupiter did not give a price (HTTP 500)'));
    const throws: RangeOpenReads = { outsidePrice: async () => Promise.reject(new Error('offline')) };
    expect(priceLine(await notices(throws))).toBe(RANGE_COPY.priceUnread('offline'));
  });
});

describe('an account this opens keeps the deposit its own mint needs', () => {
  it('opening: a Token-2022 token’s account is 170 bytes, not 165', async () => {
    const c = ready(chainWith({ token2022: true, tokens: null }));
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...coinOnly, side: 'coin', amount: 2_000_000_000n, toleranceBps: 100 }));
    expect(p.steps.some((x) => x.kind === 'create-token-account' && x.address.equals(TOKEN_ATA_2022))).toBe(true);
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(281) + rent(512) + rent(170) + rent(170)));
  });

  it('taking out: the account opened for a Token-2022 token is 170 bytes, not 165', async () => {
    const c = ready(chainWith({ token2022: true, tokens: null }));
    const { position } = withPosition(c);
    const p = ok(await prepareRangeRemove(W(c), cfgLocal, PROG, { owner: ME, position, percent: 50, toleranceBps: 100 }));
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
  });
});

/** A position of ME's in the pool, its NFT in ME's own Token-2022 account. */
function withPosition(c: FakeChain, o: { liquidity?: bigint; fees?: [bigint, bigint]; nftOwner?: PublicKey } = {}) {
  const nft = Keypair.generate().publicKey;
  const position = derivePersonalPosition(PROG, nft);
  c.set(position, {
    lamports: rent(281),
    owner: PROG,
    data: encodePosition({ nftMint: nft, pool: POOL, ...inRange, liquidity: o.liquidity ?? 10n ** 12n, feesOwed0: o.fees?.[0] ?? 0n, feesOwed1: o.fees?.[1] ?? 0n }),
  });
  c.token2022Account(positionNftAccount(ME, nft), nft, o.nftOwner ?? ME, 1n);
  c.set(deriveTickArray(PROG, POOL, 0), {
    lamports: rent(10_240),
    owner: PROG,
    data: encodeTickArray(POOL, 0, SPACING, [
      { tick: 0, liquidityNet: o.liquidity ?? 10n ** 12n, liquidityGross: o.liquidity ?? 10n ** 12n },
      { tick: 1_200, liquidityNet: -(o.liquidity ?? 10n ** 12n), liquidityGross: o.liquidity ?? 10n ** 12n },
    ]),
  });
  return { nft, position };
}

describe('taking out, collecting and closing', () => {
  it('half out: the liquidity halved, floors a tolerance under what comes back, SOL unwrapped', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c);
    const p = ok(await prepareRangeRemove(W(c), cfgLocal, PROG, { owner: ME, position, percent: 50, toleranceBps: 100 }));
    const s = p.summary as Exclude<RangeSummary, { kind: 'range-open' }>;
    expect(s.liquidity).toBe(5n * 10n ** 11n);
    expect(s.min.token).toBe((s.quoted.token * 9_900n) / 10_000n);
    expect(s.percent).toBe(50);
    expect(p.steps.map((x) => x.kind).filter((k) => !k.startsWith('compute'))).toEqual(['create-token-account', 'range-decrease', 'close-wsol']);
  });

  it('0% collects the fees, and with no fees there is nothing to build', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c, { fees: [7n, 9n] });
    const p = ok(await prepareRangeRemove(W(c), cfgLocal, PROG, { owner: ME, position, percent: 0, toleranceBps: 100 }));
    const s = p.summary as Exclude<RangeSummary, { kind: 'range-open' }>;
    expect([s.liquidity, s.min.token, s.min.quote]).toEqual([0n, 0n, 0n]);
    expect(s.fees).toEqual(TOKEN_IS_0 ? { token: 7n, quote: 9n } : { token: 9n, quote: 7n });
    const empty = ready(chainWith());
    const { position: none } = withPosition(empty, { liquidity: 0n });
    const r = await prepareRangeRemove(W(empty), cfgLocal, PROG, { owner: ME, position: none, percent: 0, toleranceBps: 100 });
    expect(r.ok ? null : r.outcome.message).toBe(RANGE_COPY.nothingToTake);
  });

  it('closing takes all of it out and closes the position in one transaction', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c);
    const p = ok(await prepareRangeClose(W(c), cfgLocal, PROG, { owner: ME, position, toleranceBps: 100 }));
    expect(p.kind).toBe('range-close');
    expect(p.steps.map((x) => x.kind).filter((k) => k.startsWith('range'))).toEqual(['range-decrease', 'range-close']);
    const dec = p.steps.find((x) => x.kind === 'range-decrease');
    expect(dec?.kind === 'range-decrease' && dec.liquidity).toBe(10n ** 12n);
  });

  it('refuses a position whose NFT is not in the wallet’s own account for it', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c, { nftOwner: STRANGER });
    const r = await prepareRangeRemove(W(c), cfgLocal, PROG, { owner: ME, position, percent: 50, toleranceBps: 100 });
    expect(r.ok ? null : r.outcome.message).toBe(RANGE_COPY.notYourNft);
  });
});

/** The built transaction's own instructions, as the checker reads them. */
const body = (p: PreparedTx) => p.tx.instructions;
const intentOf = (p: PreparedTx) => p.check.intent as RangeIntent;
const swapIx = (list: TransactionInstruction[], i: number, ix: TransactionInstruction) => list.map((x, j) => (j === i ? ix : x));
const rangeIndex = (p: PreparedTx) => body(p).findIndex((ix) => ix.programId.equals(PROG));

describe('the checker refuses every change to a range transaction', () => {
  it('passes what was built, and refuses another account for the coins, another pool, a stranger paid, or no NFT link', async () => {
    const c = ready(chainWith());
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    expect(decodeIntent(body(p), intentOf(p)).ok).toBe(true);
    const i = rangeIndex(p);
    const ix = body(p)[i]!;
    const strangerAta = associatedTokenAddress(TOKEN, STRANGER, TOKEN_PROGRAM_ID);
    const tokenSlot = ix.keys.findIndex((k) => k.pubkey.equals(own(TOKEN)));
    const variants: TransactionInstruction[] = [
      new TransactionInstruction({ programId: PROG, data: ix.data, keys: ix.keys.map((k, j) => (j === tokenSlot ? { ...k, pubkey: strangerAta } : k)) }),
      new TransactionInstruction({ programId: PROG, data: ix.data, keys: ix.keys.map((k, j) => (j === 4 ? { ...k, pubkey: Keypair.generate().publicKey } : k)) }),
      new TransactionInstruction({ programId: PROG, keys: ix.keys, data: Buffer.from(ix.data.map((b, j) => (j === 56 ? 0 : b))) }),
      new TransactionInstruction({ programId: PROG, keys: ix.keys, data: Buffer.from(ix.data.map((b, j) => (j === 24 ? 1 : b))) }),
      // Liquidity 0 with a base side: the program would check only one coin's maximum.
      new TransactionInstruction({
        programId: PROG,
        keys: ix.keys,
        data: Buffer.concat([Buffer.from(ix.data.subarray(0, 24)), Buffer.alloc(16), Buffer.from(ix.data.subarray(40, 57)), Buffer.from([1, TOKEN_IS_0 ? 1 : 0])]),
      }),
    ];
    // An amount changed in a well-formed opening is a shape this site builds: the review's
    // own comparison and submit's byte-for-byte check of a wallet's version refuse it.
    for (const v of variants) {
      const r = decodeIntent(swapIx(body(p), i, v), intentOf(p));
      expect(r.ok, `variant ${variants.indexOf(v)}`).toBe(false);
    }
    // Something added: a SOL transfer to a stranger, a token transfer, a call to the other pool program.
    const added = [
      SystemProgram.transfer({ fromPubkey: ME, toPubkey: STRANGER, lamports: 1 }),
      createTransferInstruction(own(TOKEN), strangerAta, ME, 1n, [], TOKEN_PROGRAM_ID),
      new TransactionInstruction({ programId: cfgLocal.cpSwapProgram, keys: ix.keys, data: ix.data }),
      new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys: [], data: Buffer.from([1]) }),
    ];
    for (const extra of added) expect(decodeIntent([...body(p), extra], intentOf(p)).ok).toBe(false);
    // Two openings in one transaction.
    expect(decodeIntent([...body(p), ix], intentOf(p)).ok).toBe(false);
  });

  it('a withdrawal paid to a stranger, or larger than the position, is refused; so is a close in a plain withdrawal', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c);
    const p = ok(await prepareRangeRemove(W(c), cfgLocal, PROG, { owner: ME, position, percent: 50, toleranceBps: 100 }));
    expect(decodeIntent(body(p), intentOf(p)).ok).toBe(true);
    const i = rangeIndex(p);
    const ix = body(p)[i]!;
    const recipientSlot = ix.keys.findIndex((k) => k.pubkey.equals(own(TOKEN)));
    const toStranger = new TransactionInstruction({
      programId: PROG,
      data: ix.data,
      keys: ix.keys.map((k, j) => (j === recipientSlot ? { ...k, pubkey: associatedTokenAddress(TOKEN, STRANGER, TOKEN_PROGRAM_ID) } : k)),
    });
    expect(decodeIntent(swapIx(body(p), i, toStranger), intentOf(p)).ok).toBe(false);
    const more = Buffer.from(ix.data);
    more.writeBigUInt64LE(10n ** 13n, 8);
    expect(decodeIntent(swapIx(body(p), i, new TransactionInstruction({ programId: PROG, keys: ix.keys, data: more })), intentOf(p)).ok).toBe(false);
    const closing = ok(await prepareRangeClose(W(c), cfgLocal, PROG, { owner: ME, position, toleranceBps: 100 }));
    const closeIx = body(closing).find((x) => x.programId.equals(PROG) && x.data[0] === 123)!;
    expect(decodeIntent([...body(p), closeIx], intentOf(p)).ok).toBe(false);
  });

  it('a close that leaves liquidity in is refused', async () => {
    const c = ready(chainWith());
    const { position } = withPosition(c);
    const closing = ok(await prepareRangeClose(W(c), cfgLocal, PROG, { owner: ME, position, toleranceBps: 100 }));
    const i = body(closing).findIndex((x) => x.programId.equals(PROG) && x.data[0] !== 123);
    const ix = body(closing)[i]!;
    const half = Buffer.from(ix.data);
    half.writeBigUInt64LE(10n ** 11n, 8);
    expect(decodeIntent(swapIx(body(closing), i, new TransactionInstruction({ programId: PROG, keys: ix.keys, data: half })), intentOf(closing)).ok).toBe(false);
  });

  it('a range transaction never reaches Token-2022 or the system program’s create-account at the top level', async () => {
    const c = ready(chainWith());
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    expect(body(p).some((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID))).toBe(false);
    const create = SystemProgram.createAccount({ fromPubkey: ME, newAccountPubkey: Keypair.generate().publicKey, lamports: 1, space: 82, programId: TOKEN_PROGRAM_ID });
    expect(decodeIntent([...body(p), create], intentOf(p)).ok).toBe(false);
  });
});

describe('the review holds the decoded steps to the plan', () => {
  // A changed amount in a well-formed opening still decodes: this comparison is what refuses it.
  it('the built opening matches, and a changed maximum, an added close, a different SOL wrap or a dropped account do not', async () => {
    const c = ready(chainWith());
    const p = ok(await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 }));
    const r = decodeIntent(body(p), intentOf(p));
    if (!r.ok) throw new Error(r.reason);
    const steps = r.steps;
    const open = steps.find((s) => s.kind === 'range-open') as Extract<IntentStep, { kind: 'range-open' }>;
    const wrap = steps.find((s) => s.kind === 'wrap-sol') as Extract<IntentStep, { kind: 'wrap-sol' }>;
    const creates = steps.filter((s) => s.kind === 'create-token-account').map((s) => (s as Extract<IntentStep, { kind: 'create-token-account' }>).address);
    const want = {
      own: (s: IntentStep) => s.kind === 'range-open' && s.max0 === open.max0 && s.max1 === open.max1,
      wraps: wrap.lamports,
      opens: creates,
      closes: steps.some((s) => s.kind === 'close-wsol'),
    };
    expect(stepsProblem(steps, want)).toBeNull();
    const swap = (from: IntentStep, to: IntentStep) => steps.map((s) => (s === from ? to : s));
    expect(stepsProblem(swap(open, { ...open, max0: open.max0 + 1n }), want)).not.toBeNull();
    expect(stepsProblem([...steps, { kind: 'range-close', position: Keypair.generate().publicKey, nftMint: Keypair.generate().publicKey }], want)).not.toBeNull();
    expect(stepsProblem(swap(wrap, { ...wrap, lamports: wrap.lamports + 1n }), want)).not.toBeNull();
    expect(stepsProblem(steps, { ...want, opens: [...creates, Keypair.generate().publicKey] })).not.toBeNull();
    expect(stepsProblem(steps, { ...want, closes: !want.closes })).not.toBeNull();
  });
});

describe('the pins are held to the chain', () => {
  it('a pool whose vault is not the one its address derives is refused', async () => {
    const c = ready(chainWith());
    const pool = c.accounts.get(POOL.toBase58())!;
    const data = Uint8Array.from(pool.data);
    data.set(Keypair.generate().publicKey.toBytes(), POOL_STATE_OFFSETS.tokenVault0);
    c.set(POOL, { ...pool, data });
    const r = await prepareRangeOpen(W(c), cfgLocal, PROG, READS, { owner: ME, pool: POOL, ...inRange, side: 'token', amount: 5_000_000n, toleranceBps: 100 });
    expect(r.ok ? null : r.outcome.message).toBe(RANGE_COPY.poolChanged('its vaults'));
  });
});
