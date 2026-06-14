/**
 * Net-proceeds preview for accepting an offer (F666).
 *
 * When a token owner accepts a Seaport bid, the buyer's gross WETH offer is
 * reduced by the ERC20 consideration items (OpenSea fee + platform fee + any
 * royalty the collection encoded into the order). The seller receives the
 * residual. The seller only sees that residual in the wallet popup today — this
 * helper pre-computes it so it can be shown before they confirm.
 *
 * Display/UX only — this does NOT touch fulfillment. It mirrors MyListings'
 * `computeRevenue` (which deducts PLATFORM_FEE_BPS for listings) but extends it
 * to bids, where the exact fee+royalty split is explicit in the order's
 * consideration.
 *
 * Two precision tiers, picked automatically:
 *
 *  1. EXACT — when the order's ERC20 consideration total is known
 *     (`feeEth` passed). net = gross − feeEth. This captures any royalty the
 *     collection baked into the order, so `royaltyIncluded` is true.
 *
 *  2. ESTIMATE — when consideration isn't available, fall back to the known
 *     marketplace fee bps (OpenSea + platform). Royalty cannot be derived from
 *     bps alone, so `royaltyIncluded` is false and the caller should label
 *     royalty as "set by the collection" rather than render a fabricated number.
 *
 * No USD, no price oracle — purely arithmetic on values the order already carries.
 */

/**
 * @param {number} grossEth      Buyer's gross offer in ETH/WETH.
 * @param {object} [opts]
 * @param {number} [opts.feeEth]  Exact ERC20 consideration total in ETH (fees +
 *                                royalty), when derivable from the order. When
 *                                provided and finite, the EXACT tier is used.
 * @param {number} [opts.feeBps]  Marketplace fee in basis points for the ESTIMATE
 *                                tier (e.g. OpenSea 100 + platform 100 = 200).
 * @returns {{
 *   gross: number,        // echoed gross (0 when input invalid)
 *   fee: number,          // amount deducted in ETH
 *   net: number,          // what the seller receives in ETH
 *   exact: boolean,       // true => fee came from the order's consideration
 *   royaltyIncluded: boolean, // true => the deducted fee already includes royalty
 * } | null}
 *   null when gross is not a usable positive number.
 */
export function computeNetProceeds(grossEth, { feeEth, feeBps = 0 } = {}) {
  const gross = Number(grossEth);
  if (!Number.isFinite(gross) || gross <= 0) return null;

  // EXACT tier: the order's ERC20 consideration total is known.
  if (feeEth != null && Number.isFinite(Number(feeEth))) {
    // Clamp to [0, gross]: a malformed order shouldn't ever show a negative net
    // or a fee larger than the offer itself.
    const fee = Math.min(Math.max(Number(feeEth), 0), gross);
    return {
      gross,
      fee,
      net: gross - fee,
      exact: true,
      royaltyIncluded: true,
    };
  }

  // ESTIMATE tier: derive the marketplace fee from bps. Royalty is NOT included
  // (not derivable from bps), so the caller must disclose that separately.
  const bps = Number.isFinite(Number(feeBps)) ? Math.max(Number(feeBps), 0) : 0;
  const fee = (gross * bps) / 10000;
  return {
    gross,
    fee,
    net: gross - fee,
    exact: false,
    royaltyIncluded: false,
  };
}

/**
 * Sum the ERC20 (itemType 1) consideration items of a Seaport order, in ETH.
 * These are the OpenSea fee + platform fee + any royalty — every amount the
 * buyer's gross offer is reduced by before the seller is paid. The NFT item
 * (itemType >= 2) carries no ETH amount and is ignored.
 *
 * @param {Array<{itemType:(number|string), startAmount:(string|number)}>} consideration
 * @returns {number|null} total fee in ETH, or null when no usable ERC20 items.
 */
export function feeEthFromConsideration(consideration) {
  if (!Array.isArray(consideration) || consideration.length === 0) return null;
  let totalWei = 0n;
  let sawErc20 = false;
  for (const item of consideration) {
    if (!item) continue;
    if (Number(item.itemType) !== 1) continue; // only ERC20 (WETH) fee items
    try {
      totalWei += BigInt(item.startAmount || "0");
      sawErc20 = true;
    } catch {
      // a non-integer startAmount is a malformed item — skip it rather than
      // throwing, so one bad item doesn't blank the whole preview.
    }
  }
  if (!sawErc20) return null;
  // wei -> ETH without precision loss for the magnitudes we deal with: divide by
  // 1e12 first (BigInt) then by 1e6 (Number), matching api-offers' safePriceFromWei.
  return Number(totalWei / 1_000_000_000_000n) / 1_000_000;
}
