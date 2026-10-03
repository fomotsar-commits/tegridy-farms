// OfferPanel offers Accept only for an offer on the token the owner is looking at.
//
// The panel shows Accept whenever the connected wallet owns the ACTIVE token,
// but acceptOffer fills the offer's OWN tokenContract. When the offer book was
// read from the wrong collection (offerSlugScope.test.js), a GNSS owner was
// offered Accept on a Nakamigos bid, and accepting it would have sold the
// Nakamigos. Reading the right book fixes the cause; this pins the second
// layer: an offer whose contract is not the active collection's never gets an
// Accept button, whatever the book returns.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import { ADDR } from "./__fixtures__/jungleBayFamily";

const h = vi.hoisted(() => ({ book: null }));

vi.mock("./api-offers", () => ({
  fetchTokenOfferBook: vi.fn(async () => h.book),
  acceptOffer: vi.fn(async () => ({ success: true })),
}));

const OWNER = "0x" + "a".repeat(40);

function offer(tokenContract) {
  return {
    price: 0.05,
    maker: "0x" + "b".repeat(40),
    orderHash: `0xoffer-${tokenContract}`,
    tokenContract,
    tokenId: "5",
    expiry: new Date(Date.now() + 3600_000),
  };
}

async function renderPanel(slug) {
  const { default: OfferPanel } = await import("./components/OfferPanel.jsx");
  return render(
    <CollectionProvider slug={slug}>
      <OfferPanel tokenId="5" wallet={OWNER} ownerAddress={OWNER} addToast={() => {}} onMakeOffer={() => {}} />
    </CollectionProvider>,
  );
}

beforeEach(() => {
  h.book = { offers: [], bestOffer: null, unavailable: false };
});

describe("Accept is offered only on the active collection's own token", () => {
  it("shows Accept for an offer on the active collection (control)", async () => {
    const o = offer(ADDR.gnssart);
    h.book = { offers: [o], bestOffer: o, unavailable: false };
    await renderPanel("gnssart");
    expect((await screen.findAllByRole("button", { name: "Accept" })).length).toBeGreaterThan(0);
  });

  it("hides Accept for an offer on another collection's contract", async () => {
    const o = offer(ADDR.nakamigos);
    h.book = { offers: [o], bestOffer: o, unavailable: false };
    await renderPanel("gnssart");
    // The offer row itself still renders; only the button that would fill it is withheld.
    await waitFor(() => expect(screen.getAllByText(/0\.0500/).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole("button", { name: "Accept" })).toHaveLength(0);
  });
});
