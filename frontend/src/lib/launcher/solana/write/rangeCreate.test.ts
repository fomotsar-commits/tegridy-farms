// @vitest-environment node
//
// A new range pool and its first position, against a fake chain whose simulator runs the
// range program's own opening sums (solana/clmm/math.ts) at the price the same transaction
// creates the pool at, and charges the program's fee and deposits. Then the checker: the
// pool opening is rebuilt and refused on any other tier, price, fee receiver or order.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { BPF_LOADER_UPGRADEABLE_ID } from '../curve/read';
import { associatedTokenAddress } from '../curve/ix';
import { CREATE_POOL_FEE_RECEIVER, createPoolIx } from '../../../solana/clmm/ix';
import {
  IX_CREATE_POOL,
  IX_OPEN_POSITION_WITH_TOKEN22_NFT,
  deriveAmmConfig,
  deriveObservation,
  derivePool,
  deriveVault,
  sortMints,
} from '../../../solana/clmm/program';
import { getDeltaAmountsSigned, getTickAtSqrtPrice } from '../../../solana/clmm/math';
import { encodeAmmConfig, encodePool } from '../../../solana/clmm/encode.fixture';
import { pairOf, sqrtAtPrice, type Price } from '../../../solana/clmm/rangeMath';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { decodeIntent } from './intent';
import { RANGE_COPY, prepareRangeCreate, type RangeCreateArgs, type RangeOpenReads } from './range';
import { FakeChain, VAULT, cfgLocal, openAccount, rent, type SimHandler } from './testkit.fixture';
import type { PreparedTx, RangeCreateSummary, RangeIntent, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const PROG = Keypair.generate().publicKey;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const TOKEN = Keypair.generate().publicKey;
const SPACING = 120;
const { token0: MINT0, token1: MINT1 } = sortMints(WSOL_MINT, TOKEN);
const TOKEN_IS_0 = MINT0.equals(TOKEN);
const TIER0 = deriveAmmConfig(PROG, 0);
const POOL = derivePool(PROG, TIER0, MINT0, MINT1);
const TOKEN_ATA = associatedTokenAddress(TOKEN, ME, TOKEN_PROGRAM_ID);
const WSOL_ATA = associatedTokenAddress(WSOL_MINT, ME);
const FEE = 500_000_000;

/** 0.0003 SOL per token: the opening price, and the market's. */
const START: Price = { num: 3n, den: 10_000n };
const PAIR = pairOf({ tokenMint0: MINT0.toBase58(), tokenMint1: MINT1.toBase58(), mintDecimals0: TOKEN_IS_0 ? 6 : 9, mintDecimals1: TOKEN_IS_0 ? 9 : 6, tickSpacing: SPACING })!;
const SQRT = sqrtAtPrice(PAIR, START);
const TICK = getTickAtSqrtPrice(SQRT);
const below = Math.floor(TICK / SPACING) * SPACING;
/** A range around the opening price, its two ends in different bands. */
const RANGE = { tickLower: below - 7_200, tickUpper: below + 7_200 };

function chainWith(o: { deploy?: boolean; tier?: boolean; pool?: boolean; token2022?: boolean } = {}): FakeChain {
  const c = new FakeChain();
  if (o.deploy !== false) {
    const pd = Keypair.generate().publicKey;
    const stub = new Uint8Array(36);
    new DataView(stub.buffer).setUint32(0, 2, true);
    stub.set(pd.toBytes(), 4);
    c.set(PROG, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: stub, executable: true });
    c.set(pd, { lamports: 10_000_000, owner: BPF_LOADER_UPGRADEABLE_ID, data: new Uint8Array(64) });
  }
  if (o.tier !== false) {
    c.set(TIER0, { lamports: rent(117), owner: PROG, data: encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, tickSpacing: SPACING, owner: VAULT, fundOwner: STRANGER }) });
  }
  if (o.pool) {
    c.set(POOL, {
      lamports: rent(1544),
      owner: PROG,
      data: encodePool({
        ammConfig: TIER0, mint0: MINT0, mint1: MINT1, vault0: deriveVault(PROG, POOL, MINT0), vault1: deriveVault(PROG, POOL, MINT1),
        observation: deriveObservation(PROG, POOL), decimals0: TOKEN_IS_0 ? 6 : 9, decimals1: TOKEN_IS_0 ? 9 : 6, tickSpacing: SPACING, liquidity: 0n, sqrtPriceX64: SQRT, tickCurrent: TICK,
      }),
    });
  }
  if (o.token2022) c.mint2022(TOKEN, [], { decimals: 6 });
  else c.mint(TOKEN, { decimals: 6 });
  c.mint(WSOL_MINT, { decimals: 9 });
  c.fund(ME, 50_000_000_000);
  if (o.token2022) c.token2022Account(associatedTokenAddress(TOKEN, ME, TOKEN_2022_PROGRAM_ID), TOKEN, ME, 1_000_000_000_000n);
  else c.tokenAccount(TOKEN_ATA, TOKEN, ME, 1_000_000_000_000n);
  c.simulate = createSim;
  return c;
}

const fail = (code: number) => ({ err: { InstructionError: [3, { Custom: code }] }, logs: [`Program ${PROG.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 40_000 });
const amountAt = (c: FakeChain, k: PublicKey) => {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};
const is = (data: Uint8Array, disc: Uint8Array) => disc.every((b, i) => data[i] === b);

/**
 * The program's `create_pool` then `open_position_with_token22_nft`, as they run on the chain:
 * the pool opens at the price in the bytes, its fee goes to the vault, its own accounts and the
 * position's take their deposits, and the opening takes what its liquidity needs at that price.
 */
const createSim: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const create = ixs.find((i) => i.program.equals(PROG) && is(i.data, IX_CREATE_POOL));
  const open = ixs.find((i) => i.program.equals(PROG) && is(i.data, IX_OPEN_POSITION_WITH_TOKEN22_NFT));
  if (!create || !open) return { err: 'not a pool opening', logs: [], unitsConsumed: 1 };
  // Anchor's `init`: the pool's address already holds a pool.
  if (chain.accounts.get(POOL.toBase58())) return fail(0);
  const cv = new DataView(create.data.buffer, create.data.byteOffset, create.data.byteLength);
  const sqrt = cv.getBigUint64(8, true) | (cv.getBigUint64(16, true) << 64n);
  const tick = getTickAtSqrtPrice(sqrt);
  const dv = new DataView(open.data.buffer, open.data.byteOffset, open.data.byteLength);
  const lower = dv.getInt32(8, true);
  const upper = dv.getInt32(12, true);
  const liquidity = dv.getBigUint64(24, true) | (dv.getBigUint64(32, true) << 64n);
  const [need0, need1] = getDeltaAmountsSigned(tick, sqrt, lower, upper, liquidity);
  if (need0 > dv.getBigUint64(40, true) || need1 > dv.getBigUint64(48, true)) return fail(6021);
  const vaultSize = (m: PublicKey) => (chain.accounts.get(m.toBase58())!.owner.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165);
  const poolRent = rent(1544) + rent(4483) + rent(1832) + rent(vaultSize(MINT0)) + rent(vaultSize(MINT1));
  const bands = new Set([Math.floor(lower / 7_200), Math.floor(upper / 7_200)]).size * rent(10_240);
  const position = rent(281) + rent(469) + rent(170);
  const wrapped = ixs.filter((i) => i.program.equals(SystemProgram.programId)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
  const paidToOpen = ixs.filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).reduce((n, i) => n + openAccount(chain, i.accounts[1]!).paid, 0);
  const closesWsol = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  const wsolBefore = amountAt(chain, WSOL_ATA) ?? 0n;
  const wsolLamports = openAccount(chain, WSOL_ATA).lamports;
  const [dToken, dSol] = TOKEN_IS_0 ? [-need0, -need1] : [-need1, -need0];
  const tokenAta = chain.accounts.get(TOKEN_ATA.toBase58()) ? TOKEN_ATA : associatedTokenAddress(TOKEN, ME, TOKEN_2022_PROGRAM_ID);
  const tokenBefore = amountAt(chain, tokenAta) ?? 0n;
  if (tokenBefore + dToken < 0n || wsolBefore + wrapped + dSol < 0n) return fail(1);
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 160_000 };
  const wsolAfter = wsolBefore + wrapped + dSol;
  // Today's mainnet build takes the vault as a spare account and charges nothing.
  const chargesFee = !(chain as FakeChain & { noFee?: boolean }).noFee;
  const signerDelta = -Number(wrapped) - paidToOpen - (chargesFee ? FEE : 0) - poolRent - bands - position + (closesWsol ? wsolLamports + Number(wsolAfter) : 0);
  return {
    err: null,
    logs: [],
    unitsConsumed: 160_000,
    accounts: chain.post(config.accounts.addresses, {
      [ME.toBase58()]: { lamportsDelta: signerDelta },
      ...(chargesFee ? { [VAULT.toBase58()]: { lamportsDelta: FEE } } : {}),
      [tokenAta.toBase58()]: { tokenAmount: tokenBefore + dToken, mint: TOKEN, owner: ME },
      [WSOL_ATA.toBase58()]: closesWsol ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: ME },
    }),
  };
};

const readsAt = (answer: OutsidePrice): RangeOpenReads => ({ outsidePrice: async () => answer });
const MARKET = readsAt({ kind: 'ok', solPerToken: 0.0003, source: 'Jupiter' });
const ARGS: RangeCreateArgs = { owner: ME, tokenMint: TOKEN, coinMint: WSOL_MINT, startPrice: START, ...RANGE, side: 'token', amount: 5_000_000n };

const ok = (r: Awaited<ReturnType<typeof prepareRangeCreate>>): PreparedTx => {
  if (!r.ok) throw new Error(`not built: ${r.outcome.message}`);
  return r.prepared;
};
const said = (r: Awaited<ReturnType<typeof prepareRangeCreate>>) => (r.ok ? null : r.outcome.message);

describe('opening a range pool with its first position', () => {
  it('one transaction: the pool at the opening price on tier 0, its 0.5 SOL fee to the vault, then the position, exactly', async () => {
    const p = ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, ARGS));
    expect(p.kind).toBe('range-create');
    expect(p.extraSigners).toHaveLength(1);
    const kinds = p.steps.map((x) => x.kind).filter((k) => !k.startsWith('compute'));
    expect(kinds).toEqual(['create-token-account', 'wrap-sol', 'sync-wsol', 'range-create-pool', 'range-open', 'close-wsol']);
    const made = p.steps.find((x) => x.kind === 'range-create-pool');
    expect(made?.kind === 'range-create-pool' && made.pool.equals(POOL) && made.ammConfig.equals(TIER0) && made.sqrtPriceX64 === SQRT).toBe(true);
    // The program's own accounts list: the tier is index 0's, the fee's receiver is the vault.
    const createIx = p.tx.instructions.find((ix) => ix.programId.equals(PROG) && is(ix.data, IX_CREATE_POOL))!;
    expect(createIx.keys[1]!.pubkey.equals(TIER0)).toBe(true);
    expect(createIx.keys[13]!.pubkey.equals(CREATE_POOL_FEE_RECEIVER)).toBe(true);
    expect(CREATE_POOL_FEE_RECEIVER.equals(VAULT)).toBe(true);

    const s = p.summary as RangeCreateSummary;
    expect(s.createFee).toBe(500_000_000n);
    expect(s.feeReceiver.equals(VAULT)).toBe(true);
    expect(s.startPrice).toBeCloseTo(0.0003, 9);
    expect(s.price.state).toBe('agrees');
    // The typed amount is what goes in, to the base unit: no tolerance, the pool cannot move in between.
    expect(s.max.token).toBe(5_000_000n);
    expect(s.range.holds).toBe('both');
    // Never back: the pool, its record, its far-band map, two vaults and the two new bands. Back on close: the position's.
    const neverBack = rent(1544) + rent(4483) + rent(1832) + rent(165) + rent(165) + 2 * rent(10_240);
    expect(s.neverBack).toBe(BigInt(neverBack));
    expect(s.backOnClose).toBe(BigInt(rent(281) + rent(512) + rent(170)));
    expect(p.fees.newAccountRentLamports).toBe(BigInt(neverBack + rent(281) + rent(512) + rent(170)));
    // How a position earns, from the tier: 84% of each 1% fee to positions.
    expect([s.poolLine.tradeFeeRate, s.poolLine.protocolFeeRate, s.poolLine.fundFeeRate]).toEqual([10_000, 104_000, 56_000]);
    // The test run: the fee and every deposit leave the wallet, with the SOL that went in.
    expect(-p.simulated.signerLamportsDelta).toBeGreaterThan(FEE + neverBack);
  });

  it('the test run must show the vault receive the 0.5 SOL: a program that does not charge it (today’s mainnet build) builds nothing', async () => {
    const p = ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, ARGS));
    expect(p.simulated.solDeltas?.map((d) => [d.account.toBase58(), d.delta])).toEqual([[VAULT.toBase58(), 500_000_000n]]);
    const free = Object.assign(chainWith(), { noFee: true });
    const r = await prepareRangeCreate(W(free), cfgLocal, PROG, MARKET, ARGS);
    expect(r.ok ? null : r.outcome.message).toBe(`Blocked: ${RANGE_COPY.feeNotCharged}.`);
  });

  it('a Token-2022 token: its vault is 170 bytes, said in the deposits that never come back', async () => {
    const p = ok(await prepareRangeCreate(W(chainWith({ token2022: true })), cfgLocal, PROG, MARKET, ARGS));
    const s = p.summary as RangeCreateSummary;
    expect(s.neverBack).toBe(BigInt(rent(1544) + rent(4483) + rent(1832) + rent(165) + rent(170) + 2 * rent(10_240)));
  });

  it('someone opened the pool first: nothing is built, and the line says at what price', async () => {
    expect(said(await prepareRangeCreate(W(chainWith({ pool: true })), cfgLocal, PROG, MARKET, ARGS))).toBe(RANGE_COPY.poolTaken('0.0003 SOL per token'));
  });

  it('the opening price is held to the market’s, asked fresh: off it, no market or unread, nothing is built', async () => {
    const asked: boolean[] = [];
    const fresh: RangeOpenReads = {
      outsidePrice: async (_m, _d, o) => {
        asked.push(o?.fresh === true);
        return { kind: 'ok', solPerToken: 0.0003, source: 'Jupiter' };
      },
    };
    ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, fresh, ARGS));
    expect(asked).toEqual([true]);
    // The market at 0.00033: the opening price is 9.1% below it.
    expect(said(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, readsAt({ kind: 'ok', solPerToken: 0.00033, source: 'Jupiter' }), ARGS))).toBe(
      RANGE_COPY.createPriceOff('9.1%', 'below'),
    );
    // Within 3%: built.
    ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, readsAt({ kind: 'ok', solPerToken: 0.000306, source: 'Jupiter' }), ARGS));
    expect(said(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, readsAt({ kind: 'no-route', detail: 'no route' }), ARGS))).toBe(RANGE_COPY.createNoMarket);
    const unread = await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, readsAt({ kind: 'unread', detail: 'timed out' }), ARGS);
    expect(unread.ok ? null : [unread.outcome.message, unread.outcome.retry]).toEqual([RANGE_COPY.createPriceUnread('timed out'), true]);
  });

  it('refuses with no program, no tier 0, a coin the site does not pair, a range off the spacing or an opening price past the pool’s limits', async () => {
    expect(said(await prepareRangeCreate(W(chainWith({ deploy: false })), cfgLocal, PROG, MARKET, ARGS))).toBe(RANGE_COPY.notDeployed);
    expect(said(await prepareRangeCreate(W(chainWith({ tier: false })), cfgLocal, PROG, MARKET, ARGS))).toBe(RANGE_COPY.noTier);
    expect(said(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, { ...ARGS, coinMint: STRANGER }))).toBe(RANGE_COPY.notOurPair);
    expect(said(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, { ...ARGS, tickLower: RANGE.tickLower + 60 }))).toBe(RANGE_COPY.badRange);
    expect(said(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, { ...ARGS, startPrice: { num: 10n ** 40n, den: 1n } }))).toBe(RANGE_COPY.startOutside);
  });
});

const body = (p: PreparedTx) => p.tx.instructions;
const intentOf = (p: PreparedTx) => p.check.intent as RangeIntent;
const createAt = (p: PreparedTx) => body(p).findIndex((ix) => ix.programId.equals(PROG) && is(ix.data, IX_CREATE_POOL));
const withIx = (list: TransactionInstruction[], i: number, ix: TransactionInstruction) => list.map((x, j) => (j === i ? ix : x));

describe('the checker holds the pool opening to what was worked out', () => {
  it('passes what was built; refuses another fee receiver, price, tier, a later open, the wrong order, or none', async () => {
    const p = ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, ARGS));
    const intent = intentOf(p);
    expect(decodeIntent(body(p), intent).ok).toBe(true);
    const i = createAt(p);
    const ix = body(p)[i]!;
    const refused = (list: TransactionInstruction[], ctx: RangeIntent = intent) => {
      const r = decodeIntent(list, ctx);
      return r.ok ? null : r.reason;
    };
    // The fee paid to a stranger instead of the vault.
    const stranger = new TransactionInstruction({ programId: PROG, data: ix.data, keys: ix.keys.map((k, j) => (j === 13 ? { ...k, pubkey: STRANGER } : k)) });
    expect(refused(withIx(body(p), i, stranger))).toMatch(/the pool opening names accounts or amounts this site did not check/);
    // Another opening price.
    const price = Buffer.from(ix.data);
    price[8] = price[8]! ^ 1;
    expect(refused(withIx(body(p), i, new TransactionInstruction({ programId: PROG, keys: ix.keys, data: price })))).toMatch(/a price this site did not check/);
    // Trading opening later.
    const later = Buffer.from(ix.data);
    later[24] = 1;
    expect(refused(withIx(body(p), i, new TransactionInstruction({ programId: PROG, keys: ix.keys, data: later })))).toMatch(/open for trading later/);
    // A pool on fee tier 1 (the 0.25% tier): never this site's.
    const tier1 = deriveAmmConfig(PROG, 1);
    expect(refused(body(p), { ...intent, pins: { ...intent.pins, ammConfig: tier1, address: derivePool(PROG, tier1, MINT0, MINT1) } })).toMatch(/a fee tier this site does not offer/);
    // The position put in before the pool exists, and no pool opening at all.
    const list = [...body(p)];
    const openAt = list.findIndex((x) => x.programId.equals(PROG) && is(x.data, IX_OPEN_POSITION_WITH_TOKEN22_NFT));
    [list[i], list[openAt]] = [list[openAt]!, list[i]!];
    expect(refused(list)).toMatch(/puts the first position in before the pool is opened/);
    expect(refused(body(p).filter((_, j) => j !== i))).toMatch(/exactly the range-position steps/);
    // A pool opening in a plain opening, and a second one.
    expect(refused(body(p), { ...intent, kind: 'range-open', create: undefined })).toMatch(/opens a new range pool, and this transaction is not for that/);
    expect(refused([...body(p), ix])).not.toBeNull();
    // The site's own builder, on the vault: the same bytes as the one built.
    const rebuilt = createPoolIx({ programId: PROG, poolCreator: ME, ammConfig: TIER0, mint0: MINT0, mint1: MINT1, tokenProgram0: TOKEN_PROGRAM_ID, tokenProgram1: TOKEN_PROGRAM_ID, sqrtPriceX64: SQRT });
    expect(Buffer.from(rebuilt.data).equals(Buffer.from(ix.data))).toBe(true);
  });

  it('the opening price is the one in the bytes, the start of the review', async () => {
    const p = ok(await prepareRangeCreate(W(chainWith()), cfgLocal, PROG, MARKET, { ...ARGS, startPrice: { num: 30_003n, den: 100_000_000n } }));
    expect((p.summary as RangeCreateSummary).startPrice).toBeCloseTo(0.00030003, 10);
  });
});
