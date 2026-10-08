// @vitest-environment node
//
// A swap in one of our pools from the swap page, against a fake chain whose simulator
// runs the pool program's own swap sum and enforces its account rules. A swap built with
// another tier's fee, a wrong vault or the wrong token program is refused here as the
// program would refuse it, whatever the builder believes.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  IX_SWAP_BASE_INPUT,
  POOL_STATUS_DISABLE_SWAP,
  decodeAmmConfig,
  decodePoolState,
  deriveAmmConfig,
  publicTierConfig,
} from '../../../solana/cpswap/program';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../solana/lp/quotes';
import { BAYLA_MINT } from '../../../solana/lp/tokenSafety';
import { decodeIntent } from './intent';
import { LP_COPY } from './liquidity';
import { CPSWAP, EXT, FakeChain, addPool, cfgLocal, openAccount, rent, setClock, skewTestRun, type PoolFixture, type SimHandler } from './testkit.fixture';
import type { AggregatorSeen, PreparedTx, SwapIntent, SwapOpenGate, VenueSwapSummary, WriteRpc } from './types';
import { VENUE_SWAP_COPY, prepareVenueSwap, swapStepsProblem, type VenueSwapArgs } from './venueSwap';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: SwapOpenGate = { kind: 'open', cfg: cfgLocal };
const SOL = 10n ** 9n;
const TOK = 10n ** 6n;
const COIN_RESERVE = 24n * SOL;
const TOKEN_RESERVE = 5_000_000n * TOK;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
const TIER1 = publicTierConfig(CPSWAP);
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';

const ceilPpm = (amount: bigint, ppm: bigint) => (amount * ppm + 999_999n) / 1_000_000n;
/**
 * The pool program's own sum, written out: fees rounded up, payout rounded down. A pool
 * that charges its creator's fee takes it WITH the trade fee from what is paid in, or
 * alone from what is paid out, depending on which side it is charged on.
 */
function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: bigint, creator: { ppm: bigint; onInput: boolean } = { ppm: 0n, onInput: true }): bigint {
  const net = amountIn - ceilPpm(amountIn, creator.onInput ? feePpm + creator.ppm : feePpm);
  const out = (net * reserveOut) / (reserveIn + net);
  return creator.onInput ? out : out - ceilPpm(out, creator.ppm);
}

function amountAt(c: FakeChain, k: PublicKey): bigint | null {
  const a = c.accounts.get(k.toBase58());
  if (!a || a.data.length < 72) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

const cpFail = (code: number) => ({
  err: { InstructionError: [3, { Custom: code }] },
  logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`],
  unitsConsumed: 40_000,
});

/** Runs cp-swap's `swap_base_input` on the chain's accounts and reports the watched post-state. */
const swapSimulator: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const sw = ixs.find((i) => i.program.equals(CPSWAP));
  if (!sw || !IX_SWAP_BASE_INPUT.every((b, i) => sw.data[i] === b)) return { err: 'no swap instruction', logs: [], unitsConsumed: 1 };
  const dv = new DataView(sw.data.buffer, sw.data.byteOffset, sw.data.byteLength);
  const amountIn = dv.getBigUint64(8, true);
  const minOut = dv.getBigUint64(16, true);
  const at = (i: number) => sw.accounts[i]!;
  const state = decodePoolState(at(3).toBase58(), chain.accounts.get(at(3).toBase58())!.data)!;
  // The program's own account rules (Anchor's ConstraintAddress): the fee settings are
  // the POOL's, each vault is the pool's for its mint, each program is its mint's.
  if (state.ammConfig !== at(2).toBase58()) return cpFail(2012);
  const in0 = at(10).toBase58() === state.token0Mint;
  const [vIn, vOut, pIn, pOut, mIn, mOut] = in0
    ? [state.token0Vault, state.token1Vault, state.token0Program, state.token1Program, state.token0Mint, state.token1Mint]
    : [state.token1Vault, state.token0Vault, state.token1Program, state.token0Program, state.token1Mint, state.token0Mint];
  const named = [at(6), at(7), at(8), at(9), at(10), at(11), at(12)].map((k) => k.toBase58());
  if (named.join() !== [vIn, vOut, pIn, pOut, mIn, mOut, state.observationKey].join()) return cpFail(2012);
  const clock = chain.accounts.get(CLOCK);
  const now = clock ? new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigInt64(32, true) : 0n;
  if ((state.status & POOL_STATUS_DISABLE_SWAP) !== 0 || now < state.openTime) return cpFail(6000);
  const tier = decodeAmmConfig(at(2).toBase58(), chain.accounts.get(at(2).toBase58())!.data)!;
  // creator_fee_on: 0 both sides (always from what is paid in), 1 token_0 only, 2 token_1 only.
  const creator = { ppm: state.enableCreatorFee ? tier.creatorFeeRate : 0n, onInput: state.creatorFeeOn === 0 || (state.creatorFeeOn === 1) === in0 };
  const out = expectedOut(amountIn, amountAt(chain, at(6))!, amountAt(chain, at(7))!, tier.tradeFeeRate, creator);
  if (out < minOut) return cpFail(6005);

  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const [userIn, userOut] = [at(4), at(5)];
  const inIsSol = userIn.equals(wsolAta);
  const outIsSol = userOut.equals(wsolAta);
  const wrapped = ixs.filter((i) => i.program.equals(SYSTEM_PROGRAM_ID)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
  const inBefore = amountAt(chain, userIn) ?? 0n;
  // Both token programs number "insufficient funds" 1.
  if ((inIsSol ? inBefore + wrapped : inBefore) < amountIn) {
    return { err: { InstructionError: [3, { Custom: 1 }] }, logs: [`Program ${pIn} failed: custom program error: 0x1`], unitsConsumed: 1 };
  }
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 60_000 };

  const paidToOpen = ixs
    .filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    .reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
  const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  const wsolLamports = inIsSol || outIsSol ? openAccount(chain, wsolAta).lamports : 0;
  const wsolBefore = amountAt(chain, wsolAta) ?? 0n;
  const wsolAfter = wsolBefore + wrapped - (inIsSol ? amountIn : 0n) + (outIsSol ? out : 0n);
  // A close hands back every lamport in the account.
  const signerDelta = -Number(wrapped) - paidToOpen + (closes ? wsolLamports + Number(wsolAfter - wsolBefore) : 0);
  const changes: Parameters<FakeChain['post']>[1] = { [ME.toBase58()]: { lamportsDelta: signerDelta } };
  if (!inIsSol) changes[userIn.toBase58()] = { tokenAmount: inBefore - amountIn, mint: new PublicKey(mIn), owner: ME };
  if (!outIsSol) changes[userOut.toBase58()] = { tokenAmount: (amountAt(chain, userOut) ?? 0n) + out, mint: new PublicKey(mOut), owner: ME };
  if (inIsSol || outIsSol) changes[wsolAta.toBase58()] = closes ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: ME };
  return { err: null, logs: [], unitsConsumed: 60_000, accounts: chain.post(config.accounts.addresses, changes) };
};

interface World {
  chain: FakeChain;
  mint: PublicKey;
  coin: QuoteCoin;
  pool: PoolFixture;
  tokenProgram: PublicKey;
  tokenAta: PublicKey;
  coinAta: PublicKey;
}

function world(o: {
  mint?: PublicKey;
  coin?: QuoteCoin;
  tokenProgram?: PublicKey;
  mintExtensions?: Array<[number, number]>;
  /** The fee tier the pool is on; default 1, where this site opens every pool. */
  tier?: 0 | 1;
  address?: PublicKey;
  status?: number;
  openTime?: bigint;
  clock?: bigint | null;
  frozenTokenVault?: boolean;
  heldTokens?: bigint | null;
  heldCoin?: bigint | null;
  heldWsol?: bigint;
  /** The tier's creator fee (parts per million), and the pool's own switch for it on. */
  creatorFee?: bigint;
  /** The pairing coin's own mint extensions, when it is a Token-2022 coin (BAYLA). */
  coinMintExtensions?: Array<[number, number]>;
} = {}): World {
  const chain = FakeChain.healthy().addTier1(o.creatorFee === undefined ? {} : { creatorFeeRate: o.creatorFee });
  chain.simulate = swapSimulator;
  const mint = o.mint ?? Keypair.generate().publicKey;
  const coin = o.coin ?? SOL_QUOTE;
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, o.mintExtensions ?? METADATA_ONLY, { decimals: 6 });
  else chain.mint(mint, { decimals: 6 });
  const coinMint = new PublicKey(coin.mint);
  const coinProgram = new PublicKey(coin.program);
  if (!coin.native) {
    if (coinProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(coinMint, o.coinMintExtensions ?? METADATA_ONLY, { decimals: coin.decimals });
    else chain.mint(coinMint, { decimals: coin.decimals });
  }
  const pool = addPool(chain, mint, {
    sol: COIN_RESERVE,
    tokens: TOKEN_RESERVE,
    tokenProgram,
    quote: coin,
    ammConfig: o.tier === 0 ? undefined : TIER1,
    address: o.address,
    status: o.status,
    openTime: o.openTime ?? NOW - 100n,
    frozenTokenVault: o.frozenTokenVault,
    enableCreatorFee: o.creatorFee !== undefined,
  });
  setClock(chain, o.clock === undefined ? NOW : o.clock);
  chain.fund(ME, Number(20n * SOL));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  const held = o.heldTokens === undefined ? 100_000n * TOK : o.heldTokens;
  if (held !== null) {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, ME, held);
    else chain.tokenAccount(tokenAta, mint, ME, held);
  }
  const coinAta = associatedTokenAddress(coinMint, ME, coinProgram);
  if (!coin.native && o.heldCoin !== null) {
    const amount = o.heldCoin ?? 1_000n * TOK;
    if (coinProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(coinAta, coinMint, ME, amount);
    else chain.tokenAccount(coinAta, coinMint, ME, amount);
  }
  if (o.heldWsol !== undefined) chain.tokenAccount(coinAta, WSOL_MINT, ME, o.heldWsol, { native: { reserve: BigInt(rent(165)) } });
  return { chain, mint, coin, pool, tokenProgram, tokenAta, coinAta };
}

/** Pay the coin, receive the token. */
const buy = (w: World, o: Partial<VenueSwapArgs> = {}): VenueSwapArgs => ({
  owner: ME,
  pool: w.pool.address,
  inputMint: new PublicKey(w.coin.mint),
  outputMint: w.mint,
  amountIn: SOL,
  slippageBps: 100n,
  aggregator: NO_ROUTE,
  ...o,
});
/** Pay the token, receive the coin. */
const sell = (w: World, o: Partial<VenueSwapArgs> = {}): VenueSwapArgs => ({ ...buy(w), inputMint: w.mint, outputMint: new PublicKey(w.coin.mint), amountIn: 1_000n * TOK, ...o });

const NO_ROUTE: AggregatorSeen = { kind: 'no-route' };
const quotedNow = (out: bigint): AggregatorSeen => ({ kind: 'quoted', out, when: 'now' });

function ok(r: Awaited<ReturnType<typeof prepareVenueSwap>>): PreparedTx {
  if (!r.ok) throw new Error(`not prepared: ${r.outcome.message}`);
  return r.prepared;
}
function summaryOf(p: PreparedTx): VenueSwapSummary {
  if (p.summary.kind !== 'venue-swap') throw new Error('kind');
  return p.summary;
}
const swapIx = (p: PreparedTx) => p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
const refusal = async (w: World, a: VenueSwapArgs) => {
  const r = await prepareVenueSwap(W(w.chain), OPEN, a);
  if (r.ok) throw new Error('it prepared');
  return r.outcome;
};

describe('the pool the owner asked about: BAYLA and SOL on fee tier 1, BAYLA under Token-2022', () => {
  const bayla = () => world({ mint: new PublicKey(BAYLA_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID, heldTokens: null });

  it('buys BAYLA with SOL in that pool, priced with tier 1’s own fee', async () => {
    const w = bayla();
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)));
    const s = summaryOf(p);
    const out = expectedOut(SOL, COIN_RESERVE, TOKEN_RESERVE, 10_000n);
    expect(s.quoted.outAmount).toBe(out);
    expect(s.minimumAmountOut).toBe((out * 9_900n) / 10_000n);
    expect(s).toMatchObject({ kind: 'venue-swap', origin: 'standard', paysCoin: true, amountIn: SOL, unwrapsWsol: true, aggregator: NO_ROUTE });
    expect(s.config.index).toBe(1);
    expect(s.pool.equals(w.pool.address)).toBe(true);
    expect(s.coin).toBe(SOL_QUOTE);
    expect(p.kind).toBe('venue-swap');
    expect(p.steps.map((x) => x.kind)).toEqual([
      'compute-limit', 'compute-price', 'create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'pool-swap', 'close-wsol',
    ]);
    // The swap names tier 1's settings (the one account the program takes for this
    // pool), and pays out to the signer's own BAYLA account under Token-2022.
    const ix = swapIx(p);
    expect(ix.keys[2]!.pubkey.equals(TIER1)).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(deriveAmmConfig(CPSWAP, 0))).toBe(false);
    expect(ix.keys[5]!.pubkey.equals(associatedTokenAddress(w.mint, ME, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(ix.keys[8]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // The new BAYLA account is a Token-2022 one (170 bytes), and its deposit is what the review says.
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
    expect(p.simulated.signerLamportsDelta).toBe(-(SOL + BigInt(rent(170))));
    expect(p.simulated.tokenDeltas.find((t) => t.mint.equals(w.mint))?.delta).toBe(out);
  });

  it('sells BAYLA for SOL in that pool, and the SOL arrives as plain SOL', async () => {
    const w = world({ mint: new PublicKey(BAYLA_MINT), tokenProgram: TOKEN_2022_PROGRAM_ID });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w)));
    const s = summaryOf(p);
    const out = expectedOut(1_000n * TOK, TOKEN_RESERVE, COIN_RESERVE, 10_000n);
    expect(s.quoted.outAmount).toBe(out);
    expect(s).toMatchObject({ paysCoin: false, unwrapsWsol: true });
    expect(p.steps.map((x) => x.kind)).toEqual(['compute-limit', 'compute-price', 'create-token-account', 'pool-swap', 'close-wsol']);
    expect(p.simulated.signerLamportsDelta).toBe(out);
    expect(p.check.expect.minSolIn).toBe(s.minimumAmountOut);
    const ix = swapIx(p);
    expect(ix.keys[4]!.pubkey.equals(w.tokenAta)).toBe(true);
    expect(ix.keys[8]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });
});

describe('the routing rule is held again where the swap is built', () => {
  async function ours(w: World) {
    return summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)))).quoted.outAmount;
  }

  it('builds nothing when the aggregator pays one raw unit more than the pool does now', async () => {
    const w = world();
    const out = await ours(w);
    const o = await refusal(w, buy(w, { aggregator: quotedNow(out + 1n) }));
    expect(o).toMatchObject({ status: 'not-sent', stage: 'build', message: VENUE_SWAP_COPY.routeMoved });
    // And no test run was spent on it: the refusal is before anything is built.
    w.chain.simulateCalls = [];
    await refusal(w, buy(w, { aggregator: quotedNow(out + 1n) }));
    expect(w.chain.simulateCalls).toHaveLength(0);
  });

  it('keeps a tie: the aggregator quoting exactly what the pool pays', async () => {
    const w = world();
    const out = await ours(w);
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: quotedNow(out) }))));
    expect(s.quoted.outAmount).toBe(out);
    expect(s.aggregator).toEqual(quotedNow(out));
  });

  it('builds when the pool pays more, and when the aggregator gave no quote', async () => {
    const w = world();
    const out = await ours(w);
    expect(summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: quotedNow(out - 1n) })))).aggregator).toEqual(quotedNow(out - 1n));
    expect(summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: NO_ROUTE })))).aggregator).toEqual(NO_ROUTE);
  });

  it('is judged on the pool as it is NOW: a pool that moved since the page looked loses', async () => {
    const w = world();
    const shown = await ours(w);
    // Someone bought first: fewer tokens are left in the pool for the same SOL.
    w.chain.tokenAccount(w.pool.tokenVault, w.mint, CPSWAP, TOKEN_RESERVE - 100_000n * TOK);
    expect((await refusal(w, buy(w, { aggregator: quotedNow(shown) }))).message).toBe(VENUE_SWAP_COPY.routeMoved);
  });

  it('is held to a figure that stood in for a fresh one just the same, and carries what was seen to the review as it was', async () => {
    const w = world();
    const out = await ours(w);
    const earlier: AggregatorSeen = { kind: 'quoted', out: out + 1n, when: 'earlier' };
    expect((await refusal(w, buy(w, { aggregator: earlier }))).message).toBe(VENUE_SWAP_COPY.underLastQuote);
    const stoodIn: AggregatorSeen = { kind: 'quoted', out, when: 'earlier' };
    expect(summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: stoodIn })))).aggregator).toEqual(stoodIn);
    // An aggregator that could not be asked holds the swap to nothing, and is said as that.
    const unreachable: AggregatorSeen = { kind: 'unreachable' };
    expect(summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: unreachable })))).aggregator).toEqual(unreachable);
  });

  it('a refusal held to a figure that stood in for a fresh one says the pool fell under the last quote, never that the aggregator "now pays more"', async () => {
    const w = world();
    const out = await ours(w);
    const o = await refusal(w, buy(w, { aggregator: { kind: 'quoted', out: out + 1n, when: 'earlier' } }));
    expect(o).toMatchObject({ status: 'not-sent', stage: 'build' });
    expect(o.message).not.toBe(VENUE_SWAP_COPY.routeMoved);
    expect(o.message).not.toMatch(/now pays more|better route/);
  });

  it('an aggregator whose transaction was refused by its test run holds the swap to nothing, and is carried to the review as that', async () => {
    const w = world();
    const refused: AggregatorSeen = { kind: 'refused' };
    expect(summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { aggregator: refused })))).aggregator).toEqual(refused);
  });
});

describe('a pool that charges its creator a fee is priced with it', () => {
  // The tier names a creator fee of 0.5%; the launch program switches it on for the pools
  // it opens, charged on the SOL side: from what is paid in on a buy, from what is paid
  // out on a sale. A quote without it would promise more than the pool pays.
  const CREATOR = 5_000n;

  it('a buy: the fee comes off what is paid in, with the trade fee', async () => {
    const w = world({ creatorFee: CREATOR, heldTokens: null });
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w))));
    expect(s.quoted.outAmount).toBe(expectedOut(SOL, COIN_RESERVE, TOKEN_RESERVE, 10_000n, { ppm: CREATOR, onInput: true }));
    expect(s.quoted.outAmount).toBeLessThan(expectedOut(SOL, COIN_RESERVE, TOKEN_RESERVE, 10_000n));
    expect(s.quoted.result.creatorFee).toBeGreaterThan(0n);
    expect(s.quoted.creatorFeeOnInput).toBe(true);
  });

  it('a sale: the fee comes off what is paid out', async () => {
    const w = world({ creatorFee: CREATOR });
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w))));
    expect(s.quoted.outAmount).toBe(expectedOut(1_000n * TOK, TOKEN_RESERVE, COIN_RESERVE, 10_000n, { ppm: CREATOR, onInput: false }));
    expect(s.quoted.outAmount).toBeLessThan(expectedOut(1_000n * TOK, TOKEN_RESERVE, COIN_RESERVE, 10_000n));
    expect(s.quoted.creatorFeeOnInput).toBe(false);
  });

  it('a pool on the same tier with its own switch off is not charged it', async () => {
    const w = world({ heldTokens: null });
    w.chain.addTier1({ creatorFeeRate: CREATOR });
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w))));
    expect(s.quoted.outAmount).toBe(expectedOut(SOL, COIN_RESERVE, TOKEN_RESERVE, 10_000n));
    expect(s.quoted.result.creatorFee).toBe(0n);
  });
});

describe('each pool is priced and traded with its own fee settings', () => {
  it('a pool on tier 0 pays tier 0’s price and names tier 0’s settings', async () => {
    const w = world({ tier: 0 });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)));
    expect(summaryOf(p).quoted.outAmount).toBe(expectedOut(SOL, COIN_RESERVE, TOKEN_RESERVE, 2_500n));
    expect(swapIx(p).keys[2]!.pubkey.equals(deriveAmmConfig(CPSWAP, 0))).toBe(true);
  });

  it('a pool at its own address is traded at that address', async () => {
    const w = world({ address: Keypair.generate().publicKey });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)));
    expect(summaryOf(p).origin).toBe('other');
    expect(swapIx(p).keys[3]!.pubkey.equals(w.pool.address)).toBe(true);
  });
});

describe('a pool paired with USDC or BAYLA moves no SOL', () => {
  it('buys the token with USDC from the signer’s own USDC account, wrapping nothing', async () => {
    const w = world({ coin: USDC_QUOTE, heldTokens: null });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w, { amountIn: 100n * TOK })));
    expect(p.steps.map((x) => x.kind)).toEqual(['compute-limit', 'compute-price', 'create-token-account', 'pool-swap']);
    const s = summaryOf(p);
    expect(s).toMatchObject({ paysCoin: true, unwrapsWsol: false });
    expect(s.quoted.outAmount).toBe(expectedOut(100n * TOK, COIN_RESERVE, TOKEN_RESERVE, 10_000n));
    // Only the new token account's deposit leaves in SOL.
    expect(p.simulated.signerLamportsDelta).toBe(-BigInt(rent(165)));
    expect(p.simulated.tokenDeltas.find((t) => t.account.equals(w.coinAta))?.delta).toBe(-100n * TOK);
  });

  it('sells the token for BAYLA into the signer’s own BAYLA account under Token-2022', async () => {
    const w = world({ coin: BAYLA_QUOTE, heldCoin: null });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w)));
    expect(p.steps.map((x) => x.kind)).toEqual(['compute-limit', 'compute-price', 'create-token-account', 'pool-swap']);
    const ix = swapIx(p);
    expect(ix.keys[5]!.pubkey.equals(associatedTokenAddress(new PublicKey(BAYLA_MINT), ME, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
  });
});

describe('a wallet’s own wrapped SOL is never spent or unwrapped behind its back', () => {
  it('a buy keeps a wrapped-SOL account that already held some, with what it held', async () => {
    const w = world({ heldWsol: 5n * SOL, heldTokens: null });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)));
    expect(summaryOf(p)).toMatchObject({ unwrapsWsol: false, wsolHeldBefore: 5n * SOL });
    expect(p.steps.some((x) => x.kind === 'close-wsol')).toBe(false);
    expect(p.simulated.tokenDeltas.find((t) => t.mint.equals(WSOL_MINT))?.delta ?? 0n).toBe(0n);
  });

  it('a buy whose test run spends one lamport of that wrapped SOL is blocked', async () => {
    const w = world({ heldWsol: 5n * SOL, heldTokens: null });
    skewTestRun(w.chain, w.coinAta, -1n);
    const o = await refusal(w, buy(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' });
  });

  it('a sale into a kept wrapped-SOL account pays wrapped SOL, and says it keeps it', async () => {
    const w = world({ heldWsol: 5n * SOL });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w)));
    const s = summaryOf(p);
    expect(s.unwrapsWsol).toBe(false);
    expect(p.simulated.tokenDeltas.find((t) => t.mint.equals(WSOL_MINT))?.delta).toBe(s.quoted.outAmount);
    expect(p.check.expect.minSolIn).toBeUndefined();
  });
});

describe('what it refuses to build, in words', () => {
  it('a pair with no pairing coin', async () => {
    const w = world();
    const o = await refusal(w, buy(w, { inputMint: Keypair.generate().publicKey }));
    expect(o.message).toBe(VENUE_SWAP_COPY.notOurPair);
  });

  it('a pool that is another token’s', async () => {
    const w = world();
    const otherMint = Keypair.generate().publicKey;
    w.chain.mint(otherMint, { decimals: 6 });
    const other = addPool(w.chain, otherMint, { sol: COIN_RESERVE, tokens: TOKEN_RESERVE, ammConfig: TIER1, openTime: NOW - 100n });
    const o = await refusal(w, buy(w, { pool: other.address }));
    expect(o.message).toBe(LP_COPY.notThisPair('SOL'));
  });

  it('a token that takes a fee on every transfer', async () => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [[EXT.TransferFeeConfig, 108]] });
    const o = await refusal(w, buy(w));
    expect(o.message).toMatch(/^This token uses a transfer-fee setting/);
    expect(o.message).toMatch(/Nothing was built\.$/);
  });

  it('a pool with a frozen vault, with swaps off, not open yet, or with no clock to check it by', async () => {
    const frozen = world({ frozenTokenVault: true });
    expect((await refusal(frozen, buy(frozen))).message).toBe(LP_COPY.vaultFrozen());
    const off = world({ status: POOL_STATUS_DISABLE_SWAP });
    expect((await refusal(off, buy(off))).message).toBe(VENUE_SWAP_COPY.cannotPrice);
    const early = world({ openTime: NOW + 60n });
    expect((await refusal(early, buy(early))).message).toBe(VENUE_SWAP_COPY.cannotPrice);
    const noClock = world({ clock: null });
    expect((await refusal(noClock, buy(noClock))).message).toBe(VENUE_SWAP_COPY.noClock);
  });

  it('a pool whose fee settings cannot be read', async () => {
    const w = world();
    w.chain.accounts.delete(TIER1.toBase58());
    expect((await refusal(w, buy(w))).message).toBe(VENUE_SWAP_COPY.feesUnread);
  });

  it('a sale of a token the wallet has no account for, or holds too little of', async () => {
    const none = world({ heldTokens: null });
    expect((await refusal(none, sell(none))).message).toBe(VENUE_SWAP_COPY.noSource('tokens', none.tokenAta.toBase58()));
    const few = world({ heldTokens: 10n * TOK });
    expect((await refusal(few, sell(few))).message).toBe(VENUE_SWAP_COPY.short('1,000 tokens', '10 tokens'));
  });

  it('an amount of zero, and a price limit of zero', async () => {
    const w = world();
    expect((await refusal(w, buy(w, { amountIn: 0n }))).message).toBe('Enter an amount above zero.');
    expect((await refusal(w, buy(w, { slippageBps: 0n }))).message).toBe('Set a price limit above 0%.');
  });

  it('an amount too small to be protected by a price limit', async () => {
    const w = world();
    expect((await refusal(w, sell(w, { amountIn: 1n }))).message).toMatch(/cannot price this trade|too small/);
  });

  it('a pairing coin under Token-2022 whose own mint takes a fee on every transfer', async () => {
    const w = world({ coin: BAYLA_QUOTE, coinMintExtensions: [[EXT.TransferFeeConfig, 108]] });
    const o = await refusal(w, sell(w));
    expect(o.message).toBe(LP_COPY.coinChanged('BAYLA', 'it uses a transfer-fee setting, which lets the token take a fee out of every transfer'));
  });

  it('an account to be paid into that belongs to someone else', async () => {
    const w = world({ heldTokens: null });
    w.chain.tokenAccount(w.tokenAta, w.mint, STRANGER, 0n);
    expect((await refusal(w, buy(w))).message).toBe(LP_COPY.foreignOwner(w.tokenAta.toBase58(), STRANGER.toBase58()));
  });
});

describe('the test run is compared with what the review says', () => {
  it('blocks a swap whose test run pays out less than its own minimum', async () => {
    const w = world({ heldTokens: null });
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w))));
    skewTestRun(w.chain, w.tokenAta, -(s.quoted.outAmount - s.minimumAmountOut) - 1n);
    const o = await refusal(w, buy(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' });
  });

  it('blocks a swap whose test run takes more SOL than it pays in', async () => {
    const w = world();
    // This chain's test run takes no network fee, so the bound has that much room: one
    // lamport past the fees it carried is one lamport past what the review says.
    const fees = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w))).fees;
    skewTestRun(w.chain, ME, -(fees.baseLamports + fees.priorityLamports) - 1n);
    const o = await refusal(w, buy(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows more SOL leaving your wallet than this screen says.' });
  });

  it('blocks a sale whose test run pays out one lamport less SOL than its own minimum', async () => {
    const w = world();
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w)));
    const s = summaryOf(p);
    // This chain's test run takes no network fee, and the bound allows for one.
    skewTestRun(w.chain, ME, -(s.quoted.outAmount - s.minimumAmountOut) - (p.fees.baseLamports + p.fees.priorityLamports) - 1n);
    const o = await refusal(w, sell(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows less SOL arriving than this screen says.' });
  });

  it('blocks a sale into a kept wrapped-SOL account that pays in less than its minimum', async () => {
    const w = world({ heldWsol: 5n * SOL });
    const s = summaryOf(ok(await prepareVenueSwap(W(w.chain), OPEN, sell(w))));
    skewTestRun(w.chain, w.coinAta, -(s.quoted.outAmount - s.minimumAmountOut) - 1n);
    const o = await refusal(w, sell(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' });
  });

  it('blocks a swap in a USDC pool whose test run pays out less than its minimum, or takes more USDC than it names', async () => {
    const short = world({ coin: USDC_QUOTE, heldTokens: null });
    const s = summaryOf(ok(await prepareVenueSwap(W(short.chain), OPEN, buy(short, { amountIn: 100n * TOK }))));
    skewTestRun(short.chain, short.tokenAta, -(s.quoted.outAmount - s.minimumAmountOut) - 1n);
    expect((await refusal(short, buy(short, { amountIn: 100n * TOK }))).message).toBe('Blocked: the simulation shows a different token amount than this screen says.');
    const over = world({ coin: USDC_QUOTE, heldTokens: null });
    skewTestRun(over.chain, over.coinAta, -1n);
    expect((await refusal(over, buy(over, { amountIn: 100n * TOK }))).message).toBe('Blocked: the simulation shows a different token amount than this screen says.');
  });

  it('blocks a sale whose test run takes more tokens than it names', async () => {
    const w = world();
    skewTestRun(w.chain, w.tokenAta, -1n);
    const o = await refusal(w, sell(w));
    expect(o).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' });
  });
});

describe('the checker: a venue swap read back out of its bytes', () => {
  async function built(o: Parameters<typeof world>[0] = { heldTokens: null }, side: 'buy' | 'sell' = 'buy') {
    const w = world(o);
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, side === 'buy' ? buy(w) : sell(w)));
    return { w, p, intent: p.check.intent as SwapIntent, ixs: p.tx.instructions };
  }
  const reasonOf = (r: ReturnType<typeof decodeIntent>) => (r.ok ? 'accepted' : r.reason);
  /** The same instruction with one account swapped for another. */
  function withKey(ix: TransactionInstruction, slot: number, k: PublicKey): TransactionInstruction {
    return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((m, i) => (i === slot ? { ...m, pubkey: k } : m)) });
  }
  const replacing = (ixs: TransactionInstruction[], old: TransactionInstruction, now: TransactionInstruction) => ixs.map((i) => (i === old ? now : i));

  it('accepts the transaction it built', async () => {
    const { ixs, intent } = await built();
    expect(decodeIntent(ixs, intent).ok).toBe(true);
  });

  it('refuses any one of the swap’s 13 accounts changed, naming which', async () => {
    const { ixs, intent, p } = await built();
    const sw = swapIx(p);
    const why: Record<number, RegExp> = {
      0: /paid by someone else/,
      1: /wrong pool authority/,
      2: /wrong fee settings/,
      3: /different pool than the one checked/,
      4: /spends from an account that is not yours/,
      5: /pays out to an account that is not yours/,
      6: /wrong pool vault/,
      7: /wrong pool vault/,
      8: /wrong token program/,
      9: /wrong token program/,
      10: /wrong token/,
      11: /wrong token/,
      12: /wrong price record/,
    };
    for (let slot = 0; slot < 13; slot++) {
      const r = decodeIntent(replacing(ixs, sw, withKey(sw, slot, STRANGER)), intent);
      expect(reasonOf(r), `slot ${slot}`).toMatch(why[slot]!);
    }
  });

  it('refuses the launch tier’s fee settings on a tier 1 pool', async () => {
    const { ixs, intent, p } = await built();
    const sw = swapIx(p);
    expect(reasonOf(decodeIntent(replacing(ixs, sw, withKey(sw, 2, deriveAmmConfig(CPSWAP, 0))), intent))).toMatch(/wrong fee settings/);
  });

  it('refuses a payout to a stranger’s account for the same token', async () => {
    const { ixs, intent, p, w } = await built();
    const sw = swapIx(p);
    const theirs = associatedTokenAddress(w.mint, STRANGER, w.tokenProgram);
    expect(reasonOf(decodeIntent(replacing(ixs, sw, withKey(sw, 5, theirs)), intent))).toMatch(/pays out to an account that is not yours/);
  });

  it('refuses a swap with no minimum, and one of zero', async () => {
    const { ixs, intent, p } = await built();
    const sw = swapIx(p);
    const data = (amountIn: bigint, min: bigint) => {
      const d = Buffer.from(sw.data);
      d.writeBigUInt64LE(amountIn, 8);
      d.writeBigUInt64LE(min, 16);
      return new TransactionInstruction({ programId: sw.programId, keys: sw.keys, data: d });
    };
    expect(reasonOf(decodeIntent(replacing(ixs, sw, data(SOL, 0n)), intent))).toMatch(/accepts any price/);
    expect(reasonOf(decodeIntent(replacing(ixs, sw, data(0n, 1n)), intent))).toMatch(/swap amount is zero/);
  });

  it('refuses two swaps, and none', async () => {
    const { ixs, intent, p } = await built();
    const sw = swapIx(p);
    expect(reasonOf(decodeIntent([...ixs, sw], intent))).toMatch(/exactly one swap/);
    expect(reasonOf(decodeIntent(ixs.filter((i) => i !== sw), intent))).toMatch(/exactly one swap/);
  });

  it('refuses SOL wrapped by a swap that does not pay in SOL', async () => {
    const buying = await built();
    const wraps = buying.ixs.filter((i) => i.programId.equals(SYSTEM_PROGRAM_ID) || (i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 17));
    expect(wraps).toHaveLength(2);
    // A sale in the same pool: the same wrap instructions are not its to carry.
    const selling = await built({}, 'sell');
    for (const wrap of wraps) {
      expect(reasonOf(decodeIntent([...selling.ixs, wrap], selling.intent))).toMatch(/wraps SOL, and this swap does not pay in SOL/);
    }
    // And a pool with no SOL in it neither wraps nor unwraps.
    const usdc = await built({ coin: USDC_QUOTE, heldTokens: null });
    for (const wrap of wraps) expect(reasonOf(decodeIntent([...usdc.ixs, wrap], usdc.intent))).toMatch(/does not pay in SOL/);
    const close = selling.ixs.find((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9)!;
    expect(reasonOf(decodeIntent([...usdc.ixs, close], usdc.intent))).toMatch(/not paired with SOL/);
  });

  it('opens only the wrapped-SOL account and the account it pays into', async () => {
    const { ixs, intent, w, p } = await built();
    const open = (mint: PublicKey, program: PublicKey, owner = ME) =>
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        data: Buffer.from([1]),
        keys: [ME, associatedTokenAddress(mint, owner, program), owner, mint, SYSTEM_PROGRAM_ID, program].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      });
    // The pool-share account, an unrelated token's, and one for someone else.
    expect(reasonOf(decodeIntent([...ixs, open(summaryOf(p).pool, TOKEN_PROGRAM_ID)], intent))).toMatch(/token this swap does not pay out/);
    expect(reasonOf(decodeIntent([...ixs, open(intent.pins.lpMint, TOKEN_PROGRAM_ID)], intent))).toMatch(/token this swap does not pay out/);
    expect(reasonOf(decodeIntent([...ixs, open(w.mint, w.tokenProgram, STRANGER)], intent))).toMatch(/for someone else/);
    // The token's account under the OTHER token program is a different address.
    const other = w.tokenProgram.equals(TOKEN_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    expect(reasonOf(decodeIntent([...ixs, open(w.mint, other)], intent))).toMatch(/wrong programs/);
    // A sale pays out SOL: it may not open the account it SPENDS from.
    const selling = await built({}, 'sell');
    expect(reasonOf(decodeIntent([...selling.ixs, open(selling.w.mint, selling.w.tokenProgram)], selling.intent))).toMatch(/token this swap does not pay out/);
  });

  it('refuses a token transfer, an approval, and a call to any other program', async () => {
    const { ixs, intent } = await built();
    const tokenIx = (tag: number) => new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data: Buffer.from([tag, 1, 0, 0, 0, 0, 0, 0, 0]), keys: [] });
    expect(reasonOf(decodeIntent([...ixs, tokenIx(3)], intent))).toMatch(/never builds/);
    expect(reasonOf(decodeIntent([...ixs, tokenIx(4)], intent))).toMatch(/never builds/);
    const t22 = new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, data: Buffer.from([3]), keys: [] });
    expect(reasonOf(decodeIntent([...ixs, t22], intent))).toMatch(/a program this page never uses/);
    const launch = new TransactionInstruction({ programId: cfgLocal.programId, data: Buffer.from([0]), keys: [] });
    expect(reasonOf(decodeIntent([...ixs, launch], intent))).toMatch(/never uses/);
  });
});

describe('swapStepsProblem: the decoded steps must be exactly the plan', () => {
  it('says what differs', async () => {
    const w = world({ heldTokens: null });
    const p = ok(await prepareVenueSwap(W(w.chain), OPEN, buy(w)));
    const s = summaryOf(p);
    const wsol = associatedTokenAddress(WSOL_MINT, ME);
    const want = { pool: s.pool, inputMint: WSOL_MINT, outputMint: w.mint, amountIn: SOL, minimumAmountOut: s.minimumAmountOut, wraps: SOL, opens: [wsol, w.tokenAta], closes: true };
    expect(swapStepsProblem(p.steps, want)).toBe(null);
    expect(swapStepsProblem(p.steps, { ...want, minimumAmountOut: s.minimumAmountOut + 1n })).toMatch(/does not match the quote/);
    expect(swapStepsProblem(p.steps, { ...want, pool: STRANGER })).toMatch(/different pool/);
    expect(swapStepsProblem(p.steps, { ...want, outputMint: STRANGER })).toMatch(/different tokens/);
    expect(swapStepsProblem(p.steps, { ...want, wraps: SOL - 1n })).toMatch(/SOL wrapped/);
    expect(swapStepsProblem(p.steps, { ...want, wraps: null })).toMatch(/does not pay in SOL/);
    expect(swapStepsProblem(p.steps, { ...want, opens: [wsol] })).toMatch(/opens accounts other than/);
    expect(swapStepsProblem(p.steps, { ...want, closes: false })).toMatch(/closes your wrapped-SOL account/);
    expect(swapStepsProblem(p.steps.filter((x) => x.kind !== 'pool-swap'), want)).toMatch(/missing/);
  });
});
