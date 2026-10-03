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
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../curve/program';
import { isLpKind } from './lpKinds';
import { LOCKED_SHARES_TEXT } from '../../../solana/lp/liquidityMath';
import type { CurveWriteConfig, LpKind, TxKind } from './types';

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

/**
 * Liquidity failures, said for what the person was doing. Used ONLY for adding,
 * removing and the swap page's own-pool swap (`lp-swap`): the pool's own codes mean
 * something different to someone adding than to someone taking out ("switched off" is
 * a closed door for one and a locked exit for the other), and the swap copy in
 * CP_SWAP_ERROR_COPY stays the launch pool swap's.
 */
export interface LpFailureCopy {
  /** cp-swap 6000 NotApproved: the pool's deposit or withdraw switch is off. */
  notApproved: string;
  /** cp-swap 6005 ExceededSlippage. */
  exceededSlippage: string;
  /** cp-swap 6006 ZeroTradingTokens. */
  zeroTradingTokens: string;
  /** cp-swap 6011 MathOverflow and 6012 InsufficientVault. `{n}` is the code. */
  booksOff: string;
  /** Anchor 2506 (a `require_gte!` failing) inside cp-swap. `null` = the program's general line. */
  heldTooFew: string | null;
  /** Either token program's 17, AccountFrozen. */
  accountFrozen: string;
  /** The associated-token program's 0, InvalidOwner: an account it would reuse belongs to another wallet. */
  ataInvalidOwner: string;
}

// The copy is final (spec 3.9), with plain apostrophes, so it reads the same in
// the page and in the spec the e2e checks it against.
const LP_FROZEN =
  "The token's issuer has frozen an account this needs (the pool's vault or your token account), so nothing can move. That is the issuer's doing, not the pool program's.";
const LP_ATA_OWNER = 'One of your token accounts now belongs to another wallet, so this was stopped before anything moved.';

export const LP_FAILURE_COPY: Record<Exclude<LpKind, 'lp-create'>, LpFailureCopy> = {
  'lp-deposit': {
    notApproved:
      "Deposits were switched off on this pool by the pool program's admin (the team's vault) before this ran. Nothing was added.",
    exceededSlippage:
      "The pool's price moved past your tolerance before this ran, so it would have cost more than your maximum. Start over to see the new amounts.",
    zeroTradingTokens: "Too small: at this pool's size one side would round to zero. Add a larger amount.",
    booksOff: "The pool's books did not add up when this ran (error {n}). Do not add to this pool; tell us.",
    heldTooFew: null,
    accountFrozen: LP_FROZEN,
    ataInvalidOwner: LP_ATA_OWNER,
  },
  'lp-withdraw': {
    notApproved:
      "Withdrawals are switched off on this pool by the pool program's admin (the team's vault). Only the vault can switch them back on. Your pool shares are still in your wallet.",
    exceededSlippage:
      "The pool's price moved past your tolerance before this ran, so you would have received less than your minimum. Start over to see the new amounts.",
    zeroTradingTokens: 'Too small: one side would round to zero. Take out a larger share, or all of it.',
    booksOff: "The pool's books did not add up when this ran (error {n}). Your shares are still in your wallet; tell us.",
    heldTooFew: 'Your wallet held fewer pool shares than this tried to take out when it ran. Read your positions again.',
    accountFrozen: LP_FROZEN,
    ataInvalidOwner: LP_ATA_OWNER,
  },
  // A swap through one of our pools from the main swap page (spec S3 3.10). "Nothing was
  // swapped" is true on every row: the whole transaction reverts, the site fee with it.
  'lp-swap': {
    notApproved:
      "Swaps on this pool are switched off by the pool program's admin (the team's vault), or the pool is not open yet. Nothing was swapped.",
    exceededSlippage:
      "The pool's price moved past your limit before this ran, so you would have received less than your minimum. Nothing was swapped. Start over for a fresh price.",
    zeroTradingTokens: "Too small: at this pool's size the swap would round to nothing. Try a larger amount.",
    booksOff: "The pool's books did not add up when this ran (error {n}). Nothing was swapped; tell us.",
    heldTooFew: null,
    accountFrozen: LP_FROZEN,
    ataInvalidOwner: LP_ATA_OWNER,
  },
};

/**
 * Opening a pool's failures, in its own words (spec 3.5). A front-run at the standard
 * address is the System program's custom 0 (Anchor's `init` of the pool's share token
 * finds the account in use before the handler runs), and the innermost failing program
 * speaks first, so that line names it. cp-swap 6000 at `initialize` means the fee
 * tier's `disable_create_pool` is on, not a pool's deposit switch.
 */
export const CREATE_FAILURE_COPY = {
  notApproved:
    "Opening new pools on the public fee tier was switched off by the pool program's admin (the team's vault) before this ran. Nothing was opened.",
  addressInUse: 'Someone opened a pool at this address first. Nothing was opened. Start over: the site will use a new address.',
  emptySupply: 'One side of the opening was empty when it ran. Nothing was opened.',
  notSupportMint: 'The pool program does not take this kind of token. Nothing was opened.',
  initLpAmountTooLess: `Too small: the pool program keeps ${LOCKED_SHARES_TEXT} in every new pool forever, and this opening would not cover them. Nothing was opened.`,
  tokenOwner: LP_ATA_OWNER,
  accountMissing:
    'An account the pool program needs is missing or wrong (the public fee tier, or the account that receives the fee to open a pool), so no pool can be opened right now. Nothing was opened.',
  constraint: 'The pool program refused the accounts this named. That is a fault in this site; nothing was opened. Please tell us.',
  accountFrozen: "Your token account is frozen by the token's issuer, so nothing can move out of it. Nothing was opened.",
} as const;

/** Anchor's own error numbers (anchor-lang 0.32.1 error.rs), raised inside cp-swap. */
const ANCHOR_CONSTRAINT_TOKEN_OWNER = 2015;
const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM = 3007;
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

/** The opening's sentence for this failing program and code, or null to use the general rules (token 1, lamports, rent). */
export function createFailure(program: FailingProgram, id: string, code: number): string | null {
  if (program === 'cp-swap') {
    switch (code) {
      case 6000:
        return CREATE_FAILURE_COPY.notApproved;
      case 6002:
        return CREATE_FAILURE_COPY.emptySupply;
      case 6007:
        return CREATE_FAILURE_COPY.notSupportMint;
      case 6009:
        return CREATE_FAILURE_COPY.initLpAmountTooLess;
      case ANCHOR_CONSTRAINT_TOKEN_OWNER:
        return CREATE_FAILURE_COPY.tokenOwner;
      case ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM:
      case ANCHOR_ACCOUNT_NOT_INITIALIZED:
        return CREATE_FAILURE_COPY.accountMissing;
      default:
        // Every other Anchor constraint (2000-2999, 2501 RequireEqViolated included).
        return code >= 2000 && code <= 2999 ? CREATE_FAILURE_COPY.constraint : null;
    }
  }
  if (id === SYSTEM_PROGRAM_ID.toBase58() && code === 0) return CREATE_FAILURE_COPY.addressInUse;
  if (TOKEN_PROGRAMS.has(id) && code === 17) return CREATE_FAILURE_COPY.accountFrozen;
  return null;
}

/** The liquidity sentence for this failing program and code, or null to use the general one. */
function lpFailure(kind: TxKind | undefined, program: FailingProgram, id: string, code: number | null): string | null {
  if (!isLpKind(kind) || code === null) return null;
  if (kind === 'lp-create') return createFailure(program, id, code);
  const c = LP_FAILURE_COPY[kind];
  if (program === 'cp-swap') {
    switch (code) {
      case 6000:
        return c.notApproved;
      case 6005:
        return c.exceededSlippage;
      case 6006:
        return c.zeroTradingTokens;
      case 6011:
      case 6012:
        return c.booksOff.replace('{n}', String(code));
      case 2506:
        return c.heldTooFew;
      default:
        return null;
    }
  }
  if (TOKEN_PROGRAMS.has(id) && code === 17) return c.accountFrozen;
  if (id === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() && code === 0) return c.ataInvalidOwner;
  return null;
}

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

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

const NOT_ENOUGH_SOL =
  'Your wallet does not have enough SOL for this, including the network fee and any one-time account costs.';

/** True whether it failed in the test run or on chain, so it says nothing about what was sent. */
const PLANT_SHORT = 'This wallet holds less than 100,000 $BAYLA, so the plant cannot be paid.';

/**
 * Explain a failed simulation or a reverted transaction.
 *
 * `err` is the RPC's `TransactionError` value (a string or an object); `logs` its
 * log lines, which may be missing. `kind` is what the transaction was for: a
 * liquidity kind gets LP_FAILURE_COPY where it has a sentence. Never throws.
 */
export function explainFailure(
  err: unknown,
  logs: readonly string[] | null | undefined,
  cfg: Pick<CurveWriteConfig, 'programId' | 'cpSwapProgram'>,
  kind?: TxKind,
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
    const lp = lpFailure(kind, program, id, code);
    if (lp !== null) return { program, code, message: lp };
    // In a create, Token-2022 runs only the $BAYLA plant, so its "insufficient funds"
    // is the plant's. Only in a create: a liquidity transaction's pool token can be a
    // Token-2022 token, and its shortfall is the general one below.
    if (kind === 'create' && program === 'other' && id === TOKEN_2022_PROGRAM_ID.toBase58() && code === 1) {
      return { program, code, message: PLANT_SHORT };
    }
    // Both token programs number "insufficient funds" 1.
    if (program === 'other' && TOKEN_PROGRAMS.has(id) && code === 1) {
      return { program, code, message: 'You do not hold that many tokens.' };
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
