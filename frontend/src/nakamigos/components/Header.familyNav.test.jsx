// The header and the mobile bar, for a collection that is browsed here but
// trades elsewhere.
//
// Three small contracts the view-only collections rely on:
//   - `allowedTabs` narrows both navs to the tabs a collection really has, and
//     shows them as primary tabs rather than behind a More menu;
//   - the cart button renders only when there is a cart to toggle;
//   - a long collection name ellipsises instead of pushing the nav into the
//     next element. The family's names are the longest in the registry ("the
//     memes by jungle bay x mfers artists" is 39 characters), and the desktop
//     nav stays visible from 769 to 1024 px, which is the iPad width green
//     reported overlaps at.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TradingModeProvider } from "../contexts/TradingModeContext";

vi.mock("../contexts/WalletContext", () => ({
  useWalletState: () => ({ address: null, isConnected: false, walletName: null, isWrongNetwork: false }),
  useWalletActions: () => ({ connectWallet: () => {}, disconnect: () => {}, switchChain: () => {} }),
  useWalletUI: () => ({ isPending: false, connectError: null, availableConnectors: [], isSwitching: false }),
  useWallet: () => ({ address: null }),
}));

afterEach(() => cleanup());

const LONG = "the memes by jungle bay x mfers artists";

async function renderHeader(props = {}) {
  const { default: Header } = await import("./Header.jsx");
  return render(
    <MemoryRouter>
      <TradingModeProvider>
        <Header
          tab="gallery"
          setTab={() => {}}
          wallet={null}
          setWallet={() => {}}
          onConnect={() => {}}
          activities={[]}
          isLive={false}
          cartCount={0}
          themeName="default"
          onCycleTheme={() => {}}
          collectionName={LONG}
          collectionImage="/splash/skeleton.jpg"
          {...props}
        />
      </TradingModeProvider>
    </MemoryRouter>,
  );
}

describe("Header", () => {
  it("narrows the desktop nav to the allowed tabs, shown as primary tabs with no More menu", async () => {
    await renderHeader({ allowedTabs: new Set(["gallery", "about"]), onCartToggle: undefined });
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent.trim())).toEqual(["Gallery", "About"]);
  });

  it("control: with no allowedTabs the nav is unchanged", async () => {
    await renderHeader({ onCartToggle: () => {} });
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const labels = within(nav).getAllByRole("button").map((b) => b.textContent.trim());
    expect(labels).toContain("Floor");
    expect(labels).toContain("More");
  });

  it("renders the cart button only when there is a cart to toggle", async () => {
    await renderHeader({ onCartToggle: undefined });
    expect(screen.queryByRole("button", { name: "Shopping cart" })).toBeNull();
    cleanup();
    await renderHeader({ onCartToggle: () => {} });
    expect(screen.getByRole("button", { name: "Shopping cart" })).toBeInTheDocument();
  });

  it("ellipsises a long collection name, and keeps the whole name in its title", async () => {
    await renderHeader({ onCartToggle: () => {} });
    const name = screen.getByTitle(new RegExp(LONG, "i"));
    expect(name.textContent).toMatch(/THE MEMES BY JUNGLE BAY/);
    expect(name.style.overflow).toBe("hidden");
    expect(name.style.textOverflow).toBe("ellipsis");
    expect(name.style.whiteSpace).toBe("nowrap");
    expect(name.style.maxWidth).not.toBe("");
    expect(name.style.maxWidth).not.toBe("none");
  });
});

describe("MobileNav", () => {
  it("shows the allowed tabs as primary tabs and hides the More menu", async () => {
    const { default: MobileNav } = await import("./MobileNav.jsx");
    render(
      <TradingModeProvider>
        <MobileNav tab="gallery" onTabChange={() => {}} allowedTabs={new Set(["gallery", "about"])} />
      </TradingModeProvider>,
    );
    expect(screen.getByRole("button", { name: /^Gallery$/, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^About$/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More tabs", hidden: true })).toBeNull();
    for (const t of ["Deals", "Floor", "Activity", "Favs"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${t}$`), hidden: true })).toBeNull();
    }
  });
});
