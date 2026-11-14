import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useMemo } from "react";

const STORAGE_KEY = "nakamigos_theme";

// The three colourways. Their colours live in App.css, keyed on the
// `theme-<id>` class this provider puts on the app box and on <body> (the
// pop-up menus are drawn at the end of <body>, outside the app box, and read
// the class from there). Nothing is written as an inline custom property any
// more, so `vars` is empty: the ids are kept because a visitor's saved choice
// is stored under them.
const themes = [
  { id: "default", label: "Lime", vars: {} },
  { id: "midnight", label: "Ice", vars: {} },
  { id: "sovereign", label: "Amber", vars: {} },
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

const THEME_BG = { default: "#0a0b0d", midnight: "#090b10", sovereign: "#0c0b0a" };

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

    // Also set on body: the pop-up menus are drawn at the end of <body>, outside
    // the app box, and App.css gives them their colourway from this class.
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
