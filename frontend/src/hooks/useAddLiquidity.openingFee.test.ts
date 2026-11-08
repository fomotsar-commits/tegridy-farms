// Opening a pool costs 0.006 ETH (owner ruling 2026-10-25). The hook decides, per pair, which
// factory and router the add goes to, and adds the opening fee to what the wallet sends only
// when this add opens the pool on the fee factory. A pool on the old factory stays there.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import type { TokenInfo } from '../lib/tokenList';
import { TEGRIDY_FACTORY_ADDRESS, TEGRIDY_ROUTER_ADDRESS } from '../lib/constants';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const OPENING_FACTORY = '0x0fac000000000000000000000000000000000001' as const;
const OPENING_ROUTER = '0x0be0000000000000000000000000000000000002' as const;
const venueState = vi.hoisted(() => ({ opening: false }));

vi.mock('../lib/chains/liquidityVenue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains/liquidityVenue')>();
  return {
    ...real,
    openingVenueOn: (chainId: number) => {
      const base = real.liquidityVenueOn(chainId);
      return venueState.opening && base
        ? { ...base, factory: OPENING_FACTORY, router: OPENING_ROUTER }
        : null;
    },
  };
});

import { useAddLiquidity } from './useAddLiquidity';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const SOME_PAIR = '0x9a19000000000000000000000000000000000003';
const FEE = 6_000_000_000_000_000n; // 0.006 ETH
const ETH: TokenInfo = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };
const A: TokenInfo = { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'AAA', name: 'Token A', decimals: 18, logoURI: '' };
const B: TokenInfo = { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'BBB', name: 'Token B', decimals: 18, logoURI: '' };

function pairOn(factory: string, pair: string) {
  wagmiMock.setReadResult({ functionName: 'getPair', address: factory, result: pair });
}

function lastWrite() {
  const calls = wagmiMock.writeContract().mock.calls;
  return calls[calls.length - 1]?.[0] as { address: string; functionName: string; value?: bigint; args: unknown[] };
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  venueState.opening = false;
  wagmiMock.setReadResult({ functionName: 'POOL_OPENING_FEE', address: OPENING_FACTORY, result: FEE });
});

describe('useAddLiquidity — the pool-opening fee', () => {
  it('with no fee factory deployed, nothing changes: old router, no fee', () => {
    pairOn(TEGRIDY_FACTORY_ADDRESS, ZERO);
    const { result } = renderHook(() => useAddLiquidity(ETH, A));
    expect(result.current.opensPoolWithFee).toBe(false);
    result.current.addLiquidity('1', '1000');
    const w = lastWrite();
    expect(w.address).toBe(TEGRIDY_ROUTER_ADDRESS);
    expect(w.functionName).toBe('addLiquidityETH');
    expect(w.value).toBe(10n ** 18n);
  });

  it('a new ETH pair opens on the fee router and sends the liquidity ETH plus the fee', () => {
    venueState.opening = true;
    pairOn(TEGRIDY_FACTORY_ADDRESS, ZERO);
    pairOn(OPENING_FACTORY, ZERO);
    const { result } = renderHook(() => useAddLiquidity(ETH, A));
    expect(result.current.opensPoolWithFee).toBe(true);
    expect(result.current.openingFeeWei).toBe(FEE);
    result.current.addLiquidity('1', '1000');
    const w = lastWrite();
    expect(w.address).toBe(OPENING_ROUTER);
    expect(w.functionName).toBe('addLiquidityETH');
    expect(w.value).toBe(10n ** 18n + FEE);
  });

  it('a new token/token pair sends exactly the fee', () => {
    venueState.opening = true;
    pairOn(TEGRIDY_FACTORY_ADDRESS, ZERO);
    pairOn(OPENING_FACTORY, ZERO);
    const { result } = renderHook(() => useAddLiquidity(A, B));
    result.current.addLiquidity('10', '20');
    const w = lastWrite();
    expect(w.address).toBe(OPENING_ROUTER);
    expect(w.functionName).toBe('addLiquidity');
    expect(w.value).toBe(FEE);
  });

  it('a pair already on the old factory stays on the old router and pays nothing', () => {
    venueState.opening = true;
    pairOn(TEGRIDY_FACTORY_ADDRESS, SOME_PAIR);
    pairOn(OPENING_FACTORY, ZERO);
    const { result } = renderHook(() => useAddLiquidity(ETH, A));
    expect(result.current.opensPoolWithFee).toBe(false);
    expect(result.current.pairAddress).toBe(SOME_PAIR);
    result.current.addLiquidity('1', '1000');
    const w = lastWrite();
    expect(w.address).toBe(TEGRIDY_ROUTER_ADDRESS);
    expect(w.value).toBe(10n ** 18n);
  });

  it('a pair already on the fee factory uses the fee router and pays nothing more', () => {
    venueState.opening = true;
    pairOn(TEGRIDY_FACTORY_ADDRESS, ZERO);
    pairOn(OPENING_FACTORY, SOME_PAIR);
    const { result } = renderHook(() => useAddLiquidity(A, B));
    expect(result.current.opensPoolWithFee).toBe(false);
    result.current.addLiquidity('10', '20');
    const w = lastWrite();
    expect(w.address).toBe(OPENING_ROUTER);
    expect(w.value).toBe(0n);
  });

  it('an unread fee builds no transaction', () => {
    venueState.opening = true;
    pairOn(TEGRIDY_FACTORY_ADDRESS, ZERO);
    pairOn(OPENING_FACTORY, ZERO);
    wagmiMock.setReadResult({ functionName: 'POOL_OPENING_FEE', address: OPENING_FACTORY, result: undefined, status: 'failure' });
    const { result } = renderHook(() => useAddLiquidity(ETH, A));
    expect(result.current.opensPoolWithFee).toBe(true);
    expect(result.current.openingFeeWei).toBeUndefined();
    expect(result.current.openingFeeUnread).toBe(true);
    result.current.addLiquidity('1', '1000');
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('until the old factory answers, no add or approval is built against either router', () => {
    venueState.opening = true;
    pairOn(OPENING_FACTORY, ZERO); // the old factory's getPair is still out
    const { result } = renderHook(() => useAddLiquidity(ETH, A));
    result.current.addLiquidity('1', '1000');
    result.current.approveTokenB('1000');
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });
});
