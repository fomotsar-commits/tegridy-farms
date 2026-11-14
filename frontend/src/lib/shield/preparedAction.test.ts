// The transaction the user signs, and the ways it refuses to be built.
//
// This is a money path: the encoded call moves the user's WETH and decides whether
// their NFT comes home. Gondi repays in WETH pulled by the loan contract, so the
// prepared action is whichever of three steps comes next (wrap, approve, repay),
// each built from the same pieces My Loans sends (lib/gondi/repay.ts). Pinned
// hardest: the executor is structurally the user, a repayment is never built past
// the deadline (Gondi's `repayLoan` reverts with LoanExpiredError there), and no
// step is chosen from a WETH balance nobody read.

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { ERC20_ABI } from '../contracts';
import { GONDI_LOAN_ABI } from '../gondi/abi.js';
import { WETH_ADDRESS } from '../gondi/loanOffer.js';
import { owedAt, type Loan } from '../gondi/loanMath';
import { REPAY_PAD_SECONDS, repayLoanArgs } from '../gondi/repay';
import { prepareRepay, type PreparedRepayInput } from './preparedAction';
import { assessDeadlineHealth } from './health';

const NOW = 1_700_000_000;
const BORROWER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x9999999999999999999999999999999999999999' as Address;
const LENDER = '0x3333333333333333333333333333333333333333' as Address;
const LENDING = '0x2222222222222222222222222222222222222222' as Address;
const ONE = 1_000_000_000_000_000_000n;

const startTime = BigInt(NOW - 86_400);
const LOAN: Loan = {
  borrower: BORROWER,
  nftCollateralTokenId: 7n,
  nftCollateralAddress: '0x4444444444444444444444444444444444444444',
  principalAddress: WETH_ADDRESS,
  principalAmount: ONE,
  startTime,
  duration: BigInt(86_400 + 7200),
  tranche: [{ loanId: 4n, floor: 0n, principalAmount: ONE, lender: LENDER, accruedInterest: 0n, startTime, aprBps: 1000n }],
  protocolFee: 500n,
  lenderRefinanceDisabled: false,
};

/** What the wallet must hold and approve: owed ten minutes from now. */
const NEEDED = owedAt(LOAN, BigInt(NOW) + 600n).total;

const HEALTHY = assessDeadlineHealth({ deadlineUnix: NOW + 7200, nowUnix: NOW });

function input(over: Partial<PreparedRepayInput> = {}): PreparedRepayInput {
  return {
    loanId: 4,
    loan: LOAN,
    lendingContract: LENDING,
    chainId: 1,
    expectedChainId: 1,
    account: BORROWER,
    health: HEALTHY,
    nowUnix: NOW,
    // Enough WETH, enough approval: the next step is the repayment itself.
    wethBalance: 2n * ONE,
    wethAllowance: 2n * ONE,
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
  it.each([
    ['wrap', { wethBalance: 0n }],
    ['approve', { wethAllowance: 0n }],
    ['repay', {}],
  ] as const)('marks the %s step as sent by the user', (_kind, over) => {
    expect(ok(over).executor).toBe('user');
  });

  it('carries no field that could route the transaction anywhere but a wallet', () => {
    const keys = Object.keys(ok());
    for (const forbidden of ['keeper', 'relayer', 'endpoint', 'submitUrl', 'signer', 'sessionKey']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('says in every disclosure that you repay it yourself', () => {
    for (const over of [{ wethBalance: 0n }, { wethAllowance: 0n }, {}]) {
      expect(ok(over).disclosure).toMatch(/you repay it yourself/i);
    }
  });
});

describe('the three steps are exactly what My Loans sends', () => {
  it('holds and approves what is owed ten minutes from now', () => {
    expect(REPAY_PAD_SECONDS).toBe(600n);
    expect(ok().neededWei).toBe(NEEDED);
    // Interest accrues, so the padded amount is above what is owed this second.
    expect(NEEDED).toBeGreaterThan(owedAt(LOAN, BigInt(NOW)).total);
  });

  it('wraps exactly the WETH the wallet is short, as ETH sent to WETH deposit()', () => {
    const held = NEEDED / 4n;
    const a = ok({ wethBalance: held, wethAllowance: 0n });
    expect(a.kind).toBe('wrap');
    expect(a.to).toBe(WETH_ADDRESS);
    expect(a.value).toBe(NEEDED - held);
    const decoded = decodeFunctionData({
      abi: [{ type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }] as const,
      data: a.data,
    });
    expect(decoded.functionName).toBe('deposit');
  });

  it('approves the loan contract for the padded amount once the WETH is there', () => {
    // An allowance under what is owed 2 minutes on (repayCovered): the approval is for the padded amount.
    const a = ok({ wethBalance: NEEDED, wethAllowance: 0n });
    expect(a.kind).toBe('approve');
    expect(a.to).toBe(WETH_ADDRESS);
    expect(a.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: a.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([LENDING, NEEDED]);
  });

  it('repays with the whole loan, sending no ETH, once WETH and approval are both there', () => {
    const a = ok({ wethBalance: NEEDED, wethAllowance: NEEDED });
    expect(a.kind).toBe('repay');
    expect(a.to).toBe(LENDING);
    expect(a.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: GONDI_LOAN_ABI, data: a.data });
    expect(decoded.functionName).toBe('repayLoan');
    expect(decoded.args).toEqual(repayLoanArgs(4n, LOAN));
    expect(a.summary).toBe(`repayLoan(4) on ${LENDING}`);
  });

  it('tells the user a wrap or approval repays nothing yet', () => {
    expect(ok({ wethBalance: 0n }).disclosure).toMatch(/nothing is repaid yet/i);
    expect(ok({ wethAllowance: 0n }).disclosure).toMatch(/nothing is repaid yet/i);
  });
});

describe('it refuses rather than encoding a transaction it knows is dead', () => {
  it('refuses at the deadline second: Gondi refuses repayment from there on', () => {
    const reason = refusal({ health: assessDeadlineHealth({ deadlineUnix: NOW, nowUnix: NOW }) });
    expect(reason).toMatch(/deadline has passed/i);
    expect(reason).toMatch(/refuses repayment/i);
  });

  it('refuses past the deadline, before looking at WETH', () => {
    const reason = refusal({
      health: assessDeadlineHealth({ deadlineUnix: NOW - 600, nowUnix: NOW }),
      wethBalance: null,
      wethAllowance: null,
    });
    expect(reason).toMatch(/deadline has passed/i);
  });

  it('still prepares one second before the deadline', () => {
    expect(ok({ health: assessDeadlineHealth({ deadlineUnix: NOW + 1, nowUnix: NOW }) }).kind).toBe('repay');
  });

  it('refuses when the WETH balance was not read', () => {
    expect(refusal({ wethBalance: null })).toMatch(/could not be read/i);
  });

  it('refuses when the WETH approval was not read', () => {
    expect(refusal({ wethAllowance: null })).toMatch(/could not be read/i);
  });

  it('refuses without a lending contract', () => {
    expect(refusal({ lendingContract: null })).toMatch(/no lending contract/i);
  });

  it('refuses without a connected wallet', () => {
    expect(refusal({ account: null })).toMatch(/connect the borrowing wallet/i);
  });

  it('refuses on the wrong chain', () => {
    expect(refusal({ chainId: 8453 })).toMatch(/switch to ethereum mainnet/i);
  });

  it('refuses for a wallet that is not the borrower', () => {
    expect(refusal({ account: OTHER })).toMatch(/only the borrower/i);
  });

  it('checks identity before WETH, so a stranger is told why rather than asked to wrap', () => {
    expect(refusal({ account: OTHER, wethBalance: null })).toMatch(/only the borrower/i);
  });
});
