import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchCollectionStats, fetchActivity } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";
import { sendLocalNotification } from "../lib/notifications";

// ═══ CONSTANTS ═══
const CHECK_INTERVAL = 30000; // 30s polling
const STORAGE_PREFIX = "smart_alerts_";
const HISTORY_KEY_PREFIX = "smart_alerts_history_";
const MAX_HISTORY = 200;

// Default config for all alert types
const DEFAULT_CONFIG = {
  floor: { enabled: true, dropPercent: 10, risePercent: 10 },
  underpriced: { enabled: false, belowTraitFloorPercent: 20 },
  whale: { enabled: false, buyCount: 5, windowMinutes: 10 },
  volume: { enabled: false, spikeMultiplier: 3 },
  listingRate: { enabled: false, count: 20, windowMinutes: 60, normalRate: 4 },
  cooldown: 300000, // 5 min default
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

// ═══ STORAGE HELPERS ═══
function loadConfig(slug) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}config_${slug}`);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(slug, config) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}config_${slug}`, JSON.stringify(config));
  } catch { /* quota exceeded */ }
}

function loadHistory(slug) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY_PREFIX + (slug || "global"));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history, slug) {
  try {
    localStorage.setItem(HISTORY_KEY_PREFIX + (slug || "global"), JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch { /* quota exceeded */ }
}

function isInQuietHours(quietHours) {
  if (!quietHours.enabled) return false;
  const now = new Date();
  const hhmm = now.getHours() * 100 + now.getMinutes();
  const [sh, sm] = quietHours.start.split(":").map(Number);
  const [eh, em] = quietHours.end.split(":").map(Number);
  const start = sh * 100 + sm;
  const end = eh * 100 + em;
  if (start <= end) return hhmm >= start && hhmm < end;
  // Wraps midnight (e.g. 22:00 - 07:00)
  return hhmm >= start || hhmm < end;
}

function generateId() {
  return (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// ═══ HOOK ═══
export default function useSmartAlerts(addToast) {
  const collection = useActiveCollection();
  const [config, setConfig] = useState(() => loadConfig(collection.slug));
  const [history, setHistory] = useState(() => loadHistory(collection.slug));
  const [unreadCount, setUnreadCount] = useState(() => {
    const h = loadHistory(collection.slug);
    return h.filter(n => !n.read).length;
  });

  // Tracking refs for detecting changes between checks
  const prevFloorRef = useRef(null);
  const prevVolumeRef = useRef(null);
  const volumeHistoryRef = useRef([]);
  const prevListingCountRef = useRef(null);
  const prevListingTimeRef = useRef(null);
  const cooldownMapRef = useRef({}); // { alertType: lastFiredTimestamp }
  const configRef = useRef(config);
  const prevSlugRef = useRef(collection.slug);

  // Reset on collection change
  useEffect(() => {
    if (prevSlugRef.current !== collection.slug) {
      prevSlugRef.current = collection.slug;
      setConfig(loadConfig(collection.slug));
      setHistory(loadHistory(collection.slug));
      prevFloorRef.current = null;
      prevVolumeRef.current = null;
      volumeHistoryRef.current = [];
      prevListingCountRef.current = null;
      prevListingTimeRef.current = null;
      cooldownMapRef.current = {};
    }
  }, [collection.slug]);

  // Keep config ref in sync
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Persist config
  useEffect(() => {
    saveConfig(collection.slug, config);
  }, [config, collection.slug]);

  // Persist history (scoped per collection)
  useEffect(() => {
    saveHistory(history, collection.slug);
    setUnreadCount(history.filter(n => !n.read).length);
  }, [history, collection.slug]);

  // Fire an alert notification
  const fireAlert = useCallback((category, title, body) => {
    // Check cooldown
    const now = Date.now();
    const lastFired = cooldownMapRef.current[category] || 0;
    if (now - lastFired < config.cooldown) return;

    // Check quiet hours
    if (isInQuietHours(config.quietHours)) return;

    cooldownMapRef.current[category] = now;

    const notification = {
      id: generateId(),
      category,
      title,
      body,
      timestamp: new Date().toISOString(),
      read: false,
      collection: collection.name,
      slug: collection.slug,
    };

    setHistory(prev => [notification, ...prev].slice(0, MAX_HISTORY));

    // In-app toast
    if (addToast) addToast(body, "success");

    // Push notification when tab is inactive
    if (document.hidden) {
      sendLocalNotification(title, body).catch(() => {});
    }
  }, [config.cooldown, config.quietHours, addToast, collection.name, collection.slug]);

  // ═══ POLLING LOOP ═══
  useEffect(() => {
    let cancelled = false;

    async function check() {
      if (cancelled) return;
      const { contract, slug, openseaSlug } = collection;
      const cfg = configRef.current;

      try {
        // Fetch stats for floor / volume checks
        const stats = await fetchCollectionStats({ contract, slug, openseaSlug });

        if (cancelled) return;

        // --- Floor Price Alert ---
        if (cfg.floor.enabled && stats.floor != null) {
          const prev = prevFloorRef.current;
          if (prev != null && prev > 0) {
            const dropPct = ((prev - stats.floor) / prev) * 100;
            const risePct = ((stats.floor - prev) / prev) * 100;
            if (dropPct >= cfg.floor.dropPercent) {
              fireAlert(
                "floor_drop",
                `${collection.name} Floor Drop`,
                `Floor dropped ${dropPct.toFixed(1)}% from ${prev.toFixed(4)} to ${stats.floor.toFixed(4)} ETH`
              );
            } else if (risePct >= cfg.floor.risePercent) {
              fireAlert(
                "floor_rise",
                `${collection.name} Floor Rise`,
                `Floor rose ${risePct.toFixed(1)}% from ${prev.toFixed(4)} to ${stats.floor.toFixed(4)} ETH`
              );
            }
          }
          prevFloorRef.current = stats.floor;
        }

        // --- Volume Spike Alert ---
        if (cfg.volume.enabled && stats.volume != null) {
          const hist = volumeHistoryRef.current;
          if (hist.length > 0) {
            const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
            if (avg > 0) {
              const multiplier = stats.volume / avg;
              if (multiplier >= cfg.volume.spikeMultiplier) {
                fireAlert(
                  "activity",
                  `${collection.name} Volume Spike`,
                  `24h volume up ${Math.round((multiplier - 1) * 100)}% vs rolling avg (${stats.volume} ETH)`
                );
              }
            }
          }
          hist.push(stats.volume);
          if (hist.length > 10) hist.shift();
          prevVolumeRef.current = stats.volume;
        }
      } catch {
        // Silently fail — will retry next cycle
      }

      // --- Activity-based checks (whale + listing rate) ---
      try {
        const actData = await fetchActivity({ contract: collection.contract, limit: 50, daysBack: 1 });
        if (cancelled) return;
        const acts = actData.activities || [];

        // --- Whale Activity Alert ---
        if (cfg.whale.enabled && acts.length > 0) {
          const windowMs = cfg.whale.windowMinutes * 60 * 1000;
          const cutoff = Date.now() - windowMs;
          const recentBuys = acts.filter(a => a.type === "sale" && a.time >= cutoff);

          // Group by buyer address
          const buyerCounts = {};
          for (const buy of recentBuys) {
            const addr = buy.toFull || buy.to;
            if (addr) {
              buyerCounts[addr] = (buyerCounts[addr] || 0) + 1;
            }
          }

          // Group by seller address
          const sellerCounts = {};
          for (const buy of recentBuys) {
            const addr = buy.fromFull || buy.from;
            if (addr) {
              sellerCounts[addr] = (sellerCounts[addr] || 0) + 1;
            }
          }

          let whaleAlertFired = false;
          for (const [addr, count] of Object.entries(buyerCounts)) {
            if (count >= cfg.whale.buyCount) {
              const short = addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
              fireAlert(
                "whale",
                `${collection.name} Whale Activity`,
                `Wallet ${short} bought ${count} items in the last ${cfg.whale.windowMinutes} minutes`
              );
              whaleAlertFired = true;
              break; // One whale alert per check
            }
          }

          if (!whaleAlertFired) {
            for (const [addr, count] of Object.entries(sellerCounts)) {
              if (count >= 5) {
                const short = addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
                fireAlert(
                  "whale",
                  `${collection.name} Whale Dump`,
                  `Wallet ${short} sold ${count} items in the last ${cfg.whale.windowMinutes} minutes`
                );
                break;
              }
            }
          }
        }

        // --- Listing Rate Alert ---
        if (cfg.listingRate.enabled && acts.length > 0) {
          // Count listings (ask/list type) in the window
          const windowMs = cfg.listingRate.windowMinutes * 60 * 1000;
          const cutoff = Date.now() - windowMs;
          const recentListings = acts.filter(a =>
            (a.type === "ask" || a.type === "listing") && a.time >= cutoff
          );
          const count = recentListings.length;
          if (count >= cfg.listingRate.count) {
            const normalRate = Math.max(1, Math.round((collection.supply || 10000) / 2500));
            const multiplier = normalRate > 0
              ? (count / normalRate).toFixed(1)
              : count;
            fireAlert(
              "activity",
              `${collection.name} Listing Surge`,
              `${count} new listings in the last ${cfg.listingRate.windowMinutes} min (${multiplier}x normal rate)`
            );
          }
        }

        // --- Underpriced Listing Alert ---
        if (cfg.underpriced.enabled && acts.length > 0) {
          // Check if any listing is priced significantly below floor
          const floor = prevFloorRef.current;
          if (floor && floor > 0) {
            const threshold = floor * (1 - cfg.underpriced.belowTraitFloorPercent / 100);
            const underpriced = acts.find(a =>
              (a.type === "ask" || a.type === "listing") && a.price != null && a.price < threshold && a.price > 0
            );
            if (underpriced) {
              fireAlert(
                "price",
                `${collection.name} Underpriced Listing`,
                `Token ${underpriced.token?.name || "?"} listed at ${underpriced.price.toFixed(4)} ETH, ${cfg.underpriced.belowTraitFloorPercent}%+ below floor of ${floor.toFixed(4)} ETH`
              );
            }
          }
        }
      } catch {
        // Activity fetch failed — will retry next cycle
      }
    }

    check();
    const iv = setInterval(check, CHECK_INTERVAL);
    return () => { cancelled = true; clearInterval(iv); };
  }, [collection, fireAlert]);

  // ═══ PUBLIC API ═══
  const updateConfig = useCallback((updates) => {
    setConfig(prev => ({ ...prev, ...updates }));
  }, []);

  const markRead = useCallback((id) => {
    setHistory(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  }, []);

  const markAllRead = useCallback(() => {
    setHistory(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const removeNotification = useCallback((id) => {
    setHistory(prev => prev.filter(n => n.id !== id));
  }, []);

  return useMemo(() => ({
    config,
    updateConfig,
    history,
    unreadCount,
    markRead,
    markAllRead,
    clearHistory,
    removeNotification,
  }), [config, updateConfig, history, unreadCount, markRead, markAllRead, clearHistory, removeNotification]);
}
