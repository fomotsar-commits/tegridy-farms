// @vitest-environment jsdom
/**
 * SolanaProviders hands its connection to the top bar (lib/solanaSurface.ts),
 * so on a Solana page the top bar's Connect opens THIS page's list and shows
 * THIS page's address: one connection, never a second WalletProvider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  BaseMessageSignerWalletAdapter,
  WalletReadyState,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { SolanaProviders, SolanaSurfaceBridge } from './SolanaProviders';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import { SOLANA_CONNECT_WAIT_NOTICE_MS } from './SolanaConnectButton';
import { cancelSolanaOpenRequest, getSolanaSurfaceState, requestSolanaOpen } from '../../lib/solanaSurface';

const WSOL = 'So11111111111111111111111111111111111111112';

class FakeWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName;
  url = 'https://example.test';
  icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);
  connectCalls = 0;
  private _publicKey: PublicKey | null = null;
  /**
   * 'restores': the saved wallet reconnects by itself. 'hangs': connect() waits on the wallet.
   * 'restore-hangs': the saved wallet's restore never answers (a locked wallet).
   */
  private readonly _mode: 'plain' | 'restores' | 'hangs' | 'restore-hangs';

  constructor(name: string, mode: 'plain' | 'restores' | 'hangs' | 'restore-hangs' = 'plain') {
    super();
    this.name = name as WalletName;
    this._mode = mode;
  }
  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return WalletReadyState.Installed;
  }
  override async autoConnect() {
    if (this._mode === 'restore-hangs') await new Promise<void>(() => {});
    if (this._mode !== 'restores') return;
    await Promise.resolve();
    this._publicKey = new PublicKey(WSOL);
    this.emit('connect', this._publicKey);
  }
  async connect() {
    this.connectCalls += 1;
    if (this._mode === 'hangs') await new Promise<void>(() => {});
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

function PickAndConnect() {
  const { select } = useWallet();
  return (
    <button type="button" onClick={() => select('Fake' as WalletName)}>
      pick fake
    </button>
  );
}

function withFake(wallet: FakeWallet) {
  return render(
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={[wallet]} autoConnect>
        <SolanaWalletModalProvider>
          <SolanaSurfaceBridge />
          <PickAndConnect />
        </SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>,
  );
}

afterEach(() => {
  cleanup();
  act(() => cancelSolanaOpenRequest());
  localStorage.clear();
  vi.unstubAllEnvs();
});

describe('SolanaProviders reports to the top bar', () => {
  it('reports while mounted, opens its own list on request, and withdraws on unmount', async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
    const { unmount } = render(<SolanaProviders>page</SolanaProviders>);
    const surface = getSolanaSurfaceState().surface;
    expect(surface).not.toBeNull();
    expect(surface!.address).toBeNull();
    act(() => requestSolanaOpen());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('on Solana to continue');
    unmount();
    expect(getSolanaSurfaceState().surface).toBeNull();
  });

  it('opens its list for a top-bar tap that came before it mounted, once', async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
    act(() => requestSolanaOpen());
    expect(getSolanaSurfaceState().openPending).toBe(true);
    render(<SolanaProviders>page</SolanaProviders>);
    expect(await screen.findByRole('dialog')).toHaveTextContent('on Solana to continue');
    expect(getSolanaSurfaceState().openPending).toBe(false);
  });

  it('reports the connected address as a string', async () => {
    const fake = new FakeWallet('Fake');
    withFake(fake);
    expect(getSolanaSurfaceState().surface!.address).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pick fake' }));
    await screen.findByRole('button', { name: 'pick fake' });
    await act(async () => {});
    expect(fake.connectCalls).toBe(1);
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
  });

  // ⚠️ The fake emits 'connect' with no await, as a trusted Wallet Standard
  // wallet does (Trust's own browser after the first approval). Acting on the
  // tap in the bridge's FIRST effect connected it before WalletProvider had
  // attached its listener: connectCalls was 1 and the address stayed null,
  // for good. This failed on that version.
  it('connects a saved, installed wallet for an early tap, and the provider hears it', async () => {
    localStorage.setItem('walletName', JSON.stringify('Fake'));
    const fake = new FakeWallet('Fake');
    act(() => requestSolanaOpen());
    withFake(fake);
    await act(async () => {});
    expect(fake.connectCalls).toBe(1);
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getSolanaSurfaceState().openPending).toBe(false);
  });

  // A returning visitor's wallet reconnects by itself. The early tap is then
  // answered by that connection: no list opens over a connected page.
  it('lets a restore that connected answer an early tap: no list, no second connect', async () => {
    localStorage.setItem('walletName', JSON.stringify('Fake'));
    const fake = new FakeWallet('Fake', 'restores');
    act(() => requestSolanaOpen());
    withFake(fake);
    await act(async () => {});
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
    expect(getSolanaSurfaceState().openPending).toBe(false);
    expect(fake.connectCalls).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports that the wallet is connecting, which is what dims the top bar', async () => {
    const fake = new FakeWallet('Fake', 'hangs');
    withFake(fake);
    expect(getSolanaSurfaceState().surface!.connecting).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'pick fake' }));
    await act(async () => {});
    expect(fake.connectCalls).toBe(1);
    expect(getSolanaSurfaceState().surface!.connecting).toBe(true);
    expect(getSolanaSurfaceState().surface!.address).toBeNull();
  });

  // A locked wallet's restore never ends (owner, 2026-10-03). The early tap was
  // held for as long as it ran, so for ever: the top bar dimmed, did nothing,
  // and ten seconds on said the list "did not load". Once the wait has run as
  // long as the card takes to name the wallet, the tap opens the list, which
  // names it too. Nothing is connected a second time.
  it('opens its list for an early tap when the saved wallet has not answered, and not before', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('walletName', JSON.stringify('Fake'));
      const fake = new FakeWallet('Fake', 'restore-hangs');
      act(() => requestSolanaOpen());
      withFake(fake);
      await act(async () => {});
      expect(getSolanaSurfaceState().surface!.connecting).toBe(true);
      expect(getSolanaSurfaceState().openPending).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS - 1);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(getSolanaSurfaceState().openPending).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('dialog')).toHaveTextContent('Waiting for Fake to answer');
      expect(getSolanaSurfaceState().openPending).toBe(false);
      expect(fake.connectCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still never opens it over another dialog, however long the wallet takes', async () => {
    vi.useFakeTimers();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    try {
      localStorage.setItem('walletName', JSON.stringify('Fake'));
      act(() => requestSolanaOpen());
      withFake(new FakeWallet('Fake', 'restore-hangs'));
      await act(async () => {});
      act(() => {
        vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
      });
      expect(document.querySelector('.wallet-adapter-modal')).toBeNull();
      // The tap is used up all the same: the top bar's button stops waiting.
      expect(getSolanaSurfaceState().openPending).toBe(false);
    } finally {
      other.remove();
      vi.useRealTimers();
    }
  });

  // Overlays are never stacked here. One Escape closed both, in the wrong
  // order, and this list's scroll-lock restore left the page unable to scroll.
  it('does not open its list over another dialog the visitor opened while the tap waited', async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    try {
      act(() => requestSolanaOpen());
      render(<SolanaProviders>page</SolanaProviders>);
      await act(async () => {});
      expect(document.querySelector('.wallet-adapter-modal')).toBeNull();
      // The tap is used up all the same: the top bar's button un-dims.
      expect(getSolanaSurfaceState().openPending).toBe(false);
    } finally {
      other.remove();
    }
  });
});
