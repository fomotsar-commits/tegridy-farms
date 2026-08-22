import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";

const STORAGE_KEY = "nakamigos_theme";

const themes = [
  {
    id: "default",
    label: "Default",
    vars: {
      "--bg": "#09090b",
      "--surface": "#101012",
      "--surface-glass": "rgba(16, 16, 18, 0.6)",
      "--surface-hover": "#151517",
      "--border": "rgba(255, 255, 255, 0.04)",
      "--border-gold": "rgba(200, 170, 100, 0.08)",
      "--text": "#e5e5e5",
      "--text-dim": "#888",
      "--text-muted": "#6b6b6b",
      "--text-faint": "#555",
      "--card": "#131315",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    vars: {
      "--bg": "#070810",
      "--surface": "#0d0e16",
      "--surface-glass": "rgba(12, 14, 22, 0.6)",
      "--surface-hover": "#12131d",
      "--border": "rgba(100, 160, 235, 0.06)",
      "--border-gold": "rgba(100, 160, 235, 0.1)",
      "--text": "#e0e8f0",
      "--text-dim": "#5a6a80",
      "--text-muted": "#3a4558",
      "--text-faint": "#2a3345",
      "--card": "#0a0b14",
      "--gold": "#4fc3f7",
      "--gold-dim": "#39a0d4",
      "--gold-glow": "rgba(79, 195, 247, 0.25)",
      "--naka-blue": "#81d4fa",
      "--naka-sky": "#b3e5fc",
      "--naka-glow": "rgba(79, 195, 247, 0.2)",
      "--green": "#4ade80",
      "--red": "#ff6b6b",
      "--yellow": "#fdd835",
      "--purple": "#b388ff",
    },
  },
  {
    id: "sovereign",
    label: "Sovereign",
    vars: {
      "--bg": "#0a0e1a",
      "--surface": "#0f1426",
      "--surface-glass": "rgba(15, 20, 38, 0.7)",
      "--surface-hover": "#141a30",
      "--border": "rgba(200, 170, 100, 0.08)",
      "--border-gold": "rgba(200, 170, 100, 0.15)",
      "--text": "#e8dcc8",
      "--text-dim": "#8a7e6a",
      "--text-muted": "#5a5040",
      "--text-faint": "#3a3228",
      "--card": "#0d1220",
    },
  },
];

const themeIds = themes.map((t) => t.id);

function getInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && themeIds.includes(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }

  return "default";
}

const THEME_BG = { default: "#09090b", midnight: "#070810", sovereign: "#0a0e1a" };

// Every custom property any theme writes. Used to snapshot/restore the fallback
// target (document.body) — applyTheme falls back to it when `.nakamigos-app`
// isn't mounted yet, and body outlives this sub-app.
const ALL_THEME_VARS = [...new Set(themes.flatMap((t) => Object.keys(t.vars)))];

// The nodes below are shared with the MAIN app, which owns them: it writes
// documentElement[data-theme] = "dark"|"light" and a matching meta theme-color
// once, on ITS theme change. This sub-app's theme ids ("midnight", …) match
// none of the main app's `[data-theme="light"]` rules, so leaving Tradermigos
// used to strand the whole site on a value nothing styles — the main provider
// never re-runs to correct it, and the user's light mode silently died (F531).
// The snapshot is taken before the first applyTheme and handed back on unmount.
function snapshotGlobalTheme() {
  try {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    return {
      rootTheme: root.getAttribute("data-theme"),
      bodyTheme: document.body.getAttribute("data-theme"),
      bodyThemeClasses: themeIds.filter((id) => document.body.classList.contains(`theme-${id}`)),
      bodyVars: ALL_THEME_VARS.map((prop) => [prop, document.body.style.getPropertyValue(prop)]),
      meta,
      metaColor: meta ? meta.getAttribute("content") : null,
    };
  } catch {
    return null;
  }
}

function restoreGlobalTheme(snapshot) {
  if (!snapshot) return;
  try {
    const root = document.documentElement;
    if (snapshot.rootTheme == null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", snapshot.rootTheme);

    if (snapshot.bodyTheme == null) document.body.removeAttribute("data-theme");
    else document.body.setAttribute("data-theme", snapshot.bodyTheme);

    // Only theme-* classes are ours; anything else on body belongs to another
    // owner and must survive.
    themeIds.forEach((id) => document.body.classList.remove(`theme-${id}`));
    snapshot.bodyThemeClasses.forEach((id) => document.body.classList.add(`theme-${id}`));

    for (const [prop, value] of snapshot.bodyVars) {
      if (value) document.body.style.setProperty(prop, value);
      else document.body.style.removeProperty(prop);
    }

    if (snapshot.meta) {
      if (snapshot.metaColor == null) snapshot.meta.removeAttribute("content");
      else snapshot.meta.setAttribute("content", snapshot.metaColor);
    }
  } catch {
    // SecurityError on some mobile browsers (private mode, sandboxed iframe)
  }
}

function applyTheme(themeId) {
  const themeDef = themes.find((t) => t.id === themeId);
  if (!themeDef) return;

  try {
    // Apply CSS variables to the .nakamigos-app wrapper (scoped, not :root)
    const appEl = document.querySelector(".nakamigos-app") || document.body;
    if (appEl) {
      Object.entries(themeDef.vars).forEach(([prop, value]) => {
        appEl.style.setProperty(prop, value);
      });
      themeIds.forEach((id) => appEl.classList.remove(`theme-${id}`));
      appEl.classList.add(`theme-${themeId}`);
      appEl.setAttribute("data-theme", themeId);
    }

    // Also set on body for the Background component which reads document.body.className
    themeIds.forEach((id) => document.body.classList.remove(`theme-${id}`));
    document.body.classList.add(`theme-${themeId}`);
    document.documentElement.setAttribute("data-theme", themeId);

    // Update meta theme-color so the browser chrome matches the theme
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && THEME_BG[themeId]) {
      meta.setAttribute("content", THEME_BG[themeId]);
    }
  } catch {
    // SecurityError on some mobile browsers (private mode, sandboxed iframe)
  }
}

const ThemeContext = createContext(undefined);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);

  const setTheme = useCallback((nextTheme) => {
    if (!themeIds.includes(nextTheme)) return;
    setThemeState(nextTheme);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((current) => {
      const idx = themeIds.indexOf(current);
      return themeIds[(idx + 1) % themeIds.length];
    });
  }, []);

  // Declared BEFORE the apply effect so it snapshots the untouched values, and
  // as a layout effect so the handback lands in the unmount commit — before the
  // browser paints the main app again, which is what keeps it flash-free.
  useLayoutEffect(() => {
    const snapshot = snapshotGlobalTheme();
    return () => restoreGlobalTheme(snapshot);
  }, []);

  // Apply CSS variables and body class whenever theme changes
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  const value = useMemo(
    () => ({ theme, setTheme, themes, cycleTheme }),
    [theme, setTheme, cycleTheme]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
