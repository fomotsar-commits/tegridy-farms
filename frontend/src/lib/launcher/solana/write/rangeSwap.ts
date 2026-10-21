// A swap in one of our range pools, from the swap page (kind `range-swap`). One fresh read of
// the pool, its tier, its mints, the chain's clock and the price bands ahead of the price;
// the quote walks those bands as the program does (solana/clmm/quote.ts); nothing is built
// when the pool now pays less than the aggregator was seen to pay; the bytes go through
// `buildAndSimulate`, and the checker rebuilds the swap from the pins and the bands it walks.
// What is paid out goes to the signer's own associated account. Nothing here signs or sends.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatTokenAmount } from '../curve/format';
import { applySlippage } from '../curve/math';
import { swapV2Ix } from '../../../solana/clmm/ix';
import { getArrayStartIndex, initializedTickArrayStarts } from '../../../solana/clmm/bitmap';
import { MAX_SWAP_BANDS, quoteSwap } from '../../../solana/clmm/quote';
import {
  POOL_STATUS_BIT,
  isFeeOnInput,
  decodeBitmapExtension,
  decodeTickArray,
  deriveBitmapExtension,
  deriveTickArray,
  poolAllows,
  type BitmapExtensionView,
  type PoolStateView,
  type TickArrayView,
} from '../../../solana/clmm/program';
import type { RawAccount } from '../../../solana/lp/accounts';
import { CLOCK_SYSVAR, chainTimeOf, tokenVault } from '../../../solana/lp/poolFinder';
import { tokenAccountSize } from '../../../solana/lp/tokenAccountSize';
import { readPair } from '../../../solana/lp/quotes';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { accountCheck, rentOf, toRaw } from './liquidity';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { RANGE_COPY, decodePool, deployed, poolLine, rangePins, readFresh, sideAccount, tokenAmountOf } from './range';
import { slippageProblem } from './trade';
import { VENUE_SWAP_COPY, type VenueSwapArgs } from './venueSwap';
import type { CurveWriteConfig, IntentStep, Prepared, RangeIntent, TxSummary, WatchList, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom, type WsolPlan } from './wsol';

export const RANGE_SWAP_COPY = {
  swapsPaused: 'Swaps in this range pool are switched off by the venue’s vault right now.',
  notOpenYet: 'This range pool does not take swaps yet.',
  tooLarge: `This trade would walk through more than ${MAX_SWAP_BANDS} price bands of the pool, more than one swap here carries. Try a smaller amount.`,
  partFill: 'This pool cannot fill the whole trade at any price. Try a smaller amount.',
  bandUnread: 'A price band the pool marks as used did not read, so the swap could not be priced. Try again in a moment.',
} as const;

export type RangeSwapArgs = VenueSwapArgs;

/** The bands the pool marks as used from its price onward in the swap's direction, nearest first. */
function bandsAhead(pool: PoolStateView, ext: BitmapExtensionView | null, zeroForOne: boolean): number[] {
  const here = getArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
  const starts = initializedTickArrayStarts(pool, ext);
  return (zeroForOne ? starts.filter((s) => s <= here).sort((a, b) => b - a) : starts.filter((s) => s >= here).sort((a, b) => a - b)).slice(0, MAX_SWAP_BANDS);
}

/** The decoded steps must be exactly the plan. A string says what differs. */
export function rangeSwapStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; inputMint: PublicKey; outputMint: PublicKey; amountIn: bigint; minimumAmountOut: bigint; wraps: bigint | null; opens: PublicKey[]; closes: boolean },
): string | null {
  const body = bodySteps(steps);
  const swaps = body.filter((s) => s.kind === 'range-swap');
  const s = swaps[0];
  if (swaps.length !== 1 || !s || s.kind !== 'range-swap') return 'The swap is missing from the transaction.';
  if (s.amountIn !== want.amountIn || s.minimumAmountOut !== want.minimumAmountOut) return 'The swap in the transaction does not match the quote.';
  if (!s.pool.equals(want.pool)) return 'The swap names a different pool.';
  if (!s.inputMint.equals(want.inputMint) || !s.outputMint.equals(want.outputMint)) return 'The swap trades different tokens than the quote.';
  const wraps = body.filter((x) => x.kind === 'wrap-sol');
  const syncs = body.filter((x) => x.kind === 'sync-wsol').length;
  if (want.wraps === null) {
    if (wraps.length !== 0 || syncs !== 0) return 'The transaction wraps SOL, and this swap does not pay in SOL.';
  } else if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.wraps || syncs !== 1) {
    return 'The SOL wrapped for the swap does not match what it pays in.';
  }
  const creates = body.filter((x) => x.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((x) => x.kind === 'create-token-account' && x.address.equals(k)).length === 1;
  if (creates.length !== want.opens.length || !want.opens.every(opens)) return 'The transaction opens accounts other than the ones this swap needs.';
  if (body.filter((x) => x.kind === 'close-wsol').length !== (want.closes ? 1 : 0)) {
    return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  }
  return null;
}

export async function prepareRangeSwap(rpc: WriteRpc, cfg: CurveWriteConfig, programId: PublicKey, a: RangeSwapArgs): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.amountIn <= 0n) return notSent('build', 'Enter an amount above zero.');
  const pair = readPair(a.inputMint.toBase58(), a.outputMint.toBase58());
  if (!pair) return notSent('build', VENUE_SWAP_COPY.notOurPair);

  // 2. A first look at the pool, for its tier, mints and map; then ONE read of everything
  // the swap is priced and built from, the bands ahead of the price included.
  const first = await readFresh(rpc, programId, a.pool, null, null, []);
  if (!first) return notSent('build', VENUE_SWAP_COPY.poolUnread);
  if (!deployed(first.program)) return notSent('build', RANGE_COPY.notDeployed);
  const peek = decodePool(programId, a.pool, first.pool);
  if (typeof peek === 'string') return notSent('build', peek);
  const zeroForOne = a.inputMint.toBase58() === peek.tokenMint0;
  if (!zeroForOne && a.inputMint.toBase58() !== peek.tokenMint1) return notSent('build', VENUE_SWAP_COPY.notOurPair);
  if (a.outputMint.toBase58() !== (zeroForOne ? peek.tokenMint1 : peek.tokenMint0)) return notSent('build', VENUE_SWAP_COPY.notOurPair);
  // A spacing under 15 can reach past the pool's own map: its far-band map is read, and the
  // bands are chosen again from it below.
  const extAddress = peek.tickSpacing < 15 ? deriveBitmapExtension(programId, a.pool) : null;
  let starts = bandsAhead(peek, null, zeroForOne);
  // The clock, the far-band map, the bands, then the pool's two vaults: a frozen one moves nothing.
  const read = async (s: number[]) =>
    readFresh(rpc, programId, a.pool, new PublicKey(peek.ammConfig), [new PublicKey(peek.tokenMint0), new PublicKey(peek.tokenMint1)], [
      new PublicKey(CLOCK_SYSVAR),
      ...(extAddress ? [extAddress] : []),
      ...s.map((x) => deriveTickArray(programId, a.pool, x)),
      new PublicKey(peek.tokenVault0),
      new PublicKey(peek.tokenVault1),
    ]);
  let fresh = await read(starts);
  if (!fresh) return notSent('build', VENUE_SWAP_COPY.poolUnread);
  let ext: BitmapExtensionView | null = null;
  if (extAddress) {
    const e = fresh.extra[1] ?? null;
    if (e) {
      if (e.owner !== programId.toBase58()) return notSent('build', RANGE_COPY.poolChanged('its far-band map'));
      ext = decodeBitmapExtension(extAddress.toBase58(), e.data);
      if (!ext || ext.poolId !== a.pool.toBase58()) return notSent('build', RANGE_COPY.poolChanged('its far-band map'));
    }
  }
  const pool0 = decodePool(programId, a.pool, fresh.pool);
  if (typeof pool0 === 'string') return notSent('build', pool0);
  const again = bandsAhead(pool0, ext, zeroForOne);
  if (again.join() !== starts.join()) {
    // The map moved between the two reads, or the far-band map adds bands: read once more.
    starts = again;
    fresh = await read(starts);
    if (!fresh) return notSent('build', VENUE_SWAP_COPY.poolUnread);
  }
  if (!deployed(fresh.program)) return notSent('build', RANGE_COPY.notDeployed);
  const pool = decodePool(programId, a.pool, fresh.pool);
  if (typeof pool === 'string') return notSent('build', pool);
  if (bandsAhead(pool, ext, zeroForOne).join() !== starts.join()) return notSent('build', VENUE_SWAP_COPY.poolUnread);
  const pinned = rangePins(programId, pool, fresh.config, fresh.mint0, fresh.mint1, [], false);
  if (typeof pinned === 'string') return notSent('build', pinned);
  const { pins, tier } = pinned;
  if (!poolAllows(pool, POOL_STATUS_BIT.swap)) return notSent('build', RANGE_SWAP_COPY.swapsPaused);
  const chainNow = chainTimeOf(fresh.extra[0] ?? null);
  if (chainNow === null) return notSent('build', VENUE_SWAP_COPY.noClock);
  const bandsAt = extAddress ? 2 : 1;
  const bandRaw = fresh.extra.slice(bandsAt, bandsAt + starts.length);
  const [vault0, vault1] = fresh.extra.slice(bandsAt + starts.length);
  const v0 = tokenVault(vault0 ?? null, pins.token0Program.toBase58());
  const v1 = tokenVault(vault1 ?? null, pins.token1Program.toBase58());
  if (!v0 || !v1) return notSent('build', RANGE_COPY.poolChanged('its vaults'));
  if (v0.frozen || v1.frozen) return notSent('build', RANGE_COPY.vaultFrozen);
  const bands = new Map<number, TickArrayView>();
  for (let i = 0; i < starts.length; i++) {
    const raw = bandRaw[i] ?? null;
    const address = deriveTickArray(programId, a.pool, starts[i]!).toBase58();
    const band = raw && raw.owner === programId.toBase58() ? decodeTickArray(address, raw.data) : null;
    if (!band || band.poolId !== a.pool.toBase58() || band.startTickIndex !== starts[i]) return notSent('build', RANGE_SWAP_COPY.bandUnread);
    bands.set(starts[i]!, band);
  }

  // 3. The quote, as the program walks it, by the chain's clock; the routing rule held on it.
  const q = quoteSwap({
    pool,
    config: tier,
    band: (s) => bands.get(s),
    extension: ext,
    zeroForOne,
    isBaseInput: true,
    amount: a.amountIn,
    sqrtPriceLimitX64: 0n,
    blockTimestamp: Number(chainNow),
  });
  if (q.kind === 'needs-band') return notSent('build', RANGE_SWAP_COPY.tooLarge);
  if (q.kind === 'refused') {
    if (q.code === 'NotApproved') return notSent('build', RANGE_SWAP_COPY.notOpenYet);
    if (q.code === 'RequireEqViolated') return notSent('build', RANGE_SWAP_COPY.partFill);
    return notSent('build', VENUE_SWAP_COPY.cannotPrice);
  }
  if (!q.filled || q.amountIn !== a.amountIn || q.amountOut <= 0n) return notSent('build', RANGE_SWAP_COPY.partFill);
  if (a.aggregator.kind === 'quoted' && q.amountOut < a.aggregator.out) {
    return notSent('build', a.aggregator.when === 'now' ? VENUE_SWAP_COPY.routeMoved : VENUE_SWAP_COPY.underLastQuote);
  }
  const minimumAmountOut = applySlippage(q.amountOut, a.slippageBps);
  if (minimumAmountOut === null || minimumAmountOut <= 0n) return notSent('build', VENUE_SWAP_COPY.tooSmall);
  const walked = q.bands.map((s) => deriveTickArray(programId, a.pool, s));
  const extension = q.passExtension ? extAddress : null;

  // 4. The wallet's two accounts. SOL is wrapped from the wallet itself; anything else paid
  // in must already sit in the signer's own account for it.
  const paysCoin = a.inputMint.toBase58() === pair.quote.mint;
  const coin = pair.quote;
  const tokenIn = sideAccount(a.owner, pins, 'token', paysCoin ? 'destination' : 'source');
  const coinIn = sideAccount(a.owner, pins, 'quote', paysCoin ? 'source' : 'destination');
  let tokenAcc: RawAccount | null;
  let coinAcc: RawAccount | null;
  let rentTokenAccount: bigint;
  // The account paid into is sized by its own mint: 170 bytes for a Token-2022 coin such as BAYLA.
  const outMintRaw = (zeroForOne ? fresh.mint1 : fresh.mint0) ?? null;
  const outSize = coin.native && !paysCoin ? 165 : outMintRaw ? tokenAccountSize(outMintRaw) : 'its mint was not read';
  if (typeof outSize === 'string') return notSent('build', RANGE_COPY.cannotSize(outSize));
  try {
    [tokenAcc, coinAcc] = toRaw([tokenIn.address, coinIn.address], await rpc.getMultipleAccountsInfo([tokenIn.address, coinIn.address], 'confirmed')) as [RawAccount | null, RawAccount | null];
    rentTokenAccount = rentOf(await rpc.getMinimumBalanceForRentExemption(outSize));
  } catch {
    return notSent('build', VENUE_SWAP_COPY.poolUnread);
  }
  const tokenDecimals = pinned.pair.tokenDecimals;
  const inSide = paysCoin ? { ...coinIn, held: coinAcc, decimals: coin.decimals, name: coin.symbol } : { ...tokenIn, held: tokenAcc, decimals: tokenDecimals, name: 'tokens' };
  const outSide = paysCoin ? { ...tokenIn, held: tokenAcc } : { ...coinIn, held: coinAcc };
  const inIsSol = coin.native && paysCoin;
  const outIsSol = coin.native && !paysCoin;
  const notices: string[] = [];
  if (!inIsSol) {
    const inCheck = accountCheck(inSide.held, inSide.want);
    if (inCheck.refuse) return notSent('build', inCheck.refuse);
    if (!inSide.held) return notSent('build', VENUE_SWAP_COPY.noSource(inSide.name, inSide.address.toBase58()));
    const have = tokenAmountOf(inSide.held);
    if (have < a.amountIn) {
      const fmt = (v: bigint) => `${formatTokenAmount(v, inSide.decimals, inSide.decimals).text} ${inSide.name}`;
      return notSent('build', VENUE_SWAP_COPY.short(fmt(a.amountIn), fmt(have)));
    }
  }
  if (!outIsSol) {
    const outCheck = accountCheck(outSide.held, outSide.want);
    if (outCheck.refuse) return notSent('build', outCheck.refuse);
    notices.push(...outCheck.notices);
  }

  // 5. Wrapped SOL: only a SOL pool has a plan for it. `null` = nothing is wrapped.
  let plan: WsolPlan | null = null;
  if (coin.native) {
    const made = wsolPlanFrom(a.owner, coinAcc);
    if (typeof made === 'string') return notSent('build', made);
    plan = made;
  }

  // 6. The one swap, from the pins and the bands the quote walks.
  const inProgram = zeroForOne ? pins.token0Program : pins.token1Program;
  const outProgram = zeroForOne ? pins.token1Program : pins.token0Program;
  const inAccount = associatedTokenAddress(a.inputMint, a.owner, inProgram);
  const outAccount = associatedTokenAddress(a.outputMint, a.owner, outProgram);
  const swap = swapV2Ix({
    programId,
    payer: a.owner,
    pool,
    zeroForOne,
    inputTokenAccount: inAccount,
    outputTokenAccount: outAccount,
    tickArrays: walked,
    bitmapExtension: extension,
    amount: a.amountIn,
    otherAmountThreshold: minimumAmountOut,
    sqrtPriceLimitX64: 0n,
    isBaseInput: true,
  });
  const opens: PublicKey[] = [];
  const body: TransactionInstruction[] = [];
  if (plan) {
    body.push(openWsolIx(a.owner));
    opens.push(plan.ata);
    if (inIsSol) body.push(...wrapIxs(a.owner, a.amountIn));
  }
  if (!outIsSol) {
    // Idempotent: the program needs the account, and an existing one is left as it is.
    body.push(createAssociatedTokenAccountIdempotentInstruction(a.owner, outAccount, a.owner, a.outputMint, outProgram));
    opens.push(outAccount);
  }
  body.push(swap);
  if (plan) body.push(...closeWsolIxs(plan, a.owner));

  const tokenAccounts: WatchList['tokenAccounts'] = [];
  if (!inIsSol) tokenAccounts.push({ account: inAccount, mint: a.inputMint, role: paysCoin ? 'quote' : 'token', decimals: inSide.decimals });
  if (!outIsSol) tokenAccounts.push({ account: outAccount, mint: a.outputMint, role: paysCoin ? 'token' : 'quote', decimals: paysCoin ? tokenDecimals : coin.decimals });
  if (plan) tokenAccounts.push({ account: plan.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 });

  const intent: RangeIntent = {
    kind: 'range-swap',
    signer: a.owner,
    cfg,
    maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
    pins,
    position: null,
    nftMint: null,
    swap: { inputMint: a.inputMint, bands: walked, extension },
  };

  // 7. Simulate twice and compare.
  return buildAndSimulate(rpc, {
    kind: 'range-swap',
    body,
    extraSigners: [],
    intent,
    watch: { signer: a.owner, tokenAccounts },
    expect: (pre, rents) => {
      const exists = (k: PublicKey) => pre.tokens.get(k.toBase58())?.exists ?? false;
      const openCost = outIsSol || exists(outAccount) ? 0n : rentTokenAccount;
      // At least what the swap names comes in; at most what it names goes out.
      const outRow = { account: outAccount, mint: a.outputMint, minDelta: minimumAmountOut, maxDelta: 2n ** 64n };
      const inRow = { account: inAccount, mint: a.inputMint, minDelta: -a.amountIn, maxDelta: 2n ** 64n };
      if (!plan) return { maxSolOut: openCost, tokens: [inRow, outRow] };
      const wsolRent = !exists(plan.ata) && !plan.closeAfter ? rents.tokenAccount : 0n;
      if (inIsSol) {
        const kept = plan.closeAfter ? 0n : syncCredit(pre.tokens.get(plan.ata.toBase58()), rents.tokenAccount);
        return {
          maxSolOut: a.amountIn + openCost + wsolRent,
          tokens: [outRow, { account: plan.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: plan.closeAfter ? 0n : 2n ** 64n }],
        };
      }
      return plan.closeAfter
        ? { maxSolOut: 0n, minSolIn: minimumAmountOut, tokens: [inRow, { account: plan.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }] }
        : { maxSolOut: wsolRent, tokens: [inRow, { account: plan.ata, mint: WSOL_MINT, minDelta: minimumAmountOut, maxDelta: 2n ** 64n }] };
    },
    newAccountRent: (pre) => (!outIsSol && !(pre.tokens.get(outAccount.toBase58())?.exists ?? false) ? rentTokenAccount : 0n),
    summarize: (steps): TxSummary | string => {
      const problem = rangeSwapStepsProblem(steps, {
        pool: pins.address,
        inputMint: a.inputMint,
        outputMint: a.outputMint,
        amountIn: a.amountIn,
        minimumAmountOut,
        wraps: inIsSol ? a.amountIn : null,
        opens,
        closes: plan?.closeAfter ?? false,
      });
      if (problem) return problem;
      const s = bodySteps(steps).find((x) => x.kind === 'range-swap');
      if (!s || s.kind !== 'range-swap') return 'The swap is missing from the transaction.';
      return {
        kind: 'range-swap',
        poolLine: poolLine(pins, pinned.pair, tier),
        paysCoin,
        amountIn: s.amountIn,
        minimumAmountOut: s.minimumAmountOut,
        quotedOut: q.amountOut,
        bandsCrossed: walked.length,
        feeOnInput: isFeeOnInput(pool.feeOn, zeroForOne),
        aggregator: a.aggregator,
        unwrapsWsol: bodySteps(steps).some((x) => x.kind === 'close-wsol'),
        wsolHeldBefore: plan ? plan.heldBefore : 0n,
        notices,
      };
    },
  });
}
