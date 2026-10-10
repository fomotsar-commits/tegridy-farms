// @vitest-environment node
//
// Adding to and removing from a pool paired with USDC or BAYLA (quotes.ts). Nothing is
// wrapped: a deposit spends the coin from the signer's own account for it, and a
// withdrawal pays it into that account, opened under the coin's own token program.
// liquidity.test.ts holds the SOL pools; the rules that do not depend on the coin (the
// token's checks, the pool's status bits, the share maths) are tested there once.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from '@solana/spl-token';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { IX_DEPOSIT, IX_WITHDRAW, decodePoolState } from '../../../solana/cpswap/program';
import { depositIx, withdrawIx } from '../../../solana/cpswap/ix';
import { lpTokensToTradingTokens } from '../../../solana/cpswap/math';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../solana/lp/quotes';
import { decodeIntent } from './intent';
import {
  LP_COPY,
  LP_FEE_RESERVE,
  depositStepsProblem,
  poolPins,
  prepareLpDeposit,
  prepareLpWithdraw,
  readPoolForWrite,
  withdrawStepsProblem,
  type LpPrepareReads,
  type WriteSnapshot,
} from './liquidity';
import { bodySteps } from './prepare';
import { CPSWAP, EXT, FakeChain, addPool, beforeBalanceRun, cfgLocal, openAccount, rent, setClock, skewTestRun, type PoolFixture, type SimHandler } from './testkit.fixture';
import type { IntentStep, LpDepositSummary, LpOpenGate, LpWithdrawSummary, PoolIntent, PoolPins, PreparedTx, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const U6 = 10n ** 6n;
/** 2,000 coins against 1,000 tokens (both 6 decimals): 2 coins a token. */
const QUOTE_RESERVE = 2_000n * U6;
const TOKEN_RESERVE = 1_000n * U6;
const LP_SUPPLY = 1_000_000_000n;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
const programOf = (q: QuoteCoin) => new PublicKey(q.program);
const accountSize = (q: QuoteCoin) => (q.program === TOKEN_2022_PROGRAM_ID.toBase58() ? 170 : 165);

// ── prices: the token at 0.01 SOL, the coin at 0.005 SOL, so 2 coins a token ───
const ok = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });
function priced(quote: QuoteCoin, o: { token?: OutsidePrice; coin?: OutsidePrice } = {}): LpPrepareReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    outsidePrice: async (mint) => {
      asked.push(mint);
      return mint === quote.mint ? (o.coin ?? ok(0.005)) : (o.token ?? ok(0.01));
    },
  };
}

// ── the simulator: cp-swap's deposit / withdraw maths, with no wrapped SOL anywhere ──
const amountAt = (c: FakeChain, k: PublicKey): bigint | null => {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null;
};

const simulator: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const pool = ixs.find((i) => i.program.equals(CPSWAP));
  if (!pool) return { err: 'no pool instruction', logs: [], unitsConsumed: 1 };
  const d = pool.data;
  const u64 = (o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
  const isDeposit = IX_DEPOSIT.every((b, i) => d[i] === b);
  const isWithdraw = IX_WITHDRAW.every((b, i) => d[i] === b);
  const [lp, b0, b1] = [u64(8), u64(16), u64(24)];
  const state = decodePoolState(pool.accounts[2]!.toBase58(), chain.accounts.get(pool.accounts[2]!.toBase58())!.data)!;
  const R0 = amountAt(chain, new PublicKey(state.token0Vault))!;
  const R1 = amountAt(chain, new PublicKey(state.token1Vault))!;
  const [user0, user1, userLp] = [pool.accounts[4]!, pool.accounts[5]!, pool.accounts[3]!];
  // What the signer pays to open accounts, each sized for its own token program.
  const paidToOpen = ixs
    .filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    .reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
  const before0 = amountAt(chain, user0) ?? 0n;
  const before1 = amountAt(chain, user1) ?? 0n;
  const lpBefore = amountAt(chain, userLp) ?? 0n;
  let move0: bigint;
  let move1: bigint;
  if (isDeposit) {
    const c = lpTokensToTradingTokens(lp, state.lpSupply, R0, R1, 'ceiling');
    if (!c || c.token0Amount > b0 || c.token1Amount > b1) return { err: { InstructionError: [1, { Custom: 6005 }] }, logs: [], unitsConsumed: 1 };
    if (before0 < c.token0Amount || before1 < c.token1Amount) return { err: { InstructionError: [1, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
    [move0, move1] = [-c.token0Amount, -c.token1Amount];
  } else if (isWithdraw) {
    const o = lpTokensToTradingTokens(lp, state.lpSupply, R0, R1, 'floor');
    if (!o || o.token0Amount < b0 || o.token1Amount < b1) return { err: { InstructionError: [2, { Custom: 6005 }] }, logs: [], unitsConsumed: 1 };
    [move0, move1] = [o.token0Amount, o.token1Amount];
  } else {
    return { err: 'not a liquidity instruction', logs: [], unitsConsumed: 1 };
  }
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 60_000 };
  return {
    err: null,
    logs: [],
    unitsConsumed: 60_000,
    accounts: chain.post(config.accounts.addresses, {
      [ME.toBase58()]: { lamportsDelta: -paidToOpen },
      [user0.toBase58()]: { tokenAmount: before0 + move0, mint: new PublicKey(state.token0Mint), owner: ME },
      [user1.toBase58()]: { tokenAmount: before1 + move1, mint: new PublicKey(state.token1Mint), owner: ME },
      [userLp.toBase58()]: { tokenAmount: lpBefore + (isDeposit ? lp : -lp), mint: new PublicKey(state.lpMint), owner: ME },
    }),
  };
};

// ── the world ────────────────────────────────────────────────────────────────

interface World {
  chain: FakeChain;
  quote: QuoteCoin;
  mint: PublicKey;
  pool: PoolFixture;
  tokenAta: PublicKey;
  quoteAta: PublicKey;
  lpAta: PublicKey;
}

function world(quote: QuoteCoin, o: { heldQuote?: bigint | null; heldLp?: bigint; wallet?: bigint; coinMint?: 'missing' | 'wrong-decimals' | 'wrong-program'; cpiGuard?: boolean; quoteOwner?: PublicKey; frozenTokenVault?: boolean } = {}): World {
  const chain = FakeChain.healthy();
  chain.simulate = simulator;
  const mint = Keypair.generate().publicKey;
  chain.mint(mint, { decimals: 6 });
  // The coin's own mint, as the chain holds it: USDC classic with its freeze authority,
  // BAYLA under Token-2022 with a name and a picture.
  const quoteMint = new PublicKey(quote.mint);
  if (o.coinMint !== 'missing') {
    const decimals = o.coinMint === 'wrong-decimals' ? 9 : quote.decimals;
    const token2022 = (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) !== (o.coinMint === 'wrong-program');
    if (token2022) chain.mint2022(quoteMint, METADATA_ONLY, { decimals });
    else chain.mint(quoteMint, { decimals });
  }
  const pool = addPool(chain, mint, { quote, sol: QUOTE_RESERVE, tokens: TOKEN_RESERVE, lpSupply: LP_SUPPLY, frozenTokenVault: o.frozenTokenVault });
  setClock(chain, NOW);
  chain.fund(ME, Number(o.wallet ?? 5n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(mint, ME);
  chain.tokenAccount(tokenAta, mint, ME, 10_000n * U6);
  const quoteAta = associatedTokenAddress(quoteMint, ME, programOf(quote));
  const held = o.heldQuote === undefined ? 50_000n * U6 : o.heldQuote;
  if (held !== null) {
    const owner = o.quoteOwner ?? ME;
    if (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) chain.token2022Account(quoteAta, quoteMint, owner, held, { cpiGuard: o.cpiGuard });
    else chain.tokenAccount(quoteAta, quoteMint, owner, held);
  }
  const lpAta = associatedTokenAddress(pool.lpMint, ME);
  if (o.heldLp !== undefined) chain.tokenAccount(lpAta, pool.lpMint, ME, o.heldLp);
  return { chain, quote, mint, pool, tokenAta, quoteAta, lpAta };
}

const depositArgs = (w: World, o: Partial<Parameters<typeof prepareLpDeposit>[3]> = {}) => ({
  owner: ME,
  pool: w.pool.address,
  tokenMint: w.mint,
  quoteMint: new PublicKey(w.quote.mint),
  driving: 'quote' as const,
  maxIn: 100n * U6,
  slippageBps: 100n,
  shownOtherMax: null,
  ...o,
});
const deposit = (w: World, o: Partial<Parameters<typeof prepareLpDeposit>[3]> = {}, reads: LpPrepareReads = priced(w.quote)) =>
  prepareLpDeposit(W(w.chain), OPEN, reads, depositArgs(w, o));
const withdraw = (w: World, o: Partial<Parameters<typeof prepareLpWithdraw>[2]> = {}) =>
  prepareLpWithdraw(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: w.mint, quoteMint: new PublicKey(w.quote.mint), lpAccount: w.lpAta, pctBps: 5_000n, slippageBps: 100n, ...o });

function prepared(r: Awaited<ReturnType<typeof deposit>>): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}
function refused(r: Awaited<ReturnType<typeof deposit>>): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  return r.outcome.message;
}
const kinds = (p: PreparedTx) => bodySteps(p.steps).map((s) => s.kind);
const row = (p: PreparedTx, k: PublicKey) => {
  const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
  return [r.minDelta, r.maxDelta];
};
const COINS = [['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const;

// ── the read ─────────────────────────────────────────────────────────────────

describe('readPoolForWrite: a pool paired with USDC or BAYLA', () => {
  it.each(COINS)('%s: 14 keys in ONE call (the 13, then the coin’s own mint), and the coin’s account is its own associated account', async (_n, quote) => {
    const w = world(quote, { heldLp: 5n });
    const asked: string[][] = [];
    const orig = w.chain.getMultipleAccountsInfo;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      asked.push(keys.map((k) => k.toBase58()));
      return orig(keys);
    };
    const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote, owner: ME })) as WriteSnapshot;
    expect(typeof snap).toBe('object');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(14);
    expect(asked[0]![13]).toBe(quote.mint);
    expect(asked[0]).toContain(w.quoteAta.toBase58());
    // No wrapped-SOL account is read at all.
    expect(asked[0]).not.toContain(associatedTokenAddress(WSOL_MINT, ME).toBase58());
    expect(snap.quote).toBe(quote);
    expect(snap.quoteAccount.address.equals(w.quoteAta)).toBe(true);
    expect(snap.quoteMint?.owner).toBe(quote.program);
    expect(snap.view.quote).toBe(quote);
    expect([snap.view.quoteReserve, snap.view.tokenReserve]).toEqual([QUOTE_RESERVE, TOKEN_RESERVE]);
    // USDC's account is a classic 165 (no extra rent read); BAYLA's is 170 under Token-2022.
    expect(snap.rents.quoteAccount).toBe(BigInt(rent(accountSize(quote))));
    expect(w.chain.calls.filter((c) => c === 'getMinimumBalanceForRentExemption')).toHaveLength(quote === USDC_QUOTE ? 3 : 4);
  });

  it('the pool must pair the token with the coin the caller named: a SOL pool asked for as USDC is refused, and so is the reverse', async () => {
    const usdc = world(USDC_QUOTE);
    const sol = FakeChain.healthy();
    const mint = Keypair.generate().publicKey;
    sol.mint(mint, { decimals: 6 });
    sol.mint(new PublicKey(USDC_QUOTE.mint), { decimals: 6 });
    const solPool = addPool(sol, mint, { sol: 10n ** 10n, tokens: TOKEN_RESERVE });
    setClock(sol, NOW);
    expect(await readPoolForWrite(W(sol), cfgLocal, { pool: solPool.address, tokenMint: mint, quote: USDC_QUOTE, owner: ME })).toBe(LP_COPY.notThisPair('USDC'));
    expect(await readPoolForWrite(W(usdc.chain), cfgLocal, { pool: usdc.pool.address, tokenMint: usdc.mint, quote: SOL_QUOTE, owner: ME })).toBe(LP_COPY.notThisPair('SOL'));
    expect(await readPoolForWrite(W(usdc.chain), cfgLocal, { pool: usdc.pool.address, tokenMint: usdc.mint, quote: BAYLA_QUOTE, owner: ME })).toBe(LP_COPY.notThisPair('BAYLA'));
  });

  it('a pair this site reads the other way round is refused: SOL is never the token of a pool', async () => {
    // A real SOL/USDC pool. This site reads it as USDC priced in SOL, never SOL priced in USDC.
    const chain = FakeChain.healthy();
    chain.mint(new PublicKey(USDC_QUOTE.mint), { decimals: 6 });
    const p = addPool(chain, WSOL_MINT, { quote: USDC_QUOTE, sol: QUOTE_RESERVE, tokens: 10n ** 10n, tokenDecimals: 9 });
    setClock(chain, NOW);
    expect(await readPoolForWrite(W(chain), cfgLocal, { pool: p.address, tokenMint: WSOL_MINT, quote: USDC_QUOTE, owner: ME })).toBe(LP_COPY.notThisPair('USDC'));
    // The same pool, read the right way round, gets past the pair rule (its token here is USDC).
    const right = await readPoolForWrite(W(chain), cfgLocal, { pool: p.address, tokenMint: new PublicKey(USDC_QUOTE.mint), quote: SOL_QUOTE, owner: ME });
    expect(typeof right === 'string' ? right : 'read').toBe('read');
  });

  it.each([
    ['missing', 'its mint is missing'],
    ['wrong-decimals', 'its decimals differ'],
    ['wrong-program', 'it sits under another token program'],
  ] as const)('the coin’s own mint %s: nothing is built, and the reason names the coin', async (coinMint, what) => {
    for (const [, quote] of COINS) {
      const w = world(quote, { coinMint });
      expect(await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote, owner: ME })).toBe(LP_COPY.coinChanged(quote.symbol, what));
    }
  });
});

// ── deposit ──────────────────────────────────────────────────────────────────

describe('prepareLpDeposit: a pool paired with USDC or BAYLA', () => {
  it.each(COINS)('%s: the body is the pool-share account and the deposit, and nothing is wrapped', async (_n, quote) => {
    const w = world(quote);
    const reads = priced(quote);
    const p = prepared(await deposit(w, {}, reads));
    expect(kinds(p)).toEqual(['create-token-account', 'pool-deposit']);
    const create = bodySteps(p.steps)[0] as Extract<IntentStep, { kind: 'create-token-account' }>;
    expect(create.address.equals(w.lpAta)).toBe(true);
    // Both prices were read: the token's and the coin's own.
    expect(reads.asked.sort()).toEqual([w.mint.toBase58(), quote.mint].sort());

    const s = p.summary as LpDepositSummary;
    expect(s.quote).toBe(quote);
    // 100 coins is the typed limit: the driving side's maximum, exactly.
    expect(s.max.quote).toBe(100n * U6);
    expect(s.quoted.quote <= s.max.quote && s.quoted.quote > 0n).toBe(true);
    // 2 coins a token: about 50 tokens beside 100 coins.
    expect(Number(s.quoted.token) / Number(U6)).toBeCloseTo(49.5, 0);
    expect(s.unwrapsWsol).toBe(false);
    expect(s.wsolHeldBefore).toBe(0n);
    expect(s.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(s.price.state === 'agrees' && s.price.pool).toBeCloseTo(2, 9);

    // The coin's own account is watched, named as the coin, in the coin's decimals.
    expect(p.check.watch.tokenAccounts.map((t) => [t.role, t.decimals, t.account.toBase58()])).toEqual([
      ['token', 6, w.tokenAta.toBase58()],
      ['lp', 9, w.lpAta.toBase58()],
      ['quote', quote.decimals, w.quoteAta.toBase58()],
    ]);
    // At most the limit leaves the coin's account. No upper bound: more of the coin
    // arriving while Review builds must not block the deposit.
    expect(row(p, w.quoteAta)).toEqual([-(100n * U6), 2n ** 64n]);
    expect(row(p, w.tokenAta)).toEqual([-s.max.token, -1n]);
    expect(row(p, w.lpAta)).toEqual([s.lpAmount, 2n ** 64n]);
    // The only SOL that leaves is the new pool-share account's deposit: none goes into the pool.
    expect(p.check.expect.maxSolOut).toBe(BigInt(rent(165)));
  });

  it('with the pool-share account already there, no SOL leaves at all', async () => {
    const w = world(USDC_QUOTE, { heldLp: 7n });
    expect(prepared(await deposit(w)).check.expect.maxSolOut).toBe(0n);
  });

  it('typing the token side: the coin’s maximum is worked out from the pool, in the coin’s own units', async () => {
    const w = world(USDC_QUOTE);
    const s = prepared(await deposit(w, { driving: 'token', maxIn: 50n * U6 })).summary as LpDepositSummary;
    expect(s.max.token).toBe(50n * U6);
    // 2 USDC a token, plus the 1% allowed: about 100 USDC, never about 100 SOL's worth of lamports.
    expect(Number(s.max.quote) / Number(U6)).toBeGreaterThan(99);
    expect(Number(s.max.quote) / Number(U6)).toBeLessThan(102);
  });

  it.each(COINS)('%s: no account for the coin, or too little of it, is refused in the coin’s own words', async (_n, quote) => {
    const none = world(quote, { heldQuote: null });
    expect(refused(await deposit(none))).toBe(LP_COPY.noCoinAccount(quote.symbol, none.quoteAta.toBase58()));
    const short = world(quote, { heldQuote: 40n * U6 });
    const msg = refused(await deposit(short));
    expect(msg).toBe(LP_COPY.overBalance(`100 ${quote.symbol}`, `40 ${quote.symbol}`));
    // The rent band is SOL's rule: it is never said about another coin.
    expect(msg).not.toMatch(/too little SOL|SOL to stay open/);
  });

  it('the coin’s account belonging to another wallet is refused, naming its owner', async () => {
    const w = world(USDC_QUOTE, { quoteOwner: STRANGER });
    expect(refused(await deposit(w))).toBe(LP_COPY.foreignOwner(w.quoteAta.toBase58(), STRANGER.toBase58()));
  });

  it('BAYLA sits under Token-2022: CPI Guard on the signer’s BAYLA account stops the pool taking it', async () => {
    // Said of the BAYLA account, in BAYLA's name: the token's own words say "this token".
    expect(refused(await deposit(world(BAYLA_QUOTE, { cpiGuard: true })))).toBe(LP_COPY.cpiGuardCoin('BAYLA'));
  });

  it('a wallet with the coin but not the SOL for the fee and the new account is told how much SOL it needs', async () => {
    const need = LP_FEE_RESERVE + BigInt(rent(165)) + BigInt(rent(0));
    const w = world(USDC_QUOTE, { wallet: need - 1n });
    expect(refused(await deposit(w))).toMatch(/^Your wallet needs about .* SOL for the network fee and the account deposits, and has .* SOL\. Nothing was built\.$/);
    expect((await deposit(world(USDC_QUOTE, { wallet: need }))).ok).toBe(true);
  });

  // UNREAD IS STILL REFUSED (owner: "every unread state is still refused"). A read of the
  // coin's own price that FAILED builds nothing. The mutation "treat every coin that is
  // not ok as no-route" fails here: it would build this deposit.
  it.each(COINS)('%s: the coin’s own price could not be read, with a token price to compare: the deposit check is unchecked, so nothing is built', async (_n, quote) => {
    const w = world(quote);
    const msg = refused(await deposit(w, {}, priced(quote, { coin: { kind: 'unread', detail: 'HTTP 502' } })));
    expect(msg).toBe(`We did not build this deposit: We could not check its price against an outside price (the price of ${quote.symbol} could not be read (HTTP 502)).`);
    expect(msg).not.toMatch(/this token/);
  });

  // Owner ruling 2026-10-07: Jupiter ANSWERING that it has no route for the pool's coin
  // does not stop a deposit. It builds through the `allowed` verdict, and the warning,
  // naming the coin, is on the summary the review reads. Before, nothing was built.
  it.each(COINS)('%s: Jupiter ANSWERS "no route" for the coin: it builds, with a warning that names the coin and no price gap', async (_n, quote) => {
    const noRoute: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
    const built = prepared(await deposit(world(quote), {}, priced(quote, { coin: noRoute })));
    const s = built.summary as LpDepositSummary;
    expect(s.price).toEqual({ state: 'no-market', of: 'coin', pool: expect.closeTo(2, 9), detail: `Jupiter has no route for ${quote.symbol}` });
    expect(s.priceGap).toBeNull();
    expect(s.warnings).toEqual([
      `Jupiter has no price for ${quote.symbol} right now, so this pool’s price in ${quote.symbol} was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.`,
    ]);
    // The token HAS a price: Jupiter's own "this token" never reaches the review.
    expect(s.warnings.join(' ')).not.toMatch(/this token/);
    // The warning decides nothing: the same amounts as with the coin priced.
    const fair = prepared(await deposit(world(quote))).summary as LpDepositSummary;
    expect([s.lpAmount, s.max, s.quoted]).toEqual([fair.lpAmount, fair.max, fair.quoted]);
  });

  // With no route for the TOKEN nothing is compared, so the coin's own price is not needed.
  it.each([
    ['could not be read', { kind: 'unread', detail: 'HTTP 502' } as OutsidePrice],
    ['has no route', { kind: 'no-route', detail: 'no route' } as OutsidePrice],
    ['was read', ok(0.005)],
  ])('no route for the token, and the coin’s own price %s: it builds as "no market", with the warning', async (_n, coin) => {
    const w = world(USDC_QUOTE);
    const s = prepared(await deposit(w, {}, priced(USDC_QUOTE, { token: { kind: 'no-route', detail: 'Jupiter has no route for this token' }, coin }))).summary as LpDepositSummary;
    expect(s.price).toMatchObject({ state: 'no-market' });
    expect(s.priceGap).toBeNull();
    expect(s.warnings).toEqual([
      'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.',
    ]);
  });

  // With no route for the token AND a launch pool for it, there is something to compare
  // with: the launch pool's SOL price, said in the pool's own coin (review, 2026-10-04).
  describe('no route for the token, which has a launch pool', () => {
    const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
    /** The pool says 2 coins a token. The launch pool: `sol` SOL against 1,000 tokens, never traded. */
    function besideLaunch(quote: QuoteCoin, sol: bigint): World {
      const w = world(quote);
      addPool(w.chain, w.mint, { sol: sol * 10n ** 9n, tokens: TOKEN_RESERVE, launch: true });
      return w;
    }

    it.each(COINS)('%s: the launch pool’s SOL price is compared in the coin, and the gap and the loss are said in that coin', async (_n, quote) => {
      // The launch pool says 0.02 SOL a token. With the coin at 0.005 SOL that is 4 coins: the pool is 50% below.
      const s = prepared(await deposit(besideLaunch(quote, 20n), {}, priced(quote, { token: NO_ROUTE }))).summary as LpDepositSummary;
      expect(s.price).toMatchObject({ state: 'disagrees', against: 'launch-pool' });
      expect(s.price.state === 'disagrees' && s.price.reference).toBeCloseTo(4, 9);
      expect(s.priceGap!.diff).toBeCloseTo(-0.5, 9);
      expect(s.warnings).toHaveLength(2);
      expect(s.warnings[0]).toBe('Its price is 50.0% below the launch pool’s price. A deposit here would hand that gap to the first arbitrage trade.');
      expect(s.warnings[1]).toMatch(new RegExp(`^At these amounts, a move back to the launch pool’s price would take up to about 1[67]\\.\\d+ ${quote.symbol} of what you put in\\. That is an estimate\\.$`));
      expect(s.warnings.join(' ')).not.toMatch(/\bSOL\b/);
    });

    it('at the launch pool’s price in the coin it agrees, with nothing to warn of', async () => {
      // 0.01 SOL a token is 2 USDC a token: what the pool says.
      const s = prepared(await deposit(besideLaunch(USDC_QUOTE, 10n), {}, priced(USDC_QUOTE, { token: NO_ROUTE }))).summary as LpDepositSummary;
      expect(s.price).toMatchObject({ state: 'agrees', against: 'launch-pool' });
      expect(s.warnings).toEqual([]);
      expect(s.priceGap).toBeNull();
    });

    it('the coin’s own price could not be read: the comparison could not be made, so nothing is built', async () => {
      const msg = refused(await deposit(besideLaunch(USDC_QUOTE, 20n), {}, priced(USDC_QUOTE, { token: NO_ROUTE, coin: { kind: 'unread', detail: 'HTTP 502' } })));
      expect(msg).toBe('We did not build this deposit: We could not check its price against the launch pool’s price (the price of USDC could not be read (HTTP 502)).');
    });
  });

  it.each(COINS)('%s: a pool more than 3%% off the market in the COIN builds, and the gap and the estimated loss are said in that coin, never in SOL', async (_n, quote) => {
    const w = world(quote);
    // The pool says 2 coins a token. With the coin at 0.005 SOL the market says 4: 50% off.
    const s = prepared(await deposit(w, {}, priced(quote, { token: ok(0.02) }))).summary as LpDepositSummary;
    expect(s.price).toMatchObject({ state: 'disagrees', against: 'outside' });
    expect(s.price.state === 'disagrees' && s.price.reference).toBeCloseTo(4, 9);
    expect(s.priceGap!.diff).toBeCloseTo(-0.5, 9);
    // About 99 coins and 49.5 tokens go in. At 4 coins a token: (√99 − √198)² is about 17 coins.
    const loss = Number(s.priceGap!.lossQuote) / 1e6;
    expect(loss).toBeGreaterThan(16.5);
    expect(loss).toBeLessThan(17.5);
    expect(s.warnings).toHaveLength(2);
    expect(s.warnings[0]).toBe('Its price is 50.0% below the outside price. A deposit here would hand that gap to the first arbitrage trade.');
    expect(s.warnings[1]).toMatch(new RegExp(`^At these amounts, a move back to the outside price would take up to about 1[67]\\.\\d+ ${quote.symbol} of what you put in\\. That is an estimate\\.$`));
    expect(s.warnings.join(' ')).not.toMatch(/\bSOL\b/);
  });

  it('the units cannot be mixed up: the same pool read as "2 SOL a token" against a 2 SOL market has no gap at all', async () => {
    const w = world(USDC_QUOTE);
    const s = prepared(await deposit(w, {}, priced(USDC_QUOTE, { token: ok(2), coin: ok(1) }))).summary as LpDepositSummary;
    expect(s.price.state).toBe('agrees');
    expect(s.priceGap).toBeNull();
    expect(s.warnings).toEqual([]);
  });

  it('a coin that is not on the list is refused before anything is read', async () => {
    const w = world(USDC_QUOTE);
    const before = w.chain.calls.length;
    expect(refused(await deposit(w, { quoteMint: Keypair.generate().publicKey }))).toBe(LP_COPY.notAPairingCoin);
    expect(w.chain.calls.length).toBe(before);
  });
});

// ── withdraw ─────────────────────────────────────────────────────────────────

describe('prepareLpWithdraw: a pool paired with USDC or BAYLA', () => {
  const holding = (quote: QuoteCoin, o: Parameters<typeof world>[1] = {}) => world(quote, { heldLp: LP_SUPPLY / 10n, ...o });

  it.each(COINS)('%s: both payout accounts are opened under their own programs, the coin arrives in its own account, and SOL is never unwrapped', async (_n, quote) => {
    const w = holding(quote);
    const p = prepared(await withdraw(w));
    expect(kinds(p)).toEqual(['create-token-account', 'create-token-account', 'pool-withdraw']);
    const [openToken, openCoin] = bodySteps(p.steps) as Array<Extract<IntentStep, { kind: 'create-token-account' }>>;
    expect(openToken!.address.equals(w.tokenAta)).toBe(true);
    expect(openCoin!.address.equals(w.quoteAta)).toBe(true);
    expect(openCoin!.mint.toBase58()).toBe(quote.mint);

    const s = p.summary as LpWithdrawSummary;
    expect(s.quote).toBe(quote);
    // Half of a tenth of the pool: 100 coins and 50 tokens.
    expect([s.quoted.quote, s.quoted.token]).toEqual([100n * U6, 50n * U6]);
    expect([s.min.quote, s.min.token]).toEqual([99n * U6, 49_500_000n]);
    // The account exists: it is named, and nothing is paid to open it.
    expect(s.quoteAccount).toEqual({ address: w.quoteAta, rent: 0n });
    expect(s.unwrapsWsol).toBe(false);

    expect(p.check.watch.tokenAccounts.map((t) => [t.role, t.decimals])).toEqual([['lp', 9], ['token', 6], ['quote', quote.decimals]]);
    // At least the minimum of the coin arrives; no upper bound (a gift to the pool must not block leaving).
    expect(row(p, w.quoteAta)).toEqual([s.min.quote, 2n ** 64n]);
    expect(row(p, w.tokenAta)).toEqual([s.min.token, 2n ** 64n]);
    expect(row(p, w.lpAta)).toEqual([-s.lpAmount, 2n ** 64n]);
    // Both accounts exist: no SOL leaves, and none is promised back (nothing is unwrapped).
    expect(p.check.expect.maxSolOut).toBe(0n);
    expect(p.check.expect.minSolIn).toBeUndefined();
  });

  it.each(COINS)('%s: a wallet with no account for the coin has one opened, at that coin’s own size, and is told what it costs', async (_n, quote) => {
    const w = holding(quote, { heldQuote: null });
    const p = prepared(await withdraw(w));
    const s = p.summary as LpWithdrawSummary;
    const deposit165or170 = BigInt(rent(accountSize(quote)));
    expect(s.quoteAccount).toEqual({ address: w.quoteAta, rent: deposit165or170 });
    expect(p.check.expect.maxSolOut).toBe(deposit165or170);
    expect(row(p, w.quoteAta)).toEqual([s.min.quote, 2n ** 64n]);
  });

  it('the leave rule holds for these pools too: no price is read and no price can refuse', async () => {
    const w = holding(USDC_QUOTE);
    // prepareLpWithdraw takes no price reader at all; a pool far off any market still pays out.
    expect((await withdraw(w)).ok).toBe(true);
  });

  it('the coin’s account belonging to another wallet is refused: the payout would not be yours', async () => {
    const w = holding(USDC_QUOTE, { quoteOwner: STRANGER });
    expect(refused(await withdraw(w))).toBe(LP_COPY.foreignOwner(w.quoteAta.toBase58(), STRANGER.toBase58()));
  });

  it('a coin that is not on the list cannot be built for, and the message says the shares are safe', async () => {
    const w = holding(USDC_QUOTE);
    const msg = refused(await withdraw(w, { quoteMint: Keypair.generate().publicKey }));
    expect(msg).toMatch(/This site cannot build a withdrawal for this token yet \(its pool is not paired with SOL, USDC or BAYLA\)/);
    expect(msg).toMatch(/Your pool shares stay in your wallet\./);
  });
});

// ── the decoded steps must be the plan ───────────────────────────────────────

describe('the step rules for a pool not paired with SOL', () => {
  const pool = Keypair.generate().publicKey;
  const lpAta = Keypair.generate().publicKey;
  const tokenAta = Keypair.generate().publicKey;
  const quoteAta = Keypair.generate().publicKey;
  const open = (address: PublicKey): IntentStep => ({ kind: 'create-token-account', owner: ME, mint: Keypair.generate().publicKey, address });
  const dep: IntentStep = { kind: 'pool-deposit', pool, lpAmount: 5n, max0: 6n, max1: 7n };
  const wd: IntentStep = { kind: 'pool-withdraw', pool, lpAccount: lpAta, lpAmount: 5n, min0: 6n, min1: 7n };
  const wantDep = { pool, lp: 5n, max0: 6n, max1: 7n, lpAta, quoteNative: false as const };
  const wantWd = { pool, lpAccount: lpAta, lp: 5n, min0: 6n, min1: 7n, tokenAta, quoteAta, quoteNative: false as const };

  it('a deposit: exactly the pool-share account and the deposit; any wrap, sync or close is a mismatch', () => {
    expect(depositStepsProblem([open(lpAta), dep], wantDep)).toBeNull();
    for (const extra of [{ kind: 'wrap-sol', lamports: 1n }, { kind: 'sync-wsol' }, { kind: 'close-wsol' }] as IntentStep[]) {
      expect(depositStepsProblem([open(lpAta), extra, dep], wantDep), extra.kind).toBe('The transaction wraps or unwraps SOL, and this pool is not paired with SOL.');
    }
    expect(depositStepsProblem([dep], wantDep)).toBe('The transaction does not open exactly your pool-share account.');
    expect(depositStepsProblem([open(lpAta), open(quoteAta), dep], wantDep)).toBe('The transaction does not open exactly your pool-share account.');
    expect(depositStepsProblem([open(quoteAta), dep], wantDep)).toBe('The transaction does not open exactly your pool-share account.');
  });

  it('a withdrawal: exactly the two payout accounts and the withdrawal; a close of wrapped SOL is a mismatch', () => {
    expect(withdrawStepsProblem([open(tokenAta), open(quoteAta), wd], wantWd)).toBeNull();
    expect(withdrawStepsProblem([open(tokenAta), open(quoteAta), wd, { kind: 'close-wsol' }], wantWd)).toBe('The transaction unwraps SOL, and this pool is not paired with SOL.');
    expect(withdrawStepsProblem([open(tokenAta), wd], wantWd)).toBe('The transaction does not open exactly your two payout accounts.');
    expect(withdrawStepsProblem([open(tokenAta), open(lpAta), wd], wantWd)).toBe('The transaction does not open exactly your two payout accounts.');
  });
});

// ── the transaction checker ──────────────────────────────────────────────────

describe('decodeIntent: a liquidity transaction for a pool paired with USDC or BAYLA', () => {
  async function pinned(quote: QuoteCoin): Promise<{ w: World; pins: PoolPins; ctx: (kind: PoolIntent['kind']) => PoolIntent }> {
    const w = world(quote, { heldLp: 1_000n });
    const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote, owner: ME })) as WriteSnapshot;
    const pins = poolPins(cfgLocal, snap.view, { tokenMint: w.mint, lpAccount: w.lpAta }) as PoolPins;
    expect(typeof pins).toBe('object');
    return { w, pins, ctx: (kind) => ({ kind, signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins }) };
  }
  const mine = (m: PublicKey, program: PublicKey) => associatedTokenAddress(m, ME, program);
  const poolIx = (kind: 'deposit' | 'withdraw', p: PoolPins): TransactionInstruction => {
    const common = {
      programId: CPSWAP, owner: ME, poolState: p.address, ownerLpToken: p.lpAccount,
      token0Account: mine(p.token0Mint, p.token0Program), token1Account: mine(p.token1Mint, p.token1Program),
      token0Vault: p.vault0, token1Vault: p.vault1, vault0Mint: p.token0Mint, vault1Mint: p.token1Mint, lpMint: p.lpMint, lpTokenAmount: 10n,
    };
    return kind === 'deposit' ? depositIx({ ...common, maximumToken0Amount: 5n, maximumToken1Amount: 7n }) : withdrawIx({ ...common, minimumToken0Amount: 5n, minimumToken1Amount: 7n });
  };
  const openAta = (m: PublicKey, program: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(ME, mine(m, program), ME, m, program);
  const reasonOf = (r: ReturnType<typeof decodeIntent>) => (r.ok ? 'accepted' : r.reason);

  it.each(COINS)('%s: the coin’s account may be opened, under the coin’s own program and nowhere else', async (_n, quote) => {
    const { pins, ctx } = await pinned(quote);
    const quoteMint = new PublicKey(quote.mint);
    const right = programOf(quote);
    const wrong = right.equals(TOKEN_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    expect(reasonOf(decodeIntent([openAta(pins.tokenMint, pins.tokenProgram), openAta(quoteMint, right), poolIx('withdraw', pins)], ctx('lp-withdraw')))).toBe('accepted');
    expect(reasonOf(decodeIntent([openAta(quoteMint, wrong), poolIx('withdraw', pins)], ctx('lp-withdraw')))).toMatch(/creates a token account under the wrong programs/);
  });

  it('a pool not paired with SOL may not open, fund, sync or close a wrapped-SOL account', async () => {
    const { pins, ctx } = await pinned(USDC_QUOTE);
    const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
    const pool = poolIx('deposit', pins);
    expect(reasonOf(decodeIntent([openAta(WSOL_MINT, TOKEN_PROGRAM_ID), pool], ctx('lp-deposit')))).toMatch(/creates a token account for an unrelated token/);
    expect(reasonOf(decodeIntent([SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsolAta, lamports: 5 }), pool], ctx('lp-deposit')))).toMatch(/it wraps SOL, and this pool is not paired with SOL/);
    expect(reasonOf(decodeIntent([createSyncNativeInstruction(wsolAta), pool], ctx('lp-deposit')))).toMatch(/it wraps SOL, and this pool is not paired with SOL/);
  });

  it('the pins cannot name a coin of their own: a coin off the list, or one moved to the other side, is refused', async () => {
    const { pins, ctx } = await pinned(USDC_QUOTE);
    const pool = poolIx('deposit', pins);
    const with_ = (over: Partial<PoolPins>): PoolIntent => ({ ...ctx('lp-deposit'), pins: { ...pins, ...over } });
    expect(reasonOf(decodeIntent([pool], with_({ quote: { ...USDC_QUOTE, mint: Keypair.generate().publicKey.toBase58() } })))).toMatch(/paired with a coin this site does not build for/);
    // USDC's mint with the "wrap it like SOL" flag, or another program, is not the row on the list.
    expect(reasonOf(decodeIntent([pool], with_({ quote: { ...USDC_QUOTE, native: true } })))).toMatch(/paired with a coin this site does not build for/);
    expect(reasonOf(decodeIntent([pool], with_({ quote: { ...USDC_QUOTE, program: TOKEN_2022_PROGRAM_ID.toBase58() } })))).toMatch(/paired with a coin this site does not build for/);
    // A real coin, but not the one on the pool's coin side.
    expect(reasonOf(decodeIntent([pool], with_({ quote: BAYLA_QUOTE })))).toMatch(/pairing coin is not where the review says it is/);
    expect(reasonOf(decodeIntent([pool], with_({ quoteIsToken0: !pins.quoteIsToken0 })))).toMatch(/pairing coin is not where the review says it is/);
    expect(reasonOf(decodeIntent([pool], ctx('lp-deposit')))).toBe('accepted');
  });
});

// The read says only that A vault is frozen, not which. On a pool paired with a coin whose
// issuer can freeze (USDC), the Remove builder must not blame the token alone; on a BAYLA
// pool (nobody can freeze BAYLA) the frozen vault can only be the token's (phone walk, 2026-10-03).
describe('a frozen vault on a pool paired with a coin: who is said to have frozen it', () => {
  it('USDC: the token’s issuer or USDC’s. BAYLA: the token’s issuer, as on a SOL pool', async () => {
    const usdc = world(USDC_QUOTE, { heldLp: LP_SUPPLY / 10n, frozenTokenVault: true });
    expect(refused(await withdraw(usdc))).toBe(
      "The token's issuer, or USDC's, has frozen one of this pool's vaults, so nothing can move in or out, for anyone. That is the issuer's doing, not the pool program's.",
    );
    const bayla = world(BAYLA_QUOTE, { heldLp: LP_SUPPLY / 10n, frozenTokenVault: true });
    expect(refused(await withdraw(bayla))).toBe(
      "The token's issuer has frozen one of this pool's vaults, so nothing can move in or out, for anyone. That is the issuer's doing, not the pool program's.",
    );
  });
});

/** The wallet's own account for the coin, as the chain holds it, with `o` on top (an approved spender, frozen, ...). */
function setCoinAccount(w: World, o: Parameters<FakeChain['token2022Account']>[4], amount = 50_000n * U6): void {
  const mint = new PublicKey(w.quote.mint);
  if (w.quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) w.chain.token2022Account(w.quoteAta, mint, ME, amount, o);
  else w.chain.tokenAccount(w.quoteAta, mint, ME, amount, o);
}

// Whole-change review 2026-10-04 (checker-1). The balances are read a slot or more before
// the test run, and anyone can send a coin to the wallet in between. The deposit's row for
// the coin's account said it must FALL by at least one unit, so a payment arriving while
// Review was building blocked an honest deposit. The opening's row for the same account has
// no upper bound for exactly this. What protects the signer is the other end of the row:
// no more than the limit may leave, and that is not loosened.
describe('the coin’s account in a deposit: more arriving does not block it; more leaving than the limit still does', () => {
  const BLOCKED = { status: 'not-sent', stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' };
  const outcome = (r: Awaited<ReturnType<typeof deposit>>) => (r.ok ? 'prepared' : r.outcome);
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;

  it.each(COINS)('%s: 1,000 coins sent to the wallet between the balance read and the test run: the deposit still prepares', async (_n, quote) => {
    const w = world(quote);
    beforeBalanceRun(w.chain, () => setCoinAccount(w, {}, 51_000n * U6));
    const p = prepared(await deposit(w));
    const s = p.summary as LpDepositSummary;
    // The account ends 1,000 coins up, less what the deposit took: a rise, not a fall.
    expect(moved(p, w.quoteAta)).toBe(1_000n * U6 - s.quoted.quote);
    expect(moved(p, w.quoteAta) > 0n).toBe(true);
    // At most the limit leaves; no upper bound, as on the opening's row for this account.
    expect(row(p, w.quoteAta)).toEqual([-s.max.quote, 2n ** 64n]);
  });

  it.each(COINS)('%s: exactly the limit leaving passes; one unit more than the limit is still blocked', async (_n, quote) => {
    const clean = prepared(await deposit(world(quote))).summary as LpDepositSummary;
    const room = clean.max.quote - clean.quoted.quote;
    expect(room > 0n).toBe(true);
    const atLimit = world(quote);
    skewTestRun(atLimit.chain, atLimit.quoteAta, -room);
    expect(outcome(await deposit(atLimit))).toBe('prepared');
    const over = world(quote);
    skewTestRun(over.chain, over.quoteAta, -room - 1n);
    expect(outcome(await deposit(over))).toMatchObject(BLOCKED);
  });
});

// Whole-change review 2026-10-04 (L4). A withdrawal is refused when the account it pays
// into has an approved spender: what arrives would not be only the visitor's. A deposit
// SPENDS from that same account, and built with no word about it. So a wallet was let in
// in silence and then refused on the way out. The exit rule stays; the way in now says it.
// (A card or payment app's standing approval on a USDC account is the ordinary case.)
describe('an approved spender on the visitor’s own account: said on the way in, refused on the way out', () => {
  const approved = { delegate: STRANGER, delegatedAmount: 25n * U6 };

  it.each(COINS)('%s: a deposit builds, and its review says who is approved, for how much, and what this site will not do until it is revoked', async (_n, quote) => {
    const w = world(quote, { heldLp: LP_SUPPLY / 10n });
    setCoinAccount(w, approved);
    const s = prepared(await deposit(w)).summary as LpDepositSummary;
    expect(s.notices).toEqual([
      `An approved spender (${STRANGER.toBase58()}) can move up to 25 out of your ${quote.symbol} account (${w.quoteAta.toBase58()}). This site will not pay a withdrawal into that account until you revoke that approval.`,
    ]);
    expect(s.notices).toEqual([LP_COPY.delegatedSource(STRANGER.toBase58(), '25', quote.symbol, w.quoteAta.toBase58())]);
    // A notice is not a warning about the pool: nothing is added to the pool's own list.
    expect(s.warnings).toEqual([]);
    // The same wallet on the way out: refused, as it always was, naming the same spender and account.
    expect(refused(await withdraw(w))).toBe(LP_COPY.delegatedDestination(STRANGER.toBase58(), '25', quote.symbol, w.quoteAta.toBase58()));
  });

  it('the token’s account too: the same notice, naming it as the token account', async () => {
    const w = world(USDC_QUOTE, { heldLp: LP_SUPPLY / 10n });
    w.chain.tokenAccount(w.tokenAta, w.mint, ME, 10_000n * U6, approved);
    const s = prepared(await deposit(w)).summary as LpDepositSummary;
    expect(s.notices).toEqual([LP_COPY.delegatedSource(STRANGER.toBase58(), '25', 'token', w.tokenAta.toBase58())]);
    expect(refused(await withdraw(w))).toBe(LP_COPY.delegatedDestination(STRANGER.toBase58(), '25', 'token', w.tokenAta.toBase58()));
  });

  it('both accounts approved: both are said, the token’s first', async () => {
    const w = world(BAYLA_QUOTE);
    setCoinAccount(w, approved);
    w.chain.tokenAccount(w.tokenAta, w.mint, ME, 10_000n * U6, approved);
    expect((prepared(await deposit(w)).summary as LpDepositSummary).notices).toEqual([
      LP_COPY.delegatedSource(STRANGER.toBase58(), '25', 'token', w.tokenAta.toBase58()),
      LP_COPY.delegatedSource(STRANGER.toBase58(), '25', 'BAYLA', w.quoteAta.toBase58()),
    ]);
  });

  it('a spender with nothing left to move is not said, and does not refuse the way out either', async () => {
    const w = world(USDC_QUOTE, { heldLp: LP_SUPPLY / 10n });
    setCoinAccount(w, { delegate: STRANGER, delegatedAmount: 0n });
    expect((prepared(await deposit(w)).summary as LpDepositSummary).notices).toEqual([]);
    expect((await withdraw(w)).ok).toBe(true);
  });
});

// Whole-change review 2026-10-04 (W6). The account rules were written for the token's
// account, and said "this token" and "the token's issuer" of the visitor's own account for
// the pairing coin as well. A USDC account is frozen by USDC's issuer, not the token's.
describe('a refusal about the visitor’s own account for the coin names the coin, never "this token"', () => {
  it('BAYLA (under Token-2022) with CPI Guard on: a deposit is refused in BAYLA’s name', async () => {
    const msg = refused(await deposit(world(BAYLA_QUOTE, { cpiGuard: true })));
    expect(msg).toBe('Your BAYLA account has CPI Guard switched on, which stops a pool taking BAYLA from it. Switch it off in your wallet, then try again.');
    expect(msg).not.toMatch(/this token/);
  });

  it('BAYLA with required memos: a withdrawal is refused in BAYLA’s name', async () => {
    const w = world(BAYLA_QUOTE, { heldLp: LP_SUPPLY / 10n });
    setCoinAccount(w, { memoRequired: true });
    const msg = refused(await withdraw(w));
    expect(msg).toBe('Your BAYLA account only accepts transfers that carry a memo, and the pool cannot add one. Switch off required memos in your wallet, then try again.');
    expect(msg).not.toMatch(/this token/);
  });

  it('a frozen USDC account is frozen by ITS issuer: on the way in and on the way out', async () => {
    const w = world(USDC_QUOTE, { heldLp: LP_SUPPLY / 10n });
    setCoinAccount(w, { state: 2 });
    expect(refused(await deposit(w))).toBe('Your USDC account is frozen by its issuer, so nothing can move out of it.');
    expect(refused(await withdraw(w))).toBe('Your USDC account is frozen by its issuer, so nothing can be paid into it.');
  });

  it('the token’s own account keeps its words: "this token", and "the token’s issuer"', async () => {
    const frozen = world(USDC_QUOTE);
    frozen.chain.tokenAccount(frozen.tokenAta, frozen.mint, ME, 10_000n * U6, { state: 2 });
    expect(refused(await deposit(frozen))).toBe("Your token account is frozen by the token's issuer, so nothing can move out of it.");
    expect(LP_COPY.cpiGuard).toBe('Your account for this token has CPI Guard switched on, which stops a pool taking tokens from it. Switch it off in your wallet, then try again.');
    expect(LP_COPY.memosRequired).toBe(
      'Your account for this token only accepts transfers that carry a memo, and the pool cannot add one. Switch off required memos in your wallet, then try again.',
    );
  });
});
