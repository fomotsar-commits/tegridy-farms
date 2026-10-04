// @vitest-environment node
//
// THE LEAVE RULE for an opening, through the real builders: nobody is let in who cannot
// be let out.
//
// The pool program refuses a withdrawal that pays 0 on a side (withdraw.rs 116-126). An
// opening with ONE base unit on a side passed every rule this site had: 1 of a token with
// no decimals against 10,000 BAYLA gives 100,000 pool shares, the opener gets 99,900, and
// those pay floor(99,900 · 1 / 100,000) = 0 tokens. `prepareLpCreate` built it and
// `prepareLpWithdraw` then refused every share of it, for good (review, 2026-10-04).
//
// So this file opens with the real `prepareLpCreate`, puts the pool on the chain exactly
// as that opening leaves it, and takes the opener's whole share out with the real
// `prepareLpWithdraw`. Whatever the first lets through, the second must build.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { IX_WITHDRAW, decodePoolState, deriveLpMint } from '../../../solana/cpswap/program';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../solana/lp/quotes';
import { CREATE_COPY, prepareLpCreate } from './createPool';
import { LP_COPY, prepareLpWithdraw, type LpPrepareReads } from './liquidity';
import { CPSWAP, EXT, FakeChain, TIER1_VALUES, addPool, cfgLocal, createSimulator, openAccount, setClock, type SimHandler } from './testkit.fixture';
import type { LpCreateSummary, LpOpenGate, LpWithdrawSummary, Prepared, TierTerms, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const ISSUER = Keypair.generate().publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const TERMS: TierTerms = {
  createPoolFee: TIER1_VALUES.createPoolFee,
  tradeFeeRate: TIER1_VALUES.tradeFeeRate,
  protocolFeeRate: TIER1_VALUES.protocolFeeRate,
  fundFeeRate: TIER1_VALUES.fundFeeRate,
  creatorFeeRate: TIER1_VALUES.creatorFeeRate,
};
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
/** 10,000 USDC, 10,000 BAYLA or 10 SOL: the same number of base units in each. */
const BIG = 10_000_000_000n;
const COINS = [['SOL', SOL_QUOTE], ['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const;

const price = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });
/** A token nobody trades: Jupiter ANSWERS that it has no route. That is a warning, never a stop. */
const noMarket = (quote: QuoteCoin): LpPrepareReads => ({
  outsidePrice: async (mint) => (mint === quote.mint ? price(0.005) : { kind: 'no-route', detail: 'Jupiter has no route for this token' }),
});
/** The token at 0.01 SOL and the coin at 0.005 SOL: 2 coins a token, or 0.01 SOL a token. */
const priced = (quote: QuoteCoin): LpPrepareReads => ({ outsidePrice: async (mint) => price(mint === quote.mint ? 0.005 : 0.01) });

interface World {
  chain: FakeChain;
  quote: QuoteCoin;
  quoteMint: PublicKey;
  mint: PublicKey;
  decimals: number;
}

/** A wallet holding plenty of a classic token (`decimals` of them), of the coin and of SOL, on a chain whose tier 1 is ready. */
function world(quote: QuoteCoin, decimals: number): World {
  const chain = FakeChain.healthy().addTier1({}).addFeeReceiver({});
  chain.simulate = createSimulator();
  const mint = Keypair.generate().publicKey;
  chain.mint(mint, { decimals });
  const quoteMint = new PublicKey(quote.mint);
  if (!quote.native) {
    if (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) chain.mint2022(quoteMint, METADATA_ONLY, { decimals: quote.decimals });
    else chain.mint(quoteMint, { decimals: quote.decimals, mintAuthority: ISSUER, freezeAuthority: ISSUER });
    const quoteAta = associatedTokenAddress(quoteMint, ME, new PublicKey(quote.program));
    if (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) chain.token2022Account(quoteAta, quoteMint, ME, 5n * BIG);
    else chain.tokenAccount(quoteAta, quoteMint, ME, 5n * BIG);
  }
  chain.fund(ME, 60_000_000_000);
  chain.tokenAccount(associatedTokenAddress(mint, ME), mint, ME, 5n * BIG);
  setClock(chain, 2_000_000_000n);
  return { chain, quote, quoteMint, mint, decimals };
}

const open = (w: World, quote: bigint, token: bigint, reads: LpPrepareReads = noMarket(w.quote)) =>
  prepareLpCreate(W(w.chain), OPEN, reads, { owner: ME, tokenMint: w.mint, quoteMint: w.quoteMint, quote, token, shown: { terms: TERMS, standard: 'empty' } });

function refusal(r: Prepared): string {
  if (r.ok) throw new Error('expected the builder to refuse, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  return r.outcome.message;
}

function opened(r: Prepared): LpCreateSummary {
  if (!r.ok) throw new Error(`expected an opening, got: ${r.outcome.message}`);
  return r.prepared.summary as LpCreateSummary;
}

const amountAt = (c: FakeChain, k: PublicKey): bigint | null => {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};

/**
 * cp-swap's `withdraw` on the fake chain's accounts, written out from withdraw.rs and not
 * from this site's maths: each side pays floor(shares · vault / supply), a side that pays 0
 * is refused (6006, ZeroTradingTokens), and a side below its minimum is refused (6005).
 */
const withdrawSimulator: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const w = ixs.find((i) => i.program.equals(CPSWAP) && IX_WITHDRAW.every((b, j) => i.data[j] === b));
  if (!w) return { err: 'no withdrawal', logs: [], unitsConsumed: 1 };
  const u64 = (at: number) => new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength).getBigUint64(at, true);
  const [lp, min0, min1] = [u64(8), u64(16), u64(24)];
  const state = decodePoolState(w.accounts[2]!.toBase58(), chain.accounts.get(w.accounts[2]!.toBase58())!.data)!;
  const out0 = (lp * amountAt(chain, new PublicKey(state.token0Vault))!) / state.lpSupply;
  const out1 = (lp * amountAt(chain, new PublicKey(state.token1Vault))!) / state.lpSupply;
  const fail = (code: number) => ({ err: { InstructionError: [ixs.indexOf(w), { Custom: code }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 1 });
  if (out0 === 0n || out1 === 0n) return fail(6006);
  if (out0 < min0 || out1 < min1) return fail(6005);
  const [userLp, user0, user1] = [w.accounts[3]!, w.accounts[4]!, w.accounts[5]!];
  const lpBefore = amountAt(chain, userLp) ?? 0n;
  if (lpBefore < lp) return fail(1);
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 60_000 };

  // What the signer pays to open each payout account, sized for its own token program.
  const opens = ixs.filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  const paidToOpen = opens.reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
  // A SOL pool pays wrapped SOL, and the transaction closes that account: the SOL lands in the wallet.
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  let unwrapped = 0;
  const paid = (user: PublicKey, mint: string, out: bigint) => {
    if (closes && user.equals(wsolAta)) {
      unwrapped = openAccount(chain, wsolAta).lamports + Number(out);
      return { closed: true };
    }
    return { tokenAmount: (amountAt(chain, user) ?? 0n) + out, mint: new PublicKey(mint), owner: ME };
  };
  const changes: Parameters<FakeChain['post']>[1] = {
    [userLp.toBase58()]: { tokenAmount: lpBefore - lp, mint: new PublicKey(state.lpMint), owner: ME },
    [user0.toBase58()]: paid(user0, state.token0Mint, out0),
    [user1.toBase58()]: paid(user1, state.token1Mint, out1),
  };
  changes[ME.toBase58()] = { lamportsDelta: unwrapped - paidToOpen };
  return { err: null, logs: [], unitsConsumed: 60_000, accounts: chain.post(config.accounts.addresses, changes) };
};

/**
 * The same chain one block later: the pool at its address holding exactly what the opening
 * put in, with the share count `initialize` gives it, and the opener holding the supply
 * less the locked 100. Then the opener's WHOLE share, through the real withdrawal builder.
 */
function leave(w: World, s: LpCreateSummary, pctBps = 10_000n): Promise<Prepared> {
  addPool(w.chain, w.mint, { quote: w.quote, sol: s.put.quote, tokens: s.put.token, lpSupply: s.supply, address: s.pool, tokenDecimals: w.decimals });
  const lpAccount = associatedTokenAddress(deriveLpMint(CPSWAP, s.pool), ME);
  w.chain.tokenAccount(lpAccount, deriveLpMint(CPSWAP, s.pool), ME, s.lpAmount);
  w.chain.simulate = withdrawSimulator;
  return prepareLpWithdraw(W(w.chain), OPEN, { owner: ME, pool: s.pool, tokenMint: w.mint, quoteMint: w.quoteMint, lpAccount, pctBps, slippageBps: 100n });
}

function left(r: Prepared): LpWithdrawSummary {
  if (!r.ok) throw new Error(`expected the withdrawal to build, got: ${r.outcome.message}`);
  return r.prepared.summary as LpWithdrawSummary;
}

describe('an opening whose own share could never be taken out is refused', () => {
  it.each(COINS)('%s: ONE token with no decimals against 10,000 coins (10 SOL) is refused, and the words name the token', async (_n, quote) => {
    const w = world(quote, 0);
    expect(refusal(await open(w, BIG, 1n))).toBe(
      'Too small: your own share of this pool could never be taken out, because it would pay out less than one unit of the token. Put in more of it.',
    );
    expect(refusal(await open(w, BIG, 1n))).toBe(CREATE_COPY.cannotLeave('the token'));
    // Nothing reached a test run: it was stopped while building.
    expect(w.chain.simulateCalls).toHaveLength(0);
  });

  it.each(COINS)('%s: ONE base unit of the coin against 10,000,000,000 tokens is refused, and the words name the coin', async (_n, quote) => {
    const w = world(quote, 0);
    expect(refusal(await open(w, 1n, BIG))).toBe(
      `Too small: your own share of this pool could never be taken out, because it would pay out less than one unit of ${quote.symbol}. Put in more of it.`,
    );
  });

  // What the refusal prevents, shown on the pool program's own sum: this is the pool that
  // opening would have left, and no share of it can ever leave.
  it.each(COINS)('%s: the pool that opening would have left pays 0 tokens for any share of it, so the withdrawal builder refuses 100%%, 50%% and 0.01%%', async (_n, quote) => {
    for (const pct of [10_000n, 5_000n, 1n]) {
      const w = world(quote, 0);
      // 100,000 shares, 99,900 to the opener: what `initialize` does with 10,000,000,000 x 1.
      const stuck = { put: { quote: BIG, token: 1n }, supply: 100_000n, lpAmount: 99_900n, pool: Keypair.generate().publicKey } as LpCreateSummary;
      expect(refusal(await leave(w, stuck, pct))).toBe(LP_COPY.tooSmallWithdraw);
    }
  });
});

describe('what the opening rule lets through can be taken out, all of it', () => {
  it.each(COINS)('%s: 2, 3, 10 and 1,000 tokens with no decimals against 10,000 coins open, and the whole share then leaves', async (_n, quote) => {
    for (const tokens of [2n, 3n, 10n, 1_000n]) {
      const w = world(quote, 0);
      const s = opened(await open(w, BIG, tokens));
      expect(s.put).toEqual({ quote: BIG, token: tokens });
      const out = left(await leave(w, s));
      expect([out.all, out.keep, out.lpAmount]).toEqual([true, 0n, s.lpAmount]);
      // At least one unit of each side comes back, and never more than went in.
      expect(out.quoted.token >= 1n && out.quoted.token <= tokens, `${tokens} tokens`).toBe(true);
      expect(out.quoted.quote >= 1n && out.quoted.quote <= BIG, `${tokens} tokens`).toBe(true);
      expect(out.min.token >= 1n && out.min.quote >= 1n).toBe(true);
    }
  });

  it.each(COINS)('%s: the other way round, 2 base units of the coin against 10,000,000,000 tokens', async (_n, quote) => {
    const w = world(quote, 0);
    const s = opened(await open(w, 2n, BIG));
    const out = left(await leave(w, s));
    expect(out.all).toBe(true);
    expect(out.quoted.quote).toBe(1n);
  });

  // An ordinary opening is not touched by the rule: the same amounts as before it, and out again.
  it.each(COINS)('%s: an ordinary opening at the market (100 tokens of 6 decimals) still opens, and leaves', async (_n, quote) => {
    const w = world(quote, 6);
    const coins = quote.native ? 1_000_000_000n : 200_000_000n;
    const r = await open(w, coins, 100_000_000n, priced(quote));
    const s = opened(r);
    expect(s.price.state).toBe('agrees');
    expect(s.warnings).toEqual([]);
    const out = left(await leave(w, s));
    expect(out.all).toBe(true);
    // All but the locked 100 shares' worth comes back: more than 99.9% of each side.
    expect(out.quoted.quote * 1_000n >= coins * 999n).toBe(true);
    expect(out.quoted.token * 1_000n >= 100_000_000n * 999n).toBe(true);
  });
});
