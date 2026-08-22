// Whether anything executes on the user's behalf. It does not, and this module is
// where that fact is held so no surface can drift away from it.
//
// A liquidation shield is the one product where a confident UI is actively
// dangerous. A user who believes a rescue will fire stops watching the position;
// if nothing fires, they lose the collateral AND the chance they would have had
// if they had known they were on their own. That user is strictly worse off than
// one who was told plainly "you execute this yourself" and set their own alarm.
// So the resting state here is not "automation pending" or "keeper starting up" —
// it is that execution is the user's, stated in the user's own words.
//
// `SHIELD_AUTOMATION_AVAILABLE` is a constant rather than an env flag for the same
// reason `triggers/armState.ts` makes `KEEPER_AVAILABLE` one: an operator cannot
// make a keeper exist by setting a variable, and a dial invites exactly that.
// Flipping it requires the F4 items in `F4_REQUIREMENTS` to be true in fact.

/** Flips only when F4 ships an executor that actually watches and submits. */
export const SHIELD_AUTOMATION_AVAILABLE = false;

/**
 * What F4 has to supply before the flag above may move. Exported so the surface
 * prints it verbatim: the user asking "why won't this save me" and the operator
 * asking "what is left to build" read the same list.
 */
export const F4_REQUIREMENTS: readonly string[] = [
  'A position watcher that reads each subscribed loan’s deadline, default status and repayment quote on its own tick, off the user’s browser, with its own staleness bound — the monitor loop in this app runs only while the tab is open.',
  'A watcher that takes the closing time from `isDefaulted`, never from `effectiveDeadline + GRACE_PERIOD`. The contract extends grace by its own pause time, so the constant expires while repayment is still being accepted; a keeper scheduled on the constant would give up on a loan it could still have saved, and one that trusted the constant the other way would fire into a window that had already closed.',
  'A pre-authorised execution credential scoped to {lending contract, loan id, max repayment, expiry}, revocable on-chain, so the executor can repay without ever holding or being able to redirect user funds.',
  'A funding source for the repayment itself. Monitoring is free; a repay is not. Either the user pre-funds an escrow they can withdraw from, or the executor flash-borrows and the position deleverages — the venue may not front capital it has not earned.',
  'Per-attempt receipts including failures, readable back into this UI, so a save that did not happen is visible as not having happened rather than as silence.',
  'Idempotency per (loan, attempt), so a retry cannot repay twice or repay a loan the user already closed.',
  'Revocation that provably stops execution — the credential dead on-chain, not a row deleted from a table.',
];

/**
 * The sentence every shield surface carries. Pinned by test: it must name the
 * user as the executor and must not describe a watcher that does not exist.
 */
export const EXECUTION_IS_YOURS =
  'You execute this yourself. Nothing watches this position while this page is closed, and nothing signs for you.';

/**
 * The scope of the monitoring that DOES exist. Deliberately narrower than the
 * alerts engine's own coverage sentence, because a shield read is an RPC read
 * from this tab and stops with the tab.
 */
export const MONITORING_SCOPE =
  'Health is read from the lending contract in this browser tab while the page is open. Close the tab and nothing is being read.';

/**
 * What a triggered alert is and is not. An alert that arrives is a message, not
 * an intervention — worth saying because the two are easy to conflate at the
 * moment one lands.
 */
export const ALERT_IS_NOT_AN_ACTION =
  'An alert tells you the deadline is close. It does not repay anything — you still have to sign the repayment.';

/**
 * The other half of "one-click prepared action": which actions exist at all.
 *
 * A borrower arriving from a money market looks for the two moves that work
 * there — add collateral, or deleverage by repaying part of the debt. Neither
 * exists on `TegridyNFTLending`: `repayLoan` is the only debt-side function, it
 * reverts on anything under the full amount (`InsufficientRepayment`), and the
 * collateral is a single NFT that cannot be partly sold. Leaving that unsaid
 * would send a user hunting for a smaller, cheaper move that is not there while
 * the deadline runs out.
 */
export const ONLY_FULL_REPAYMENT =
  'Full repayment is the only move these loans have. The lending contract takes no partial repayment, no collateral top-up and no deleverage — the collateral is one NFT and cannot be partly sold — so nothing smaller than the whole amount clears the deadline.';

export interface ShieldAutomationState {
  /** True only when a named executor actually submits transactions for the user. */
  automated: boolean;
  /** Short status word. There is no optimistic middle value here on purpose. */
  statusLabel: 'Not automated';
  /** One sentence naming who executes. Never empty. */
  statusDetail: string;
  /** Non-empty exactly while `automated` is false. */
  requirements: readonly string[];
}

export function shieldAutomationState(): ShieldAutomationState {
  return {
    automated: SHIELD_AUTOMATION_AVAILABLE,
    statusLabel: 'Not automated',
    statusDetail: EXECUTION_IS_YOURS,
    requirements: SHIELD_AUTOMATION_AVAILABLE ? [] : F4_REQUIREMENTS,
  };
}

/**
 * Every user-facing sentence this feature ships, in one place, so the wording
 * test can sweep the whole surface rather than the subset someone remembered to
 * list. A new string rendered by a shield component belongs here.
 */
export const SHIELD_COPY = {
  title: 'Liquidation shield',
  subtitle: 'Health monitoring and a ready-to-sign repayment. Not automated rescue.',
  executionIsYours: EXECUTION_IS_YOURS,
  monitoringScope: MONITORING_SCOPE,
  alertIsNotAnAction: ALERT_IS_NOT_AN_ACTION,
  onlyFullRepayment: ONLY_FULL_REPAYMENT,
  automationHeading: 'What would make this automatic',
  automationLead:
    'The venue runs no keeper. Until one exists, every item below is missing, and this surface prepares transactions rather than sending them.',
  noPositions:
    'This wallet has no open borrow on the venue’s NFT lending. Nothing is at risk here, so nothing is being watched.',
  signButton: 'Review and sign repayment',
  /**
   * Rendered when the wallet has NO deadline rule. The absence of an alerts
   * section would otherwise read as alerts being handled, which is the same
   * silent-implication failure as an empty list standing in for an outage.
   */
  noRules:
    'No deadline alert is set up for these loans. Nothing will notify you — add a “Loan deadline approaching” rule on the alerts page, and read what it covers before relying on it.',
  /** Prefix for the rule store’s own failure, so an operator sentence lands in context. */
  ruleStoreProblem: 'Deadline alerts cannot be read or created right now:',
} as const;
