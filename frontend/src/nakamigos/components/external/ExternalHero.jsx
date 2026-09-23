import { useState } from "react";
import { supplyLabel } from "../../lib/venue";
import { formatMarketAmount } from "../../lib/marketAmount";
import MarketButton from "./MarketButton";
import { explainerLine } from "./externalCopy";

const DASH = "\u2014";

function StatCard({ label, value, note, color = "var(--text)" }) {
  return (
    <div className="stat-card ext-stat-card">
      <div className="stat-value" style={{ color: value === DASH ? "var(--text-muted)" : color }}>{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="ext-stat-note">{note}</div>}
    </div>
  );
}

function StatSkeleton({ label }) {
  return (
    <div className="stat-card ext-stat-card">
      <div className="stat-skeleton-bar" style={{ width: 64, height: 16, marginBottom: 6 }} />
      <div className="stat-label">{label}</div>
    </div>
  );
}

// The market's numbers, each in its own unit. A value the read did not
// produce is the unread dash, never a zero, and a read that failed says so.
function StatsRow({ collection, stats }) {
  const supply = supplyLabel(collection) ?? DASH;
  const market = collection.market.name;

  if (stats.status === "loading") {
    return (
      <>
        <div className="stats-row">
          {["FLOOR", "VOLUME", "OWNERS"].map((l) => <StatSkeleton key={l} label={l} />)}
          <StatCard label="SUPPLY" value={supply} />
        </div>
        <div className="ext-stats-source">Reading stats from {market}...</div>
      </>
    );
  }

  if (stats.status !== "ready") {
    return (
      <>
        <div className="stats-row">
          <StatCard label="FLOOR" value={DASH} />
          <StatCard label="VOLUME" value={DASH} />
          <StatCard label="OWNERS" value={DASH} />
          <StatCard label="SUPPLY" value={supply} />
        </div>
        <div className="ext-stats-source" role="status">Stats unavailable: {market} could not be read right now.</div>
      </>
    );
  }

  const s = stats.data;
  const floor = s.floor != null ? formatMarketAmount(s.floor, s.floorSymbol, collection) : "None listed";
  const readsVolume = s.source !== "Magic Eden";
  return (
    <>
      <div className="stats-row">
        <StatCard label="FLOOR" value={floor ?? DASH} color="var(--gold)" />
        {!readsVolume && (
          <StatCard label="LISTED" value={s.listedCount != null ? `${s.listedCount.toLocaleString("en-US")} listed` : DASH} color="var(--naka-blue)" />
        )}
        <StatCard
          label="VOLUME"
          value={formatMarketAmount(s.volume, "ETH", collection) ?? DASH}
          note={readsVolume ? null : "not read here"}
          color="var(--naka-blue)"
        />
        <StatCard
          label="OWNERS"
          value={s.owners != null ? s.owners.toLocaleString("en-US") : DASH}
          note={readsVolume ? null : "not read here"}
          color="var(--green)"
        />
        <StatCard label="SUPPLY" value={supply} />
      </div>
      <div className="ext-stats-source">Stats from {s.source}</div>
    </>
  );
}

export default function ExternalHero({ collection, stats }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <section className="hero ext-hero">
      <div className="hero-wrap">
        <div className="hero-info">
          <div className="hero-badge-row">
            {(collection.tags || []).map((tag) => (
              <span key={tag} className="pixel-badge blue">{tag}</span>
            ))}
          </div>
          <h1 className="hero-title ext-hero-title">{collection.name}</h1>
          <p className="hero-desc">{explainerLine(collection)}</p>
          <div className="ext-hero-actions">
            <MarketButton collection={collection} />
          </div>
          <StatsRow collection={collection} stats={stats} />
        </div>
        {collection.image && !imageFailed && (
          <div className="ext-hero-image">
            <img src={collection.image} alt="" loading="eager" decoding="async" onError={() => setImageFailed(true)} />
          </div>
        )}
      </div>
      <div className="hero-divider" />
    </section>
  );
}
