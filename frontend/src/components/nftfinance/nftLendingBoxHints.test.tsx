// A Lend box holding text the offer cannot use says which values it takes (owner 2026-11-12).
//
// The form used to go quiet: an APR of 33343 (over the 1000% cap) hid the interest card and
// the timeline and kept the button faded, and a faded button never runs the toast that would
// have named the problem.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ offers: [], count: 0, live: true, loans: [] }))));

import { NFTLendingSection } from './NFTLendingSection';

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: '0x1111111111111111111111111111111111111111', isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
});

const box = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(box(name), { target: { value } });

describe('a Lend box whose text the offer cannot use says which values it takes', () => {
  it.each([
    ['APR (%)', '33343', 'lend-hint-apr'], // over the 1000% cap: the owner's case
    ['APR (%)', '14.555', 'lend-hint-apr'], // three decimals
    ['APR (%)', '0', 'lend-hint-apr'],
    ['Loan amount (WETH)', '0', 'lend-hint-amount'],
    ['Loans this offer can fund', '101', 'lend-hint-loans'],
    ['Loans this offer can fund', '0', 'lend-hint-loans'],
  ])('%s = %s', (name, value, testId) => {
    renderWithProviders(<NFTLendingSection />);
    type(name, value);
    const hint = screen.getByTestId(testId);
    expect(hint.textContent).not.toBe('');
    expect(box(name).getAttribute('aria-invalid')).toBe('true');
    expect(box(name).getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('the APR hint names the range and what the number means', () => {
    renderWithProviders(<NFTLendingSection />);
    type('APR (%)', '33343');
    expect(screen.getByTestId('lend-hint-apr').textContent).toBe('A yearly rate from 0.01 to 1000, at most two decimals: 14 means 14% a year.');
  });

  it('one specific NFT: a token number of 0 is not one', () => {
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('button', { name: 'One specific NFT' }));
    type('Token ID', '0');
    expect(screen.getByTestId('lend-hint-token')).toBeTruthy();
    type('Token ID', '1234');
    expect(screen.queryByTestId('lend-hint-token')).toBeNull();
  });

  it('says nothing for an empty box or a value it takes, and the interest card comes back', () => {
    renderWithProviders(<NFTLendingSection />);
    expect(screen.queryByTestId('lend-hint-amount')).toBeNull();
    expect(screen.queryByTestId('lend-hint-apr')).toBeNull();
    expect(screen.queryByTestId('lend-hint-loans')).toBeNull();
    type('Loan amount (WETH)', '0.02');
    type('APR (%)', '33343');
    expect(screen.queryByTestId('lend-default-outcome')).toBeNull();
    type('APR (%)', '14');
    type('Loans this offer can fund', '3');
    for (const id of ['lend-hint-amount', 'lend-hint-apr', 'lend-hint-loans']) expect(screen.queryByTestId(id)).toBeNull();
    expect(box('APR (%)').hasAttribute('aria-invalid')).toBe(false);
    expect(screen.getByTestId('lend-default-outcome')).toBeTruthy();
  });
});
