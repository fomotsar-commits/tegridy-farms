// The shield's read layer on Gondi's v3.2 loan contract.
//
// The pure core (health.ts, positions.ts) is tested on its own; what this file
// pins is the wiring, where the collapse actually happens. Ways this hook can end
// up with no rows, and only ONE of them means the wallet has no debt:
//
//   Gondi not deployed        nothing can be read (the venue gate)
//   no wallet                 nothing was asked
//   loan discovery failed     useMyLoans could not read
//   a record did not check    useMyLoans read a SHORT list
//   the wallet genuinely has none
//
// A hook that returned `[]` for all of them would make an outage indistinguishable
// from safety on the one surface where that difference is the product.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Address } from 'viem';
import { owedAt, type Loan } from '../lib/gondi/loanMath';

const GONDI = '0x5555555555555555555555555555555555555555' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const wallet = vi.hoisted(() => ({ address: '0x1111111111111111111111111111111111111111' as string | undefined }));
const gondi = vi.hoisted(() => ({ address: '0x5555555555555555555555555555555555555555' }));
const loanState = vi.hoisted(() => ({
  loans: [] as unknown[],
  isLoading: false,
  isError: false,
  loansUnread: false,
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: wallet.address }) }));
vi.mock('./useMyLoans', () => ({ useMyLoans: () => loanState }));
// The REAL venue gate runs (lib/shield/venues.ts): it opens on a deployed Gondi address.
// The address is zero until the deploy, so a stand-in is set here, and one describe puts
// the zero back.
vi.mock('../lib/gondi/loanOffer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get GONDI_LOAN_ADDRESS() {
      return gondi.address;
    },
  };
});

import { useShieldPositions } from './useShieldPositions';

const NOW = 1_800_000_000;
const ME = '0x1111111111111111111111111111111111111111' as Address;

function gondiLoan(over: Partial<Loan> = {}): Loan {
  const startTime = over.startTime ?? BigInt(NOW - 86_400);
  return {
    borrower: ME,
    nftCollateralTokenId: 7n,
    nftCollateralAddress: '0x4444444444444444444444444444444444444444',
    principalAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    principalAmount: 1_000_000_000_000_000_000n,
    startTime,
    duration: 3n * 86_400n,
    tranche: [{
      loanId: 4n,
      floor: 0n,
      principalAmount: 1_000_000_000_000_000_000n,
      lender: '0x2222222222222222222222222222222222222222',
      accruedInterest: 0n,
      startTime,
      aprBps: 1000n,
    }],
    protocolFee: 500n,
    lenderRefinanceDisabled: false,
    ...over,
  };
}

/** A useMyLoans row, as that hook builds it from a hash-checked loan. */
function row(loan: Loan, over: Record<string, unknown> = {}) {
  return {
    id: 4,
    role: 'borrower',
    borrower: loan.borrower,
    lender: loan.tranche[0]!.lender,
    tokenId: loan.nftCollateralTokenId,
    collateralContract: loan.nftCollateralAddress,
    principal: loan.principalAmount,
    aprBps: 1000n,
    startTime: loan.startTime,
    deadline: loan.startTime + loan.duration,
    loan,
    repaid: false,
    defaultClaimed: false,
    status: 'active',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW * 1000);
  wallet.address = ME;
  gondi.address = GONDI;
  loanState.loans = [];
  loanState.isLoading = false;
  loanState.isError = false;
  loanState.loansUnread = false;
});
afterEach(() => vi.useRealTimers());

describe('a Gondi borrower’s loans are watched, with the chain’s own deadline', () => {
  it('lists the loan with deadline = startTime + duration, on Gondi’s contract, owing what owedAt says', () => {
    const loan = gondiLoan();
    loanState.loans = [row(loan)];
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('ready');
    const [p] = result.current.positions;
    expect(p!.loanId).toBe(4);
    expect(p!.lendingContract).toBe(GONDI);
    expect(p!.health.deadlineUnix).toBe(NOW - 86_400 + 3 * 86_400);
    expect(p!.health.band).toBe('watch');
    expect(p!.owedNowWei).toBe(owedAt(loan, BigInt(NOW)).total);
    expect(p!.loan).toBe(loan);
  });

  it('flips to "repayment window closed" when the deadline passes, without a reload', () => {
    // 30 s to the deadline. Gondi refuses repayment from the deadline second on.
    loanState.loans = [row(gondiLoan({ startTime: BigInt(NOW - 86_400 + 30), duration: 86_400n }))];
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.positions[0]!.health.band).toBe('urgent');
    expect(result.current.positions[0]!.health.repayable).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.positions[0]!.health.band).toBe('defaulted');
    expect(result.current.positions[0]!.health.repayable).toBe(false);
  });

  it('ignores loans where this wallet is the lender', () => {
    // A lender whose borrower defaults RECEIVES the collateral. Listing that as
    // something a shield protects would invent a risk.
    loanState.loans = [row(gondiLoan(), { role: 'lender' })];
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('ready');
    expect(result.current.positions).toEqual([]);
  });

  it('reports ready with no positions when the wallet genuinely has no borrow', () => {
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('ready');
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toBeNull();
  });
});

describe('nothing-was-asked is not nothing-at-risk', () => {
  it('with no wallet, reports idle and says nothing is being watched', () => {
    wallet.address = undefined;
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('idle');
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toMatch(/nothing is watched until then/i);
  });

  it('before Gondi’s contract is deployed, reports idle and says why, even for a listed loan', () => {
    gondi.address = ZERO;
    loanState.loans = [row(gondiLoan())];
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('idle');
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toMatch(/not deployed/i);
  });
});

describe('a failed read is reported as a failed read', () => {
  it('surfaces useMyLoans’ own read failure as unreadable', () => {
    loanState.isError = true;
    loanState.loans = [row(gondiLoan())];
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('unreadable');
    expect(result.current.detail).toMatch(/failed read, not an absence of debt/i);
    expect(result.current.positions).toEqual([]);
  });

  it('refuses a PARTIAL read rather than watching a book with holes in it', () => {
    // A loan record whose hash did not check out on chain: the list is real and SHORT,
    // and a shorter list on this surface reads as LESS risk.
    loanState.loans = [row(gondiLoan())];
    loanState.loansUnread = true;
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('unreadable');
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toMatch(/missing positions/i);
  });

  it('reports loading while useMyLoans is still reading', () => {
    loanState.isLoading = true;
    const { result } = renderHook(() => useShieldPositions());
    expect(result.current.status).toBe('loading');
    expect(result.current.positions).toEqual([]);
  });
});
