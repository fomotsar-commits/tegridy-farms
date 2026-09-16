/**
 * THE WALLET'S CHAIN DOES NOT DECIDE WHAT A MAINNET READ REPORTS -- two more
 * display hooks, after walletChainReads.test.ts.
 *
 * Each pins its reads to mainnet (`chainId: CHAIN_ID`) and ALSO gated `enabled`
 * on `useChainId() === CHAIN_ID`, which follows the wallet since 2443b584. So
 * for a wallet on Base or Robinhood Chain nothing was asked:
 *   - useLpPosition: the Dashboard dropped a real LP position, and its unread
 *     flags were scoped by the same term, so nothing said a read was missing;
 *   - useWalletExposure: "No tracked ERC-20 balances in this wallet", printed
 *     under the page's own "switch to read your holdings" notice.
 * Neither feeds a write, so both gates are gone. Per hook: on Base and on
 * Robinhood Chain it reports what it reports on mainnet, after checking that one
 * stubbed figure landed (two unread renders would be equal too), and a read that
 * fails there is reported as a failed read.
 *
 * Pinned elsewhere: usePortfolioSources and useShieldPositions in their own
 * suites, whose local mocks model what the shared one does not; the gates that
 * stay in positionMarketWalletChain.test.tsx and swapWalletChainGates.test.ts.
 *
 * MUTATION CHECK: put the chain term back in either hook's `enabled`, or in
 * useLpPosition's `readsEnabled`, and that hook's cases here fail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { useLpPosition } from './useLpPosition';
import { useWalletExposure } from './useWalletExposure';
import { CHAIN_ID, LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';

const E18 = 10n ** 18n;
const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
/** A pasted token, so the case does not lean on the curated list. */
const TOKEN = '0x00000000000000000000000000000000000000aa';
/** ONE array for every render: useWalletExposure keys a memo on its identity. */
const EXTRA = [TOKEN];
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** What `useHook` reports to a wallet whose chain is `chainId`. */
function reportOn<T>(useHook: () => T, chainId: number): T {
  wagmiMock.setChainId(chainId);
  const { result, unmount } = renderHook(useHook);
  const report = result.current;
  unmount();
  return report;
}

/** A report's figures. Its callbacks are re-created on every render and are not the subject. */
function figures(report: object) {
  return Object.fromEntries(Object.entries(report).filter(([, v]) => typeof v !== 'function'));
}

describe.each(OFF_MAINNET)('a wallet CONNECTED on %s', (_label, chainId) => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });

  describe('useLpPosition', () => {
    beforeEach(() => {
      // 40 TGLP held and 10 staked, of 1,000, in a TOWELI-first pool.
      const lp = (functionName: string, result: unknown) =>
        wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName, result });
      lp('balanceOf', 40n * E18);
      lp('totalSupply', 1_000n * E18);
      lp('getReserves', [2_000_000n * E18, 50n * E18, 0]);
      lp('token0', TOWELI_ADDRESS);
      const farm = (functionName: string, result: unknown) =>
        wagmiMock.setReadResult({ address: LP_FARMING_ADDRESS, functionName, result });
      farm('rawBalanceOf', 10n * E18);
      farm('earned', 3n * E18);
    });

    it('reports the mainnet LP position rather than dropping it', () => {
      const useLp = () => useLpPosition(USER);
      const off = reportOn(useLp, chainId);
      expect(off.walletLp).toBe(40n * E18);
      expect(off.hasPosition).toBe(true);
      expect([off.lpUnread, off.reservesUnread]).toEqual([false, false]);
      expect(figures(off)).toEqual(figures(reportOn(useLp, CHAIN_ID)));
    });

    it('says a failed LP read is unread, where it used to say nothing', () => {
      wagmiMock.setReadResult({ address: TEGRIDY_LP_ADDRESS, functionName: 'balanceOf', result: 0n, status: 'failure' });
      expect(reportOn(() => useLpPosition(USER), chainId).lpUnread).toBe(true);
    });
  });

  describe('useWalletExposure', () => {
    beforeEach(() => {
      // Every curated token reads a real zero, so the list holds only the pasted one.
      wagmiMock.setReadResult({ functionName: 'balanceOf', result: 0n });
      const token = (functionName: string, result: unknown) =>
        wagmiMock.setReadResult({ address: TOKEN, functionName, result });
      token('balanceOf', 5n * E18);
      token('totalSupply', 1_000n * E18);
      token('symbol', 'AAA');
      token('decimals', 18);
    });

    it('lists the mainnet holding rather than an empty wallet', () => {
      const useExposure = () => useWalletExposure({ extraTokens: EXTRA });
      const off = reportOn(useExposure, chainId);
      expect(off.holdings.map((h) => [h.address, h.balance])).toEqual([[TOKEN, 5n * E18]]);
      expect(figures(off)).toEqual(figures(reportOn(useExposure, CHAIN_ID)));
    });

    it('discloses a balance it could not read, where it used to list nothing', () => {
      wagmiMock.setReadResult({ address: TOKEN, functionName: 'balanceOf', result: 0n, status: 'failure' });
      expect(reportOn(() => useWalletExposure({ extraTokens: EXTRA }), chainId).unreadableBalances).toEqual([TOKEN]);
    });
  });
});
