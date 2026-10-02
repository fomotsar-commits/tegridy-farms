// Finish graduation. Open to ANYONE.
//
// Graduation (`migrate_to_amm`) moves the curve's SOL and tokens into a new pool in
// our own pool program at the address the LAUNCH PROGRAM derives (not the pool
// program's standard address, which anyone could occupy first), burns the pool
// shares so the liquidity is locked for good, and sends the unspent migration
// reserve to the fee recipient. The person who presses the button pays the network
// fee. The program also has them front the rent for its two working token accounts
// (and a small top-up of its authority), then closes those accounts, and the pool's
// LP account, back to them in the SAME instruction: they end slightly ahead, so the
// review shows no account rent, only the simulated change.
//
// Graduation does not touch the platform reserve: `create_launch` already paid it
// to the treasury when the token was created. There is nothing to release.

import type { PublicKey } from '@solana/web3.js';
import { poolStatePda } from '../curve/program';
import { MIGRATE_COMPUTE_UNITS, migrateToAmmIx } from '../curve/ix';
import type { CurveAccount } from '../curve/read';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import { bodySteps, buildAndSimulate, notSent } from './prepare';
import type { IntentContext, OpenGate, Prepared, TxSummary, WriteRpc } from './types';

function ctxFor(gate: OpenGate, payer: PublicKey, mint: PublicKey, curve: CurveAccount): IntentContext {
  return {
    kind: 'migrate',
    signer: payer,
    cfg: gate.cfg,
    feeRecipient: gate.global.feeRecipient,
    ammConfig: gate.global.ammConfig,
    creator: curve.curve.creator,
    mint,
    maxPriorityLamports: MAX_OWN_PRIORITY_LAMPORTS,
  };
}

export async function prepareMigrate(
  rpc: WriteRpc,
  gate: OpenGate,
  a: { payer: PublicKey; mint: PublicKey; curve: CurveAccount },
): Promise<Prepared> {
  if (gate.paused) return notSent('build', 'Graduation is paused right now. Selling still works.');
  if (!a.curve.curve.mint.equals(a.mint)) return notSent('build', 'The curve read does not belong to this token.');
  if (a.curve.curve.complete) return notSent('build', 'This launch has already graduated.');
  if (gate.graduation.permission === false) {
    return notSent('build', 'The pool program has not given the launch program permission to open pools yet.');
  }
  if (gate.graduation.createPoolFeeReceiver === false) {
    return notSent('build', 'The pool program’s fee account does not exist yet, so graduation cannot run.');
  }

  const pool = poolStatePda(a.mint, gate.cfg.programId);
  const body = [
    migrateToAmmIx(
      {
        payer: a.payer,
        creator: a.curve.curve.creator,
        feeRecipient: gate.global.feeRecipient,
        launchMint: a.mint,
        ammConfig: gate.global.ammConfig,
        createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
      },
      { programId: gate.cfg.programId, cpSwapProgram: gate.cfg.cpSwapProgram },
    ),
  ];

  return buildAndSimulate(rpc, {
    kind: 'migrate',
    body,
    extraSigners: [],
    intent: ctxFor(gate, a.payer, a.mint, a.curve),
    watch: { signer: a.payer, tokenAccounts: [] },
    // The payer fronts the rent for `auth_wsol` and `auth_token` (both init_if_needed,
    // payer = payer) plus the authority's top-up. That bounds what can leave the
    // wallet. Both accounts, and the LP account, are closed back to the payer before
    // the instruction ends, so no rent is kept: there is none to show as a cost.
    expect: (_pre, rents) => ({ maxSolOut: 2n * rents.tokenAccount, tokens: [] }),
    newAccountRent: () => 0n,
    computeFloor: MIGRATE_COMPUTE_UNITS,
    summarize: (steps): TxSummary | string => {
      const m = bodySteps(steps).find((s) => s.kind === 'migrate');
      if (!m || m.kind !== 'migrate') return 'The graduation step is missing from the transaction.';
      if (!m.pool.equals(pool)) return 'The graduation names a different pool.';
      return { kind: 'migrate', mint: a.mint, pool };
    },
  });
}
