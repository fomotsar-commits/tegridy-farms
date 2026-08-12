import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

// ═══ REGRESSION: the SYNCHRONOUS getProvider() must follow the wagmi connector ═══
//
// `getActiveWalletProvider()` is async. But ~20 call sites cannot await a
// connector and resolve their wallet through the SYNCHRONOUS `getProvider()`:
//   lib/weth.js (wrap/unwrap/approve/allowance), lib/orderbook.js :117/:314/:533,
//   lib/trades.js, MyListings.jsx cancel, BidManager.jsx, ShoppingCart,
//   SweepCalculator.
// Pre-fix, every one of those fell through to a FIXED rdns priority walk
// (['io.metamask', 'com.coinbase.wallet', ...]) that is completely independent
// of which connector wagmi actually connected — so a user on Rabby could have a
// WETH wrap paid by MetaMask.
//
// The invariant pinned here is USER-VISIBLE, not implementational. It is
// deliberately NOT "getActiveWalletProvider was called" — a fix that calls it
// and then fails to prime the cache would still satisfy that, and every one of
// those 20 call sites would still be on the wrong wallet. Instead:
//
//   After <WalletProvider> renders with a connected connector, the SYNCHRONOUS
//   getProvider() hands back THAT CONNECTOR'S provider.
//
// The test rig makes the pre-fix answer a *different object*: window.ethereum
// and the EIP-6963 announcement both present MetaMask (rdns 'io.metamask' —
// first in the priority walk), while the connector hands back Rabby. So a
// regression to the rdns walk returns the MetaMask sentinel and fails loudly
// with the wallet tag in the diff, rather than passing by coincidence.
//
// Also covered: switching connectors re-points the cache, and disconnecting
// clears it (a disconnect must not keep serving the old wallet).
//
// NOTE ON `src/test-utils/wagmi-mocks.ts`: that shared helper cannot drive this
// test. Its `useAccount` exposes no `connector` at all, and `setAccount`
// couples `address`/`isConnected` into one blob with `isDisconnected` derived
// from `isConnected` — there is no way to vary the CONNECTOR independently of
// the account, which is the single variable this regression turns on. It also
// stubs none of `useConnect`/`useDisconnect`/`useSwitchChain`, all of which
// WalletProvider calls. So this file follows the established pattern from its
// sibling `walletProvider.test.js` instead: `vi.hoisted` state + local
// `vi.mock`s for `wagmi`, `wagmi/actions` and `../lib/wagmi`.

const CONNECTED = "0x1111111111111111111111111111111111111111";

const h = vi.hoisted(() => ({
  // Single source of truth for the connected wallet: BOTH the `useAccount()`
  // hook WalletProvider renders from and the `getAccount()` that api.js reads
  // are served from this one object, exactly as wagmi does at runtime.
  account: { address: undefined, isConnected: false, connector: undefined, chain: { id: 1 } },
}));

vi.mock("wagmi", () => ({
  useAccount: () => h.account,
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false, error: null }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));
vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}));

/** Distinct sentinels so a wrong answer names the wrong wallet in the diff. */
const makeProvider = (tag) => ({ __wallet: tag, request: vi.fn() });

const cleanups = [];

/**
 * Install MetaMask as `window.ethereum` AND as the EIP-6963 announcement for
 * rdns 'io.metamask' — i.e. the exact provider the pre-fix priority walk picks.
 * It is deliberately NOT the connected wallet in these tests.
 */
function installMetaMaskInjection(metaMask) {
  window.ethereum = metaMask;
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info: { rdns: "io.metamask" }, provider: metaMask },
      }),
    );
  };
  window.addEventListener("eip6963:requestProvider", announce);
  // Torn down in afterEach — NOT inline — so a failed assertion cannot leak an
  // announcer into the next test.
  cleanups.push(() => {
    window.removeEventListener("eip6963:requestProvider", announce);
    delete window.ethereum;
  });
}

function connectAs(address, provider) {
  h.account = {
    address,
    isConnected: true,
    chain: { id: 1 },
    connector: { name: provider.__wallet, getProvider: async () => provider },
  };
}

function disconnect() {
  h.account = { address: undefined, isConnected: false, connector: undefined, chain: undefined };
}

let api;
let WalletProvider;

beforeEach(async () => {
  vi.resetModules();
  disconnect();
  delete window.ethereum;
  // WalletContext is imported first so that the `../api` instance it closes
  // over is the SAME module instance whose `getProvider()` we then assert on —
  // the module-level cache is the thing under test.
  ({ WalletProvider } = await import("./contexts/WalletContext"));
  api = await import("./api");
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe("WalletProvider primes the synchronous provider cache", () => {
  it("getProvider() resolves to the ACTIVE connector's provider, not the rdns-priority injected one", async () => {
    const metaMask = makeProvider("metamask");
    const rabby = makeProvider("rabby");
    installMetaMaskInjection(metaMask);
    connectAs(CONNECTED, rabby);

    render(<WalletProvider>{null}</WalletProvider>);

    // INVARIANT: the wallet the ~20 sync call sites get IS the connected one.
    await waitFor(() => expect(api.getProvider()?.__wallet).toBe("rabby"));
    expect(api.getProvider()).toBe(rabby);
    expect(api.getProvider()).not.toBe(metaMask);
  });

  it("serves a NON-INJECTED connector (WalletConnect / Coinbase SDK / Safe) with nothing on window", async () => {
    // Pre-fix these users got `null` from the sync walk — surfaced as a bogus
    // "MetaMask not found" on every WETH wrap and native-orderbook action.
    const wc = makeProvider("walletconnect");
    connectAs(CONNECTED, wc);
    expect(window.ethereum).toBeUndefined();

    render(<WalletProvider>{null}</WalletProvider>);

    await waitFor(() => expect(api.getProvider()).toBe(wc));
  });

  it("re-points the cache when the user switches connectors", async () => {
    const metaMask = makeProvider("metamask");
    const rabby = makeProvider("rabby");
    const wc = makeProvider("walletconnect");
    installMetaMaskInjection(metaMask);
    connectAs(CONNECTED, rabby);

    const { rerender } = render(<WalletProvider>{null}</WalletProvider>);
    await waitFor(() => expect(api.getProvider()?.__wallet).toBe("rabby"));

    // User switches wallets in the app.
    connectAs(CONNECTED, wc);
    rerender(<WalletProvider>{null}</WalletProvider>);

    // INVARIANT: the sync call sites follow the switch — they must not keep
    // paying from the previously connected wallet.
    await waitFor(() => expect(api.getProvider()?.__wallet).toBe("walletconnect"));
    expect(api.getProvider()).toBe(wc);
  });

  it("clears the cache on disconnect instead of serving the old wallet", async () => {
    const metaMask = makeProvider("metamask");
    const rabby = makeProvider("rabby");
    installMetaMaskInjection(metaMask);
    connectAs(CONNECTED, rabby);

    const { rerender } = render(<WalletProvider>{null}</WalletProvider>);
    await waitFor(() => expect(api.getProvider()?.__wallet).toBe("rabby"));

    disconnect();
    rerender(<WalletProvider>{null}</WalletProvider>);

    // INVARIANT: a disconnected app never hands a stale wallet to a sync call
    // site. Falling back to injected discovery is fine; serving Rabby is not.
    await waitFor(() => expect(api.getProvider()).not.toBe(rabby));
    expect(api.getProvider()?.__wallet).not.toBe("rabby");
  });
});
