// The read layer's failure modes, which are the only interesting thing about it.
//
// The pure core (health.ts, positions.ts) is tested on its own; what this file
// pins is the wiring, where the collapse actually happens. Four ways this hook
// can end up with no rows, and only ONE of them means the wallet has no debt:
//
//   no wallet / wrong chain   nothing was asked
//   loan discovery failed     useMyLoans could not read
//   every deadline read failed an RPC outage
//   the wallet genuinely has none
//
// A hook that returned `[]` for all four would make an outage indistinguishable
// from safety on the one surface where that difference is the product.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const wallet = vi.hoisted(() => ({ address: '0x1111111111111111111111111111111111111111' as string | undefined }));
const chain = vi.hoisted(() => ({ id: 1 }));
const loanState = vi.hoisted(() => ({
  loans: [] as unknown[],
  isLoading: false,
  isError: false,
  // Weaker than isError: the list came back, but discovery lost records, so it
  // is real and SHORT. That is the fourth state in the header above.
  loansUnread: false,
  deployed: true,
}));
const rpc = vi.hoisted(() => {
  const readContract = vi.fn();
  // ONE object, forever. wagmi memoises its client; a mock that minted a new one
  // per render would re-fire the read effect on every state update it caused.
  return { readContract, client: { readContract }, present: true };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: wallet.address }),
  useChainId: () => chain.id,
  usePublicClient: () => (rpc.present ? rpc.client : undefined),
}));
vi.mock('./useMyLoans', () => ({ useMyLoans: () => loanState }));

import { useShieldPositions } from './useShieldPositions';

const NOW = Math.floor(Date.now() / 1000);

function loan(over: Record<string, unknown> = {}) {
  return {
    id: 4,
    source: 'nft',
    role: 'borrower',
    borrower: wallet.address,
    lender: '0x2222222222222222222222222222222222222222',
    offerId: 0n,
    tokenId: 7n,
    collateralContract: '0x4444444444444444444444444444444444444444',
    principal: 1_000_000_000_000_000_000n,
    aprBps: 1000n,
    startTime: BigInt(NOW - 86_400),
    deadline: BigInt(NOW + 86_400),
    repaid: false,
    defaultClaimed: false,
    status: 'active',
    ...over,
  };
}

/** Answers every contract read with the given per-function resolver. */
function respond(map: Record<string, () => Promise<unknown>>) {
  rpc.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    const fn = map[functionName];
    if (!fn) return Promise.reject(new Error(`unstubbed read: ${functionName}`));
    return fn();
  });
}

const HEALTHY_READS = {
  GRACE_PERIOD: () => Promise.resolve(3600n),
  effectiveDeadline: () => Promise.resolve(BigInt(NOW + 7200)),
  isDefaulted: () => Promise.resolve(false),
  getRepaymentAmount: () => Promise.resolve(1_010_000_000_000_000_000n),
};

beforeEach(() => {
  wallet.address = '0x1111111111111111111111111111111111111111';
  chain.id = 1;
  loanState.loans = [];
  loanState.isLoading = false;
  loanState.isError = false;
  loanState.loansUnread = false;
  rpc.present = true;
  rpc.readContract.mockReset();
  respond(HEALTHY_READS);
});

describe('nothing-was-asked is not nothing-at-risk', () => {
  it('with no wallet, reports idle and says nothing is being watched', async () => {
    wallet.address = undefined;
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toMatch(/nothing is being watched/i);
  });

  it('on the wrong chain, says the loans were not read rather than showing none', async () => {
    chain.id = 8453;
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.detail).toMatch(/were not read/i);
  });
});

describe('a failed read is reported as a failed read', () => {
  it('surfaces useMyLoans’ own read failure as unreadable', async () => {
    loanState.isError = true;
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.detail).toMatch(/failed read, not an absence of debt/i);
    expect(result.current.positions).toEqual([]);
  });

  it('refuses a PARTIAL discovery rather than watching a book with holes in it', async () => {
    // Every per-loan read below is healthy; the failure happened one layer up,
    // while enumerating which loans exist. A shorter list on this surface reads
    // as LESS risk, so the shield declines it instead of showing part as whole.
    loanState.loans = [loan()];
    loanState.loansUnread = true;
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toMatch(/could not be read|missing positions/i);
  });

  it('reports an RPC outage as unreadable, not as a list of healthy loans', async () => {
    loanState.loans = [loan()];
    respond({
      GRACE_PERIOD: () => Promise.resolve(3600n),
      effectiveDeadline: () => Promise.reject(new Error('rpc down')),
      isDefaulted: () => Promise.reject(new Error('rpc down')),
      getRepaymentAmount: () => Promise.reject(new Error('rpc down')),
    });
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.positions).toEqual([]);
  });

  it('keeps a row whose quote failed but whose deadline read, flagging only the quote', async () => {
    loanState.loans = [loan()];
    respond({
      ...HEALTHY_READS,
      getRepaymentAmount: () => Promise.reject(new Error('quote failed')),
    });
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.positions).toHaveLength(1);
    expect(result.current.positions[0]!.health.status).toBe('read');
    expect(result.current.positions[0]!.quotedRepayWei).toBeNull();
    expect(result.current.positions[0]!.quoteDetail).toBeTruthy();
  });

  it('reports a loan unreadable when only the contract’s default verdict failed', async () => {
    // The deadline read fine, so a model that judged the window on its own clock
    // would band this row confidently. `isDefaulted` is what says whether
    // repayment still settles; without it the row's answer is "unknown".
    loanState.loans = [loan()];
    respond({ ...HEALTHY_READS, isDefaulted: () => Promise.reject(new Error('down')) });
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.positions[0]!.health.status).toBe('unreadable');
  });

  it('carries the contract’s default verdict into the position it built', async () => {
    loanState.loans = [loan()];
    respond({ ...HEALTHY_READS, isDefaulted: () => Promise.resolve(true) });
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const health = result.current.positions[0]!.health;
    expect(health.status === 'read' && health.band).toBe('defaulted');
    expect(health.status === 'read' && health.repayable).toBe(false);
  });

  it('refuses every deadline when the grace constant could not be read', async () => {
    loanState.loans = [loan()];
    respond({
      ...HEALTHY_READS,
      GRACE_PERIOD: () => Promise.reject(new Error('down')),
    });
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.positions[0]!.health.status).toBe('unreadable');
  });
});

describe('a successful read is allowed to say "none"', () => {
  it('reports ready with no positions when the wallet genuinely has no borrow', async () => {
    loanState.loans = [];
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.positions).toEqual([]);
    expect(result.current.detail).toBeNull();
  });

  it('builds a position from the pause-adjusted deadline, not the loan struct’s', async () => {
    // `deadline` on the struct is NOW+86400; `effectiveDeadline` answers NOW+7200.
    // The health must follow the contract's answer, because that is the one the
    // claim path acts on.
    loanState.loans = [loan()];
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const health = result.current.positions[0]!.health;
    expect(health.status).toBe('read');
    expect(health.status === 'read' && health.deadlineUnix).toBe(NOW + 7200);
  });
});

describe('it watches the borrower side only', () => {
  it('ignores loans where this wallet is the lender', async () => {
    // A lender whose borrower defaults RECEIVES the collateral. Listing that as
    // something a shield protects would invent a risk.
    loanState.loans = [loan({ role: 'lender' })];
    const { result } = renderHook(() => useShieldPositions());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.positions).toEqual([]);
  });
});
