/**
 * The top bar's Connect on a Solana page connects Solana (lib/solanaSurface.ts).
 *
 * The owner tapped it on a Solana pool, picked Trust, and Trust offered
 * Ethereum, Robinhood Chain and Base (2026-10-02): it was RainbowKit, whose
 * WalletConnect proposal is eip155 only. Here RainbowKit's button is rendered
 * for real (its render prop is called with a disconnected state), so a page
 * that still gets the Ethereum button shows "Connect wallet" and fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';

const evmOpen = vi.hoisted(() => vi.fn());
/** RainbowKit's side: disconnected unless a test sets an account. */
const evm = vi.hoisted(() => ({ account: undefined as { displayName: string } | undefined }));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, {
    Custom: ({ children }: { children: (props: Record<string, unknown>) => ReactNode }) =>
      children({
        mounted: true,
        account: evm.account,
        chain: evm.account ? { unsupported: false } : undefined,
        openConnectModal: evmOpen,
        openAccountModal: vi.fn(),
        openChainModal: vi.fn(),
      }),
  }),
}));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }) }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

import { TopNav } from './TopNav';
import { ThemeProvider } from '../../contexts/ThemeContext';
import {
  cancelSolanaOpenRequest,
  setSolanaSurface,
  takeSolanaOpenRequest,
  type SolanaSurface,
} from '../../lib/solanaSurface';

const WALLET_ADDRESS = 'Bq6jovnQfVTFjmxL4dPt9xNNNnDBgvdhaXy3D4YqXTXV';

let goTo: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  useEffect(() => {
    goTo = navigate;
  }, [navigate]);
  return null;
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Navigator />
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const owners: object[] = [];
function report(surface: Partial<SolanaSurface> & { open: () => void }, owner: object = {}) {
  if (!owners.includes(owner)) owners.push(owner);
  act(() => setSolanaSurface(owner, { address: null, connecting: false, ...surface }));
  return owner;
}

const banner = () => screen.getByRole('banner');

afterEach(() => {
  act(() => {
    for (const o of owners.splice(0)) setSolanaSurface(o, null);
    cancelSolanaOpenRequest();
  });
  localStorage.clear();
  evmOpen.mockClear();
  toastMock.mockClear();
  evm.account = undefined;
});

describe('TopNav: Connect on a Solana page', () => {
  it('opens the page\'s Solana list, never the Ethereum one (the owner\'s Trust report)', () => {
    const solOpen = vi.fn();
    mount('/earn/bayla');
    report({ open: solOpen });
    fireEvent.click(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' }));
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(evmOpen).not.toHaveBeenCalled();
    expect(within(banner()).queryByRole('button', { name: 'Connect wallet' })).toBeNull();
  });

  it('shows the Solana address once connected, and a tap opens the list to switch', () => {
    const solOpen = vi.fn();
    mount('/pools');
    report({ open: solOpen, address: WALLET_ADDRESS });
    const chip = within(banner()).getByRole('button', { name: 'Solana wallet Bq6j…XTXV, switch or disconnect' });
    expect(chip).toHaveTextContent('Bq6j…XTXV');
    expect(within(banner()).queryByRole('button', { name: /^Connect/ })).toBeNull();
    fireEvent.click(chip);
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(evmOpen).not.toHaveBeenCalled();
  });

  it('is never hidden while the Solana section loads; a tap then waits for it', () => {
    mount('/earn/bayla');
    const button = within(banner()).getByRole('button', { name: 'Connect a Solana wallet' });
    expect(button).toBeEnabled();
    expect(button).toBeVisible();
    fireEvent.click(button);
    expect(evmOpen).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    // SolanaProviders' bridge takes it when it mounts (SolanaProviders.surface.test.tsx).
    act(() => {
      expect(takeSolanaOpenRequest()).toBe(true);
    });
    expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).not.toHaveAttribute('aria-busy');
  });

  it('dims, and refuses a second tap, while the page\'s wallet is connecting', () => {
    const solOpen = vi.fn();
    mount('/pools');
    report({ open: solOpen, connecting: true });
    const button = within(banner()).getByRole('button', { name: 'Connect a Solana wallet' });
    // aria-disabled, never disabled: the list hands focus back to this button.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('title', 'Connecting your Solana wallet…');
    fireEvent.click(button);
    expect(solOpen).not.toHaveBeenCalled();
  });

  it('drops a waiting tap when the visitor leaves the page', async () => {
    mount('/earn/bayla');
    fireEvent.click(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' }));
    expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).toHaveAttribute('aria-busy', 'true');
    act(() => goTo('/swap'));
    // Back on the Ethereum button: nothing is left waiting for a Solana page.
    expect(within(banner()).getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    act(() => goTo('/pools'));
    expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).not.toHaveAttribute('aria-busy');
  });

  it('stops waiting after ten seconds and says so, so a section that never loads leaves no dimmed, silent button', () => {
    vi.useFakeTimers();
    try {
      mount('/pools');
      fireEvent.click(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' }));
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).toHaveAttribute('aria-busy', 'true');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const button = within(banner()).getByRole('button', { name: 'Connect a Solana wallet' });
      expect(button).not.toHaveAttribute('aria-busy');
      expect(button).toBeEnabled();
      expect(takeSolanaOpenRequest()).toBe(false);
      // And it says so: a button that dims and then does nothing reads as broken.
      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(toastMock).toHaveBeenCalledWith('The Solana wallet list did not load on this page. Reload the page and try again.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads /dashboard by the room: Solana in BAYLA\'s, Ethereum in PEPE\'s', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    const first = mount('/dashboard');
    expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).toBeTruthy();
    first.unmount();
    localStorage.setItem('tegridy-bungalow', 'pepe');
    mount('/dashboard');
    expect(within(banner()).getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(within(banner()).queryByRole('button', { name: 'Connect a Solana wallet' })).toBeNull();
  });

  it('goes Solana on any page whose Solana section has mounted, even one the path misses', () => {
    const solOpen = vi.fn();
    mount('/somewhere-new');
    expect(within(banner()).getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    report({ open: solOpen });
    fireEvent.click(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' }));
    expect(solOpen).toHaveBeenCalledTimes(1);
  });

  it('wears exactly the Ethereum button\'s classes, so the 360px row keeps its width', () => {
    mount('/');
    const evmButton = within(banner()).getByRole('button', { name: 'Connect wallet' });
    const evmClass = evmButton.className;
    const evmStyle = evmButton.getAttribute('style');
    goToSolana();
    const solButton = within(banner()).getByRole('button', { name: 'Connect a Solana wallet' });
    expect(solButton.className).toBe(evmClass);
    expect(solButton.getAttribute('style')).toBe(evmStyle);
  });
});

function goToSolana() {
  act(() => goTo('/pools'));
}

describe('TopNav: the connected chip is one chip on both networks', () => {
  // Its width was measured once, for both (TopNav ACCOUNT_CHIP_CLASS): the 360px
  // row has no room to spare, so a class on one and not the other overflows it.
  it('gives the Ethereum chip and the Solana chip the same classes, dot included', () => {
    evm.account = { displayName: '0x71…5788' };
    mount('/');
    const evmChip = within(banner()).getByRole('button', { name: 'Account details' });
    const evmClass = evmChip.className;
    const evmDot = evmChip.querySelector('span')!.className;
    goToSolana();
    report({ open: vi.fn(), address: WALLET_ADDRESS });
    const solChip = within(banner()).getByRole('button', { name: /^Solana wallet / });
    expect(solChip.className).toBe(evmClass);
    expect(solChip.querySelector('span')!.className).toBe(evmDot);
    // The measured rules themselves: 4px of padding below 375px, no dot below 400px.
    expect(evmClass.split(' ')).toEqual(expect.arrayContaining(['px-1', 'min-[375px]:px-2', 'lg:px-3']));
    expect(evmClass).not.toMatch(/(^| )md:px-3( |$)/);
    expect(evmDot.split(' ')).toEqual(expect.arrayContaining(['hidden', 'min-[400px]:block']));
  });
});

describe('TopNav: Connect everywhere else is unchanged (RainbowKit)', () => {
  it.each(['/', '/swap', '/liquidity', '/earn', '/earn/toweli', '/earn/pepe', '/bayla'])('%s', (path) => {
    mount(path);
    const button = within(banner()).getByRole('button', { name: 'Connect wallet' });
    fireEvent.click(button);
    expect(evmOpen).toHaveBeenCalledTimes(1);
    expect(within(banner()).queryByRole('button', { name: 'Connect a Solana wallet' })).toBeNull();
  });
});
