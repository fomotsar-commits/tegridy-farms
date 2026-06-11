/**
 * Server-side web-push sender for trade events.
 *
 * Graceful no-op when VAPID keys are unset — push is an optional layer and
 * must never fail a trade write. Dead subscriptions (404/410 from the push
 * service) are pruned opportunistically.
 *
 * Required env (operator: `npx web-push generate-vapid-keys`):
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  — the key pair
 *   VITE_VAPID_PUBLIC_KEY                 — same public key, for the client
 *   VAPID_SUBJECT                         — mailto: contact (optional)
 */

import webpush from "web-push";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:ops@tegridyfarms.vercel.app", pub, priv);
  configured = true;
  return true;
}

/**
 * Send a push to every subscription a wallet has. Never throws; bounded so
 * it can run inline before the API response without meaningful latency.
 *
 * @param {object} supabase service-role client
 * @param {string} wallet   lowercase recipient wallet
 * @param {{title:string, body:string, url?:string, tag?:string}} payload
 */
export async function sendPushToWallet(supabase, wallet, payload) {
  try {
    if (!ensureConfigured() || !supabase || !wallet) return;
    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("endpoint, keys")
      .eq("wallet", wallet.toLowerCase())
      .limit(10);
    if (!subs || subs.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 3600 }
        );
      } catch (err) {
        // 404/410 = the browser dropped the subscription — prune it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("wallet", wallet.toLowerCase())
            .eq("endpoint", sub.endpoint);
        }
      }
    }));
  } catch (err) {
    console.error("[push] send failed:", err?.message ?? err);
  }
}
