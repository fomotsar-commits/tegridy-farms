// Telegram Bot API transport. Deliberately dependency-free.
//
// grammY and telegraf are the obvious choices and both are fine libraries. This
// file is ~120 lines of `fetch` against a documented HTTP API instead, for one
// reason that outweighs the convenience: this process holds a secret that
// authenticates it to the venue, and every transitive dependency it takes on is
// another package that could reach that secret in a postinstall script or a
// compromised release. The bot's whole claim is a small attack surface. Taking a
// 200-package tree to save 120 lines would be spending the claim to buy comfort.
//
// It also means `npm ci` here installs nothing, so the host has no lockfile drift
// and no advisory queue — see bot/DEPLOY.md §1.
//
// LONG POLLING, NOT A WEBHOOK. A webhook needs a public HTTPS endpoint, and the
// only one this project has is the Vercel deployment, which is at 11 of its 12
// function slots (frontend/api/SERVERLESS_BUDGET.md) and is the wrong shape for a
// bot anyway. Long polling works from a host with no inbound port at all, which is
// what most operators will actually have.

const API_BASE = "https://api.telegram.org";

/**
 * Telegram's own long-poll timeout plus headroom. The request is EXPECTED to sit
 * open for `timeoutSec` with no data; aborting at the same number would cancel
 * every successful idle poll.
 */
const POLL_HEADROOM_MS = 10_000;

/** Anything sent to a chat is short. This is a sanity bound, not a feature. */
export const MAX_MESSAGE_CHARS = 4000;

export class Telegram {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!token) throw new Error("Telegram: no token");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  /**
   * @param {string} method
   * @param {object} payload
   * @param {number} timeoutMs
   */
  async call(method, payload, timeoutMs = 15_000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true) {
        // The description is Telegram's, about our request, and safe to log. The
        // REQUEST is not: it may carry a message a user should not have sent.
        // Never widen this to include `payload`.
        const err = new Error(`telegram ${method} failed: ${body?.description ?? res.status}`);
        err.retryAfter = body?.parameters?.retry_after ?? null;
        throw err;
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {number} offset First update id to fetch.
   * @param {number} timeoutSec Telegram-side long-poll timeout.
   */
  async getUpdates(offset, timeoutSec) {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        // Only what this bot reads. Narrowing the subscription means the process
        // is never handed media, edits or channel posts it would have to decide
        // what to do with.
        allowed_updates: ["message"],
      },
      timeoutSec * 1000 + POLL_HEADROOM_MS,
    );
  }

  async sendMessage(chatId, text) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text,
      parse_mode: "Markdown",
      // Every link this bot sends is one the user is meant to open deliberately.
      // A preview card renders the destination's own title and image inside our
      // message, which is a surface we do not control sitting under our name.
      disable_web_page_preview: true,
    });
  }

  /** `getMe` doubles as the token check. Called once at boot. */
  async whoAmI() {
    return this.call("getMe", {});
  }
}

/**
 * Extract what the router needs, or null.
 *
 * Returns null for anything without a text body — photos, stickers, service
 * messages. Silence is right there: replying "I do not understand" to a sticker
 * trains users to ignore this bot's messages, and the one message it must not have
 * ignored is the secret-shaped one, which is text.
 */
export function extractMessage(update) {
  const msg = update?.message;
  if (!msg || typeof msg.text !== "string") return null;
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (typeof chatId !== "number" || typeof userId !== "number") return null;
  return { chatId, userId, text: msg.text };
}
