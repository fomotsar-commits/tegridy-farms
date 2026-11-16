// The house bidder's disclosure on the marketplace's About tab (BUILD-SPEC 3.2, item 8).
// Nothing at all while the registry is empty; once it names a wallet, a heading, one line,
// the small print, and the About tab's one link to it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import COMMITTED from "../../lib/house/houseRegistry.json";

const h = vi.hoisted(() => ({ registry: null }));
vi.mock("../../lib/house/houseRegistry.js", async () => {
  const core = await import("../../lib/house/houseRegistryCore.js");
  const now = () => core.createHouseRegistry(h.registry);
  return {
    HOUSE_LABEL: core.HOUSE_LABEL,
    createHouseRegistry: core.createHouseRegistry,
    houseWallets: () => now().houseWallets(),
    isHouseWallet: (a) => now().isHouseWallet(a),
    houseLabel: (a) => now().houseLabel(a),
    houseBidLabel: (a, b) => now().houseBidLabel(a, b),
  };
});

import HouseBidsDisclosure, { HOUSE_BIDS_ID, HOUSE_RULES_URL } from "./HouseBidsDisclosure";

const HOUSE = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const ONE_HOUSE = { version: 1, note: "test", wallets: [{ address: HOUSE, label: "House bidder", collections: ["junglebay"], since: "2026-11-16" }] };

// The About tab's first import (the Jungle Bay showcase behind it) takes a few seconds.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  h.registry = COMMITTED;
});
afterEach(cleanup);

describe("HouseBidsDisclosure", () => {
  it("renders nothing while the committed registry names no wallet", () => {
    const { container } = render(<HouseBidsDisclosure />);
    expect(container.innerHTML).toBe("");
  });

  it("once a wallet is registered: the heading, the one line, and the small print closed", () => {
    h.registry = ONE_HOUSE;
    render(<HouseBidsDisclosure />);
    const section = document.getElementById(HOUSE_BIDS_ID);
    expect(section).toBeTruthy();
    expect(within(section).getByRole("heading", { name: "House bids" })).toBeTruthy();
    expect(within(section).getByText("The venue runs its own bidder for some collections. Its bids are labelled House.")).toBeTruthy();
    const small = screen.getByTestId("house-bids-small-print");
    expect(small.tagName).toBe("DETAILS");
    expect(small.hasAttribute("open")).toBe(false);
  });

  it("the small print names the wallet in full and says each promise", () => {
    h.registry = ONE_HOUSE;
    render(<HouseBidsDisclosure />);
    const text = screen.getByTestId("house-bids-small-print").textContent;
    expect(text).toContain(`It bids from one wallet: ${HOUSE.toLowerCase()}.`);
    for (const promise of [
      "fully funded",
      "one it will honour",
      "change only for reasons it publishes",
      "only public OpenSea and chain data",
      "Nobody who works on the venue or shares its revenue trades with it.",
      "left out of the lending desk's numbers",
      "every house trade is published",
      "not a promise to hold any price",
    ]) {
      expect(text, promise).toContain(promise);
    }
  });

  it("names every wallet when there is more than one", () => {
    const second = "0x" + "c".repeat(40);
    h.registry = { ...ONE_HOUSE, wallets: [...ONE_HOUSE.wallets, { ...ONE_HOUSE.wallets[0], address: second }] };
    render(<HouseBidsDisclosure />);
    expect(screen.getByTestId("house-bids-small-print").textContent).toContain(`It bids from 2 wallets: ${HOUSE.toLowerCase()}, ${second}.`);
  });

  it("draws no link to a rules page that is not there yet", () => {
    h.registry = ONE_HOUSE;
    render(<HouseBidsDisclosure />);
    const small = screen.getByTestId("house-bids-small-print");
    if (HOUSE_RULES_URL === null) {
      expect(within(small).queryByRole("link")).toBeNull();
      expect(small.textContent).toContain("The full rules are published before the first house bid.");
    } else {
      expect(within(small).getByRole("link").getAttribute("href")).toBe(HOUSE_RULES_URL);
    }
  });

  // The guard on the placeholder: the house cannot go live with its rules unpublished.
  it("the committed registry names no wallet until the rules page link is set", () => {
    if (COMMITTED.wallets.length > 0) {
      expect(HOUSE_RULES_URL, "set HOUSE_RULES_URL in HouseBidsDisclosure.jsx before registering a house wallet").toMatch(/^https:\/\//);
    } else {
      expect(COMMITTED.wallets).toEqual([]);
    }
  });
});

describe("the About tab's one link to it", () => {
  async function renderAbout() {
    const { MemoryRouter } = await import("react-router-dom");
    const { CollectionProvider } = await import("../contexts/CollectionContext");
    const { default: About } = await import("./About.jsx");
    return render(
      <MemoryRouter>
        <CollectionProvider slug="junglebay">
          <About stats={{ floor: 0.05, supply: 5555, owners: 2000 }} onNavigateGallery={() => {}} onFilterGallery={() => {}} />
        </CollectionProvider>
      </MemoryRouter>,
    );
  }

  it("is absent, and About has no house section, while the registry is empty", async () => {
    await renderAbout();
    expect(screen.queryByRole("link", { name: /House bids/ })).toBeNull();
    expect(document.getElementById(HOUSE_BIDS_ID)).toBeNull();
    expect(document.body.textContent).not.toMatch(/House bids/);
  });

  it("once a wallet is registered, is exactly one link and it lands on the disclosure", async () => {
    h.registry = ONE_HOUSE;
    await renderAbout();
    const links = screen.getAllByRole("link", { name: /House bids/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(`#${HOUSE_BIDS_ID}`);
    expect(document.getElementById(HOUSE_BIDS_ID)).toBeTruthy();
  });
});
