// ═══ Transaction recording utility ═══
// Extracted from TransactionHistory.jsx so that components like Listings and
// ShoppingCart can record transactions without statically importing the
// (lazy-loaded) TransactionHistory component — which was breaking code-splitting.

function loadHistory(slug = "nakamigos") {
  try {
    return JSON.parse(localStorage.getItem(`${slug}_tx_history`) || "[]");
  } catch {
    return [];
  }
}

export function recordTransaction({ type, nft, price, hash, wallet, slug }) {
  const key = slug || "nakamigos";
  const history = loadHistory(key);
  // Store lowercase wallet for reliable comparison in TransactionHistory.
  // localStorage is local-only so storing the full address is acceptable.
  const normalizedWallet = wallet ? wallet.toLowerCase() : null;
  history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    tokenId: nft?.id,
    name: nft?.name || `#${nft?.id}`,
    image: nft?.image,
    price,
    hash,
    wallet: normalizedWallet,
    timestamp: Date.now(),
  });
  // Keep last 50 transactions per collection
  const trimmed = history.slice(0, 50);
  try {
    localStorage.setItem(`${key}_tx_history`, JSON.stringify(trimmed));
  } catch { /* quota */ }
}
