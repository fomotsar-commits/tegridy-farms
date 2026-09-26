import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Trust rides this too: with no injected Trust provider it connects over
  // WalletConnect (QR on desktop, trust:// deep link on mobile), so dropping
  // WalletConnect from the modal would take Trust's main path with it.
  ['WalletConnect + Rainbow + Trust', '@walletconnect/ethereum-provider'],
  ['Base', '@base-org/account'],
  ['Safe', '@safe-global/safe-apps-sdk'],
  ['Safe', '@safe-global/safe-apps-provider'],
  // Not a RainbowKit row. `wagmi.ts` wires coinbaseWallet directly in the
  // no-projectId fallback config, which is what CI, preview deploys, E2E and
  // fresh clones actually run — so it stubs there even though production,
  // which always has a projectId, never reaches it.
  ['Coinbase (fallback config)', '@coinbase/wallet-sdk'],
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

/**
 * SOLANA WALLETCONNECT — no second copy of anything (2026-09-25).
 *
 * The Solana connect modal's WalletConnect row (lib/solanaWalletConnect.ts)
 * declares five packages that were ALREADY in the tree, each pinned EXACTLY
 * to the copy that is already bundled. Each one is free only while it stays
 * the SAME copy as its owner's: the day an upgrade moves the owner and not us,
 * npm nests a second copy and the bundle quietly grows — for sign-client that
 * is a whole second WalletConnect core, beside the one the EVM connector
 * loads. These fail that day, naming the pair to bump together.
 *
 * They pass on the tree they were written against, by design: they guard an
 * upgrade, not today. The last test is what shows the comparison can fail at
 * all — AppKit nests its own sign-client, and it must read as a different
 * copy.
 */

/**
 * Node's own lookup (node_modules, walking up), done by hand: these packages'
 * `exports` maps hide ./package.json from require.resolve.
 */
function locate(pkg: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${pkg} is not installed (looked from ${fromDir})`);
  }
}
const HERE = dirname(fileURLToPath(import.meta.url));
const ours = (pkg: string) => locate(pkg, HERE);
/** The copy of `pkg` that `owner` gets when it imports it. */
const copyUsedBy = (owner: string, pkg: string) => locate(pkg, dirname(ours(owner)));

const SAME_COPY: ReadonlyArray<readonly [ours: string, owner: string, why: string]> = [
  ['@walletconnect/sign-client', '@walletconnect/universal-provider', 'the EVM connector’s WalletConnect core'],
  ['@walletconnect/universal-provider', '@walletconnect/ethereum-provider', 'the link that makes the line above the EVM path'],
  ['@walletconnect/keyvaluestorage', '@walletconnect/core', 'the storage every WalletConnect core on the page already opens'],
  ['@walletconnect/core', '@walletconnect/sign-client', 'the link that makes the line above sign-client’s own'],
  ['cuer', '@rainbow-me/rainbowkit', 'RainbowKit’s QR component, in the eager vendor-wagmi chunk'],
  ['@noble/curves', '@solana/web3.js', 'web3.js’s own ed25519, in the eager vendor-crypto chunk'],
  ['@scure/base', '@walletconnect/utils', 'base58/base64 already in vendor-crypto'],
];

describe('Solana WalletConnect adds no second copy of anything', () => {
  it.each(SAME_COPY)('%s is the same copy %s uses (%s)', (pkg, owner) => {
    expect(ours(pkg)).toBe(copyUsedBy(owner, pkg));
  });

  it('the check can see a second copy (AppKit still nests WalletConnect 2.23.7)', () => {
    // Mutation check kept in the file: a nested copy exists in this tree today,
    // and the comparison above must tell it apart from ours.
    expect(copyUsedBy('@reown/appkit', '@walletconnect/sign-client')).not.toBe(ours('@walletconnect/sign-client'));
  });
});
