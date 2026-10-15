import React from "react";

// Detects chunk load failures from code splitting after deployments
function isChunkLoadError(error) {
  const msg = error?.message || "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Loading chunk") ||
    msg.includes("Loading CSS chunk") ||
    msg.includes("Importing a module script failed")
  );
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    // No reload from here: the marketplace cannot tell when a wallet prompt is open
    // (App.jsx holds the page). A chunk that failed gets the Reload button below.
  }

  render() {
    if (this.state.hasError) {
      const isChunk = isChunkLoadError(this.state.error);

      return (
        <div
          role="alert"
          style={{
            padding: "40px 24px",
            textAlign: "center",
            maxWidth: 600,
            margin: "40px auto",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              margin: "0 auto 20px",
              borderRadius: "50%",
              background: "rgba(248,113,113,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
            }}
          >
            &#9888;
          </div>
          <h2
            style={{
              fontFamily: "var(--display, system-ui)",
              fontSize: 20,
              color: "var(--text, #eee)",
              marginBottom: 12,
              fontWeight: 700,
            }}
          >
            {this.props.title || "Something went wrong"}
          </h2>
          <p
            style={{
              fontFamily: "var(--mono, monospace)",
              fontSize: 11,
              color: "var(--text-dim)",
              lineHeight: 1.6,
              marginBottom: 20,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              textAlign: "left",
              userSelect: "text",
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {isChunk
              ? "A new version of the app is available. Please reload to get the latest version."
              : (this.state.error?.message || "An unexpected error occurred.")
                // Only surface the raw stack trace in dev — a retail user
                // shouldn't see an internal trace (F545).
                + (import.meta.env.DEV && this.state.error?.stack ? "\n\n" + this.state.error.stack : "")}
          </p>
          <button
            onClick={() => {
              if (isChunk) {
                window.location.reload();
              } else {
                this.setState({ hasError: false, error: null });
                if (this.props.onReset) this.props.onReset();
              }
            }}
            style={{
              fontFamily: "var(--display, system-ui)",
              fontSize: 13,
              fontWeight: 700,
              color: "var(--bg)",
              background: "var(--gold, #d4a843)",
              border: "none",
              borderRadius: 8,
              padding: "10px 24px",
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            {isChunk ? "Reload Page" : "Try Again"}
          </button>
          {!isChunk && (
            <button
              onClick={() => {
                // Hard navigation — a hash write does NOT change the pathname
                // under BrowserRouter, so the crashing route would re-render and
                // re-catch, trapping the user in a loop (F529). A full document
                // load guarantees a clean escape. Matches the app-level boundary.
                window.location.href = "/nakamigos";
              }}
              style={{
                fontFamily: "var(--display, system-ui)",
                fontSize: 13,
                fontWeight: 700,
                color: "var(--text-dim, #999)",
                background: "transparent",
                border: "1px solid var(--border, #333)",
                borderRadius: 8,
                padding: "10px 24px",
                cursor: "pointer",
                letterSpacing: "0.04em",
                marginTop: 8,
              }}
            >
              Go Home
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
