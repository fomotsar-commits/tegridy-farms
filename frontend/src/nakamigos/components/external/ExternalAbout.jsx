import { chainLabel, standardLabel, supplyLabel, explorerAddressUrl } from "../../lib/venue";
import MarketButton from "./MarketButton";
import { explainerLine } from "./externalCopy";

const DESCRIPTION_SOURCE = {
  opensea: "Description from the collection's OpenSea page",
  onchain: "Description from the collection's on-chain metadata",
};

function short(addr) {
  return typeof addr === "string" && addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

// A view-only collection's own facts, each with where it came from: the
// description is labelled as the collection's words, the supply carries the
// read that produced it, and the contract links to its chain's explorer.
export default function ExternalAbout({ collection }) {
  const explorer = explorerAddressUrl(collection);
  const address = collection.contract || collection.solana?.collectionMint || null;
  const sourceLabel = DESCRIPTION_SOURCE[collection.descriptionSource];
  const facts = [
    ["Chain", chainLabel(collection)],
    ["Standard", standardLabel(collection)],
    [collection.contract ? "Contract" : "Collection mint", address ? short(address) : null, explorer],
    ["Supply", supplyLabel(collection)],
    ["Deployed", collection.deploy ? `${collection.deploy.date} (block ${collection.deploy.block.toLocaleString("en-US")})` : null],
    ["Trades on", collection.market?.name],
  ].filter(([, value]) => value);

  return (
    <section className="about-section ext-about">
      <div className="about-hero">
        <div className="pixel-badge" style={{ marginBottom: 16, display: "inline-block" }}>ABOUT</div>
        {collection.image && (
          <div className="ext-about-image">
            <img src={collection.image} alt="" />
          </div>
        )}
        <h2 className="ext-about-title">{collection.name.toUpperCase()}</h2>
        <p className="ext-about-lead">{explainerLine(collection)}</p>

        {collection.description && sourceLabel && (
          <figure className="ext-description">
            <figcaption className="ext-description-source">{sourceLabel}</figcaption>
            <blockquote className="ext-description-text">{collection.description}</blockquote>
          </figure>
        )}

        {collection.tags?.length > 0 && (
          <div className="ext-tags">
            {collection.tags.map((tag) => <span key={tag} className="ext-tag">{tag}</span>)}
          </div>
        )}
      </div>

      <div className="about-meta-grid">
        {facts.map(([label, value, href]) => (
          <div key={label} className="ext-about-fact">
            <div className="ext-fact-label">{label.toUpperCase()}</div>{" "}
            <div className="ext-about-fact-value">
              {href ? <a href={href} target="_blank" rel="noopener noreferrer">{value} {"\u2197"}</a> : value}
            </div>
          </div>
        ))}
      </div>

      {collection.supplyNote && (
        <p className="ext-supply-note">Supply: {collection.supplyNote}</p>
      )}

      <div className="ext-about-links">
        <MarketButton collection={collection} />
        {explorer && (
          <a className="about-link" href={explorer} target="_blank" rel="noopener noreferrer">
            {collection.explorer.name} {"\u2197"}
          </a>
        )}
      </div>
    </section>
  );
}
