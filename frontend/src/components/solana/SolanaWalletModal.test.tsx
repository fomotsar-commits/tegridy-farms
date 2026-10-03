// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  BaseMessageSignerWalletAdapter,
  WalletNotReadyError,
  WalletReadyState,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import { orderWallets } from '../../lib/solanaWalletOrder';
import { useSolanaConnect } from './useSolanaConnect';
import { SolanaConnectButton } from './SolanaConnectButton';
import { SOLANA_HANDOFF_PARAM } from '../../lib/solanaSurface';

const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts.toast }));

/**
 * The Solana connect modal, mounted inside the REAL WalletProvider — the
 * select → auto-connect handoff and the Standard-wallet merge are the parts
 * that break quietly, so none of it is mocked. Only the wallets are fakes.
 *
 * The first test is the owner's bug (2026-09-24): a visitor with Phantom's
 * extension opened the BAYLA card's wallet list and found no Trust, because
 * upstream folds every wallet that is not installed behind "More options"
 * once one is. It is run against upstream's modal too, and must FAIL there —
 * a guard that passes on the code it guards against is no guard.
 */

const WSOL = 'So11111111111111111111111111111111111111112';

class FakeWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName;
  url: string;
  icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);
  connectCalls = 0;
  /** The address a real adapter would build its app link from: read at connect(). */
  hrefAtConnect: string | null = null;
  private _readyState: WalletReadyState;
  private _publicKey: PublicKey | null = null;

  constructor(name: string, readyState: WalletReadyState) {
    super();
    this.name = name as WalletName;
    this.url = `https://example.test/get-${name.toLowerCase().replace(/\s+/g, '-')}`;
    this._readyState = readyState;
  }

  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return this._readyState;
  }
  // A stored wallet is restored on mount through autoConnect; the fakes stay
  // quiet there so every connect counted below came from a click.
  override async autoConnect() {}
  async connect() {
    this.connectCalls += 1;
    this.hrefAtConnect = window.location.href;
    if (this._readyState === WalletReadyState.NotDetected) {
      const error = new WalletNotReadyError();
      this.emit('error', error);
      throw error;
    }
    this._publicKey = new PublicKey(WSOL);
    this.emit('connect', this._publicKey);
  }
  async disconnect() {
    this._publicKey = null;
    this.emit('disconnect');
  }
  async signTransaction<T>(transaction: T): Promise<T> {
    return transaction;
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return message;
  }
}

/** What a visitor with only Phantom's extension installed has on desktop. */
function phantomVisitor() {
  return {
    phantom: new FakeWallet('Phantom', WalletReadyState.Installed),
    trust: new FakeWallet('Trust', WalletReadyState.NotDetected),
    metamask: new FakeWallet('MetaMask', WalletReadyState.NotDetected),
    coinbase: new FakeWallet('Coinbase Wallet', WalletReadyState.NotDetected),
  };
}

function Opener() {
  const { setVisible } = useWalletModal();
  return (
    <button type="button" onClick={() => setVisible(true)}>
      open wallets
    </button>
  );
}

function ConnectButton() {
  const onClick = useSolanaConnect();
  return (
    <button type="button" onClick={onClick}>
      connect
    </button>
  );
}

function mount(adapters: FakeWallet[], Modal: (p: { children: ReactNode }) => ReactNode = SolanaWalletModalProvider) {
  return render(
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={adapters} autoConnect>
        <Modal>
          <Opener />
          <ConnectButton />
        </Modal>
      </WalletProvider>
    </ConnectionProvider>,
  );
}

async function openList() {
  fireEvent.click(screen.getByRole('button', { name: 'open wallets' }));
  return screen.findByRole('dialog');
}

/**
 * Lets the mount-time restore of a saved wallet finish. While it runs the
 * provider reports `connecting`, and a click read from that render does not
 * connect. The restore is microtasks only: an awaited act() drains them and
 * commits the re-render they queue. findByRole races that commit against a timer.
 */
async function restoreSettled() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * The invariant: every wallet the provider offers has a row a visitor can see
 * and reach — in the dialog, in the tab order, not folded. Throws otherwise.
 */
function assertEveryWalletReachable(dialog: HTMLElement, names: string[]) {
  for (const name of names) {
    const row = within(dialog)
      .getAllByRole('button', { hidden: true })
      .find((b) => b.textContent?.includes(name));
    if (!row) throw new Error(`no row for ${name}`);
    if (row.tabIndex < 0) throw new Error(`${name} is out of the tab order (folded)`);
    if (row.closest('[aria-hidden="true"], .wallet-adapter-collapse')) {
      throw new Error(`${name} sits inside a collapsed section`);
    }
  }
  if (within(dialog).queryByText(/More options|View options/)) {
    throw new Error('the list still folds wallets behind a toggle');
  }
}

beforeEach(() => {
  localStorage.clear();
  toasts.toast.mockClear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('SolanaWalletModal — nothing is folded away', () => {
  it('a Phantom-extension visitor still sees Trust, MetaMask and Coinbase Wallet', async () => {
    const w = phantomVisitor();
    mount(Object.values(w));
    const dialog = await openList();
    assertEveryWalletReachable(dialog, ['Phantom', 'Trust', 'MetaMask', 'Coinbase Wallet']);
    // Trust is shown under the name the EVM modal uses, while its adapter
    // keeps the dedupe name "Trust".
    expect(within(dialog).getByText('Trust Wallet')).toBeTruthy();
  });

  it('the same visitor on upstream’s modal is the bug — this check fails there', async () => {
    const w = phantomVisitor();
    mount(Object.values(w), WalletModalProvider as (p: { children: ReactNode }) => ReactNode);
    const dialog = await openList();
    expect(() =>
      assertEveryWalletReachable(dialog, ['Phantom', 'Trust', 'MetaMask', 'Coinbase Wallet']),
    ).toThrow();
  });

  it('every row says what a click will do', async () => {
    const phantom = new FakeWallet('Phantom', WalletReadyState.Installed);
    const trust = new FakeWallet('Trust', WalletReadyState.Loadable);
    const metamask = new FakeWallet('MetaMask', WalletReadyState.NotDetected);
    mount([metamask, trust, phantom]);
    const dialog = await openList();
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['PhantomDetected', 'Trust WalletOpen app', 'MetaMaskInstall']);
  });
});

describe('SolanaWalletModal — order', () => {
  it('detected first, then the offered order, then everything else as given', () => {
    // Glow and Nightly stand for wallets this venue does not offer (they only
    // ever arrive as Wallet Standard registrations); the rest are offered.
    const wallets = [
      new FakeWallet('Glow', WalletReadyState.NotDetected),
      new FakeWallet('Backpack', WalletReadyState.NotDetected),
      new FakeWallet('Coinbase Wallet', WalletReadyState.NotDetected),
      new FakeWallet('MetaMask', WalletReadyState.Installed),
      new FakeWallet('Trust', WalletReadyState.Loadable),
      new FakeWallet('Nightly', WalletReadyState.Installed),
      new FakeWallet('Solflare', WalletReadyState.Loadable),
      new FakeWallet('Phantom', WalletReadyState.NotDetected),
    ].map((adapter) => ({ adapter, readyState: adapter.readyState }));
    expect(orderWallets(wallets).map((w) => w.adapter.name)).toEqual([
      'MetaMask',
      'Nightly',
      'Phantom',
      'Trust',
      'Coinbase Wallet',
      'Solflare',
      'Backpack',
      'Glow',
    ]);
  });
});

describe('SolanaWalletModal — clicks', () => {
  it('a wallet that is not installed opens its install page and is NOT selected', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const w = phantomVisitor();
    mount(Object.values(w));
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('Trust Wallet'));
    expect(open).toHaveBeenCalledWith(w.trust.url, '_blank', 'noopener,noreferrer');
    expect(localStorage.getItem('walletName')).toBeNull();
    expect(w.trust.connectCalls).toBe(0);
    // The list stays up, so the visitor can still pick a wallet they have.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('picking a reachable wallet selects it, closes, and connects it once', async () => {
    const w = phantomVisitor();
    mount(Object.values(w));
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('Phantom'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(localStorage.getItem('walletName') ?? 'null')).toBe('Phantom');
    await waitFor(() => expect(w.phantom.connectCalls).toBe(1));
    expect(w.trust.connectCalls + w.metamask.connectCalls + w.coinbase.connectCalls).toBe(0);
  });

  it('picking the wallet that is already selected connects it (upstream did nothing)', async () => {
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    const trust = new FakeWallet('Trust', WalletReadyState.Loadable);
    mount([new FakeWallet('Phantom', WalletReadyState.NotDetected), trust]);
    await restoreSettled();
    const dialog = await openList();
    expect(trust.connectCalls).toBe(0);
    fireEvent.click(within(dialog).getByText('Trust Wallet'));
    expect(trust.connectCalls).toBe(1);
  });
});

describe('SolanaWalletModal — dialog behaviour', () => {
  it('is labelled by its real title, takes focus, and gives it back on Escape', async () => {
    mount(Object.values(phantomVisitor()));
    const opener = screen.getByRole('button', { name: 'open wallets' });
    opener.focus();
    const dialog = await openList();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Connect a wallet on Solana to continue');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' })));
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('Tab from outside the dialog brings focus back in', async () => {
    mount(Object.values(phantomVisitor()));
    const dialog = await openList();
    (document.body as HTMLElement).focus();
    screen.getByRole('button', { name: 'open wallets' }).focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('clicking the backdrop closes it', async () => {
    mount(Object.values(phantomVisitor()));
    const dialog = await openList();
    fireEvent.mouseDown(dialog.querySelector('.wallet-adapter-modal-overlay')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('useSolanaConnect — a saved wallet that is not installed', () => {
  it('opens the list instead of the install page, so the visitor can pick again', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    const trust = new FakeWallet('Trust', WalletReadyState.NotDetected);
    mount([new FakeWallet('Phantom', WalletReadyState.Installed), trust]);
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(trust.connectCalls).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('still connects a saved INSTALLED wallet directly, without the list', async () => {
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    const phantom = new FakeWallet('Phantom', WalletReadyState.Installed);
    mount([phantom, new FakeWallet('Trust', WalletReadyState.NotDetected)]);
    // Mid-restore, the hook rightly opens the list instead.
    await restoreSettled();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(phantom.connectCalls).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('useSolanaConnect — a saved "Open app" wallet on a phone', () => {
  // A phone visitor tapped "MetaMask — Open app" without the MetaMask app.
  // The handoff returns without throwing, so the choice stays saved. Before
  // the fix every later Connect tap handed them to MetaMask again and the
  // list never came back; the BAYLA cards have no other way to reach it.
  it('opens the list instead of handing the page to the app again', async () => {
    localStorage.setItem('walletName', JSON.stringify('MetaMask'));
    const metamask = new FakeWallet('MetaMask', WalletReadyState.Loadable);
    mount([new FakeWallet('Phantom', WalletReadyState.Loadable), metamask]);
    await restoreSettled();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    const dialog = await screen.findByRole('dialog');
    expect(metamask.connectCalls).toBe(0);
    // Someone who does have the app gets there from the list, one tap later.
    fireEvent.click(within(dialog).getByText('MetaMask'));
    await waitFor(() => expect(metamask.connectCalls).toBe(1));
  });

  it('and picking a different wallet from that list is possible', async () => {
    localStorage.setItem('walletName', JSON.stringify('MetaMask'));
    const phantom = new FakeWallet('Phantom', WalletReadyState.Loadable);
    const metamask = new FakeWallet('MetaMask', WalletReadyState.Loadable);
    mount([phantom, metamask]);
    await restoreSettled();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Phantom'));
    await waitFor(() => expect(phantom.connectCalls).toBe(1));
    expect(metamask.connectCalls).toBe(0);
    expect(JSON.parse(localStorage.getItem('walletName') ?? 'null')).toBe('Phantom');
  });
});

/**
 * The top bar's address opens this list while a wallet is connected
 * (lib/solanaSurface.ts, 2026-10-02). Before, no button opened it then, so it
 * still said "Connect a wallet…", marked the wallet in use only "Detected",
 * and the Solana pages had no way to disconnect at all.
 */
describe('SolanaWalletModal — opened while connected', () => {
  async function connectPhantom() {
    const phantom = new FakeWallet('Phantom', WalletReadyState.Installed);
    const trust = new FakeWallet('Trust', WalletReadyState.Installed);
    mount([phantom, trust]);
    const first = await openList();
    expect(first).toHaveTextContent('Connect a wallet on Solana to continue');
    fireEvent.click(within(first).getByText('Phantom'));
    await waitFor(() => expect(phantom.connectCalls).toBe(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return { phantom, trust };
  }

  it('says Switch, names the wallet in use, and marks its row Connected', async () => {
    await connectPhantom();
    const dialog = await openList();
    expect(dialog).toHaveTextContent('Switch Solana wallet');
    expect(dialog).not.toHaveTextContent('Connect a wallet on Solana to continue');
    expect(dialog).toHaveTextContent('Connected as So11…1112.');
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['PhantomConnected', 'Trust WalletDetected']);
  });

  it('closes on a tap of the wallet in use, and connects nothing again', async () => {
    const { phantom } = await connectPhantom();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('Phantom'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(phantom.connectCalls).toBe(1);
    expect(phantom.publicKey).not.toBeNull();
  });

  it('has a Disconnect, which disconnects and closes', async () => {
    const { phantom } = await connectPhantom();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(phantom.publicKey).toBeNull());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // And the list is the connect list again.
    const again = await openList();
    expect(again).toHaveTextContent('Connect a wallet on Solana to continue');
    expect(within(again).queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(within(again).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['PhantomDetected', 'Trust WalletDetected']);
  });
});

/**
 * A wallet that does not answer (owner, 2026-10-03: "it won't even recognize my
 * phantom wallet"). A connect waits on the wallet for as long as the wallet
 * takes; a locked wallet, or an approval window nobody saw, takes for ever. For
 * that whole wait every Connect button was switched off and nothing named the
 * wallet being waited on, so the page looked as if it could not see the wallet
 * at all, and the list that would have let the visitor pick another one could
 * not be opened. Run inside the real WalletProvider, with a wallet whose
 * connect never answers.
 *
 * Nothing here cancels the wait: a person reading an approval prompt must not
 * have it pulled away from them.
 */
describe('a wallet that never answers is not a dead end', () => {
  class HungWallet extends FakeWallet {
    override async connect(): Promise<void> {
      this.connectCalls += 1;
      await new Promise<void>(() => {});
    }
  }

  function mountCard(adapters: FakeWallet[]) {
    return render(
      <ConnectionProvider endpoint="http://127.0.0.1:8899">
        <WalletProvider wallets={adapters} autoConnect>
          <SolanaWalletModalProvider>
            <Opener />
            <SolanaConnectButton />
          </SolanaWalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>,
    );
  }

  /** A remembered Phantom, pressed once: its connect is now waiting for ever. */
  async function waitingOnPhantom() {
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    const phantom = new HungWallet('Phantom', WalletReadyState.Installed);
    const backpack = new FakeWallet('Backpack', WalletReadyState.Installed);
    mountCard([phantom, backpack]);
    await restoreSettled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Solana Wallet' }));
    const waiting = await screen.findByRole('button', { name: 'Connecting…' });
    expect(phantom.connectCalls).toBe(1);
    return { phantom, backpack, waiting };
  }

  it('the card stays pressable while it waits, and a press opens the wallet list', async () => {
    const { phantom, waiting } = await waitingOnPhantom();
    expect(waiting).toBeEnabled();
    fireEvent.click(waiting);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // The wait was not started a second time.
    expect(phantom.connectCalls).toBe(1);
  });

  it('the list says which wallet it is waiting for and what to do about it', async () => {
    const { waiting } = await waitingOnPhantom();
    fireEvent.click(waiting);
    const dialog = await screen.findByRole('dialog');
    const notice = within(dialog).getByRole('status');
    expect(notice).toHaveTextContent(/Waiting for Phantom/);
    expect(notice).toHaveTextContent(/locked/);
    expect(notice).toHaveTextContent(/approve/);
    expect(notice).toHaveTextContent(/another wallet/);
  });

  it('another wallet picked from that list connects, so the wait is escaped without a reload', async () => {
    const { phantom, backpack, waiting } = await waitingOnPhantom();
    fireEvent.click(waiting);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Backpack'));
    await waitFor(() => expect(backpack.connectCalls).toBe(1));
    await waitFor(() => expect(backpack.publicKey).not.toBeNull());
    expect(JSON.parse(localStorage.getItem('walletName') ?? 'null')).toBe('Backpack');
    expect(phantom.connectCalls).toBe(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connecting…' })).toBeNull());
  });

  // A pick starts the connect and the list then fades out for 150 ms, still
  // mounted. For that fade it said "it may be locked", in a live region, at
  // every ordinary connect: a wallet that had been asked nothing a moment ago.
  it('an ordinary pick does not put the notice in the list as it closes', async () => {
    const phantom = new HungWallet('Phantom', WalletReadyState.Installed);
    mountCard([phantom, new FakeWallet('Backpack', WalletReadyState.Installed)]);
    await restoreSettled();
    const dialog = await openList();
    expect(within(dialog).queryByRole('status')).toBeNull();
    fireEvent.click(within(dialog).getByText('Phantom'));
    // The connect has begun, and the list is still on screen for its fade.
    expect(phantom.connectCalls).toBe(1);
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).queryByRole('status')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says nothing about waiting when nothing is being waited on (the control)', async () => {
    mountCard([new FakeWallet('Phantom', WalletReadyState.Installed), new FakeWallet('Backpack', WalletReadyState.Installed)]);
    await restoreSettled();
    const dialog = await openList();
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(dialog).not.toHaveTextContent(/Waiting for/);
  });
});

// In a phone browser an offered wallet's row says "Open app": its adapter
// reopens the CURRENT address inside the wallet's own app. That page used to
// look like the start again (four testers, 2026-10-03), and the page left
// behind said nothing about where the connect had gone.
//
// MUTATION CHECK: delete the change-8 block in handleWalletClick. The first
// two tests must fail (no marker in the address the wallet read, no notice).
describe('an "Open app" row hands the page to the wallet app', () => {
  it('the address the wallet reads carries the marker, and the page left behind says where the connect went', async () => {
    window.history.replaceState(null, '', '/earn?ref=abc');
    const trust = new FakeWallet('Trust', WalletReadyState.Loadable);
    mount([new FakeWallet('Phantom', WalletReadyState.Loadable), trust]);
    const dialog = await openList();
    expect(within(dialog).getByText('Trust Wallet').closest('button')).toHaveTextContent('Open app');
    fireEvent.click(within(dialog).getByText('Trust Wallet'));
    await waitFor(() => expect(trust.connectCalls).toBe(1));
    const read = new URL(trust.hrefAtConnect!);
    expect(read.pathname).toBe('/earn');
    expect(read.searchParams.get('ref')).toBe('abc');
    expect(read.searchParams.get(SOLANA_HANDOFF_PARAM)).toBe('1');
    expect(toasts.toast).toHaveBeenCalledTimes(1);
    expect(toasts.toast.mock.calls[0]![0]).toBe(
      'Opening Trust Wallet. This site opens again inside the Trust Wallet app, and connects there.',
    );
    // It outlasts the trip to the wallet's app: a visitor who comes back still reads it.
    expect(toasts.toast.mock.calls[0]![1]).toEqual({ duration: 20_000 });
  });

  // Change 4's path: the wallet is already the saved one, so connect() is
  // called straight from the press. The marker has to be there by then too.
  it('the same for the wallet that is already the saved one', async () => {
    localStorage.setItem('walletName', JSON.stringify('MetaMask'));
    const metamask = new FakeWallet('MetaMask', WalletReadyState.Loadable);
    mount([metamask]);
    await restoreSettled();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('MetaMask'));
    await waitFor(() => expect(metamask.connectCalls).toBe(1));
    expect(new URL(metamask.hrefAtConnect!).searchParams.get(SOLANA_HANDOFF_PARAM)).toBe('1');
    expect(toasts.toast).toHaveBeenCalledTimes(1);
  });

  // The controls: a wallet in this browser connects here, and the Mobile
  // Wallet Adapter row is "Open app" too but connects in place. Neither
  // reopens the page anywhere, so neither marks it or says it will.
  it.each([
    ['a wallet detected in this browser', 'Phantom', WalletReadyState.Installed],
    ['the Mobile Wallet Adapter row', 'Mobile Wallet Adapter', WalletReadyState.Loadable],
  ])('%s leaves the address alone and says nothing', async (_label, name, readyState) => {
    window.history.replaceState(null, '', '/earn?ref=abc');
    const wallet = new FakeWallet(name, readyState);
    mount([wallet]);
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText(name));
    await waitFor(() => expect(wallet.connectCalls).toBe(1));
    expect(wallet.hrefAtConnect).toBe(`${window.location.origin}/earn?ref=abc`);
    expect(toasts.toast).not.toHaveBeenCalled();
  });
});
