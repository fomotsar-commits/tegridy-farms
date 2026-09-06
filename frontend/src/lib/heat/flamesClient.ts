// Network boundary for Jungle Bay Island's board, browser side.
//
// Goes through OUR proxy (`/api/aggregator?resource=flames`), never the upstream
// directly — same CORS lock as the heat oracle. The proxy also strips `person_id` and
// `wallet_count` before anything reaches here, so this module never sees them and
// cannot leak them. See api/_lib/flames.js.
//
// THREE OUTCOMES, AND THEY ARE NOT THE SAME FACT:
//   a board          -> { flames, asOfUnix }
//   the board is OFF -> null            (the proxy answered 204; nothing to paint)
//   we could not ask -> BoardUnavailableError
// The card renders nothing for the last two, but they are kept distinct here because
// "the island has no board today" and "we failed to reach the island" are different
// truths, and collapsing them is how an outage starts reading as an empty island.
//
// A FAILED READ IS NEVER AN EMPTY BOARD. There is no path in this file that returns
// `{ flames: [] }` for a failure.

import { normalizeXHandle } from './heatOracle';

/** One row of the island's board, already normalised and safe to paint. */
export interface Flame {
  /**
   * BARE handle (no `@`), already validated by normalizeXHandle, or null for an
   * unnamed flame. The board's `x_username` is the same untrusted-string-to-href path
   * as the reading's `x_handle`, so it runs through the SAME validator rather than a
   * second local `replace(/^@+/, '')` — one implementation, no drift, and a spoofed
   * handle reads as unnamed instead of becoming a link to somewhere that is not x.com.
   */
  xHandle: string | null;
  degrees: number;
  /** Rendered VERBATIM. Never restyled, never translated into yield language. */
  tier: string;
  heldSinceUnix: number | null;
  tokenCount: number;
}

export interface FlamesBoard {
  flames: Flame[];
  /** When the ISLAND last reckoned the board. Null if it did not say. */
  asOfUnix: number | null;
}

export class BoardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardUnavailableError';
  }
}

const CLIENT_TIMEOUT_MS = 6000;

/**
 * The island's board refreshes at noon UTC and on link and merge events, and the edge
 * already caches it for five minutes. This matches that, so a home page and an
 * instrument on the same tab cost one read between them rather than one each.
 */
const CACHE_TTL_MS = 5 * 60_000;

const cache = new Map<string, { board: FlamesBoard | null; storedAt: number }>();

/** Drop the cached board. For tests, and after anything that could change standing. */
export function clearFlamesCache(): void {
  cache.clear();
}

function parseFlame(raw: unknown): Flame | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Degrees is the one field with no honest default. A row without it is not a flame
  // reading zero, it is a row we cannot read, so it is dropped rather than painted.
  if (typeof r.degrees !== 'number' || !Number.isFinite(r.degrees)) return null;
  if (typeof r.tier !== 'string' || !r.tier) return null;
  return {
    xHandle: normalizeXHandle(r.x_username),
    degrees: r.degrees,
    tier: r.tier,
    heldSinceUnix: typeof r.held_since_unix === 'number' ? r.held_since_unix : null,
    tokenCount: typeof r.token_count === 'number' ? r.token_count : 0,
  };
}

export interface FetchFlamesOptions {
  /** 1..500. The home reads 5, the Island lobby 25, the insertion rank 500. */
  limit: number;
  /** Named flames only. The board card wants this; the insertion rank does not. */
  claimed?: boolean;
  signal?: AbortSignal;
  fresh?: boolean;
}

/**
 * Read the board. Resolves to null when the island's board is OFF; throws
 * BoardUnavailableError when we could not read it at all.
 */
export async function fetchFlames(opts: FetchFlamesOptions): Promise<FlamesBoard | null> {
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit)));
  const claimed = opts.claimed === true;
  const key = `${limit}:${claimed}`;

  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.board;
    if (hit) cache.delete(key);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(
      `/api/aggregator?resource=flames&limit=${limit}${claimed ? '&claimed=1' : ''}`,
      { headers: { Accept: 'application/json' }, signal: ac.signal },
    );
  } catch {
    throw new BoardUnavailableError('The board is unreachable.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  // 204: the island's board is off. A real answer, and a cacheable one — otherwise
  // every render of a page carrying the card re-asks a board we know is dark.
  if (res.status === 204) {
    cache.set(key, { board: null, storedAt: Date.now() });
    return null;
  }
  if (!res.ok) throw new BoardUnavailableError('The board is unavailable.');

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new BoardUnavailableError('The board returned something unreadable.');
  }

  const body = payload as { flames?: unknown; as_of_unix?: unknown } | null;
  if (!body || !Array.isArray(body.flames)) {
    // A 200 with the wrong shape is an OUTAGE, never an empty island.
    throw new BoardUnavailableError('The board returned something unreadable.');
  }

  const flames = body.flames.map(parseFlame).filter((f): f is Flame => f !== null);
  // Rows arrived but none survived parsing: the upstream shape moved under us. Saying
  // "nobody is on the island" would be a confident answer to a question we failed.
  if (flames.length === 0 && body.flames.length > 0) {
    throw new BoardUnavailableError('The board returned something unreadable.');
  }

  const board: FlamesBoard = {
    flames,
    asOfUnix: typeof body.as_of_unix === 'number' ? body.as_of_unix : null,
  };
  if (cache.size >= 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { board, storedAt: Date.now() });
  return board;
}

/**
 * Where a number would sit on the board right now: 1 + however many flames beat it.
 *
 * ARITHMETIC ON SERVED NUMBERS, and labelled as such wherever it renders. It is not a
 * heat calculation, it is not persisted, and it is not the island's ranking of this
 * wallet — the island ranks named flames, and an unnamed wallet is not on the board at
 * all. That is exactly why the line is worth showing: it says what claiming a name
 * would be worth, without pretending the claim has happened.
 */
export function insertionRank(degrees: number, flames: Flame[]): { rank: number; of: number } {
  const ahead = flames.filter((f) => f.degrees > degrees).length;
  return { rank: ahead + 1, of: flames.length + 1 };
}
