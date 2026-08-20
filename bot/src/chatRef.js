// The one-way door between a Telegram identity and anything this venue stores.
//
// `chat_ref = HMAC-SHA256(BOT_LINK_SECRET, 'tg:' || telegram_user_id)`, lowercase
// hex. The API derives the same value from the same secret (see
// frontend/api/_lib/botLink.js), and NOTHING else ever sees the numeric id.
//
// WHY A KEYED MAC AND NOT A HASH. Telegram user ids are small sequential
// integers. A plain SHA-256 of one is reversible by counting to it — a rainbow
// table over the whole id space is a few hours of laptop time. The secret is what
// makes a dump of `telegram_links` a list of wallets beside meaningless digests
// instead of a wallet-to-person map that anyone who obtains it can invert.
//
// WHAT ROTATING THE SECRET DOES, stated here because it is not recoverable: every
// existing binding becomes unreachable. The rows survive, the digests no longer
// match, and every linked chat silently reads as unlinked. That is a re-link for
// every user, so the secret is generated once and kept — see bot/DEPLOY.md §2.

import { createHmac } from "node:crypto";

/** Domain separator. Reserves room for a second identity source without collision. */
const CHAT_REF_PREFIX = "tg:";

export const CHAT_REF_RE = /^[0-9a-f]{64}$/;

/**
 * @param {string} secret BOT_LINK_SECRET, shared with the API and nothing else.
 * @param {number|string} telegramUserId The `from.id` of an incoming update.
 * @returns {string} 64 lowercase hex characters.
 */
export function deriveChatRef(secret, telegramUserId) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("deriveChatRef: no secret");
  }
  // Integers only. A caller that reaches here with an object or an empty string is
  // about to derive a ref that every such caller shares, which would join
  // unrelated chats onto one binding.
  const id = String(telegramUserId);
  if (!/^-?\d+$/.test(id)) {
    throw new Error("deriveChatRef: telegram user id must be an integer");
  }
  return createHmac("sha256", secret).update(`${CHAT_REF_PREFIX}${id}`, "utf8").digest("hex");
}
