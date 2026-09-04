# BAYLA Staking: Rail Decision

**Date:** 2026-09-02 · **Subject:** reproducing TOWELI's staking economics for a Token-2022 mint · **Status:** decision-ready

---

## 1. The answer

**Stay on Streamflow. Do not migrate rails, and do not create a new stake pool. Attach a *dynamic* reward pool (`RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez`) to the stake pool you already run, and turn off the classic one.**

The rail is not the problem. `STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH` is the only program on Solana proven to custody a Token-2022 stake — not by reading account constraints, but by holding 2,022,682.761887 BAYLA in `5Wh91ioKW7EVPkHcPam79yuA8x2fArkaVKVv51Cq5ZS6`, a Token-2022 account whose authority is your pool PDA. It already gives you the linear duration ladder, multiple positions per holder, and a pool authority that can neither release nor trap principal (there is no `update_pool` instruction on the stake program at all — configuration is immutable after creation, which cuts both ways in your favour).

What *is* the problem is the **reward program you are attached to**. The classic pool (`RWRDdfRbi…`) pays a rate *per effective stake unit* — `reward_amount` is documented in the IDL as "distributed per effective stake," and the SDK's accrual function multiplies by the user's own weighted balance with no division by total stake anywhere. Your cost scales linearly and without bound as the pool grows. Success is the failure mode. Streamflow ships a second reward program that does not have that field at all, and it is the fix.

This is not a migration. It is a second reward pool on an existing stake pool, and the eight people currently staked are not touched.

**One TOWELI property is unobtainable and you should stop looking for it: the 25% any-time penalized exit.** Nine research lenses plus an adversarial refutation pass have now established something stronger than "Token-2022 blocks it" — the intersection of {penalized early exit} and {linear duration→weight ladder} is empty across *every deployed Solana staking program, at any token standard*. Kamino kfarms was believed to sit in that cell for two rounds of this survey. It does not (see §6). TOWELI's combination has never existed on Solana for anyone. You are not being denied something your peers have.

---

## 2. What changed since the last survey

**The Token-2022 filter did most of the killing, and it killed more than expected.**

Eliminated outright because their stake path cannot accept a Token-2022 mint — verified this pass at source or by counting occurrences of the Token-2022 program id in the deployed binary (a program that never embeds that pubkey cannot constrain to it or CPI into it):

| Program | Evidence |
|---|---|
| Kamino kfarms | `handler_stake.rs:2` `use anchor_spl::token::…`, `:97` `Program<'info, Token>` — **and** `handler_initialize_farm.rs` is legacy too, so a Token-2022 farm cannot even be *created*. Five instructions, not one line. |
| Raydium Farm v6 / Staking v5 | `FarmqiPv…` and `EhhTKczW…`: **zero** Token-2022 references in either binary. Never tested by the prior survey. Now closed. |
| Meteora Stake2Earn (M3M3) | Zero T2022 refs; requires a DAMM v1 pool, and DAMM v1 also has zero. 3,311 of 3,311 live stake mints are legacy. |
| Meteora Farming v1 | `lib.rs:761` `Program<'info, Token>`. Repo archived 2026-08-27. |
| Jupiter locked_voter | Zero T2022 refs; 13 of 13 live Lockers are legacy. No reward subsystem at all. |
| Quarry, Jito, VSR, Nosana, Helium VSR, Wormhole MultiGov, Cardinal | Zero T2022 refs each. |
| Smithii (`stsJYTwx…`) | Program id **found this pass** (the prior survey gave up on it). 503 pools, ~8,750 user accounts, live traffic. Zero T2022 refs. Their *token creator* supports Token-2022; their *staking program* does not. |

**Genuinely new and material:**

1. **Streamflow ships three reward programs, not one.** The prior survey evaluated only the classic pool and concluded Streamflow's emissions were fatally flawed. The dynamic pool (`RWRDyfZa…`) has no `reward_amount` and no `reward_period` field; `create_pool` takes no rate argument; `update_pool` can only change `claim_period` and `permissionless`. There is no rate for you to set.
2. **The exact configuration you want is already running.** Stake pool `Fgwemm7VcQoeRqiNHZGEqmkUKe4WfD3axYse1P86nxeQ`: Token-2022 pump.fun mint, linear ladder 1.0x→**13.0x** over **7 days**→180 days, with a funded dynamic reward pool attached. Token-2022 stake + ladder + fixed-budget emissions, simultaneously, today, on third-party code.
3. **Coverage:** 117 live dynamic reward pools, 102 funded, 77 of them sitting on Token-2022 stake pools. 20 of 43 distinct stake mints are Token-2022. Three live fund-delegates pay **USDC** on a 7d/30d schedule — real projects already using this as a fee pass-through.
4. **kfarms is not the twin everyone thought.** Its penalty *decays*: `penalty_bps × time_remaining / total_duration`, i.e. 25% only at the instant of staking, zero at maturity. And it has **no boost ladder at all** — a recursive grep for `weight|multiplier|boost|effective_stake` returns nothing; `UserState` stores only raw `active_stake_scaled`; the lock is farm-wide, not per-position. **Drop the "ask Kamino to change one line" follow-up.** Even if they did, kfarms would score no better than Streamflow-dynamic, on a program you don't already run.
5. **vetoken's blocker was a false alarm** (see table). Its upgrade authority `FcfYR3GN…` is not a bare wallet — it is a **Squads v4 vault PDA, 2-of-6** (derivation confirmed, multisig `JCyWkWDd…`). It still doesn't win, but the "one key from theft" claim is dead.
6. **A false negative in the prior survey's own notes:** the pool decoded as having "no ladder at all" was `4WCpdeQ2…`, the 1,000-BAYLA test pool. Your production pool `EFWpSpH9…` runs **1.0x → 5.0x over 1 day → 365 days**. You already have a linear ladder. That materially weakens the case for a new pool.

**Evidence-quality corrections carried forward from the refutation pass**, so you don't act on numbers that don't hold: the dynamic program has **117** reward pools, not 2,056 (the higher figure counted entries as pools by byte-size); the "invariant holds on all 117" claim fails on 2 pools, both with zero stakers and the funds sitting untouched in the vault (which resolves an open question favourably — a fund landing at zero effective stake is **deferred, not lost**); and the flagship "Token-2022 delegate sweep" exhibit was actually a legacy-SPL mint. The Token-2022 conclusion survives on custody evidence and the 77-pool count, not on that transaction.

---

## 3. The table

| Candidate | T-2022 stake | Fixed emissions | Lock ladder | Per-user penalized exit | Battle-tested | Licence |
|---|---|---|---|---|---|---|
| **Streamflow stake_pool + DYNAMIC reward (recommended)** | **YES** — proven by custody | **Partial** — bounded & TVL-independent, but schedule is off-chain | **YES** — linear, proven exact to 6 dp | **NO** | Stake program 9 mo, 1,170 pools; dynamic program ~4 mo, 117 pools | Closed source; SDK GPL-3.0 |
| Streamflow stake_pool + CLASSIC reward (status quo) | YES | **NO** — rate per effective stake, unbounded in TVL | YES | NO | 9 mo, 1,076 pools | Closed source |
| Kamino kfarms | **NO** — legacy across farm creation + 5 ix | YES (true Synthetix) | **NO** — none exists | Partial — penalty *decays* to 0, farm-wide lock | Very high; verified build | NOASSERTION (custom) |
| me-foundation/vetoken | YES (source + live, 2 positions × 10 tokens) | NO — 2-of-2 cosigned arbitrary amount | YES — linear, cap 25x | NO | 73.7k lockups, but **not a verified build**, no audit found; T-2022 path unexercised at scale | Apache-2.0 |
| Raydium Farm v6 | **NO** — 0 refs in binary | YES (true Synthetix) | NO | NO | Very high | Not published |
| Meteora Stake2Earn (M3M3) | **NO** — 0 refs; needs DAMM v1 | Fee pass-through | NO — top-N leaderboard | NO — cooldown only | High, but "legacy product" | Program not published |
| Meteora Farming v1 | **NO** — `lib.rs:761` | YES (true Synthetix) | NO | NO — free withdraw | Archived 2026-08-27 | None declared |
| Jupiter locked_voter | **NO** — 0 refs, 13/13 legacy | No emissions at all | Voting weight only | NO | High | AGPL-3.0 upstream |
| StakePoint (`gLHaGJsZ…`) | YES (binary + custody, *unverified* from source) | NO — admin-set APY/APR | NO | NO — plus admin can pause **withdrawals** | **Redeployed 6.8 days ago**; closed source; solo founder | None |
| Smithii (`stsJYTwx…`) | **NO** — 0 refs | NO — operator rate | NO | NO — hard lock | Live at scale; closed source; single upgrade key | None |
| Quarry | **NO** — 0 refs | Mints rewards (BAYLA mint authority is None) | No | No; pause can trap principal | High | AGPL-3.0 |
| Armada / mithraiclabs | NO | NO — balance diff | Frozen weight | Global admin, not per-user | Abandoned Apr 2024 | BSL until 2027, licensor defunct |
| Wrapper: klend cToken → kfarms | Wrapper leg YES | (inherits kfarms) | (inherits: none) | (inherits: decaying) | klend very high | NOASSERTION |
| spl-token-wrap | YES at source | n/a | n/a | n/a | **Not deployed on any cluster** (3 audits, 0 production hours) | Apache-2.0 |
| solana-foundation/vault | YES | No emissions | Spec'd, not implemented | No | **Devnet only, self-declared unaudited** | MIT |

*Marked unverified:* StakePoint's stake path (closed source, inferred from binary + custody); Streamflow's Rust generally (closed source — all source-level claims rest on the shipped Anchor IDL, the SDK, and mainnet behaviour); vetoken's deployed bytes vs. its repo (`verify.osec.io` returns `is_verified: false`).

---

## 4. The recommendation in detail

### Native — no compromise, already yours

- **Token-2022 stake.** Nothing to configure. Working today.
- **Linear lock ladder.** `min_weight` is hardcoded 1.0x in all 1,170 live pools; your pool interpolates linearly to 5.0x at 365 days. Verified exact: implied weight at 7d/90d/365d matches the model to six decimals.
- **Multiple positions per holder.** `StakeEntry` PDA is seeded `["stake-entry", pool, authority, nonce:u32]`. Up to 2³² positions per wallet, each with its own frozen weight.
- **Principal safety.** The stake program has no `update_pool`. You cannot change the ladder, and you cannot release or freeze anyone's principal. The only privileged unstake path (`unstake_as_worker`) is pinned to a Streamflow key and hits the same lock check — proven by simulation, which forced the closed-source program to print `unstake/base.rs:220`.

### The change to make

**Attach a dynamic reward pool to `EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`.** You hold the authority (`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`) and the pool is `permissionless: false`, so only you can.

Sequence:

1. **Create the dynamic reward pool.** *Route caveat:* `@streamflow/staking` 13.4.0 cannot create one — `CreateRewardPoolArgs` carries `rewardAmount`/`rewardPeriod` with no way to select dynamic. It can fully *operate* one (`fundPool`, `claimRewards`, `createRewardEntry`, `closeRewardEntry` all accept `rewardPoolType: "fixed" | "dynamic"`). Create it through Streamflow's app, or with a direct Anchor call against the `reward_pool_dynamic.json` IDL that ships inside the SDK. This is integration work against a deployed audited program — it does not trip the no-custom-code rule, but it is off the paved path, so confirm the route with Streamflow first.
2. **Batch-create `RewardEntry` accounts for the 8 existing stakers.** `create_entry` takes payer as signer and authority as non-signer, so you can create them all and eat the rent. `staking-cli`'s `populate-reward-entries` does exactly this but is wired to `buildRewardProgram` (the classic program, `src/index.ts:497`) — repoint it at `buildRewardDynamicProgram`. One-line client change. Run `--dry-run` first. Note that `create_entry` snapshots `rewards_state` at creation, so late entries earn forward-only and cannot claim retroactively — correct behaviour, but it means nobody earns until their entry exists.
3. **Wind down the classic pool — carefully.** This is the one step with a real hazard. Accrual on the classic pool continues whether or not you fund it, and an underfunded vault throws `RewardPoolDrained` (6012), which currently **bricks withdrawal of principal** through your client (see §5). Options: set `reward_amount` to zero via `update_pool`, or keep the classic vault funded until every open entry closes. **Verify before acting:** classic `reward_pool` errors 6013 `UpdateTooSoon` / 6017 `UpdateNotPossible` suggest updates are rate-limited to once per stake-pool `max_duration` — on your pool that is 365 days, so you may get exactly one shot. Establish this before you touch it.
4. **Choose the funding rail.**

### The funding rail — and the best idea in this document

Two rails exist:

- **(a) `fund_pool(amount)`** — you or a cron send a fixed amount on a fixed cadence. No period restriction. A live pool is being funded every ~30 minutes right now. To reproduce TOWELI's 71,219/day you fund once daily, or 1,483.73 every 30 minutes for a curve indistinguishable from a continuous stream.
- **(b) `create_fund_delegate(start_ts, period, expiry_ts)` + `fund_as_delegate()`** — creates a PDA and its ATA; Streamflow's keeper sweeps 100% of whatever sits there into the reward vault once per period. `fund_as_delegate` takes **zero arguments**. It cannot pay out more than actually arrived, and pays nothing (without erroring) when nothing arrived. The enum variant is literally `RevShare`.

**Recommendation: run rail (b), denominated in SOL, funded from PumpSwap creator fees.**

The reward mint does not have to be the stake mint — of 117 live dynamic pools there are 43 distinct stake mints and 42 distinct reward mints, and three delegates pay USDC. BAYLA's PumpSwap creator-fee vault (`CYrpkD5yiPZ13F4S8yPQM7yRSfpVrvMkm2H3gVJXvLGk`) holds **29.16 WSOL uncollected right now**, and collection is fully permissionless (both `collect_creator_fee_v2` and `collect_coin_creator_fee` require zero signers).

This does three things at once:

- It is the shape the US review called materially safer — a pass-through of actually-collected fees, not treasury emissions. There is no rate for you to set (`create_pool` has no rate argument) and no `clawback` instruction on the dynamic program, so funds you send in cannot be pulled back. Both halves of the flagged exposure — *operator sets the rate*, *operator funds from treasury* — are structurally removed, not merely promised away.
- **It stops rewards diluting BAYLA entirely.** On a token with roughly $62k of pool depth, paying yield in the token you are trying to support is the mechanism by which staking programs destroy the thing they are advertising. Paying in SOL breaks that loop completely.
- It self-limits. If trading dries up, rewards go to zero and no one is left holding an unfunded promise.

**The honest gap:** creator fees land in a vault whose authority is a wallet, so getting SOL from the creator vault into the delegate ATA is an operator-run collect-and-forward step, not a trustless on-chain route. That is a keeper hop, not a design flaw — but do not describe it publicly as fully autonomous. Also check the *accrual rate* of those fees before you quote anyone an APR; 29.16 WSOL is an accumulated balance, not a run-rate.

You can run a SOL dynamic pool and a BAYLA dynamic pool simultaneously on the same stake pool (you already run two classic pools). Start with SOL/fees; add a small BAYLA-denominated pool later only if you decide you want the emissions.

### What you give up, and why it's right for this token

| TOWELI property | Outcome |
|---|---|
| Token-2022 stake | Fully native |
| Linear lock ladder | Fully native (1.0x→5.0x / 1d–365d today; 10:1 available only via a new pool — see §6) |
| Multiple positions per holder | Fully native |
| Fixed daily emission | **Compromise.** Bounded and TVL-independent — total payout can never exceed total funded, verified across 115 of 117 live pools — but the schedule is enforced by your cron, not by a contract invariant. A missed crank underpays silently. |
| 25% any-time penalized exit | **Given up entirely.** |

On the emissions compromise: the dynamic pool is structurally a balance-diff distributor, which is the family you ruled out with Armada. The Armada objection was that balance-diff gives you no predictable per-period emission. That objection does not survive here, because you control both the amount and the cadence with no minimum period on `fund_pool`, and because the lock defuses the obvious attack — a driveby staker front-running a daily drop is locked for at least a day at 1.0x against a 365-day staker's 5.0x. But call it what it is: **bounded and TVL-independent**, not "fixed emissions."

The single most important sentence in this section: **on a classic pool, the ladder multiplies your emission liability by up to the boost factor; on a dynamic pool the ladder is free, because it only redistributes a fixed pot.** TOWELI's ladder and Streamflow's classic reward pool are economically incompatible. If you had raised `max_weight` to 10x on the classic pool you would have doubled your liability for nothing.

---

## 5. The missing exit

### It genuinely does not exist

Proven this pass, not inferred:

- Zero occurrences of `penalt` anywhere in `stake_pool.json`. No penalty field, no penalty argument, no penalty error across all 27 error codes.
- Error 6013 `LockedStake` is thrown at `unstake/base.rs:220` in **every** path that moves principal — plain unstake, unstake with `should_close`, and Streamflow's own privileged `unstake_as_worker`. Confirmed by read-only mainnet simulation against your live locked entries.
- vetoken hard-gates on `unstake.rs:35` `lockup.end_ts <= ns.now()`. The dynamic reward program has no principal-touching instruction at all.
- kfarms has the primitive and rejects the mint — and its penalty decays and it has no ladder anyway.
- A corrected GitHub sweep (nine queries, MasterChef/non-Anchor vocabulary included) surfaced ~120 additional repos. All 0–2 stars, none deployed. One, `magicanscript/magican-spl-staking` (MIT), describes TOWELI's exact spec against `token_interface` — and has zero stars and no deployment. **The shape is trivial to write and nobody has earned production trust with it.** Given that your one custom staking contract just failed an audit on a critical that paid rewards out of other stakers' principal, read that as an argument against writing it, not for.

### Substitute the lock ceiling for the exit

The value of an escape hatch scales with lock length and approaches zero as the ceiling shortens. A 25% haircut is transformative against a four-year lock and marginal against a 30-day one. **Your lock ceiling *is* your exit policy** — and unlike a penalty, it costs nothing and needs no code.

Your current ceiling is 365 days. That is long for a ~$500k-cap token. If you ever open a new pool, 30–90 days is the credible ceiling, and at that ceiling the missing exit stops being a real complaint.

Note also what the missing feature buys you: with no early-exit path there is no penalty accounting, no partial-withdrawal arithmetic, and no code path where a reward computation can reach the stake vault. The reward vault is a PDA under `RWRDyfZa…`; the stake vault is a PDA under `STAKEvGqQ…`. Different programs, no cross-signing. **The class of bug your audit found is structurally unreachable here.** The missing feature and the missing bug are the same fact.

### Fix this now: wire `unstakeAndClose`

**This is a live defect in your client and it is the most urgent item in this document.**

`bungalowStaking.ts:646` wires only `unstakeAndClaim`. Your own devnet note at `bungalowStaking.ts:534-539` records that when accrued rewards exceed the reward vault, **both** `claim` and `unstakeAndClaim` revert with `RewardPoolDrained` (6012). Today, an underfunded reward vault blocks withdrawal of **principal** even after the lock has fully expired.

`unstakeAndClose` is the SDK's designed remedy and is not wired. It is *not* an early exit — `prepareUnstakeAndCloseInstructions` calls `prepareUnstakeInstructions({...data, shouldClose: true})`, emitting the identical `unstake` instruction; both variants fail with the same `Custom(6013)` at the same line on a locked entry. What it skips is the *claim* leg. Its own docstring: "REWARDS WON'T be claimed - use this call only if user can't unstake with rewards claims, i.e. when reward pool is drained."

Wire it as a clearly labelled fallback: **"Recover principal — forfeits unclaimed rewards."** (The forfeiture is inferred from `reward_pool` error 6010 `StakeEntryClosed` — "Stake Entry is closed, rewards are not claimable anymore" — combined with unstake setting `closed_ts`. Not simulated, because your pool currently has no unlocked entry to test against. Label it conservatively.)

This also becomes materially more important during the classic-pool wind-down in §4 step 3.

### Say it before the wallet connects

Holders arriving from TOWELI will assume a 25% exit exists, because on TOWELI it does. State plainly, above the stake button: *tokens cannot be withdrawn before the term ends, at any price.* This was fixed once before; make sure it survives any UI change.

---

## 6. What not to do

**Do not create a new stake pool to get 10:1 / 7d–4y.** `max_weight`, `min_duration` and `max_duration` have no update instruction, so "changing the ladder" means opening a second pool — and `migrate_entry` is hardcoded to two Streamflow STREAM pools, so there is no migration path. Your eight existing stakers are *locked* and cannot move. You would run two pools side by side for up to 365 days, splitting the reward budget and the UI. You already have a working 5:1 linear ladder. The emissions fix is worth an order of magnitude more than the ladder ratio, and it needs no new pool. If you ever do open one, do it for the *shorter* ceiling (30–90 days), not the longer one.

**Do not add `unstake_period` as an "exit compromise."** It is strictly additive: `request_unstake.rs:41` rejects a request filed during the lock, so total time to principal becomes `duration + unstake_period`. It makes stakers wait *longer*. Worse, the only configuration anyone actually ships in production sets `min_duration == max_duration`, which makes `calculateStakeWeight` short-circuit to a flat 1.0x — you would trade your entire ladder for a longer wait. Zero of the 471 live ladder pools set `unstake_period`.

**Do not set `freeze_stake_mint: false` to make positions tradeable.** It looks like a market-priced exit with the discount set by buyers rather than by you — the best regulatory shape anyone proposed. It doesn't work. `unstake` consumes the receipt from the staker's own PDA-derived ATA *and* requires the `StakeEntry` authority to sign, and `change_authority` is pool-level only with no per-entry transfer. A staker who sells their receipts forfeits their principal, and the buyer cannot exit either. `freeze_stake_mint: true` — what you already run — is correct.

**Do not ask Kamino to move `handler_stake.rs` to `token_interface`.** Even granted, kfarms has no boost ladder (grep for `weight|multiplier|boost|effective_stake` returns nothing), its lock is farm-wide rather than per-position, and its penalty decays linearly to zero rather than being a flat 25%. It would score no better than Streamflow-dynamic, on a program you don't run. And the legacy pin covers farm creation plus five instructions, not one line.

**Do not wrap BAYLA into a legacy-SPL representation.** No credible off-the-shelf wrapper exists: `spl-token-wrap` is audited three times and deployed nowhere (self-deploying means recompiling with a new `declare_id!` and shipping a binary no auditor signed); Solend's is abandoned, unlicensed, unaudited, has one wrapped mint in two years, and has a live upgrade key over escrowed funds. The only battle-tested Token-2022→legacy converter on Solana is a *lending protocol* — klend — and `check_reserve_emergency_mode` is called on the **redeem** path (`lending_checks.rs:281`), not just deposit, so the market owner holds a switch that freezes every staker's principal. Wrapping also splits BAYLA into two representations, adds a second program holding 100% of principal, and adds a second unwind step on exit — a staker facing a broken wrapper holds a receipt with no redemption path and no market, which is a 100% penalty, not 25%.

**Do not use StakePoint, Smithii, or vetoken.** StakePoint was redeployed **6.8 days ago**, is closed source with a solo founder, and its admin holds `withdraw_paused` — the exact principal-trap that disqualified Quarry, in code nobody can audit. Smithii is legacy-only regardless. vetoken is cleaner than the prior survey claimed (2-of-6 Squads, not a bare key) but is not a verified build, has no published audit, allows only **one position per wallet per namespace**, lets its council retroactively re-weight existing lockups, and its Token-2022 track record is two positions of 10 tokens; its reward module is a 2-of-2 cosigner-signed *arbitrary amount*, which is the worst possible regulatory shape — strictly worse than what you run today.

**Do not wait for the ecosystem.** The gap is not a Token-2022 gap. Three programs implement TOWELI's exact Synthetix emissions (Meteora Farming v1, Raydium Farm v6, kfarms) and all are legacy-only because they predate Token-2022 and have been deliberately frozen. Meteora's modern stack is thoroughly Token-2022-aware everywhere *except* staking. But even a fully ported ecosystem wouldn't give you TOWELI, because no Solana program at any token standard combines a penalized exit with a duration ladder. There is nothing to wait for.

---

## Verify before acting

1. **Confirm the dynamic-pool creation route** with Streamflow (SDK 13.4.0 cannot do it).
2. **Establish whether classic `reward_amount` can be set to zero now**, or whether the once-per-`max_duration` rate limit (errors 6013/6017) means you get one shot in 365 days. This gates step 3 of the rollout.
3. **Ask Streamflow for the OPCODES/FYEO audit report scoped to `reward_pool_dynamic` specifically.** Their audit page names no scope, no dates, and links no reports. The dynamic program is ~4 months old. Treat "audited" as an unverified vendor claim at this level until you see the document.
4. **Measure the PumpSwap creator-fee accrual rate**, not just the standing 29.16 WSOL balance, before quoting any APR.
5. **Test the zero-effective-stake funding edge case on devnet.** Two live mainnet pools are in that state with funds intact in the vault, which is consistent with deferral rather than loss — but the subsequent absorption once someone stakes has not been observed.

**Accepted residual risk, unchanged by this recommendation:** all Streamflow programs are upgradeable under a single authority (`5u7o2WGgHckh18opTfPsqKb8E3nhDKcReBrbzUeXg2n7`, an off-curve PDA consistent with a multisig, threshold unverified). You already live with this. Nothing here improves it, and nothing here makes it worse."
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Hunt"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Challenge"
    },
    {
      "type": "workflow_phase",
      "index": 3,
      "title": "Decide"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "hunt:streamflow-dynamic",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a7bd83e86616b6f3f",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174540,
      "queuedAt": 1788405173085,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "streamflow-dynamic — Streamflow Dynamic Reward Pool (RWRDyf…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788406365808,
      "tokens": 174302,
      "toolCalls": 57,
      "durationMs": 1191266,
      "resultPreview": "{"area":"streamflow-dynamic — Streamflow Dynamic Reward Pool (RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez) as the emissions engine for BAYLA staking, on the existing STAKEvGqQ… stake rail","candidates":"THE PROGRAM: `reward_pool_dynamic` v2.7.0, \"Reward pools with dynamic rewards distribution\", program id RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez. Deployed under BPFLoaderUpgradeable, programda…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "hunt:empirical-t22-staking",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "ae3c27f24ba851210",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174673,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "empirical-t22-staking — which staking programs are actually…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788407828835,
      "tokens": 227964,
      "toolCalls": 89,
      "durationMs": 2652961,
      "resultPreview": "{"area":"empirical-t22-staking — which staking programs are actually live on Solana mainnet TODAY custodying Token-2022 stake, verified by on-chain enumeration rather than documentation claims","candidates":"I ran a live mainnet census (RPC getProgramAccounts / getMultipleAccounts, Sept 2026) rather than trusting docs. Findings:\
\
=== LIVE AND STAKING TOKEN-2022 (only two exist) ===\
\
1. STREAMF…"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "hunt:t22-source-sweep",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a6923bb3e3d60371f",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174772,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "t22-source-sweep — GitHub / registry sweep for open-source …",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788406417849,
      "tokens": 164650,
      "toolCalls": 69,
      "durationMs": 1241974,
      "resultPreview": "{"area":"t22-source-sweep — GitHub / registry sweep for open-source Solana staking programs whose STAKE path accepts a Token-2022 mint (anchor_spl::token_interface / Interface<TokenInterface>) rather than anchor_spl::token / Program<Token>","candidates":"ONE genuinely new candidate found; everything else confirmed dead at source.\
\
=== 1. me-foundation/vetoken — THE ONLY NEW HIT (Magic Eden Found…"
    },
    {
      "type": "workflow_agent",
      "index": 4,
      "label": "hunt:jupiter-meteora-t22",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "ad5eb496a1f2be416",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174809,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "jupiter-meteora-t22 — Jupiter (JUP gov/locked_voter, Jupite…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788406743118,
      "tokens": 164460,
      "toolCalls": 103,
      "durationMs": 1567243,
      "resultPreview": "{"area":"jupiter-meteora-t22 — Jupiter (JUP gov/locked_voter, Jupiter Lock, ASR, dev surface) and Meteora (Stake2Earn/M3M3, Farming v1, Dynamic Fee Sharing, DAMM v2, DLMM) re-examined specifically for Token-2022 STAKE acceptance","candidates":"Nine surfaces examined. NONE passes the decisive test.\
\
1) JUPITER GOVERNANCE / locked_voter — voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj (on-chain Ancho…"
    },
    {
      "type": "workflow_agent",
      "index": 5,
      "label": "hunt:feeshare-t22",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a97e4265cae32c02b",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174893,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "feeshare-t22 — fee-share (pass-through of actually-collecte…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788405976260,
      "tokens": 133857,
      "toolCalls": 58,
      "durationMs": 800385,
      "resultPreview": "{"area":"feeshare-t22 — fee-share (pass-through of actually-collected fees) as the reward shape for a Token-2022 BAYLA stake","candidates":"Four candidates evaluated; the lens splits cleanly into a FEE-SOURCE layer (works) and a STAKING-DISTRIBUTION layer (does not exist).\
\
1) Meteora M3M3 / Stake2Earn — program FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP. DEAD, two independent proofs (below). …"
    },
    {
      "type": "workflow_agent",
      "index": 6,
      "label": "hunt:wrapper-path",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a716df855ebc77bf6",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174860,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Wrapper path — can BAYLA (Token-2022) be converted into a l…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788405806260,
      "tokens": 112316,
      "toolCalls": 50,
      "durationMs": 630385,
      "resultPreview": "{"area":"Wrapper path — can BAYLA (Token-2022) be converted into a legacy-SPL representation that battle-tested, legacy-only staking programs (kfarms et al.) will accept as a stake mint, using off-the-shelf code the operator does not have to write, fork, or deploy?","candidates":"Seven candidates surveyed. Only one is a real, deployed, battle-tested Token-2022 -> legacy-SPL converter, and it is no…"
    },
    {
      "type": "workflow_agent",
      "index": 7,
      "label": "hunt:toweli-shape-tradeoffs",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a6c08ebea3d74783a",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174769,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "TOWELI-shape trade-offs for BAYLA: ranking which of the fou…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788405973696,
      "tokens": 128232,
      "toolCalls": 44,
      "durationMs": 797821,
      "resultPreview": "{"area":"TOWELI-shape trade-offs for BAYLA: ranking which of the four properties (Token-2022 stake / fixed daily emissions / linear lock ladder / per-user penalized exit) to sacrifice","candidates":"The premise I was handed (\"assume no single program gives all four\") is correct, but the prior survey's COUNT is wrong, and that changes the whole ranking. It treated \"Streamflow\" as one thing. Str…"
    },
    {
      "type": "workflow_agent",
      "index": 8,
      "label": "hunt:streamflow-exit-recheck",
      "phaseIndex": 1,
      "phaseTitle": "Hunt",
      "agentId": "a9eff0c0cf3afb6a1",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788405174956,
      "queuedAt": 1788405173086,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Streamflow CLASSIC staking (stake_pool STAKEvGqQTtzJZH6BWDc…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788406094083,
      "tokens": 138406,
      "toolCalls": 43,
      "durationMs": 918207,
      "resultPreview": "{"area":"Streamflow CLASSIC staking (stake_pool STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH) — adversarial re-check of \"no early exit at any price\"","candidates":"Streamflow stake_pool v2.7.0 — the program the operator already runs the live BAYLA pool on. Four exit-shaped SDK entry points examined: unstake, unstakeAndClaim, unstakeAndClose, closeStakeEntry; plus two instructions the SDK does NOT…"
    },
    {
      "type": "workflow_agent",
      "index": 9,
      "label": "challenge:refute",
      "phaseIndex": 2,
      "phaseTitle": "Challenge",
      "agentId": "ad156e3dd50d9b2f6",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788407833808,
      "queuedAt": 1788407830524,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd "C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788409165645,
      "tokens": 205512,
      "toolCalls": 35,
      "durationMs": 1329397,
      "resultPreview": "Verification complete. Writing up.

**REFUTATION REPORT — independent verification, mainnet + source, 2026-09-02/03**

---

## A. CLAIMS THAT SURVIVE

**A1. Streamflow stake_pool accepts a Token-2022 stake — SURVIVES, and it is the only Token-2022 claim in the whole report proven by custody rather than inference.**
`getAccountInfo(5Wh91ioKW7EVPkHcPam79yuA8x2fArkaVKVv51Cq5ZS6)` returns `"program":"…"
    },
    {
      "type": "workflow_agent",
      "index": 10,
      "label": "challenge:gaps",
      "phaseIndex": 2,
      "phaseTitle": "Challenge",
      "agentId": "a107daf1e93d95dde",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788407832849,
      "queuedAt": 1788407830527,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd "C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo…",
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788409643603,
      "tokens": 239923,
      "toolCalls": 43,
      "durationMs": 1810752,
      "resultPreview": "Investigation complete. Returning findings.

```json
{
  "area": "completeness-critic — what the eight prior lenses missed, and investigation of the gaps: untested major protocols (Raydium), unfound program IDs (Smithii), mischaracterised candidates (kfarms), unexplored mechanisms (Streamflow's receipt mint), narrow search vocabulary, and the absence of any transaction-level census",

  "candidate…"
    },
    {
      "type": "workflow_agent",
      "index": 11,
      "label": "decide:recommendation",
      "phaseIndex": 3,
      "phaseTitle": "Decide",
      "agentId": "a30703fea2e611626",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788409647463,
      "queuedAt": 1788409645043,
      "attempt": 1,
      "promptPreview": "THE ASK. Reproduce TOWELI's staking for BAYLA. TOWELI is the operator's EVM
staking contract (TegridyStaking.sol) and its economics, read from the live
source, are:
  lock window        7 days .. 4 years
  boost              0.40x at 7d .. 4.00x at 4y, LINEAR interpolation
                     (only the RATIO matters economically - rewards are pro
                     rata over weighted stake - so…",
      "lastProgressAt": 1788409916057,
      "tokens": 171978,
      "toolCalls": 0,
      "durationMs": 268591,
      "resultPreview": "# BAYLA Staking: Rail Decision

**Date:** 2026-09-02 · **Subject:** reproducing TOWELI's staking economics for a Token-2022 mint · **Status:** decision-ready

---

## 1. The answer

**Stay on Streamflow. Do not migrate rails, and do not create a new stake pool. Attach a *dynamic* reward pool (`RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez`) to the stake pool you already run, and turn off the classic…"
    }
  ],
  "totalTokens": 1861600,
  "totalToolCalls
---

# LIVE STATE, read from mainnet 2026-09-02 — the pool is no longer empty

Earlier notes in this repo say the BAYLA pool has zero stakers and zero
funding. **That is stale.** Read directly from mainnet today:

| Fact | Value |
|---|---|
| Stake pool | `EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f` |
| Total staked | **2,022,682.76 BAYLA** across **8 stake entries** |
| Stake vault | `5Wh91ioKW7EVPkHcPam79yuA8x2fArkaVKVv51Cq5ZS6` (Token-2022) |
| Reward pool | `3ysyH5py46Q4XUXkumGy3DhWjPbNVhLMfQZmpQMdDruf` |
| Reward vault | **898,988.70 BAYLA — funded** |
| Ladder | 1 day .. 365 days, maxWeight **5.00x** (as configured) |

Open positions: 1,000,000 @365d · 557,727 @7d · 369,369 @90d · 79,462 @365d ·
10,000 @365d · 3,000 @365d · 3,000 @365d · 125 @365d.
**The 7-day position unlocks in ~6.6 days** — the first real exit attempt.

## The rate was re-based to a per-second schedule, and it is correct

`rewardAmount = 7` raw with `rewardPeriod = 1 second` (creation was `600000`
over `86400`). That decodes to ~7e-9 per staked token per *second*, which is
easy to misread as a near-zero rate. It is not:

    7 raw/s x 6.803e21 effective / 1e9 / 1e9 = 47,621 raw/s = 0.0476 BAYLA/s
    x 86,400 = ~4,114 BAYLA/day

The original `0.0006/staked/day` against the same stake would emit ~4,082/day.
So the schedule is intact — someone simply moved it to a per-second period.

## What that means for runway, and why the dynamic pool matters

At today's stake: **898,988 / 4,114 = ~218 days of runway.**

But this is the classic pool, so emission is a rate *per staked token* and the
daily burn scales with TVL. The runway is not a constant:

| Total staked | Daily emission | Runway on today's vault |
|---|---|---|
| 2.0M (today) | ~4,114 | ~218 days |
| 5M | ~10,200 | ~88 days |
| 10M | ~20,400 | ~44 days |

That is the unbounded-emission problem, now quantified with real money in it,
and it is exactly what attaching a dynamic reward pool fixes.

## Revised urgency on `unstakeAndClose`

The report calls this the most urgent item. With 8 real stakers and a 7-day
position maturing in under a week, that judgement stands and is sharper: the
vault is currently healthy (218 days), so exits should succeed today — but the
client offers only `unstakeAndClaim`, which reverts with `RewardPoolDrained`
whenever accrued exceeds the vault. Wiring `unstakeAndClose` removes the
scenario where a funding gap holds matured principal hostage. It is a
frontend-only change, needs no ceremony, no deploy of anything on-chain, and
no audit.
