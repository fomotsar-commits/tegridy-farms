// Reading an EIP-5792 batch's outcome, conservatively.
//
// `wallet_sendCalls` returns a batch id, not a result. What happened has to be read back
// through `wallet_getCallsStatus`, and wallets vary: some return one receipt for the whole
// batch (the calls really did share a transaction), some return one per call, some answer
// a shape this code has never seen. Only the first two can be turned into per-leg truth.
//
// Everything else answers `unreadable`, which the run records as `unknown` — a leg that
// blocks the resume until somebody reads its receipt. That is the deliberately expensive
// default: the alternative is guessing, and a wrong guess re-sends a swap.

export type BatchCallOutcome = { status: 'confirmed' | 'reverted'; txHash?: string };

export type BatchOutcome =
  | { kind: 'pending' }
  /** Every call in the batch mapped to an outcome. */
  | { kind: 'settled'; calls: BatchCallOutcome[] }
  /** The wallet reports the batch never executed. Safe to send again. */
  | { kind: 'failed'; detail: string }
  /** Cannot be turned into per-leg truth. Legs go to `unknown`, not to `failed`. */
  | { kind: 'unreadable'; detail: string };

function receiptStatus(raw: unknown): 'confirmed' | 'reverted' | null {
  if (raw === '0x1' || raw === 1 || raw === true || raw === 'success') return 'confirmed';
  if (raw === '0x0' || raw === 0 || raw === false || raw === 'reverted' || raw === 'failure') return 'reverted';
  return null;
}

/**
 * Turn one `wallet_getCallsStatus` answer into per-call outcomes.
 *
 * `callCount` is what the caller SENT. A receipt list that is neither one-for-all nor
 * one-per-call cannot be aligned with the legs, and aligning it by position anyway is how
 * a confirmed approval gets recorded against the swap that follows it.
 */
export function parseCallsStatus(raw: unknown, callCount: number): BatchOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'unreadable', detail: 'The wallet returned no readable batch status.' };
  }
  const body = raw as { status?: unknown; receipts?: unknown; atomic?: unknown };
  const status = body.status;

  // EIP-5792 v2.0.0 numeric codes, with the older string forms still in the wild.
  const code = typeof status === 'number' ? status : typeof status === 'string' ? status.toUpperCase() : null;
  if (code === 100 || code === 'PENDING') return { kind: 'pending' };
  if (code === 400) {
    return { kind: 'failed', detail: 'The wallet reports the batch was rejected before execution.' };
  }

  const receipts = Array.isArray(body.receipts) ? body.receipts : null;
  if (!receipts || receipts.length === 0) {
    if (code === 500) {
      return {
        kind: 'unreadable',
        detail: 'The wallet reports the batch failed but returned no receipts, so which calls ran is unknown.',
      };
    }
    return { kind: 'unreadable', detail: 'The wallet returned a batch status with no receipts.' };
  }

  const mapped = receipts.map((r) => {
    const rec = (typeof r === 'object' && r !== null ? r : {}) as { status?: unknown; transactionHash?: unknown };
    return {
      status: receiptStatus(rec.status),
      txHash: typeof rec.transactionHash === 'string' ? rec.transactionHash : undefined,
    };
  });
  if (mapped.some((m) => m.status === null)) {
    return { kind: 'unreadable', detail: 'A receipt in the batch carried a status this page cannot read.' };
  }

  if (receipts.length === 1) {
    // One transaction carried every call, so they share its fate.
    const only = mapped[0]!;
    return {
      kind: 'settled',
      calls: Array.from({ length: callCount }, () => ({ status: only.status!, txHash: only.txHash })),
    };
  }
  if (receipts.length === callCount) {
    return { kind: 'settled', calls: mapped.map((m) => ({ status: m.status!, txHash: m.txHash })) };
  }
  return {
    kind: 'unreadable',
    detail: `The wallet returned ${receipts.length} receipts for ${callCount} calls, which cannot be lined up.`,
  };
}
