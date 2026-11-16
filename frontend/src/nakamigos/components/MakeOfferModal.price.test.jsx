import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CollectionProvider } from "../contexts/CollectionContext";

// Bids go in steps of 0.00001 WETH (lib/seaportOffer.js PRICE_TICK_WEI), so the
// price field takes at most 5 decimals and passes the typed decimal on as it is:
// what the bidder reads on the button is exactly what is signed. The overcommitment
// warning counts each live bid whole (offerWei), not one item of it.

const WALLET = "0x" + "a".repeat(40);
const h = vi.hoisted(() => ({ createItemOffer: null, myOffers: [] }));

vi.mock("../api-offers", () => ({
  createItemOffer: (...a) => h.createItemOffer(...a),
  createTraitOffer: vi.fn(),
  createCollectionOffer: vi.fn(),
  fetchMyOffers: vi.fn(async () => h.myOffers),
}));
vi.mock("../lib/weth", () => ({
  getWethBalance: vi.fn(async () => 10n ** 17n),
  getEthBalance: vi.fn(async () => 0n),
  formatEth: (v) => (Number(v) / 1e18).toFixed(4),
}));
vi.mock("../contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: vi.fn() }),
}));

let MakeOfferModal;
beforeEach(async () => {
  h.createItemOffer = vi.fn(async () => ({ success: true }));
  h.myOffers = [];
  ({ default: MakeOfferModal } = await import("./MakeOfferModal"));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderModal() {
  return render(
    <CollectionProvider slug="junglebay">
      <MakeOfferModal nft={{ id: "7", name: "#7" }} onClose={() => {}} wallet={WALLET} addToast={vi.fn()} />
    </CollectionProvider>,
  );
}

describe("the bid price field", () => {
  it("keeps at most 5 decimals, and the exact typed decimal is what the bid is made at", async () => {
    renderModal();
    const input = screen.getByLabelText(/offer price/i);
    fireEvent.change(input, { target: { value: "0.0123456789" } });
    expect(input.value).toBe("0.01234");
    fireEvent.click(screen.getByRole("button", { name: /place 0\.01234 weth/i }));
    await waitFor(() => expect(h.createItemOffer).toHaveBeenCalledTimes(1));
    expect(h.createItemOffer.mock.calls[0][0].priceEth).toBe("0.01234");
  });

  it("counts every live bid whole in the overcommitment warning", async () => {
    // One live bid for 3 items at 0.04 each: 0.12 WETH can be pulled, not 0.04.
    h.myOffers = [{ priceWei: "40000000000000000", offerWei: "120000000000000000" }];
    renderModal();
    fireEvent.change(screen.getByLabelText(/offer price/i), { target: { value: "0.05" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/active offers \(0\.1200 WETH\)/);
  });
});
