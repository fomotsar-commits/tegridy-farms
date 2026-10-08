// A swap in one of our pools, from the swap page (kind `venue-swap`). One fresh read of
// the pool (`readPoolForWrite`); the quote comes from that read and the pool's OWN fee
// settings; nothing is built when the pool now pays less than the aggregator was seen to
// pay (`aggregator`); the bytes go through `buildAndSimulate`. What is paid out goes to
// the signer's own associated account: the pool program does not check whose it is.
// Nothing here signs or sends.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatTokenAmount } from '../curve/format';
import { applySlippage } from '../curve/math';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import { quoteOwnPool } from '../../../solana/cpswap/read';
import { OWN_ROUTE_COPY } from '../../../solana/swap/ownPoolRoute';
import type { RawAccount } from '../../../solana/lp/accounts';
import { QUOTE_COINS_OR, readPair } from '../../../solana/lp/quotes';
import { BUILDABLE_EXTENSIONS, decodeMintAccount, extensionPlain } from '../../../solana/lp/tokenSafety';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { LP_COPY, POOL_READ_FAILED, accountCheck, coinAccount, poolPins, readPoolForWrite, type AccountWant } from './liquidity';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { AggregatorSeen, IntentStep, Prepared, SwapOpenGate, TxSummary, WatchList, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom, type WsolPlan } from './wsol';

export const VENUE_SWAP_COPY = {
  notOurPair: `This site swaps in pools that pair a token with ${QUOTE_COINS_OR} only.`,
  poolUnread: 'We could not read the pool just now, so nothing was built. Try again in a moment.',
  notAToken: (why: string) => `This token cannot be swapped here: ${why}.`,
  tokenExtension: (what: string) =>
    `This token uses ${what}, so this site cannot work out exactly what a swap in this pool pays. Nothing was built.`,
  feesUnread: 'This pool’s fee settings could not be read, so the swap could not be priced. Nothing was built.',
  noClock: 'Could not read the network clock to check the pool is open.',
  cannotPrice: 'The pool cannot price this trade right now.',
  tooSmall: 'That amount is too small to protect with a price limit.',
  routeMoved: OWN_ROUTE_COPY.routeMoved,
  noSource: (what: string, address: string) => `You hold no ${what} in your main account for it (${address}).`,
  short: (need: string, have: string) => `This needs ${need} and your wallet has ${have}.`,
  cannotSize: 'This site cannot open your account for what this swap pays out, so nothing was built.',
} as const;

export interface VenueSwapArgs {
  owner: PublicKey;
  /** One of our pools for this pair, as the route chose it. Read again here, whole. */
  pool: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  slippageBps: bigint;
  /**
   * What the aggregator was seen to pay for the same trade, just before this call. When
   * it quoted, the pool must pay at least that. It is carried to the review as it is.
   */
  aggregator: AggregatorSeen;
}

function amountOf(acc: RawAccount | null): bigint {
  return acc && acc.data.length >= 72 ? new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true) : 0n;
}

/**
 * The decoded steps of a swap must be exactly the plan. A string says what differs.
 * `wraps`: the lamports wrapped when SOL is paid in, null when nothing is wrapped.
 * `opens`: every account it opens. `closes`: whether the wrapped-SOL account is closed.
 */
export function swapStepsProblem(
  steps: IntentStep[],
  want: { pool: PublicKey; inputMint: PublicKey; outputMint: PublicKey; amountIn: bigint; minimumAmountOut: bigint; wraps: bigint | null; opens: PublicKey[]; closes: boolean },
): string | null {
  const body = bodySteps(steps);
  const swaps = body.filter((s) => s.kind === 'pool-swap');
  const s = swaps[0];
  if (swaps.length !== 1 || !s || s.kind !== 'pool-swap') return 'The swap is missing from the transaction.';
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

export async function prepareVenueSwap(rpc: WriteRpc, gate: SwapOpenGate, a: VenueSwapArgs): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.amountIn <= 0n) return notSent('build', 'Enter an amount above zero.');
  const pair = readPair(a.inputMint.toBase58(), a.outputMint.toBase58());
  if (!pair) return notSent('build', VENUE_SWAP_COPY.notOurPair);
  const cfg = gate.cfg;
  const coin = pair.quote;
  const tokenMint = new PublicKey(pair.tokenMint);
  const paysCoin = a.inputMint.toBase58() === coin.mint;

  // 2. One fresh read; the pool is the pool, and pairs exactly these two.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint, quote: coin, owner: a.owner });
  if (snap === POOL_READ_FAILED) return notSent('build', VENUE_SWAP_COPY.poolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;
  const coinIs0 = view.quoteIsToken0;
  const tokenProgram = new PublicKey(coinIs0 ? p.token1Program : p.token0Program);
  const tokenDecimals = coinIs0 ? p.mint1Decimals : p.mint0Decimals;

  // 3. The token: the mint the pool names, and nothing that changes what a transfer
  // moves (the one set the liquidity builders use). A transfer fee would make the pool's
  // sum, and so the comparison with the aggregator, wrong.
  const mint = decodeMintAccount(snap.mint.owner, snap.mint.data);
  if (!mint.ok) return notSent('build', VENUE_SWAP_COPY.notAToken(mint.reason));
  if (snap.mint.owner !== tokenProgram.toBase58()) return notSent('build', LP_COPY.poolChanged("the token's program"));
  if (mint.value.decimals !== tokenDecimals) return notSent('build', LP_COPY.poolChanged("the token's decimals"));
  const outside = mint.value.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
  if (outside !== undefined) return notSent('build', VENUE_SWAP_COPY.tokenExtension(extensionPlain(outside)));
  // The pairing coin's own mint, when it sits under Token-2022 (BAYLA): the same rule, as
  // the withdrawal builder holds it. `readPoolForWrite` read it in the same slot.
  if (snap.quoteMint && coin.program === TOKEN_2022_PROGRAM_ID.toBase58()) {
    const coinMint = decodeMintAccount(snap.quoteMint.owner, snap.quoteMint.data);
    if (!coinMint.ok) return notSent('build', LP_COPY.coinChanged(coin.symbol, coinMint.reason));
    const coinOutside = coinMint.value.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
    if (coinOutside !== undefined) return notSent('build', LP_COPY.coinChanged(coin.symbol, `it uses ${extensionPlain(coinOutside)}`));
  }
  if (view.vaultsFrozen) return notSent('build', LP_COPY.vaultFrozen(coin.risk === null ? undefined : `The token's issuer, or ${coin.symbol}'s,`));
  const config = view.config;
  if (!config) return notSent('build', VENUE_SWAP_COPY.feesUnread);

  // 4. The quote, by the CHAIN's clock, and the routing rule held on it.
  if (snap.chainNow === null && p.openTime > 0n) return notSent('build', VENUE_SWAP_COPY.noClock);
  const quoted = quoteOwnPool(view.snapshot, config, a.inputMint.toBase58(), a.amountIn, snap.chainNow === null ? 0 : Number(snap.chainNow));
  if (!quoted) return notSent('build', VENUE_SWAP_COPY.cannotPrice);
  if (a.aggregator.kind === 'quoted' && quoted.outAmount < a.aggregator.out) return notSent('build', VENUE_SWAP_COPY.routeMoved);
  const minimumAmountOut = applySlippage(quoted.outAmount, a.slippageBps);
  if (minimumAmountOut === null || minimumAmountOut <= 0n) return notSent('build', VENUE_SWAP_COPY.tooSmall);

  // 5. The wallet's two accounts. SOL is wrapped from the wallet itself; anything else
  // paid in must already sit in the signer's own account for it.
  const tokenWant = (use: AccountWant['use']): AccountWant => ({ owner: a.owner, mint: tokenMint, program: tokenProgram, use, what: 'token', decimals: tokenDecimals });
  const tokenSide = { program: tokenProgram, decimals: tokenDecimals, held: snap.tokenAccount, rent: snap.rents.tokenAccountForMint, want: tokenWant, name: 'tokens' };
  const coinSide = {
    program: new PublicKey(coin.program),
    decimals: coin.decimals,
    held: snap.quoteAccount,
    rent: snap.rents.quoteAccount,
    want: (use: AccountWant['use']) => coinAccount(a.owner, coin, use),
    name: coin.symbol,
  };
  const input = paysCoin ? coinSide : tokenSide;
  const output = paysCoin ? tokenSide : coinSide;
  const inIsSol = coin.native && paysCoin;
  const outIsSol = coin.native && !paysCoin;
  const notices: string[] = [];

  const inCheck = accountCheck(input.held.account, input.want('source'));
  if (inCheck.refuse) return notSent('build', inCheck.refuse);
  if (!inIsSol) {
    if (!input.held.account) return notSent('build', VENUE_SWAP_COPY.noSource(input.name, input.held.address.toBase58()));
    const have = amountOf(input.held.account);
    if (have < a.amountIn) {
      const fmt = (v: bigint) => `${formatTokenAmount(v, input.decimals, input.decimals).text} ${input.name}`;
      return notSent('build', VENUE_SWAP_COPY.short(fmt(a.amountIn), fmt(have)));
    }
  }
  const outCheck = accountCheck(output.held.account, output.want('destination'));
  if (outCheck.refuse) return notSent('build', outCheck.refuse);
  notices.push(...outCheck.notices);
  // What opening the account for what is paid out costs. SOL's is the wrapped-SOL account.
  const outRent = outIsSol ? 0n : output.rent;
  if (!outIsSol && !output.held.account && outRent === null) return notSent('build', VENUE_SWAP_COPY.cannotSize);

  // 6. Wrapped SOL: only a SOL pool has a plan for it. `null` = nothing is wrapped.
  let plan: WsolPlan | null = null;
  if (coin.native) {
    const made = wsolPlanFrom(a.owner, snap.quoteAccount.account);
    if (typeof made === 'string') return notSent('build', made);
    plan = made;
  }

  // 7. Pins, and the one swap built from them.
  const pins = poolPins(cfg, view, { tokenMint, lpAccount: snap.lp.address });
  if (typeof pins === 'string') return notSent('build', pins);
  const in0 = a.inputMint.equals(pins.token0Mint);
  const inAccount = associatedTokenAddress(a.inputMint, a.owner, input.program);
  const outAccount = associatedTokenAddress(a.outputMint, a.owner, output.program);
  const swap = swapBaseInputIx({
    programId: cfg.cpSwapProgram,
    payer: a.owner,
    ammConfig: pins.ammConfig,
    poolState: pins.address,
    inputTokenAccount: inAccount,
    outputTokenAccount: outAccount,
    inputVault: in0 ? pins.vault0 : pins.vault1,
    outputVault: in0 ? pins.vault1 : pins.vault0,
    inputTokenProgram: input.program,
    outputTokenProgram: output.program,
    inputTokenMint: a.inputMint,
    outputTokenMint: a.outputMint,
    observationState: pins.observation,
    amountIn: a.amountIn,
    minimumAmountOut,
  });
  const openOut = createAssociatedTokenAccountIdempotentInstruction(a.owner, outAccount, a.owner, a.outputMint, output.program);
  const body: TransactionInstruction[] = !plan
    ? [openOut, swap]
    : inIsSol
      ? [openWsolIx(a.owner), ...wrapIxs(a.owner, a.amountIn), openOut, swap, ...closeWsolIxs(plan, a.owner)]
      : [openWsolIx(a.owner), swap, ...closeWsolIxs(plan, a.owner)];

  const tokenAccounts: WatchList['tokenAccounts'] = [];
  if (!inIsSol) tokenAccounts.push({ account: inAccount, mint: a.inputMint, role: paysCoin ? 'quote' : 'token', decimals: input.decimals });
  if (!outIsSol) tokenAccounts.push({ account: outAccount, mint: a.outputMint, role: paysCoin ? 'token' : 'quote', decimals: output.decimals });
  // The wrapped-SOL account is always watched, so a balance check can name it.
  if (plan) tokenAccounts.push({ account: plan.ata, mint: WSOL_MINT, role: 'wsol', decimals: 9 });

  // 8. Simulate twice and compare.
  return buildAndSimulate(rpc, {
    kind: 'venue-swap',
    body,
    extraSigners: [],
    intent: { kind: 'venue-swap', signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins, inputMint: a.inputMint },
    watch: { signer: a.owner, tokenAccounts },
    expect: (pre, rents) => {
      const exists = (k: PublicKey) => pre.tokens.get(k.toBase58())?.exists ?? false;
      const openCost = exists(outAccount) ? 0n : outRent ?? 0n;
      // At least what the swap names comes in; at most what it names goes out. No upper
      // bound on either: a token a stranger sends in after the balance read must not block it.
      const outRow = { account: outAccount, mint: a.outputMint, minDelta: minimumAmountOut, maxDelta: 2n ** 64n };
      const inRow = { account: inAccount, mint: a.inputMint, minDelta: -a.amountIn, maxDelta: 2n ** 64n };
      if (!plan) return { maxSolOut: openCost, tokens: [inRow, outRow] };
      // A wrapped-SOL account we create and do not close keeps its rent.
      const wsolRent = !exists(plan.ata) && !plan.closeAfter ? rents.tokenAccount : 0n;
      if (inIsSol) {
        // Whatever was wrapped in is swapped out. Closed: the wrapped-SOL balance ends
        // where it began. Kept: at least what the wrap's sync credits from lamports it
        // already held, so the person's own wrapped SOL is never spent.
        const kept = plan.closeAfter ? 0n : syncCredit(pre.tokens.get(plan.ata.toBase58()), rents.tokenAccount);
        return {
          maxSolOut: a.amountIn + openCost + wsolRent,
          tokens: [outRow, { account: plan.ata, mint: WSOL_MINT, minDelta: kept, maxDelta: plan.closeAfter ? 0n : 2n ** 64n }],
        };
      }
      // SOL comes out. Closed: it arrives as plain SOL, and the account held nothing when
      // read, so wrapped SOL that arrived since is blocked rather than unwrapped.
      return plan.closeAfter
        ? { maxSolOut: 0n, minSolIn: minimumAmountOut, tokens: [inRow, { account: plan.ata, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }] }
        : { maxSolOut: wsolRent, tokens: [inRow, { account: plan.ata, mint: WSOL_MINT, minDelta: minimumAmountOut, maxDelta: 2n ** 64n }] };
    },
    newAccountRent: (pre) => (!outIsSol && !(pre.tokens.get(outAccount.toBase58())?.exists ?? false) ? outRent ?? 0n : 0n),
    summarize: (steps): TxSummary | string => {
      const problem = swapStepsProblem(steps, {
        pool: pins.address,
        inputMint: a.inputMint,
        outputMint: a.outputMint,
        amountIn: a.amountIn,
        minimumAmountOut,
        wraps: inIsSol ? a.amountIn : null,
        opens: [...(plan ? [plan.ata] : []), ...(outIsSol ? [] : [outAccount])],
        closes: plan?.closeAfter ?? false,
      });
      if (problem) return problem;
      const s = bodySteps(steps).find((x) => x.kind === 'pool-swap');
      if (!s || s.kind !== 'pool-swap') return 'The swap is missing from the transaction.';
      return {
        kind: 'venue-swap',
        pool: pins.address,
        origin: pins.origin,
        config,
        tokenMint,
        tokenDecimals,
        coin,
        paysCoin,
        amountIn: s.amountIn,
        minimumAmountOut: s.minimumAmountOut,
        quoted,
        aggregator: a.aggregator,
        unwrapsWsol: bodySteps(steps).some((x) => x.kind === 'close-wsol'),
        wsolHeldBefore: plan ? plan.heldBefore : 0n,
        notices,
      };
    },
  });
}
