import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ═══ /nakamigos/pro says which of itself is real ═══
//
// Verified state of the page before this fix:
//   · TEGRIDY_PRO_PASS_ADDRESS (lib/constants.ts:70) is the ZERO address, so
//     PRO_PASS_LIVE is false — no Pro Pass contract exists to mint.
//   · `useProAccess` has exactly ONE consumer in the whole app: ProMembership
//     itself. So no Pro badge renderer, no referral accounting and no Pro-gated
//     tool exists — every perk on the page is a plan, written in present tense.
//   · `onCta` calls window.open(`https://etherscan.io/address/…`). Even once the
//     address IS set, the button labelled "Mint Pro Pass" opens a block explorer.
//     It has never minted anything.
//
// THE PAGE IS NOT THE PROBLEM AND MUST NOT BE DELETED. The operator's standing
// rule is that sections are never removed, and a roadmap page is legitimate. The
// defect is that it read as a product you could buy today. So two families of
// invariant are pinned here, and they pull against each other on purpose:
//
//   A. HONESTY — no control offers a mint that cannot happen, and the page states
//      that the contract is undeployed and the perks unbuilt.
//   B. PRESERVATION — every perk, the hero, and the CTA are still on the page. A
//      future pass that "fixes honesty" by deleting content goes red here.
//
// Pre-fix, family A fails. Family B passes both before and after — that is the
// point of including it.

const NOT_LIVE_DISCLOSED =
  /not been deployed|not yet deployed|nothing to mint|no pro pass contract/i;
const PERKS_NOT_LIVE_DISCLOSED =
  /not shipped|none of these are live|planned|intended design|not live yet/i;

// Every perk title in PERKS (ProMembership.jsx). Listed literally here ON PURPOSE:
// this half of the file is the anti-deletion guard, so it must notice a removal.
const PERK_TITLES = [
  "Pro flair across the app",
  "Earn on who you bring",
  "Early access to new tools",
  "A tradeable membership",
  "Funds real yield, not inflation",
];

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("../lib/constants");
});

async function renderPro(props = {}) {
  const { default: ProMembership } = await import("./components/ProMembership");
  return render(<ProMembership wallet={null} onConnect={() => {}} {...props} />);
}

describe("pro page — undeployed state is stated, not implied", () => {
  it("offers no mint from the primary control while there is no contract", async () => {
    const { container } = await renderPro();

    const cta = container.querySelector("button");
    expect(cta).toBeTruthy();
    // THE INVARIANT: the control the user reaches for must not name an action
    // that cannot occur. Pre-fix this read "Minting soon".
    expect(cta.textContent).not.toMatch(/mint/i);
    expect(cta.disabled).toBe(true);
  });

  it("states that the contract is undeployed and the perks are unbuilt", async () => {
    const { container } = await renderPro();
    const text = container.textContent || "";

    expect(text).toMatch(NOT_LIVE_DISCLOSED);
    expect(text).toMatch(PERKS_NOT_LIVE_DISCLOSED);
  });

  it("carries an explicit not-for-sale line, because a mint page is a scam target", async () => {
    const { container } = await renderPro();
    const text = container.textContent || "";

    // A polished pre-launch mint page is exactly what a phishing clone copies.
    // Saying we are taking no money is the one line that helps a user who lands
    // on the fake one.
    expect(text).toMatch(/not (taking|for sale)|nothing here is for sale|not us/i);
  });

  it("does not present the status as an imminent drop it cannot back", async () => {
    const { container } = await renderPro();

    // Pre-fix pill: "MINTING SOON" — a schedule claim with no schedule behind it.
    expect(container.textContent).not.toMatch(/minting soon/i);
    expect(container.textContent).not.toMatch(/drops with the next wave/i);
  });
});

describe("pro page — the CTA never promises a mint it does not perform", () => {
  // With the address set, PRO_PASS_LIVE flips true and the button enables — but
  // `onCta` still only calls window.open(etherscan). Pin the label against the
  // behaviour, not against the flag.
  const DEPLOYED = "0x00000000000000000000000000000000000000aa";

  async function renderLive(props = {}) {
    vi.resetModules();
    vi.doMock("../lib/constants", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, TEGRIDY_PRO_PASS_ADDRESS: DEPLOYED };
    });
    // useProAccess reads NFT balances once live — keep the test off the network.
    vi.doMock("./api", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, fetchWalletNfts: vi.fn(async () => ({ totalCount: 0 })) };
    });
    const { default: ProMembership } = await import("./components/ProMembership");
    return render(<ProMembership wallet={null} onConnect={() => {}} {...props} />);
  }

  afterEach(() => {
    vi.doUnmock("./api");
  });

  it("labels the enabled button for what it does — open the explorer", async () => {
    const { container } = await renderLive();

    const cta = container.querySelector("button");
    expect(cta.disabled).toBe(false);
    // Guard the rig: if the constants mock stopped taking effect the button would
    // be disabled and this whole block would assert nothing.
    expect(cta.textContent).not.toMatch(/\bmint\b/i);
    expect(container.textContent).toMatch(/etherscan/i);
    expect(container.textContent).toMatch(/minting is not wired/i);
  });
});

describe("pro page — nothing was deleted to achieve the above", () => {
  it("still renders the hero, every perk, and a CTA", async () => {
    const { container } = await renderPro();

    // "Tegridy Pro" also appears inside the disclosure copy — the hero wordmark
    // is the exact-match node.
    expect(screen.getByText("TEGRIDY PRO")).toBeInTheDocument();
    for (const title of PERK_TITLES) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("keeps the roadmap copy itself intact rather than watering it down", async () => {
    const { container } = await renderPro();
    const text = container.textContent || "";

    // The vision copy stays; only its TENSE and the surrounding disclosure changed.
    expect(text).toMatch(/referral cut/i);
    expect(text).toMatch(/real fees, not inflation/i);
    expect(text).toMatch(/share of the platform fee/i);
  });
});
