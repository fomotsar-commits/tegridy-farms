// The edges of waitForTxOutcome that a scripted node cannot easily produce, and
// the words the outcomes become. The shapes ethers really throws are pinned
// against the real library in txOutcome.ethers.test.js.
//
// The rule every case here leans on: only POSITIVE evidence is a revert or a
// "did not happen". Anything unrecognised is "we can't tell", because calling an
// unread success a failure invites a second send.
import { describe, it, expect, vi } from "vitest";
import { makeError } from "ethers";
import {
  waitForTxOutcome, txOutcomeResult, txOutcomeError, isTxNotice, toastTxNotice, toastTxOutcome, txExplorerUrl,
} from "./txOutcome";
import { getFriendlyError } from "./errorMessages";

const SENT = "0x" + "11".repeat(32);
const TOOK = "0x" + "22".repeat(32);
const tx = (wait) => ({ hash: SENT, wait });
const WORDS = { reverted: { error: "reverted", message: "It reverted." }, ifLanded: "it is already done." };

describe("waitForTxOutcome on evidence it does not recognise", () => {
  it.each([
    ["no receipt at all", null],
    ["a receipt with no status", { hash: SENT }],
    ["a receipt whose status is not 0 or 1", { hash: SENT, status: null }],
  ])("%s is unreadable, not a success", async (_label, receipt) => {
    expect(await waitForTxOutcome(tx(async () => receipt))).toMatchObject({ kind: "unreadable", hash: SENT });
  });

  it("a CALL_EXCEPTION that carries no reverted receipt is not a revert", async () => {
    // The same code a failed gas estimate or eth_call uses. Without the receipt
    // there is no proof this transaction was mined at all.
    const error = makeError("missing revert data", "CALL_EXCEPTION", {
      action: "estimateGas", data: null, reason: null, invocation: null, revert: null, transaction: { to: null, data: "" },
    });
    expect(await waitForTxOutcome(tx(() => Promise.reject(error)))).toMatchObject({ kind: "unreadable", hash: SENT });
  });

  it("a replacement with a reason ethers does not have is unreadable, pointing at what confirmed", async () => {
    const error = makeError("transaction was replaced", "TRANSACTION_REPLACED", {
      cancelled: false, reason: "something-new", replacement: {}, hash: TOOK, receipt: { status: 1, hash: TOOK },
    });
    expect(await waitForTxOutcome(tx(() => Promise.reject(error)))).toMatchObject({ kind: "unreadable", hash: TOOK, sentHash: SENT });
  });

  it("a replacement that names no transaction is unreadable under the hash that was sent", async () => {
    const error = makeError("transaction was replaced", "TRANSACTION_REPLACED", {
      cancelled: false, reason: "repriced", replacement: {}, hash: undefined, receipt: { status: 1 },
    });
    expect(await waitForTxOutcome(tx(() => Promise.reject(error)))).toMatchObject({ kind: "unreadable", hash: SENT });
  });

  it("a speed-up whose receipt has no status is unreadable, not a success", async () => {
    const error = makeError("transaction was replaced", "TRANSACTION_REPLACED", {
      cancelled: false, reason: "repriced", replacement: {}, hash: TOOK, receipt: { hash: TOOK },
    });
    expect(await waitForTxOutcome(tx(() => Promise.reject(error)))).toMatchObject({ kind: "unreadable", hash: TOOK });
  });

  it("a timeout, or anything else thrown, is unreadable", async () => {
    for (const thrown of [makeError("wait for transaction timeout", "TIMEOUT", {}), new Error("boom"), "a string", undefined]) {
      expect((await waitForTxOutcome(tx(() => Promise.reject(thrown)))).kind).toBe("unreadable");
    }
  });
});

describe("waitForTxOutcome and the replacement scan", () => {
  it("re-arms a response before waiting, from a block behind the head", async () => {
    const rearmedWait = vi.fn(async () => ({ status: 1, hash: SENT }));
    const replaceableTransaction = vi.fn(() => ({ wait: rearmedWait }));
    const bareWait = vi.fn();
    const outcome = await waitForTxOutcome({
      hash: SENT, wait: bareWait, replaceableTransaction, provider: { getBlockNumber: async () => 100 },
    });
    expect(outcome.kind).toBe("success");
    expect(bareWait).not.toHaveBeenCalled();
    const [startBlock] = replaceableTransaction.mock.calls[0];
    expect(startBlock).toBeLessThan(100);
    expect(startBlock).toBeGreaterThanOrEqual(0);
  });

  it("never asks for a negative start block on a young chain", async () => {
    const replaceableTransaction = vi.fn(() => ({ wait: async () => ({ status: 1 }) }));
    await waitForTxOutcome({ hash: SENT, wait: vi.fn(), replaceableTransaction, provider: { getBlockNumber: async () => 2 } });
    expect(replaceableTransaction).toHaveBeenCalledWith(0);
  });

  it("waits on the response as it is when the head cannot be read", async () => {
    const bareWait = vi.fn(async () => ({ status: 1, hash: SENT }));
    const outcome = await waitForTxOutcome({
      hash: SENT, wait: bareWait, replaceableTransaction: vi.fn(),
      provider: { getBlockNumber: async () => { throw new Error("rpc down"); } },
    });
    expect(outcome.kind).toBe("success");
    expect(bareWait).toHaveBeenCalledTimes(1);
  });
});

describe("the words", () => {
  const unreadable = { kind: "unreadable", hash: SENT, sentHash: SENT, error: new Error("rpc") };
  const cancelled = { kind: "replaced", reason: "cancelled", hash: TOOK, sentHash: SENT };
  const otherCall = { kind: "replaced", reason: "replaced", hash: TOOK, sentHash: SENT };

  it("a revert is the site's own answer, untouched", () => {
    expect(txOutcomeResult({ kind: "reverted", hash: SENT, sentHash: SENT }, WORDS)).toEqual(WORDS.reverted);
  });

  it("an unread receipt says we can't tell, names the transaction, and says what a resend would do", () => {
    const res = txOutcomeResult(unreadable, WORDS);
    expect(res).toMatchObject({ error: "unconfirmed", hash: SENT });
    expect(res.message).toContain("0x11111111…11111111");
    expect(res.message).toMatch(/can't tell whether it went through/);
    expect(res.message).toMatch(/before you send it again: if it landed, it is already done\.$/);
    expect(res.message).not.toMatch(/fail|revert|succe/i);
  });

  it("a cancel and a different call each say what took the transaction's place", () => {
    const a = txOutcomeResult(cancelled, WORDS);
    const b = txOutcomeResult(otherCall, WORDS);
    expect(a).toMatchObject({ error: "replaced", reason: "cancelled", hash: TOOK, sentHash: SENT });
    expect(a.message).toMatch(/cancelled in your wallet/);
    expect(b.message).toMatch(/replaced .* with a different transaction/);
    for (const res of [a, b]) {
      expect(res.message).toContain("0x11111111…11111111");
      expect(res.message).toContain("0x22222222…22222222");
      expect(res.message).toMatch(/did not happen/);
    }
  });

  it("no notice carries an em dash", () => {
    for (const outcome of [unreadable, cancelled, otherCall]) {
      expect(txOutcomeResult(outcome, WORDS).message).not.toMatch(/—/);
    }
  });

  it("isTxNotice is true for the two notices and nothing else", () => {
    expect(isTxNotice(txOutcomeResult(unreadable, WORDS))).toBe(true);
    expect(isTxNotice(txOutcomeResult(cancelled, WORDS))).toBe(true);
    for (const other of [WORDS.reverted, { error: "failed" }, { error: "rejected" }, { success: true }, null, undefined]) {
      expect(isTxNotice(other)).toBe(false);
    }
  });

  it("txOutcomeError carries a notice on .notice, and a revert as a plain error", () => {
    const notice = txOutcomeError(unreadable, WORDS);
    expect(notice).toBeInstanceOf(Error);
    expect(notice.code).toBe("unconfirmed");
    expect(notice.notice).toEqual(txOutcomeResult(unreadable, WORDS));
    const revert = txOutcomeError({ kind: "reverted", hash: SENT, sentHash: SENT }, WORDS);
    expect(revert.message).toBe("It reverted.");
    expect(revert.code).toBe("reverted");
    expect(revert.notice).toBeUndefined();
  });
});

describe("the toast", () => {
  it("a notice is a long-lived warning that links the transaction to look at", () => {
    const addToast = vi.fn();
    const res = txOutcomeResult({ kind: "replaced", reason: "cancelled", hash: TOOK, sentHash: SENT }, WORDS);
    expect(toastTxNotice(addToast, res)).toBe(true);
    const [message, type, opts] = addToast.mock.calls[0];
    expect(message).toBe(res.message);
    expect(type).toBe("warning");
    expect(opts.duration).toBeGreaterThanOrEqual(20_000);
    expect(opts.link.href).toBe(txExplorerUrl(TOOK));
    expect(txExplorerUrl(TOOK)).toBe(`https://etherscan.io/tx/${TOOK}`);
  });

  it("anything else is left to the caller", () => {
    const addToast = vi.fn();
    expect(toastTxNotice(addToast, { error: "failed", message: "x" })).toBe(false);
    expect(toastTxNotice(addToast, { success: true })).toBe(false);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("toastTxOutcome words a revert as an error and a notice as a warning", () => {
    const addToast = vi.fn();
    toastTxOutcome(addToast, { kind: "reverted", hash: SENT, sentHash: SENT }, WORDS);
    toastTxOutcome(addToast, { kind: "unreadable", hash: SENT, sentHash: SENT }, WORDS);
    expect(addToast.mock.calls.map(([, type]) => type)).toEqual(["error", "warning"]);
    expect(addToast.mock.calls[0][0]).toBe("It reverted.");
  });

  it("why a screen must not pass a notice through getFriendlyError", () => {
    // The shared mapper turns any message over 120 characters into "Transaction
    // failed, please try again". Every notice is longer than that. This is the
    // reason toastTxNotice exists, pinned so a shorter notice does not hide it.
    const res = txOutcomeResult({ kind: "unreadable", hash: SENT, sentHash: SENT }, WORDS);
    expect(res.message.length).toBeGreaterThan(120);
    expect(getFriendlyError(res.message)).toMatch(/failed/i);
  });
});
