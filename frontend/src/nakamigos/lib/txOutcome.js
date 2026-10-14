// ethers v6 `tx.wait()` throws for three different facts, and the app owes each
// one different words. Measured against the installed ethers by
// txOutcome.ethers.test.js, which runs the real library:
//   a reverted receipt        -> throws CALL_EXCEPTION, carrying the receipt
//   a replaced transaction    -> throws TRANSACTION_REPLACED, a speed-up included
//   a receipt it cannot read  -> throws the RPC error: nothing is known

const ETHERSCAN_TX = "https://etherscan.io/tx/";

// A response from a contract method (`seaport.cancel(...)`) has lost the block
// its signer started the replacement scan at, so its wait() never settles once
// the wallet replaces it. Re-arming needs a block no later than the send.
const REARM_LOOKBACK_BLOCKS = 5;

async function rearmed(tx) {
  if (typeof tx?.replaceableTransaction !== "function" || !tx.provider) return tx;
  try {
    const head = await tx.provider.getBlockNumber();
    return tx.replaceableTransaction(Math.max(0, head - REARM_LOOKBACK_BLOCKS));
  } catch {
    return tx;
  }
}

// Only a receipt that was read and says 1 is a success, and only one that says
// 0 is a revert. Anything else is "we could not read it".
function fromReceipt(receipt, hash, sentHash) {
  if (receipt?.status === 1) return { kind: "success", hash, sentHash, receipt };
  if (receipt?.status === 0) return { kind: "reverted", hash, sentHash, receipt };
  return { kind: "unreadable", hash, sentHash, error: null };
}

/**
 * Wait for an ethers transaction and say what happened to it. Never throws.
 *
 * `kind` is 'success', 'reverted', 'replaced' (a cancel, or a different call at
 * that nonce: what was sent did not happen) or 'unreadable' (nothing is known).
 * `hash` is the transaction to look at, which after a speed-up or a replacement
 * is the one that mined and not the one sent (`sentHash`).
 */
export async function waitForTxOutcome(tx) {
  const sentHash = tx.hash;
  let receipt;
  try {
    receipt = await (await rearmed(tx)).wait();
  } catch (error) {
    if (error?.code === "TRANSACTION_REPLACED" && error.hash) {
      // A speed-up is the same call. It ran, and its own receipt says how.
      if (error.reason === "repriced") return fromReceipt(error.receipt, error.hash, sentHash);
      if (error.reason === "cancelled" || error.reason === "replaced") {
        return { kind: "replaced", reason: error.reason, hash: error.hash, sentHash, receipt: error.receipt };
      }
      return { kind: "unreadable", hash: error.hash, sentHash, error };
    }
    if (error?.code === "CALL_EXCEPTION" && error.receipt?.status === 0) {
      return { kind: "reverted", hash: sentHash, sentHash, receipt: error.receipt };
    }
    return { kind: "unreadable", hash: sentHash, sentHash, error };
  }
  return fromReceipt(receipt, sentHash, sentHash);
}

const short = (hash) =>
  typeof hash === "string" && hash.length > 22 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : String(hash);

/**
 * The `{ error, message }` a site returns for an outcome that is not a success.
 *
 * `reverted` is the site's own answer to a revert. `ifLanded` completes "if it
 * landed, ___" for a receipt nobody could read: what sending it again would do.
 */
export function txOutcomeResult(outcome, { reverted, ifLanded }) {
  if (outcome.kind === "reverted") return { ...reverted };
  const sent = short(outcome.sentHash);
  if (outcome.kind === "replaced") {
    const took = short(outcome.hash);
    return {
      error: "replaced",
      reason: outcome.reason,
      hash: outcome.hash,
      sentHash: outcome.sentHash,
      message: outcome.reason === "cancelled"
        ? `${sent} was cancelled in your wallet: an empty transaction (${took}) confirmed in its place, so what you sent did not happen.`
        : `Your wallet replaced ${sent} with a different transaction (${took}), which confirmed in its place. What you sent did not happen as sent.`,
    };
  }
  return {
    error: "unconfirmed",
    hash: outcome.hash,
    sentHash: outcome.sentHash,
    message:
      `We couldn't confirm this transaction. ${sent} was sent, but we couldn't read its result, so we can't ` +
      `tell whether it went through. Check it on Etherscan before you send it again: if it landed, ${ifLanded}`,
  };
}

/** True for the two results that are neither a success nor a failure. */
export function isTxNotice(result) {
  return result?.error === "unconfirmed" || result?.error === "replaced";
}

/** The same answer as an Error, for a helper that throws. A notice rides on `.notice`. */
export function txOutcomeError(outcome, words) {
  const result = txOutcomeResult(outcome, words);
  return Object.assign(new Error(result.message), {
    code: result.error,
    notice: isTxNotice(result) ? result : undefined,
  });
}

/** Where to look at a transaction. */
export const txExplorerUrl = (hash) => `${ETHERSCAN_TX}${hash}`;

/**
 * Toast a notice as a long-lived warning with a link to the transaction, and
 * return true. Returns false for any other result, which the caller words itself.
 */
export function toastTxNotice(addToast, result) {
  if (!isTxNotice(result)) return false;
  addToast?.(result.message, "warning", {
    duration: 30_000,
    link: { href: txExplorerUrl(result.hash), label: "Etherscan" },
  });
  return true;
}

/** For a site that toasts for itself: say what an outcome that is not a success was. */
export function toastTxOutcome(addToast, outcome, words) {
  const result = txOutcomeResult(outcome, words);
  if (!toastTxNotice(addToast, result)) addToast?.(result.message, "error");
}
