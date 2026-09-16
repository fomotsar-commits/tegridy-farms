import { describe, it, expect, beforeEach, vi } from "vitest";

// ═══ REGRESSION: a criteria offer could not be filled, and a multi-item bid
//     priced itself 9x too high ═══
//
// Two live-measured defects on the seller's side of the book, both on
// api-offers.js.
//
// 1. `acceptOffer` POSTed `offers/fulfillment_data` WITHOUT a `consideration`
//    field. A criteria offer (ERC721_WITH_CRITERIA, itemType 4 — a collection or
//    trait bid) names a merkle root rather than a token, so that POST could not
//    tell which token the seller was handing over and rejected the request.
//    Measured 2026-09-09 against the live collection, same order hash and same
//    fulfiller, the ONLY difference being the field: 400 without it, 200 with it
//    (returning matchAdvancedOrders calldata). 10 of 12 sampled tokens carried a
//    criteria order, so this was the majority case on the accept screen.
//
// 2. The token id itself had no honest source. `fetchBestOffer` did not return
//    one at all, and the obvious-looking source — the consideration item's
//    `identifierOrCriteria` — is the MERKLE ROOT on a criteria offer, not a
//    token id.
//
// 3. `normalizeOffer` divides a whole-order bid by its quantity to get the unit
//    price. Re-measured 2026-09-09, 4 of 50 rows on `offers/collection/{slug}/all`
//    are multi-item (3 at quantity 5, 1 at quantity 9), so that divide is
//    correcting live rows rather than guarding a hypothetical.
//
// WHAT IS PINNED IS THE WIRING, NEVER A LITERAL:
//   - that the fulfillment POST carries the token being sold (not that some
//     particular key spelling appears in some particular place),
//   - that the token id is the one QUERIED and not the merkle root parsed out of
//     the order — asserted against a root that is deliberately a valid-looking
//     integer, so reading the wrong field yields a wrong ANSWER, not a crash,
//   - that a quantity-N bid reports the per-token price. Every quantity fixture
//     here is > 1: at quantity 1 the divide is the identity and the test would
//     pass against the unfixed code.

const SEAPORT_16 = "0x0000000000000068f116a894984e2db1123eb395";
const SELLER = "0x4aa4fac237b07e12d90b707ed2e543cd00b3a683";
const NFT = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// The real merkle root from the live trait offer measured on 2026-09-09. It is a
// plain decimal integer, which is exactly why mistaking it for a token id is
// silent: nothing throws, the fill just names an asset that does not exist.
const MERKLE_ROOT =
  "19572567979756331467177789874135933887466987296180735004828955672482482597473";

const h = vi.hoisted(() => ({
  account: null,
  signerAddress: "",
  chainId: 1n,
  openseaGet: null,
  openseaPost: null,
  sendTransaction: null,
  isApprovedForAll: null,
}));

vi.mock("../lib/wagmi", () => ({ config: { __test: true } }));
vi.mock("wagmi/actions", () => ({ getAccount: () => h.account }));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal();
  class MockBrowserProvider {
    async getNetwork() { return { chainId: h.chainId }; }
    async getSigner() {
      return {
        getAddress: async () => h.signerAddress,
        sendTransaction: (...a) => h.sendTransaction(...a),
      };
    }
    async getBalance() { return 10n ** 20n; }
  }
  // The NFT approval read runs after the fulfillment POST; returning "already
  // approved" keeps the flow on its happy path without a second tx.
  class MockContract {
    isApprovedForAll(...a) { return h.isApprovedForAll(...a); }
  }
  return {
    ...actual,
    ethers: { ...actual.ethers, BrowserProvider: MockBrowserProvider, Contract: MockContract },
  };
});

vi.mock("./lib/proxy", () => ({
  alchemyGet: vi.fn(),
  alchemyPost: vi.fn(),
  openseaGet: (...a) => h.openseaGet(...a),
  openseaPost: (...a) => h.openseaPost(...a),
  ApiError: class ApiError extends Error {},
}));

vi.mock("./lib/seaportCancel", () => ({
  cancelSeaportOrder: vi.fn(),
  buildOrderComponents: vi.fn(),
}));

// A well-formed fulfillment response. `fulfillOrder` is a real allowlisted
// entrypoint and the argument shape is simplified — these tests care about what
// we SEND, not about calldata layout.
const FULFILLMENT_OK = {
  fulfillment_data: {
    transaction: {
      to: SEAPORT_16,
      value: "0",
      function: "fulfillOrder(uint256 hint)",
      input_data: { hint: 1 },
    },
  },
};

/** The live `offers/collection/{slug}/nfts/{id}/best` shape for a TRAIT offer:
 *  the NFT consideration item is itemType 4 and carries the merkle root. */
function bestCriteriaOfferResponse() {
  return {
    order_hash: "0x3e99df6be75d4fdb27e6f8cc6648e1f450a40ea9f4a7b3935130bb2b69557484",
    protocol_address: SEAPORT_16,
    price: { currency: "WETH", decimals: 18, value: "127000000000000000" },
    protocol_data: {
      parameters: {
        offerer: "0x7186256cdfa758271128ef50ff8732b4fe88ca06",
        endTime: String(Math.floor(Date.now() / 1000) + 3600),
        offer: [{ itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: "127000000000000000" }],
        consideration: [
          { itemType: 4, token: NFT, identifierOrCriteria: MERKLE_ROOT, startAmount: "1", endAmount: "1" },
        ],
      },
    },
  };
}

let apiOffers;

beforeEach(async () => {
  vi.resetModules();
  h.account = { address: SELLER, connector: { getProvider: async () => ({ request: vi.fn() }) } };
  h.signerAddress = SELLER;
  h.chainId = 1n;
  h.openseaGet = vi.fn(async () => bestCriteriaOfferResponse());
  h.openseaPost = vi.fn(async () => FULFILLMENT_OK);
  h.sendTransaction = vi.fn(async () => ({ hash: "0xfilled", wait: async () => ({ status: 1 }) }));
  h.isApprovedForAll = vi.fn(async () => true);
  apiOffers = await import("./api-offers");
});

describe("acceptOffer names the token that fills a criteria offer", () => {
  it("sends the token being sold to the fulfillment build, so a criteria bid can resolve", async () => {
    const TOKEN = "1234";
    const res = await apiOffers.acceptOffer({
      orderHash: "0xoffer",
      protocolAddress: SEAPORT_16,
      tokenContract: NFT,
      tokenId: TOKEN,
    });
    expect(res.success).toBe(true);

    const [path, body] = h.openseaPost.mock.calls[0];
    expect(path).toContain("fulfillment_data");

    // The invariant: the request identifies the exact asset being handed over.
    // Asserted by SEARCHING the body for the pair rather than by naming a key
    // path, so this survives a reshuffle of the request envelope and only reds
    // when the token genuinely stops being communicated.
    const sent = JSON.stringify(body);
    expect(sent).toContain(TOKEN);
    expect(sent.toLowerCase()).toContain(NFT.toLowerCase());

    // ...and it is the TOKEN, not the merkle root of the criteria set.
    expect(sent).not.toContain(MERKLE_ROOT);
  });

  it("still fills when the token is unknown, rather than sending a bogus id", async () => {
    // An offer with no token id must not invent one (least of all `undefined`
    // stringified into the request). Degrading to the old, criteria-less request
    // is correct for an exact-token order, which does not need the field.
    const res = await apiOffers.acceptOffer({
      orderHash: "0xoffer",
      protocolAddress: SEAPORT_16,
      tokenContract: NFT,
    });
    expect(res.success).toBe(true);
    const sent = JSON.stringify(h.openseaPost.mock.calls[0][1]);
    expect(sent).not.toContain("undefined");
    expect(sent).not.toContain("null");
  });
});

describe("the offer read carries an honest token id", () => {
  it("reports the token it was asked about, not the merkle root in the order", async () => {
    const best = await apiOffers.fetchBestOffer("1234");
    // The merkle root is a valid-looking integer, so the wrong source produces a
    // wrong answer instead of an error — this is the assertion that separates them.
    expect(best.tokenId).toBe("1234");
    expect(best.tokenId).not.toBe(MERKLE_ROOT);
  });

  it("hands acceptOffer a token id that survives the round trip", async () => {
    // The end-to-end wiring: what the read produces is what the fill sends. A
    // break at either end reds this, which is the point of pinning the pair.
    const best = await apiOffers.fetchBestOffer("7777");
    await apiOffers.acceptOffer({ ...best, tokenContract: NFT });
    const sent = JSON.stringify(h.openseaPost.mock.calls[0][1]);
    expect(sent).toContain("7777");
    expect(sent).not.toContain(MERKLE_ROOT);
  });
});

describe("a multi-item bid is priced per token", () => {
  /** An `offers/collection/{slug}/all` row: the WETH offer item holds
   *  quantity x unit price, and the criteria consideration item holds quantity. */
  function bulkBid({ unitWei, quantity, feeWeiTotal = "0" }) {
    const consideration = [
      {
        itemType: 4,
        token: NFT,
        identifierOrCriteria: MERKLE_ROOT,
        startAmount: String(quantity),
        endAmount: String(quantity),
      },
    ];
    if (feeWeiTotal !== "0") {
      consideration.push({ itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: feeWeiTotal, endAmount: feeWeiTotal });
    }
    return {
      order_hash: `0xbulk${quantity}`,
      status: "ACTIVE",
      protocol_address: SEAPORT_16,
      protocol_data: {
        parameters: {
          offerer: "0xbidder",
          endTime: String(Math.floor(Date.now() / 1000) + 3600),
          offer: [{
            itemType: 1,
            token: "0xweth",
            identifierOrCriteria: "0",
            startAmount: (BigInt(unitWei) * BigInt(quantity)).toString(),
          }],
          consideration,
        },
      },
    };
  }

  // Quantity 9 is the largest multi-item bid actually seen on the live route on
  // 2026-09-09. Nothing here uses quantity 1: that is the divide's identity, and
  // a quantity-1 fixture passes against the unfixed code.
  it("reports the per-token price for a 9-item bid, not the whole-order total", async () => {
    h.openseaGet = vi.fn(async () => ({ offers: [bulkBid({ unitWei: "100000000000000000", quantity: 9 })], next: null }));
    const [o] = await apiOffers.fetchMyOffers("0xbidder");
    // 0.9 WETH total across 9 tokens is a 0.1 WETH bid per token. Undivided it
    // reports 0.9 and sorts to the top of the seller's book.
    expect(o.price).toBeCloseTo(0.1, 9);
    expect(o.priceWei).toBe("100000000000000000");
  });

  it("divides the order's fees per token too, so net proceeds are not over-charged", async () => {
    h.openseaGet = vi.fn(async () => ({
      offers: [bulkBid({ unitWei: "100000000000000000", quantity: 5, feeWeiTotal: "25000000000000000" })],
      next: null,
    }));
    const [o] = await apiOffers.fetchMyOffers("0xbidder");
    // A 0.025 WETH fee across 5 tokens is 0.005 per token. Left whole, the net
    // preview subtracts a 5-item fee from a 1-item price.
    expect(o.feeWei).toBe("5000000000000000");
  });
});
