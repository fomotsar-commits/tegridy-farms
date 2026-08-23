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

/** Live TOWELI. Mirrors src/lib/constants.ts; the specs gate CTAs on this balance. */
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D';

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Assert a transaction receipt link appeared — one that could not have been on the page
 * before the action.
 *
 * ⚠ EVERY money-path spec used to do this instead:
 *     page.locator('a[href*="etherscan"], a[href*="explorer"]').first()
 * and that is a FALSE GREEN. Measured on /swap with no wallet and no transaction: one
 * such link is already present and visible — the static TOWELI token link
 * (`etherscan.io/token/0x420698…`, "Etherscan ↗"). Several surfaces carry similar
 * standing links.
 *
 * The consequence was worse than a weak assertion. In liquidity.spec.ts it let the spec
 * sail past a supply that never landed and fail four lines later on a missing remove
 * button — pointing the reader at the wrong step entirely. A receipt link points at
 * `/tx/0x<64 hex>`, and nothing static does.
 *
 * Lives here, not copy-pasted per spec, because the original was fixed in swap.spec.ts
 * alone and survived in five other places.
 */
export async function expectTxReceipt(page: Page, what: string): Promise<void> {
  const link = page.locator('a[href*="/tx/0x"]');
  await expect(
    link.first(),
    `${what}: no explorer link to a transaction hash appeared. A receipt link points at ` +
      `/tx/0x…; the static token link on these pages is NOT a receipt and must not satisfy this.`,
  ).toBeVisible({ timeout: 30_000 });
  await expect(link.first()).toHaveAttribute('href', /\/tx\/0x[0-9a-fA-F]{64}/);
}

/**
 * Give `holder` an ERC-20 balance on the fork by writing the balance slot directly.
 *
 * THE SLOT IS DISCOVERED, NOT HARDCODED, and that is the whole point. `balanceOf` is
 * `_balances[holder]` at `keccak256(abi.encode(holder, N))` for some mapping slot N —
 * and N depends on the contract's storage layout. The live TOWELI is NOT this repo's
 * Toweli.sol: it is a generator template ("Towelie", ERC20 + ERC20Burnable +
 * Ownable2Step + Initializable), so N is not the 0 you would get from a textbook
 * OpenZeppelin ERC20, and nothing in this repo pins its layout.
 *
 * A hardcoded slot would not throw. It would write to an unrelated slot, leave
 * balanceOf at 0, and hand the spec back the exact "CTA never enabled" timeout this
 * function exists to remove — a fixture that looks like it ran and did nothing. So we
 * probe: write a sentinel, read balanceOf back through the contract's OWN getter, and
 * keep the slot only if the getter agrees. Self-verifying by construction.
 *
 * Every probe is undone before moving on, so a wrong guess leaves no residue.
 */
async function seedErc20Balance(rpc: Rpc, token: string, holder: string, amount: bigint): Promise<void> {
  const { keccak256, encodeAbiParameters, parseAbiParameters, toHex, pad } = await import('viem');
  const balanceOfCall = `0x70a08231${pad(holder as `0x${string}`, { size: 32 }).slice(2)}`;

  const readBalance = async (): Promise<bigint> => {
    const hex = (await rpc('eth_call', [{ to: token, data: balanceOfCall }, 'latest'])) as string;
    return hex && hex !== '0x' ? BigInt(hex) : 0n;
  };

  const before = await readBalance();
  if (before >= amount) return; // already rich enough — nothing to do

  const sentinel = pad(toHex(amount), { size: 32 });
  for (let slot = 0; slot < 64; slot++) {
    const key = keccak256(
      encodeAbiParameters(parseAbiParameters('address, uint256'), [holder as `0x${string}`, BigInt(slot)]),
    );
    const prior = (await rpc('eth_getStorageAt', [token, key, 'latest'])) as string;
    await rpc('anvil_setStorageAt', [token, key, sentinel]);
    if ((await readBalance()) === amount) return; // the getter agrees — this is the slot
    await rpc('anvil_setStorageAt', [token, key, prior]); // wrong guess, leave no trace
  }

  // FAIL LOUD. Silently continuing hands the spec a timeout whose message blames the
  // product ("CTA never enabled") for a fixture that could not find the slot.
  throw new Error(
    `seedErc20Balance: could not locate the balance slot for ${token} in slots 0-63. ` +
      `The token's storage layout changed, or it proxies balanceOf. Do NOT hardcode a slot ` +
      `to work around this — find out why the probe failed.`,
  );
}

export interface WalletMock {
  /**
   * Mark the mock as connected; eth_accounts now returns [account].
   *
   * Safe to call BEFORE the first `page.goto`, and that is the form you want
   * for anything that asserts a CONNECTED surface — see the note on
   * `__walletMockConnected` in installWalletMock.
   */
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

// ⚠ ORDER-DEPENDENCE IS A KNOWN, OPEN ISSUE HERE — and an `evm_snapshot`/`evm_revert`
// auto-fixture is NOT the drop-in fix it looks like. Tried 2026-08-12 and reverted: the
// rollback also rewinds `anvil_setBalance` and the seeded ERC-20 balance, and it races
// the per-test bridge install, which turned two passing render tests red. If you pick
// this up, snapshot AFTER the bridge has finished seeding, not before, and prove the
// basic render tests still pass before trusting the money paths.
//
// The symptom to watch for: a spec that passes alone and fails in a batch. stake.spec
// does exactly that today — it spends, leaving a position and an allowance behind.
export const test = base.extend<Fixtures>({
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
        // ConsentBanner is a THIRD full-width fixed overlay that this list
        // missed (role=dialog, z-[120], bottom-0 — AppLayout.tsx:187). On short
        // viewports it and the fixed header sandwich the page, so Playwright
        // cannot land a click on the launch door's audit toggle, which is the
        // `locator.click: Test timeout of 30000ms exceeded` in CI.
        //
        // `getConsent()` returns 'pending' — and the banner shows — for anything
        // that is not exactly 'granted' or 'denied' (src/lib/consent.ts:18-24),
        // so the key has to hold one of those two. 'denied' is chosen so the
        // suite never opts a synthetic visitor into telemetry.
        localStorage.setItem('tegridy_telemetry_consent', 'denied');
      } catch { /* ignore */ }
    });
    await installWalletMock(page);
    const mock: WalletMock = {
      connect: async (account = DEFAULT_ACCOUNT) => {
        // TWO writes, and both are load-bearing.
        //
        // 1. An init script, so the account survives navigation AND is already
        //    there when wagmi's reconnect() runs on mount. That is the only
        //    window in which the app can end up genuinely connected: reconnect
        //    calls injected.isAuthorized(), which is just `eth_accounts` being
        //    non-empty. Before this existed, every "connected" spec ran against
        //    a wallet the app had never authorized — the surfaces they asserted
        //    on were the DISCONNECTED ones, and the assertions were vacuous.
        // 2. A live evaluate for the already-loaded case, best-effort because
        //    connect() is legitimately called before the first navigation.
        await page.addInitScript(
          ([addr]) => {
            (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = addr;
          },
          [account]
        );
        await page
          .evaluate(
            ([addr]) => (window as unknown as { __walletMock?: { connect: (a: string) => void } }).__walletMock?.connect(addr!),
            [account]
          )
          .catch(() => { /* no document yet — the init script covers the next load */ });
      },
      disconnect: async () => {
        await page.addInitScript(() => {
          (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = undefined;
        });
        await page
          .evaluate(() =>
            (window as unknown as { __walletMock?: { disconnect: () => void } }).__walletMock?.disconnect()
          )
          .catch(() => { /* nothing loaded */ });
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

      // Read LAZILY, never at install time. `connect()` seeds
      // `__walletMockConnected` with its own addInitScript, which necessarily
      // runs AFTER this one on every document; by the time the app asks for
      // accounts both have run, so the ordering resolves itself. Reading it
      // eagerly here would always see undefined.
      function accountsNow(): string[] {
        if (connectedAccounts.length) return connectedAccounts;
        const seeded = (window as unknown as { __walletMockConnected?: string }).__walletMockConnected;
        if (seeded) connectedAccounts = [seeded];
        return connectedAccounts;
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
              return accountsNow();
            case 'eth_requestAccounts': {
              connectedAccounts = [account as string];
              emit('accountsChanged', connectedAccounts);
              return connectedAccounts;
            }
            case 'wallet_requestPermissions':
              // RainbowKit / wagmi's injected connector asks for this before
              // eth_requestAccounts on some paths; returning null makes it fall
              // through to eth_requestAccounts rather than throwing.
              return null;
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

      // EIP-6963 announcement. Setting window.ethereum alone is NOT enough for
      // this app: it builds its wagmi config through RainbowKit's
      // getDefaultConfig, and wagmi's `multiInjectedProviderDiscovery` is what
      // turns a browser wallet into a connector there. Without an announcement
      // the app never so much as calls `eth_accounts` on the mock — verified:
      // `__walletMock.getCalls()` came back EMPTY after a full page load, which
      // is what made every "connected" assertion in the money-path specs an
      // assertion about the DISCONNECTED surface.
      const providerInfo = {
        uuid: '11111111-2222-3333-4444-555555555555',
        name: 'Tegridy E2E Mock',
        // 1x1 transparent PNG — RainbowKit requires a data URI here.
        icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        rdns: 'farms.tegridy.e2emock',
      };
      const announce = () => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: providerInfo, provider }),
          }),
        );
      };
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
      (window as unknown as { __walletMock: Record<string, unknown> }).__walletMock = {
        connect: (addr: string) => {
          connectedAccounts = [addr];
          emit('accountsChanged', connectedAccounts);
        },
        disconnect: () => {
          connectedAccounts = [];
          // Clear the seed too, or `accountsNow()` re-authorizes the account on
          // the very next `eth_accounts` and the disconnect silently undoes
          // itself. The fixture's addInitScript only affects the NEXT document.
          (window as unknown as { __walletMockConnected?: string }).__walletMockConnected = undefined;
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
/**
 * The app's READ path never touches the wallet.
 *
 * wagmi answers useBalance / useReadContract through the `transports` in
 * src/lib/wagmi.ts — three public mainnet RPCs — and only sends WRITES through
 * the connector. So pointing the wallet at a fork moves the transactions and
 * leaves every balance, allowance and quote reading real mainnet, where the
 * test account holds nothing. `anvil_setBalance` funds an account the app then
 * never asks about, and every CTA stays disabled behind "insufficient balance".
 *
 * Redirecting those hosts at the browser is the whole fix, and it keeps the fix
 * in the test: no VITE_ override to add to src/, nothing that can leak into a
 * production build. Unset ANVIL_RPC_URL and not a single route is installed.
 */
const APP_RPC_HOSTS = [
  'https://ethereum-rpc.publicnode.com/**',
  'https://eth.drpc.org/**',
  'https://eth.merkle.io/**',
];

async function routeAppReadsToAnvil(page: Page, rpcUrl: string): Promise<void> {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
  };
  for (const pattern of APP_RPC_HOSTS) {
    await page.route(pattern, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors, body: '' });
        return;
      }
      try {
        const upstream = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.postData() ?? '',
        });
        await route.fulfill({
          status: upstream.status,
          headers: { ...cors, 'content-type': 'application/json' },
          body: await upstream.text(),
        });
      } catch (e) {
        // Fail the request rather than letting it fall through to real
        // mainnet — a silent fallback would make the fork invisible and the
        // assertions meaningless again.
        await route.abort('failed');
        throw e;
      }
    });
  }
}

async function installAnvilBridge(page: Page, rpcUrl: string): Promise<void> {
  let nextId = 1;

  await routeAppReadsToAnvil(page, rpcUrl);

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

  // ANVIL_BACKEND step 5 — ERC-20 balance. ETH alone is not enough.
  //
  // Four money-path specs failed on a live fork with their own named messages —
  // "stake CTA never enabled — the fork account holds no TOWELI", and the same for
  // liquidity's paired side. A mainnet fork inherits mainnet state, and the test
  // account holds no TOWELI there, so every CTA that gates on a token balance stays
  // disabled and the leg times out. That is a MISSING FIXTURE, not a product defect,
  // and it is what kept these specs skipped for months.
  await seedErc20Balance(rpc, TOWELI, DEFAULT_ACCOUNT, 1_000_000n * 10n ** 18n);

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
