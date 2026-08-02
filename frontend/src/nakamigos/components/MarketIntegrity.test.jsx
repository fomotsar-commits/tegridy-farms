import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// Import-resolution + transform guard: a broken import path or JSX syntax error
// in MarketIntegrity (or its new lib dependency) would break the production
// build. Importing the module here fails the suite before that can ship.
describe("MarketIntegrity surface module loads", () => {
  it("imports without throwing and default-exports a component", async () => {
    const mod = await import("./MarketIntegrity.jsx");
    expect(typeof mod.default).toBe("function");
  });

  it("its detection lib default path is wired to the shared core", async () => {
    const lib = await import("../lib/marketIntegrity.js");
    expect(typeof lib.computeMarketIntegrity).toBe("function");
    expect(typeof lib.fetchCollectionOwners).toBe("function");
    // Sanity: the core round-trips through the lib (no reimplemented metrics).
    const r = lib.analyzeOwnershipConcentration({
      owners: [{ address: `0x${"1".padStart(40, "0")}`, count: 1 }],
      totalSupply: 1,
    });
    expect(r.measured).toBe(true);
    expect(r.analysis.method.version).toMatch(/detection-core/);
  });
});

// The NFT owner feed (`fetchCollectionOwners` → Alchemy getOwnersForContract)
// yields only `{address, count}`: no `isContract` flag, no venue label, and the
// adapter passes no `labelSources`. So the ONLY exclusion the detection core can
// apply on this path is its built-in burn registry. These two cases pin the copy
// to that reality — if T2 ever starts failing, the subtitle must be revisited in
// the same commit.
describe("ownership-panel copy matches what this feed can actually exclude", () => {
  const OWNERS = [
    { address: `0x${"a".repeat(40)}`, count: 100 },
    { address: "0x000000000000000000000000000000000000dead", count: 50 },
  ];

  it("the subtitle does not claim LP or contract wallets were excluded", async () => {
    const { OwnershipPanel } = await import("./MarketIntegrity.jsx");
    const { analyzeOwnershipConcentration } = await import("../lib/marketIntegrity.js");
    const result = analyzeOwnershipConcentration({ owners: OWNERS, totalSupply: 150 });
    expect(result.measured).toBe(true);

    render(<OwnershipPanel result={result} truncated={false} />);
    const subtitle = screen.getByText(/effective-holder read over the owner set/i);
    expect(subtitle.textContent).not.toMatch(/LP[^.]*excluded/i);
    expect(subtitle.textContent).not.toMatch(/contract wallets excluded/i);
    // Burn removal IS real on this path and may still be claimed.
    expect(subtitle.textContent).toMatch(/burn/i);
  });

  it("only burn is actually excluded on the NFT owner path", async () => {
    const { analyzeOwnershipConcentration } = await import("../lib/marketIntegrity.js");
    const r = analyzeOwnershipConcentration({ owners: OWNERS, totalSupply: 150 });
    const excluded = r.analysis.exclusions.buckets.filter((b) => b.excluded).map((b) => b.category);
    expect(excluded).toContain("burn");
    expect(excluded).not.toContain("lp");
    expect(excluded).not.toContain("contract");
  });
});
