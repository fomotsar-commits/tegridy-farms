// Range positions in the venue's own range program (solana/tegridy-clmm): opening one with
// its Token-2022 NFT, taking some or all of its liquidity out (none collects its fees), and
// closing it. Each builder makes ONE fresh read of everything it touches, pins the pool and
// position from that read (`rangePins`), builds with the site's own builders
// (solana/clmm/ix.ts), and goes through `buildAndSimulate`: decoded back and checked
// against the shapes this site builds (intent.ts rebuilds every range instruction from the
// pins and refuses any difference), test-run twice, and held to balance bounds.
// Nothing here signs or sends.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatTokenAmount } from '../curve/format';
import { quoteCoin, type QuoteCoin } from '../../../solana/lp/quotes';
import { BUILDABLE_EXTENSIONS, decodeMintAccount, extensionPlain, freezeWarning } from '../../../solana/lp/tokenSafety';
import type { RawAccount } from '../../../solana/lp/accounts';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { tokenVault } from '../../../solana/lp/poolFinder';
import { tokenAccountSize } from '../../../solana/lp/tokenAccountSize';
import { rangePriceCheck } from '../../../solana/clmm/priceCheck';
import { closePositionIx, decreaseLiquidityV2Ix, openPositionWithToken22NftIx, positionNftAccount } from '../../../solana/clmm/ix';
import { calculateLatestTokenFees, getDeltaAmountsSigned, getFeeGrowthInside, usableTickBounds, ClmmMathError } from '../../../solana/clmm/math';
import {
  POOL_STATUS_BIT,
  decodeAmmConfig,
  decodePersonalPosition,
  decodePoolState,
  decodeTickArray,
  deriveObservation,
  derivePersonalPosition,
  deriveTickArray,
  deriveVault,
  poolAllows,
  type AmmConfigView,
  type PersonalPositionView,
  type PoolStateView,
} from '../../../solana/clmm/program';
import { getArrayStartIndex } from '../../../solana/clmm/bitmap';
import { depositFrom, holdsNow, lessTolerance, pairOf, planFromCeiling, priceNumber, rangePrices, withTolerance, type Pair, type TickRange } from '../../../solana/clmm/rangeMath';
import { poolFeeCeiling } from '../../../solana/clmm/feeText';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { LP_COPY, accountCheck, coinAccount, rentOf, toRaw, type AccountWant } from './liquidity';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import type {
  CurveWriteConfig,
  Expectation,
  IntentStep,
  Prepared,
  RangeIntent,
  RangeKind,
  RangeLine,
  RangePins,
  RangePoolLine,
  RangePositionPins,
  TxSummary,
  WatchList,
  WriteRpc,
} from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom, type WsolPlan } from './wsol';

export const RANGE_COPY = {
  notDeployed: 'The range-pool program is not on this network yet, so nothing was built.',
  readFailed: 'We could not read the range pool just now, so nothing was built. Try again in a moment.',
  notAPool: 'This address is not a range pool of this venue.',
  notOurPair: LP_COPY.notAPairingCoin,
  poolChanged: (what: string) => `This range pool no longer matches what the page read (${what}). Read it again.`,
  tokenNot: (why: string) => `This site does not build for this token in a range pool: ${why}.`,
  addingPaused: 'Opening positions in this pool is switched off by the venue’s vault right now.',
  withdrawalsOff:
    'Withdrawals are switched off on this pool by the venue’s vault, so money put in now could not be taken out until the vault switches them back on. Nothing was built.',
  vaultFrozen: 'One of this pool’s vaults is frozen by its coin’s issuer, so nothing can move in or out of the pool, for anyone. Nothing was built.',
  cannotSize: (why: string) => `This site cannot size your account for a coin of this pool (${why}), so nothing was built.`,
  priceOff: (pct: string, side: 'above' | 'below', loss: string | null) =>
    `This pool’s price is ${pct} ${side} the outside price (Jupiter’s). Anyone can open a range pool at any price. ` +
    (loss === null
      ? 'What a move back to the outside price would cost you at these amounts could not be worked out.'
      : `At these amounts, a move back to the outside price would take up to about ${loss} of what you put in. That is an estimate.`),
  noMarket: 'Jupiter has no route for this pair, so this pool’s price could not be checked against an outside price. Anyone can open a range pool at any price.',
  priceUnread: (why: string) =>
    `The outside price could not be read just now (${why}), so this pool’s price was not checked against it. Anyone can open a range pool at any price.`,
  removingPaused: 'Taking liquidity out of this pool is switched off by the venue’s vault right now.',
  collectingPaused: 'Collecting fees from this pool is switched off by the venue’s vault right now.',
  badRange: 'That range is not one a position may use in this pool.',
  buysNothing: 'That amount buys nothing in this range: a range above the price takes the token only, and one below it takes the pairing coin only.',
  noTokenAccount: (address: string) => LP_COPY.noTokenAccount(address),
  noCoinAccount: (symbol: string, address: string) => LP_COPY.noCoinAccount(symbol, address),
  short: (need: string, have: string) => LP_COPY.overBalance(need, have),
  notAPosition: 'This address is not a range position of this venue.',
  notYourNft: 'The position’s NFT is not in your wallet’s own account for it, so this site cannot take it out for you.',
  nothingToTake: 'There is nothing in this position to take out, and no fees to collect.',
  badPercent: 'Choose how much to take out: from 0% (fees only) to 100%.',
  badTolerance: 'The price tolerance must be from 0% to 50%.',
} as const;

/** The largest a position's Token-2022 NFT mint gets: its name, symbol and link included (469 bytes for ours). */
const NFT_MINT_SIZE_BOUND = 512;
const PERSONAL_POSITION_SIZE = 281;
const NFT_ACCOUNT_SIZE = 170;
const TICK_ARRAY_SIZE_BYTES = 10_240;
const MAX_TOLERANCE_BPS = 5_000;
const BPF_LOADERS = new Set(['BPFLoaderUpgradeab1e11111111111111111111111', 'BPFLoader2111111111111111111111111111111111']);

const tokenAmountOf = (acc: RawAccount | null): bigint =>
  acc && acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true) : 0n;

/** Everything one builder reads, in one call so it is one slot. */
interface Fresh {
  program: RawAccount | null;
  pool: RawAccount | null;
  config: RawAccount | null;
  mint0: RawAccount | null;
  mint1: RawAccount | null;
  extra: (RawAccount | null)[];
}

async function readFresh(rpc: WriteRpc, programId: PublicKey, pool: PublicKey, configHint: PublicKey | null, mints: [PublicKey, PublicKey] | null, extra: PublicKey[]): Promise<Fresh | null> {
  const keys = [programId, pool, ...(configHint ? [configHint] : []), ...(mints ?? []), ...extra];
  try {
    const raw = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
    let i = 2;
    const config = configHint ? raw[i++]! : null;
    const mint0 = mints ? raw[i++]! : null;
    const mint1 = mints ? raw[i++]! : null;
    return { program: raw[0]!, pool: raw[1]!, config, mint0, mint1, extra: raw.slice(i) };
  } catch {
    return null;
  }
}

const deployed = (a: RawAccount | null) => a !== null && BPF_LOADERS.has(a.owner);

/** The pool as decoded, after the checks every range builder makes of it. A string says why not. */
function decodePool(programId: PublicKey, address: PublicKey, a: RawAccount | null): PoolStateView | string {
  if (!a || a.owner !== programId.toBase58()) return RANGE_COPY.notAPool;
  const pool = decodePoolState(address.toBase58(), a.data);
  if (!pool) return RANGE_COPY.notAPool;
  return pool;
}

/**
 * The pins for one pool, from one fresh read: each vault and the price record equal both
 * the pool's own field and the derivation from its address, the tier is the pool's own and
 * decodes, each mint is owned by the token program the pool's vault uses, the pairing coin
 * is one of the site's own (and on the side and program it says), and the token has no
 * extension that changes what a transfer moves. `withRewards` false (an opening, which carries
 * no reward account): the pool's rewards are not pinned, so their accounts need not be read.
 */
function rangePins(
  programId: PublicKey,
  pool: PoolStateView,
  config: RawAccount | null,
  mint0: RawAccount | null,
  mint1: RawAccount | null,
  rewardVaults: (RawAccount | null)[],
  withRewards = true,
): { pins: RangePins; pair: Pair; tier: AmmConfigView; tokenDecimals: number } | string {
  const addr = new PublicKey(pool.address);
  const m0 = new PublicKey(pool.tokenMint0);
  const m1 = new PublicKey(pool.tokenMint1);
  if (pool.tokenVault0 !== deriveVault(programId, addr, m0).toBase58() || pool.tokenVault1 !== deriveVault(programId, addr, m1).toBase58()) {
    return RANGE_COPY.poolChanged('its vaults');
  }
  if (pool.observationKey !== deriveObservation(programId, addr).toBase58()) return RANGE_COPY.poolChanged('its price record');
  if (!config || config.owner !== programId.toBase58()) return RANGE_COPY.poolChanged('its fee tier');
  const tier = decodeAmmConfig(pool.ammConfig, config.data);
  if (!tier || tier.tickSpacing !== pool.tickSpacing) return RANGE_COPY.poolChanged('its fee tier');
  const pair = pairOf(pool);
  if (!pair) return RANGE_COPY.notOurPair;
  const programs: PublicKey[] = [];
  for (const [mint, decimals] of [[mint0, pool.mintDecimals0], [mint1, pool.mintDecimals1]] as const) {
    if (!mint || (mint.owner !== TOKEN_PROGRAM_ID.toBase58() && mint.owner !== TOKEN_2022_PROGRAM_ID.toBase58())) return RANGE_COPY.poolChanged('a mint');
    const d = decodeMintAccount(mint.owner, mint.data);
    if (!d.ok) return RANGE_COPY.tokenNot(d.reason);
    if (d.value.decimals !== decimals) return RANGE_COPY.poolChanged('a mint’s decimals');
    const outside = d.value.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
    if (outside !== undefined) return RANGE_COPY.tokenNot(`it uses ${extensionPlain(outside)}`);
    programs.push(new PublicKey(mint.owner));
  }
  const quoteIsToken0 = !pair.tokenIsToken0;
  const quoteProgram = quoteIsToken0 ? programs[0]! : programs[1]!;
  if (quoteProgram.toBase58() !== pair.quote.program || (quoteIsToken0 ? pool.mintDecimals0 : pool.mintDecimals1) !== pair.quote.decimals) {
    return LP_COPY.coinChanged(pair.quote.symbol, 'its program or decimals');
  }
  const rewards: RangePins['rewards'] = [];
  if (withRewards && poolAllows(pool, POOL_STATUS_BIT.collectReward)) {
    const live = pool.rewardInfos.filter((r) => r.initialized);
    for (let i = 0; i < live.length; i++) {
      const vault = rewardVaults[i];
      const r = live[i]!;
      if (!vault || (vault.owner !== TOKEN_PROGRAM_ID.toBase58() && vault.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) || vault.data.length < 72) {
        return RANGE_COPY.poolChanged('a reward account');
      }
      if (new PublicKey(vault.data.subarray(0, 32)).toBase58() !== r.tokenMint) return RANGE_COPY.poolChanged('a reward account');
      rewards.push({ vault: new PublicKey(r.tokenVault), mint: new PublicKey(r.tokenMint), program: new PublicKey(vault.owner) });
    }
  }
  return {
    pins: {
      program: programId,
      address: addr,
      ammConfig: new PublicKey(pool.ammConfig),
      observation: new PublicKey(pool.observationKey),
      tickSpacing: pool.tickSpacing,
      token0Mint: m0,
      token1Mint: m1,
      token0Program: programs[0]!,
      token1Program: programs[1]!,
      vault0: new PublicKey(pool.tokenVault0),
      vault1: new PublicKey(pool.tokenVault1),
      tokenMint: new PublicKey(pair.tokenMint),
      tokenProgram: pair.tokenIsToken0 ? programs[0]! : programs[1]!,
      quote: pair.quote,
      quoteIsToken0,
      rewards,
      status: pool.status,
    },
    pair,
    tier,
    tokenDecimals: pair.tokenDecimals,
  };
}

function poolLine(pins: RangePins, pair: Pair, tier: AmmConfigView, pool: PoolStateView): RangePoolLine {
  return {
    pool: pins.address,
    feeCeiling: poolFeeCeiling(pool, tier.tradeFeeRate),
    tokenMint: pins.tokenMint,
    tokenDecimals: pair.tokenDecimals,
    quote: pair.quote,
    tokenIsToken0: pair.tokenIsToken0,
    tradeFeeRate: tier.tradeFeeRate,
    venueShareRate: tier.protocolFeeRate + tier.fundFeeRate,
    protocolFeeRate: tier.protocolFeeRate,
    fundFeeRate: tier.fundFeeRate,
    owner: tier.owner,
    fundOwner: tier.fundOwner,
  };
}

function rangeLine(pair: Pair, pool: PoolStateView, r: TickRange): RangeLine {
  const { min, max } = rangePrices(pair, r);
  return { tickLower: r.tickLower, tickUpper: r.tickUpper, minPrice: priceNumber(min), maxPrice: priceNumber(max), holds: holdsNow(pair, pool, r) };
}

/** The two sides, as the token and the coin, from the pool's 0/1. */
const sides = <T>(pair: Pair, v0: T, v1: T): { token: T; quote: T } => (pair.tokenIsToken0 ? { token: v0, quote: v1 } : { token: v1, quote: v0 });

const toleranceProblem = (bps: number) => (!Number.isInteger(bps) || bps < 0 || bps > MAX_TOLERANCE_BPS ? RANGE_COPY.badTolerance : null);

/** The signer's account for one side, and the question `accountCheck` asks of it. */
function sideAccount(owner: PublicKey, pins: RangePins, which: 'token' | 'quote', use: AccountWant['use']): { address: PublicKey; want: AccountWant } {
  if (which === 'quote') {
    const q: QuoteCoin = pins.quote;
    return { address: associatedTokenAddress(new PublicKey(q.mint), owner, new PublicKey(q.program)), want: coinAccount(owner, q, use) };
  }
  return {
    address: associatedTokenAddress(pins.tokenMint, owner, pins.tokenProgram),
    want: { owner, mint: pins.tokenMint, program: pins.tokenProgram, use, what: 'token' },
  };
}

const openAta = (owner: PublicKey, address: PublicKey, mint: PublicKey, program: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(owner, address, owner, mint, program);

// ── opening ──────────────────────────────────────────────────────────────────

/**
 * A coin whose holder can freeze accounts, on either side, in the LP deposit's words
 * (tokenSafety.ts freezeWarning); a pairing coin with its own risk line (USDC: Circle) is
 * said from it on the review instead, once. A mint that does not decode is refused, never
 * passed as one that cannot be frozen.
 */
export function freezeLines(pair: Pick<Pair, 'tokenMint' | 'quote'>, tokenMint: RawAccount | null, coinMint: RawAccount | null): string[] | { refuse: string } {
  const sides: [string, string, RawAccount | null][] = [[quoteCoin(pair.tokenMint)?.symbol ?? 'The token', pair.tokenMint, tokenMint]];
  if (!pair.quote.native && !pair.quote.risk) sides.push([pair.quote.symbol, pair.quote.mint, coinMint]);
  const lines: string[] = [];
  for (const [name, mint, raw] of sides) {
    const d = raw ? decodeMintAccount(raw.owner, raw.data) : null;
    if (!d || !d.ok) return { refuse: RANGE_COPY.tokenNot(d ? d.reason : 'its mint was not read') };
    if (d.value.freezeAuthority) lines.push(`${name}: ${freezeWarning(mint, d.value.freezeAuthority).text}`);
  }
  return lines;
}

export interface RangeOpenArgs {
  owner: PublicKey;
  pool: PublicKey;
  tickLower: number;
  tickUpper: number;
  /** The coin the amount is of: the most the opening takes of that coin. */
  side: 'token' | 'coin';
  amount: bigint;
  /** How far either coin's amount may rise if the price moves before this lands. */
  toleranceBps: number;
}

/** The outside market price, asked fresh at Review (the LP deposit's reader, outsidePrice.ts). */
export interface RangeOpenReads {
  outsidePrice(mint: string, decimals: number, opts?: { fresh?: boolean }): Promise<OutsidePrice>;
}

export async function prepareRangeOpen(rpc: WriteRpc, cfg: CurveWriteConfig, programId: PublicKey, reads: RangeOpenReads, a: RangeOpenArgs): Promise<Prepared> {
  const bad = toleranceProblem(a.toleranceBps);
  if (bad) return notSent('build', bad);
  if (a.amount <= 0n) return notSent('build', 'Enter an amount above zero.');

  // 1. One read of the pool, its tier and mints, the signer's accounts and the two bands.
  const first = await readFresh(rpc, programId, a.pool, null, null, []);
  if (!first) return notSent('build', RANGE_COPY.readFailed);
  if (!deployed(first.program)) return notSent('build', RANGE_COPY.notDeployed);
  const peek = decodePool(programId, a.pool, first.pool);
  if (typeof peek === 'string') return notSent('build', peek);
  const bounds = usableTickBounds(peek.tickSpacing);
  if (!(a.tickLower < a.tickUpper) || a.tickLower < bounds.min || a.tickUpper > bounds.max || a.tickLower % peek.tickSpacing !== 0 || a.tickUpper % peek.tickSpacing !== 0) {
    return notSent('build', RANGE_COPY.badRange);
  }
  const pairPeek = pairOf(peek);
  if (!pairPeek) return notSent('build', RANGE_COPY.notOurPair);
  const startLower = getArrayStartIndex(a.tickLower, peek.tickSpacing);
  const startUpper = getArrayStartIndex(a.tickUpper, peek.tickSpacing);
  const bands = [...new Set([startLower, startUpper])].map((s) => deriveTickArray(programId, a.pool, s));
  const quote = pairPeek.quote;
  // The bands, then the pool's two vaults: a frozen vault takes nothing in or out.
  const extraKeys = [...bands, new PublicKey(peek.tokenVault0), new PublicKey(peek.tokenVault1)];
  const fresh = await readFresh(rpc, programId, a.pool, new PublicKey(peek.ammConfig), [new PublicKey(peek.tokenMint0), new PublicKey(peek.tokenMint1)], extraKeys);
  if (!fresh) return notSent('build', RANGE_COPY.readFailed);
  if (!deployed(fresh.program)) return notSent('build', RANGE_COPY.notDeployed);
  const pool = decodePool(programId, a.pool, fresh.pool);
  if (typeof pool === 'string') return notSent('build', pool);
  // A pool that pays a reward opens like any other: the program updates rewards from the pool alone.
  const pinned = rangePins(programId, pool, fresh.config, fresh.mint0, fresh.mint1, [], false);
  if (typeof pinned === 'string') return notSent('build', pinned);
  const { pins, pair, tier } = pinned;
  if (!poolAllows(pool, POOL_STATUS_BIT.openPositionOrIncreaseLiquidity)) return notSent('build', RANGE_COPY.addingPaused);
  // Money put in while withdrawals are off could not come back out (the LP deposit refuses the same).
  if (!poolAllows(pool, POOL_STATUS_BIT.decreaseLiquidity)) return notSent('build', RANGE_COPY.withdrawalsOff);
  const vaults = fresh.extra.slice(bands.length);
  const v0 = tokenVault(vaults[0] ?? null, pins.token0Program.toBase58());
  const v1 = tokenVault(vaults[1] ?? null, pins.token1Program.toBase58());
  if (!v0 || !v1) return notSent('build', RANGE_COPY.poolChanged('its vaults'));
  if (v0.frozen || v1.frozen) return notSent('build', RANGE_COPY.vaultFrozen);

  // The signer's two accounts, read now that the token's program is known. An account this
  // opens is sized by its own mint: 170 bytes for a Token-2022 coin such as BAYLA, not 165.
  const tokenSide = sideAccount(a.owner, pins, 'token', 'source');
  const coinSide = sideAccount(a.owner, pins, 'quote', 'source');
  const tokenMintRaw = pair.tokenIsToken0 ? fresh.mint0 : fresh.mint1;
  const coinMintRaw = pair.tokenIsToken0 ? fresh.mint1 : fresh.mint0;
  const tokenSize = tokenMintRaw ? tokenAccountSize(tokenMintRaw) : 'its mint was not read';
  const coinSize = quote.native ? 165 : coinMintRaw ? tokenAccountSize(coinMintRaw) : 'its mint was not read';
  if (typeof tokenSize === 'string') return notSent('build', RANGE_COPY.cannotSize(tokenSize));
  if (typeof coinSize === 'string') return notSent('build', RANGE_COPY.cannotSize(coinSize));
  let accounts: (RawAccount | null)[];
  let rents: { position: bigint; nftMint: bigint; nftAccount: bigint; band: bigint; tokenAccount: bigint; coinAccount: bigint };
  try {
    accounts = toRaw([tokenSide.address, coinSide.address, a.owner], await rpc.getMultipleAccountsInfo([tokenSide.address, coinSide.address, a.owner], 'confirmed'));
    const [position, nftMint, nftAccount, band, tokenAccount, coinAccount] = await Promise.all(
      [PERSONAL_POSITION_SIZE, NFT_MINT_SIZE_BOUND, NFT_ACCOUNT_SIZE, TICK_ARRAY_SIZE_BYTES, tokenSize, coinSize].map((n) => rpc.getMinimumBalanceForRentExemption(n)),
    );
    rents = { position: rentOf(position), nftMint: rentOf(nftMint), nftAccount: rentOf(nftAccount), band: rentOf(band), tokenAccount: rentOf(tokenAccount), coinAccount: rentOf(coinAccount) };
  } catch {
    return notSent('build', RANGE_COPY.readFailed);
  }
  const [tokenAcc, coinAcc] = accounts as [RawAccount | null, RawAccount | null, RawAccount | null];

  // 2. A FIXED liquidity with a ceiling on BOTH coins: a price move either way raises one
  // side past its ceiling and the program refuses it. (Liquidity 0 with a base side checks
  // only that coin, so a sandwich passed.) The plan is made from the typed amount less the
  // tolerance, so the typed amount stays the most it takes of that coin.
  const range: TickRange = { tickLower: a.tickLower, tickUpper: a.tickUpper };
  const planAmount = planFromCeiling(a.amount, a.toleranceBps);
  const plan = depositFrom(pair, pool, range, a.side, planAmount);
  if (!plan) return notSent('build', RANGE_COPY.buysNothing);
  const typed0 = (a.side === 'token') === pair.tokenIsToken0;
  const ceil = (amount: bigint, typed: boolean) => {
    const m = withTolerance(amount, a.toleranceBps);
    return typed && m > a.amount ? a.amount : m;
  };
  const max0 = ceil(plan.amount0, typed0);
  const max1 = ceil(plan.amount1, !typed0);
  const max = sides(pair, max0, max1);
  const quoted = sides(pair, plan.amount0, plan.amount1);

  // 2b. The pool's price against the outside market, asked fresh: anyone can open a range
  // pool at any price, and a deposit at a price off the market is arbitraged back.
  const warnings: string[] = [];
  const ask = async (mint: string, decimals: number): Promise<OutsidePrice> => {
    try {
      return await reads.outsidePrice(mint, decimals, { fresh: true });
    } catch (e) {
      return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  const [outside, coinOutside] = await Promise.all([ask(pins.tokenMint.toBase58(), pair.tokenDecimals), quote.native ? null : ask(quote.mint, quote.decimals)]);
  const check = rangePriceCheck({ pair, sqrtPriceX64: pool.sqrtPriceX64, range, liquidity: plan.liquidity, amount0: plan.amount0, amount1: plan.amount1, outside, coinOutside });
  if (check.state === 'disagrees') {
    const pct = `${Number((Math.abs(check.diff) * 100).toFixed(1))}%`;
    const loss = check.lossQuote === null ? null : `${formatTokenAmount(check.lossQuote, quote.decimals, 6).text} ${quote.symbol}`;
    warnings.push(RANGE_COPY.priceOff(pct, check.diff > 0 ? 'above' : 'below', loss));
  } else if (check.state === 'no-market') warnings.push(RANGE_COPY.noMarket);
  else if (check.state === 'unread') warnings.push(RANGE_COPY.priceUnread(check.detail));
  const freezes = freezeLines(pair, tokenMintRaw ?? null, coinMintRaw ?? null);
  if (!Array.isArray(freezes)) return notSent('build', freezes.refuse);
  warnings.push(...freezes);
  // The accounts' notices are the review's own lines, apart from the price warnings (as a deposit's are).
  const notices: string[] = [];

  // 3. The accounts the coins come from. SOL is wrapped from the wallet itself.
  const tokenCheck = accountCheck(tokenAcc, tokenSide.want);
  if (tokenCheck.refuse) return notSent('build', tokenCheck.refuse);
  notices.push(...tokenCheck.notices);
  if (max.token > 0n) {
    if (!tokenAcc) return notSent('build', RANGE_COPY.noTokenAccount(tokenSide.address.toBase58()));
    const have = tokenAmountOf(tokenAcc);
    if (have < max.token) {
      const t = (v: bigint) => `${formatTokenAmount(v, pair.tokenDecimals, pair.tokenDecimals).text} tokens`;
      return notSent('build', RANGE_COPY.short(t(max.token), t(have)));
    }
  }
  let plan2: WsolPlan | null = null;
  if (quote.native) {
    const made = wsolPlanFrom(a.owner, coinAcc);
    if (typeof made === 'string') return notSent('build', made);
    plan2 = made;
  } else {
    const coinCheck = accountCheck(coinAcc, coinSide.want);
    if (coinCheck.refuse) return notSent('build', coinCheck.refuse);
    notices.push(...coinCheck.notices);
    if (max.quote > 0n) {
      if (!coinAcc) return notSent('build', RANGE_COPY.noCoinAccount(quote.symbol, coinSide.address.toBase58()));
      const have = tokenAmountOf(coinAcc);
      if (have < max.quote) {
        const c = (v: bigint) => `${formatTokenAmount(v, quote.decimals, quote.decimals).text} ${quote.symbol}`;
        return notSent('build', RANGE_COPY.short(c(max.quote), c(have)));
      }
    }
  }

  // 4. The body. Both coin accounts must exist for the program, so a missing one with
  // nothing to give is opened (the wrapped-SOL account is closed again at the end).
  const nft = Keypair.generate();
  const opens: PublicKey[] = [];
  const body: TransactionInstruction[] = [];
  if (!tokenAcc) {
    body.push(openAta(a.owner, tokenSide.address, pins.tokenMint, pins.tokenProgram));
    opens.push(tokenSide.address);
  }
  if (plan2) {
    body.push(openWsolIx(a.owner));
    opens.push(plan2.ata);
    if (max.quote > 0n) body.push(...wrapIxs(a.owner, max.quote));
  } else if (!coinAcc) {
    body.push(openAta(a.owner, coinSide.address, new PublicKey(quote.mint), new PublicKey(quote.program)));
    opens.push(coinSide.address);
  }
  const own0 = associatedTokenAddress(pins.token0Mint, a.owner, pins.token0Program);
  const own1 = associatedTokenAddress(pins.token1Mint, a.owner, pins.token1Program);
  body.push(
    openPositionWithToken22NftIx({
      programId,
      payer: a.owner,
      owner: a.owner,
      positionNftMint: nft.publicKey,
      pool,
      tokenAccount0: own0,
      tokenAccount1: own1,
      tickLower: a.tickLower,
      tickUpper: a.tickUpper,
      liquidity: plan.liquidity,
      amount0Max: max0,
      amount1Max: max1,
      baseFlag: null,
    }),
  );
  if (plan2) body.push(...closeWsolIxs(plan2, a.owner));

  const bandRent = BigInt(fresh.extra.slice(0, bands.length).filter((b) => b === null || b.owner !== programId.toBase58()).length) * rents.band;
  const positionRent = rents.position + rents.nftMint + rents.nftAccount;
  // What the accounts this opens keep as deposits, each sized by its own mint.
  const openedRent = (pre: { tokens: Map<string, { exists: boolean }> }) =>
    opens
      .filter((k) => !(pre.tokens.get(k.toBase58())?.exists ?? false) && !(plan2 && k.equals(plan2.ata) && plan2.closeAfter))
      .reduce((sum, k) => sum + (k.equals(tokenSide.address) ? rents.tokenAccount : rents.coinAccount), 0n);

  const tokenAccounts: WatchList['tokenAccounts'] = [{ account: tokenSide.address, mint: pins.tokenMint, role: 'token', decimals: pair.tokenDecimals }];
  if (plan2) tokenAccounts.push({ account: plan2.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 });
  else tokenAccounts.push({ account: coinSide.address, mint: new PublicKey(quote.mint), role: 'quote', decimals: quote.decimals });

  const intent: RangeIntent = {
    kind: 'range-open',
    signer: a.owner,
    cfg,
    maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
    pins,
    position: null,
    nftMint: nft.publicKey,
    openLiquidity: plan.liquidity,
  };
  return buildAndSimulate(rpc, {
    kind: 'range-open',
    body,
    extraSigners: [nft],
    intent,
    watch: { signer: a.owner, tokenAccounts },
    expect: (pre, r): Expectation => {
      const accountRents = openedRent(pre);
      const tokenRow = { account: tokenSide.address, mint: pins.tokenMint, minDelta: -max.token, maxDelta: 2n ** 64n };
      if (!plan2) {
        return {
          maxSolOut: positionRent + bandRent + accountRents,
          tokens: [tokenRow, { account: coinSide.address, mint: new PublicKey(quote.mint), minDelta: -max.quote, maxDelta: 2n ** 64n }],
        };
      }
      // SOL wrapped in and not used: closed, it comes back as SOL; kept, it stays wrapped.
      const kept = plan2.closeAfter ? 0n : syncCredit(pre.tokens.get(plan2.ata.toBase58()), r.tokenAccount);
      return {
        maxSolOut: max.quote + positionRent + bandRent + accountRents,
        tokens: [tokenRow, { account: plan2.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: plan2.closeAfter ? 0n : kept + max.quote }],
      };
    },
    newAccountRent: (pre) => positionRent + bandRent + openedRent(pre),
    summarize: (steps): TxSummary | string => {
      const problem = stepsProblem(steps, {
        own: (s) => s.kind === 'range-open' && s.tickLower === a.tickLower && s.tickUpper === a.tickUpper && s.max0 === max0 && s.max1 === max1 && s.liquidity === plan.liquidity,
        wraps: plan2 && max.quote > 0n ? max.quote : null,
        opens,
        closes: plan2?.closeAfter ?? false,
      });
      if (problem) return problem;
      return {
        kind: 'range-open',
        nftMint: nft.publicKey,
        max,
        quoted,
        rentLamports: positionRent + bandRent,
        unwrapsWsol: plan2?.closeAfter ?? false,
        notices,
        warnings,
        price: check,
        poolLine: poolLine(pins, pair, tier, pool),
        range: rangeLine(pair, pool, range),
      };
    },
  });
}

// ── taking out, collecting, closing ──────────────────────────────────────────

export interface RangeRemoveArgs {
  owner: PublicKey;
  /** The position's record (PersonalPositionState) address. */
  position: PublicKey;
  /** 0 to 100: the share of its liquidity taken out. 0 collects its fees only. */
  percent: number;
  toleranceBps: number;
}

export function prepareRangeRemove(rpc: WriteRpc, cfg: CurveWriteConfig, programId: PublicKey, a: RangeRemoveArgs): Promise<Prepared> {
  return prepareDecrease(rpc, cfg, programId, 'range-remove', a);
}

/** Everything out, fees and rewards included, then the NFT burned and the record closed. */
export function prepareRangeClose(rpc: WriteRpc, cfg: CurveWriteConfig, programId: PublicKey, a: Omit<RangeRemoveArgs, 'percent'>): Promise<Prepared> {
  return prepareDecrease(rpc, cfg, programId, 'range-close', { ...a, percent: 100 });
}

async function prepareDecrease(rpc: WriteRpc, cfg: CurveWriteConfig, programId: PublicKey, kind: Exclude<RangeKind, 'range-open'>, a: RangeRemoveArgs): Promise<Prepared> {
  const bad = toleranceProblem(a.toleranceBps);
  if (bad) return notSent('build', bad);
  if (!Number.isInteger(a.percent) || a.percent < 0 || a.percent > 100) return notSent('build', RANGE_COPY.badPercent);

  // 1. The position, then its pool with everything else in one read.
  let posAccount: RawAccount | null;
  try {
    posAccount = toRaw([a.position], await rpc.getMultipleAccountsInfo([a.position], 'confirmed'))[0] ?? null;
  } catch {
    return notSent('build', RANGE_COPY.readFailed);
  }
  if (!posAccount || posAccount.owner !== programId.toBase58()) return notSent('build', RANGE_COPY.notAPosition);
  const peekPos = decodePersonalPosition(a.position.toBase58(), posAccount.data);
  if (!peekPos || !derivePersonalPosition(programId, new PublicKey(peekPos.nftMint)).equals(a.position)) return notSent('build', RANGE_COPY.notAPosition);
  const poolKey = new PublicKey(peekPos.poolId);
  const first = await readFresh(rpc, programId, poolKey, null, null, []);
  if (!first) return notSent('build', RANGE_COPY.readFailed);
  const peekPool = decodePool(programId, poolKey, first.pool);
  if (typeof peekPool === 'string') return notSent('build', peekPool);
  const nftMint = new PublicKey(peekPos.nftMint);
  const nftAccount = positionNftAccount(a.owner, nftMint);
  const liveRewards = peekPool.rewardInfos.filter((r) => r.initialized);
  const bandKeys = [...new Set([getArrayStartIndex(peekPos.tickLowerIndex, peekPool.tickSpacing), getArrayStartIndex(peekPos.tickUpperIndex, peekPool.tickSpacing)])].map((s) =>
    deriveTickArray(programId, poolKey, s),
  );
  const extra = [a.position, nftAccount, a.owner, ...liveRewards.map((r) => new PublicKey(r.tokenVault)), ...bandKeys];
  const fresh = await readFresh(rpc, programId, poolKey, new PublicKey(peekPool.ammConfig), [new PublicKey(peekPool.tokenMint0), new PublicKey(peekPool.tokenMint1)], extra);
  if (!fresh) return notSent('build', RANGE_COPY.readFailed);
  if (!deployed(fresh.program)) return notSent('build', RANGE_COPY.notDeployed);
  const pool = decodePool(programId, poolKey, fresh.pool);
  if (typeof pool === 'string') return notSent('build', pool);
  const [posRaw, nftRaw] = fresh.extra as [RawAccount | null, RawAccount | null];
  const rewardRaw = fresh.extra.slice(3, 3 + liveRewards.length);
  const bandRaw = fresh.extra.slice(3 + liveRewards.length);
  if (!posRaw || posRaw.owner !== programId.toBase58()) return notSent('build', RANGE_COPY.notAPosition);
  const position = decodePersonalPosition(a.position.toBase58(), posRaw.data) as PersonalPositionView | null;
  if (!position || position.poolId !== pool.address || position.nftMint !== nftMint.toBase58()) return notSent('build', RANGE_COPY.notAPosition);
  // The NFT: one, in the signer's own Token-2022 account for it.
  if (!nftRaw || nftRaw.owner !== TOKEN_2022_PROGRAM_ID.toBase58() || nftRaw.data.length < 72) return notSent('build', RANGE_COPY.notYourNft);
  if (
    new PublicKey(nftRaw.data.subarray(0, 32)).toBase58() !== nftMint.toBase58() ||
    !new PublicKey(nftRaw.data.subarray(32, 64)).equals(a.owner) ||
    tokenAmountOf(nftRaw) !== 1n
  ) {
    return notSent('build', RANGE_COPY.notYourNft);
  }
  const pinned = rangePins(programId, pool, fresh.config, fresh.mint0, fresh.mint1, rewardRaw);
  if (typeof pinned === 'string') return notSent('build', pinned);
  const { pins, pair, tier } = pinned;

  // 2. How much, and the floors.
  const liquidity = kind === 'range-close' ? position.liquidity : (position.liquidity * BigInt(a.percent)) / 100n;
  if (liquidity > 0n && !poolAllows(pool, POOL_STATUS_BIT.decreaseLiquidity)) return notSent('build', RANGE_COPY.removingPaused);
  if (liquidity === 0n && !poolAllows(pool, POOL_STATUS_BIT.collectFee)) return notSent('build', RANGE_COPY.collectingPaused);
  let amounts: [bigint, bigint];
  try {
    amounts = liquidity > 0n ? getDeltaAmountsSigned(pool.tickCurrent, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex, -liquidity) : [0n, 0n];
  } catch (e) {
    if (e instanceof ClmmMathError) return notSent('build', RANGE_COPY.readFailed);
    throw e;
  }
  const min0 = liquidity > 0n ? lessTolerance(amounts[0], a.toleranceBps) : 0n;
  const min1 = liquidity > 0n ? lessTolerance(amounts[1], a.toleranceBps) : 0n;
  const fees = feesNow(pool, position, bandRaw.map((b) => (b && b.owner === programId.toBase58() ? decodeTickArray('', b.data) : null)));
  // Closing needs every reward owed collected first, and a pool whose rewards cannot be collected now cannot do that.
  if (kind === 'range-close' && pins.rewards.length === 0 && position.rewardInfos.some((r) => r.rewardAmountOwed > 0n)) {
    return notSent('build', RANGE_COPY.collectingPaused);
  }
  if (kind === 'range-remove' && liquidity === 0n && fees && fees[0] === 0n && fees[1] === 0n && position.rewardInfos.every((r) => r.rewardAmountOwed === 0n)) {
    return notSent('build', RANGE_COPY.nothingToTake);
  }

  // 3. Where it goes: the signer's own accounts, opened if missing.
  const tokenSide = sideAccount(a.owner, pins, 'token', 'destination');
  const coinSide = sideAccount(a.owner, pins, 'quote', 'destination');
  let accounts: (RawAccount | null)[];
  const rewardRecipients = pins.rewards.map((r) => associatedTokenAddress(r.mint, a.owner, r.program));
  try {
    const keys = [tokenSide.address, coinSide.address, ...rewardRecipients, ...pins.rewards.map((r) => r.mint)];
    accounts = toRaw(keys, await rpc.getMultipleAccountsInfo(keys, 'confirmed'));
  } catch {
    return notSent('build', RANGE_COPY.readFailed);
  }
  const [tokenAcc, coinAcc] = accounts as [RawAccount | null, RawAccount | null];
  const rewardMintRaw = accounts.slice(2 + rewardRecipients.length);
  const notices: string[] = [];
  const tokenCheck = accountCheck(tokenAcc, tokenSide.want);
  if (tokenCheck.refuse) return notSent('build', tokenCheck.refuse);
  notices.push(...tokenCheck.notices);
  let wsol: WsolPlan | null = null;
  if (pins.quote.native) {
    const made = wsolPlanFrom(a.owner, coinAcc);
    if (typeof made === 'string') return notSent('build', made);
    wsol = made;
  } else {
    const coinCheck = accountCheck(coinAcc, coinSide.want);
    if (coinCheck.refuse) return notSent('build', coinCheck.refuse);
    notices.push(...coinCheck.notices);
  }
  const body: TransactionInstruction[] = [];
  const opens: PublicKey[] = [];
  if (!tokenAcc) {
    body.push(openAta(a.owner, tokenSide.address, pins.tokenMint, pins.tokenProgram));
    opens.push(tokenSide.address);
  }
  if (wsol) {
    body.push(openWsolIx(a.owner));
    opens.push(wsol.ata);
  } else if (!coinAcc) {
    body.push(openAta(a.owner, coinSide.address, new PublicKey(pins.quote.mint), new PublicKey(pins.quote.program)));
    opens.push(coinSide.address);
  }
  pins.rewards.forEach((r, i) => {
    if (accounts[2 + i]) return;
    body.push(openAta(a.owner, rewardRecipients[i]!, r.mint, r.program));
    opens.push(rewardRecipients[i]!);
  });
  // What each account this opens keeps as a deposit, sized by its own mint (170 bytes for a
  // Token-2022 coin such as BAYLA, not 165).
  const mintOf = (k: PublicKey): RawAccount | null | 'wsol' => {
    if (wsol && k.equals(wsol.ata)) return 'wsol';
    if (k.equals(tokenSide.address)) return (pair.tokenIsToken0 ? fresh.mint0 : fresh.mint1) ?? null;
    if (k.equals(coinSide.address)) return (pair.tokenIsToken0 ? fresh.mint1 : fresh.mint0) ?? null;
    return rewardMintRaw[rewardRecipients.findIndex((x) => x.equals(k))] ?? null;
  };
  const openRents = new Map<string, bigint>();
  for (const k of opens) {
    const m = mintOf(k);
    const size = m === 'wsol' ? 165 : m ? tokenAccountSize(m) : 'its mint was not read';
    if (typeof size === 'string') return notSent('build', RANGE_COPY.cannotSize(size));
    try {
      openRents.set(k.toBase58(), rentOf(await rpc.getMinimumBalanceForRentExemption(size)));
    } catch {
      return notSent('build', RANGE_COPY.readFailed);
    }
  }
  const own0 = associatedTokenAddress(pins.token0Mint, a.owner, pins.token0Program);
  const own1 = associatedTokenAddress(pins.token1Mint, a.owner, pins.token1Program);
  const positionPins: RangePositionPins = { address: a.position, nftMint, tickLower: position.tickLowerIndex, tickUpper: position.tickUpperIndex, liquidity: position.liquidity };
  body.push(
    decreaseLiquidityV2Ix({
      programId,
      nftOwner: a.owner,
      position,
      pool: { ...pool, status: 0, rewardInfos: pins.rewards.map((r) => ({ ...liveRewards.find((x) => x.tokenMint === r.mint.toBase58())! })) },
      recipientTokenAccount0: own0,
      recipientTokenAccount1: own1,
      liquidity,
      amount0Min: min0,
      amount1Min: min1,
      rewards: pins.rewards.map((r, i) => ({ vault: r.vault, recipient: rewardRecipients[i]!, mint: r.mint })),
    }),
  );
  if (kind === 'range-close') body.push(closePositionIx({ programId, nftOwner: a.owner, nftMint }));
  if (wsol) body.push(...closeWsolIxs(wsol, a.owner));

  const min = sides(pair, min0, min1);
  const quoted = sides(pair, amounts[0], amounts[1]);
  const feesSides = fees ? sides(pair, fees[0], fees[1]) : null;
  const tokenAccounts: WatchList['tokenAccounts'] = [{ account: tokenSide.address, mint: pins.tokenMint, role: 'token', decimals: pair.tokenDecimals }];
  if (wsol) tokenAccounts.push({ account: wsol.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 });
  else tokenAccounts.push({ account: coinSide.address, mint: new PublicKey(pins.quote.mint), role: 'quote', decimals: pins.quote.decimals });
  const openedRent = (pre: { tokens: Map<string, { exists: boolean }> }) =>
    opens
      .filter((k) => !(pre.tokens.get(k.toBase58())?.exists ?? false) && !(wsol && k.equals(wsol.ata) && wsol.closeAfter))
      .reduce((sum, k) => sum + (openRents.get(k.toBase58()) ?? 0n), 0n);

  const intent: RangeIntent = { kind, signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins, position: positionPins, nftMint: null };
  return buildAndSimulate(rpc, {
    kind,
    body,
    extraSigners: [],
    intent,
    watch: { signer: a.owner, tokenAccounts },
    expect: (pre): Expectation => {
      const tokenRow = { account: tokenSide.address, mint: pins.tokenMint, minDelta: min.token, maxDelta: 2n ** 64n };
      const rent = openedRent(pre);
      if (!wsol) return { maxSolOut: rent, tokens: [tokenRow, { account: coinSide.address, mint: new PublicKey(pins.quote.mint), minDelta: min.quote, maxDelta: 2n ** 64n }] };
      // SOL out of the position: closed, it arrives as plain SOL; kept, as wrapped SOL.
      return wsol.closeAfter
        ? { maxSolOut: rent, minSolIn: min.quote > rent ? min.quote - rent : 0n, tokens: [tokenRow, { account: wsol.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }] }
        : { maxSolOut: rent, tokens: [tokenRow, { account: wsol.ata, mint: WSOL_MINT, minDelta: min.quote, maxDelta: 2n ** 64n }] };
    },
    newAccountRent: (pre) => openedRent(pre),
    summarize: (steps): TxSummary | string => {
      const problem = stepsProblem(steps, {
        own: (s) => s.kind === 'range-decrease' && s.liquidity === liquidity && s.min0 === min0 && s.min1 === min1 && s.position.equals(a.position),
        alsoClose: kind === 'range-close',
        wraps: null,
        opens,
        closes: wsol?.closeAfter ?? false,
      });
      if (problem) return problem;
      const range: TickRange = { tickLower: position.tickLowerIndex, tickUpper: position.tickUpperIndex };
      return {
        kind,
        position: a.position,
        percent: kind === 'range-close' ? 100 : a.percent,
        liquidity,
        min,
        quoted,
        fees: feesSides,
        unwrapsWsol: wsol?.closeAfter ?? false,
        notices,
        poolLine: poolLine(pins, pair, tier, pool),
        range: rangeLine(pair, pool, range),
      };
    },
  });
}

/** A position's fees owed now: as of its last update, plus what built up since. Null when its bands did not read. */
function feesNow(pool: PoolStateView, p: PersonalPositionView, bands: (ReturnType<typeof decodeTickArray> | null)[]): [bigint, bigint] | null {
  if (p.liquidity === 0n) return [p.tokenFeesOwed0, p.tokenFeesOwed1];
  const tickOf = (t: number) => {
    const band = bands.find((b) => b && b.startTickIndex === getArrayStartIndex(t, pool.tickSpacing));
    const tick = band?.ticks[(t - band.startTickIndex) / pool.tickSpacing];
    return tick && tick.tick === t ? tick : null;
  };
  const lower = tickOf(p.tickLowerIndex);
  const upper = tickOf(p.tickUpperIndex);
  if (!lower || !upper) return null;
  try {
    const [g0, g1] = getFeeGrowthInside(lower, upper, pool.tickCurrent, pool.feeGrowthGlobal0X64, pool.feeGrowthGlobal1X64);
    return [
      calculateLatestTokenFees(p.tokenFeesOwed0, p.feeGrowthInside0LastX64, g0, p.liquidity),
      calculateLatestTokenFees(p.tokenFeesOwed1, p.feeGrowthInside1LastX64, g1, p.liquidity),
    ];
  } catch (e) {
    if (e instanceof ClmmMathError) return null;
    throw e;
  }
}

/**
 * The decoded steps must be exactly the plan. `own` matches the one range step; `alsoClose`:
 * the closing too; `wraps`: lamports wrapped, null for none; `opens`: every account opened;
 * `closes`: the wrapped-SOL account is closed. A string says what differs.
 */
export function stepsProblem(
  steps: IntentStep[],
  want: { own: (s: IntentStep) => boolean; alsoClose?: boolean; wraps: bigint | null; opens: PublicKey[]; closes: boolean },
): string | null {
  const body = bodySteps(steps);
  const range = body.filter((s) => s.kind === 'range-open' || s.kind === 'range-decrease');
  if (range.length !== 1 || !want.own(range[0]!)) return 'The range-position step in the transaction does not match what was worked out.';
  if (body.filter((s) => s.kind === 'range-close').length !== (want.alsoClose ? 1 : 0)) return 'The transaction closes a position when it should not, or does not when it should.';
  const wraps = body.filter((x) => x.kind === 'wrap-sol');
  const syncs = body.filter((x) => x.kind === 'sync-wsol').length;
  if (want.wraps === null) {
    if (wraps.length !== 0 || syncs !== 0) return 'The transaction wraps SOL when nothing needs wrapping.';
  } else if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.wraps || syncs !== 1) {
    return 'The SOL wrapped does not match what the position takes.';
  }
  const creates = body.filter((x) => x.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((x) => x.kind === 'create-token-account' && x.address.equals(k)).length === 1;
  if (creates.length !== want.opens.length || !want.opens.every(opens)) return 'The transaction opens accounts other than the ones this needs.';
  if (body.filter((x) => x.kind === 'close-wsol').length !== (want.closes ? 1 : 0)) {
    return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  }
  return null;
}
