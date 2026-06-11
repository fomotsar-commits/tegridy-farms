-- Standard Supabase role grants for tables created via raw SQL (the dashboard
-- table editor does this automatically; raw CREATE TABLE does not). RLS still
-- governs which ROWS each role sees; these grant table-level access at all.

-- service_role = the /api layer (orderbook, push sender). Full access.
GRANT ALL ON trade_offers, dm_messages, push_subscriptions, revoked_jwts TO service_role;

-- authenticated = the user's SIWE JWT forwarded by /api/supabase-proxy.
-- RLS scopes rows to the wallet; these grant the verbs.
GRANT SELECT, INSERT, UPDATE, DELETE ON dm_messages TO authenticated;
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO authenticated;

-- anon = public reads (trades are public offers, RLS USING(true)).
GRANT SELECT ON trade_offers TO anon, authenticated;

-- The reactions RPC is called from the public supabase-js client.
GRANT EXECUTE ON FUNCTION toggle_reaction(uuid, text, text) TO anon, authenticated;

-- Reload PostgREST so it picks up the new grants immediately.
NOTIFY pgrst, 'reload schema';
