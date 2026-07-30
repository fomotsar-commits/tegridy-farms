/**
 * AUDIT C-05 — Wallet-integrated E2E test foundation.
 *
 * Pattern: inject a mock EIP-1193 provider as window.ethereum BEFORE the app loads.
 * Tests drive the mock from Playwright-land via `page.evaluate`, and the app sees
 * exactly the JSON-RPC shape a real wallet would emit. No Anvil, MetaMask, or other
 * external dependency is required for this baseline; you can replace the mock's
 * in-memory backing with an Anvil fork URL (see ANVIL_BACKEND section at the bottom)
 * once you want true on-chain simulation.
 *
 * What the mock currently handles (enough for the UI happy-path specs):
 *   eth_chainId          — returns configured chainId (default 1)
 *   eth_accounts         — returns [testAccount] after connect(), [] before
 *   eth_requestAccounts  — connects and returns [testAccount]
 *   personal_sign        — returns a canned signature (doesn't really sign)
 *   wallet_switchEthereumChain — updates chainId and emits chainChanged
 *   eth_call / eth_blockNumber / eth_getBalance — returns canned defaults; override
 *     per-test via `walletMock.setReadResponses({...})`
 *
 * What it does NOT handle:
 *   - Real signatures / transactions that the chain needs to accept. Any test that
 *     asserts on-chain state changes must be paired with an Anvil backend.
 *
 * Usage:
 *   import { test } from './fixtures/wallet';
 *   test('connects and shows address', async ({ page, walletMock }) => {
 *     await page.goto('/');
 *     await walletMock.connect();
 *     await page.getByRole('button', { name: /connect/i }).click();
 *     await expect(page.getByText(/hoodhokage|0x/i)).toBeVisible();
 *   });
 */

import { test as base, expect, type Page } from '@playwright/test';

const DEFAULT_ACCOUNT = '0x71be63f3384f5fb98995898a86b02fb2426c5788'; // Hardhat account #9
const DEFAULT_CHAIN_ID = 1; // Ethereum mainnet

// ANVIL_BACKEND. When ANVIL_RPC_URL is set, unhandled JSON-RPC is forwarded to a
// real anvil node instead of being answered with canned values — which is what
// turns the `test.skip(!onAnvil, …)` specs in stake/swap/liquidity/lending/
// claim-rewards into genuine end-to-end flows. Unset, behaviour is byte-identical
// to before: canned reads, no network.
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL;

export interface WalletMock {
  /** Mark the mock as connected; eth_accounts now returns [account]. */
  connect: (account?: string) => Promise<void>;
  /** Mark the mock as disconnected. */
  disconnect: () => Promise<void>;
  /** Switch chain and emit chainChanged. */
  switchChain: (chainId: number) => Promise<void>;
  /** Override eth_call / eth_getBalance responses by method + optional data prefix. */
  setReadResponses: (map: Record<string, string>) => Promise<void>;
  /** Capture all JSON-RPC calls the app has made since mock install. */
  getCalls: () => Promise<Array<{ method: string; params: unknown }>>;
}

type Fixtures = { walletMock: WalletMock };

export const test = base.extend<Fixtures>({
  // Playwright fixture callback takes a "use" function as its second arg. We
  // rename it (anything not starting with `use*` or uppercase) so the React
  // hooks lint rule doesn't mistake the call for a React hook.
  walletMock: async ({ page }, provide) => {
    // Suppress full-viewport overlays that block clicks in test runs:
    //   - AppLoader splash canvas (zIndex 9999)
    //   - OnboardingModal welcome dialog (zIndex 100)
    // Both self-dismiss on repeat visits by checking storage flags; pre-seed
    // the flags before nav so they short-circuit on mount.
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('tf_loaded', '1');
        localStorage.setItem('tegridy-onboarding-seen', '1');
      } catch { /* ignore */ }
    });
    await installWalletMock(page);
    const mock: WalletMock = {
      connect: async (account = DEFAULT_ACCOUNT) => {
        await page.evaluate(
          ([addr]) => (window as unknown as { __walletMock: { connect: (a: string) => void } }).__walletMock.connect(addr!),
          [account]
        );
      },
      disconnect: async () => {
        await page.evaluate(() =>
          (window as unknown as { __walletMock: { disconnect: () => void } }).__walletMock.disconnect()
        );
      },
      switchChain: async (chainId) => {
        await page.evaluate(
          ([id]) => (window as unknown as { __walletMock: { switchChain: (n: number) => void } }).__walletMock.switchChain(id!),
          [chainId]
        );
      },
      setReadResponses: async (map) => {
        await page.evaluate(
          ([m]) => (window as unknown as { __walletMock: { setReadResponses: (x: Record<string, string>) => void } }).__walletMock.setReadResponses(m!),
          [map]
        );
      },
      getCalls: async () =>
        page.evaluate(() =>
          (window as unknown as { __walletMock: { getCalls: () => Array<{ method: string; params: unknown }> } }).__walletMock.getCalls()
        ),
    };
    await provide(mock);
  },
});

export { expect };

/**
 * Installed BEFORE the app bundle evaluates. Anything inside must be self-contained
 * because Playwright serializes the function body across the page boundary.
 */
async function installWalletMock(page: Page): Promise<void> {
  // Must be exposed BEFORE the init script runs, and it survives navigation.
  if (ANVIL_RPC_URL) await installAnvilBridge(page, ANVIL_RPC_URL);
  await page.addInitScript(
    ([account, chainId, anvilEnabled]) => {
      type Listener = (...args: unknown[]) => void;
      const listeners: Record<string, Set<Listener>> = {};
      const calls: Array<{ method: string; params: unknown }> = [];
      let connectedAccounts: string[] = [];
      let currentChainId = chainId as number;
      const reads: Record<string, string> = {
        eth_blockNumber: '0x1234567',
        eth_getBalance: '0xde0b6b3a7640000', // 1 ETH
      };

      function emit(event: string, ...args: unknown[]): void {
        listeners[event]?.forEach((cb) => cb(...args));
      }

      const provider = {
        isMetaMask: false,
        isTegridyTestMock: true,
        async request(args: { method: string; params?: unknown }) {
          calls.push({ method: args.method, params: args.params });
          switch (args.method) {
            case 'eth_chainId':
              return `0x${currentChainId.toString(16)}`;
            case 'eth_accounts':
              return connectedAccounts;
            case 'eth_requestAccounts': {
              connectedAccounts = [account as string];
              emit('accountsChanged', connectedAccounts);
              return connectedAccounts;
            }
            case 'personal_sign':
              return '0x' + '00'.repeat(64) + '1b';
            case 'wallet_switchEthereumChain': {
              const chainHex = (args.params as Array<{ chainId: string }>)[0]?.chainId;
              if (chainHex) {
                currentChainId = parseInt(chainHex, 16);
                emit('chainChanged', chainHex);
              }
              return null;
            }
            default: {
              // ANVIL_BACKEND step 2 — forward anything we do not emulate to the
              // real node. Reached by eth_call, eth_estimateGas, eth_getBalance,
              // eth_blockNumber, eth_getTransactionReceipt, eth_sendTransaction…
              // i.e. everything a state-changing flow actually needs.
              const bridge = (
                window as unknown as {
                  __tegridyAnvilRpc?: (m: string, p: unknown[]) => Promise<unknown>;
                }
              ).__tegridyAnvilRpc;
              if (anvilEnabled && typeof bridge === 'function') {
                return await bridge(args.method, (args.params as unknown[]) ?? []);
              }
              const override = reads[args.method];
              if (override !== undefined) return override;
              return null;
            }
          }
        },
        on(event: string, cb: Listener) {
          (listeners[event] ||= new Set()).add(cb);
        },
        removeListener(event: string, cb: Listener) {
          listeners[event]?.delete(cb);
        },
      };

      (window as unknown as { ethereum: typeof provider }).ethereum = provider;
      (window as unknown as { __walletMock: Record<string, unknown> }).__walletMock = {
        connect: (addr: string) => {
          connectedAccounts = [addr];
          emit('accountsChanged', connectedAccounts);
        },
        disconnect: () => {
          connectedAccounts = [];
          emit('accountsChanged', []);
        },
        switchChain: (id: number) => {
          currentChainId = id;
          emit('chainChanged', `0x${id.toString(16)}`);
        },
        setReadResponses: (map: Record<string, string>) => {
          Object.assign(reads, map);
        },
        getCalls: () => calls,
      };
    },
    [DEFAULT_ACCOUNT, DEFAULT_CHAIN_ID, !!ANVIL_RPC_URL] as [string, number, boolean]
  );
}

/**
 * ANVIL_BACKEND steps 2-4. Forwards JSON-RPC from the page's injected provider to
 * a real anvil node.
 *
 * The forwarding deliberately happens HERE, in Node, not in the page:
 *   * no CORS — the page never talks to 127.0.0.1 directly
 *   * anvil's `anvil_*` cheatcodes are reachable, which is what lets us send
 *     transactions with NO PRIVATE KEY anywhere in the test suite
 */
async function installAnvilBridge(page: Page, rpcUrl: string): Promise<void> {
  let nextId = 1;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`anvil ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`anvil ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }

  // ANVIL_BACKEND step 3 — CORRECTED. The original TODO said DEFAULT_ACCOUNT is
  // "one of Anvil's pre-funded accounts", which is true for a FRESH anvil chain
  // and FALSE when forking: a fork inherits mainnet state, and account #9 holds
  // 0 ETH on mainnet. Verified — eth_getBalance returned 0x0 on a live fork.
  // So fund it explicitly. anvil_setBalance needs no key and no faucet.
  await rpc('anvil_setBalance', [DEFAULT_ACCOUNT, '0x21e19e0c9bab2400000']); // 10,000 ETH

  await page.exposeFunction(
    '__tegridyAnvilRpc',
    async (method: string, params: unknown[] = []): Promise<unknown> => {
      // ANVIL_BACKEND step 4 — sign without a key. `anvil_impersonateAccount`
      // makes the node accept eth_sendTransaction from an address it holds no
      // key for, so DEFAULT_ACCOUNT (anvil/hardhat account #9, pre-funded on a
      // fresh fork) can transact and NO private key is ever handled by the
      // fixture, the specs, or CI.
      if (method === 'eth_sendTransaction') {
        const from = (params?.[0] as { from?: string } | undefined)?.from;
        if (from) await rpc('anvil_impersonateAccount', [from]);
      }
      return rpc(method, params);
    },
  );
}

// ─── ANVIL_BACKEND — IMPLEMENTED 2026-07-30 ──────────────────────────────
// This used to be a 4-step TODO. All four are now done, above:
//   1. Run anvil forking mainnet. Verified working against a KEYLESS RPC
//      (https://ethereum-rpc.publicnode.com) — no paid archive provider needed:
//        anvil --fork-url https://ethereum-rpc.publicnode.com --port 8545
//      Sanity check that the fork sees real state — TOWELI totalSupply via
//      eth_call returns 0x033b2e3c9fd0803ce8000000 (1e9 * 1e18).
//   2. Unhandled requests forward to anvil — see the `default:` case above.
//   3. DEFAULT_ACCOUNT is funded via `anvil_setBalance` at bridge-install time.
//      NOTE the original TODO was WRONG here: it said account #9 is "pre-funded",
//      which holds for a FRESH anvil chain but not for a FORK — a fork inherits
//      mainnet state, where that address has 0 ETH. Confirmed on a live fork
//      (eth_getBalance -> 0x0), hence the explicit top-up.
//   4. eth_sendTransaction is signed by the node via `anvil_impersonateAccount`,
//      so NO private key exists anywhere in this suite.
//
// To run the state-changing specs:
//   ANVIL_RPC_URL=http://127.0.0.1:8545 npx playwright test e2e/stake.spec.ts …
// With ANVIL_RPC_URL unset every one of those specs still skips exactly as
// before, and mock-mode behaviour is unchanged.
