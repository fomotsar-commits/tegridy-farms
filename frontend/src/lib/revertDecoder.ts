/**
 * Revert reason decoder — surfaces user-friendly text from a contract revert.
 *
 * AUDIT R074 (M-01): the previous decoder was a regex over the stringified
 * error message which missed every viem-shaped custom error (the new style
 * across our contracts). It now walks the viem error chain via
 * `BaseError#walk(...)` to find the `ContractFunctionRevertedError` and
 * pull `errorName` / `args` directly out of the structured payload.
 *
 * Falls back to the old string-pattern matching for plain JSON-RPC reverts
 * and other non-viem errors (e.g. providers that surface a raw string).
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';

/**
 * Known contract revert reasons (string + custom-error name) mapped to
 * user-friendly messages.
 */
const KNOWN_ERRORS: Record<string, string> = {
  // Legacy `require()` strings
  'INSUFFICIENT_OUTPUT_AMOUNT': 'Price moved too much — try increasing slippage.',
  'INSUFFICIENT_LIQUIDITY': 'Not enough liquidity for this trade.',
  'EXPIRED': 'Transaction expired — please try again.',
  'TRANSFER_FROM_FAILED': 'Token transfer failed — check your balance and approval.',
  'INSUFFICIENT_A_AMOUNT': 'Insufficient token amount for liquidity.',
  'INSUFFICIENT_B_AMOUNT': 'Insufficient token amount for liquidity.',
  'LOCKED': 'Your tokens are still locked. Wait for the lock period to expire.',
  'NOT_OWNER': 'You do not own this position.',
  'ZERO_AMOUNT': 'Amount must be greater than zero.',
  'ALREADY_STAKED': 'You already have an active staking position.',
  'NO_REWARDS': 'No rewards available to claim.',
  'INVALID_LOCK_DURATION': 'Lock duration is outside the allowed range.',
  'EARLY_WITHDRAWAL': 'Early withdrawal will incur a 25% penalty.',
  'execution reverted': 'Transaction reverted — the on-chain conditions changed. Try again.',
  'user rejected': 'Transaction was rejected in your wallet.',
  'User denied': 'Transaction was rejected in your wallet.',

  // AUDIT R074: viem custom-error names emitted by our contracts.
  'InsufficientPayment': 'Repayment amount has changed — refresh and try again.',
  'InvalidLoanId': 'Loan does not exist.',
  'OfferInactive': 'This loan offer is no longer active.',
  'NotBorrower': 'Only the borrower can take this action.',
  'NotLender': 'Only the lender can take this action.',
  'AlreadyRepaid': 'This loan has already been repaid.',
  'NotDefaulted': 'Loan is not in default — wait until the deadline passes.',
  'AlreadyClaimed': 'Default has already been claimed.',
  'CollateralMismatch': 'Collateral does not match this offer.',
  'BelowMinimumCollateral': 'Your position value is below the lender’s minimum.',
  'PositionLocked': 'Your staking position is still locked.',
  'PositionNotOwned': 'You do not own this staking position.',
  'NotPaused': 'Contract is not paused.',
  'EnforcedPause': 'Action is paused on-chain — try again later.',
  'ReentrancyGuardReentrantCall': 'Re-entrant call blocked. Refresh and try again.',
  'OwnableUnauthorizedAccount': 'You are not authorised for this action.',
  'OwnableInvalidOwner': 'Invalid owner address.',
  'ERC20InsufficientBalance': 'Token balance is too low.',
  'ERC20InsufficientAllowance': 'Approval is too low — approve a larger amount and try again.',
  'ERC20InvalidApprover': 'Invalid approver.',
  'ERC721NonexistentToken': 'NFT does not exist.',
  'ERC721InsufficientApproval': 'NFT not approved — approve the contract and try again.',
  'ERC721IncorrectOwner': 'NFT owner mismatch.',
  'SafeERC20FailedOperation': 'Token transfer failed.',
  'SequencerDown': 'L2 sequencer is down — try again shortly.',
  'OracleStale': 'Oracle is stale — try again in a moment.',
  'OracleDeviation': 'Oracle price deviation too high — try again.',
  'NotEOA': 'Smart-contract wallets are not allowed for this action.',
  'NoActivePosition': 'You have no active staking position.',
  'BoostExpired': 'Your JBAC boost has expired — revalidate your position.',
};

/**
 * Walk the viem error chain looking for a ContractFunctionRevertedError. If
 * found, return the structured custom-error name; otherwise undefined.
 */
function extractCustomErrorName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | undefined;
  if (!reverted) return undefined;
  return reverted.data?.errorName;
}

/**
 * Attempt to extract a human-readable error message from a contract error.
 * Falls back to a generic message if no known error is matched.
 */
export function decodeRevertReason(error: unknown): string {
  if (!error) return 'An unknown error occurred.';

  // AUDIT R074: try the structured custom-error path first.
  const customName = extractCustomErrorName(error);
  if (customName && KNOWN_ERRORS[customName]) return KNOWN_ERRORS[customName]!;
  if (customName) return `Transaction failed: ${customName}`;

  const message = typeof error === 'string'
    ? error
    : (error as { message?: string; shortMessage?: string; reason?: string })?.shortMessage
      ?? (error as { message?: string })?.message
      ?? String(error);

  // Check for known error patterns (legacy require() strings)
  for (const [pattern, friendly] of Object.entries(KNOWN_ERRORS)) {
    if (message.includes(pattern)) return friendly;
  }

  // Extract revert reason from "execution reverted: REASON" pattern
  const revertMatch = message.match(/execution reverted:\s*(.+?)(?:\s*\(|$)/i);
  if (revertMatch?.[1]) {
    const reason = revertMatch[1].trim();
    // Check if the extracted reason matches a known error
    for (const [pattern, friendly] of Object.entries(KNOWN_ERRORS)) {
      if (reason.includes(pattern)) return friendly;
    }
    return `Transaction failed: ${reason}`;
  }

  // Truncate very long messages
  if (message.length > 200) {
    return message.slice(0, 150) + '…';
  }

  return message;
}
