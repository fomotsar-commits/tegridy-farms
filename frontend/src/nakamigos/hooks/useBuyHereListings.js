import { useCallback, useEffect, useState } from "react";
import { fetchListings } from "../api";
import { canBuyOnVenue, canTradeOnVenue } from "../lib/venue";

/**
 * The exact ETH amount of a wei string, every digit kept: "18990000000000000"
 * is "0.01899". A listing's `price` is cut to four decimals for sorting, which
 * can read BELOW what the buyer pays (0.0189 for 0.01899), so a price a buyer
 * is asked to pay is always shown from its wei. null for anything not a wei string.
 */
export function exactEth(priceWei) {
  if (typeof priceWei !== "string" || !/^\d{1,40}$/.test(priceWei)) return null;
  const wei = BigInt(priceWei);
  const unit = 10n ** 18n;
  const frac = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${wei / unit}.${frac}` : `${wei / unit}`;
}

/**
 * True for an OpenSea listing this venue offers to buy for a Base buy
 * collection: priced in ETH with a readable wei amount, with an order hash,
 * whose signed order offers exactly one ERC-721 and it is this collection's,
 * and not a burned token. Anything else is not shown as buyable (the OpenSea
 * link stays).
 */
export function buyableListing(collection, listing) {
  if (!collection?.contract || !listing || listing.isNative) return false;
  if (listing.currency !== "ETH") return false;
  if (!listing.orderHash || exactEth(listing.priceWei) == null || !(BigInt(listing.priceWei) > 0n)) return false;
  const offer = listing.orderData?.parameters?.offer;
  if (!Array.isArray(offer) || offer.length !== 1) return false;
  const item = offer[0];
  if (Number(item?.itemType) !== 2) return false;
  if (String(item?.token || "").toLowerCase() !== collection.contract.toLowerCase()) return false;
  if (String(item?.identifierOrCriteria) !== String(listing.tokenId)) return false;
  return !(collection.burnedIds || []).some((b) => String(b) === String(listing.tokenId));
}

const IDLE = Object.freeze({ status: "idle", byId: new Map() });

/**
 * The buyable OpenSea listings of a Base buy collection, by token id.
 * status: idle (not a buy collection) | loading | ready | unavailable.
 * "ready" with an empty map means the read worked and nothing is listed.
 */
export default function useBuyHereListings(collection) {
  const enabled = canBuyOnVenue(collection) && !canTradeOnVenue(collection);
  const [state, setState] = useState(() => (enabled ? { status: "loading", byId: new Map() } : IDLE));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ status: "loading", byId: s.byId }));
    fetchListings(collection.slug, { openseaSlug: collection.openseaSlug })
      .then((res) => {
        if (cancelled) return;
        if (!res || res.error) {
          setState({ status: "unavailable", byId: new Map() });
          return;
        }
        const byId = new Map();
        for (const l of res.listings || []) {
          if (buyableListing(collection, l)) byId.set(String(l.tokenId), l);
        }
        setState({ status: "ready", byId });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable", byId: new Map() });
      });
    return () => { cancelled = true; };
  }, [collection, enabled, attempt]);

  const refresh = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, refresh };
}
