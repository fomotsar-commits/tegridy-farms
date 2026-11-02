// Alerts to the owner. Always printed; also sent to Telegram when TELEGRAM_BOT_TOKEN
// and TELEGRAM_CHAT_ID are set. The token is never printed, and a failed send never
// stops the watch: the alert is still in the console and the log.

export const TELEGRAM_MAX_CHARS = 4000;

export function makeAlerter({ token = null, chat = null, fetchImpl = fetch, print = console.log } = {}) {
  return async function alert(text) {
    print(`ALERT  ${text}`);
    if (!token || !chat) return 'printed';
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: text.slice(0, TELEGRAM_MAX_CHARS), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        print(`ALERT  (Telegram refused it: HTTP ${res.status})`);
        return 'refused';
      }
      return 'sent';
    } catch {
      print('ALERT  (Telegram did not answer)');
      return 'unsent';
    }
  };
}

/**
 * Says each thing once, then again only when it has changed enough or enough time
 * has passed: an alert that repeats every 30 seconds stops being read.
 */
export function makeGate({ cooldownMs, now = () => Date.now() }) {
  const last = new Map();
  return function shouldSend(key, value = 0, moved = 1) {
    const prev = last.get(key);
    const t = now();
    if (prev && t - prev.t < cooldownMs && Math.abs(value - prev.value) < moved) return false;
    last.set(key, { t, value });
    return true;
  };
}
