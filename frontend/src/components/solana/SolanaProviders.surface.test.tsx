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
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { SolanaProviders, SolanaSurfaceBridge, TopBarSolanaProviders } from './SolanaProviders';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import {
  SOLANA_CONNECT_WAIT_NOTICE_MS,
  SOLANA_HANDOFF_PARAM,
  getSolanaSurfaceState,
  noteSolanaHandoffArrival,
  requestSolanaOpen,
  resetSolanaSurfaceForTests,
  solanaHandoffPending,
  subscribeSolanaSurface,
} from '../../lib/solanaSurface';

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
  private _ready: WalletReadyState;

  constructor(
    name: string,
    mode: 'plain' | 'restores' | 'hangs' | 'restore-hangs' = 'plain',
    ready: WalletReadyState = WalletReadyState.Installed,
  ) {
    super();
    this.name = name as WalletName;
    this._mode = mode;
    this._ready = ready;
  }
  /** The wallet's provider shows up after the page loaded (Trust, on some Android builds). */
  detect() {
    this._ready = WalletReadyState.Installed;
    this.emit('readyStateChange', this._ready);
  }
  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return this._ready;
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
  const { setVisible } = useWalletModal();
  return (
    <>
      <button type="button" onClick={() => select('Fake' as WalletName)}>
        pick fake
      </button>
      <button type="button" onClick={() => setVisible(true)}>
        open list
      </button>
    </>
  );
}

function withFake(...wallets: FakeWallet[]) {
  return render(
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={wallets} autoConnect>
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
  act(() => resetSolanaSurfaceForTests());
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
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

  // The early tap asked for the list. If the visitor opens it from the page
  // while the tap is held, that is the answer: closing it must be the end of
  // it, not the list opening again by itself when the hold runs out.
  it('does not open the list again for a held tap once the visitor has had the list from the page', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('walletName', JSON.stringify('Fake'));
      act(() => requestSolanaOpen());
      withFake(new FakeWallet('Fake', 'restore-hangs'));
      await act(async () => {});
      expect(getSolanaSurfaceState().openPending).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'open list' }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(getSolanaSurfaceState().openPending).toBe(false);
      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
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

  // One live connection per page: TopBarSolana.tsx unmounts the top bar's own
  // wherever a page's is mounted, and it tells them apart by this flag.
  it("marks the top bar's own connection as its own, and a page's as the page's", () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
    const own = render(<TopBarSolanaProviders />);
    expect(getSolanaSurfaceState()).toMatchObject({ page: false });
    expect(getSolanaSurfaceState().surface).not.toBeNull();
    own.unmount();
    render(<SolanaProviders>page</SolanaProviders>);
    expect(getSolanaSurfaceState()).toMatchObject({ page: true });
  });

  it("opens the Solana list from the top bar's own connection, with nothing else inside it", async () => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
    const { container } = render(<TopBarSolanaProviders />);
    expect(container).toBeEmptyDOMElement();
    act(() => getSolanaSurfaceState().surface!.open());
    expect(await screen.findByRole('dialog')).toHaveTextContent('Connect a wallet on Solana to continue');
  });

  // WalletProvider starts restoring a saved wallet in its own effect, after the
  // bridge's first one. A first report of "not connecting" was a guess, and the
  // wallet sheet acted on it: it opened the list while a restore was starting.
  it('never says "not connecting, not connected" before a saved wallet has had its restore', async () => {
    localStorage.setItem('walletName', JSON.stringify('Fake'));
    const seen: string[] = [];
    const off = subscribeSolanaSurface(() => {
      const s = getSolanaSurfaceState().surface;
      if (s) seen.push(`${s.address ? 'connected' : 'none'}/${s.connecting ? 'connecting' : 'idle'}`);
    });
    withFake(new FakeWallet('Fake', 'restores'));
    await act(async () => {});
    off();
    expect(seen[0]).toBe('none/connecting');
    expect(seen[seen.length - 1]).toBe('connected/idle');
    expect(seen).not.toContain('none/idle');
  });

  it('says "not connecting" once it knows there is nothing to restore', async () => {
    const seen: string[] = [];
    const off = subscribeSolanaSurface(() => {
      const s = getSolanaSurfaceState().surface;
      if (s) seen.push(`${s.address ? 'connected' : 'none'}/${s.connecting ? 'connecting' : 'idle'}`);
    });
    withFake(new FakeWallet('Fake'));
    await act(async () => {});
    off();
    expect(seen[0]).toBe('none/connecting');
    expect(seen[seen.length - 1]).toBe('none/idle');
  });
});

// A phone browser's "Open app" row reopens the page inside the wallet's own
// app (lib/solanaSurface.ts). That page used to look like the start again:
// Connect, Solana and the wallet had to be pressed a second time, with nothing
// saying so (four testers walking it as a Trust user, 2026-10-03).
//
// MUTATION CHECK: delete the hand-off effect in SolanaSurfaceBridge. The first,
// third and fourth tests must fail (nothing connects, no list opens).
describe('a page opened by a hand-off carries on by itself', () => {
  const ANDROID_IN_APP =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
  /** The wallet's app opens the address the press handed it. */
  const arriveByHandoff = () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID_IN_APP);
    window.history.replaceState(null, '', `/?${SOLANA_HANDOFF_PARAM}=1`);
    noteSolanaHandoffArrival();
  };

  it('asks the one wallet it detects to connect: no press, no list', async () => {
    arriveByHandoff();
    const trust = new FakeWallet('Trust');
    withFake(trust);
    await act(async () => {});
    expect(trust.connectCalls).toBe(1);
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(solanaHandoffPending()).toBe(false);
  });

  // The control: the same page, opened the ordinary way, asks no wallet for anything.
  it('does nothing of the kind on an ordinary visit', async () => {
    const trust = new FakeWallet('Trust');
    withFake(trust);
    await act(async () => {});
    expect(trust.connectCalls).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Which wallet is the visitor's to say when there is more than one.
  it('opens the list instead of choosing when two wallets are detected', async () => {
    arriveByHandoff();
    const trust = new FakeWallet('Trust');
    const phantom = new FakeWallet('Phantom');
    withFake(trust, phantom);
    expect(await screen.findByRole('dialog')).toHaveTextContent('on Solana to continue');
    expect(trust.connectCalls + phantom.connectCalls).toBe(0);
    expect(solanaHandoffPending()).toBe(false);
  });

  // Trust's in-app browser injects its provider late on some Android builds.
  it('waits for a wallet that is detected late, then asks it', async () => {
    arriveByHandoff();
    const trust = new FakeWallet('Trust', 'plain', WalletReadyState.NotDetected);
    withFake(trust);
    await act(async () => {});
    expect(trust.connectCalls).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(solanaHandoffPending()).toBe(true);
    await act(async () => trust.detect());
    await act(async () => {});
    expect(trust.connectCalls).toBe(1);
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
  });

  // A returning visitor inside the wallet's app: the saved wallet reconnects by
  // itself, and the hand-off must not ask it a second time.
  it('lets a saved wallet that restored answer it: one connection, no second ask', async () => {
    localStorage.setItem('walletName', JSON.stringify('Trust'));
    arriveByHandoff();
    const trust = new FakeWallet('Trust', 'restores');
    withFake(trust);
    await act(async () => {});
    expect(trust.connectCalls).toBe(0);
    expect(getSolanaSurfaceState().surface!.address).toBe(WSOL);
    expect(solanaHandoffPending()).toBe(false);
  });
});
