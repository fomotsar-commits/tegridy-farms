// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  WalletReadyState,
  WalletNotConnectedError,
  WalletNotReadyError,
} from '@solana/wallet-adapter-base';
import {
  CoinbaseWalletAdapter,
  CoinbaseWalletName,
  IPadAwarePhantomWalletAdapter,
  MetaMaskWalletAdapter,
  MetaMaskWalletName,
  TrustWalletAdapter,
  TrustWalletName,
} from './solanaWallets';

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

function setTouchPoints(n: number) {
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: n, configurable: true });
}

// iPadOS 13+ Safari sends exactly a Mac's UA; only touch tells them apart.
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
// An in-app WKWebView on that iPad: same UA shape, but no Safari token.
const IPAD_WEBVIEW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

/** Replace location with a plain object so href assignment is observable. */
function setLocation(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    value: { href, origin: url.origin, host: url.host, pathname: url.pathname, search: url.search },
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
  setTouchPoints(0);
  delete (window as unknown as { trustwallet?: unknown }).trustwallet;
  delete (window as unknown as { coinbaseSolana?: unknown }).coinbaseSolana;
  delete (window as unknown as { ethereum?: unknown }).ethereum;
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

// ─────────────────────────────────────────────────────────────────────────────
// MetaMask — a deep-link row that never signs
// ─────────────────────────────────────────────────────────────────────────────

const BAYLA_CARD = 'https://memetics.finance/farm?bungalow=bayla';

describe('MetaMaskWalletAdapter', () => {
  it('is named exactly "MetaMask", the name MetaMask registers its Solana wallet under', () => {
    // The extension and MetaMask Mobile's in-app browser both register a
    // Standard wallet called "MetaMask". Anything else would leave this dead
    // row sitting next to the real, working one.
    expect(MetaMaskWalletName).toBe('MetaMask');
    expect(new MetaMaskWalletAdapter().name).toBe('MetaMask');
  });

  it('declares legacy and v0, as MetaMask itself does', () => {
    const versions = new MetaMaskWalletAdapter().supportedTransactionVersions;
    expect(versions!.has(0)).toBe(true);
    expect(versions!.has('legacy')).toBe(true);
  });

  it('desktop with no extension is NotDetected, pointing at the download page', () => {
    const adapter = new MetaMaskWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.NotDetected);
    expect(adapter.url).toBe('https://metamask.io/download');
  });

  it.each([
    ['iOS Safari', UA.iosSafari],
    ['Android Chrome', UA.androidChrome],
  ])('%s is Loadable', (_label, ua) => {
    setUserAgent(ua);
    expect(new MetaMaskWalletAdapter().readyState).toBe(WalletReadyState.Loadable);
  });

  it('never offers the hop from inside a webview, or from inside MetaMask', () => {
    setUserAgent(UA.iosTrustInApp);
    expect(new MetaMaskWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
    setUserAgent(UA.androidWebView);
    expect(new MetaMaskWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
    // A MetaMask build whose UA did carry "Safari" must still not bounce
    // into itself.
    setUserAgent(`${UA.iosSafari} WebView MetaMaskMobile`);
    expect(new MetaMaskWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
  });

  it('opens this exact page inside MetaMask, query string and all', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(UA.iosSafari);
    await new MetaMaskWalletAdapter().connect();
    expect(window.location.href).toBe('https://metamask.app.link/dapp/memetics.finance/farm?bungalow=bayla');
  });

  it('autoConnect never navigates', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(UA.iosSafari);
    const adapter = new MetaMaskWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.Loadable);
    await adapter.autoConnect();
    expect(window.location.href).toBe(BAYLA_CARD);
  });

  it('desktop with no extension refuses, and does not navigate', async () => {
    const adapter = new MetaMaskWalletAdapter();
    adapter.on('error', () => {});
    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletNotReadyError);
    expect(window.location.href).toBe(PAGE);
  });

  it('never signs — the real MetaMask wallet replaces this row first', async () => {
    const adapter = new MetaMaskWalletAdapter();
    adapter.on('error', () => {});
    expect(adapter.connected).toBe(false);
    await expect(adapter.signTransaction({} as never)).rejects.toBeInstanceOf(WalletNotConnectedError);
    await expect(adapter.signMessage(new Uint8Array(1))).rejects.toBeInstanceOf(WalletNotConnectedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase Wallet
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => void;

function injectCoinbase(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const provider = {
    publicKey: undefined as PublicKey | undefined,
    connect: vi.fn(async () => {
      provider.publicKey = new PublicKey(WSOL);
    }),
    disconnect: vi.fn(async () => {
      provider.publicKey = undefined;
    }),
    signTransaction: vi.fn(async <T,>(t: T) => t),
    signAllTransactions: vi.fn(async <T,>(t: T[]) => t),
    signAndSendTransaction: vi.fn(async () => ({ signature: 'sig-from-coinbase' })),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    on: (e: string, h: Handler) => {
      if (!handlers.has(e)) handlers.set(e, new Set());
      handlers.get(e)!.add(h);
    },
    off: (e: string, h: Handler) => handlers.get(e)?.delete(h),
    emit: (e: string) => handlers.get(e)?.forEach((h) => h()),
    ...overrides,
  };
  (window as unknown as { coinbaseSolana?: unknown }).coinbaseSolana = provider;
  return provider;
}

describe('CoinbaseWalletAdapter', () => {
  it('keeps upstream’s name, "Coinbase Wallet"', () => {
    expect(CoinbaseWalletName).toBe('Coinbase Wallet');
    expect(new CoinbaseWalletAdapter().name).toBe('Coinbase Wallet');
  });

  it('declares legacy and v0, as upstream does', () => {
    const versions = new CoinbaseWalletAdapter().supportedTransactionVersions;
    expect(versions!.has(0)).toBe(true);
    expect(versions!.has('legacy')).toBe(true);
  });

  it('desktop with no extension is NotDetected, pointing at Coinbase’s downloads page', () => {
    const adapter = new CoinbaseWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.NotDetected);
    expect(adapter.url).toContain('coinbase.com');
  });

  it('an injected provider is Installed', () => {
    injectCoinbase();
    expect(new CoinbaseWalletAdapter().readyState).toBe(WalletReadyState.Installed);
  });

  it.each([
    ['iOS Safari', UA.iosSafari],
    ['Android Chrome', UA.androidChrome],
  ])('%s with no provider is Loadable', (_label, ua) => {
    setUserAgent(ua);
    expect(new CoinbaseWalletAdapter().readyState).toBe(WalletReadyState.Loadable);
  });

  it('never offers the hop from a webview, or from inside Coinbase’s own browser', () => {
    setUserAgent(UA.androidWebView);
    expect(new CoinbaseWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
    setUserAgent(UA.iosSafari);
    (window as unknown as { ethereum?: unknown }).ethereum = { isCoinbaseBrowser: true };
    expect(new CoinbaseWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
  });

  it('an injected provider beats the deep link even on a redirectable UA', () => {
    setUserAgent(UA.iosSafari);
    injectCoinbase();
    expect(new CoinbaseWalletAdapter().readyState).toBe(WalletReadyState.Installed);
  });

  it('upgrades Loadable to Installed when the provider injects late', () => {
    setUserAgent(UA.androidChrome);
    const adapter = new CoinbaseWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.Loadable);
    injectCoinbase();
    vi.advanceTimersByTime(1100);
    expect(adapter.readyState).toBe(WalletReadyState.Installed);
  });

  it('opens the CURRENT url inside Coinbase, with the link Reown uses for Solana', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(UA.iosSafari);
    await new CoinbaseWalletAdapter().connect();
    expect(window.location.href).toBe(`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(BAYLA_CARD)}`);
  });

  it('autoConnect never navigates from the Loadable state', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(UA.iosSafari);
    const adapter = new CoinbaseWalletAdapter();
    await adapter.autoConnect();
    expect(window.location.href).toBe(BAYLA_CARD);
  });

  it('desktop with no extension refuses, and does not navigate', async () => {
    const adapter = new CoinbaseWalletAdapter();
    adapter.on('error', () => {});
    await expect(adapter.connect()).rejects.toBeInstanceOf(WalletNotReadyError);
    expect(window.location.href).toBe(PAGE);
  });

  it('connects through the injected provider', async () => {
    injectCoinbase();
    const adapter = new CoinbaseWalletAdapter();
    await adapter.connect();
    expect(adapter.connected).toBe(true);
    expect(adapter.publicKey?.toBase58()).toBe(WSOL);
  });

  it('keeps signTransaction, which the Streamflow staking path calls directly', async () => {
    // Streamflow checks `signTransaction !== undefined` and otherwise treats
    // the adapter as a raw keypair — a crash, not a signature.
    const provider = injectCoinbase();
    const adapter = new CoinbaseWalletAdapter();
    await adapter.connect();
    const tx = { marker: 'v0' };
    await expect(adapter.signTransaction(tx as never)).resolves.toBe(tx);
    expect(provider.signTransaction).toHaveBeenCalledWith(tx);
  });

  it('sends a versioned transaction through the wallet’s own signAndSendTransaction', async () => {
    const provider = injectCoinbase();
    const adapter = new CoinbaseWalletAdapter();
    await adapter.connect();
    const message = new TransactionMessage({
      payerKey: new PublicKey(WSOL),
      recentBlockhash: WSOL,
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const connection = { commitment: 'confirmed' } as never;
    await expect(adapter.sendTransaction(tx, connection)).resolves.toBe('sig-from-coinbase');
    expect(provider.signAndSendTransaction).toHaveBeenCalledWith(tx, { preflightCommitment: 'confirmed' });
  });

  it('a wallet-side disconnect clears the account', async () => {
    const provider = injectCoinbase();
    const adapter = new CoinbaseWalletAdapter();
    adapter.on('error', () => {});
    await adapter.connect();
    provider.emit('disconnect');
    expect(adapter.connected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// iPad, and MetaMask's link host
// ─────────────────────────────────────────────────────────────────────────────

describe('iPad Safari (a Mac user agent with touch)', () => {
  it.each([
    ['Trust', () => new TrustWalletAdapter()],
    ['MetaMask', () => new MetaMaskWalletAdapter()],
    ['Coinbase Wallet', () => new CoinbaseWalletAdapter()],
  ])('%s is Loadable on an iPad, so the row opens the app instead of "Install"', (_name, make) => {
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(5);
    expect(make().readyState).toBe(WalletReadyState.Loadable);
  });

  it.each([
    ['Trust', () => new TrustWalletAdapter()],
    ['MetaMask', () => new MetaMaskWalletAdapter()],
    ['Coinbase Wallet', () => new CoinbaseWalletAdapter()],
  ])('%s stays NotDetected on a real Mac, and in an in-app webview on iPad', (_name, make) => {
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(0);
    expect(make().readyState).toBe(WalletReadyState.NotDetected);
    setUserAgent(IPAD_WEBVIEW_UA);
    setTouchPoints(5);
    expect(make().readyState).toBe(WalletReadyState.NotDetected);
  });
});

describe('MetaMaskWalletAdapter — the link host cannot be steered', () => {
  it('drops query keys the link host reads as redirect instructions, keeps ours', async () => {
    // metamask.app.link is a Branch link. Branch treats `$…`, `~…` and `+…`
    // keys as its own settings — `$fallback_url` among them — and the page's
    // query is copied straight into the link.
    setLocation(
      'https://memetics.finance/farm?bungalow=bayla&$fallback_url=https%3A%2F%2Fevil.example&~channel=x&%2Bnon_branch_link=y&$ios_url=z',
    );
    setUserAgent(UA.iosSafari);
    await new MetaMaskWalletAdapter().connect();
    expect(window.location.href).toBe('https://metamask.app.link/dapp/memetics.finance/farm?bungalow=bayla');
  });

  it('a page with no query gets a link with no query', async () => {
    setLocation('https://memetics.finance/solana');
    setUserAgent(UA.iosSafari);
    await new MetaMaskWalletAdapter().connect();
    expect(window.location.href).toBe('https://metamask.app.link/dapp/memetics.finance/solana');
  });
});

describe('IPadAwarePhantomWalletAdapter — upstream Phantom, plus the iPad', () => {
  afterEach(() => {
    delete (window as unknown as { phantom?: unknown }).phantom;
    delete (window as unknown as { isPhantomInstalled?: unknown }).isPhantomInstalled;
  });

  it('keeps the name "Phantom", so Phantom’s own registration still replaces it', () => {
    expect(new IPadAwarePhantomWalletAdapter().name).toBe('Phantom');
  });

  it('an iPad (Mac UA with touch) is Loadable and opens the page inside Phantom', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(5);
    const adapter = new IPadAwarePhantomWalletAdapter();
    expect(adapter.readyState).toBe(WalletReadyState.Loadable);
    await adapter.connect();
    expect(window.location.href).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(BAYLA_CARD)}?ref=${encodeURIComponent('https://memetics.finance')}`,
    );
  });

  it('autoConnect on an iPad never navigates', async () => {
    setLocation(BAYLA_CARD);
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(5);
    await new IPadAwarePhantomWalletAdapter().autoConnect();
    expect(window.location.href).toBe(BAYLA_CARD);
  });

  it('a real Mac, and an in-app webview on iPad, stay NotDetected', () => {
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(0);
    expect(new IPadAwarePhantomWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
    setUserAgent(IPAD_WEBVIEW_UA);
    setTouchPoints(5);
    expect(new IPadAwarePhantomWalletAdapter().readyState).toBe(WalletReadyState.NotDetected);
  });

  it('inside Phantom on an iPad (provider injected) it is Installed, never a loop', () => {
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(5);
    // What Phantom's in-app browser injects; upstream needs both flags.
    (window as unknown as { isPhantomInstalled?: boolean }).isPhantomInstalled = true;
    (window as unknown as { phantom?: unknown }).phantom = { solana: { isPhantom: true } };
    const adapter = new IPadAwarePhantomWalletAdapter();
    vi.advanceTimersByTime(1100);
    expect(adapter.readyState).toBe(WalletReadyState.Installed);
  });

  it('a half-injected Phantom (no isPhantomInstalled yet) is not offered the hop', () => {
    setUserAgent(MAC_SAFARI_UA);
    setTouchPoints(5);
    (window as unknown as { phantom?: unknown }).phantom = { solana: { isPhantom: true } };
    expect(new IPadAwarePhantomWalletAdapter().readyState).not.toBe(WalletReadyState.Loadable);
  });

  it('an iPhone still takes upstream’s own path', () => {
    setUserAgent(UA.iosSafari);
    expect(new IPadAwarePhantomWalletAdapter().readyState).toBe(WalletReadyState.Loadable);
  });
});
