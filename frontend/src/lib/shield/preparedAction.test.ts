// The transaction the user signs, and the ten ways it refuses to be built.
//
// This is a money path: the encoded call moves the user's ETH and decides whether
// their NFT comes home. The two properties pinned hardest are that the executor
// is structurally the user, and that a repayment is never encoded against numbers
// nobody read — a transaction built from a missing quote reverts on
// `InsufficientRepayment` and costs gas for nothing, with the venue's name on it.

import { describe, it, expect } from 'vitest';
import { decodeFunctionData } from 'viem';
import { TEGRIDY_NFT_LENDING_ABI } from '../contracts';
import { REPAY_BUFFER_BPS, prepareRepay, type PreparedRepayInput } from './preparedAction';
import { assessDeadlineHealth } from './health';

const NOW = 1_700_000_000;
const BORROWER = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x9999999999999999999999999999999999999999' as const;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const ONE_ETH = 1_000_000_000_000_000_000n;

const HEALTHY = assessDeadlineHealth({
  effectiveDeadlineUnix: NOW + 7200,
  minGraceSeconds: 3600,
  defaultedOnChain: false,
  nowUnix: NOW,
});

function input(over: Partial<PreparedRepayInput> = {}): PreparedRepayInput {
  return {
    loanId: 4,
    lendingContract: LENDING,
    chainId: 1,
    expectedChainId: 1,
    account: BORROWER,
    borrower: BORROWER,
    repaid: false,
    defaultClaimed: false,
    quotedRepayWei: ONE_ETH,
    health: HEALTHY,
    ...over,
  };
}

function ok(over: Partial<PreparedRepayInput> = {}) {
  const r = prepareRepay(input(over));
  if (!r.ok) throw new Error(`expected a prepared action, got refusal: ${r.reason}`);
  return r.action;
}

function refusal(over: Partial<PreparedRepayInput>) {
  const r = prepareRepay(input(over));
  if (r.ok) throw new Error('expected a refusal, got a prepared action');
  return r.reason;
}

describe('the user is the executor, structurally', () => {
  it('marks the action as sent by the user', () => {
    expect(ok().executor).toBe('user');
  });

  it('carries no field that could route the transaction anywhere but a wallet', () => {
    const action = ok();
    const keys = Object.keys(action);
    for (const forbidden of ['keeper', 'relayer', 'endpoint', 'submitUrl', 'signer', 'sessionKey']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('says in the disclosure that the wallet sends it', () => {
    expect(ok().disclosure).toMatch(/sends the repayment from your wallet/i);
    expect(ok().disclosure).toMatch(/you execute this yourself/i);
  });
});

describe('the encoded call is exactly the repayment for this loan', () => {
  it('encodes repayLoan with the loan id', () => {
    const action = ok({ loanId: 17 });
    const decoded = decodeFunctionData({ abi: TEGRIDY_NFT_LENDING_ABI, data: action.data });
    expect(decoded.functionName).toBe('repayLoan');
    expect(decoded.args).toEqual([17n]);
  });

  it('targets the lending contract it was given', () => {
    expect(ok().to).toBe(LENDING);
  });

  it('sends the quote plus the disclosed buffer, and the parts add up', () => {
    const action = ok();
    expect(action.quotedRepayWei).toBe(ONE_ETH);
    expect(action.bufferWei).toBe((ONE_ETH * REPAY_BUFFER_BPS) / 10_000n);
    expect(action.value).toBe(action.quotedRepayWei + action.bufferWei);
  });

  it('never sends less than the quote — underpaying reverts, overpaying is refunded', () => {
    for (const quote of [1n, 7n, 999n, ONE_ETH, ONE_ETH * 12345n]) {
      const action = ok({ quotedRepayWei: quote });
      expect(action.value).toBeGreaterThan(quote);
      expect(action.bufferWei).toBeGreaterThan(0n);
    }
  });

  it('explains the buffer and that the contract refunds the remainder', () => {
    expect(ok().disclosure).toMatch(/refunds whatever is not owed/i);
  });
});

describe('it refuses rather than encoding a transaction it knows is dead', () => {
  it('refuses without a lending contract', () => {
    expect(refusal({ lendingContract: null })).toMatch(/no lending contract is configured/i);
  });

  it('refuses without a connected wallet', () => {
    expect(refusal({ account: null })).toMatch(/connect the borrowing wallet/i);
  });

  it('refuses on the wrong chain', () => {
    expect(refusal({ chainId: 8453 })).toMatch(/switch to ethereum mainnet/i);
  });

  it('refuses for a wallet that is not the borrower', () => {
    expect(refusal({ account: OTHER })).toMatch(/only the borrower can repay/i);
  });

  it('refuses an already-repaid loan', () => {
    expect(refusal({ repaid: true })).toMatch(/already repaid/i);
  });

  it('refuses once the lender has claimed the collateral, and says repaying will not get it back', () => {
    expect(refusal({ defaultClaimed: true })).toMatch(/would not return it/i);
  });

  it('refuses when the repayment quote could not be read, naming the reason', () => {
    expect(refusal({ quotedRepayWei: null })).toMatch(/could not be read/i);
    expect(refusal({ quotedRepayWei: null })).toMatch(/underpay and revert/i);
  });

  it('refuses a zero quote — a zero-value repay is a read that failed, not a free loan', () => {
    expect(refusal({ quotedRepayWei: 0n })).toMatch(/could not be read/i);
  });

  it('refuses when health is unreadable, and repeats the read failure', () => {
    const reason = refusal({
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: null,
        minGraceSeconds: null,
        defaultedOnChain: null,
        nowUnix: NOW,
      }),
    });
    expect(reason).toMatch(/deadline and default status could not be read/i);
    expect(reason).toMatch(/no repayment is prepared against a deadline nobody read/i);
  });

  it('refuses once the contract reports the loan defaulted, and says so as a read', () => {
    const reason = refusal({
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: NOW - 100_000,
        minGraceSeconds: 3600,
        defaultedOnChain: true,
        nowUnix: NOW,
      }),
    });
    expect(reason).toMatch(/repayment window has closed/i);
    expect(reason).toMatch(/the lending contract reports this loan as defaulted/i);
  });

  // The refusal above is the most dangerous sentence this module can produce: it
  // tells a borrower to stop trying. It may only follow the contract's own
  // verdict. Past the GRACE_PERIOD constant with `isDefaulted` still false, the
  // contract extended the grace for its own pause time and `repayLoan` succeeds —
  // so the transaction gets built.
  it('still builds the repayment past the minimum grace while the contract reports no default', () => {
    const action = ok({
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: NOW - 100_000,
        minGraceSeconds: 3600,
        defaultedOnChain: false,
        nowUnix: NOW,
      }),
    });
    expect(action.kind).toBe('repay');
    expect(action.value).toBeGreaterThan(action.quotedRepayWei);
  });

  it('still prepares inside the grace period — the contract does accept it there', () => {
    const action = ok({
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: NOW - 600,
        minGraceSeconds: 3600,
        defaultedOnChain: false,
        nowUnix: NOW,
      }),
    });
    expect(action.kind).toBe('repay');
  });

  it('checks identity before the quote, so a stranger is told why rather than shown a number', () => {
    expect(refusal({ account: OTHER, quotedRepayWei: null })).toMatch(/only the borrower can repay/i);
  });
});
