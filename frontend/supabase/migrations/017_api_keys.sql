-- ============================================================
-- 017_api_keys.sql — the key store for the /api/v1 developer API
--
-- WHY
-- ---
-- api/v1/index.js has advertised `Access-Control-Allow-Headers: …, X-API-Key`
-- since it was written and never read the header. This table is what makes that
-- header mean something: api/_lib/apiAuth.js resolves a presented key to a tier,
-- and refuses when it cannot.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
--   * No plaintext key. `key_hash` is SHA-256 of a 32-byte CSPRNG secret. The
--     secret is returned once, at issuance, and never again — there is no
--     "reveal key" path because there is nothing left to reveal. SHA-256 rather
--     than bcrypt is correct for a high-entropy random token (no dictionary to
--     run, no work factor worth paying per request); it would be wrong for a
--     password and this table holds none.
--   * No billing columns — no customer id, no subscription id, no card. Billing
--     is not wired and a schema that implies it is would invite a UI that takes
--     payment nothing can settle. When a processor lands it brings its own
--     migration.
--   * No usage table. Metering runs on Upstash counters (apiAuth.js), which are
--     the enforcement point; a durable usage ledger belongs on the dedicated API
--     host alongside the invoices it would support, not here where nothing would
--     write it.
--
-- Run in the Supabase SQL editor AFTER 015_drop_permissive_policy_overrides.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Hex SHA-256. UNIQUE so a hash collision or a double-insert cannot produce two
  -- rows one lookup would have to choose between.
  key_hash     text        NOT NULL UNIQUE,
  -- `mtk_` + 8 chars. Enough to name a key in a dashboard, useless as a credential.
  key_prefix   text        NOT NULL,
  -- Lowercased EVM address from the SIWE session that minted the key.
  owner_wallet text        NOT NULL,
  -- Must name an entry in api/_lib/apiTiers.js. A value that does not is treated
  -- by apiAuth.js as "entitlement cannot be determined" and refused with 503 —
  -- never silently downgraded to free, never silently upgraded.
  tier         text        NOT NULL DEFAULT 'free',
  label        text        NOT NULL DEFAULT 'default',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Revocation is a timestamp, not a delete: a key that was used must stay
  -- attributable after it is withdrawn.
  revoked_at   timestamptz
);

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_shape;
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_shape
  CHECK (
    key_hash ~ '^[0-9a-f]{64}$'
    AND length(key_prefix) BETWEEN 4 AND 32
    AND owner_wallet ~ '^0x[0-9a-f]{40}$'
    AND length(tier) BETWEEN 1 AND 32
    AND length(label) BETWEEN 1 AND 64
  );

-- The hot path: one equality lookup per keyed request.
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash);
-- The issuance path counts a wallet's ACTIVE keys against MAX_KEYS_PER_WALLET.
CREATE INDEX IF NOT EXISTS api_keys_owner_active_idx
  ON api_keys (owner_wallet) WHERE revoked_at IS NULL;

-- ── RLS: closed, and it stays closed ────────────────────────────────────────
--
-- RLS ENABLED WITH NO POLICIES = every role except service_role reads and writes
-- NOTHING. That is the intent, not an oversight, and it is why there is no
-- "users can read their own keys" policy here: the anon key is shipped in the
-- browser bundle, so any policy readable by `anon` is readable by everyone, and
-- `key_hash` is the credential itself. The only path in is api/_lib/apiAuth.js
-- holding SUPABASE_SERVICE_KEY, which scopes every owner-facing query by the
-- wallet in the verified SIWE JWT.
--
-- Do NOT add a PostgREST-facing SELECT policy to make a dashboard easier. The
-- dashboard reads GET /api/v1?route=keys, which returns metadata only.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

REVOKE ALL ON api_keys FROM anon;
REVOKE ALL ON api_keys FROM authenticated;

-- ── Operator notes ──────────────────────────────────────────────────────────
--
-- Granting a paid tier is a manual UPDATE until a payment processor exists.
-- Self-serve issuance can only mint the tier whose price is zero (apiTiers.js
-- `isSelfServeTier`), so this statement is the ONLY way a paid entitlement is
-- created, and it should follow a settled invoice:
--
--   UPDATE api_keys SET tier = 'starter' WHERE key_prefix = 'mtk_XXXXXXXX';
--
-- Revoking:
--
--   UPDATE api_keys SET revoked_at = now() WHERE key_prefix = 'mtk_XXXXXXXX';
--
-- Revocation takes effect on the next request: apiAuth.js does not cache
-- verification results, which costs one round trip per keyed call and buys the
-- property that a withdrawn key stops working immediately.
