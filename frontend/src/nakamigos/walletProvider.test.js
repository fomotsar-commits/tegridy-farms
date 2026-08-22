import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ═══ REGRESSION: pay-from-the-wrong-wallet ═══
//
// Pre-fix, `getProvider()` walked a FIXED rdns priority list
// ('io.metamask' first) that was completely independent of which connector
// wagmi actually connected. So with MetaMask installed and Rabby selected,
// the transaction was PAID BY MetaMask while the address sent to OpenSea as
// fulfiller/offerer/recipient was Rabby's. And every WalletConnect /
// Coinbase-SDK / Safe user — who injects nothing and announces no EIP-6963
// provider — got "MetaMask not found".
//
// The invariants pinned here (never a literal message string):
//   1. The provider comes from the ACTIVE wagmi connector.
//   2. A non-injected connector is usable (no "no wallet" bail-out).
//   3. When the signing wallet != the connected account, NOTHING is signed,
//      sent, or POSTed — the call fails with a distinct, non-generic error.
//   4. When they match, the flow proceeds unchanged (no over-blocking).

const CONNECTED = "0x1111111111111111111111111111111111111111"; // e.g. Rabby
const OTHER_WALLET = "0x2222222222222222222222222222222222222222"; // e.g. MetaMask

const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";

const h = vi.hoisted(() => ({
  // wagmi state
  account: null,
  // signer state
  signerAddress: "",
  chainId: 1n,
  sendTransaction: null,
  signTypedData: null,
  // network
  openseaPost: null,
  cancelSeaportOrder: null,
}));

vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    constructor(eip1193) {
      this.eip1193 = eip1193;
    }
    async getNetwork() {
      return { chainId: h.chainId };
    }
    async getSigner() {
      return {
        getAddress: async () => h.signerAddress,
        sendTransaction: (...a) => h.sendTransaction(...a),
        signTypedData: (...a) => h.signTypedData(...a),
      };
    }
    async getBalance() {
      return 10n ** 20n;
    }
  }
  return {
    ...actual,
    ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider },
  };
});

vi.mock("./lib/proxy", () => ({
  alchemyGet: vi.fn(),
  alchemyPost: vi.fn(),
  openseaGet: vi.fn(),
  openseaPost: (...a) => h.openseaPost(...a),
  ApiError: class ApiError extends Error {},
}));

vi.mock("./lib/seaportCancel", () => ({
  cancelSeaportOrder: (...a) => h.cancelSeaportOrder(...a),
  buildOrderComponents: vi.fn(),
}));

// A well-formed OpenSea fulfillment_data response. The function signature is a
// real allowlisted entrypoint name; the argument shape is simplified because
// this test only cares about WHICH wallet pays, not about calldata layout.
const FULFILLMENT_OK = {
  fulfillment_data: {
    transaction: {
      to: SEAPORT_15,
      value: "1000000000000000",
      function: "fulfillOrder(uint256 hint)",
      input_data: { hint: 1 },
    },
  },
};

// Cleanups are torn down in afterEach — NOT at the end of each test body — so a
// failing assertion cannot leak an EIP-6963 announcer into the next test and
// silently hand it an injected wallet it was supposed to be running without.
const cleanups = [];

/** window.ethereum + an EIP-6963 announcement for MetaMask — i.e. the wallet the
 *  pre-fix rdns walk would have picked, which is NOT the connected one. */
function installMetaMaskInjection(metaMaskProvider) {
  window.ethereum = metaMaskProvider;
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info: { rdns: "io.metamask" }, provider: metaMaskProvider },
      }),
    );
  };
  window.addEventListener("eip6963:requestProvider", announce);
  cleanups.push(() => {
    window.removeEventListener("eip6963:requestProvider", announce);
    delete window.ethereum;
  });
}

let api;
let apiOffers;

beforeEach(async () => {
  vi.resetModules();
  h.account = null;
  h.signerAddress = "";
  h.chainId = 1n;
  h.sendTransaction = vi.fn(async () => ({
    hash: "0xdeadbeef",
    wait: async () => ({ status: 1 }),
  }));
  h.signTypedData = vi.fn(async () => "0xsig");
  h.openseaPost = vi.fn(async () => FULFILLMENT_OK);
  h.cancelSeaportOrder = vi.fn(async () => ({
    hash: "0xcancel",
    wait: async () => ({ status: 1 }),
  }));
  delete window.ethereum;
  api = await import("./api");
  apiOffers = await import("./api-offers");
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe("getActiveWalletProvider", () => {
  it("returns the provider of the ACTIVE wagmi connector, not the rdns-priority injected one", async () => {
    const metaMask = { isMetaMask: true, request: vi.fn(), __tag: "metamask" };
    const rabby = { request: vi.fn(), __tag: "rabby" };
    installMetaMaskInjection(metaMask);
    h.account = { address: CONNECTED, connector: { getProvider: async () => rabby } };

    const res = await api.getActiveWalletProvider();

    expect(res.provider).toBe(rabby);
    expect(res.provider).not.toBe(metaMask);
    expect(res.address).toBe(CONNECTED);
  });

  it("resolves a NON-INJECTED connector (WalletConnect / Coinbase SDK / Safe) with nothing on window", async () => {
    const wcProvider = { request: vi.fn(), __tag: "walletconnect" };
    h.account = { address: CONNECTED, connector: { getProvider: async () => wcProvider } };
    expect(window.ethereum).toBeUndefined();

    const res = await api.getActiveWalletProvider();

    expect(res.provider).toBe(wcProvider);
  });
});

describe("fulfillSeaportOrder — wallet binding", () => {
  it("refuses to buy when the signing wallet is not the connected account", async () => {
    installMetaMaskInjection({ isMetaMask: true, request: vi.fn() });
    h.account = {
      address: CONNECTED,
      connector: { getProvider: async () => ({ request: vi.fn() }) },
    };
    h.signerAddress = OTHER_WALLET; // wallet extension is on a different account

    const res = await api.fulfillSeaportOrder(
      { orderHash: "0xabc", protocolAddress: SEAPORT_15 },
      { buyerAddress: CONNECTED },
    );

    // INVARIANT: nothing is paid for, and nothing is even quoted for.
    expect(res.success).toBeUndefined();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.openseaPost).not.toHaveBeenCalled();
    // INVARIANT: a distinct, non-generic error the UI can act on — it must name
    // both wallets so the user knows what to switch.
    expect(res.error).toBe("wallet-mismatch");
    expect(res.message).toContain(CONNECTED.slice(0, 6));
    expect(res.message).toContain(OTHER_WALLET.slice(0, 6));
  });

  it("buys normally when the signing wallet IS the connected account", async () => {
    // Injected wallet AND connector agree — the pre-fix arrangement that
    // already worked. Pins that the new guard does not over-block.
    const wallet = { isMetaMask: true, request: vi.fn() };
    installMetaMaskInjection(wallet);
    h.account = { address: CONNECTED, connector: { getProvider: async () => wallet } };
    h.signerAddress = CONNECTED;

    const res = await api.fulfillSeaportOrder(
      { orderHash: "0xabc", protocolAddress: SEAPORT_15 },
      { buyerAddress: CONNECTED },
    );

    expect(res.success).toBe(true);
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    // The fulfiller sent to OpenSea is the wallet that actually pays.
    expect(h.openseaPost.mock.calls[0][1].fulfiller.address).toBe(CONNECTED);
  });

  it("does not report 'no wallet' for a non-injected connector", async () => {
    h.account = {
      address: CONNECTED,
      connector: { getProvider: async () => ({ request: vi.fn() }) },
    };
    h.signerAddress = CONNECTED;
    expect(window.ethereum).toBeUndefined();

    const res = await api.fulfillSeaportOrder({ orderHash: "0xabc" }, {});

    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
  });
});

describe("wallet-mismatch message survives the toast pipeline", () => {
  // ADVERSARIAL REVIEW 2026-08-06: every buy-path caller renders the message
  // through `getFriendlyError`, which collapses anything over 120 chars to a
  // generic "Transaction failed — please try again". A guard the user cannot
  // act on just looks like a broken app and gets retried forever.
  // INVARIANT: the string the user actually SEES still names both wallets.
  it("still names both wallets after getFriendlyError", async () => {
    const { getFriendlyError } = await import("./lib/errorMessages");
    const err = api.assertSameWallet(OTHER_WALLET, CONNECTED);

    const shown = getFriendlyError(err.message);

    expect(shown).toContain(CONNECTED.slice(0, 6));
    expect(shown).toContain(OTHER_WALLET.slice(0, 6));
  });
});

describe("api-offers — wallet binding", () => {
  it("cancelOrder refuses to sign from a wallet other than the connected account", async () => {
    installMetaMaskInjection({ isMetaMask: true, request: vi.fn() });
    h.account = {
      address: CONNECTED,
      connector: { getProvider: async () => ({ request: vi.fn() }) },
    };
    h.signerAddress = OTHER_WALLET;

    const res = await apiOffers.cancelOrder({
      rawOrder: { protocol_data: { parameters: { offerer: CONNECTED } } },
    });

    expect(res.success).toBeUndefined();
    expect(res.error).toBe("wallet-mismatch");
    expect(h.cancelSeaportOrder).not.toHaveBeenCalled();
  });

  it("cancelOrder proceeds when the signing wallet is the connected account", async () => {
    const wallet = { isMetaMask: true, request: vi.fn() };
    installMetaMaskInjection(wallet);
    h.account = { address: CONNECTED, connector: { getProvider: async () => wallet } };
    h.signerAddress = CONNECTED;

    const res = await apiOffers.cancelOrder({
      rawOrder: { protocol_data: { parameters: { offerer: CONNECTED } } },
    });

    expect(res.success).toBe(true);
    expect(h.cancelSeaportOrder).toHaveBeenCalledTimes(1);
  });

  // ADVERSARIAL REVIEW 2026-08-06: the connector lookup is wrapped in a broad
  // `catch`, and api-offers has no `opts.buyerAddress` fallback to lean on. If
  // the lookup degrades (expired WalletConnect session -> getProvider() throws,
  // or a connector that hands back nothing) the wagmi account must NOT be
  // thrown away: dropping it turns assertSameWallet into a no-op and silently
  // restores the exact pay-from-the-wrong-wallet bug this lane fixed.
  // INVARIANT: a degraded connector lookup must fail CLOSED, never open.
  it("still blocks a wrong-wallet cancel when the connector lookup THROWS", async () => {
    installMetaMaskInjection({ isMetaMask: true, request: vi.fn() });
    h.account = {
      address: CONNECTED,
      connector: {
        getProvider: async () => {
          throw new Error("session expired");
        },
      },
    };
    h.signerAddress = OTHER_WALLET; // the injected fallback is a different wallet

    const res = await apiOffers.cancelOrder({
      rawOrder: { protocol_data: { parameters: { offerer: CONNECTED } } },
    });

    expect(res.success).toBeUndefined();
    expect(res.error).toBe("wallet-mismatch");
    expect(h.cancelSeaportOrder).not.toHaveBeenCalled();
  });

  it("still blocks a wrong-wallet cancel when the connector returns no provider", async () => {
    installMetaMaskInjection({ isMetaMask: true, request: vi.fn() });
    h.account = { address: CONNECTED, connector: { getProvider: async () => null } };
    h.signerAddress = OTHER_WALLET;

    const res = await apiOffers.cancelOrder({
      rawOrder: { protocol_data: { parameters: { offerer: CONNECTED } } },
    });

    expect(res.success).toBeUndefined();
    expect(res.error).toBe("wallet-mismatch");
    expect(h.cancelSeaportOrder).not.toHaveBeenCalled();
  });

  it("acceptOffer refuses to sign/approve from a wallet other than the connected account", async () => {
    installMetaMaskInjection({ isMetaMask: true, request: vi.fn() });
    h.account = {
      address: CONNECTED,
      connector: { getProvider: async () => ({ request: vi.fn() }) },
    };
    h.signerAddress = OTHER_WALLET;

    const res = await apiOffers.acceptOffer({ orderHash: "0xoffer" });

    expect(res.success).toBeUndefined();
    expect(res.error).toBe("wallet-mismatch");
    // No setApprovalForAll and no fulfillment quote were attempted.
    expect(h.openseaPost).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});
