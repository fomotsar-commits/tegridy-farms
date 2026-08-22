# Everything left — 2026-08-15

Twelve lanes swept the repository, each one followed by an independent verifier instructed to
default to "already done" and kill anything it could not confirm. **220 candidate items → 211
survived verification → ~151 distinct after merging duplicates.** Nine were killed outright.

**79 need you. 87 need nobody but an agent. 38 are a build plus one gated step from you.
7 are waiting on someone else.**

Of the 211, **200 carry a verified citation** — a file read at a line, a command run, an
on-chain read, or a live HTTP response. 7 are derived, 4 are explicitly unverified and labelled.

---

## ▶️ Start here — refreshed 2026-08-21

The two lanes run in parallel and do not block each other. Within each lane the order is
load-bearing, and the reason is given rather than assumed.

**Agent lane — do these in this order:**

1. **Fix the 13 `tsc -b` errors. Nothing else in the test lane means anything until this is
   green.** `ci.yml`'s `lint-typecheck-test` job runs Type Check *before* Unit Tests, the Solana
   indexer suite, the address registry, the four `--self-test` steps and the arb-linkage tests,
   and **none of them carry `if: always()`** — so a red Type Check silently skips all of them.
   Every "covered by CI" claim below is currently unenforced on PRs. Full error list, the
   money-path caveat, and the `-b` trap are in **CI and tests** further down. Verify with
   `cd frontend && npx tsc -b --noEmit` reaching 0, then confirm `npm run lint` and
   `npx vitest run` have not regressed.
2. **Audit the trigger block of every scheduled workflow.** `arb-linkage-monitor.yml` was caught
   on 2026-08-21 claiming coverage it only delivered on a cron; the guard that caught it now
   only guards the two monitoring files. Anything else in `.github/workflows/` that is
   `schedule`-only is making the same claim, and GitHub disables schedules in a repository idle
   60 days. Cheap: read the `on:` block of each, and ask which of them a PR author would expect
   to catch their mistake.
3. **Re-probe SIWE before building on it.** The `500 "Failed to generate nonce"` below is a
   **2026-08-15** reading, not a fact about today. Re-run the probe first; if it still fails, the
   migration order (`castVote→proxyWrite` → 015 §1 → 014, and 015 **before** 014) is the part
   that is easy to get backwards and expensive to undo.

**Operator lane — unchanged, and still the highest-leverage thing on this page:**

4. **Name the Safe topology.** Minutes, free, human-only, zero dependencies, unblocks ~20 items.
   The blocker was never money or recruitment — it was that `SAFE_REHOME_RUNBOOK.md:31` demands
   15 disjoint keys and nobody wrote down that the *target* is the problem. Reachable answer is
   **8 keys** (2-of-3 / 2-of-3 / 1-of-2), or 3. See **The critical path**.
5. **Arm the coverage ratchet, or record why it cannot be armed.** One click plus one commit;
   procedure and the expected failure mode are under the ⏰ section. Right now it is a gate that
   enforces nothing and no longer says so out loud.

⚠️ **Before acting on any item below, check its date.** This page is a 2026-08-15 snapshot with
dated corrections layered on. Items carrying a `> **Updated …**`, `> **Reconciled …**` or
`> **Re-verified …**` block have been re-verified; the rest have not been re-read since the
sweep, and six of them were already wrong on the day they were written — see the corrections
section immediately below.

**Status of the five above, as of 2026-08-21:** ① is being worked in a separate session — check
whether `tsc -b` is green before starting it, rather than assuming either way. ②–⑤ are untouched.

**Four lanes have now been re-verified item-by-item and carry their own next steps: Frontend**
(4 of 5 named CLOSED; R080 narrowed to 1-of-3) · **Repo hygiene** (receipts CLOSED; every other
number grew) · **Contracts** (restaking DEAD; `canUpdate()` and `additionalContracts` CONFIRMED
with mechanisms) · **the completeness-critic eight** (CSP and the advisory gate CLOSED; vendored
libs, zero-test router and `release.yml` CONFIRMED; nakamigos WORSE). Read those blocks before
picking anything up — **about a third of what the prose calls open is already closed, and a few
things are worse than written.**

**Honesty debt is now swept too** (see the block under it): the count held at ~5-6 but the
*contents* moved, and two items were mis-classified as wording when they are functional —
`read.ts` asserts a deployment that does not exist, and `cp-swap/src/lib.rs`'s header tells an
operator to do the exact thing its own body records as the bug that bricked graduation.

**Backend re-probed live 2026-08-21 — SIWE still 500, and the root cause is now nailed down.**

- 🔴 **`/api/auth/siwe?action=nonce` returns `500 {"error":"Failed to generate nonce"}` on BOTH
  origins** (`tegridyfarms.vercel.app` and `memetic.fun`), six days after the 08-15 probe. The
  entire authenticated layer is still dead.
- 🔑 **The cause is not a mystery and does not need a DB read to establish.**
  `frontend/api/auth/siwe.js:136` inserts into `siwe_nonces`. `014_siwe_nonces.sql`'s own header
  states it plainly: `public.siwe_nonces` **does not exist in production**, PostgREST answers
  `PGRST205`, the INSERT errors, and every login 500s. **SIWE login has therefore never worked in
  production.** The table was supposed to come from `001_siwe_auth_rls.sql`, which aborts partway
  through. So the fix is exactly migration **014** — and the ordering constraint in TIER 1 is the
  whole game: **015 must land first**, or opening login while 21 permissive `qual=true` policies
  are live exposes every user's rows on day one. ⚠️ And 015 only names **12 of the 21** — enumerate
  live-21 against 015's-12 before running either.
- 🔴 **`/api/analytics` confirmed: migration 013 is STILL unapplied.** The endpoint has two
  distinct 503s and the doc had never separated them: `analytics.js:175` returns
  `"Analytics sink not configured"` (env missing, before any DB call) and `:202` returns
  `"Analytics sink unavailable"` (the `analytics_events` INSERT itself failed). Probed in two
  steps, deliberately:
  1. **A zero-write probe first.** `{"events":[]}` returns at `:180` *before* any insert — it
     answered **`200 {"accepted":0,"rejected":0}` on both origins**, which rules out the
     "not configured" branch without writing a single row. Reuse this one freely; it is inert.
  2. **Then one clearly-marked synthetic event**, which returned **`503 "Analytics sink
     unavailable"`** — the `:202` branch. The INSERT failed, so **013 is unapplied** and the
     probe wrote nothing.
  🔑 **Method worth keeping: migration applied-state was established with no DB credentials**, by
  reading the API's own error branches. The same trick localised SIWE to 014. Before asking for
  DB access to answer an applied-state question, check whether a route already distinguishes the
  failure modes for you.
  ⚠️ Not re-checked: the client half of that finding — the prod bundle's `flush()` being literally
  `console.log("[analytics]", …)`. **Both halves were broken on 08-15; only the server half is
  re-confirmed here**, so fixing 013 alone may still yield no data.
- ⚠️ **Correcting the probe list itself:** `/api/record` and `/api/births` are **not routes** —
  both 404. They live in `frontend/api/_lib/` and are mounted behind branches of
  `aggregator.js` / `analytics.js` / `orderbook.js` / `supabase-proxy.js`. The repo is at **11
  top-level functions of the Vercel Hobby cap of 12**, which is why. Anyone re-running the 08-15
  probes needs the real query form, not those paths.

**Env-var docs, re-derived 2026-08-21 — 8 undocumented, 2 dead, and half the undocumented ones
route money.** `frontend/.env.example` documents 20 `VITE_` vars; the code actually reads 26.

- **Read by the code, absent from `.env.example` (8):** `VITE_SWAP_FEE_BPS`,
  `VITE_SWAP_FEE_RECIPIENT`, `VITE_SOLANA_FEE_VAULT`, `VITE_ONRAMP_PARTNER_FEE_BPS`,
  `VITE_COW_STOP_LOSS_HANDLER`, `VITE_INDEXER_URL`, `VITE_ISLAND_KEY_ROUTE`,
  `VITE_TRIGGER_PRICE_FEEDS`.
- **Documented but read nowhere (2):** `VITE_0X_API_KEY`, `VITE_ALCHEMY_API_KEY`.
- ✅ **The good news, and it is the important half: the fee code fails CLOSED, not open.**
  `lib/fees/swapFee.ts:73-76` — a missing or unparseable bps yields 0, a missing/invalid address
  yields null, and either one returns `{ enabled: false }`. The zero address is rejected
  *explicitly*, with the right reason given in the source: several providers read it as
  "no partner" and silently keep the fee, "which would read on our side as revenue we never
  earned." **So an unset var cannot misroute a fee to a stranger.**
- 🔴 **The actual risk is silent revenue loss.** Four money-routing vars are undocumented, so a
  fresh or re-created deploy omits them, and swap fees are then simply **off** — with nothing
  logged, nothing surfaced, and the symptom appearing weeks later as "we earned 0". Given
  [[project_2026_08_02_native_pool_drained]] and the stranded fee rail, that failure mode has a
  track record here.
  → **Next step:** document all 8 in `.env.example` (names and semantics — **no values**), delete
  the 2 dead entries, and add a one-line startup log when `swapFeePolicy()` returns disabled, so
  "fees are off" is an observation rather than an inference.

⚠️ **Method note on this one: my first pass said 18 undocumented and it was wrong.** A bare grep
for `VITE_[A-Z_]+` matches *comments*, and three of the hits were exactly that — including
`VITE_ETHERSCAN_API_KEY`, which survives only in a `HistoryPage.tsx:78` note recording that it
**was removed** from the client bundle. Reporting that as a live client-exposed key would have
been a bad call in the other direction. **Match `import.meta.env.VITE_…`, not the bare name.**

✅ **README native-pool figures — CLOSED.** `README.md:101` already carries the corrected
on-chain reading (146,258 TOWELI + 0.00383 WETH ≈ $14, ~83% of LP burned, LP Farming holding 0
staked LP), it matches the independent 08-02 record, and it is **explicitly dated** rather than
asserted as current. The "six times off" in that line refers to the *deepen sizing* being 6×
undersized — a correction the README already states — not to an error in the figures.

**Genuinely still not verified:** the analytics client-side `flush()`, the remaining
migration/DB applied-state items beyond 013 and 014, and external prep. Treat those as 08-15
hypotheses.

⚠️ **A pattern worth naming, because it showed up in three separate lanes today:** a fixed count
with changed contents. "LIVE ON MAINNET" is still 5 files, but two were cleaned and the claim
**spread into `YEAR_PLAN_2026_2027.md`**; the "Last reviewed" stamps dropped 5→3; nakamigos was
called unswept when it had been swept and left unfixed. **A number that has not moved is not
evidence that nothing moved** — re-derive the list, never trust the tally.

⚠️ **One finding from the 08-21 sweep, and one retraction.** The advisory gate now exists and the
debt has not moved — **40 advisories, ten high, unchanged in six days**. A gate that has been
green over ten highs for a week is either not failing on them or nobody is reading it; that is
the "gate is not a control until something fails when it fires" defect this repo has now
rediscovered nine times.

**Retracted:** I paired that with the contracts size gate, claiming it only warns where the
ceiling binds. **That was wrong** — the size step tests EIP-170 in its first branch and the floor
allowlist cannot reach it, so a TegridyStaking crossing is a red run, not a silent one. Detail
and the control flow are under **Contracts** below. The lesson is the ordinary one: I read the
comment and the severity strings without reading the branch structure they sit in.

🔴🔴 **AND THE THIRD INSTANCE OF THAT CLASS, FOUND THE SAME DAY, IS THE WORST: contract tests
have not run on trunk since ~2026-08-20.** `contracts-ci`'s `build` job is red on `mvp-launch`,
and the structure guarantees the blackout — verified at file:line in
`.github/workflows/contracts-ci.yml`: the nine-slice matrix is `needs: [build, slices]` (`:337`),
`fuzz-invariant` is `needs: [build]` (`:511`), and `all-tests-pass` is
`needs: [build, slices, test, fuzz-invariant]` (`:590`). **A red `build` skips every one of
them**, so merges in that window landed with zero contract test coverage and nothing said so.

⚠️ **The job name actively misleads.** It is called "forge build + size budget", but the size
budget only warns. The step that actually fails is **`Interface + frontend ABI selector guard`**:
`AIRDROP_DISTRIBUTOR_ABI` and `VESTING_WALLET_ABI` resolve to no artifact. **Fix is open as #306**
(two `FRONTEND_ABI_TARGET_OVERRIDES` entries mapping them to `TegridyAirdropDistributor` /
`TegridyVestingWallet` — the exports drop the `Tegridy` prefix, exactly as `LP_FARMING_ABI`
already does). Expect #306 to surface a *different, real* selector error next: that is the guard
finally inspecting a surface it could never reach, not a regression. **Do not silence it by
moving those ABIs to `EXTERNAL_FRONTEND_ABIS`** — they have in-repo `*_ADDRESS` and the guard
rejects that. **Verify by confirming the nine slices RUN, not merely that trunk went green.**

So the same shape now has three live instances: a red step blacking out later *steps* (tsc, in
the CI lane below), a red job blacking out later *jobs* (here), and gates that fire into nothing
(above). **When something in this repo goes red, the next question is always "and what stopped
running because of it?"**

---

## Read these five corrections first

Each one is something the repo currently tells you that is false, and acting on any of them
wastes your time or your money.

**1 — Squads member B can sign. It has never been a blocker.**
`ISLAND_WAVE_THREE_STATUS.md:15` and `SOLANA_PROGRAM_FINDINGS_2026_08_15.md:51` both say member
B holds 0 SOL and has never appeared in a proposal's `approved[]`. I read it myself: it holds
**9,785,035 lamports** and has **three successful mainnet transactions**, the most recent
2026-08-13. Two independent lanes also decoded proposal #4 as Executed with B in `approved[2]`.
This is a false blocker of exactly the kind that gets a working multisig abandoned in favour of
a hot key.

**2 — Production is current.** The note that prod is 707 commits behind is dead. Both origins
serve the identical build and the lazy chunks carry all of Wave 3. Trunk is six *doc* commits
ahead — no code gap. (Verifying this needs care: `index.html` names only 22 chunks and grepping
those alone false-negatives on every marker. The real code is in lazy chunks you reach by
extracting asset names from inside the downloaded chunks — 120 files total.)

**3 — Nobody is being cheated on the premium swap discount.** One lane flagged that a paying
subscriber is charged full fees for a benefit they bought. They are not: the discount was
removed from the product in the 2026-07-18 honesty pass, `premiumBenefits.ts:28` says so, and
`accumulatedETHFees()` is 0 so there is no fee to discount. The wiring gap is real; the urgency
was not. **Demoted to optional.**

**4 — `/solana` is already live.** A lane proposed un-gating it. The production bundle shows
`VITE_SOLANA_FEE_ACCOUNT` is set, `isSolanaConfigured()` is true, and the Jupiter-routed swap is
running. The item is not open work — its root cause is a stale code comment at
`SolanaLaunchPage.tsx:889` asserting a prod value the file cannot read, which has now generated
one phantom finding and will keep doing so.

**5 — Do not fund the Solana deploy authority.** `OPERATOR_PACKET` §0 still ranks this action
#1. It now buys you the ability to call `update_global` on a program with null ProgramData —
which is nothing — while reading as progress on the dashboard. That is the expensive part.

---

## ⏰ One thing has a clock on it, measured in hours

The contracts-coverage cron is `13 5 * * 0` — **Sunday 05:13 UTC**. It is 03:04 UTC on Sunday
2026-08-16 right now, and `.github/coverage-floor.json` **does not exist**. The ratchet fires in
roughly two hours against no floor. This is mine to fix, not yours — I mention it because it is
the only item on this page with a deadline today.

> **The clock expired 2026-08-16 and this section is kept only as the record of it. Re-read
> 2026-08-21: the deadline is gone, the item is HALF closed, and the remaining half is yours.**
>
> `.github/coverage-floor.json` now exists (committed 2026-08-18), which removed the
> "Coverage floor not armed" hard failure that was stopping the cron completing at all. But it
> carries **`lines: 0`, `measured: null`** — so the ratchet still **enforces nothing**. It is a
> disarmed gate that no longer announces itself as disarmed in the run's conclusion, which is
> the more dangerous of the two states: `contracts-coverage.yml:151` downgrades it to a
> `::warning`, and warnings do not fail runs or get read.
>
> Arming it is **one operator action, no code change**, and the file's own `_readme` carries the
> procedure: Actions → Contracts Coverage → Run workflow with **`update_floor` checked** → the
> run prints measured JSON and enforces nothing → commit that number as `lines`, with
> `measured` / `measuredOn` set from the same run.
>
> **Expect step 1 to fail, and treat that as the finding, not as an error.** At arming time
> `forge coverage --ir-minimum` aborted with a Yul "too deep in the stack" exception before
> emitting `lcov.info` (forge 1.5.1, solc 0.8.26), with and without `script/` excluded; the
> non-IR fallback died in `script/DeepenLP.s.sol`. If it fails the same way on the runner, the
> conclusion is that this contract set needs a **coverage strategy before it needs a floor** —
> do not seed a guessed number to make the job green. `frontend/src/test/contractsCoverageFloor.test.ts`
> enforces that `lines` may never exceed `measured`, and that `lines` stays 0 while `measured`
> is null, so a guess would fail the frontend suite rather than sneak through.

---

## The critical path

Four operator actions unlock more than everything else on this page combined.

```
1.  Name the Safe topology          minutes · free · human-only · zero dependencies
      ↓
2.  Recruit + independence-verify   3–4 people at 8 keys, 12–14 at 15
      ↓
3.  Deploy 3 Safes + smoke-test     nonce ≥ 1 on each, BEFORE naming any authority
      ↓
4.  18 contracts: transferOwnership → acceptOwnership
```

Downstream of those four steps: the factory feeToSetter re-home · the factory guardian rotation
· pauseGuardian × 4 · the NFTPoolFactory rescue · `setGaugeController` signed by a quorum instead
of a hot key · the four Community un-gates · Pro Pass creation · LaunchpadV2 taking ETH ·
TegridyLending · the launcher integrator re-point · the Hats vault · the auto-pause trigger ·
Island Wave 3 phase 05 · the hardware-key purchase · a truthful `GOVERNANCE.md`.

**Why step 1 is the bottleneck and not the money.** Every previous attempt stalled at "we need
15 signers and we have 3", and nobody wrote down that *the target itself is the problem*.
`SAFE_REHOME_RUNBOOK.md:31` demands 15 disjoint keys. On chain, the union of all three existing
Safes is **three addresses**, two of which fail the runbook's own EIP-7702 independence test.
The reachable answer is 8 keys (2-of-3 / 2-of-3 / 1-of-2), or even 3 (Admin-only, self-held on
distinct hardware). Both are strictly better than one hot EOA across 19 authority surfaces.
Nobody has to recruit anyone until you pick the number.

**The second chain runs in parallel and needs no signers at all:**

```
[me] castVote → proxyWrite  →  015 §1  →  014  →  the entire authenticated social layer
```

DMs, profiles, favourites, watchlist, votes, order creation, push subscriptions and every
`/api/supabase-proxy` write are **100% dead behind a 500 today** — I confirmed it live:
`/api/auth/siwe?action=nonce` returns `500 {"error":"Failed to generate nonce"}`.

---

# TIER 0 — Today. No dependencies.

| # | Do this | Why first |
|---|---|---|
| **0.1** | **Name the Safe topology.** 8 keys, 3 keys, or hold at 15 and accept the stall. Write the answer into `SAFE_REHOME_RUNBOOK.md §3`. | Free, minutes, human-only, and the head of the longest chain in the repo. |
| **0.2** | **Unjam TegridyFactory** — three calls from the deployer, no Safe needed: `cancelFeeToSetterProposal()`, `cancelGuardianChange()`, `cancelFeeToChange()` on `0xa24C7287…7a52`. | ~$0.05. Until these clear, `proposeFeeToSetter` reverts `CANCEL_EXISTING_FIRST` and `proposeGuardianChange` reverts `ExistingProposalPending`. A fully-built Safe still could not take the factory. |
| **0.3** | **Pause MemeBountyBoard and VoteIncentives** — 2 transactions. | Both live, both `paused() == false`, both permissionless-write, neither has a UI. Closes ~20 audit findings for two signatures. |
| **0.4** | **Back up the deployer keystore + password** to two geographies, offline. | `OwnableNoRenounce` disables renounce and rejects `transferOwnership(address(0))`. Lose that one file before the re-home and **18 mainnet contracts become permanently unownable.** Cheapest item here, worst tail. |
| **0.5** | **Squads 2-of-2 → 2-of-3.** Add a third member. | ⛔ A 2-of-2 cannot repair itself, and the repair is itself a 2-of-2 transaction — so it can only be done *while both keys still work*. Guards the only live Solana fee custody. Independent of the restart decision. |
| **0.6** | **Add a third owner to the Treasury Safe `0x7D26`** — `addOwnerWithThreshold(new, 2)`. | Same argument on the EVM side. Executable today from the existing quorum (`nonce = 1` proves it signs). Does not wait on 0.1. |
| **0.7** | **One Vercel lookup session.** Check — do not set — `SOLANA_RPC_URL`, `ALCHEMY_API_KEY_FALLBACK`, `ETHPLORER_API_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `MEMETICS_BIRTH_SECRET`. | Five of these are *"go look"*, not *"go set"* — none is verifiable from outside. Batch them into one tab. Set `VAPID_SUBJECT` regardless; it still points at the dead `tegridyfarms.vercel.app`. |
| **0.8** | **Answer: do you already hold the birth secret, or does seacasa still owe it?** | `HEAT_WAVE_TWO.md:156` says it comes from them; `ISLAND_WAVE_THREE_STATUS.md:14` says it is operator-only. One of those is wrong, and it decides whether Wave 3 phase 01 is a 30-second paste or a line in the next message to the island. |
| **0.9** | **Answer: is `6VHowW4p…` your second key, or someone else's?** | One sentence. It determines whether a stranger is a co-signer on the vault holding all Solana fee custody. |

---

# TIER 1 — The login change-set. Strictly ordered.

> ⛔ **The most order-sensitive block in the repo.** Getting 1.1 and 1.2 backwards exposes every
> user's rows to anyone holding the anon key that ships in the browser bundle.

| # | Step | Constraint |
|---|---|---|
| 1.0 | *(mine)* Repoint `castVote` at `proxyWrite` — merged and deployed | ⛔ Running 015 §1 before this ships kills voting **silently**: `castVote` returns false on RLS denial and the UI has no error path. |
| **1.1** | **015 §1 — the eight DROPs** | ⛔ **Before** 014, not alongside. The migration header says so in terms. Any window where login works while 21 `qual = true` policies are live is a full exposure. |
| **1.2** | **014, whole, same session** | Ends with `NOTIFY pgrst, 'reload schema'` — without it the table exists and PostgREST keeps answering PGRST205. |
| **1.3** | **Verify** — anon empty-body POST returns **42501** on all four tables; `?action=nonce` returns **200** | The 23502 → 42501 flip is the only proof RLS actually bit. |
| **1.4** | **Migration 016** — `REVOKE SELECT ON native_orders, trade_offers FROM anon, authenticated` | Same session. There is no anon reader of either table (everything goes through `/api/orderbook` on the service key), so this is two lines — **not** the column allowlist one lane proposed. |
| **1.5** | `prune_revoked_jwts` REVOKE + `SET search_path` — 004 §2's three statements, as a standalone migration | Same session. ⛔ Do **not** run 004 as a unit. |
| **1.6** | **Migration 013 + `VITE_ANALYTICS_ENDPOINT=/api/analytics` + redeploy** | Both halves are broken and both must land. I confirmed each independently: a well-formed event to `/api/analytics` returns **503 "Analytics sink unavailable"**, and the live bundle's `flush()` is literally `for (let e of t) console.log("[analytics]", e.event, e.properties)` — every event is printed to the visitor's own console and discarded. `VITE_` is a build-time var, so setting it without a redeploy changes nothing. |
| 1.7 | ⛔ **Never run 008 after 014** | `008:18` is a blanket `GRANT … ON ALL TABLES … TO anon, authenticated`, which reverses 014's `REVOKE ALL ON siwe_nonces`. |
| 1.8 | **Decide 015 §2 read-side, per table** — after login works | `votes` is the trap: dropping "Anyone can read votes" blanks the public tally, because `userdata.js:363` is an anon SELECT. Needs an aggregate view from me first. Do not blanket-uncomment. |
| 1.9 | VAPID server-pair verification | Downstream of 1.2 — nobody can create a push subscription until SIWE works, so nobody is misled today. |

> ⚠️ **Known gap, flagged by the completeness critic and not yet resolved.** Ground truth says
> **21** live policies are permissive-with-`qual = true`. Migration 015 names **12** (8 active
> DROPs, 4 commented). That leaves roughly **9 untouched on tables 015 never mentions.** The
> change-set is being described as *the* RLS remediation; it is a partial one. Enumerate the live
> 21 against 015's 12 before you burn the session — that is mine to do.

---

# TIER 2 — The custody chain

| # | Step | Gate |
|---|---|---|
| 2.1 | Recruit + independence-verify signers | needs 0.1. `eth_getCode` must be **empty**, not 23 bytes. No two candidates on the same 7702 delegate, no two on the same hardware model. |
| 2.2 | **Resolve the EIP-7702 delegate overlap** | `0xe44Ec097…` and `0xE9B7aB8e…` both delegate to `0x612373d7…51d3`. Of three existing signers only `0x28d7CB2F…` passes the runbook's own test. This decides how many humans 2.1 must call. |
| 2.3 | Deploy 3 Safes, smoke-test each to `nonce ≥ 1` | ⛔ `MULTISIG_MIGRATION.md:106` — *"Do not transfer ownership to an untested Safe."* Two live counterexamples already sit at nonce 0. |
| 2.4 | **Prove `0xA360` can sign** (nonce 0, never executed) | ⛔ Must precede 2.9. If it cannot assemble 2-of-3, NFTPoolFactory is permanently unrecoverable — learn that at zero cost, not on the day it matters. |
| 2.5 | **Prove `0xCDCA` can sign** (1-of-2, nonce 0, owners = the whole Treasury quorum) | ⛔ Must precede 2.10 and any reliance on `INCIDENT_RESPONSE.md` §5's T+0:02 pause. |
| 2.6 | **18 × `transferOwnership` → `acceptOwnership`** | Fork-rehearse the whole sequence first. `acceptOwnership` checks the 14-day expiry *before* the caller, so submit accepts promptly. Nine of the 18 carry a stale expired `pendingOwner = 0xA360` — cosmetic, not a live seizure window. |
| 2.7 | Factory `proposeFeeToSetter` → **24h** → `acceptFeeToSetter` (7-day window) | needs 0.2. ⛔ `acceptFeeToSetter` force-cancels `GUARDIAN_CHANGE` — so do 2.8 first, or plan to re-propose the guardian after. |
| 2.8 | Factory `proposeGuardianChange` → **48h** → execute | needs 0.2 + 2.3. Target must have `codeLen ∉ {0, 23}` — a 7702-delegated EOA is rejected. |
| 2.9 | **NFTPoolFactory: `0xA360.transferOwnership(ADMIN_SAFE)`** → accept within 14 days | needs 2.4. **Highest-urgency re-home, above 2.6** — `0xA360` is 2-of-3 and two of its three owners share one 7702 delegate, so a single delegate compromise clears threshold today. |
| 2.10 | `setPauseGuardian(GUARDIAN_SAFE)` × **4** | Instant, owner-set, no accept step. Four contracts, not the seven the runbook lists — three of those are undeployed and two revert on `pauseGuardian()`. |
| 2.11 | **Write the un-gate waiver, or re-gate** | `SAFE_REHOME_RUNBOOK.md:171` forbids un-gating fund-touching features before their owner is a multisig. It happened anyway. The launcher bypass is documented; the gated-batch bypass is not. Decide in writing which. |

---

# TIER 3 — Fee rails, oracle, emissions

| # | Step | Gate |
|---|---|---|
| 3.1 | `recoverCallerCredit()` on SwapFeeRouter | Permissionless, no args. 2.4e12 wei — under half a cent. **Bundle it with any other transaction; do not make a special trip.** It has been carried as an open action for weeks and deserves a straight answer: the money is real, the amount is not. |
| 3.2 | ⛔ **POL wiring, strict order:** `proposePolAccumulator` → 48h → `executePolAccumulator` → `proposeFeeSplit` → 48h → `executeFeeSplit` | Raising `polShareBps` while the accumulator is unset makes `distributeFeesToStakers` **silently fold the whole POL slice into treasury**. The contract only guards the reverse. |
| 3.3 | **TWAP decision.** Path A: deepen the pool. Path B: lower the floor (propose → 24h → execute). | Costed in `CAPITAL_REQUIREMENTS_2026_08_15.md` — $3,886 all-in for a 1.0 WETH floor. Path B weakens the oracle TegridyLending's origination check consults. A genuine security trade-off, not a chore. Never quote a fixed depth multiple; it drifts with every trade. |
| 3.4 | GaugeController: `proposeAddGauge` → timelock → `executeAddGauge`. Review the 1e24/epoch budget. | Four epochs have elapsed with nothing to vote on. Nothing is leaking — with zero gauges there is nothing to emit to. |
| 3.5 | ⛔ **`setGaugeController` on VoteIncentives — ONE-SHOT** | Do it **after** 2.6 so an Admin Safe quorum signs it. The deployed bytecode has **no** `applyGaugeControllerChange` — the rotation path you may believe exists landed three weeks after the deploy. A typo from a hot key bricks every future bribe deposit forever. |
| 3.6 | Un-gate the four Community contracts | ⛔ **after** 3.5 and 3.4. With `gaugeController == 0`, `_requireGaugedPair` is a no-op and bribes deposit against pairs that were never gauged. |
| 3.7 | Deploy TegridyLending + Admin | ⛔ **after** 3.3. Origination calls `_assertSpotWithinTWAP` against an oracle with zero observations — you would ship a contract that reverts on every valuation. |
| 3.8 | Create the Pro Pass collection | after 2.6 — LaunchpadV2 should be Safe-owned before it takes ETH. Note the `CollectionConfig` struct has **fourteen** fields, including a merkle root and Dutch-auction params. |
| 3.9 | Staking reserve: top-up or rate cut before ~2026-10-11 | ⛔ The failure model in the runbook is wrong. `getReward()` does **not** revert — `StakingRewardLib.sol:493` caps the payout and books the shortfall as `unsettledRewards`. Claims start **silently paying partial with IOUs**. Quieter, and arguably worse for trust. |
| 3.10 | LP farming: restart emissions, or say so in the UI | Funding emissions before deepening the pool pays for liquidity that is not there. |
| 3.11 | *(optional)* Premium swap discount | See correction 3. Nobody is misled. Product decision, not a fix. |

---

# TIER 4 — Solana. One decision gates most of it.

| # | Step | Gate |
|---|---|---|
| 4.1 | **Restart or retire.** (a) both programs, (b) launch-only and graduate elsewhere, (c) retire the own-venue and keep Meteora. | Head of the tier. Write the answer into `ISLAND_WAVE_THREE_STATUS.md` note 1. |
| 4.2 | *(mine)* Fix `liveConfig.ts` `CONFIG_OFFSETS.feeClaimer` **72 → 40** | ⛔ Must precede 4.6. On v1 both offsets hold the same key so nothing is exposed — but the moment a v2 config is minted this is the only thing between a mistyped `fee_claimer` and every future launch's fees, **and it would report "verified"**. |
| 4.3 | *(mine)* Add `--opening-fee-bps` / `--resting-fee-bps` / `--decay-seconds` to `cmdCreateConfig` | ⛔ Must precede 4.6. Without it a signing session silently reproduces `DEFAULT_ANTI_SNIPE` = 9900 bps. |
| 4.4 | ⛔ **Three authority destinations** — `admin::ID`, `deployer::ID`, upgrade authority | needs 4.1 + 4.2. These are **compile-time constants**, answered before `solana-verify build`, not after. Getting this wrong once already cost 8.4 SOL and both programs. If you name the vault, it must be funded above the 890,880-lamport rent floor. |
| 4.5 | Fresh keypairs, backed up offline **at generation time**; mark the two spent IDs retired | needs 4.1. ⛔ `MAINNET_RUNBOOK` §2 tells you to hunt for `1111…1111` sentinels — but cp-swap's committed `declare_id!` is the real spent id `3ZvZXEBr…`, so following §2 literally leaves it in place and the deploy dies on arrival with `DeclaredProgramIdMismatch (4100)`. |
| 4.6 | **DBC config v2** — print without `--send`, read the fee split, then sign | needs 4.2 + 4.3. **Independent of 4.1** — it is Meteora's program, not ours. Cheapest revenue-relevant action anywhere on this page. |
| 4.7 | **Publish `VITE_SOLANA_DBC_CONFIG`** | ⛔ **Never before 4.6.** Opening the current config ships public launches that are economically untradeable for ~4 hours at a 99% opening fee. |
| 4.8 | Segmented-mode scope call: ship it behind a shared economics gate, or delete it | needs 4.1. The capital plan gates the restart SOL on these two HIGHs being closed. |
| 4.9 | Solana fee custody: rotate to the vault, or accept single-key in writing | **Free today** — both ATAs read zero, so the switch strands nothing. Gets harder with every day of real volume. |
| 4.10 | Back up the four live Solana identities | ⛔ The three keys the current backup routine protects are **dead**. The four that hold something live are on **no disk anywhere**. |
| 4.11 | ⛔ **Do NOT fund the deploy authority** | See correction 5. |

---

# TIER 5 — External. Long lead times, so start early.

| # | Step | Note |
|---|---|---|
| 5.1 | **Send the wave-three packet to seacasa** | Written, pushed, never handed over. Two raw.githubusercontent links, one message. No blocker. **Add a fifth question the packet does not contain:** when will the island publish its attestation signing key, and at what route? Without it the heat gate is walkable by anyone who reads the Airlock ABI — it is the largest thing they owe us. |
| 5.2 | **Send the Solana audit RFQ** to OtterSec / Neodyme / Sec3 / Zellic | Free, and it turns the largest unpriced line in the capital plan into a number. Audit calendars, not engineering, are usually the schedule constraint. I fix `AUDIT_RFQ.md:107` first — it currently tells four firms nothing was ever deployed and nothing holds funds, and both are now false. |
| 5.3 | **Send the Whetstone petition** (+ the BUSL grant question) | **Refreshed 2026-08-19.** Every source-and-test claim re-verified against the working tree; the drifts are logged in the petition's own §0.1. The branch pointer is **gone** — no commit is named, and the petition instead hands the reader a one-line `grep` for `PROTOCOL_OWNER_MIN_SHARES` to prove the fix is in whatever tree they were given. The on-chain reads (Airlock owner, module states, the four `initialize` probes) still date to **2026-07-31** and cannot be re-read from the repo, so §15 makes re-running them a precondition of sending. The venue choice behind the ask is now recorded in `GRADUATION_VENUE_DECISION.md`. Still needs you: re-run §13, re-check the BUSL grant channel, pick the ref you hand them, fill in a contact. |
| 5.4 | **SEAL 911 / Safe Harbor registration** | Free, no dependencies. Hats vault **after** the Treasury Safe. |
| 5.5 | Immunefi listing — decide | ⛔ Fix `AUDITS.md:178` first (its published Immunefi link 404s — verified today). Then decide. Publishing reward tiers a $61 treasury cannot honour is worse than having no page. |
| 5.6 | Book or formally decline a paid human audit | ⛔ Should **follow** the re-home. Auditing a system whose admin model is about to change out from under the report wastes the report. |
| 5.7 | Legal entity + tax scoping conversation | Reclassified from EXTERNAL to yours — nobody has been contacted, so nothing is pending on anyone's side. |

## The 7 genuinely waiting on someone else

| Who | What | Blocks |
|---|---|---|
| Island | **Q1** — exact TWAB window semantics, or "stay descriptive" | a reproduction preview |
| Island | **Q2** — is the rate the immutable half, or must the destination be timelocked | one published sentence + the code matching it |
| Island | **Q3** — certification read path: `/record/:chain/:ca/certification.json`, or their own root | one path change; module and tests exist |
| Island | **Q4** — voucher expiry: verifier's clock, or an island freshness rule | expiry judgement in the seam |
| Island | **A certification endpoint** — probed 404 today | the garden lane can never light without it |
| Island | **A signing key and key route** — never published | the launch gate stays advisory and unenforceable |
| Whetstone | Doppler BUSL Additional Use Grant — still unregistered, verified on-chain today | 15 days since the last check |

---

# TIER 6 — No clock on these

**Branch protection** ⛔ — arming the ruleset as currently written is **strictly worse than
today's honest zero enforcement**, for two independent reasons: `contracts-ci.yml` and
`slither.yml` have `paths:` filters and GitHub never synthesises a passing check for a skipped
workflow, so the nine clean Dependabot PRs would sit at "Waiting for status" forever; and every
context string in the plan is the UI display form (`CI / Build`) rather than the check-run name
(`Build`), so the ruleset would show active while matching nothing. I ship the companion
workflow and correct the strings first.

**Then, in any order:** indexer wire-or-delete · `/api/v1` publish-or-cut · FeeExecutorRouter
deploy-or-delete · bundle listing (migration 012 is already applied, so only the flag and a QA
pass remain) · write down the already-made EVM-rail freeze verdict · legacy-staking residue
(EIP-170-gated) · ROADMAP restate-or-retire · V4 audit (weeks + money) · DefiLlama listing
(**after** the pool deepen — today it would publish a native pair holding 0.023 WETH).

---

# Where doing it early is worse than never doing it

Ranked by what it costs to get backwards.

| Doing this early | Costs you |
|---|---|
| **014 before 015 §1** | Login day arrives with 21 permissive `qual = true` policies OR-defeating every owner policy. Every user's favourites, watchlist, profile and votes become world-readable **and world-writable** to anyone holding the anon key in the browser bundle. The tables are harmless today *only because nobody can log in.* Turning on login is what arms the bug. |
| **015 §1 before the castVote fix ships** | Voting dies silently. No error path in the UI. |
| **Naming any Safe or vault authority before proving its members sign** | The already-paid-for failure. `admin::ID` pointed at the Squads *multisig account* instead of the *vault PDA* → AmmConfig uncreatable → 8.4 SOL and both programs gone. The identical shape is live twice on EVM right now: `0xA360` (owns NFTPoolFactory) and `0xCDCA` (pauses four fund-touching contracts) **both at nonce 0.** |
| **`setGaugeController` before the VoteIncentives re-home** | One-shot, no rotation path in the deployed bytecode. A typo from a hot key bricks every future bribe deposit forever. |
| **Un-gating VoteIncentives before `setGaugeController`** | `_requireGaugedPair` is a no-op at `gaugeController == 0` — bribes deposit against pairs never gauged. |
| **Publishing the DBC config before v2** | Every public launch untradeable ~4h at 99%, presented as launched. pump.fun is flat ~1% from t=0. A creator who lives through that does not come back, and fixing the config later does not recover it. |
| **Minting a v2 config before the `feeClaimer` 72→40 fix** | A v2 with a wrong `fee_claimer` and a right `leftover_receiver` **passes the custody gate and reports "verified"** — the venue's headline Solana guarantee, inverted at the exact moment it first matters. |
| **Raising `polShareBps` before wiring `polAccumulator`** | The POL slice folds into treasury. No revert, no event, no log. |
| **Rotating Solana `global.authority` before one proven graduation** | `update_global` is the only instruction that can set `cp_swap_program`/`amm_config`. Rotate first and a 2-of-2 ceremony becomes a prerequisite for the *first* graduation. |
| **Deploying TegridyLending before the TWAP is warm** | Ships a contract that reverts on every valuation. |
| **Arming branch protection as written** | See TIER 6. |
| **Committing the receipts *and* flipping registry check 6 in one change** | Surfaces 36 more unregistered mainnet addresses and turns green CI red without a bulk retired-classification pass alongside. |
| **Funding the Solana deploy authority** | Buys nothing, and reads as progress. |
| **008 after 014** | Its blanket GRANT reverses 014's REVOKE. |
| **Running 004 as a unit to "catch up"** | Its `:174-183` re-creates the client write policies 007 deliberately removed. *(The commonly cited "kills the Trade Board" reason is false — every `trade_offers` path is service-key — but the write-policy hazard is real.)* |
| **Buying hardware keys before naming signers** | You cannot know how many to buy. |
| **Merging PR #278** | Not a duplicate — trunk's heat gate is a **newer rewrite**. #278 still carries `LAUNCH_MIN_HELD_DAYS`, so merging it **reverts the live gate to the 180-day rule that was deliberately removed.** Close it. |
| **Deleting the `VITE_0X_API_KEY` block from `.env.example`** | Reverses a deliberate choice — the four lines above it say it is kept *"only so nobody re-adds it believing it was missed."* |
| **Flipping the cp-swap roster entry to informational** | Removes a working tripwire that matches a documented deliberate decision. |
| **Immunefi before the treasury can honour tiers** | Worse than no page. |
| **DefiLlama before the pool deepen** | Negative upside. |
| **A paid audit before the ownership migration** | Audits a system about to change. |

---

# What I can do without you — 87 items

Grouped, so you can see the shape. None of these needs a key, a credential, money or a
judgement call.

**Honesty debt (10).** Both closed Solana programs still read "live, DEPLOYED" in
`addresses.json`; `readDeployment` calls them DEPLOYED; the "LIVE ON MAINNET since 2026-08-08"
assertion survives in eight files; `security.txt` disclaims the very domains it is served from;
the README's native-pool figures are six times off; ROADMAP writes shipped Q2 items as future
work; five pages carry a hardcoded "Last reviewed: July 2026".

> **Reconciled 2026-08-19 — four of these are closed, six are not.**
> *Closed:* the registry now records both program ids as closed on 2026-08-13 and carries
> each one's **ProgramData** address as its own entry with `expect: absent`, so the claim is
> machine-checked rather than asserted — the program stub stays executable-flagged after a
> close, which is exactly why the old `expect: executable` kept passing. `ROADMAP.md` is
> rewritten with a per-item status vocabulary and its Q3 "70/20/10" premise corrected (no
> such split is implemented anywhere). `NEXT_SESSION.md` is reduced to a redirect: it was
> dated April, and its "immediate priorities" told an operator to act on three addresses the
> June relaunch superseded, one of them the `GaugeController` whose `pairToGauge` reverts.
> The PWA manifests no longer describe a single-chain farming product.
> *Still open:* `readDeployment`'s wording; the "LIVE ON MAINNET since 2026-08-08" assertion,
> now in six files (`frontend/src/lib/launcher/solana/README.md`, `curve/index.ts`,
> `curve/program.ts`, `curve/ix.ts`, `curve/geometry.ts`, `frontend/scripts/tegridy-launch-operator.mjs`);
> `security.txt`; the README pool figures; the five "Last reviewed" stamps. The Solana
> markdown under `solana/tegridy-amm/` is corrected, but the same stale claims survive in
> `programs/cp-swap/src/lib.rs`'s header comment, which still describes fail-closed sentinels
> the tree no longer has and still names the multisig as `admin::ID`.

> **Re-verified 2026-08-21 — the count is right but the contents are not, and two of these are
> materially worse than "honesty debt" implies.**
>
> - 🔴 **`readDeployment` is not a wording problem — the comment is FALSE, and it is false in the
>   most instructive way available.** `frontend/src/lib/launcher/solana/curve/read.ts:16` asserts
>   **"The program IS deployed (mainnet, 2026-08-08)"**, while both Solana programs were closed
>   and verified closed on 2026-08-15 against two RPCs. Read the next sentence of that same
>   comment: it explains that the comment *previously* asserted "NOT DEPLOYED" and "went on being
>   believed after it was false, which is the whole argument for the check existing in code rather
>   than in prose." **It then made the identical mistake in the opposite direction, in the very
>   comment warning against it.** Second defect in the same file: `:126` models deployment as
>   `{ kind: 'deployed'; executable: true }` — and a closed program's stub **stays
>   executable-flagged**, which is precisely why the old registry check kept passing over closed
>   programs. → **Next step:** delete the claim rather than update it (the tree has proven twice it
>   cannot keep a deployment status accurate in prose), and check **ProgramData**, not `executable`.
> - 🔴 **`cp-swap/src/lib.rs` contradicts itself, and the header is the half an operator will
>   follow.** The header at `:33-40` claims the non-devnet AUTHORITY constants are the
>   System-Program sentinel (all-1s) so a default build is non-functional — but the actual
>   non-devnet values are live keys: `admin::ID` = `Dcjink4R…7kZ7` at `:75`,
>   `create_pool_fee_reveiver::ID` = `2sa31zce…uEXa` at `:88`. **No sentinel remains.** Worse, the
>   header instructs the operator to set **"admin = Squads MULTISIG"** at `:39` — and the body at
>   `:53-71` documents that doing exactly that shipped to mainnet on 2026-08-08, made
>   `create_amm_config` **UNCALLABLE**, and left `migrate_to_amm` permanently on
>   `AmmNotConfigured (6015)`: tokens could trade but never graduate. Squads v4 signs CPIs as the
>   **vault PDA**, never as the multisig account, and `CreateAmmConfig` has `payer = owner`, so the
>   account must be system-owned and fundable. **An operator who reads the header and stops
>   re-runs the incident, and this constant is compile-time — fixing it needs another program
>   upgrade.** → **Next step:** delete the header's fail-closed paragraph and its "admin = Squads
>   MULTISIG" line outright. Do not soften them; the body below already says the true thing.
>   See [[reference_squads_vault_vs_multisig_signer]].
> - ⚠️ **"LIVE ON MAINNET since 2026-08-08" is still 5 files, but not the same five.** Fixed:
>   `frontend/src/lib/launcher/solana/README.md` and `curve/geometry.ts`. **Newly carrying it:
>   `docs/YEAR_PLAN_2026_2027.md`** — so the claim spread into the planning doc while it was being
>   cleaned out of the code. Current: `docs/YEAR_PLAN_2026_2027.md`,
>   `frontend/scripts/tegridy-launch-operator.mjs`, `curve/index.ts`, `curve/ix.ts`,
>   `curve/program.ts`.
> - ✅ **The "Last reviewed" stamps are 3, not 5** — `pages/ContractsPage.tsx:501`,
>   `pages/FAQPage.tsx:259`, `pages/SecurityPage.tsx:368`. Two were cleared.
> - 🔴 **`security.txt` confirmed, with the mechanism.** `memetic.fun` appears **zero times** in
>   `frontend/public/.well-known/security.txt`. Its `Canonical:` and its entire in-scope list name
>   only `tegridyfarms.vercel.app`. Served from the canonical domain, the file declares a Canonical
>   URI that is not the one being read and a scope that excludes the host serving it — under
>   RFC 9116 a scanner may reject it, and a researcher may reasonably read the canonical domain as
>   out of scope. → **Next step:** add the second domain to `Canonical:` (the field is repeatable)
>   and to the in-scope list. Cheap, and it is the file that tells someone how to report a drain.
> - **Not re-verified:** the README native-pool figures.

**Repo hygiene (15).** Close #278 · decide #280, #282, #265, #205 · merge eight clean Dependabot
PRs and hold #296 · reclaim **27 GB** (`.git/worktrees` holds a duplicate submodule clone per
worktree, 116 times over) · prune 116 worktrees with `git worktree remove` only, 93 are dirty ·
delete the 119 fully-merged local branches of 316 · resolve 12 stashes, nine of them on `main`
which is not the trunk · narrow yesterday's `*.mp4` ignore before it swallows real video assets.

> **Re-measured in the primary checkout 2026-08-21 — every number moved, and all but one moved
> the wrong way.** This lane is not static debt; it accrues on its own with each session.
>
> | | 08-15 | 08-21 | |
> |---|---|---|---|
> | worktrees | 116 | **124** | +8 — each carries a duplicate submodule clone, so the 27 GB reclaim is now larger |
> | local branches | 316 | **325** | +9 |
> | fully-merged, safe to delete | 119 | **122** | +3 |
> | stashes | 12 | **12** | unchanged — nobody has touched these |
>
> ✅ **One item here IS closed: "commit six untracked broadcast receipts."** `contracts/broadcast`
> now tracks **63 files**, committed 2026-08-18 in `15ef4263` ("commit the deploy receipts for the
> relaunch and gated batches"). The primary checkout reports **0 untracked files** — so the
> "untracked receipts" framing is dead and should not be re-raised.
>
> **Next step, in this order, because two of them are destructive and one is not:**
> 1. **Delete the 122 fully-merged branches first** — safest, reversible via reflog, and it shrinks
>    what step 2 has to reason about: `git branch --merged origin/mvp-launch` is the exact list.
>    ⚠️ Verify against `origin/mvp-launch`, **not** `main` — [[reference_main_vs_mvplaunch_divergence]].
> 2. **Then the 124 worktrees, with `git worktree remove` ONLY** — never `rm -rf`, which strands the
>    `.git/worktrees` metadata and leaves the reclaim unrealised. Many are dirty; `git worktree list`
>    plus a per-tree `git status --porcelain` tells you which hold real work before anything is lost.
> 3. **The 12 stashes last, and read them before dropping.** Nine sit on `main`, which is not the
>    trunk, so their content may be the only copy of work that never landed —
>    [[reference_shared_checkout_hazard]].

**CI and tests (11).** The coverage ratchet (see the clock above) · the money-path E2E job is red
because the suite is **order-dependent**, not unseeded — seeding already landed and did not fix
it · teach the daily chain gate to read ProgramData instead of the stub · commit six untracked
broadcast receipts · triage 18 Slither detector classes now that the curated config actually
loads, `reentrancy-eth` among them · run the 9 echidna/halmos properties that execute in zero
pipelines today.

> **Updated 2026-08-21 — one closed, one class of gap closed with it, and one new blocker that
> is currently blacking out most of this lane.**
>
> **Closed: the ghost-test report.** `frontend/src/test/vitestCollection.test.ts` was reported
> failing with two orphans (`contracts/monitoring/lib/arbLinkage.test.mjs`,
> `scripts/monitoring/lib/pausePlan.test.mjs`). It was not failing — `762e421f` had already
> accounted for both on 08-19. Re-verified independently rather than trusted: **534 tracked
> test files, 0 orphans**, and both files pass **48/48** under `node --test`.
>
> **Closed: a gap that fix left behind, worth generalising.** Its only runner was
> `arb-linkage-monitor.yml`, whose trigger block is `schedule` + `workflow_dispatch` — nothing
> in it fires on a pull request. That satisfies "has a runner" while the PR that breaks the rule
> still merges green, and GitHub disables schedules in a repository idle for 60 days, at which
> point the coverage lapses with nothing going red. `6179cd4d` puts both files on the PR gate in
> `ci.yml` and rewrites the guard to require each to be named by a workflow that actually fires
> on `pull_request`; both branches of the new assertion are mutation-checked.
> **⚠️ The class generalises: every "it runs in workflow X" claim in this document is only as
> strong as X's trigger block, and nothing audits that.** `arb-linkage-monitor.yml` was the one
> that got caught; the other scheduled workflows have not been checked the same way.
>
> **🔴 NEW BLOCKER — `npx tsc -b --noEmit` is RED with 13 errors, and it is skipping the rest of
> the job.** In `ci.yml` the `lint-typecheck-test` job runs Lint → **Type Check** → Unit Tests →
> Solana indexer → Address registry → the four `--self-test` steps → the new arb-linkage step.
> **None of them carry `if: always()`**, so a red Type Check skips every step after it. Most of
> what this lane thinks is covered is not currently executing on any PR. Confirmed pre-existing:
> identical 13 errors with all 08-21 changes stashed, none in any file touched that day.
>
> The 13, by file:
> - `frontend/src/components/shield/ShieldPositionCard.tsx:53,68` — `TS7053` implicit-any index
>   plus `TS2339` `Property 'band' does not exist`, twice. From the 08-19 shield slice
>   (`50119149`); the type and the component disagree about whether a band exists.
> - `frontend/src/hooks/useAirdropCampaign.ts:91` — `TS2322`, a wagmi `useReadContracts`
>   contracts array inferred as the empty tuple `readonly []`. It cascades: `:114` yields four
>   errors reading `.status`/`.result` off `never`.
> - `frontend/src/hooks/useAirdropCampaign.ts:139` — `TS2345`, the `claimWithFee` variant carries
>   `value: bigint` where the inferred parameter wants `value: undefined`; the ABI union has been
>   narrowed to the non-payable `claim` overload.
> - `frontend/src/hooks/useTerminalSafety.ts:141,147` — `TS2345`, `string | undefined` passed
>   where `string` is required. From the 08-19 terminal slice (`2c67d86e`).
> - `frontend/src/pages/LaunchPage.tsx:325` — `TS18047`, `'pricingRead' is possibly 'null'`.
>
> **⚠️ Do not "fix" this by dropping `-b`.** `frontend/tsconfig.json` is a solution file with an
> empty `files` and no `include`; plain `tsc --noEmit` follows no references, checks **zero
> files** in ~0.4s and reports green over nothing. That was the bug `ci.yml:43-54` was written to
> close — reintroducing it would hide these 13 rather than fix them. The `useAirdropCampaign`
> errors sit on a money path (`claim` / `claimWithFee`), so correct the types to match what the
> contract actually accepts rather than casting the mismatch away.

**Frontend (11).** Three answers to "does the Solana program exist" across five modules · LP
boost never refreshes for a user who buys a JBAC after staking, and the changelog says it does ·
R080 zod schemas written, tested, applied at zero call sites · two EIP-5792 hooks complete and
mounted nowhere · Playwright has no iPhone and no iPad against a standing three-device
requirement · a11y smoke covers 2 of 43 routes.

> **Re-verified against the tree 2026-08-21 — four of the five named above are CLOSED, and the
> fifth is narrower than written.** Each checked at file:line, not inferred. Do not re-open these.
>
> - ✅ **Playwright iPhone + iPad — DONE.** `frontend/playwright.config.ts:87-88` declares
>   `iphone-safari` (iPhone 15) and `ipad-safari` (iPad gen 7), both carrying
>   `grepInvert: WEBKIT_GREP_INVERT`. The three-device requirement in [[project_responsive]] is met
>   at the config level. *Not* proven: that the suite is green on those two projects.
> - ✅ **a11y "2 of 43 routes" — DONE, and guarded against regression**, which is the better half.
>   `e2e/a11y-routes.spec.ts` sweeps every routed page from `e2e/fixtures/routes.ts` (**55
>   entries**), and `src/test/a11yRouteCoverage.test.ts` re-derives that list from `src/App.tsx`
>   and fails when the two disagree — so a new route now arrives with coverage attached instead of
>   arriving silently. The assertion is **equality**, not "no new violations": a route that stops
>   violating a rule also fails until its id is deleted, deliberately, so the debt list stays
>   pruned. ⚠️ **Scope limit, stated in the fixture header and worth keeping honest: the rule set
>   is markup-level. Nothing checks colour contrast, target size or focus visibility. Green here
>   says the semantics are sound; it does NOT say the app is WCAG AA.**
> - ✅ **EIP-5792 "mounted nowhere" — DONE, and it was three hooks, not two.** `src/lib/eip5792.ts`
>   is imported by `useOneClickLaunchBuy` → `components/launcher/LaunchBuyPanel.tsx`,
>   `useOneClickStake` → `pages/FarmPage.tsx`, and `useZapRun` → `components/zap/ZapPanel.tsx`.
>   All three reach a rendered component.
> - ✅ **LP boost refresh — DONE.** `src/hooks/useAutoRefreshBoost.ts` exists with a companion
>   test and is wired into `useLPFarming.ts`, `pages/DashboardPage.tsx` and `pages/FarmPage.tsx`.
>   The changelog claim it was accused of overstating is now true.
> - ⚠️ **R080 zod schemas — STILL OPEN, but it is 1-of-3 applied, not 0.** `src/lib/schemas/` holds
>   three modules. **`geckoTerminal.ts` IS applied** (`hooks/usePriceHistory.ts`,
>   `hooks/useToweliPrice.ts`). **`aggregator.ts` and `opensea.ts` remain at ZERO call sites.**
>   → **Next step:** find the fetch/parse sites those two were written for — the aggregator quote
>   path and the OpenSea listing path — and apply them there. A schema module with no call site is
>   a test that validates a fixture, so treat "the schema's own test passes" as no evidence.
>
> **Not re-checked, still carried from 08-15:** the three contradictory answers to "does the
> Solana program exist" across five modules.

**Contracts (6), backend (6), env docs (7), Solana docs (8), security docs (5), external
prep (5).** Registry gaps, the `additionalContracts` blind spot, TegridyRestaking still 2,208
bytes over EIP-170 on this branch, `canUpdate()` returning true while `update()` reverts, and
the doc corrections that must precede every TIER 5 send.

> **Contracts lane re-verified 2026-08-21. One is dead, two are confirmed real with the exact
> mechanism, and a CI comment has drifted from the thing it describes.**
>
> - ❌ **DEAD — "TegridyRestaking still 2,208 bytes over EIP-170."** Landed 2026-08-19 in
>   `c749c933`: the admin-sister split puts the host at **22,114 B, 2,462 B UNDER**. Do not
>   re-open, and do not chase the 36-selector diff the repo used to point at — its own artifact
>   measured **24,743 B, 167 B OVER**. See correction 6 above.
> - 🔴 **CONFIRMED — `canUpdate()` returns true while `update()` reverts, three separate ways.**
>   `TegridyTWAP.sol:1110`'s `canUpdate()` evaluates **only the time condition** (`count == 0`, or
>   wrap-safe `elapsed >= MIN_UPDATE_INTERVAL`). `update()` at `:489` reverts *before* ever
>   reaching that check on `UnknownPair` (`!factory.isPair(pair)`) and `PairDisabled`
>   (`factory.disabledPairs(pair)`), then later on `InsufficientFee` when
>   `msg.value < effectiveFee` — and `effectiveFee` falls back to `MIN_UPDATE_FEE` whenever
>   `updateFeeConfigured` is false, so a caller sending 0 with no fee configured still reverts.
>   **Any keeper, script or UI gating on `canUpdate() == true` will burn gas on a revert.**
>   → **Next step:** decide which contract the name is making. Either widen `canUpdate()` to
>   evaluate all four preconditions and return the fee it requires, or rename it to something
>   that cannot be read as "this call will succeed" (`isPeriodElapsed`). Widening is the better
>   fix — the callers that exist want the question the name asks. Do not just document it.
> - 🔴 **CONFIRMED — the `additionalContracts` blind spot is real and unhandled.** Zero matches
>   for `additionalContracts` across `scripts/`, `frontend/scripts/` and `.github/`. Any contract
>   a Forge script deploys via CREATE from inside another contract lands in that array of the
>   broadcast JSON and is invisible to the registry verifier, which only reads top-level
>   `transactions[].contractAddress`.
>   → **Next step:** teach `frontend/scripts/verify-addresses.mjs` to walk
>   `transactions[].additionalContracts[]` too, then re-run it — expect it to surface addresses
>   nobody has classified. ⚠️ Land that **separately** from flipping registry check 6; the doc's
>   own hazard table warns that combining them turns CI red against 36 unclassified addresses.
> - ⚠️ **A CI comment has drifted, but the gate itself is sound — I got this wrong first time and
>   the correction matters.** `contracts-ci.yml:117` records `TegridyStaking — 24,337 B (measured
>   2026-07-24): 239 B under EIP-170`; the 08-21 re-measure puts it at **24,554 B, 22 B of
>   headroom**. The stale number reads as reassurance and should be refreshed.
>   **What is NOT true — and I asserted it here before checking the control flow — is that the
>   last 22 bytes would be spent by a PR that goes green.** The size step tests EIP-170 in its
>   **first** branch (`:141`), and `FLOOR_EXCEPTIONS` is consulted only in the `elif` for
>   over-floor-but-under-limit (`:149`). TegridyStaking sits in `FLOOR_EXCEPTIONS`, **not** in
>   `OVER_EIP170_DEFERRED` — so the moment it crosses 24,576 it falls into the hard branch, emits
>   `::error`, sets `FAIL=1` and the job **exits 1**. The two-tier split exists precisely so the
>   floor allowlist cannot soften the hard limit, and that was separately confirmed by execution:
>   a `FLOOR_EXCEPTIONS` member at 24,577 B run through the real step errors out.
>   **So: a crossing is a RED RUN, not a silently undeployable artifact.** The `::warning` at
>   `:151` applies only to the 24,000-byte *floor*, which is a soft budget by design.
>   → **Next step is therefore just the comment**, not the gate. Refresh `:117` to the measured
>   24,554 B so nobody reads 239 B of headroom that does not exist.
>
> **Not re-verified:** backend, env docs, Solana docs, security docs, external prep.

---

# What the sweep itself missed

A completeness critic went looking for what fell between the twelve lanes. Eight findings, all
verified, none of which any lane owned:

1. **Our own CSP blocks the Irys upload rail.** `vercel.json:22` allowlists ~40 hosts in
   `connect-src`; `uploader.irys.xyz` is not one of them, and neither is `arweave.net`. The
   LaunchpadV2 collection-creation flow — the exact flow behind "create the Pro Pass" — is
   **browser-blocked in production before it can reach a wallet prompt.** Nobody had swept
   "does the shipped CSP permit the network calls the shipped code makes."
2. **40 npm advisories** — 10 high, 12 moderate, 18 low — including a `bigint-buffer` overflow
   via `@solana/spl-token`, in a transaction-signing app. **There is no advisory gate in any
   workflow.** Dependabot version drift is a different thing entirely.
3. **The Solidity supply chain cannot be updated at all.** `openzeppelin-contracts` (833 tracked
   files), `forge-std` and `uniswap-hooks` are **vendored as tracked copies, not submodules**,
   and there is no `gitsubmodule` entry in `dependabot.yml`. Neither the vendored three nor the
   pinned four can ever receive a security bump.
4. **The migration set cannot rebuild the database.** It creates 7 tables and never creates
   `messages`, `user_profiles`, `user_favorites`, `user_watchlist` or `votes` — all five live.
   No base schema, no restore script. *(The backup workflow itself is fine — green on 08-10,
   08-03, 07-30, 07-27. Do not re-open it.)*
5. **Load-bearing modules with zero tests** — `TegridyNativeBuyRouter` (270 lines, zero test
   references, **absent from all 211 items**), `VotePowerOracle` (the anti-flash-loan primitive
   for both governance surfaces), `notifyBirth.ts` (decides whether a launch is announced at
   all, every branch a silent refusal), `_lib/heat.js`, `_lib/launch-radar.js`.
6. **No release identity.** `release.yml` triggers on `v*.*.*`; there are 3 tags, none semver,
   and the workflow has **never run**. Nothing anywhere marks which commit is production — which
   is exactly the recurring "merged ≠ live" pain.
7. **The PWA manifest is wrong-brand** — still `"Tegridy Farms"`, `"Art-first yield farming on
   Ethereum"` — on a project that spent 20 items this sweep on honesty debt.
   > **Half-closed 2026-08-19.** The *description* was the factually wrong half — the app is
   > not single-chain and not farming-only — and both `public/manifest.json` and
   > `public/manifest.webmanifest` now carry the same wording `index.html` already ships to
   > crawlers. The *name* is a branding decision and is left alone: "Tegridy Farms" is still
   > what `<title>`, the OG tags and the JSON-LD say, while the canonical domain is
   > memetic.fun, so changing one file would have made the install name disagree with the
   > tab title instead of agreeing with it. Flagged for the operator in
   > `docs/OPERATOR_NEXT.md`; both manifest files must move together, because
   > `index.html` links the `.webmanifest` and the e2e suite fetches the `.json`.
8. **`frontend/src/nakamigos/` is the largest unswept surface** — 177 files, 52,530 LOC, ~26% of
   `frontend/src`, a live marketplace handling **signed Seaport orders**, and it appears in the
   211 items exactly once. Named as unswept, not as buggy — nobody looked.

> ## Re-verified 2026-08-21 — three closed, three confirmed, one worse, one unreachable
>
> These eight were the completeness critic's findings, so they had never been re-read. Checked at
> file:line except where noted.
>
> 1. ✅ **CLOSED — the CSP does NOT block the Irys rail.** `frontend/vercel.json`'s `connect-src`
>    now ends with `https://uploader.irys.xyz https://arweave.net`. And the reason this is safe to
>    call closed rather than half-closed: **`index.html` ships no CSP at all** (zero matches for
>    `Content-Security-Policy`), so there is no second policy to intersect with. Two CSPs both
>    apply and the browser enforces the *intersection*, which is how this class of fix usually
>    fails — not the case here. LaunchpadV2 collection creation is unblocked.
> 2. ⚠️ **HALF CLOSED — the gate exists, the debt does not move.** `.github/workflows/npm-advisories.yml`
>    now exists and fires on `push`, `pull_request`, `schedule` and dispatch, so "no advisory gate
>    in any workflow" is dead. **The advisories are unchanged: `npm audit` reports 40 — 0 critical,
>    10 high, 12 moderate, 18 low**, exactly the 08-15 figures. A gate that has been green over 40
>    advisories for six days is either not failing on them or nobody is reading it.
>    → **Next step:** read what severity that workflow actually fails at before trusting it. The
>    bigint-buffer overflow via `@solana/spl-token` is a **high in a signing app** — triage that
>    one by hand regardless of what the gate says.
> 3. 🔴 **CONFIRMED — the three big vendored trees still cannot be bumped.** `.gitmodules` declares
>    only `v4-core`, `v4-periphery`, `solmate`, `solady`. **`openzeppelin-contracts` (833 tracked
>    files), `forge-std` (68) and `uniswap-hooks` (60) are tracked file copies with no submodule
>    entry** — `git submodule update --remote` cannot reach them, so they are frozen at whatever
>    was pasted in. OZ is the one that matters: it is the security-critical dependency.
> 4. ⏸️ **Not re-verifiable from the repo** — "migrations create 7 tables and never create 5 that
>    are live" needs a read against the live DB. Carried forward unchanged; the applied-state
>    ledger is the authority, not the migration files.
> 5. 🔴 **CONFIRMED — `TegridyNativeBuyRouter` still has zero tests.** `git ls-files | grep -i
>    nativebuy` returns exactly one path: `contracts/src/TegridyNativeBuyRouter.sol`. It remains
>    absent from all 211 items, which is how it stayed invisible.
> 6. 🔴 **CONFIRMED, with the mechanism — `release.yml` has never run and cannot have.** It
>    triggers on `push: tags: - "v*.*.*"`. The three tags in the repo are `audit-pass-6`,
>    `audit-remediation` and `backup/crazy-nobel-pre-rebase` — **none match the glob**. So nothing
>    marks which commit is production, and adding the workflow did not change that.
>    → **Next step:** this is one `git tag v0.1.0 && git push --tags` away from being real, but do
>    not fire it before deciding what a release *means* here, since prod deploys via Vercel on two
>    separate paths and a tag would claim to mark something it does not control.
> 7. ✅ Half-closed 2026-08-19 — see the PWA note under item 7 above.
> 8. 🔴 **CORRECTED, and it is worse than the finding said — `frontend/src/nakamigos/` is NOT
>    unswept. It was swept on 2026-08-02 and the findings were never fixed.** A 133-agent pass
>    over 30 surfaces returned **91 findings that survived adversarial verification: 9 high, 38
>    medium, 42 low**, verdicts 22 material-issues / 5 minor / **3 clean**. Exactly **one** is
>    fixed (#224, the Seaport cancel money path). The 08-15 completeness critic called this
>    surface unswept because it appears in the 211 items once — but the sweep predates the critic
>    by two weeks, so "nobody looked" was wrong in both directions: someone did look, and what
>    they found is still sitting there. The tree also grew 177 → **191 tracked files** since 08-15.
>
>    **I re-verified the worst one at file:line today.** `frontend/src/nakamigos/lib/portfolio.js:145`
>    catches a failed Alchemy `getNFTSales` call and, because the only reporting is
>    `if (import.meta.env.DEV) console.warn(...)`, **logs nothing whatsoever in production** while
>    leaving `allSales = []`. Zero buy-sales means zero cost basis, which means **the entire
>    portfolio renders as pure profit**. It is a silent wrong-number bug on a surface users make
>    money decisions from, and it fails in the direction that flatters.
>
>    The other named highs, from the 08-02 record and NOT re-verified today:
>    `api.js:780` (a total listings outage renders as a success-styled "No active listings right
>    now") · `components/MarketIntegrity.jsx:203` ("in the last 30 days" can silently be the
>    collection's entire history) · `components/RaritySniper.jsx:505/286` (ranks computed over a
>    40-token page; listings for unloaded tokens dropped) · `components/NftCompare.jsx:248`
>    (SEND TRADE is a dead control — target owner always null).
>    ⚠️ **Re-check RaritySniper before acting** — the 08-02 record flags it as possibly overstated
>    because a `~` disclosure marker already exists.
>
>    → **Next step:** these are ~1 PR each and they are independent. Take `portfolio.js` first:
>    it is verified, it is the one that misstates money, and the fix is to surface the failure
>    rather than return a confident zero.

---

# Killed — do not chase

Nine items died in verification, and four more were demoted by the synthesis. Recorded so they
do not come back: the certification endpoint ask (already covered) · sweeping PremiumAccess
revenue · re-deciding the Heat gate threshold · running Certora (free Halmos equivalents exist) ·
`TegridyNativeBuyRouter`'s fate as an *operator* decision · a secrets sweep (clean, tracked tree
and history) · the untracked-file triage (done in `36b48425`) · gating the Jupiter claim in the
meta tags · a wave-three doc command that does not actually 405.

Plus, from the cross-lane disagreements: the `/solana` un-gate (already live), the premium
discount (nobody misled), the staking `getReward()` revert (it pays partial instead), the
analytics re-queue burn (a 503 response does not re-queue; only a fetch throw does), and the
claim that `registry-onchain` fails quietly (it fails **loudly**, and has for three days, with a
substantive finding).
