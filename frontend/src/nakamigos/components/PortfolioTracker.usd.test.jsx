import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Honesty guard: PortfolioTracker must never paint a USD figure off a rate it
// invented.
//
// Pre-fix, PortfolioTracker.jsx read the rate from `useTOWELIPriceOptional()`,
// which returns null on 100% of renders here (the /nakamigos subtree is routed
// as a SIBLING of the AppLayout route that mounts the only <PriceProvider> in
// the repo). `(ethUsd || 3200)` then substituted a hardcoded rate, so both
// dollar sub-lines in the hero stats bar were always fabricated.
//
// The fix routes the component through useEthUsd + formatUsd — the same honest
// chain already used by Hero/Modal/ShoppingCart on this route — which yields 0
// when no real rate is reachable, at which point the dollar lines are omitted
// entirely and the (real) ETH figures remain.
// ─────────────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  rate: 0,
  pnl: null,
  useReal: false,
  tokens: [{ tokenId: "1", name: "#1", image: null }],
}));

// The REAL hook is always invoked (so hook order is identical in every test and
// the no-provider crash path from 2026-06-11 is exercised on every render); we
// only substitute its return value when a test needs a specific rate.
vi.mock("../hooks/useEthUsd", async (importOriginal) => {
  const actual = await importOriginal();
  const useEthUsd = () => {
    const real = actual.useEthUsd();
    return hoisted.useReal ? real : hoisted.rate;
  };
  return { useEthUsd, default: useEthUsd };
});

// Pre-fix the component imports this directly. Production returns null here
// (no provider on this route) — mock it faithfully so the pre-fix code takes
// exactly the branch it takes in production, and keep wagmi out of the test.
vi.mock("../../contexts/PriceContext", () => ({
  useTOWELIPriceOptional: () => null,
  useTOWELIPrice: () => {
    throw new Error("useTOWELIPrice must be used within a <PriceProvider>");
  },
  PriceProvider: ({ children }) => children,
}));

vi.mock("../api", () => ({
  fetchWalletNfts: vi.fn(async () => ({ tokens: hoisted.tokens, error: null })),
  fetchCollectionStats: vi.fn(async () => ({ floor: 1 })),
}));

vi.mock("../lib/portfolio", () => ({
  calculatePnL: vi.fn(async () => hoisted.pnl),
  saveSnapshot: vi.fn(),
  loadSnapshots: vi.fn(() => []),
}));

const { default: PortfolioTracker } = await import("./PortfolioTracker.jsx");
const { CollectionProvider } = await import("../contexts/CollectionContext.jsx");

// React 19 emits a console warning for every act() call unless this is set.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WALLET = "0x9999999999999999999999999999999999999999";

function makePnl({ currentValue = 2, unrealizedPnL = 0, realizedPnL = 0 } = {}) {
  return {
    realizedPnL,
    unrealizedPnL,
    totalGasSpent: 0.003,
    costBasis: 1,
    currentValue,
    nftCount: 1,
    floorPrice: 1,
    tokenDetails: [
      {
        tokenId: "1",
        name: "#1",
        image: null,
        costBasis: 1,
        currentValue,
        pnl: currentValue - 1,
        pnlPercent: (currentValue - 1) * 100,
        holdDays: 10,
        isMint: false,
      },
    ],
  };
}

let mounted = [];

async function renderTracker() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CollectionProvider>
        <PortfolioTracker wallet={WALLET} onConnect={() => {}} />
      </CollectionProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  hoisted.rate = 0;
  hoisted.useReal = false;
  hoisted.pnl = makePnl();
  localStorage.clear();
  // Block the CoinGecko leg so the real hook can only reach its honest 0.
  // AbortError is the one rejection useEthUsd deliberately does not log.
  globalThis.fetch = vi.fn(() =>
    Promise.reject(Object.assign(new Error("blocked"), { name: "AbortError" })),
  );
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  vi.clearAllMocks();
});

describe("PortfolioTracker never fabricates an ETH/USD rate", () => {
  it("renders NO dollar figure when no real rate is reachable (rate = 0)", async () => {
    hoisted.rate = 0;
    hoisted.pnl = makePnl({ currentValue: 2, unrealizedPnL: 1 });
    const c = await renderTracker();

    // Sanity: we actually reached the hero stats bar (not an early return).
    expect(c.textContent).toContain("PORTFOLIO VALUE");
    expect(c.textContent).toContain("TOTAL P&L");

    // The ETH-denominated figures are real and must survive untouched.
    expect(c.textContent).toContain("2.0000"); // formatPrice(currentValue)
    expect(c.textContent).toContain("1.0000"); // formatPrice(|totalPnL|)

    // The invariant: with no rate, not a single dollar amount is painted.
    expect(
      c.textContent,
      "a USD figure was rendered with no real ETH/USD rate available",
    ).not.toMatch(/\$[\d,]/);
  });

  it("tracks the REAL rate for portfolio value (4000 -> ~ $8,000, not a constant)", async () => {
    hoisted.rate = 4000;
    hoisted.pnl = makePnl({ currentValue: 2 });
    const c = await renderTracker();
    expect(c.textContent).toContain("~ $8,000");
  });

  it("still shows the USD line for a LOSING portfolio (negative P&L)", async () => {
    // formatPrice.js:57 returns the fallback for a NEGATIVE usd amount, so a
    // naive `formatUsd(totalPnL, rate)` would blank this line for every loss.
    // The magnitude must be passed and the sign carried separately.
    hoisted.rate = 4000;
    hoisted.pnl = makePnl({ currentValue: 2, unrealizedPnL: -1.5 });
    const c = await renderTracker();
    expect(c.textContent).toContain("1.5000"); // ETH magnitude still shown
    expect(
      c.textContent,
      "the USD sub-line vanished for a losing portfolio (negative-amount trap)",
    ).toContain("$6,000");
  });

  it("renders with the REAL useEthUsd and no PriceProvider (no crash, no USD)", async () => {
    // Guards the 2026-06-11 prod bug from the other side: this tab mounts
    // outside any <PriceProvider>, so the rate hook must degrade rather than
    // throw. useEthUsd reaches useTOWELIPriceOptional (non-throwing); swapping
    // it for useTOWELIPrice would re-crash the tab here.
    hoisted.useReal = true;
    hoisted.pnl = makePnl({ currentValue: 2, unrealizedPnL: 1 });
    const c = await renderTracker();

    expect(c.textContent).toContain("PORTFOLIO VALUE");
    expect(c.textContent).toContain("2.0000");
    // No context rate, no cache, no network => 0 => no dollar line at all.
    expect(c.textContent).not.toMatch(/\$[\d,]/);
  });
});

// ─── Source-level guard ──────────────────────────────────────────────────────
// A render test only covers the call sites that exist today. Pin the invariant
// at the source so a future edit cannot reintroduce a fabricated rate constant
// anywhere on this surface. Shape borrowed from strictMotion.test.tsx:21-53.
//
// The invariant is "no NON-ZERO rate constant", not "not 3200": a future 4000
// must fail too. A zero fallback is the honest sentinel (useEthUsd.js:113
// `?? 0`, documented at useEthUsd.js:18-19 as "returns 0 when no real rate is
// available") and is explicitly allowed.
const HERE = dirname(fileURLToPath(import.meta.url));
const NAKA_ROOT = join(HERE, "..");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

// `ethUsd || 3200`, `ethUsd ?? 4000` — but NOT `ethUsd ?? 0`.
const ETH_USD_FALLBACK = /ethUsd\s*(?:\|\||\?\?)\s*([0-9][0-9_]*(?:\.[0-9]+)?)/g;
// Renamed carriers: `rate = ctxRate || 3200`, `usdRate ?? 3500`. 100 is the
// plausibility floor useEthUsd.js:32 uses for a real ETH/USD quote, so any
// literal at or above it is a rate, not a scaling constant.
const RATE_FALLBACK = /\b\w*(?:usd|rate)\w*\s*(?:\|\||\?\?)\s*([0-9][0-9_]*(?:\.[0-9]+)?)/gi;

function offendersFor(re, min) {
  const hits = [];
  for (const f of sourceFiles(NAKA_ROOT)) {
    const src = readFileSync(f, "utf8");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const value = Number(m[1].replace(/_/g, ""));
      if (Number.isFinite(value) && Math.abs(value) >= min) {
        hits.push(`${f.slice(NAKA_ROOT.length + 1).replace(/\\/g, "/")}: ${m[0]}`);
      }
    }
  }
  return hits;
}

describe("no hardcoded ETH/USD rate anywhere under nakamigos/", () => {
  it("no `ethUsd || <non-zero>` fallback", () => {
    // Guard the guard: the scan must actually be looking at the tree.
    expect(sourceFiles(NAKA_ROOT).length).toBeGreaterThan(50);
    const offenders = offendersFor(ETH_USD_FALLBACK, Number.MIN_VALUE);
    expect(
      offenders,
      `fabricated ETH/USD rate constant — use useEthUsd() and let formatUsd omit the line at 0: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no rate-shaped identifier falls back to a literal >= 100", () => {
    const offenders = offendersFor(RATE_FALLBACK, 100);
    expect(
      offenders,
      `fabricated rate constant: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
