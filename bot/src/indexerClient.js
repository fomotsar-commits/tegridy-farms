// Indexed reads for the bot, under the same gate the browser client uses.
//
// WHY THIS FILE EXISTS SEPARATELY FROM frontend/src/lib/indexer/client.ts, and why
// that is not a second data path: it is the same SERVICE, the same GraphQL
// document, the same `_meta { status }` ready-gate and the same fail-closed rule —
// re-expressed in plain Node because that client is a TypeScript module compiled
// into a browser bundle and reads `import.meta.env`, neither of which exists here.
// The queries below are copied from src/lib/indexer/queries.ts verbatim rather than
// rewritten, so a schema change breaks both in the same way. Nothing here computes
// a number the indexer did not return.
//
// THE GATE, restated because it is the only reason this file may report anything at
// all: the absence of INDEXER_URL IS the deploy flag. The indexer is built and
// hosted nowhere (indexer/DEPLOY.md). Until an operator sets that variable, every
// read here returns `unavailable`, and the command layer prints that instead of a
// balance. There is no fallback source, on purpose — a fallback is how a venue ends
// up with two answers and shows the one nobody can verify.
//
// AND THE SUBTLER HALF: a REACHABLE indexer that has not finished its backfill
// answers 200 with a short or empty page. That is not an outage and not an answer.
// Every query asks for `_meta { status }` in the same round trip and a not-ready
// response is reported as `backfilling`, never as zero rows.

/** Matches INDEXER_TIMEOUT_MS in src/lib/indexer/client.ts. */
export const INDEXER_TIMEOUT_MS = 8000;

/** Matches MAX_PAGE_LIMIT. No chat message shows more than a handful anyway. */
export const MAX_PAGE_LIMIT = 100;

const MAX_RESPONSE_BYTES = 512 * 1024;

export const INDEXER_UNAVAILABLE = Object.freeze({
  /** No INDEXER_URL, or one that does not parse. Nothing was asked. */
  NOT_CONFIGURED: "not-configured",
  /** Asked, no usable answer: network error, timeout, 5xx, or a proxy 429. */
  UNREACHABLE: "unreachable",
  /** Answered, and the answer was an error. */
  REJECTED: "rejected",
  /** Answered 200 with a body we cannot trust. */
  MALFORMED: "malformed",
  /** Answered, reachable, and still syncing. A zero here means nothing yet. */
  BACKFILLING: "backfilling",
});

/** Verbatim from src/lib/indexer/queries.ts — INDEXER_META_SELECTION. */
const META_SELECTION = "_meta { status }";

/** Verbatim from src/lib/indexer/queries.ts — INDEXED_SWAPS_QUERY. */
export const SWAPS_QUERY = `query IndexedSwaps($limit: Int!, $where: swapFilter!) {
  swaps(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit) {
    items { id user tokenIn tokenOut amountIn fee timestamp txHash }
    pageInfo { hasNextPage endCursor }
  }
  ${META_SELECTION}
}`;

/**
 * Read sync state, mirroring `parseIndexerMeta`.
 *
 * Returns null — meaning NOT-READY, never "probably fine" — when the document did
 * not ask for `_meta`, when Ponder has written no status row, or when the shape is
 * unrecognised. All three are "we do not know how fresh this is".
 */
export function parseMeta(data) {
  const status = data?._meta?.status;
  if (!status || typeof status !== "object") return null;
  const networks = Object.values(status);
  if (networks.length === 0) return null;

  let ready = true;
  let syncedBlock = null;
  for (const net of networks) {
    if (!net || typeof net.ready !== "boolean") return null;
    if (!net.ready) ready = false;
    const block = net.block ?? null;
    if (block === null || typeof block.number !== "number") {
      // One chain with no block makes the aggregate meaningless; reporting the
      // other chain's height would overstate coverage.
      syncedBlock = null;
      continue;
    }
    syncedBlock = syncedBlock === null ? block.number : Math.min(syncedBlock, block.number);
  }
  return { ready, syncedBlock };
}

async function readBody(res) {
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One GraphQL round trip, fully gated.
 *
 * @returns {{ok: true, data: object, syncedBlock: number|null} | {ok: false, reason: string, detail: string}}
 */
export async function query(cfg, document, variables, { fetchImpl = fetch } = {}) {
  if (!cfg.indexerUrl) {
    return {
      ok: false,
      reason: INDEXER_UNAVAILABLE.NOT_CONFIGURED,
      detail: cfg.indexerUrlRaw
        ? "INDEXER_URL is set on the bot host but is not a valid http(s) URL, so nothing was asked."
        : "This venue has no indexer hosted yet, so there is nothing to read history from. Nothing here says your history is empty.",
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INDEXER_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${cfg.indexerUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: ac.signal,
    });
  } catch {
    return {
      ok: false,
      reason: INDEXER_UNAVAILABLE.UNREACHABLE,
      detail: "The indexer did not answer, so no history was read.",
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status >= 500) {
    return { ok: false, reason: INDEXER_UNAVAILABLE.UNREACHABLE, detail: "The indexer could not answer." };
  }
  const body = await readBody(res);
  if (!body) {
    return { ok: false, reason: INDEXER_UNAVAILABLE.MALFORMED, detail: "The indexer answered with something unreadable." };
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return { ok: false, reason: INDEXER_UNAVAILABLE.REJECTED, detail: "The indexer rejected that query." };
  }
  if (!res.ok || !body.data || typeof body.data !== "object") {
    return { ok: false, reason: INDEXER_UNAVAILABLE.REJECTED, detail: "The indexer returned no data for that query." };
  }

  const meta = parseMeta(body.data);
  if (!meta || !meta.ready) {
    // The whole point. A reachable-but-syncing indexer returns rows, sometimes
    // NONE, and those rows are not the answer to "what has this wallet done".
    return {
      ok: false,
      reason: INDEXER_UNAVAILABLE.BACKFILLING,
      detail:
        "The indexer is still catching up on chain history, so any answer now would be short of the truth rather than wrong in an obvious way.",
    };
  }
  return { ok: true, data: body.data, syncedBlock: meta.syncedBlock };
}

/**
 * Venue-routed swaps for one wallet, newest first.
 *
 * SCOPE, copied from useIndexedSwaps.ts because the bot must not soften it: this
 * table holds swaps that went through the venue's SwapFeeRouter and nothing else. A
 * trader who routed around it has no rows, and the correct reading of an empty
 * READY result is "no venue-routed swaps", never "no trading". The command layer
 * prints exactly that sentence.
 */
export async function recentSwaps(cfg, wallet, limit = 5, opts) {
  const where = wallet ? { user: String(wallet).toLowerCase() } : {};
  const clamped = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_PAGE_LIMIT));
  const result = await query(cfg, SWAPS_QUERY, { limit: clamped, where }, opts);
  if (!result.ok) return result;
  const items = result.data?.swaps?.items;
  if (!Array.isArray(items)) {
    return { ok: false, reason: INDEXER_UNAVAILABLE.MALFORMED, detail: "The indexer returned an unexpected shape." };
  }
  return { ok: true, items, syncedBlock: result.syncedBlock };
}
