import { createContext, useContext, useEffect, type ReactNode } from 'react';

/**
 * THE APP IS DARK-ONLY. Light mode was removed 2026-08-23.
 *
 * It carried an app-wide ~1.5:1 contrast defect — the Kenny-orange day palette put
 * low-contrast text on a saturated ground — and the operator's call was to drop it
 * rather than re-tune every surface for a theme nobody had asked for. The 23
 * `[data-theme="light"]` rule blocks are gone from `index.css`.
 *
 * This context is KEPT rather than deleted, deliberately. Five components branch on
 * `isDark` for inline styles; with `isDark` a constant `true` those branches are
 * unreachable rather than wrong, and collapsing them is cosmetic work that does not
 * need to happen in the same change as the behavioural removal. Deleting the context
 * would have meant editing all five in the same commit as the CSS, which is exactly
 * how a visual regression gets in unnoticed.
 *
 * ⚠️ THE MIGRATION BELOW IS LOAD-BEARING. Anyone who had toggled light has
 * `tegridy-theme: 'light'` in localStorage. Without clearing it, a returning visitor
 * would get `data-theme="light"` stamped on the root with no light CSS behind it —
 * a half-styled page that looks broken rather than dark. The stored value is
 * removed, not just ignored, so the state cannot come back if light is ever
 * reintroduced under different rules.
 */

type Theme = 'dark';

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = 'tegridy-theme';

/** Frozen so a consumer cannot mutate the shared value into a light state. */
const DARK_ONLY: ThemeContextValue = Object.freeze({ theme: 'dark', isDark: true });

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#060c1a');
    try {
      // Clear, don't overwrite: see the migration note above.
      if (localStorage.getItem(STORAGE_KEY) !== null) localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  return (
    <ThemeContext.Provider value={DARK_ONLY}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
