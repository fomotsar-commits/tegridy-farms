// A swap through one of OUR pools from the main swap page (`lp-swap`), with the site's
// 0.5% fee (SPEC_S3 3.3).
//
// THE ROUTE IS DECIDED HERE, at send time, on one fresh read. The page shows a route; this
// file decides whether that route still holds, and only then builds. Every press of
// Review builds from scratch, in a fixed order, and every "no" is a `not-sent` with its
// own sentence. Nothing is defaulted:
//
//   1. the inputs: both switches are on (LP's, and the route's own), this build's fee
//      settings agree with the committed 0.5% to the team vault, and Jupiter's number
//      for the same trade is either a positive amount or an ANSWERED "no route";
//   2. ONE read of 16 accounts in one slot: the 13 a deposit reads, both routed fee
//      tiers, and the site's fee account. The pool is priced with the tier it records;
//   3. the pool is the pool (`poolPins`): each vault, the share token and the price
//      record equal both their derivation and the pool's own record;
//   4. the token, judged again: unread, blocked, or a copy of a well-known name refuses;
//      its decimals must be the ones the page used (D21);
//   5. the pool may take routed trades (`routeExclusion`, the rule the route line uses);
//   6. the fee account is the vault's, native, and closable by nobody else;
//   7. the wallet's own accounts (`accountCheck`, `wsolPlanFrom`);
//   8. the quote (`routeQuote`): the pool's own fee settings, the CHAIN's clock, the site
//      fee taken off on the SOL side;
//   9. the route, re-ranked on THIS read (`decideRoute`, the rule the route line uses):
//      ours must still pay at least what Jupiter pays; with no Jupiter route, only the
//      token's launch pool, and only while its price agrees with its own average;
//  10. the amount the page showed is still there, within the trader's price limit;
//  11. a buy leaves the wallet enough SOL to stay open on the network (the rent band);
//  12-13. the body, then the shared simulate-and-compare path. The trader's balance rows
//      are exact, or one-sided in the trader's favour. The fee account's row is a LOWER
//      bound: the bytes already pin the fee's amount and destination, so its row only has
//      to prove the fee arrived, and an unrelated payment landing there meanwhile must
//      not block an honest swap (D11).
//
// THE FEE IS ONE TransferChecked OF WRAPPED SOL from the trader's own wrapped-SOL account
// to the team vault's. Never a System transfer plus a sync on that account: mainnet's
// token program re-prices a native account's stored reserve on every sync and would
// credit it far more than the fee (wsol.ts syncCredit). This file never syncs any account
// but the signer's own, and the checker refuses a transaction that does.
//
// A wallet's pre-existing wrapped SOL is never spent and never unwrapped: the fee comes
// out of what this transaction wraps (a buy) or receives (a sell), and the account is
// closed only when it held nothing in the read.
//
// The swap is built from `PoolPins` only, so a caller cannot hand-type a vault. Nothing
// here signs or sends.

import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol, formatTokenAmount } from '../curve/format';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import type { RawAccount } from '../../../solana/lp/accounts';
import { spendableSol } from '../../../solana/lp/liquidityMath';
import { assessPool, tokenReasons, type PriceCheck } from '../../../solana/lp/poolHealth';
import { SITE_ALLOWED_EXTENSIONS, classifyToken, extensionPlain } from '../../../solana/lp/tokenSafety';
import { decideRoute, launchPriceOk, routeExclusion, routeQuote } from '../../../solana/swap/ownRoute';
import { siteFeeAgrees } from '../../../solana/swap/siteFee';
import { SITE_FEE_WSOL_ACCOUNT } from '../../../solana/swap/siteFeeAccount';
import { ownPoolRouteMode, type OwnPoolRouteMode } from '../lpWriteFlag';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { siteFeeAccountStateOf } from './config';
import {
  LP_COPY,
  LP_FEE_RESERVE,
  POOL_READ_FAILED,
  SWAP_CONFIG_UNREAD,
  SWAP_TIER_NOT_ROUTED,
  accountCheck,
  poolPins,
  readPoolForWrite,
} from './liquidity';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { IntentStep, LpOpenGate, PoolPins, Prepared, RouteSwapSummary, TxSummary, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom } from './wsol';

export interface RouteSwapArgs {
  owner: PublicKey;
  pool: PublicKey;
  tokenMint: PublicKey;
  /** The decimals the page used for this token; must equal the mint's (D21). */
  tokenDecimals: number;
  side: 'buy' | 'sell';
  /** buy: lamports; sell: token base units. */
  amountIn: bigint;
  slippageBps: bigint;
  /** Jupiter's net for the same trade, re-quoted at Review and passed through jupiterNet(). null ONLY when Jupiter answered no-route. */
  jupiterNet: bigint | null;
  /** The net the page showed for this route; the fresh net must not fall below it by more than the slippage. */
  shownNet: bigint;
}

// ── copy (SPEC_S3 3.10) ──────────────────────────────────────────────────────

const WSOL_DECIMALS = 9;
const U64_SPAN = 2n ** 64n;
const tokensText = (raw: bigint, decimals: number) => `${formatTokenAmount(raw, decimals, decimals).text} tokens`;

export const ROUTE_COPY = {
  switchedOff: 'Trading through our pools is switched off right now. Nothing was built.',
  feeDisagrees: "This build's fee settings do not match the site's 0.5% fee, so our pools are not used. Nothing was built.",
  jupiterUnread: "We couldn't get Jupiter's price just now, so we can't compare routes. Nothing was sent.",
  poolUnread: 'We could not read the pool just now, so nothing was built. Try again in a moment.',
  poolChanged: LP_COPY.poolChanged,
  tierNotRouted: SWAP_TIER_NOT_ROUTED,
  configUnread: SWAP_CONFIG_UNREAD,
  notEligible: (reason: string) => `Our pool can't take this trade right now: ${reason}. Nothing was built.`,
  tokenRefused: (reason: string) => `${reason} Nothing was built.`,
  decimalsDiffer: (chain: number, page: number) =>
    `This token's decimals on chain (${chain}) differ from what this page used (${page}), so nothing was built. Reload the page.`,
  decimalsUnknown: "This page does not know this token's decimals, so nothing was built. Reload the page.",
  tokenUnread: 'We could not read the token, so we cannot say whether it is safe.',
  feeAccountUnchecked: 'We could not check where the site fee goes, so nothing was built.',
  noTokenAccount: LP_COPY.noTokenAccount,
  overBalance: LP_COPY.overBalance,
  tooSmall: "That amount is too small to swap through our pool: the site fee or the pool's minimum would round to nothing.",
  jupiterPaysMore: "Jupiter now pays more for this amount, so nothing was built. The page now shows Jupiter's route.",
  priceMoved: "Our pool's price moved past your limit since you looked, so nothing was built. The page now shows the new price.",
  noRouteNotLaunch: "Jupiter has no route for this token, and this site then uses only the token's launch pool. Nothing was built.",
  launchPriceMoved: (pct: string) =>
    `This launch pool's price is ${pct}% from its own average over the last half hour. Someone may have just pushed it, so nothing was built.`,
  launchPriceUnread: "We could not check this launch pool's price against its own average, so nothing was built.",
  rentBand: (most: string) =>
    `That would leave your wallet with too little SOL to stay open on the network. The most you can swap from this wallet is ${most} SOL.`,
  cannotSizeAccount: 'This site cannot work out the deposit for an account of this token, so nothing was built.',
  stepsDiffer: 'The swap in the transaction does not match the quote.',
} as const;

// ── the plan, checked against the decoded transaction ────────────────────────

/** The decoded steps must be exactly the plan; a string says what differs. */
export function routeSwapStepsProblem(
  steps: IntentStep[],
  plan: { pool: PublicKey; side: 'buy' | 'sell'; wrap: bigint | null; swapIn: bigint; minOut: bigint; fee: bigint; closeAfter: boolean },
): string | null {
  const body = bodySteps(steps);
  const swaps = body.filter((s) => s.kind === 'pool-swap');
  const s = swaps[0];
  if (swaps.length !== 1 || !s || s.kind !== 'pool-swap') return 'The swap is missing from the transaction.';
  if (!s.pool.equals(plan.pool)) return 'The swap names a different pool.';
  if (s.inputMint.equals(WSOL_MINT) !== (plan.side === 'buy') || s.outputMint.equals(WSOL_MINT) !== (plan.side === 'sell')) return ROUTE_COPY.stepsDiffer;
  if (s.amountIn !== plan.swapIn || s.minimumAmountOut !== plan.minOut) return ROUTE_COPY.stepsDiffer;
  const fees = body.filter((x) => x.kind === 'site-fee');
  const f = fees[0];
  if (fees.length !== 1 || !f || f.kind !== 'site-fee' || f.amount !== plan.fee) return 'The site fee in the transaction does not match the quote.';
  const wraps = body.filter((x) => x.kind === 'wrap-sol');
  const syncs = body.filter((x) => x.kind === 'sync-wsol').length;
  if (plan.wrap === null) {
    if (wraps.length !== 0 || syncs !== 0) return 'The transaction wraps SOL when it should not.';
  } else {
    const w = wraps[0];
    if (wraps.length !== 1 || !w || w.kind !== 'wrap-sol' || w.lamports !== plan.wrap) return 'The SOL wrapped for the swap does not match the amount you pay.';
    if (syncs !== 1) return 'The wrapped SOL is not synced exactly once.';
  }
  // A buy opens your wrapped-SOL and token accounts if they are missing; a sell only the first.
  const creates = new Set<string>();
  for (const x of body) if (x.kind === 'create-token-account') creates.add(x.address.toBase58());
  const wantCreates = plan.side === 'buy' ? 2 : 1;
  if (creates.size !== wantCreates || body.filter((x) => x.kind === 'create-token-account').length !== wantCreates) {
    return 'The transaction does not open exactly the accounts this swap needs.';
  }
  const closes = body.filter((x) => x.kind === 'close-wsol').length;
  if (closes > 1 || (closes === 1) !== plan.closeAfter) return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  return null;
}

function amountOf(acc: RawAccount): bigint {
  return acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true) : 0n;
}

/** The swap, every account from the pins: a caller cannot hand-type a vault or a payout account. */
function swapIx(cp: PublicKey, owner: PublicKey, p: PoolPins, side: 'buy' | 'sell', amountIn: bigint, minimumAmountOut: bigint): TransactionInstruction {
  const [inMint, outMint] = side === 'buy' ? [WSOL_MINT, p.tokenMint] : [p.tokenMint, WSOL_MINT];
  const prog = (m: PublicKey) => (m.equals(WSOL_MINT) ? TOKEN_PROGRAM_ID : p.tokenProgram);
  const vaultOf = (m: PublicKey) => (m.equals(p.token0Mint) ? p.vault0 : p.vault1);
  return swapBaseInputIx({
    programId: cp,
    payer: owner,
    ammConfig: p.ammConfig,
    poolState: p.address,
    inputTokenAccount: associatedTokenAddress(inMint, owner, prog(inMint)),
    outputTokenAccount: associatedTokenAddress(outMint, owner, prog(outMint)),
    inputVault: vaultOf(inMint),
    outputVault: vaultOf(outMint),
    inputTokenProgram: prog(inMint),
    outputTokenProgram: prog(outMint),
    inputTokenMint: inMint,
    outputTokenMint: outMint,
    observationState: p.observation,
    amountIn,
    minimumAmountOut,
  });
}

// ── prepare (3.3) ────────────────────────────────────────────────────────────

export async function prepareRouteSwap(
  rpc: WriteRpc,
  gate: LpOpenGate,
  a: RouteSwapArgs,
  /** Tests and the mainnet dry-run harness only. Every page caller leaves it out. */
  o?: { routeMode?: OwnPoolRouteMode; feeEnv?: { account: string; bps: number } },
): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.amountIn <= 0n) return notSent('build', 'Enter an amount above zero.');
  if (a.side !== 'buy' && a.side !== 'sell') return notSent('build', 'Internal check failed: the swap has no direction.');
  if (gate.kind !== 'open' || gate.mode !== 'on') return notSent('build', ROUTE_COPY.switchedOff);
  if ((o?.routeMode ?? ownPoolRouteMode()) !== 'on') return notSent('build', ROUTE_COPY.switchedOff);
  if (!siteFeeAgrees(o?.feeEnv).ok) return notSent('build', ROUTE_COPY.feeDisagrees);
  // null is Jupiter's ANSWERED "no route". Anything else must be a positive amount:
  // our pool never competes against a number that is not a price.
  if (a.jupiterNet !== null && a.jupiterNet <= 0n) return notSent('build', ROUTE_COPY.jupiterUnread);
  // The page showed an amount for this route, or there is nothing to hold the fresh one to.
  if (a.shownNet <= 0n) return notSent('build', ROUTE_COPY.priceMoved);
  if (!Number.isInteger(a.tokenDecimals) || a.tokenDecimals < 0 || a.tokenDecimals > 18) return notSent('build', ROUTE_COPY.decimalsUnknown);
  const cfg = gate.cfg;
  const cp = cfg.cpSwapProgram;
  const buy = a.side === 'buy';

  // 2. One fresh read: the pool, its fee settings and the fee account in one slot.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint: a.tokenMint, owner: a.owner, forSwap: true });
  if (snap === POOL_READ_FAILED) return notSent('build', ROUTE_COPY.poolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view, chainNow } = snap;
  const p = view.snapshot.pool;
  const config = view.config;
  if (!snap.swap || !config) return notSent('build', ROUTE_COPY.configUnread);

  // 3. The pool is the pool. `lpAccount` is never used by a swap; the pins need one.
  const pins = poolPins(cfg, view, { tokenMint: a.tokenMint, lpAccount: snap.lp.address });
  if (typeof pins === 'string') return notSent('build', pins);
  const tokenProgram = pins.tokenProgram;

  // 4. The token, read again. Unread never admits it.
  const safety = classifyToken(a.tokenMint.toBase58(), snap.mint, snap.metaplex);
  if (safety.kind === 'read' && safety.verdict === 'blocked') {
    return notSent('build', ROUTE_COPY.tokenRefused(LP_COPY.tokenBlocked(safety.blocks[0]?.text ?? 'see the token check')));
  }
  const token = tokenReasons(safety, 'swaps');
  const tokenReason = token.refused[0] ?? token.unchecked[0];
  if (tokenReason !== undefined) return notSent('build', ROUTE_COPY.tokenRefused(tokenReason));
  const facts = safety.kind === 'read' ? safety.facts : null;
  if (!facts) return notSent('build', ROUTE_COPY.tokenRefused(ROUTE_COPY.tokenUnread));
  if (snap.mint.owner !== tokenProgram.toBase58()) return notSent('build', ROUTE_COPY.poolChanged("the token's program"));
  // Repeats the verdict on purpose: a future loosening of classifyToken cannot loosen swaps.
  const outsideSet = facts.extensions.find((e) => !SITE_ALLOWED_EXTENSIONS.has(e));
  if (outsideSet !== undefined) return notSent('build', ROUTE_COPY.tokenRefused(LP_COPY.tokenBlocked(`It uses ${extensionPlain(outsideSet)}.`)));
  const decimals = facts.decimals;
  if (decimals !== a.tokenDecimals) return notSent('build', ROUTE_COPY.decimalsDiffer(decimals, a.tokenDecimals));
  if (decimals !== (view.solIsToken0 ? p.mint1Decimals : p.mint0Decimals)) return notSent('build', ROUTE_COPY.poolChanged("the token's decimals"));

  // 5. Eligibility, on this read: the rule the route line uses. An unread fact (the
  // clock, the fee settings) excludes the pool; it never admits it.
  const exclusion = routeExclusion(view, { cp, chainNow, safety, demoted: new Set() });
  if (exclusion !== null) return notSent('build', ROUTE_COPY.notEligible(exclusion));
  if (chainNow === null) return notSent('build', ROUTE_COPY.notEligible('the network clock could not be read'));

  // 6. The fee account. A swap is never built without its fee step.
  if (siteFeeAccountStateOf(snap.swap.feeAccount).kind !== 'ready') return notSent('build', ROUTE_COPY.feeAccountUnchecked);

  // 7. The wallet's accounts.
  const wsolCheck = accountCheck(snap.wsol.account, { owner: a.owner, mint: WSOL_MINT, program: TOKEN_PROGRAM_ID, use: buy ? 'source' : 'destination', what: 'wrapped SOL', decimals: WSOL_DECIMALS });
  if (wsolCheck.refuse) return notSent('build', wsolCheck.refuse);
  // A stranger's close authority, or a spender on a kept account, is refused here (wsol.ts).
  const plan = wsolPlanFrom(a.owner, snap.wsol.account);
  if (typeof plan === 'string') return notSent('build', plan);
  const tokenAta = snap.tokenAccount.address;
  const tokenAccount = snap.tokenAccount.account;
  if (!buy && !tokenAccount) return notSent('build', ROUTE_COPY.noTokenAccount(tokenAta.toBase58()));
  const tokenCheck = accountCheck(tokenAccount, { owner: a.owner, mint: a.tokenMint, program: tokenProgram, use: buy ? 'destination' : 'source', what: 'token', decimals });
  if (tokenCheck.refuse) return notSent('build', tokenCheck.refuse);
  if (!buy && tokenAccount) {
    const have = amountOf(tokenAccount);
    if (have < a.amountIn) return notSent('build', ROUTE_COPY.overBalance(tokensText(a.amountIn, decimals), tokensText(have, decimals)));
  }

  // 8. The quote: this pool's own fee settings, the chain's clock, our fee on the SOL side.
  const q = routeQuote(view, a.side, a.amountIn, a.slippageBps, chainNow);
  if (!q) return notSent('build', ROUTE_COPY.tooSmall);

  // 9. The route, on this read. The same rule the route line runs on the finder's read;
  // only this answer moves money.
  const candidate = { view, q };
  const isLaunch = view.origin === 'launch-pool';
  let priceCheck: PriceCheck | null = null;
  let launchOk = false;
  if (a.jupiterNet === null && isLaunch) {
    priceCheck = assessPool({ view, tokenDecimals: decimals, chainNow, outside: { kind: 'no-route', detail: 'Jupiter has no route for this token' }, safety }).price;
    launchOk = launchPriceOk(view, { chainNow, safety });
  }
  const choice = decideRoute({
    best: candidate,
    launch: isLaunch ? { ...candidate, priceOk: launchOk } : null,
    jupiter: a.jupiterNet === null ? { kind: 'no-route' } : { kind: 'net', net: a.jupiterNet },
  });
  if (choice.route !== 'own' || choice.own.view.address !== view.address) {
    if (a.jupiterNet !== null) return notSent('build', choice.route === 'none' ? ROUTE_COPY.jupiterUnread : ROUTE_COPY.jupiterPaysMore);
    if (!isLaunch) return notSent('build', ROUTE_COPY.noRouteNotLaunch);
    if (priceCheck?.state === 'disagrees') return notSent('build', ROUTE_COPY.launchPriceMoved((Math.abs(priceCheck.diff) * 100).toFixed(1)));
    return notSent('build', ROUTE_COPY.launchPriceUnread);
  }

  // 10. The shown floor: today's display-vs-submit rule, in net terms.
  if (q.netExpected < a.shownNet - (a.shownNet * a.slippageBps) / 10_000n) return notSent('build', ROUTE_COPY.priceMoved);

  // 11. The rent band (a buy only: a sell pays only network fees, and the simulation is
  // the network's own answer there).
  const tokenRent = snap.rents.tokenAccountForMint;
  if (buy) {
    if (!tokenAccount && tokenRent === null) return notSent('build', ROUTE_COPY.cannotSizeAccount);
    const most = spendableSol({
      lamports: snap.signerLamports,
      walletFloor: snap.rents.walletFloor,
      feeReserve: LP_FEE_RESERVE,
      lpAccountRent: tokenAccount ? 0n : (tokenRent ?? 0n),
      wsolCreateRent: snap.wsol.account ? 0n : snap.rents.tokenAccount165,
    });
    if (a.amountIn > most) return notSent('build', ROUTE_COPY.rentBand(formatSol(most, 9)));
  }

  // 12. The body. The fee is ONE TransferChecked of wrapped SOL: on a buy out of what was
  // just wrapped, before the swap; on a sell out of what the swap just paid, after it.
  const feeIx = createTransferCheckedInstruction(plan.ata, WSOL_MINT, SITE_FEE_WSOL_ACCOUNT, a.owner, q.fee, WSOL_DECIMALS, [], TOKEN_PROGRAM_ID);
  const swap = swapIx(cp, a.owner, pins, a.side, q.swapIn, q.minOut);
  const body: TransactionInstruction[] = buy
    ? [
        openWsolIx(a.owner),
        ...wrapIxs(a.owner, a.amountIn),
        feeIx,
        createAssociatedTokenAccountIdempotentInstruction(a.owner, tokenAta, a.owner, a.tokenMint, tokenProgram),
        swap,
        ...closeWsolIxs(plan, a.owner),
      ]
    : [openWsolIx(a.owner), swap, feeIx, ...closeWsolIxs(plan, a.owner)];

  const rentIfOpened = (exists: boolean) => (buy && !exists ? (tokenRent ?? 0n) : 0n);
  const notices = [...tokenCheck.notices];
  const tier = snap.swap.tier;

  // 13. Simulate twice and compare (3.6).
  return buildAndSimulate(rpc, {
    kind: 'lp-swap',
    body,
    extraSigners: [],
    intent: { kind: 'lp-swap', side: a.side, signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins },
    watch: {
      signer: a.owner,
      tokenAccounts: [
        { account: tokenAta, mint: a.tokenMint, role: 'token', decimals },
        { account: plan.ata, mint: WSOL_MINT, role: 'wsol', decimals: WSOL_DECIMALS },
        { account: SITE_FEE_WSOL_ACCOUNT, mint: WSOL_MINT, role: 'treasury', decimals: WSOL_DECIMALS },
      ],
    },
    expect: (pre, rents) => {
      const tokenExists = pre.tokens.get(tokenAta.toBase58())?.exists ?? false;
      // The fee arrived. No upper bound: the bytes pin its amount and destination, and
      // every lamport it could gain beyond that must leave one of the trader's rows.
      const feeRow = { account: SITE_FEE_WSOL_ACCOUNT, mint: WSOL_MINT, minDelta: q.fee, maxDelta: U64_SPAN };
      if (buy) {
        // Closed: it ends where it began. Kept: exactly what its own sync credits from
        // lamports it already held; the trader's own wrapped SOL is never spent.
        const kept = plan.closeAfter ? 0n : syncCredit(pre.tokens.get(plan.ata.toBase58()), rents.tokenAccount);
        return {
          maxSolOut: a.amountIn + rentIfOpened(tokenExists),
          tokens: [
            { account: tokenAta, mint: a.tokenMint, minDelta: q.minOut, maxDelta: U64_SPAN },
            { account: plan.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: kept },
            feeRow,
          ],
        };
      }
      const tokenRow = { account: tokenAta, mint: a.tokenMint, minDelta: -a.amountIn, maxDelta: -a.amountIn };
      return plan.closeAfter
        ? {
            maxSolOut: 0n,
            minSolIn: q.minOut - q.fee,
            // The close pays out everything in the account. It held nothing in the
            // builder's read; wrapped SOL that arrived since makes this negative, and is
            // blocked rather than unwrapped.
            tokens: [tokenRow, { account: plan.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }, feeRow],
          }
        : {
            maxSolOut: 0n,
            tokens: [tokenRow, { account: plan.ata, mint: WSOL_MINT, minDelta: q.minOut - q.fee, maxDelta: U64_SPAN }, feeRow],
          };
    },
    newAccountRent: (pre) => rentIfOpened(pre.tokens.get(tokenAta.toBase58())?.exists ?? false),
    summarize: (steps): TxSummary | string => {
      const problem = routeSwapStepsProblem(steps, {
        pool: pins.address,
        side: a.side,
        wrap: buy ? a.amountIn : null,
        swapIn: q.swapIn,
        minOut: q.minOut,
        fee: q.fee,
        closeAfter: plan.closeAfter,
      });
      if (problem) return problem;
      const stepsBody = bodySteps(steps);
      const s = stepsBody.find((x) => x.kind === 'pool-swap');
      const f = stepsBody.find((x) => x.kind === 'site-fee');
      const w = stepsBody.find((x) => x.kind === 'wrap-sol');
      if (!s || s.kind !== 'pool-swap' || !f || f.kind !== 'site-fee') return ROUTE_COPY.stepsDiffer;
      if (buy && (!w || w.kind !== 'wrap-sol')) return ROUTE_COPY.stepsDiffer;
      const summary: RouteSwapSummary = {
        kind: 'lp-swap',
        pool: s.pool,
        origin: pins.origin,
        config,
        tier,
        side: a.side,
        tokenMint: a.tokenMint,
        tokenDecimals: decimals,
        amountIn: buy && w && w.kind === 'wrap-sol' ? w.lamports : s.amountIn,
        swap: { amountIn: s.amountIn, minimumAmountOut: s.minimumAmountOut },
        fee: { amount: f.amount, to: f.to },
        quote: q.quote,
        netExpected: q.netExpected,
        netGuaranteed: buy ? s.minimumAmountOut : s.minimumAmountOut - f.amount,
        versus: a.jupiterNet,
        priceCheck: a.jupiterNet === null ? priceCheck : null,
        tokenWarnings: safety.kind === 'read' ? safety.warnings : [],
        unwrapsWsol: stepsBody.some((x) => x.kind === 'close-wsol'),
        wsolHeldBefore: plan.heldBefore,
        notices,
      };
      return summary;
    },
  });
}
