import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";

// When the OpenSea stats call is throttled, `fetchCollectionStats` substitutes a
// stored ALL-TIME volume total and flags it `volumeFallback`. That number is
// orders of magnitude away from any real polling-interval figure, so admitting
// it to the spike detector's rolling average manufactures an enormous alert on
// the step into the outage — a toast and a push notification asserting market
// activity that never happened. The engine must sit the cycle out instead.

const statsQueue = [];

vi.mock("./api", () => ({
  fetchCollectionStats: vi.fn(async () =>
    statsQueue.shift() ?? { floor: null, volume: null, owners: null, supply: null },
  ),
  fetchActivity: vi.fn(async () => ({ activities: [] })),
}));

const CHECK_INTERVAL = 30000;

const wrapper = ({ children }) => (
  <CollectionProvider slug="nakamigos">{children}</CollectionProvider>
);

async function runTwoTicks() {
  const { default: useSmartAlerts } = await import("./hooks/useSmartAlerts");
  const { result } = renderHook(() => useSmartAlerts(null), { wrapper });
  // Two polls: the first seeds the rolling history, the second is compared
  // against it. A spike can only be claimed on the second.
  await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL + 10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL + 10); });
  return result;
}

const activityAlerts = (result) => result.current.history.filter((n) => n.category === "activity");

describe("volume-spike alerts refuse the stand-in reading", () => {
  beforeEach(() => {
    statsQueue.length = 0;
    localStorage.clear();
    localStorage.setItem(
      "smart_alerts_config_nakamigos",
      JSON.stringify({
        floor: { enabled: false },
        volume: { enabled: true, spikeMultiplier: 3 },
        cooldown: 0,
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires nothing when the second reading is the cached constant", async () => {
    statsQueue.push(
      { floor: 0.2, volume: 100, owners: 4321, supply: 20000, volumeFallback: false },
      { floor: 0.2, volume: 52200, owners: 4321, supply: 20000, volumeFallback: true },
    );
    const result = await runTwoTicks();
    // Unguarded this is a 522x "spike" invented entirely by the outage.
    expect(activityAlerts(result)).toEqual([]);
  }, 20000);

  it("still fires on a genuine spike, so the guard didn't disable the feature", async () => {
    statsQueue.push(
      { floor: 0.2, volume: 100, owners: 4321, supply: 20000, volumeFallback: false },
      { floor: 0.2, volume: 400, owners: 4321, supply: 20000, volumeFallback: false },
    );
    const result = await runTwoTicks();
    const fired = activityAlerts(result);
    expect(fired).toHaveLength(1);
    expect(fired[0].body).toMatch(/volume up/i);
  }, 20000);

  it("does not let the constant poison the average for the next real reading", async () => {
    statsQueue.push(
      { floor: 0.2, volume: 100, owners: 4321, supply: 20000, volumeFallback: false },
      { floor: 0.2, volume: 52200, owners: 4321, supply: 20000, volumeFallback: true },
      { floor: 0.2, volume: 400, owners: 4321, supply: 20000, volumeFallback: false },
    );
    const { default: useSmartAlerts } = await import("./hooks/useSmartAlerts");
    const { result } = renderHook(() => useSmartAlerts(null), { wrapper });
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_INTERVAL + 10); });
    }
    // The history the third reading is judged against is [100], not [100, 52200]
    // — so 400 is still the 4x spike it really is.
    const fired = activityAlerts(result);
    expect(fired).toHaveLength(1);
    expect(fired[0].body).toMatch(/volume up 300%/i);
  }, 20000);
});
