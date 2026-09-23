import { useEffect, useRef, useState } from "react";
import { chainLabel, standardLabel, marketItemUrl, explorerAddressUrl } from "../../lib/venue";
import { formatMarketAmount } from "../../lib/marketAmount";
import MarketButton from "./MarketButton";
import { itemName } from "./externalCopy";

function short(addr) {
  return typeof addr === "string" && addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

function Fact({ label, children }) {
  return (
    <div className="ext-fact">
      <div className="ext-fact-label">{label}</div>{" "}
      <div className="ext-fact-value">{children}</div>{" "}
    </div>
  );
}

// One item of a view-only collection: what was read about it, and a link to
// its page on the market where it trades (per item where an item page was
// verified, the collection page otherwise). No action is offered here, and a
// token held by the burn address gets no market link at all.
export default function ExternalItemPanel({ collection, item, onClose }) {
  const closeRef = useRef(null);
  const [broken, setBroken] = useState(false);
  const name = itemName(collection, item);
  const burned = item.id != null && (collection.burnedIds || []).some((b) => String(b) === String(item.id));
  const itemUrl = item.id != null ? marketItemUrl(collection, item.id) : null;
  const explorer = explorerAddressUrl(collection);
  const price = item.priceSol != null ? formatMarketAmount(item.priceSol, "SOL", collection) : null;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-bg modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={name}>
      <div className="modal-content ext-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-image-side">
          <div className="modal-image-wrap">
            {item.image && !broken ? (
              <img src={item.image} alt={name} style={{ width: "100%", display: "block" }} onError={() => setBroken(true)} />
            ) : (
              <div className="ext-image-missing ext-image-missing-lg">Image unavailable</div>
            )}
          </div>
        </div>
        <div className="modal-details">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="ext-panel-collection">{collection.name}</div>{" "}
              <h2 className="ext-panel-title">{name}</h2>{" "}
              {item.id != null && <div className="ext-panel-id">#{item.id}</div>}
            </div>
            <button ref={closeRef} type="button" className="modal-close" onClick={onClose} aria-label="Close">{"\u2715"}</button>
          </div>

          {price && (
            <div className="ext-panel-price">Listed at {price} on {collection.market.name}</div>
          )}

          <div className="ext-facts">
            <Fact label="Chain">{chainLabel(collection)}</Fact>
            <Fact label="Standard">{standardLabel(collection)}</Fact>
            {collection.contract ? (
              <Fact label="Contract">
                {explorer ? <a href={explorer} target="_blank" rel="noopener noreferrer">{short(collection.contract)} {"\u2197"}</a> : short(collection.contract)}
              </Fact>
            ) : item.mint ? (
              <Fact label="Mint">
                <a href={`https://explorer.solana.com/address/${item.mint}`} target="_blank" rel="noopener noreferrer">{short(item.mint)} {"\u2197"}</a>
              </Fact>
            ) : null}
          </div>

          {item.attributes?.length > 0 && (
            <div className="ext-facts">
              {item.attributes.map((a) => <Fact key={`${a.key}:${a.value}`} label={a.key}>{a.value}</Fact>)}
            </div>
          )}

          {burned ? (
            <p className="ext-panel-note">
              This token is held by the burn address, so it cannot be bought on {collection.market.name} or anywhere else.
            </p>
          ) : (
            <div className="ext-panel-actions">
              <MarketButton collection={collection} href={itemUrl || undefined} />
              <p className="ext-panel-note">
                {itemUrl
                  ? `Opens this item's page on ${collection.market.name}. ${collection.name} does not trade on this venue.`
                  : `Opens the collection's page on ${collection.market.name}. ${collection.name} does not trade on this venue.`}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
