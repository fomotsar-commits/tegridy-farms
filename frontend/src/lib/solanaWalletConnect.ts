// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import './solanaPolyfill';
import {
  BaseSignerWalletAdapter,
  WalletAccountError,
  WalletConnectionError,
  WalletDisconnectedError,
  WalletDisconnectionError,
  WalletError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletPublicKeyError,
  WalletReadyState,
  WalletSignTransactionError,
  WalletTimeoutError,
  WalletWindowClosedError,
  isVersionedTransaction,
  type SupportedTransactionVersions,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { PublicKey, VersionedTransaction, type Transaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { base58, base64 } from '@scure/base';
// TYPE-ONLY. The package itself is loaded with a dynamic import() inside
// getClient(), so the Solana page pays nothing for it until someone connects.
// solanaWalletConnect.test.ts fails on any static value import of it, and
// scripts/check-dist-graph.mjs fails the BUILD if the built chunk graph ever
// reaches it statically.
import type SignClientClass from '@walletconnect/sign-client';

/**
 * WalletConnect on the Solana connect modal — a QR code a phone wallet scans.
 *
 * ── WHERE THE CODE COMES FROM ──
 *
 *  - Chain ids, the method name, the connect proposal, the method check and
 *    the icon: @walletconnect/solana-adapter@0.0.9 (Apache-2.0) src/constants.ts,
 *    src/utils.ts getConnectParams(), src/core.ts checkIfWalletSupportsMethod,
 *    src/adapter.ts.
 *  - The request's parameters: the WalletConnect Solana RPC spec
 *    (docs.walletconnect.com/wallets/chains/solana.md, solana_signTransaction):
 *    `transaction`, plus the deprecated legacy fields in the spec's own shapes.
 *  - NOTHING is copied from @reown/appkit-adapter-solana: it is under the Reown
 *    Community License, whose §1(c) assigns derivative works to Reown.
 *
 * ── WHY NOT THE PACKAGE ──
 *
 * @walletconnect/solana-adapter statically imports @reown/appkit and a second
 * WalletConnect core (2.23.7), adds +26 KB to the EAGER chunks through nested
 * @noble/bs58 copies, opens a QR window on PAGE LOAD for a returning visitor
 * (its autoConnect is the base class's, which calls connect()), and hangs
 * forever if UniversalProvider.init rejects (core.ts:35 is not awaited). This
 * file keeps its request code and drops all four.
 *
 * ── WHY SignClient AND NOT UniversalProvider ──
 *
 * UniversalProvider writes `wc@2:universal_provider:*` keys WITHOUT the storage
 * prefix, and its cleanupStorage() deletes EVERY such key when its own client
 * has no sessions left — including the EVM WalletConnect provider's saved
 * namespaces, after which an EVM send throws TypeError on the next load
 * (UniversalProvider.ts:577-607; reproduced with the real 2.25.0 package).
 * SignClient writes only prefixed keys, so `customStoragePrefix: 'solana'`
 * isolates everything that matters from RainbowKit's 'clientOne'/'clientTwo'.
 * Reown's adapter already sends every request through `client.client.request`
 * — the SignClient — so nothing about the wire format changes.
 *
 * ── THE RULES THIS ADAPTER KEEPS ──
 *
 *  1. Built only with a project id (SolanaProviders). Without one it is inert.
 *  2. Not offered on a phone: a QR cannot be scanned by the screen showing it,
 *     and phones already get in-app-browser rows (Phantom, Trust, MetaMask,
 *     Coinbase) and the Mobile Wallet Adapter.
 *  3. autoConnect RESTORES ONLY: a live Solana session connects silently; no
 *     session means nothing happens. It never shows a QR. "Live" means inside
 *     its expiry: the engine prunes expired sessions only when it starts, so a
 *     dead one can still be listed.
 *  4. Nothing waits forever: starting WalletConnect is bounded by
 *     START_TIMEOUT_MS, a QR by the proposal's own 5-minute expiry, a
 *     signature by SIGN_TIMEOUT_MS — and a cancel (Back, Escape, Close) ends
 *     the attempt in EVERY phase, including while WalletConnect is still
 *     starting. A cancel armed only once the QR existed was lost before it:
 *     the proposal went out anyway, with no dialog left to show it, and every
 *     Connect button read "Connecting…" until that 5-minute expiry.
 *  5. ONE SignClient per page, shared by every adapter instance. Two
 *     SignClients on one prefix overwrite each other's sessions (Store.persist
 *     saves the whole map; last writer wins).
 *  6. A signature is VERIFIED before anything is sent, in RFC 8032 strict mode.
 *     The Streamflow SDK sends with skipPreflight, so an unchecked bad
 *     signature would only surface as "expired" a minute later — unreadable
 *     reading as pending. noble's default (ZIP-215) would pass a small-order
 *     "address", with which one forged signature verifies over anything.
 *  7. Solana code never writes or deletes localStorage
 *     WALLETCONNECT_DEEPLINK_CHOICE. RainbowKit owns that key; our session is
 *     marked disableDeepLink so sign-client never follows it for us.
 *  8. The session is READ when it is used, never trusted from a snapshot: at
 *     sign time the record is fetched again, and one that is gone, expired or
 *     no longer grants signing stops the request before it is sent.
 *  9. Every card hears a session end. /farm?bungalow=bayla mounts two
 *     SolanaProviders, so two adapters hold ONE session on the one client.
 *     sign-client's own disconnect() emits nothing locally (deleteSession with
 *     emitEvent:false), so a Disconnect in one card, and the wallet ending it,
 *     are fanned out here to every adapter holding that topic.
 */

export const WalletConnectWalletName = 'WalletConnect' as WalletName<'WalletConnect'>;

/** @walletconnect/solana-adapter@0.0.9 src/constants.ts, verbatim values. */
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEPRECATED_MAINNET = 'solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ';
const SIGN_TRANSACTION = 'solana_signTransaction';

/**
 * Keys this client's storage apart from RainbowKit's two EVM clients. FIXED
 * FOREVER once shipped: changing it strands every live Solana session, for
 * the same reason wagmi.ts gives for not renaming the EVM wallet id.
 */
export const WALLETCONNECT_STORAGE_PREFIX = 'solana';

export const START_TIMEOUT_MS = 10_000;
/**
 * A blockhash is valid for 150 slots, about 60–90 seconds. An approval later
 * than this signs a transaction that can no longer land, so waiting longer
 * only delays the "nothing was sent" answer. sign-client's own limit is 15
 * minutes (wc_sessionRequest ttl), far past any usable blockhash.
 */
export const SIGN_TIMEOUT_MS = 120_000;

/** @walletconnect/utils errors.ts SDK_ERRORS, copied so utils is not imported. */
const USER_DISCONNECTED = { message: 'User disconnected.', code: 6000 };
const UNSUPPORTED_ACCOUNTS = { message: 'Unsupported accounts.', code: 5103 };

type SignClient = Awaited<ReturnType<typeof SignClientClass.init>>;
type Session = ReturnType<SignClient['session']['getAll']>[number];

/** What the Solana connect modal shows for this adapter. */
export type WalletConnectPairing =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'scan'; readonly uri: string }
  | { readonly phase: 'failed'; readonly reason: string };

const IDLE: WalletConnectPairing = { phase: 'idle' };

/**
 * The notices the modal shows. `startFailed` doubles as this module's marker
 * in the BUILT graph: scripts/check-dist-graph.mjs finds the chunk holding
 * this adapter by a phrase of it, then proves sign-client is not statically
 * reachable from there. Reword it and that gate says so, by name.
 */
export const PAIRING_REASONS = {
  declined: 'Your wallet declined the connection. Nothing was shared.',
  unsupported: "That wallet can't connect to Solana this way. Pick another wallet.",
  expired: 'The QR code expired. Tap WalletConnect for a new one.',
  noSolana: "That wallet didn't share a Solana address. Pick a wallet that supports Solana.",
  startFailed: "WalletConnect didn't start. Check your connection, or pick another wallet.",
} as const;

/** The SignClient options — exported so a test can run the REAL client on them. */
export function signClientOptions(projectId: string, origin: string) {
  return {
    projectId,
    customStoragePrefix: WALLETCONNECT_STORAGE_PREFIX,
    telemetryEnabled: false,
    // The same app identity the EVM connector sends (wagmi.ts buildConfig).
    metadata: { name: 'memetics.finance', description: 'memetics.finance', url: origin, icons: [] as string[] },
  };
}

let clientPromise: Promise<SignClient> | null = null;

/**
 * The page's one SignClient. A TIMEOUT does not reset it — the init may still
 * finish, and a second SignClient on the same prefix would clobber the first's
 * sessions. Only a REJECTED init is forgotten, so the next click retries.
 */
function getClient(projectId: string): Promise<SignClient> {
  if (!clientPromise) {
    const started = import('@walletconnect/sign-client').then(({ SignClient }) =>
      SignClient.init(signClientOptions(projectId, window.location.origin)),
    );
    clientPromise = started;
    started.catch(() => {
      if (clientPromise === started) clientPromise = null;
    });
  }
  return within(clientPromise, START_TIMEOUT_MS, () => new WalletTimeoutError('WalletConnect did not start'));
}

/** Test-only: forget the page's client between tests. */
export function resetWalletConnectClientForTests(): void {
  clientPromise = null;
}

function within<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(error()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The session's Solana MAINNET account, or null. Mainnet first, then the
 * deprecated mainnet id some wallets still answer with (solana-adapter
 * utils.ts getDefaultChainFromSession). CAIP-10: `<ns>:<ref>:<address>`.
 */
function solanaAccount(session: Session): { chainId: string; address: string } | null {
  const accounts = session.namespaces.solana?.accounts ?? [];
  for (const chainId of [MAINNET, DEPRECATED_MAINNET]) {
    const account = accounts.find((a) => a.startsWith(`${chainId}:`));
    if (account) return { chainId, address: account.slice(chainId.length + 1) };
  }
  return null;
}

/**
 * Inside its expiry (seconds, per the spec). An unreadable expiry is NaN, and
 * NaN > now is false: a record this cannot read as live is treated as dead.
 */
function isLive(session: Session): boolean {
  return session.expiry * 1000 > Date.now();
}

/** Newest LIVE session that carries a Solana account. Never `sessions[0]`. */
function restorableSession(client: SignClient): Session | undefined {
  return client.session
    .getAll()
    .filter((s) => isLive(s) && solanaAccount(s) !== null)
    .sort((a, b) => b.expiry - a.expiry)[0];
}

/**
 * The session record as it is NOW, or null when it is gone or expired. The
 * store's get() THROWS for a topic it no longer holds (@walletconnect/core
 * Store.getData, "No matching key"), and that is an answer: gone.
 */
function currentSession(client: SignClient, topic: string): Session | null {
  let session: Session | undefined;
  try {
    session = client.session.get(topic);
  } catch {
    return null;
  }
  return session && isLive(session) ? session : null;
}

/** `wc:<pairing topic>@2?…` — the topic to close when a QR is abandoned. */
function pairingTopicOf(uri: string): string | null {
  return /^wc:([^@]+)@/.exec(uri)?.[1] ?? null;
}

/**
 * Close a pairing nobody will scan, so a late scan of its QR cannot settle a
 * session nobody asked for. Best effort: offline, it simply expires.
 */
function dropPairing(client: SignClient, uri: string | undefined): void {
  const topic = uri ? pairingTopicOf(uri) : null;
  if (topic) client.disconnect({ topic, reason: USER_DISCONNECTED }).catch(() => {});
}

/**
 * @rainbow-me/rainbowkit 2.2.11 src/utils/isMobile.ts isAndroid + isSmallIOS
 * (dist/index.js:134-139). An iPad is NOT a phone here: it shows the QR, and a
 * phone scans it.
 */
function isPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent) || /iPhone|iPod/.test(navigator.userAgent);
}

/**
 * solana_signTransaction params, as the WalletConnect Solana spec lists them:
 * `transaction` (base64 of the serialized transaction, unsigned slots zeroed),
 * and — for a LEGACY transaction only — the deprecated fields older wallets
 * read, in the spec's shapes (base58 strings, not web3.js objects; 0.0.9's
 * `...transaction` spread leaks web3.js internals instead). The spec's
 * "Refer always to `transaction`" warning is why v0 sends nothing else.
 */
function signTransactionParams(transaction: Transaction | VersionedTransaction) {
  if (isVersionedTransaction(transaction)) {
    return { transaction: base64.encode(transaction.serialize()) };
  }
  return {
    transaction: base64.encode(new Uint8Array(transaction.serialize({ verifySignatures: false }))),
    feePayer: transaction.feePayer?.toBase58(),
    recentBlockhash: transaction.recentBlockhash,
    instructions: transaction.instructions.map((instruction) => ({
      programId: instruction.programId.toBase58(),
      data: base58.encode(new Uint8Array(instruction.data)),
      keys: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
        pubkey: pubkey.toBase58(),
        isSigner,
        isWritable,
      })),
    })),
  };
}

/**
 * The 64 signature bytes for `signer`, from either answer shape: the spec's
 * `{ signature }` (base58), or Reown's reference wallet's `{ transaction }`
 * (base64; react-wallet-v2 SolanaLib.ts returns no `signature`). Both land
 * in `VersionedTransaction.deserialize`, which reads legacy bytes too.
 */
function signatureFrom(result: { signature?: unknown; transaction?: unknown }, signer: PublicKey): Uint8Array {
  if (typeof result?.signature === 'string' && result.signature) {
    return base58.decode(result.signature);
  }
  if (typeof result?.transaction === 'string' && result.transaction) {
    const returned = VersionedTransaction.deserialize(base64.decode(result.transaction));
    const signers = returned.message.staticAccountKeys.slice(0, returned.message.header.numRequiredSignatures);
    const index = signers.findIndex((key) => key.equals(signer));
    const signature = index >= 0 ? returned.signatures[index] : undefined;
    if (signature) return signature;
  }
  throw new Error('The wallet answered without a signature');
}

/** Every adapter instance that holds a session right now (rule 9). */
const adopted = new Set<WalletConnectWalletAdapter>();

export class WalletConnectWalletAdapter extends BaseSignerWalletAdapter {
  name = WalletConnectWalletName;
  url = 'https://walletconnect.network';
  /** @walletconnect/solana-adapter@0.0.9 adapter.ts icon, verbatim. */
  icon =
    'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjE4NSIgdmlld0JveD0iMCAwIDMwMCAxODUiIHdpZHRoPSIzMDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0ibTYxLjQzODU0MjkgMzYuMjU2MjYxMmM0OC45MTEyMjQxLTQ3Ljg4ODE2NjMgMTI4LjIxMTk4NzEtNDcuODg4MTY2MyAxNzcuMTIzMjA5MSAwbDUuODg2NTQ1IDUuNzYzNDE3NGMyLjQ0NTU2MSAyLjM5NDQwODEgMi40NDU1NjEgNi4yNzY1MTEyIDAgOC42NzA5MjA0bC0yMC4xMzY2OTUgMTkuNzE1NTAzYy0xLjIyMjc4MSAxLjE5NzIwNTEtMy4yMDUzIDEuMTk3MjA1MS00LjQyODA4MSAwbC04LjEwMDU4NC03LjkzMTE0NzljLTM0LjEyMTY5Mi0zMy40MDc5ODE3LTg5LjQ0Mzg4Ni0zMy40MDc5ODE3LTEyMy41NjU1Nzg4IDBsLTguNjc1MDU2MiA4LjQ5MzYwNTFjLTEuMjIyNzgxNiAxLjE5NzIwNDEtMy4yMDUzMDEgMS4xOTcyMDQxLTQuNDI4MDgwNiAwbC0yMC4xMzY2OTQ5LTE5LjcxNTUwMzFjLTIuNDQ1NTYxMi0yLjM5NDQwOTItMi40NDU1NjEyLTYuMjc2NTEyMiAwLTguNjcwOTIwNHptMjE4Ljc2Nzc5NjEgNDAuNzczNzQ0OSAxNy45MjE2OTcgMTcuNTQ2ODk3YzIuNDQ1NTQ5IDIuMzk0Mzk2OSAyLjQ0NTU2MyA2LjI3NjQ3NjkuMDAwMDMxIDguNjcwODg5OWwtODAuODEwMTcxIDc5LjEyMTEzNGMtMi40NDU1NDQgMi4zOTQ0MjYtNi40MTA1ODIgMi4zOTQ0NTMtOC44NTYxNi4wMDAwNjItLjAwMDAxLS4wMDAwMS0uMDAwMDIyLS4wMDAwMjItLjAwMDAzMi0uMDAwMDMybC01Ny4zNTQxNDMtNTYuMTU0NTcyYy0uNjExMzktLjU5ODYwMi0xLjYwMjY1LS41OTg2MDItMi4yMTQwNCAwLS4wMDAwMDQuMDAwMDA0LS4wMDAwMDcuMDAwMDA4LS4wMDAwMTEuMDAwMDExbC01Ny4zNTI5MjEyIDU2LjE1NDUzMWMtMi40NDU1MzY4IDIuMzk0NDMyLTYuNDEwNTc1NSAyLjM5NDQ3Mi04Ljg1NjE2MTIuMDAwMDg3LS4wMDAwMTQzLS4wMDAwMTQtLjAwMDAyOTYtLjAwMDAyOC0uMDAwMDQ0OS0uMDAwMDQ0bC04MC44MTI0MTk0My03OS4xMjIxODVjLTIuNDQ1NTYwMjEtMi4zOTQ0MDgtMi40NDU1NjAyMS02LjI3NjUxMTUgMC04LjY3MDkxOTdsMTcuOTIxNzI5NjMtMTcuNTQ2ODY3M2MyLjQ0NTU2MDItMi4zOTQ0MDgyIDYuNDEwNTk4OS0yLjM5NDQwODIgOC44NTYxNjAyIDBsNTcuMzU0OTc3NSA1Ni4xNTUzNTdjLjYxMTM5MDguNTk4NjAyIDEuNjAyNjQ5LjU5ODYwMiAyLjIxNDAzOTggMCAuMDAwMDA5Mi0uMDAwMDA5LjAwMDAxNzQtLjAwMDAxNy4wMDAwMjY1LS4wMDAwMjRsNTcuMzUyMTAzMS01Ni4xNTUzMzNjMi40NDU1MDUtMi4zOTQ0NjMzIDYuNDEwNTQ0LTIuMzk0NTUzMSA4Ljg1NjE2MS0uMDAwMi4wMDAwMzQuMDAwMDMzNi4wMDAwNjguMDAwMDY3My4wMDAxMDEuMDAwMTAxbDU3LjM1NDkwMiA1Ni4xNTU0MzJjLjYxMTM5LjU5ODYwMSAxLjYwMjY1LjU5ODYwMSAyLjIxNDA0IDBsNTcuMzUzOTc1LTU2LjE1NDMyNDljMi40NDU1NjEtMi4zOTQ0MDkyIDYuNDEwNTk5LTIuMzk0NDA5MiA4Ljg1NjE2IDB6IiBmaWxsPSIjM2I5OWZjIi8+PC9zdmc+';

  /**
   * ['legacy', 0] — Reown's declaration. It is a claim about the PROTOCOL, not
   * about whichever wallet scans the QR: the spec's `transaction` parameter
   * carries either version, but no public source says which wallets sign v0
   * over WalletConnect. A wallet that cannot will refuse the request, and the
   * signature check below turns anything else it returns into a clean error.
   */
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set(['legacy' as const, 0 as const]);

  private readonly _projectId: string;
  private readonly _readyState: WalletReadyState;
  private _connecting = false;
  private _client: SignClient | null = null;
  /** The session's TOPIC only. The record itself is read when it is used (rule 8). */
  private _topic: string | null = null;
  private _chainId = MAINNET;
  private _publicKey: PublicKey | null = null;
  private _pairing: WalletConnectPairing = IDLE;
  private readonly _pairingListeners = new Set<() => void>();
  private _cancelPairing: ((error: Error) => void) | null = null;

  constructor(config: { projectId: string }) {
    super();
    this._projectId = config.projectId;
    this._readyState =
      typeof window === 'undefined' || typeof document === 'undefined' || !config.projectId || isPhone()
        ? WalletReadyState.Unsupported
        : WalletReadyState.Loadable;
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

  // ── pairing state, read by the connect modal (useSyncExternalStore) ──

  getPairing = (): WalletConnectPairing => this._pairing;

  subscribePairing = (listener: () => void): (() => void) => {
    this._pairingListeners.add(listener);
    return () => {
      this._pairingListeners.delete(listener);
    };
  };

  /** The modal's Back, Escape and close: abandon the attempt. connect() rejects. */
  cancelPairing(): void {
    this._cancelPairing?.(new WalletWindowClosedError());
  }

  /** Clear a failure notice once the modal has shown it. */
  dismissPairing(): void {
    if (this._pairing.phase === 'failed') this._setPairing(IDLE);
  }

  private _setPairing(next: WalletConnectPairing): void {
    this._pairing = next;
    for (const listener of this._pairingListeners) listener();
  }

  /**
   * Restore only. WalletProvider calls this on mount for the saved wallet.
   * A live Solana session reconnects with no UI; no session means nothing
   * happens and nothing throws — the Trust and Coinbase guards behave the same.
   */
  override async autoConnect(): Promise<void> {
    if (this.connected || this.connecting || this._readyState !== WalletReadyState.Loadable) return;
    this._connecting = true;
    try {
      const client = await getClient(this._projectId);
      const session = restorableSession(client);
      if (session) await this._adopt(client, session);
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async connect(): Promise<void> {
    try {
      if (this.connected || this.connecting) return;
      if (this._readyState !== WalletReadyState.Loadable) throw new WalletNotReadyError();
      this._connecting = true;
      // Armed BEFORE the first await (rule 4), and raced against every wait
      // below: starting the client, making the proposal, the scan. A cancel
      // that lands after the last race has nothing left to stop; the catch
      // keeps that from reading as an unhandled rejection.
      const cancelled = new Promise<never>((_, reject) => {
        this._cancelPairing = reject;
      });
      cancelled.catch(() => {});
      this._setPairing({ phase: 'starting' });

      const client = await Promise.race([getClient(this._projectId), cancelled]);
      const existing = restorableSession(client);
      if (existing) {
        await this._adopt(client, existing);
        this._setPairing(IDLE);
        return;
      }

      // @walletconnect/solana-adapter@0.0.9 utils.ts getConnectParams(Mainnet),
      // minus solana_signMessage: nothing on this site signs a Solana message.
      const proposing = client.connect({
        optionalNamespaces: {
          solana: { chains: [MAINNET, DEPRECATED_MAINNET], methods: [SIGN_TRANSACTION], events: [] },
        },
      });
      const { uri, approval } = await Promise.race([
        within(proposing, START_TIMEOUT_MS, () => new WalletTimeoutError('WalletConnect did not start')),
        cancelled,
      ]).catch((error: unknown) => {
        // Cancelled or timed out while the proposal was being made: it can
        // still be made after we stop waiting. Close its pairing when it lands.
        proposing.then(({ uri: late }) => dropPairing(client, late), () => {});
        throw error;
      });
      if (!uri || !pairingTopicOf(uri)) throw new WalletConnectionError('WalletConnect returned no pairing link');
      this._setPairing({ phase: 'scan', uri });

      let session: Session;
      try {
        session = await Promise.race([approval(), cancelled]);
      } catch (error) {
        dropPairing(client, uri);
        throw error;
      }
      await this._adopt(client, session);
      this._setPairing(IDLE);
    } catch (error) {
      this._setPairing(failureFor(error));
      const walletError =
        error instanceof WalletError ? error : new WalletConnectionError((error as { message?: string })?.message, error);
      this.emit('error', walletError);
      throw walletError;
    } finally {
      this._connecting = false;
      this._cancelPairing = null;
    }
  }

  private async _adopt(client: SignClient, session: Session): Promise<void> {
    const account = solanaAccount(session);
    if (!account) {
      // An EVM-only wallet scanned the QR. Delete the session, or every later
      // connect would restore it and fail again for up to seven days.
      await client.disconnect({ topic: session.topic, reason: UNSUPPORTED_ACCOUNTS }).catch(() => {});
      throw new WalletAccountError('The wallet shared no Solana account');
    }
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(account.address);
    } catch (error) {
      throw new WalletPublicKeyError((error as Error)?.message, error);
    }
    // Rule 7. sign-client redirects every request to the app named in
    // localStorage WALLETCONNECT_DEEPLINK_CHOICE unless the SESSION says not to
    // (sign-client engine.ts:787-794). That key is RainbowKit's choice for the
    // EVM wallet; this flag keeps our requests from following it. It lives only
    // in this client's own session record.
    if (!session.sessionConfig?.disableDeepLink) {
      await client.session.update(session.topic, {
        sessionConfig: { ...session.sessionConfig, disableDeepLink: true },
      });
    }
    this._client = client;
    this._topic = session.topic;
    this._chainId = account.chainId;
    this._publicKey = publicKey;
    adopted.add(this);
    // One listener per client, however many cards adopt: off-then-on keeps it
    // single, and it fans out to every holder of the topic (rule 9).
    client.off('session_delete', WalletConnectWalletAdapter._walletEnded);
    client.off('session_expire', WalletConnectWalletAdapter._walletEnded);
    client.on('session_delete', WalletConnectWalletAdapter._walletEnded);
    client.on('session_expire', WalletConnectWalletAdapter._walletEnded);
    this.emit('connect', publicKey);
  }

  async disconnect(): Promise<void> {
    this.cancelPairing();
    const client = this._client;
    const topic = this._topic;
    this._detach();
    if (topic) {
      // The other card, holding the same session, is told here: the client
      // will not tell it (rule 9). The user asked for this, so no error.
      WalletConnectWalletAdapter._end(topic, false);
    }
    if (client && topic) {
      try {
        await client.disconnect({ topic, reason: USER_DISCONNECTED });
      } catch (error) {
        this.emit('error', new WalletDisconnectionError((error as Error)?.message, error));
      }
    }
    this.emit('disconnect');
  }

  /**
   * The only signing primitive. BaseSignerWalletAdapter derives sendTransaction
   * (ladder: legacy; swap: v0) and signAllTransactions from it, and the
   * Streamflow card calls it directly.
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    try {
      const client = this._client;
      const topic = this._topic;
      const publicKey = this._publicKey;
      if (!client || !topic || !publicKey) throw new WalletNotConnectedError();
      try {
        // Rule 8: the record as it is NOW. Gone or expired means disconnected
        // — for every card holding it — and nothing is sent.
        const session = currentSession(client, topic);
        if (!session) {
          WalletConnectWalletAdapter._end(topic, true);
          throw new Error('The WalletConnect session has ended. Connect again. Nothing was sent');
        }
        // solana-adapter core.ts checkIfWalletSupportsMethod, on the FRESH
        // record, with a sentence a person can act on.
        if (!session.namespaces.solana?.methods.includes(SIGN_TRANSACTION)) {
          throw new Error("This wallet didn't allow transaction signing over WalletConnect");
        }
        const message = isVersionedTransaction(transaction)
          ? transaction.message.serialize()
          : (transaction as Transaction).serializeMessage();
        const result = await within(
          client.request<{ signature?: string; transaction?: string }>({
            chainId: this._chainId,
            topic,
            request: {
              method: SIGN_TRANSACTION,
              params: signTransactionParams(transaction),
            },
          }),
          SIGN_TIMEOUT_MS,
          () => new Error('No answer from the wallet in time. Nothing was sent'),
        );
        const signature = signatureFrom(result, publicKey);
        // Rule 6: over OUR message bytes, never over whatever the wallet sent
        // back — a wallet that changed the transaction fails here too — and in
        // RFC 8032 strict mode, which refuses a small-order key.
        if (
          signature.length !== 64 ||
          !ed25519.verify(signature, message, publicKey.toBytes(), { zip215: false })
        ) {
          throw new Error("The wallet's signature doesn't match this transaction. Nothing was sent");
        }
        (transaction as { addSignature(k: PublicKey, s: Uint8Array): void }).addSignature(
          publicKey,
          isVersionedTransaction(transaction) ? signature : Buffer.from(signature),
        );
        return transaction;
      } catch (error) {
        throw new WalletSignTransactionError((error as Error)?.message, error);
      }
    } catch (error) {
      this.emit('error', error as WalletError);
      throw error;
    }
  }

  private _detach(): void {
    adopted.delete(this);
    this._client = null;
    this._topic = null;
    this._publicKey = null;
  }

  /**
   * Every adapter holding `topic` lets go of it and says so (rule 9). When the
   * WALLET ended it (session_delete, seven days running out, or a record found
   * gone at sign time) each also reports WalletDisconnectedError, the way the
   * upstream adapters report a wallet-side disconnect.
   */
  private static _end(topic: string, byWallet: boolean): void {
    for (const adapter of [...adopted]) {
      if (adapter._topic !== topic) continue;
      adapter._detach();
      if (byWallet) adapter.emit('error', new WalletDisconnectedError());
      adapter.emit('disconnect');
    }
  }

  /** The wallet ended it, or seven days ran out. Either way: disconnected. */
  private static readonly _walletEnded = ({ topic }: { topic: string }): void => {
    WalletConnectWalletAdapter._end(topic, true);
  };
}

function failureFor(error: unknown): WalletConnectPairing {
  if (error instanceof WalletWindowClosedError) return IDLE;
  if (error instanceof WalletTimeoutError) return { phase: 'failed', reason: PAIRING_REASONS.startFailed };
  if (error instanceof WalletAccountError) return { phase: 'failed', reason: PAIRING_REASONS.noSolana };
  const code = (error as { code?: unknown })?.code;
  // @walletconnect/utils SDK_ERRORS: 5000–5003 USER_REJECTED*, 5100–5104 UNSUPPORTED_*.
  if (typeof code === 'number' && code >= 5000 && code < 5100) return { phase: 'failed', reason: PAIRING_REASONS.declined };
  if (typeof code === 'number' && code >= 5100 && code < 5200) return { phase: 'failed', reason: PAIRING_REASONS.unsupported };
  // sign-client constants/proposal.ts PROPOSAL_EXPIRY_MESSAGE.
  if ((error as { message?: unknown })?.message === 'Proposal expired') return { phase: 'failed', reason: PAIRING_REASONS.expired };
  const detail = (error as { message?: unknown })?.message;
  return {
    phase: 'failed',
    reason: `WalletConnect couldn't connect${typeof detail === 'string' && detail ? ` (${detail.slice(0, 120)})` : ''}.`,
  };
}
