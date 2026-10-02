import MarketButton from "./MarketButton";
import { TAB_LABELS, unavailableCopy } from "./externalCopy";

// A tab a view-only collection does not have, reached by a deep link or an old
// bookmark. It says so, gives the reason where the tab would trade, and points
// to the market where the collection does trade and to the tabs it has here.
export default function ExternalTabUnavailable({ collection, tab, onGoTo }) {
  const { lead, reason } = unavailableCopy(tab, collection);
  return (
    <section className="ext-section ext-unavailable" aria-labelledby="ext-unavailable-title">
      <div className="ext-unavailable-card">
        <h2 id="ext-unavailable-title" className="ext-unavailable-title">{TAB_LABELS[tab] || tab}</h2>
        <p>{lead}</p>
        {reason && <p>{reason}</p>}
        <div className="ext-unavailable-actions">
          <MarketButton collection={collection} />
          <button type="button" className="ext-secondary-btn" onClick={() => onGoTo("gallery")}>Browse the gallery</button>
          <button type="button" className="ext-secondary-btn" onClick={() => onGoTo("about")}>About this collection</button>
        </div>
      </div>
    </section>
  );
}
