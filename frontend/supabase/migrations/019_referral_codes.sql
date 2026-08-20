-- ============================================================
-- 019 — referral_codes: short codes for referral links
--
-- ⚠️ NOT APPLIED. This repo has no migration ledger; statements are applied by
--    hand against the Supabase project. Until an operator runs this file,
--    PostgREST answers 404/PGRST205 for `referral_codes` and
--    frontend/api/_lib/referrals.js reports `code: "schema-missing"` —
--    deliberately NOT "that code does not exist", because "no referrer is
--    registered under that code" and "no code could ever have been minted" are
--    different facts and only one of them is about a wallet.
--
-- ORDERING: independent of everything before it. One new table, nothing existing
-- is touched. Safe to apply at any time.
--
-- NOT REQUIRED FOR THE FEATURE TO WORK. Referral links of the form
-- `/?ref=0xabc…` are self-contained: they resolve in the visitor's browser with
-- no server, no database and no migration, and they are what every share surface
-- mints by default. This table only buys the shorter `/?r=code` form. That
-- ordering is deliberate — the fallback is the one that cannot 404 into "we
-- could not tell who referred you" on a link that already went out.
--
-- ============================================================
-- WHAT A ROW IS — AND WHAT IT EMPHATICALLY IS NOT
-- ============================================================
--
-- A row maps a short string to a wallet. That is the whole of it.
--
-- THIS TABLE IS NOT THE REFERRAL LEDGER. It holds no balances, no earnings, no
-- referee counts, and no claim state. All of that lives in ReferralSplitter at
-- 0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c and is read from chain. Do NOT add
-- an `earnings`, `referred_count`, `rank` or `last_paid_at` column here. A second
-- copy of a money number is a second account of the money, and the moment the two
-- disagree the UI has to pick one — and it will pick the fast one, which is this
-- one, which is the one nobody can verify.
--
-- There is also no `referred_by` column. Who referred whom is `referrerOf` on the
-- splitter: one-time, permanent, and enforced by the chain. A mirror here would
-- be writable by anyone who can reach PostgREST and would silently disagree with
-- the contract that actually pays.
--
-- AND THERE IS NO `listed` COLUMN. An earlier draft carried one, to opt wallets
-- into a public roster that a referral LEADERBOARD would rank. That leaderboard
-- was not built and cannot honestly be: ranking referrers needs every referrer's
-- earnings, which means the splitter's `FeeRecorded` history, and the Ponder
-- indexer does not subscribe to ReferralSplitter at all (no contract entry in
-- indexer/ponder.config.ts, no table in indexer/ponder.schema.ts). A ranking over
-- only the wallets that opted into a database row is a directory of volunteers,
-- and presenting it as a leaderboard tells a reader that #1 is the top referrer
-- when that is unknowable. If the indexer ever subscribes to the splitter, the
-- ranking comes from THERE, on-chain, for everyone — not from an opt-in flag here.
--
-- ============================================================
-- AUTHORITY — AND WHY THE ONE PUBLIC READ IS SHAPED THE WAY IT IS
-- ============================================================
--
-- Writes and self-reads are keyed to the SIWE JWT wallet claim, same shape as
-- alert_rules in 016. The API forwards the USER's JWT to PostgREST for those, so
-- RLS is the authority.
--
-- Code RESOLUTION cannot work that way: a visitor following somebody else's link
-- has no session and never will. It is not served by a public SELECT policy
-- either — a `USING (true)` here would be readable straight from the browser with
-- the published anon key, which turns this table into a downloadable list of
-- every referrer's wallet, the same shape api/_lib/airdrop.js deliberately has no
-- endpoint for. Instead it runs SERVER-SIDE under the service role with a PINNED
-- filter: one code in, at most one wallet out. That single query shape is pinned
-- by api/__tests__/referrals-surface-parity.test.js so a second, wider one cannot
-- quietly appear.
--
-- The consequence to accept: the service role bypasses RLS, so the policies below
-- are NOT what protects the public read. The FILTER is. The policies protect the
-- anon/authenticated roles, which is what a browser can actually present.
-- ============================================================

CREATE TABLE IF NOT EXISTS referral_codes (
  -- The code is the primary key: one code, one owner, and a collision is a 409
  -- at insert rather than two rows racing to own a link that is already printed
  -- in somebody's timeline.
  --
  -- Shape mirrors REF_CODE_RE in frontend/src/lib/referrals/attribution.ts and
  -- the same literal in frontend/api/_lib/referrals.js. Lowercase alphanumeric,
  -- 4–12 characters. Constrained HERE too, so a direct-to-database write cannot
  -- create a code the client-side regex will refuse to parse back.
  code        text        PRIMARY KEY CHECK (code ~ '^[a-z0-9]{4,12}$'),

  -- Lower-cased owner wallet. UNIQUE: one code per wallet, so re-minting updates
  -- the row instead of adding another, and a wallet cannot squat the namespace.
  wallet      text        NOT NULL UNIQUE CHECK (wallet ~ '^0x[0-9a-f]{40}$'),

  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

-- SELECT: the owner reads their own row. There is deliberately no public SELECT
-- policy — see the header. Resolution is a server-side read with a pinned
-- filter, not an open table.
DROP POLICY IF EXISTS "Owner reads own referral code" ON referral_codes;
CREATE POLICY "Owner reads own referral code" ON referral_codes FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- INSERT: only as self. Without this a wallet could mint a memorable code
-- pointing at an address it does not control — collecting nothing, but burning
-- that code for its real owner forever.
DROP POLICY IF EXISTS "Owner creates own referral code" ON referral_codes;
CREATE POLICY "Owner creates own referral code" ON referral_codes FOR INSERT WITH CHECK (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- UPDATE: only as self, and WITH CHECK as well as USING — without the WITH CHECK
-- half an owner could re-home their row to another wallet, handing a live code
-- (already pasted into other people's timelines) to a different payee.
DROP POLICY IF EXISTS "Owner updates own referral code" ON referral_codes;
CREATE POLICY "Owner updates own referral code" ON referral_codes FOR UPDATE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
) WITH CHECK (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- DELETE: only as self. Retiring your code stops the short link resolving; it
-- touches nothing on-chain, and nothing here pretends it does. Anyone still
-- holding the long /?ref=0x… form is unaffected.
DROP POLICY IF EXISTS "Owner deletes own referral code" ON referral_codes;
CREATE POLICY "Owner deletes own referral code" ON referral_codes FOR DELETE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_codes TO authenticated;

-- PostgREST caches the schema. A new table it has not seen answers PGRST205 —
-- "could not find the table" — until the cache is reloaded or the connection
-- recycles, so without this line the table exists, every referral-code call
-- fails, and the migration looks like it did nothing. Migration 014 carries the
-- same line for the same reason; it is why login stayed broken for months.
NOTIFY pgrst, 'reload schema';
