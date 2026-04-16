/**
 * Known contract revert reasons mapped to user-friendly messages.
 */
const KNOWN_ERRORS: Record<string, string> = {
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
};

/**
 * Attempt to extract a human-readable error message from a contract error.
 * Falls back to a generic message if no known error is matched.
 */
export function decodeRevertReason(error: unknown): string {
  if (!error) return 'An unknown error occurred.';

  const message = typeof error === 'string'
    ? error
    : (error as { message?: string; shortMessage?: string; reason?: string })?.shortMessage
      ?? (error as { message?: string })?.message
      ?? String(error);

  // Check for known error patterns
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
