// @vitest-environment node
//
// A swap through one of our own pools from the main swap page (SPEC_S3 3.3, T-B-01..16),
// against a fake chain whose simulator runs the transaction instruction by instruction:
// the wrap, the sync (with mainnet's re-price of a stale reserve), the site fee, the pool
// program's own swap maths on the pool's own fee tier, and the close.
//
// No address is typed here: the fee account is the derived constant, the tiers are
// derived, and every wallet and mint is a fresh key.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol } from '../curve/format';
import { USDC_MINT } from '../../../solana';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, deriveAmmConfig, sortMints } from '../../../solana/cpswap/program';
import { spendableSol } from '../../../solana/lp/liquidityMath';
import { observationBytes } from '../../../solana/lp/testkit.fixture';
import { routeQuote, type RouteQuote } from '../../../solana/swap/ownRoute';
import { siteFee } from '../../../solana/swap/siteFee';
import { SITE_FEE_WSOL_ACCOUNT } from '../../../solana/swap/siteFeeAccount';
import { decodeIntent } from './intent';
import { LP_COPY, LP_FEE_RESERVE, SWAP_CONFIG_UNREAD, SWAP_TIER_NOT_ROUTED, readPoolForWrite, type WriteSnapshot } from './liquidity';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from './metaplex';
import { TX_SIZE_LIMIT, bodySteps } from './prepare';
import { ROUTE_COPY, prepareRouteSwap, routeSwapStepsProblem, type RouteSwapArgs } from './routeSwap';
import {
  AMM_CONFIG,
  CPSWAP,
  EXT,
  FakeChain,
  VAULT,
  addPool,
  cfgLocal,
  encodeAmmConfig,
  encodeTokenAccountWith,
  rent,
  routeSwapSimulator,
  setClock,
  type PoolFixture,
  type RouteSwapSimOptions,
} from './testkit.fixture';
import type { IntentStep, LpOpenGate, PreparedTx, Prepared, RouteSwapSummary, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const WITHDRAW_ONLY: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' };
/** What a page build that may route passes implicitly: the switch on, and the env fee agreeing. */
const ON = { routeMode: 'on' as const, feeEnv: { account: VAULT.toBase58(), bps: 50 } };
const TIER0 = deriveAmmConfig(CPSWAP, 0);
const TIER1 = deriveAmmConfig(CPSWAP, 1);
const TIER2 = deriveAmmConfig(CPSWAP, 2);
const U64_SPAN = 2n ** 64n;
// The spec's worked pool: 85 SOL against 200,000,000 tokens of 6 decimals.
const SOL_RESERVE = 85n * 10n ** 9n;
const TOKEN_RESERVE = 200_000_000n * 10n ** 6n;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
const RENT165 = BigInt(rent(165));
const BUY = 1_000_000_000n;
const SELL = 2_000_000n * 10n ** 6n;
const SLIP = 50n;

/** A token mint that sorts on the wanted side of wrapped SOL, so both pool layouts are exercised. */
function mintWith(solIsToken0: boolean): PublicKey {
  for (let i = 0; i < 20_000; i++) {
    const m = fresh();
    if (sortMints(WSOL_MINT, m).token0.equals(WSOL_MINT) === solIsToken0) return m;
  }
  throw new Error('no mint found on that side of wrapped SOL');
}

interface World {
  chain: FakeChain;
  mint: PublicKey;
  pool: PoolFixture;
  tokenProgram: PublicKey;
  tokenAta: PublicKey;
  wsolAta: PublicKey;
}

interface WorldOptions {
  tokenProgram?: PublicKey;
  mintExtensions?: Array<[number, number]>;
  mintDecimals?: number;
  freezeAuthority?: PublicKey;
  solIsToken0?: boolean;
  tier?: 0 | 1;
  ammConfig?: PublicKey;
  launch?: boolean;
  /** The pool's own creator-fee switch, on as the launch program opens a pool (default off). */
  enableCreatorFee?: boolean;
  status?: number;
  openTime?: bigint;
  frozenTokenVault?: boolean;
  wallet?: bigint;
  /** null = no token account. */
  heldTokens?: bigint | null;
  tokenAccount?: Parameters<FakeChain['token2022Account']>[4];
  /** A wrapped-SOL account the wallet already has: its balance, stored reserve, and lamports no sync has counted yet. */
  wsol?: { amount: bigint; reserve?: bigint; unsynced?: bigint; closeAuthority?: PublicKey; delegate?: PublicKey; delegatedAmount?: bigint; owner?: PublicKey };
  /** false = no fee account on the chain. */
  feeReceiver?: Parameters<FakeChain['addFeeReceiver']>[0] | false;
  sim?: RouteSwapSimOptions;
  /** The token itself (default: a fresh key). */
  mint?: PublicKey;
  /** What the pool's token vault holds (default TOKEN_RESERVE), and the shares it records (default: the fixture's). */
  tokens?: bigint;
  lpSupply?: bigint;
}

/** floor(sqrt(n)): the shares the pool program records when it opens a pool with these two sides. */
function isqrt(n: bigint): bigint {
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
/** The shares of a pool opened with the spec's worked reserves and not traded since. */
const OPENING_SHARES = isqrt(SOL_RESERVE * TOKEN_RESERVE);

function world(o: WorldOptions = {}): World {
  const chain = FakeChain.healthy();
  chain.addTier1();
  if (o.feeReceiver !== false) chain.addFeeReceiver(o.feeReceiver ?? {});
  chain.simulate = routeSwapSimulator(o.sim);
  const mint = o.mint ?? (o.solIsToken0 === undefined ? fresh() : mintWith(o.solIsToken0));
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const mintOpts = { decimals: o.mintDecimals ?? 6, freezeAuthority: o.freezeAuthority };
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, o.mintExtensions ?? METADATA_ONLY, mintOpts);
  else chain.mint(mint, mintOpts);
  const pool = addPool(chain, mint, {
    sol: SOL_RESERVE,
    tokens: o.tokens ?? TOKEN_RESERVE,
    lpSupply: o.lpSupply,
    status: o.status,
    openTime: o.openTime,
    launch: o.launch,
    enableCreatorFee: o.enableCreatorFee,
    tokenProgram,
    tokenDecimals: o.mintDecimals ?? 6,
    frozenTokenVault: o.frozenTokenVault,
    ammConfig: o.ammConfig ?? (o.tier === 1 ? TIER1 : undefined),
  });
  setClock(chain, NOW);
  chain.fund(ME, Number(o.wallet ?? 20n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  const held = o.heldTokens === undefined ? 10_000_000n * 10n ** 6n : o.heldTokens;
  if (held !== null) {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, ME, held, o.tokenAccount);
    else chain.tokenAccount(tokenAta, mint, ME, held, o.tokenAccount);
  }
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  if (o.wsol) {
    chain.tokenAccount(wsolAta, WSOL_MINT, o.wsol.owner ?? ME, o.wsol.amount, {
      native: { reserve: o.wsol.reserve ?? RENT165, unsynced: o.wsol.unsynced },
      closeAuthority: o.wsol.closeAuthority,
      delegate: o.wsol.delegate,
      delegatedAmount: o.wsol.delegatedAmount,
    });
  }
  return { chain, mint, pool, tokenProgram, tokenAta, wsolAta };
}

/** What this pool pays for the trade right now, by the site's own rule on the builder's own read. */
async function ours(w: World, side: 'buy' | 'sell', amountIn: bigint, slippageBps = SLIP): Promise<RouteQuote> {
  const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, owner: ME, forSwap: true })) as WriteSnapshot;
  if (typeof snap === 'string') throw new Error(snap);
  const q = routeQuote(snap.view, side, amountIn, slippageBps, NOW);
  if (!q) throw new Error('no quote');
  return q;
}

type Over = Partial<RouteSwapArgs>;

/** Prepare with Jupiter one unit below ours and the page having shown ours, unless `over` says otherwise. */
async function run(w: World, side: 'buy' | 'sell', over: Over = {}, o: Parameters<typeof prepareRouteSwap>[3] | 'as-a-page-calls-it' = ON, gate: LpOpenGate = OPEN): Promise<Prepared> {
  const amountIn = over.amountIn ?? (side === 'buy' ? BUY : SELL);
  // No quote (a pool the rule excludes, an amount too small): the case under test sets its own numbers.
  const q: RouteQuote | null = await ours(w, side, amountIn, over.slippageBps ?? SLIP).catch(() => null);
  w.chain.calls = [];
  w.chain.simulateCalls = [];
  return prepareRouteSwap(
    W(w.chain),
    gate,
    {
      owner: ME,
      pool: w.pool.address,
      tokenMint: w.mint,
      tokenDecimals: 6,
      side,
      amountIn,
      slippageBps: SLIP,
      jupiterNet: q ? q.netExpected - 1n : 1n,
      // The page proved at Review that Jupiter's own trade carries the fee, unless the case says otherwise.
      jupiterFee: 'charged',
      shownNet: q ? q.netExpected : 1n,
      ...over,
    },
    o === 'as-a-page-calls-it' ? undefined : o,
  );
}

function ok(r: Prepared): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}

/** Refused before anything was simulated: no fee-less or half-checked fallback exists. */
function refused(w: World, r: Prepared): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  expect(w.chain.simulateCalls).toHaveLength(0);
  return r.outcome.message;
}

const summaryOf = (p: PreparedTx) => p.summary as RouteSwapSummary;
const kinds = (p: PreparedTx) => bodySteps(p.steps).map((s) => s.kind);
const delta = (p: PreparedTx, account: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(account))!.delta;
const row = (p: PreparedTx, account: PublicKey) => p.check.expect.tokens.find((t) => t.account.equals(account))!;

// ── T-B-01 ───────────────────────────────────────────────────────────────────

describe('T-B-01: an honest swap prepares, and the review is the transaction’s own bytes', () => {
  const LAYOUTS: Array<[string, WorldOptions]> = [
    ['a classic token on tier 0, SOL as token 0', { solIsToken0: true }],
    ['a classic token on tier 1, SOL as token 1', { solIsToken0: false, tier: 1 }],
    ['a Token-2022 token (name and picture only) on tier 0', { tokenProgram: TOKEN_2022_PROGRAM_ID, solIsToken0: false }],
    ['a Token-2022 token on tier 1', { tokenProgram: TOKEN_2022_PROGRAM_ID, solIsToken0: true, tier: 1 }],
  ];

  it.each(LAYOUTS)('a buy from a wallet with no wrapped-SOL and no token account: %s', async (_n, opts) => {
    const w = world({ ...opts, heldTokens: null });
    const q = await ours(w, 'buy', BUY);
    const p = ok(await run(w, 'buy'));
    expect(p.kind).toBe('lp-swap');
    // SPEC_S3 3.3 step 12, in order.
    expect(kinds(p)).toEqual(['create-token-account', 'wrap-sol', 'sync-wsol', 'site-fee', 'create-token-account', 'pool-swap', 'close-wsol']);
    const s = summaryOf(p);
    const fee = siteFee(BUY);
    expect(fee).toBe(5_000_000n);
    expect(s).toMatchObject({
      kind: 'lp-swap',
      side: 'buy',
      tier: opts.tier ?? 0,
      amountIn: BUY,
      swap: { amountIn: BUY - fee, minimumAmountOut: q.minOut },
      netExpected: q.quoteOut,
      netGuaranteed: q.minOut,
      versus: q.netExpected - 1n,
      priceCheck: null,
      unwrapsWsol: true,
      wsolHeldBefore: 0n,
      tokenDecimals: 6,
    });
    expect(s.fee.amount).toBe(fee);
    expect(s.fee.to.equals(SITE_FEE_WSOL_ACCOUNT)).toBe(true);
    expect(s.pool.equals(w.pool.address)).toBe(true);
    expect(s.config.address).toBe((opts.tier === 1 ? TIER1 : TIER0).toBase58());
    // The pool's own maths is the fill, to the unit; the fee account gains exactly the fee.
    expect(delta(p, w.tokenAta)).toBe(q.quoteOut);
    expect(delta(p, SITE_FEE_WSOL_ACCOUNT)).toBe(fee);
    expect(delta(p, w.wsolAta)).toBe(0n);
    const tokenRent = BigInt(rent(w.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165));
    expect(p.simulated.signerLamportsDelta).toBe(-(BUY + tokenRent));
    expect(p.fees.newAccountRentLamports).toBe(tokenRent);
    // The rows (3.6): the trader's are exact or one-sided in the trader's favour; the fee account's is a lower bound.
    expect(p.check.expect.maxSolOut).toBe(BUY + tokenRent);
    expect(p.check.expect.minSolIn).toBeUndefined();
    expect(row(p, w.tokenAta)).toMatchObject({ minDelta: q.minOut, maxDelta: U64_SPAN });
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 0n, maxDelta: 0n });
    expect(row(p, SITE_FEE_WSOL_ACCOUNT)).toMatchObject({ minDelta: fee, maxDelta: U64_SPAN });
  });

  it.each(LAYOUTS)('a sell into a wallet with no wrapped-SOL account: %s', async (_n, opts) => {
    const w = world(opts);
    const q = await ours(w, 'sell', SELL);
    const p = ok(await run(w, 'sell'));
    expect(kinds(p)).toEqual(['create-token-account', 'pool-swap', 'site-fee', 'close-wsol']);
    const s = summaryOf(p);
    const fee = siteFee(q.minOut);
    expect(s).toMatchObject({
      side: 'sell',
      amountIn: SELL,
      swap: { amountIn: SELL, minimumAmountOut: q.minOut },
      netExpected: q.quoteOut - siteFee(q.quoteOut),
      netGuaranteed: q.minOut - fee,
      unwrapsWsol: true,
    });
    expect(s.fee.amount).toBe(fee);
    expect(delta(p, w.tokenAta)).toBe(-SELL);
    expect(delta(p, SITE_FEE_WSOL_ACCOUNT)).toBe(fee);
    // Everything the pool paid, less the fee, reaches the wallet as plain SOL.
    expect(p.simulated.signerLamportsDelta).toBe(q.quoteOut - fee);
    expect(p.check.expect).toMatchObject({ maxSolOut: 0n, minSolIn: q.minOut - fee });
    expect(row(p, w.tokenAta)).toMatchObject({ minDelta: -SELL, maxDelta: -SELL });
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 0n, maxDelta: 0n });
    expect(row(p, SITE_FEE_WSOL_ACCOUNT)).toMatchObject({ minDelta: fee, maxDelta: U64_SPAN });
  });

  it('a sell’s fee is floor(0.5%) of the MINIMUM the pool must pay, the one output amount the bytes carry', async () => {
    const w = world();
    const p = ok(await run(w, 'sell'));
    const s = summaryOf(p);
    // 2,000,000 tokens into 85 SOL / 200,000,000 tokens on tier 0 (0.25%): floor(1.995e12 x 85e9 / 2.01995e14).
    expect(s.quote.outAmount).toBe(839_500_977n);
    expect(s.swap.minimumAmountOut).toBe((839_500_977n * 9_950n) / 10_000n);
    expect(s.fee.amount).toBe((s.swap.minimumAmountOut * 50n) / 10_000n);
    expect(s.netGuaranteed).toBe(s.swap.minimumAmountOut - s.fee.amount);
    // It ranks on the fee Jupiter would take at the quote, so the small undercharge never wins a trade.
    expect(s.netExpected).toBe(839_500_977n - (839_500_977n * 50n) / 10_000n);
  });

  // The review's "traders pay" is the pool's own cost: the trade fee, plus the tier's creator
  // fee when the POOL's switch is on (#698). The switch comes from the same fresh read.
  it("carries the pool's own creator-fee switch into the summary, read fresh", async () => {
    const launch = world({ launch: true, enableCreatorFee: true, lpSupply: OPENING_SHARES });
    expect(summaryOf(ok(await run(launch, 'buy'))).enableCreatorFee).toBe(true);
    expect(summaryOf(ok(await run(world(), 'buy'))).enableCreatorFee).toBe(false);
  });

  it('a tie with Jupiter is ours; one unit below ours prepares too', async () => {
    const w = world();
    const q = await ours(w, 'buy', BUY);
    expect(summaryOf(ok(await run(w, 'buy', { jupiterNet: q.netExpected }))).versus).toBe(q.netExpected);
    expect(summaryOf(ok(await run(w, 'buy', { jupiterNet: q.netExpected - 1n }))).versus).toBe(q.netExpected - 1n);
  });

  it('the builder’s real body passes the checker, and one changed account does not (S4’s rules on S5’s bytes)', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const w = world();
      const p = ok(await run(w, side));
      const ixs = p.tx.instructions;
      expect(decodeIntent(ixs, p.check.intent).ok).toBe(true);
      const swapAt = ixs.findIndex((i) => i.programId.equals(CPSWAP));
      const feeAt = ixs.findIndex((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 12);
      const withKey = (at: number, slot: number, pubkey: PublicKey) =>
        ixs.map((ix, n) => (n === at ? new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((k, j) => (j === slot ? { ...k, pubkey } : k)) }) : ix));
      const outMint = side === 'buy' ? w.mint : WSOL_MINT;
      const paysStranger = decodeIntent(withKey(swapAt, 5, associatedTokenAddress(outMint, STRANGER)), p.check.intent);
      expect(paysStranger.ok).toBe(false);
      if (!paysStranger.ok) expect(paysStranger.reason).toMatch(/pays out to an account that is not yours/);
      const feeElsewhere = decodeIntent(withKey(feeAt, 2, associatedTokenAddress(WSOL_MINT, STRANGER)), p.check.intent);
      expect(feeElsewhere.ok).toBe(false);
      if (!feeElsewhere.ok) expect(feeElsewhere.reason).toMatch(/somewhere other than the site's fee account/);
    }
  });

  it('a fill between the minimum and the quote still prepares; below the minimum, the pool’s own refusal is said in the swap’s words', async () => {
    const w = world({ sim: { fillOut: (quoted) => quoted - 1n } });
    const q = await ours(w, 'buy', BUY);
    expect(delta(ok(await run(w, 'buy')), w.tokenAta)).toBe(q.quoteOut - 1n);
    const low = world({ sim: { fillOut: () => q.minOut - 1n } });
    const r = await run(low, 'buy');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'simulate', message: expect.stringMatching(/moved past your limit/) });
  });
});

// ── T-B-02 ───────────────────────────────────────────────────────────────────

describe('T-B-02: the pool’s fee settings come from the same read, or nothing is built', () => {
  it('a swap’s read is ONE call of 16 keys (13, both tiers, the fee account) and never reads the config a second time', async () => {
    const w = world({ tier: 1 });
    const asked: string[][] = [];
    const orig = w.chain.getMultipleAccountsInfo;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      asked.push(keys.map((k) => k.toBase58()));
      return orig(keys);
    };
    w.chain.calls = [];
    const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, owner: ME, forSwap: true })) as WriteSnapshot;
    expect(typeof snap).toBe('object');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(16);
    expect(asked[0]!.slice(13)).toEqual([TIER0, TIER1, SITE_FEE_WSOL_ACCOUNT].map((k) => k.toBase58()));
    expect(w.chain.calls.filter((c) => c === 'getAccountInfo')).toHaveLength(0);
    expect(w.chain.calls.filter((c) => c === 'getMinimumBalanceForRentExemption')).toHaveLength(3);
    expect(snap.swap?.tier).toBe(1);
    expect(snap.view.config?.address).toBe(TIER1.toBase58());
    expect(snap.view.config?.tradeFeeRate).toBe(10_000n);
    expect(snap.swap?.feeAccount?.address).toBe(SITE_FEE_WSOL_ACCOUNT.toBase58());
  });

  it('the config account gone, owned by another program, or not a fee tier: not built', async () => {
    const cases: Array<[string, (c: FakeChain) => void]> = [
      ['gone', (c) => void c.accounts.delete(AMM_CONFIG.toBase58())],
      ['another owner', (c) => void c.set(AMM_CONFIG, { lamports: rent(236), owner: STRANGER, data: encodeAmmConfig() })],
      ['not a tier', (c) => void c.set(AMM_CONFIG, { lamports: rent(236), owner: CPSWAP, data: new Uint8Array(236) })],
    ];
    for (const [name, breakIt] of cases) {
      const w = world();
      breakIt(w.chain);
      expect(await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, owner: ME, forSwap: true }), name).toBe(SWAP_CONFIG_UNREAD);
      expect(refused(w, await run(w, 'buy', { jupiterNet: 1n, shownNet: 1n })), name).toBe(ROUTE_COPY.configUnread);
    }
  });

  it('a pool on a tier this site does not route to (tier 2), though that tier exists and decodes: not built', async () => {
    const w = world({ ammConfig: TIER2 });
    w.chain.set(TIER2, { lamports: rent(236), owner: CPSWAP, data: encodeAmmConfig({ index: 2 }) });
    expect(await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, owner: ME, forSwap: true })).toBe(SWAP_TIER_NOT_ROUTED);
    expect(refused(w, await run(w, 'buy', { jupiterNet: 1n, shownNet: 1n }))).toBe(ROUTE_COPY.tierNotRouted);
  });

  it('a failed read is said as unread, never as a refusal of the pool', async () => {
    const w = world();
    w.chain.getMultipleAccountsInfo = async () => {
      throw new Error('503');
    };
    const r = await prepareRouteSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: w.mint, tokenDecimals: 6, side: 'buy', amountIn: BUY, slippageBps: SLIP, jupiterNet: 1n, jupiterFee: 'charged', shownNet: 1n }, ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome.message).toBe(ROUTE_COPY.poolUnread);
  });
});

// ── T-B-03 ───────────────────────────────────────────────────────────────────

describe('T-B-03: the fee account is the vault’s own, or nothing is built (never a swap without its fee)', () => {
  const feeAt = (c: FakeChain, data: Uint8Array, owner: PublicKey = TOKEN_PROGRAM_ID) => c.set(SITE_FEE_WSOL_ACCOUNT, { lamports: rent(165), owner, data });
  const native = { native: { reserve: RENT165 } };
  const cases: Array<[string, (c: FakeChain) => void]> = [
    ['missing', (c) => void c.accounts.delete(SITE_FEE_WSOL_ACCOUNT.toBase58())],
    ['owned by another wallet', (c) => void feeAt(c, encodeTokenAccountWith(WSOL_MINT, STRANGER, 0n, native))],
    ['frozen', (c) => void feeAt(c, encodeTokenAccountWith(WSOL_MINT, VAULT, 0n, { ...native, state: 2 }))],
    ['not native', (c) => void feeAt(c, encodeTokenAccountWith(WSOL_MINT, VAULT, 0n))],
    ['closable by a stranger', (c) => void feeAt(c, encodeTokenAccountWith(WSOL_MINT, VAULT, 0n, { ...native, closeAuthority: STRANGER }))],
    ['another token', (c) => void feeAt(c, encodeTokenAccountWith(fresh(), VAULT, 0n, native))],
    ['under another program', (c) => void feeAt(c, encodeTokenAccountWith(WSOL_MINT, VAULT, 0n, native), TOKEN_2022_PROGRAM_ID)],
  ];

  it.each(cases)('%s', async (_n, breakIt) => {
    for (const side of ['buy', 'sell'] as const) {
      const w = world();
      breakIt(w.chain);
      expect(refused(w, await run(w, side))).toBe(ROUTE_COPY.feeAccountUnchecked);
    }
  });

  it('the vault itself as close authority is fine', async () => {
    const w = world();
    feeAt(w.chain, encodeTokenAccountWith(WSOL_MINT, VAULT, 0n, { ...native, closeAuthority: VAULT }));
    ok(await run(w, 'buy'));
  });
});

// ── T-B-04, T-B-05, T-B-06 ───────────────────────────────────────────────────

describe('T-B-04: a wallet’s own wrapped SOL is never spent, and the sync’s credit is exact', () => {
  const HELD = 5n * 10n ** 9n;

  it('a kept account set up under the old rent: the buy’s wrapped-SOL row is EXACTLY the re-priced reserve (550,840)', async () => {
    const w = world({ heldTokens: null, wsol: { amount: HELD, reserve: RENT165 + 550_840n } });
    const p = ok(await run(w, 'buy'));
    expect(kinds(p)).not.toContain('close-wsol');
    expect(summaryOf(p)).toMatchObject({ unwrapsWsol: false, wsolHeldBefore: HELD });
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 550_840n, maxDelta: 550_840n });
    expect(delta(p, w.wsolAta)).toBe(550_840n);
    // The wallet pays the SOL typed and the token account's deposit; nothing comes out of the wrapped balance.
    expect(p.simulated.signerLamportsDelta).toBe(-(BUY + RENT165));
    expect(delta(p, SITE_FEE_WSOL_ACCOUNT)).toBe(siteFee(BUY));
  });

  it('a stored reserve between today’s rent and the old one, plus an unsynced lamport: exactly lamports - rent - balance', async () => {
    // Seen live: a reserve of 1,855,569 against today's 1,488,440, crediting 367,130.
    const w = world({ wsol: { amount: HELD, reserve: RENT165 + 367_129n, unsynced: 1n } });
    const p = ok(await run(w, 'buy'));
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 367_130n, maxDelta: 367_130n });
    expect(delta(p, w.wsolAta)).toBe(367_130n);
  });

  it('a kept account already at today’s rent: the row is exactly 0', async () => {
    const w = world({ wsol: { amount: HELD } });
    const p = ok(await run(w, 'buy'));
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 0n, maxDelta: 0n });
    expect(delta(p, w.wsolAta)).toBe(0n);
  });

  it('a token program that keeps the stored reserve lands off that number, and is blocked (fails closed)', async () => {
    const w = world({ wsol: { amount: HELD, reserve: RENT165 + 550_840n }, sim: { keepsReserve: true } });
    const r = await run(w, 'buy');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^Blocked:/) });
  });

  it('a sell into a kept account: what the pool paid less the fee stays wrapped, and the wallet’s SOL does not move', async () => {
    const w = world({ wsol: { amount: HELD, reserve: RENT165 + 550_840n } });
    const q = await ours(w, 'sell', SELL);
    const p = ok(await run(w, 'sell'));
    expect(kinds(p)).toEqual(['create-token-account', 'pool-swap', 'site-fee']);
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: q.minOut - q.fee, maxDelta: U64_SPAN });
    // No sync on a sell, so no re-price: exactly the gross less the fee.
    expect(delta(p, w.wsolAta)).toBe(q.quoteOut - q.fee);
    expect(p.simulated.signerLamportsDelta).toBe(0n);
    expect(p.check.expect.minSolIn).toBeUndefined();
  });
});

describe('T-B-05: a fresh or empty wrapped-SOL account is closed after, and its row is [0, 0]', () => {
  it('absent before: opened, used and closed in the same transaction', async () => {
    const w = world();
    const p = ok(await run(w, 'buy'));
    expect(kinds(p).filter((k) => k === 'close-wsol')).toHaveLength(1);
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 0n, maxDelta: 0n });
    expect(summaryOf(p).unwrapsWsol).toBe(true);
  });

  it('there but empty: closed too, and its own deposit returns to the wallet', async () => {
    const w = world({ wsol: { amount: 0n } });
    const p = ok(await run(w, 'buy'));
    expect(kinds(p).filter((k) => k === 'close-wsol')).toHaveLength(1);
    expect(row(p, w.wsolAta)).toMatchObject({ minDelta: 0n, maxDelta: 0n });
    expect(p.simulated.signerLamportsDelta).toBe(-BUY + RENT165);
  });
});

describe('T-B-06: a wrapped-SOL account someone else controls is not used', () => {
  it('a stranger as its close authority: not built, kept or empty', async () => {
    for (const amount of [0n, 10n ** 9n]) {
      const w = world({ wsol: { amount, closeAuthority: STRANGER } });
      for (const side of ['buy', 'sell'] as const) expect(refused(w, await run(w, side))).toMatch(/can close your wrapped-SOL account/);
    }
  });

  it('kept, with an approved spender who can still move something: not built', async () => {
    const w = world({ wsol: { amount: 10n ** 9n, delegate: STRANGER, delegatedAmount: 5n } });
    for (const side of ['buy', 'sell'] as const) expect(refused(w, await run(w, side))).toMatch(/approved spender/);
  });

  it('reassigned to another wallet: not built', async () => {
    const w = world({ wsol: { amount: 10n ** 9n, owner: STRANGER } });
    expect(refused(w, await run(w, 'buy'))).toBe(LP_COPY.foreignOwner(w.wsolAta.toBase58(), STRANGER.toBase58()));
  });
});

// ── T-B-07..10 ───────────────────────────────────────────────────────────────

describe('T-B-07..10: the wallet’s token account', () => {
  it('T-B-07 owned by another wallet: not built, on a buy and on a sell', async () => {
    const w = world();
    w.chain.tokenAccount(w.tokenAta, w.mint, STRANGER, 10n ** 12n);
    for (const side of ['buy', 'sell'] as const) expect(refused(w, await run(w, side))).toBe(LP_COPY.foreignOwner(w.tokenAta.toBase58(), STRANGER.toBase58()));
  });

  it('T-B-08 frozen: nothing can be paid into it (buy) or moved out of it (sell)', async () => {
    const w = world({ tokenAccount: { state: 2 } });
    expect(refused(w, await run(w, 'buy'))).toBe(LP_COPY.frozenDestination('token'));
    expect(refused(w, await run(w, 'sell'))).toBe(LP_COPY.frozenSource('token'));
  });

  it('T-B-09 a buy into an account with a live approved spender: not built', async () => {
    const w = world({ tokenAccount: { delegate: STRANGER, delegatedAmount: 7n } });
    expect(refused(w, await run(w, 'buy'))).toMatch(/approved spender/);
  });

  it('T-B-10 a Token-2022 sell from an account with CPI Guard on: not built; required memos stop a buy', async () => {
    const guarded = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, tokenAccount: { cpiGuard: true } });
    expect(refused(guarded, await run(guarded, 'sell'))).toBe(LP_COPY.cpiGuard);
    const memos = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, tokenAccount: { memoRequired: true } });
    expect(refused(memos, await run(memos, 'buy'))).toBe(LP_COPY.memosRequired);
  });

  it('a sell with no token account, or more than it holds: not built, in stage 2’s words', async () => {
    const none = world({ heldTokens: null });
    expect(refused(none, await run(none, 'sell'))).toBe(ROUTE_COPY.noTokenAccount(none.tokenAta.toBase58()));
    const short = world({ heldTokens: SELL - 1n });
    expect(refused(short, await run(short, 'sell'))).toMatch(/your wallet has/);
    const exact = world({ heldTokens: SELL });
    ok(await run(exact, 'sell'));
  });
});

// ── T-B-11 ───────────────────────────────────────────────────────────────────

describe('T-B-11: the rent band', () => {
  const WALLET = 3n * 10n ** 9n;
  const most = (tokenRent: bigint, wsolRent: bigint) =>
    spendableSol({ lamports: WALLET, walletFloor: BigInt(rent(0)), feeReserve: LP_FEE_RESERVE, lpAccountRent: tokenRent, wsolCreateRent: wsolRent });

  it('one lamport above what the wallet can spend is refused with the number; exactly that much prepares', async () => {
    const w = world({ wallet: WALLET, heldTokens: null });
    const T = most(RENT165, RENT165);
    expect(T).toBe(WALLET - LP_FEE_RESERVE - RENT165 - RENT165);
    expect(refused(w, await run(w, 'buy', { amountIn: T + 1n }))).toBe(ROUTE_COPY.rentBand(formatSol(T, 9)));
    ok(await run(w, 'buy', { amountIn: T }));
  });

  it('accounts that already exist cost nothing: only the wallet’s own floor is held back', async () => {
    const w = world({ wallet: WALLET, wsol: { amount: 10n ** 9n } });
    const T = most(0n, 0n);
    expect(T).toBe(WALLET - LP_FEE_RESERVE - BigInt(rent(0)));
    expect(refused(w, await run(w, 'buy', { amountIn: T + 1n }))).toBe(ROUTE_COPY.rentBand(formatSol(T, 9)));
    ok(await run(w, 'buy', { amountIn: T }));
  });

  it('a Token-2022 account is 170 bytes: its rent is what the band, the limit and the review use', async () => {
    const w = world({ wallet: WALLET, heldTokens: null, tokenProgram: TOKEN_2022_PROGRAM_ID });
    const rent170 = BigInt(rent(170));
    const T = most(rent170, RENT165);
    expect(refused(w, await run(w, 'buy', { amountIn: T + 1n }))).toBe(ROUTE_COPY.rentBand(formatSol(T, 9)));
    const p = ok(await run(w, 'buy', { amountIn: T }));
    expect(p.check.expect.maxSolOut).toBe(T + rent170);
    expect(p.fees.newAccountRentLamports).toBe(rent170);
  });

  it('a sell has no pre-check of its own: a nearly empty wallet can still sell', async () => {
    const w = world({ wallet: 3_000_000n });
    ok(await run(w, 'sell'));
  });
});

// ── T-B-12 ───────────────────────────────────────────────────────────────────

describe('T-B-12: the route is decided here, on this read', () => {
  it('Jupiter one unit above ours: not built, and the page is told to show Jupiter', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const w = world();
      const q = await ours(w, side, side === 'buy' ? BUY : SELL);
      expect(refused(w, await run(w, side, { jupiterNet: q.netExpected + 1n }))).toBe(ROUTE_COPY.jupiterPaysMore);
    }
  });

  it('a Jupiter number that is not a positive amount is not a price: not built, and nothing is read', async () => {
    const w = world();
    for (const jupiterNet of [0n, -1n]) {
      expect(refused(w, await run(w, 'buy', { jupiterNet }))).toBe(ROUTE_COPY.jupiterUnread);
      expect(w.chain.calls).toHaveLength(0);
    }
  });

  it('the shown amount is still there within the price limit, or nothing is built', async () => {
    const w = world();
    const q = await ours(w, 'buy', BUY);
    // The largest shown amount whose floor ours still reaches, and one past it.
    let shown = (q.netExpected * 10_000n) / (10_000n - SLIP);
    while (q.netExpected < shown - (shown * SLIP) / 10_000n) shown -= 1n;
    while (q.netExpected >= shown + 1n - ((shown + 1n) * SLIP) / 10_000n) shown += 1n;
    ok(await run(w, 'buy', { shownNet: shown }));
    expect(refused(w, await run(w, 'buy', { shownNet: shown + 1n }))).toBe(ROUTE_COPY.priceMoved);
  });

  it('a page that showed no amount at all has nothing to hold the fresh one to: not built, nothing read', async () => {
    const w = world();
    for (const shownNet of [0n, -5n]) {
      expect(refused(w, await run(w, 'buy', { shownNet }))).toBe(ROUTE_COPY.priceMoved);
      expect(w.chain.calls).toHaveLength(0);
    }
  });

  it('Jupiter has no route: a pool anyone could open is never routed to on its own', async () => {
    for (const tier of [0, 1] as const) {
      const w = world({ tier });
      expect(refused(w, await run(w, 'buy', { jupiterNet: null }))).toBe(ROUTE_COPY.noRouteNotLaunch);
    }
  });

  it('Jupiter has no route: the token’s launch pool runs while it has never traded and still holds what its shares account for, and the review says which check passed', async () => {
    const w = world({ launch: true, lpSupply: OPENING_SHARES });
    const s = summaryOf(ok(await run(w, 'buy', { jupiterNet: null })));
    expect(s).toMatchObject({ origin: 'launch-pool', versus: null, priceCheck: { state: 'no-trades-yet' } });
    // With no Jupiter trade to compare with, the fee proof is not read.
    ok(await run(w, 'sell', { jupiterNet: null, jupiterFee: 'unchecked' }));
  });

  // funds-1 (dark review): a transfer straight into a vault moves the price and leaves
  // no mark in the pool's price record, so "never traded" used to pass on a moved price.
  it('Jupiter has no route: a never-traded launch pool whose token vault was topped up by a plain transfer is not built, on a buy or a sell', async () => {
    // Half as many tokens again sent straight in: the price is a third lower and no swap recorded it.
    const w = world({ launch: true, lpSupply: OPENING_SHARES, tokens: (TOKEN_RESERVE * 3n) / 2n });
    for (const side of ['buy', 'sell'] as const) {
      expect(refused(w, await run(w, side, { jupiterNet: null })), side).toBe(ROUTE_COPY.launchReservesMoved);
    }
    // The same pool still has to be the better route when Jupiter HAS one: that path is unchanged.
    ok(await run(w, 'sell'));
  });

  it('Jupiter has no route: a launch pool that traded, went quiet, and then had tokens sent in is not built ("its average" would be the price now compared with itself)', async () => {
    const w = world({ launch: true, lpSupply: OPENING_SHARES, tokens: TOKEN_RESERVE * 2n });
    // Its record: steady trading at the ORIGINAL price for 40 minutes, the last swap an hour ago.
    const Q32 = 1n << 32n;
    const perUnit = (SOL_RESERVE * Q32) / TOKEN_RESERVE;
    const inverse = (TOKEN_RESERVE * Q32) / SOL_RESERVE;
    const start = NOW - 6_000n;
    const obs: [number, bigint, bigint, bigint][] = [];
    for (let i = 0n; i <= 40n; i++) {
      const [own, other] = [perUnit * i * 60n, inverse * i * 60n];
      obs.push([Number(i), start + i * 60n, ...(w.pool.solIsToken0 ? ([other, own] as const) : ([own, other] as const))]);
    }
    w.chain.set(w.pool.observation, {
      lamports: rent(4075),
      owner: CPSWAP,
      data: observationBytes({ pool: w.pool.address, index: 40, lastUpdate: start + 2_400n, obs }),
    });
    expect(refused(w, await run(w, 'sell', { jupiterNet: null }))).toBe(ROUTE_COPY.launchTooQuiet);
  });

  it('Jupiter has no route: a launch pool whose price is far from its own half-hour average is not built', async () => {
    const w = world({ launch: true });
    // Spot is 0.425 lamports per token unit; the record says it averaged 50 times that for the last hour.
    const Q32 = 1n << 32n;
    const avg = (SOL_RESERVE * 50n * Q32) / TOKEN_RESERVE;
    const sum = avg * 3_600n;
    w.chain.set(w.pool.observation, {
      lamports: rent(4075),
      owner: CPSWAP,
      data: observationBytes({ pool: w.pool.address, index: 1, lastUpdate: NOW, obs: [[0, NOW - 3_600n, 0n, 0n], [1, NOW, sum, sum]] }),
    });
    expect(refused(w, await run(w, 'buy', { jupiterNet: null }))).toMatch(/% from its own average over the last half hour/);
  });

  it('a launch pool still has to beat Jupiter when Jupiter has a route', async () => {
    const w = world({ launch: true });
    const q = await ours(w, 'buy', BUY);
    expect(refused(w, await run(w, 'buy', { jupiterNet: q.netExpected + 1n }))).toBe(ROUTE_COPY.jupiterPaysMore);
  });
});

// ── T-B-13 ───────────────────────────────────────────────────────────────────

describe('T-B-13: the switches hold even when the builder is called directly', () => {
  it('the route’s own switch is committed off, so with no override nothing is built and nothing is read', async () => {
    const w = world();
    expect(refused(w, await run(w, 'buy', {}, 'as-a-page-calls-it'))).toBe(ROUTE_COPY.switchedOff);
    expect(w.chain.calls).toHaveLength(0);
    expect(refused(w, await run(w, 'buy', {}, { feeEnv: ON.feeEnv }))).toBe(ROUTE_COPY.switchedOff);
    expect(refused(w, await run(w, 'buy', {}, { ...ON, routeMode: 'off' }))).toBe(ROUTE_COPY.switchedOff);
  });

  it('LP in withdraw-only (the emergency state): not built', async () => {
    const w = world();
    expect(refused(w, await run(w, 'buy', {}, ON, WITHDRAW_ONLY))).toBe(ROUTE_COPY.switchedOff);
  });

  it('a build whose fee env is not the vault at exactly 50: not built', async () => {
    const w = world();
    const envs = [
      { account: '', bps: 50 },
      { account: STRANGER.toBase58(), bps: 50 },
      { account: 'not a key', bps: 50 },
      { account: VAULT.toBase58(), bps: 49 },
      { account: VAULT.toBase58(), bps: 51 },
      { account: VAULT.toBase58(), bps: 100 },
    ];
    for (const feeEnv of envs) {
      expect(refused(w, await run(w, 'buy', {}, { routeMode: 'on', feeEnv })), JSON.stringify(feeEnv)).toBe(ROUTE_COPY.feeDisagrees);
      expect(w.chain.calls).toHaveLength(0);
    }
  });

  // parity-1 (dark review): on a route where Jupiter's own program refuses the site fee,
  // the Jupiter trade that goes out carries NO fee and pays about 0.5% more than the
  // fee-bearing number our pool is ranked against. Ours used to be built there.
  it('a Jupiter number without a proof that Jupiter’s own trade carries the fee is not one our pool may beat: not built, nothing read', async () => {
    const w = world();
    expect(refused(w, await run(w, 'buy', { jupiterFee: 'waived' }))).toBe(ROUTE_COPY.jupiterFeeWaived);
    expect(w.chain.calls).toHaveLength(0);
    expect(refused(w, await run(w, 'buy', { jupiterFee: 'unchecked' }))).toBe(ROUTE_COPY.jupiterFeeUnchecked);
    expect(w.chain.calls).toHaveLength(0);
    // A caller that leaves the proof out altogether (a JS caller, a stale page) is refused, not waved through.
    expect(refused(w, await run(w, 'sell', { jupiterFee: undefined as never }))).toBe(ROUTE_COPY.jupiterFeeUnchecked);
    // Ours beats the fee-bearing number by the width of the fee: exactly the case that used to route to us.
    const q = await ours(w, 'buy', BUY);
    const feeBearing = q.netExpected - q.netExpected / 400n;
    expect(refused(w, await run(w, 'buy', { jupiterNet: feeBearing, jupiterFee: 'waived' }))).toBe(ROUTE_COPY.jupiterFeeWaived);
    ok(await run(w, 'buy', { jupiterNet: feeBearing, jupiterFee: 'charged' }));
    for (const s of [ROUTE_COPY.jupiterFeeWaived, ROUTE_COPY.jupiterFeeUnchecked, ROUTE_COPY.feeNotInSol, ROUTE_COPY.launchReservesMoved, ROUTE_COPY.launchTooQuiet]) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).toMatch(/Nothing was built|nothing was built/);
    }
  });

  // parity-2 (dark review): SPEC_S3 D3. Jupiter takes the fee on a USDC pair in USDC, to
  // another account; our route can only take it in wrapped SOL. The builder never checked.
  it('a USDC/SOL pool on our program is never ours: not built, nothing read, though the pool and the token are sound', async () => {
    const w = world({ mint: new PublicKey(USDC_MINT), tier: 1 });
    for (const side of ['buy', 'sell'] as const) {
      expect(refused(w, await run(w, side)), side).toBe(ROUTE_COPY.feeNotInSol);
      expect(w.chain.calls, side).toHaveLength(0);
    }
    expect(ROUTE_COPY.feeNotInSol).toBe('Our pools are not used for this pair: the site fee on this pair is taken in USDC, not in SOL. Nothing was built.');
  });

  it('a bad price limit or an empty amount is refused first', async () => {
    const w = world();
    expect(refused(w, await run(w, 'buy', { slippageBps: 501n }))).toMatch(/price limit/);
    expect(refused(w, await run(w, 'buy', { slippageBps: 0n }))).toMatch(/price limit/);
    expect(refused(w, await run(w, 'buy', { amountIn: 0n }))).toBe('Enter an amount above zero.');
  });
});

// ── T-B-14 ───────────────────────────────────────────────────────────────────

describe('T-B-14: the fee account’s row proves the fee arrived, and nothing more', () => {
  it('an unrelated payment landing on the fee account meanwhile (an opening fee) does not block an honest swap', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const w = world({ sim: { treasuryCredit: 150_000_000n } });
      const p = ok(await run(w, side));
      expect(delta(p, SITE_FEE_WSOL_ACCOUNT)).toBe(summaryOf(p).fee.amount + 150_000_000n);
    }
  });

  it('a fee that does not arrive in full is blocked', async () => {
    for (const arrives of [(fee: bigint) => fee - 1n, () => 0n]) {
      for (const side of ['buy', 'sell'] as const) {
        const w = world({ sim: { feeArrives: arrives } });
        const r = await run(w, side);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^Blocked:/) });
      }
    }
  });

  it('wrapped SOL that reaches an empty account after the builder’s read is blocked, not unwrapped', async () => {
    const w = world();
    const orig = w.chain.getMultipleAccountsInfo;
    let reads = 0;
    // The builder's read sees no account; by the balance read it holds 1 SOL.
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      if (++reads === 2) w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 10n ** 9n, { native: { reserve: RENT165 } });
      return orig(keys);
    };
    const q = await ours(w, 'sell', SELL);
    reads = 0;
    w.chain.accounts.delete(w.wsolAta.toBase58());
    const r = await prepareRouteSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: w.mint, tokenDecimals: 6, side: 'sell', amountIn: SELL, slippageBps: SLIP, jupiterNet: q.netExpected, jupiterFee: 'charged', shownNet: q.netExpected }, ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^Blocked:/) });
  });
});

// ── T-B-15, T-B-16 ───────────────────────────────────────────────────────────

describe('T-B-15: the page’s decimals must be the mint’s', () => {
  it('the page used 9, the mint says 6: not built', async () => {
    const w = world();
    expect(refused(w, await run(w, 'buy', { tokenDecimals: 9 }))).toBe(ROUTE_COPY.decimalsDiffer(6, 9));
  });

  it('decimals that are not a whole number from 0 to 18: not built, nothing read', async () => {
    const w = world();
    for (const tokenDecimals of [Number.NaN, -1, 19, 6.5]) {
      expect(refused(w, await run(w, 'buy', { tokenDecimals }))).toBe(ROUTE_COPY.decimalsUnknown);
      expect(w.chain.calls).toHaveLength(0);
    }
  });
});

describe('T-B-16: the largest transaction this builds leaves a wallet room for its guard instructions', () => {
  it('a Token-2022 buy with both accounts opened and the close is at most 1,232 - 150 bytes', async () => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, heldTokens: null, tier: 1 });
    const p = ok(await run(w, 'buy'));
    expect(kinds(p)).toHaveLength(7);
    expect(p.sizeBytes).toBeLessThanOrEqual(TX_SIZE_LIMIT - 150);
    const sell = ok(await run(world({ tokenProgram: TOKEN_2022_PROGRAM_ID }), 'sell'));
    expect(sell.sizeBytes).toBeLessThan(p.sizeBytes);
  });
});

// ── which pools and tokens (3.8), on the builder's own read ──────────────────

describe('the pool and the token are judged again on the builder’s read', () => {
  it('swaps switched off, another status bit, not open yet, a frozen vault, no clock: not built, each with its reason', async () => {
    const cases: Array<[WorldOptions, RegExp, ((c: FakeChain) => void)?]> = [
      [{ status: POOL_STATUS_DISABLE_SWAP }, /swaps are switched off on it/],
      [{ status: POOL_STATUS_DISABLE_DEPOSIT }, /admin has changed its settings/],
      [{ openTime: NOW + 1n }, /does not open for trading until/],
      [{ frozenTokenVault: true }, /vaults is frozen/],
      [{}, /network clock could not be read/, (c) => setClock(c, null)],
    ];
    for (const [opts, why, after] of cases) {
      const w = world(opts);
      after?.(w.chain);
      const msg = refused(w, await run(w, 'buy', { jupiterNet: 1n, shownNet: 1n }));
      expect(msg).toMatch(why);
      expect(msg).toMatch(/^Our pool can't take this trade right now: .*\. Nothing was built\.$/);
    }
  });

  it('a pool that opens exactly now is open', async () => {
    ok(await run(world({ openTime: NOW }), 'buy'));
  });

  it('a token with a live freeze authority, or an extension beyond name and picture: not built', async () => {
    const frozen = world({ freezeAuthority: STRANGER });
    expect(refused(frozen, await run(frozen, 'buy', { jupiterNet: 1n, shownNet: 1n }))).toMatch(/^This token is now blocked on this site: .+ Nothing was built\.$/);
    const fee = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [[EXT.TransferFeeConfig, 108]] });
    expect(refused(fee, await run(fee, 'buy', { jupiterNet: 1n, shownNet: 1n }))).toMatch(/^This token is now blocked on this site: .+ Nothing was built\.$/);
  });

  it('a token that calls itself by a well-known name is only a warning on the token, and still never routed to', async () => {
    const w = world();
    const str = (s: string): number[] => {
      const b = Buffer.from(s, 'utf8');
      return [b.length & 255, (b.length >> 8) & 255, 0, 0, ...b];
    };
    // A Metaplex name record (key 4), immutable, naming this mint "USD Coin" / "USDC".
    const data = Uint8Array.from([4, ...fresh().toBytes(), ...w.mint.toBytes(), ...str('USD Coin'), ...str('USDC'), ...str('https://x.test/a.json'), 0, 0, 0, 0, 0]);
    w.chain.set(metadataPda(w.mint), { lamports: 1, owner: METAPLEX_TOKEN_METADATA_ID, data });
    const msg = refused(w, await run(w, 'buy', { jupiterNet: 1n, shownNet: 1n }));
    expect(msg).toMatch(/well-known token’s name but has a different mint\. This site does not send trades to pools of copies\. Nothing was built\.$/);
  });

  it('a token mint that is gone is refused as not existing', async () => {
    const w = world();
    w.chain.accounts.delete(w.mint.toBase58());
    const r = await prepareRouteSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: w.mint, tokenDecimals: 6, side: 'buy', amountIn: BUY, slippageBps: SLIP, jupiterNet: 1n, jupiterFee: 'charged', shownNet: 1n }, ON);
    expect(r.ok).toBe(false);
    expect(w.chain.simulateCalls).toHaveLength(0);
  });

  it('an amount whose site fee rounds to nothing is never ours', async () => {
    const w = world();
    expect(siteFee(199n)).toBe(0n);
    expect(refused(w, await run(w, 'buy', { amountIn: 199n, jupiterNet: 1n, shownNet: 1n }))).toBe(ROUTE_COPY.tooSmall);
  });

  it('a pool that is not this token’s is refused', async () => {
    const w = world();
    const other = world();
    const r = await prepareRouteSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: other.mint, tokenDecimals: 6, side: 'buy', amountIn: BUY, slippageBps: SLIP, jupiterNet: 1n, jupiterFee: 'charged', shownNet: 1n }, ON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome.message).toBe(LP_COPY.notThisPair);
  });
});

// ── the plan against the decoded steps ───────────────────────────────────────

describe('routeSwapStepsProblem: the decoded steps must be exactly the plan', () => {
  const pool = fresh();
  const token = fresh();
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const tokenAta = associatedTokenAddress(token, ME);
  const create = (address: PublicKey, mint: PublicKey): IntentStep => ({ kind: 'create-token-account', owner: ME, mint, address });
  const buySteps = (): IntentStep[] => [
    create(wsolAta, WSOL_MINT),
    { kind: 'wrap-sol', lamports: 1_000n },
    { kind: 'sync-wsol' },
    { kind: 'site-fee', from: wsolAta, to: SITE_FEE_WSOL_ACCOUNT, amount: 5n },
    create(tokenAta, token),
    { kind: 'pool-swap', pool, inputMint: WSOL_MINT, outputMint: token, amountIn: 995n, minimumAmountOut: 70n },
    { kind: 'close-wsol' },
  ];
  const buyPlan = { pool, side: 'buy' as const, wrap: 1_000n, swapIn: 995n, minOut: 70n, fee: 5n, closeAfter: true };
  const sellSteps = (): IntentStep[] => [
    create(wsolAta, WSOL_MINT),
    { kind: 'pool-swap', pool, inputMint: token, outputMint: WSOL_MINT, amountIn: 900n, minimumAmountOut: 400n },
    { kind: 'site-fee', from: wsolAta, to: SITE_FEE_WSOL_ACCOUNT, amount: 2n },
  ];
  const sellPlan = { pool, side: 'sell' as const, wrap: null, swapIn: 900n, minOut: 400n, fee: 2n, closeAfter: false };

  it('the honest buy and sell match', () => {
    expect(routeSwapStepsProblem(buySteps(), buyPlan)).toBeNull();
    expect(routeSwapStepsProblem(sellSteps(), sellPlan)).toBeNull();
  });

  it('each difference is named', () => {
    const without = (steps: IntentStep[], kind: IntentStep['kind']) => steps.filter((s) => s.kind !== kind);
    const cases: Array<[string, IntentStep[], typeof buyPlan | typeof sellPlan]> = [
      ['another pool', buySteps(), { ...buyPlan, pool: fresh() }],
      ['another amount in', buySteps(), { ...buyPlan, swapIn: 994n }],
      ['another minimum', buySteps(), { ...buyPlan, minOut: 71n }],
      ['another fee', buySteps(), { ...buyPlan, fee: 6n }],
      ['another wrap', buySteps(), { ...buyPlan, wrap: 1_001n }],
      // Only the direction differs: the same amounts, the mints the other way round.
      ['the wrong direction', buySteps().map((s) => (s.kind === 'pool-swap' ? { ...s, inputMint: token, outputMint: WSOL_MINT } : s)), buyPlan],
      ['the wrong direction (sell)', sellSteps().map((s) => (s.kind === 'pool-swap' ? { ...s, inputMint: WSOL_MINT, outputMint: token } : s)), sellPlan],
      ['no swap', without(buySteps(), 'pool-swap'), buyPlan],
      ['no fee', without(buySteps(), 'site-fee'), buyPlan],
      ['two fees', [...buySteps(), { kind: 'site-fee', from: wsolAta, to: SITE_FEE_WSOL_ACCOUNT, amount: 5n }], buyPlan],
      ['no sync', without(buySteps(), 'sync-wsol'), buyPlan],
      ['a close the plan keeps', buySteps(), { ...buyPlan, closeAfter: false }],
      ['no close the plan wants', without(buySteps(), 'close-wsol'), buyPlan],
      ['the token account not opened', buySteps().filter((s) => !(s.kind === 'create-token-account' && s.address.equals(tokenAta))), buyPlan],
      ['the wrapped-SOL account opened twice instead', buySteps().map((s) => (s.kind === 'create-token-account' ? create(wsolAta, WSOL_MINT) : s)), buyPlan],
      ['a sell that wraps', [...sellSteps(), { kind: 'wrap-sol', lamports: 1n }], sellPlan],
      ['a sell that opens a second account', [...sellSteps(), create(tokenAta, token)], sellPlan],
    ];
    for (const [name, steps, plan] of cases) expect(routeSwapStepsProblem(steps, plan), name).toEqual(expect.any(String));
  });
});
