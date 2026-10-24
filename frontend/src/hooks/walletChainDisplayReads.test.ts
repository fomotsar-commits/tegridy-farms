/**
 * The wallet's chain does not decide what a mainnet read reports. On Base and on
 * Robinhood Chain, useLpPosition and useWalletExposure report what they report
 * on mainnet, and a read that fails there is reported as a failed read. Each case
 * first checks that one stubbed figure landed: two unread renders are equal too.
 * MUTATION CHECK: put the chain term back in either hook's `enabled`, or in
 * useLpPosition's `readsEnabled`, and that hook's cases here fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { useLpPosition } from './useLpPosition';
import { useWalletExposure } from './useWalletExposure';
import { CHAIN_ID, LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';

const E18 = 10n ** 18n;
const NOW = new Date('2026-10-03T12:00:00Z');
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
    // The clock stands still: useWalletExposure stamps `observedAt` on every
    // render, and two renders either side of a second boundary are not equal.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER, isConnected: true });
  });
  afterEach(() => vi.useRealTimers());

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
      // The stamp is the frozen clock's: take the freeze away and this fails every run.
      expect(off.exposures[TOKEN]?.observedAt).toBe(NOW.getTime() / 1000);
      expect(figures(off)).toEqual(figures(reportOn(useExposure, CHAIN_ID)));
    });

    it('discloses a balance it could not read, where it used to list nothing', () => {
      wagmiMock.setReadResult({ address: TOKEN, functionName: 'balanceOf', result: 0n, status: 'failure' });
      expect(reportOn(() => useWalletExposure({ extraTokens: EXTRA }), chainId).unreadableBalances).toEqual([TOKEN]);
    });
  });
});
