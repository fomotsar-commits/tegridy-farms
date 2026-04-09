import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";

const STORAGE_KEY = "nakamigos_trading_mode";

/**
 * TradingModeContext — provides a "lite" / "pro" toggle for the entire app.
 *
 * Lite mode hides advanced trading tools and simplifies the UI for casual users.
 * Pro mode shows every feature (the current default behaviour).
 *
 * Persists preference to localStorage. Default for new users: "lite".
 */

// Tabs hidden from primary nav in Lite mode
export const LITE_HIDDEN_PRIMARY = new Set(["deals", "portfolio", "analytics"]);

// Tabs hidden from "More" menu in Lite mode
export const LITE_HIDDEN_MORE = new Set([
  "sniper", "trade", "watchlist", "bids", "my-listings", "alerts",
]);

// Combined set for mobile nav filtering
export const LITE_HIDDEN_ALL = new Set([...LITE_HIDDEN_PRIMARY, ...LITE_HIDDEN_MORE]);

function getInitialMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "lite" || stored === "pro") return stored;
  } catch {
    // localStorage unavailable
  }
  return "lite";
}

const TradingModeContext = createContext(undefined);

export function TradingModeProvider({ children }) {
  const [mode, setModeState] = useState(getInitialMode);

  const setMode = useCallback((next) => {
    if (next !== "lite" && next !== "pro") return;
    setModeState(next);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((cur) => (cur === "lite" ? "pro" : "lite"));
  }, []);

  const isLite = mode === "lite";
  const isPro = mode === "pro";

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage unavailable
    }
  }, [mode]);

  const value = useMemo(
    () => ({ mode, setMode, toggleMode, isLite, isPro }),
    [mode, setMode, toggleMode, isLite, isPro],
  );

  return (
    <TradingModeContext.Provider value={value}>
      {children}
    </TradingModeContext.Provider>
  );
}

export function useTradingMode() {
  const context = useContext(TradingModeContext);
  if (context === undefined) {
    throw new Error("useTradingMode must be used within a TradingModeProvider");
  }
  return context;
}
