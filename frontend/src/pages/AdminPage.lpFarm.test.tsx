// The admin LP Farming card printed `rewardRate()` raw.
//
// That storage slot is Synthetix-shaped: it keeps its last value after
// `periodFinish` — only the next notifyRewardAmount overwrites it — while earned()
// stops accruing at periodFinish. On mainnet, where the LP farm's period ended
// 2026-06-15, this card therefore reported the leftover 0.003307/sec as the farm's
// live rate: the exact trap lib/lpEmissions.ts documents, on the page an operator
// reads to decide whether the farm needs funding.
//
// The wagmi mock answers each batch entry BY QUERY (address + functionName), never
// by position, so reading the new periodFinish entry from the wrong index — or the
// LP rate from the staking contract's slot — shows up here as a wrong value.
//
// MUTATION CHECK against the pre-fix page: the ended and unread cases fail (both
// print 0.003307/sec). The running case is the negative control and passes both ways.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Address } from 'viem';
import { LP_FARMING_ADDRESS } from '../lib/constants';

const OWNER = '0x14898258122c0740106391e6e8e4f17F3b6D456E' as Address;

// `${address}:${functionName}` -> result. Anything absent answers as a failed read.
const reads = new Map<string, unknown>();
const key = (address: string, functionName: string) => `${address.toLowerCase()}:${functionName}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: OWNER, isConnected: true }),
  useChainId: () => 1,
  useChains: () => [{ id: 1, name: 'Ethereum', blockExplorers: { default: { url: 'https://etherscan.io' } } }],
  // owner() — the role gate's only single read.
  useReadContract: () => ({ data: OWNER, isLoading: false, refetch: vi.fn() }),
  useReadContracts: (opts?: { contracts?: ReadonlyArray<{ address: string; functionName: string }> }) => ({
    data: (opts?.contracts ?? []).map((c) => {
      const k = key(c.address, c.functionName);
      return reads.has(k)
        ? { status: 'success', result: reads.get(k) }
        : { status: 'failure', error: new Error('no stub') };
    }),
    error: null,
    refetch: vi.fn(),
  }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
}));

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/launcher/IntegratorFeesPanel', () => ({
  IntegratorFeesPanel: () => <div data-testid="fees-panel" />,
}));

import AdminPage from './AdminPage';

// Mainnet, lib/lpEmissions.ts:9-11.
const ENDED_PERIOD_FINISH = 1_781_493_095n; // 2026-06-15
const RESIDUAL_REWARD_RATE = 3_306_878_306_878_306n;
const RESIDUAL_TEXT = '0.003307/sec';

/** One label/value row of the LP Farming card, and only that card. */
function lpFarmRow(label: string): HTMLElement {
  const card = screen.getByRole('heading', { name: 'LP Farming' }).closest('.glass-card') as HTMLElement;
  return within(card).getByText(label).parentElement!;
}

beforeEach(() => {
  reads.clear();
  reads.set(key(LP_FARMING_ADDRESS, 'rewardRate'), RESIDUAL_REWARD_RATE);
  reads.set(key(LP_FARMING_ADDRESS, 'totalRawSupply'), 0n);
});

describe('AdminPage LP Farming card', () => {
  it('reports an ended period as paying nothing, not the rate left in storage', () => {
    reads.set(key(LP_FARMING_ADDRESS, 'periodFinish'), ENDED_PERIOD_FINISH);
    render(<AdminPage />);

    expect(lpFarmRow('Reward Rate')).not.toHaveTextContent(RESIDUAL_TEXT);
    expect(lpFarmRow('Reward Rate')).toHaveTextContent(/0\/sec.*ended/i);
    expect(lpFarmRow('Reward Period')).toHaveTextContent(/Ended \d/);
  });

  it('gives no verdict, and no rate, while periodFinish is unread', () => {
    // periodFinish deliberately absent: the stored rate cannot be vouched for, and
    // the unread period must not be reported as ended either.
    render(<AdminPage />);

    expect(lpFarmRow('Reward Rate')).not.toHaveTextContent(RESIDUAL_TEXT);
    // The card's whole verdict vocabulary, not just "ended": an unread period
    // passed off as never-funded is the same fabricated answer.
    expect(lpFarmRow('Reward Rate')).not.toHaveTextContent(/ended|never funded/i);
    expect(lpFarmRow('Reward Period')).not.toHaveTextContent(/ended|ends|never funded/i);
  });

  it('still shows the stored rate while the period is running', () => {
    reads.set(key(LP_FARMING_ADDRESS, 'periodFinish'), BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
    render(<AdminPage />);

    expect(lpFarmRow('Reward Rate')).toHaveTextContent(RESIDUAL_TEXT);
  });
});
