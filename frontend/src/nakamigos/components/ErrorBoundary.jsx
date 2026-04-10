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

    // Auto-reload on chunk load failures (stale deployment cache) — max 3 attempts
    try {
      if (isChunkLoadError(error)) {
        const reloadKey = "app_chunk_reload";
        const countKey = "app_chunk_reload_count";
        const lastReload = sessionStorage.getItem(reloadKey);
        const reloadCount = parseInt(sessionStorage.getItem(countKey) || "0", 10);
        const now = Date.now();
        if (reloadCount < 3 && (!lastReload || now - parseInt(lastReload, 10) > 30000)) {
          sessionStorage.setItem(reloadKey, String(now));
          sessionStorage.setItem(countKey, String(reloadCount + 1));
          window.location.reload();
          return;
        }
      }
    } catch {
      // sessionStorage unavailable (mobile private mode)
    }
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
              : (this.state.error?.message || "An unexpected error occurred.") + "\n\n" + (this.state.error?.stack || "")}
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
                this.setState({ hasError: false, error: null });
                window.location.hash = "#/nakamigos/";
                if (this.props.onReset) this.props.onReset();
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
