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
