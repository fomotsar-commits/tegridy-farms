# Audit 080 — Supabase RLS / Proxy

Agent: 080 (forensic, AUDIT-ONLY)
Targets:
- `frontend/api/supabase-proxy.js`
- `frontend/supabase/migrations/001_siwe_auth_rls.sql`
- `frontend/supabase/migrations/002_native_orders_trades_push.sql`
- `frontend/supabase/migrations/003_revoked_jwts.sql`
- Cross-check: `frontend/api/__tests__/supabase-proxy.test.js`, `frontend/api/_lib/proxy-schemas.js`, `frontend/src/nakamigos/lib/supabase.js`

## Counts
- HIGH: 0
- MEDIUM: 3
- LOW: 4
- INFO: 5

## Findings

### MED-1 — `toggle_like` SECURITY DEFINER without locked `search_path`
File: `001_siwe_auth_rls.sql:90-110`
```
CREATE OR REPLACE FUNCTION toggle_like(msg_id uuid, wallet text)
...
$$ LANGUAGE plpgsql SECURITY DEFINER;
```
Function is `SECURITY DEFINER` (executes as the owner, typically `postgres`) but does NOT set `search_path`. An attacker who can create a function/operator in a schema earlier on the search_path of the calling role (e.g. `public` or a tenant-writable schema) can shadow `array_remove`, `array_append`, or operator resolution and execute code with definer privileges. PostgreSQL official guidance: every SECURITY DEFINER function should `SET search_path = pg_catalog, public` (or pin to specific schemas). Same defect on `prune_revoked_jwts()` (`003_revoked_jwts.sql:40-48`) — covered as MED-2.

Recommended fix:
```
ALTER FUNCTION toggle_like(uuid, text) SET search_path = pg_catalog, public;
ALTER FUNCTION prune_revoked_jwts() SET search_path = pg_catalog, public;
```

### MED-2 — `prune_revoked_jwts` SECURITY DEFINER without `search_path` and EXECUTE not revoked
File: `003_revoked_jwts.sql:40-48`. Same `search_path` hijack risk as MED-1. Additionally, the default `GRANT EXECUTE ON FUNCTION ... TO PUBLIC` is left in place, so any role that can connect (anon, authenticated) can call `prune_revoked_jwts()` to wipe rows. Although the function only deletes already-expired JWTs, exposing definer-priv mutations to PUBLIC is a privilege-escalation surface waiting for the next refactor. Recommend `REVOKE ALL ON FUNCTION prune_revoked_jwts() FROM PUBLIC, anon, authenticated;` and grant only to `service_role`.

### MED-3 — Public `messages` INSERT path: trigger ratelimit + RLS rely on JWT-claim mismatch with proxy validator (case sensitivity)
File: `001_siwe_auth_rls.sql:26-30`, vs proxy `_lib/proxy-schemas.js:27` (`/^0x[a-f0-9]{40}$/`). RLS lowercases the JWT wallet (`lower(... ->> 'wallet')`) but RLS does NOT lowercase the inserted `author` column. If a client sends mixed-case `author` directly to PostgREST (bypassing the proxy by attaching a stolen JWT to a `supabase-js` client), RLS rejects only because the JWT side is lowered while the row side is not. Proxy validator only accepts lowercase via regex — but RLS enforcement is the boundary in the threat model. The migration should normalise both sides:
```
WITH CHECK (lower(author) = lower(current_setting('request.jwt.claims', true)::json->>'wallet') ...)
```
Today the system happens to work because proxy refuses non-lowercase; remove the proxy and you have a bypass. Defense-in-depth gap.

### LOW-1 — `messages` table missing UNIQUE/replay constraint
File: `frontend/src/nakamigos/lib/supabase.js:13-21` (canonical schema). No UNIQUE on (`author`,`text`,`created_at` truncated) or jti-style nonce; combined with the documented 5-second per-author rate-limit trigger, this is acceptable, but the trigger lives only in the docstring of `supabase.js` — I cannot find the actual `CREATE TRIGGER rate_limit_messages` in any migration file. If never run in production, every authenticated wallet can flood `messages` at the proxy rate-limit ceiling (20 writes/min). Confirm the trigger is deployed; if not, port it into a `004_*.sql` migration.

### LOW-2 — `siwe_nonces` lacks UNIQUE / FOR-DELETE on consume path; no PK index on `expires_at` for cleanup
File: `001_siwe_auth_rls.sql:14-22`. PK on `nonce` is fine; expires_at index exists. However, no `WHERE expires_at > now()` partial index — cleanup queries scan the whole table once it grows. INFO-only at small scale; flag for the cron job in `prune_*` family.

### LOW-3 — `trade_offers` and `push_subscriptions` SELECT policies leak via JOIN-style patterns
Files: `002_native_orders_trades_push.sql:88-91` and `127-129`. Policies are correct, but `idx_trades_target` covers `(target_owner, status)` while `idx_trades_offerer` covers `(offerer, status)` — the SELECT policy is `offerer=jwt OR target_owner=jwt`, which Postgres planner cannot use either index for in a single scan; expect seq-scan once the table grows past tens of thousands of rows. Add a covering index or a generated column `(jwt_party text)`.

### LOW-4 — Conflicting policies on `trade_offers`: 001 declares "Anyone can read trades USING (true)"; 002 replaces with participant-only SELECT — but 002 does NOT `DROP POLICY` on the legacy "Anyone can read trades"
File: `002_native_orders_trades_push.sql:84-91`. Drops only `Participants read trades` before re-creating it. The earlier `Anyone can read trades` policy from `001_siwe_auth_rls.sql:118-120` is still present, and Postgres OR-combines policies — so trade_offers SELECT remains effectively public. Migration order means the public policy "wins" by being permissive. Fix: prepend `DROP POLICY IF EXISTS "Anyone can read trades" ON trade_offers;` to 002 (or to a 004 cleanup).

### INFO-1 — Proxy correctly uses anon key, never service-role
`supabase-proxy.js:88-99` reads `VITE_SUPABASE_ANON_KEY` and forwards the user JWT in the Authorization header — exactly the right architecture. No service-role secret is shipped to the client.

### INFO-2 — JWT verification on the proxy is HS256 with `issuer:"supabase", audience:"authenticated"` — matches Supabase defaults
`supabase-proxy.js:69-77`. Good. Tests stub `jose.jwtVerify` correctly.

### INFO-3 — Wallet-authn / RLS auth.uid() mismatch — NOT present
RLS policies in 001 and 002 read `current_setting('request.jwt.claims', true)::json->>'wallet'`, which matches the SIWE issuer's custom claim. No policy uses `auth.uid()` (which would have been wrong for wallet authn).

### INFO-4 — `ALL TO authenticated` not used anywhere
No "FOR ALL TO authenticated" grants found; service-role is the only role with FOR ALL.

### INFO-5 — INSERT policies all carry WITH CHECK
Every INSERT policy in 001 and 002 has an explicit `WITH CHECK` clause binding the row to the JWT wallet. No "INSERT WITHOUT WITH CHECK" anti-pattern. Combined with `proxy-schemas.js` strict Zod and JWT-ownership refinement, defense-in-depth is solid.

## Top-5 (severity-ranked)
1. **MED-1** — `toggle_like` SECURITY DEFINER missing `SET search_path` (hijack risk)
2. **MED-2** — `prune_revoked_jwts` SECURITY DEFINER missing `SET search_path` AND not revoked from PUBLIC
3. **MED-3** — RLS on `messages.author` doesn't lowercase row-side; mixed-case bypass possible if proxy sidestepped
4. **LOW-4** — Legacy `Anyone can read trades USING (true)` on `trade_offers` left in place, OR-combined with participant-only policy → effectively public
5. **LOW-1** — `rate_limit_messages` BEFORE-INSERT trigger documented in `supabase.js` but not present in any migration file (confirm deploy)
