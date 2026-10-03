// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  BaseMessageSignerWalletAdapter,
  WalletConnectionError,
  WalletReadyState,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import { SolanaConnectButton } from './SolanaConnectButton';

/**
 * "Pick another wallet" must not strand the visitor a second time.
 *
 * The page tells someone whose wallet is not answering to pick another. The first
 * wallet's connect is still running inside wallet-adapter-react, with the handlers it
 * captured when it began. When that wallet answers LATER, those stale handlers act on
 * the page as it was:
 *  - it declines (the forgotten prompt is closed): the saved choice is wiped and the
 *    wallet the visitor moved to is dropped from the page, while it is still connected;
 *    picking it again selected it and never connected it (a connected adapter returns
 *    from connect() without announcing), so Connect was dead until a reload;
 *  - it approves: nothing shows, until the visitor switches back to it, and then the
 *    same dead Connect.
 * Found by the review of the fix for the owner's report of 2026-10-03, and reproduced
 * inside the real WalletProvider. The wallets here mirror the Wallet Standard adapter:
 * a guarded connect, and a disconnect that answers after an await.
 */

const WSOL = 'So11111111111111111111111111111111111111112';

class ProbeWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName;
  url = 'https://example.test/get';
  icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);
  connectCalls = 0;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;
  /** Answers the pending connect, as the person in front of the wallet would. */
  settle: { approve: () => void; decline: (e: Error) => void } | null = null;
  /** 'at once' connects as soon as it is asked; 'waits' holds every connect until settled. */
  private readonly answers: 'at once' | 'waits';
  /** A saved wallet's silent restore: 'quiet' does nothing, 'waits' hangs like a locked wallet. */
  private readonly restore: 'quiet' | 'waits';

  constructor(name: string, answers: 'at once' | 'waits', restore: 'quiet' | 'waits' = 'quiet') {
    super();
    this.name = name as WalletName;
    this.answers = answers;
    this.restore = restore;
  }
  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return this._connecting;
  }
  get readyState() {
    return WalletReadyState.Installed;
  }
  private async run(waits: boolean) {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    try {
      if (waits) {
        await new Promise<void>((approve, decline) => {
          this.settle = { approve, decline };
        });
      }
      this._publicKey = new PublicKey(WSOL);
      this.emit('connect', this._publicKey);
    } catch (error) {
      const wrapped = new WalletConnectionError((error as Error).message, error);
      this.emit('error', wrapped);
      throw wrapped;
    } finally {
      this._connecting = false;
    }
  }
  override async autoConnect() {
    if (this.restore === 'waits') await this.run(true);
  }
  async connect() {
    this.connectCalls += 1;
    await this.run(this.answers === 'waits');
  }
  async disconnect() {
    await Promise.resolve();
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

function State() {
  const { wallet, connected, connecting } = useWallet();
  return <pre data-testid="state">{JSON.stringify({ wallet: wallet?.adapter.name ?? null, connected, connecting })}</pre>;
}
const page = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as { wallet: string | null; connected: boolean; connecting: boolean };
const saved = () => JSON.parse(localStorage.getItem('walletName') ?? 'null') as string | null;

function mount(adapters: ProbeWallet[]) {
  return render(
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={adapters} autoConnect>
        <SolanaWalletModalProvider>
          <State />
          <SolanaConnectButton />
        </SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>,
  );
}
/** Lets promises, effects and zero-delay timers run. */
async function settled() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function pickFromList(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /Connecting…|Connect Solana Wallet/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByText(name));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await settled();
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

/** A remembered Phantom whose prompt is open and unanswered, then Backpack picked instead. */
async function gaveUpOnPhantom(how: 'pressed connect' | 'restore hung') {
  localStorage.setItem('walletName', JSON.stringify('Phantom'));
  const phantom = how === 'pressed connect' ? new ProbeWallet('Phantom', 'waits') : new ProbeWallet('Phantom', 'at once', 'waits');
  const backpack = new ProbeWallet('Backpack', 'at once');
  mount([phantom, backpack]);
  await settled();
  if (how === 'pressed connect') {
    fireEvent.click(screen.getByRole('button', { name: 'Connect Solana Wallet' }));
    await screen.findByRole('button', { name: 'Connecting…' });
  }
  await pickFromList('Backpack');
  expect(page()).toMatchObject({ wallet: 'Backpack', connected: true });
  return { phantom, backpack };
}

describe.each(['pressed connect', 'restore hung'] as const)('the wallet that was given up on answers late (%s)', (how) => {
  it('it declines: the wallet in use stays connected on the page, and stays the saved choice', async () => {
    const { phantom, backpack } = await gaveUpOnPhantom(how);
    await act(async () => {
      phantom.settle!.decline(new Error('User rejected the request.'));
      await Promise.resolve();
    });
    await settled();
    expect(backpack.connected).toBe(true);
    expect(page()).toMatchObject({ wallet: 'Backpack', connected: true });
    expect(saved()).toBe('Backpack');
  });

  it('it approves: nothing changes for the wallet in use', async () => {
    const { phantom } = await gaveUpOnPhantom(how);
    await act(async () => {
      phantom.settle!.approve();
      await Promise.resolve();
    });
    await settled();
    expect(page()).toMatchObject({ wallet: 'Backpack', connected: true });
    expect(saved()).toBe('Backpack');
  });

  it('it approves, and the visitor switches back to it: it is connected, not a dead Connect', async () => {
    const { phantom } = await gaveUpOnPhantom(how);
    await act(async () => {
      phantom.settle!.approve();
      await Promise.resolve();
    });
    await settled();
    expect(phantom.connected).toBe(true);
    await pickFromList('Phantom');
    await waitFor(() => expect(page()).toMatchObject({ wallet: 'Phantom', connected: true }));
    expect(saved()).toBe('Phantom');
  });
});

describe('a second wallet that is itself still being waited on', () => {
  it('a press opens the wallet list, even after the first wallet answered and the page stopped saying Connecting', async () => {
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    const phantom = new ProbeWallet('Phantom', 'waits');
    const backpack = new ProbeWallet('Backpack', 'waits');
    mount([phantom, backpack]);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Solana Wallet' }));
    await screen.findByRole('button', { name: 'Connecting…' });
    await pickFromList('Backpack');
    // Phantom answers; its stale handler tells the page nothing is connecting any more.
    await act(async () => {
      phantom.settle!.approve();
      await Promise.resolve();
    });
    await settled();
    const calls = backpack.connectCalls;
    fireEvent.click(screen.getByRole('button', { name: /Connecting…|Connect Solana Wallet/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // And when Backpack does answer, it connects.
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      backpack.settle!.approve();
      await Promise.resolve();
    });
    await settled();
    expect(page()).toMatchObject({ wallet: 'Backpack', connected: true });
    expect(backpack.connectCalls).toBeGreaterThanOrEqual(calls);
  });
});

describe('what the resync must never do', () => {
  it('a wallet the visitor disconnected stays disconnected', async () => {
    const backpack = new ProbeWallet('Backpack', 'at once');
    mount([new ProbeWallet('Phantom', 'at once'), backpack]);
    await settled();
    await pickFromList('Backpack');
    expect(page()).toMatchObject({ wallet: 'Backpack', connected: true });
    fireEvent.click(screen.getByRole('button', { name: /Connect Solana Wallet/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await settled();
    expect(backpack.connected).toBe(false);
    expect(page().connected).toBe(false);
    expect(saved()).toBeNull();
  });

  it('a wallet whose own prompt was declined is not picked again behind the visitor\'s back', async () => {
    const phantom = new ProbeWallet('Phantom', 'waits');
    mount([phantom, new ProbeWallet('Backpack', 'at once')]);
    await settled();
    await pickFromList('Phantom');
    await act(async () => {
      phantom.settle!.decline(new Error('User rejected the request.'));
      await Promise.resolve();
    });
    await settled();
    expect(page()).toMatchObject({ wallet: null, connected: false });
    expect(phantom.connectCalls).toBe(1);
  });
});
