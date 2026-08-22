# The remaining work — everything left, and exactly how to do it

**Written 2026-08-21.** This is the single canonical to-do list. Everything that could be built
without you has been built, tested, and pushed. What follows needs a key, a credential, a payment,
a signature, or a decision — plus a short tail of code work that is blocked on one of those.

**How to read this.** Items are ordered by *unlock per minute you spend*, not by size. Each has
what to run, what you should see, and what a mismatch means. If a "you should see" does not match,
stop and say so — a surprise is information.

**Three standing rules.**
1. Claude never types a secret into a field. Where a step involves a key, you set it. Never paste a
   secret into a chat, including to me.
2. Claude never changes security settings on live infrastructure and never signs anything that
   moves value.
3. ⏸️ **The Safe / custody situation is deferred by your instruction.** It is not on this list, it
   is not a blocker, and no session should reopen it. Facts preserved in
   [`WHAT_I_NEED_FROM_YOU.md`](WHAT_I_NEED_FROM_YOU.md) §0.3. The same call is assumed for the
   Squads 2-of-2 unless you say otherwise.

---

# TIER 0 — free, minutes each, unlocks the most

## 0.1 ⭐ Run the login change-set — the single biggest unlock

**Time:** ~2 minutes. **Cost:** nothing. **Unlocks:** the entire social tier.

Login has never worked in production: `siwe_nonces` does not exist, so every sign-in 500s. Until it
works, profiles, DMs, watchlists, votes, push notifications, alerts, referral claims and real
analytics are all dark — and analytics events are currently printed to the visitor's own console
and discarded.

**Do this in the Supabase dashboard → SQL Editor, one session, in this order.**

**Step 1 — the eight DROPs** (this is the security fix; it is a no-op on empty tables):

```sql
BEGIN;
DROP POLICY IF EXISTS "Anyone can delete favorites"   ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can insert favorites"   ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can upsert own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Anyone can update own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Anyone can delete watchlist"   ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can insert watchlist"   ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can insert votes"       ON public.votes;
DROP POLICY IF EXISTS "Anyone can update own vote"    ON public.votes;
COMMIT;
```

⛔ Run **Section 1 only** of `015_drop_permissive_policy_overrides.sql`. Section 2 is commented out
deliberately — enabling it blanks the public vote tally until an aggregate view exists.

**Step 2 — verify, both queries.** The first must return **zero rows**:

```sql
select tablename, cmd, policyname from pg_policies
 where schemaname='public' and permissive='PERMISSIVE' and cmd <> 'SELECT'
   and coalesce(qual, with_check)='true'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes');
```

The second must show the **owner** policies survived — including **both** `votes` twins
(`"Owner can insert votes"` *and* `"Owner can update own vote"`). The votes write is an upsert; with
only one twin, voting writes fail after the drops:

```sql
select tablename, cmd, policyname from pg_policies
 where schemaname='public'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
 order by tablename, cmd;
```

**Step 3 — run `014_siwe_nonces.sql` whole, same session.** It ends with
`NOTIFY pgrst, 'reload schema';` — **do not stop before that line**, or the table exists while the
API keeps insisting it does not.

⛔ **Never run migration 008 after 014.** Its blanket GRANT undoes 014. If you have ever run it,
tell me — repairable, but it has to be known.

**Step 4 — prove the lock bit.** With the **anon** key (not the service key), try an insert into
`user_favorites`. You want it **rejected** with `42501`. A `23502` not-null error instead means the
policy did *not* bite and the write got through — stop and tell me.

**Tell me:** the row count from re-running the full enumeration. **It should be 13** (down from 21).

*Already verified for you:* I ran the enumeration against your live database. All 21 permissive
policies are accounted for — 8 targets, 4 deferred read-side, 9 intentional public/service-role.

---

## 0.2 Redeploy Vercel

**Time:** ~5 minutes including build.

`VITE_*` variables are baked in at **build** time, so setting one without redeploying changes
nothing. Several shipped fixes are waiting on this:
- the CSP fix that currently **browser-blocks Pro Pass collection creation**
- the write-proxy repoint (so writes survive step 0.1)
- the analytics endpoint

**While you are in Settings → Environment Variables, set:**

| Variable | Value | Why |
|---|---|---|
| `VITE_ANALYTICS_ENDPOINT` | `/api/analytics` | Events currently print to the visitor's console and vanish |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` | Push; nothing can subscribe until 0.1 is done |
| `VITE_VAPID_PUBLIC_KEY` | same public value | The browser needs the public half |
| `VAPID_SUBJECT` | `mailto:` your address | Currently points at a dead domain |

**And confirm two that already exist** (check, do not change): `SUPABASE_SERVICE_KEY` must be
present and the SIWE JWT must carry a `jti` claim — the write proxy fails closed without them, so
every write would 503 the moment login starts working.

Then run `013_analytics_events.sql` and redeploy once more so both halves land.

---

## 0.3 Back up the deployer keystore + password — offline, two locations

**Time:** ~10 minutes. **This is not a custody decision; it is a backup.**

`OwnableNoRenounce` disables renounce and rejects transferring to the zero address. Lose that one
file and **18 mainnet contracts become permanently unownable.** Cheapest item on this page against
the worst tail on it.

---

# TIER 1 — one account or one paste, unlocks the largest built-but-dark surface

## 1.1 Host the indexer (~$5–20/month) — the biggest remaining unlock

**Runbook:** [`indexer/DEPLOY.md`](../indexer/DEPLOY.md). **Time:** ~30–45 minutes.

Six finished surfaces currently render "unavailable" for exactly one reason — the indexer runs
nowhere: **the pro terminal, copy-trading, competitions, charting, the portfolio history, and tax
reports.** None of them are broken. They are honest about being unhosted.

1. Railway account → provision Postgres → deploy `indexer/`.
2. Set `PONDER_RPC_URL_1` to an **authenticated** mainnet RPC (your Alchemy key). Public nodes
   rate-limit `eth_getLogs` hard enough that the historical backfill never finishes.
3. ⛔ **Put it behind a proxy with a rate limit. Never expose the raw port.** Ponder ships no auth
   and no rate limiting of its own. This is not optional hardening.
4. In Vercel set `VITE_INDEXER_URL` to the **public proxy origin, no path**, and redeploy.

**Tell me when the URL is live** and I will wire the first consumer pages.

## 1.2 Set `MEMETICS_BIRTH_SECRET`

A **server-side** Vercel variable — never `VITE_`, which would ship it to every browser. Then
redeploy.

It must be the **exact secret seacasa issued**: it is a shared HMAC key, and a self-generated value
fails on their side where you cannot see it. After setting it, launch or replay a birth and read
the answer — it is unambiguous:

| Response | Meaning |
|---|---|
| `200` + `status: enrolled` | The key matches. Done. |
| `422` + `retryable: false` | Wrong or rotated secret — the island rejected the signature. |
| `503 no_secret` | The variable never reached the deployment. Redeploy. |
| `502` | Their socket is down. Says nothing about your key. Retry later. |

## 1.3 Mint DBC config v2 — the cheapest revenue-relevant act available

**Both code gates shipped 2026-08-18 (`21835d1d`); nothing blocks you.**

Your Solana rail is armed on mainnet and has taken **zero launches**, because config v1 opens at a
**99% fee** — which makes a freshly launched token untradeable for roughly four hours. A DBC config
is **immutable**, so this cannot be corrected; it needs a v2.

```bash
node frontend/scripts/solana-dbc-operator.mjs create-config --opening-fee-bps <n> --resting-fee-bps <n> --decay-seconds <n>
```

**Print it without `--send` first**, read the resolved fee schedule it prints, then sign.

⛔ **Never publish `VITE_SOLANA_DBC_CONFIG` before v2 exists** — doing so ships public launches into
the 99% fee.

---

# TIER 2 — switches, all deliberately off

## 2.1 Apply six migrations, in this order

`016_alert_rules` · `017_api_keys` · `018_airdrop_manifests` · `019_referral_codes` ·
`020_telegram_links` · `021_commerce`

All written, none applied. Two things to know:
- Each surface answers **`503 schema-missing` with the migration path attached** until you run its
  file — never a confident empty result. A surface that looks broken is telling you which migration
  is missing.
- `019`, `020` and `021` end with `NOTIFY pgrst, 'reload schema'`. Do not stop before that line.

## 2.2 Deploy the contracts (all written, all deployed nowhere)

Thirteen constants in `frontend/src/lib/constants.ts` are the zero address, and every surface gates
on `isDeployed()`. **Filling in an address is the entire activation step** — no code change.

`AIRDROP_FACTORY` · `VESTING_FACTORY` · `TEGRIDY_LOCK_VAULT` · `LAUNCH_LOCK_VIEW` ·
`POSITION_MARKET` · `LaunchRugEscrow` · `DecayingFeeHook` · the ERC-4626 harvest vault ·
`TEGRIDY_LENDING` (⛔ oracle-gated — see below) · `TEGRIDY_RESTAKING` (⛔ needs external re-audit) ·
`TEGRIDY_PRO_PASS` · and the governance set (`GAUGE_CONTROLLER`, `VOTE_INCENTIVES`,
`COMMUNITY_GRANTS`, `MEME_BOUNTY_BOARD` — these are **already deployed on mainnet**, zeroed here on
purpose because they spend).

**Orderings that cost you something if reversed:**
- ⛔ **`setFeeSink(...)` BEFORE `setFee(...)`** on the escrow and factories. A fee with a zero sink
  is snapshotted as zero, so the reverse order silently ships free escrows until the next one opens.
- ⛔ **The rug escrow ships with openings disabled.** `setOpeningsEnabled(true)` is a separate
  deliberate act.
- ⛔ **The decaying-fee hook's owner is set in the constructor**, because the deploy script mines a
  CREATE2 address over the constructor args. Decide the owner *before* deploying — rotating
  afterwards changes the address and invalidates the mine.
- ⛔ **`TegridyLending` must not deploy before the TWAP is warm.** Origination calls
  `_assertSpotWithinTWAP` against an oracle with zero observations; it would revert on every
  valuation. That needs the pool deepen first.

## 2.3 Two tiny changes with outsized effect

**(a) Add `getcontractcreation` to the Etherscan proxy's `ALLOWED_ACTIONS`**
(`frontend/api/etherscan.js`). Right now a token's deployer cannot be resolved, so **most terminal
rows show UNRATED** — that is the honest state, and this one line is what turns the terminal from
sparse into the product. The deployer-reputation score is the whole differentiator.

**(b) Add an output amount to the indexer's `swap` table** (`indexer/ponder.schema.ts`). The row
records `amountIn` but no output and no price, so **no realised return is computable anywhere** —
not for copy-trading leaders, not for competitions, not for tax cost-basis. It is not caution; the
number does not exist. One column makes all three real.

## 2.4 Fee dials — a flag and a price are two decisions

Nothing charges anything today. Each needs both halves:
- **Swap/trigger/terminal:** `VITE_SWAP_FEE_BPS` + `VITE_SWAP_FEE_RECIPIENT`
- **Heat-tier launch pricing:** `VITE_LAUNCH_TIER_PRICING=on` + a **full five-tier** bps table (all
  five tier words, or it refuses to apply — a partial table would silently price someone at a
  default they never chose)
- **Creator revenue share:** `VITE_CREATOR_FEE_SHARE=on` + `VITE_CREATOR_FEE_SHARE_BPS`

The venue's take is **structurally capped** at today's rate: no configuration can raise it, because
the resolver rejects any tier priced above the standard line.

## 2.5 Services built and hosted nowhere

Besides the indexer: the **Solana indexing leg** (same host, runs beside Ponder) and the
**Telegram bot** (`bot/DEPLOY.md` — zero npm dependencies on purpose, non-custodial by
construction: its credential can bind a chat and can *never* attach a wallet).

---

# TIER 3 — external, long lead times, start early

| # | Action | Note |
|---|---|---|
| 3.1 | **Send the Whetstone petition** | Written, fact-checked, ready. It asks them to whitelist the graduation migrator on deploy. Without it, venue graduation reverts at pool initialization. The BUSL grant question travels with it. |
| 3.2 | **Send the Solana audit RFQ** | Written, never sent. Audit *calendars* are the schedule constraint, not engineering — send before you think you need it. |
| 3.3 | **Send the seacasa wave-three packet** | Written, never handed over. Add the fifth question: **when does the island publish its attestation signing key, and at what route?** Without it the Heat gate stays advisory — anyone reading the Airlock ABI can launch around it. |
| 3.4 | Book the EVM firm audit | Sequenced after any admin-model change so the report is not invalidated. |
| 3.5 | SEAL 911 / Safe Harbor · Immunefi (fix the 404'd link in `AUDITS.md:178` first) · DefiLlama (after the pool deepen) · legal entity + tax scoping | None started; none pending on anyone else. |

---

# Decisions I need one sentence on

1. **The PWA app name.** The manifest description is corrected but the *name* is untouched — the
   app is "Tegridy Farms" at memetic.fun with a Tradermigos marketplace inside it, and installing
   from the marketplace produces an app named after the venue. Renaming an installed app out from
   under someone is not a call to make by inference.
2. **The flagged wing** — perps, the synthetic dollar, the gambling items. Built nothing; each
   conflicts with a written house law and would need that law amended in a commit first.

*Already answered, recorded, and acted on:* graduation venue → **V4 hooked pool** · airdrop
manifests → **hosted** (they went to Supabase, not the indexer: a Ponder table is rebuilt from
chain on every re-index, which would have destroyed every manifest).

---

# ⏰ Clocks that run whether or not you act

| When | What | If missed |
|---|---|---|
| **~2026-10-11** | Staking reserve runway ends | Claims silently pay **partial with IOUs** — quieter than a revert and worse for trust |
| **~Aug 2027** | `memetics.finance` renewal (1-year, registered 2026-08-02) | A second production domain lapses while monitoring stays green |
| Standing | `TegridyStaking` has **22 bytes** of EIP-170 headroom; `VoteIncentives` has **99** | The next one-line edit to either makes its redeploy artifact undeployable. The extraction is unbuilt. Do not casually edit those two files. |

---

# What is running or waiting on me

- Clearing the **53 orphaned type errors** and wiring `tsconfig.test.json` into the build, so test
  files are actually typechecked. Includes two production errors nothing has ever seen:
  `irysClient.ts` disagreeing with itself about the ambient `Window` type across two projects, and a
  `playwright.config.ts` line where `reducedMotion` is not a valid key and has been silently doing
  nothing.
- Then: extending the typecheck guard so it asserts the check **covers** something, not just that
  the command looks right — the gap that let a vacuous gate slip past twice.

**When you finish any Tier 0 or Tier 1 item, tell me and I will wire what it unlocks the same
hour.** Most of the remaining code work is one env var away from being reachable.
