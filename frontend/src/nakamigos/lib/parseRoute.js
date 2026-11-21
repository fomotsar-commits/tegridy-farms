// What the marketplace shows for an address: /nakamigos/:collection/:tab.
// Its own file so a test can read it without mounting the whole app.

import { COLLECTIONS, VALID_TABS } from "../constants";
import { canTradeOnVenue } from "./venue";

/**
 * The tab a bare collection address opens on (/nakamigos/:collection). A
 * collection that trades here opens on Floor, what is for sale (owner,
 * 2026-11-15: "user should always land on floor not gallery"). A view-only
 * collection has no Floor (its tabs are Gallery and About), so it opens on
 * Gallery. The Gallery tab itself never relies on this: every tab button
 * writes its own segment (/nakamigos/:collection/gallery).
 */
export function landingTabFor(slug) {
  return canTradeOnVenue(COLLECTIONS[slug]) ? "listings" : "gallery";
}

export function parseRoute(pathname) {
  // Strip the /nakamigos prefix when embedded in Tegriddy Farms
  const stripped = pathname.replace(/^\/nakamigos\/?/, "/");
  const segments = stripped.replace(/^\//, "").split("/").filter(Boolean);

  // "/" — landing page
  if (segments.length === 0) return { collectionSlug: null, tab: "landing", tokenId: null };

  const first = segments[0];

  // Check if the first segment is a known collection slug
  if (COLLECTIONS[first]) {
    const second = segments[1] || landingTabFor(first);
    // Deep link: /:collection/nft/:id
    if (second === "nft" && segments[2]) {
      // Strict digits only — parseInt("12abc") === 12 would resolve a junk
      // segment to a real token (F547). Mirrors the ?token= reader's regex.
      const seg = segments[2];
      return { collectionSlug: first, tab: "gallery", tokenId: /^\d{1,10}$/.test(seg) ? seg : null };
    }
    const tab = VALID_TABS.includes(second) ? second : "404";
    return { collectionSlug: first, tab, tokenId: null };
  }

  // Legacy routes without collection prefix — redirect to nakamigos
  if (first === "nft" && segments[1]) {
    const seg = segments[1];
    return { collectionSlug: "nakamigos", tab: "gallery", tokenId: /^\d{1,10}$/.test(seg) ? seg : null };
  }
  if (VALID_TABS.includes(first)) {
    return { collectionSlug: "nakamigos", tab: first, tokenId: null };
  }

  return { collectionSlug: null, tab: "404", tokenId: null };
}
