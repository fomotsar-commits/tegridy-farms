-- ============================================================
-- 018 — airdrop_manifests / airdrop_manifest_entries: the hosted claim-list store
--
-- ⚠️ NOT APPLIED. This repo has no migration ledger; statements are applied by
--    hand against the Supabase project. Until an operator runs this file,
--    PostgREST answers 404/PGRST205 and frontend/api/_lib/airdrop.js reports
--    `code: "schema-missing"` — deliberately NOT "you are not in this campaign",
--    because "no manifest could ever have been stored" and "this wallet is not a
--    recipient" are different facts and only one of them is about the wallet.
--
-- ORDERING: independent of every prior migration. Creates two new tables and
-- touches nothing existing.
--
-- ─── WHY SUPABASE AND NOT A PONDER TABLE ────────────────────────────────────
--
-- A Ponder `onchainTable` is written exclusively by an event handler from chain
-- data, and Ponder REBUILDS its tables from chain on every re-index (a schema
-- change, a fresh database, an RPC re-org replay). A creator-uploaded recipient
-- list cannot be reconstructed from chain — the chain stores one 32-byte root and
-- nothing else. So a manifest in a Ponder table is a manifest that a routine
-- re-index silently destroys, and every campaign funded against it becomes
-- unclaimable by everyone. That is not a degradation, it is a loss of other
-- people's money.
--
-- The list is also creator-authored, needs authenticated writes, and needs an
-- indexed single-account lookup. All three are Postgres jobs. Ponder stays the
-- authority for what the CHAIN says; this store is the authority for what the
-- creator published, and the API cross-checks one against the other.
--
-- ─── WHY NEITHER TABLE HAS A CLIENT-REACHABLE ROLE ──────────────────────────
--
-- The recipient list of an airdrop is a wallet-targeting database: every row is
-- an address with a balance worth phishing, grouped by the criteria that selected
-- it. A full-list read is therefore not a feature with a missing permission
-- check, it is a thing that must not be expressible.
--
-- RLS is enabled on both tables and NO policy is created for `anon` or
-- `authenticated`, and both roles are REVOKEd. With RLS on and no policy,
-- PostgREST returns zero rows to every client role no matter what it asks for.
-- The only reader is the service role (which bypasses RLS) inside
-- frontend/api/_lib/airdrop.js, and that file has exactly two entry-row queries:
--
--   1. the tree rebuild, which selects `leaf_index, leaf` and NO account column,
--      so the query that touches every row cannot return an address at all; and
--   2. the claimant lookup, which is filtered `account=eq.<one address>` and
--      capped at one row.
--
-- Those two shapes are pinned by api/_lib/__tests__/airdrop.test.js. Adding a
-- SELECT policy here, or a query that selects `account` without an `account=eq.`
-- filter, re-opens the exposure this comment exists to prevent.
--
-- A claimant is NOT required to sign in. Making someone authenticate to be told
-- their own allocation would be hostile, and the per-account filter is what keeps
-- that safe rather than a session.
-- ============================================================

-- ─── The manifest: one row per published campaign list ───────────────────────
CREATE TABLE IF NOT EXISTS airdrop_manifests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chain the campaign lives on. Part of the identity: the same root published
  -- for mainnet and for a testnet are two campaigns, not one.
  chain_id        integer     NOT NULL CHECK (chain_id > 0),

  -- THE CAMPAIGN'S IDENTITY. Lower-cased 0x-prefixed 32-byte merkle root.
  -- Keyed on the root rather than on the distributor address because the creator
  -- publishes the list BEFORE `createCampaign` is signed — that ordering is the
  -- point of requirement 3, so the creator sees the root they are committing to
  -- while the funding transaction is still unsent. At publish time no distributor
  -- exists yet.
  root            text        NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),

  -- Filled in AFTER `createCampaign` lands, so a claimant holding only a
  -- distributor address can find the list. Nullable forever: a published list
  -- that was never funded is a real and harmless state, and NULL here means
  -- "no campaign contract has been attached", never "the campaign is gone".
  distributor     text        CHECK (distributor IS NULL OR distributor ~ '^0x[0-9a-f]{40}$'),

  -- ERC-20 being distributed, as the creator declared it. Advisory only: the
  -- distributor's own `campaignInfo()` is the authority and the claim surface
  -- reads it from chain. Recorded so a mismatch is visible.
  token           text        CHECK (token IS NULL OR token ~ '^0x[0-9a-f]{40}$'),

  -- Lower-cased SIWE wallet that published this list. The only wallet allowed to
  -- attach a distributor to it later.
  creator         text        NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),

  -- Row count, stored rather than counted on read. This is the number the claim
  -- surface prints when it tells a wallet it is not in the list, and a wallet
  -- given a negative verdict is owed the size of the list that excluded it. It is
  -- also the cross-check that a tree rebuild read every row: a rebuild that
  -- fetched fewer leaves than this produces a different root and is refused.
  recipient_count integer     NOT NULL CHECK (recipient_count > 0),

  -- Sum of every entry's amount, in BASE UNITS. `numeric` and not `bigint`:
  -- a uint256 allocation is up to 78 digits and does not fit in 64 bits.
  total           numeric     NOT NULL CHECK (total > 0 AND total = trunc(total)),

  -- Free text: snapshot block, Heat floor, exclusions. Printed verbatim on the
  -- claim surface. A wallet told it is not in the list is owed the rule that
  -- excluded it, not just the verdict.
  criteria        text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One manifest per (chain, root). Makes a double-submitted publish a 409
  -- instead of two lists that disagree about the same root.
  CONSTRAINT airdrop_manifests_unique_root UNIQUE (chain_id, root)
);

CREATE INDEX IF NOT EXISTS idx_airdrop_manifests_distributor
  ON airdrop_manifests(chain_id, distributor)
  WHERE distributor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_airdrop_manifests_creator
  ON airdrop_manifests(creator);

-- ─── The entries: one row per recipient ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS airdrop_manifest_entries (
  manifest_id  uuid    NOT NULL REFERENCES airdrop_manifests(id) ON DELETE CASCADE,

  -- The `index` field of the leaf tuple, and the claimed-bitmap slot this
  -- recipient will occupy on-chain forever. Assigned by address order at build
  -- time so anyone holding the same list rebuilds the same root; never by the
  -- creator's spreadsheet row order.
  leaf_index   integer NOT NULL CHECK (leaf_index >= 0),

  account      text    NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),

  -- Base units. `> 0` mirrors the build-time rejection of zero-amount leaves: a
  -- zero leaf burns its bitmap slot on a transfer of nothing.
  amount       numeric NOT NULL CHECK (amount > 0 AND amount = trunc(amount) AND amount < 2::numeric ^ 256),

  -- keccak256(abi.encodePacked(uint256 index, address account, uint256 amount)),
  -- as src/lib/merkle/core.js computes it and as the vendored Uniswap
  -- distributor verifies it.
  --
  -- STORED, NOT DERIVED-ON-READ, for one reason: the tree rebuild that generates
  -- a proof needs every leaf in the campaign but must not read a single address
  -- to do it. Selecting `leaf_index, leaf` gives the rebuild everything it needs
  -- and nothing it does not. The API re-derives this leaf from `account` and
  -- `amount` for the ONE row it is asked about and refuses to serve a proof if
  -- the stored leaf and the re-derived leaf disagree, so a tampered `leaf` column
  -- cannot survive into a served proof.
  leaf         text    NOT NULL CHECK (leaf ~ '^0x[0-9a-f]{64}$'),

  PRIMARY KEY (manifest_id, leaf_index),

  -- One row per wallet per campaign. The builder already refuses a list with a
  -- duplicated address (summing two rows would change the amount the creator
  -- reviewed without saying so); this is the same refusal at the storage layer,
  -- and it is what makes the single-account lookup provably at most one row.
  CONSTRAINT airdrop_entries_unique_account UNIQUE (manifest_id, account)
);

-- The claimant lookup's index. `(manifest_id, account)` is already covered by the
-- unique constraint above, so no second index is created for it — the constraint's
-- index is the one that serves the only per-account query there is.

-- ─── Authority ───────────────────────────────────────────────────────────────
--
-- RLS ON with NO policies. This is not an oversight and it is not a TODO: it is
-- the enforcement. PostgREST reaches Postgres as `anon` or `authenticated`, both
-- of which are subject to RLS, and a table with RLS enabled and no matching
-- policy returns zero rows for every statement. The service role bypasses RLS and
-- is used only by frontend/api/_lib/airdrop.js, which is the sole place the
-- per-account scoping is implemented and tested.
--
-- Do not "fix" the missing policies. A SELECT policy on
-- airdrop_manifest_entries reachable by `anon` is a public recipient-list dump.
ALTER TABLE airdrop_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE airdrop_manifest_entries ENABLE ROW LEVEL SECURITY;

-- Belt-and-braces on top of RLS. RLS is the authority, but a revoked grant means
-- a future policy added by mistake still cannot reach the table.
REVOKE ALL ON airdrop_manifests FROM anon;
REVOKE ALL ON airdrop_manifests FROM authenticated;
REVOKE ALL ON airdrop_manifest_entries FROM anon;
REVOKE ALL ON airdrop_manifest_entries FROM authenticated;
