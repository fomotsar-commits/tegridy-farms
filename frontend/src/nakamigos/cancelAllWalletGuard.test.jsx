import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// ═══ MyListings "Cancel all" must not sign from the wrong wallet ═══
//
// `handleCancelAll` sends Seaport `incrementCounter()`. That single call
// invalidates EVERY order the CALLER has ever signed — listings, item bids,
// collection bids, on this marketplace and on every other one sharing this
// Seaport. There is no un-increment: the orders cannot be restored, only
// re-signed one by one, and any that the maker no longer has approvals or
// balance for are simply gone.
//
// Pre-fix the handler resolved a provider through the SYNCHRONOUS `getProvider()`
// and never compared the resulting signer to the connected account. So when the
// provider is decoupled from the connector — the exact failure the wallet-provider
// audit lane closed elsewhere (see walletProvider.test.js / walletContextProviderCache
// .test.jsx) — the user pays gas to destroy an unrelated identity's entire order
// book, their own listings stay live and fillable, and the UI runs
// setListings([]) as though it worked. Every neighbouring signing path had
// already been fixed: api-offers.cancelOrder:706-709, acceptOffer:766-769,
// createItemOffer:214-217. This call site, the only irreversible one, had not.
//
// THE INVARIANT: when the signing wallet is not the connected account, NOTHING is
// sent on-chain and the failure names the reason. Pinned on the observable
// effect (incrementCounter never called) rather than on the guard being present,
// because a guard that runs after the transaction would satisfy the latter.

const CONNECTED = "0x1111111111111111111111111111111111111111"; // wagmi says this
const OTHER_WALLET = "0x2222222222222222222222222222222222222222"; // provider signs as this

const h = vi.hoisted(() => ({
  account: null,
  signerAddress: "",
  incrementCounter: null,
  signMessage: null,
  cancelSeaportOrder: null,
}));

vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));

vi.mock("./contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: vi.fn() }),
}));

vi.mock("./lib/seaportCancel", () => ({
  cancelSeaportOrder: (...a) => h.cancelSeaportOrder(...a),
  buildOrderComponents: vi.fn(),
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    constructor(eip1193) { this.eip1193 = eip1193; }
    async getNetwork() { return { chainId: 1n }; }
    async getSigner() {
      return {
        getAddress: async () => h.signerAddress,
        signMessage: (...a) => h.signMessage(...a),
      };
    }
  }
  class MockContract {
    constructor(address, abi, signer) {
      this.target = address;
      this.signer = signer;
    }
    incrementCounter(...a) { return h.incrementCounter(...a); }
  }
  return {
    ...actual,
    ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract },
  };
});

const ORDER = {
  order_hash: "0xorder1",
  token_id: "1",
  price_eth: 1.5,
  end_time: new Date(Date.now() + 86_400_000).toISOString(),
  protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
  parameters: { offerer: CONNECTED },
  signature: "0xsig",
  created_at: new Date().toISOString(),
  is_bundle: false,
};

const cleanups = [];

/** window.ethereum present, so the PRE-FIX synchronous getProvider() finds a
 *  wallet. Without this the old code would bail on "Wallet not connected" and
 *  the guard tests would pass for entirely the wrong reason. */
function installInjectedWallet() {
  window.ethereum = { isMetaMask: true, request: vi.fn() };
  cleanups.push(() => { delete window.ethereum; });
}

let MyListings;
let CollectionProvider;
let addToast;

beforeEach(async () => {
  vi.resetModules();
  h.account = null;
  h.signerAddress = "";
  h.incrementCounter = vi.fn(async () => ({
    hash: "0xdead", wait: async () => ({ status: 1 }),
  }));
  h.signMessage = vi.fn(async () => "0xsig");
  h.cancelSeaportOrder = vi.fn(async () => ({
    hash: "0xdead", wait: async () => ({ status: 1 }),
  }));
  addToast = vi.fn();

  global.fetch = vi.fn(async (url, init) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ orders: [ORDER] }) };
  });

  installInjectedWallet();
  // Imported AFTER resetModules so the provider and the component close over the
  // same CollectionContext instance — a static import would give them two.
  ({ CollectionProvider } = await import("./contexts/CollectionContext"));
  ({ default: MyListings } = await import("./components/MyListings"));
});

afterEach(() => {
  cleanup();
  while (cleanups.length) cleanups.pop()();
  vi.clearAllMocks();
});

function connectAs(address) {
  h.account = {
    address,
    connector: { getProvider: async () => ({ __wallet: "connector", request: vi.fn() }) },
  };
}

async function renderListings() {
  render(
    <CollectionProvider slug="nakamigos">
      <MyListings wallet={CONNECTED} onConnect={() => {}} addToast={addToast} stats={{ floor: 1 }} />
    </CollectionProvider>,
  );
  // The Cancel All control only exists once a listing has loaded.
  return waitFor(() => screen.getByRole("button", { name: /cancel all/i }));
}

function toastText() {
  return addToast.mock.calls.map(([msg]) => String(msg)).join(" | ");
}

/**
 * Wait for the cancel flow to REACH A TERMINAL STATE.
 *
 * Do not replace this with `waitFor(() => expect(addToast).toHaveBeenCalled())`.
 * The pre-fix handler fires a "Cancelling all listings…" progress toast BEFORE
 * its `await import("ethers")`, so that weaker condition is satisfied one tick in
 * — while incrementCounter is still pending. Every "nothing was sent" assertion
 * then passes against the unguarded code, i.e. the test proves nothing. Waiting
 * for a NON-progress toast is what makes these assertions real.
 */
async function settle() {
  await waitFor(() => {
    expect(addToast).toHaveBeenCalled();
    const last = String(addToast.mock.calls.at(-1)[0]);
    expect(last).not.toMatch(/^cancelling/i);
  });
}

describe("cancel-all refuses to increment the counter from the wrong wallet", () => {
  it("sends NOTHING on-chain when the signer is not the connected account", async () => {
    connectAs(CONNECTED);
    h.signerAddress = OTHER_WALLET;

    const btn = await renderListings();
    fireEvent.click(btn);

    await settle();
    // THE INVARIANT — the irreversible call never happened.
    expect(h.incrementCounter).not.toHaveBeenCalled();
    // ...and neither did the backend sync that would have marked them cancelled.
    expect(h.signMessage).not.toHaveBeenCalled();
  });

  it("names both wallets so the user can act, rather than failing silently", async () => {
    connectAs(CONNECTED);
    h.signerAddress = OTHER_WALLET;

    const btn = await renderListings();
    fireEvent.click(btn);

    await settle();
    const shown = toastText();
    expect(shown).toContain(CONNECTED.slice(0, 6));
    expect(shown).toContain(OTHER_WALLET.slice(0, 6));
  });

  it("does not claim success by clearing the listings it did not cancel", async () => {
    connectAs(CONNECTED);
    h.signerAddress = OTHER_WALLET;

    const btn = await renderListings();
    fireEvent.click(btn);

    await settle();
    // Pre-fix the handler ran setListings([]) on the success path — the seller was
    // shown an empty page while their orders were still live and fillable.
    expect(screen.getByRole("button", { name: /cancel all/i })).toBeInTheDocument();
    expect(toastText()).not.toMatch(/all orders cancelled/i);
  });

  it("fails CLOSED when the connector lookup throws mid-session", async () => {
    // Expired WalletConnect session: connector.getProvider() rejects, so
    // getActiveWalletProvider degrades to the injected provider. api.js:1082
    // deliberately captures the wagmi address BEFORE that await, so the guard
    // still has a comparand here — this test pins that the degraded path stays
    // guarded end-to-end from this call site, not just inside api.js.
    h.account = {
      address: CONNECTED,
      connector: { getProvider: async () => { throw new Error("session expired"); } },
    };
    h.signerAddress = OTHER_WALLET;

    const btn = await renderListings();
    fireEvent.click(btn);

    await settle();
    expect(h.incrementCounter).not.toHaveBeenCalled();
  });

  it("fails CLOSED when wagmi reports NO account while the page still shows a maker", async () => {
    // The case the previous test does NOT cover, and the reason the comparand is
    // `connectedAddress || wallet` rather than `connectedAddress` alone: when
    // getAccount() returns nothing (mid-reconnect, or wagmi absent on this
    // surface), `connectedAddress` is null and assertSameWallet returns null for a
    // missing comparand — i.e. the guard degrades to a NO-OP and the irreversible
    // call goes out signed by whatever injected wallet happens to be installed.
    // The maker this page fetched its listings for is the fallback identity.
    h.account = null;
    h.signerAddress = OTHER_WALLET;

    const btn = await renderListings();
    fireEvent.click(btn);

    await settle();
    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(toastText()).toContain(OTHER_WALLET.slice(0, 6));
  });

  it("still lets the RIGHT wallet cancel everything — the guard must not over-block", async () => {
    // The other half of the pair. Without it, a handler that simply refused every
    // cancel-all would satisfy every assertion above.
    connectAs(CONNECTED);
    h.signerAddress = CONNECTED;

    const btn = await renderListings();
    fireEvent.click(btn);

    await waitFor(() => expect(h.incrementCounter).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastText()).toMatch(/all orders cancelled/i));
  });
});

describe("single-row cancel carries the same guard", () => {
  // Lower blast radius than incrementCounter — Seaport reverts a cancel from a
  // non-offerer — but it is the same defect: gas burned on a transaction that
  // cannot do what the button says, from an identity the user did not pick.
  it("does not send a cancel signed by a wallet that is not the connected account", async () => {
    connectAs(CONNECTED);
    h.signerAddress = OTHER_WALLET;

    await renderListings();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await settle();
    expect(h.cancelSeaportOrder).not.toHaveBeenCalled();
    expect(toastText()).toContain(OTHER_WALLET.slice(0, 6));
  });

  it("still cancels normally for the connected account", async () => {
    connectAs(CONNECTED);
    h.signerAddress = CONNECTED;

    await renderListings();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(h.cancelSeaportOrder).toHaveBeenCalledTimes(1));
  });
});
