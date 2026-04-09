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

import { supabase } from "./supabase";

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
export async function subscribeToPush(wallet) {
  if (!VAPID_PUBLIC_KEY || !wallet) return null;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const sub = subscription.toJSON();

    // Save to Supabase
    if (supabase) {
      await supabase.from("push_subscriptions").upsert({
        wallet: wallet.toLowerCase(),
        endpoint: sub.endpoint,
        keys: sub.keys,
      });
    }

    return subscription;
  } catch (err) {
    console.error("subscribeToPush failed:", err);
    return null;
  }
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(wallet) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      await subscription.unsubscribe();

      if (supabase && wallet) {
        await supabase
          .from("push_subscriptions")
          .delete()
          .eq("wallet", wallet.toLowerCase())
          .eq("endpoint", subscription.endpoint);
      }
    }
  } catch (err) {
    console.error("unsubscribeFromPush failed:", err);
  }
}

/**
 * Update notification preferences.
 */
export async function updatePreferences(wallet, preferences) {
  if (!supabase || !wallet) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    await supabase
      .from("push_subscriptions")
      .update({ preferences })
      .eq("wallet", wallet.toLowerCase())
      .eq("endpoint", subscription.endpoint);
  } catch (err) {
    console.error("updatePreferences failed:", err);
  }
}

/**
 * Check if currently subscribed.
 */
export async function isSubscribed() {
  try {
    const registration = await navigator.serviceWorker.ready;
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

  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(title, {
    body,
    icon: "/splash/skeleton.png",
    data: { url },
    tag: "local-" + Date.now(),
    vibrate: [100, 50, 100],
  });
  } catch { /* SW unavailable on mobile private mode */ }
}
