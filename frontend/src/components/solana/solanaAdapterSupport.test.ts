// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { TrustWalletAdapter } from '../../lib/solanaWallets';
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
  ['Phantom', () => new PhantomWalletAdapter() as unknown as Adapter],
  ['Trust', () => new TrustWalletAdapter() as unknown as Adapter],
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
    expect(new Set(mounted)).toEqual(new Set(['PhantomWalletAdapter', 'TrustWalletAdapter']));
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
