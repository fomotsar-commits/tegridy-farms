// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SignClient } from '@walletconnect/sign-client';
import { signClientOptions } from './solanaWalletConnect';

/**
 * The REAL @walletconnect/sign-client 2.25.0 — the copy wagmi's EVM connector
 * already loads — on one shared key-value store, the way every WalletConnect
 * client on this origin shares IndexedDB WALLET_CONNECT_V2_INDEXED_DB. No
 * network: a relayer opens its socket only once it has a topic.
 */

function memoryStorage() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    storage: {
      getItem: async <T,>(k: string) => kv.get(k) as T | undefined,
      setItem: async <T,>(k: string, v: T) => {
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        kv.delete(k);
      },
      getKeys: async () => [...kv.keys()],
      getEntries: async <T,>() => [...kv.entries()] as [string, T][],
    },
  };
}

const session = (topic: string, ns: string) => ({
  topic,
  expiry: 9_999_999_999,
  namespaces: { [ns]: { accounts: [], methods: [], events: [] } },
  self: { publicKey: 'a', metadata: { name: '', description: '', url: '', icons: [] } },
  peer: { publicKey: 'b', metadata: { name: '', description: '', url: '', icons: [] } },
  relay: { protocol: 'irn' },
  acknowledged: true,
  controller: 'b',
  requiredNamespaces: {},
  optionalNamespaces: {},
  pairingTopic: 'p',
});

describe('the Solana client beside RainbowKit\'s EVM client', () => {
  it('keeps its own sessions and writes only under its own prefix', async () => {
    const { kv, storage } = memoryStorage();
    // RainbowKit's visible WalletConnect connector: prefix 'clientTwo' (rainbowkit dist/index.js:7087-7091).
    const evm = await SignClient.init({
      projectId: '00000000000000000000000000000000',
      storage,
      telemetryEnabled: false,
      customStoragePrefix: 'clientTwo',
    });
    const before = new Set(kv.keys());
    const sol = await SignClient.init(signClientOptions('00000000000000000000000000000000', 'https://x.test', storage));
    const written = [...kv.keys()].filter((k) => !before.has(k));

    expect(sol.core).not.toBe(evm.core);
    await evm.session.set('EVM', session('EVM', 'eip155') as never);
    await sol.session.set('SOL', session('SOL', 'solana') as never);
    expect(((kv.get('wc@2:client:0.3:clientTwo//session') as Array<{ topic: string }>) ?? []).map((s) => s.topic)).toEqual(['EVM']);
    expect(((kv.get('wc@2:client:0.3:solana//session') as Array<{ topic: string }>) ?? []).map((s) => s.topic)).toEqual(['SOL']);

    expect(written.length).toBeGreaterThan(0);
    for (const key of written) expect(key).toMatch(/:solana\/\//);
    expect([...kv.keys()].some((k) => k.startsWith('wc@2:universal_provider:'))).toBe(false);
  });

  it('pins WHY the client is shared: two clients on ONE prefix erase each other\'s sessions', async () => {
    const { kv, storage } = memoryStorage();
    const opts = { ...signClientOptions('00000000000000000000000000000000', 'https://x.test', storage), customStoragePrefix: 'same' };
    const a = await SignClient.init(opts);
    const b = await SignClient.init(opts);
    await a.session.set('A', session('A', 'solana') as never);
    await b.session.set('B', session('B', 'solana') as never);
    expect(((kv.get('wc@2:client:0.3:same//session') as Array<{ topic: string }>) ?? []).map((s) => s.topic)).toEqual(['B']);
  });

  describe("RainbowKit's WALLETCONNECT_DEEPLINK_CHOICE survives everything the Solana client does", () => {
    // sign-client's deleteSession ALWAYS runs
    // core.storage.removeItem('WALLETCONNECT_DEEPLINK_CHOICE') — a key with no
    // storage prefix, so 'solana' cannot protect it (engine.ts:1583-1587).
    // Normally core.storage is IndexedDB and RainbowKit's key lives in
    // localStorage, so they never meet. But KeyValueStorage falls back to
    // window.localStorage when IndexedDB cannot be opened, and then a Solana
    // disconnect — or an expired Solana session found at start-up — deleted
    // RainbowKit's saved EVM wallet choice (reproduced with the real browser
    // build, 2026-09-25). The shared store here stands for that fallback.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const now = () => Math.floor(Date.now() / 1000);
    const full = (topic: string, expiry: number) => ({
      ...session(topic, 'solana'),
      expiry,
      namespaces: {
        solana: {
          accounts: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:11111111111111111111111111111111'],
          methods: ['solana_signTransaction'],
          events: [],
        },
      },
      self: { publicKey: 'a'.repeat(64), metadata: { name: '', description: '', url: '', icons: [] } },
      peer: { publicKey: 'b'.repeat(64), metadata: { name: 'W', description: '', url: 'https://wallet.test', icons: [] } },
      controller: 'b'.repeat(64),
      pairingTopic: 'p'.repeat(64),
    });

    it('start-up cleanup of an expired session, and a disconnect: no key outside its own prefix is added, changed or removed', async () => {
      // Core caches one core per prefix on globalThis (core.ts getGlobalCore);
      // the first test above already made the 'solana' one, on another store.
      vi.stubEnv('DISABLE_GLOBAL_CORE', 'true');
      const { kv, storage } = memoryStorage();
      // RainbowKit's own value shape (rainbowkit setWalletConnectDeepLink).
      kv.set('WALLETCONNECT_DEEPLINK_CHOICE', JSON.stringify({ href: 'metamask://', name: 'MetaMask' }));
      kv.set('wc@2:universal_provider:namespaces', { eip155: { chains: ['eip155:1'] } });
      kv.set('wc@2:client:0.3:clientTwo//session', [session('EVM', 'eip155')]);
      kv.set('wc@2:client:0.3:solana//session', [full('DEAD', now() - 10)]);
      kv.set('wc@2:core:0.3:solana//expirer', [{ target: 'topic:DEAD', expiry: now() - 10 }]);
      const outside = () =>
        Object.fromEntries([...kv].filter(([k]) => !/:solana\/\//.test(k)).map(([k, v]) => [k, JSON.stringify(v)]));
      const before = outside();

      const sol = await SignClient.init(signClientOptions('00000000000000000000000000000000', 'https://x.test', storage));
      // Offline: nothing below may reach a relay.
      const relayer = sol.core.relayer as unknown as Record<string, unknown>;
      relayer.publish = async () => {};
      relayer.publishCustom = async () => {};
      relayer.subscribe = async () => 'sub';
      relayer.unsubscribe = async () => {};
      // The start-up cleanup ran — on THIS store — so its deleteSession was exercised.
      await vi.waitFor(() =>
        expect(((kv.get('wc@2:client:0.3:solana//session') as Array<{ topic: string }>) ?? []).map((s) => s.topic)).toEqual([]),
      );

      await sol.core.crypto.keychain.set('SOL', 'c'.repeat(64));
      await sol.session.set('SOL', full('SOL', now() + 86_400) as never);
      await sol.session.update('SOL', { sessionConfig: { disableDeepLink: true } });
      await sol.disconnect({ topic: 'SOL', reason: { message: 'User disconnected.', code: 6000 } });
      expect(((kv.get('wc@2:client:0.3:solana//session') as Array<{ topic: string }>) ?? []).map((s) => s.topic)).toEqual([]);

      expect(outside()).toEqual(before);
    });
  });

  it('sign-client still honours a session\'s disableDeepLink (the flag the adapter sets)', () => {
    const require = createRequire(import.meta.url);
    const dist = readFileSync(require.resolve('@walletconnect/sign-client').replace(/index\.cjs$/, 'index.js'), 'utf8');
    expect(dist).toMatch(/sessionConfig\?\.disableDeepLink/);
    expect(dist).toMatch(/WALLETCONNECT_DEEPLINK_CHOICE/);
  });
});
