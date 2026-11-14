/**
 * useSwapQuote: our pools on two factories. Pools opened since the 0.006 ETH opening fee
 * (owner ruling 2026-10-25) live on a second factory, swapped through its own router and its
 * own SwapFeeRouter (the same venue fee). The quote prices our pool on both, each net of its
 * own SwapFeeRouter's fee, keeps the better one, and says which (`ownPools`). Only a caller
 * that asks (the swap page) sees the second factory; the zap, which signs against the old
 * SwapFeeRouter only, never does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import {
  UNISWAP_V2_ROUTER,
  TEGRIDY_FACTORY_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  CHAIN_ID,
} from '../lib/constants';
import { NATIVE_ETH_ADDRESS, type TokenInfo } from '../lib/tokenList';

const OPENING_FACTORY = '0x0fac000000000000000000000000000000000001' as const;
const OPENING_ROUTER = '0x0be0000000000000000000000000000000000002' as const;
const OPENING_SFR = '0x05f0000000000000000000000000000000000003' as const;
const opening = vi.hoisted(() => ({ on: true }));
vi.mock('../lib/chains/swapVenue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains/swapVenue')>();
  return {
    ...real,
    openingSwapVenue: (v: ReturnType<typeof real.swapVenueOn>) =>
      opening.on && v ? { ...v, factory: OPENING_FACTORY, router: OPENING_ROUTER, swapFeeRouter: OPENING_SFR } : null,
  };
});

import { useSwapQuote } from './useSwapQuote';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as const;
const PAIR = '0x9999999999999999999999999999999999999999' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ETH: TokenInfo = { address: NATIVE_ETH_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };
const TKN: TokenInfo = { address: '0x1111111111111111111111111111111111111111', symbol: 'TKN', name: 'Token', decimals: 18, logoURI: '' };
const IN = parseEther('1');

function pools({ base, fresh, uni }: { base: bigint | null; fresh: bigint | null; uni: bigint }) {
  wagmiMock.setReadResult({ functionName: 'getPair', address: TEGRIDY_FACTORY_ADDRESS, result: base === null ? ZERO : PAIR });
  wagmiMock.setReadResult({ functionName: 'getPair', address: OPENING_FACTORY, result: fresh === null ? ZERO : PAIR });
  if (base !== null) wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: TEGRIDY_ROUTER_ADDRESS, result: [IN, base] });
  if (fresh !== null) wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: OPENING_ROUTER, result: [IN, fresh] });
  wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: UNISWAP_V2_ROUTER, result: [IN, uni] });
}

const quote = (includeOpeningPools?: boolean) =>
  renderHook(() => useSwapQuote(ETH, TKN, IN, 1, USER, CHAIN_ID, includeOpeningPools === undefined ? undefined : { includeOpeningPools })).result.current;

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  opening.on = true;
  wagmiMock.setReadResult({ functionName: 'feeBps', address: SWAP_FEE_ROUTER_ADDRESS, result: 50n });
  wagmiMock.setReadResult({ functionName: 'feeBps', address: OPENING_SFR, result: 50n });
});

describe('useSwapQuote: our pools on the opening factory', () => {
  it('a better pool on the opening factory wins, net of its own fee', () => {
    pools({ base: parseEther('100'), fresh: parseEther('120'), uni: parseEther('50') });
    const q = quote(true);
    expect(q.ownPools).toBe('opening');
    expect(q.selectedRoute).toBe('tegridy');
    expect(q.outputAmount).toBe((parseEther('120') * 9950n) / 10000n);
    expect(q.hasTegridyPair).toBe(true);
  });

  it('a better pool on the old factory stays on the old one; a tie does too', () => {
    pools({ base: parseEther('120'), fresh: parseEther('100'), uni: parseEther('50') });
    expect(quote(true).ownPools).toBe('base');
    pools({ base: parseEther('100'), fresh: parseEther('100'), uni: parseEther('50') });
    expect(quote(true).ownPools).toBe('base');
  });

  it('a pool only on the opening factory is found and quoted', () => {
    pools({ base: null, fresh: parseEther('120'), uni: parseEther('50') });
    const q = quote(true);
    expect(q.hasTegridyPair).toBe(true);
    expect(q.ownPools).toBe('opening');
    expect(q.selectedOnChainRoute.source).toBe('tegridy');
  });

  it('each factory is netted with its own SwapFeeRouter fee', () => {
    // 1% on the opening SwapFeeRouter: 120 * 0.99 = 118.8 still beats 100 * 0.995 = 99.5.
    wagmiMock.setReadResult({ functionName: 'feeBps', address: OPENING_SFR, result: 100n });
    pools({ base: parseEther('100'), fresh: parseEther('120'), uni: parseEther('50') });
    const q = quote(true);
    expect(q.outputAmount).toBe((parseEther('120') * 9900n) / 10000n);
    expect(q.routeLabel).toContain('incl. 1% fee');
  });

  it('a caller that does not ask (the zap) never sees the opening factory', () => {
    pools({ base: parseEther('100'), fresh: parseEther('120'), uni: parseEther('50') });
    const q = quote();
    expect(q.ownPools).toBe('base');
    expect(q.outputAmount).toBe((parseEther('100') * 9950n) / 10000n);
  });

  it('with no opening factory deployed, nothing changes', () => {
    opening.on = false;
    pools({ base: parseEther('100'), fresh: parseEther('120'), uni: parseEther('50') });
    const q = quote(true);
    expect(q.ownPools).toBe('base');
    expect(q.outputAmount).toBe((parseEther('100') * 9950n) / 10000n);
  });
});
