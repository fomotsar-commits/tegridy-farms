// The venue's 0.5% fee on a native listing, enforced here because the client that adds it
// is optional: anyone can POST a hand-built Seaport order. Must equal PLATFORM_FEE_RECIPIENT
// and PLATFORM_FEE_BPS in src/nakamigos/constants.js (api/ cannot import src/);
// orderbook.platform-fee.test.js holds them equal.
export const PLATFORM_FEE_RECIPIENT = "0x7d2620243edad69ec81a53c4a063b07995a4bd7d";
export const PLATFORM_FEE_BPS = 50n;

/**
 * Error string, or null when exactly one native-ETH consideration item pays the treasury
 * exactly PLATFORM_FEE_BPS of `totalWei` (the consideration sum).
 */
export function platformFeeError(consideration, totalWei) {
  const feeItems = consideration.filter(
    (item) => String(item?.recipient || "").toLowerCase() === PLATFORM_FEE_RECIPIENT,
  );
  if (feeItems.length !== 1) {
    return "Listing must pay the 0.5% venue fee to the treasury in exactly one consideration item";
  }
  const expected = (totalWei * PLATFORM_FEE_BPS) / 10000n;
  const fee = feeItems[0];
  const raw = String(fee.startAmount ?? "").trim();
  if (Number(fee.itemType) !== 0 || !/^[0-9]+$/.test(raw) || BigInt(raw) !== expected) {
    return `Venue fee must be exactly ${expected} wei in native ETH (0.5% of ${totalWei})`;
  }
  return null;
}
