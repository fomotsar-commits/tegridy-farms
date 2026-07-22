import { describe, it, expect } from "vitest";

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
