/**
 * The add / remove form on each network it runs on (2026-10-18). Walked live on Base, the form
 * opened on Ethereum's TOWELI ("Your TOWELI balance could not be read": that address holds no
 * token on Base) and its token picker was empty ("No tokens found"), so a visitor had nothing
 * to pick without pasting an address. Each network now opens on its own headline token, the
 * one its swap opens on, and the picker lists that network's own tokens.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TOWELI_ADDRESS } from '../../lib/constants';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xdddddddddddddddddddddddddddddddddddddddd', isConnected: true }),
  useChainId: () => 1,
  useWalletClient: () => ({ data: undefined }),
  useBalance: () => ({ data: undefined, isError: false }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn(), isLoading: false }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button type="button">Connect</button> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
// The picker, reduced to the list it was handed.
vi.mock('./TokenSelectModal', () => ({
  TokenSelectModal: ({ tokens }: { tokens: ReadonlyArray<{ symbol: string; address: string }> }) => (
    <ul data-testid="picker">{tokens.map((t) => <li key={t.address} data-address={t.address}>{t.symbol}</li>)}</ul>
  ),
}));

import { LiquidityTab } from './LiquidityTab';

const tokenB = () => screen.getByText('Token B').closest('.mb-3')!.querySelector('button')!;
const pickerSymbols = () => [...screen.getByTestId('picker').querySelectorAll('li')].map((li) => li.textContent);
const pickerAddresses = () => [...screen.getByTestId('picker').querySelectorAll('li')].map((li) => li.getAttribute('data-address')!.toLowerCase());

describe('the add / remove form on each network', () => {
  it('Ethereum opens on ETH + TOWELI and lists Ethereum\'s curated tokens, as before', () => {
    render(<LiquidityTab chainId={1} />);
    expect(tokenB()).toHaveTextContent('TOWELI');
    fireEvent.click(tokenB());
    expect(pickerSymbols()).toEqual(expect.arrayContaining(['ETH', 'WETH', 'TOWELI', 'USDC']));
  });

  it('Base opens on ETH + USDC and lists Base\'s own tokens, never Ethereum\'s TOWELI', () => {
    render(<LiquidityTab chainId={8453} />);
    expect(tokenB()).toHaveTextContent('USDC');
    expect(screen.queryByText(/TOWELI/)).toBeNull();
    fireEvent.click(tokenB());
    expect(pickerSymbols()).toEqual(['ETH', 'WETH', 'USDC']);
    expect(pickerAddresses()).toContain('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(pickerAddresses()).not.toContain(TOWELI_ADDRESS.toLowerCase());
  });

  it('Robinhood Chain opens on ETH + USDG and lists Robinhood\'s own tokens', () => {
    render(<LiquidityTab chainId={4663} />);
    expect(tokenB()).toHaveTextContent('USDG');
    expect(screen.queryByText(/TOWELI/)).toBeNull();
    fireEvent.click(tokenB());
    expect(pickerSymbols()).toEqual(['ETH', 'WETH', 'USDG']);
    expect(pickerAddresses()).toContain('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  });

  it('a chain with no venue opens with Token B unpicked, and says which networks the form runs on', () => {
    render(<LiquidityTab chainId={42161} />);
    expect(tokenB()).toHaveTextContent('Select');
    // Both boxes are named by their placeholder, '0.0': e2e/liquidity.spec.ts finds them by
    // that name in Chromium, and an aria-label on one (tried 2026-10-18) hid it from all four.
    const [amountA, amountB] = screen.getAllByPlaceholderText('0.0');
    for (const box of [amountA, amountB]) expect(box).not.toHaveAttribute('aria-label');
    expect(amountA).toBeEnabled();
    expect(amountB).toBeDisabled();
    expect(screen.getByTestId('liquidity-submit')).toHaveTextContent('Pick token B');
    expect(screen.getByRole('alert')).toHaveTextContent('switch to Ethereum, Robinhood Chain or Base to view pool data');
  });
});
