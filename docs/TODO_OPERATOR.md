# The remaining work — everything left, and exactly how to do it

**Written 2026-08-21. Revised 2026-08-22.** This is the single canonical to-do list. Everything that
could be built without you has been built, tested, and pushed. What follows needs a key, a
credential, a payment, a signature, or a decision — plus a short tail of code work that is blocked
on one of those.

**What changed in the 2026-08-22 revision:** an active address-poisoning warning (read it before you
paste any Solana address); §0.4, the 8.47 SOL released by the program closes and still unreconciled;
Decision 1, whether the Solana own venue restarts at all now that both program ids are permanently
spent; and **"What is running or waiting on me" expanded from three bullets to the real ordered
queue**, with every count re-verified against the tree rather than carried forward. Five things
closed out at the bottom.

**Scope note.** This file is the *curated* list: what unlocks the most, in the order worth doing it.
The exhaustive inventory is [`EVERYTHING_LEFT_2026_08_15.md`](EVERYTHING_LEFT_2026_08_15.md) — 211
items, last reconciled 2026-08-19. Where the two disagree, this file is newer; where this file is
silent, that one is not empty.

**How to read this.** Items are ordered by *unlock per minute you spend*, not by size. Each has
what to run, what you should see, and what a mismatch means. If a "you should see" does not match,
stop and say so — a surprise is information.

**Four standing rules.**
1. Claude never types a secret into a field. Where a step involves a key, you set it. Never paste a
   secret into a chat, including to me.
2. Claude never changes security settings on live infrastructure and never signs anything that
   moves value.
3. ⏸️ **The Safe / custody situation is deferred by your instruction.** It is not on this list, it
   is not a blocker, and no session should reopen it. Facts preserved in
   [`WHAT_I_NEED_FROM_YOU.md`](WHAT_I_NEED_FROM_YOU.md) §0.3.
   *Update 2026-08-22:* the **Squads 2-of-2 is no longer an unknown** — it executed both program
   closes on 2026-08-13, so both member keys are real and usable. That removes the standing risk
   that 8.4 SOL and two programs were locked behind a threshold nobody could reach.
4. 🎣 **Never copy a Solana address out of wallet history or an explorer activity feed.** See the
   poisoning warning immediately below. Take addresses from `frontend/scripts/addresses.json`.

---

# 🎣 READ THIS BEFORE YOU PASTE ANY SOLANA ADDRESS

You are being **address-poisoned**, currently and specifically.

```
Dcj1fGKYXCCyNsovXYtbyoKfDkUb8Hzty3gkoYVYADZ7   <- theirs
Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7   <- the real deploy authority
```

`Dcj1` versus `Dcji` — a digit one where the letter i belongs. Both are legal base58 and they are
indistinguishable at a glance in a wallet's transaction list. That address sent 1000-lamport dust to
an operator wallet **59 seconds after** a 3.4566 SOL deposit landed there, and again on a separate
day. A second sprayer, `5GHWLcQBAc9vMeZprtVFtqrzstX8SG3oTscNrfsbAdfV`, blasts 1-lamport dust at many
wallets at once.

The dust exists for one reason: to sit in your history looking like an address you already use, so
that a later copy-paste goes to them. It costs them nothing and it only has to work once.

**The rule:** addresses come from `addresses.json`, and `node frontend/scripts/verify-addresses.mjs
--onchain` decodes them. Never from history, never from a screenshot, never from a chat message —
including mine. Compare character-for-character against the registry before any transfer.

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

**Same trip, same drawer:** `mainnet-deploy-authority.json`. It has **no seed phrase** — generated
`--no-bip39-passphrase --silent`, so the keyfile *is* the backup, and it is the key any Solana
restart deploys from. Verified 2026-08-22: the keys directory is gitignored, no keypair JSON has
ever been committed, and `README-IDENTITIES.md` beside it holds only public pubkeys — no mnemonic,
no secret-key blob. That hygiene is good; it is also why losing the file is unrecoverable.

## 0.4 Account for the 8.47 SOL released by the program closes

**Time:** ~2 minutes, and it is the only unreconciled money on this page.

Closing both Solana programs on 2026-08-13 released **8.467160160 SOL** of ProgramData rent
(4.886289 from cp-swap, 3.580871 from tegridy-launch). The registry records it as *"not recovered to
any address this registry knows"* — the close instruction names a recipient, and whichever address
you gave it is not in `addresses.json`.

This is bookkeeping, not a search: you know where you sent it. Tell me the recipient and I will
either register it with a role and custody, or record deliberately that it left to a personal wallet
that does not belong in a public registry — **do not put a personal trading wallet in
`addresses.json`.** Either answer closes it; silence leaves the largest single number in the Solana
column pointing nowhere.

While you are looking: `swap-fee-account` `DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER` holds
0.006477 SOL plus two ATAs (~0.004 more), and **its key is not on this machine.** I scanned
`.solana-operator`, `tegridy-ops\solana` and `.config\solana` and derived the pubkey of every
keypair file in them; none matches. Either it is somewhere else, or ~0.010 SOL is written off.
Worth one sentence so the registry stops implying it is spendable.

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

**Both code gates shipped 2026-08-18 (`21835d1d`); nothing blocks you but the numbers.**

Your Solana rail is armed on mainnet and has taken **zero launches**, because config v1 opens at a
**99% fee**. A DBC config is **immutable**, so this cannot be corrected; it needs a v2.

```bash
node frontend/scripts/solana-dbc-operator.mjs create-config --opening-fee-bps <n> --resting-fee-bps <n> --decay-seconds <n> --creator-fee-pct 60
```

**Print it without `--send` first**, read the resolved fee schedule it prints, then sign.

⛔ **Never publish `VITE_SOLANA_DBC_CONFIG` before v2 exists** — doing so ships public launches into
the 99% fee. It is **not** currently set in Vercel production (only `VITE_SOLANA_FEE_ACCOUNT` is),
which is why the rail is dark even though the submit path is built and deployed.

### ⚠️ Before you pick numbers — six things established 2026-08-22

The decay maths was transcribed from the vendored SDK (`@meteora-ag/dynamic-bonding-curve-sdk`
v1.5.11) and proven **bit-identical to the real SDK across 1,062 configs**, then re-derived
independently by a second pass. These are measurements, not opinions.

1. ⛔ **Always pass `--creator-fee-pct` explicitly.** It defaults to **60**, and a silent default is
   exactly what produced v1's 99% fee. `creatorTradingFeePercentage` (byte 245) is the creator's
   share **of the non-Meteora 80%**, *not* of the trade — so 60 there is ~48% of the trade. A first
   draft of this plan proposed writing `48` into byte 245 believing it was a trade percentage; that
   would have permanently cut the creator's take to ~38% of the trade. **60 is correct.**
2. ⛔ **Mint EXPONENTIAL (`baseFeeMode = 1`).** `liveConfig.ts`'s linear-mode formula is wrong by a
   factor of 1e5 (it divides `reductionFactor` by 1e4; the program divides by 1e9). It is currently
   **masked** — a range check rejects linear configs, so the Fact Sheet fails *closed* rather than
   lying. Do not "fix" that range check without fixing the formula: doing so converts a visible
   failure into a **silent false fee disclosure on a public page**.
3. **`--decay-seconds` must be a multiple of 120.** The CLI hardcodes `NUMBER_OF_PERIOD = 120` with
   no `--periods` flag, and `dbc.ts:toBaseFeeParams` requires `totalDuration % 120 === 0`. So 600 ✓,
   1200 ✓, 1800 ✓, but **900 ✗ and 300 ✗ throw**. It fails loud, which is correct.
4. **v1 is worse than "untradeable ~4 h".** Its real curve (`cliff=990000000, periodFrequency=180,
   reductionFactor=375, numberOfPeriod=120, exponential`) crosses 50% at 54 min, 20% at 2.1 h,
   **10% at 3.0 h**, 5% at 4.0 h — and **never reaches 1%**; the floor is 100.86 bps, not the 100 it
   discloses. Flooring always overshoots resting, never undershoots (safe direction).
5. **The public disclosure breaks under 30 minutes.** `SolanaLaunchPage.tsx:206` renders the window
   as `over {(cfg.totalDurationSeconds / 3600).toFixed(0)}h`, which prints **"0h"** for any window
   shorter than half an hour. If v2's window is short, that one-line copy fix ships *with* it.
6. **`initialMarketCap` / `migrationMarketCap` are also immutable** and are **not** in
   `CONFIG_OFFSETS`, so `liveConfig.ts` can never read them back to check. Set them deliberately —
   they cannot be verified after the fact the way the fee curve can.

**Verify before you point production at it.** `scripts/verify-dbc-config.mjs` reads any config
pubkey back, guards the Anchor discriminator before touching an offset, prints the fee-vs-time
table, asserts the curve matches declared intent, and **fails closed** if `feeClaimer` is a 1-of-1
or a non-`Multisig` account — the mistake that strands 100% of partner fees irreversibly.

### 🔴 The one open decision: the curve numbers themselves

The maths is settled and proven; the **numbers are not**, and you have **one cheap attempt**.
A first proposal (2000 → 100 bps over 600 s) was **rejected in review**: at `periodFrequency = 5 s`
an honest buyer still pays **14.83% at t = 60 s** — a 5× improvement on v1 that is still not
tradeable.

The open question is narrow: pick a curve against an explicit **"what does a normal buyer pay one
minute in"** bar, while a sniper at t = 0 still faces a real cost. One candidate needs **no code
change at all** — v1's own `cliff` and `reductionFactor` with `periodFrequency` 180 → 1, i.e. the
same shape compressed from 6 hours into 2 minutes.

⛔ **Do not mint until this section names a verified set.**

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

1. ⭐ **Does the Solana own venue restart at all?** This is the biggest open question on the page
   and nothing downstream of it can be planned until you answer.

   Both programs were closed on 2026-08-13 and **their program ids are spent** — Solana will not
   redeploy a closed id, so `CpFnacr…zED` and `3ZvZXEBr…PM9y` are gone permanently, along with every
   PDA derived from them. The `global` config PDA still sits on chain holding 0.005923 SOL, orphaned
   and unreachable: its owning program no longer exists.

   Graduation never worked while they were live — `AmmNotConfigured` (6015) was never cleared,
   because `admin::ID` had been set to the Squads *multisig account*, which can neither sign nor
   pay. That was diagnosed and fixed in source (trunk now points it at a system-owned, fundable
   address) but the fix was never deployed, and now cannot be: [#282](https://github.com/fomotsar-commits/tegridy-farms/pull/282)
   is closed for exactly that reason.

   **A restart costs roughly what the first one did:** two fresh program keypairs, new `declare_id!`
   values, **8.46 SOL settled / 13.4 SOL peak float** of rent, and a re-derivation of every PDA the
   fork owns. At SOL $96.94 that is ~$820 settled, ~$1,299 peak — but quote the SOL, not the
   dollars: rent is denominated in lamports and does not move with the price, so only the dollar
   figure ages. Full derivation, re-priced 2026-08-22, in
   [`CAPITAL_REQUIREMENTS_2026_08_15.md`](CAPITAL_REQUIREMENTS_2026_08_15.md).

   Note the shape of it: **8.46 SOL is within 0.01 of the 8.467 SOL that closing the two programs
   released.** It is the same rent coming back out. So this is only a funding ask if that SOL has
   been spent — which is exactly what §0.4 is asking you to confirm.

   The deploy authority is currently empty, so it needs funding either way. Before spending any of
   it, run
   `node scripts/verify-program-constants.mjs --so <artifact> --program cp-swap` against the built
   binary — that check exists because getting `admin::ID` wrong once already cost the whole
   deployment.

   Three honest options: **restart** (fund it and I will rewrite the runbook around new ids),
   **stay on Meteora DBC** (then §1.3's config v2 is the whole Solana story and is much cheaper), or
   **park Solana** (then §3.2's audit RFQ and §3.3's packet come off the critical path). Say which.

2. **The PWA app name.** The manifest description is corrected but the *name* is untouched — the
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

Ordered. Counts re-verified 2026-08-22 against the tree, not carried forward from the sweep — the
long tail lives in [`EVERYTHING_LEFT_2026_08_15.md`](EVERYTHING_LEFT_2026_08_15.md) §"87 items",
which is still broadly right but predates three merges.

**1. 🔴 Get trunk green. Everything else is worth less until this is done.**

**Updated 2026-08-22 (late).** Two of the four red checks are fixed and one turned out never to
have run at all. What is left on trunk:

| Check | State | Where it stands |
|---|---|---|
| `advisories — frontend` / `— indexer` | ✅ **FIXED** (`5565506b`) | Was never an advisory problem. GitHub runs every `run:` block under `bash -e`, and `set -uo pipefail` does not clear errexit, so the unguarded `npm audit --json` ended the step the instant it found anything and **the gate never ran once** since it was armed on 08-18. Running the gate against the real reports: 0 blocking in both projects, every finding already baselined, zero stale suppressions. Nothing was allowlisted to force green. |
| `Static analysis` (Slither) | 🔴 **STILL RED — and it was masking** | See item 8. |
| `E2E Tests` / `E2E Tests (Anvil fork)` | 🔴 **still red** | Unchanged. The `reducedMotion` finding below is still the first thing to check. |
| `Lint, Type Check & Test` | ✅ green | Went red for ~15 minutes today on my own `no-fallthrough` mistake (`a0c83c42`); see the note at the end of item 8. |

The failures are not the problem. A permanently-red trunk is: once red is the normal state, the
next real regression is indistinguishable from the noise. This repo has already shipped **three**
gates that could not fail — a `tsc --noEmit` over zero files, a chain read behind a flag nothing
passed, and a CI check satisfied by a two-second echo — so that is a demonstrated failure mode here,
not a worry.

## 1a. The Anvil money-path job — DIAGNOSED 2026-08-22. The old diagnosis was wrong.

**Everything this entry used to say has been disproven by measurement. Do not act on it.**
It said *"order-dependent, not unseeded — seeding landed and did not fix it; bisect the pair that
collides, do not add more seeding."* The truth is close to the opposite: **more seeding is exactly
what is needed**, and there is no collision.

**Anvil is healthy. This is NOT an operator item and the RPC needs nothing.** Positive proof, not
absence of errors:
- `[e2e] fork ready at block 25813292` prints only after the harness POSTs `eth_blockNumber` and
  rejects any head below 1,000,000 (`run-e2e-with-anvil.mjs:162-181`) — the guard exists precisely
  because "anvil listens before the fork handshake completes".
- **`swap.spec.ts:72 execute ETH → TOWELI swap and confirm receipt (Anvil only)` PASSES in 1.6s.**
  That is a full write path — `anvil_setBalance`, impersonate, `eth_sendTransaction`, receipt, and a
  matched `/tx/0x[0-9a-f]{64}` link. A dead or rate-limited fork cannot produce it.
- `ANVIL_FORK_URL` is `https://ethereum-rpc.publicnode.com`, hardcoded at `ci.yml:400`. **No secret
  is involved**, and `ANVIL_FORK_BLOCK` is unset, so there is no stale block pin. Both of the usual
  suspects are ruled out by construction.

**The ~21-second clustering is not a shared hang.** It is a literal `{ timeout: 20_000 }`
copy-pasted into the first blocking assertion of each spec (`claim-rewards:64`, `lending:75`,
`liquidity:79`, `stake:88`). 20s assertion + ~1-2s page load = the observed 20.3 / 21.5 / 22.4s.

**The `reducedMotion` hypothesis is also disproven** — it is correctly under `contextOptions` now,
and independently the fixture pre-seeds `sessionStorage.tf_loaded` to skip the splash
(`wallet.ts:167-171`). **16 of 20 tests finish in 0.9–2.7s.** A 15-19s prologue cannot fit inside a
962 ms test.

**What is actually wrong: the fixture seeds two things, and these four tests need more.**
`e2e/fixtures/wallet.ts` seeds native ETH (`anvil_setBalance`, :464) and one ERC-20 balance
(`seedErc20Balance`, :474). Swap needs only those two — and swap is the one money path that passes.
**The four failing specs say what they need, verbatim, in their own assertion messages:**

| Spec | What its own error says is missing |
|---|---|
| `claim-rewards.spec.ts:64` | "no accrued rewards on the fork — pre-fund reward storage in the fixture" |
| `lending.spec.ts:75` | "no borrowable offer on the fork — the fixture must mint a collateral NFT to the test account and create a lender offer" |
| `liquidity.spec.ts:79` | "supply CTA never enabled … check the seeded TOWELI balance" — one side is seeded, an add needs both |
| `stake.spec.ts:90` | got PAST the CTA, clicked, submitted a tx, then died waiting for the receipt. **First cold write to the fork.** Retry #1 hit the warm cache: 3.6 s |

▶ **HOW TO FINISH IT.** Extend `e2e/fixtures/wallet.ts` beside the existing seed calls (~:463-474),
reusing the self-verifying probe pattern `seedErc20Balance` already establishes — write, read back
through the contract's own getter, keep the slot only if the getter agrees, throw loudly otherwise:
1. **claim-rewards** — seed a staked LP position, then `evm_increaseTime` + `evm_mine` so the farm's
   own `pendingRewards` getter returns non-zero. **Warp, do not write the accumulator directly** —
   warping exercises the real accrual maths instead of forging its output.
2. **lending** — cannot be seeded by storage pokes. `anvil_impersonateAccount` an existing NFT holder
   on the fork, transfer a collateral NFT to `DEFAULT_ACCOUNT`, then impersonate a lender and create
   the offer **through the protocol's real entrypoint**.
3. **liquidity** — seed the ETH-paired side too, not just TOWELI.
4. **stake** — likely already fixed by `50ee7a92` (below). Re-run before touching it. If attempt 1
   now passes, the cold-cache read was the whole story, and that is a finding, not a fix.

✅ **Landed 2026-08-22 (`50ee7a92`), and it is a prerequisite for all four:** `playwright.config.ts`
declared no `timeout`, so the default 30_000 exactly equalled `expectTxReceipt`'s own
`toBeVisible({ timeout: 30_000 })` (`wallet.ts:76`). Two equal budgets race, the test-level one
wins, and **the assertion could never print its own reason** — every receipt failure has been
reporting the generic "Test timeout of 30000ms exceeded". Now 60_000. No assertion's budget moved.
Also corrected `liquidity.spec.ts`, whose comment claimed "the fork precondition is handled now"
while its own test proved otherwise.

⛔ **DO NOT** fix any of these by loosening the assertion, widening a per-assertion timeout, or
adding a retry. Each assertion is correct and is telling the truth. The fixture is what is missing.

## 1b. The chromium heat-door failures — NOT yet diagnosed

`E2E Tests` fails on a heat "door" surface: `element(s) not found` for `door.getByText('WARM')` and
the degree strings `41.20°` / `195.54° — Builder`, plus `locator.click` timeouts on an
`aria-expanded` toggle. **"element(s) not found" for text a fixture is supposed to render is a
data/route problem, not a race.**

▶ The diagnostic agents assigned to this were killed by a session limit before reporting, so this is
genuinely open. Start here: `grep` for `195.54` and `41.20` under `frontend/e2e/` to find the owning
spec, then read its route fixtures. The candidate worth checking first, because this repo does it
deliberately: **the door component self-gates to "unavailable" when the oracle payload fails its
schema** — so a fixture that has drifted out of schema renders *nothing* rather than wrong numbers,
and "element not found" is the honesty gate working correctly against a stale fixture.

**2. ✅ The five non-Dependabot PRs are decided AND resolved — nothing is left open.** Every verdict re-derived against trunk rather
than taken from the PR's own claims.

- **`#306`** selector-guard ABI registration — **merged** (`dce626c3`). It un-skipped the contracts
  matrix. Contracts CI had failed on every trunk run since 08-19 and the forge slices `needs:` that
  job, so they reported *skipped*, not *failure* — **every merge in that window landed with zero
  contract test coverage and nothing went red.**
- **`#205`** foundry 1.3.1 → 1.9.1 — **merged** (`6dedcb53`). Its dependabot mute named one release
  condition ("a run where all nine slices are green"); that run exists, on a head rebased onto trunk
  exactly. The mute is now lifted too (`22823be3`) — an ignore whose stated condition has been met
  stops being a decision and becomes a mute nobody owns.
- **`#278`** Heat launch gate — **CLOSED**, superseded on every file. Trunk's gate is *newer*
  (`657c5170`, #286, 08-11 — three days after #278 opened) and this PR's actual purpose is already
  delivered: `assertMayLaunch` is wired into both rails. The one thing not carried over, the
  180-day floor, was removed on purpose per the island spec and is documented twice. If you want
  that floor it is a config change (`VITE_HEAT_LAUNCH_FLOOR`), not a re-merge.
- **`#304`** restaking ABI alignment — ✅ **MERGED** (`0d4ec7e4`).
  Real live drift: `TegridyRestaking.sol` declares a **6-field** `RestakeInfo`, trunk's frontend ABI
  declares 5. The four `docs(todo)` commits were dropped (redundant with trunk, and the only files
  that conflicted).
- **`#265`** Solana metadata-URI check — ✅ **MERGED** (`461d8b1e`), with one hunk dropped and one
  finding fixed first. Scope note that changed the verdict: this targets the **live Meteora DBC rail**, not the
  dead own-curve rail, so it is revenue-path work and not dead-rail polish. Tokens are created
  `AUTHORITY_IMMUTABLE`, so the URI is permanent and unfixable after launch.
  - *Dropped:* its `liveConfig.ts` hunk deleted `feeClaimer: 72`. Trunk has since answered that
    question the other way and correctly (`feeClaimer: 40` / `leftoverReceiver: 72`, pinned
    separately), and `feeCustody.ts` reads `feeClaimer` for the custody gate. Taking the hunk would
    have broken it.
  - *Fixed before merge:* a single IPFS gateway 404 would have **blocked legitimate launches** —
    freshly pinned CIDs 404 for minutes while they propagate. It now tries a second gateway and, if
    both miss, warns in amber instead of blocking. `https://` and `ar://` 404s still block, because
    those hosts are authoritative for their own paths.

**3. Sweep the 15 Dependabot PRs.** Hold `#296` (framer-motion 12 → **13**, a major). The rest are
minor/patch and grouped.

**Status 2026-08-22 (late):** all 14 non-major PRs have been sent `@dependabot rebase` onto the
fixed trunk; they will re-run CI on their own. Do not read their previous red as a verdict on the
bumps. `#303` (eslint /
vite tooling) and `#287` (viem / wagmi) were failing `Lint, Type Check & Test` for **my** lint
regression, not for anything in the bump — that is fixed in `a0c83c42` and they need a re-run. The
CodeQL-action bumps (`#268`–`#271`) and `#302` were red on the pre-existing trunk failures, which
are now two-thirds resolved. The eight package bumps (`#289`–`#295`) report `UNKNOWN` mergeable,
which means GitHub has not computed a merge base recently, not that they conflict.

▶ **The order that costs least:** re-run CI on all of them (pushing trunk already retriggers most),
then merge the ones that come back green **one at a time** — each merge moves trunk and Dependabot
rebases the rest, so batching them just means N rounds of CI either way. Leave `#296` alone.

**4–5. ✅ DONE 2026-08-22 (`01b26b86`).** All 53 cleared, `tsconfig.test.json` wired, and the guard
extended to assert coverage rather than spelling. Verified by mutation in both directions: a
deliberate type error in a `.test.ts` now fails `tsc -b`, and unwiring the reference turns the new
guard red. `tsc -b --noEmit` → 0 across all three projects; 6,025 tests green.

Both production bugs were real, and one of them **bears directly on item 1**:

- **`playwright.config.ts` — `reducedMotion` was never applied.** It is a `BrowserContextOptions`
  key, not a top-level `use` key, so it was never forwarded to `newContext()`. The app therefore
  never saw `prefers-reduced-motion: reduce`, and **every e2e test has been sitting through the
  ~15–19 s fullscreen canvas intro** that `AppLoader.shouldSkipAtMount` exists to skip. Now inside
  `contextOptions`, where it applies. ⚠️ **Check this against the E2E failures before bisecting
  anything** — a 15–19 s prologue on every spec is a plausible cause of timeout-shaped flake, and
  it would look exactly like order-dependence when workers contend.
- **`irysClient.ts` ambient-`Window` split** — `tsconfig.test.json` *overrides* `include` rather
  than extending it, so the global declaration file never entered the test program. Fixed at the
  root with a `src/**/*.d.ts` glob rather than the one filename.

And several tests were **passing for the wrong reason**, which is worth knowing before trusting a
green suite: `chains/registry` compared two `as const` literals, so the expression folded at compile
time and the assertion was literally `expect(false).toBe(false)`; the airlock SDK mock was missing a
method the code under test calls, green only because the migrator address is still zero and it would
have died the day that changed; `CurveLaunchPage` fixtures omitted the exact field whose absence
caused the documented silent Borsh offset shift.

*Residual, recorded not hidden:* `tsconfig.test.json` relaxes five flags relative to `src/` —
`noUncheckedIndexedAccess`, `strictFunctionTypes`, `verbatimModuleSyntax` and the two unused checks.
Test files are checked now, but not as strictly. Tightening them is its own piece of work.

**6. ✅ Honesty debt — closed (`514942c5`, `b0484908`).** It was **eight** files, not five. Two were
not on any list and were found by scanning rather than by counting: `geometry.ts` had *not* been
fixed, and `rpc.ts` carried a claim nobody had counted. All eight now say what is true — deployed
08-08, closed 08-13, permanently spent, and graduation never ran once because cp-swap's `AmmConfig`
was never created.

**The part that was a live defect, not a comment.** `readDeployment` reported `deployed` for both
spent ids, and every surface gating on it believed the rail was up for the nine days since the
close. `solana program close` deletes the ProgramData account and leaves the 36-byte program stub
**still executable-flagged**, so `getAccountInfo` — and `readDeployment`, built on it — answers "a
program is here" for an id that can never execute again. This is the one place where "trust the
chain read, not the comment" fails: **the chain read agreed with the wrong comment.**

`readDeployment` now follows the stub's pointer and reads the ProgramData account before saying
`deployed`; any failure in that second read is `unreadable`, never `deployed`. `closed` is its own
variant in `Deployment` and `LaunchPhase` rather than folded into `not-deployed` — a spent id is
not an id you can still deploy to, and adding the variant made the exhaustiveness checks fail at
all four render sites, which is how they were found. The operator script refuses both spent ids from
a literal list, not a chain read, for the same reason.

While in the page: the deployment banner had been telling every visitor *"That id is a placeholder
generated so the program compiles… expected to return nothing today"* for two weeks after the
deploy made it false.

**8. 🔴 NEW — Slither: 362 findings at `fail-on: medium`, and the check was being masked.**

Two separate problems, one now fixed.

**Fixed (`cdd58b06`) — four required checks could be satisfied by a two-second echo.** Measured on
`#205` (head `a4706efb`): two check runs named `Slither / Static analysis` existed at once — the
real 4-minute analysis **FAILED**, a 2-second shim **passed**, and the PR's check list surfaced only
the pass, with the real result absent entirely. `all-tests-pass` was doubled on the same PR and
agreed by luck. A required-status rule on either name would have been satisfied by an echo. **This
is the third instance of this repo's documented failure mode.**

The cause was GitHub's own "skipped but required" recipe: `paths` fires when *any* changed file
matches, `paths-ignore` when *any* does not — they are not complements, so a PR touching both sides
triggered the real workflow **and** its `-not-applicable.yml` companion. The companions carried a
comment arguing the overlap was safe on finish order, and `requiredCheckSynthesis.test.ts` enforced
that pairing and repeated the argument. Nobody had measured it.

The four companions are deleted. Each workflow now triggers on every PR — so exactly one check run
per name can exist — and a `scope` job decides whether the expensive jobs run
(`.github/scripts/diff-scope.mjs`). Every uncertain answer **runs** the real job, including a scope
job that failed outright. `requiredCheckSynthesis.test.ts` is rewritten to enforce the shape that
cannot regress, and its header records what was measured and why the old reasoning was wrong.

*Proven in production on `#265`,* a frontend-only PR: exactly one check run per name, all four
`scope` jobs green, `Static analysis` and `registry vs chain` **SKIPPED**, and `all-tests-pass` /
`all-checks-pass` **SUCCESS** via their out-of-scope step. Under the old arrangement that PR would
have carried two `Static analysis` runs and two `all-tests-pass` runs.

**Still open — but much smaller than 362, and now measured.**

**Only 48 of the 362 findings gate anything.** `fail-on: medium` ignores Low and Informational, and
the split is **5 High / 43 Medium / 200 Low / 114 Informational**. The 48 sit in 16 files:

- **5 High**, all reentrancy, in exactly **two** files — `TegridyFeeExecutorRouter.sol` (3) and
  `vaults/TegridyHarvestVault.sol` (2).
- **43 Medium**, dominated by two FP-prone detectors: `incorrect-equality` (21) and
  `uninitialized-local` (13), plus `unused-return` (6), `divide-before-multiply` (2),
  `reentrancy-no-eth` (1).

✅ **The config question is SETTLED — do not spend time on it.** The TODO previously said to check
whether `contracts/slither.config.json` loads. **It loads and it works.** Proof from the report
itself: **zero** of its 12 excluded detectors (`timestamp`, `dead-code`, `naming-convention`, …)
produced a single finding, and detectors that are *not* on its promoted list (`costly-loop`,
`cyclomatic-complexity`, `missing-inheritance`, `return-bomb`, `unused-state`) *did* fire. That
second half also disproves the feared failure mode recorded in the config's own comment — the
promoted `detectors_to_include` list has **not** gutted the detector set. 20 detectors produced the
362 findings.

⚠️ **A stale claim to fix while you are in there:** `contracts/slither.config.json`'s `_scope` note
lists 15 in-scope contracts and says 12 others "have been moved off this branch". **Every file
producing findings today appears on neither list** (TegridyFeeExecutorRouter, TegridyHarvestVault,
StreamingRevenueDistributor, NftfiBnpl, TegridyFeeLocker, TegridyPositionMarket, LaunchRugEscrow,
AirdropFactory, VestingFactory…). `_scope` is a **comment and enforces nothing** — `filter_paths`
only drops `lib/ node_modules/ test/ script/ out/ cache/ broadcast/`. The note is badly stale and
its FP rationale ("verified across RevenueDistributor / ReferralSplitter / POLAccumulator /
TegridyStaking / TegridyRestaking / TegridyTWAP, 2026-05-31") covers almost none of the files that
actually fire. Rewrite or delete it; do not inherit its conclusions.

🔶 **A first triage pass exists — written up in [`SLITHER_TRIAGE_2026_08_22.md`](SLITHER_TRIAGE_2026_08_22.md), one section per finding — and you must NOT act on it as-is.** Five agents triaged all 48
against the Solidity on 2026-08-22 and returned **54 FALSE_POSITIVE, 2 REAL_BUT_ACCEPTED, 0
REAL_BUG**. The reasoning is detailed and cites line numbers — e.g. the fee-router HIGHs are argued
down on three checked facts: every state-mutating entrypoint carries `nonReentrant` under **one
shared OZ v5.5.0 slot** (so cross-function re-entry is impossible, not just same-function); the
caller-supplied `target` must be on a 48 h-timelocked allowlist that excludes WETH / distributor /
treasury / POL; and slither names `amountOut` as "stale" when it is read *after* the call, with
`outBefore` as a deliberate pre-call baseline — **the detector flagged the defence as the bug.**

**But the adversarial refutation pass never ran** — all three refute agents plus the config auditor
were killed by a session limit. **A triage that clears 54 of 56 with zero real bugs and no
independent check is exactly the shape this repo keeps shipping**, and `FALSE_POSITIVE` is the
verdict that makes work disappear. The verdict count also exceeds the finding count (56 vs 48)
because the groups overlapped, which is a second reason it is not final.

▶ **NEXT STEP, and it is one command:** re-run the refutation phase. The workflow is saved and its
completed agents replay from cache, so only the failed ones cost anything:
`Workflow({scriptPath: '…/workflows/scripts/slither-48-triage-wf_8b438261-0c5.js', resumeFromRunId: 'wf_8b438261-0c5'})`
▶ **Then, and only then**, apply per-line `// slither-disable-next-line <detector>` with a reason at
each site — the convention the codebase already uses (`TegridyFeeExecutorRouter.sol:341`). The two
REAL_BUT_ACCEPTED findings (`TegridyHarvestVault.sol:364` and `:386`, raw donatable `balanceOf`
reads in a strict equality) get a reason comment too, and a human eye before deploy.
▶ ⛔ **Never** add `reentrancy-balance` or `incorrect-equality` to `detectors_to_exclude`. A global
mute would silence the harvest-vault HIGHs along with the router ones — different file, different
argument. Per-line, per-reason, or not at all.
▶ ⛔ **Do NOT lower `fail-on` or add `continue-on-error`.** The workflow's own comment argues this
and is right: a gate lowered until it stops objecting still reports, and now reports nothing.

*Standing context that lowers the stakes and should not lower the care:* **none of these contracts
is deployed.** Nothing here is live risk today; the value is catching a real bug at the cheapest
possible moment, which is before the deploy ceremony.

*One process note, recorded because it cost trunk 15 minutes of red:* I verified `b0484908` with
`tsc -b` and `vitest` and **did not run `npm run lint`**, which is the other third of the
`Lint, Type Check & Test` job. An explanatory comment placed between two empty `case` labels made
`no-fallthrough` read the case above it as a falling-through body. Fixed in `a0c83c42`, and found
by reading why two Dependabot PRs were failing rather than by my own check. **Run all three.**

**7. Repo hygiene — the numbers moved, so here they are fresh.** 122 worktrees · 329 local branches,
**120 of them fully merged** into `mvp-launch` · 12 stashes, nine on `main`, which is not the trunk ·
roughly 27 GB reclaimable, because `.git/worktrees` holds a duplicate submodule clone per worktree.
⛔ Prune with `git worktree remove` **only** — 93 are dirty, and deleting the directories by hand
leaves the metadata behind. This is safe, boring, and worth doing before the count grows again.

**Closed 2026-08-22 (late session), so nobody re-opens them:**

- **The advisory gate had never run** (`5565506b`) — errexit killed the audit step before the gate
  was reached, every run since it was armed. See item 1.
- **Four required checks could be satisfied by an echo** (`cdd58b06`) — the `-not-applicable.yml`
  companions are gone. See item 8.
- **`readDeployment` called a closed program deployed** (`b0484908`) — a live honesty failure, not a
  comment. See item 6.
- **Eight stale "the Solana rail is live" claims** (`514942c5`) — two of them found by scanning
  rather than by list.
- **The foundry-toolchain dependabot mute** (`22823be3`) — its stated release condition was met by
  `#205`.
- **`#278` closed as superseded**, `#304` and `#265` rebased onto trunk and ready to merge. See
  item 2.

**Closed since the previous revision (2026-08-22), so nobody re-opens them:**

- **Registry chain read hardened** — [#280](https://github.com/fomotsar-commits/tegridy-farms/pull/280)
  (`cbc60f15`). Batched to two requests for 58 addresses; three outcomes instead of two, so a
  rate-limited endpoint skips and is counted rather than failing the build; `registry-onchain.yml`
  now fails a **total** skip, closing the "green means nothing was checked" hole one level below its
  existing grep. New **check 5b** covers Solana literals in `launcher/solana/curve/program.ts`,
  which `constants.ts` — being EVM-only — never saw.
  ⚠️ On a real GitHub runner the public endpoints answered all 58 with **0 NOT CHECKED**, so do
  **not** buy keyed RPC endpoints on spec. Watch the `NOT CHECKED` count and act only if it moves.
- **Keyfile hygiene verified** — keys directory gitignored, no keypair JSON ever committed, and the
  identities readme holds no secret material. See §0.3.
- **Squads 2-of-2 proven usable** — it executed both program closes. See standing rule 3.
- **A self-inflicted trap fixed** — `base58Decode` returned **33 bytes** for an all-zero key, so the
  System Program would have been rejected as "NOT A SOLANA ADDRESS": the exact verdict that function
  exists to reserve for a fabricated key. Found by a self-test case, not by a registry entry.
- **The gotchas that were only in my head are now in the repo** —
  [`DEVELOPING.md § Common gotchas`](DEVELOPING.md#common-gotchas). Two of them can destroy work on
  this box: a worktree's `node_modules` may be a **junction**, so `rm -rf` follows it and deletes
  the real tree (`cmd /c rmdir` removes only the link); and PowerShell 5.1 mangles the encoding of
  any non-ASCII file it round-trips, which is every runbook and `addresses.json`. The rest are
  verification discipline — including why "the search did not run" must never be reported as "it is
  not there", which produced two confident wrong claims before it was written down.

**When you finish any Tier 0 or Tier 1 item, tell me and I will wire what it unlocks the same
hour.** Most of the remaining code work is one env var away from being reachable.

---

# 🧭 START HERE — everything left, in the order it should happen

Written 2026-08-22 at the close of the session that landed the eleven commits listed under "Closed
2026-08-22 (late session)". This section is the single entry point; the tiers above are the detail.

**Read this rule first, because it is the one the repo keeps re-learning.** Three gates have shipped
here that could not fail: a `tsc --noEmit` over zero files, a chain read behind a flag nothing
passed, and a CI check satisfied by a two-second echo. Every one of them was *green*. So the
question to ask of any check is never "is it passing" but **"could it fail if the thing it guards
broke?"** Two of the three were found by someone reading *why* something unrelated was red.

## The dependency spine — what actually blocks what

```
  Safe re-home ─────────────► contract deploys ────► lending / gauges / community un-gate
   (Tier 0.1 §0.3, 7 [op])          (Tier 2.2)              (~2,500 lines of finished UI)

  Login change-set ─────────► social layer + push + profiles
   (4 items, strict order)

  DBC config v2 ────────────► first public Solana launch ────► fee-claim ceremony
   (1 [op] session)

  Indexer hosted ($5-20/mo) ► Leaderboard/History/TVL ────► fact sheets, afterlife, Dune
   (1 [op] decision)              (client already written)

  trunk green ──────────────► everything is cheaper, nothing is blocked by it
```

Only the **first** box in each row is blocked on you. Everything to the right of it is written and
dark. That is the whole shape of this project right now: **over-built and under-lit.**

## Order of operations

### ① Finish getting trunk green — the only thing an agent can complete alone

| # | What | Where | Who |
|---|---|---|---|
| 1 | Seed the four Anvil money-path preconditions | item **1a** — has the per-spec recipe | agent |
| 2 | Diagnose the chromium heat-door failures | item **1b** — start with the schema self-gate | agent |
| 3 | Re-run the Slither refutation pass, then apply per-line suppressions | item **8** — one command | agent |
| 4 | Merge the 14 rebased Dependabot PRs once ① lands | item **3** | agent |

**Do ① before anything else**, and not because the failures are dangerous — they are not, nothing
here is deployed. Do it because a permanently-red trunk means the next real regression is
indistinguishable from the noise, and this repo has already proven it cannot tell the difference.

### ② The operator critical path — nothing to the right of it moves until you act

Ordered by *what unblocks the most*, not by effort.

1. **Safe re-home** (Tier 0.1 + §0.3, 7 items). Every contract deploy waits on it.
   ⚠️ Per your standing instruction the Safe topology decision itself stays untouched by agents —
   §0.3 records that deferral and nothing in this document reopens it. The keystore backup and the
   `guardianPause()` correction are explicitly *outside* the deferral and are still worth doing.
2. **Login change-set** (4 items, Tier 0.1). **Strict order, single session** — the order is a
   correctness requirement, not a preference: `015 §1 DROPs → 014 whole → verify 42501 on all four
   tables + nonce 200 → 016 → prune_revoked_jwts → 013 + VITE_ANALYTICS_ENDPOINT → redeploy`.
   ⛔ Never run 008 after 014. Never run 004 as a unit. Wakes the entire social layer.
3. **Mint DBC config v2** (Tier 1.3). v1's **99 % opening fee is disqualifying** and a config is
   **immutable**, so the rail cannot take a public launch until it is replaced — and you get **one
   cheap attempt**. ⚠️ The maths is proven but **the curve numbers are still an open decision**; §1.3
   carries six measured constraints, one of which would have permanently mis-set the creator's fee
   share. Read them before you pick numbers, and do not sign until §1.3 names a verified set.
4. **Host the indexer** ($5-20/month, Tier 1.1). The GraphQL client is already written and merged
   (`088ed89e`). This one payment lights Leaderboard, History, per-pool volume/TVL, the treasury
   feed and the timelock queue.
5. **`MEMETICS_BIRTH_SECRET`** in Vercel prod (Tier 1.2). Production answers `503 no_secret` today.
6. **Vercel env session + redeploy** (Tier 0.2). Cheapest unlock per minute in the document.

### ③ Clocks — these run whether or not you act

| When | What | Days left as of 2026-08-22 |
|---|---|---|
| **~2026-10-11** | Staking reserve runway ends → claims silently pay **partial with IOUs** | **~50** |
| ~Aug 2027 | `memetics.finance` renewal | ~345 |
| Standing | `TegridyStaking` has **22 bytes** of EIP-170 headroom, `VoteIncentives` **99** | — |

The October date is the only one that can hurt you soon, and its failure mode is the quiet kind:
not a revert, a partial payment with an IOU. Decide **top-up or rate cut** well before it.

## The plan documents, and which to open when

| Document | What it is | When to open it |
|---|---|---|
| **`TODO_OPERATOR.md`** (this file) | The operative runbook — what to do next, in order | Always start here |
| `YEAR_PLAN_2026_2027.md` | The 12-month checklist. **105 unticked: 44 `[code]`, 44 `[op]`, 4 `[ext]`, 1 `[island]`** | Quarterly planning |
| `BATTLE_PLAN.md` | 9 foundation tracks, 8 waves, per-item build instructions | When you are about to build one of them |
| `TOP_100_BUILDS.md` | Revenue-ranked backlog with comparables | Choosing what is worth building at all |
| `WHAT_I_NEED_FROM_YOU.md` | The operator asks, with §0.3 recording the Safe deferral | Before a signing session |

⚠️ **A convention that matters:** in `YEAR_PLAN`, a ticked box means **merged and tested — NOT
deployed, NOT switched on.** `BATTLE_PLAN` uses the stricter pair (`✅ shipped` vs `🟡 in the tree`).
A box ticked on a half-done item is a lie the next session inherits.

## What did NOT get finished, stated plainly

An audit of all 44 unticked `[code]` items against the tree was launched and **every agent in it was
killed by a session limit before reporting** — zero results. So the `[code]` half of `YEAR_PLAN` has
**not** been reconciled against the tree since 2026-08-19, and several lines are known to be stale:

- **Line 65** ("Close PR #278") — **done 2026-08-22**. Tick it.
- **Line 71** ("companion workflow for path-filtered checks") — **the prescription is now wrong.**
  The four companions were deleted and replaced by a `scope` job; re-writing a companion would
  reintroduce the defect. Only the `[op]` arming half survives. Rewrite the line.
- **Line 75** (honesty-debt sweep) — the Solana half is done across 8 files (`514942c5`). The rest
  of the line (addresses.json, README pool figures, PWA manifest, "Last reviewed" dates) is
  **unverified** — nobody checked it.

▶ **Re-run the audit when limits reset.** It is saved and its completed agents replay from cache:
`Workflow({scriptPath: '…/workflows/scripts/year-plan-code-audit-wf_f5bcdad2-7b2.js', resumeFromRunId: 'wf_f5bcdad2-7b2'})`

**Do not tick anything in `YEAR_PLAN` on the strength of this section.** It reports what one session
observed, and the reconciliation it was supposed to rest on did not run.
