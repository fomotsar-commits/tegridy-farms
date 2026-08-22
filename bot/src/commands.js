// The command router: text in, one reply out. The only module in this service that
// decides what a user is told, and therefore the only one worth reading closely.
//
// FOUR RULES, each of which has a test with its name on it.
//
//   1. THE SECRET CHECK RUNS FIRST, before the message is even parsed as a command.
//      A user pasting a seed phrase does not politely prefix it with a slash, and
//      `/import <phrase>` must warn rather than 404 into the help text — the help
//      text would scroll their phrase up the chat and say nothing about it.
//
//   2. NOTHING THAT MOVES VALUE IS EXECUTED. Not gated, not confirmed, not
//      queued — the capability is absent. `/buy`, `/sell`, `/withdraw` and their
//      neighbours all land in one handler that returns a LINK. This bot cannot
//      sign, so there is nothing here for a compromised bot host to abuse.
//
//   3. AN UNREAD SOURCE IS NEVER RENDERED AS A ZERO. Every read below returns a
//      discriminated result, and every failure branch prints what could not be read
//      and why. "You have no swaps" is only ever said after the indexer answered
//      READY. "You are not linked" is only ever said after the store answered.
//
//   4. NO REPLY ECHOES THE INPUT. Not for errors, not for the unknown-command
//      fallback, and above all not for a secret-shaped message. Echoing is how a
//      pasted key gets copied into a second message and into this process's own
//      outbound log.
//
// The router is PURE with respect to the network: every read arrives through the
// injected `deps`, so commands.test.js drives the full decision tree — including
// every failure branch — with no service running anywhere.

import { detectSecretShape, secretWarning } from "./secretGuard.js";
import { buildAppLink, buildLinkUrl, buildScanUrl, buildSwapUrl } from "./deepLink.js";
import { describeCapabilities } from "./config.js";

/** EVM address, for the optional argument to /heat and /scan. */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Commands that would move value on any other bot on this surface.
 *
 * Enumerated rather than pattern-matched so the refusal is a deliberate list
 * somebody has to edit, and so a user typing the muscle-memory command from a
 * different bot gets the explanation instead of the help text.
 */
const VALUE_MOVING = new Set([
  "buy",
  "sell",
  "swap",
  "trade",
  "snipe",
  "ape",
  "withdraw",
  "send",
  "transfer",
  "approve",
  "bridge",
  "limit",
  "stop",
  "wallet",
  "import",
  "export",
  "deposit",
]);

const SHORT = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export function parseCommand(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text.startsWith("/")) return { command: null, args: [], text };
  // Telegram appends `@botname` to commands in group chats.
  const [head, ...args] = text.slice(1).split(/\s+/);
  return { command: head.split("@")[0].toLowerCase(), args, text };
}

const HELP = [
  "*What this bot does*",
  "",
  "/link — bind this chat to your wallet by signing in the app",
  "/status — what this chat is linked to, and what I can currently read",
  "/unlink — cut the binding immediately",
  "/heat `[address]` — Jungle Bay Island's held-time reading",
  "/history — your venue-routed swaps",
  "/scan `<token>` — open the holder-concentration scanner",
  "",
  "*What it will never do*",
  "",
  "It never asks for a recovery phrase, a private key or a password, and it could not use one if you sent it. It holds no key and can sign nothing. Every action that moves value comes back as a link you open and sign in your own wallet.",
  "",
  "If anything calling itself part of this venue asks you to paste a phrase or import a wallet, it is not us.",
].join("\n");

function notLinked() {
  return "This chat is not linked to a wallet yet. Send /link and I will give you a code to carry to the app.";
}

/**
 * Render a venue/indexer failure.
 *
 * One shape for all of them so a failure never reads like a result. The operator
 * step is included when the venue supplied one — a user who reports "it says the
 * migration is not applied" gets fixed faster than one who reports "it is broken".
 */
function failure(what, result) {
  const step = result.operatorStep ? `\n\nOperator: ${result.operatorStep}` : "";
  return `${what}\n\n${result.detail}${step}`;
}

export async function handleMessage({ text, chatRef }, deps) {
  const { cfg, venue, indexer } = deps;

  // RULE 1. Before parsing, before routing, before anything.
  const shape = detectSecretShape(text);
  if (shape) return { text: secretWarning(shape) };

  const { command, args } = parseCommand(text);

  if (!command || command === "start" || command === "help") {
    return { text: HELP };
  }

  if (VALUE_MOVING.has(command)) {
    return { text: refuseValueMoving(cfg, command) };
  }

  if (command === "link") return { text: await doLink(cfg, venue, chatRef) };
  if (command === "status") return { text: await doStatus(cfg, venue, chatRef) };
  if (command === "unlink") return { text: await doUnlink(cfg, venue, chatRef) };
  if (command === "heat") return { text: await doHeat(cfg, venue, chatRef, args[0]) };
  if (command === "history") return { text: await doHistory(cfg, venue, indexer, chatRef) };
  if (command === "scan") return { text: doScan(cfg, args[0]) };
  if (command === "alerts") return { text: doAlerts(cfg) };

  // RULE 4: names no part of what was typed.
  return { text: `I do not have that command.\n\n${HELP}` };
}

/**
 * The refusal, and the reason, every single time.
 *
 * It does not apologise and it does not describe the capability as "coming soon",
 * because it is not coming. The two largest bots on this surface both executed
 * trades in-chat and both were drained through the keys that made that possible;
 * this venue decided the trade-off in the other direction and the user is told
 * which trade-off they are getting.
 */
function refuseValueMoving(cfg, command) {
  const link = buildSwapUrl(cfg.appOrigin);
  return [
    `I cannot ${command} for you, and that is the design rather than a missing feature.`,
    "",
    "Executing a trade from a chat means a server holds a key that can spend your money. The two biggest bots on this surface worked that way and both were drained through it. This one holds no key, so there is nothing here to steal and nothing here to misuse.",
    "",
    `Trade here instead — your wallet signs, in front of you: ${link}`,
  ].join("\n");
}

async function doLink(cfg, venue, chatRef) {
  const result = await venue.beginLink(cfg, chatRef);
  if (!result.ok) {
    if (result.code === "already-linked") {
      const w = typeof result.wallet === "string" ? SHORT(result.wallet) : "a wallet";
      return `This chat is already linked to ${w}. Send /unlink first if you want to bind a different one — a chat points at exactly one wallet.`;
    }
    return failure("I could not mint a link code, so this chat is unchanged.", result);
  }

  const { code, expiresAt } = result.data;
  let url;
  try {
    url = buildLinkUrl(cfg.appOrigin, code);
  } catch {
    return "I minted a code but could not build a link to the app on this deployment. Report this — the code is unusable without it.";
  }
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60000));
  return [
    "*Link this chat to your wallet*",
    "",
    `1. Open ${url}`,
    "2. Connect your wallet and sign the sign-in message.",
    `3. The code \`${code}\` is already in that link. It works once and expires in about ${minutes} minutes.`,
    "",
    "The signature is how you prove the wallet is yours. I never see a key, and signing that message does not approve any spending — read it before you sign, here and everywhere else.",
  ].join("\n");
}

async function doStatus(cfg, venue, chatRef) {
  const result = await venue.readLink(cfg, chatRef);
  const caps = describeCapabilities(cfg)
    .map((c) => `${c.available ? "✅" : "⚠️"} ${c.label} — ${c.detail}`)
    .join("\n\n");

  if (!result.ok) {
    // Deliberately NOT "you are not linked". The store did not answer, so this
    // process does not know, and saying otherwise would be a claim about a binding
    // that may well exist.
    return `${failure("I could not read whether this chat is linked.", result)}\n\n*What I can read when things are working*\n\n${caps}`;
  }

  const head = result.data.linked
    ? `This chat is linked to \`${result.data.wallet}\`.`
    : "This chat is not linked to any wallet.";
  return `${head}\n\n*What I can read*\n\n${caps}`;
}

async function doUnlink(cfg, venue, chatRef) {
  const result = await venue.revokeLink(cfg, chatRef);
  if (!result.ok) {
    // "Still in place" rather than a vague error: a user who believes they are
    // unlinked stops watching a binding that is live.
    return failure("The binding was NOT removed and is still in place.", result);
  }
  return result.data.removed > 0
    ? "Unlinked. This chat is bound to nothing and I can no longer answer anything about that wallet."
    : "There was nothing to unlink — this chat was not bound to a wallet.";
}

async function doHeat(cfg, venue, chatRef, arg) {
  let address = typeof arg === "string" ? arg.trim() : "";
  if (address && !EVM_ADDRESS_RE.test(address) && !SOLANA_ADDRESS_RE.test(address)) {
    return "That does not look like an Ethereum or Solana address, so I did not look it up.";
  }
  if (!address) {
    const link = await venue.readLink(cfg, chatRef);
    if (!link.ok) return failure("I could not find out which wallet to read.", link);
    if (!link.data.linked) return notLinked();
    address = link.data.wallet;
  }

  const result = await venue.readHeat(cfg, address);
  if (!result.ok) {
    return failure(`I could not read a Heat standing for ${SHORT(address)}.`, result);
  }
  const { degrees, tier, as_of_unix: asOf } = result.data;
  const when = Number.isFinite(asOf) ? new Date(asOf * 1000).toISOString().slice(0, 10) : "an unstated date";
  return [
    `*Heat — ${SHORT(address)}*`,
    "",
    `${degrees}° · ${tier ?? "no tier reported"}`,
    "",
    `Reckoned by Jungle Bay Island on ${when}. This is their measurement of how long a wallet has held, forwarded unchanged. It is not a yield, not a price and not a score of ours, and a reading older than you expect certifies nothing about today.`,
  ].join("\n");
}

async function doHistory(cfg, venue, indexer, chatRef) {
  const link = await venue.readLink(cfg, chatRef);
  if (!link.ok) return failure("I could not find out which wallet to read.", link);
  if (!link.data.linked) return notLinked();

  const result = await indexer.recentSwaps(cfg, link.data.wallet, 5);
  if (!result.ok) {
    return failure("I have no swap history to show you, and that is not the same as you having none.", result);
  }
  if (result.items.length === 0) {
    // Only reachable after the indexer reported READY — see indexerClient.query.
    return "No venue-routed swaps for that wallet. This table only holds swaps that went through the venue's own router, so trades made anywhere else are not counted here and are not missing from the chain.";
  }
  const lines = result.items.map((s) => {
    const when = new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " ");
    return `• ${when} — ${SHORT(String(s.tokenIn))} → ${SHORT(String(s.tokenOut))}`;
  });
  return [
    `*Last ${result.items.length} venue-routed swaps*`,
    "",
    ...lines,
    "",
    `Indexed to block ${result.syncedBlock ?? "an unreported height"}. Amounts are deliberately not shown here — they need decimals this bot does not read, and a number rendered with the wrong ones is worse than no number.`,
  ].join("\n");
}

function doScan(cfg, token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t || (!EVM_ADDRESS_RE.test(t) && !SOLANA_ADDRESS_RE.test(t))) {
    return "Send /scan followed by a token address, e.g. `/scan 0x…`.";
  }
  let url;
  try {
    url = buildScanUrl(cfg.appOrigin, t);
  } catch {
    return "I could not build a scanner link on this deployment.";
  }
  // The scan itself is not run here. It is a multi-page read with disclosed
  // exclusions and a timestamp, and compressing it into a chat line would drop
  // exactly the caveats that make it honest.
  return `Holder concentration and distribution for that token, with the method and exclusions stated: ${url}`;
}

/**
 * The alerts answer, which is mostly a correction.
 *
 * Users arrive expecting a bot that messages them when something moves, because
 * every other bot on this surface claims to. Nothing in this venue runs on a
 * schedule — no keeper, no worker — so promising delivery here would be a promise
 * kept by nobody, and the user finds out by missing the event it was for.
 */
function doAlerts(cfg) {
  return [
    "*Alerts do not reach this chat, and I will not pretend otherwise.*",
    "",
    "Nothing in this venue runs on a schedule. Alert rules are stored against your wallet and evaluated in your browser while the app is open — when the tab is shut, nothing is watching, and no message will arrive here.",
    "",
    `Rules, inbox and the delivery report: ${buildAppLink(cfg.appOrigin, "/alerts")}`,
    "",
    "When a service exists that can watch a rule, this chat becomes one of the places it can deliver to. It does not exist yet.",
  ].join("\n");
}
