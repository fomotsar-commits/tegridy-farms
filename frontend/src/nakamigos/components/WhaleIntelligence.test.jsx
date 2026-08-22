import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollectionProvider } from "../contexts/CollectionContext";

// The ENS pass is best-effort (WhaleIntelligence.jsx wraps it in try/catch) —
// keep it offline so a test never reaches the network.
vi.mock("../lib/rpcProvider", () => ({
  getReadProvider: vi.fn(async () => {
    throw new Error("no rpc in test");
  }),
}));

vi.mock("../api", () => ({
  fetchTopHolders: vi.fn(),
  fetchActivity: vi.fn(),
  fetchWalletNfts: vi.fn(async () => ({ tokens: [], totalCount: 0 })),
  shortenAddress: (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ""),
}));

import WhaleIntelligence from "./WhaleIntelligence.jsx";
import { fetchTopHolders, fetchActivity } from "../api";

// `fetchTopHolders` / `fetchActivity` never reject (api.js turns every failure
// into a resolved `{ ..., fallback: true }`), so an outage is ONLY visible as
// `fallback: true` with an empty payload. These fixtures reproduce that exactly.
const HOLDER_OUTAGE = { holders: [], totalOwners: 0, totalHeld: 0, fallback: true };
const ACTIVITY_OUTAGE = { activities: [], fallback: true, pageKey: null };

function renderWhales(slug = "gnssart") {
  return render(
    <CollectionProvider slug={slug}>
      <WhaleIntelligence />
    </CollectionProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchTopHolders.mockResolvedValue(HOLDER_OUTAGE);
  fetchActivity.mockResolvedValue(ACTIVITY_OUTAGE);
});

describe("WhaleIntelligence surface module loads", () => {
  it("imports without throwing and default-exports a component", async () => {
    const mod = await import("./WhaleIntelligence.jsx");
    expect(typeof mod.default).toBe("function");
  });
});

describe("WhaleIntelligence holder outage is reachable and recoverable", () => {
  it("surfaces an outage message with a recovery control", async () => {
    renderWhales();
    expect(await screen.findByText(/could not load top holders/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("the recovery control actually refetches", async () => {
    renderWhales();
    await screen.findByText(/could not load top holders/i);
    fetchTopHolders.mockClear();
    fetchActivity.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    // Pin the invariant (a refetch happened), not a call count.
    expect(fetchTopHolders).toHaveBeenCalled();
    expect(fetchActivity).toHaveBeenCalled();
  });

  it("never promises data that already failed to arrive", async () => {
    renderWhales();
    await screen.findByText(/could not load top holders/i);
    expect(screen.queryByText(/will appear once data is loaded/i)).toBeNull();
  });

  it("renders an explicit unavailable state instead of a blank holder panel", async () => {
    renderWhales();
    await screen.findByText(/could not load top holders/i);
    expect(screen.getAllByText(/holder data unavailable/i).length).toBeGreaterThan(0);
  });

  it("does not assert zero sales when the activity feed is the thing that failed", async () => {
    renderWhales();
    await screen.findByText(/could not load top holders/i);
    expect(screen.queryByText(/no recent sales found/i)).toBeNull();
  });
});

describe("WhaleIntelligence controls (outage disclosure must stay off the healthy paths)", () => {
  it("a live holder set shows no outage message and no retry control", async () => {
    fetchTopHolders.mockResolvedValue({
      holders: [{ address: `0x${"1".repeat(40)}`, count: 5 }],
      totalOwners: 1,
      totalHeld: 5,
      fallback: false,
    });
    fetchActivity.mockResolvedValue({ activities: [], fallback: false, pageKey: null });
    renderWhales();
    expect(await screen.findByText(/top holders/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("a fallback that still carries rows discloses non-liveness without the hard-failure banner", async () => {
    // Guards the `list.length === 0` half of the outage condition: a degraded
    // response that still has holders must not be reported as a hard failure on
    // top of a populated panel — but it must still be disclosed as not-live.
    fetchTopHolders.mockResolvedValue({
      holders: [{ address: `0x${"2".repeat(40)}`, count: 9 }],
      totalOwners: 0,
      totalHeld: 9,
      fallback: true,
    });
    renderWhales("nakamigos");
    expect(await screen.findByText(/not a live read/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load top holders/i)).toBeNull();
  });
});
