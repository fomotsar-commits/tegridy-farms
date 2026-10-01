// supabase-backup.yml's tables and 1000-row Range pages, made strict. Each page asks for an
// exact row count, so a short page fails the table. Pages go in primary-key order, and each
// page after the first starts on the row the last one ended on: if that row is not there,
// rows shifted under the dump (an update, delete or insert between pages), and the table
// fails instead of skipping one row with the count unchanged. The workflow could skip it.

import { supabaseAuthHeaders } from '../../../frontend/scripts/supabase-restore.mjs';

// Same order and set as the workflow's TABLES line; the tests pin both.
export const TABLES = Object.freeze([
  'native_orders', 'trade_offers', 'messages', 'dm_messages', 'user_profiles',
  'user_favorites', 'user_watchlist', 'votes', 'push_subscriptions', 'revoked_jwts',
]);
// Each table's primary key, as frontend/supabase/migrations defines it (a test pins them).
export const TABLE_KEYS = Object.freeze({
  native_orders: ['order_hash'],
  trade_offers: ['id'],
  messages: ['id'],
  dm_messages: ['id'],
  user_profiles: ['wallet'],
  user_favorites: ['wallet', 'token_id', 'collection_slug'],
  user_watchlist: ['wallet', 'token_id', 'collection_slug'],
  votes: ['wallet', 'week'],
  push_subscriptions: ['id'],
  revoked_jwts: ['jti'],
});
// Tables allowed to be absent (HTTP 404). Empty, as in the workflow.
export const OPTIONAL_TABLES = Object.freeze([]);
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 500;
export const REQUEST_TIMEOUT_MS = 60_000;
// The whole dump's limit, so a stalled server fails the run with a report before the
// scheduler's own time limit kills it silently.
export const DUMP_DEADLINE_MS = 20 * 60_000;

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
 * 'truncated' (hit MAX_PAGES). Rows are only returned with status 'ok': when their count
 * equals the server's total and no primary key is missing or repeated.
 */
export async function dumpTable({
  baseUrl, key, table, keys = TABLE_KEYS[table], fetchImpl = fetch, pageSize = PAGE_SIZE, maxPages = MAX_PAGES,
  timeoutMs = REQUEST_TIMEOUT_MS, deadline = Infinity, now = Date.now,
}) {
  if (!keys?.length) return fail(table, 'no primary key is known for it, so it cannot be paged safely');
  const order = keys.map((k) => `${k}.asc`).join(',');
  const keyOf = (row) => JSON.stringify(keys.map((k) => row?.[k] ?? null));
  const rows = [];
  let total = null;
  let finished = false;
  for (let page = 0; page < maxPages; page++) {
    const from = page === 0 ? 0 : rows.length - 1;
    const to = from + pageSize - 1;
    const left = deadline - now();
    if (left <= 0) return fail(table, `the dump ran past its deadline before rows ${from}-${to}; nothing is trusted`);
    let res;
    let text;
    try {
      res = await fetchImpl(`${baseUrl}/rest/v1/${table}?select=*&order=${order}`, {
        headers: {
          ...supabaseAuthHeaders(key),
          'Range-Unit': 'items',
          Range: `${from}-${to}`,
          Prefer: 'count=exact',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
      });
      text = await res.text();
    } catch (e) {
      return fail(table, `request for rows ${from}-${to} failed (${e?.name || 'Error'}: ${e?.message || e})`);
    }
    if (res.status === 404) return { table, status: 'missing', rows: null, reason: `HTTP 404 on rows ${from}-${to}` };
    // Every page starts on a row already read, so a range past the end means rows vanished.
    if (res.status === 416) return fail(table, `rows ${from}-${to} are past the end: the table shrank during the dump; re-run`);
    if (res.status !== 200 && res.status !== 206) return fail(table, `HTTP ${res.status} on rows ${from}-${to}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(table, `non-JSON page at rows ${from}-${to}`);
    }
    if (!Array.isArray(body)) return fail(table, `page at rows ${from}-${to} is not a JSON array`);
    const range = parseContentRange(res.headers.get('content-range'));
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
    const lastPage = body.length < pageSize;
    if (page > 0) {
      if (body.length === 0 || keyOf(body[0]) !== keyOf(rows[rows.length - 1])) {
        return fail(table, `row ${from} is not the row the last page ended on: rows moved during the dump; re-run`);
      }
      body.shift();
    }
    rows.push(...body);
    if (lastPage) {
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
  const seen = new Set();
  for (const row of rows) {
    if (keys.some((k) => row?.[k] === undefined || row?.[k] === null)) {
      return fail(table, `a row has no ${keys.join(', ')}, so no row can be proven read exactly once`);
    }
    const k = keyOf(row);
    if (seen.has(k)) return fail(table, `two rows share the primary key (${keys.join(', ')}); a row was read twice`);
    seen.add(k);
  }
  return { table, status: 'ok', rows, reason: null };
}

/** Dump every table (all are attempted, so one report names every broken one). */
export async function dumpAll({
  baseUrl, key, fetchImpl = fetch, tables = TABLES, optional = OPTIONAL_TABLES,
  deadlineMs = DUMP_DEADLINE_MS, now = Date.now, ...opts
}) {
  const deadline = now() + deadlineMs;
  const results = [];
  for (const table of tables) {
    results.push(await dumpTable({ baseUrl, key, table, fetchImpl, deadline, now, ...opts }));
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
