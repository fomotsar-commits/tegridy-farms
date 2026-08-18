import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, renderHook, act, waitFor } from "@testing-library/react";
import { TradingModeProvider, LITE_HIDDEN_ALL } from "./contexts/TradingModeContext";
import MobileNav, { PRIMARY_TABS, MORE_TABS } from "./components/MobileNav";

// First coverage for two of the shell's social/navigation surfaces. Both had
// none, and both encode a rule that is invisible from the outside: Lite mode is
// a promise that the hidden Pro tabs are unreachable, and the DM badge poll is
// one of the intervals that has to stay off a backgrounded tab (the venue's own
// rate limiter is what a polling storm trips first).

function renderNav(props) {
  return render(
    <TradingModeProvider>
      <MobileNav tab="gallery" onTabChange={() => {}} {...props} />
    </TradingModeProvider>,
  );
}

// The bar carries an inline `display: none` and is revealed by a viewport media
// query, which jsdom does not evaluate — so every query here opts into hidden
// elements. Dropping that opt-in makes these tests pass for the wrong reason
// (nothing found, nothing asserted), which is why the Lite-mode test also
// asserts a tab that IS expected to be present.
const btn = (name) => screen.getByRole("button", { name, hidden: true });
const maybeBtn = (name) => screen.queryByRole("button", { name, hidden: true });

describe("MobileNav", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("marks only the active tab with aria-current", () => {
    renderNav({ tab: "activity" });
    expect(btn("Activity")).toHaveAttribute("aria-current", "page");
    expect(btn("Gallery")).not.toHaveAttribute("aria-current");
  });

  it("opens the More sheet, reports expansion, and closes on choosing a tab", () => {
    const onTabChange = vi.fn();
    renderNav({ onTabChange });

    const more = btn("More tabs");
    expect(more).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(btn("About"));
    expect(onTabChange).toHaveBeenCalledWith("about");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(maybeBtn("About")).toBeNull();
  });

  it("hides every Lite-hidden tab in the default (Lite) mode", () => {
    renderNav({});
    fireEvent.click(btn("More tabs"));

    const hiddenLabels = [...PRIMARY_TABS, ...MORE_TABS]
      .filter((t) => LITE_HIDDEN_ALL.has(t.key))
      .map((t) => t.label);
    expect(hiddenLabels.length).toBeGreaterThan(0);
    for (const label of hiddenLabels) {
      expect(maybeBtn(label)).toBeNull();
    }
    // …while an always-available tab is still there, so the assertion above
    // isn't passing because nothing rendered at all.
    expect(btn("Chat")).toBeInTheDocument();
  });

  it("restores the hidden tabs in Pro mode", () => {
    localStorage.setItem("nakamigos_trading_mode", "pro");
    renderNav({});
    fireEvent.click(btn("More tabs"));

    expect(btn("Sniper")).toBeInTheDocument();
    expect(btn("Deals")).toBeInTheDocument();
  });

  it("highlights More when the active tab lives inside it", () => {
    renderNav({ tab: "chat" });
    fireEvent.click(btn("More tabs"));
    expect(btn("Chat")).toHaveAttribute("aria-current", "page");
  });
});

// ── useDmUnread ──────────────────────────────────────────────────────────────

const unreadState = { count: 0, calls: 0 };

vi.mock("./lib/dm", () => ({
  fetchUnreadCount: vi.fn(async () => {
    unreadState.calls++;
    return unreadState.count;
  }),
}));

const POLL_MS = 60_000;

describe("useDmUnread", () => {
  let hidden = false;

  beforeEach(() => {
    unreadState.count = 0;
    unreadState.calls = 0;
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays silent with no wallet", async () => {
    const { default: useDmUnread } = await import("./hooks/useDmUnread");
    const { result } = renderHook(() => useDmUnread(null));
    await waitFor(() => expect(result.current.unread).toBe(0));
    expect(unreadState.calls).toBe(0);
  });

  it("reports the count without toasting what was already unread on arrival", async () => {
    const { default: useDmUnread } = await import("./hooks/useDmUnread");
    const onNew = vi.fn();
    unreadState.count = 3;

    const { result } = renderHook(() => useDmUnread("0xabc", { onNew }));
    await waitFor(() => expect(result.current.unread).toBe(3));
    // Three messages were already waiting — a badge, not an interruption.
    expect(onNew).not.toHaveBeenCalled();

    unreadState.count = 5;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.unread).toBe(5);
    expect(onNew).toHaveBeenCalledWith(5);
  });

  it("does not announce a count that fell", async () => {
    const { default: useDmUnread } = await import("./hooks/useDmUnread");
    const onNew = vi.fn();
    unreadState.count = 4;

    const { result } = renderHook(() => useDmUnread("0xabc", { onNew }));
    await waitFor(() => expect(result.current.unread).toBe(4));

    unreadState.count = 1;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.unread).toBe(1);
    expect(onNew).not.toHaveBeenCalled();
  });

  it("skips the poll while the tab is backgrounded and resumes when it returns", async () => {
    const { default: useDmUnread } = await import("./hooks/useDmUnread");
    renderHook(() => useDmUnread("0xabc"));
    await waitFor(() => expect(unreadState.calls).toBe(1));

    hidden = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(unreadState.calls).toBe(1);

    hidden = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(unreadState.calls).toBe(2);
  });

  it("clears the badge and re-arms the first-load guard when the wallet goes away", async () => {
    const { default: useDmUnread } = await import("./hooks/useDmUnread");
    const onNew = vi.fn();
    unreadState.count = 2;

    const { result, rerender } = renderHook(({ w }) => useDmUnread(w, { onNew }), {
      initialProps: { w: "0xabc" },
    });
    await waitFor(() => expect(result.current.unread).toBe(2));

    rerender({ w: null });
    await waitFor(() => expect(result.current.unread).toBe(0));

    // Reconnecting must not toast the same two messages as if they just arrived.
    rerender({ w: "0xabc" });
    await waitFor(() => expect(result.current.unread).toBe(2));
    expect(onNew).not.toHaveBeenCalled();
  });
});
