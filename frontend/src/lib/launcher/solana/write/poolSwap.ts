// Trade a graduated launch in its own pool (our cp-swap fork).
//
// The pool is the one `readLaunchPool` verified from the curve's record, never the
// standard pair address. SOL goes in and out through the signer's wrapped-SOL
// account:
//
//   buy:  [create WSOL account if missing, move SOL in, sync, create token account
//          if missing, swap WSOL -> token, close WSOL account*]
//   sell: [create WSOL account if missing, swap token -> WSOL, close WSOL account*]
//
//   * only when that account did not exist or held nothing before, so a wallet's
//     own wrapped SOL is never unwrapped behind its back. `unwrapsWsol` says which.
//     That rule and the WSOL instructions live in wsol.ts. The WSOL account always
//     has a balance row, so wrapped SOL that reaches it after this file's read is
//     blocked, never paid out.
//
// The pool program does not check who owns the swap's output account, so the
// output is always the signer's own associated account and the intent check
// refuses anything else.
//
// The quote comes from the pool as the chain has it NOW (`refreshLaunchPool`, at
// 'confirmed'), never from the copy the page loaded. The fee settings are the
// pool's own, never the launch program's current global ones.

import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { applySlippage } from '../curve/math';
import { clipDetail } from '../curve/read';
import { deriveObservation, deriveVault } from '../../../solana/cpswap/program';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import { quoteOwnPool } from '../../../solana/cpswap/read';
import { refreshLaunchPool, type LaunchPool } from '../discover/pool';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import { slippageProblem } from './trade';
import type { OpenGate, Prepared, TxSummary, WriteRpc } from './types';
import { closeWsolIxs, openWsolIx, syncCredit, wrapIxs, wsolPlanFrom, type WsolPlan } from './wsol';

export async function preparePoolSwap(
  rpc: WriteRpc,
  gate: OpenGate,
  a: {
    owner: PublicKey;
    mint: PublicKey;
    pool: LaunchPool;
    side: 'buy' | 'sell';
    amountIn: bigint;
    slippageBps: bigint;
    nowSecs?: number;
  },
): Promise<Prepared> {
  const bad = slippageProblem(a.slippageBps);
  if (bad) return notSent('build', bad);
  if (a.amountIn <= 0n) return notSent('build', 'Enter an amount above zero.');

  const cp = gate.cfg.cpSwapProgram;
  const poolKey = a.pool.address;
  const inputMint = a.side === 'buy' ? WSOL_MINT : a.mint;
  const outputMint = a.side === 'buy' ? a.mint : WSOL_MINT;

  const fresh = await refreshLaunchPool(
    { getAccountInfo: (k) => rpc.getAccountInfo(k, 'confirmed'), getMinimumBalanceForRentExemption: (n) => rpc.getMinimumBalanceForRentExemption(n) },
    cp,
    a.pool,
  );
  if (fresh.kind !== 'ok') return notSent('build', `Could not price this against the pool now: ${fresh.detail}.`);
  const pool = fresh.value;

  // The pool opens by the CHAIN's clock (read with the pool), never the viewer's.
  const chainTime = pool.chainTime ?? null;
  const nowSecs = a.nowSecs ?? (chainTime !== null ? Number(chainTime) : undefined);
  if (nowSecs === undefined && pool.snapshot.pool.openTime > 0n) {
    return notSent('build', 'Could not read the network clock to check the pool is open.');
  }
  const quote = quoteOwnPool(pool.snapshot, pool.ammConfig, inputMint.toBase58(), a.amountIn, nowSecs ?? 0);
  if (!quote) return notSent('build', 'The pool cannot price this trade right now.');
  const minimumAmountOut = applySlippage(quote.outAmount, a.slippageBps);
  if (minimumAmountOut === null || minimumAmountOut <= 0n) {
    return notSent('build', 'That amount is too small to protect with a price limit.');
  }

  const wsolAta = associatedTokenAddress(WSOL_MINT, a.owner);
  const tokenAta = associatedTokenAddress(a.mint, a.owner);

  // Close the WSOL account afterwards only if it held nothing before.
  let plan: WsolPlan;
  try {
    const p = wsolPlanFrom(a.owner, await rpc.getAccountInfo(wsolAta, 'confirmed'));
    if (typeof p === 'string') return notSent('build', p);
    plan = p;
  } catch (e) {
    return notSent('build', `Could not read your wrapped-SOL account: ${clipDetail(e)}`);
  }
  const unwrapsWsol = plan.closeAfter;

  const swap = swapBaseInputIx({
    programId: cp,
    payer: a.owner,
    ammConfig: pool.ammConfigAddress,
    poolState: poolKey,
    inputTokenAccount: associatedTokenAddress(inputMint, a.owner),
    outputTokenAccount: associatedTokenAddress(outputMint, a.owner),
    inputVault: deriveVault(cp, poolKey, inputMint),
    outputVault: deriveVault(cp, poolKey, outputMint),
    inputTokenProgram: TOKEN_PROGRAM_ID,
    outputTokenProgram: TOKEN_PROGRAM_ID,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    observationState: deriveObservation(cp, poolKey),
    amountIn: a.amountIn,
    minimumAmountOut,
  });

  const createWsol = openWsolIx(a.owner);
  const close = closeWsolIxs(plan, a.owner);
  const body: TransactionInstruction[] =
    a.side === 'buy'
      ? [
          createWsol,
          ...wrapIxs(a.owner, a.amountIn),
          createAssociatedTokenAccountIdempotentInstruction(a.owner, tokenAta, a.owner, a.mint, TOKEN_PROGRAM_ID),
          swap,
          ...close,
        ]
      : [createWsol, swap, ...close];

  const kind = a.side === 'buy' ? 'pool-buy' : 'pool-sell';
  return buildAndSimulate(rpc, {
    kind,
    body,
    extraSigners: [],
    intent: {
      kind,
      signer: a.owner,
      cfg: gate.cfg,
      feeRecipient: gate.global.feeRecipient,
      // The pool's own fee settings: the one account cp-swap accepts for this pool.
      ammConfig: pool.ammConfigAddress,
      mint: a.mint,
      maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
    },
    watch: {
      signer: a.owner,
      // The WSOL account is always watched, so a balance check can name it.
      tokenAccounts: [
        { account: tokenAta, mint: a.mint, role: 'token' },
        { account: wsolAta, mint: WSOL_MINT, role: 'wsol', decimals: 9 },
      ],
    },
    expect: (pre, rents) => {
      const tokenExists = pre.tokens.get(tokenAta.toBase58())?.exists ?? false;
      const wsolExists = pre.tokens.get(wsolAta.toBase58())?.exists ?? false;
      // A WSOL account we create and do not close keeps its rent.
      const wsolRent = !wsolExists && !unwrapsWsol ? rents.tokenAccount : 0n;
      if (a.side === 'buy') {
        const kept = unwrapsWsol ? 0n : syncCredit(pre.tokens.get(wsolAta.toBase58()), rents.tokenAccount);
        return {
          maxSolOut: a.amountIn + (tokenExists ? 0n : rents.tokenAccount) + wsolRent,
          tokens: [
            { account: tokenAta, mint: a.mint, minDelta: minimumAmountOut, maxDelta: 2n ** 64n },
            // Whatever was wrapped in is swapped out. Closed: the WSOL balance ends where it
            // began. Kept: at least what the wrap's sync credits from lamports it already
            // held, so the person's own wrapped SOL is never spent. No upper bound on a kept
            // account: wrapped SOL a stranger sends in after the balance read must not block the buy.
            { account: wsolAta, mint: WSOL_MINT, minDelta: kept, maxDelta: unwrapsWsol ? 0n : 2n ** 64n },
          ],
        };
      }
      // A sale: at most the tokens it names may leave (the bytes pin the exact number).
      // No upper bound: the balance is read a slot or more before the test run, and a
      // token a stranger sends in between must not block the sale.
      return unwrapsWsol
        ? {
            maxSolOut: 0n,
            minSolIn: minimumAmountOut,
            tokens: [
              { account: tokenAta, mint: a.mint, minDelta: -a.amountIn, maxDelta: 2n ** 64n },
              // The close pays out everything in the account. It held nothing when the
              // builder read it; wrapped SOL that arrived since makes this negative,
              // and is blocked rather than unwrapped.
              { account: wsolAta, mint: WSOL_MINT, minDelta: 0n, maxDelta: 0n },
            ],
          }
        : {
            maxSolOut: wsolRent,
            tokens: [
              { account: tokenAta, mint: a.mint, minDelta: -a.amountIn, maxDelta: 2n ** 64n },
              { account: wsolAta, mint: WSOL_MINT, minDelta: minimumAmountOut, maxDelta: 2n ** 64n },
            ],
          };
    },
    newAccountRent: (pre, rents) =>
      a.side === 'buy' && !(pre.tokens.get(tokenAta.toBase58())?.exists ?? false) ? rents.tokenAccount : 0n,
    summarize: (steps): TxSummary | string => {
      const s = bodySteps(steps).find((x) => x.kind === 'pool-swap');
      if (!s || s.kind !== 'pool-swap') return 'The swap is missing from the transaction.';
      if (s.amountIn !== a.amountIn || s.minimumAmountOut !== minimumAmountOut) {
        return 'The swap in the transaction does not match the quote.';
      }
      if (!s.pool.equals(poolKey)) return 'The swap names a different pool.';
      const closes = bodySteps(steps).some((x) => x.kind === 'close-wsol');
      return {
        kind,
        mint: a.mint,
        pool: poolKey,
        amountIn: s.amountIn,
        minimumAmountOut: s.minimumAmountOut,
        quote,
        unwrapsWsol: closes,
      };
    },
  });
}
