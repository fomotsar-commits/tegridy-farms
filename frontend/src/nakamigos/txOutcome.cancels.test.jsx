// The four on-chain cancels that live in components, against every way ethers'
// wait() can end. The sibling of txOutcome.sites.test.js: same table, but these
// sites toast for themselves instead of returning a result, so what is pinned is
// what the seller is TOLD and whether the row is still on screen.
//
// A cancel that was sped up went through: the row goes and the backend hears.
// A cancel nobody could confirm is not "failed", and its row stays.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { makeError } from "ethers";
// Static imports: the first load of these components is slower than a test's
// timeout when the whole suite runs, and it belongs to collection, not to a test.
import { CollectionProvider } from "./contexts/CollectionContext";
import MyListings from "./components/MyListings";
import OrderBookPanel from "./components/OrderBookPanel";
import BidManager from "./components/BidManager";

const WALLET = "0x1111111111111111111111111111111111111111";
const SENT = "0x" + "11".repeat(32);
const TOOK = "0x" + "22".repeat(32);
const NFT = "0xd774557b647330c91bf44cfeab205095f7e6c367";

const h = vi.hoisted(() => ({ account: null, wait: null, signMessage: null, openseaGet: null }));

const sentTx = () => Promise.resolve({ hash: SENT, wait: () => h.wait() });

vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));
vi.mock("./contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: vi.fn() }),
}));
vi.mock("./hooks/useOffers", () => ({
  useCollectionOffers: () => ({ data: [], isLoading: false, refetch: () => {} }),
  useTraitOffers: () => ({ data: {}, isLoading: false, refetch: () => {} }),
}));
vi.mock("./lib/proxy", () => ({
  alchemyGet: vi.fn(async () => ({})),
  alchemyPost: vi.fn(async () => ({})),
  openseaGet: (...a) => h.openseaGet(...a),
  openseaPost: vi.fn(async () => ({})),
  ApiError: class ApiError extends Error {},
}));
vi.mock("./lib/seaportCancel", () => ({
  cancelSeaportOrder: () => sentTx(),
  buildOrderComponents: vi.fn(),
}));
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    async getNetwork() { return { chainId: 1n }; }
    async getSigner() {
      return { getAddress: async () => WALLET, signMessage: (...a) => h.signMessage(...a) };
    }
  }
  class MockContract {
    incrementCounter() { return sentTx(); }
  }
  return { ...actual, ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract } };
});

const replacedError = (reason, status) => makeError("transaction was replaced", "TRANSACTION_REPLACED", {
  cancelled: reason !== "repriced", reason, replacement: {}, hash: TOOK, receipt: { status, hash: TOOK },
});
const WAITS = {
  mined: () => Promise.resolve({ status: 1, hash: SENT }),
  revert: () => Promise.reject(makeError("transaction execution reverted", "CALL_EXCEPTION", {
    action: "sendTransaction", data: null, reason: null, invocation: null, revert: null,
    transaction: { to: null, from: WALLET, data: "" }, receipt: { status: 0, hash: SENT },
  })),
  unread: () => Promise.reject(makeError("could not coalesce error", "UNKNOWN_ERROR", {
    error: { code: -32005, message: "limit exceeded" },
  })),
  cancel: () => Promise.reject(replacedError("cancelled", 1)),
  speedUp: () => Promise.reject(replacedError("repriced", 1)),
  speedUpReverted: () => Promise.reject(replacedError("repriced", 0)),
};

const NATIVE_ORDER = {
  order_hash: "0xorder1",
  token_id: "1",
  price_eth: 1.5,
  maker: WALLET,
  end_time: new Date(Date.now() + 86_400_000).toISOString(),
  protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
  parameters: { offerer: WALLET },
  signature: "0xsig",
  created_at: new Date().toISOString(),
  is_bundle: false,
  status: "active",
};
const BID = {
  order_hash: "0xbid1",
  protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
  cancelled: false,
  finalized: false,
  created_date: new Date().toISOString(),
  protocol_data: {
    parameters: {
      offerer: WALLET,
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      offer: [{ itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: "100000000000000000" }],
      consideration: [{ itemType: 2, token: NFT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }],
    },
  },
};

let addToast;
let posts;

beforeEach(() => {
  h.wait = WAITS.mined;
  h.signMessage = vi.fn(async () => "0xsig");
  h.openseaGet = vi.fn(async () => ({ offers: [BID] }));
  addToast = vi.fn();
  posts = [];
  global.fetch = vi.fn(async (_url, init) => {
    if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ orders: [NATIVE_ORDER] }) };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = { isMetaMask: true, request: vi.fn() };
  window.ethereum = provider;
  h.account = { address: WALLET, connector: { getProvider: async () => provider } };
});

afterEach(() => {
  cleanup();
  delete window.ethereum;
  vi.restoreAllMocks();
});

const inCollection = (node) => render(<CollectionProvider slug="nakamigos">{node}</CollectionProvider>);
// "Cancel" exactly: MyListings also has a "Cancel All".
const rowCancel = () => screen.queryByRole("button", { name: /^cancel$/i });

const SURFACES = [
  {
    name: "MyListings, cancel one listing",
    backend: "cancel",
    open: async () => {
      inCollection(<MyListings wallet={WALLET} onConnect={() => {}} addToast={addToast} stats={{ floor: 1 }} />);
      return waitFor(() => { const b = rowCancel(); expect(b).toBeTruthy(); return b; });
    },
    stillListed: () => !!rowCancel(),
  },
  {
    name: "MyListings, cancel all",
    backend: "cancel-all",
    open: async () => {
      inCollection(<MyListings wallet={WALLET} onConnect={() => {}} addToast={addToast} stats={{ floor: 1 }} />);
      return waitFor(() => screen.getByRole("button", { name: /cancel all/i }));
    },
    stillListed: () => !!rowCancel(),
  },
  {
    name: "OrderBookPanel, cancel my listing",
    backend: "cancel",
    open: async () => {
      inCollection(<OrderBookPanel wallet={WALLET} onConnect={() => {}} addToast={addToast} floorPrice={1} />);
      return waitFor(() => { const b = rowCancel(); expect(b).toBeTruthy(); return b; });
    },
    stillListed: () => !!rowCancel(),
  },
  {
    name: "BidManager, cancel my bid",
    backend: null, // OpenSea's book: there is no backend row of ours to update
    open: async () => {
      inCollection(<BidManager wallet={WALLET} onConnect={() => {}} addToast={addToast} onPick={() => {}} tokens={[]} />);
      return waitFor(() => { const b = rowCancel(); expect(b).toBeTruthy(); return b; });
    },
    stillListed: () => !!rowCancel(),
  },
];

/** Click, then wait for a toast that is not the "Cancelling..." progress one. */
async function cancelAndSettle(surface, how) {
  h.wait = WAITS[how];
  const button = await surface.open();
  addToast.mockClear();
  fireEvent.click(button);
  await waitFor(() => {
    expect(addToast).toHaveBeenCalled();
    expect(String(addToast.mock.calls.at(-1)[0])).not.toMatch(/^cancelling/i);
  });
  const [message, type, opts] = addToast.mock.calls.at(-1);
  return { message: String(message), type, opts };
}

const backendHeard = (surface) => posts.some((body) => body.action === surface.backend);

describe.each(SURFACES)("$name", (surface) => {
  it("control: a cancel that mines is reported, and the row goes", async () => {
    const toast = await cancelAndSettle(surface, "mined");
    expect(toast.type).toBe("success");
    await waitFor(() => expect(surface.stillListed()).toBe(false));
    if (surface.backend) expect(backendHeard(surface)).toBe(true);
  });

  it("a sped-up cancel went through: same report, the row goes, the backend hears", async () => {
    const toast = await cancelAndSettle(surface, "speedUp");
    expect(toast.type).toBe("success");
    await waitFor(() => expect(surface.stillListed()).toBe(false));
    if (surface.backend) expect(backendHeard(surface)).toBe(true);
  });

  it("an unread receipt is a warning that we can't tell, never 'failed', and the row stays", async () => {
    const toast = await cancelAndSettle(surface, "unread");
    expect(toast.type).toBe("warning");
    expect(toast.message).toMatch(/couldn't confirm/i);
    expect(toast.message).toMatch(/before you send it again/i);
    expect(toast.message).not.toMatch(/fail/i);
    expect(toast.opts?.link?.href).toBe(`https://etherscan.io/tx/${SENT}`);
    expect(surface.stillListed()).toBe(true);
    expect(posts).toEqual([]);
  });

  it("a cancel the wallet cancelled did not happen, and the row stays", async () => {
    const toast = await cancelAndSettle(surface, "cancel");
    expect(toast.type).toBe("warning");
    expect(toast.message).toMatch(/did not happen/i);
    expect(toast.opts?.link?.href).toBe(`https://etherscan.io/tx/${TOOK}`);
    expect(surface.stillListed()).toBe(true);
    expect(posts).toEqual([]);
  });

  it.each(["revert", "speedUpReverted"])("a %s says the cancel reverted, and the row stays", async (how) => {
    const toast = await cancelAndSettle(surface, how);
    expect(toast.type).toBe("error");
    expect(toast.message).toMatch(/reverted/i);
    expect(surface.stillListed()).toBe(true);
    expect(posts).toEqual([]);
  });
});
