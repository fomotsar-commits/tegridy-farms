# Supabase restore runbook

**Nothing in this repo applies SQL.** Every step below is executed by a person
in the Supabase SQL editor or by a script they invoke deliberately. Reading
this file changes nothing.

This is the other half of `.github/workflows/supabase-backup.yml`. That
workflow is fine — it fails loudly, encrypts before upload, and refuses to ship
a partial bundle. The gap it cannot close on its own is that a restore needs
somewhere to restore **into**, and until `000_base_schema.sql` was committed,
five of the ten live tables existed nowhere in this repo.

---

## What a restore can and cannot bring back

| | |
|---|---|
| **Recoverable** | The ten tables in the weekly bundle: `native_orders`, `trade_offers`, `messages`, `dm_messages`, `user_profiles`, `user_favorites`, `user_watchlist`, `votes`, `push_subscriptions`, `revoked_jwts`. |
| **Deliberately not backed up** | `siwe_nonces` — 5-minute TTL. Every nonce in a bundle is dead before the bundle is opened. |
| **⚠️ Not in any bundle, and not recoverable from one** | `analytics_events` (013), `alert_rules` (016), `api_keys` (017), `airdrop_manifests` + `airdrop_manifest_entries` (018). The workflow's `TABLES` list was written against the API surface as it stood and has **not grown with these five migrations**. `airdrop_manifest_entries` is the one that costs money: 018's own header explains that a lost manifest makes a funded campaign unclaimable by everyone, because the chain stores one 32-byte root and nothing else. |
| **Never recoverable** | Anything a user had in `localStorage` only — every write path in `src/nakamigos/lib/userdata.js` falls back to local storage when the cloud write is refused, and that copy is on their device. |

`scripts/supabase-restore.mjs` prints the "not in any bundle" list on every
run, including dry runs, so a restore cannot be mistaken for a full recovery.

---

## Step 0 — Decide what you are doing

Two different operations share this page. They are not interchangeable.

- **Rebuild** — a fresh or wiped Supabase project. Do steps 1–5 in order.
- **Repair** — the live project, one missing object. Apply only the file that
  creates it, then step 4. Do **not** walk the whole list against a live
  database; several files below are only safe on an empty one.

---

## Step 1 — Decrypt the bundle

```sh
gpg --decrypt --batch --passphrase "$BACKUP_PASSPHRASE" \
  supabase-backup-<date>.tar.gz.gpg | tar -xz
# → backup/<table>.json, one JSON array per table
```

Without `BACKUP_PASSPHRASE` the artifact is noise. It is a repo secret with no
recovery path; the offline copy the workflow header asks for is the whole
safety net.

---

## Step 2 — Schema, in this order

Filename order is **wrong**, twice over: `001` aborts partway through, and
running `014` before `015` is the single most expensive ordering mistake in the
repo. Use this list.

| # | File | Why here |
|---|---|---|
| 1 | `000_base_schema.sql` | The five tables no other migration creates, plus the `schema_migrations` ledger. Everything after it assumes these exist. |
| 2 | `002_native_orders_trades_push.sql` | Creates `native_orders`, `trade_offers`, `push_subscriptions`. Its policy `DROP`/`CREATE`s on the five tables from step 1 are idempotent re-assertions. |
| 3 | `003_revoked_jwts.sql` | `revoked_jwts` + `prune_revoked_jwts()`. Needed before 004 §1 can `ALTER` that function. |
| 4 | `005_add_seaport_order_hash.sql` | Alters `native_orders`. Needs step 2. |
| 5 | `006_audit_2026_05_26.sql` | Creates `toggle_like`. Needed before 004 §1 can `ALTER` it — and this is the version to keep; 001's is superseded. |
| 6 | `007_p2p_trades_and_chat.sql` | `dm_messages`, `messages.reactions`, `trade_offers` alters, first `toggle_reaction`. |
| 7 | `004_security_hardening.sql` | ⚠️ see the traps below before running. Out of numeric position on purpose: §1 `ALTER`s functions that steps 3 and 5 create. |
| 8 | `008_grant_new_table_roles.sql` | ⛔ **Must be before 014.** See traps. |
| 9 | `009_messages_slug_column.sql` | A no-op after step 1 — `000` already declares `slug` and the same index. Run it anyway so the ledger records it. |
| 10 | `010_reaction_auth_hardening.sql`, `011_reaction_jwt_binding.sql` | Reaction RPC lockdown, in that order. |
| 11 | `012_bundle_listings.sql`, `013_analytics_events.sql` | Independent. |
| 12 | `015_drop_permissive_policy_overrides.sql` | ⛔ **Before 014, not alongside.** On a fresh rebuild every `DROP` is a no-op, because `000` never created the eight permissive write policies. Run it regardless: it is what makes the rebuild and the live database converge on one policy set. |
| 13 | `014_siwe_nonces.sql` | Login. Last of the core set, for the reason in the row above. |
| 14 | `016_alert_rules.sql`, `017_api_keys.sql`, `018_airdrop_manifests.sql` | ⚠️ Independent, and **not applied in production** as of 2026-08-19. Applying them here puts the rebuilt database *ahead* of prod. Do that only if you intend prod to follow; otherwise a restored project will answer differently from the one it replaced. |

**`001_siwe_auth_rls.sql` is not in this list.** It is fully superseded and it
aborts: `001:25` drops a policy on `messages` and `001:115` enables RLS on
`trade_offers`, neither of which exists at that point in the original ordering.
Every section of it has a later home — §1 → `014`, §2–§6 → `004` §4, §7 →
`006`, §8–§9 → `002` and `004` §3–§4. Running it buys nothing and stops
partway, which is exactly how the live database reached its current state. Do
not "just re-run 001".

---

## Step 3 — Reload the PostgREST schema cache

```sql
NOTIFY pgrst, 'reload schema';
```

Run it after the last file, every time, even if you think a migration already
did. PostgREST caches the schema: without a reload the tables exist and the
REST layer keeps answering `PGRST205 Could not find the table …`, which looks
exactly like the migration having done nothing. 014's header records that
outage first-hand.

**Only three files in the set reload it themselves** — `000`, `008`, `014`.
These eight create a table and do **not**, which is why the standalone `NOTIFY`
above is a step and not an afterthought:

`001_siwe_auth_rls.sql` · `002_native_orders_trades_push.sql` ·
`003_revoked_jwts.sql` · `007_p2p_trades_and_chat.sql` ·
`013_analytics_events.sql` · `016_alert_rules.sql` · `017_api_keys.sql` ·
`018_airdrop_manifests.sql`

*(`scripts/supabase-restore.test.mjs` fails if a new table-creating migration
lands without a reload and without a line here.)*

---

## Step 4 — Data

```sh
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_KEY=<service-role key>

node scripts/supabase-restore.mjs --bundle ./backup            # dry run first
node scripts/supabase-restore.mjs --bundle ./backup --apply
```

The service key is required, not a convenience: a restore has no user JWT, and
every owner-scoped policy in the schema compares against one. With the anon key
every row is refused with `42501`.

The dry run is not optional in practice — it is what tells you a table is
missing from the bundle *before* nine others have been written.

### The `messages` cooldown trigger — a hazard, not a step

`messages` carries a `BEFORE INSERT` trigger enforcing a 5-second per-author
cooldown (`000_base_schema.sql` §1, lifted from `004` §5). It is widely assumed
to block bulk loads. **It does not, on the normal path**, and the difference is
worth knowing before you disable a live security trigger.

Its predicate tests the `created_at` of rows **already in the table**, not
`NEW.created_at`:

```sql
WHERE author = NEW.author AND slug = NEW.slug
  AND created_at > now() - interval '5 seconds'
```

Restored rows carry their original timestamps — the bundle captures
`created_at` and `supabase-restore.mjs` posts rows verbatim — and no historical
timestamp is newer than `now() - 5s`. The trigger never fires.

It fires when `created_at` is **absent** from the payload and the column
`DEFAULT now()` supplies it: a hand-written `INSERT`, a column-filtered import,
a rewritten loader. Then the second row of every author raises `Rate limit
exceeded` and the table comes back holding one message per person — and the
first chunk succeeds, which is what makes it easy to miss.

So: check your payload carries `created_at` first. The script counts rows
missing it and says so. Only if they genuinely lack it, and PostgREST cannot
run DDL so it must be by hand:

```sql
ALTER TABLE public.messages DISABLE TRIGGER rate_limit_messages;
--   … run the restore …
ALTER TABLE public.messages ENABLE TRIGGER rate_limit_messages;
```

Disable, never drop. Re-enabling is one statement; remembering to recreate a
dropped trigger is a thing nobody does.

---

## Step 5 — Verify

1. **Row counts match the bundle.** `jq length backup/<table>.json` against a
   `Prefer: count=exact` read of each table.
2. **RLS bit.** With the **anon** key, an empty-body `POST` to
   `/rest/v1/user_profiles`, `/rest/v1/user_favorites`, `/rest/v1/user_watchlist`
   and `/rest/v1/votes` must return **42501**. A `23502` (null violation) means
   the request got past RLS and the write policies did not bite — stop and
   re-check step 2 row 12.
3. **Login.** `GET /api/auth/siwe?action=nonce` returns **200**. A 500 means
   `siwe_nonces` is missing or invisible — re-run step 3.
4. **The trigger is back on.** `select tgenabled from pg_trigger where tgname =
   'rate_limit_messages';` → `O`, not `D`.
5. **The ledger.** `select filename from public.schema_migrations order by 1;`
   should list every file you applied. If it does not, you applied a file that
   does not yet carry its ledger insert — see `MIGRATIONS.md`.

---

## Traps

Each of these is a real incident shape, not a style preference.

**⛔ Never apply `008` after `014`.**
`008:20` is a blanket `GRANT … ON ALL TABLES … TO anon, authenticated`, and
014's whole security posture is `REVOKE ALL ON siwe_nonces FROM anon,
authenticated`. Running 008 afterwards hands the login CSRF-token table back to
the anon key that ships in the browser bundle. 008 also sets `ALTER DEFAULT
PRIVILEGES`, so **every table created after it is anon-reachable by default** —
which is why `000`, `014`, `017` and `018` each have to take the grant back by
hand. Assume the trap on any new table.

**⛔ Never run `004` as a unit against the live database.**
On a fresh rebuild in the order above, its dependencies are satisfied and it
applies cleanly — that is why it is step 7 rather than excluded. Against the
live project it is a different file: 001 only partly applied there, so 004 §1's
`ALTER FUNCTION` statements can hit a signature that does not exist, and a
migration that aborts halfway is precisely how this database acquired two
generations of overlapping policies. On live, take only the three statements
from §2 (`prune_revoked_jwts` `REVOKE` + `SET search_path`) as a standalone
migration. **This claim about the rebuild path is reasoned from the file
contents, not from an applied run — if any statement errors, stop, and do not
"finish the rest by hand".**

**⛔ `015` before `014`, never the reverse.**
014 makes login work. 015 removes eight permissive policies whose `qual` is
literally `true` and which OR-defeat every owner policy on `user_favorites`,
`user_profiles`, `user_watchlist` and `votes`. Those tables are harmless today
*only because nobody can log in*. Turn login on first and every user's
favourites, watchlist, profile and votes are world-readable and world-writable
by anyone holding the anon key. On a rebuild from `000` the exposure never
exists in the first place — but keep the order, so the rebuild and the live
sequence are the same sequence.

**⛔ Two files sharing a number.**
On 2026-08-19 two independent slices both wrote `016`; the API one was
renumbered by hand. The failure mode is silent: you apply one, record "016
done", and the other never lands at all. `scripts/supabase-restore.test.mjs`
now fails on a duplicate number. See `MIGRATIONS.md`.

**⚠️ `revoked_jwts` restores a logout list, not a login list.**
Restoring it is correct — those tokens were revoked on purpose. But every JWT
issued before the outage is still cryptographically valid until it expires
(24h), whether or not the row that revoked it survived. If the incident that
caused the restore involved a key compromise, rotate `SUPABASE_JWT_SECRET`
rather than trusting this table.

**⚠️ `native_orders` and `trade_offers` hold signed Seaport orders.**
Those signatures stay fulfillable on-chain whether or not the database
remembers them. Restoring the rows is what lets makers *see and cancel* their
live orders. A restore that quietly drops these two tables leaves people
holding open orders they cannot find — which is why the script treats a missing
table file as a failure and not as an empty table.

---

## Known schema gaps this runbook does not fix

Recorded here because a restore is when someone reads this page, and both are
things a rebuild will faithfully reproduce.

- **`user_watchlist` has no UPDATE policy.** `addWatchlistRemote`
  (`userdata.js:413`) UPSERTs, so editing `target_price` or `note` on an
  existing row is an UPDATE that RLS denies. No migration ever created one and
  `000` does not invent one — that would be a behaviour change smuggled in as a
  restore. Fix it in a numbered migration if the edit path is real.
- **`messages` carries two identical public-read policies in prod** — `"Anyone
  can read"` (original raw SQL) and `"Anyone can read messages"` (002). `000`
  creates only the second; two permissive `SELECT` policies with `qual = true`
  have exactly the effect of one.
- **Every column bound enforced only in `api/_lib/proxy-schemas.js`** —
  `avatar_url` ≤ 512, `user_watchlist.note` ≤ 500, `token_id` ≤ 64, the
  `votes.week` format — exists in the proxy and **not** in the database. `000`
  does not add `CHECK`s for them: none is provable from the tree, and inventing
  one would make a restore reject rows the backup legitimately contains. A
  direct PostgREST write with a user's own JWT bypasses the proxy and therefore
  bypasses all four.
