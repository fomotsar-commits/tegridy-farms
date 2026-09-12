/**
 * THE WALLET'S CHAIN DOES NOT DECIDE WHAT A MAINNET READ REPORTS -- the hooks
 * farmReadsWalletChain.test.ts left.
 *
 * Each hook here pins its reads to mainnet (`chainId: CHAIN_ID`, or the mainnet
 * public client) and ALSO gated `enabled` on `useChainId() === CHAIN_ID`
 * (R043 H-062-02). Since the multichain config (2443b584) useChainId() follows
 * the wallet, and wagmi persists it through a disconnect, so on Base or
 * Robinhood Chain every one of those reads was disabled: nothing was asked,
 * every figure collapsed to 0 or null, and no unread flag fired.
 *   - useNFTDropV2 (logged out too): a live sale read as "0/0" minted, "Closed";
 *   - useUserPosition: the never-staked form for a real staker, beside an LP
 *     section (#514) already showing the same wallet its mainnet LP stake;
 *   - useMyLoans: an empty loan list with neither failure flag set;
 *   - usePoints: a score from the swap count alone, SAVED to localStorage;
 *   - useNFTBoost: a JBAC holder reported as "unknown";
 *   - useZapPlan (logged out too): the venue fee unread -- not visible today,
 *     since the fee row renders only under a plan, and useSwapQuote's own
 *     chain gate keeps a plan from composing off mainnet;
 *   - useRestaking: every figure 0 -- dormant, as its address is zeroed.
 *
 * No gate here protected a write -- each write keeps its own chain guard -- so
 * they are gone. Per hook, this pins that on Base and on Robinhood Chain it
 * reports exactly what it reports on mainnet, after checking that one stubbed
 * figure landed, because two renders of an unread hook would be equal too.
 *
 * Two things deliberately stay chain-dependent, and are pinned elsewhere:
 * useNFTDropV2's `onMainnet`, the guard on mint()/refund() and the Mint button
 * (useNFTDropV2.test.ts, CollectionDetailV2.offMainnet.test.tsx), and
 * useAutoRefreshBoost's whole gate, which triggers a transaction
 * (useAutoRefreshBoost.test.ts).
 *
 * MUTATION CHECK: put `onMainnet` back in any of these hooks' `enabled` and
 * that hook's cases here fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Restaking is not deployed: TEGRIDY_RESTAKING_ADDRESS is zeroed, so its reads
// never run in production. Pin the gate for the day it ships with a stand-in
// address and every other constant real, as useRestaking.test.ts does.
vi.mock('../lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/constants')>()),
  TEGRIDY_RESTAKING_ADDRESS: '0x1111111111111111111111111111111111111111' as const,
}));
// useZapPlan's quote legs. Its fee read is the subject here; the quotes carry
// their own chain gate (useSwapQuote.ts) and are not.
vi.mock('./useSwapQuote', () => ({
  useSwapQuote: () => ({
    outputAmount: 0n,
    minimumReceived: 0n,
    isQuoteLoading: false,
    selectedRoute: 'tegridy',
    selectedOnChainRoute: { source: 'tegridy', output: 0n },
    path: [],
  }),
}));

import { useNFTDropV2 } from './useNFTDropV2';
import { useZapPlan } from './useZapPlan';
import { useMyLoans } from './useMyLoans';
import { useUserPosition } from './useUserPosition';
import { usePoints } from './usePoints';
import { useRestaking } from './useRestaking';
import { useNFTBoost } from './useNFTBoost';
import {
  CHAIN_ID, REFERRAL_SPLITTER_ADDRESS, STAKING_MONITOR_VIEW_ADDRESS, SWAP_FEE_ROUTER_ADDRESS,
  TEGRIDY_LP_ADDRESS, TEGRIDY_NFT_LENDING_ADDRESS, TEGRIDY_RESTAKING_ADDRESS, TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
} from '../lib/constants';

const E18 = 10n ** 18n;
const DAY = 86_400n;
const NOW = new Date('2026-09-11T12:00:00Z');
const NOW_SEC = BigInt(Math.floor(NOW.getTime() / 1000));
const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
const OTHER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;
const DROP = '0x2222222222222222222222222222222222222222';
// useNFTBoost.ts, duplicated so a moved address fails here loudly.
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
const GOLD = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3';
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** TegridyNFTLending's getLoan tuple for loan 0: USER borrowed 1 ETH, due in 30 days. */
const LOAN = [
  USER, OTHER, 3n, 42n, '0x4444444444444444444444444444444444444444',
  E18, 1_000n, NOW_SEC - DAY, NOW_SEC + 30n * DAY, false, false,
] as const;

/** The mainnet public client useMyLoans scans through. ONE object: wagmi memoises it. */
const mainnetClient = {
  readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === 'getLoan' && args?.[0] === 0n) return LOAN;
    throw new Error(`unstubbed read: ${functionName}`);
  },
};

/** One live mainnet deployment of everything these hooks read, stubbed per contract so shared function names cannot collide. */
function stubMainnet() {
  const at = (address: string) => (functionName: string, result: unknown) =>
    wagmiMock.setReadResult({ address, functionName, result });
  const staking = at(TEGRIDY_STAKING_ADDRESS);
  const monitor = at(STAKING_MONITOR_VIEW_ADDRESS);
  const toweli = at(TOWELI_ADDRESS);
  const drop = at(DROP);
  const restaking = at(TEGRIDY_RESTAKING_ADDRESS);

  // useUserPosition, usePoints, useRestaking: 1,000 TOWELI at 2x, locked 60 more days
  staking('userTokenId', 7n);
  staking('paused', false);
  staking('unsettledRewards', 0n);
  staking('rewardRate', E18);
  staking('totalBoostedStake', 6_000_000n * E18);
  monitor('getPosition', [1_000n * E18, 20_000n, NOW_SEC + 60n * DAY, 90n * DAY, false, false]);
  monitor('earned', 12n * E18);
  toweli('balanceOf', 500n * E18);
  toweli('allowance', 0n);
  // usePoints
  at(TEGRIDY_LP_ADDRESS)('balanceOf', 40n * E18);
  at(REFERRAL_SPLITTER_ADDRESS)('getReferralInfo', [2n, 0n, 0n]);
  // useNFTBoost
  at(JBAC)('balanceOf', 1n);
  at(GOLD)('balanceOf', 0n);
  // useNFTDropV2: a live public sale (contractURI unstubbed, so no metadata fetch)
  drop('mintPhase', 2);
  drop('currentPrice', parseEther('0.08'));
  drop('mintPrice', parseEther('0.08'));
  drop('totalSupply', 3n);
  drop('maxSupply', 100n);
  drop('maxPerWallet', 5n);
  drop('paidPerWallet', 0n);
  drop('paused', false);
  drop('revealed', false);
  drop('owner', OTHER);
  drop('creator', OTHER);
  // useZapPlan
  at(SWAP_FEE_ROUTER_ADDRESS)('feeBps', 25n);
  // useMyLoans. TegridyLending is zeroed, so only the NFT book exists.
  at(TEGRIDY_NFT_LENDING_ADDRESS)('loanCount', 1n);
  // useRestaking
  restaking('restakers', [7n, 1_000n * E18, 2_000n * E18, 0n, NOW_SEC - DAY, 0n]);
  restaking('pendingTotal', [3n * E18, E18]);
  restaking('totalRestaked', 50_000n * E18);
  restaking('totalBonusFunded', 100_000n * E18);
  restaking('totalBonusDistributed', 10_000n * E18);
  restaking('bonusRewardPerSecond', E18 / 10n);
}

/** What `useHook` reports to a wallet whose chain is `chainId`. */
function reportOn<T>(useHook: () => T, chainId: number): T {
  wagmiMock.setChainId(chainId);
  // usePoints persists what it computes; each render starts from nothing.
  localStorage.clear();
  const { result, unmount } = renderHook(useHook);
  const report = result.current;
  unmount();
  return report;
}

/** The same for a hook whose reads resolve after mount: waits until `landed` stops throwing. */
async function settledReportOn<T>(useHook: () => T, chainId: number, landed: (report: T) => void): Promise<T> {
  wagmiMock.setChainId(chainId);
  const { result, unmount } = renderHook(useHook);
  await waitFor(() => landed(result.current));
  const report = result.current;
  unmount();
  return report;
}

/** A report's figures. Its callbacks are re-created on every render and are not the subject. */
function figures(report: object, ...except: string[]) {
  return Object.fromEntries(
    Object.entries(report).filter(([key, v]) => typeof v !== 'function' && !except.includes(key)),
  );
}

describe('mainnet reads do not depend on the wallet chain', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    wagmiMock.reset();
    stubMainnet();
  });
  afterEach(() => vi.useRealTimers());

  describe.each(OFF_MAINNET)('a logged-out visitor whose wallet was last on %s', (_label, chainId) => {
    beforeEach(() => wagmiMock.setAccount({ address: undefined, isConnected: false }));

    it('useNFTDropV2 reports the live mainnet sale, not a closed and empty one', () => {
      const useDrop = () => useNFTDropV2(DROP);
      const off = reportOn(useDrop, chainId);
      expect(off.totalSupply).toBe(3);
      expect(off.phaseLabel).toBe('Public');
      const on = reportOn(useDrop, CHAIN_ID);
      // The one field that follows the wallet: it is the write guard.
      expect([off.onMainnet, on.onMainnet]).toEqual([false, true]);
      expect(figures(off, 'onMainnet')).toEqual(figures(on, 'onMainnet'));
    });

    it('useZapPlan reports the mainnet venue fee', () => {
      const useZap = () => useZapPlan({ venueId: 'lp-farm', inputToken: null, amountIn: 0n, slippagePct: 0.5 });
      const off = reportOn(useZap, chainId);
      expect(off.routerFeeBps).toBe(25);
      expect(figures(off)).toEqual(figures(reportOn(useZap, CHAIN_ID)));
    });
  });

  describe.each(OFF_MAINNET)('a wallet CONNECTED on %s', (_label, chainId) => {
    beforeEach(() => wagmiMock.setAccount({ address: USER, isConnected: true }));

    it('useUserPosition reports the mainnet staking position, not the never-staked form', () => {
      // The inconsistency #514 left: LPFarmingSection showed this wallet its
      // mainnet LP stake while StakingCard, fed by this hook, showed no stake.
      const off = reportOn(useUserPosition, chainId);
      expect(off.hasPosition).toBe(true);
      expect(off.stakedAmount).toBe(1_000n * E18);
      expect(off.positionUnread).toBe(false);
      expect(figures(off)).toEqual(figures(reportOn(useUserPosition, CHAIN_ID)));
    });

    it('usePoints scores the mainnet position, not the swap count alone', () => {
      const off = reportOn(usePoints, chainId);
      expect(off.onChainMetrics?.stakedAmount).toBe(1_000n * E18);
      expect(off.onChainMetrics?.lpBalance).toBe(40n * E18);
      expect(figures(off)).toEqual(figures(reportOn(usePoints, CHAIN_ID)));
    });

    it('useNFTBoost confirms a mainnet JBAC rather than calling it unknown', () => {
      const off = reportOn(useNFTBoost, chainId);
      expect(off.holdsJBAC).toBe(true);
      expect(figures(off)).toEqual(figures(reportOn(useNFTBoost, CHAIN_ID)));
    });

    it('useRestaking reports the mainnet restaking position', () => {
      const off = reportOn(useRestaking, chainId);
      expect(off.isRestaked).toBe(true);
      expect(off.totalRestaked).toBe(50_000n * E18);
      expect(figures(off)).toEqual(figures(reportOn(useRestaking, CHAIN_ID)));
    });

    it('useMyLoans finds the mainnet loan rather than an empty list', async () => {
      wagmiMock.setPublicClient(mainnetClient);
      const found = (report: ReturnType<typeof useMyLoans>) =>
        expect(report.loans.map((l) => [l.source, l.id, l.role])).toEqual([['nft', 0, 'borrower']]);
      const off = await settledReportOn(useMyLoans, chainId, found);
      expect(off.loansUnread).toBe(false);
      expect(figures(off)).toEqual(figures(await settledReportOn(useMyLoans, CHAIN_ID, found)));
    });
  });
});
