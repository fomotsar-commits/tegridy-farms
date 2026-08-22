// The message this bot most needs to handle correctly is the one it never asked
// for: a user pasting a seed phrase or a private key into the chat.
//
// They do it because the bots that came before taught them to. Trojan and Banana
// Gun's onboarding is "we made you a wallet" or "import yours here", so by the time
// somebody reaches a Telegram bot for the third time, pasting twelve words into it
// is a learned, unremarkable act. This bot never asks — and a bot that never asks
// but silently ignores the paste is worse than useless at that moment, because the
// user has just published their key to a chat log and does not know it.
//
// WHAT THIS IS, EXACTLY: a heuristic tripwire, not a wall. It is worth being clear
// about its limits, because a guard that is trusted past its accuracy is how the
// one message it misses becomes the one that mattered.
//
//   * It matches SHAPES, not membership. `looksLikeMnemonic` does not carry the
//     BIP-39 word list; twelve arbitrary short lowercase words trip it. That is the
//     deliberate direction to be wrong in — a false alarm costs a user one line of
//     text, a false all-clear costs them their balance.
//   * A 64-character hex string is also the shape of a transaction hash, so the
//     copy this drives says so and tells the user to ignore it if that is what they
//     pasted. Naming the false positive is what keeps the warning credible enough
//     to be read the fifth time.
//   * It cannot see an image, a forwarded message's caption, or a file. A user who
//     screenshots their seed phrase gets no warning from this and never will.
//
// WHAT THE CALLER MUST DO WITH A HIT, and the reason the return value is a bare
// enum rather than the match: this module never returns, stores, echoes or logs the
// matched text, and neither may its caller. Quoting the offending words back into
// the chat — "did you mean to send `abandon abandon …`?" — would copy the secret
// into a second message and into the bot's own outbound log. `commands.test.js`
// pins that the reply contains none of the input.

/** Detection verdicts. `null` is the overwhelmingly common answer. */
export const SECRET_SHAPES = Object.freeze({
  MNEMONIC: "mnemonic",
  HEX_KEY: "hex-key",
  BASE58_KEY: "base58-key",
  KEY_ARRAY: "key-array",
});

/** The shortest BIP-39 phrase. A run this long is the trigger. */
const MNEMONIC_MIN_RUN = 12;

/** Every BIP-39 word is 3-8 lowercase letters. */
const WORD_RE = /^[a-z]{3,8}$/;

/**
 * A RUN of qualifying words anywhere in the message, not the whole message.
 *
 * Written the obvious way first — "is every token a word, and are there exactly
 * 12/15/…?" — and that missed the case this guard is most needed for.
 * `/import abandon ability able …` is thirteen tokens, one of which is a command,
 * so an exact-length check over the whole message let it through and the router
 * then answered it as a command with the phrase sitting untouched in the chat.
 * Users paste with a preamble ("here's my seed:") far more often than they paste
 * twelve bare words.
 *
 * Ordinary English rarely sustains twelve consecutive 3-8-letter lowercase words,
 * because articles and prepositions — a, an, in, of, to, is, it — are one or two
 * letters and break the run.
 */
function looksLikeMnemonic(text) {
  let run = 0;
  for (const token of text.trim().toLowerCase().split(/\s+/)) {
    run = WORD_RE.test(token) ? run + 1 : 0;
    if (run >= MNEMONIC_MIN_RUN) return true;
  }
  return false;
}

/**
 * 32 bytes of hex, standing alone.
 *
 * Anchored to token boundaries so a 64-hex substring inside a longer identifier
 * does not trip it. Shares its shape with a transaction hash — see the header.
 */
const HEX_32_RE = /(?:^|\s)(?:0x)?[0-9a-fA-F]{64}(?=\s|$)/;

/**
 * Base58 of a 64-byte Solana secret key: 87 or 88 characters. A base58 PUBLIC key
 * is 32-44 and must not match — public keys are the normal content of a message
 * here, and a bot that cried wolf over every mint address would train users to
 * dismiss the one warning that counts.
 */
const BASE58_64_RE = /(?:^|\s)[1-9A-HJ-NP-Za-km-z]{87,88}(?=\s|$)/;

/** The bracketed byte array a Solana wallet exports. Unmistakable. */
const KEY_ARRAY_RE = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/;

/**
 * @param {unknown} text A raw inbound message.
 * @returns {string|null} A member of SECRET_SHAPES, or null.
 */
export function detectSecretShape(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (looksLikeMnemonic(text)) return SECRET_SHAPES.MNEMONIC;
  if (KEY_ARRAY_RE.test(text)) return SECRET_SHAPES.KEY_ARRAY;
  if (BASE58_64_RE.test(text)) return SECRET_SHAPES.BASE58_KEY;
  if (HEX_32_RE.test(text)) return SECRET_SHAPES.HEX_KEY;
  return null;
}

/**
 * What to say. Every branch ends in the same instruction because there is only one
 * correct action once the paste has happened, and hedging it ("you may want to
 * consider…") is how a user talks themselves out of moving funds in time.
 */
export function secretWarning(shape) {
  const move =
    "Treat it as public from this moment. Move everything it controls to a wallet this phrase or key has never touched, then delete your message. Telegram messages persist on their servers and in every other member's client; deleting it does not un-publish it.";
  if (shape === SECRET_SHAPES.MNEMONIC) {
    return `⚠️ That looks like a recovery phrase, and you have just posted it into a chat.\n\n${move}\n\nThis bot never asks for a phrase, a key or a password, and it cannot use one. It only ever sends you a link to sign in your own wallet. Anything calling itself part of this venue and asking you to paste a phrase is not.`;
  }
  if (shape === SECRET_SHAPES.KEY_ARRAY || shape === SECRET_SHAPES.BASE58_KEY) {
    return `⚠️ That looks like an exported wallet key, and you have just posted it into a chat.\n\n${move}\n\nThis bot never asks for a key and cannot use one. It only ever sends you a link to sign in your own wallet.`;
  }
  return `⚠️ That is 32 bytes of hex. If it is a transaction hash, ignore this message — nothing is wrong.\n\nIf it is a private key: ${move}\n\nThis bot never asks for a key and cannot use one.`;
}
