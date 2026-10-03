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
import {
  SOLANA_CONNECT_WAIT_NOTICE_MS,
  getSolanaSurfaceState,
  resetSolanaSurfaceForTests,
} from '../../lib/solanaSurface';

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

/**
 * A Wallet Standard wallet named Phantom whose connect never answers: a locked
 * wallet, or an approval window nobody saw. It registers the way an extension
 * does, so the real provider wraps it in its own Standard adapter.
 */
let removeWallet: (() => void) | null = null;
function registerPhantomThatNeverAnswers() {
  const connects: unknown[] = [];
  const wallet = {
    version: '1.0.0',
    name: 'Phantom',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    chains: ['solana:mainnet'],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: (input?: unknown) => {
          connects.push(input);
          return new Promise<never>(() => {});
        },
      },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async () => [],
      },
    },
  };
  let unregister: (() => void) | undefined;
  const callback = ({ register }: { register: (w: unknown) => () => void }) => {
    unregister = register(wallet);
  };
  // Heard now if the app's side is already listening, else when it says it is ready.
  const onAppReady = (event: Event) => callback((event as CustomEvent).detail);
  window.addEventListener('wallet-standard:app-ready', onAppReady);
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  removeWallet = () => {
    window.removeEventListener('wallet-standard:app-ready', onAppReady);
    unregister?.();
  };
  return { connects };
}

// The provider's code loads in real time, whatever a test does to the clock.
const realSetTimeout = globalThis.setTimeout;
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 800 && !done(); i++) {
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 25));
    });
  }
  if (!done()) throw new Error(`never happened: ${what}`);
}

afterEach(() => {
  cleanup();
  act(() => resetSolanaSurfaceForTests());
  removeWallet?.();
  removeWallet = null;
  localStorage.clear();
  document.body.style.overflow = '';
  vi.unstubAllEnvs();
  vi.useRealTimers();
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

/**
 * The owner's Phantom, 2026-10-03: saved from an earlier visit, and locked. Its
 * restore never ends, and wallet-adapter-react says "connecting" for as long as
 * it runs. The sheet waited for that to end before it opened the list, so it
 * sat on "Connecting…" for ever. It waits as long as the card does, no longer.
 * The wait itself is never cancelled: an approval prompt may be open.
 */
describe('TopNav: a saved Solana wallet that never answers, with the real provider and list', () => {
  const sheetRow = () =>
    within(screen.getByRole('dialog', { name: 'Connect a wallet' })).getByRole('button', { name: /^Solana/ });
  const list = () => screen.queryByRole('dialog', { name: /on Solana to continue/ });

  /** The Solana row tapped on the home page; the saved Phantom's restore is now running, for ever. */
  async function waitingOnPhantom() {
    // Loaded before the clock is replaced, so nothing in it keeps a stand-in timer.
    await import('../solana/SolanaProviders');
    const phantom = registerPhantomThatNeverAnswers();
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount('/');
    fireEvent.click(topConnect());
    fireEvent.click(sheetRow());
    await until(
      () => phantom.connects.length > 0 && Boolean(getSolanaSurfaceState().surface?.connecting),
      "the restore of the saved wallet, through the top bar's own connection",
    );
    expect(phantom.connects).toEqual([{ silent: true }]);
    expect(sheetRow()).toHaveTextContent('Connecting…');
    return phantom;
  }

  it('the sheet stops waiting: it closes and the list opens, naming the wallet, and not before', async () => {
    const phantom = await waitingOnPhantom();
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS - 1);
    });
    expect(sheetRow()).toHaveTextContent('Connecting…');
    expect(list()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('dialog', { name: 'Connect a wallet' })).toBeNull();
    expect(list()).not.toBeNull();
    expect(within(list()!).getByRole('status')).toHaveTextContent(
      'Waiting for Phantom to answer. Open Phantom: it may be locked, or waiting for you to approve this site. Or pick another wallet below.',
    );
    // The wallet was asked once, and is still being waited on.
    expect(phantom.connects).toHaveLength(1);
    expect(getSolanaSurfaceState().surface).toMatchObject({ connecting: true, address: null });
    // The lock on the page is the list's own, and goes with it.
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(list()!).getByRole('button', { name: 'Close' }));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  }, 30_000);

  it('a tap on the row while it waits opens the list at once, and the delay opens no second one', async () => {
    const phantom = await waitingOnPhantom();
    fireEvent.click(sheetRow());
    expect(screen.queryByRole('dialog', { name: 'Connect a wallet' })).toBeNull();
    expect(list()).not.toBeNull();
    expect(within(list()!).getByRole('status')).toHaveTextContent('Waiting for Phantom to answer');
    expect(phantom.connects).toHaveLength(1);
    fireEvent.click(within(list()!).getByRole('button', { name: 'Close' }));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS * 3);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(phantom.connects).toHaveLength(1);
  }, 30_000);
});
