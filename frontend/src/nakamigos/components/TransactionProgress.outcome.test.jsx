// The buy overlay, on the two answers that are neither success nor failure, and
// on its own SPEED UP button.
//
// "Transaction Failed" with a RETRY button is an instruction to send again. It is
// the right panel for a revert and the wrong one for a receipt nobody could read:
// the purchase may have landed. And a speed-up sent from this overlay is a NEW
// transaction hash, so a monitor that keeps asking for the old one never ends.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { txOutcomeResult } from "../lib/txOutcome";

const SENT = "0x" + "11".repeat(32);
const TOOK = "0x" + "22".repeat(32);

const h = vi.hoisted(() => ({ receipts: {}, transaction: null, sendTransaction: null }));

vi.mock("../api", () => ({ getProvider: () => ({ request: () => {} }) }));
vi.mock("ethers", () => {
  class MockBrowserProvider {
    async getTransactionReceipt(hash) { return h.receipts[hash] ?? null; }
    async getTransaction() { return h.transaction; }
    async getSigner() { return { sendTransaction: (...a) => h.sendTransaction(...a) }; }
  }
  return { ethers: { BrowserProvider: MockBrowserProvider } };
});

let TransactionProgress;

beforeEach(async () => {
  h.receipts = {};
  h.transaction = {
    to: "0x00000000000000000000000000000000000c0de1", value: 5n, data: "0xd0e30db0", nonce: 7,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gasLimit: 100000n, blockNumber: null,
  };
  h.sendTransaction = vi.fn(async () => ({ hash: TOOK }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Loaded once up front, so the overlay's own `import("ethers")` is a cache hit.
  await import("ethers");
  ({ default: TransactionProgress } = await import("./TransactionProgress"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const WORDS = { reverted: { error: "failed", message: "Transaction reverted on-chain" }, ifLanded: "the NFT is already yours." };

async function showResult(result, props = {}) {
  await act(async () => {
    render(<TransactionProgress visible price={0.05} onExecute={async () => result} onClose={() => {}} {...props} />);
  });
}

describe("the overlay does not call an unknown outcome a failure", () => {
  it("control: a revert is 'Transaction Failed', with RETRY", async () => {
    await showResult(txOutcomeResult({ kind: "reverted", hash: SENT, sentHash: SENT }, WORDS));
    expect(screen.getByText("Transaction Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "RETRY" })).toBeTruthy();
  });

  it("an unread receipt says we can't tell, links the transaction, and offers no RETRY", async () => {
    await showResult(txOutcomeResult({ kind: "unreadable", hash: SENT, sentHash: SENT, error: new Error("rpc") }, WORDS));
    expect(screen.queryByText("Transaction Failed")).toBeNull();
    expect(document.body.textContent).not.toMatch(/fail/i);
    expect(document.body.textContent).toMatch(/couldn't confirm/i);
    expect(document.body.textContent).toMatch(/before you send it again/i);
    expect(screen.queryByRole("button", { name: "RETRY" })).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://etherscan.io/tx/${SENT}`);
  });

  it("a wallet cancel says it did not happen, links what confirmed instead, and may be retried", async () => {
    await showResult(txOutcomeResult({ kind: "replaced", reason: "cancelled", hash: TOOK, sentHash: SENT }, WORDS));
    expect(screen.queryByText("Transaction Failed")).toBeNull();
    expect(document.body.textContent).not.toMatch(/fail/i);
    expect(screen.getByText("Transaction cancelled")).toBeTruthy();
    expect(document.body.textContent).toMatch(/did not happen/i);
    expect(screen.getByRole("button", { name: "RETRY" })).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://etherscan.io/tx/${TOOK}`);
  });
});

describe("the pending monitor follows a speed-up it sent", () => {
  const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  async function pendingFor(ms, onSuccess) {
    vi.useFakeTimers();
    await showResult({ success: true, hash: SENT }, { onSuccess });
    await tick(ms);
  }

  it("confirms under the replacement's hash once the replacement mines", async () => {
    const onSuccess = vi.fn();
    await pendingFor(120_000, onSuccess);
    fireEvent.click(screen.getByRole("button", { name: "SPEED UP" }));
    await tick(0);
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    expect(h.sendTransaction.mock.calls[0][0]).toMatchObject({ nonce: 7, data: "0xd0e30db0", value: 5n });

    // Only the replacement ever gets a receipt: the original never mines.
    h.receipts[TOOK] = { status: 1, gasUsed: 21000n, gasPrice: 10n ** 9n };
    await tick(3000);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].hash).toBe(TOOK);
    expect(screen.getByText("Purchase Complete")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://etherscan.io/tx/${TOOK}`);
  });

  it("still confirms under the original hash when the original mines first", async () => {
    const onSuccess = vi.fn();
    await pendingFor(120_000, onSuccess);
    fireEvent.click(screen.getByRole("button", { name: "SPEED UP" }));
    await tick(0);
    h.receipts[SENT] = { status: 1, gasUsed: 21000n, gasPrice: 10n ** 9n };
    await tick(3000);
    expect(onSuccess.mock.calls[0][0].hash).toBe(SENT);
  });

  it("sends nothing for a transaction that has already mined", async () => {
    // Receipt reads can fail for two minutes while the transaction is in a block.
    // Sending its call again is not a speed-up: it is the purchase, twice.
    h.transaction = { ...h.transaction, blockNumber: 19_000_000 };
    await pendingFor(120_000, vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "SPEED UP" }));
    await tick(0);
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});
