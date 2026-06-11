/**
 * Push Notification System — Web Push API integration.
 * Pattern from every major PWA marketplace (Coinbase, MetaMask).
 *
 * Notification types:
 *   - Floor price alerts (above/below threshold)
 *   - Outbid alerts (someone outbid you)
 *   - Whale activity (followed wallet made a move)
 *   - Sale confirmations (your NFT sold)
 *   - Prediction market results
 *   - Points milestone achievements
 *
 * --- Required Supabase table (run in SQL editor): ---
 *
 *   CREATE TABLE push_subscriptions (
 *     wallet text NOT NULL,
 *     endpoint text NOT NULL,
 *     keys jsonb NOT NULL,
 *     preferences jsonb DEFAULT '{"floor_alerts": true, "outbid": true, "whale_activity": true, "sales": true}',
 *     created_at timestamptz DEFAULT now(),
 *     PRIMARY KEY (wallet, endpoint)
 *   );
 *
 *   ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can manage own subs" ON push_subscriptions FOR ALL USING (true);
 */

// VAPID public key — generate with: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ═══ PUBLIC API ═══

/**
 * Check if push notifications are supported and permission status.
 */
export function getNotificationStatus() {
  if (!("Notification" in window)) return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!VAPID_PUBLIC_KEY) return "unconfigured";
  return Notification.permission; // "granted" | "denied" | "default"
}

/**
 * Request permission and subscribe to push notifications.
 */
// FIX (2026-06-11): this flow was dead end-to-end — no service worker file
// or registration ever existed, so `navigator.serviceWorker.ready` hung
// forever; and the writes used the anon client, which RLS (001: subs are
// keyed to the SIWE JWT wallet) correctly rejects. The worker now registers
// on demand and writes flow through /api/supabase-proxy, which attaches the
// httpOnly SIWE JWT — same pattern as DMs. Requires sign-in.
async function pushProxy(payload) {
  const res = await fetch("/api/supabase-proxy", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    const err = new Error("Sign in first — push subscriptions are tied to your wallet");
    err.needsAuth = true;
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Proxy ${res.status}`);
  }
  return res.json().catch(() => null);
}

async function getRegistration() {
  // Register (idempotent) instead of waiting on `.ready`, which never
  // resolves when no worker was registered.
  return navigator.serviceWorker.register("/push-sw.js");
}

export async function subscribeToPush(wallet) {
  if (!VAPID_PUBLIC_KEY || !wallet) return null;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const registration = await getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const sub = subscription.toJSON();
  // Flat p256dh/auth columns to match migration 002's canonical schema.
  await pushProxy({
    table: "push_subscriptions",
    method: "UPSERT",
    body: {
      wallet: wallet.toLowerCase(),
      endpoint: sub.endpoint,
      p256dh: sub.keys?.p256dh,
      auth: sub.keys?.auth,
    },
  });

  return subscription;
}

/**
 * Unsubscribe from push notifications. Server-side rows for this wallet are
 * removed wholesale (the proxy's filter charset can't carry endpoint URLs) —
 * push is per-wallet, so this disables it on all of the wallet's devices.
 */
export async function unsubscribeFromPush(wallet) {
  try {
    const registration = await getRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    if (wallet) {
      await pushProxy({
        table: "push_subscriptions",
        method: "DELETE",
        match: { wallet: wallet.toLowerCase() },
      });
    }
  } catch (err) {
    console.error("unsubscribeFromPush failed:", err);
  }
}

/**
 * Update notification preferences.
 */
// Per-type preferences are not yet persisted — migration 002's
// push_subscriptions schema has no preferences column. The bell is a single
// on/off for all trade alerts. No-op kept so callers don't break; wire a
// preferences column + this body when granular toggles ship.
export async function updatePreferences() {
  return;
}

/**
 * Check if currently subscribed.
 */
export async function isSubscribed() {
  try {
    // Passive check — don't force a registration just to look.
    const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch {
    return false;
  }
}

/**
 * Send a local notification (for testing / immediate alerts).
 */
export async function sendLocalNotification(title, body, url = "/") {
  try {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!("serviceWorker" in navigator)) return;

  const registration = await navigator.serviceWorker.register("/push-sw.js");
  await registration.showNotification(title, {
    body,
    icon: "/splash/skeleton.jpg",
    data: { url },
    tag: "local-" + (title || "notification").slice(0, 20),
    vibrate: [100, 50, 100],
  });
  } catch { /* SW unavailable on mobile private mode */ }
}
