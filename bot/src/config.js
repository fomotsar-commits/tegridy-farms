// Everything this process reads from its environment. An unset variable degrades one
// capability to an explicit "unavailable", never to a plausible answer like "you hold
// nothing": each capability is on, off with a reason, or misconfigured with a reason, and
// describeCapabilities() is what /status prints. No variable here holds, unlocks or derives
// a key; frontend/api/__tests__/bot-noncustodial.test.js scans bot/ and fails the build if
// one appears.

/** Read once, at boot, so nothing snapshots a value mid-flight. */
export function loadConfig(env = process.env) {
  return {
    botToken: str(env.TELEGRAM_BOT_TOKEN),
    linkSecret: str(env.BOT_LINK_SECRET),
    // Every link the bot mints is a share link, so both default to the venue's canonical
    // host, SITE_URL in frontend/src/lib/constants.ts. frontend/src/test/botOrigins.test.ts
    // pins these defaults, and the ones bot/.env.example and bot/DEPLOY.md state, to it.
    venueOrigin: origin(env.VENUE_ORIGIN) ?? "https://memetics.finance",
    appOrigin: origin(env.APP_ORIGIN) ?? "https://memetics.finance",
    // Same meaning as the frontend's VITE_INDEXER_URL: the indexer's public proxy origin,
    // no path. Its absence is the gate (indexer/DEPLOY.md section 5).
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
 * An http(s) origin with any trailing path stripped, or null. A relative or other-scheme
 * value must not reach a fetch, where it would read as an outage rather than a typo.
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
 * The two variables without which there is no bot. Fatal, not degraded: with no token
 * nothing is received, with no secret every chat derives the same ref and unrelated users
 * share one binding, and a deploy that started anyway would look alive in the dashboard.
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
 * Per-capability state, printed by /status. `available: false` is why a command answers
 * "unavailable"; it is never why a command answers zero.
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

  // Not a variable: there is no keeper in this venue, and an environment variable must not
  // be able to make one exist. The frontend's KEEPER_AVAILABLE is a constant for the same reason.
  caps.push({
    id: "execution",
    label: "Trading from chat",
    available: false,
    detail:
      "By design, permanently in this shape. Anything that moves value is handed back as a link you open and sign yourself. This bot holds no key and can sign nothing.",
  });

  return caps;
}
