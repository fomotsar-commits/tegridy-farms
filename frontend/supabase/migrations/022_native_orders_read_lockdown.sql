-- ============================================================
-- 022 — native_orders / trade_offers: close the anon read side
--
-- ⚠️ NOT APPLIED, AND CARRIES AN OPERATOR DECISION. This is the REVOKE that
--    silently fell out of every planning list: it was scheduled as "016", that
--    number was taken by alert_rules, and the SQL was never written — recorded
--    in docs/EVERYTHING_LEFT_2026_08_15.md as "exists nowhere and needs an
--    explicit decision, not amnesia". This file is the explicit decision point.
--
-- WHAT IT DOES: revokes direct PostgREST SELECT on `native_orders` and
-- `trade_offers` from the anon role. After it, the ONLY read path is the
-- serverless API (frontend/api/orderbook.js and friends), which reads with the
-- service role and controls shape, filters, and rate limits. Today anyone with
-- the published anon key can SELECT the full tables from a shell — every open
-- order, every offer, every wallet pairing, without touching our API.
--
-- ⛔ PREFLIGHT — DO NOT APPLY BLIND. If any live frontend code still reads
--    these tables through supabase-js with the anon key, this REVOKE blanks
--    that surface. Verify first, from a shell:
--
--      # 1. Is the anon read even open today? (200 = open, this file matters)
--      curl -s -o /dev/null -w '%{http_code}\n' \
--        -H "apikey: $SUPABASE_ANON_KEY" \
--        "$SUPABASE_URL/rest/v1/native_orders?select=id&limit=1"
--
--      # 2. Does the shipped bundle query PostgREST for these tables directly?
--      #    Grep the LIVE bundle (not the source) for 'rest/v1/native_orders'
--      #    and 'rest/v1/trade_offers'. Zero hits = the API is the only reader
--      #    and this REVOKE breaks nothing.
--
-- ORDERING: independent of 013/014/015. ⛔ But NEVER run 008 after this file —
-- 008's ALTER DEFAULT PRIVILEGES blanket-grants anon on every future table and
-- its re-grant undoes exactly this kind of lockdown (the 008 hazard is already
-- documented as "never after 014 or 016-021"; this file joins that list).
-- ============================================================

REVOKE SELECT ON public.native_orders FROM anon;
REVOKE SELECT ON public.trade_offers FROM anon;

-- The API path is service-role and unaffected. `authenticated` is deliberately
-- left as-is: the SIWE-JWT read policies (001/015) are row-scoped and remain
-- the contract for signed-in reads.

NOTIFY pgrst, 'reload schema';

-- ── Record this file in the ledger ────────────────────────────────────
INSERT INTO public.schema_migrations (filename, note)
VALUES ('022_native_orders_read_lockdown.sql', 'anon SELECT revoked on native_orders + trade_offers; API is the only public read path')
ON CONFLICT (filename) DO NOTHING;

-- ── VERIFICATION — run after applying ─────────────────────────────────
--
--   # Both must now answer 401/403/404, NOT 200:
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     "$SUPABASE_URL/rest/v1/native_orders?select=id&limit=1"
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     "$SUPABASE_URL/rest/v1/trade_offers?select=id&limit=1"
--
--   # And the API path still works (browse endpoint, no auth):
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "Origin: https://memetic.fun" \
--     "https://memetic.fun/api/orderbook?action=listings&limit=1"
