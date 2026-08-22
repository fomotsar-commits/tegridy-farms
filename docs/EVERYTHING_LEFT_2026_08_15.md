# Everything left — 2026-08-15

Twelve lanes swept the repository, each one followed by an independent verifier instructed to
default to "already done" and kill anything it could not confirm. **220 candidate items → 211
survived verification → ~151 distinct after merging duplicates.** Nine were killed outright.

**79 need you. 87 need nobody but an agent. 38 are a build plus one gated step from you.
7 are waiting on someone else.**

Of the 211, **200 carry a verified citation** — a file read at a line, a command run, an
on-chain read, or a live HTTP response. 7 are derived, 4 are explicitly unverified and labelled.

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
| 2.7 | Factory `proposeFeeToSetter` → **24h** → `acceptFeeToSetter` (7-day window) | needs 0.2. ⛔ `acceptFeeToSetter` force-cancels `GUARDIAN_CHANGE`. **Corrected 2026-08-19: "do 2.8 first" does not work** — 2.7 destroys it. 2.8 must come strictly AFTER 2.7. |
| 2.8 | Factory `proposeGuardianChange` → **48h** → execute | needs 0.2 + 2.3 **+ 2.7**. Only the current `feeToSetter` may propose, so once 2.7 lands this is the ADMIN_SAFE's call, not the deployer's — and it cannot be pre-queued, because 2.7 force-cancels anything sitting in the slot. Target must have `codeLen ∉ {0, 23}` — a 7702-delegated EOA is rejected. Live `guardian()` is still the deployer EOA `0x14898258…456E`. |
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

**Repo hygiene (15).** Close #278 · decide #280, #282, #265, #205 · merge eight clean Dependabot
PRs and hold #296 · reclaim **27 GB** (`.git/worktrees` holds a duplicate submodule clone per
worktree, 116 times over) · prune 116 worktrees with `git worktree remove` only, 93 are dirty ·
delete the 119 fully-merged local branches of 316 · resolve 12 stashes, nine of them on `main`
which is not the trunk · narrow yesterday's `*.mp4` ignore before it swallows real video assets.

**CI and tests (11).** The coverage ratchet (see the clock above) · the money-path E2E job is red
because the suite is **order-dependent**, not unseeded — seeding already landed and did not fix
it · teach the daily chain gate to read ProgramData instead of the stub · commit six untracked
broadcast receipts · triage 18 Slither detector classes now that the curated config actually
loads, `reentrancy-eth` among them · run the 9 echidna/halmos properties that execute in zero
pipelines today.

**Frontend (11).** Three answers to "does the Solana program exist" across five modules · LP
boost never refreshes for a user who buys a JBAC after staking, and the changelog says it does ·
R080 zod schemas written, tested, applied at zero call sites · two EIP-5792 hooks complete and
mounted nowhere · Playwright has no iPhone and no iPad against a standing three-device
requirement · a11y smoke covers 2 of 43 routes.

**Contracts (6), backend (6), env docs (7), Solana docs (8), security docs (5), external
prep (5).** Registry gaps, the `additionalContracts` blind spot, TegridyRestaking still 2,208
bytes over EIP-170 on this branch, `canUpdate()` returning true while `update()` reverts, and
the doc corrections that must precede every TIER 5 send.

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

---

# Addendum 2026-08-20 — the multichain directive (Base 8453 + Robinhood Chain 4663)

The operator took the go/no-go: the app is to serve Base and Robinhood Chain, launchpads and
LP system included. Everything code-side landed on `claude/jolly-ritchie-0d4dda`
(`456cdf6f` contracts, `2443b584` frontend); what remains is the operator ceremony per chain.
Full context: [ROBINHOOD_L2_LEG.md](./ROBINHOOD_L2_LEG.md) + [BASE_L2_GO_NO_GO.md](./BASE_L2_GO_NO_GO.md).

| # | Operator step | Notes |
|---|---|---|
| M.1 | **4 disjoint Safes per chain** (TREASURY / MULTISIG / PAUSE_GUARDIAN / FEE_REMITTANCE), proven signers, nonce > 0 | Safe 1.3.0 + 1.4.1 factories verified present on 4663; Safe{Wallet} UI support there unverified — may need safe-cli. Precedes everything. |
| M.2 | `DeployBaseMVP` → accepts → `VerifyBaseMVP` green; same for `DeployRobinhoodMVP`/`VerifyRobinhoodMVP` | The 4663 leg deploys the **AttestedSequencerUptimeFeed** first (no Chainlink there) — its attestor duty (flip on outage) goes in INCIDENT_RESPONSE **before** go-live. |
| M.3 | `DeployBaseLaunchRail` / `DeployRobinhoodLaunchRail` (5 accepts each) | RugEscrow openings ship DISABLED — enabling is its own decision. 4663 rail needs the M.2 feed address as SEQUENCER_FEED. |
| M.4 | LP farming per chain — **blocked on an economics decision**: the reward token | `DeployBase/RobinhoodLPFarming` refuse to pick one. NullBoost = flat 1.0x, no veTOWELI off mainnet. Needs a pair to exist first. |
| M.5 | Frontend go-live per chain = ONE change-set | Fill the chain's zeroed `ChainConfig` slots from broadcast artifacts + (4663) set `sequencerUptimeFeed` to the deployed adapter — a registry test fails the build if the feed is forgotten while contracts are live. Register addresses in `frontend/scripts/addresses.json` per-chain. |
| M.6 | Vercel env on BOTH deploy paths + CSP already carries the new RPC hosts | `base.drpc.org`, `mainnet.base.org`, `rpc.mainnet.chain.robinhood.com` allowlisted in `connect-src` (script-src hash untouched). |
| M.7 | Doppler-on-Robinhood migration policy | 4663 has **no UniswapV4Migrator / no V1 locker** (V2 only) — the current launch policy cannot run there; choosing the replacement (UniswapV2MigratorSplit into our own factory pair fits the own-venue directive) is a product decision with its own verification pass. Doppler-on-Base has full parity and is only gated on per-chain fee sinks + the frontend address book. |
| M.8 | Monitoring legs per chain (revenue-watch reads the FEE_REMITTANCE balance, arb-linkage via its CHAIN_ID/RPC env seams) | The fee-rail-invisible-for-weeks incident repeats on Base day one otherwise. |
