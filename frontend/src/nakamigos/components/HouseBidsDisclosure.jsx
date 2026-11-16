// What the venue's own bidder is, on the marketplace's About tab (BUILD-SPEC 3.2, item 8).
//
// Shown only once lib/house/houseRegistry.json names a wallet: until the venue bids, there
// is nothing to disclose and no page gains a word. A heading and one line; the rest is small
// print. Plain text in the marketplace's own styles (the 2026-11-14 "fresh" rules: no art,
// no glow, no new colours).
import { FinePrint } from "../../components/ui/FinePrint";
import { houseWallets } from "../../lib/house/houseRegistry.js";

/** The anchor About's one link jumps to. */
export const HOUSE_BIDS_ID = "house-bids";

// PLACEHOLDER: the page with the house bidder's full rules. It must exist before the first
// wallet is registered (HouseBidsDisclosure.test.jsx refuses a registered wallet while this
// is null), and until then no link is drawn: a link to nowhere is worse than none.
export const HOUSE_RULES_URL = null;

export default function HouseBidsDisclosure() {
  const wallets = houseWallets();
  if (wallets.length === 0) return null;
  return (
    <section id={HOUSE_BIDS_ID} aria-labelledby={`${HOUSE_BIDS_ID}-title`} style={{ marginTop: 36, maxWidth: 700 }}>
      <h3
        id={`${HOUSE_BIDS_ID}-title`}
        style={{ fontFamily: "var(--pixel)", fontSize: 12, color: "var(--naka-blue)", letterSpacing: "0.06em", marginBottom: 12 }}
      >
        House bids
      </h3>
      <p style={{ fontFamily: "var(--display)", fontSize: 14, color: "var(--text-dim)", lineHeight: 1.7, margin: 0 }}>
        The venue&apos;s operator runs a bidder for some collections, with their own money. Its bids are labelled House.
      </p>
      <FinePrint summary="Details" testId="house-bids-small-print">
        <p>
          {wallets.length === 1 ? "It bids from one wallet: " : `It bids from ${wallets.length} wallets: `}
          {wallets.map((w, i) => (
            <span key={w}>
              {i > 0 ? ", " : ""}
              <code style={{ fontFamily: "var(--mono)", wordBreak: "break-all" }}>{w}</code>
            </span>
          ))}
          .
        </p>
        {/* Owner 2026-11-16: "I'll fund it myself". Say whose money it is, so nobody reads a
            House bid as the venue's treasury or as revenue shared under the split. */}
        <p>
          It is funded by the venue&apos;s operator personally, not by the venue or the revenue it shares, so its gains and
          losses are the operator&apos;s alone.
        </p>
        <p>Every house bid is fully funded, so a house bid is one it will honour.</p>
        <p>Its bids change only for reasons it publishes, and it uses only public OpenSea and chain data.</p>
        <p>No one who works on the venue or shares its revenue, the operator included, sells to it or buys from it.</p>
        <p>House bids are left out of the lending desk&apos;s numbers, and every house trade is published.</p>
        <p>A house bid is not a promise to hold any price.</p>
        <p>
          {HOUSE_RULES_URL ? (
            <a href={HOUSE_RULES_URL} target="_blank" rel="noopener noreferrer">
              The full rules {"↗"}
            </a>
          ) : (
            "The full rules are published before the first house bid."
          )}
        </p>
      </FinePrint>
    </section>
  );
}
