// @vitest-environment jsdom
/**
 * The top bar's own Solana connection, end to end with the REAL pieces: the
 * wallet sheet, TopBarSolana's import(), SolanaProviders and the Solana wallet
 * list. Only RainbowKit, wagmi and the animation library are stand-ins.
 *
 * ⚠️ THE FIRST TEST IS A BUG THAT SHIPPED TO REVIEW (2026-10-03). On a first
 * Solana connect from a page with no Solana section, the list could open while
 * the wallet sheet still held the page's scroll lock; the list took that lock
 * for the page's own state and put it back when it closed. The page then no
 * longer scrolled until a reload, and keyboard focus was left on <body>. To
 * see it fail, make WalletSheet's waiting effect call `openSolanaList()`
 * itself instead of leaving it in `afterClose`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';

vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, {
    Custom: ({ children }: { children: (props: Record<string, unknown>) => ReactNode }) =>
      children({
        mounted: true,
        account: undefined,
        chain: undefined,
        openConnectModal: vi.fn(),
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
        ({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => (
          <div {...props}>{children}</div>
        ),
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
import { getSolanaSurfaceState, resetSolanaSurfaceForTests } from '../../lib/solanaSurface';

let goTo: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  useEffect(() => {
    goTo = navigate;
  }, [navigate]);
  return null;
}

function mount(path: string) {
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Navigator />
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const banner = () => screen.getByRole('banner');
const topConnect = () => within(banner()).getByRole('button', { name: 'Connect wallet' });
const solanaList = () => screen.findByRole('dialog', { name: /on Solana to continue/ }, { timeout: 15_000 });

afterEach(() => {
  cleanup();
  act(() => resetSolanaSurfaceForTests());
  localStorage.clear();
  document.body.style.overflow = '';
  vi.unstubAllEnvs();
});

describe("TopNav: the top bar's own Solana connection, with the real provider and list", () => {
  it('a first Solana connect from the home page leaves the page scrollable, and focus on the top bar', async () => {
    mount('/');
    expect(getSolanaSurfaceState()).toMatchObject({ surface: null, ownWanted: false });
    const connect = topConnect();
    connect.focus();
    fireEvent.click(connect);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Connect a wallet' })).getByRole('button', { name: /^Solana/ }));

    // The provider's code is loaded now, and the list opens.
    const list = await solanaList();
    expect(within(list).getByText('Trust Wallet')).toBeTruthy();
    // The sheet is gone, and the lock on the page is the list's own.
    expect(screen.queryByRole('dialog', { name: 'Connect a wallet' })).toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    expect(getSolanaSurfaceState()).toMatchObject({ page: false, ownWanted: true, ownFailed: false });

    fireEvent.click(within(list).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The page scrolls again, and focus is back where the visitor started.
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(topConnect());
  }, 30_000);

  // One live Solana connection per page: a page that has its own Solana
  // section must not have the top bar's beside it.
  it('unmounts on the way into a Solana page, and comes back on the way out', async () => {
    mount('/');
    fireEvent.click(topConnect());
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Connect a wallet' })).getByRole('button', { name: /^Solana/ }));
    const list = await solanaList();
    fireEvent.click(within(list).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getSolanaSurfaceState().surface).not.toBeNull();

    act(() => goTo('/earn/bayla'));
    // No page section is mounted in this test, so nothing answers at all.
    expect(getSolanaSurfaceState()).toMatchObject({ surface: null, page: false });
    expect(within(banner()).getByRole('button', { name: 'Connect a Solana wallet' })).toBeTruthy();

    act(() => goTo('/earn'));
    await waitFor(() => expect(getSolanaSurfaceState().surface).not.toBeNull());
    expect(getSolanaSurfaceState().page).toBe(false);
  }, 30_000);
});
