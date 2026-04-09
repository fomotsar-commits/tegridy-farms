import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";

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

function applyTheme(themeId) {
  const themeDef = themes.find((t) => t.id === themeId);
  if (!themeDef) return;

  // Apply CSS variables to the .nakamigos-app wrapper (scoped, not :root)
  const appEl = document.querySelector(".nakamigos-app");
  if (appEl) {
    Object.entries(themeDef.vars).forEach(([prop, value]) => {
      appEl.style.setProperty(prop, value);
    });
    // Theme classes on the wrapper element (CSS is scoped to .nakamigos-app.theme-*)
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

  // Apply CSS variables and body class whenever theme changes
  useEffect(() => {
    applyTheme(theme);
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
