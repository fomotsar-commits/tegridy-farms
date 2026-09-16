// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { WalletReadyState, WalletNotReadyError } from '@solana/wallet-adapter-base';
import { TrustWalletAdapter, TrustWalletName } from './solanaWallets';

/**
 * The states that decide whether a Trust user can stake at the bungalow, or
 * just looks at a modal with nothing in it. Every assertion here is a state
 * that shipped broken before 2026-09-14, or a way this adapter could break the
 * page if it were wired carelessly.
 */

const WSOL = 'So11111111111111111111111111111111111111112';
const PAGE = 'https://memetics.finance/island/bayla';

const UA = {
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  // Trust's own iOS in-app browser: a WKWebView, so no "Safari" token.
  iosTrustInApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Trust/9.12',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36',
};

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

/** Replace location with a plain object so href assignment is observable. */
function setLocation(href: string) {
  Object.defineProperty(window, 'location', {
    value: { href, origin: new URL(href).origin },
    writable: true,
    configurable: true,
  });
}

type FakeProvider = {
  isTrust: boolean;
  isConnected: boolean;
  publicKey: unknown;
  connect: () => Promise<{ publicKey?: unknown } | void>;
  disconnect: () => Promise<void>;
  signTransaction: <T>(t: T) => Promise<T>;
  signMessage: (m: Uint8Array) => Promise<{ signature: Uint8Array } | Uint8Array>;
  on?: (e: string, h: (...a: never[]) => void) => void;
  off?: (e: string, h: (...a: never[]) => void) => void;
};

function injectTrust(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const provider: FakeProvider = {
    isTrust: true,
    isConnected: false,
    publicKey: null,
    connect: async () => {
      provider.isConnected = true;
      provider.publicKey = WSOL;
      return { publicKey: provider.publicKey };
    },
    disconnect: async () => {
      provider.isConnected = false;
      provider.publicKey = null;
    },
    signTransaction: async (t) => t,
    signMessage: async () => new Uint8Array(64),
    on: () => {},
    off: () => {},
    ...overrides,
  };
  (window as unknown as { trustwallet?: unknown }).trustwallet = { solana: provider };
  return provider;
}

beforeEach(() => {
  setLocation(PAGE);
  setUserAgent(UA.desktopChrome);
  delete (window as unknown as { trustwallet?: unknown }).trustwallet;
  // The adapter's detection polls once a second until it finds a provider.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TrustWalletAdapter — the dedupe contract', () => {
  it('is named exactly "Trust", the name Trust registers under', () => {
    // useStandardWalletAdapters drops a legacy adapter whose `name` matches a
    // registered Standard wallet, by EXACT string. "Trust Wallet" (what the
    // EVM modal calls it) would show the user two Trust rows, one of them
    // dead. This assertion is the whole dedupe mechanism.
    expect(TrustWalletName).toBe('Trust');
    expect(new TrustWalletAdapter().name).toBe('Trust');
  });

  it('declares the transaction versions this venue actually sends', () => {
    const versions = new TrustWalletAdapter().supportedTransactionVersions;
    expect(versions).toBeTruthy();
    expect(versions!.has(0)).toBe(true);
    expect(versions!.has('legacy')).toBe(true);
  });
});

describe('TrustWalletAdapter — readyState', () => {
  it('desktop with no extension is NotDetected, and offers an install link', () => {
    const adapter = new TrustWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.NotDetected);
    expect(adapter.url).toContain('trustwallet.com');
  });

  it('an injected provider is Installed', () => {
    injectTrust();
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.Installed);
  });

  it('iOS Safari with no provider is Loadable, not a dead NotDetected', () => {
    setUserAgent(UA.iosSafari);
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.Loadable);
  });

  it('Android Chrome with no provider is Loadable', () => {
    setUserAgent(UA.androidChrome);
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.Loadable);
  });

  it('never offers the deep link from inside a webview', () => {
    // Deep-linking a user who is already in someone's in-app browser is a
    // loop, not a connection. Both platforms' webview tells are checked.
    setUserAgent(UA.iosTrustInApp);
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
    setUserAgent(UA.androidWebView);
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
  });

  it('an injected provider beats the deep link even on a redirectable UA', () => {
    // Trust's in-app browser on a build whose UA does carry "Safari" would
    // otherwise be bounced out of itself.
    setUserAgent(UA.iosSafari);
    injectTrust();
    expect(new TrustWalletAdapter().readyState).toBe(WalletReadyState.Installed);
  });

  it('upgrades Loadable to Installed when the provider injects late', () => {
    setUserAgent(UA.androidChrome);
    const adapter = new TrustWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.Loadable);
    injectTrust();
    vi.advanceTimersByTime(1100);
    expect(adapter.readyState).toBe(WalletReadyState.Installed);
  });
});

describe('TrustWalletAdapter — connect', () => {
  it('deep-links the CURRENT url into Trust, with Solana’s slip44 index', () => {
    setUserAgent(UA.iosSafari);
    const adapter = new TrustWalletAdapter();
    return adapter.connect().then(() => {
      expect(window.location.href).toBe(
        `https://link.trustwallet.com/open_url?coin_id=501&url=${encodeURIComponent(PAGE)}`,
      );
    });
  });

  it('autoConnect NEVER navigates from the Loadable state', async () => {
    // WalletProvider mounts with autoConnect. If autoConnect reached the deep
    // link, every returning visitor whose stored wallet is Trust would be
    // thrown off the island on page load, without touching anything.
    setUserAgent(UA.iosSafari);
    const adapter = new TrustWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.Loadable);
    await adapter.autoConnect();
    expect(window.location.href).toBe(PAGE);
  });

  it('desktop with no extension refuses, and does not navigate', async () => {
    const adapter = new TrustWalletAdapter();
    adapter.on('error', () => {});
    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletNotReadyError);
    expect(window.location.href).toBe(PAGE);
  });

  it('connects through the injected provider', async () => {
    injectTrust();
    const adapter = new TrustWalletAdapter();
    await adapter.connect();
    expect(adapter.connected).toBe(true);
    expect(adapter.publicKey?.toBase58()).toBe(WSOL);
  });

  it.each([
    ['a base58 string', WSOL],
    ['a PublicKey', new PublicKey(WSOL)],
    ['an object with toBytes()', { toBytes: () => new PublicKey(WSOL).toBytes() }],
  ])('reads the account when Trust returns %s', async (_label, shape) => {
    // Three real shapes across Trust builds. Reading only one of them and
    // calling the rest "no account" is the degraded-read bug this venue keeps
    // paying for.
    injectTrust({
      isConnected: true,
      publicKey: shape,
      connect: async () => ({ publicKey: shape }),
    });
    const adapter = new TrustWalletAdapter();
    await adapter.connect();
    expect(adapter.publicKey?.toBase58()).toBe(WSOL);
  });

  it('connects on a build whose provider is not an EventEmitter', async () => {
    // `on`/`off` are not contractual on the injected object. A missing `on`
    // must not TypeError the whole connect.
    injectTrust({ on: undefined, off: undefined });
    const adapter = new TrustWalletAdapter();
    await adapter.connect();
    expect(adapter.connected).toBe(true);
  });
});
