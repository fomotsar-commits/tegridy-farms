import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { CollectionProvider } from "./contexts/CollectionContext";

// ═══ MakeOfferModal names the reason an offer failed ═══
//
// Pre-fix, handleSubmit had exactly one terminal branch for every typed error it
// did not enumerate:
//
//     } else {
//       addToast?.("Offer failed. Please try again.", "error");
//     }
//
// `createItemOffer` / `createTraitOffer` / `createCollectionOffer` return SIX
// typed errors that land in it: wallet-mismatch, no-wallet, wrong-chain,
// no-network, wrap-failed, approve-failed — each carrying a specific `message`
// that was thrown away. Two of them are the reason this matters:
//
//   · wallet-mismatch — the signer is not the connected account. Retrying re-signs
//     from the same wrong identity. assertSameWallet (api.js:1117) had already
//     built a message naming BOTH addresses; the modal discarded it and told the
//     user to try again.
//   · no-wallet       — there is no wallet. Retrying cannot conjure one.
//
// "Please try again" is not merely unhelpful there, it is instruction to repeat a
// guaranteed failure while believing the app is flaky.
//
// THE INVARIANT: for a condition a retry cannot fix, the toast carries the
// reason. Pinned against the REAL `assertSameWallet` output — not a literal
// string — so rewording the guard keeps this green while dropping it goes red.

const CONNECTED = "0x1111111111111111111111111111111111111111";
const SIGNER = "0x2222222222222222222222222222222222222222";

const GENERIC_RETRY = /please try again/i;

const h = vi.hoisted(() => ({ createItemOffer: null }));

vi.mock("./api-offers", () => ({
  createItemOffer: (...a) => h.createItemOffer(...a),
  createTraitOffer: vi.fn(),
  createCollectionOffer: vi.fn(),
  fetchMyOffers: vi.fn(async () => []),
}));

vi.mock("./lib/weth", () => ({
  getWethBalance: vi.fn(async () => 0n),
  getEthBalance: vi.fn(async () => 0n),
  formatEth: (v) => String(v),
}));

vi.mock("./contexts/WalletContext", () => ({
  useWalletState: () => ({ isWrongNetwork: false }),
  useWalletActions: () => ({ switchChain: vi.fn() }),
}));

let addToast;

function renderModal() {
  return render(
    <CollectionProvider slug="nakamigos">
      <MakeOfferModal
        nft={{ id: "1", name: "Nakamigo #1" }}
        onClose={() => {}}
        wallet={CONNECTED}
        addToast={addToast}
      />
    </CollectionProvider>,
  );
}

/** Drive the form the way a user does, then read every toast the submit produced. */
async function submitOffer() {
  fireEvent.change(screen.getByLabelText(/offer price/i), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: /place 1 weth/i }));
  await waitFor(() => expect(addToast).toHaveBeenCalled());
  return addToast.mock.calls.map(([msg]) => String(msg)).join(" | ");
}

let MakeOfferModal;

beforeEach(async () => {
  addToast = vi.fn();
  h.createItemOffer = vi.fn();
  ({ default: MakeOfferModal } = await import("./components/MakeOfferModal"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("offer failure surfaces the reason a retry cannot fix", () => {
  it("names BOTH wallets on a wallet mismatch instead of advising a retry", async () => {
    // Produced by the real guard, so this test rides the actual message the app
    // would build rather than a hand-written stand-in.
    const { assertSameWallet } = await import("./api");
    const real = assertSameWallet(SIGNER, CONNECTED);
    expect(real.error).toBe("wallet-mismatch"); // rig check
    h.createItemOffer.mockResolvedValue(real);

    renderModal();
    const shown = await submitOffer();

    // The two facts the user needs, and cannot get anywhere else in this flow.
    expect(shown).toContain(CONNECTED.slice(0, 6));
    expect(shown).toContain(SIGNER.slice(0, 6));
    expect(shown).not.toMatch(GENERIC_RETRY);
  });

  it("says the wallet is missing rather than telling the user to retry into nothing", async () => {
    h.createItemOffer.mockResolvedValue({
      error: "no-wallet",
      message: "No wallet connected",
    });

    renderModal();
    const shown = await submitOffer();

    expect(shown).toMatch(/wallet/i);
    expect(shown).not.toMatch(GENERIC_RETRY);
  });

  it("re-opens the form so the surfaced reason is actionable, not terminal", async () => {
    h.createItemOffer.mockResolvedValue({
      error: "wallet-mismatch",
      message: "Wrong wallet: connected as 0x1111…1111 but 0x2222…2222 would sign and pay.",
    });

    renderModal();
    await submitOffer();

    // Back on the input step — a user who switches wallets can submit again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /place 1 weth/i })).toBeInTheDocument(),
    );
  });

  it("passes through the specific message on the other typed failures too", async () => {
    // wrap-failed also landed in the generic bucket, and it means real ETH moved
    // (or failed to) — the user must be told which transaction died.
    h.createItemOffer.mockResolvedValue({
      error: "wrap-failed",
      message: "Wrapping 0.5 ETH to WETH failed",
    });

    renderModal();
    const shown = await submitOffer();

    expect(shown).toMatch(/wrapping/i);
  });

  it("does not swallow a THROW into generic retry advice", async () => {
    // Pre-fix this path was a bare `catch {}` — the exception never reached the
    // console and the user got the same unhelpful line.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.createItemOffer.mockRejectedValue(new Error("conduit approval reverted"));

    renderModal();
    const shown = await submitOffer();

    expect(shown).toMatch(/conduit approval reverted/i);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still gives a usable message when the helper names no reason at all", async () => {
    // The generic line is legitimate HERE and only here — nothing was reported.
    h.createItemOffer.mockResolvedValue({ error: "failed" });

    renderModal();
    const shown = await submitOffer();

    expect(shown.length).toBeGreaterThan(0);
  });
});
