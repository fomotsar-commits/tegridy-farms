// A Bojungle or a Seed's panel trades it on the venue, on Base: the book's
// listing (buy it, or cancel your own), the best offer (accept it), and the
// forms to list it here and to bid. Each press goes to the money sink with
// this collection's contract and this token, and the copy says how the money
// moves. Collections that do not trade here get none of it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { COLLECTIONS } from "./constants";

const m = vi.hoisted(() => ({
  orders: [],
  best: null,
  createNativeListing: vi.fn(),
  fulfillNativeOrder: vi.fn(),
  cancelNativeListing: vi.fn(),
  createItemOffer: vi.fn(),
  acceptOffer: vi.fn(),
  switched: [],
}));

vi.mock("./lib/orderbook", () => ({
  fetchNativeListings: vi.fn(async () => ({ orders: m.orders, count: m.orders.length })),
  createNativeListing: (...a) => m.createNativeListing(...a),
  fulfillNativeOrder: (...a) => m.fulfillNativeOrder(...a),
  cancelNativeListing: (...a) => m.cancelNativeListing(...a),
}));
vi.mock("./api-offers", () => ({
  fetchTokenOfferBook: vi.fn(async () => ({ offers: m.best ? [m.best] : [], bestOffer: m.best, unavailable: false })),
  createItemOffer: (...a) => m.createItemOffer(...a),
  acceptOffer: (...a) => m.acceptOffer(...a),
}));
vi.mock("./lib/walletSwitch", () => ({ askWalletToSwitch: (id) => { m.switched.push(id); } }));

const WALLET = "0x" + "a".repeat(40);
const OTHER = "0x" + "c".repeat(40);
const item = { id: 7, name: "Bojungle #7", image: null };

async function renderPanel(collection, { wallet = WALLET } = {}) {
  const { default: TradeHereBase } = await import("./components/external/TradeHereBase");
  const addToast = vi.fn();
  render(<TradeHereBase collection={collection} item={item} wallet={wallet} onConnect={vi.fn()} addToast={addToast} />);
  return { addToast };
}

beforeEach(() => {
  m.orders = [];
  m.best = null;
  m.switched = [];
  for (const k of ["createNativeListing", "fulfillNativeOrder", "cancelNativeListing", "createItemOffer", "acceptOffer"]) {
    m[k] = vi.fn(async () => ({ success: true, hash: "0x" + "1".repeat(64) }));
  }
});

describe("the Base trade panel", () => {
  for (const key of ["bojungles", "memeticseeds"]) {
    const c = COLLECTIONS[key];

    it(`${c.name}: lists here with this contract, this token and the typed price`, async () => {
      await renderPanel(c);
      fireEvent.change(screen.getByPlaceholderText("Price in ETH"), { target: { value: "0.02" } });
      fireEvent.click(screen.getByRole("button", { name: "List" }));
      await waitFor(() => expect(m.createNativeListing).toHaveBeenCalledWith({ contract: c.contract, tokenId: "7", priceEth: "0.02" }));
    });

    it(`${c.name}: bids with this contract, this token and the typed price`, async () => {
      await renderPanel(c);
      fireEvent.change(screen.getByPlaceholderText("Offer in WETH"), { target: { value: "0.01" } });
      fireEvent.click(screen.getByRole("button", { name: "Make offer" }));
      await waitFor(() => expect(m.createItemOffer).toHaveBeenCalledWith({ tokenId: "7", priceEth: "0.01", contract: c.contract }));
    });
  }

  it("refuses a price that is not a plain ETH amount, without calling the sink", async () => {
    await renderPanel(COLLECTIONS.bojungles);
    fireEvent.change(screen.getByPlaceholderText("Price in ETH"), { target: { value: "1e3" } });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Enter a price in ETH/);
    expect(m.createNativeListing).not.toHaveBeenCalled();
  });

  it("shows the book's listing at its exact wei price and buys it", async () => {
    m.orders = [{ token_id: "7", status: "active", maker: OTHER, price_wei: "19990000000000000", order_hash: "0xrow" }];
    await renderPanel(COLLECTIONS.bojungles);
    const buy = await screen.findByRole("button", { name: "Buy for 0.01999 ETH" });
    fireEvent.click(buy);
    await waitFor(() => expect(m.fulfillNativeOrder).toHaveBeenCalledWith(m.orders[0]));
  });

  it("offers the maker a cancel instead of a buy", async () => {
    m.orders = [{ token_id: "7", status: "active", maker: WALLET.toUpperCase().replace("0X", "0x"), price_wei: "20000000000000000", order_hash: "0xrow" }];
    await renderPanel(COLLECTIONS.bojungles);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel my listing" }));
    await waitFor(() => expect(m.cancelNativeListing).toHaveBeenCalledWith(m.orders[0]));
    expect(screen.queryByRole("button", { name: /^Buy for/ })).toBeNull();
  });

  it("shows the best offer and accepts it", async () => {
    m.best = { price: 0.002, currency: "WETH", maker: OTHER, orderHash: "0xoffer", tokenContract: COLLECTIONS.bojungles.contract, tokenId: "7" };
    await renderPanel(COLLECTIONS.bojungles);
    fireEvent.click(await screen.findByRole("button", { name: "Accept (owner)" }));
    await waitFor(() => expect(m.acceptOffer).toHaveBeenCalledWith(m.best));
  });

  it("a wallet on the wrong chain is asked to switch to Base", async () => {
    m.createNativeListing = vi.fn(async () => ({ error: "wrong-chain", chainId: 8453, message: "switch" }));
    const { addToast } = await renderPanel(COLLECTIONS.bojungles);
    fireEvent.change(screen.getByPlaceholderText("Price in ETH"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await waitFor(() => expect(m.switched).toEqual([8453]));
    expect(addToast).toHaveBeenCalledWith("Switch your wallet to Base, then press List again.", "info");
  });

  it("says how the money moves: the venue's 0.5% to its Base treasury, OpenSea's 1% on an accepted offer", async () => {
    await renderPanel(COLLECTIONS.bojungles);
    expect(screen.getByText(/You get the price minus the venue's 0\.5%, which goes to the venue's Base treasury/)).toBeInTheDocument();
    expect(screen.getByText(/they get your offer minus OpenSea's 1% and the venue's 0\.5%/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/—/);
  });
});

describe("only the Base buy collections get the panel", () => {
  it("ExternalItemPanel mounts it for Bojungles and not for the memes", async () => {
    const { default: ExternalItemPanel } = await import("./components/external/ExternalItemPanel");
    const { unmount } = render(<ExternalItemPanel collection={COLLECTIONS.bojungles} item={item} onClose={vi.fn()} wallet={WALLET} />);
    expect(await screen.findByLabelText(/Trade Bojungles #7 here, on Base/)).toBeInTheDocument();
    unmount();
    render(<ExternalItemPanel collection={COLLECTIONS.junglebaymemes} item={{ id: 1, name: "meme" }} onClose={vi.fn()} wallet={WALLET} />);
    expect(screen.queryByLabelText(/Trade .* here/)).toBeNull();
  });
});
