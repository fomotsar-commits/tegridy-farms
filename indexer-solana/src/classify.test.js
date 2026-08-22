import { describe, it, expect } from "vitest";
import { classifyTransaction, tokenMoves, feePayerOf } from "./classify.js";

const POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE = "So11111111111111111111111111111111111111112";
const VAULT_AUTH = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"; // owner of the pool's vaults
const FEE_RECEIVER = "GXjJKuvpBTHzsF1XwLbvcPP8bJ3vqPBpwEjMHZBRHFqW"; // the Squads vault
const PAYER = "8DkRR6cyCLYNbTNBBqCVLxU7c5PCsCvJHvKvNMArzq4h";
const OTHER_POOL_AUTH = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";

const watch = (over = {}) => ({
  pool: POOL,
  baseMint: BASE,
  quoteMint: QUOTE,
  feeReceiver: null,
  ...over,
});

const bal = (accountIndex, mint, owner, amount) => ({
  accountIndex,
  mint,
  owner,
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  uiTokenAmount: { amount: String(amount), decimals: 6, uiAmountString: "0" },
});

const tx = ({ err = null, payer = PAYER, pre = [], post = [], slot = 100, blockTime = 1_700_000 } = {}) => ({
  slot,
  blockTime,
  transaction: { message: { accountKeys: [{ pubkey: payer, signer: true, writable: true }] } },
  meta: { err, preTokenBalances: pre, postTokenBalances: post },
});

describe("feePayerOf", () => {
  it("reads the first account key under both jsonParsed and legacy shapes", () => {
    expect(feePayerOf(tx())).toBe(PAYER);
    expect(feePayerOf({ transaction: { message: { accountKeys: [PAYER] } } })).toBe(PAYER);
    expect(feePayerOf({ transaction: { message: { accountKeys: [] } } })).toBeNull();
  });
});

describe("tokenMoves", () => {
  it("treats an account absent from one side as zero on that side", () => {
    const moved = tokenMoves(
      { preTokenBalances: [], postTokenBalances: [bal(3, BASE, PAYER, 500)] },
      [BASE, QUOTE],
    );
    expect(moved.ok).toBe(true);
    expect(moved.moves).toEqual([{ index: 3, mint: BASE, owner: PAYER, delta: 500n }]);
  });

  it("ignores mints the watch does not track", () => {
    const moved = tokenMoves(
      { preTokenBalances: [], postTokenBalances: [bal(3, VAULT_AUTH, PAYER, 500)] },
      [BASE, QUOTE],
    );
    expect(moved.moves).toEqual([]);
  });

  it("refuses balances with no owner, which is what a base64 fetch produces", () => {
    const entry = bal(3, BASE, PAYER, 500);
    delete entry.owner;
    const moved = tokenMoves({ preTokenBalances: [], postTokenBalances: [entry] }, [BASE]);
    expect(moved.ok).toBe(false);
    expect(moved.reason).toContain("jsonParsed");
  });
});

describe("classifyTransaction — trades", () => {
  // The pool's vaults are persistent accounts, so they always appear on both
  // sides. The buyer's wrapped-SOL account is created and closed inside the
  // same transaction and appears on NEITHER — which is exactly why the amounts
  // are taken from the pool's side.
  it("reads a buy from the pool's vaults when the wrapped-SOL leg is invisible", () => {
    const t = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000)],
      post: [
        bal(4, BASE, VAULT_AUTH, 900_000),
        bal(5, QUOTE, VAULT_AUTH, 600_000),
        bal(6, BASE, PAYER, 100_000),
      ],
    });
    const v = classifyTransaction(watch(), t);
    expect(v.status).toBe("ok");
    expect(v.trade).toEqual({
      payer: PAYER,
      direction: "buy",
      baseAmount: 100_000n,
      quoteAmount: 100_000n,
    });
  });

  it("reads a sell", () => {
    const t = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 900_000), bal(5, QUOTE, VAULT_AUTH, 600_000), bal(6, BASE, PAYER, 100_000)],
      post: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000), bal(6, BASE, PAYER, 0)],
    });
    const v = classifyTransaction(watch(), t);
    expect(v.status).toBe("ok");
    expect(v.trade).toMatchObject({ direction: "sell", baseAmount: 100_000n, quoteAmount: 100_000n });
  });

  it("never emits a trade with a zero amount", () => {
    const t = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000)],
      post: [bal(4, BASE, VAULT_AUTH, 900_000), bal(5, QUOTE, VAULT_AUTH, 500_000)],
    });
    const v = classifyTransaction(watch(), t);
    expect(v.trade).toBeNull();
    expect(v.status).toBe("undecodable");
  });
});

describe("classifyTransaction — refusals", () => {
  it("marks a reverted transaction as failed, not as a gap", () => {
    const v = classifyTransaction(watch(), tx({ err: { InstructionError: [0, "Custom"] } }));
    expect(v.status).toBe("failed");
    expect(v.trade).toBeNull();
  });

  it("skips a transaction that touched the pool without moving its mints", () => {
    const v = classifyTransaction(watch(), tx());
    expect(v.status).toBe("skipped");
  });

  // A routed swap hops through several pools in one transaction. Which of the
  // several base-mint deltas belongs to THIS pool is not decidable from
  // balances, and picking the largest would write a confident wrong number.
  it("refuses a routed transaction rather than attributing one of several deltas", () => {
    const t = tx({
      pre: [
        bal(4, BASE, VAULT_AUTH, 1_000_000),
        bal(5, QUOTE, VAULT_AUTH, 500_000),
        bal(7, BASE, OTHER_POOL_AUTH, 2_000_000),
      ],
      post: [
        bal(4, BASE, VAULT_AUTH, 900_000),
        bal(5, QUOTE, VAULT_AUTH, 600_000),
        bal(7, BASE, OTHER_POOL_AUTH, 2_100_000),
      ],
    });
    const v = classifyTransaction(watch(), t);
    expect(v.status).toBe("undecodable");
    expect(v.reason).toContain("more than one counterparty account");
  });

  it("refuses when both legs moved the same way", () => {
    const t = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000)],
      post: [bal(4, BASE, VAULT_AUTH, 1_100_000), bal(5, QUOTE, VAULT_AUTH, 600_000)],
    });
    expect(classifyTransaction(watch(), t).status).toBe("undecodable");
  });

  it("refuses when the fee payer moved the base mint the same way the pool did", () => {
    const t = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000), bal(6, BASE, PAYER, 0)],
      post: [
        bal(4, BASE, VAULT_AUTH, 900_000),
        bal(5, QUOTE, VAULT_AUTH, 600_000),
        bal(6, BASE, PAYER, 0),
      ],
      // payer's base account exists but does not move → not the counterparty
    });
    // Same-direction case: payer LOSES base while the pool also loses base.
    const t2 = tx({
      pre: [bal(4, BASE, VAULT_AUTH, 1_000_000), bal(5, QUOTE, VAULT_AUTH, 500_000), bal(6, BASE, PAYER, 50_000)],
      post: [
        bal(4, BASE, VAULT_AUTH, 900_000),
        bal(5, QUOTE, VAULT_AUTH, 600_000),
        bal(6, BASE, PAYER, 10_000),
      ],
    });
    expect(classifyTransaction(watch(), t).status).toBe("ok");
    const v2 = classifyTransaction(watch(), t2);
    expect(v2.status).toBe("undecodable");
    expect(v2.reason).toContain("same direction");
  });

  // HONESTY GUARD: transactions predating token-balance metadata, or fetched
  // with an encoding that omits it, must not read as transactions that moved
  // nothing.
  it("refuses a transaction with no pre/post token balances instead of calling it empty", () => {
    const t = { slot: 1, meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: PAYER }] } } };
    const v = classifyTransaction(watch(), t);
    expect(v.status).toBe("undecodable");
    expect(v.reason).toContain("token balances");
  });
});

describe("classifyTransaction — partner-fee claims", () => {
  it("records a claim when the configured receiver gains and the pool drains", () => {
    const t = tx({
      pre: [bal(5, QUOTE, VAULT_AUTH, 600_000), bal(9, QUOTE, FEE_RECEIVER, 0)],
      post: [bal(5, QUOTE, VAULT_AUTH, 100_000), bal(9, QUOTE, FEE_RECEIVER, 500_000)],
    });
    const v = classifyTransaction(watch({ feeReceiver: FEE_RECEIVER }), t);
    expect(v.status).toBe("ok");
    expect(v.trade).toBeNull();
    expect(v.claims).toEqual([{ receiver: FEE_RECEIVER, mint: QUOTE, amount: 500_000n }]);
  });

  // Without a configured receiver there is nothing to recognise a claim BY.
  // The right answer is "we cannot tell", which becomes a gap row upstream —
  // never a claim of zero fees.
  it("cannot see a claim at all when no fee receiver is configured", () => {
    const t = tx({
      pre: [bal(5, QUOTE, VAULT_AUTH, 600_000), bal(9, QUOTE, FEE_RECEIVER, 0)],
      post: [bal(5, QUOTE, VAULT_AUTH, 100_000), bal(9, QUOTE, FEE_RECEIVER, 500_000)],
    });
    const v = classifyTransaction(watch(), t);
    expect(v.claims).toEqual([]);
    expect(v.status).toBe("undecodable");
  });

  it("does not treat the receiver's own account as the pool's counterparty side", () => {
    const t = tx({
      pre: [bal(5, QUOTE, VAULT_AUTH, 600_000), bal(9, QUOTE, FEE_RECEIVER, 0)],
      post: [bal(5, QUOTE, VAULT_AUTH, 100_000), bal(9, QUOTE, FEE_RECEIVER, 500_000)],
    });
    const v = classifyTransaction(watch({ feeReceiver: FEE_RECEIVER }), t);
    expect(v.claims).toHaveLength(1);
    expect(v.trade).toBeNull();
  });
});
