// The quote side of a zap.
//
// The defect this file exists to catch is silent: `useZapPlan` decides how much of the
// input each leg spends so it can price that leg, and `planner.ts` decides the same thing
// again so it can build the calldata. Two copies of one number. If they drift, the panel
// prices half a trade and submits a floor for a whole one — the plan is REFUSED rather
// than mispriced (planner checks the size), so the visible symptom is a zap that will not
// compose and no clue why. These tests hold the two halves equal.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CHAIN_ID, SWAP_FEE_ROUTER_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../lib/constants';
import { DEFAULT_TOKENS } from '../lib/tokenList';

const WALLET = '0x1111111111111111111111111111111111111111' as const;

const state = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined,
  chainId: 1,
  routerFeeBps: 25n as bigint | undefined,
  routerFeeError: false,
  quoteCalls: [] as { to: string; amount: bigint }[],
  minimumReceived: 10n ** 20n,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: !!state.address }),
  useChainId: () => state.chainId,
  useReadContract: () => ({ data: state.routerFeeBps, isError: state.routerFeeError }),
}));

vi.mock('./useSwapQuote', () => ({
  useSwapQuote: (from: unknown, to: { symbol: string }, amount: bigint) => {
    state.quoteCalls.push({ to: to.symbol, amount });
    const usable = amount > 0n;
    return {
      outputAmount: usable ? state.minimumReceived * 2n : 0n,
      minimumReceived: usable ? state.minimumReceived : 0n,
      isQuoteLoading: false,
      selectedRoute: 'tegridy',
      selectedOnChainRoute: { source: 'tegridy', output: state.minimumReceived * 2n },
      path: [WETH_ADDRESS, TOWELI_ADDRESS],
    };
  },
}));

import { useZapPlan } from './useZapPlan';

const ETH = DEFAULT_TOKENS.find((t) => t.isNative)!;
const USDC = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')!;
const TOWELIE = DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === TOWELI_ADDRESS.toLowerCase())!;

function amountsQuoted(): Record<string, bigint> {
  return Object.fromEntries(state.quoteCalls.map((c) => [c.to, c.amount]));
}

describe('the leg sizes this hook prices', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.quoteCalls = [];
    state.routerFeeBps = 25n;
    state.routerFeeError = false;
  });

  it('prices the whole input for a staking lock, because there is one leg', () => {
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(amountsQuoted().TOWELI).toBe(1_000_000n);
    expect(amountsQuoted().ETH).toBe(0n);
    expect(result.current.result?.ok).toBe(true);
  });

  it('prices half the input for the LP farm, matching the half the planner spends', () => {
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'lp-farm', inputToken: ETH, amountIn: 10n ** 18n, slippagePct: 0.5 }),
    );
    expect(amountsQuoted().TOWELI).toBe(10n ** 18n / 2n);
    // A native input needs no ETH leg — quoting one would price a swap nobody makes.
    expect(amountsQuoted().ETH).toBe(0n);
    // The planner's own size check is what proves the two halves agree: a mismatch
    // refuses with `route-unavailable`, so `ok` here IS the equality assertion.
    expect(result.current.result?.ok).toBe(true);
  });

  it('prices both halves for an ERC20 into the LP farm', () => {
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'lp-farm', inputToken: USDC, amountIn: 1_000_001n, slippagePct: 0.5 }),
    );
    // Odd amounts split floor/ceil; the two must still add to the input exactly.
    expect(amountsQuoted().TOWELI + amountsQuoted().ETH).toBe(1_000_001n);
    expect(result.current.result?.ok).toBe(true);
  });

  it('prices only the ETH half for a TOWELI input, since one side is already held', () => {
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'lp-farm', inputToken: TOWELIE, amountIn: 100n, slippagePct: 0.5 }),
    );
    expect(amountsQuoted().TOWELI).toBe(0n);
    expect(amountsQuoted().ETH).toBe(50n);
    expect(result.current.result?.ok).toBe(true);
  });
});

describe('refusals reach the caller', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.quoteCalls = [];
    state.routerFeeBps = 25n;
    state.routerFeeError = false;
    state.minimumReceived = 10n ** 20n;
  });

  it('refuses when a leg came back without a floor, instead of composing one', () => {
    state.minimumReceived = 0n;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.result).toMatchObject({ ok: false, code: 'route-unavailable' });
  });

  it('reports nothing at all with no wallet — a refusal would be premature', () => {
    state.address = undefined;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.result).toBeNull();
  });
});

describe('the fee this hook discloses', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.quoteCalls = [];
    state.minimumReceived = 10n ** 20n;
    state.routerFeeError = false;
  });

  it('shows the venue router s live rate on a native-route leg', () => {
    state.routerFeeBps = 25n;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.routerFeeBps).toBe(25);
    expect(result.current.fee.value).toBe('0.25%');
    expect(result.current.fee.addedByZap).toBe(0);
  });

  it('renders a failed read as unavailable, never as a zero fee', () => {
    state.routerFeeError = true;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.routerFeeBps).toBeNull();
    expect(result.current.fee.value).toBe('Unavailable');
    expect(result.current.fee.unavailable).toBe(true);
  });

  it('refuses a nonsense rate from the chain rather than displaying it', () => {
    state.routerFeeError = false;
    state.routerFeeBps = 99_999n;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.routerFeeBps).toBeNull();
    expect(result.current.fee.value).toBe('Unavailable');
  });

  it('takes nothing when the zap has no swap leg at all', () => {
    state.routerFeeBps = 25n;
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: TOWELIE, amountIn: 100n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    expect(result.current.fee.value).toBe('None');
  });
});

// The executor a quote resolves to must be one this app already routes through — never an
// address a quote response could name.
describe('the executor a leg resolves to', () => {
  beforeEach(() => {
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.quoteCalls = [];
    state.routerFeeBps = 25n;
    state.routerFeeError = false;
    state.minimumReceived = 10n ** 20n;
  });

  it('is the venue s own SwapFeeRouter for a native-pool route', () => {
    const { result } = renderHook(() =>
      useZapPlan({ venueId: 'staking-lock', inputToken: USDC, amountIn: 1_000_000n, slippagePct: 0.5, lockDurationSeconds: 7776000n }),
    );
    const swap = result.current.result?.ok
      ? result.current.result.plan.steps.find((s) => s.kind === 'swap')
      : null;
    expect(swap?.route?.executor.toLowerCase()).toBe(SWAP_FEE_ROUTER_ADDRESS.toLowerCase());
    expect(swap?.route?.executorTakesMaxFee).toBe(true);
  });
});
