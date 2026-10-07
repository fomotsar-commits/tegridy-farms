// A swap against one of our pools, sent from the Solana swap page (`venue-swap`).
//
// The page sends a trade here only once it has settled that this pool pays at least as
// much as Jupiter (lib/solana/swap/settleVenue.ts). This builds it on ONE fresh read of
// the pool and the wallet (`readPoolForWrite`), priced with the pool's OWN fee tier on
// the chain's clock, with every account pinned to that read (`PoolPins`, intent.ts):
//
//   SOL in:   [open WSOL, wrap amountIn, sync, open the output account, swap, close WSOL*]
//   SOL out:  [open WSOL, swap, close WSOL*]
//   no SOL:   [open the output account, swap]
//
//   * only when the wrapped-SOL account was absent or empty (wsol.ts), so a wallet's own
//     wrapped SOL is never unwrapped behind its back.
//
// Each account is its own mint's: classic for SOL and USDC, Token-2022 for BAYLA, the
// pool's recorded program for the token. Nothing here signs or sends.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol, formatTokenAmount } from '../curve/format';
import { applySlippage } from '../curve/math';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import { quoteOwnPool } from '../../../solana/cpswap/read';
import { spendableSol } from '../../../solana/lp/liquidityMath';
import { quoteCoin, readPair, QUOTE_COINS_OR } from '../../../solana/lp/quotes';
import { BUILDABLE_EXTENSIONS, classifyToken, extensionPlain } from '../../../solana/lp/tokenSafety';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { LP_COPY, LP_FEE_RESERVE, POOL_READ_FAILED, accountCheck, coinAccount, poolPins, readPoolForWrite } from './liquidity';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { Expectation, IntentStep, LpOpenGate, Prepared, SwapSide, TxSummary, VenueSwapArgs, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom, type WsolPlan } from './wsol';

const U64_CEIL = 2n ** 64n;

export const SWAP_COPY = {
  paused: 'Swaps in our pools are paused right now, so nothing was built.',
  notAPair: `Our pools pair a token with ${QUOTE_COINS_OR}, and this pair has none of them, so nothing was built.`,
  poolUnread: 'We could not read the pool just now, so nothing was built. Try again in a moment.',
  feesUnread: "We could not read this pool's fee settings just now, so the swap could not be priced. Nothing was built.",
  clockUnread: "We could not read the network's clock to check the pool is open, so nothing was built.",
  vaultFrozen: "One of this pool's vaults is frozen, so nothing can be swapped in it right now. Nothing was built.",
  cannotPrice: 'This pool cannot price this trade right now: its swaps may be switched off, or it is not open yet. Nothing was built.',
  tooSmall: 'That amount is too small to protect with a price limit.',
  tokenUnread: 'We could not read the token just now, so nothing was built. Try again in a moment.',
  noInput: (what: string, address: string) => `You hold no ${what} in your main account for it (${address}).`,
  shortInput: (have: string, need: string) => `This swap spends ${need} and your account for it holds ${have}.`,
  shortSol: (most: string) => `That would leave your wallet with too little SOL for the network fee and the account deposits. The most this wallet can swap is ${most}.`,
  outputUnsized: 'This site cannot size an account for the token you would receive, so nothing was built.',
} as const;

const sol = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;
const amountText = (raw: bigint, side: SwapSide) =>
  side.symbol === 'SOL' ? sol(raw) : `${formatTokenAmount(raw, side.decimals, side.decimals).text} ${side.symbol ?? 'tokens'}`;

function amountOf(data: Uint8Array | null | undefined): bigint {
  return data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true) : 0n;
}

/**
 * The decoded steps of a venue swap must be exactly the plan. A string says what
 * differs: one swap, with these mints and amounts, in this pool; SOL wrapped (exactly
 * `wrap`) only when SOL goes in; exactly the accounts planned opened; the wrapped-SOL
 * account closed if and only if the plan says so, and never when SOL is not a side.
 */
export function venueSwapStepsProblem(
  steps: IntentStep[],
  want: {
    pool: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: bigint;
    minimumAmountOut: bigint;
    wrap: bigint | null;
    opens: PublicKey[];
    closeAfter: boolean | null;
  },
): string | null {
  const body = bodySteps(steps);
  const swaps = body.filter((s) => s.kind === 'pool-swap');
  const s = swaps[0];
  if (swaps.length !== 1 || !s || s.kind !== 'pool-swap') return 'The swap is missing from the transaction.';
  if (!s.pool.equals(want.pool)) return 'The swap names a different pool.';
  if (!s.inputMint.equals(want.inputMint) || !s.outputMint.equals(want.outputMint)) return 'The swap in the transaction goes the other way.';
  if (s.amountIn !== want.amountIn || s.minimumAmountOut !== want.minimumAmountOut) return 'The swap in the transaction does not match the quote.';
  const wraps = body.filter((x) => x.kind === 'wrap-sol');
  const syncs = body.filter((x) => x.kind === 'sync-wsol').length;
  if (want.wrap === null) {
    if (wraps.length !== 0 || syncs !== 0) return 'The transaction wraps SOL, and this swap spends no SOL.';
  } else if (wraps.length !== 1 || wraps[0]?.kind !== 'wrap-sol' || wraps[0].lamports !== want.wrap || syncs !== 1) {
    return 'The SOL wrapped for the swap does not match what it spends.';
  }
  const creates = body.filter((x) => x.kind === 'create-token-account');
  const opens = (k: PublicKey) => creates.filter((x) => x.kind === 'create-token-account' && x.address.equals(k)).length === 1;
  if (creates.length !== want.opens.length || !want.opens.every(opens)) return 'The transaction does not open exactly the accounts this swap needs.';
  const closes = body.filter((x) => x.kind === 'close-wsol').length;
  if (want.closeAfter === null ? closes !== 0 : closes > 1 || (closes === 1) !== want.closeAfter) {
    return 'The transaction closes your wrapped-SOL account when it should not, or keeps it when it should close it.';
  }
  return null;
}

export async function prepareVenueSwap(rpc: WriteRpc, gate: LpOpenGate, a: VenueSwapArgs): Promise<Prepared> {
  // 1. Inputs.
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.amountIn <= 0n) return notSent('build', 'Enter an amount above zero.');
  if (gate.kind !== 'open' || gate.mode !== 'on') return notSent('build', SWAP_COPY.paused);
  const pair = readPair(a.inputMint.toBase58(), a.outputMint.toBase58());
  if (!pair) return notSent('build', SWAP_COPY.notAPair);
  const quote = pair.quote;
  const tokenMint = new PublicKey(pair.tokenMint);
  const cfg = gate.cfg;

  // 2. One fresh read. The pool must pair exactly this token with exactly this coin
  //    (`readPoolForWrite` refuses any other), so its two mints are the trade's two.
  const snap = await readPoolForWrite(rpc, cfg, { pool: a.pool, tokenMint, quote, owner: a.owner });
  if (snap === POOL_READ_FAILED) return notSent('build', SWAP_COPY.poolUnread);
  if (typeof snap === 'string') return notSent('build', snap);
  const { view } = snap;
  const p = view.snapshot.pool;

  // 3. The fees ARE the maths here: the pool's own tier, read now.
  const config = view.config;
  if (!config) return notSent('build', SWAP_COPY.feesUnread);
  if (view.vaultsFrozen) return notSent('build', SWAP_COPY.vaultFrozen);

  // 4. The token, read again: never one this site cannot build for (a transfer fee would
  //    take its own cut outside the quote).
  const safety = classifyToken(tokenMint.toBase58(), snap.mint, snap.metaplex);
  if (safety.kind !== 'read' || !safety.facts) return notSent('build', SWAP_COPY.tokenUnread);
  if (safety.verdict === 'blocked') return notSent('build', LP_COPY.tokenBlocked(safety.blocks[0]?.text ?? 'see the token check'));
  const tokenProgram = new PublicKey(view.quoteIsToken0 ? p.token1Program : p.token0Program);
  const tokenDecimals = safety.facts.decimals;
  if (snap.mint.owner !== tokenProgram.toBase58()) return notSent('build', LP_COPY.poolChanged("the token's program"));
  if (tokenDecimals !== (view.quoteIsToken0 ? p.mint1Decimals : p.mint0Decimals)) return notSent('build', LP_COPY.poolChanged("the token's decimals"));
  const outsideSet = safety.facts.extensions.find((e) => !BUILDABLE_EXTENSIONS.has(e));
  if (outsideSet !== undefined) return notSent('build', LP_COPY.tokenBlocked(`It uses ${extensionPlain(outsideSet)}.`));

  // 5. The price: the pool's own tier, on the chain's clock (never the viewer's).
  if (snap.chainNow === null) return notSent('build', SWAP_COPY.clockUnread);
  const q = quoteOwnPool(view.snapshot, config, a.inputMint.toBase58(), a.amountIn, Number(snap.chainNow));
  if (!q) return notSent('build', SWAP_COPY.cannotPrice);
  const minimumAmountOut = applySlippage(q.outAmount, a.slippageBps);
  if (minimumAmountOut === null || minimumAmountOut <= 0n) return notSent('build', SWAP_COPY.tooSmall);

  // 6. The pins: the read, checked against the pool's own address derivations.
  const lpAta = associatedTokenAddress(new PublicKey(p.lpMint), a.owner, TOKEN_PROGRAM_ID);
  const pins = poolPins(cfg, view, { tokenMint, lpAccount: lpAta });
  if (typeof pins === 'string') return notSent('build', pins);

  // 7. Which side is which, and the wallet's own accounts for each.
  const inputIsCoin = a.inputMint.toBase58() === quote.mint;
  const solSide: 'in' | 'out' | 'none' = !quote.native ? 'none' : inputIsCoin ? 'in' : 'out';
  const coinSide: SwapSide = { mint: new PublicKey(quote.mint), symbol: quote.symbol, decimals: quote.decimals };
  const tokenSide: SwapSide = { mint: tokenMint, symbol: quoteCoin(tokenMint.toBase58())?.symbol ?? null, decimals: tokenDecimals };
  const input = inputIsCoin ? coinSide : tokenSide;
  const output = inputIsCoin ? tokenSide : coinSide;
  const coinAcc = snap.quoteAccount;
  const tokenAcc = snap.tokenAccount;
  const inAcc = inputIsCoin ? coinAcc : tokenAcc;
  const outAcc = inputIsCoin ? tokenAcc : coinAcc;
  const tokenWant = (use: 'source' | 'destination') => ({ owner: a.owner, mint: tokenMint, program: tokenProgram, use, what: 'token', decimals: tokenDecimals });
  const coinCheck = accountCheck(coinAcc.account, coinAccount(a.owner, quote, inputIsCoin ? 'source' : 'destination'));
  if (coinCheck.refuse) return notSent('build', coinCheck.refuse);
  const tokenCheck = accountCheck(tokenAcc.account, tokenWant(inputIsCoin ? 'destination' : 'source'));
  if (tokenCheck.refuse) return notSent('build', tokenCheck.refuse);
  const notices = [...coinCheck.notices, ...tokenCheck.notices];

  let plan: WsolPlan | null = null;
  if (solSide !== 'none') {
    const w = wsolPlanFrom(a.owner, coinAcc.account);
    if (typeof w === 'string') return notSent('build', w);
    plan = w;
  }

  // What opening the output account costs. A wrapped-SOL output is the plan's to open and close.
  const outputRent =
    solSide === 'out' || outAcc.account
      ? 0n
      : inputIsCoin
        ? snap.rents.tokenAccountForMint
        : snap.rents.quoteAccount;
  if (outputRent === null) return notSent('build', SWAP_COPY.outputUnsized);

  // The input: SOL from the wallet's balance, anything else from its own account.
  if (solSide === 'in') {
    const most = spendableSol({
      lamports: snap.signerLamports,
      walletFloor: snap.rents.walletFloor,
      feeReserve: LP_FEE_RESERVE,
      lpAccountRent: outputRent,
      wsolCreateRent: coinAcc.account ? 0n : snap.rents.tokenAccount165,
    });
    if (a.amountIn > most) return notSent('build', SWAP_COPY.shortSol(sol(most)));
  } else {
    if (!inAcc.account) return notSent('build', SWAP_COPY.noInput(input.symbol ?? 'of this token', inAcc.address.toBase58()));
    const held = amountOf(inAcc.account.data);
    if (held < a.amountIn) return notSent('build', SWAP_COPY.shortInput(amountText(held, input), amountText(a.amountIn, input)));
    const floor = snap.rents.walletFloor + LP_FEE_RESERVE + outputRent + (solSide === 'out' && !coinAcc.account ? snap.rents.tokenAccount165 : 0n);
    if (snap.signerLamports < floor) return notSent('build', LP_COPY.needSol(sol(floor), sol(snap.signerLamports)));
  }

  // 8. The body.
  const programOf = (m: PublicKey) => (m.equals(pins.token0Mint) ? pins.token0Program : pins.token1Program);
  const vaultOf = (m: PublicKey) => (m.equals(pins.token0Mint) ? pins.vault0 : pins.vault1);
  const inAddress = associatedTokenAddress(a.inputMint, a.owner, programOf(a.inputMint));
  const outAddress = associatedTokenAddress(a.outputMint, a.owner, programOf(a.outputMint));
  const swap = swapBaseInputIx({
    programId: cfg.cpSwapProgram,
    payer: a.owner,
    ammConfig: pins.ammConfig,
    poolState: pins.address,
    inputTokenAccount: inAddress,
    outputTokenAccount: outAddress,
    inputVault: vaultOf(a.inputMint),
    outputVault: vaultOf(a.outputMint),
    inputTokenProgram: programOf(a.inputMint),
    outputTokenProgram: programOf(a.outputMint),
    inputTokenMint: a.inputMint,
    outputTokenMint: a.outputMint,
    observationState: pins.observation,
    amountIn: a.amountIn,
    minimumAmountOut,
  });
  const openOutput = createAssociatedTokenAccountIdempotentInstruction(a.owner, outAddress, a.owner, a.outputMint, programOf(a.outputMint));
  const wsolAta = associatedTokenAddress(WSOL_MINT, a.owner);
  const body: TransactionInstruction[] =
    solSide === 'in'
      ? [openWsolIx(a.owner), ...wrapIxs(a.owner, a.amountIn), openOutput, swap, ...closeWsolIxs(plan!, a.owner)]
      : solSide === 'out'
        ? [openWsolIx(a.owner), swap, ...closeWsolIxs(plan!, a.owner)]
        : [openOutput, swap];
  const opens = solSide === 'in' ? [wsolAta, outAddress] : solSide === 'out' ? [wsolAta] : [outAddress];

  // 9. Simulate twice and compare. Every bound is one-sided where a stranger can pay in.
  const coinRow = { account: coinAcc.address, mint: coinSide.mint, role: quote.native ? ('wsol' as const) : ('quote' as const), decimals: quote.decimals };
  const tokenRow = { account: tokenAcc.address, mint: tokenMint, role: 'token' as const, decimals: tokenDecimals };
  const outputRow = { account: outAddress, mint: a.outputMint, minDelta: minimumAmountOut, maxDelta: U64_CEIL };
  const inputRow = { account: inAddress, mint: a.inputMint, minDelta: -a.amountIn, maxDelta: U64_CEIL };
  const closeAfter = plan?.closeAfter ?? null;
  return buildAndSimulate(rpc, {
    kind: 'venue-swap',
    body,
    extraSigners: [],
    intent: { kind: 'venue-swap', signer: a.owner, cfg, maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS, pins },
    watch: { signer: a.owner, tokenAccounts: [tokenRow, coinRow] },
    expect: (pre, rents): Expectation => {
      const outRent = (pre.tokens.get(outAddress.toBase58())?.exists ?? false) ? 0n : outputRent;
      if (solSide === 'in') {
        // Whatever is wrapped in is swapped out. Closed: the wrapped-SOL balance ends where it
        // began. Kept: at least what the sync credits, so the wallet's own wrapped SOL is never spent.
        const kept = closeAfter ? 0n : syncCredit(pre.tokens.get(wsolAta.toBase58()), rents.tokenAccount);
        return {
          maxSolOut: a.amountIn + outRent,
          tokens: [outputRow, { account: wsolAta, mint: WSOL_MINT, minDelta: kept, maxDelta: closeAfter ? 0n : U64_CEIL }],
        };
      }
      if (solSide === 'out') {
        return closeAfter
          ? { maxSolOut: 0n, minSolIn: minimumAmountOut, tokens: [inputRow, { account: wsolAta, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n }] }
          : { maxSolOut: 0n, tokens: [inputRow, { account: wsolAta, mint: WSOL_MINT, minDelta: minimumAmountOut, maxDelta: U64_CEIL }] };
      }
      return { maxSolOut: outRent, tokens: [inputRow, outputRow] };
    },
    newAccountRent: (pre) => ((pre.tokens.get(outAddress.toBase58())?.exists ?? false) ? 0n : outputRent),
    summarize: (steps): TxSummary | string => {
      const problem = venueSwapStepsProblem(steps, {
        pool: pins.address,
        inputMint: a.inputMint,
        outputMint: a.outputMint,
        amountIn: a.amountIn,
        minimumAmountOut,
        wrap: solSide === 'in' ? a.amountIn : null,
        opens,
        closeAfter,
      });
      if (problem) return problem;
      return {
        kind: 'venue-swap',
        pool: pins.address,
        origin: pins.origin,
        config,
        enableCreatorFee: p.enableCreatorFee,
        input,
        output,
        amountIn: a.amountIn,
        minimumAmountOut,
        quote: q,
        wrapsSol: solSide !== 'none',
        unwrapsWsol: bodySteps(steps).some((x) => x.kind === 'close-wsol'),
        outputAccountRent: outAcc.account ? 0n : outputRent,
        notices,
      };
    },
  });
}
