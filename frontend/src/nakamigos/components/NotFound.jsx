export default function NotFound({ onGoHome }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", minHeight: "60vh", padding: "40px 20px",
        textAlign: "center",
      }}
    >
      <div style={{
        fontFamily: "var(--pixel)", fontSize: 64, color: "var(--gold)",
        lineHeight: 1, marginBottom: 16, opacity: 0.3,
      }}>
        404
      </div>
      <div style={{
        fontFamily: "var(--display)", fontSize: 20, fontWeight: 700,
        color: "var(--text)", marginBottom: 8,
      }}>
        Page Not Found
      </div>
      <div style={{
        fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)",
        maxWidth: 360, lineHeight: 1.6, marginBottom: 24,
      }}>
        This page doesn't exist. Maybe what you're looking for is back on the home page.
      </div>
      <button
        className="btn-primary"
        onClick={onGoHome || (() => { window.location.hash = "#/nakamigos/"; })}
        style={{ fontSize: 12, padding: "10px 28px" }}
      >
        Back to Home
      </button>
    </div>
  );
}
