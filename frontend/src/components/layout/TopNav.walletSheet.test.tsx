/**
 * Off the Solana pages, the top bar's wallet button opens the wallet sheet:
 * Solana, or Ethereum (WalletSheet.tsx). Owner, 2026-10-03: the home page, the
 * Earn list and the doors must connect Solana too, and there the top bar's
 * Connect could only open the Ethereum list.
 *
 * RainbowKit's ConnectButton.Custom is rendered for real (its render prop is
 * called with the state each test sets), and the Solana side is the store
 * itself: a test reports the top bar's own connection the way TopBarSolana's
 * provider does.
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
vi.mock('sonner', () => ({ toast: vi.fn() }));
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
/** Every row opens its dialog a frame after the sheet has closed. */
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

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

  it('the Ethereum row opens RainbowKit, after the sheet has let go of the page', async () => {
    mount('/swap');
    openSheet();
    let scrollWhenOpened: string | null = null;
    rk.openConnectModal.mockImplementation(() => {
      scrollWhenOpened = document.body.style.overflow;
    });
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(ethereumRow());
    // Not in the same tick: the next dialog would read this sheet's scroll lock
    // as the page's own and put it back when it closed.
    expect(rk.openConnectModal).not.toHaveBeenCalled();
    await nextFrame();
    expect(rk.openConnectModal).toHaveBeenCalledTimes(1);
    expect(scrollWhenOpened).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("the Solana row, where a Solana connection is already mounted, opens that connection's list", async () => {
    const solOpen = vi.fn();
    mount('/');
    reportOwn({ open: solOpen });
    openSheet();
    fireEvent.click(solanaRow());
    expect(solOpen).not.toHaveBeenCalled();
    await nextFrame();
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(rk.openConnectModal).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe("TopNav: the Solana row loads the top bar's own connection on first use", () => {
  it('asks for it, says it is loading, and opens the list once it has loaded', async () => {
    const solOpen = vi.fn();
    mount('/');
    openSheet();
    expect(getSolanaSurfaceState().ownWanted).toBe(false);
    fireEvent.click(solanaRow());
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
    expect(solanaRow()).toHaveTextContent('Loading Solana wallets…');
    expect(solanaRow()).toHaveAttribute('aria-busy', 'true');
    // It loads, and is still restoring a saved wallet: the sheet keeps waiting.
    const owner = reportOwn({ open: solOpen, connecting: true });
    await nextFrame();
    expect(solOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    // The restore found nothing: the sheet closes and the list opens, once.
    reportOwn({ open: solOpen }, owner);
    await nextFrame();
    expect(solOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    reportOwn({ open: solOpen }, owner);
    await nextFrame();
    expect(solOpen).toHaveBeenCalledTimes(1);
  });

  it('opens no list when the saved wallet reconnected by itself: the address is the answer', async () => {
    const solOpen = vi.fn();
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    reportOwn({ open: solOpen, address: WALLET_ADDRESS });
    await nextFrame();
    expect(solOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(banner()).getByRole('button', { name: 'Your wallets' })).toHaveTextContent('So11…1112');
  });

  it('opens nothing later if the sheet was closed while it loaded', async () => {
    const solOpen = vi.fn();
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    reportOwn({ open: solOpen });
    await nextFrame();
    expect(solOpen).not.toHaveBeenCalled();
    // And the sheet, opened again, is not still "loading".
    openSheet();
    expect(solanaRow()).not.toHaveAttribute('aria-busy');
  });

  it('says when the Solana wallets did not load, and a tap tries again', () => {
    mount('/');
    openSheet();
    fireEvent.click(solanaRow());
    act(() => noteOwnSolanaFailed());
    expect(within(solanaRow()).getByRole('alert')).toHaveTextContent(
      'Couldn’t load Solana wallets. Check your connection and tap to try again.',
    );
    expect(solanaRow()).not.toHaveAttribute('aria-busy');
    fireEvent.click(solanaRow());
    expect(getSolanaSurfaceState()).toMatchObject({ ownWanted: true, ownFailed: false, ownAttempt: 1 });
    expect(solanaRow()).toHaveTextContent('Loading Solana wallets…');
  });
});

describe('TopNav: the chip, off the Solana pages, lists both networks', () => {
  // The owner's own case: Trust connected on Ethereum, and no way from the top
  // bar to Solana at all, because the chip opened RainbowKit's account dialog.
  it('with an Ethereum wallet connected, it opens "Your wallets" and offers Solana', async () => {
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
    await nextFrame();
    expect(rk.openAccountModal).toHaveBeenCalledTimes(1);
    expect(rk.openConnectModal).not.toHaveBeenCalled();
  });

  it('with only a Solana wallet connected, it shows that address and offers Ethereum', async () => {
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
    await nextFrame();
    expect(solOpen).toHaveBeenCalledTimes(1);
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
