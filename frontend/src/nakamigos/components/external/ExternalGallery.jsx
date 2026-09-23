import { memo, useEffect, useState } from "react";
import { formatMarketAmount } from "../../lib/marketAmount";
import { itemKey, itemName } from "./externalCopy";

const ItemCard = memo(function ItemCard({ collection, item, onPick }) {
  const [broken, setBroken] = useState(false);
  const name = itemName(collection, item);
  const price = item.priceSol != null ? formatMarketAmount(item.priceSol, "SOL", collection) : null;
  return (
    <button
      type="button"
      className="ext-card"
      onClick={() => onPick(item)}
      aria-label={price ? `${name}, listed at ${price}` : name}
    >
      <div className="nft-card gallery">
        <div className="card-image-wrap">
          {item.image && !broken ? (
            <img src={item.image} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          ) : (
            <div className="ext-image-missing">Image unavailable</div>
          )}
        </div>
        <div className="card-footer">
          <div className="card-name ext-card-name">{name}</div>
          <div className="ext-card-meta">
            {item.id != null ? <span>#{item.id}</span> : <span>Listed on {collection.market.name}</span>}
            {price && <span className="ext-card-price">{price}</span>}
          </div>
        </div>
      </div>
    </button>
  );
});

function RetryButton({ retryAt, onRetry }) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = retryAt != null && now < retryAt;
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const secs = waiting ? Math.ceil((retryAt - now) / 1000) : 0;
  return (
    <button type="button" className="ext-retry-btn" onClick={onRetry} disabled={waiting}>
      {waiting ? `Retry in ${secs}s` : "Retry"}
    </button>
  );
}

// Rows the market returned that failed validation are counted, never hidden.
function droppedLine(dropped) {
  if (!(dropped > 0)) return "";
  return ` ${dropped.toLocaleString("en-US")} more could not be read and ${dropped === 1 ? "is" : "are"} not shown.`;
}

// Junglets show listings only. "The N listed" is said only when the stats
// read counted exactly N; fewer is "N of the M listed", and with no count
// read it is "N listed", so the line never contradicts the LISTED stat.
function countLine(collection, items, listedCount) {
  const source = items.source || collection.market.name;
  const count = items.list.length;
  const n = count.toLocaleString("en-US");
  const more = droppedLine(items.dropped);
  if (collection.chain === "solana") {
    const supply = collection.supply != null ? collection.supply.toLocaleString("en-US") : null;
    const of = supply ? `, of ${supply}` : "";
    const listed = Number.isFinite(listedCount) ? listedCount : null;
    if (items.status === "partial" || items.dropped > 0) {
      return `Showing at least ${n} ${collection.name} listed on ${source}${of}.${more}`;
    }
    if (listed === count) return `Showing the ${n} ${collection.name} listed on ${source}${of}.`;
    if (listed != null && listed > count) {
      return `Showing ${n} of the ${listed.toLocaleString("en-US")} ${collection.name} listed on ${source}${supply ? `, of ${supply} in all` : ""}.`;
    }
    return `Showing ${n} ${collection.name} listed on ${source}${of}.`;
  }
  return items.status === "partial"
    ? `Showing at least ${n} items read from ${source}; the rest could not be read.${more}`
    : `Showing ${n} items read from ${source}.${more}`;
}

// What the market read produced: every item it returned, a count that says
// where it came from, and an explicit failure with Retry when it failed.
// "No items" is said only after a read that succeeded and returned none.
export default function ExternalGallery({ collection, items, listedCount = null, onRetry, onPick, notice }) {
  const market = collection.market.name;
  const failed = items.status === "unavailable" || (items.status === "partial" && items.reason !== "page-limit");

  return (
    <section className="ext-section" aria-label={`${collection.name} items`}>
      {notice}
      {items.status === "loading" && (
        <div className="ext-gallery-status" role="status">
          <span className="spinner" /> Reading items from {market}...
        </div>
      )}
      {failed && (
        <div className="ext-gallery-status ext-gallery-error" role="status">
          <span>Items could not be read from {market} right now.</span>
          <RetryButton retryAt={items.retryAt} onRetry={onRetry} />
        </div>
      )}
      {items.status === "empty" && (
        <div className="ext-gallery-status" role="status">
          No items were returned by {market} for this collection.
        </div>
      )}
      {(items.status === "ready" || items.status === "partial") && (
        <>
          <div className="ext-gallery-count">{countLine(collection, items, listedCount)}</div>
          <div className="gallery-grid gallery ext-gallery-grid">
            {items.list.map((item) => (
              <ItemCard key={itemKey(item)} collection={collection} item={item} onPick={onPick} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
