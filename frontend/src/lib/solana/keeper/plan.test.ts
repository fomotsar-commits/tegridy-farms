// @vitest-environment node
//
// The price keeper's checks: which gaps it takes, how big, and what a Jupiter swap must be
// before the keeper's key signs it. The route_v2 bytes and account order are Jupiter's
// on-chain IDL, and match what its API built for a live quote on 2026-10-31.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../cpswap/ix';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../lp/quotes';
import {
  DEFAULT_LIMITS,
  JUPITER_PROGRAM,
  MAX_LAMPORTS_SPENT,
  ROUTE_V2,
  SHARED_ACCOUNTS_ROUTE_V2,
  decodeJupiterRoute,
  NEW_ACCOUNT_RENT,
  floorSlippageBps,
  jupiterFloor,
  jupiterLegProblem,
  lamportsInCoin,
  lastJupiterSlippage,
  lastPoolMinimum,
  planFor,
  simulationProblem,
  type JupiterLegExpect,
  type Plan,
} from './plan';

const TOKEN = Keypair.generate().publicKey.toBase58();
const view = (quote: QuoteCoin, over: Partial<PoolView> = {}) =>
  ({ address: 'Pool1111111111111111111111111111111111111111', quote, tokenMint: TOKEN, vaultsFrozen: false, ...over }) as unknown as PoolView;
const arb = (over: Partial<Arbitrage> = {}): Arbitrage => ({
  side: 'sell', gap: 0.05, inputMint: TOKEN, outputMint: SOL_QUOTE.mint, amountIn: 1n, outAmount: 1n, tradeUsd: 10, outUsd: 10.5, profitUsd: 0.5,
  lpFeeUsd: 0, venueFeeUsd: 0, creatorFeeUsd: 0, transferFeeUsd: 0, afterPerToken: 1, priceImpact: 0, ...over,
});
const usd = new Map([[SOL_QUOTE.mint, 200], [USDC_QUOTE.mint, 1]]);

describe('planFor: which gaps, and how big', () => {
  it('sizes the round trip in the coin, and the floor from the profit setting', () => {
    const p = planFor(view(SOL_QUOTE), arb({ side: 'buy', tradeUsd: 10 }), usd, DEFAULT_LIMITS) as Plan;
    expect(p.side).toBe('buy');
    expect(p.coinIn).toBe(50_000_000n); // $10 at $200 a SOL
    expect(p.minProfit).toBe(50_000n); // $0.01
    expect(p.coinMint).toBe(SOL_QUOTE.mint);
    expect(p.tokenMint).toBe(TOKEN);
  });

  it('makes a larger gap smaller, to the most a round trip may be', () => {
    const p = planFor(view(USDC_QUOTE), arb({ tradeUsd: 400 }), usd, { ...DEFAULT_LIMITS, maxTradeUsd: 25 }) as Plan;
    expect(p.coinIn).toBe(25_000_000n);
  });

  it('leaves alone what it cannot measure or should not touch', () => {
    expect(planFor(view(BAYLA_QUOTE), arb(), usd, DEFAULT_LIMITS)).toBe('priced in BAYLA');
    expect(planFor(view(SOL_QUOTE, { vaultsFrozen: true }), arb(), usd, DEFAULT_LIMITS)).toBe('a pool vault is frozen');
    expect(planFor(view(SOL_QUOTE), arb({ profitUsd: 0.009 }), usd, DEFAULT_LIMITS)).toBe('listed profit under the floor');
    expect(planFor(view(SOL_QUOTE), arb(), new Map(), DEFAULT_LIMITS)).toBe('no price for the coin');
    expect(planFor(view(SOL_QUOTE), arb({ tradeUsd: 1e-12 }), usd, DEFAULT_LIMITS)).toBe('too small to trade');
  });
});

describe('floorSlippageBps: Jupiter’s minimum, set from the keeper’s own amounts', () => {
  it('is the most slippage whose floor still reaches the need', () => {
    for (const [out, need] of [[10_426_938n, 10_000_000n], [1_000n, 999n], [5n, 5n], [123_456_789n, 1n]] as const) {
      const bps = floorSlippageBps(out, need)!;
      expect(jupiterFloor(out, bps)).toBeGreaterThanOrEqual(need);
      if (bps < 10_000) expect(jupiterFloor(out, bps + 1)).toBeLessThan(need);
    }
  });

  it('is null when Jupiter pays back less than the need', () => {
    expect(floorSlippageBps(999n, 1_000n)).toBeNull();
    expect(floorSlippageBps(0n, 0n)).toBeNull();
  });
});

const owner = Keypair.generate().publicKey;
const coin = new PublicKey(SOL_QUOTE.mint);
const token = new PublicKey(TOKEN);

function routeData(disc: Uint8Array, inAmount: bigint, quoted: bigint, slip: number, platformFee = 0, shared = false, positiveSlip = 0): Buffer {
  const head = Buffer.alloc((shared ? 9 : 8) + 22 + 4);
  Buffer.from(disc).copy(head, 0);
  const at = shared ? 9 : 8;
  head.writeBigUInt64LE(inAmount, at);
  head.writeBigUInt64LE(quoted, at + 8);
  head.writeUInt16LE(slip, at + 16);
  head.writeUInt16LE(platformFee, at + 18);
  head.writeUInt16LE(positiveSlip, at + 20);
  return head; // the route plan (an empty vec here) follows
}

const expectLeg = (over: Partial<JupiterLegExpect> = {}): JupiterLegExpect => ({
  owner,
  inputMint: token,
  inputProgram: TOKEN_2022_PROGRAM_ID,
  outputMint: coin,
  outputProgram: TOKEN_PROGRAM_ID,
  inAmount: 1_000n,
  minOut: 9_000n,
  refused: new Set(),
  untouchable: [],
  ...over,
});
const src = getAssociatedTokenAddressSync(token, owner, true, TOKEN_2022_PROGRAM_ID);
const dst = getAssociatedTokenAddressSync(coin, owner, true, TOKEN_PROGRAM_ID);
const acct = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });

function routeIx(o: { data?: Buffer; keys?: PublicKey[]; signer?: PublicKey; programId?: PublicKey; extra?: PublicKey[] } = {}) {
  const keys = o.keys ?? [owner, src, dst, token, coin, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, JUPITER_PROGRAM, Keypair.generate().publicKey, JUPITER_PROGRAM];
  return new TransactionInstruction({
    programId: o.programId ?? JUPITER_PROGRAM,
    keys: [...keys.map((k, i) => acct(k, i === 0 && (o.signer ?? owner).equals(k))), ...(o.extra ?? []).map((k) => acct(k))],
    data: o.data ?? routeData(ROUTE_V2, 1_000n, 10_000n, 1_000),
  });
}

describe('decodeJupiterRoute', () => {
  it('reads the amounts right after the discriminator (and the shared id)', () => {
    expect(decodeJupiterRoute(routeData(ROUTE_V2, 1_000_000n, 10_426_938n, 37))).toEqual({ shared: false, inAmount: 1_000_000n, quotedOutAmount: 10_426_938n, slippageBps: 37, platformFeeBps: 0, positiveSlippageBps: 0 });
    expect(decodeJupiterRoute(routeData(SHARED_ACCOUNTS_ROUTE_V2, 5n, 6n, 7, 0, true))).toEqual({ shared: true, inAmount: 5n, quotedOutAmount: 6n, slippageBps: 7, platformFeeBps: 0, positiveSlippageBps: 0 });
  });

  it('is null for any other instruction, or one cut short', () => {
    const v1Route = Uint8Array.from([229, 23, 203, 151, 122, 227, 173, 42]);
    expect(decodeJupiterRoute(routeData(v1Route, 1n, 1n, 1))).toBeNull();
    expect(decodeJupiterRoute(routeData(ROUTE_V2, 1n, 1n, 1).subarray(0, 20))).toBeNull();
  });
});

describe('jupiterLegProblem: what the keeper’s key signs', () => {
  it('passes Jupiter’s own swap of the keeper’s coins, at or over the floor', () => {
    expect(jupiterLegProblem(routeIx(), expectLeg())).toBeNull();
    // destination_token_account may also name the keeper's own account
    const keys = [owner, src, dst, token, coin, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, dst, Keypair.generate().publicKey, JUPITER_PROGRAM];
    expect(jupiterLegProblem(routeIx({ keys }), expectLeg())).toBeNull();
  });

  it('refuses another program, another instruction, another amount or a fee', () => {
    expect(jupiterLegProblem(routeIx({ programId: Keypair.generate().publicKey }), expectLeg())).toMatch(/not a call into Jupiter/);
    expect(jupiterLegProblem(routeIx({ data: Buffer.alloc(40) }), expectLeg())).toMatch(/not a route_v2/);
    expect(jupiterLegProblem(routeIx({ data: routeData(ROUTE_V2, 1_001n, 10_000n, 1_000) }), expectLeg())).toMatch(/spends 1001, not 1000/);
    expect(jupiterLegProblem(routeIx({ data: routeData(ROUTE_V2, 1_000n, 10_000n, 1_000, 50) }), expectLeg())).toMatch(/platform fee/);
    expect(jupiterLegProblem(routeIx({ data: routeData(ROUTE_V2, 1_000n, 10_000n, 1_000, 0, false, 10) }), expectLeg())).toMatch(/better price/);
  });

  it('refuses a route that names the keeper’s other coin account anywhere', () => {
    const otherFloat = getAssociatedTokenAddressSync(new PublicKey(USDC_QUOTE.mint), owner, true, TOKEN_PROGRAM_ID);
    expect(jupiterLegProblem(routeIx(), expectLeg({ untouchable: [otherFloat] }))).toBeNull();
    expect(jupiterLegProblem(routeIx({ extra: [otherFloat] }), expectLeg({ untouchable: [otherFloat] }))).toMatch(/another of the keeper/);
  });

  it('refuses a minimum under the floor, by one unit', () => {
    // 10000 × (10000 − 1000) / 10000 = 9000: exactly the floor passes, one more refuses
    expect(jupiterLegProblem(routeIx(), expectLeg({ minOut: 9_000n }))).toBeNull();
    expect(jupiterLegProblem(routeIx(), expectLeg({ minOut: 9_001n }))).toMatch(/under the floor/);
  });

  it('refuses another signer, another wallet’s accounts, a payout elsewhere and other coins', () => {
    const stranger = Keypair.generate().publicKey;
    const theirs = getAssociatedTokenAddressSync(coin, stranger, true, TOKEN_PROGRAM_ID);
    const base = [owner, src, dst, token, coin, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, JUPITER_PROGRAM, Keypair.generate().publicKey, JUPITER_PROGRAM];
    const swap = (i: number, k: PublicKey) => base.map((x, j) => (j === i ? k : x));
    const signed = routeIx();
    signed.keys.push({ pubkey: stranger, isSigner: true, isWritable: false });
    expect(jupiterLegProblem(signed, expectLeg())).toMatch(/another signer/);
    expect(jupiterLegProblem(routeIx({ keys: swap(0, stranger), signer: stranger }), expectLeg())).toMatch(/another signer/);
    expect(jupiterLegProblem(routeIx({ keys: swap(1, theirs) }), expectLeg())).toMatch(/another wallet/);
    expect(jupiterLegProblem(routeIx({ keys: swap(2, theirs) }), expectLeg())).toMatch(/another wallet/);
    expect(jupiterLegProblem(routeIx({ keys: swap(7, theirs) }), expectLeg())).toMatch(/pays out to another account/);
    expect(jupiterLegProblem(routeIx({ keys: swap(4, stranger) }), expectLeg())).toMatch(/other coins/);
  });

  it('checks the shared-accounts layout too', () => {
    const data = routeData(SHARED_ACCOUNTS_ROUTE_V2, 1_000n, 10_000n, 1_000, 0, true);
    const auth = Keypair.generate().publicKey;
    const keys = [auth, owner, src, Keypair.generate().publicKey, Keypair.generate().publicKey, dst, token, coin];
    const ix = new TransactionInstruction({ programId: JUPITER_PROGRAM, keys: keys.map((k) => acct(k, k.equals(owner))), data });
    expect(jupiterLegProblem(ix, expectLeg())).toBeNull();
    const elsewhere = new TransactionInstruction({ programId: JUPITER_PROGRAM, keys: keys.map((k, i) => acct(i === 5 ? Keypair.generate().publicKey : k, k.equals(owner))), data });
    expect(jupiterLegProblem(elsewhere, expectLeg())).toMatch(/another wallet/);
  });

  it('refuses a route through a refused venue', () => {
    const raydium = Keypair.generate().publicKey;
    expect(jupiterLegProblem(routeIx({ extra: [raydium] }), expectLeg({ refused: new Set([raydium.toBase58()]) }))).toMatch(/refused venue/);
  });
});

describe('simulationProblem: what the test run must show', () => {
  const plan: Plan = { pool: 'p', side: 'sell', coinMint: SOL_QUOTE.mint, tokenMint: TOKEN, coinIn: 1_000n, minProfit: 10n };
  const ok = { coinBefore: 5_000n, coinAfter: 5_010n, tokenBefore: 7n, tokenAfter: 7n, otherCoinBefore: 3n, otherCoinAfter: 3n, lamportsBefore: 10_000_000n, lamportsAfter: 10_000_000n - MAX_LAMPORTS_SPENT };
  it('passes a coin gain of the floor, the token kept, and fees and rent spent', () => {
    expect(simulationProblem(ok, plan)).toBeNull();
  });
  it('refuses a gain one under the floor, a token loss, or more SOL than fees and rent', () => {
    expect(simulationProblem({ ...ok, coinAfter: 5_009n }, plan)).toMatch(/under the floor/);
    expect(simulationProblem({ ...ok, tokenAfter: 6n }, plan)).toMatch(/token account shrank/);
    expect(simulationProblem({ ...ok, otherCoinAfter: 2n }, plan)).toMatch(/other coin shrank/);
    expect(simulationProblem({ ...ok, lamportsAfter: ok.lamportsAfter - 1n }, plan)).toMatch(/more SOL/);
  });
});

describe('the last leg’s minimum: the floor, or the expected payout less the tolerance, whichever is more', () => {
  it('keeps a sandwich to the tolerance when the trip pays well', () => {
    // spend 25, expect 27, tolerance 0.5%: the minimum is 26.865, not 25.01
    expect(lastPoolMinimum(27_000_000n, 25_010_000n, 50)).toBe(26_865_000n);
    const bps = lastJupiterSlippage(27_000_000n, 25_010_000n, 50)!;
    expect(bps).toBe(50);
    expect(jupiterFloor(27_000_000n, bps)).toBe(26_865_000n);
  });
  it('is the floor itself when the trip pays only a little over it', () => {
    expect(lastPoolMinimum(25_050_000n, 25_010_000n, 50)).toBe(25_010_000n);
    const bps = lastJupiterSlippage(25_050_000n, 25_010_000n, 50)!;
    expect(jupiterFloor(25_050_000n, bps)).toBeGreaterThanOrEqual(25_010_000n);
    expect(bps).toBeLessThan(50);
  });
  it('is null under the floor', () => {
    expect(lastPoolMinimum(25_000_000n, 25_010_000n, 50)).toBeNull();
    expect(lastJupiterSlippage(25_000_000n, 25_010_000n, 50)).toBeNull();
  });
});

describe('lamportsInCoin: a new account’s rent, as a cost in the trip’s coin', () => {
  it('is lamports for SOL, and USDC at the two listed prices, rounded up', () => {
    expect(lamportsInCoin(NEW_ACCOUNT_RENT, SOL_QUOTE, usd)).toBe(NEW_ACCOUNT_RENT);
    expect(lamportsInCoin(NEW_ACCOUNT_RENT, SOL_QUOTE, new Map())).toBe(NEW_ACCOUNT_RENT); // SOL needs no price
    expect(lamportsInCoin(NEW_ACCOUNT_RENT, USDC_QUOTE, usd)).toBe(414_816n); // 0.00207408 SOL at $200
    expect(lamportsInCoin(NEW_ACCOUNT_RENT, USDC_QUOTE, new Map([[USDC_QUOTE.mint, 1]]))).toBeNull();
  });
});

