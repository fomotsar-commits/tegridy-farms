// A Wallet Standard wallet for Playwright, registered before the app loads.
//
// It is hand-rolled on purpose and deliberately SMALL: standard:connect / disconnect /
// events, solana:signTransaction and solana:signMessage (the upload endpoint asks the
// creator to sign its request, critic A9). There is NO solana:signAndSendTransaction, so
// a page that depends on the wallet broadcasting (through the wallet's own RPC and chain)
// cannot pass. The page must sign-only and send through /api/solrpc.
//
// signMessage signs ONLY the site's upload request naming this wallet as creator; any
// other text is refused, because a signed message is a signature too.
//
// The private key never enters the browser. The page hands the serialized transaction to
// Node through an exposed binding; Node runs walletGuard.checkTransaction on the exact
// bytes, signs only if it passes, and records everything (signed or refused) so a spec
// can prove what was signed, and that nothing was asked for when nothing should have been.
import crypto from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { checkTransaction, GuardRefusal, base58, type SignedIx } from './walletGuard';

export const TEST_WALLET_NAME = 'E2E Test Wallet';
const BINDING = '__tegridyE2eWalletSign';
const MESSAGE_BINDING = '__tegridyE2eWalletSignMessage';
/** The only message this wallet signs: src/lib/launchMetadata/validate.js uploadAuthMessage. */
const UPLOAD_MESSAGE_HEAD = 'Tegridy launch upload v1\n';
const CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:localnet'];
// A plain square; Wallet Standard requires a data: URI icon.
const ICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#3b7a57"/><text x="16" y="21" font-size="12" text-anchor="middle" fill="#fff">E2E</text></svg>').toString('base64')}`;

export interface SignRecord {
  at: string;
  kind: 'transaction' | 'message';
  /** 'signed', 'refused' (the guard said no) or 'declined' (the spec told the wallet to say no). */
  outcome: 'signed' | 'refused' | 'declined';
  reason: string | null;
  /** The transaction id (the fee payer's signature), when signed. */
  signature: string | null;
  /** Wire size of the transaction as the page handed it over. */
  bytes: number;
  /** The message version the page handed over (transactions only). */
  version?: 'legacy' | 0;
  instructions: SignedIx[];
  /** For kind 'message': the text that was presented. */
  text?: string;
}

export interface TestWallet {
  readonly keypair: Keypair;
  readonly name: string;
  readonly records: SignRecord[];
  /** 'approve' (default) signs what passes the guard; 'decline' rejects like a user pressing Cancel. */
  setMode(mode: 'approve' | 'decline'): void;
  /** Signed TRANSACTIONS (message signatures are in `records` with kind 'message'). */
  signed(): SignRecord[];
  lastSigned(): SignRecord;
  /** Instructions of the last signed transaction named `name` (e.g. 'buy'). */
  lastIx(name: string): SignedIx;
}

export interface TestWalletOptions {
  /**
   * The transaction versions the wallet says it signs (Wallet Standard
   * `supportedTransactionVersions`). Default both. `['legacy']` is a legacy-only wallet:
   * it also REFUSES a versioned message, as such a wallet cannot sign one.
   */
  versions?: ('legacy' | 0)[];
}

/**
 * Register the wallet in every page of `context`. One wallet per context: a second
 * call on the same context throws (the binding name is fixed).
 */
export async function installTestWallet(context: BrowserContext, keypair: Keypair, name = TEST_WALLET_NAME, o: TestWalletOptions = {}): Promise<TestWallet> {
  let mode: 'approve' | 'decline' = 'approve';
  const records: SignRecord[] = [];
  const versions = o.versions ?? ['legacy', 0];
  if (versions.length === 0) throw new Error('a wallet must sign at least one transaction version');

  await context.exposeBinding(BINDING, async (_source, txBase64: string): Promise<string> => {
    const bytes = Uint8Array.from(Buffer.from(txBase64, 'base64'));
    const rec: SignRecord = { at: new Date().toISOString(), kind: 'transaction', outcome: 'refused', reason: null, signature: null, bytes: bytes.length, instructions: [] };
    records.push(rec);
    let version: 'legacy' | 0;
    try {
      version = VersionedTransaction.deserialize(bytes).version;
    } catch (e) {
      rec.reason = `the wallet could not read the transaction: ${(e as Error).message}`;
      throw new Error(`E2E wallet refused to sign: ${rec.reason}`, { cause: e });
    }
    rec.version = version;
    if (!versions.includes(version)) {
      rec.reason = `a ${version === 'legacy' ? 'legacy' : 'version 0'} transaction, which this wallet does not sign (it signs ${versions.join(', ')})`;
      throw new Error(`E2E wallet refused to sign: ${rec.reason}`);
    }
    try {
      rec.instructions = await checkTransaction(bytes, keypair.publicKey);
    } catch (e) {
      rec.reason = e instanceof GuardRefusal ? e.message : `the wallet could not read the transaction: ${(e as Error).message}`;
      throw new Error(`E2E wallet refused to sign: ${rec.reason}`, { cause: e });
    }
    if (mode === 'decline') {
      rec.outcome = 'declined';
      rec.reason = 'the spec declined';
      throw new Error('User rejected the request.');
    }
    const vt = VersionedTransaction.deserialize(bytes);
    // Sign EXACTLY the message we were given: re-serializing must not change a byte.
    const nSigs = bytes[0]; // compact-u16; < 128 signatures, so one byte
    const given = Buffer.from(bytes.subarray(1 + 64 * nSigs));
    if (!Buffer.from(vt.message.serialize()).equals(given)) {
      rec.reason = 'the message did not round-trip byte for byte';
      throw new Error(`E2E wallet refused to sign: ${rec.reason}`);
    }
    vt.sign([keypair]);
    rec.outcome = 'signed';
    rec.signature = base58(vt.signatures[0]);
    return Buffer.from(vt.serialize()).toString('base64');
  });

  await context.exposeBinding(MESSAGE_BINDING, async (_source, msgBase64: string): Promise<string> => {
    const bytes = Buffer.from(msgBase64, 'base64');
    const text = bytes.toString('utf8');
    const rec: SignRecord = { at: new Date().toISOString(), kind: 'message', outcome: 'refused', reason: null, signature: null, bytes: bytes.length, instructions: [], text };
    records.push(rec);
    if (!text.startsWith(UPLOAD_MESSAGE_HEAD) || !text.split('\n').includes(`Creator: ${keypair.publicKey.toBase58()}`)) {
      rec.reason = "not the site's upload request for this wallet";
      throw new Error(`E2E wallet refused to sign a message: ${rec.reason}`);
    }
    if (mode === 'decline') {
      rec.outcome = 'declined';
      rec.reason = 'the spec declined';
      throw new Error('User rejected the request.');
    }
    const key = crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString('base64url'), x: keypair.publicKey.toBuffer().toString('base64url') },
      format: 'jwk',
    });
    const sig = crypto.sign(null, bytes, key);
    rec.outcome = 'signed';
    return sig.toString('base64');
  });

  await context.addInitScript(
    ({ name, address, pk, chains, icon, binding, messageBinding, versions }) => {
      type Listener = (props: { accounts?: unknown[] }) => void;
      const listeners = new Set<Listener>();
      let connected = false;
      const b64 = (u: Uint8Array) => { let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const account = Object.freeze({
        address,
        publicKey: new Uint8Array(pk),
        chains,
        features: ['solana:signTransaction', 'solana:signMessage'],
        label: name,
      });
      const emit = () => { for (const l of listeners) l({ accounts: connected ? [account] : [] }); };
      // Looked up per call, not captured: the binding is Playwright's to install.
      const call = (b: string, arg: string) => (window as unknown as Record<string, (a: string) => Promise<string>>)[b](arg);
      const sign = (tx: string) => call(binding, tx);
      const wallet = {
        version: '1.0.0',
        name,
        icon,
        chains,
        get accounts() { return connected ? [account] : []; },
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => { connected = true; emit(); return { accounts: [account] }; } },
          'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; emit(); } },
          'standard:events': { version: '1.0.0', on: (event: string, l: Listener) => { if (event === 'change') listeners.add(l); return () => listeners.delete(l); } },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: versions,
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
              const outputs = [];
              for (const input of inputs) outputs.push({ signedTransaction: unb64(await sign(b64(input.transaction))) });
              return outputs;
            },
          },
          'solana:signMessage': {
            version: '1.0.0',
            signMessage: async (...inputs: { message: Uint8Array }[]) => {
              const outputs = [];
              for (const input of inputs) outputs.push({ signedMessage: input.message, signature: unb64(await call(messageBinding, b64(input.message))) });
              return outputs;
            },
          },
        },
      };
      // The Wallet Standard registration protocol (@wallet-standard/wallet registerWallet).
      const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
      class RegisterWalletEvent extends Event {
        readonly #detail: typeof callback;
        get detail() { return this.#detail; }
        constructor(cb: typeof callback) { super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false }); this.#detail = cb; }
      }
      try { window.dispatchEvent(new RegisterWalletEvent(callback)); } catch (e) { console.error('e2e wallet: register failed', e); }
      try { window.addEventListener('wallet-standard:app-ready', ((ev: CustomEvent) => callback(ev.detail)) as EventListener); } catch (e) { console.error('e2e wallet: app-ready failed', e); }
    },
    { name, address: keypair.publicKey.toBase58(), pk: Array.from(keypair.publicKey.toBytes()), chains: CHAINS, icon: ICON, binding: BINDING, messageBinding: MESSAGE_BINDING, versions },
  );

  return {
    keypair,
    name,
    records,
    setMode(m) { mode = m; },
    signed: () => records.filter((r) => r.kind === 'transaction' && r.outcome === 'signed'),
    lastSigned() {
      const s = records.filter((r) => r.kind === 'transaction' && r.outcome === 'signed');
      if (!s.length) throw new Error('the wallet has signed nothing');
      return s[s.length - 1];
    },
    lastIx(ixName: string) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].kind !== 'transaction' || records[i].outcome !== 'signed') continue;
        const ix = records[i].instructions.find((x) => x.name === ixName);
        if (ix) return ix;
      }
      throw new Error(`no signed transaction carried ${ixName}`);
    },
  };
}
