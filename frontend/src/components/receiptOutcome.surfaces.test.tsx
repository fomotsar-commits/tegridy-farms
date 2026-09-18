/**
 * Every toast-reporting receipt surface: a revert says reverted, and a receipt
 * nobody could read says "we can't tell" — with that surface's own resend cost.
 *
 * wagmi's waitForTransactionReceipt THROWS on a reverted receipt (it replays the
 * tx; lib/txErrors.ts has the measurement), so a real revert reaches these
 * surfaces on `isError`. Each one derived its revert as
 * `isSuccess && receipt.status !== 'success'` and never read `isError`, so a
 * revert was silent and so was an unreadable receipt. The assertions match
 * EACH surface's own copy, because in a mounted tree other hooks (useBribes,
 * useFarmActions…) can toast too — a generic /revert/ match would be satisfied
 * by a neighbour. The errors are the real viem types wagmi throws.
 *
 * Legs that only mount behind a tab and a data load (offer and loan cards,
 * the AMM's pool cards and create-pool step) are held by
 * hooks/receiptConsumers.guard.test.ts instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderHook } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError, parseEther } from 'viem';
import { toast } from 'sonner';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { renderWithProviders } from '../test-utils/render';
import { noteReplacement } from '../lib/txErrors';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const Div = ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>;
  const passthrough = new Proxy({}, { get: () => Div });
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    useReducedMotion: () => true,
  };
});

vi.mock('./ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 0, priceInEth: 0, ethUsd: 0, isLoaded: false, isStale: false }),
  useTOWELIPriceOptional: () => null,
}));

import { GaugeVoting } from './GaugeVoting';
import { LegacyStakingExit } from './farm/LegacyStakingExit';
import { OwnerAdminPanelV2 } from './launchpad/OwnerAdminPanelV2';
import { PoolAdminPanel, AMMSection } from './nftfinance/AMMSection';
import { NFTLendingSection } from './nftfinance/NFTLendingSection';
import { LendingSection } from './nftfinance/LendingSection';
import { VoteIncentivesSection } from './community/VoteIncentivesSection';
import { ETHRevenueClaim } from '../pages/DashboardPage';
import { useAirdropCampaign } from '../hooks/useAirdropCampaign';
import { useAirdropFactory } from '../hooks/useAirdropFactory';
import { useVestingStreams } from '../hooks/useVestingStreams';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const HASH = `0x${'fe'.repeat(32)}` as const;

type Surface = {
  name: string;
  mount: () => void;
  /** This surface's own revert copy. */
  reverted: RegExp;
  /** This surface's own resend cost, which only its unreadable warning carries. */
  repeat: RegExp;
};

const ui = (el: ReactElement) => () => {
  renderWithProviders(el);
};
const hook = (fn: () => unknown) => () => {
  renderHook(fn);
};

const SURFACES: Surface[] = [
  {
    name: 'GaugeVoting',
    mount: ui(<GaugeVoting />),
    reverted: /your vote was not recorded/i,
    repeat: /replaces the reveal secret saved in this browser/i,
  },
  {
    name: 'LegacyStakingExit',
    mount: ui(<LegacyStakingExit />),
    reverted: /Withdrawal reverted on-chain/i,
    repeat: /position is already closed/i,
  },
  {
    name: 'OwnerAdminPanelV2',
    mount: ui(<OwnerAdminPanelV2 dropAddress={OTHER} deployed />),
    reverted: /no admin change was applied/i,
    repeat: /applies the change a second time/i,
  },
  {
    name: 'AMM PoolAdminPanel',
    mount: ui(
      <PoolAdminPanel
        poolAddress={OTHER}
        poolType={0}
        spotPrice={parseEther('1')}
        delta={parseEther('0.1')}
        feeBps={0n}
        ethBalance={0n}
        onChange={() => {}}
      />,
    ),
    reverted: /pool settings were not changed/i,
    repeat: /withdrawal moves funds a second time/i,
  },
  {
    name: 'AMM trade tab (swap + approval legs)',
    mount: ui(<AMMSection />),
    reverted: /no NFTs or ETH changed hands/i,
    repeat: /trades a second time/i,
  },
  {
    name: 'NFTLendingSection lend tab',
    mount: ui(<NFTLendingSection />),
    reverted: /Offer creation reverted on-chain/i,
    repeat: /principal into a second offer/i,
  },
  {
    name: 'LendingSection lend tab',
    mount: ui(<LendingSection />),
    reverted: /Offer creation reverted on-chain/i,
    repeat: /principal into a second offer/i,
  },
  {
    name: 'VoteIncentivesSection withdrawPendingETH',
    mount: ui(<VoteIncentivesSection />),
    reverted: /ETH withdrawal reverted on-chain/i,
    repeat: /more ETH has come due/i,
  },
  {
    name: 'Dashboard ETHRevenueClaim',
    mount: ui(<ETHRevenueClaim address={WALLET} isWrongNetwork={false} />),
    reverted: /ETH claim reverted on-chain/i,
    repeat: /claims what has accrued since/i,
  },
  {
    name: 'useAirdropCampaign',
    mount: hook(() => useAirdropCampaign(OTHER, 0)),
    reverted: /Claim reverted on-chain/i,
    repeat: /allocation is already claimed/i,
  },
  {
    name: 'useAirdropFactory',
    mount: hook(() => useAirdropFactory()),
    reverted: /nothing was approved or funded/i,
    repeat: /second create funds another campaign/i,
  },
  {
    name: 'useVestingStreams',
    mount: hook(() => useVestingStreams()),
    reverted: /Release reverted on-chain/i,
    repeat: /only sends what has vested since/i,
  },
];

const errorToasts = () => vi.mocked(toast.error).mock.calls.map(([m]) => String(m));
const warnings = () =>
  vi.mocked(toast.warning).mock.calls.map(([title, opts]) => ({
    title: String(title),
    description: String((opts as { description?: string } | undefined)?.description ?? ''),
  }));

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.success).mockClear();
});

for (const s of SURFACES) {
  describe(s.name, () => {
    it('a revert wagmi THREW says reverted, and draws no "can\'t tell" warning', () => {
      wagmiMock.setWriteStatus({
        hash: HASH,
        receiptError: new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {}),
      });
      s.mount();

      expect(errorToasts().some((m) => s.reverted.test(m)), `error toasts: ${JSON.stringify(errorToasts())}`).toBe(true);
      expect(toast.warning, 'a revert was told it could not be confirmed').not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('an unreadable receipt says "we can\'t tell" with this surface\'s resend cost, and never "reverted"', () => {
      wagmiMock.setWriteStatus({ hash: HASH, receiptError: new TransactionReceiptNotFoundError({ hash: HASH }) });
      s.mount();

      const mine = warnings().filter((w) => s.repeat.test(w.description));
      expect(mine.length, `warnings: ${JSON.stringify(warnings())}`).toBeGreaterThan(0);
      expect(mine[0]!.title).toMatch(/couldn.?t confirm/i);
      expect(mine[0]!.description).toMatch(/can.?t tell whether it went through/i);
      expect(mine[0]!.description).toContain(HASH.slice(0, 10));
      expect(errorToasts().filter((m) => /revert|fail/i.test(m)), 'an unreadable receipt was called a failure').toEqual([]);
      expect(toast.success).not.toHaveBeenCalled();
    });

    // viem RESOLVES a replaced wait with the replacement's receipt, and a wallet
    // cancel's says success (lib/txErrors.receipt.test.ts). The shared mock gives
    // every wait in the tree that receipt, so no success toast may fire anywhere.
    it('a tx the wallet cancelled is not a success: no success toast, and it says cancelled', () => {
      const submitted = `0x${'c0'.repeat(32)}` as const;
      noteReplacement({ reason: 'cancelled', replacedTransaction: { hash: submitted } });
      wagmiMock.setWriteStatus({
        hash: submitted, isSuccess: true, receiptStatus: 'success', receiptHash: `0x${'0d'.repeat(32)}`,
      });
      s.mount();

      expect(vi.mocked(toast.success).mock.calls.map(([m]) => String(m)), 'a cancel read as this action').toEqual([]);
      const cancelled = warnings().filter((w) => /cancel/i.test(w.title));
      expect(cancelled.length, `warnings: ${JSON.stringify(warnings())}`).toBeGreaterThan(0);
      expect(cancelled[0]!.description).toMatch(/did not happen/i);
      expect(errorToasts().filter((m) => /revert|fail/i.test(m))).toEqual([]);
    });
  });
}
