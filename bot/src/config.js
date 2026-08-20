// Everything this process reads from its environment, and — just as important —
// what it refuses to do when a piece is missing.
//
// THE RULE THIS FILE ENFORCES: an unset variable degrades one capability to an
// explicit "unavailable", never to a plausible answer. A bot that answers "you
// hold nothing" because its indexer URL is unset has told a user something false
// about their money, and it looked exactly like the truth. So every capability
// below is a tri-state — on, off with a reason, misconfigured with a reason — and
// `describeCapabilities()` is what /status prints so the reason is one message
// away rather than buried in a log the user cannot read.
//
// There is no variable here that holds, unlocks or derives a key, and there never
// will be. `frontend/api/__tests__/bot-noncustodial.test.js` scans this whole
// directory and fails the build if one appears. It lives on the frontend side
// deliberately: that suite runs on every change to the repo, so the guard cannot be
// skipped by anyone who never touches the bot.

/** Read once, at boot, so nothing snapshots a value mid-flight. */
export function loadConfig(env = process.env) {
  return {
    botToken: str(env.TELEGRAM_BOT_TOKEN),
    linkSecret: str(env.BOT_LINK_SECRET),
    venueOrigin: origin(env.VENUE_ORIGIN) ?? "https://memetic.fun",
    appOrigin: origin(env.APP_ORIGIN) ?? "https://memetic.fun",
    // Same variable name and same meaning as the frontend's VITE_INDEXER_URL: the
    // PUBLIC PROXY origin of the Ponder service, no path. Its absence IS the gate
    // — see indexer/DEPLOY.md §5 and src/lib/indexer/client.ts.
    indexerUrl: origin(env.INDEXER_URL),
    indexerUrlRaw: str(env.INDEXER_URL),
    pollTimeoutSec: int(env.TELEGRAM_POLL_TIMEOUT_SEC, 30),
  };
}

function str(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

function int(v, fallback) {
  const n = Number(str(v));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * An http(s) origin with any trailing path stripped, or null.
 *
 * A relative or exotic-scheme value must not survive into a fetch — it would fail
 * in a way that reads as an outage of the service rather than as the typo it is.
 * Same reasoning as `indexerOrigin()` in src/lib/indexer/client.ts.
 */
function origin(v) {
  const raw = str(v);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * The two variables without which there is no bot at all.
 *
 * Deliberately fatal rather than degraded: with no token nothing can be received,
 * and with no secret every chat derives the same ref, which would join unrelated
 * users onto one binding. Starting anyway and reporting per-message would mean a
 * misconfigured deploy looks alive in the platform dashboard.
 */
export function fatalConfigProblems(cfg) {
  const out = [];
  if (!cfg.botToken) {
    out.push("TELEGRAM_BOT_TOKEN is unset. Nothing can be received or sent; the process would idle silently.");
  }
  if (!cfg.linkSecret) {
    out.push(
      "BOT_LINK_SECRET is unset. Without it every chat derives the same chat_ref, which would bind unrelated users to one wallet. It must match BOT_LINK_SECRET on the Vercel deployment exactly.",
    );
  }
  return out;
}

/**
 * Per-capability state, printed by /status so a user is never left guessing why an
 * answer did not arrive.
 *
 * `available: false` here is why a command answers "unavailable". It is never why a
 * command answers zero.
 */
export function describeCapabilities(cfg) {
  const caps = [
    {
      id: "link",
      label: "Wallet linking",
      available: true,
      detail:
        "Handled by the venue API. A chat is bound only by signing in the web app, so this works whenever the venue is reachable.",
    },
    {
      id: "heat",
      label: "Heat standing",
      available: true,
      detail: "Read through the venue's heat resource, which forwards Jungle Bay Island's measurement.",
    },
  ];

  if (cfg.indexerUrl) {
    caps.push({
      id: "indexed",
      label: "Balances, positions and fills",
      available: true,
      detail: `Read from the indexer at ${cfg.indexerUrl}. An answer is only given once that service reports its backfill complete.`,
    });
  } else {
    caps.push({
      id: "indexed",
      label: "Balances, positions and fills",
      available: false,
      detail: cfg.indexerUrlRaw
        ? "INDEXER_URL is set but is not a valid http(s) URL, so nothing was asked. This is a misconfiguration on the bot host, not an outage."
        : "No indexer is hosted for this venue yet, so there is nothing to read positions from. This is stated rather than answered as zero.",
    });
  }

  // Not a variable and not a dial. There is no keeper anywhere in this venue, and
  // an operator must not be able to make one exist by setting an environment
  // variable — the same reason KEEPER_AVAILABLE is a constant in the frontend.
  caps.push({
    id: "execution",
    label: "Trading from chat",
    available: false,
    detail:
      "By design, permanently in this shape. Anything that moves value is handed back as a link you open and sign yourself. This bot holds no key and can sign nothing.",
  });

  return caps;
}
