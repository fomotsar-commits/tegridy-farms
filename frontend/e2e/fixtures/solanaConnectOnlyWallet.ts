// A Wallet Standard wallet that can CONNECT and nothing else, registered before
// the app loads. It exists to show the connected state of the Solana connect
// flow (the top bar's address, the page's own card) in the mock-mode suite.
//
// It holds no key: the address is 32 fixed bytes, and solana:signTransaction
// always rejects. The registration protocol is the one in
// e2e-solana/fixtures/testWallet.ts, copied rather than imported, because that
// file's guard pulls in localnet-only code this suite must not load.
import type { BrowserContext } from '@playwright/test';

export const CONNECT_ONLY_WALLET_NAME = 'E2E Test Wallet';
/** base58 of the bytes 1..32. */
export const CONNECT_ONLY_WALLET_ADDRESS = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';
const CHAINS = ['solana:mainnet'];
// A plain square; Wallet Standard requires a data: URI icon.
const ICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#3b7a57"/></svg>').toString('base64')}`;

/** Register the wallet in every page of `context`. */
export async function installConnectOnlySolanaWallet(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ name, address, chains, icon }) => {
      type Listener = (props: { accounts?: unknown[] }) => void;
      const listeners = new Set<Listener>();
      let connected = false;
      const account = Object.freeze({
        address,
        publicKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        chains,
        features: ['solana:signTransaction'],
        label: name,
      });
      const emit = () => { for (const l of listeners) l({ accounts: connected ? [account] : [] }); };
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
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async () => { throw new Error('This test wallet connects only; it signs nothing.'); },
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
    { name: CONNECT_ONLY_WALLET_NAME, address: CONNECT_ONLY_WALLET_ADDRESS, chains: CHAINS, icon: ICON },
  );
}
