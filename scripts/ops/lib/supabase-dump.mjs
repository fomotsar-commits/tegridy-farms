// The table dump from .github/workflows/supabase-backup.yml, in Node: same tables, same
// PostgREST endpoint, same Range pagination and caps. One addition: each page asks for
// `Prefer: count=exact`, so a short page (a server row cap, a proxy) fails the table
// instead of ending the dump early and passing as a smaller, complete-looking table.

// Same order and set as the workflow's TABLES line; the tests pin both.
export const TABLES = Object.freeze([
  'native_orders', 'trade_offers', 'messages', 'dm_messages', 'user_profiles',
  'user_favorites', 'user_watchlist', 'votes', 'push_subscriptions', 'revoked_jwts',
]);
// Tables allowed to be absent (HTTP 404). Empty, as in the workflow.
export const OPTIONAL_TABLES = Object.freeze([]);
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 500;
const REQUEST_TIMEOUT_MS = 60_000;

// "0-999/1234", "*/0" or "0-9/*" -> { start, end, total } (null where unknown); else null.
export function parseContentRange(value) {
  const m = /^\s*(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/.exec(value || '');
  if (!m) return null;
  return {
    start: m[1] === undefined ? null : Number(m[1]),
    end: m[2] === undefined ? null : Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

const fail = (table, reason) => ({ table, status: 'failed', rows: null, reason });

/**
 * Read one table whole, or say why not. status: 'ok' | 'missing' (404) | 'failed' |
 * 'truncated' (hit MAX_PAGES). Rows are only ever returned with status 'ok', and only
 * when their count equals the row total the server reported.
 */
export async function dumpTable({ baseUrl, key, table, fetchImpl = fetch, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const rows = [];
  let total = null;
  let page = 0;
  let finished = false;
  for (; page < maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let res;
    let text;
    try {
      res = await fetchImpl(`${baseUrl}/rest/v1/${table}?select=*`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Range-Unit': 'items',
          Range: `${from}-${to}`,
          Prefer: 'count=exact',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      return fail(table, `request for rows ${from}-${to} failed (${e?.name || 'Error'}: ${e?.message || e})`);
    }
    const range = parseContentRange(res.headers.get('content-range'));
    if (res.status === 416) {
      // Range past the end: pagination is complete. The header still carries the total.
      if (range && range.total !== null) {
        if (total !== null && range.total !== total) {
          return fail(table, `row total changed during the dump (${total}, then ${range.total}); re-run`);
        }
        total = range.total;
      }
      finished = true;
      break;
    }
    if (res.status === 404) return { table, status: 'missing', rows: null, reason: `HTTP 404 on rows ${from}-${to}` };
    if (res.status !== 200 && res.status !== 206) return fail(table, `HTTP ${res.status} on rows ${from}-${to}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(table, `non-JSON page at rows ${from}-${to}`);
    }
    if (!Array.isArray(body)) return fail(table, `page at rows ${from}-${to} is not a JSON array`);
    if (!range || range.total === null) {
      return fail(table, `no row total in Content-Range at rows ${from}-${to}, so a complete read cannot be proven`);
    }
    if (total !== null && range.total !== total) {
      return fail(table, `row total changed during the dump (${total}, then ${range.total}); re-run`);
    }
    total = range.total;
    if (body.length > 0 && (range.start !== from || range.end !== from + body.length - 1)) {
      return fail(table, `page asked for rows ${from}-${to} and got ${range.start}-${range.end} holding ${body.length} rows`);
    }
    rows.push(...body);
    if (body.length < pageSize) {
      finished = true;
      break;
    }
  }
  if (!finished) {
    return { table, status: 'truncated', rows: null, reason: `hit the ${maxPages}-page cap; this table is TRUNCATED. Raise MAX_PAGES.` };
  }
  if (total === null) return fail(table, 'the server never reported a row total');
  if (rows.length !== total) {
    return fail(table, `read ${rows.length} rows but the server reports ${total}; a page came back short`);
  }
  return { table, status: 'ok', rows, reason: null };
}

/** Dump every table (all are attempted, so one report names every broken one). */
export async function dumpAll({ baseUrl, key, fetchImpl = fetch, tables = TABLES, optional = OPTIONAL_TABLES, ...opts }) {
  const results = [];
  for (const table of tables) {
    results.push(await dumpTable({ baseUrl, key, table, fetchImpl, ...opts }));
  }
  const bad = results.filter((r) => r.status !== 'ok' && !(r.status === 'missing' && optional.includes(r.table)));
  return { ok: bad.length === 0, results, bad };
}

export function describeResults(results) {
  return results.map((r) => {
    if (r.status === 'ok') return `  ${r.table.padEnd(20)} ${r.rows.length} rows${r.rows.length === 0 ? ' (read, and empty)' : ''}`;
    return `  ${r.table.padEnd(20)} ${r.status.toUpperCase()}: ${r.reason}`;
  });
}
