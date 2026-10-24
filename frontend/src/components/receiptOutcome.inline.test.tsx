/**
 * The surfaces that report a receipt INLINE rather than as a toast: a revert
 * reads as reverted, and a receipt nobody could read reads as "we can't tell".
 *
 * wagmi THROWS on a reverted receipt (lib/txErrors.ts), so each of these saw a
 * real revert on `isError`, which none of them read:
 *   - ShieldPositionCard's "reverted" line never rendered: a reverted repay
 *     showed nothing at all.
 *   - Step5_Deploy's revert panel never showed, and an unreadable deploy
 *     re-armed "Deploy Collection" in silence — a second click is a second
 *     collection.
 *   - The bungalow pools' "Last tx" line said "· pending" for good.
 * The errors below are the real viem types wagmi throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError, parseEther } from 'viem';

const USER = '0x1111111111111111111111111111111111111111' as const;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;
const TOKEN = '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2' as const;

const w = vi.hoisted(() => ({
  chainId: 1,
  receiptError: undefined as unknown,
  /** The wallet replaced the tx: viem RESOLVES with this other tx's success receipt. */
  replacedReason: undefined as 'cancelled' | 'replaced' | 'repriced' | undefined,
  reads: new Map<string, unknown>(),
}));

vi.mock('wagmi', async () => {
  const { vi: v } = await import('vitest');
  const idle = { isLoading: false, isSuccess: false, isError: false, error: null, data: undefined };
  return {
    useAccount: () => ({ address: USER, isConnected: true }),
    useChainId: () => w.chainId,
    useSwitchChain: () => ({ switchChain: () => {} }),
    useReadContract: () => ({ data: undefined, refetch: v.fn() }),
    useReadContracts: ({ contracts }: { contracts: { functionName: string }[] }) => ({
      data: contracts.map((q) =>
        w.reads.has(q.functionName)
          ? { status: 'success', result: w.reads.get(q.functionName) }
          : { status: 'failure', error: new Error(`unmocked ${q.functionName}`) },
      ),
      isLoading: false,
      refetch: () => Promise.resolve(),
    }),
    useWriteContract: () => ({
      writeContract: v.fn(),
      writeContractAsync: () => Promise.resolve(HASH),
      data: HASH,
      isPending: false,
    }),
    useSendTransaction: () => ({ sendTransaction: v.fn(), data: HASH, isPending: false, error: null }),
    useWaitForTransactionReceipt: ({ hash, onReplaced }: { hash?: string; onReplaced?: (r: unknown) => void }) => {
      if (hash && w.replacedReason) {
        onReplaced?.({ reason: w.replacedReason, replacedTransaction: { hash } });
        return {
          isLoading: false, isSuccess: true, isError: false, error: null,
          data: { status: 'success', transactionHash: `0x${'cd'.repeat(32)}`, logs: [], blockNumber: 1n },
        };
      }
      return hash && w.receiptError !== undefined
        ? { isLoading: false, isSuccess: false, isError: true, error: w.receiptError, data: undefined }
        : idle;
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const Div = ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>;
  const passthrough = new Proxy({}, { get: () => Div });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { ShieldPositionCard } from './shield/ShieldPositionCard';
import { Step5_Deploy } from './launchpad/wizard/Step5_Deploy';
import { initialState } from './launchpad/wizard/wizardReducer';
import { EvmLighthousePoolLive } from './bungalow/EvmLighthousePoolLive';
import { EvmLadderPoolLive } from './bungalow/EvmLadderPoolLive';
import { assessDeadlineHealth } from '../lib/shield/health';
import type { ShieldPosition } from '../lib/shield/positions';
import type { Bungalow } from '../lib/bungalows';

const REVERT = () => new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {});
const UNREAD = () => new TransactionReceiptNotFoundError({ hash: HASH });
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  w.chainId = 1;
  w.receiptError = undefined;
  w.replacedReason = undefined;
  w.reads = new Map();
});

describe('ShieldPositionCard', () => {
  const now = Math.floor(Date.now() / 1000);
  const position: ShieldPosition = {
    loanId: 4,
    venue: 'tegridy-nft-lending' as ShieldPosition['venue'],
    lendingContract: LENDING,
    collateralContract: null,
    tokenId: 7n,
    principal: parseEther('1'),
    borrower: USER,
    repaid: false,
    defaultClaimed: false,
    health: assessDeadlineHealth({
      effectiveDeadlineUnix: now + 7200,
      minGraceSeconds: 3600,
      defaultedOnChain: false,
      nowUnix: now,
    }),
    quotedRepayWei: parseEther('1.01'),
    quoteDetail: null,
  };

  it('a thrown revert shows the "reverted, nothing was repaid" line', () => {
    w.receiptError = REVERT();
    render(<ShieldPositionCard position={position} />);
    expect(screen.getByText(/reverted on-chain\. Nothing was repaid/i)).toBeInTheDocument();
    expect(text()).not.toMatch(/can.?t tell/i);
  });

  it('an unreadable receipt says we cannot tell, with the explorer link — never reverted', () => {
    w.receiptError = UNREAD();
    render(<ShieldPositionCard position={position} />);
    expect(screen.getByText(/can.?t tell whether it went\s+through/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /check it on the explorer/i }).getAttribute('href')).toContain(HASH);
    expect(text()).not.toMatch(/reverted on-chain/i);
    expect(text()).not.toMatch(/Repayment confirmed/i);
  });

  it('a repay the wallet cancelled says it did not happen, never "Repayment confirmed"', () => {
    w.replacedReason = 'cancelled';
    render(<ShieldPositionCard position={position} />);
    expect(screen.getByText(/cancelled in your wallet, so it did not happen/i)).toBeInTheDocument();
    expect(text(), 'a cancel read as the repay').not.toMatch(/Repayment confirmed/i);
  });
});

describe('Step5_Deploy', () => {
  const deploy = () => render(<Step5_Deploy state={initialState} dispatch={vi.fn()} onBack={vi.fn()} />);

  it('a thrown revert shows the revert panel', () => {
    w.receiptError = REVERT();
    deploy();
    expect(screen.getByText(/Deploy transaction reverted on-chain — no collection was created/)).toBeInTheDocument();
    expect(text()).not.toMatch(/can.?t tell/i);
  });

  it('an unreadable receipt warns that a second deploy is a second collection — never reverted', () => {
    w.receiptError = UNREAD();
    deploy();
    expect(screen.getByText(/can.?t tell whether the collection\s+was created/i)).toBeInTheDocument();
    expect(text()).toMatch(/a second deploy creates a second collection/i);
    expect(text()).not.toMatch(/reverted on-chain/i);
  });

  it('a deploy the wallet cancelled says no collection was created, and never "Deployed"', () => {
    w.replacedReason = 'cancelled';
    deploy();
    expect(screen.getByText(/cancelled in your wallet: an empty transaction confirmed in its place, so no collection was created/i)).toBeInTheDocument();
    expect(text(), 'a cancel read as the deploy, and locked the button').not.toMatch(/Deployed ✓/);
  });
});

describe('bungalow pools: the "Last tx" line', () => {
  const E18 = 10n ** 18n;
  const future = BigInt(now() + 30 * 86_400);
  function now() {
    return Math.floor(Date.now() / 1000);
  }
  const base = (stakePool: string) =>
    ({
      id: 'drb',
      name: 'DRB',
      symbol: 'DRB',
      chain: 'base',
      address: TOKEN,
      stakePool,
      status: 'SETTLED',
      tagline: 'x',
      thumb: '/art/x.jpg',
      live: false,
    }) as unknown as Bungalow & { stakePool: string };

  beforeEach(() => {
    w.chainId = 8453;
    w.reads = new Map<string, unknown>([
      ['totalSupply', 200n * E18],
      ['totalBoosted', 200n * E18],
      ['rewardSurplus', 60n * E18],
      ['balanceOf', 260n * E18],
      ['rewardRate', 1_000n],
      ['periodFinish', future],
      ['rewardsDuration', BigInt(60 * 86_400)],
      ['decimals', 18],
      ['earned', 5n * E18],
      ['allowance', 0n],
      ['positionsOf', []],
      ['stakingToken', TOKEN],
    ]);
  });

  const POOLS = [
    { name: 'EvmLighthousePoolLive', mount: () => render(<EvmLighthousePoolLive bungalow={base('0x00000000000000000000000000000000000c0FfE')} />), claim: /^claim/i },
    { name: 'EvmLadderPoolLive', mount: () => render(<EvmLadderPoolLive bungalow={base('0x00000000000000000000000000000000000dEcAf')} />), claim: /claim rewards/i },
  ];

  for (const p of POOLS) {
    it(`${p.name}: a thrown revert reads REVERTED, not pending`, async () => {
      w.receiptError = REVERT();
      p.mount();
      fireEvent.click(screen.getByRole('button', { name: p.claim }));
      expect(await screen.findByText(/REVERTED on-chain/)).toBeInTheDocument();
      expect(text()).not.toMatch(/· pending/);
    });

    it(`${p.name}: an unreadable receipt reads "can't tell", not pending and not reverted`, async () => {
      w.receiptError = UNREAD();
      p.mount();
      fireEvent.click(screen.getByRole('button', { name: p.claim }));
      expect(await screen.findByText(/can.?t tell whether it went through/i)).toBeInTheDocument();
      expect(text()).not.toMatch(/· pending/);
      expect(text()).not.toMatch(/REVERTED/);
    });

    it(`${p.name}: a tx the wallet cancelled reads cancelled, not confirmed`, async () => {
      w.replacedReason = 'cancelled';
      p.mount();
      fireEvent.click(screen.getByRole('button', { name: p.claim }));
      expect(await screen.findByText(/cancelled in your wallet, so it did not happen/i)).toBeInTheDocument();
      expect(text(), 'a cancel read as the claim').not.toMatch(/· confirmed/);
    });
  }
});
