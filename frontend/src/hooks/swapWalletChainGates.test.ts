/**
 * THE SWAP STACK KEEPS ITS WALLET-CHAIN GATE. The sweep that un-gated the
 * display reads (walletChainReads.test.ts, walletChainDisplayReads.test.ts)
 * stops here on purpose, and this pins where it stopped.
 *
 * Both hooks pin every read to mainnet AND gate on the wallet being there, and
 * here the gate is not hiding a figure:
 *   - useSwapQuote's path, route and minimumReceived are what useSwap signs and
 *     the floors a zap plan submits. Its aggregator leg follows the wallet's
 *     chain on purpose (R045 H1), and off mainnet ChainSwapAvailability explains
 *     the empty form.
 *   - useSwapAllowance's allowances are shown nowhere. They decide whether to
 *     approve and whether approve() zeroes first, for USDT.
 * Each case proves its stub lands on mainnet first: a gate test that never sees
 * the read land would pass for any reason.
 *
 * MUTATION CHECK: delete the chain term from these hooks' read gates -- every
 * copy, as useSwapQuote carries one per read -- and their cases here fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { maxUint256, parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useSwapQuote } from './useSwapQuote';
import { useSwapAllowance } from './useSwapAllowance';
import { CHAIN_ID, UNISWAP_V2_FACTORY, UNISWAP_V2_ROUTER, WETH_ADDRESS } from '../lib/constants';
import { NATIVE_ETH_ADDRESS, type TokenInfo } from '../lib/tokenList';

const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
const PAIR = '0x9999999999999999999999999999999999999999';
const ETH: TokenInfo = { address: NATIVE_ETH_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };
const TKN: TokenInfo = { address: '0x1111111111111111111111111111111111111111', symbol: 'TKN', name: 'Token', decimals: 18, logoURI: '' };
const AMOUNT = parseEther('1');
const OUT = parseEther('1900');
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

type Write = Parameters<typeof useSwapAllowance>[5];

/** What `useHook` reports to a wallet whose chain is `chainId`. */
function reportOn<T>(useHook: () => T, chainId: number): T {
  wagmiMock.setChainId(chainId);
  const { result, unmount } = renderHook(useHook);
  const report = result.current;
  unmount();
  return report;
}

describe.each(OFF_MAINNET)('a wallet on %s', (_label, chainId) => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  it('useSwapQuote quotes nothing there, though the same pair quotes on mainnet', () => {
    wagmiMock.setReadResult({ address: UNISWAP_V2_FACTORY, functionName: 'getPair', result: PAIR });
    wagmiMock.setReadResult({ address: UNISWAP_V2_ROUTER, functionName: 'getAmountsOut', result: [AMOUNT, OUT] });
    wagmiMock.setReadResult({ address: PAIR, functionName: 'getReserves', result: [parseEther('1000'), parseEther('2000000'), 0] });
    wagmiMock.setReadResult({ address: PAIR, functionName: 'token0', result: WETH_ADDRESS });
    // No address: keeps the aggregator effect, and its network, out of this.
    const useQuote = () => useSwapQuote(ETH, TKN, AMOUNT, 0.5, undefined);

    const on = reportOn(useQuote, CHAIN_ID);
    expect(on.outputAmount).toBe(OUT);
    expect(on.minimumReceived).toBeGreaterThan(0n);
    expect(on.hasDirectPair).toBe(true);

    const off = reportOn(useQuote, chainId);
    expect([off.outputAmount, off.minimumReceived, off.selectedOnChainRoute.output]).toEqual([0n, 0n, 0n]);
    expect(off.hasDirectPair).toBe(false);
    // Nothing was asked, so nothing is reported unread either.
    expect([off.priceImpact, off.priceImpactUnread]).toEqual([null, false]);
  });

  it('useSwapAllowance clears no approval there, though mainnet has one on record', () => {
    // An unlimited allowance to both spenders, on mainnet.
    wagmiMock.setReadResult({ address: TKN.address, functionName: 'allowance', result: maxUint256 });
    const useAllowance = () => useSwapAllowance(TKN, AMOUNT, 'uniswap', 'uniswap', USER, vi.fn<Write>());

    expect(reportOn(useAllowance, CHAIN_ID).needsApproval).toBe(false);
    // Off mainnet nothing was read, so it cannot say the approval is in place.
    expect(reportOn(useAllowance, chainId).needsApproval).toBe(true);
  });

  it('useSwapAllowance sends no approve from there, and does from mainnet', () => {
    const approvesSent = (id: number) => {
      wagmiMock.setChainId(id);
      const write = vi.fn<Write>();
      const { result, unmount } = renderHook(() => useSwapAllowance(TKN, AMOUNT, 'uniswap', 'uniswap', USER, write));
      act(() => result.current.approve());
      unmount();
      return write.mock.calls.length;
    };
    expect(approvesSent(CHAIN_ID)).toBe(1);
    expect(approvesSent(chainId)).toBe(0);
  });
});
