/**
 * Off the Solana pages, the top bar's wallet button opens the wallet sheet:
 * Solana, or Ethereum (WalletSheet.tsx). Owner, 2026-10-03: the home page, the
 * Earn list and the doors must connect Solana too, and there the top bar's
 * Connect could only open the Ethereum list.
 *
 * RainbowKit's ConnectButton.Custom is rendered for real (its render prop is
 * called with the state each test sets), and the Solana side is the store
 * itself: a test reports the top bar's own connection the way TopBarSolana's
 * provider does. TopNav.ownSolana.test.tsx runs the same flow against the real
 * provider and the real Solana list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';

const rk = vi.hoisted(() => ({
  account: undefined as { displayName: string } | undefined,
  unsupported: false,
  openConnectModal: vi.fn(),
  openAccountModal: vi.fn(),
  openChainModal: vi.fn(),
}));
const toastMock = vi.hoisted(() => vi.fn());
const reloadMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('../../lib/reloadPage', () => ({ reloadPage: reloadMock }));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, {
    Custom: ({ children }: { children: (props: Record<string, unknown>) => ReactNode }) =>
      children({
        mounted: true,
        account: rk.account,
        chain: rk.account ? { unsupported: rk.unsupported } : undefined,
        openConnectModal: rk.openConnectModal,
        openAccountModal: rk.openAccountModal,
        openChainModal: rk.openChainModal,
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
// The lazy Solana provider is never loaded here: the store stands in for it.
vi.mock('./TopBarSolana', () => ({ TopBarSolana: () => null }));

import { TopNav } from './TopNav';
import { ThemeProvider } from '../../contexts/ThemeContext';
import {
  getSolanaSurfaceState,
  noteOwnSolanaFailed,
  resetSolanaSurfaceForTests,
  setSolanaSurface,
  type SolanaSurface,
} from '../../lib/solanaSurface';

const WALLET_ADDRESS = 'So11111111111111111111111111111111111111112';

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
/** The top bar's own Solana connection reports, as TopBarSolana's provider would. */
function reportOwn(surface: Partial<SolanaSurface> & { open: () => void }, owner: object = {}) {
  if (!owners.includes(owner)) owners.push(owner);
  act(() => setSolanaSurface(owner, { address: null, connecting: false, ...surface }, true));
  return owner;
}

const banner = () => screen.getByRole('banner');
const sheet = () => screen.getByRole('dialog');
const rows = () => within(sheet()).getAllByRole('listitem').map((li) => li.textContent);
const solanaRow = () => within(sheet()).getByRole('button', { name: /^Solana/ });
const ethereumRow = () => within(sheet()).getByRole('button', { name: /^Ethereum, Base, Robinhood Chain/ });

function openSheet(name: string | RegExp = 'Connect wallet') {
  fireEvent.click(within(banner()).getByRole('button', { name }));
  return sheet();
}

afterEach(() => {
  act(() => {
    for (const o of owners.splice(0)) setSolanaSurface(o, null);
    resetSolanaSurfaceForTests();
  });
  localStorage.clear();
  document.body.style.overflow = '';
  rk.account = undefined;
  rk.unsupported = false;
  rk.openConnectModal.mockReset();
  rk.openAccountModal.mockReset();
  rk.openChainModal.mockReset();
  toastMock.mockReset();
  reloadMock.mockReset();
  vi.useRealTimers();
});

describe('TopNav: Connect, off the Solana pages, asks which network', () => {
  it.each(['/', '/swap', '/liquidity', '/earn', '/earn/toweli', '/earn/pepe', '/bayla'])(
    '%s: the sheet lists Solana first, then Ethereum, and opens no list by itself',
    (path) => {
      mount(path);
      const dialog = openSheet();
      expect(dialog).toHaveTextContent('Connect a wallet');
      expect(dialog).toHaveTextContent('Pick a network. Each one connects on its own.');
      expect(rows()).toEqual([
        'SolanaPhantom, Trust, Jupiter, Solflare and more',
        'Ethereum, Base, Robinhood ChainMetaMask, Trust, Rainbow and more',
      ]);
      expect(rk.openConnectModal).not.toHaveBeenCalled();
    },
  );

  // The header's backdrop-filter makes it the containing block of a fixed
  // child: a dialog drawn inside it is laid out in the header's 64px.
  it('is drawn in <body>, not inside the header', () => {
    mount('/');
    openSheet();
    expect(banner()).not.toContainElement(sheet());
  });

  // ⚠️ The next dialog reads the page's scroll state as it opens. Opened while
  // this sheet still held its lock, the Solana list put that lock back when it
  // closed: a page that no longer scrolled until a reload (review, 2026-10-03).
  it('the Ethereum row opens RainbowKit only after the sheet has let go of the page', () => {
    mount('/swap');
    openSheet();
    let scrollWhenOpened: string | null = null;
    let sheetWhenOpened: Element | null = null;
    rk.openConnectModal.mockImplementation(() => {
      scrollWhenOpened = document.body.style.overflow;
      sheetWhenOpened = document.querySelector('[role="dialog"]');
    });
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(ethereumRow());
    expect(rk.openConnectModal).toHaveBeenCalledTimes(1);
    expect(scrollWhenOpened).toBe('');
    expect(sheetWhenOpened).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("the Solana row, where a Solana connection is already mounted, opens that connection's list, after the sheet has let go", () => {
    let scrollWhenOpened: string | null = null;
    const solOpen = vi.fn(() => {
      scrollWhenOpened = document.body.style.overflow;
    });
    mount('/');
    reportOwn({ open: solOpen });
    openSheet();
    fireEvent.click(solanaRow());
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(scrollWhenOpened).toBe('');
    expect(rk.openConnectModal).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The handler captured when the sheet was drawn may belong to a wallet that
  // has since been cleared; the one in the store now is the one to call.
  it('opens the list through the connection as it is NOW, not as it was when the sheet was drawn', () => {
    const stale = vi.fn();
    const current = vi.fn();
    mount('/');
    const owner = reportOwn({ open: stale });
    openSheet();
    reportOwn({ open: current }, owner);
    fireEvent.click(solanaRow());
    expect(current).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});

describe("TopNav: the Solana row loads the top bar's own connection on first use", () => {
  // The real provider's reports, in order: "connecting" until it knows
  // (SolanaProviders' bridge), "connecting" while a saved wallet is restored,
  // then the outcome.
  it('asks for it, says it is loading, waits out a restore, and then opens the list once', () => {
    let scrollWhenOpened: string | null = null;
    const solOpen = vi.fn(() => {
      scrollWhenOpened = document.body.style.overflow;
    });
    mount('/');
    openSheet();
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    fireEvent.click(solanaRow());
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
    expect(solanaRow()).toHaveTextContent('Loading Solana wallets…');
    expect(solanaRow()).toHaveAttribute('aria-busy', 'true');
    expect(within(sheet()).getByRole('status')).toHaveTextContent('Loading Solana wallets…');
    // It has loaded, and does not know yet whether a saved wallet will reconnect.
    const owner = reportOwn({ open: solOpen, connecting: true });
    expect(solOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(solanaRow()).toHaveTextContent('Connecting…');
    // The restore found nothing: the sheet closes, lets go of the page, and the list opens.
    reportOwn({ open: solOpen }, owner);
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(scrollWhenOpened).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Later reports open nothing more.
    reportOwn({ open: solOpen }, owner);
    reportOwn({ open: solOpen, connecting: true }, owner);
    reportOwn({ open: solOpen }, owner);
    expect(solOpen).toHaveBeenCalledTimes(1);
  });

  it('opens no list when the saved wallet reconnected by itself: the address is the answer', () => {
    const solOpen = vi.fn();
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    const owner = reportOwn({ open: solOpen, connecting: true });
    reportOwn({ open: solOpen, address: WALLET_ADDRESS }, owner);
    expect(solOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(banner()).getByRole('button', { name: 'Your wallets' })).toHaveTextContent('So11…1112');
  });

  it('opens nothing later if the sheet was closed while it loaded', () => {
    const solOpen = vi.fn();
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    reportOwn({ open: solOpen });
    expect(solOpen).not.toHaveBeenCalled();
    // And the sheet, opened again, is not still "loading".
    openSheet();
    expect(solanaRow()).not.toHaveAttribute('aria-busy');
  });

  // A failed chunk or stylesheet is not fetched again in the same tab, and after
  // a deploy its old name is gone: "try again" in place could never work.
  it('says when the Solana wallets did not load, and a tap reloads the page', () => {
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    act(() => noteOwnSolanaFailed());
    expect(solanaRow()).toHaveTextContent('Couldn’t load Solana wallets. Tap to reload the page.');
    expect(solanaRow()).not.toHaveAttribute('aria-busy');
    expect(within(sheet()).getByRole('status')).toHaveTextContent('Couldn’t load Solana wallets.');
    expect(reloadMock).not.toHaveBeenCalled();
    fireEvent.click(solanaRow());
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('says the same when it failed before the sheet was ever opened', () => {
    mount('/');
    act(() => noteOwnSolanaFailed());
    openSheet();
    expect(solanaRow()).toHaveTextContent('Couldn’t load Solana wallets. Tap to reload the page.');
    fireEvent.click(solanaRow());
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
  });

  it('stops saying "Loading" after fifteen seconds: a load that never ends is a failed one', () => {
    vi.useFakeTimers();
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    act(() => {
      vi.advanceTimersByTime(14_999);
    });
    expect(solanaRow()).toHaveTextContent('Loading Solana wallets…');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getSolanaSurfaceState().ownFailed).toBe(true);
    expect(solanaRow()).toHaveTextContent('Couldn’t load Solana wallets. Tap to reload the page.');
  });
});

describe('TopNav: the chip, off the Solana pages, lists both networks', () => {
  // The owner's own case: Trust connected on Ethereum, and no way from the top
  // bar to Solana at all, because the chip opened RainbowKit's account dialog.
  it('with an Ethereum wallet connected, it opens "Your wallets" and offers Solana', () => {
    rk.account = { displayName: '0x71…5788' };
    mount('/');
    const chip = within(banner()).getByRole('button', { name: 'Your wallets' });
    expect(chip).toHaveTextContent('0x71…5788');
    fireEvent.click(chip);
    expect(rk.openAccountModal).not.toHaveBeenCalled();
    expect(sheet()).toHaveTextContent('Your wallets');
    expect(sheet()).not.toHaveTextContent('Pick a network');
    expect(rows()).toEqual([
      'SolanaPhantom, Trust, Jupiter, Solflare and more',
      'Ethereum, Base, Robinhood ChainAccount and disconnect0x71…5788',
    ]);
    fireEvent.click(ethereumRow());
    expect(rk.openAccountModal).toHaveBeenCalledTimes(1);
    expect(rk.openConnectModal).not.toHaveBeenCalled();
  });

  // The chip keeps naming the Ethereum account, so nothing in the top bar
  // would show that the Solana connect worked.
  it('with an Ethereum wallet connected, a Solana connect made from the sheet is said in a toast', () => {
    rk.account = { displayName: '0x71…5788' };
    mount('/');
    const owner = reportOwn({ open: vi.fn() });
    fireEvent.click(within(banner()).getByRole('button', { name: 'Your wallets' }));
    fireEvent.click(solanaRow());
    expect(toastMock).not.toHaveBeenCalled();
    reportOwn({ open: vi.fn(), address: WALLET_ADDRESS }, owner);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('Solana wallet So11…1112 connected. Tap your wallet at the top to see both.');
    expect(within(banner()).getByRole('button', { name: 'Your wallets' })).toHaveTextContent('0x71…5788');
  });

  it('says nothing in a toast where the chip itself shows the new Solana address', () => {
    mount('/');
    const owner = reportOwn({ open: vi.fn() });
    openSheet();
    fireEvent.click(solanaRow());
    reportOwn({ open: vi.fn(), address: WALLET_ADDRESS }, owner);
    expect(within(banner()).getByRole('button', { name: 'Your wallets' })).toHaveTextContent('So11…1112');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('with only a Solana wallet connected, it shows that address and offers Ethereum', () => {
    const solOpen = vi.fn();
    mount('/earn');
    reportOwn({ open: solOpen, address: WALLET_ADDRESS });
    const chip = within(banner()).getByRole('button', { name: 'Your wallets' });
    expect(chip).toHaveTextContent('So11…1112');
    expect(within(banner()).queryByRole('button', { name: 'Connect wallet' })).toBeNull();
    fireEvent.click(chip);
    expect(rows()).toEqual([
      'SolanaSwitch wallet or disconnectSo11…1112',
      'Ethereum, Base, Robinhood ChainMetaMask, Trust, Rainbow and more',
    ]);
    fireEvent.click(solanaRow());
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('with both connected, it names the Ethereum account (the wallet these pages use) and lists both', () => {
    rk.account = { displayName: '0x71…5788' };
    mount('/swap');
    reportOwn({ open: vi.fn(), address: WALLET_ADDRESS });
    fireEvent.click(within(banner()).getByRole('button', { name: 'Your wallets' }));
    expect(within(banner()).getByRole('button', { name: 'Your wallets' })).toHaveTextContent('0x71…5788');
    expect(rows()).toEqual([
      'SolanaSwitch wallet or disconnectSo11…1112',
      'Ethereum, Base, Robinhood ChainAccount and disconnect0x71…5788',
    ]);
  });

  it('caps a long Ethereum name in its row, so the row keeps its own words', () => {
    rk.account = { displayName: 'averyveryverylongensname.eth' };
    mount('/');
    fireEvent.click(within(banner()).getByRole('button', { name: 'Your wallets' }));
    const value = within(ethereumRow()).getByTitle('averyveryverylongensname.eth');
    expect(value.className.split(' ')).toEqual(expect.arrayContaining(['truncate', 'max-w-[55%]']));
  });

  it('on a network the venue does not serve, Wrong Network still opens the network list directly', () => {
    rk.account = { displayName: '0x71…5788' };
    rk.unsupported = true;
    mount('/');
    fireEvent.click(within(banner()).getByRole('button', { name: 'Switch to correct network' }));
    expect(rk.openChainModal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the visitor moves to another page', () => {
    mount('/');
    openSheet();
    act(() => goTo('/swap'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
