// Rich skeleton loaders for Suspense boundaries (replaces plain "Loading..." text)

export function GallerySkeleton() {
  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 16px" }}>
      {/* Toolbar skeleton */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
        <div className="skeleton" style={{ width: 200, height: 38, borderRadius: 10 }} />
        <div className="skeleton" style={{ width: 140, height: 38, borderRadius: 10 }} />
        <div style={{ flex: 1 }} />
        <div className="skeleton" style={{ width: 80, height: 38, borderRadius: 10 }} />
      </div>
      {/* Grid skeleton */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="skeleton-card card-reveal" style={{ animationDelay: `${i * 40}ms`, borderRadius: 12, overflow: "hidden" }}>
            <div className="skeleton skeleton-image" style={{ height: 240 }} />
            <div className="skeleton-info" style={{ padding: 12 }}>
              <div className="skeleton skeleton-line" style={{ width: "70%" }} />
              <div className="skeleton skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 8 }) {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
      <div className="skeleton" style={{ width: 200, height: 28, borderRadius: 8, marginBottom: 24 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 52, borderRadius: 10, animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
      <div className="skeleton" style={{ width: 180, height: 32, borderRadius: 8, marginBottom: 24 }} />
      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 80, borderRadius: 12, animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
      {/* Chart panels */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="skeleton" style={{ height: 260, borderRadius: 12 }} />
        <div className="skeleton" style={{ height: 260, borderRadius: 12 }} />
      </div>
    </div>
  );
}

export function GenericSkeleton() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 300, padding: 24 }}>
      <div style={{ textAlign: "center" }}>
        <div className="skeleton" style={{ width: 48, height: 48, borderRadius: "50%", margin: "0 auto 16px" }} />
        <div className="skeleton" style={{ width: 160, height: 12, borderRadius: 6, margin: "0 auto" }} />
      </div>
    </div>
  );
}
