import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';

export interface PriceAlert {
  id: string;
  type: 'above' | 'below';
  price: number;
  triggered: boolean;
}

interface AlertsStore {
  alerts: PriceAlert[];
}

const STORAGE_KEY = 'tegridy-price-alerts';

// AUDIT USE-PRICE-ALERTS: cap alerts-per-wallet so a user can't accidentally
// fill their localStorage quota with thousands of one-off thresholds (the
// storage layer has a separate quota check but this is the UX-level cap).
// 20 is generous — nobody watches 20 price points manually.
const MAX_ALERTS = 20;

// Treat two alerts as duplicates when they target the same direction AND
// round to the same 6-decimal-places price. Prevents "Add" taps from
// stacking identical entries when the user is clicking fast or the UI
// re-fires the add.
function alertKey(type: 'above' | 'below', price: number): string {
  return `${type}:${price.toFixed(6)}`;
}

function loadAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: AlertsStore = JSON.parse(raw);
    return Array.isArray(parsed.alerts) ? parsed.alerts : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: PriceAlert[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ alerts }));
  } catch {}
}

function sendNotification(title: string, body: string) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/favicon.ico' }); } catch { /* Notification API unavailable */ }
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') { try { new Notification(title, { body, icon: '/favicon.ico' }); } catch { /* Notification API unavailable */ } }
    });
  }
}

export function usePriceAlerts(currentPrice: number) {
  const [alerts, setAlerts] = useState<PriceAlert[]>(loadAlerts);
  const prevPrice = useRef<number>(currentPrice);

  // Persist on change
  useEffect(() => { saveAlerts(alerts); }, [alerts]);

  // Check thresholds when price updates
  useEffect(() => {
    if (currentPrice <= 0) return;
    setAlerts((prev) => {
      let changed = false;
      const next = prev.map((a) => {
        if (a.triggered) return a;
        const crossed =
          (a.type === 'above' && currentPrice >= a.price && prevPrice.current < a.price) ||
          (a.type === 'below' && currentPrice <= a.price && prevPrice.current > a.price);
        if (crossed) {
          changed = true;
          sendNotification(
            'TOWELI Price Alert',
            `Price is now $${currentPrice.toFixed(6)} (crossed your $${a.price.toFixed(6)} ${a.type} threshold)`,
          );
          return { ...a, triggered: true };
        }
        return a;
      });
      prevPrice.current = currentPrice;
      return changed ? next : prev;
    });
  }, [currentPrice]);

  const addAlert = useCallback((type: 'above' | 'below', price: number) => {
    if (!Number.isFinite(price) || price <= 0) {
      toast.error('Price alerts require a positive price threshold.');
      return;
    }
    const id = `${type}-${price}-${Date.now()}`;
    const key = alertKey(type, price);
    setAlerts((prev) => {
      // Dedup: same type + same rounded price is a no-op. Surface the clash
      // so the user knows their click did something (even if nothing visibly
      // changed) rather than stacking silently-invisible duplicates.
      if (prev.some((a) => alertKey(a.type, a.price) === key)) {
        toast.info('That price alert is already set.');
        return prev;
      }
      if (prev.length >= MAX_ALERTS) {
        toast.error(`Up to ${MAX_ALERTS} price alerts per wallet. Delete one to add another.`);
        return prev;
      }
      return [...prev, { id, type, price, triggered: false }];
    });
  }, []);

  const removeAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearTriggered = useCallback(() => {
    setAlerts((prev) => prev.map((a) => (a.triggered ? { ...a, triggered: false } : a)));
  }, []);

  return { alerts, addAlert, removeAlert, clearTriggered };
}
