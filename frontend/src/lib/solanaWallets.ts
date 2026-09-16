// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import './solanaPolyfill';
import {
  BaseMessageSignerWalletAdapter,
  WalletAccountError,
  WalletConnectionError,
  WalletDisconnectedError,
  WalletDisconnectionError,
  type WalletError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletPublicKeyError,
  WalletReadyState,
  WalletSignMessageError,
  WalletSignTransactionError,
  scopePollingDetectionStrategy,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { TRUST_ICON } from './walletIcons';

/**
 * The Solana sibling of rainbowkitWallets.ts: wallets this venue adds to the
 * Solana connect modal that the packaged adapters get wrong.
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
 */
function isMobileAndRedirectable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad')) return ua.includes('safari');
  if (ua.includes('android')) return !ua.includes('; wv');
  return false;
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
