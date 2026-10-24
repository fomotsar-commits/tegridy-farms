import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VALID_TABS } from "./constants";
import { PRIMARY_NAV, MORE_NAV } from "./components/Header";
import { PRIMARY_TABS, MORE_TABS } from "./components/MobileNav";

// Regression guard for the bug class that shipped the P2P Trades tab dead:
// Header/MobileNav offered "trades" while App.jsx parseRoute() 404'd it
// because VALID_TABS was a second, drifted copy of the tab list.

describe("every nav target is routable", () => {
  it("desktop Header nav keys are all in VALID_TABS", () => {
    for (const [key] of [...PRIMARY_NAV, ...MORE_NAV]) {
      expect(VALID_TABS, `Header nav "${key}" would 404`).toContain(key);
    }
  });

  it("MobileNav keys are all in VALID_TABS", () => {
    for (const { key } of [...PRIMARY_TABS, ...MORE_TABS]) {
      expect(VALID_TABS, `MobileNav "${key}" would 404`).toContain(key);
    }
  });

  it("every VALID_TABS entry has a renderTab case in App.jsx", () => {
    // Source-level check: importing App.jsx would execute the full app tree,
    // so assert against the switch statement text instead. vitest runs with
    // cwd = frontend/, and import.meta.url is not a file: URL under jsdom.
    const src = readFileSync(
      join(process.cwd(), "src", "nakamigos", "App.jsx"),
      "utf8",
    );
    for (const tab of VALID_TABS) {
      expect(src, `VALID_TABS "${tab}" has no renderTab case`).toMatch(
        new RegExp(`case "${tab}":`),
      );
    }
  });
});

describe("App.jsx routing regression guards (source-level)", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "nakamigos", "App.jsx"),
    "utf8",
  );

  it("nft deep-link parse is strict-digits, not lenient parseInt (F547)", () => {
    // parseInt("12abc") === 12 used to resolve junk segments to a real token.
    expect(src).toMatch(/\/\^\\d\{1,10\}\$\/\.test\(seg\)/);
    expect(src, "lenient parseInt token-id parse must be gone").not.toMatch(
      /tokenId:\s*!isNaN\(id\)/,
    );
  });

  it("both /nft/ modal-close paths land on the explicit /gallery segment (F538)", () => {
    // A bare /:collection close path is ambiguous; the explicit /gallery segment
    // keeps the tab under the modal on Gallery instead of bouncing to Floor.
    // Both the Escape handler and the Modal onClose must use it (2 occurrences).
    const closeMatches = src.match(
      /navigate\(`\/nakamigos\/\$\{collectionSlug\}\/gallery`,\s*\{\s*replace:\s*true\s*\}\)/g,
    ) || [];
    expect(closeMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("trade surface modules load", () => {
  // Regression guard for the TradeWindow TDZ crash (COLLECTION_LIST used
  // before declaration) that Modal.jsx's lazy().catch silently swallowed.
  it("TradeWindow imports without throwing and exports a component", async () => {
    const mod = await import("./components/TradeWindow.jsx");
    expect(typeof mod.default).toBe("function");
  });

  it("TradesPanel imports without throwing and exports a component", async () => {
    const mod = await import("./components/TradesPanel.jsx");
    expect(typeof mod.default).toBe("function");
  });
});

// P2P trading reaches only the collections the venue can settle. TradeWindow,
// TradesPanel and TradeChips each kept their own loop over COLLECTIONS, which
// would hand a Base, ERC-1155 or Solana collection to an inventory read, a
// floor estimate and a wildcard chip, and crash at import on Junglets' null
// contract. Each list is exported so this can hold it to VENUE_COLLECTIONS.
describe("P2P trade surfaces are built from the venue list only", () => {
  // Imported through a variable so a missing module fails these tests alone,
  // not the whole file's existing guards.
  const load = (p) => import(/* @vite-ignore */ p);
  const venueKeys = async () => {
    const { VENUE_COLLECTIONS } = await load("./lib/venue");
    return VENUE_COLLECTIONS.map((c) => c.contract.toLowerCase()).sort();
  };

  it("TradeWindow's collection list and supply map are the venue list", async () => {
    const mod = await import("./components/TradeWindow.jsx");
    const want = await venueKeys();
    expect(mod.COLLECTION_LIST.map((c) => c.contract.toLowerCase()).sort()).toEqual(want);
    expect(Object.keys(mod.SUPPLY_BY_CONTRACT).sort()).toEqual(want);
  });

  it("TradesPanel's contract map is the venue list", async () => {
    const mod = await import("./components/TradesPanel.jsx");
    expect(Object.keys(mod.COLLECTION_BY_CONTRACT).sort()).toEqual(await venueKeys());
  });

  it("TradeChips names every venue collection by its registry chip, and no two alike", async () => {
    const mod = await import("./components/TradeChips.jsx");
    const { VENUE_COLLECTIONS } = await load("./lib/venue");
    expect(Object.keys(mod.SHORT_NAME).sort()).toEqual(await venueKeys());
    for (const c of VENUE_COLLECTIONS) {
      expect(mod.SHORT_NAME[c.contract.toLowerCase()], c.slug).toBe(c.chip);
    }
    const labels = Object.values(mod.SHORT_NAME);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a chip carries its collection's full name, so GOLD #12 cannot be taken for an ape", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { ItemChips } = await import("./components/TradeChips.jsx");
    const { COLLECTIONS } = await import("./constants");
    render(<ItemChips items={[{ contract: COLLECTIONS.junglebaygoldcards.contract, tokenId: "12" }]} accent="#fff" />);
    const chip = screen.getByTitle("Jungle Bay Gold Cards");
    expect(chip.textContent).toContain("GOLD #12");
    // The visually hidden full name is what a screen reader hears.
    expect(chip.textContent).toContain("Jungle Bay Gold Cards");
  });
});
