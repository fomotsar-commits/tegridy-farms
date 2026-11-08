// useMyLoans on Gondi's loan contract: the book lists the loans, the chain's getLoanHash
// decides which are real and open. A loan is shown only when its hash matches; a zero hash
// (closed on chain) is left out; a mismatch or a failed read is COUNTED as unread, never
// shown and never dropped silently, because a short list on the dashboard reads as fewer loans.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Address } from 'viem';
import { loanHash, loanFromJson, type LoanJson } from '../lib/gondi/loanMath';
import type { BookLoan } from '../lib/gondi/offerBook';

const ME = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const NAKAMIGOS = '0xd774557b647330C91Bf44cfEAB205095f7E6c367' as Address;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

let account: Address | undefined = ME;
let book: { data?: { loans: BookLoan[] }; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
let hashes: { data?: { status: 'success' | 'failure'; result?: unknown }[]; isError: boolean } = { isError: false };
const readArgs: unknown[] = [];

vi.mock('../lib/gondi/loanOffer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GONDI_LOAN_ADDRESS: '0x5555555555555555555555555555555555555555',
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: account }),
  useReadContracts: (args: unknown) => {
    readArgs.push(args);
    return hashes;
  },
}));
vi.mock('../lib/gondi/offerBook', () => ({ useBookLoans: () => book }));

const { useMyLoans } = await import('./useMyLoans');

const now = Math.floor(Date.now() / 1000);

function loanJson(over: Partial<{ borrower: Address; lender: Address; principal: string; start: number; duration: number }> = {}): LoanJson {
  return {
    borrower: over.borrower ?? ME,
    nftCollateralTokenId: '42',
    nftCollateralAddress: NAKAMIGOS,
    principalAddress: WETH,
    principalAmount: over.principal ?? '100000000000000000',
    startTime: String(over.start ?? now - 3600),
    duration: String(over.duration ?? 7 * 86400),
    tranche: [{
      loanId: '1', floor: '0', principalAmount: over.principal ?? '100000000000000000',
      lender: over.lender ?? OTHER, accruedInterest: '0', startTime: String(over.start ?? now - 3600), aprBps: '1000',
    }],
    protocolFee: '500',
    lenderRefinanceDisabled: false,
  };
}

function row(loanId: string, loan: LoanJson, status: BookLoan['status'] = 'open'): BookLoan {
  return { loanId, loan, status, emitTx: `0x${'a'.repeat(64)}`, closeTx: null };
}

const hashOf = (j: LoanJson) => loanHash(loanFromJson(j));

beforeEach(() => {
  account = ME;
  book = { isLoading: false, isError: false };
  hashes = { isError: false };
  readArgs.length = 0;
});

describe('useMyLoans (Gondi)', () => {
  it('lists a loan whose chain hash matches, as the borrower, and pins the read to mainnet', () => {
    const j = loanJson();
    book = { data: { loans: [row('7', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: hashOf(j) }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans).toHaveLength(1);
    const l = result.current.loans[0]!;
    expect(l).toMatchObject({ id: 7, role: 'borrower', principal: 10n ** 17n, aprBps: 1000n, status: 'active' });
    expect(l.deadline).toBe(BigInt(now - 3600 + 7 * 86400));
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.loansUnread).toBe(false);
    const contracts = (readArgs.at(-1) as { contracts: { functionName: string; args: bigint[]; chainId: number }[] }).contracts;
    expect(contracts[0]).toMatchObject({ functionName: 'getLoanHash', args: [7n], chainId: 1 });
  });

  it('shows the lender side with only this wallet’s tranche as its principal', () => {
    const j = loanJson({ borrower: OTHER, lender: ME, principal: '250000000000000000' });
    book = { data: { loans: [row('3', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: hashOf(j) }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans[0]).toMatchObject({ role: 'lender', principal: 25n * 10n ** 16n });
  });

  it('marks a loan overdue from the second it is due (Gondi has no grace period)', () => {
    const j = loanJson({ start: now - 86400, duration: 86400 });
    book = { data: { loans: [row('1', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: hashOf(j) }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans[0]!.status).toBe('overdue');
  });

  it('leaves out a loan the chain has closed (zero hash), without calling it unread', () => {
    const j = loanJson();
    book = { data: { loans: [row('1', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: ZERO_HASH }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans).toHaveLength(0);
    expect(result.current.loansUnread).toBe(false);
  });

  it('counts a hash that does not match the book’s loan as unread, and does not show it', () => {
    const j = loanJson();
    book = { data: { loans: [row('1', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: hashOf(loanJson({ principal: '1' })) }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans).toHaveLength(0);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.loansUnread).toBe(true);
  });

  it('counts a failed hash read as unread next to a good one', () => {
    const a = loanJson();
    const b = loanJson({ principal: '5' });
    book = { data: { loans: [row('1', a), row('2', b)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'success', result: hashOf(a) }, { status: 'failure' }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans.map((l) => l.id)).toEqual([1]);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.isError).toBe(false);
  });

  it('is an error, with the gap unknown, when the offer book does not answer', () => {
    book = { isLoading: false, isError: true };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.isError).toBe(true);
    expect(result.current.unreadCount).toBeNull();
    expect(result.current.loansUnread).toBe(true);
  });

  it('is an error when every hash read failed', () => {
    const j = loanJson();
    book = { data: { loans: [row('1', j)] }, isLoading: false, isError: false };
    hashes = { data: [{ status: 'failure' }], isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.isError).toBe(true);
  });

  it('skips rows the book already has as closed', () => {
    const j = loanJson();
    book = { data: { loans: [row('1', j, 'repaid')] }, isLoading: false, isError: false };
    const { result } = renderHook(() => useMyLoans());
    expect(result.current.loans).toHaveLength(0);
    expect(result.current.loansUnread).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });
});
