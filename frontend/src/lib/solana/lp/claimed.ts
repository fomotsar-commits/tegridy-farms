// Claims (Claim fees) sent this session, by share account and the balance they were worked
// out for. Once a claim is sent it may land, and after it lands a node that has not caught
// up can still answer the old balance: the old figures would offer the same claim again,
// from shares that are by then what the deposits bought. A claim against a balance one was
// already sent on is not offered (YourPositions.tsx) and not built (write/liquidity.ts
// `prepareLpWithdraw`). Recorded at send, so a claim whose landing only the pending check
// sees later is covered too; dropped only when its outcome says it did not land (expired,
// reverted, not sent). Memory only: a reload reads the chain afresh.

const sent = new Set<string>();
const keyOf = (lpAccount: string, held: bigint): string => `${lpAccount}:${held.toString()}`;

export function noteClaimSent(lpAccount: string, heldAtRead: bigint): void {
  sent.add(keyOf(lpAccount, heldAtRead));
}

/** The claim sent on this balance did not land: it may be made again. */
export function dropClaimSent(lpAccount: string, heldAtRead: bigint): void {
  sent.delete(keyOf(lpAccount, heldAtRead));
}

export function claimSentOn(lpAccount: string, held: bigint): boolean {
  return sent.has(keyOf(lpAccount, held));
}

/** For tests: each starts with no claim sent. */
export function forgetClaimsSent(): void {
  sent.clear();
}
