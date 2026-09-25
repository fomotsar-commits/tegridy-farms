// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import './solanaPolyfill';
import {
  BaseMessageSignerWalletAdapter,
  WalletAccountError,
  WalletConnectionError,
  WalletDisconnectedError,
  WalletDisconnectionError,
  WalletError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletPublicKeyError,
  WalletReadyState,
  WalletSendTransactionError,
  WalletSignMessageError,
  WalletSignTransactionError,
  isVersionedTransaction,
  scopePollingDetectionStrategy,
  type EventEmitter,
  type SendTransactionOptions,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import {
  PublicKey,
  type Connection,
  type SendOptions,
  type Transaction,
  type TransactionSignature,
  type VersionedTransaction,
} from '@solana/web3.js';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { METAMASK_ICON, TRUST_ICON } from './walletIcons';

/**
 * The Solana sibling of rainbowkitWallets.ts: wallets this venue adds to the
 * Solana connect modal that the packaged adapters get wrong — Trust, MetaMask
 * and Coinbase Wallet. Each section below says why it is vendored rather than
 * installed. The Trust history comes first because it set the pattern.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT `@solana/wallet-adapter-trust` ──
 *
 * On 2026-09-02 (b5109cc8) Trust was shipped to the EVM modal and deliberately
 * kept OFF Solana, because `@solana/wallet-adapter-trust` declares
 * `supportedTransactionVersions = null`. That reads like "all versions" and
 * means the opposite: wallet-adapter-base narrows null to a bare legacy
 * `Transaction`, so every one of this venue's write paths — all of which send
 * v0 — would have thrown. Connect-then-dead-end, worse than not listing it.
 *
 * That call was right about the PACKAGE and wrong about the WALLET. The
 * package is stale metadata; Trust itself has signed v0 for years. Three
 * independent confirmations, all read from Trust's own sources:
 *
 *  1. trustwallet/trust-web3-provider `adapter/src/wallet.ts` — Trust's own
 *     Wallet Standard implementation — declares
 *     `supportedTransactionVersions: ['legacy', 0]` on BOTH
 *     `solana:signTransaction` and `solana:signAndSendTransaction`.
 *  2. Its injected provider (`src/solana_provider.js`) reads `tx.version` and
 *     serializes with `requireAllSignatures: false, verifySignatures: false`
 *     — the versioned-transaction path, not the legacy one.
 *  3. wallet-core has shipped `VersionedTx`/`V0Message` since PR #2935
 *     (merged 2023-02-20), which closed the "[Solana] Support versioned
 *     transactions" issue.
 *
 * Verified against @solana/wallet-adapter-trust@0.1.18 (published 2026-09-10):
 * the package STILL says `null`, and still has no Loadable branch, so adopting
 * it remains the wrong move. Hence a vendored adapter, exactly as the EVM side
 * vendors its two.
 *
 * ── WHAT THIS ADAPTER IS FOR ──
 *
 * Trust registers itself via the Wallet Standard, so where that registration
 * lands, `useStandardWalletAdapters` already surfaces it and DROPS this
 * adapter by name (see the name constant below). This adapter covers the three
 * states the Standard cannot reach, which is where the venue's Trust users
 * actually were:
 *
 *  - desktop with no Trust extension — the modal lists Trust with an install
 *    link instead of showing nothing;
 *  - a mobile browser that is not Trust's own — `connect()` deep-links the
 *    current URL into Trust's in-app browser, the way Phantom's adapter
 *    deep-links into Phantom's;
 *  - Trust's in-app browser on a build whose Standard registration has not
 *    landed — the injected provider is still there, and this adapter uses it.
 */

/** SLIP-44 index for Solana — the `coin_id` Trust's open_url link expects. */
const SOLANA_SLIP44 = 501;
const TRUST_OPEN_URL = 'https://link.trustwallet.com/open_url';

/**
 * MUST be exactly "Trust" — the `name` Trust's own Wallet Standard wallet
 * registers under. `useStandardWalletAdapters` dedupes by exact name match, so
 * this string is what makes this adapter disappear (with an upstream
 * console.warn) the moment Trust's real registration is present. Spelling it
 * "Trust Wallet" the way the EVM modal does would show the user TWO Trust rows
 * and let them pick the dead one.
 */
export const TrustWalletName = 'Trust' as WalletName<'Trust'>;

interface TrustSolanaProvider {
  isTrust?: boolean;
  isConnected?: boolean;
  publicKey?: unknown;
  connect(): Promise<{ publicKey?: unknown } | void>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array } | Uint8Array>;
  on?(event: string, handler: (...args: never[]) => void): void;
  off?(event: string, handler: (...args: never[]) => void): void;
}

/** The injected provider, or undefined. Never throws, never caches. */
function trustProvider(): TrustSolanaProvider | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { trustwallet?: { solana?: TrustSolanaProvider } }).trustwallet
    ?.solana;
}

/**
 * Is this a mobile browser we may redirect OUT of, into Trust's in-app one?
 *
 * The iOS half is upstream's `isIosAndRedirectable` heuristic verbatim: an iOS
 * in-app webview does not carry "safari" in its UA, so requiring "safari"
 * keeps us from bouncing a user who is already inside somebody's in-app
 * browser. The Android half is the same idea with Android's own tell — a
 * WebView UA carries "; wv". Callers must ALSO check that no Trust provider is
 * injected; a redirect out of Trust's own browser would be a loop.
 *
 * iPad (2026-09-24): since iPadOS 13, iPad Safari sends a UA byte-identical to
 * a Mac's, with no "ipad" in it, so the iOS branch above was unreachable there
 * and every iPad row read "Install" even with the app on the device. The tell
 * that separates the two is touch: a Mac reports maxTouchPoints 0. The
 * "safari" requirement still applies, so an in-app WKWebView on iPad (no
 * "safari" token) is not bounced. Upstream Phantom's own helper has the same
 * blind spot; IPadAwarePhantomWalletAdapter below covers it.
 */
function isMobileAndRedirectable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || isDesktopClassIPad()) return ua.includes('safari');
  if (ua.includes('android')) return !ua.includes('; wv');
  return false;
}

/** iPadOS 13+ Safari: a Mac's user agent, on a device that reports touch. */
function isDesktopClassIPad(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.toLowerCase().includes('macintosh') && (navigator.maxTouchPoints ?? 0) > 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phantom on iPad
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upstream's PhantomWalletAdapter, unchanged except on an iPad.
 *
 * Upstream decides "open the page inside Phantom" with isIosAndRedirectable,
 * which looks for "iphone"/"ipad" in the user agent. iPad Safari has sent a
 * Mac's user agent since iPadOS 13, so on an iPad Phantom read "Install" and a
 * tap opened phantom.app, even with the app on the device — the same blind
 * spot fixed for Trust, MetaMask and Coinbase in isMobileAndRedirectable
 * above. This subclass reports Loadable in exactly that case. Everything else
 * is upstream's: its connect() and autoConnect() both read `this.readyState`,
 * so the deep link (phantom.app/ul/browse/...) and the no-redirect-on-page-load
 * guard follow from this one getter. The name stays "Phantom", so Phantom's
 * own Wallet Standard registration still replaces it wherever it exists.
 */
export class IPadAwarePhantomWalletAdapter extends PhantomWalletAdapter {
  override get readyState(): WalletReadyState {
    const upstream = super.readyState;
    if (upstream === WalletReadyState.NotDetected && isMobileAndRedirectable() && isDesktopClassIPad() && !phantomInjected()) {
      return WalletReadyState.Loadable;
    }
    return upstream;
  }
}

/**
 * Any sign of Phantom's Solana provider. Deliberately LOOSER than upstream's
 * Installed test (adapter.js also requires window.isPhantomInstalled): this
 * only decides whether to offer a hop INTO Phantom, and any trace of its
 * provider means the page is already inside Phantom, where that hop would
 * be a loop.
 */
function phantomInjected(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { phantom?: { solana?: { isPhantom?: boolean } }; solana?: { isPhantom?: boolean } };
  return Boolean(w.phantom?.solana?.isPhantom || w.solana?.isPhantom);
}

/**
 * Trust hands back a public key in whichever of three shapes its build
 * favours. Reading only one of them and calling the other two "not connected"
 * is the failure this venue keeps writing down: an unreadable value must not
 * read as absent.
 */
function toPublicKey(value: unknown): PublicKey {
  if (value instanceof PublicKey) return value;
  if (typeof value === 'string') return new PublicKey(value);
  const candidate = value as { toBytes?: () => Uint8Array; toString?: () => string };
  if (typeof candidate?.toBytes === 'function') return new PublicKey(candidate.toBytes());
  if (typeof candidate?.toString === 'function') return new PublicKey(candidate.toString());
  throw new Error('Trust returned a public key in an unrecognised shape');
}

export class TrustWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = TrustWalletName;
  url = 'https://trustwallet.com/browser-extension';
  icon = TRUST_ICON;

  /**
   * ['legacy', 0] — Trust's own declaration, not the stale package's null.
   * See the three sources cited in this file's header before changing it; the
   * WALLET-04 guard (solanaAdapterSupport.test.ts) fails the moment this goes
   * falsy, which is the whole point of that test.
   */
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set([
    'legacy' as const,
    0 as const,
  ]);

  private _connecting = false;
  private _wallet: TrustSolanaProvider | null = null;
  private _publicKey: PublicKey | null = null;
  private _readyState: WalletReadyState =
    typeof window === 'undefined' || typeof document === 'undefined'
      ? WalletReadyState.Unsupported
      : WalletReadyState.NotDetected;

  constructor() {
    super();
    if (this._readyState === WalletReadyState.Unsupported) return;

    // Poll UNCONDITIONALLY, unlike upstream's either/or: Trust's in-app
    // browser injects late on some Android builds, and an injected provider
    // must always win over the deep link. Detection upgrades Loadable ->
    // Installed; it never downgrades.
    scopePollingDetectionStrategy(() => {
      if (!trustProvider()?.isTrust) return false;
      this._readyState = WalletReadyState.Installed;
      this.emit('readyStateChange', this._readyState);
      return true;
    });

    // A mobile browser that is not Trust's own gets the deep link rather than
    // a dead "not installed" row pointing at a desktop extension.
    if (!trustProvider() && isMobileAndRedirectable()) {
      this._readyState = WalletReadyState.Loadable;
      this.emit('readyStateChange', this._readyState);
    }
  }

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  /**
   * Autoconnect must NEVER reach the Loadable branch. WalletProvider mounts
   * with autoConnect, so a returning visitor whose stored wallet is Trust
   * would otherwise be navigated off the page — into a deep link they did not
   * click — on every single load. Upstream guards this the same way.
   */
  override async autoConnect(): Promise<void> {
    if (this.readyState === WalletReadyState.Installed) {
      await this.connect();
    }
  }

  async connect(): Promise<void> {
    try {
      if (this.connected || this.connecting) return;
      const provider = trustProvider();

      if (!provider) {
        if (this._readyState === WalletReadyState.Loadable) {
          // Open the CURRENT url inside Trust's in-app browser, where the
          // provider exists. Not a connection — a handoff; the connect happens
          // again on the other side.
          const target = encodeURIComponent(window.location.href);
          window.location.href = `${TRUST_OPEN_URL}?coin_id=${SOLANA_SLIP44}&url=${target}`;
          return;
        }
        throw new WalletNotReadyError();
      }

      this._connecting = true;

      let account = provider.publicKey;
      if (!provider.isConnected || !account) {
        try {
          const result = await provider.connect();
          account = provider.publicKey ?? (result as { publicKey?: unknown } | undefined)?.publicKey;
        } catch (error) {
          throw new WalletConnectionError((error as Error)?.message, error);
        }
      }
      if (!account) throw new WalletAccountError();

      let publicKey: PublicKey;
      try {
        publicKey = toPublicKey(account);
      } catch (error) {
        throw new WalletPublicKeyError((error as Error)?.message, error);
      }

      // Guarded: the injected provider is not contractually an EventEmitter,
      // and a build without `on` must still connect rather than TypeError.
      if (typeof provider.on === 'function') {
        provider.on('disconnect', this._disconnected as (...args: never[]) => void);
        provider.on('accountChanged', this._accountChanged as (...args: never[]) => void);
      }

      this._wallet = provider;
      this._publicKey = publicKey;
      this.emit('connect', publicKey);
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const wallet = this._wallet;
    if (wallet) {
      if (typeof wallet.off === 'function') {
        wallet.off('disconnect', this._disconnected as (...args: never[]) => void);
        wallet.off('accountChanged', this._accountChanged as (...args: never[]) => void);
      }
      this._wallet = null;
      this._publicKey = null;
      try {
        await wallet.disconnect();
      } catch (error) {
        this.emit('error', new WalletDisconnectionError((error as Error)?.message, error));
      }
    }
    this.emit('disconnect');
  }

  /**
   * The only signing primitive this adapter implements, deliberately.
   * BaseSignerWalletAdapter derives `sendTransaction` (sign + sendRawTransaction,
   * gated on supportedTransactionVersions) and `signAllTransactions` from it,
   * so the swap/limit/DCA paths and the Streamflow staking path — which calls
   * `invoker.signTransaction` directly — both run through this one method.
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        return (await wallet.signTransaction(transaction)) || transaction;
      } catch (error) {
        throw new WalletSignTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        const result = await wallet.signMessage(message);
        // Phantom answers `{ signature }`; some Trust builds answer the bytes
        // directly. Accept both, and refuse anything else out loud rather than
        // handing back a value that is not a signature.
        const signature =
          result instanceof Uint8Array
            ? result
            : (result as { signature?: Uint8Array } | undefined)?.signature;
        if (!(signature instanceof Uint8Array)) {
          throw new Error('Trust returned no signature');
        }
        return signature;
      } catch (error) {
        throw new WalletSignMessageError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  private _disconnected = () => {
    const wallet = this._wallet;
    if (!wallet) return;
    if (typeof wallet.off === 'function') {
      wallet.off('disconnect', this._disconnected as (...args: never[]) => void);
      wallet.off('accountChanged', this._accountChanged as (...args: never[]) => void);
    }
    this._wallet = null;
    this._publicKey = null;
    this.emit('error', new WalletDisconnectedError());
    this.emit('disconnect');
  };

  private _accountChanged = (newPublicKey?: unknown) => {
    const publicKey = this._publicKey;
    if (!publicKey) return;
    // Trust emits this with no argument on some builds, meaning "the account
    // is gone". Treat that as a disconnect, never as "unchanged".
    if (newPublicKey === undefined || newPublicKey === null) {
      this._disconnected();
      return;
    }
    let next: PublicKey;
    try {
      next = toPublicKey(newPublicKey);
    } catch (error) {
      this.emit('error', new WalletPublicKeyError((error as Error)?.message, error));
      return;
    }
    if (publicKey.equals(next)) return;
    this._publicKey = next;
    this.emit('connect', next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaMask
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MUST be exactly "MetaMask" — the name MetaMask's own Solana wallet registers
 * under through the Wallet Standard, in the desktop extension
 * (app/scripts/inpage.js → registerSolanaWalletStandard, walletName from
 * METAMASK_BUILD_NAME) and in MetaMask Mobile's in-app browser
 * (scripts/inpage-bridge → injectSolanaWalletStandard). Where that registration
 * lands, `useStandardWalletAdapters` drops this adapter by exact name and the
 * real wallet — which declares ['legacy', 0] on both solana:signTransaction and
 * solana:signAndSendTransaction — takes the row. Verified live 2026-09-24 on
 * /farm?bungalow=bayla in a browser with the extension installed.
 */
export const MetaMaskWalletName = 'MetaMask' as WalletName<'MetaMask'>;

/**
 * MetaMask's universal link that opens a page inside MetaMask Mobile's in-app
 * browser. The target is written WITHOUT a scheme — the app strips everything
 * up to `/dapp/` and prefixes https:// itself (metamask-mobile
 * handleUniversalLink). `dapp` is on the app's whitelist of actions that skip
 * its interstitial warning (v8.12.0), so this is a single hop.
 */
const METAMASK_DAPP_LINK = 'https://metamask.app.link/dapp/';

/**
 * The page's own query string, minus any key Branch (metamask.app.link's link
 * host) reads as an instruction — `$fallback_url`, `$ios_url`, `~channel`,
 * `+clicked_branch_link` and the rest all start with `$`, `~` or `+`. The
 * target is written into the link unencoded, so the page's query BECOMES the
 * link's query; without this a crafted link to our own page could ask Branch
 * to send a visitor with no MetaMask app somewhere else. No page of ours uses
 * such a key, so nothing real is lost.
 */
function searchWithoutBranchKeys(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    if (/^[$~+]/.test(key)) params.delete(key);
  }
  const kept = params.toString();
  return kept ? `?${kept}` : '';
}

/**
 * MetaMask on the Solana modal — a deep-link row, never a signer.
 *
 * Why no package: `@metamask/connect-solana` registers a Wallet Standard
 * wallet in EVERY browser, extension or not. That reads as Installed, costs a
 * relay socket the CSP does not allow (wss://mm-sdk-relay.api.cx.metamask.io),
 * and drags MetaMask's multichain SDK into the Solana chunk up front. What
 * MetaMask users actually lack here is narrower:
 *
 *  - desktop WITH the extension: nothing — the extension's own registration
 *    already lists "MetaMask" as Detected and this adapter is dropped;
 *  - desktop WITHOUT it: a row pointing at the download page instead of no
 *    row at all;
 *  - a phone browser: a row that opens this page inside MetaMask Mobile, where
 *    MetaMask's in-app browser registers the real wallet and it connects.
 *
 * So this adapter only ever does one of two things: navigate, or refuse.
 * It never holds a connection, which is why every signing method below
 * refuses — the real MetaMask wallet replaces it before anything is signed.
 */
export class MetaMaskWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = MetaMaskWalletName;
  url = 'https://metamask.io/download';
  icon = METAMASK_ICON;

  /** MetaMask's own declaration (@metamask/solana-wallet-standard wallet.mjs). */
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set([
    'legacy' as const,
    0 as const,
  ]);

  private _readyState: WalletReadyState =
    typeof window === 'undefined' || typeof document === 'undefined'
      ? WalletReadyState.Unsupported
      : WalletReadyState.NotDetected;

  constructor() {
    super();
    if (this._readyState === WalletReadyState.Unsupported) return;
    // Never offer a hop INTO MetaMask from inside MetaMask. Its iOS in-app
    // browser is a WKWebView (no "safari" token) and its Android one carries
    // "; wv", so isMobileAndRedirectable already refuses both; the explicit
    // MetaMaskMobile token covers any build where that stops being true.
    const inMetaMask =
      typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('metamaskmobile');
    if (!inMetaMask && isMobileAndRedirectable()) {
      this._readyState = WalletReadyState.Loadable;
      this.emit('readyStateChange', this._readyState);
    }
  }

  get publicKey(): PublicKey | null {
    return null;
  }

  get connecting(): boolean {
    return false;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  /**
   * Never navigates. WalletProvider mounts with autoConnect, so a returning
   * phone visitor whose stored wallet is "MetaMask" would otherwise be sent
   * into MetaMask on every page load, without touching anything.
   */
  override async autoConnect(): Promise<void> {}

  async connect(): Promise<void> {
    try {
      if (this._readyState === WalletReadyState.Loadable) {
        const { host, pathname, search } = window.location;
        window.location.href = `${METAMASK_DAPP_LINK}${host}${pathname}${searchWithoutBranchKeys(search)}`;
        return;
      }
      throw new WalletNotReadyError();
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.emit('disconnect');
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(_transaction: T): Promise<T> {
    const error = new WalletNotConnectedError();
    this.emit('error', error);
    throw error;
  }

  async signMessage(_message: Uint8Array): Promise<Uint8Array> {
    const error = new WalletNotConnectedError();
    this.emit('error', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase Wallet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coinbase Wallet (the Base app on phones) — copied from
 * @solana/wallet-adapter-coinbase@0.1.24 src/adapter.ts, the Solana
 * Foundation's own adapter, with three additions and one URL change.
 *
 * Why vendored, not installed: 0.1.24 (and its wallet-adapter-base 0.9.28)
 * peer on @solana/web3.js ^1.99.0 while this app runs 1.98.4, and
 * frontend/.npmrc sets legacy-peer-deps, so npm would install the mismatch
 * without a word. The code itself is small and is kept line for line.
 *
 * NOT the EVM modal's "Base" row. That row is a Base Account passkey smart
 * wallet, which has no Solana address at all. This adapter serves Coinbase
 * Wallet's recovery-phrase / email wallets, which hold Solana once Solana is
 * switched on in the app.
 *
 * The additions, all copied from the Trust adapter above for the same reasons:
 *  1. Loadable on a phone browser that is not Coinbase's own, where connect()
 *     opens the page inside the app with the universal link Reown's AppKit
 *     uses for Coinbase on Solana (appkit-controllers MobileWallet.js:
 *     `https://go.cb-w.com/dapp?cb_url=<encoded href>`).
 *  2. autoConnect only when Installed, so that link never fires on page load.
 *  3. Detection keeps polling from the Loadable state, so a late injection
 *     inside Coinbase's browser upgrades the row to Installed.
 * The URL change: upstream points at the Chrome Web Store, a dead end on a
 * phone; Coinbase's downloads page covers the extension and both apps.
 */
export const CoinbaseWalletName = 'Coinbase Wallet' as WalletName<'Coinbase Wallet'>;

const COINBASE_DAPP_LINK = 'https://go.cb-w.com/dapp?cb_url=';

interface CoinbaseWalletEvents {
  connect(...args: unknown[]): unknown;
  disconnect(...args: unknown[]): unknown;
}

interface CoinbaseSolanaProvider extends EventEmitter<CoinbaseWalletEvents> {
  publicKey?: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  signAndSendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    options?: SendOptions,
  ): Promise<{ signature: TransactionSignature }>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/** The injected provider, or undefined. Never throws, never caches. */
function coinbaseProvider(): CoinbaseSolanaProvider | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { coinbaseSolana?: CoinbaseSolanaProvider }).coinbaseSolana;
}

/**
 * Coinbase's in-app browser marks its injected EVM provider — the same flag
 * @coinbase/wallet-sdk reads (dist/util/provider.js). A redirect out of
 * Coinbase's own browser, into Coinbase's own browser, would be a loop.
 */
function inCoinbaseBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { ethereum?: { isCoinbaseBrowser?: boolean } }).ethereum?.isCoinbaseBrowser);
}

export class CoinbaseWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = CoinbaseWalletName;
  url = 'https://www.coinbase.com/wallet/downloads';
  icon =
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiB2aWV3Qm94PSIwIDAgMTAyNCAxMDI0IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8Y2lyY2xlIGN4PSI1MTIiIGN5PSI1MTIiIHI9IjUxMiIgZmlsbD0iIzAwNTJGRiIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTE1MiA1MTJDMTUyIDcxMC44MjMgMzEzLjE3NyA4NzIgNTEyIDg3MkM3MTAuODIzIDg3MiA4NzIgNzEwLjgyMyA4NzIgNTEyQzg3MiAzMTMuMTc3IDcxMC44MjMgMTUyIDUxMiAxNTJDMzEzLjE3NyAxNTIgMTUyIDMxMy4xNzcgMTUyIDUxMlpNNDIwIDM5NkM0MDYuNzQ1IDM5NiAzOTYgNDA2Ljc0NSAzOTYgNDIwVjYwNEMzOTYgNjE3LjI1NSA0MDYuNzQ1IDYyOCA0MjAgNjI4SDYwNEM2MTcuMjU1IDYyOCA2MjggNjE3LjI1NSA2MjggNjA0VjQyMEM2MjggNDA2Ljc0NSA2MTcuMjU1IDM5NiA2MDQgMzk2SDQyMFoiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=';
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set([
    'legacy' as const,
    0 as const,
  ]);

  private _connecting = false;
  private _wallet: CoinbaseSolanaProvider | null = null;
  private _publicKey: PublicKey | null = null;
  private _readyState: WalletReadyState =
    typeof window === 'undefined' || typeof document === 'undefined'
      ? WalletReadyState.Unsupported
      : WalletReadyState.NotDetected;

  constructor() {
    super();
    if (this._readyState === WalletReadyState.Unsupported) return;

    // Upstream's detection, unchanged: Installed the moment the provider is
    // there. It runs from the Loadable state too, which is addition 3.
    scopePollingDetectionStrategy(() => {
      if (!coinbaseProvider()) return false;
      this._readyState = WalletReadyState.Installed;
      this.emit('readyStateChange', this._readyState);
      return true;
    });

    if (!coinbaseProvider() && !inCoinbaseBrowser() && isMobileAndRedirectable()) {
      this._readyState = WalletReadyState.Loadable;
      this.emit('readyStateChange', this._readyState);
    }
  }

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  /** Addition 2 — see the Trust adapter's autoConnect for the full reason. */
  override async autoConnect(): Promise<void> {
    if (this.readyState === WalletReadyState.Installed) {
      await this.connect();
    }
  }

  async connect(): Promise<void> {
    try {
      if (this.connected || this.connecting) return;

      if (this._readyState === WalletReadyState.Loadable && !coinbaseProvider()) {
        // Addition 1: a handoff into the app's browser, not a connection.
        window.location.href = `${COINBASE_DAPP_LINK}${encodeURIComponent(window.location.href)}`;
        return;
      }
      if (this._readyState !== WalletReadyState.Installed) throw new WalletNotReadyError();

      this._connecting = true;

      const wallet = coinbaseProvider();
      if (!wallet) throw new WalletNotReadyError();

      try {
        await wallet.connect();
      } catch (error) {
        throw new WalletConnectionError((error as Error)?.message, error);
      }

      if (!wallet.publicKey) throw new WalletAccountError();

      let publicKey: PublicKey;
      try {
        publicKey = new PublicKey(wallet.publicKey.toBytes());
      } catch (error) {
        throw new WalletPublicKeyError((error as Error)?.message, error);
      }

      wallet.on('disconnect', this._disconnected);

      this._wallet = wallet;
      this._publicKey = publicKey;

      this.emit('connect', publicKey);
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off('disconnect', this._disconnected);

      this._wallet = null;
      this._publicKey = null;

      try {
        await wallet.disconnect();
      } catch (error) {
        this.emit('error', new WalletDisconnectionError((error as Error)?.message, error));
      }
    }

    this.emit('disconnect');
  }

  override async sendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    connection: Connection,
    options: SendTransactionOptions = {},
  ): Promise<TransactionSignature> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();

      try {
        const { signers, ...sendOptions } = options;

        if (isVersionedTransaction(transaction)) {
          if (signers?.length) transaction.sign(signers);
        } else {
          transaction = (await this.prepareTransaction(transaction, connection, sendOptions)) as T;
          if (signers?.length) (transaction as Transaction).partialSign(...signers);
        }

        sendOptions.preflightCommitment = sendOptions.preflightCommitment || connection.commitment;

        const { signature } = await wallet.signAndSendTransaction(transaction, sendOptions);
        return signature;
      } catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletSendTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();

      try {
        return ((await wallet.signTransaction(transaction)) as T) || transaction;
      } catch (error) {
        throw new WalletSignTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  override async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();

      try {
        return ((await wallet.signAllTransactions(transactions)) as T[]) || transactions;
      } catch (error) {
        throw new WalletSignTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();

      try {
        const { signature } = await wallet.signMessage(message);
        return signature;
      } catch (error) {
        throw new WalletSignTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  private _disconnected = () => {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off('disconnect', this._disconnected);

      this._wallet = null;
      this._publicKey = null;

      this.emit('error', new WalletDisconnectedError());
      this.emit('disconnect');
    }
  };
}
