// Library-contract pin for waitForTxOutcome.
//
// The helper leans on how ethers v6 `TransactionResponse.wait()` fails, which is
// an implementation detail of the library. So nothing here builds those errors by
// hand: each case sends a transaction through the REAL BrowserProvider, over a
// scripted EIP-1193 node, by both routes the marketplace uses
// (`signer.sendTransaction` and a contract method), and classifies whatever
// wait() does. If an ethers upgrade changes a shape, this goes red before a buyer
// is told a purchase that landed "failed".
import { describe, it, expect, afterEach } from "vitest";
import { ethers } from "ethers";
import { waitForTxOutcome } from "./txOutcome";

const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TO = "0x00000000000000000000000000000000000c0de1";
const SENT = "0x" + "11".repeat(32);
const TOOK = "0x" + "22".repeat(32);
const BLOCK_HASH = "0x" + "bb".repeat(32);
const DATA = "0xd0e30db0"; // deposit()

const rpcTx = (over = {}) => ({
  hash: SENT, blockHash: null, blockNumber: null, transactionIndex: null,
  from: FROM, to: TO, input: DATA, value: "0x5", gas: "0x186a0", nonce: "0x7",
  type: "0x2", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1", chainId: "0x1",
  v: "0x0", yParity: "0x0", r: "0x" + "01".repeat(32), s: "0x" + "02".repeat(32), accessList: [],
  ...over,
});
const rpcReceipt = (hash, status) => ({
  transactionHash: hash, blockHash: BLOCK_HASH, blockNumber: "0x65", transactionIndex: "0x0",
  from: FROM, to: TO, status, logs: [], logsBloom: "0x" + "0".repeat(512), type: "0x2",
  gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", contractAddress: null,
});
const rpcBlock = (number, transactions) => ({
  hash: BLOCK_HASH, number, parentHash: BLOCK_HASH, timestamp: "0x1", transactions,
  baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x5208", logsBloom: "0x" + "0".repeat(512),
  miner: FROM, nonce: "0x0000000000000000", difficulty: "0x0", extraData: "0x", size: "0x1",
  stateRoot: BLOCK_HASH, receiptsRoot: BLOCK_HASH, transactionsRoot: BLOCK_HASH, sha3Uncles: BLOCK_HASH, uncles: [],
});

// The node as it stands once the wallet has sent: block 0x64 before the send,
// `headAfter` after. `script` overrides what the wait reads.
function nodeFor(script, headAfter = "0x65") {
  let sent = false;
  const base = {
    eth_chainId: () => "0x1",
    eth_accounts: () => [FROM],
    eth_estimateGas: () => "0x186a0",
    eth_blockNumber: () => (sent ? headAfter : "0x64"),
    eth_sendTransaction: () => { sent = true; return SENT; },
    eth_getTransactionByHash: ([hash]) => (hash === SENT ? rpcTx() : null),
  };
  return {
    async request({ method, params }) {
      const answer = script[method] ?? base[method];
      if (!answer) throw Object.assign(new Error(`unscripted ${method}`), { code: -32601 });
      return answer(params ?? []);
    },
  };
}

// Mined: the transaction's own receipt answers with `status`.
const mined = (status) => () => ({ eth_getTransactionReceipt: () => rpcReceipt(SENT, status) });

// Replaced: the node knew the transaction when it was sent, then dropped it. The
// nonce is used, and block 0x65 holds another transaction from the same sender
// at that nonce, whose receipt says `status`.
const replacedBy = (replacement, status = "0x1") => () => {
  let reads = 0;
  return {
    eth_getTransactionByHash: ([hash]) => (hash === SENT && reads++ === 0 ? rpcTx() : null),
    eth_getTransactionReceipt: ([hash]) => (hash === TOOK ? rpcReceipt(TOOK, status) : null),
    eth_getTransactionCount: () => "0x8",
    eth_getBlockByNumber: ([number]) => rpcBlock(number, number === "0x65"
      ? [rpcTx({ hash: TOOK, blockHash: BLOCK_HASH, blockNumber: "0x65", transactionIndex: "0x0", ...replacement })]
      : []),
  };
};
const SPEED_UP = { maxFeePerGas: "0x77359400" }; // same to, value and calldata
const WALLET_CANCEL = { to: FROM, value: "0x0", input: "0x" }; // a 0-value send to yourself
const OTHER_CALL = { input: "0xdeadbeef" };

const unreadable = () => ({
  eth_getTransactionReceipt: () => { throw Object.assign(new Error("limit exceeded"), { code: -32005 }); },
});

const providers = [];
afterEach(() => { while (providers.length) providers.pop().destroy(); });

const ROUTES = {
  "signer.sendTransaction": (signer) => signer.sendTransaction({ to: TO, value: 5n, data: DATA }),
  "a contract method": (signer) => new ethers.Contract(TO, ["function deposit() payable"], signer).deposit({ value: 5n }),
};

async function send(route, script, headAfter) {
  // cacheTimeout -1: every read reaches the scripted node, so a test is one pass.
  const provider = new ethers.BrowserProvider(nodeFor(script(), headAfter), 1, { pollingInterval: 20, cacheTimeout: -1 });
  providers.push(provider);
  return ROUTES[route](await provider.getSigner());
}

const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

describe("what ethers' own wait() does (the contract the helper is written to)", () => {
  it("throws CALL_EXCEPTION, carrying the receipt, for a reverted transaction", async () => {
    for (const route of Object.keys(ROUTES)) {
      const { error } = await settled((await send(route, mined("0x0"))).wait());
      expect(error?.code, route).toBe("CALL_EXCEPTION");
      expect(error.receipt.status, route).toBe(0);
    }
  });

  it("throws the RPC error when the first receipt read fails", async () => {
    for (const route of Object.keys(ROUTES)) {
      const { error } = await settled((await send(route, unreadable)).wait());
      expect(error, route).toBeInstanceOf(Error);
      expect(error.code, route).not.toBe("CALL_EXCEPTION");
      expect(error.code, route).not.toBe("TRANSACTION_REPLACED");
    }
  });

  it.each([
    ["a speed-up", SPEED_UP, "repriced", false],
    ["a wallet cancel", WALLET_CANCEL, "cancelled", true],
    ["a different call at that nonce", OTHER_CALL, "replaced", true],
  ])("signer.sendTransaction: %s throws TRANSACTION_REPLACED", async (_label, replacement, reason, cancelled) => {
    const { error } = await settled((await send("signer.sendTransaction", replacedBy(replacement))).wait());
    expect(error?.code).toBe("TRANSACTION_REPLACED");
    expect(error.reason).toBe(reason);
    expect(error.cancelled).toBe(cancelled);
    expect(error.hash).toBe(TOOK);
    expect(error.receipt.status).toBe(1);
  });

  it("signer.sendTransaction: a speed-up that REVERTED is still TRANSACTION_REPLACED, with a status 0 receipt", async () => {
    const { error } = await settled((await send("signer.sendTransaction", replacedBy(SPEED_UP, "0x0"))).wait());
    expect(error?.code).toBe("TRANSACTION_REPLACED");
    expect(error.reason).toBe("repriced");
    expect(error.receipt.status).toBe(0);
  });

  it("a contract method: a replaced transaction's wait() never looks for the replacement", async () => {
    // Only ethers' own timeout ends it. With no timeout, as every site calls it,
    // the promise never settles. If this starts throwing TRANSACTION_REPLACED,
    // ethers has fixed it and the helper's re-arm can go.
    const tx = await send("a contract method", replacedBy(SPEED_UP));
    const { error } = await settled(tx.wait(1, 250));
    expect(error?.code).toBe("TIMEOUT");
  });
});

describe.each(Object.keys(ROUTES))("waitForTxOutcome, sent by %s", (route) => {
  it("a mined success is a success under its own hash", async () => {
    const outcome = await waitForTxOutcome(await send(route, mined("0x1")));
    expect(outcome).toMatchObject({ kind: "success", hash: SENT, sentHash: SENT });
    expect(outcome.receipt.status).toBe(1);
  });

  it("a revert is a revert", async () => {
    const outcome = await waitForTxOutcome(await send(route, mined("0x0")));
    expect(outcome).toMatchObject({ kind: "reverted", hash: SENT, sentHash: SENT });
  });

  it("a receipt that cannot be read is unreadable, never a revert", async () => {
    const outcome = await waitForTxOutcome(await send(route, unreadable));
    expect(outcome).toMatchObject({ kind: "unreadable", hash: SENT, sentHash: SENT });
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it("a speed-up is a success under the hash that mined", async () => {
    const outcome = await waitForTxOutcome(await send(route, replacedBy(SPEED_UP)));
    expect(outcome).toMatchObject({ kind: "success", hash: TOOK, sentHash: SENT });
  });

  it("a speed-up that reverted is a revert, not a success", async () => {
    const outcome = await waitForTxOutcome(await send(route, replacedBy(SPEED_UP, "0x0")));
    expect(outcome).toMatchObject({ kind: "reverted", hash: TOOK, sentHash: SENT });
  });

  it("a wallet cancel did not happen, though its receipt says success", async () => {
    const outcome = await waitForTxOutcome(await send(route, replacedBy(WALLET_CANCEL)));
    expect(outcome).toMatchObject({ kind: "replaced", reason: "cancelled", hash: TOOK, sentHash: SENT });
  });

  it("a different call at that nonce did not happen as sent", async () => {
    const outcome = await waitForTxOutcome(await send(route, replacedBy(OTHER_CALL)));
    expect(outcome).toMatchObject({ kind: "replaced", reason: "replaced", hash: TOOK, sentHash: SENT });
  });
});

describe("the re-arm looks back", () => {
  it("finds a replacement that mined two blocks before the wait began", async () => {
    // The helper is called after the send resolves, which can be blocks after the
    // wallet broadcast. A scan that started at the head would never see block 0x65.
    const tx = await send("a contract method", replacedBy(SPEED_UP), "0x67");
    expect(await waitForTxOutcome(tx)).toMatchObject({ kind: "success", hash: TOOK, sentHash: SENT });
  });
});
