// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

/**
 * The adapter against the REAL @walletconnect/sign-client 2.25.0 ENGINE, where
 * a fake would have to guess: what the engine does with a wallet's approval
 * that arrives after the visitor abandoned the QR.
 *
 * No network. The relayer's I/O is stubbed, and the wallet's side is played by
 * calling the dapp engine's own handlers for the two messages a wallet's
 * approve() publishes together (sign-client engine.ts sendApproveSession): the
 * proposal response on the pairing topic, then wc_sessionSettle on the new
 * session topic. The adapter gets this client through the mocked init.
 *
 * The two orderings are the two a real network produces when the visitor
 * presses Back about a second after tapping Approve on the phone:
 *  - the settle lands WHILE the pairing is being deleted: the engine stores
 *    the session and resolves approval(), with nobody listening;
 *  - the settle lands AFTER the pairing is deleted: the engine stores the
 *    session (session.set comes first, engine.ts onSessionSettleRequest), then
 *    throws on the missing pairing, so session_connect is never emitted and
 *    approval() never resolves at all.
 * Before the fix the next WalletConnect click adopted that stored session in
 * both, with no QR — in the second against a session the wallet had already
 * dropped, so a signature request then waited out SIGN_TIMEOUT_MS unanswered.
 */

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const account = Keypair.generate().publicKey.toBase58();

const h = vi.hoisted(() => ({ client: null as unknown, holdUnsubscribe: false }));
vi.mock('@walletconnect/sign-client', () => ({
  SignClient: { init: async () => h.client },
}));

function memoryStorage() {
  const kv = new Map<string, unknown>();
  return {
    getItem: async <T,>(k: string) => kv.get(k) as T | undefined,
    setItem: async <T,>(k: string, v: T) => {
      kv.set(k, v);
    },
    removeItem: async (k: string) => {
      kv.delete(k);
    },
    getKeys: async () => [...kv.keys()],
    getEntries: async <T,>() => [...kv.entries()] as [string, T][],
  };
}

// The engine's handlers are internal API: typed loosely, on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

let mod: typeof import('./solanaWalletConnect');

async function realClient(prefix: string) {
  const { SignClient } = await vi.importActual<typeof import('@walletconnect/sign-client')>('@walletconnect/sign-client');
  const client: Loose = await SignClient.init({
    ...mod.signClientOptions('00000000000000000000000000000000', 'https://x.test', memoryStorage()),
    // 2.25.0 caches one Core per prefix per process: one prefix per test.
    customStoragePrefix: prefix,
  });
  const relayer = client.core.relayer;
  relayer.confirmOnlineStateOrThrow = async () => {};
  relayer.subscribe = async () => 'sub';
  relayer.publish = async () => {};
  relayer.publishCustom = async () => {};
  const parked: Array<() => void> = [];
  relayer.unsubscribe = () => (h.holdUnsubscribe ? new Promise<void>((r) => parked.push(r)) : Promise.resolve());
  return { client, releaseUnsubscribe: () => parked.splice(0).forEach((r) => r()) };
}

/** The phone wallet, driven through the dapp engine's own message handlers. */
async function phoneWallet(client: Loose) {
  const proposal = client.proposal.getAll()[0];
  const pairingTopic: string = proposal.pairingTopic;
  const responderPublicKey = await client.core.crypto.generateKeyPair();
  return {
    pairingTopic,
    async proposeResponse(): Promise<string> {
      await client.engine.onSessionProposeResponse(
        pairingTopic,
        { id: proposal.id, jsonrpc: '2.0', result: { relay: { protocol: 'irn' }, responderPublicKey } },
        'relay',
      );
      return [...client.engine.pendingSessions.values()][0].sessionTopic;
    },
    async settle(sessionTopic: string): Promise<void> {
      const payload = {
        id: 777,
        jsonrpc: '2.0',
        method: 'wc_sessionSettle',
        params: {
          relay: { protocol: 'irn' },
          controller: { publicKey: responderPublicKey, metadata: { name: 'X', description: '', url: 'https://w.test', icons: [] } },
          namespaces: { solana: { accounts: [`${MAINNET}:${account}`], methods: ['solana_signTransaction'], events: [] } },
          expiry: Math.floor(Date.now() / 1000) + 7 * 86_400,
        },
      };
      client.core.history.set(sessionTopic, payload);
      await client.engine.onSessionSettleRequest(sessionTopic, payload).catch(() => {});
    },
  };
}

beforeEach(async () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 });
  vi.stubGlobal('window', { location: { origin: 'https://x.test' } });
  vi.stubGlobal('document', {});
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'test-project');
  h.holdUnsubscribe = false;
  mod = await import('./solanaWalletConnect');
  mod.resetWalletConnectClientForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('an approval that lands after Back, on the real engine', () => {
  it.each(['while the pairing is being deleted', 'after the pairing is deleted'] as const)(
    'settled %s: never adopted by the next click, which shows a NEW QR',
    async (order) => {
      h.holdUnsubscribe = order === 'while the pairing is being deleted';
      const { client, releaseUnsubscribe } = await realClient(`engine-test-${order.replace(/\W+/g, '-')}`);
      h.client = client;
      const adapter = new mod.WalletConnectWalletAdapter({ projectId: 'test-project' });
      const first = adapter.connect().catch((e: unknown) => e);
      await vi.waitFor(() => expect(adapter.getPairing().phase).toBe('scan'));
      const wallet = await phoneWallet(client);
      const sessionTopic = await wallet.proposeResponse();
      adapter.cancelPairing();
      await first;
      if (order === 'after the pairing is deleted') {
        await vi.waitFor(() => expect(client.core.pairing.pairings.keys).not.toContain(wallet.pairingTopic));
        await wallet.settle(sessionTopic);
        // The engine stored it; nothing told the adapter.
        expect(client.session.keys).toContain(sessionTopic);
      } else {
        await wallet.settle(sessionTopic);
        h.holdUnsubscribe = false;
        releaseUnsubscribe();
      }
      const second = adapter.connect().catch((e: unknown) => e);
      await vi.waitFor(() => expect(adapter.getPairing().phase).toBe('scan'));
      expect(adapter.connected).toBe(false);
      // And the stray session is gone from the store, so a reload cannot
      // restore it either.
      await vi.waitFor(() => expect(client.session.keys).not.toContain(sessionTopic));
      adapter.cancelPairing();
      await second;
    },
  );
});
