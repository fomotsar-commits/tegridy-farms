-- ═══ Comprehensive Supabase role grants for the public schema ═══
-- The whole public schema was created via raw SQL (not the dashboard table
-- editor), so anon/authenticated/service_role never received table-level
-- GRANTs — every REST query 42501'd ("permission denied"), silently
-- breaking chat/profiles/favorites/trades. RLS (enabled on every table) is
-- the real row gate; these grants are the standard Supabase posture that
-- lets the roles touch the tables at all. Idempotent + future-proofed via
-- ALTER DEFAULT PRIVILEGES so new tables auto-grant.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- service_role: the /api layer. Full access (also bypasses RLS).
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO service_role;

-- anon + authenticated: the verbs; RLS policies decide which rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO anon, authenticated;

-- Future tables/functions created by postgres (the SQL-editor role) auto-grant.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON ROUTINES TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
