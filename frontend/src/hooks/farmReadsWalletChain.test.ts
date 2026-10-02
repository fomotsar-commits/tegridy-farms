/**
 * THE WALLET'S CHAIN DOES NOT DECIDE WHAT THE FARM REPORTS.
 *
 * useLPFarming, useFarmStats, usePoolData and usePoolTVL read mainnet contracts,
 * and every entry in their batches is pinned `chainId: CHAIN_ID`, so each read
 * goes to mainnet whatever chain the wallet is on (F198; lib/wagmi.ts). They also
 * gated `enabled` on `useChainId() === CHAIN_ID` (R043 H-062-02).
 *
 * That gate was written when wagmi was configured for mainnet alone, where
 * useChainId() can only be 1: createConfig ignores a connector's move to an
 * unconfigured chain. The multichain config (2443b584, 2026-08-21) made it follow
 * the wallet, and wagmi persists it to localStorage and keeps it through a
 * disconnect. From then on a visitor whose wallet was, or had last been, on Base
 * or Robinhood Chain had all four batches disabled: nothing was asked, every
 * figure collapsed to 0, and no unread flag fired. FarmPage's logged-out branch
 * printed that as an empty LP farm and a "0%" Emissions APR, with no banner.
 *
 * The pins were always the fix, so the gate is gone. This pins the invariant per
 * hook: on Base and on Robinhood Chain it reports exactly what it reports on
 * mainnet. Each case first checks that one stubbed figure landed, because two
 * renders of an unread hook would be equal too.
 *
 * MUTATION CHECK: put `onMainnet` back in any hook's `enabled` and that hook's
 * cases here fail. That needs the shared mock to honour `query.enabled`, which it
 * now does; it used to answer disabled reads, so it could not see this gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 0.001, ethUsd: 2000, ethUsdForDisplay: 2000, priceInEth: 0 }),
}));

import { useLPFarming } from './useLPFarming';
import { useFarmStats } from './useFarmStats';
import { usePoolData } from './usePoolData';
import { usePoolTVL } from './usePoolTVL';
import {
  CHAIN_ID, LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS,
} from '../lib/constants';

const E18 = 10n ** 18n;
const NOW = new Date('2026-09-10T12:00:00Z');
const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** One live mainnet deployment, stubbed per contract so the hooks' shared function names cannot collide. */
function stubMainnet() {
  const at = (address: string) => (functionName: string, result: unknown) =>
    wagmiMock.setReadResult({ address, functionName, result });
  const farm = at(LP_FARMING_ADDRESS);
  const lp = at(TEGRIDY_LP_ADDRESS);
  const staking = at(TEGRIDY_STAKING_ADDRESS);
  const toweli = at(TOWELI_ADDRESS);
  const nowSec = BigInt(Math.floor(NOW.getTime() / 1000));

  // useLPFarming
  farm('totalRawSupply', 5_000n * E18);
  farm('rewardRate', E18);
  farm('periodFinish', nowSec + 7n * 86_400n);
  farm('rewardsDuration', 604_800n);
  farm('totalRewardsFunded', 1_000_000n * E18);
  farm('rawBalanceOf', 100n * E18);
  farm('earned', 5n * E18);
  farm('MIN_STAKE', E18 / 100n);
  lp('balanceOf', 40n * E18);
  lp('allowance', 0n);
  lp('totalSupply', 10_000n * E18);
  // usePoolTVL
  lp('getReserves', [1_000_000n * E18, 10n * E18, 0]);
  lp('token0', TOWELI_ADDRESS);
  // useFarmStats + usePoolData
  staking('totalStaked', 5_000_000n * E18);
  staking('totalBoostedStake', 6_000_000n * E18);
  staking('rewardRate', E18);
  staking('totalRewardsFunded', 2_000_000n * E18);
  staking('totalPenaltiesCollected', 0n);
  staking('totalUnsettledRewards', 0n);
  toweli('balanceOf', 6_000_000n * E18);
}

/** What `useHook` reports to a visitor whose wallet chain is `chainId`. */
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

describe('mainnet farm reads do not depend on the wallet chain', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wagmiMock.reset();
    wagmiMock.setAccount({ address: undefined, isConnected: false });
    stubMainnet();
  });
  afterEach(() => vi.useRealTimers());

  describe.each(OFF_MAINNET)('a logged-out visitor whose wallet was last on %s', (_label, chainId) => {
    it('useLPFarming reports the mainnet LP farm', () => {
      const off = reportOn(useLPFarming, chainId);
      expect(off.totalStaked).toBe(5_000n * E18);
      expect(figures(off)).toEqual(figures(reportOn(useLPFarming, CHAIN_ID)));
    });

    it('useFarmStats reports the mainnet staking totals', () => {
      const off = reportOn(useFarmStats, chainId);
      expect(off.tvl).toBe('5,000,000 TOWELI');
      expect(figures(off)).toEqual(figures(reportOn(useFarmStats, CHAIN_ID)));
    });

    it('usePoolData reports the mainnet APR, not "0"', () => {
      const off = reportOn(usePoolData, chainId);
      expect(off.aprNum).toBeGreaterThan(0);
      expect(figures(off)).toEqual(figures(reportOn(usePoolData, CHAIN_ID)));
    });

    it('usePoolTVL reports the mainnet pool', () => {
      const off = reportOn(usePoolTVL, chainId);
      expect(off.isLoaded).toBe(true);
      expect(figures(off)).toEqual(figures(reportOn(usePoolTVL, CHAIN_ID)));
    });
  });

  it.each(OFF_MAINNET)('a CONNECTED wallet on %s still reads its mainnet LP position', (_label, chainId) => {
    // The position reads run too, so an LP staker on the wrong network sees the
    // stake they have -- FarmPage's WrongChainBanner tells them to switch before
    // acting -- rather than the never-staked panel.
    wagmiMock.setAccount({ address: USER, isConnected: true });
    const off = reportOn(useLPFarming, chainId);
    expect(off.stakedBalance).toBe(100n * E18);
    expect(off.positionUnread).toBe(false);
  });
});
