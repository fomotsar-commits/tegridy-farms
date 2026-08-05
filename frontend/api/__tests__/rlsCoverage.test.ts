// RLS COVERAGE GUARD.
//
// PrivacyPage §5 makes two hard, public security claims:
//
//   "Row-Level Security is enforced on every row by the wallet claim in your
//    SIWE-issued JWT; writes that don't match your wallet are rejected at the
//    database."
//   "…Row-Level Security on every Supabase table…"
//
// Nothing verified either one. This is the same shape as the holder-gate that
// #217 had to move server-side: a security control that is asserted publicly and
// checked nowhere.
//
// THE FINDING THAT PROMPTED THIS FILE
// -----------------------------------
// In Postgres a POLICY IS INERT UNTIL RLS IS ENABLED ON THE TABLE. `CREATE
// POLICY` on its own changes nothing. Reading all 13 migrations:
//
//   ENABLE ROW LEVEL SECURITY appears for  7 tables
//   CREATE POLICY appears for             12 tables
//
// so five tables — messages, user_profiles, user_favorites, user_watchlist,
// votes — carry 2-3 policies each and are never enabled by any migration. Every
// one of them is writable through api/supabase-proxy.js's ALLOWED_TABLES.
//
// RLS may well be ON for them in production, switched on through the Supabase
// dashboard rather than a migration (011 was applied that way). That is exactly
// the problem: it cannot be demonstrated from this repo, and "we're pretty sure
// someone enabled it" is not what §5 promises a reader.
//
// WHAT THIS FILE DOES AND DOES NOT DO
// -----------------------------------
// It does NOT enable RLS on those five. `user_favorites` and `user_watchlist`
// have OWNER-ONLY read policies, so if production is currently serving them with
// RLS off, switching it on in a migration would silently break reads. That needs
// a look at live state first, which belongs to the operator, not to a guess.
//
// What it does is make the gap impossible to lose: the exception list below is
// enumerated, justified, and MAY ONLY SHRINK. A new writable table cannot join it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lives under api/__tests__ deliberately: vitest.config.ts only collects
// `src/**` and `api/**`, so this file at frontend/supabase/ would have been a
// test that never ran — the exact 'gate that asserts nothing' shape this repo
// keeps finding. It is about the API's writable tables anyway.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations');
const PROXY = join(HERE, '..', 'supabase-proxy.js');

const sql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

/** Tables the migrations switch RLS on for. */
function rlsEnabled(): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+([a-z_.]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    out.add(m[1]!.toLowerCase().replace(/^public\./, ''));
  }
  return out;
}

/** Tables the migrations write a policy for. */
function policied(): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+POLICY\s+(?:"[^"]+"|\S+)\s+ON\s+([a-z_.]+)/gi)) {
    out.add(m[1]!.toLowerCase().replace(/^public\./, ''));
  }
  return out;
}

/** Tables api/supabase-proxy.js will forward a write to. */
function writableTables(): string[] {
  const src = readFileSync(PROXY, 'utf8');
  const m = src.match(/const ALLOWED_TABLES\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('could not locate ALLOWED_TABLES in api/supabase-proxy.js');
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

// Tables whose RLS is NOT established by any migration. Every entry is a table
// the write-proxy accepts, so each is a place §5's promise rests on out-of-band
// dashboard state rather than on anything reviewable here.
//
// ⚠ THIS LIST MAY ONLY SHRINK. Closing an entry means: confirm in Supabase
// whether RLS is already on, confirm the read paths still work under it (note
// user_favorites and user_watchlist are OWNER-ONLY reads), then add
// `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY` to a migration and delete it here.
const RLS_NOT_ESTABLISHED_BY_MIGRATION = [
  'messages',
  'user_profiles',
  'user_favorites',
  'user_watchlist',
  'votes',
] as const;

describe('RLS coverage — the claim PrivacyPage §5 makes to every visitor', () => {
  it('every table a migration CREATEs has RLS enabled', () => {
    const enabled = rlsEnabled();
    const created = new Set<string>();
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_.]+)/gi)) {
      created.add(m[1]!.toLowerCase().replace(/^public\./, ''));
    }
    const missing = [...created].filter((t) => !enabled.has(t));
    expect(missing, `tables created without RLS: ${missing.join(', ')}`).toEqual([]);
  });

  it('no table has policies while RLS is left off — a policy without RLS is INERT', () => {
    const enabled = rlsEnabled();
    const inert = [...policied()]
      .filter((t) => !enabled.has(t))
      .filter((t) => !(RLS_NOT_ESTABLISHED_BY_MIGRATION as readonly string[]).includes(t));
    expect(
      inert,
      `these tables have CREATE POLICY but no ENABLE ROW LEVEL SECURITY, so their policies do nothing: ${inert.join(', ')}`,
    ).toEqual([]);
  });

  it('every writable table is either RLS-enabled here or a KNOWN, enumerated gap', () => {
    const enabled = rlsEnabled();
    const unaccounted = writableTables()
      .filter((t) => !enabled.has(t))
      .filter((t) => !(RLS_NOT_ESTABLISHED_BY_MIGRATION as readonly string[]).includes(t));
    expect(
      unaccounted,
      `new writable table(s) with no RLS in any migration and not on the known-gap list: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('the known-gap list contains no table that is already fixed', () => {
    // Forces the list to shrink as gaps close, instead of rotting into a
    // permanent allowlist that quietly excuses everything.
    const enabled = rlsEnabled();
    const stale = RLS_NOT_ESTABLISHED_BY_MIGRATION.filter((t) => enabled.has(t));
    expect(stale, `already RLS-enabled, remove from the gap list: ${stale.join(', ')}`).toEqual([]);
  });

  it('the known-gap list contains no table nobody can write to', () => {
    // If a table stops being writable, it stops being a risk and should leave
    // the list rather than inflate it.
    const writable = new Set(writableTables());
    const orphans = RLS_NOT_ESTABLISHED_BY_MIGRATION.filter((t) => !writable.has(t));
    expect(orphans, `not writable via the proxy, drop from the gap list: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('write policies bind to the SIWE wallet claim', () => {
  it('owner-scoped policies check the JWT wallet claim, not just any authenticated role', () => {
    // §5 promises writes are rejected "by the wallet claim in your SIWE-issued
    // JWT". A policy that only checks `TO authenticated` would let ANY logged-in
    // wallet write another wallet's row.
    const owners = [...sql.matchAll(/CREATE\s+POLICY\s+"([^"]*Owner[^"]*)"\s+ON\s+([a-z_.]+)([\s\S]*?);/gi)];
    expect(owners.length, 'no owner-scoped policies found — has the naming changed?').toBeGreaterThan(0);
    const unbound = owners
      .filter(([, , , body]) => !/request\.jwt\.claims|jwt\.claim|auth\.jwt\(\)/i.test(body!))
      .map(([, name, table]) => `${table}:${name}`);
    expect(unbound, `owner policies not bound to a JWT claim: ${unbound.join(', ')}`).toEqual([]);
  });
});
