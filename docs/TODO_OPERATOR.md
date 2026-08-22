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

**Later on 2026-08-22 — three things closed without you, and one changed shape:**
- **The Vercel deploy door is shut.** Production Branch moved `main` → `mvp-launch`. See §0.2.
- **Production is current again**, after serving a build ~707 commits behind. Verified on the live
  render, not in CI. See §0.2 for exactly what was proven live.
- **The audit remediation shipped** — 21 items across four commits (#273), plus the RLS policy
  fix (#299) that §0.1 walks you through. Every fix carries a test proven to fail on pre-fix code.
- **§1.3 (DBC config v2) grew a "before you pick numbers" section.** Six measured constraints, one
  of which would have permanently mis-set the creator's fee share. **The curve numbers themselves
  are still open** — a first proposal was rejected in review for not actually fixing the problem.
  Do not mint yet.

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

> **Two things here are already done (2026-08-22) — do not redo them.**
> - **The Production Branch is now `mvp-launch`, not `main`.** That deploy door had been open since
>   2026-08-02: `main` was wired to Production and sat 676+ commits stale, so a single
>   `git push origin main` would have reverted production to a July tree with no human step.
>   Confirmed on the settings page: *"Every commit pushed to the `mvp-launch` branch will create a
>   Production Deployment."*
> - **Production was redeployed and is current.** It had been serving a build ~707 commits behind.
>   Verified against the live site, not the build log: the CSP now allowlists `nft2-cdn.alchemy.com`
>   (broken NFT images fixed), `/api/etherscan` honours `offset` (a request that returned 918 KB now
>   returns 56 KB) and clamps it at 500 (`offset=99999` returns byte-identical output to
>   `offset=500`), and the pre-#258 "Real yield, paid in ETH" overclaim is gone from the render.
>
> ⚠️ **New consequence of the branch change:** any push to `mvp-launch` now auto-deploys with no
> local step, so `scripts/predeploy-check.mjs` never runs on that path. The guard only covers CLI
> deploys — it says so itself in its own output. That is the correct branch to have wired; just know
> the gate no longer stands in front of it.

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

**Both code gates shipped 2026-08-18 (`21835d1d`); nothing blocks you.**

Your Solana rail is armed on mainnet and has taken **zero launches**, because config v1 opens at a
**99% fee** — which makes a freshly launched token untradeable for roughly four hours. A DBC config
is **immutable**, so this cannot be corrected; it needs a v2.

```bash
node frontend/scripts/solana-dbc-operator.mjs create-config --opening-fee-bps <n> --resting-fee-bps <n> --decay-seconds <n> --creator-fee-pct 60
```

**Print it without `--send` first**, read the resolved fee schedule it prints, then sign.

⛔ **Never publish `VITE_SOLANA_DBC_CONFIG` before v2 exists** — doing so ships public launches into
the 99% fee. (It is **not** currently set in Vercel production — only `VITE_SOLANA_FEE_ACCOUNT` is.
That is why the rail is dark even though the submit path is built and deployed.)

### Before you pick numbers — six things established 2026-08-22

The decay math was transcribed from the vendored SDK (`@meteora-ag/dynamic-bonding-curve-sdk`
v1.5.11, in `frontend/node_modules`) and proven **bit-identical to the real SDK across 1,062
configs**, then re-derived independently by a second pass. These are measurements, not opinions.

1. ⛔ **Always pass `--creator-fee-pct` explicitly.** It defaults to **60**, and a silent default is
   exactly what produced v1's 99% fee. `creatorTradingFeePercentage` (byte 245) is the creator's
   share **of the non-Meteora 80%**, *not* of the trade — so 60 there is ~48% of the trade. A first
   draft of this plan proposed writing `48` into byte 245 on the belief it was a trade percentage;
   that would have permanently cut the creator's take to ~38% of the trade. **60 is correct.**
2. ⛔ **Mint EXPONENTIAL (`baseFeeMode = 1`).** `liveConfig.ts`'s linear-mode formula is wrong by a
   factor of 1e5 (it divides `reductionFactor` by 1e4; the program divides by 1e9). It is currently
   **masked** — a range check rejects linear configs, so the Fact Sheet fails *closed* rather than
   lying. Do not "fix" that range check without fixing the formula: doing so converts a visible
   failure into a **silent false fee disclosure on a public page**.
3. **`--decay-seconds` must be a multiple of 120.** The CLI hardcodes `NUMBER_OF_PERIOD = 120` with
   no `--periods` flag and `dbc.ts:toBaseFeeParams` requires `totalDuration % 120 === 0`. So 600 ✓,
   1200 ✓, 1800 ✓, but **900 ✗ and 300 ✗ throw**. It fails loud, which is correct.
4. **v1 is worse than "untradeable ~4h".** Its real curve (`cliff=990000000, periodFrequency=180,
   reductionFactor=375, numberOfPeriod=120, exponential`) crosses 50% at 54 min, 20% at 2.1 h, **10%
   at 3.0 h**, 5% at 4.0 h — and **never reaches 1%**; the floor is 100.86 bps, not the 100 it
   discloses. Flooring always overshoots resting, never undershoots (safe direction).
5. **The public disclosure breaks under 30 minutes.** `SolanaLaunchPage.tsx:206` renders the window
   as `over {(cfg.totalDurationSeconds / 3600).toFixed(0)}h`, which prints **"0h"** for any window
   shorter than half an hour. If v2's window is short, the one-line copy fix ships *with* it.
6. **`initialMarketCap` / `migrationMarketCap` are also immutable** and are **not** in
   `CONFIG_OFFSETS`, so `liveConfig.ts` can never read them back to check. Set them deliberately;
   they cannot be verified after the fact the way the fee curve can.

**Verify before you point production at it.** `scripts/verify-dbc-config.mjs` reads any config
pubkey back, guards the Anchor discriminator before touching an offset, prints the fee-vs-time
table, asserts the curve matches declared intent, and **fails closed** if `feeClaimer` is a 1-of-1
or a non-`Multisig` account — the mistake that strands 100% of partner fees irreversibly.

*The exact opening/resting/window numbers are still being settled against an explicit "what does an
honest buyer pay at t=60s" bar. A first proposal (2000→100 bps over 600 s) was rejected in review
because it still charges 14.83% at 60 s. Do not mint until this line is replaced with a verified
set — you have one cheap attempt left.*

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

**0. Finish the DBC v2 curve — in progress, and the only thing standing between you and §1.3.**

The math is settled and proven against the vendored SDK; the *numbers* are not. A first proposal
(2000 → 100 bps over 600 s) was rejected in review because at `periodFrequency = 5 s` an honest
buyer still pays **14.83% at t=60 s** — a 5× improvement on v1 that still is not tradeable. The
open question is narrow: pick a curve against an explicit "what does a normal buyer pay one minute
in" bar, while a sniper at t=0 still faces a real cost. One candidate needs **no code change at
all** — v1's own `cliff` and `reductionFactor` with `periodFrequency` 180 → 1, i.e. the same shape
compressed from 6 hours into 2 minutes.

Also unresolved and shipping with it: `initialMarketCap` / `migrationMarketCap` (immutable, and not
readable back), and the `.toFixed(0)}h` copy fix at `SolanaLaunchPage.tsx:206` if the window lands
under 30 minutes. **Do not mint until §1.3's placeholder line is replaced.** You have one cheap
attempt left; v1 already burned the free one.

**1. 🔴 Get trunk green. Everything else is worth less until this is done.**

Both E2E jobs fail on `mvp-launch` — at `98d175a3`, `e1251c42`, `b4200931` and still today — plus
`advisories — frontend` and `advisories — indexer`. Nothing in #280 or #305 touched them; I checked
against trunk before merging both.

The failures are not the problem. A permanently-red trunk is: once red is the normal state, the
next real regression is indistinguishable from the noise. This repo has already shipped **two**
gates that could not fail — a `tsc --noEmit` over zero files, and a chain read behind a flag nothing
passed — so that is a demonstrated failure mode here, not a worry.

The money-path job already has a diagnosis worth not re-deriving: it is **order-dependent, not
unseeded.** Seeding landed and did not fix it. Start by running the suite with a single worker and
a fixed order, and bisect the pair that collides — do not add more seeding.

**2. Decide the five non-Dependabot PRs.** They are the reviewed work sitting closest to done:
`#306` selector-guard ABI registration · `#304` restaking ABI alignment · `#278` Heat launch gate ·
`#265` Solana metadata-URI check · `#205` foundry 1.3.1 → 1.9.1. Each is either merge, close, or a
named reason to keep waiting — an open PR with no verdict is the same debt as a red check.

**3. Sweep the 15 Dependabot PRs.** Hold `#296` (framer-motion 12 → **13**, a major). The rest are
minor/patch and grouped.

**4. The 53 orphaned type errors,** then wire `tsconfig.test.json` into the build so test files are
actually typechecked. Two are production bugs nothing has ever seen: `irysClient.ts` disagreeing
with itself about the ambient `Window` type across two projects, and a `playwright.config.ts` line
where `reducedMotion` is not a valid key and has silently been doing nothing.

**5. Then the guard that would have caught it** — extend the typecheck gate so it asserts the check
**covered** something rather than that the command looked right. Same shape as the zero-count guards
now in `verify-addresses.mjs`: a scan that examined nothing must fail, not pass quietly.

**6. Honesty debt — 5 files still assert the Solana rail is live.** Re-counted today; `geometry.ts`
has since been fixed, so it is five, not six:
`frontend/src/lib/launcher/solana/README.md` · `curve/index.ts` · `curve/ix.ts` · `curve/program.ts` ·
`frontend/scripts/tegridy-launch-operator.mjs`. Both programs were closed on 2026-08-13 and their
ids are spent. `program.ts` is the one that matters most — its `PROGRAM_ID` still points at a closed
program, and check 5b now cross-checks it against the registry, so the code and the registry
disagree in public. *(The cp-swap `lib.rs` header and the ProgramData chain-gate items from the
sweep are both already closed — verified today.)*

**7. Repo hygiene — the numbers moved, so here they are fresh.** 122 worktrees · 329 local branches,
**120 of them fully merged** into `mvp-launch` · 12 stashes, nine on `main`, which is not the trunk ·
roughly 27 GB reclaimable, because `.git/worktrees` holds a duplicate submodule clone per worktree.
⛔ Prune with `git worktree remove` **only** — 93 are dirty, and deleting the directories by hand
leaves the metadata behind. This is safe, boring, and worth doing before the count grows again.

**Closed since the last revision (2026-08-22), so nobody re-opens them:**

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
