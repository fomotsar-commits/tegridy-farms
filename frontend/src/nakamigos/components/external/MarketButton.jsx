// A link to where a view-only collection really trades, styled as a button.
// It is always a plain link out: this venue offers no action for it.

export default function MarketButton({ collection, href, compact = false }) {
  const market = collection?.market?.name;
  const url = href || collection?.market?.collectionUrl;
  if (!market || !url) return null;
  return (
    <a
      className={`ext-market-btn${compact ? " compact" : ""}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      Trade on {market}
      <span aria-hidden="true">{" \u2197"}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
