// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WalletReadyState, BaseMessageSignerWalletAdapter, type SupportedTransactionVersions, type WalletName } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SolanaWalletModalProvider } from './SolanaWalletModal';
import { SolanaProviders } from './SolanaProviders';
import { PAIRING_REASONS, WalletConnectWalletAdapter, resetWalletConnectClientForTests } from '../../lib/solanaWalletConnect';
import { orderWallets } from '../../lib/solanaWalletOrder';

/**
 * The WalletConnect row inside the REAL WalletProvider and our modal, with the
 * real adapter over a fake SignClient. The select → connect handoff, the
 * provider clearing the saved wallet when connect() throws, and the dialog's
 * own close paths are what break quietly, so none of that is mocked.
 */

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const account = Keypair.generate().publicKey.toBase58();

const h = vi.hoisted(() => ({ client: null as unknown, init: null as null | (() => Promise<unknown>) }));
vi.mock('@walletconnect/sign-client', () => ({
  SignClient: { init: () => (h.init ? h.init() : Promise.resolve(h.client)) },
}));

/** A live Solana session, as the store holds it. */
function liveSession(pairingTopic = 'pair-earlier') {
  return {
    topic: 'sess-sol',
    pairingTopic,
    expiry: 9_999_999_999,
    namespaces: { solana: { accounts: [`${MAINNET}:${account}`], methods: ['solana_signTransaction'], events: [] } },
    peer: { metadata: { name: 'Test Wallet' } },
  };
}

function fakeClient() {
  let settle!: { resolve: (s: unknown) => void; reject: (e: unknown) => void };
  const sessions = new Map<string, Record<string, unknown>>();
  const client = {
    sessions,
    approve: () => settle.resolve(liveSession('pairtopic123')),
    decline: () => settle.reject({ code: 5000, message: 'User rejected.' }),
    session: {
      getAll: () => [...sessions.values()],
      get: (t: string) => sessions.get(t),
      update: async (t: string, u: Record<string, unknown>) => sessions.set(t, { ...(sessions.get(t) ?? { topic: t }), ...u }),
    },
    connect: async () => ({
      uri: 'wc:pairtopic123@2?relay-protocol=irn&symKey=00',
      approval: () =>
        new Promise((resolve, reject) => {
          settle = {
            resolve: (s) => {
              sessions.set('sess-sol', s as Record<string, unknown>);
              resolve(s);
            },
            reject,
          };
        }),
    }),
    disconnect: vi.fn(async () => {}),
    on: () => {},
    off: () => {},
  };
  return client;
}

class FakeWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName;
  url = 'https://example.test';
  icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);
  private _rs: WalletReadyState;
  constructor(name: string, rs: WalletReadyState) {
    super();
    this.name = name as WalletName;
    this._rs = rs;
  }
  get publicKey() {
    return null;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return this._rs;
  }
  override async autoConnect() {}
  async connect() {}
  async disconnect() {}
  async signTransaction<T>(t: T) {
    return t;
  }
  async signMessage(m: Uint8Array) {
    return m;
  }
}

function Opener() {
  const { setVisible } = useWalletModal();
  const { publicKey, connecting } = useWallet();
  return (
    <>
      <button type="button" onClick={() => setVisible(true)}>
        open wallets
      </button>
      <output data-testid="pk">{publicKey?.toBase58() ?? ''}</output>
      <output data-testid="connecting">{String(connecting)}</output>
    </>
  );
}

let client: ReturnType<typeof fakeClient>;
let wc: WalletConnectWalletAdapter;

function mount() {
  wc = new WalletConnectWalletAdapter({ projectId: 'test-project' });
  const adapters = [new FakeWallet('Phantom', WalletReadyState.Installed), new FakeWallet('Trust', WalletReadyState.NotDetected), wc];
  return render(
    <ConnectionProvider endpoint="http://127.0.0.1:8899">
      <WalletProvider wallets={adapters} autoConnect>
        <SolanaWalletModalProvider>
          <Opener />
        </SolanaWalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>,
  );
}

async function openList() {
  fireEvent.click(screen.getByRole('button', { name: 'open wallets' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  // What a production build has: without it the adapter's import() of
  // sign-client is compiled out.
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'test-project');
  localStorage.clear();
  resetWalletConnectClientForTests();
  client = fakeClient();
  h.client = client;
  h.init = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  document.body.style.overflow = '';
});

describe('the WalletConnect row', () => {
  it('is last, and says what a click does', async () => {
    mount();
    const dialog = await openList();
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[rows.length - 1]).toBe('WalletConnectScan QR code');
  });

  it('sorts LAST whatever else is listed: passed first, and beside a wallet this venue does not offer', () => {
    // Offered order alone put it last only while every wallet outside that
    // list happened to be Installed (a Wallet Standard extension). A Loadable
    // or NotDetected wallet outside the list ranked after every offered one —
    // after WalletConnect.
    const qr = new WalletConnectWalletAdapter({ projectId: 'test-project' }) as unknown as FakeWallet;
    const others = [
      new FakeWallet('Backpack', WalletReadyState.Loadable),
      new FakeWallet('Solflare', WalletReadyState.NotDetected),
      new FakeWallet('Phantom', WalletReadyState.Installed),
      new FakeWallet('Trust', WalletReadyState.Loadable),
    ];
    const orders = [[qr, ...others], [...others, qr], [others[0]!, qr, ...others.slice(1)]];
    for (const adapters of orders) {
      const names = orderWallets(adapters.map((adapter) => ({ adapter, readyState: adapter.readyState }))).map(
        (w) => w.adapter.name,
      );
      expect(names).toHaveLength(adapters.length);
      expect(names[names.length - 1]).toBe('WalletConnect');
    }
  });

  it('Back while WalletConnect is still STARTING returns to the list and ends the attempt', async () => {
    let release!: (c: unknown) => void;
    h.init = () =>
      new Promise((r) => {
        release = r;
      });
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    expect(await screen.findByText('Starting WalletConnect…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to wallets' }));
    expect(await within(screen.getByRole('dialog')).findByText('Trust Wallet')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('walletName')).toBeNull());
    // WalletConnect finishing its start-up afterwards must not bring a QR back.
    await act(async () => {
      release(client);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('img', { name: 'WalletConnect QR code' })).toBeNull();
    expect(wc.getPairing()).toEqual({ phase: 'idle' });
    expect(wc.connecting).toBe(false);
  });

  it('keeps the dialog open and shows the QR; approving connects and closes it', async () => {
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    expect(await screen.findByRole('img', { name: 'WalletConnect QR code' })).toBeInTheDocument();
    // Still there after the dialog's 150 ms close fade would have run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(screen.getByRole('img', { name: 'WalletConnect QR code' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('Scan with your phone’s wallet');
    await act(async () => client.approve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('pk')).toHaveTextContent(account);
    expect(JSON.parse(localStorage.getItem('walletName') ?? 'null')).toBe('WalletConnect');
  });

  it('"Back to wallets" cancels: the list returns, with no notice, and nothing stays selected', async () => {
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to wallets' }));
    expect(await within(screen.getByRole('dialog')).findByText('Trust Wallet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(localStorage.getItem('walletName')).toBeNull());
    expect(client.disconnect).toHaveBeenCalledWith(expect.objectContaining({ topic: 'pairtopic123' }));
  });

  it('a declined connection says so above the list, and a second tap starts a new QR', async () => {
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    await screen.findByRole('img', { name: 'WalletConnect QR code' });
    await act(async () => client.decline());
    expect(await screen.findByRole('alert')).toHaveTextContent(PAIRING_REASONS.declined);
    await waitFor(() => expect(localStorage.getItem('walletName')).toBeNull());
    fireEvent.click(within(screen.getByRole('dialog')).getByText('WalletConnect'));
    expect(await screen.findByRole('img', { name: 'WalletConnect QR code' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Escape during the QR closes the dialog AND abandons the pairing', async () => {
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    await screen.findByRole('img', { name: 'WalletConnect QR code' });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    // At once, not when the 150 ms fade unmounts the dialog: an approval that
    // lands during the fade must not connect a wallet the visitor just closed.
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(wc.getPairing()).toEqual({ phase: 'idle' });
    expect(wc.connecting).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(localStorage.getItem('walletName')).toBeNull());
    expect(wc.getPairing()).toEqual({ phase: 'idle' });
  });

  it('a failure notice already seen is gone when the list is opened again', async () => {
    mount();
    const dialog = await openList();
    fireEvent.click(within(dialog).getByText('WalletConnect'));
    await screen.findByRole('img', { name: 'WalletConnect QR code' });
    await act(async () => client.decline());
    expect(await screen.findByRole('alert')).toHaveTextContent(PAIRING_REASONS.declined);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openList();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('while a saved WalletConnect session is still being restored', () => {
  // walletName=WalletConnect is saved, so WalletProvider's autoConnect starts
  // a restore on mount, and `connecting` is true until WalletConnect has
  // started. The BAYLA Connect buttons stay enabled meanwhile, so the list
  // can be opened in that state. Nothing here may be lost or stuck.
  let release: ((c: unknown) => void) | undefined;
  async function mountRestoring({ live }: { live: boolean }) {
    localStorage.setItem('walletName', JSON.stringify('WalletConnect'));
    if (live) client.sessions.set('sess-sol', liveSession());
    release = undefined;
    h.init = () =>
      new Promise((r) => {
        release = r;
      });
    mount();
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByTestId('connecting')).toHaveTextContent('true');
  }
  /** Outside act(): the dialog's close runs in an effect act() defers. */
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  it('picking ANOTHER wallet stops the restore, and picking WalletConnect later still connects', async () => {
    // WalletProvider calls disconnect() on the wallet being left. Before the
    // fix a restore ignored it: it finished anyway, the adapter read
    // connected while the provider read disconnected, and the later
    // WalletConnect pick then did nothing at all — no QR, no error.
    await mountRestoring({ live: true });
    fireEvent.click(within(await openList()).getByText('Phantom'));
    await act(async () => {
      release!(client);
      await settle(50);
    });
    await settle();
    expect(wc.connected).toBe(false);
    fireEvent.click(within(await openList()).getByText('WalletConnect'));
    // The session is still live, so it is restored without a QR.
    await waitFor(() => expect(screen.getByTestId('pk')).toHaveTextContent(account));
  });

});

describe('SolanaProviders and the project id', () => {
  function Names() {
    const { wallets } = useWallet();
    return <output data-testid="names">{wallets.map((w) => w.adapter.name).join(',')}</output>;
  }
  it.each([
    ['unset (CI, previews)', '', false],
    ['set (production)', 'abc123', true],
  ])('%s', (_label, id, present) => {
    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', id);
    render(
      <SolanaProviders>
        <Names />
      </SolanaProviders>,
    );
    const names = screen.getByTestId('names').textContent ?? '';
    expect(names.split(',').includes('WalletConnect')).toBe(present);
  });
});

void PublicKey;
