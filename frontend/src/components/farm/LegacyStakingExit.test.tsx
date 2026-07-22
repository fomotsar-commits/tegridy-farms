import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { LegacyStakingExit } from './LegacyStakingExit';
import { LEGACY_STAKING_ADDRESSES } from '../../lib/constants';

// framer-motion passthrough (same shape as YieldCalculator.test.tsx).
vi.mock('framer-motion', () => {
  const passthrough = {
    div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    section: ({ children, ...props }: { children?: React.ReactNode }) => <section {...props}>{children}</section>,
    span: ({ children, ...props }: { children?: React.ReactNode }) => <span {...props}>{children}</span>,
    button: ({ children, ...props }: { children?: React.ReactNode }) => <button {...props}>{children}</button>,
  };
  return {
    motion: passthrough,
    m: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
  };
});

const USER = '0x1111111111111111111111111111111111111111' as const;
const [LEGACY_A, LEGACY_B] = LEGACY_STAKING_ADDRESSES;

// getPosition tuple: [amount, boostBps, lockEnd, lockDuration, autoMaxLock, canWithdraw]
const UNLOCKED_1000 = [1000000000000000000000n, 6056n, 1782443987n, 7776000n, false, true] as const;
const LOCKED_100 = [100000000000000000000n, 4000n, 99999999999n, 604800n, false, false] as const;

function stubPosition(contract: string, tokenId: bigint, position: readonly unknown[] | null) {
  wagmiMock.setReadResult({ address: contract, functionName: 'userTokenId', result: tokenId });
  if (position) {
    wagmiMock.setReadResult({ address: contract, functionName: 'getPosition', result: position });
    wagmiMock.setReadResult({ address: contract, functionName: 'EARLY_WITHDRAWAL_PENALTY_BPS', result: 2500n });
  }
}

describe('LegacyStakingExit', () => {
  beforeEach(() => wagmiMock.reset());

  it('renders nothing when the wallet is not connected', () => {
    render(<LegacyStakingExit />);
    expect(screen.queryByTestId('legacy-staking-exit')).toBeNull();
  });

  it('renders nothing when the connected wallet has no legacy position', () => {
    wagmiMock.setAccount({ address: USER, isConnected: true });
    stubPosition(LEGACY_A, 0n, null);
    stubPosition(LEGACY_B, 0n, null);
    render(<LegacyStakingExit />);
    expect(screen.queryByTestId('legacy-staking-exit')).toBeNull();
  });

  it('shows an unlocked position and sends withdraw(tokenId) to the right contract', () => {
    wagmiMock.setAccount({ address: USER, isConnected: true });
    stubPosition(LEGACY_A, 2n, UNLOCKED_1000);
    stubPosition(LEGACY_B, 0n, null);
    render(<LegacyStakingExit />);

    expect(screen.getByTestId('legacy-staking-exit')).toBeTruthy();
    expect(screen.getAllByText(/1,000 TOWELI/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Withdraw 1,000 TOWELI/ }));
    const write = wagmiMock.writeContract();
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0]![0] as { address: string; functionName: string; args: unknown[] };
    expect(call.address).toBe(LEGACY_A);
    expect(call.functionName).toBe('withdraw');
    expect(call.args).toEqual([2n]);
  });

  it('locked position requires a two-click confirm and sends earlyWithdraw', () => {
    wagmiMock.setAccount({ address: USER, isConnected: true });
    stubPosition(LEGACY_A, 0n, null);
    stubPosition(LEGACY_B, 1n, LOCKED_100);
    render(<LegacyStakingExit />);

    expect(screen.getByText(/early withdrawal pays a 25% penalty/i)).toBeTruthy();

    // First click arms the confirm; nothing is sent yet.
    fireEvent.click(screen.getByRole('button', { name: /Early withdraw/i }));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();

    // Second click (now labeled with the penalty) actually sends earlyWithdraw.
    fireEvent.click(screen.getByRole('button', { name: /Confirm −25% penalty/ }));
    const call = wagmiMock.writeContract().mock.calls[0]![0] as { address: string; functionName: string; args: unknown[] };
    expect(call.address).toBe(LEGACY_B);
    expect(call.functionName).toBe('earlyWithdraw');
    expect(call.args).toEqual([1n]);
  });

  it('never offers a stake path to the legacy contracts', () => {
    wagmiMock.setAccount({ address: USER, isConnected: true });
    stubPosition(LEGACY_A, 2n, UNLOCKED_1000);
    stubPosition(LEGACY_B, 1n, LOCKED_100);
    render(<LegacyStakingExit />);
    expect(screen.queryByRole('button', { name: /stake/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});
