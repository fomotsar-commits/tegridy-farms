import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireFrom = createRequire(import.meta.url);

/**
 * WALLET-03 — every wallet in the connect modal needs an OPTIONAL peer dep.
 *
 * `@wagmi/connectors` declares these under `peerDependenciesMeta` as
 * `optional: true` and reaches them through a lazy `await import(...)` inside
 * each connector's `getInstance()`. "Optional" means npm will not install them
 * and will not warn, and the bundler will not fail the build. Instead rolldown
 * emits a ~110-byte chunk whose entire body is:
 *
 *   throw Error(`Could not resolve "<pkg>" imported by "@wagmi/connectors". Is it installed?`);
 *
 * `connect()` awaits `getInstance()` before it ever touches a provider, so the
 * wallet hangs on "Opening <wallet>…" forever — no console error, no network
 * request, no rejected promise the UI can render. It is silent in dev, silent
 * in CI, silent in the build log, and only visible to a user clicking Connect.
 *
 * This shipped to production: on 2026-08-02 memetics.finance and memetic.fun
 * both served throwing stubs for MetaMask, WalletConnect, Rainbow, Base and
 * Safe. Every wallet was dead except Phantom — which survived only because it
 * is discovered over EIP-6963 and built by @wagmi/core itself, with no
 * optional dependency in its path.
 *
 * Resolvability is the invariant, NOT the version — pinning a version here
 * would just churn. If a wallet is deliberately dropped from the connect
 * modal, delete its entry here in the same change.
 */
const WALLET_RUNTIME_DEPS: ReadonlyArray<readonly [wallet: string, pkg: string]> = [
  ['MetaMask', '@metamask/connect-evm'],
  ['WalletConnect + Rainbow', '@walletconnect/ethereum-provider'],
  ['Base', '@base-org/account'],
  ['Safe', '@safe-global/safe-apps-sdk'],
  ['Safe', '@safe-global/safe-apps-provider'],
];

describe('wallet connector runtime dependencies', () => {
  it.each(WALLET_RUNTIME_DEPS)(
    '%s: %s resolves, so the lazy chunk is real code and not a throwing stub',
    (_wallet, pkg) => {
      expect(() => requireFrom.resolve(pkg)).not.toThrow();
    },
  );

  it('keeps every optional peer that @wagmi/connectors can lazily import accounted for', () => {
    // Guards the list above against a wagmi upgrade that adds a NEW optional
    // peer for a wallet we ship. Anything genuinely unused belongs in
    // INTENTIONALLY_ABSENT with a reason, so the decision is explicit rather
    // than an oversight that silently becomes another dead wallet button.
    const INTENTIONALLY_ABSENT = new Set([
      'typescript', // toolchain, not a runtime wallet dep
      'porto', // no Porto wallet in the connect modal
      'accounts', // no Accounts wallet in the connect modal
      '@coinbase/wallet-sdk', // Coinbase row is not in our RainbowKit wallet list
    ]);

    const meta = requireFrom('@wagmi/connectors/package.json').peerDependenciesMeta ?? {};
    const optionalPeers = Object.entries(meta)
      .filter(([, v]) => (v as { optional?: boolean })?.optional)
      .map(([name]) => name);

    const declared = new Set(WALLET_RUNTIME_DEPS.map(([, pkg]) => pkg));
    const unaccounted = optionalPeers.filter(
      (p) => !declared.has(p) && !INTENTIONALLY_ABSENT.has(p),
    );

    expect(unaccounted).toEqual([]);
  });
});
