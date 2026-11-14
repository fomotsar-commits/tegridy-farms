/**
 * Opening an NFT pool costs 0.006 ETH on top of the deposit (owner ruling 2026-10-25). The
 * create form reads the fee from the factory, says what it costs, adds it to what the wallet
 * sends, and says so when the factory is paused instead of letting a deploy fail in the wallet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('framer-motion', () => {
  const Div = ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>;
  const passthrough = new Proxy({}, { get: () => Div });
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

import { AMMSection } from './AMMSection';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const COLLECTION = '0x2222222222222222222222222222222222222222' as const;
const FEE = parseEther('0.006');

function openDeployStep(deposit: string) {
  renderWithProviders(<AMMSection />);
  fireEvent.click(screen.getByRole('tab', { name: /create pool/i }));
  const collectionInputs = screen.getAllByPlaceholderText('0x...');
  fireEvent.change(collectionInputs[collectionInputs.length - 1]!, { target: { value: COLLECTION } });
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: deposit } });
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setReadResult({ functionName: 'paused', result: false });
  wagmiMock.setReadResult({ functionName: 'POOL_OPENING_FEE', result: FEE });
});

describe('NFT pool create form: the opening fee', () => {
  it('says what opening costs and sends the deposit plus the fee', () => {
    openDeployStep('1');
    expect(screen.getByTestId('nft-pool-opening-fee')).toHaveTextContent(
      'Opening a pool costs 0.006 ETH, paid to the Tegridy treasury on top of your deposit.',
    );
    expect(screen.getByText('1.006 ETH')).toBeInTheDocument(); // "You send"

    fireEvent.click(screen.getByRole('button', { name: /deploy pool/i }));
    const call = wagmiMock.writeContract().mock.calls.at(-1)?.[0] as { functionName: string; value: bigint };
    expect(call.functionName).toBe('createPool');
    expect(call.value).toBe(parseEther('1') + FEE);
  });

  it('a paused factory is named, and Deploy waits', () => {
    wagmiMock.setReadResult({ functionName: 'paused', result: true });
    wagmiMock.setReadResult({ functionName: 'POOL_OPENING_FEE', result: undefined, status: 'failure' });
    openDeployStep('1');
    expect(screen.getByTestId('nft-pool-opening-fee')).toHaveTextContent('Opening new pools is paused on this factory.');
    expect(screen.getByRole('button', { name: /deploy pool/i })).toBeDisabled();
  });

  it('an unread fee on a live factory says so, and Deploy waits', () => {
    wagmiMock.setReadResult({ functionName: 'POOL_OPENING_FEE', result: undefined, status: 'failure' });
    openDeployStep('1');
    expect(screen.getByTestId('nft-pool-opening-fee')).toHaveTextContent('The pool-opening fee could not be read.');
    expect(screen.getByRole('button', { name: /deploy pool/i })).toBeDisabled();
  });
});
