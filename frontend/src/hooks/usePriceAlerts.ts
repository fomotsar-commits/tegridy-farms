import { useState, useEffect, useCallback, useRef } from 'react';

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
    const id = `${type}-${price}-${Date.now()}`;
    setAlerts((prev) => [...prev, { id, type, price, triggered: false }]);
  }, []);

  const removeAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearTriggered = useCallback(() => {
    setAlerts((prev) => prev.map((a) => (a.triggered ? { ...a, triggered: false } : a)));
  }, []);

  return { alerts, addAlert, removeAlert, clearTriggered };
}
