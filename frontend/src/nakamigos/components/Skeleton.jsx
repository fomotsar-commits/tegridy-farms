export default function Skeleton({ count = 8, view = "gallery" }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="skeleton-card card-reveal" style={{ animationDelay: `${i * 50}ms` }}>
      <div className="skeleton skeleton-image" />
      <div className="skeleton-info">
        <div className="skeleton skeleton-line" style={{ width: "75%" }} />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  ));
}
