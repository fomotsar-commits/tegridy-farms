-- ============================================================
-- 021 — commerce_invoices + commerce_settlements: the merchant checkout store
--
-- ⚠️ NOT APPLIED. This repo has no migration ledger; statements are applied by
--    hand against the Supabase project. Until an operator runs this file,
--    PostgREST answers 404/PGRST205 for both tables and
--    frontend/api/_lib/commerce.js reports `code: "schema-missing"` with a 503 —
--    deliberately NOT a 404 "no such invoice", because "this id was never
--    published" and "this deployment has no invoice table" are different facts
--    and only one of them is about a merchant's link. A buyer told the first
--    when the second is true concludes they were phished, and the merchant sees
--    a customer who never tried to pay.
--
-- ORDERING: independent of everything before it. Two new tables, nothing
-- existing is touched. Safe to apply at any time.
--
-- ============================================================
-- WHAT A ROW IS — AND WHAT THESE TABLES EMPHATICALLY ARE NOT
-- ============================================================
--
-- `commerce_invoices` is what a merchant published: a payee, an asset, an exact
-- amount and a deadline. `commerce_settlements` is what a browser CLAIMED
-- happened afterwards.
--
-- THESE TABLES ARE NOT CUSTODY AND NOT A PAYMENT RAIL. Nothing in this schema or
-- in the API that fronts it ever holds, moves, forwards or can authorise the
-- movement of a single token. A payment is two transactions the BUYER signs in
-- their own wallet — a swap into the settlement asset, then a transfer of the
-- exact invoiced amount directly to the merchant. There is no escrow column, no
-- balance column and no key material of any kind, and there must never be one.
--
-- `verification` IS NOT A PAYMENT CONFIRMATION. It is written `client-reported`
-- and only `client-reported`, by a hardcoded literal in api/_lib/commerce.js,
-- because nothing on this deployment reads a transaction receipt. The CHECK
-- below allows `chain-confirmed` and `chain-refuted` so that a future verifier
-- has somewhere to write, and the API has no code path that produces either.
-- ⚠️ Do NOT change the column DEFAULT to anything but 'client-reported', and do
-- NOT let an API caller choose the value: a merchant releasing goods against a
-- row that says "confirmed" when nothing checked the chain is the exact robbery
-- this design is arranged to prevent.
--
-- THERE IS NO PRICE COLUMN AND NO FIAT COLUMN. `settle_amount` is denominated in
-- `settle_token` and in nothing else. A fiat-denominated invoice would have to
-- be converted by this venue at some rate nobody agreed to, and the buyer would
-- sign for one number while the merchant was owed another the moment the price
-- moved. A merchant who thinks in fiat converts before they publish, where the
-- conversion is theirs and is visible.
--
-- `webhook_url` NEVER LEAVES THE SERVER. It is excluded from the public read's
-- explicit column list in api/_lib/commerce.js. A merchant's callback endpoint
-- is theirs, and publishing it is handing out a free target list.
--
-- ============================================================
-- AUTHORITY — AND WHY THE ONE PUBLIC READ IS SHAPED THE WAY IT IS
-- ============================================================
--
-- Publishing an invoice and reading the claims against it are keyed to the SIWE
-- JWT wallet claim, same shape as alert_rules in 016 and referral_codes in 019.
-- The API forwards the USER's JWT to PostgREST for those, so RLS is the
-- authority and the merchant column cannot be forged.
--
-- Invoice RESOLUTION cannot work that way: a buyer following a payment link has
-- no session with this venue and never will. It is not served by a public SELECT
-- policy either — a `USING (true)` here would be readable straight from the
-- browser with the published anon key, turning this table into a downloadable
-- ledger of every merchant's sales: who they invoice, for how much, how often.
-- That is the same shape api/_lib/airdrop.js refuses to expose a recipient list
-- for and api/_lib/referrals.js refuses to expose a referrer roster for.
-- Instead it runs SERVER-SIDE under the service role with a PINNED filter: one
-- id in, one invoice out, explicit columns. That query shape is pinned by
-- api/__tests__/commerce-surface-parity.test.js so a second, wider one cannot
-- quietly appear.
--
-- Recording a settlement is likewise public, and what that costs is bounded
-- rather than hidden: anyone can assert a hash against an id, so the row is a
-- CLAIM and every read of it says so. The UNIQUE constraint stops one claim being
-- written twice and the API's rate limit stops a flood; neither makes a claim
-- true.
--
-- The consequence to accept: the service role bypasses RLS, so the policies
-- below are NOT what protects the public invoice read. The FILTER is. The
-- policies protect the anon/authenticated roles, which is what a browser can
-- actually present.
-- ============================================================

CREATE TABLE IF NOT EXISTS commerce_invoices (
  -- Merchant-chosen and never derived from the amount, so an id cannot be
  -- guessed from a price. A collision is a 409 at insert rather than two rows
  -- racing to own a link that is already printed on somebody's checkout page.
  --
  -- Shape mirrors INVOICE_ID_RE in frontend/src/lib/commerce/invoice.ts and the
  -- same literal in frontend/api/_lib/commerce.js. Constrained HERE too, so a
  -- direct-to-database write cannot create an id the client will refuse to parse.
  id              text        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{7,63}$'),

  -- Lower-cased payee. Set from the AUTHENTICATED WALLET by the API, never from
  -- the request body — a caller-supplied payee would let anyone burn an id for
  -- its real owner and publish a stranger's address under this venue's name.
  merchant        text        NOT NULL CHECK (merchant ~ '^0x[0-9a-f]{40}$'),

  chain_id        integer     NOT NULL CHECK (chain_id > 0),

  settle_token    text        NOT NULL CHECK (settle_token ~ '^0x[0-9a-f]{40}$'),
  settle_symbol   text        NOT NULL CHECK (char_length(settle_symbol) BETWEEN 1 AND 32),
  settle_decimals smallint    NOT NULL CHECK (settle_decimals BETWEEN 0 AND 36),

  -- NUMERIC(78,0), not bigint. A uint256 does not fit in 64 bits, and the
  -- overflow would not be a crash — it would be a wrong amount in the one field
  -- a buyer signs against. It crosses the wire as a decimal STRING for the same
  -- reason: a JSON number loses its low digits above 2^53.
  settle_amount   numeric(78,0) NOT NULL CHECK (settle_amount > 0),

  memo            text        NOT NULL DEFAULT '' CHECK (char_length(memo) <= 200),

  -- Unix seconds. An invoice is a price the merchant committed to, and a
  -- commitment with no end is a free option on that token written against them.
  -- The 24h ceiling is enforced in the API; this only refuses the nonsensical.
  expires_at      bigint      NOT NULL,
  created_at      bigint      NOT NULL,
  CONSTRAINT commerce_invoice_window CHECK (expires_at > created_at),

  -- Read server-side only. Never in the public read's column list.
  webhook_url     text        CHECK (webhook_url IS NULL OR webhook_url ~ '^https://')
);

CREATE INDEX IF NOT EXISTS commerce_invoices_merchant_idx ON commerce_invoices (merchant);

ALTER TABLE commerce_invoices ENABLE ROW LEVEL SECURITY;

-- SELECT: the merchant reads their own invoices. There is deliberately no public
-- SELECT policy — see the header. Buyer-side resolution is a server-side read
-- with a pinned filter, not an open table.
DROP POLICY IF EXISTS "Owner reads own invoices" ON commerce_invoices;
CREATE POLICY "Owner reads own invoices" ON commerce_invoices FOR SELECT USING (
  merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- INSERT: only as self. Without this a wallet could publish an invoice naming
-- somebody else as payee — collecting nothing, but burning that id for its real
-- owner and putting a stranger's address behind this venue's checkout.
DROP POLICY IF EXISTS "Owner creates own invoices" ON commerce_invoices;
CREATE POLICY "Owner creates own invoices" ON commerce_invoices FOR INSERT WITH CHECK (
  merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- UPDATE: only as self, and WITH CHECK as well as USING — without the WITH CHECK
-- half a merchant could re-home a LIVE invoice to another payee after a buyer
-- had already loaded it, which is a redirect of somebody else's money.
DROP POLICY IF EXISTS "Owner updates own invoices" ON commerce_invoices;
CREATE POLICY "Owner updates own invoices" ON commerce_invoices FOR UPDATE USING (
  merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
) WITH CHECK (
  merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- DELETE: only as self. Withdrawing an invoice stops the link resolving; it
-- touches nothing on-chain and nothing here pretends it does. A payment already
-- broadcast against it is unaffected — which is why the settlement rows below
-- are NOT cascade-deleted with it.
DROP POLICY IF EXISTS "Owner deletes own invoices" ON commerce_invoices;
CREATE POLICY "Owner deletes own invoices" ON commerce_invoices FOR DELETE USING (
  merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_invoices TO authenticated;


CREATE TABLE IF NOT EXISTS commerce_settlements (
  id           bigserial   PRIMARY KEY,

  -- Deliberately NOT a foreign key with ON DELETE CASCADE. A merchant deleting
  -- an invoice must not delete the record of the payments claimed against it —
  -- that would let a merchant erase the evidence a buyer would point at. It is
  -- also not a foreign key at all, so a race between a withdrawal and a
  -- broadcast cannot reject a claim about a transaction that really happened.
  invoice_id   text        NOT NULL CHECK (invoice_id ~ '^[a-z0-9][a-z0-9-]{7,63}$'),

  tx_hash      text        NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  payer        text        NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),

  -- ⚠️ THE FIELD A MERCHANT DECIDES ON. See the header: the API writes
  -- 'client-reported' from a hardcoded literal and has no path that writes
  -- anything else, because nothing on this deployment reads a receipt. The other
  -- two values exist so a future on-chain verifier has somewhere to write, and
  -- adding one to an API response without adding the receipt read that justifies
  -- it is how a merchant gets robbed.
  verification text        NOT NULL DEFAULT 'client-reported'
                           CHECK (verification IN ('client-reported', 'chain-confirmed', 'chain-refuted')),

  recorded_at  bigint      NOT NULL,

  -- One claim per hash per invoice. Stops the same assertion being written twice
  -- and stops a duplicate callback firing; it does not make the claim true.
  CONSTRAINT commerce_settlement_unique UNIQUE (invoice_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS commerce_settlements_invoice_idx ON commerce_settlements (invoice_id);

ALTER TABLE commerce_settlements ENABLE ROW LEVEL SECURITY;

-- SELECT: only the merchant who owns the invoice the claim is against. Joined
-- through commerce_invoices rather than stored twice, so there is one answer to
-- "whose invoice is this" and it cannot drift.
DROP POLICY IF EXISTS "Owner reads settlements for own invoices" ON commerce_settlements;
CREATE POLICY "Owner reads settlements for own invoices" ON commerce_settlements FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM commerce_invoices i
    WHERE i.id = commerce_settlements.invoice_id
      AND i.merchant = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  )
);

-- No INSERT / UPDATE / DELETE policy for `authenticated`, and that absence is
-- the design. Writes come from the API under the service role, because the payer
-- is a signed-out visitor. A merchant with an insert policy could manufacture
-- settlement rows against their own invoices; a merchant with an update policy
-- could rewrite `verification`.

GRANT SELECT ON commerce_settlements TO authenticated;

-- PostgREST caches the schema. A new table it has not seen answers PGRST205 —
-- "could not find the table" — until the cache is reloaded or the connection
-- recycles, so without this line the tables exist, every checkout call fails,
-- and the migration looks like it did nothing. Migrations 014 and 019 carry the
-- same line for the same reason.
-- ── Record this file in the ledger ────────────────────────────────────
-- Added 2026-08-24: the self-recording INSERT MIGRATIONS.md describes was
-- missing from every file after 000 — the ledger was fiction for 016-021.
INSERT INTO public.schema_migrations (filename, note)
VALUES ('021_commerce.sql', 'commerce_invoices + commerce_settlements; webhooks need COMMERCE_WEBHOOK_SECRET')
ON CONFLICT (filename) DO NOTHING;

NOTIFY pgrst, 'reload schema';

