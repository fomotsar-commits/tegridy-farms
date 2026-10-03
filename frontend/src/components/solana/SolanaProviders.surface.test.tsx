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
import { cancelSolanaOpenRequest, getSolanaSurfaceState, requestSolanaOpen } from '../../lib/solanaSurface';

const WSOL = 'So11111111111111111111111111111111111111112';

class FakeWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName;
  url = 'https://example.test';
  icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);
  connectCalls = 0;
  private _publicKey: PublicKey | null = null;

  constructor(name: string) {
    super();
    this.name = name as WalletName;
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
  override async autoConnect() {}
  async connect() {
    this.connectCalls += 1;
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
});
