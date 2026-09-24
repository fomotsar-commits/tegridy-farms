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
    const wallets = [
      new FakeWallet('Backpack', WalletReadyState.NotDetected),
      new FakeWallet('Coinbase Wallet', WalletReadyState.NotDetected),
      new FakeWallet('MetaMask', WalletReadyState.Installed),
      new FakeWallet('Trust', WalletReadyState.Loadable),
      new FakeWallet('Solflare', WalletReadyState.Installed),
      new FakeWallet('Phantom', WalletReadyState.NotDetected),
    ].map((adapter) => ({ adapter, readyState: adapter.readyState }));
    expect(orderWallets(wallets).map((w) => w.adapter.name)).toEqual([
      'MetaMask',
      'Solflare',
      'Phantom',
      'Trust',
      'Coinbase Wallet',
      'Backpack',
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
    const dialog = await openList();
    expect(trust.connectCalls).toBe(0);
    fireEvent.click(within(dialog).getByText('Trust Wallet'));
    await waitFor(() => expect(trust.connectCalls).toBe(1));
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

  it('still connects a saved wallet that is reachable, without the list', async () => {
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    const trust = new FakeWallet('Trust', WalletReadyState.Loadable);
    mount([new FakeWallet('Phantom', WalletReadyState.NotDetected), trust]);
    // Let the mount-time restore of the saved wallet finish: while it runs the
    // provider reports `connecting`, and the hook rightly opens the list then.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(trust.connectCalls).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
