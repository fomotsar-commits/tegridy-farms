// ═══ Friendly error message mapping for Seaport / NFT transactions ═══
// Maps common revert reasons and error strings to plain-language messages.

const ERROR_MAP = [
  // Ownership / transfer errors
  { pattern: /ERC721: transfer caller is not owner/i, message: "This NFT has already been sold" },
  { pattern: /ERC721: transfer from incorrect owner/i, message: "This NFT has already been sold" },
  { pattern: /ERC721: operator query for nonexistent token/i, message: "This NFT no longer exists" },
  { pattern: /ERC721: approval to current owner/i, message: "You already own this NFT" },

  // Insufficient funds
  { pattern: /insufficient funds/i, message: "You don't have enough ETH" },
  { pattern: /Insufficient ETH/i, message: "You don't have enough ETH" },
  { pattern: /sender doesn't have enough funds/i, message: "You don't have enough ETH" },

  // Seaport-specific
  { pattern: /InvalidTime/i, message: "This listing has expired" },
  { pattern: /OrderIsCancelled/i, message: "This listing was cancelled by the seller" },
  { pattern: /OrderAlreadyFilled/i, message: "This NFT has already been sold" },
  { pattern: /ConsiderationNotMet/i, message: "The listing terms could not be met" },
  { pattern: /MissingOriginalConsiderationItems/i, message: "The listing data is incomplete" },
  { pattern: /InvalidConduit/i, message: "Marketplace routing error — try again" },
  { pattern: /BadFraction/i, message: "This listing is no longer valid" },

  // Generic revert
  { pattern: /execution reverted/i, message: "The item may no longer be available" },

  // User rejection
  { pattern: /user rejected|user denied|ACTION_REJECTED/i, message: "Transaction cancelled" },

  // Gas errors
  { pattern: /gas required exceeds allowance/i, message: "Transaction would fail — the listing may be stale" },
  { pattern: /intrinsic gas too low/i, message: "Gas estimate too low — try again" },
  { pattern: /max fee per gas less than block base fee/i, message: "Gas price too low — network is congested" },

  // Nonce errors
  { pattern: /nonce.*too low/i, message: "Transaction conflict — please wait and retry" },
  { pattern: /replacement.*underpriced/i, message: "A pending transaction is blocking this one" },

  // Network errors
  { pattern: /network error|failed to fetch|timeout/i, message: "Network error — check your connection" },
  { pattern: /could not detect network/i, message: "Cannot connect to Ethereum — check MetaMask" },

  // Fulfillment data
  { pattern: /fulfillment data/i, message: "Could not prepare the purchase — listing may be unavailable" },
  { pattern: /Invalid fulfillment/i, message: "Invalid listing data — try refreshing the page" },
  { pattern: /Unexpected transaction target/i, message: "Transaction target unrecognized — aborted for safety" },
];

/**
 * Convert a raw error message/string into a friendly user-facing message.
 * Returns the friendly message if matched, otherwise returns the original.
 */
export function getFriendlyError(error) {
  const raw = typeof error === "string" ? error : error?.message || error?.shortMessage || String(error);

  for (const entry of ERROR_MAP) {
    if (entry.pattern.test(raw)) {
      return entry.message;
    }
  }

  // Fallback: strip ethers.js prefixes and technical noise
  const cleaned = raw
    .replace(/^Error:\s*/i, "")
    .replace(/\(action="[^"]*",\s*/g, "")
    .replace(/,\s*code=[A-Z_]+.*$/g, "")
    .replace(/\(reason="[^"]*",\s*/g, "");

  // If still too long or technical, generic fallback
  if (cleaned.length > 120) {
    return "Transaction failed — please try again";
  }

  return cleaned;
}

/**
 * Determine if an error is a user rejection (should not be retried).
 */
export function isUserRejection(error) {
  const raw = typeof error === "string" ? error : error?.message || "";
  return /user rejected|user denied|ACTION_REJECTED|code.*4001/i.test(raw);
}
