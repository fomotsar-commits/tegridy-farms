-- ============================================================
-- 032_nft_loan_requests.sql: the NFT loan request book
--
-- A borrower who holds an NFT from a lending collection can ask for a loan on it: an
-- amount, a highest rate, a length. Lenders see the request on the Lend tab and answer
-- with an ordinary signed offer on that NFT (030's nft_loan_offers), which the borrower
-- then takes as usual. api/_lib/loanRequests.js (served from api/orderbook.js) is the
-- only reader and writer, as service_role.
--
--   nft_loan_requests  one row per signed request, keyed by (borrower, nonce). A closed
--                      row is kept, so a copied signature cannot post the request again.
--     request          the signed request, numbers as decimal strings
--                      (src/lib/gondi/loanRequest.js)
--     status           active, or closed (cancelled, replaced by a newer request on the
--                      same NFT, or the borrower no longer holds the NFT)
--
-- Nothing here holds money or can move it. A request is signed under its own domain,
-- which no contract reads; a wrong row can only show a request nobody can act on, and the
-- site re-checks who holds the NFT on chain before it shows one.
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md). Needs the ledger,
-- public.schema_migrations (000_base_schema.sql section 0). Touches no other table.
-- Idempotent: re-running it is safe. Until it is applied the API answers an empty list
-- with open: false for reads (the Borrow tab then offers no ask form) and "not open yet"
-- for writes. 031 is 031_venue_volume_nft_sources.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS nft_loan_requests (
  borrower      text        NOT NULL,
  nonce         numeric(78, 0) NOT NULL,
  collection    text        NOT NULL,
  token_id      numeric(78, 0) NOT NULL,
  principal_wei numeric(78, 0) NOT NULL,
  max_apr_bps   integer     NOT NULL,
  duration_s    integer     NOT NULL,
  expires_at    timestamptz NOT NULL,
  request       jsonb       NOT NULL,
  signature     text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  PRIMARY KEY (borrower, nonce)
);

ALTER TABLE nft_loan_requests DROP CONSTRAINT IF EXISTS nft_loan_requests_shape;
ALTER TABLE nft_loan_requests
  ADD CONSTRAINT nft_loan_requests_shape
  CHECK (
    borrower ~ '^0x[0-9a-f]{40}$'
    AND collection IN (
      '0xd37264c71e9af940e49795f0d3a8336afaafdda9',  -- Jungle Bay Ape Club
      '0xd774557b647330c91bf44cfeab205095f7e6c367',  -- Nakamigos
      '0xa1de9f93c56c290c48849b1393b09eb616d55dbb'   -- GNSS Art
    )
    AND nonce >= 0 AND token_id > 0 AND principal_wei > 0
    AND max_apr_bps > 0 AND duration_s > 0
    AND status IN ('active', 'closed')
    AND signature ~ '^0x[0-9a-fA-F]+$' AND length(signature) <= 4098
  );

-- One open request per NFT. The API closes the old one before it stores the new; this
-- makes two posts in the same instant end as one row, not two.
CREATE UNIQUE INDEX IF NOT EXISTS nft_loan_requests_one_open
  ON nft_loan_requests (collection, token_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS nft_loan_requests_borrower
  ON nft_loan_requests (borrower, created_at DESC);

-- RLS on with no policy: no browser reads or writes this table. api/_lib/loanRequests.js
-- reads and writes as service_role, which bypasses RLS.
ALTER TABLE nft_loan_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nft_loan_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON nft_loan_requests TO service_role;

-- Without this the table exists and PostgREST answers PGRST205 (014's header).
NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '032_nft_loan_requests.sql',
  'nft_loan_requests for borrower loan requests (api/_lib/loanRequests.js): RLS on, no policies, anon/authenticated revoked, service_role SELECT/INSERT/UPDATE only.'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '032_nft_loan_requests.sql';                        -- one row
--
-- select relname, relrowsecurity from pg_class
--  where relname = 'nft_loan_requests';                                 -- true
--
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'nft_loan_requests'
--    and grantee in ('anon', 'authenticated');                         -- no rows
