import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";
import TransactionHistory from "./components/TransactionHistory";

// ═══ /nakamigos/history states its own scope ═══
//
// The ONLY store behind this page is localStorage[<slug>_tx_history], written by
// lib/transactions.recordTransaction() as the user trades in this browser. There
// is no server read in TransactionHistory.jsx at all. Presented under the bare
// heading "Transaction History" that is a false claim in three separate ways:
//
//   · on a second device / browser / private window the page renders EMPTY, which
//     a user reads as "my trades are gone" or "that purchase never happened";
//   · clearing site data destroys it with no warning that it was the only copy;
//   · anything transacted outside this app is absent from a surface that claims
//     to be the wallet's transaction history.
//
// Backing it with the real record needs an indexer the front end does not own, so
// the fix is the honest label. THE INVARIANT PINNED HERE IS NOT ANY SENTENCE — it
// is that EVERY state of this page (connected-with-rows, connected-and-empty,
// disconnected) discloses that the log is local to this browser. The empty state
// matters most: that is the exact state where a device-local log is
// indistinguishable from "you never traded".
//
// Pre-fix all three assertions fail: no state carried any scope disclosure.

const WALLET = "0x1111111111111111111111111111111111111111";
const SLUG = "nakamigos";

// Semantic, not literal: any wording that tells the user the store is this
// browser satisfies it. A rewrite that keeps the meaning stays green; a rewrite
// that drops it goes red.
const SAYS_DEVICE_LOCAL = /this (device|browser)/i;
// ...and the consequence, which is the part that actually prevents the misread.
const SAYS_NOT_THE_WHOLE_RECORD =
  /not synced|another (device|browser)|clearing your site data|erases it|never appear/i;

function seed(entries) {
  localStorage.setItem(`${SLUG}_tx_history`, JSON.stringify(entries));
}

function renderHistory(props) {
  return render(
    <CollectionProvider slug={SLUG}>
      <TransactionHistory {...props} />
    </CollectionProvider>,
  );
}

/** Whole-surface text, so the assertion does not depend on which node carries it. */
function surfaceText(container) {
  return container.textContent || "";
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("nakamigos history surface discloses that it is device-local", () => {
  it("says so while showing rows, where the page looks most authoritative", () => {
    seed([
      {
        id: "a", type: "buy", tokenId: "1", name: "Nakamigo #1",
        price: 0.5, wallet: WALLET.toLowerCase(), timestamp: Date.now() - 60_000,
      },
    ]);

    const { container } = renderHistory({ wallet: WALLET });

    // The row really did render — otherwise this test would pass against the
    // empty branch and prove nothing about the populated one.
    expect(screen.getByText("Nakamigo #1")).toBeInTheDocument();

    const text = surfaceText(container);
    expect(text).toMatch(SAYS_DEVICE_LOCAL);
    expect(text).toMatch(SAYS_NOT_THE_WHOLE_RECORD);
  });

  it("says so on the EMPTY state, where silence reads as 'you never traded'", () => {
    // A wallet with rows recorded on some OTHER device is byte-identical to this:
    // an empty store. That is precisely why the empty state must speak.
    const { container } = renderHistory({ wallet: WALLET });

    const text = surfaceText(container);
    expect(text).toMatch(SAYS_DEVICE_LOCAL);
    expect(text).toMatch(SAYS_NOT_THE_WHOLE_RECORD);
  });

  it("does not let the empty state assert a global absence of transactions", () => {
    const { container } = renderHistory({ wallet: WALLET });
    const text = surfaceText(container);

    // "No <collection> transactions yet" is a claim about the CHAIN. This page
    // cannot see the chain. Any absence it reports must be scoped.
    expect(text).not.toMatch(/no \w+ transactions yet/i);
  });

  it("says so before connect, so the promise made up front is the one kept", () => {
    const { container } = renderHistory({ wallet: null, onConnect: () => {} });

    // Heading and button both carry the phrase — assert on the heading.
    expect(screen.getByRole("heading", { name: /connect your wallet/i })).toBeInTheDocument();
    expect(surfaceText(container)).toMatch(SAYS_DEVICE_LOCAL);
  });

  it("points at a real, complete source instead of leaving the user with nothing", () => {
    seed([
      {
        id: "a", type: "buy", tokenId: "1", name: "Nakamigo #1",
        price: 0.5, wallet: WALLET.toLowerCase(), timestamp: Date.now() - 60_000,
      },
    ]);

    const { container } = renderHistory({ wallet: WALLET });

    // An honest label that offers no alternative is only half the fix. The
    // authoritative record exists and is public — link the connected wallet to it.
    const link = container.querySelector(`a[href*="${WALLET}"]`);
    expect(link).toBeTruthy();
    expect(link.getAttribute("rel") || "").toContain("noopener");
  });
});
