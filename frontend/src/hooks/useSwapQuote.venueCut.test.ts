/**
 * useSwapQuote routes through our pool only when the venue's cut is on there (kLast() non-zero).
 * The old factories still open pools for free with the cut off (leak audit 2026-11-15, EVM-3):
 * such a pool, or one whose kLast() did not answer, is never quoted or routed, however much it pays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { UNISWAP_V2_ROUTER, TEGRIDY_FACTORY_ADDRESS, TEGRIDY_ROUTER_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { NATIVE_ETH_ADDRESS, type TokenInfo } from '../lib/tokenList';

const OPENING_FACTORY = '0x0fac000000000000000000000000000000000001' as const;
const OPENING_ROUTER = '0x0be0000000000000000000000000000000000002' as const;
const OPENING_SFR = '0x05f0000000000000000000000000000000000003' as const;
vi.mock('../lib/chains/swapVenue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains/swapVenue')>();
  return {
    ...real,
    openingSwapVenue: (v: ReturnType<typeof real.swapVenueOn>) =>
      v ? { ...v, factory: OPENING_FACTORY, router: OPENING_ROUTER, swapFeeRouter: OPENING_SFR } : null,
  };
});

import { useSwapQuote } from './useSwapQuote';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as const;
const OLD_PAIR = '0x9999999999999999999999999999999999999999' as const;
const NEW_PAIR = '0x7777777777777777777777777777777777777777' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ETH: TokenInfo = { address: NATIVE_ETH_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };
const TKN: TokenInfo = { address: '0x1111111111111111111111111111111111111111', symbol: 'TKN', name: 'Token', decimals: 18, logoURI: '' };
const IN = parseEther('1');

type Cut = bigint | 'unread';
function kLast(pair: string, cut: Cut) {
  wagmiMock.setReadResult(cut === 'unread'
    ? { functionName: 'kLast', address: pair, result: undefined, status: 'failure' }
    : { functionName: 'kLast', address: pair, result: cut });
}

/** Our old-factory pool pays 120, Uniswap 50; the opening factory has a pool only when `fresh` is given. */
function pools(base: Cut, fresh?: Cut) {
  wagmiMock.setReadResult({ functionName: 'getPair', address: TEGRIDY_FACTORY_ADDRESS, result: OLD_PAIR });
  wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: TEGRIDY_ROUTER_ADDRESS, result: [IN, parseEther('120')] });
  kLast(OLD_PAIR, base);
  wagmiMock.setReadResult({ functionName: 'getPair', address: OPENING_FACTORY, result: fresh === undefined ? ZERO : NEW_PAIR });
  if (fresh !== undefined) {
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: OPENING_ROUTER, result: [IN, parseEther('200')] });
    kLast(NEW_PAIR, fresh);
  }
  wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: UNISWAP_V2_ROUTER, result: [IN, parseEther('50')] });
}

const quote = () => renderHook(() => useSwapQuote(ETH, TKN, IN, 1, USER, CHAIN_ID, { includeOpeningPools: true })).result.current;

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
  wagmiMock.setReadResult({ functionName: 'feeBps', address: SWAP_FEE_ROUTER_ADDRESS, result: 50n });
  wagmiMock.setReadResult({ functionName: 'feeBps', address: OPENING_SFR, result: 50n });
});

describe('useSwapQuote: our pool only with the venue cut on', () => {
  it('routes through our pool when its cut is on', () => {
    pools(7n);
    const q = quote();
    expect(q.selectedRoute).toBe('tegridy');
    expect(q.hasTegridyPair).toBe(true);
    expect(q.outputAmount).toBe((parseEther('120') * 9950n) / 10000n);
  });

  it('never routes through a pool whose kLast reads 0, though it pays more', () => {
    pools(0n);
    const q = quote();
    expect(q.hasTegridyPair).toBe(false);
    expect(q.selectedRoute).toBe('uniswap');
    expect(q.outputAmount).toBe(parseEther('50'));
  });

  it('never routes through a pool whose kLast did not answer: unread is not on', () => {
    pools('unread');
    const q = quote();
    expect(q.hasTegridyPair).toBe(false);
    expect(q.selectedRoute).toBe('uniswap');
  });

  it('a better opening-factory pool with its cut off loses to the old pool with its cut on', () => {
    pools(7n, 0n);
    const q = quote();
    expect(q.ownPools).toBe('base');
    expect(q.outputAmount).toBe((parseEther('120') * 9950n) / 10000n);
  });

  it('the opening-factory pool wins once its cut is on', () => {
    pools(7n, 9n);
    expect(quote().ownPools).toBe('opening');
  });
});
