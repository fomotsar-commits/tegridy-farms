-- ============================================================
-- 030_nft_loan_offers.sql: the NFT loan offer book and the loans opened from it
--
-- NFT lending runs on Gondi's own v3.2 loan contract (contracts/vendor/gondi-v3.2).
-- A Gondi offer is a lender's signature, not a deposit, so the site needs somewhere to keep
-- the signed offers for borrowers to find. api/_lib/loanOffers.js (served from
-- api/orderbook.js) is the only reader and writer, as service_role.
--
--   nft_loan_offers  one row per signed offer, keyed by (lender, offer_id): Gondi tracks
--                    use and cancellation per lender and offer id, so the id must be
--                    unique per lender.
--     offer          the signed offer, numbers as decimal strings (src/lib/gondi/loanOffer.js)
--     token_id       0 = any NFT in the collection (Gondi's whole-collection offer)
--     status         active, or closed once the chain says cancelled or used up
--   nft_loans        one row per loan, recorded from its transaction's LoanEmitted event
--     loan           the Loan struct as emitted (Gondi stores only its hash, and repay or
--                    claim must send the whole struct back)
--     status         open, repaid, liquidated or refinanced
--
-- Nothing here holds money or can move it. A wrong row can only show an offer the loan
-- contract then refuses, and the site re-checks every offer and loan on chain before it
-- offers a button.
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md), before NFT lending
-- goes live. Needs the ledger, public.schema_migrations (000_base_schema.sql section 0).
-- Touches no other table. Idempotent: re-running it is safe. Numbered 030 because 029 is
-- held by the open fill-scoreboard PR.
-- ============================================================

CREATE TABLE IF NOT EXISTS nft_loan_offers (
  lender        text        NOT NULL,
  offer_id      numeric(78, 0) NOT NULL,
  collection    text        NOT NULL,
  token_id      numeric(78, 0) NOT NULL,
  principal_wei numeric(78, 0) NOT NULL,
  apr_bps       integer     NOT NULL,
  duration_s    integer     NOT NULL,
  capacity_wei  numeric(78, 0) NOT NULL,
  expires_at    timestamptz NOT NULL,
  offer         jsonb       NOT NULL,
  signature     text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  PRIMARY KEY (lender, offer_id)
);

ALTER TABLE nft_loan_offers DROP CONSTRAINT IF EXISTS nft_loan_offers_shape;
ALTER TABLE nft_loan_offers
  ADD CONSTRAINT nft_loan_offers_shape
  CHECK (
    lender ~ '^0x[0-9a-f]{40}$'
    AND collection IN (
      '0xd37264c71e9af940e49795f0d3a8336afaafdda9',  -- Jungle Bay Ape Club
      '0xd774557b647330c91bf44cfeab205095f7e6c367',  -- Nakamigos
      '0xa1de9f93c56c290c48849b1393b09eb616d55dbb'   -- GNSS Art
    )
    AND offer_id >= 0 AND token_id >= 0 AND principal_wei > 0 AND capacity_wei >= 0
    AND apr_bps > 0 AND duration_s > 0
    AND status IN ('active', 'closed')
    AND signature ~ '^0x[0-9a-fA-F]+$' AND length(signature) <= 4098
  );

CREATE INDEX IF NOT EXISTS nft_loan_offers_open
  ON nft_loan_offers (collection, expires_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS nft_loans (
  loan_id     numeric(78, 0) PRIMARY KEY,
  borrower    text        NOT NULL,
  lender      text        NOT NULL,
  collection  text        NOT NULL,
  token_id    numeric(78, 0) NOT NULL,
  loan        jsonb       NOT NULL,
  emit_tx     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'open',
  close_tx    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

ALTER TABLE nft_loans DROP CONSTRAINT IF EXISTS nft_loans_shape;
ALTER TABLE nft_loans
  ADD CONSTRAINT nft_loans_shape
  CHECK (
    borrower ~ '^0x[0-9a-f]{40}$' AND lender ~ '^0x[0-9a-f]{40}$' AND collection ~ '^0x[0-9a-f]{40}$'
    AND emit_tx ~ '^0x[0-9a-f]{64}$' AND (close_tx IS NULL OR close_tx ~ '^0x[0-9a-f]{64}$')
    AND status IN ('open', 'repaid', 'liquidated', 'refinanced')
  );

CREATE INDEX IF NOT EXISTS nft_loans_borrower ON nft_loans (borrower, created_at DESC);
CREATE INDEX IF NOT EXISTS nft_loans_lender ON nft_loans (lender, created_at DESC);

-- RLS on with no policy: no browser reads or writes these tables. api/_lib/loanOffers.js
-- reads and writes as service_role, which bypasses RLS.
ALTER TABLE nft_loan_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nft_loans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nft_loan_offers FROM anon, authenticated;
REVOKE ALL ON nft_loans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON nft_loan_offers TO service_role;
GRANT SELECT, INSERT, UPDATE ON nft_loans TO service_role;

-- Without this the tables exist and PostgREST answers PGRST205 (014's header).
NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '030_nft_loan_offers.sql',
  'nft_loan_offers + nft_loans for the Gondi NFT loan book (api/_lib/loanOffers.js): RLS on, no policies, anon/authenticated revoked, service_role SELECT/INSERT/UPDATE only.'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '030_nft_loan_offers.sql';                          -- one row
--
-- select relname, relrowsecurity from pg_class
--  where relname in ('nft_loan_offers', 'nft_loans');                  -- both true
--
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
--  where table_name in ('nft_loan_offers', 'nft_loans')
--    and grantee in ('anon', 'authenticated');                         -- no rows
