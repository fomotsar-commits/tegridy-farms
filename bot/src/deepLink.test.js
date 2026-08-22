// A link that goes somewhere slightly wrong is worse than one that fails.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppLink, buildLinkUrl, buildScanUrl, buildSwapUrl, PARAM_READERS } from "./deepLink.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(HERE, "..", "..", "frontend", "src");
const ORIGIN = "https://memetic.fun";

describe("links point at routes that exist and carry only parameters that are read", () => {
  it("builds the link-code URL the panel picks up", () => {
    expect(buildLinkUrl(ORIGIN, "ABCDEFGHJK")).toBe("https://memetic.fun/alerts?tglink=ABCDEFGHJK");
  });

  it("builds a scanner URL", () => {
    expect(buildScanUrl(ORIGIN, "0xabc")).toBe("https://memetic.fun/scan?token=0xabc");
  });

  it("builds a swap URL", () => {
    expect(buildSwapUrl(ORIGIN)).toBe("https://memetic.fun/swap?tab=swap");
  });

  it("THROWS on a parameter the destination page does not read", () => {
    // The failure this module exists to prevent: TradePage.tsx parses `tab` and
    // nothing else, so a `?token=` would be dropped by the app and the user would
    // land on the wrong asset under a message claiming otherwise.
    expect(() => buildAppLink(ORIGIN, "/swap", { token: "0xabc" })).toThrow(/does not read/);
  });

  it("throws on a route it does not link to at all", () => {
    expect(() => buildAppLink(ORIGIN, "/admin")).toThrow(/not a route/);
  });

  it("omits an empty value rather than emitting a blank parameter", () => {
    expect(buildAppLink(ORIGIN, "/scan", { token: "" })).toBe("https://memetic.fun/scan");
  });

  it("encodes the value, so nothing in a token address can escape the query", () => {
    expect(buildScanUrl(ORIGIN, "a b&c=d")).toBe("https://memetic.fun/scan?token=a+b%26c%3Dd");
  });
});

describe("PARAM_READERS is checked against the pages, not asserted about them", () => {
  // The table is a claim about frontend code. An unverified claim is how this
  // module goes quiet while still looking careful.
  it("ScannerPage really does read `token`", () => {
    const src = readFileSync(join(FRONTEND_SRC, "pages", "ScannerPage.tsx"), "utf8");
    expect(src).toContain("params.get('token')");
    expect(PARAM_READERS["/scan"]).toContain("token");
  });

  it("TradePage really does read `tab` — and this bot claims nothing more for /swap", () => {
    const src = readFileSync(join(FRONTEND_SRC, "pages", "TradePage.tsx"), "utf8");
    expect(src).toContain("searchParams.get('tab')");
    expect(PARAM_READERS["/swap"]).toEqual(["tab"]);
  });

  it("the alerts panel really does read `tglink`", () => {
    const src = readFileSync(join(FRONTEND_SRC, "components", "bot", "TelegramLinkPanel.tsx"), "utf8");
    expect(src).toContain("tglink");
    expect(PARAM_READERS["/alerts"]).toContain("tglink");
  });
});
