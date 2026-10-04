// @vitest-environment node
//
// Opening a pool paired with USDC or BAYLA (quotes.ts), against a fake chain whose
// simulator runs cp-swap's `initialize` with no SOL on either side. createPool.test.ts
// holds the SOL openings; the rules that do not depend on the coin (the token's own
// checks, the tier's terms, the one-off key's secrecy) are tested there once.
//
// What differs for a coin that is not SOL, and so what these pin:
//   - nothing is wrapped and no account is opened: the body is the pool instruction alone;
//   - the coin leaves the signer's own account for it, which must exist and hold it;
//   - the single read also takes the coin's own mint, which must be the mint this site knows;
//   - the opening price is checked in the coin, never in SOL;
//   - SOL pays only the fee to open and the account deposits, so none of the coin's
//     amount may leave the wallet as SOL;
//   - the pool's standard address is per pair, and a coin is only priced in the coins
//     that outrank it.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol } from '../curve/format';
import { deriveAmmConfig, deriveLpMint, deriveObservation, derivePool, deriveVault, publicTierConfig, sortMints } from '../../../solana/cpswap/program';
import { initializeIx } from '../../../solana/cpswap/ix';
import { feeReserveFor, isqrt, solSetAside } from '../../../solana/lp/liquidityMath';
import { arbitrageLoss, assessOpening, estimatedLoss, matchMarket, mostBothAtMarket, openingPricePerToken } from '../../../solana/lp/opening';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../solana/lp/quotes';
import { USDT_MINT, type TokenSafety } from '../../../solana/lp/tokenSafety';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import { CREATE_COPY, createPins, createStepsProblem, prepareLpCreate, readCreateSnapshot, type CreateSnapshot, type LpCreateArgs } from './createPool';
import { decodeIntent } from './intent';
import { LP_COPY, type LpPrepareReads } from './liquidity';
import { metadataPda } from './metaplex';
import { TX_SIZE_LIMIT, bodySteps } from './prepare';
import {
  CPSWAP,
  EXT,
  FakeChain,
  TIER1_VALUES,
  addPool,
  beforeBalanceRun,
  cfgLocal,
  createSimulator,
  rent,
  skewTestRun,
  type AmmConfigOverrides,
  type FeeReceiverOptions,
} from './testkit.fixture';
import type { IntentStep, LpCreateSummary, LpOpenGate, PoolIntent, PoolPins, PreparedTx, TierTerms, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
/** Stands in for USDC's issuer: the real mint keeps a mint authority and a freeze authority. */
const ISSUER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const TIER1 = publicTierConfig(CPSWAP);
const TIER0 = deriveAmmConfig(CPSWAP, 0);
const USDC = new PublicKey(USDC_QUOTE.mint);
const BAYLA = new PublicKey(BAYLA_QUOTE.mint);
const U6 = 10n ** 6n;
const SOL = 1_000_000_000n;
/** 200 coins against 100 tokens: 2 coins a token. Unequal on purpose, so a swapped side shows. */
const COINS = 200n * U6;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
const FEE = TIER1_VALUES.createPoolFee;
const R = (n: number) => BigInt(rent(n));
/** What `initialize` pays for and never returns: pool, price record, share token, the coin's vault and the token's. */
const NEVER_REFUNDED = R(637) + R(4075) + R(82) + R(165) + R(165);
/** A row with no upper bound: more arriving than the review says cannot hurt the signer. */
const NO_CEILING = 2n ** 64n;
const BLOCKED_SOL = 'Blocked: the simulation shows more SOL leaving your wallet than this screen says.';
const BLOCKED_TOKENS = 'Blocked: the simulation shows a different token amount than this screen says.';

const TERMS: TierTerms = {
  createPoolFee: TIER1_VALUES.createPoolFee,
  tradeFeeRate: TIER1_VALUES.tradeFeeRate,
  protocolFeeRate: TIER1_VALUES.protocolFeeRate,
  fundFeeRate: TIER1_VALUES.fundFeeRate,
  creatorFeeRate: TIER1_VALUES.creatorFeeRate,
};

const COIN_ROWS = [['USDC', USDC_QUOTE], ['BAYLA', BAYLA_QUOTE]] as const;

// ── prices: the token at 0.01 SOL, the coin at 0.005 SOL, so 2 coins a token ───

const price = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });

function priced(quote: QuoteCoin, o: { token?: OutsidePrice; coin?: OutsidePrice | Error } = {}): LpPrepareReads & { asked: Array<[string, number]> } {
  const asked: Array<[string, number]> = [];
  return {
    asked,
    outsidePrice: async (mint, decimals) => {
      asked.push([mint, decimals]);
      if (quote.native || mint !== quote.mint) return o.token ?? price(0.01);
      if (o.coin instanceof Error) throw o.coin;
      return o.coin ?? price(0.005);
    },
  };
}

// ── the world ────────────────────────────────────────────────────────────────

/** The token going into the pool: a fresh classic or Token-2022 mint, or BAYLA or USDC themselves. */
type TokenKind = 'classic' | 'token-2022' | 'BAYLA' | 'USDC';

interface World {
  chain: FakeChain;
  quote: QuoteCoin;
  quoteMint: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  tokenDecimals: number;
  tokenAta: PublicKey;
  /** The signer's own account for the coin, under the coin's own program (for SOL, the wrapped-SOL address). */
  quoteAta: PublicKey;
  token0: PublicKey;
  token1: PublicKey;
  quoteIsToken0: boolean;
  /** THIS pair's standard address on tier 1. */
  standard: PublicKey;
  /** The signer's pool-share account for a pool at that address. */
  lpAta: PublicKey;
}

interface CoinAccountOptions {
  owner?: PublicKey;
  state?: 1 | 2;
  cpiGuard?: boolean;
}

/** The signer's account for the coin as the chain holds it: a classic 165 for USDC, a Token-2022 170 for BAYLA. */
function holdCoin(chain: FakeChain, quote: QuoteCoin, address: PublicKey, amount: bigint, o: CoinAccountOptions = {}): void {
  const mint = new PublicKey(quote.mint);
  if (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) chain.token2022Account(address, mint, o.owner ?? ME, amount, { state: o.state, cpiGuard: o.cpiGuard });
  else chain.tokenAccount(address, mint, o.owner ?? ME, amount, { state: o.state });
}

function world(
  quote: QuoteCoin,
  o: {
    token?: TokenKind;
    /** A chosen key for a fresh token, to put the coin on a chosen side of the pool. */
    mint?: PublicKey;
    tokenDecimals?: number;
    wallet?: bigint;
    heldTokens?: bigint | null;
    heldQuote?: bigint | null;
    quoteAccount?: CoinAccountOptions;
    coinMint?: 'missing' | 'wrong-decimals' | 'wrong-program';
    tier?: Partial<AmmConfigOverrides> | null;
    feeReceiver?: Partial<FeeReceiverOptions> | null;
  } = {},
): World {
  const chain = FakeChain.healthy();
  chain.simulate = createSimulator();
  if (o.tier !== null) chain.addTier1(o.tier ?? {});
  if (o.feeReceiver !== null) chain.addFeeReceiver(o.feeReceiver ?? {});

  const kind = o.token ?? 'classic';
  const mint = kind === 'BAYLA' ? BAYLA : kind === 'USDC' ? USDC : (o.mint ?? fresh());
  const tokenProgram = kind === 'classic' || kind === 'USDC' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenDecimals = o.tokenDecimals ?? 6;
  if (kind === 'USDC') chain.mint(mint, { decimals: 6, mintAuthority: ISSUER, freezeAuthority: ISSUER });
  else if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, METADATA_ONLY, { decimals: tokenDecimals });
  else chain.mint(mint, { decimals: tokenDecimals });

  // The coin's own mint, as the chain holds it: USDC classic, with its issuer's mint and
  // freeze authorities; BAYLA under Token-2022, with a name and a picture.
  const quoteMint = new PublicKey(quote.mint);
  const quoteProgram = new PublicKey(quote.program);
  if (!quote.native && o.coinMint !== 'missing') {
    const decimals = o.coinMint === 'wrong-decimals' ? 9 : quote.decimals;
    const token2022 = quoteProgram.equals(TOKEN_2022_PROGRAM_ID) !== (o.coinMint === 'wrong-program');
    if (token2022) chain.mint2022(quoteMint, METADATA_ONLY, { decimals });
    else chain.mint(quoteMint, { decimals, mintAuthority: ISSUER, freezeAuthority: ISSUER });
  }

  chain.fund(ME, Number(o.wallet ?? 5n * SOL));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  const heldTokens = o.heldTokens === undefined ? 1_000n * 10n ** BigInt(tokenDecimals) : o.heldTokens;
  if (heldTokens !== null) {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, ME, heldTokens);
    else chain.tokenAccount(tokenAta, mint, ME, heldTokens);
  }
  const quoteAta = associatedTokenAddress(quoteMint, ME, quoteProgram);
  const heldQuote = o.heldQuote === undefined ? 50_000n * U6 : o.heldQuote;
  if (!quote.native && heldQuote !== null) holdCoin(chain, quote, quoteAta, heldQuote, o.quoteAccount);

  const { token0, token1 } = sortMints(quoteMint, mint);
  const standard = derivePool(CPSWAP, TIER1, token0, token1);
  return {
    chain,
    quote,
    quoteMint,
    mint,
    tokenProgram,
    tokenDecimals,
    tokenAta,
    quoteAta,
    token0,
    token1,
    quoteIsToken0: token0.equals(quoteMint),
    standard,
    lpAta: associatedTokenAddress(deriveLpMint(CPSWAP, standard), ME),
  };
}

/** A fresh mint that sorts below or above `other`, so a test can put the coin on either side of the pool. */
function mintSorted(side: 'below' | 'above', other: PublicKey): PublicKey {
  for (;;) {
    const k = fresh();
    if (sortMints(k, other).token0.equals(k) === (side === 'below')) return k;
  }
}

/** 100 whole tokens, in the token's own decimals. */
const tokensOf = (w: World) => 100n * 10n ** BigInt(w.tokenDecimals);

const args = (w: World, o: Partial<LpCreateArgs> = {}): LpCreateArgs => ({
  owner: ME,
  tokenMint: w.mint,
  quoteMint: w.quoteMint,
  // 200 coins, or 1 SOL: either way 100 tokens beside it is the market price.
  quote: w.quote.native ? SOL : COINS,
  token: tokensOf(w),
  shown: { terms: TERMS, standard: 'empty' },
  ...o,
});

async function create(w: World, o: Partial<LpCreateArgs> = {}, reads: LpPrepareReads = priced(w.quote), gate: LpOpenGate = OPEN) {
  return prepareLpCreate(W(w.chain), gate, reads, args(w, o));
}

type Result = Awaited<ReturnType<typeof create>>;

function ok(r: Result): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}

function refused(r: Result): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  return r.outcome.message;
}

const outcome = (r: Result) => (r.ok ? 'prepared' : r.outcome);
const summaryOf = (p: PreparedTx) => p.summary as LpCreateSummary;
const pinsOf = (p: PreparedTx) => (p.check.intent.kind === 'lp-create' && 'pins' in p.check.intent ? p.check.intent.pins : null);
const initIx = (p: PreparedTx) => p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
const row = (p: PreparedTx, k: PublicKey) => {
  const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
  return [r.minDelta, r.maxDelta];
};
const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;
const solText = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;

/** A pool someone else opened at THIS pair's standard tier-1 address. */
function squat(w: World): void {
  addPool(w.chain, w.mint, { quote: w.quote, sol: 10n * COINS, tokens: tokensOf(w), address: w.standard, tokenProgram: w.tokenProgram });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the single read ──────────────────────────────────────────────────────────

describe('readCreateSnapshot: an opening paired with USDC or BAYLA', () => {
  it.each(COIN_ROWS)('%s: 19 keys in ONE call: the 18, with the coin’s account where the wrapped-SOL account was, then the coin’s own mint', async (_n, quote) => {
    const w = world(quote);
    const key = Keypair.generate();
    vi.spyOn(Keypair, 'generate').mockReturnValueOnce(key);
    const asked: string[][] = [];
    const orig = w.chain.getMultipleAccountsInfo;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      asked.push(keys.map((k) => k.toBase58()));
      return orig(keys);
    };
    ok(await create(w));
    const five = (pool: PublicKey) => [pool, deriveLpMint(CPSWAP, pool), deriveVault(CPSWAP, pool, w.token0), deriveVault(CPSWAP, pool, w.token1), deriveObservation(CPSWAP, pool)];
    const want = [
      TIER1,
      CP_CREATE_POOL_FEE_RECEIVER,
      w.mint,
      metadataPda(w.mint),
      ME,
      associatedTokenAddress(w.mint, ME, TOKEN_PROGRAM_ID),
      associatedTokenAddress(w.mint, ME, TOKEN_2022_PROGRAM_ID),
      w.quoteAta,
      ...five(w.standard),
      ...five(key.publicKey),
      w.quoteMint,
    ].map((k) => k.toBase58());
    expect(asked[0]).toHaveLength(19);
    expect(asked[0]).toEqual(want);
    // The coin's account is the associated one under the coin's OWN program.
    expect(asked[0]![7]).toBe(associatedTokenAddress(w.quoteMint, ME, new PublicKey(quote.program)).toBase58());
    // No wrapped-SOL account is read at all.
    expect(asked[0]).not.toContain(associatedTokenAddress(WSOL_MINT, ME).toBase58());
    // The only other account read is the shared pipeline's balance read: the wallet and the 4 watched accounts.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual([ME, w.tokenAta, w.quoteAta, w.lpAta, CP_CREATE_POOL_FEE_RECEIVER].map((k) => k.toBase58()));
  });

  it('called on its own: one read; the coin’s account and its mint come back; SOL reads no mint; a failed read is a string', async () => {
    const w = world(BAYLA_QUOTE);
    const key = fresh();
    const snap = (await readCreateSnapshot(W(w.chain), cfgLocal, { tokenMint: w.mint, owner: ME, fresh: key, quote: BAYLA_QUOTE })) as CreateSnapshot;
    expect(w.chain.calls).toEqual(['getMultipleAccountsInfo']);
    expect(snap.quoteAccount.address.equals(w.quoteAta)).toBe(true);
    expect(snap.quoteAccount.account?.owner).toBe(BAYLA_QUOTE.program);
    expect(snap.quoteMint?.address).toBe(BAYLA_QUOTE.mint);
    expect(snap.quoteMint?.owner).toBe(BAYLA_QUOTE.program);
    expect(snap.standard.address.equals(w.standard)).toBe(true);
    expect(snap.fresh.address.equals(key)).toBe(true);
    expect([...snap.standard.accounts, ...snap.fresh.accounts]).toEqual([null, null, null, null, null, null, null, null, null, null]);
    expect(snap.tokenAccounts.classic).not.toBeNull();

    // The same token asked about as a SOL pair: another standard address, the wrapped-SOL account, and no mint read.
    const sol = (await readCreateSnapshot(W(w.chain), cfgLocal, { tokenMint: w.mint, owner: ME, fresh: key, quote: SOL_QUOTE })) as CreateSnapshot;
    expect(sol.quoteMint).toBeNull();
    expect(sol.quoteAccount.address.equals(associatedTokenAddress(WSOL_MINT, ME))).toBe(true);
    expect(sol.standard.address.equals(w.standard)).toBe(false);

    w.chain.getMultipleAccountsInfo = async () => {
      throw new Error('HTTP 502');
    };
    expect(typeof (await readCreateSnapshot(W(w.chain), cfgLocal, { tokenMint: w.mint, owner: ME, fresh: key, quote: BAYLA_QUOTE }))).toBe('string');
  });
});

// ── a clean opening ──────────────────────────────────────────────────────────

const HAPPY: Array<[string, QuoteCoin, TokenKind]> = [
  ['a classic token with USDC', USDC_QUOTE, 'classic'],
  ['a classic token with BAYLA', BAYLA_QUOTE, 'classic'],
  ['BAYLA itself (a Token-2022 token) with USDC', USDC_QUOTE, 'BAYLA'],
  ['a Token-2022 token with BAYLA', BAYLA_QUOTE, 'token-2022'],
];

describe.each(HAPPY)('prepareLpCreate, a clean opening: %s', (_name, quote, token) => {
  it('the body is the pool instruction alone: nothing is wrapped and no account is opened', async () => {
    const w = world(quote, { token });
    const reads = priced(quote);
    const p = ok(await create(w, {}, reads));
    expect(p.kind).toBe('lp-create');
    expect(p.extraSigners).toEqual([]);
    expect(p.steps.map((s) => s.kind)).toEqual(['compute-limit', 'compute-price', 'pool-create']);
    expect(p.tx.instructions.map((i) => i.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      CPSWAP.toBase58(),
    ]);
    expect(p.check.body).toHaveLength(1);
    expect(p.tx.compileMessage().header.numRequiredSignatures).toBe(1);

    // The instruction itself: tier 1, the fee account, open now, and each side spent from
    // the signer's own associated account under that side's own program.
    const ix = initIx(p);
    const [coinSide, tokenSide] = w.quoteIsToken0 ? [0, 1] : [1, 0];
    expect(ix.keys).toHaveLength(20);
    expect(ix.keys[0]!.pubkey.equals(ME)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(TIER1)).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(w.standard)).toBe(true);
    expect(ix.keys[3]!.isSigner).toBe(false);
    expect([ix.keys[4]!.pubkey.toBase58(), ix.keys[5]!.pubkey.toBase58()]).toEqual([w.token0.toBase58(), w.token1.toBase58()]);
    expect(ix.keys[7 + coinSide]!.pubkey.equals(w.quoteAta)).toBe(true);
    expect(ix.keys[7 + tokenSide]!.pubkey.equals(w.tokenAta)).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(w.lpAta)).toBe(true);
    expect(ix.keys[12]!.pubkey.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
    expect(ix.keys[15 + coinSide]!.pubkey.toBase58()).toBe(quote.program);
    expect(ix.keys[15 + tokenSide]!.pubkey.equals(w.tokenProgram)).toBe(true);
    expect(ix.data.readBigUInt64LE(8 + 8 * coinSide)).toBe(COINS);
    expect(ix.data.readBigUInt64LE(8 + 8 * tokenSide)).toBe(tokensOf(w));
    expect(ix.data.readBigUInt64LE(24)).toBe(0n);

    // Both prices were read: the token's, and the coin's own in the coin's own decimals.
    expect([...reads.asked].sort()).toEqual([[w.mint.toBase58(), w.tokenDecimals], [quote.mint, quote.decimals]].sort());
  });

  it('every number in the review comes from the transaction and the reads, in the coin’s own units', async () => {
    const w = world(quote, { token });
    const p = ok(await create(w));
    const s = summaryOf(p);
    const tokens = tokensOf(w);
    const supply = isqrt(COINS * tokens);
    expect(s.origin).toBe('standard');
    expect(s.pool.equals(w.standard)).toBe(true);
    expect(s.config.index).toBe(1);
    expect(s.tokenMint.equals(w.mint)).toBe(true);
    expect(s.tokenDecimals).toBe(w.tokenDecimals);
    expect(s.quote).toBe(quote);
    expect(s.quoteIsToken0).toBe(w.quoteIsToken0);
    expect(s.put).toEqual({ quote: COINS, token: tokens });
    expect(s.supply).toBe(supply);
    expect(s.lpAmount).toBe(supply - 100n);
    expect(s.lpDecimals).toBe(9);
    expect(s.locked).toEqual({ quote: (100n * COINS) / supply, token: (100n * tokens) / supply });
    expect(s.createFee).toBe(FEE);
    expect(s.feeReceiver.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
    expect(s.rents).toEqual({ neverRefunded: NEVER_REFUNDED, lpAccount: R(165) });
    expect(p.fees.newAccountRentLamports).toBe(NEVER_REFUNDED + R(165));
    // 2 coins a token against a market of 2 coins a token.
    expect(s.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(s.price.state === 'agrees' && s.price.pool).toBeCloseTo(2, 9);
    expect(s.price.state === 'agrees' && s.price.reference).toBeCloseTo(2, 9);
    // Nothing is wrapped, so nothing is unwrapped and no wrapped SOL was looked at.
    expect(s.unwrapsWsol).toBe(false);
    expect(s.wsolHeldBefore).toBe(0n);
    expect(s.notices).toEqual([]);
  });

  it('the coin’s own account is watched, named as the coin, in the coin’s decimals', async () => {
    const w = world(quote, { token });
    const p = ok(await create(w));
    const lpMint = deriveLpMint(CPSWAP, w.standard);
    expect(p.check.watch.signer.equals(ME)).toBe(true);
    expect(p.check.watch.tokenAccounts.map((t) => [t.role, t.decimals, t.account.toBase58(), t.mint.toBase58()])).toEqual([
      ['token', w.tokenDecimals, w.tokenAta.toBase58(), w.mint.toBase58()],
      ['quote', quote.decimals, w.quoteAta.toBase58(), quote.mint],
      ['lp', 9, w.lpAta.toBase58(), lpMint.toBase58()],
      ['treasury', 9, CP_CREATE_POOL_FEE_RECEIVER.toBase58(), WSOL_MINT.toBase58()],
    ]);
  });

  it('what may leave: at most the coins typed and the tokens typed; SOL only for the fee to open and the deposits; the shares exact', async () => {
    const w = world(quote, { token });
    const p = ok(await create(w));
    const s = summaryOf(p);
    expect(p.check.expect.tokens).toHaveLength(4);
    expect(row(p, w.lpAta)).toEqual([s.lpAmount, s.lpAmount]);
    expect(row(p, w.tokenAta)).toEqual([-tokensOf(w), NO_CEILING]);
    expect(row(p, w.quoteAta)).toEqual([-COINS, NO_CEILING]);
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([FEE, NO_CEILING]);
    // None of the coin's amount is in the SOL that may leave.
    expect(p.check.expect.maxSolOut).toBe(FEE + NEVER_REFUNDED + R(165));
    expect(p.check.expect.minSolIn).toBeUndefined();
    // And the test run moved exactly that.
    expect(p.simulated.signerLamportsDelta).toBe(-(FEE + NEVER_REFUNDED + R(165)));
    expect(p.simulated.tokenDeltas.map((d) => [d.role, d.decimals, d.delta])).toEqual([
      ['token', w.tokenDecimals, -tokensOf(w)],
      ['quote', quote.decimals, -COINS],
      ['lp', 9, s.lpAmount],
      ['treasury', 9, FEE],
    ]);
  });
});

describe('prepareLpCreate: the coin is on its own side, in its own decimals', () => {
  it.each(COIN_ROWS)('%s: the coin’s amount sits on the coin’s side whichever way the two mints sort', async (_n, quote) => {
    for (const side of ['below', 'above'] as const) {
      const w = world(quote, { mint: mintSorted(side, new PublicKey(quote.mint)) });
      // A token that sorts below the coin is token 0, so the coin is token 1.
      expect(w.quoteIsToken0, side).toBe(side === 'above');
      const p = ok(await create(w));
      const s = summaryOf(p);
      const ix = initIx(p);
      expect(s.quoteIsToken0, side).toBe(w.quoteIsToken0);
      expect(s.put, side).toEqual({ quote: COINS, token: tokensOf(w) });
      expect([ix.data.readBigUInt64LE(8), ix.data.readBigUInt64LE(16)], side).toEqual(w.quoteIsToken0 ? [COINS, tokensOf(w)] : [tokensOf(w), COINS]);
      expect(ix.keys[w.quoteIsToken0 ? 7 : 8]!.pubkey.equals(w.quoteAta), side).toBe(true);
      expect(pinsOf(p)!.quoteIsToken0, side).toBe(w.quoteIsToken0);
    }
  });

  it('a token with 9 decimals paired with a 6-decimal coin: each price is asked for in its own decimals, and 200 coins for 100 tokens is still 2 a token', async () => {
    const w = world(USDC_QUOTE, { tokenDecimals: 9 });
    const reads = priced(USDC_QUOTE);
    const p = ok(await create(w, {}, reads));
    const s = summaryOf(p);
    expect([...reads.asked].sort()).toEqual([[w.mint.toBase58(), 9], [USDC_QUOTE.mint, 6]].sort());
    expect(s.put).toEqual({ quote: 200n * U6, token: 100n * 10n ** 9n });
    expect(s.price.state === 'agrees' && s.price.pool).toBeCloseTo(2, 9);
    expect(p.check.watch.tokenAccounts.map((t) => [t.role, t.decimals])).toEqual([['token', 9], ['quote', 6], ['lp', 9], ['treasury', 9]]);
  });
});

// ── where the pool goes ──────────────────────────────────────────────────────

describe('where a pool paired with USDC or BAYLA goes', () => {
  const extraKeys = (p: PreparedTx) => p.extraSigners.map((k) => k.publicKey.toBase58());

  it('the standard address is per pair: a SOL pool for the same token does not move a USDC opening off its own', async () => {
    const w = world(USDC_QUOTE);
    const solPair = sortMints(WSOL_MINT, w.mint);
    const solStandard = derivePool(CPSWAP, TIER1, solPair.token0, solPair.token1);
    expect(solStandard.equals(w.standard)).toBe(false);
    addPool(w.chain, w.mint, { sol: 10n * SOL, tokens: tokensOf(w), address: solStandard });
    const p = ok(await create(w));
    expect(summaryOf(p).origin).toBe('standard');
    expect(summaryOf(p).pool.equals(w.standard)).toBe(true);
    expect(p.extraSigners).toEqual([]);
  });

  it('and the other way: a USDC pool for the same token does not move a SOL opening off the SOL pair’s standard address', async () => {
    const w = world(SOL_QUOTE);
    w.chain.mint(USDC, { decimals: 6, mintAuthority: ISSUER, freezeAuthority: ISSUER });
    const usdcPair = sortMints(USDC, w.mint);
    addPool(w.chain, w.mint, { quote: USDC_QUOTE, sol: 10n * COINS, tokens: tokensOf(w), address: derivePool(CPSWAP, TIER1, usdcPair.token0, usdcPair.token1) });
    const p = ok(await create(w));
    expect(summaryOf(p).origin).toBe('standard');
    expect(summaryOf(p).pool.equals(w.standard)).toBe(true);
    expect(summaryOf(p).quote).toBe(SOL_QUOTE);
  });

  it.each(COIN_ROWS)('%s: a pool already at this pair’s standard address: a fresh one-off address, signed by exactly one extra key, which is the pool', async (_n, quote) => {
    const w = world(quote);
    squat(w);
    const p = ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }));
    const s = summaryOf(p);
    expect(s.origin).toBe('other');
    expect(s.pool.equals(w.standard)).toBe(false);
    expect(extraKeys(p)).toEqual([s.pool.toBase58()]);
    expect(extraKeys(p)).toEqual([pinsOf(p)!.address.toBase58()]);
    expect(pinsOf(p)!.origin).toBe('other');
    const ix = initIx(p);
    expect(ix.keys[3]!.pubkey.equals(s.pool) && ix.keys[3]!.isSigner).toBe(true);
    expect(p.tx.compileMessage().header.numRequiredSignatures).toBe(2);
    // Still the pool instruction alone, and the shares go to the account derived from the NEW address.
    expect(bodySteps(p.steps).map((x) => x.kind)).toEqual(['pool-create']);
    expect(ix.keys[9]!.pubkey.equals(associatedTokenAddress(deriveLpMint(CPSWAP, s.pool), ME))).toBe(true);
  });

  it('anything at all at this pair’s standard address or its coin vault sends it to a one-off address', async () => {
    const atVault = world(USDC_QUOTE);
    atVault.chain.fund(deriveVault(CPSWAP, atVault.standard, USDC), 10_000_000);
    expect(summaryOf(ok(await create(atVault))).origin).toBe('other');
    const atPool = world(BAYLA_QUOTE);
    atPool.chain.fund(atPool.standard, 1_000_000);
    expect(summaryOf(ok(await create(atPool))).origin).toBe('other');
  });

  it('the panel saw this pair’s standard address empty and a pool is there now: someone just opened one', async () => {
    const w = world(USDC_QUOTE);
    squat(w);
    expect(refused(await create(w))).toBe(CREATE_COPY.justOpened);
  });

  it('something already at the fresh key’s accounts: refused, never used', async () => {
    const w = world(BAYLA_QUOTE);
    squat(w);
    const key = Keypair.generate();
    w.chain.fund(deriveVault(CPSWAP, key.publicKey, BAYLA), 1_000_000);
    vi.spyOn(Keypair, 'generate').mockReturnValueOnce(key);
    expect(refused(await create(w, { shown: { terms: TERMS, standard: 'taken' } }))).toBe(CREATE_COPY.freshTaken);
  });
});

// ── which pairs ──────────────────────────────────────────────────────────────

describe('a coin is only priced in the coins that outrank it', () => {
  it('BAYLA opens against SOL and against USDC, and USDC against SOL', async () => {
    expect(summaryOf(ok(await create(world(SOL_QUOTE, { token: 'BAYLA' })))).quote).toBe(SOL_QUOTE);
    expect(summaryOf(ok(await create(world(USDC_QUOTE, { token: 'BAYLA' })))).quote).toBe(USDC_QUOTE);
    expect(summaryOf(ok(await create(world(SOL_QUOTE, { token: 'USDC' })))).quote).toBe(SOL_QUOTE);
  });

  it('USDC is never priced in BAYLA, and no coin in itself: refused before anything is read', async () => {
    const cases: Array<[PublicKey, QuoteCoin]> = [[USDC, BAYLA_QUOTE], [USDC, USDC_QUOTE], [BAYLA, BAYLA_QUOTE]];
    for (const [tokenMint, quote] of cases) {
      const w = world(quote);
      const before = w.chain.calls.length;
      expect(refused(await create(w, { tokenMint })), `${tokenMint.toBase58()} in ${quote.symbol}`).toBe(CREATE_COPY.cannotPair(quote.symbol));
      expect(w.chain.calls.length).toBe(before);
    }
  });

  it('SOL is never the token of a pool, whatever it is paired with', async () => {
    for (const [, quote] of COIN_ROWS) {
      const w = world(quote);
      w.chain.mint(WSOL_MINT, { decimals: 9 });
      expect(refused(await create(w, { tokenMint: WSOL_MINT })), quote.symbol).toBe(
        CREATE_COPY.tokenRefused('This is wrapped SOL. Pools here pair a token WITH SOL: look up the other token.'),
      );
    }
  });

  it('a coin that is not on the list is refused before anything is read', async () => {
    const w = world(USDC_QUOTE);
    const before = w.chain.calls.length;
    expect(refused(await create(w, { quoteMint: fresh() }))).toBe(CREATE_COPY.notAPairingCoin);
    // A well-known coin is not a pairing coin until it has a row in quotes.ts.
    expect(refused(await create(w, { quoteMint: new PublicKey(USDT_MINT) }))).toBe(CREATE_COPY.notAPairingCoin);
    expect(w.chain.calls.length).toBe(before);
  });
});

// ── each "no" that belongs to the coin ───────────────────────────────────────

describe('prepareLpCreate with USDC or BAYLA: what refuses it, each in its own words', () => {
  it('inputs: paused, an empty coin side, a coin side past u64', async () => {
    const w = world(USDC_QUOTE);
    expect(refused(await create(w, {}, priced(USDC_QUOTE), { kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' }))).toBe(CREATE_COPY.paused);
    expect(refused(await create(w, { quote: 0n }))).toBe(CREATE_COPY.emptySide);
    expect(refused(await create(w, { quote: 1n << 64n }))).toBe(CREATE_COPY.tooLarge);
  });

  it.each([
    ['missing', 'its mint is missing'],
    ['wrong-decimals', 'its decimals differ'],
    ['wrong-program', 'it sits under another token program'],
  ] as const)('the coin’s own mint %s: nothing is built, and the reason names the coin', async (coinMint, what) => {
    for (const [, quote] of COIN_ROWS) {
      const w = world(quote, { coinMint });
      expect(refused(await create(w)), quote.symbol).toBe(LP_COPY.coinChanged(quote.symbol, what));
    }
  });

  it.each(COIN_ROWS)('%s: the coin’s own price unread, without a route, or a read that throws: nothing is built, and it is said as the coin’s price', async (_n, quote) => {
    const w = world(quote);
    const unread: OutsidePrice = { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' };
    expect(refused(await create(w, {}, priced(quote, { coin: unread })))).toBe(CREATE_COPY.coinPriceUnread(quote.symbol, 'Jupiter did not give a price (HTTP 502)'));
    const noRoute: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
    const msg = refused(await create(w, {}, priced(quote, { coin: noRoute })));
    // Jupiter's own sentence says "this token"; said of the coin it names the coin. A token
    // with no route is allowed now, so "this token" here read as refusing a lifted case.
    expect(msg).toBe(`We could not get the price of ${quote.symbol} from Jupiter just now (Jupiter has no route for ${quote.symbol}), so we could not check the opening price. Try again in a moment.`);
    expect(msg).not.toMatch(/this token/);
    expect(refused(await create(w, {}, priced(quote, { coin: new Error('offline') })))).toBe(CREATE_COPY.coinPriceUnread(quote.symbol, 'offline'));
    // A price that is a number but prices nothing is not a pass either.
    expect(refused(await create(w, {}, priced(quote, { coin: price(0) })))).toMatch(/^We did not build this opening: We could not get a market price from Jupiter/);
  });

  it('the token’s price NOT read: nothing is built, and it is never a warning', async () => {
    const w = world(USDC_QUOTE);
    expect(refused(await create(w, {}, priced(USDC_QUOTE, { token: { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } })))).toBe(
      CREATE_COPY.priceUnread('Jupiter did not give a price (HTTP 502)'),
    );
  });

  // Owner ruling 2026-10-04. Jupiter ANSWERING "no route" for the token opens the pool as
  // "no market". Nothing is compared, so the coin's own price is not needed either.
  it.each([
    ['read', price(0.005)],
    ['unread', { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } as OutsidePrice],
    ['without a route', { kind: 'no-route', detail: 'Jupiter has no route for this token' } as OutsidePrice],
    ['a read that throws', new Error('offline')],
  ])('the token has no route, and the coin’s own price is %s: it builds as "no market", and the opener is told they set the price themselves', async (_n, coin) => {
    for (const [, quote] of COIN_ROWS) {
      const w = world(quote);
      const s = summaryOf(ok(await create(w, {}, priced(quote, { token: { kind: 'no-route', detail: 'Jupiter has no route for this token' }, coin }))));
      expect(s.price).toEqual({ state: 'no-market', pool: 2, detail: 'Jupiter has no route for this token' });
      expect(s.priceGap).toBeNull();
      expect(s.warnings).toEqual([
        'Jupiter has no market price for this token, so there is nothing to compare your opening price with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.',
      ]);
    }
  });

  it.each(COIN_ROWS)('%s: an opening price more than 3%% from the market IN THE COIN builds, with the gap and the estimated loss said in that coin, whichever of the two prices moved', async (_n, quote) => {
    const w = world(quote);
    const gapOf = async (o: Parameters<typeof priced>[1]) => summaryOf(ok(await create(w, {}, priced(quote, o))));
    // The token dearer or cheaper in SOL: the market is 1.92 or 2.08 coins a token, the opening 2.
    const above = await gapOf({ token: price(0.0096) });
    expect(above.warnings[0]).toBe('Your opening price is 4.2% above the market price (Jupiter). The first trades would move it to the market price, at your cost.');
    expect(above.priceGap!.diff).toBeCloseTo(2 / 1.92 - 1, 9);
    // 200 coins against 100 tokens worth 192: (√200 − √192)² coins, about 0.0816.
    expect(Number(above.priceGap!.lossQuote) / 1e6).toBeCloseTo((Math.sqrt(200) - Math.sqrt(192)) ** 2, 5);
    expect(above.priceGap!.lossQuote).toBe(estimatedLoss({ quoteAmount: COINS, token: tokensOf(w), tokenDecimals: 6, marketPricePerToken: above.price.state === 'disagrees' ? above.price.reference : 0, quote }));
    expect(above.warnings[1]).toMatch(new RegExp(`^At these amounts, a move back to the market price would take up to about 0\\.0816\\d* ${quote.symbol} of what you put in\\. That is an estimate\\.$`));
    expect(above.warnings.join(' ')).not.toMatch(/\bSOL\b/);
    const below = await gapOf({ token: price(0.0104) });
    expect(below.warnings[0]).toMatch(/^Your opening price is 3\.8% below the market price/);
    // The COIN dearer in SOL, the token unchanged: the market is 1.92 coins a token again.
    const coinMoved = await gapOf({ coin: price(0.0052083333) });
    expect(coinMoved.warnings[0]).toMatch(/^Your opening price is 4\.2% above the market price/);
    // Within 3% it builds with nothing to say.
    const near = await gapOf({ token: price(0.0101) });
    expect([near.warnings, near.priceGap]).toEqual([[], null]);
  });

  it('the units cannot be mixed up: a price that only matches the token’s SOL price is 99.5% below its price in the coin, and is said so', async () => {
    const w = world(USDC_QUOTE);
    // 1 USDC for 100 tokens is 0.01 USDC a token. The token is 0.01 SOL, so the number
    // matches its SOL price, but in USDC (at 0.005 SOL) the market is 2 a token.
    const s = summaryOf(ok(await create(w, { quote: 1n * U6 })));
    expect(s.priceGap!.diff).toBeCloseTo(-0.995, 9);
    expect(s.warnings[0]).toMatch(/^Your opening price is 99\.5% below the market price/);
    // (√1 − √200)² is about 172.7 USDC: what the 100 tokens would be sold for too little.
    expect(Number(s.priceGap!.lossQuote) / 1e6).toBeCloseTo((1 - Math.sqrt(200)) ** 2, 4);
    // The same amounts are the market price only when one coin is worth one SOL.
    const fair = summaryOf(ok(await create(w, { quote: 1n * U6 }, priced(USDC_QUOTE, { coin: price(1) }))));
    expect([fair.warnings, fair.priceGap]).toEqual([[], null]);
  });

  it('the coin is read in its own six decimals, never SOL’s nine: 200,000,000,000 units is 2,000 a token, and the gap says so', async () => {
    const w = world(USDC_QUOTE, { heldQuote: 300_000n * U6 });
    // 200,000,000,000 units is 200,000 USDC, not 200: 2,000 a token against a market of 2.
    const typed = 200n * 10n ** 9n;
    expect(openingPricePerToken(typed, tokensOf(w), 6, SOL_QUOTE)).toBeCloseTo(2, 9);
    expect(openingPricePerToken(typed, tokensOf(w), 6, USDC_QUOTE)).toBeCloseTo(2_000, 6);
    const s = summaryOf(ok(await create(w, { quote: typed })));
    expect(s.warnings[0]).toMatch(/^Your opening price is 99900\.0% above the market price/);
    expect(s.price).toMatchObject({ state: 'disagrees', pool: 2_000 });
  });

  it.each(COIN_ROWS)('%s: no account for the coin, or only SOL someone sent to its address, is said as holding none of it', async (_n, quote) => {
    const none = world(quote, { heldQuote: null });
    expect(refused(await create(none))).toBe(LP_COPY.noCoinAccount(quote.symbol, none.quoteAta.toBase58()));
    const sent = world(quote, { heldQuote: null });
    sent.chain.fund(sent.quoteAta, rent(0));
    expect(refused(await create(sent))).toBe(LP_COPY.noCoinAccount(quote.symbol, sent.quoteAta.toBase58()));
  });

  it.each(COIN_ROWS)('%s: too little of the coin is said in the coin’s own words, never as SOL', async (_n, quote) => {
    const msg = refused(await create(world(quote, { heldQuote: 150n * U6 })));
    expect(msg).toBe(`This needs up to 200 ${quote.symbol} and your wallet has 150 ${quote.symbol}.`);
    expect(msg).not.toMatch(/SOL|stay open on the network/);
    // Exactly what the wallet holds can go in.
    ok(await create(world(quote, { heldQuote: COINS })));
    expect(refused(await create(world(quote, { heldQuote: COINS - 1n })))).toBe(`This needs up to 200 ${quote.symbol} and your wallet has 199.999999 ${quote.symbol}.`);
  });

  it('the coin’s account: another wallet’s, frozen, not a token account, or (BAYLA, under Token-2022) with CPI Guard on', async () => {
    const foreign = world(USDC_QUOTE, { quoteAccount: { owner: STRANGER } });
    expect(refused(await create(foreign))).toBe(LP_COPY.foreignOwner(foreign.quoteAta.toBase58(), STRANGER.toBase58()));
    // A USDC account is frozen by USDC's own issuer, not by the token's.
    expect(refused(await create(world(USDC_QUOTE, { quoteAccount: { state: 2 } })))).toBe('Your USDC account is frozen by its issuer, so nothing can move out of it.');
    const other = world(USDC_QUOTE, { heldQuote: null });
    other.chain.set(other.quoteAta, { lamports: rent(165), owner: STRANGER, data: new Uint8Array(165) });
    expect(refused(await create(other))).toBe(LP_COPY.notUsable('USDC', other.quoteAta.toBase58()));
    // Said in BAYLA's name, never "this token": it is the BAYLA account that has the guard on.
    expect(refused(await create(world(BAYLA_QUOTE, { quoteAccount: { cpiGuard: true } })))).toBe(
      'Your BAYLA account has CPI Guard switched on, which stops a pool taking BAYLA from it. Switch it off in your wallet, then try again.',
    );
    ok(await create(world(BAYLA_QUOTE, { quoteAccount: { cpiGuard: false } })));
  });

  // Whole-change review 2026-10-04 (L4). An opening spends from the same two accounts a
  // withdrawal later pays into, and a withdrawal is refused while either has an approved
  // spender. The opening built with no word about it; now its review says so.
  it.each(COIN_ROWS)('%s: an approved spender on the coin’s account or the token’s: the opening builds, and its review says what this site will not do until it is revoked', async (_n, quote) => {
    const approved = { delegate: STRANGER, delegatedAmount: 25n * U6 };
    const w = world(quote);
    if (quote.program === TOKEN_2022_PROGRAM_ID.toBase58()) w.chain.token2022Account(w.quoteAta, w.quoteMint, ME, 50_000n * U6, approved);
    else w.chain.tokenAccount(w.quoteAta, w.quoteMint, ME, 50_000n * U6, approved);
    expect(summaryOf(ok(await create(w))).notices).toEqual([
      `An approved spender (${STRANGER.toBase58()}) can move up to 25 out of your ${quote.symbol} account (${w.quoteAta.toBase58()}). This site will not pay a withdrawal into that account until you revoke that approval.`,
    ]);
    const t = world(quote);
    t.chain.tokenAccount(t.tokenAta, t.mint, ME, 1_000n * U6, approved);
    expect(summaryOf(ok(await create(t))).notices).toEqual([LP_COPY.delegatedSource(STRANGER.toBase58(), '25', 'token', t.tokenAta.toBase58())]);
    // No approval, nothing said.
    expect(summaryOf(ok(await create(world(quote)))).notices).toEqual([]);
  });

  it('the token’s side is judged as ever: no account for it, or too few tokens', async () => {
    const none = world(USDC_QUOTE, { heldTokens: null });
    expect(refused(await create(none))).toBe(LP_COPY.noTokenAccount(none.tokenAta.toBase58()));
    expect(refused(await create(world(BAYLA_QUOTE, { heldTokens: 50n * U6 })))).toBe('This needs up to 100 tokens and your wallet has 50 tokens.');
  });

  it.each(COIN_ROWS)('%s: a wallet with the coin but not the SOL for the fee to open and the deposits is told how much SOL it needs', async (_n, quote) => {
    // The network fee for two signatures, the pool-share account, the fee to open, the
    // pool's own accounts, and what the wallet itself must keep. None of the coin's amount.
    const need = feeReserveFor(2) + R(165) + FEE + NEVER_REFUNDED + R(0);
    expect(solSetAside({ walletFloor: R(0), feeReserve: feeReserveFor(2), lpAccountRent: R(165), wsolCreateRent: 0n, alsoPaid: FEE + NEVER_REFUNDED })).toBe(need);
    const msg = refused(await create(world(quote, { wallet: need - 1n })));
    expect(msg).toBe(CREATE_COPY.needSol(solText(need), solText(need - 1n)));
    // The fee to open is most of the sum, so the sentence names it.
    expect(msg).toBe(
      'Your wallet needs about 0.1940576 SOL for the fee to open, the account deposits and the network fee, and has 0.194057599 SOL. The fee and the deposits are paid in SOL whatever the pool is paired with. Nothing was built.',
    );
    // The rent band is the SOL pool's rule: its words are never said here.
    expect(msg).not.toMatch(/too little SOL|The most you can put in/);
    // With exactly that much SOL it builds, however many coins go in: they are not SOL.
    ok(await create(world(quote, { wallet: need })));
    ok(await create(world(quote, { wallet: need, heldTokens: 20_000n * U6 }), { quote: 40_000n * U6, token: 20_000n * U6 }));
    // A wallet with next to no SOL is told the same thing, before anything is built.
    expect(refused(await create(world(quote, { wallet: 10_000_000n })))).toBe(CREATE_COPY.needSol(solText(need), '0.01 SOL'));
  });

  it('the fee to open is still SOL’s business: the tier’s terms and the fee account are checked the same', async () => {
    const changed = await create(world(USDC_QUOTE), { shown: { terms: { ...TERMS, createPoolFee: 100_000_000n }, standard: 'empty' } });
    expect(refused(changed)).toBe(CREATE_COPY.termsChanged('fee to open 0.1 → 0.15 SOL'));
    expect(refused(await create(world(BAYLA_QUOTE, { feeReceiver: null })))).toBe(CREATE_COPY.feeAccount('there is no account at its address'));
    expect(refused(await create(world(BAYLA_QUOTE, { tier: null })))).toBe(CREATE_COPY.tierNotOpen);
  });
});

// ── the balance check ────────────────────────────────────────────────────────

describe('the balance check for an opening paired with USDC or BAYLA', () => {
  it.each(COIN_ROWS)('%s: SOL pays the fee and the deposits only: one lamport more is blocked, and so is the coin’s amount taken as SOL', async (_n, quote) => {
    // `networkFee`: as a cluster reports a test run, the network fee already taken.
    const shown = world(quote);
    shown.chain.simulate = createSimulator({ networkFee: true });
    expect(outcome(await create(shown))).toBe('prepared');
    for (const extra of [1n, COINS]) {
      const over = world(quote);
      over.chain.simulate = createSimulator({ networkFee: true, feeCharged: (fee) => fee + extra });
      expect(outcome(await create(over)), String(extra)).toMatchObject({ status: 'not-sent', stage: 'simulate', message: BLOCKED_SOL });
    }
  });

  it('a fee one lamport below the one shown lands short of the fee account’s own row', async () => {
    const w = world(USDC_QUOTE);
    w.chain.simulate = createSimulator({ networkFee: true, feeCharged: (fee) => fee - 1n });
    expect(outcome(await create(w))).toMatchObject({ status: 'not-sent', stage: 'simulate', message: BLOCKED_TOKENS });
  });

  it.each(COIN_ROWS)('%s: one coin more than typed leaving, one token more, or one pool share fewer arriving: each is blocked', async (_n, quote) => {
    const coin = world(quote);
    skewTestRun(coin.chain, coin.quoteAta, -1n);
    expect(outcome(await create(coin))).toMatchObject({ status: 'not-sent', stage: 'simulate', message: BLOCKED_TOKENS });

    const tok = world(quote);
    skewTestRun(tok.chain, tok.tokenAta, -1n);
    expect(outcome(await create(tok))).toMatchObject({ status: 'not-sent', stage: 'simulate', message: BLOCKED_TOKENS });

    const lp = world(quote);
    skewTestRun(lp.chain, lp.lpAta, -1n);
    expect(outcome(await create(lp))).toMatchObject({ status: 'not-sent', stage: 'simulate', message: BLOCKED_TOKENS });
  });

  it.each(COIN_ROWS)('%s: a coin sent to the wallet, or a lamport to the fee account, between the balance read and the test run does not block it', async (_n, quote) => {
    const gift = world(quote);
    beforeBalanceRun(gift.chain, () => holdCoin(gift.chain, quote, gift.quoteAta, 50_000n * U6 + 1n));
    expect(moved(ok(await create(gift)), gift.quoteAta)).toBe(1n - COINS);

    const fee = world(quote);
    beforeBalanceRun(fee.chain, () => fee.chain.addFeeReceiver({ unsynced: 1n }));
    expect(moved(ok(await create(fee)), CP_CREATE_POOL_FEE_RECEIVER)).toBe(FEE + 1n);
  });

  it('the fee account set up under the old rent: its sync credit is counted, as for a SOL opening', async () => {
    const surplus = 550_840n;
    const w = world(USDC_QUOTE, { feeReceiver: { reserve: R(165) + surplus } });
    const p = ok(await create(w));
    expect(moved(p, CP_CREATE_POOL_FEE_RECEIVER)).toBe(FEE + surplus);
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([FEE + surplus, NO_CEILING]);
  });

  it('a tier with no fee to open: only the deposits may leave, and the fee account is not expected to move', async () => {
    const free = { ...TERMS, createPoolFee: 0n };
    const w = world(BAYLA_QUOTE, { tier: { createPoolFee: 0n }, feeReceiver: { unsynced: 1_000n } });
    const p = ok(await create(w, { shown: { terms: free, standard: 'empty' } }));
    expect(p.check.expect.maxSolOut).toBe(NEVER_REFUNDED + R(165));
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([0n, NO_CEILING]);
    expect(summaryOf(p).createFee).toBe(0n);
  });

  it('the coin or the SOL gone by the time of the test run: stopped there, in plain words, before any signature', async () => {
    /** Runs `change` on the chain before every test run: what the wallet lost after the build read it. */
    const beforeEveryRun = (w: World, change: (c: FakeChain) => void) => {
      const base = w.chain.simulate;
      w.chain.simulate = (vtx, config, c) => {
        change(c);
        return base(vtx, config, c);
      };
    };
    const stopped = (message: string) => ({ status: 'not-sent', stage: 'simulate', message });

    const coinGone = world(USDC_QUOTE);
    beforeEveryRun(coinGone, (c) => holdCoin(c, USDC_QUOTE, coinGone.quoteAta, COINS - 1n));
    expect(outcome(await create(coinGone))).toMatchObject(stopped('You do not hold that much of the token, or of what it is paired with.'));

    const solGone = world(BAYLA_QUOTE);
    beforeEveryRun(solGone, (c) => c.fund(ME, 1_000_000));
    expect(outcome(await create(solGone))).toMatchObject(stopped('Your wallet does not have enough SOL for this, including the network fee and any one-time account costs.'));

    // Enough to pay, but one lamport left over: less than a wallet may hold.
    const dustLeft = world(BAYLA_QUOTE);
    beforeEveryRun(dustLeft, (c) => c.fund(ME, Number(FEE + NEVER_REFUNDED + R(165)) + 1));
    expect(outcome(await create(dustLeft))).toMatchObject(
      stopped('An account in this transaction would be left below the minimum SOL Solana requires. Add a little SOL and try again.'),
    );
  });

  it('SOL someone sent to the pool-share address comes off what the wallet pays, and the review still states the whole deposit', async () => {
    const w = world(USDC_QUOTE);
    w.chain.fund(w.lpAta, rent(0));
    const p = ok(await create(w));
    const paid = FEE + NEVER_REFUNDED + R(165) - R(0);
    expect(summaryOf(p).origin).toBe('standard');
    expect(p.check.expect.maxSolOut).toBe(paid);
    expect(p.simulated.signerLamportsDelta).toBe(-paid);
    expect(summaryOf(p).rents.lpAccount).toBe(R(165));
  });
});

// ── the summary must be the plan ─────────────────────────────────────────────

describe('createStepsProblem: an opening that is not paired with SOL', () => {
  const pool = fresh();
  const open: IntentStep = { kind: 'pool-create', pool, ammConfig: TIER1, init0: 100n, init1: 7n };
  const want = { pool, ammConfig: TIER1, init0: 100n, init1: 7n, quoteNative: false as const };
  const openAccount = (mint: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID): IntentStep => ({
    kind: 'create-token-account',
    owner: ME,
    mint,
    address: associatedTokenAddress(mint, ME, program),
  });

  it('the pool instruction alone is the plan, with or without the two compute-budget steps', () => {
    expect(createStepsProblem([open], want)).toBeNull();
    expect(createStepsProblem([{ kind: 'compute-limit', units: 1 }, { kind: 'compute-price', microLamports: 1n }, open], want)).toBeNull();
  });

  it('any wrap, sync or close is a mismatch', () => {
    for (const extra of [{ kind: 'wrap-sol', lamports: 1n }, { kind: 'sync-wsol' }, { kind: 'close-wsol' }] as IntentStep[]) {
      expect(createStepsProblem([extra, open], want), extra.kind).toBe('The transaction wraps or unwraps SOL, and this pool is not paired with SOL.');
      expect(createStepsProblem([open, extra], want), extra.kind).toBe('The transaction wraps or unwraps SOL, and this pool is not paired with SOL.');
    }
  });

  it('any account opening is a mismatch: the coin’s, the token’s, wrapped SOL’s or the pool shares’', () => {
    const lpMint = deriveLpMint(CPSWAP, pool);
    for (const step of [openAccount(USDC), openAccount(BAYLA, TOKEN_2022_PROGRAM_ID), openAccount(fresh()), openAccount(WSOL_MINT), openAccount(lpMint)]) {
      expect(createStepsProblem([step, open], want)).toBe('The transaction opens an account, and this opening opens none.');
    }
  });

  it('an opening that differs from the plan in any field, is missing, or is there twice', () => {
    const differs = (over: Partial<Extract<IntentStep, { kind: 'pool-create' }>>) => createStepsProblem([{ ...open, ...over } as IntentStep], want);
    expect(differs({ pool: fresh() })).toMatch(/does not match/);
    expect(differs({ ammConfig: TIER0 })).toMatch(/does not match/);
    expect(differs({ init0: 101n })).toMatch(/does not match/);
    expect(differs({ init1: 6n })).toMatch(/does not match/);
    expect(createStepsProblem([], want)).toMatch(/missing/);
    expect(createStepsProblem([open, open], want)).toMatch(/missing/);
  });

  it('the same lone instruction is NOT a SOL opening’s plan: that one must wrap', () => {
    const solWant = { pool, ammConfig: TIER1, init0: 100n, init1: 7n, sol: 100n, closeAfter: true, wsolAta: associatedTokenAddress(WSOL_MINT, ME) };
    expect(createStepsProblem([open], solWant)).toBe('The SOL wrapped for the opening does not match the amount to put in.');
  });
});

// ── the pins ─────────────────────────────────────────────────────────────────

describe('createPins for a coin that is not SOL', () => {
  it.each(COIN_ROWS)('%s: the coin on its sorted side under its own program, and "standard" only at THIS pair’s standard address', (_n, quote) => {
    const tokenMint = fresh();
    const quoteMint = new PublicKey(quote.mint);
    // The token under the OTHER token program than the coin's, so a swapped program shows.
    const tokenProgram = quote.program === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const { token0, token1 } = sortMints(quoteMint, tokenMint);
    const standard = derivePool(CPSWAP, TIER1, token0, token1);
    const solPair = sortMints(WSOL_MINT, tokenMint);
    const base = { tokenMint, tokenProgram, signer: ME, quote };
    const std = createPins(cfgLocal, { ...base, address: standard });
    const other = createPins(cfgLocal, { ...base, address: fresh() });
    // The SOL pair's standard address for this token is just another address to this pair.
    const atSolStandard = createPins(cfgLocal, { ...base, address: derivePool(CPSWAP, TIER1, solPair.token0, solPair.token1) });
    if (typeof std === 'string' || typeof other === 'string' || typeof atSolStandard === 'string') throw new Error('no pins');
    expect([std.origin, other.origin, atSolStandard.origin]).toEqual(['standard', 'other', 'other']);
    for (const p of [std, other]) {
      const quoteIsToken0 = token0.equals(quoteMint);
      expect(p.quote).toBe(quote);
      expect(p.quoteIsToken0).toBe(quoteIsToken0);
      expect([p.token0Mint.toBase58(), p.token1Mint.toBase58()]).toEqual([token0.toBase58(), token1.toBase58()]);
      expect((quoteIsToken0 ? p.token0Program : p.token1Program).toBase58()).toBe(quote.program);
      expect((quoteIsToken0 ? p.token1Program : p.token0Program).equals(tokenProgram)).toBe(true);
      expect(p.tokenMint.equals(tokenMint) && p.tokenProgram.equals(tokenProgram)).toBe(true);
      expect(p.ammConfig.equals(TIER1)).toBe(true);
      expect(p.lpMint.equals(deriveLpMint(CPSWAP, p.address))).toBe(true);
      expect(p.vault0.equals(deriveVault(CPSWAP, p.address, token0))).toBe(true);
      expect(p.vault1.equals(deriveVault(CPSWAP, p.address, token1))).toBe(true);
      expect(p.observation.equals(deriveObservation(CPSWAP, p.address))).toBe(true);
      // Pool shares are always a classic token, whatever the coin's program.
      expect(p.lpAccount.equals(associatedTokenAddress(p.lpMint, ME, TOKEN_PROGRAM_ID))).toBe(true);
    }
  });

  it('no pins for a pair this site reads the other way round, a coin priced in itself, or SOL as the token', () => {
    const at = { address: fresh(), tokenProgram: TOKEN_PROGRAM_ID, signer: ME };
    expect(createPins(cfgLocal, { ...at, tokenMint: USDC, quote: BAYLA_QUOTE })).toBe('this site does not open a pool that prices this token in BAYLA');
    expect(createPins(cfgLocal, { ...at, tokenMint: USDC, quote: USDC_QUOTE })).toBe('this site does not open a pool that prices this token in USDC');
    expect(createPins(cfgLocal, { ...at, tokenMint: BAYLA, tokenProgram: TOKEN_2022_PROGRAM_ID, quote: BAYLA_QUOTE })).toBe('this site does not open a pool that prices this token in BAYLA');
    expect(typeof createPins(cfgLocal, { ...at, tokenMint: WSOL_MINT, quote: USDC_QUOTE })).toBe('string');
    // The right way round has pins.
    expect(typeof createPins(cfgLocal, { ...at, tokenMint: BAYLA, tokenProgram: TOKEN_2022_PROGRAM_ID, quote: USDC_QUOTE })).toBe('object');
    expect(typeof createPins(cfgLocal, { ...at, tokenMint: USDC, quote: SOL_QUOTE })).toBe('object');
  });
});

// ── the transaction checker ──────────────────────────────────────────────────

describe('decodeIntent: opening a pool paired with USDC or BAYLA', () => {
  /** The pins prepare would make: this pair's standard address, or a fresh key of its own. */
  function pinsFor(quote: QuoteCoin, o: { tokenProgram?: PublicKey; oneOff?: boolean; tokenMint?: PublicKey; address?: PublicKey } = {}): PoolPins {
    const tokenMint = o.tokenMint ?? fresh();
    const { token0, token1 } = sortMints(new PublicKey(quote.mint), tokenMint);
    const address = o.address ?? (o.oneOff ? fresh() : derivePool(CPSWAP, TIER1, token0, token1));
    const p = createPins(cfgLocal, { address, tokenMint, tokenProgram: o.tokenProgram ?? TOKEN_PROGRAM_ID, signer: ME, quote });
    if (typeof p === 'string') throw new Error(p);
    return p;
  }
  const ctxFor = (pins: PoolPins): PoolIntent => ({ kind: 'lp-create', signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins });
  const mine = (mint: PublicKey, program: PublicKey) => associatedTokenAddress(mint, ME, program);
  const wsolAta = mine(WSOL_MINT, TOKEN_PROGRAM_ID);

  /** The site's own opening instruction for these pins. */
  function opening(p: PoolPins, o: Partial<{ init0: bigint; init1: bigint; openTime: bigint; ammConfig: PublicKey }> = {}) {
    return initializeIx({
      programId: CPSWAP,
      creator: ME,
      ammConfig: o.ammConfig ?? TIER1,
      token0Mint: p.token0Mint,
      token1Mint: p.token1Mint,
      creatorToken0: mine(p.token0Mint, p.token0Program),
      creatorToken1: mine(p.token1Mint, p.token1Program),
      creatorLpToken: p.lpAccount,
      token0Program: p.token0Program,
      token1Program: p.token1Program,
      createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
      initAmount0: o.init0 ?? 1_000_000_000n,
      initAmount1: o.init1 ?? 5_000_000_000n,
      openTime: o.openTime ?? 0n,
      poolState: p.origin === 'other' ? p.address : undefined,
    });
  }
  /** The whole transaction the site builds for a coin that is not SOL: the pool instruction, and nothing around it. */
  const siteOpening = (p: PoolPins, ix: TransactionInstruction = opening(p)) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix];
  const createAta = (mint: PublicKey, program: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(ME, mine(mint, program), ME, mint, program);
  const withKey = (ix: TransactionInstruction, i: number, pubkey: PublicKey) =>
    new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k, n) => (n === i ? { ...k, pubkey } : k)), data: ix.data });
  const reasonOf = (r: ReturnType<typeof decodeIntent>) => (r.ok ? 'accepted' : r.reason);
  const judge = (ixs: TransactionInstruction[], pins: PoolPins) => reasonOf(decodeIntent(ixs, ctxFor(pins)));
  const otherProgram = (program: PublicKey) => (program.equals(TOKEN_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);

  it.each(COIN_ROWS)('%s: the site’s own opening is one pool-create and nothing else, at the standard address and at a one-off one', (_n, quote) => {
    for (const oneOff of [false, true]) {
      const p = pinsFor(quote, { oneOff });
      expect(p.origin).toBe(oneOff ? 'other' : 'standard');
      const r = decodeIntent(siteOpening(p), ctxFor(p));
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (r.ok) {
        expect(r.steps.map((s) => s.kind)).toEqual(['compute-limit', 'pool-create']);
        expect(r.steps[1]).toEqual({ kind: 'pool-create', pool: p.address, ammConfig: TIER1, init0: 1_000_000_000n, init1: 5_000_000_000n });
      }
    }
  });

  it('the token under Token-2022 beside a classic coin, and a classic token beside BAYLA: each side’s own program, and the owner’s real pair too', () => {
    for (const p of [
      pinsFor(USDC_QUOTE, { tokenProgram: TOKEN_2022_PROGRAM_ID }),
      pinsFor(BAYLA_QUOTE, { tokenProgram: TOKEN_PROGRAM_ID }),
      pinsFor(BAYLA_QUOTE, { tokenProgram: TOKEN_2022_PROGRAM_ID }),
      pinsFor(USDC_QUOTE, { tokenMint: BAYLA, tokenProgram: TOKEN_2022_PROGRAM_ID }),
    ]) {
      expect(judge(siteOpening(p), p)).toBe('accepted');
    }
  });

  describe.each(COIN_ROWS)('%s: every one of the 20 slots, replaced', (_n, quote) => {
    const p = pinsFor(quote);
    const reasons: Array<[number, RegExp]> = [
      [0, /opened and paid for by someone else/],
      [1, /fee tier this site does not use/],
      [2, /wrong pool authority/],
      [3, /creates a different pool than the one checked/],
      [4, /pairs different tokens than the review names/],
      [5, /pairs different tokens than the review names/],
      [6, /wrong pool-share token/],
      [7, /spends from an account that is not yours/],
      [8, /spends from an account that is not yours/],
      [9, /pool shares go to an account that is not yours/],
      [10, /wrong pool vault/],
      [11, /wrong pool vault/],
      [12, /fee to open a pool goes somewhere other than the pool program's fee account/],
      [13, /wrong price record/],
      [14, /wrong token program/],
      [15, /wrong token program/],
      [16, /wrong token program/],
      [17, /wrong system program/],
      [18, /wrong system program/],
      [19, /wrong system program/],
    ];

    it('the table covers every slot', () => {
      expect(reasons.map(([i]) => i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(opening(p).keys).toHaveLength(20);
    });

    it.each(reasons)('slot %i replaced by a stranger’s key is refused', (slot, why) => {
      expect(judge(siteOpening(p, withKey(opening(p), slot, fresh())), p)).toMatch(why);
    });
  });

  it.each(COIN_ROWS)('%s: the coin’s program sits in the coin’s slot, and the creator’s coin account is the associated one under THAT program', (_n, quote) => {
    const quoteMint = new PublicKey(quote.mint);
    const program = new PublicKey(quote.program);
    // The token under the other program, so the two program slots differ.
    const p = pinsFor(quote, { tokenProgram: otherProgram(program) });
    const side = p.quoteIsToken0 ? 0 : 1;
    const ix = opening(p);
    expect(ix.keys[15 + side]!.pubkey.equals(program)).toBe(true);
    expect(ix.keys[16 - side]!.pubkey.equals(otherProgram(program))).toBe(true);
    expect(ix.keys[7 + side]!.pubkey.equals(mine(quoteMint, program))).toBe(true);
    expect(judge(siteOpening(p), p)).toBe('accepted');
    // The other token program in the coin's program slot.
    expect(judge(siteOpening(p, withKey(ix, 15 + side, otherProgram(program))), p)).toMatch(/wrong token program/);
    // The signer's account for the coin, but derived under the other program: another address.
    expect(judge(siteOpening(p, withKey(ix, 7 + side, mine(quoteMint, otherProgram(program)))), p)).toMatch(/spends from an account that is not yours/);
    // A stranger's account for the coin, under the right program.
    expect(judge(siteOpening(p, withKey(ix, 7 + side, associatedTokenAddress(quoteMint, STRANGER, program))), p)).toMatch(/spends from an account that is not yours/);
    // The pool shares go to the signer's classic account, never one under the coin's program.
    expect(judge(siteOpening(p, withKey(ix, 9, associatedTokenAddress(p.lpMint, STRANGER, TOKEN_PROGRAM_ID))), p)).toMatch(/pool shares go to an account that is not yours/);
  });

  it.each(COIN_ROWS)('%s: any associated-account creation is refused: the coin’s, the token’s, wrapped SOL’s and the pool shares’', (_n, quote) => {
    const p = pinsFor(quote);
    const none = /an opening of a pool that is not paired with SOL creates no account of yours/;
    expect(judge([createAta(new PublicKey(quote.mint), new PublicKey(quote.program)), ...siteOpening(p)], p)).toMatch(none);
    expect(judge([createAta(p.tokenMint, p.tokenProgram), ...siteOpening(p)], p)).toMatch(none);
    expect(judge([createAta(WSOL_MINT, TOKEN_PROGRAM_ID), ...siteOpening(p)], p)).toMatch(none);
    expect(judge([createAta(fresh(), TOKEN_PROGRAM_ID), ...siteOpening(p)], p)).toMatch(none);
    expect(judge([createAta(p.lpMint, TOKEN_PROGRAM_ID), ...siteOpening(p)], p)).toMatch(/pool program opens your pool-share account itself/);
    // After the pool instruction is no better than before it.
    expect(judge([...siteOpening(p), createAta(new PublicKey(quote.mint), new PublicKey(quote.program))], p)).toMatch(none);
  });

  it.each(COIN_ROWS)('%s: any wrapping is refused: a transfer into the wrapped-SOL account, a sync, a close', (_n, quote) => {
    const p = pinsFor(quote);
    expect(judge([SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsolAta, lamports: 5 }), ...siteOpening(p)], p)).toMatch(/it wraps SOL, and this pool is not paired with SOL/);
    expect(judge([createSyncNativeInstruction(wsolAta), ...siteOpening(p)], p)).toMatch(/it wraps SOL, and this pool is not paired with SOL/);
    expect(judge([...siteOpening(p), createCloseAccountInstruction(wsolAta, ME, ME)], p)).toMatch(/it unwraps SOL, and this pool is not paired with SOL/);
    // The whole SOL-style opening, around this pair's own pool instruction.
    const solStyle = [
      createAta(WSOL_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsolAta, lamports: 1_000_000_000 }),
      createSyncNativeInstruction(wsolAta),
      opening(p),
      createCloseAccountInstruction(wsolAta, ME, ME),
    ];
    expect(judge(solStyle, p)).not.toBe('accepted');
    // A plain SOL transfer to anyone, a create-account, or a token transfer stay refused too.
    expect(judge([SystemProgram.transfer({ fromPubkey: ME, toPubkey: STRANGER, lamports: 5 }), ...siteOpening(p)], p)).not.toBe('accepted');
    expect(judge([SystemProgram.createAccount({ fromPubkey: ME, newAccountPubkey: fresh(), lamports: 1, space: 82, programId: TOKEN_PROGRAM_ID }), ...siteOpening(p)], p)).toMatch(/never creates an account/);
  });

  it('the pins cannot name a coin of their own: a coin off the list, or one on the wrong side, is refused', () => {
    const p = pinsFor(USDC_QUOTE);
    const ixs = siteOpening(p);
    const with_ = (over: Partial<PoolPins>) => reasonOf(decodeIntent(ixs, ctxFor({ ...p, ...over })));
    const offList = /paired with a coin this site does not build for/;
    const wrongSide = /pairing coin is not where the review says it is/;
    expect(with_({})).toBe('accepted');
    expect(with_({ quote: { ...USDC_QUOTE, mint: fresh().toBase58() } })).toMatch(offList);
    // USDC's mint with the "wrap it like SOL" flag, another program or other decimals is not the row on the list.
    expect(with_({ quote: { ...USDC_QUOTE, native: true } })).toMatch(offList);
    expect(with_({ quote: { ...USDC_QUOTE, program: TOKEN_2022_PROGRAM_ID.toBase58() } })).toMatch(offList);
    expect(with_({ quote: { ...USDC_QUOTE, decimals: 9 } })).toMatch(offList);
    // A real coin, but not the one on this pool's coin side.
    expect(with_({ quote: BAYLA_QUOTE })).toMatch(wrongSide);
    expect(with_({ quote: SOL_QUOTE })).toMatch(wrongSide);
    expect(with_({ quoteIsToken0: !p.quoteIsToken0 })).toMatch(wrongSide);
    // The token side must be the token the review names, under its program.
    expect(with_({ tokenMint: fresh() })).toMatch(/the pool’s token is not where the review says it is/);
    expect(with_({ tokenProgram: TOKEN_2022_PROGRAM_ID })).toMatch(/the pool’s token is not where the review says it is/);
  });

  it('a pair this site reads the other way round is refused, though every account in the transaction is the same', () => {
    // BAYLA priced in USDC is a pair. USDC priced in BAYLA is the same pool read backwards.
    const right = pinsFor(USDC_QUOTE, { tokenMint: BAYLA, tokenProgram: TOKEN_2022_PROGRAM_ID });
    const ixs = siteOpening(right);
    expect(judge(ixs, right)).toBe('accepted');
    const backwards: PoolPins = { ...right, tokenMint: USDC, tokenProgram: TOKEN_PROGRAM_ID, quote: BAYLA_QUOTE, quoteIsToken0: !right.quoteIsToken0 };
    expect(judge(ixs, backwards)).toMatch(/pairs this token with a coin this site does not pair it with/);
    // SOL as the token of a USDC pool: the same rule.
    const usdcInSol = pinsFor(SOL_QUOTE, { tokenMint: USDC });
    const solInUsdc: PoolPins = { ...usdcInSol, tokenMint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID, quote: USDC_QUOTE, quoteIsToken0: !usdcInSol.quoteIsToken0 };
    expect(judge(siteOpening(usdcInSol), solInUsdc)).toMatch(/pairs this token with a coin this site does not pair it with/);
  });

  it('one pair’s opening is not another pair’s: USDC bytes under SOL pins, and SOL bytes under USDC pins, at the same address', () => {
    const tokenMint = fresh();
    const address = fresh();
    const usdc = pinsFor(USDC_QUOTE, { tokenMint, address });
    const sol = pinsFor(SOL_QUOTE, { tokenMint, address });
    expect(judge(siteOpening(usdc), sol)).toMatch(/pairs different tokens than the review names/);
    expect(judge(siteOpening(sol), usdc)).toMatch(/pairs different tokens than the review names/);
    // At each pair's own standard address the pool itself already differs.
    expect(judge(siteOpening(pinsFor(USDC_QUOTE, { tokenMint })), pinsFor(SOL_QUOTE, { tokenMint }))).toMatch(/creates a different pool than the one checked/);
  });

  it.each(COIN_ROWS)('%s: the fee tier, the fee account and the address are pinned as for SOL', (_n, quote) => {
    const tokenMint = fresh();
    const p = pinsFor(quote, { tokenMint });
    expect(judge(siteOpening(p, withKey(opening(p), 1, TIER0)), p)).toMatch(/launch tier \(fee tier 0\), which this site never does/);
    expect(judge(siteOpening(p, withKey(opening(p), 12, mine(WSOL_MINT, TOKEN_PROGRAM_ID))), p)).toMatch(/fee to open a pool goes somewhere other than the pool program's fee account/);
    // A pool built on tier 0 from the start, at tier 0's own standard address for this pair.
    const tier0: PoolPins = { ...p, address: derivePool(CPSWAP, TIER0, p.token0Mint, p.token1Mint), origin: 'other' };
    expect(judge(siteOpening(tier0, opening(tier0, { ammConfig: TIER0 })), tier0)).toMatch(/launch tier/);
    // The origin must be the truth about the address, and never a launch pool's.
    const oneOff = pinsFor(quote, { tokenMint, oneOff: true });
    const lies: Array<[PoolPins, PoolPins]> = [
      [{ ...oneOff, origin: 'standard' }, oneOff],
      [{ ...p, origin: 'other' }, p],
      [{ ...p, origin: 'launch-pool' }, p],
    ];
    for (const [lie, real] of lies) expect(judge(siteOpening(lie, opening(real)), lie)).toMatch(/pool's address does not match the review/);
    // The SOL pair's standard address is not this pair's standard address.
    const solPair = sortMints(WSOL_MINT, tokenMint);
    const atSol: PoolPins = { ...pinsFor(quote, { tokenMint, address: derivePool(CPSWAP, TIER1, solPair.token0, solPair.token1) }), origin: 'standard' };
    expect(judge(siteOpening(atSol, opening({ ...atSol, origin: 'other' })), atSol)).toMatch(/pool's address does not match the review/);
  });

  it('the arguments are judged as for SOL: open now, no empty side, the locked part at most 0.1%, 20 accounts, one opening', () => {
    const p = pinsFor(BAYLA_QUOTE);
    expect(judge(siteOpening(p, opening(p, { openTime: 1n })), p)).toMatch(/open for trading later, not now/);
    expect(judge(siteOpening(p, opening(p, { init0: 0n })), p)).toMatch(/open with an empty side/);
    expect(judge(siteOpening(p, opening(p, { init0: 99_999n, init1: 99_999n })), p)).toMatch(/keep more than 0\.1%/);
    expect(judge(siteOpening(p, opening(p, { init0: 100_000n, init1: 100_000n })), p)).toBe('accepted');
    const ix = opening(p);
    const longer = new TransactionInstruction({ programId: ix.programId, keys: [...ix.keys, { pubkey: fresh(), isSigner: false, isWritable: false }], data: ix.data });
    expect(judge(siteOpening(p, longer), p)).toMatch(/has 21 accounts, expected 20/);
    expect(judge([...siteOpening(p), opening(p)], p)).toMatch(/does not open exactly one pool/);
    expect(judge([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })], p)).toMatch(/does not open exactly one pool/);
  });
});

// ── the price check, in the coin ─────────────────────────────────────────────

describe('assessOpening: the price is checked in the pool’s own coin', () => {
  const mint = fresh().toBase58();
  const SAFE: TokenSafety = { kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
  const at = (
    quote: QuoteCoin,
    o: { coins?: bigint; tokens?: bigint; decimals?: number; token?: OutsidePrice | null; coin?: OutsidePrice | null; tokenMint?: string } = {},
  ) =>
    assessOpening({
      tokenMint: o.tokenMint ?? mint,
      quote,
      quoteAmount: o.coins ?? COINS,
      token: o.tokens ?? 100n * U6,
      tokenDecimals: o.decimals ?? 6,
      outside: o.token === undefined ? price(0.01) : o.token,
      coinOutside: o.coin === undefined ? price(0.005) : o.coin,
      safety: SAFE,
    });

  it.each(COIN_ROWS)('%s: at the market, the token’s SOL price over the coin’s own: allowed, with the comparison in coins', (_n, quote) => {
    const c = at(quote);
    expect(c).toMatchObject({ verdict: 'allowed', reasons: [], price: { state: 'agrees', against: 'outside' } });
    expect(c.price.state === 'agrees' && [c.price.pool, c.price.reference]).toEqual([2, 2]);
    // A 9-decimal token beside the 6-decimal coin is the same price.
    expect(at(quote, { tokens: 100n * 10n ** 9n, decimals: 9 }).verdict).toBe('allowed');
  });

  it('2.9% off agrees; 3.1% is allowed with a warning that names the gap, whichever side of the market', () => {
    expect(at(USDC_QUOTE, { coins: 205_800_000n })).toMatchObject({ verdict: 'allowed', warnings: [] });
    const above = at(USDC_QUOTE, { coins: 206_200_000n });
    expect(above).toMatchObject({ verdict: 'allowed', reasons: [], price: { state: 'disagrees' } });
    expect(above.warnings).toEqual(['Your opening price is 3.1% above the market price (Jupiter). The first trades would move it to the market price, at your cost.']);
    expect(at(BAYLA_QUOTE, { coins: 193_800_000n }).warnings[0]).toMatch(/3\.1% below the market price/);
  });

  it.each(COIN_ROWS)('%s: the coin’s own price not read, not asked for, without a route, or not a usable number: unchecked, never allowed', (_n, quote) => {
    const unread = at(quote, { coin: { kind: 'unread', detail: 'HTTP 502' } });
    expect(unread).toMatchObject({ verdict: 'unchecked', price: { state: 'unread' } });
    expect(unread.reasons).toEqual([`We could not get a market price from Jupiter (the price of ${quote.symbol} could not be read (HTTP 502)).`]);
    const notAsked = at(quote, { coin: null });
    expect(notAsked.verdict).toBe('unchecked');
    expect(notAsked.reasons).toEqual([`We could not get a market price from Jupiter (the price of ${quote.symbol} was not read).`]);
    // "No route" for the COIN is a failed read, never "this token has no market".
    const noRoute = at(quote, { coin: { kind: 'no-route', detail: 'no route' } });
    expect(noRoute.verdict).toBe('unchecked');
    expect(noRoute.reasons.join(' ')).not.toMatch(/no market price for this token/);
    expect(at(quote, { coin: price(0) }).verdict).toBe('unchecked');
  });

  it('the token without a route is allowed as "no market" whatever the coin’s price says, and the token unread is unchecked, as for SOL', () => {
    for (const coin of [price(0.005), { kind: 'unread', detail: 'HTTP 502' } as OutsidePrice, null]) {
      const c = at(USDC_QUOTE, { token: { kind: 'no-route', detail: 'no route' }, coin });
      expect(c).toMatchObject({ verdict: 'allowed', reasons: [], price: { state: 'no-market', pool: 2 } });
      expect(c.warnings).toHaveLength(1);
      expect(c.warnings[0]).toMatch(/^Jupiter has no market price for this token, so there is nothing to compare your opening price with\./);
    }
    expect(at(USDC_QUOTE, { token: { kind: 'unread', detail: 'HTTP 502' } })).toMatchObject({ verdict: 'unchecked', warnings: [] });
    expect(at(USDC_QUOTE, { token: null })).toMatchObject({ verdict: 'unchecked', warnings: [] });
  });

  it('a SOL opening never looks at a coin price', () => {
    const c = at(SOL_QUOTE, { coins: SOL, coin: { kind: 'unread', detail: 'HTTP 502' } });
    expect(c).toMatchObject({ verdict: 'allowed', price: { state: 'agrees', pool: 0.01, reference: 0.01 } });
  });

  it('the units cannot be mixed up: the SOL price is not the coin price, and the coin has its own decimals', () => {
    // 0.01 USDC a token equals the token's SOL price, and is 99.5% below its price in USDC.
    const asSol = at(USDC_QUOTE, { coins: 1n * U6 });
    expect(asSol.price.state).toBe('disagrees');
    expect(asSol.warnings[0]).toMatch(/99\.5% below the market price/);
    // 200,000,000,000 units is 2 a token only at nine decimals. USDC has six: 2,000 a token.
    const asLamports = at(USDC_QUOTE, { coins: 200n * 10n ** 9n });
    expect(asLamports.warnings[0]).toMatch(/99900\.0% above the market price/);
    expect(asLamports.price.state === 'disagrees' && asLamports.price.pool).toBeCloseTo(2_000, 6);
  });

  it('a pair this site reads the other way round, a coin in itself, and SOL as the token are refused by name', () => {
    expect(at(BAYLA_QUOTE, { tokenMint: USDC_QUOTE.mint }).reasons).toContain('This site does not open a pool that prices this token in BAYLA.');
    expect(at(USDC_QUOTE, { tokenMint: USDC_QUOTE.mint }).reasons).toContain('This site does not open a pool that prices this token in USDC.');
    expect(at(BAYLA_QUOTE, { tokenMint: BAYLA_QUOTE.mint }).reasons).toContain('This site does not open a pool that prices this token in BAYLA.');
    expect(at(USDC_QUOTE, { tokenMint: WSOL_MINT.toBase58() })).toMatchObject({ verdict: 'refused' });
    // The right way round is judged on its price alone.
    expect(at(USDC_QUOTE, { tokenMint: BAYLA_QUOTE.mint }).verdict).toBe('allowed');
  });
});

describe('the opening helpers in a coin that is not SOL', () => {
  it('openingPricePerToken: whole coins per whole token, in the coin’s own decimals', () => {
    expect(openingPricePerToken(200n * U6, 100n * U6, 6, USDC_QUOTE)).toBe(2);
    expect(openingPricePerToken(200n * U6, 100n * 10n ** 9n, 9, BAYLA_QUOTE)).toBe(2);
    // The same units as lamports are 0.2 SOL: a thousand times less.
    expect(openingPricePerToken(200n * U6, 100n * U6, 6, SOL_QUOTE)).toBeCloseTo(0.002, 12);
    expect(openingPricePerToken(0n, 100n * U6, 6, USDC_QUOTE)).toBeNull();
  });

  it('matchMarket and mostBothAtMarket work in the coin’s own units', () => {
    expect(matchMarket({ keep: 'quote', amount: 200n * U6, pricePerToken: 2, tokenDecimals: 6, quote: USDC_QUOTE })).toBe(100n * U6);
    expect(matchMarket({ keep: 'token', amount: 100n * U6, pricePerToken: 2, tokenDecimals: 6, quote: USDC_QUOTE })).toBe(200n * U6);
    expect(matchMarket({ keep: 'token', amount: 100n * 10n ** 9n, pricePerToken: 2, tokenDecimals: 9, quote: BAYLA_QUOTE })).toBe(200n * U6);
    expect(mostBothAtMarket({ spendableQuote: 200n * U6, tokenBalance: 500n * U6, pricePerToken: 2, tokenDecimals: 6, quote: USDC_QUOTE })).toEqual({ quote: 200n * U6, token: 100n * U6 });
    expect(mostBothAtMarket({ spendableQuote: 200n * U6, tokenBalance: 40n * U6, pricePerToken: 2, tokenDecimals: 6, quote: BAYLA_QUOTE })).toEqual({ quote: 80n * U6, token: 40n * U6 });
  });

  it('arbitrageLoss is in the coin’s base units: nothing at the market, 200 coins when the market is four times the opening price', () => {
    const loss = (market: number) => arbitrageLoss({ quoteAmount: 200n * U6, token: 100n * U6, tokenDecimals: 6, marketPricePerToken: market, quote: USDC_QUOTE });
    expect(loss(2)).toBeCloseTo(0, 3);
    // (√200 − √800)² = 200 whole coins.
    expect(loss(8)).toBeCloseTo(200 * 1e6, 0);
  });
});

// ── size ─────────────────────────────────────────────────────────────────────

describe('size', () => {
  it('the worst case without SOL (a one-off address, both sides under Token-2022, two signatures) leaves 150 bytes for wallet guards', async () => {
    const w = world(BAYLA_QUOTE, { token: 'token-2022' });
    squat(w);
    const p = ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }));
    process.stdout.write(`[size] worst-case opening without SOL: ${p.sizeBytes} of ${TX_SIZE_LIMIT} bytes\n`);
    expect(summaryOf(p).origin).toBe('other');
    expect(p.tx.compileMessage().header.numRequiredSignatures).toBe(2);
    expect(p.sizeBytes).toBeLessThanOrEqual(TX_SIZE_LIMIT - 150);
  });
});
