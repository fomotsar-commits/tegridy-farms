// THE SAME COLLAPSED 0n, SPENT WITH OPPOSITE POLARITY IN ONE FILE.
//
// An earlier hand-check cleared this hook as safe, and it was half right:
// `needsApproval` (:109) collapses toward "approval needed", which fails CLOSED
// and costs a click. That verdict was recorded and the file stayed on the
// ratchet baseline.
//
// It missed the second consumer. The R033 M-02 two-step at :156 asks
// `activeAllowance > 0n`, and an unread allowance answers NO — so the zero-write
// is skipped and a direct approve(spender, amount) goes out instead. Mainnet
// USDT (tokenList.ts:50, in DEFAULT_TOKENS) reverts `approve` when the current
// allowance and the new value are both non-zero, which is the entire reason the
// two-step exists. The guard is disarmed by the one condition it must survive.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { useSwapAllowance } from './useSwapAllowance';
import { DEFAULT_TOKENS } from '../lib/tokenList';
import { SWAP_FEE_ROUTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { swapVenueOn } from '../lib/chains/swapVenue';

const USER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;
const USDT = DEFAULT_TOKENS.find((t) => t.symbol === 'USDT')!;
const AMOUNT = 1_000_000n; // 1 USDT, 6 decimals

/** The exact shape useSwapAllowance expects for writeContract.
 *
 *  Typed, not `ReturnType<typeof vi.fn>`: a bare `vi.fn()` is
 *  `Mock<Procedure | Constructable>`, which is NOT assignable to a specific
 *  call signature, and `write.mock.calls[0][0]` would be `any` — so the
 *  assertions below would type-check against nothing. `npx tsc -b` is
 *  INCREMENTAL and reported clean on the first pass here; only a rebase
 *  invalidating the cache surfaced it, with the vitest suite green throughout
 *  because vitest does not typecheck. */
type WriteArgs = {
  chainId?: number;
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};
const makeWrite = () => vi.fn((_args: WriteArgs) => {});

function setup(write: ReturnType<typeof makeWrite>) {
  return renderHook(() => useSwapAllowance(USDT, AMOUNT, 'tegridy', 'tegridy', USER, write));
}

describe('useSwapAllowance — an unread allowance takes the safe path', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('USDT is on the default list, so this path is reachable in production', () => {
    expect(USDT.address.toLowerCase()).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7');
  });

  it('a READ allowance of zero writes the target amount directly', () => {
    // The genuine fresh-token case. One approve, no zero-write — unchanged.
    wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
    const write = makeWrite();
    const { result } = setup(write);
    act(() => { result.current.approve(); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].args).toEqual([SWAP_FEE_ROUTER_ADDRESS, AMOUNT]);
    expect(result.current.isApprovingMultiStep).toBe(false);
  });

  it('a READ non-zero allowance below the target takes the two-step', () => {
    // The case the two-step was written for, still behaving.
    wagmiMock.setReadResult({ functionName: 'allowance', result: 500_000n });
    const write = makeWrite();
    const { result } = setup(write);
    act(() => { result.current.approve(); });
    expect(write.mock.calls[0][0].args).toEqual([SWAP_FEE_ROUTER_ADDRESS, 0n]);
    expect(result.current.isApprovingMultiStep).toBe(true);
  });

  it('an UNREAD allowance takes the two-step, not the direct approve', () => {
    // THE FIX. Pre-fix this wrote [spender, AMOUNT] — which mainnet USDT
    // reverts if the wallet already had a non-zero allowance, with the gas
    // spent. The zero-write is safe against BOTH an already-zero and a
    // non-zero allowance, so it is the correct branch under uncertainty.
    wagmiMock.setReadResult({ functionName: 'allowance', result: 0n, status: 'failure' });
    const write = makeWrite();
    const { result } = setup(write);
    act(() => { result.current.approve(); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].args).toEqual([SWAP_FEE_ROUTER_ADDRESS, 0n]);
    expect(result.current.isApprovingMultiStep).toBe(true);
  });

  it('needsApproval STILL fails closed on an unread allowance', () => {
    // Deliberately pinned. This is the half the earlier hand-check got right,
    // and a later "simplify" pass that made one nullable value out of both
    // would invert it into the bug above.
    wagmiMock.setReadResult({ functionName: 'allowance', result: 0n, status: 'failure' });
    const write = makeWrite();
    const { result } = setup(write);
    expect(result.current.needsApproval).toBe(true);
  });
});

// 2026-11-01: an island coin sold through its own V3 pool goes through Uniswap's Universal
// Router, which pulls it via Permit2. The approval must name Permit2, or the sale reverts.
describe('useSwapAllowance: the V3 route approves Permit2', () => {
  const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const BNKR = { address: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b' as `0x${string}`, symbol: 'BNKR', name: 'BNKR', decimals: 18, logoURI: '' };

  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(8453);
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('asks for, and writes, an approval of exactly the amount to Permit2 on Base', () => {
    wagmiMock.setReadResult({ functionName: 'allowance', result: 0n });
    const write = makeWrite();
    const { result } = renderHook(() => useSwapAllowance(BNKR, AMOUNT, 'uniswap-v3', 'uniswap-v3', USER, write, swapVenueOn(8453)));
    expect(result.current.needsApproval).toBe(true);
    act(() => { result.current.approve(); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ chainId: 8453, address: BNKR.address, functionName: 'approve', args: [PERMIT2, AMOUNT] });
  });

  it('needs nothing once Permit2 already holds enough', () => {
    wagmiMock.setReadResult({ functionName: 'allowance', result: AMOUNT });
    const { result } = renderHook(() => useSwapAllowance(BNKR, AMOUNT, 'uniswap-v3', 'uniswap-v3', USER, makeWrite(), swapVenueOn(8453)));
    expect(result.current.needsApproval).toBe(false);
  });
});
