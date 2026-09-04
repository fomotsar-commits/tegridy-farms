// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import type { Adapter } from '@solana/wallet-adapter-base';

/**
 * WALLET-04 — the Solana sibling of walletConnectorDeps.test.ts.
 *
 * Every LEGACY adapter we hand to WalletProvider must be able to send the
 * transactions this venue actually sends. All three Solana write paths
 * (swap, limit order, DCA) build a VersionedTransaction and call
 * sendTransaction, so an adapter that cannot take a versioned transaction is
 * not "degraded" — it is a wallet that connects, shows a balance, and then
 * throws on every single trade. That dead end is worse than not listing the
 * wallet at all.
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
 * This is why @solana/wallet-adapter-trust was evaluated and NOT adopted on
 * 2026-09-02: Trust ships `supportedTransactionVersions = null`, so Trust
 * users would have connected successfully and then failed every swap. If that
 * ever changes upstream to `new Set(['legacy', 0])`, this guard is what tells
 * you the adapter has become eligible.
 *
 * Adding an adapter to SolanaProviders means adding it here in the same
 * change — a legacy adapter absent from this list is an unguarded one.
 */
const LEGACY_ADAPTERS: ReadonlyArray<readonly [name: string, adapter: () => Adapter]> = [
  ['Phantom', () => new PhantomWalletAdapter() as unknown as Adapter],
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

  it('actually REJECTS a Trust-shaped adapter (the mutation check, kept)', () => {
    // A guard that has only ever seen passing input is not a guard. These are
    // the two disqualifying shapes, asserted against the same expectations the
    // real check above runs — so this test fails the day someone "simplifies"
    // that check into something that waves them through.
    const trustShaped = { supportedTransactionVersions: null };
    const omittedEntirely: { supportedTransactionVersions?: ReadonlySet<unknown> } = {};

    for (const candidate of [trustShaped, omittedEntirely]) {
      expect(() => {
        const versions = candidate.supportedTransactionVersions;
        expect(versions).toBeTruthy();
        expect((versions as ReadonlySet<unknown>).has(0)).toBe(true);
      }).toThrow();
    }
  });
});
