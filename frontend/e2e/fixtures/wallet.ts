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
  walletMock: async ({ page }, use) => {
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
    await use(mock);
  },
});

export { expect };

/**
 * Installed BEFORE the app bundle evaluates. Anything inside must be self-contained
 * because Playwright serializes the function body across the page boundary.
 */
async function installWalletMock(page: Page): Promise<void> {
  await page.addInitScript(
    ([account, chainId]) => {
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
    [DEFAULT_ACCOUNT, DEFAULT_CHAIN_ID]
  );
}

// ─── ANVIL_BACKEND ───────────────────────────────────────────────────────
// To upgrade this fixture for real on-chain simulation:
//   1. Start Anvil on localhost:8545 forking mainnet at a known block:
//        anvil --fork-url https://eth.llamarpc.com --fork-block-number 19000000
//   2. In the installWalletMock default case, forward unhandled requests to
//      Anvil over fetch:
//        const r = await fetch('http://localhost:8545', {
//          method: 'POST',
//          headers: { 'content-type': 'application/json' },
//          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: args.method, params: args.params ?? [] }),
//        });
//        const j = await r.json();
//        return j.result;
//   3. Use one of Anvil's pre-funded accounts (DEFAULT_ACCOUNT matches account #9).
//   4. Sign eth_sendTransaction server-side via Anvil's impersonate cheatcode.
// Once those four tweaks are in place, the same test specs become real end-to-end
// flows — no changes to spec code required.
