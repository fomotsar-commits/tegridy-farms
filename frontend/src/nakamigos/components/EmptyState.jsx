const EMPTY_STATES = {
  // --- Core browsing ---
  gallery: {
    icon: "\uD83D\uDDBC",
    title: "No NFTs available",
    description: "There are no tokens to display right now. Check back soon.",
  },
  search: {
    icon: "\uD83D\uDD0D",
    title: "No results found",
    description: "Try a different search term or clear your filters.",
  },
  filters: {
    icon: "\uD83D\uDD27",
    title: "No NFTs match these filters",
    description: "Try removing some filters or adjusting the price range.",
  },

  // --- User collections & saved items ---
  collection: {
    icon: "\uD83D\uDDBC",
    title: "No NFTs found",
    description:
      "Connect your wallet to see your collection, or start browsing to find your first.",
    action: "Browse Gallery",
    tab: "gallery",
  },
  favorites: {
    icon: "\u2661",
    title: "No {collection} favorites yet",
    description: "Click the heart on any {collection} NFT to save it here.",
    action: "Browse Gallery",
    tab: "gallery",
  },
  watchlist: {
    icon: "\uD83D\uDC41",
    title: "Watchlist is empty",
    description: "Add {collection} NFTs to track price changes and get alerts.",
    action: "Browse Gallery",
    tab: "gallery",
  },
  cart: {
    icon: "\uD83D\uDED2",
    title: "Cart is empty",
    description: "Add listed NFTs to your cart for batch purchasing.",
    action: "View Listings",
    tab: "listings",
  },
  portfolio: {
    icon: "\uD83D\uDCBC",
    title: "No NFTs in this wallet",
    description:
      "This wallet doesn't hold any NFTs from this collection. Try switching collections or wallets.",
  },

  // --- Marketplace ---
  listings: {
    icon: "\uD83D\uDCC9",
    title: "No listings available",
    description:
      "There are no active listings right now. Check back later or create your own.",
  },
  offers: {
    icon: "\uD83E\uDD1D",
    title: "No offers yet",
    description: "Be the first to make an offer on this NFT.",
  },
  collectionOffers: {
    icon: "\uD83D\uDCB0",
    title: "No collection offers",
    description: "Collection-wide offers will appear here.",
  },
  traitOffers: {
    icon: "\uD83C\uDFF7\uFE0F",
    title: "No trait offers",
    description: "Trait-based offers will appear here.",
  },

  myListings: {
    icon: "\uD83D\uDCCB",
    title: "No active listings",
    description: "You don't have any active listings for this collection. List your NFTs on OpenSea to see them here.",
  },

  // --- Bids & trading ---
  bids: {
    icon: "\uD83D\uDCB0",
    title: "No active bids",
    description: "Your open bids and offers will appear here.",
  },
  bidsReceived: {
    icon: "\uD83D\uDCE9",
    title: "No offers received",
    description:
      "When someone makes an offer on one of your NFTs it will appear here.",
  },
  trades: {
    icon: "\uD83E\uDD1D",
    title: "No trade offers",
    description: "Create a trade to swap NFTs with other holders.",
  },

  // --- Activity & history ---
  activity: {
    icon: "\uD83D\uDCCA",
    title: "No activity yet",
    description: "Activity will appear here as trades happen.",
  },
  history: {
    icon: "\uD83D\uDCDC",
    title: "No bid history",
    description: "Your past bids and expired offers will appear here.",
  },

  // --- Analytics & data ---
  analytics: {
    icon: "\uD83D\uDCCA",
    title: "No analytics data available",
    description: "Analytics will populate once token and sales data is loaded.",
  },
  holders: {
    icon: "\uD83D\uDCCA",
    title: "No holder data",
    description:
      "Holder analytics will appear once on-chain data has been indexed.",
  },

  // --- Social & community ---
  chat: {
    icon: "\uD83D\uDDE8\uFE0F",
    title: "No messages yet",
    description: "Start a conversation or wait for others to post.",
  },
  alerts: {
    icon: "\uD83D\uDD14",
    title: "No alerts set",
    description:
      "Set up price or trait alerts to get notified when conditions are met.",
  },

  // --- Rarity & sniping ---
  rarity: {
    icon: "\uD83D\uDD0D",
    title: "No opportunities found",
    description:
      "Adjust your filters or check back later for underpriced listings.",
  },

  // --- Wallet & auth ---
  wallet: {
    icon: "\uD83D\uDD12",
    title: "Wallet Not Connected",
    description: "Connect your wallet to access this feature.",
    action: "Connect Wallet",
  },

  // --- Whale intelligence ---
  whales: {
    icon: "\uD83D\uDC33",
    title: "No whale activity",
    description: "Large holder transactions will appear here as they happen.",
  },
};

/**
 * EmptyState - a reusable empty-state placeholder for any page / panel.
 *
 * Props:
 *   type            - key into EMPTY_STATES (e.g. "gallery", "bids", "offers")
 *   collectionName  - replaces "{collection}" tokens in title/description
 *   icon            - override the default icon for this type
 *   title           - override the default title
 *   description     - override the default description
 *   actionLabel     - override the default action-button label
 *   actionTab       - override the tab value passed to onAction
 *   onAction        - callback invoked with (tab) when action button is clicked
 *   compact         - renders a smaller variant for inline / panel use
 *   className       - additional CSS class names
 *   style           - additional inline styles
 */
export default function EmptyState({
  type = "search",
  collectionName,
  icon,
  title,
  description,
  actionLabel,
  actionTab,
  onAction,
  compact = false,
  className,
  style,
  // legacy prop aliases
  customTitle,
  customSubtitle,
}) {
  const config = EMPTY_STATES[type] || EMPTY_STATES.search;

  // Resolve values: explicit props > legacy aliases > config defaults
  const resolvedIcon = icon || config.icon;
  const resolvedTitle = title || customTitle || config.title;
  const resolvedDesc = description || customSubtitle || config.description;
  const resolvedActionLabel = actionLabel || config.action;
  const resolvedActionTab = actionTab || config.tab;

  // Replace {collection} placeholder with the actual collection name
  const interpolate = (text) => {
    if (!text) return text;
    if (collectionName) {
      return text.replace(/\{collection\}/g, collectionName);
    }
    return text;
  };

  const finalTitle = interpolate(resolvedTitle);
  const finalDesc = interpolate(resolvedDesc);

  const compactStyle = compact
    ? { padding: "24px 0", minHeight: "auto" }
    : undefined;
  const compactIconStyle = compact
    ? { fontSize: 28, marginBottom: 8 }
    : undefined;
  const compactTitleStyle = compact ? { fontSize: 13 } : undefined;
  const compactTextStyle = compact ? { fontSize: 10 } : undefined;

  return (
    <div
      className={["empty-state", className].filter(Boolean).join(" ")}
      style={{ ...compactStyle, ...style }}
    >
      <div className="empty-state-icon" style={compactIconStyle}>
        {resolvedIcon}
      </div>
      <div className="empty-state-title" style={compactTitleStyle}>
        {finalTitle}
      </div>
      {finalDesc && (
        <div className="empty-state-text" style={compactTextStyle}>
          {finalDesc}
        </div>
      )}
      {resolvedActionLabel && onAction && (
        <button
          className="empty-state-action"
          onClick={() => onAction(resolvedActionTab)}
        >
          {resolvedActionLabel}
        </button>
      )}
    </div>
  );
}

/** Expose the type keys so consumers can validate or iterate */
EmptyState.types = Object.keys(EMPTY_STATES);
