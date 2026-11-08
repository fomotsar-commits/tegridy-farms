// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import {
  BackpackWalletAdapter,
  CoinbaseWalletAdapter,
  IPadAwarePhantomWalletAdapter,
  JupiterWalletAdapter,
  MetaMaskWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '../../lib/solanaWallets';
import { TangemWalletAdapter, WalletConnectWalletAdapter } from '../../lib/solanaWalletConnect';
import type { Adapter } from '@solana/wallet-adapter-base';

/**
 * WALLET-04 — the Solana sibling of walletConnectorDeps.test.ts.
 *
 * Every LEGACY adapter we hand to WalletProvider must be able to send the
 * transactions this venue actually sends. Every Solana write path builds a
 * VersionedTransaction — swap, limit order and DCA go through
 * BaseSignerWalletAdapter.sendTransaction, and bungalow staking goes through
 * the Streamflow SDK, which compiles a v0 message and calls
 * `invoker.signTransaction` directly. An adapter that cannot take a versioned
 * transaction is not "degraded" — it is a wallet that connects, shows a
 * balance, and then throws on every single write. That dead end is worse than
 * not listing the wallet at all.
 *
 * The trap this pins: `supportedTransactionVersions = null` READS like "no
 * restriction / all versions" and is the exact opposite. In
 * wallet-adapter-base, null|undefined narrows
 * TransactionOrVersionedTransaction to a bare legacy `Transaction`
 * (types/transaction.d.ts), and BaseSignerWalletAdapter.sendTransaction
 * throws `Sending versioned transactions isn't supported by this wallet` when
 * the field is falsy (esm/signer.js). `undefined` — i.e. an adapter that
 * simply omits the field — is equally disqualifying.
 *
 * ── 2026-09-14: this guard is why Trust is now here rather than excluded ──
 *
 * On 2026-09-02 this file recorded that @solana/wallet-adapter-trust was
 * evaluated and NOT adopted, because it ships `supportedTransactionVersions =
 * null`. That reading of the PACKAGE was correct and is still true of
 * 0.1.18 (published 2026-09-10). It was the wrong reading of the WALLET:
 * Trust's own Wallet Standard implementation declares ['legacy', 0] on both
 * solana:signTransaction and solana:signAndSendTransaction, and wallet-core
 * has signed v0 since 2023. So the venue vendors its own adapter
 * (lib/solanaWallets.ts) with the honest declaration instead of adopting a
 * package whose metadata is stale — and that adapter faces this guard like
 * every other.
 *
 * Adding an adapter to SolanaProviders means adding it here in the same
 * change — a legacy adapter absent from this list is an unguarded one.
 */
const LEGACY_ADAPTERS: ReadonlyArray<readonly [name: string, adapter: () => Adapter]> = [
  ['Phantom', () => new IPadAwarePhantomWalletAdapter() as unknown as Adapter],
  ['Trust', () => new TrustWalletAdapter() as unknown as Adapter],
  ['Jupiter', () => new JupiterWalletAdapter() as unknown as Adapter],
  ['MetaMask', () => new MetaMaskWalletAdapter() as unknown as Adapter],
  ['Coinbase Wallet', () => new CoinbaseWalletAdapter() as unknown as Adapter],
  ['Solflare', () => new SolflareWalletAdapter() as unknown as Adapter],
  ['Backpack', () => new BackpackWalletAdapter() as unknown as Adapter],
  ['Tangem', () => new TangemWalletAdapter({ projectId: 'test' }) as unknown as Adapter],
  ['WalletConnect', () => new WalletConnectWalletAdapter({ projectId: 'test' }) as unknown as Adapter],
];

describe('Solana legacy adapters can send what this venue sends', () => {
  it.each(LEGACY_ADAPTERS)(
    '%s declares support for versioned (v0) transactions',
    (_name, make) => {
      const versions = make().supportedTransactionVersions;
      // Falsy (null/undefined) is legacy-only — the failure this guard exists
      // to catch — so assert the positive capability, not just "not null".
      expect(versions).toBeTruthy();
      expect(versions!.has(0)).toBe(true);
    },
  );

  it('pins the base-package semantics this guard depends on', () => {
    // If a wallet-adapter-base upgrade ever made a falsy value mean "all
    // versions", the assertion above would still pass but for the wrong
    // reason. Phantom's own declaration is the canonical shape; keep a
    // sighting of it so the guard's premise stays visible.
    const versions = new PhantomWalletAdapter().supportedTransactionVersions;
    expect(versions).toEqual(new Set(['legacy', 0]));
  });

  it('every adapter mounted by SolanaProviders is covered by this list', async () => {
    // The rule in the header is only as good as its enforcement: an adapter
    // added to SolanaProviders but not to LEGACY_ADAPTERS would sail past
    // every assertion above by simply not being tested. Read the real list.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./SolanaProviders.tsx', import.meta.url), 'utf8'),
    );
    const mounted = [...source.matchAll(/new\s+(\w+WalletAdapter)\(/g)].map((m) => m[1]);
    expect(mounted.length).toBeGreaterThan(0);
    expect(new Set(mounted)).toEqual(
      new Set([
        'IPadAwarePhantomWalletAdapter',
        'TrustWalletAdapter',
        'JupiterWalletAdapter',
        'MetaMaskWalletAdapter',
        'CoinbaseWalletAdapter',
        'SolflareWalletAdapter',
        'BackpackWalletAdapter',
        'TangemWalletAdapter',
        'WalletConnectWalletAdapter',
      ]),
    );
    expect(mounted.length).toBe(LEGACY_ADAPTERS.length);
  });

  it('actually REJECTS a null-shaped adapter (the mutation check, kept)', () => {
    // A guard that has only ever seen passing input is not a guard. These are
    // the two disqualifying shapes — the exact shape @solana/wallet-adapter-
    // trust still ships, and an adapter that omits the field — asserted
    // against the same expectations the real check above runs, so this test
    // fails the day someone "simplifies" that check into something that waves
    // them through.
    const packagedTrustShaped = { supportedTransactionVersions: null };
    const omittedEntirely: { supportedTransactionVersions?: ReadonlySet<unknown> } = {};

    for (const candidate of [packagedTrustShaped, omittedEntirely]) {
      expect(() => {
        const versions = candidate.supportedTransactionVersions;
        expect(versions).toBeTruthy();
        expect((versions as ReadonlySet<unknown>).has(0)).toBe(true);
      }).toThrow();
    }
  });
});

// ── version 1 signing (SIMD-0385), 2026-11-07 ──────────────────────────────────
// Phantom asked for version 1 transactions (ticket #455104). The write path builds one
// only for a wallet whose wallet-standard `solana:signTransaction` feature lists 1 for
// the connected account; every other wallet keeps the legacy path. The detection reads
// the standard wallet behind wallet-adapter's StandardWalletAdapter, never the adapter's
// own `supportedTransactionVersions` (the Set above, which never says 1).
import { PublicKey } from '@solana/web3.js';
import { v1SignerOf } from '../../lib/solana/v1Signer';

describe('v1SignerOf: which wallets are handed version 1 bytes', () => {
  const ME = new PublicKey(new Uint8Array(32).fill(7));
  const signed = new Uint8Array([129, 9, 9]);
  function standardAdapter(versions: ReadonlyArray<'legacy' | 0 | 1>, o: { accountLists?: boolean; address?: string } = {}) {
    const calls: unknown[] = [];
    const account = {
      address: o.address ?? ME.toBase58(),
      publicKey: ME.toBytes(),
      chains: ['solana:mainnet', 'solana:devnet'],
      features: o.accountLists === false ? [] : ['solana:signTransaction'],
    };
    const wallet = {
      name: 'Phantom',
      version: '1.0.0',
      icon: 'data:image/png;base64,',
      chains: ['solana:mainnet'],
      accounts: [account],
      features: {
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: versions,
          signTransaction: async (...inputs: unknown[]) => {
            calls.push(inputs);
            return inputs.map(() => ({ signedTransaction: signed }));
          },
        },
      },
    };
    return { adapter: { standard: true as const, wallet }, calls, account };
  }

  it('Phantom-shaped: the feature lists 1 for the account, so the signer hands bytes over on the chain asked for', async () => {
    const { adapter, calls, account } = standardAdapter(['legacy', 0, 1]);
    const sign = v1SignerOf(adapter, ME);
    expect(sign).not.toBeNull();
    const bytes = new Uint8Array([129, 1, 2, 3]);
    expect(await sign!(bytes, 'solana:mainnet')).toEqual(signed);
    expect(calls).toEqual([[{ account, chain: 'solana:mainnet', transaction: bytes }]]);
  });

  it.each([
    ['MetaMask-shaped: legacy and 0 only', () => standardAdapter(['legacy', 0]).adapter],
    ['an account that does not list the feature', () => standardAdapter(['legacy', 0, 1], { accountLists: false }).adapter],
    ['a wallet whose account is another address', () => standardAdapter(['legacy', 0, 1], { address: new PublicKey(new Uint8Array(32).fill(8)).toBase58() }).adapter],
    ['a legacy adapter with no standard wallet behind it', () => new IPadAwarePhantomWalletAdapter()],
  ])('%s keeps the legacy path', (_what, make) => {
    expect(v1SignerOf(make(), ME)).toBeNull();
  });

  it('a wallet that returns nothing is an error, never an empty transaction', async () => {
    const { adapter } = standardAdapter(['legacy', 0, 1]);
    (adapter.wallet.features['solana:signTransaction'] as { signTransaction: unknown }).signTransaction = async () => [];
    await expect(v1SignerOf(adapter, ME)!(new Uint8Array([129]), 'solana:mainnet')).rejects.toThrow(/did not return/);
  });
});
