// Test-only: one summary of every kind of transaction a review shows, keyed by kind, so a new
// kind is a compile error here until it has one; and a prepared transaction with real bytes,
// decoded steps and a test run, for what is drawn under the review (UnderTheHood.tsx).

import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { BAYLA_QUOTE, SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { lpCreateSummary, lpDepositSummary, lpWithdrawSummary } from '../lp/fakeLpWriteApi.fixture';
import { CREATOR, KEY, PLANT_SUMMARY, SOL, buySummary, prepared } from './fakeWriteApi.fixture';
import type { PreparedTx, RangeSummary, TxKind, TxSummary } from './ports';

export const BAYLA = new PublicKey(BAYLA_QUOTE.mint);
/** The range program's stand-in address: any key the page does not name. */
export const RANGE_PROGRAM = KEY(70);
/** A blockhash in base58 (32 bytes of 7). */
export const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
export const TEST_RUN_AT = Date.UTC(2026, 9, 24, 14, 2, 11);

const cpQuote = {
  poolAddress: KEY(40).toBase58(), outAmount: 900n, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.01, creatorFeeOnInput: true,
  result: { outputAmount: 900n, tradeFee: 2_500_000n, protocolFee: 300_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
};
const tier1 = {
  address: KEY(42).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n,
  createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'a', fundOwner: 'b',
};

/** BAYLA with SOL, 1% tier, the agreed split. */
export const POOL_LINE: Extract<RangeSummary, { kind: 'range-open' }>['poolLine'] = {
  feeCeiling: null, pool: KEY(51), tokenMint: BAYLA, tokenDecimals: 6, quote: SOL_QUOTE, tokenIsToken0: true,
  tradeFeeRate: 10_000, venueShareRate: 160_000, protocolFeeRate: 104_000, fundFeeRate: 56_000,
  owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58(),
};
const RANGE = { tickLower: 0, tickUpper: 1200, minPrice: 0.0002, maxPrice: 0.0005, holds: 'both' as const };

export function rangeOpening(over: Partial<Extract<RangeSummary, { kind: 'range-open' }>> = {}): Extract<RangeSummary, { kind: 'range-open' }> {
  return {
    kind: 'range-open', nftMint: KEY(52), max: { token: 10_100_000_000n, quote: 4_139_788_000n }, quoted: { token: 10_000_000_000n, quote: 4_098_800_000n },
    rentLamports: 59_300_000n, unwrapsWsol: true, notices: [], warnings: [], price: { state: 'agrees', pool: 0.0004, reference: 0.0004, diff: 0 },
    poolLine: POOL_LINE, range: RANGE, ...over,
  };
}

export function rangeTakeOut(kind: 'range-remove' | 'range-close', over: Partial<Extract<RangeSummary, { kind: 'range-remove' | 'range-close' }>> = {}): RangeSummary {
  return {
    kind, position: KEY(53), percent: kind === 'range-close' ? 100 : 50, liquidity: 1_000n, min: { token: 4_900_000_000n, quote: 2_000_000_000n },
    quoted: { token: 5_000_000_000n, quote: 2_049_400_000n }, fees: { token: 12_000_000n, quote: 4_900_000n }, rewards: [], unwrapsWsol: true, notices: [],
    poolLine: POOL_LINE, range: RANGE, ...over,
  } as RangeSummary;
}

/** One of every kind. Keyed by kind: a kind missing here does not compile. */
export const EVERY_KIND: Readonly<Record<TxKind, TxSummary>> = {
  create: {
    kind: 'create', mint: KEY(15), creator: CREATOR, name: 'A', symbol: 'AB', uri: 'https://x', decimals: 6, openingBuy: null,
    platformReserve: { amount: 36_900_000_000_000n, bps: 369n, recipient: KEY(4), treasuryToken: KEY(12) }, treasuryAccountRent: 1_488_440n, plant: PLANT_SUMMARY,
  },
  buy: buySummary(),
  sell: {
    kind: 'sell', mint: KEY(1), tokensIn: 1_000_000n, minLamportsOut: 900n, quote: { lamportsOut: 1_000n, feeLamports: 10n, grossLamports: 1_010n },
    priceImpactBps: 5n, feeSplit: { total: 10n, creator: 5n, platform: 5n },
  },
  migrate: { kind: 'migrate', mint: CREATOR, pool: KEY(40) },
  'pool-buy': { kind: 'pool-buy', mint: KEY(1), pool: KEY(40), amountIn: SOL, minimumAmountOut: 800n, quote: cpQuote, unwrapsWsol: true },
  'pool-sell': { kind: 'pool-sell', mint: KEY(1), pool: KEY(40), amountIn: 1_000n, minimumAmountOut: 800n, quote: cpQuote, unwrapsWsol: true },
  'venue-swap': {
    kind: 'venue-swap', pool: KEY(40), origin: 'standard', config: tier1, tokenMint: KEY(41), tokenDecimals: 6, coin: SOL_QUOTE, paysCoin: true,
    amountIn: 100_000_000n, minimumAmountOut: 9_753_945_691n,
    quoted: { ...cpQuote, outAmount: 9_802_960_494n, result: { ...cpQuote.result, outputAmount: 9_802_960_494n, tradeFee: 1_000_000n } },
    aggregator: { kind: 'no-route' }, unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
  },
  'lp-deposit': lpDepositSummary(KEY(30), KEY(31)),
  'lp-withdraw': lpWithdrawSummary(KEY(30), KEY(31), KEY(32)),
  'lp-create': lpCreateSummary(KEY(30), KEY(31)),
  'range-open': rangeOpening(),
  'range-remove': rangeTakeOut('range-remove'),
  'range-close': rangeTakeOut('range-close'),
  'range-swap': {
    kind: 'range-swap', poolLine: POOL_LINE, paysCoin: true, amountIn: 500_000_000n, minimumAmountOut: 1_190_000_000n, quotedOut: 1_198_000_000n,
    bandsCrossed: 1, feeOnInput: true, aggregator: { kind: 'no-route' }, unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
  },
};

/** The test run's log: what a node answers for a range opening, cut to a few lines. */
export const LOG = [
  'Program ComputeBudget111111111111111111111111111111 invoke [1]',
  'Program ComputeBudget111111111111111111111111111111 success',
  `Program ${RANGE_PROGRAM.toBase58()} invoke [1]`,
  'Program log: Instruction: OpenPositionWithToken22Nft',
  `Program ${RANGE_PROGRAM.toBase58()} consumed 84211 of 120000 compute units`,
  `Program ${RANGE_PROGRAM.toBase58()} success`,
];

/** A compute-budget instruction from its bytes (web3's encoder fails under jsdom): 2 = unit limit, 3 = unit price. */
const budgetIx = (data: number[]) => new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from(data) });

/**
 * The venue's own step: a range opening's first seven accounts in the program's order (payer,
 * NFT owner, NFT mint, NFT account, pool, protocol position, lower band), the rest left off.
 */
const ownIx = () =>
  new TransactionInstruction({
    programId: RANGE_PROGRAM,
    keys: [
      { pubkey: CREATOR, isSigner: true, isWritable: true },
      { pubkey: CREATOR, isSigner: false, isWritable: false },
      { pubkey: KEY(52), isSigner: true, isWritable: true },
      { pubkey: KEY(56), isSigner: false, isWritable: true },
      { pubkey: KEY(51), isSigner: false, isWritable: true },
      { pubkey: KEY(57), isSigner: false, isWritable: false },
      { pubkey: KEY(54), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]),
  });

/**
 * `summary` as prepared: a compute limit of 120,000 at 10,000 micro-lamports, then one range
 * opening; 1,014 bytes; a test run that used 84,211 units at slot 460,729,140.
 */
export function underTheHood(summary: TxSummary, over: Partial<PreparedTx> = {}): PreparedTx {
  const tx = new Transaction({ feePayer: CREATOR, blockhash: BLOCKHASH, lastValidBlockHeight: 1234 });
  tx.add(budgetIx([2, 0xc0, 0xd4, 0x01, 0x00]), budgetIx([3, 0x10, 0x27, 0, 0, 0, 0, 0, 0]), ownIx());
  return prepared(summary, {
    tx,
    blockhash: BLOCKHASH,
    sizeBytes: 1_014,
    steps: [
      { kind: 'compute-limit', units: 120_000 },
      { kind: 'compute-price', microLamports: 10_000n },
      { kind: 'range-open', pool: KEY(51), nftMint: KEY(52), tickLower: -1200, tickUpper: 1200, liquidity: 1_284_112n, max0: 10_100_000_000n, max1: 4_139_788_000n },
    ],
    simulation: { unitsConsumed: 84_211, logs: LOG, slot: 460_729_140, at: TEST_RUN_AT, wsolLamportsDelta: null },
    ...over,
  });
}
