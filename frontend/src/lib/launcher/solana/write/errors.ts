// Why a transaction failed, in plain English, and WHOSE failure it was.
//
// The launch program and cp-swap both number their errors from 6000, so "6005"
// alone is either "already graduated" or "price moved". The failing program is
// read from the `Program <id> failed` log line FIRST (the innermost program fails
// first, so a cp-swap refusal inside graduation is named as cp-swap's), and only
// then is the number looked up, in that program's own table.
//
// Nothing here says "nothing moved" or "only the fee was spent": that depends on
// WHEN it failed (simulation, preflight, or on chain), which is the caller's to say.

import { launchErrorName, type LaunchErrorName } from '../curve/program';
import type { LaunchQuoteErrorCode } from '../curve/math';
import { CP_SWAP_ERROR_COPY, cpSwapErrorName } from '../../../solana/cpswap/errors';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../curve/program';
import type { CurveWriteConfig } from './types';

export type FailingProgram = 'launch' | 'cp-swap' | 'other';

/** One sentence per launch-program error. Keyed by name so a new variant is a type error here. */
export const LAUNCH_FAILURE_COPY: Record<LaunchErrorName, string> = {
  Overflow: 'The amount is too large for the launch program to work with.',
  InsufficientLiquidity: 'The curve cannot fill a trade this size. Try a smaller amount.',
  ZeroAmount: 'That amount is too small: the fee would use all of it.',
  FeeTooHigh: 'The launch program has a fee setting it refuses. This is a setup problem, not something you did.',
  Paused: 'New launches, buys and graduation are paused right now. Selling still works.',
  AlreadyComplete: 'This launch has already graduated (someone may have just finished it). Trade it in its pool instead.',
  NotReadyToGraduate: 'This launch has not reached its graduation target yet.',
  SlippageExceeded: 'The price moved past your limit before this landed. Get a new quote and try again.',
  Unauthorized: 'An account in this transaction is not the one the launch program expects.',
  InvalidParameter: 'The launch program refused one of the values in this transaction.',
  InsufficientRentExemptBalance: 'That sell is larger than the curve can pay out right now. Try a smaller amount.',
  MintHasFreezeAuthority: 'The token still has a freeze authority, which the launch program refuses.',
  NotDeployAuthority: 'Only the operator can do that.',
  GraduationTargetUnreachable: 'The launch settings are not valid. This is a setup problem, not something you did.',
  GraduationPriceGap: 'The launch settings are not valid. This is a setup problem, not something you did.',
  AmmNotConfigured: 'The pool for graduation is not set up yet. This is not a problem with this launch.',
  AmmMismatch: 'The pool settings in this transaction do not match the launch program.',
  MigrationReserveTooLow:
    'The curve does not hold enough SOL to pay for graduation yet. This clears when someone buys again.',
  LpNotBurned: 'Graduation stopped because the pool shares could not be burned. Nothing was changed.',
  AwaitingMigration: 'The curve is full and waiting to graduate, so it takes no more buys. Selling still works.',
  CreatorMismatch: 'The creator account in this transaction does not match this launch.',
  MigrationPermissionMissing:
    'The pool program has not given the launch program permission to open pools yet. This is not a problem with this launch.',
  // Retired codes (6022, 6023): the program no longer returns them, because the
  // platform reserve is paid inside create_launch. Worded so a stray one still reads true.
  PlatformReserveLocked: 'No longer used: the platform reserve is paid when a token is created.',
  PlatformReserveAlreadyReleased: 'No longer used: the platform reserve is paid when a token is created.',
  CpSwapProgramNotPinned: 'The pool program in this transaction is not the one the launch program uses.',
};

/** Plain-English reason for a program error. `code` null = the program did not give one. */
export function describeFailure(program: FailingProgram, code: number | null): string {
  if (code !== null) {
    if (program === 'launch') {
      const name = launchErrorName(code);
      if (name) return LAUNCH_FAILURE_COPY[name];
    }
    if (program === 'cp-swap') {
      const name = cpSwapErrorName(code);
      if (name) return CP_SWAP_ERROR_COPY[name];
    }
    return `A Solana program refused this transaction (error ${code}).`;
  }
  return 'The transaction could not run.';
}

/** Why a quote could not be made, before anything is built. */
export function describeQuoteError(e: LaunchQuoteErrorCode | 'ReserveTooHigh'): string {
  switch (e) {
    case 'ZeroAmount':
      return 'That amount is too small: the fee would use all of it.';
    case 'InsufficientLiquidity':
      return 'The curve cannot fill a trade this size. Try a smaller amount.';
    case 'AwaitingMigration':
      return LAUNCH_FAILURE_COPY.AwaitingMigration;
    case 'AlreadyComplete':
      return LAUNCH_FAILURE_COPY.AlreadyComplete;
    case 'SlippageExceeded':
      return LAUNCH_FAILURE_COPY.SlippageExceeded;
    case 'InsufficientRentExemptBalance':
      return LAUNCH_FAILURE_COPY.InsufficientRentExemptBalance;
    case 'Overflow':
    case 'FeeTooHigh':
    case 'ReserveTooHigh':
      return 'That amount cannot be priced on this curve.';
  }
}

// ── reading a failure out of logs and error objects ──────────────────────────

export interface FailureExplanation {
  program: FailingProgram;
  code: number | null;
  message: string;
}

const FAILED_LINE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: (.*)$/;
const CUSTOM = /custom program error: 0x([0-9a-fA-F]+)/;

function programOf(id: string, cfg: Pick<CurveWriteConfig, 'programId' | 'cpSwapProgram'>): FailingProgram {
  if (id === cfg.programId.toBase58()) return 'launch';
  if (id === cfg.cpSwapProgram.toBase58()) return 'cp-swap';
  return 'other';
}

const NOT_ENOUGH_SOL =
  'Your wallet does not have enough SOL for this, including the network fee and any one-time account costs.';

/** True whether it failed in the test run or on chain, so it says nothing about what was sent. */
const PLANT_SHORT = 'This wallet holds less than 100,000 $BAYLA, so the plant cannot be paid.';

/**
 * Explain a failed simulation or a reverted transaction.
 *
 * `err` is the RPC's `TransactionError` value (a string or an object); `logs` its
 * log lines, which may be missing. Never throws.
 */
export function explainFailure(
  err: unknown,
  logs: readonly string[] | null | undefined,
  cfg: Pick<CurveWriteConfig, 'programId' | 'cpSwapProgram'>,
): FailureExplanation {
  const lines = Array.isArray(logs) ? logs.filter((l): l is string => typeof l === 'string') : [];
  const joined = lines.join('\n');

  // Whole-transaction errors that happen before any program runs.
  if (err === 'AccountNotFound' || err === 'InsufficientFundsForFee') {
    return { program: 'other', code: null, message: NOT_ENOUGH_SOL };
  }
  if (err === 'BlockhashNotFound') {
    return { program: 'other', code: null, message: 'The network did not recognise this transaction’s recent block. Try again.' };
  }
  if (err && typeof err === 'object' && 'InsufficientFundsForRent' in (err as object)) {
    return {
      program: 'other',
      code: null,
      message: 'An account in this transaction would be left below the minimum SOL Solana requires. Add a little SOL and try again.',
    };
  }

  // The innermost failing program speaks first.
  for (const line of lines) {
    const m = FAILED_LINE.exec(line);
    if (!m) continue;
    const [, id, rest] = m as unknown as [string, string, string];
    const hex = CUSTOM.exec(rest);
    const code = hex ? parseInt(hex[1]!, 16) : null;
    const program = programOf(id, cfg);
    if (program === 'other' && id === TOKEN_PROGRAM_ID.toBase58() && code === 1) {
      return { program, code, message: 'You do not hold that many tokens.' };
    }
    // Token-2022 runs only the $BAYLA plant, so its "insufficient funds" is the plant's.
    if (program === 'other' && id === TOKEN_2022_PROGRAM_ID.toBase58() && code === 1) {
      return { program, code, message: PLANT_SHORT };
    }
    if (/insufficient lamports/i.test(joined)) return { program, code, message: NOT_ENOUGH_SOL };
    if (/exceeded CUs meter|Computational budget exceeded/i.test(rest)) {
      return { program, code, message: 'The transaction ran out of computing budget. Try again.' };
    }
    return { program, code, message: describeFailure(program, code) };
  }

  if (/insufficient lamports/i.test(joined)) return { program: 'other', code: null, message: NOT_ENOUGH_SOL };

  // No failing line (logs missing): fall back to the error object's custom code.
  const custom = customCodeOf(err);
  if (custom !== null) return { program: 'other', code: custom, message: describeFailure('other', custom) };
  if (err && typeof err === 'object' && 'InstructionError' in (err as object)) {
    const detail = (err as { InstructionError: unknown[] }).InstructionError?.[1];
    if (detail === 'InsufficientFunds') return { program: 'other', code: null, message: NOT_ENOUGH_SOL };
  }
  return { program: 'other', code: null, message: 'The transaction could not run.' };
}

function customCodeOf(err: unknown): number | null {
  if (!err || typeof err !== 'object' || !('InstructionError' in (err as object))) return null;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie)) return null;
  const detail = ie[1] as { Custom?: unknown } | undefined;
  return detail && typeof detail === 'object' && typeof detail.Custom === 'number' ? detail.Custom : null;
}
