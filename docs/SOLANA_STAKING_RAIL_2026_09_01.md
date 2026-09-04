# TOWELI on Solana — Rail Selection: Decision Document

**Prepared 2026-09-01. All on-chain figures read from `api.mainnet-beta.solana.com` around slot ~443,590,000 on 2026-09-01/02.**

---

## 1. The Answer

**Nothing off-the-shelf reproduces TOWELI.** No Solana program in existence gives you a fixed daily emission, a per-user penalized exit, *and* a lock-duration boost ladder on a codebase with a real operating record. The one program that satisfies all three of your **hard** requirements is **Kamino Farms (kfarms)**, `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` — used as a **tenant on Kamino's already-deployed, verified mainnet binary, not as a fork**. It gives you R2 (program-enforced per-second emission, `RewardType::Proportional`) and R3 (an always-available per-user `unstake` that pays a penalty into a destination-pinned treasury sweep) natively, with zero custom code and zero keeper. It gives you **nothing** on R4: there is no boost, no multiplier, no per-user lock duration, and no per-deposit positions anywhere in the program. You reconstruct the ladder as N parallel farms with an off-chain RPS rebalancer, which is exact-at-rebalance and degrades gracefully rather than failing. That is the compromise. **My recommendation is: take kfarms, ship the multi-farm ladder, and accept that the boost is an off-chain-maintained approximation rather than an on-chain invariant.** If the ladder as an on-chain invariant is non-negotiable, then the house rule and the economics are in direct conflict, and §6 tells you which one I'd break.

---

## 2. The Comparison

| Candidate | Battle-tested evidence | Fixed daily emissions | Lock boost ladder | Per-user penalized exit | Licence | Exploit history |
|---|---|---|---|---|---|---|
| **Kamino kfarms** `FarmsPZ…` | Protocol $1.31B (that is **klend**, not kfarms). kfarms self-custodied ≈**$35.5M priceable**, ~$35–60M inferred. 578 farms, 1.53M UserStates, live since ~Mar 2023. **Lock+penalty path: 2 of 578 farms, both `penalty_bps=0`, ~$0 at risk.** Verified reproducible build. | **PASS native.** `RewardScheduleCurve` (20 pts), `RewardType::Proportional` = rate × elapsed, TVL-independent. No keeper. | **FAIL.** Zero hits for boost/multiplier/weight. Lock is farm-level, one duration per farm. One UserState per (farm, owner). | **PASS native.** `unstake` always succeeds → `apply_early_withdrawal_penalty`. Penalty **decays linearly to 0** at maturity, not flat. Swept by permissionless crank to `has_one`-pinned spill address. | **BSL 1.1**, Grant `None`, Change Date 2027-11-17 → GPLv2+. **Fork blocked.** Tenancy unaffected. **But `release/v1.5.0` and earlier are irrevocably Apache-2.0** (relicensed 2024-09-25, commit `aab8ab6`) — *verify branch before relying*. | None found across DefiLlama hacks DB (1,251 records), Helius 38-incident history, or repo advisories. Negative, not proof. |
| **Quarry** `QMNeHC…` | Peak $1.54B (2021-11) — **DefiLlama's own adapter sets `doublecounted: true`**, and that peak is the Saber/Sunny/Cashio circularity CoinDesk documented. Today $5.93M (I reproduced it to 0.6%). Live, 702 quarries. | **PASS native.** `annual_rewards_rate`, Synthetix accrual. But audit findings **QSP-2/QSP-3 accepted an off-chain `syncQuarryRewards` keeper as the mitigation** — never fixed. | **FAIL — absent.** No lock, weight, or duration field anywhere. | **FAIL.** `withdraw_tokens` is unconditional and free. Worse: `pause` gates `UserStake::validate()`, so **a single `pause_authority` key freezes principal**. | AGPL-3.0, verified byte-identical to FSF text. Fork legally permitted today. SDK is also AGPL — frontend obligation. | None found. But: upgradeable, **6-of-11 Goki, 0 timelock**, whose *own* controlling wallet is **2-of-3 with keys used as recently as 2025-12**. At $1.5B peak it was a **single keypair on unaudited code**. |
| **Armada / mithraiclabs** | **~$37.5k measured**, 29 of 62 pools at zero. Abandoned Apr 2024. Audit is **34 commits behind the deployed binary**. | FAIL. Balance-diff. No rate field exists. | **PASS** — linear, 12:1 observed in prod. Frozen `effective_stake` (your existing bug). | FAIL. Global `ESCAPE_HATCH_ENABLED` bitflag; 10 pools have it on. No penalty anywhere. | BSL 1.1, Grant `None`, Change Date 2027-11-13. **Licensor defunct** — no one can grant a waiver. | None found — meaningless at $37k. |
| **Streamflow** | ≈$7.0M measured; **$4.83M is one token**. The $371M is the *vesting* program, different code. | FAIL. Classic = rate per staked token. Dynamic = balance-diff. `fund_as_delegate` requires **Streamflow's hot key**. | PASS (linear, 10:1 in prod, 1.0x floor hardcoded). | **FAIL absolutely.** Error 6013 `LockedStake`. No exit at any price, no field to add one. | **No source published. Not a verified build. Unforkable, permanently.** | None found. Unreviewable by anyone. |
| **Raydium Farm V6** | Protocol $1.39B — that is the AMM. **Farm V6: 41 of 2,824 farms still emitting.** | PASS (`rewardPerSecond`) but **capped at 90-day tranches**, rate cuts only in final 72h. | FAIL. `rewardMultiplier` is share-math scaling, not a boost. | FAIL. Withdraw is `{u8, u64}`. No lock. | **No public source.** `raydium-staking` repo is 404. Unforkable. | **Protocol hacked twice** (Dec 2022 $4.4M key compromise; Jun 2026 $1.34M legacy AMM). Not the farm program. "Never hacked" is false. |
| **Meteora Stake2Earn** | **$276,660 total across 3,319 vaults; $7.36/day rewards.** Product is on Meteora's own legacy shelf. | FAIL. Fee-share, no emission machinery, `claim_fee_crank` required. | FAIL. Top-N leaderboard, no time weighting. | FAIL. Free cooldown exit, and `update_unstake_lock_duration` lets admin **extend** it post-deposit. | No source; published programs are **Noncommercial with no change date** — worse than BSL. | None found. Dec 2024 unstake UI failure during a 100x. |
| **ve family** (Jupiter/WAGMI, Tribeca) | WAGMI/Jupiter: **$226M, 888,831 escrows, 28 months** — the strongest R1 in the sweep. Tribeca canonical: <$1M, README says "unaudited". | **FAIL — no reward subsystem exists.** Jupiter's ASR is an off-chain merkle drop. | PASS-ish. Correct continuous decay (no frozen-weight bug) but the ratio is forced to min:max duration, and Jupiter runs it at **1x / 7d** — unexercised. | **FAIL.** `invariant!(expiration <= now, EscrowNotEnded)`. Partial-unstake is a cooldown, not a penalty. | Tribeca AGPL-3.0. **WAGMI has no LICENSE file** — README asserts Apache 2.0 in a sentence that names Anchor. | None found. `voTpe3…` upgrade authority is a **bare System-owned keypair**. |
| **Adrena** (reference only) | Orders of magnitude below bar. | n/a | **The only correct implementation** — 90/180/360/540d, 1.75–4.0x, early unlock forfeits 5–40%. | Yes — the design you want. | **Program source not published** (unverified). | n/a |

---

## 3. Why the Runners-Up Lose

**Quarry** — three independent kills. (i) It **mints** rewards: `NewRewarderV2::validate` asserts `rewards_token_mint.mint_authority == mint_wrapper`. A fixed-supply TOWELI-equivalent with revoked mint authority cannot be used at all without the Saber IOU + `quarry-redeemer` pattern — a second program in front of every user with a "vault runs dry, users hold unredeemable IOUs" failure mode. (ii) R3 is inverted: withdrawal is free at all times, and `pause` is checked in `UserStake::validate()`, so a single `pause_authority` key can **trap principal indefinitely** — the exact single-key surface you rejected in Armada, pointing the wrong way. (iii) The $1.5B is flagged `doublecounted: true` by [DefiLlama's own adapter](https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/quarry/index.js), and at the moment of that peak the program was replaceable by one pseudonymous keypair running code the Quantstamp audit had not yet covered. AGPL is the only thing it wins on, and the Apache-2.0 kfarms v1.5.0 finding takes even that away.

**Armada (mithraiclabs)** — BSL 1.1 with `Additional Use Grant: None` and a **defunct licensor**, so the fork is forbidden and no one is left to grant an exception. Measured TVL ~$37.5k. Emissions are balance-diff with no rate field in `RewardPool` (`#[assert_size(64)]`, 8 bytes free). The audit's end commit is 34 commits behind the deployed binary, and every admin lever that matters — `set_flags`, `dangerously_mint_stake_mint`, `transfer_authority` — was added *after* it. Close this line permanently.

**Streamflow** — no early exit at any price (`LockedStake`, error 6013), no rate-based emission in either reward program, and no published source, so none of it can ever be fixed by you or by anyone but Streamflow. The dynamic pool moves *away* from R2 by deleting the rate entirely; `fund_as_delegate` is gated on Streamflow's on-curve hot wallet `wdrwhnCv4…`. It is a defensible status quo and a non-candidate.

**Raydium Farm V6** — no public source (the audited repo `raydium-io/raydium-staking` returns 404), no lock, no penalty field in the withdraw instruction, no published audit that covers V6 (the OtterSec report is scoped to `doubleRewards/`, i.e. V5, and predates V6's launch), and emissions come in ≤90-day tranches you must re-fund forever. Two protocol-level exploits on record, so "never hacked" is literally false.

**Meteora Stake2Earn** — $276,660 across the entire program, paying $7.36/day globally. No emission engine. `update_unstake_lock_duration` lets an admin **lengthen** the exit delay on people already deposited — strictly worse than Armada's escape hatch, which could only free people. The forkable adjacent code (`reward-pool`) has the right Synthetix rate but no LICENSE file and is a Step Finance fork; if you ever wanted that lineage you'd take `step-finance/reward-pool` (Apache-2.0) directly and skip Meteora.

**The ve family (Jupiter/WAGMI, Tribeca)** — a governance-weight primitive, not a staking rail. `locked_voter` contains zero lines of reward code; Jupiter's own ASR is an off-chain merkle computation, which is the heaviest keeper in the sweep. `withdraw` hard-asserts `EscrowNotEnded`. Two of your three hard requirements fail in the source, and fixing either means a fork that deletes the $226M record that was the only reason to look. Tribeca canonical additionally says "unaudited" in its own README.

**Adrena** — the correct economics exist and are the closest thing to TOWELI on Solana (duration multipliers *and* a 5–40% forfeit-to-burn early unlock), but the program is hardcoded to ADX/ALP inside Adrena's perps program, not instantiable for an arbitrary mint, and the on-chain source is not published. Keep it as a design reference for the penalty curve, nothing more.

---

## 4. The Architecture

Repo: [Kamino-Finance/kfarms](https://github.com/Kamino-Finance/kfarms). Deployed binary is **v1.6.5**, last deployed slot 379693642 = **2025-11-12T23:46:55Z**, and it is a **verified reproducible build** against commit `72c94b4` — [verify.osec.io](https://verify.osec.io/status/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr) reports `is_verified: true`, on-chain hash == executable hash. Code against `72c94b4`, **not** master (master's 1.7.0 is not deployed).

### 4.1 Fixed daily emission — NATIVE, no keeper, no fork

`RewardInfo.reward_schedule_curve` holds up to 20 `RewardPerTimeUnitPoint { ts_start, reward_per_time_unit }`. `farm_operations::refresh_global_reward` with `RewardType::Proportional` computes `cumulative_amt` = rate × elapsed, **independent of TVL**, then splits it pro-rata across `total_active_stake_scaled`. That is Synthetix `rewardRate`, enforced by the program every slot.

- 71,219 TOWELI/day ÷ 86,400 = **0.8242939… TOWELI/sec** = **824,293,981 base units/sec** at 9 decimals. `rewards_per_second_decimals` gives you the fractional precision so you are not rounding away 0.48 base units per second.
- **Select `Proportional` explicitly.** `RewardType::Constant` = rate × elapsed × `total_staked_amount` — that is exactly the Streamflow per-staked-token model you rejected, and it is one enum value away.
- The 20-point curve lets you pre-commit a taper/halving schedule on-chain, which TOWELI cannot do. Free upgrade.
- **Solvency, not liveness:** `add_rewards` pre-funds a vault; if `rewards_available` hits zero, issuance is clamped to `min(amount, rewards_available)` and stakers silently under-earn. This is a treasury operation with an alarm, not a crank. 71,219/day × 365 = **25,994,935 TOWELI/yr**.

### 4.2 The 25% penalized exit — NATIVE, per-user, no admin action

`unstake` (`handler_unstake.rs` → `stake_operations::unstake`) **always succeeds**, at any time, for any staker, with no toggle and no keeper. It routes through `utils/withdrawal_penalty.rs`:

```
penalty_bps_effective = penalty_bps * time_remaining / total_duration
amount_out            = amount - amount * penalty_bps_effective / 10000
```

Set `LockingMode = Continuous (1)` so each user's clock starts at their own `last_stake_ts`, and `LockingEarlyWithdrawalPenaltyBps = 2500`. Penalty accrues to `slashed_amount_current` / `slashed_amount_cumulative` and is swept by `withdraw_slashed_amount` — signer is an unconstrained `crank: Signer` (**permissionless**), destination pinned by `has_one` to `slashed_amount_spill_address`. Your treasury address is on-chain and publicly checkable; no admin discretion over where the money goes.

**Two deviations from TOWELI, both unfixable without a fork:**
1. **Decaying, not flat.** 2500 bps at t=0 → 0 at maturity. On a 4-year rung, a day-1 exit pays 25%, a year-2 exit pays 12.5%. Expected treasury capture is roughly *half* of TOWELI's for uniformly-distributed exits. Price this into your treasury model.
2. **Guardrail:** `penalty_bps` of exactly `0` or exactly `10000` returns `EarlyWithdrawalNotAllowed`. Usable range is 1–9999. Note the corollary: **your own `farm_admin` can revoke the exit right** by writing 0 or 10000. See §5.

### 4.3 The 7d..4y, 0.4x..4.0x ladder — NOT NATIVE. This is the whole compromise.

There is no weight field, no multiplier, no per-user duration. `locking_duration` is a **farm-level** field, so one farm = one lock length for everybody, and `UserState` is one PDA per (farm, owner) with a single `active_stake_scaled` — no per-deposit positions.

**Construction: N parallel farms, one per rung, plus an RPS rebalancer.** Your ratio note does the work here — only the min:max ratio matters, so normalise the floor to 1.00x:

| Rung | `locking_duration` (s) | Normalised weight `wᵢ` |
|---|---|---|
| 7 d | 604,800 | 1.00 |
| 90 d | 7,776,000 | 1.51 |
| 365 d | 31,536,000 | 3.22 |
| 1460 d | 126,144,000 | 10.00 |

(from `b(d) = 1 + 9·(d−7)/1453`, the linear 0.40→4.00 curve rebased to its floor.)

**The keeper's job is one formula.** With `Sᵢ` = tokens staked in rung *i*:

```
RPSᵢ = R_total · (wᵢ · Sᵢ) / Σⱼ (wⱼ · Sⱼ)
```

Two properties that make this acceptable where Armada's keeper was not:
- **Σ RPSᵢ = R_total identically.** Your fixed daily emission (R2) is preserved by construction at every rebalance, regardless of stake distribution. The keeper cannot inflate or deflate the schedule.
- **At each rebalance instant this is arithmetically identical to a single weighted pool.** The only error is stake drift *between* rebalances, and **if the keeper dies, emissions do not stop** — the split freezes at its last-correct value and degrades in proportion to subsequent migration. Contrast Armada, where a stalled keeper means emissions silently go to zero, and Streamflow's ASR cron, where a stalled keeper means no rewards at all. This is a cosmetics keeper, not a correctness keeper. Run it on an hourly cron plus an event trigger when any rung's stake moves >2%.

**Sign it with `delegated_rps_admin`, not `farm_admin`.** `handler_update_farm_config.rs` authorises `UpdateRewardRps` / `UpdateRewardScheduleCurvePoints` for either `farm_admin` **or** a separate `delegated_rps_admin`; every other `FarmConfigOption` is `farm_admin` only. So the hot keeper key can move emissions between rungs and **cannot** touch `LockingEarlyWithdrawalPenaltyBps`, `LockingDuration`, `SlashedAmountSpillAddress`, or `withdraw_authority`. Take that separation; it is the single best security property of this design.

### 4.4 Setup sequence (all permissionless, all on the deployed binary)

1. `initialize_global_config` — `global_admin: Signer` + `#[account(zero)]`, no gate. **Create your own; do not point at Kamino's** `6UodrBjL2ZreDy7QdR4YV1oxqMBjVYSEyrFpctqqwGwL`, whose admin can raise `treasury_fee_bps` to 10000 and skim every harvest (`farm_operations.rs:614`). Set yours to 0.
2. `initialize_farm` ×4 — `farm_admin: Signer` + `#[account(zero)] farm_state`; `global_config` is passed **unconstrained**, so your config is accepted. Staked mint = TOWELI-on-Solana.
3. `initialize_reward` + `add_rewards` per rung. `RewardType::Proportional`.
4. `update_farm_config` per rung: `UpdateRewardRps`, `LockingMode=1`, `LockingDuration`, `LockingEarlyWithdrawalPenaltyBps=2500`, `SlashedAmountSpillAddress=treasury`, `deposit_warmup_period=0`, `withdrawal_cooldown_period=0`, `delegated_rps_admin=keeper`. **Leave `withdraw_authority` at `Pubkey::default()`** — it is the principal-drain lever and is off by default (set on 0 of 578 live farms).
5. `update_farm_admin` (two-step, `pending_farm_admin`) → Squads multisig with a timelock.

User path: `stake` → `unstake` (penalty applied) → `withdraw_unstaked_deposits`; `harvest_reward` to claim; anyone calls `withdraw_slashed_amount` to sweep the treasury.

### 4.5 Native / config / fork / keeper

| Requirement | Status |
|---|---|
| Fixed 71,219/day, program-enforced | **Native** + one config value |
| Pro-rata over stake | **Native** |
| Per-user penalized exit to treasury | **Native** + `LockingMode`/`penalty_bps`/`spill_address` config |
| 7d & 1460d bounds | **Config** (per rung) |
| 10:1 boost ratio | **Config + off-chain rebalancer** (non-critical liveness) |
| Flat 25% instead of decaying | **Fork only** |
| Per-deposit multi-positions inside one rung | **Fork only** (partially recovered: a holder may hold one position per rung simultaneously) |
| NFT +0.5x | **Fork only** (`reward_user_once` is admin-driven, not a hook) |
| Token-2022 staked mint | **Fork only** — `handler_stake.rs` and `handler_initialize_farm.rs` pin `Program<'info, Token>` |

---

## 5. What It Costs

**Licence.** Tenancy triggers no BSL obligation: you never copy, modify, or distribute the Licensed Work — you send transactions to a binary Kamino deployed and validators execute. That is not a copyright act. Get counsel to sign off on exactly one narrow question in writing: *does sending transactions to a BSL-licensed program deployed by its own licensor constitute "production use of the Licensed Work" when we never possess or execute a copy?* Also: the licence grants no trademark rights — keep "Kamino" out of your branding and out of any endorsement implication. Separately, [`farms-sdk`](https://github.com/Kamino-Finance/farms-sdk) declares `Apache-2.0` in `package.json` but **ships no LICENSE file in the repo**. Either generate your own client from the on-chain IDL, or pin a version and archive the npm tarball as evidence. There is no published `farms-cli`; budget for writing your own admin script against the SDK's generated instruction builders.

**Audit.** Nothing to audit if you do not fork — but do not read that as "audited". The two farms audits ([OtterSec, Oct 2023](https://github.com/Kamino-Finance/audits/blob/master/kamino_farms_ottersec.pdf); [Offside Labs, Dec 2023](https://github.com/Kamino-Finance/audits/blob/master/kamino_farms-offside_labs.pdf)) both describe the product as stake/unstake-at-will; the strings `lock`, `penalt`, `boost` appear **zero times** in OtterSec, and `withdrawal_penalty.rs` appears in Offside exactly once, in a file list attached to a rewards-precision finding. **No auditor has ever analysed the lock or penalty semantics.** The one 2025 report that is public ([Offside RA-KMNO-058, released as a v1.6.4 asset](https://github.com/Kamino-Finance/kfarms/releases/download/release/v1.6.4/Offside.Audit.pdf)) is a **one-day, two-PR delta review**. Kamino's own audits repo holds 42 PDFs: klend is re-audited at nearly every version; farms is 2 of 42, both from 2023. Budget a paid independent review of *your configuration and the lock/penalty path specifically* — call it $25–50k — and consider funding a targeted Immunefi Boost on that path.

**Keeper.** One process, hourly + event-triggered, holding only `delegated_rps_admin`. Failure mode: ratio drift, bounded, self-limiting, no funds at risk, no emission interruption. Plus a per-rung `rewards_available` solvency alarm — note that as RPS moves between rungs, burn rates move too, so a rung that gains weight drains faster.

**Admin key surface — yours.** `farm_admin` can retroactively change `locking_duration`, `locking_mode`, and `penalty_bps` on live stakers, and can set `penalty_bps` to 0 or 10000 to **revoke the early-exit right entirely**. That is the mirror image of Armada's escape hatch, defaulting the right way but still a single-key surface. Put `farm_admin` behind a Squads multisig with a timelock immediately after configuration, and say so publicly, or the "user right, not admin toggle" framing is thin.

**Admin key surface — Kamino's.** The program is upgradeable: authority `CivjSDKgTpmkRNL4zYcmv9D9QqPJg6yTxBVxMGcXvMuY`, off-curve, derived as a Squads v4 vault of multisig `5HzXCm7omo3M7sX5nC4XcAxcTXEC22UHegB1hQiRvbfk`, reported **5-of-10 with an 86,400s timelock — treat the threshold and timelock as unverified until you re-derive them yourself.** 36 upgrades to date, none in 2026. The 24h timelock, if real, is your exit window. And there is precedent for commercial use of that authority: in **December 2025 Kamino upgraded its lending contracts to block Jupiter Lend's migration tool** ([The Defiant](https://thedefiant.io/news/defi/kamino-blocks-jupiter-lend-refinance)) — different key, same organisation, same willingness.

**What you must accept that you would rather not:**
- The ladder is an off-chain-maintained approximation, not an on-chain invariant.
- The penalty decays instead of being flat, roughly halving expected treasury capture.
- `farm_operations.rs:497` sets `last_stake_ts = current_ts` on **every** stake. In Continuous mode a top-up **re-locks the holder's entire balance and re-arms the full penalty on all of it**. This is a serious footgun and must be screamed at in the UI. Tell users to open a new position in another rung instead of topping up.
- One position per wallet per rung. Four rungs = at most four positions.
- **The lock+penalty code path has ~$0 of mainnet exposure and has never been audited.** You would be its first meaningful user.
- Your TVL sits under someone else's upgrade authority, forever, with no contract and no recourse.

---

## 6. The Honest Residual

Versus TOWELI, this rail does **not** give you:

**A boost ladder that holds without you.** In TOWELI the 10:1 is an invariant of the accounting. Here it is a number a cron job maintains. If the keeper is down for a week during a big migration into the 4-year rung, long-lockers are under-paid and short-lockers over-paid until it comes back. Nothing breaks, nothing is stolen, no emission is lost — but the promise drifts, and you will have to explain that to holders.

**A flat 25%.** Your contract charges 25% at any moment. This charges 25% falling to zero. Economically this is arguably fairer and it is definitely different, and it means the exit gets cheaper exactly as the lock becomes less onerous — the opposite of a commitment device late in the term.

**A fix for the frozen-boost bug.** This is the one that will sting. Once a 4-year position matures under `LockingMode::Continuous`, the penalty goes to zero and the holder is free to leave — **but they keep sitting in the 10x rung earning the 10x rate until they do.** That is your existing bug, reproduced. kfarms has no force-unstake and no auto-decay, so there is no mitigation short of a fork. It is neither better nor worse than what you have today; it is simply not fixed.

**Per-deposit positions, and the NFT bonus.** Neither is expressible. Four rungs is your entire position model.

**Token-2022.** The staked mint must be legacy SPL Token. **Check this before anything else in this document matters** — a Token-2022 TOWELI-on-Solana mint kills the recommendation outright and there is no runner-up to fall back to.

**And the strategic residual.** If the ladder-as-invariant is truly non-negotiable, there is a legal fork path that nobody had found: **kfarms was Apache-2.0 until 2024-09-25** (relicense commit `aab8ab6`; the highest Apache tree appears to be `release/v1.5.0` — verify the exact branch), and Apache §2's grant is irrevocable. That tree **already contains** `withdrawal_penalty.rs` and `RewardScheduleCurve`, so you would be adding a per-position weight and a weighted denominator to a codebase that already has R2 and R3 — a materially smaller and safer change than doing the same to AGPL Quarry, which has neither. Cost: two audits, a bounty, months, and — decisively — **the moment you deploy it, it is a custom program with zero TVL and zero history, and your house rule forbids it.**

So the real decision on your desk is not "which program". It is: **do you give up the ladder, or do you give up the rule?** My judgement is that you give up the ladder. The rule exists to prevent exactly the failure the fork reintroduces, and R2 plus a genuine per-user penalized exit on a program with 1.5M user accounts and no incident across three registries is worth more than an on-chain-perfect boost curve on code nobody has attacked yet.

---

## Verify Before You Build

1. **Is TOWELI-on-Solana a legacy SPL mint or Token-2022?** Binary gate. Everything above depends on it.
2. **How many `GlobalConfig` accounts exist?** Two independent counts say **1**; one says **6**. If it is genuinely 1, you would be the first third party to run an independent config — re-derive it before relying on the `treasury_fee_bps = 0` isolation.
3. **Re-derive the Squads multisig threshold and timelock** behind `CivjSDKgTpmkRNL4zYcmv9D9QqPJg6yTxBVxMGcXvMuY`. The 5-of-10 / 24h figure is single-sourced.
4. **Confirm the exact Apache-2.0 branch/tag** if you want the fork option preserved as a fallback, and archive the LICENSE blob, the `NOTICE`, and the `Cargo.toml` `license = "Apache-2.0"` line at that commit as evidence.
5. **Written counsel sign-off** on the tenancy question in §5.

**Key sources:** [kfarms](https://github.com/Kamino-Finance/kfarms) · [LICENSE (master, BSL)](https://raw.githubusercontent.com/Kamino-Finance/kfarms/master/LICENSE) · [audits repo](https://github.com/Kamino-Finance/audits) · [verified build](https://verify.osec.io/status/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr) · [DefiLlama Kamino](https://api.llama.fi/protocol/kamino) · [DefiLlama hacks DB](https://api.llama.fi/hacks) · [Helius Solana hack history](https://www.helius.dev/blog/solana-hacks) · [Immunefi Kamino scope](https://immunefi.com/bug-bounty/kamino/scope/) · [Quarry](https://github.com/QuarryProtocol/quarry) · [Quarry adapter `doublecounted:true`](https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/quarry/index.js) · [Armada BSL](https://raw.githubusercontent.com/mithraiclabs/spl-token-staking/master/LICENSE) · [Streamflow js-sdk](https://github.com/streamflow-finance/js-sdk)"
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Survey"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Verify"
    },
    {
      "type": "workflow_phase",
      "index": 3,
      "title": "Design"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "survey:quarry",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "aa65e25796bb87f67",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292324,
      "queuedAt": 1788318290454,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Quarry Protocol (quarry-mine)",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788318932291,
      "tokens": 110049,
      "toolCalls": 51,
      "durationMs": 639964,
      "resultPreview": "{"name":"Quarry Protocol (quarry-mine)","verdict":"partial-fit","repo":"https://github.com/QuarryProtocol/quarry — programs/quarry-mine v5.3.0. Mainnet program IDs (same on devnet/testnet/mainnet): Mine QMNeHCGYnLVDn1icRAfQZpjPLBNkfGbSKRB83G5d8KB, MintWrapper QMWoBmAyJLAsA1Lh9ugMTw2gciTihncciphzdNzdZYV, Redeemer QRDxhMw1P2NEfiw5mYXG79bwfgHTdasY2xNP76XSea9. Deps: anchor-lang/anchor-spl \">=0.22, <=…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "survey:armada-recheck",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a2b39c79ff2cebdc6",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292362,
      "queuedAt": 1788318290455,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "mithraiclabs/spl-token-staking (Armada / PsyOptions "SPL To…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319038737,
      "tokens": 128712,
      "toolCalls": 56,
      "durationMs": 744551,
      "resultPreview": "{"name":"mithraiclabs/spl-token-staking (Armada / PsyOptions \"SPL Token Staking\")","verdict":"unsuitable","repo":"https://github.com/mithraiclabs/spl-token-staking — mainnet program ID STAKEGztX7S1MUHxcQHieZhELCntb9Ys9BgUbeEtMu1 (verified deployed, executable, BPFLoaderUpgradeable). 36 stars, 12 forks, 77 commits, master HEAD 2024-04-18.","license":"CONFIRMED HARD BLOCKER, and worse than previou…"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "survey:streamflow",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a2a0452c20a411902",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292478,
      "queuedAt": 1788318290455,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Streamflow Staking (stake_pool `STAKEvGq…` + reward_pool `R…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319324329,
      "tokens": 132637,
      "toolCalls": 65,
      "durationMs": 1030142,
      "resultPreview": "{"name":"Streamflow Staking (stake_pool `STAKEvGq…` + reward_pool `RWRDdfRb…` / reward_pool_dynamic `RWRDyfZa…`)","verdict":"unsuitable","repo":"https://github.com/streamflow-finance/js-sdk — TypeScript SDK ONLY. The on-chain program source is NOT published anywhere. Streamflow's GitHub org has 18 repos; the only Rust on-chain-program repo is `streamflow-program` (AGPL-3.0, explicitly \"(deprecate…"
    },
    {
      "type": "workflow_agent",
      "index": 4,
      "label": "survey:kamino-farms",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "ae8a2a281c43d8c5c",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292678,
      "queuedAt": 1788318290455,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Kamino Farms (kfarms)",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319012060,
      "tokens": 129327,
      "toolCalls": 57,
      "durationMs": 717872,
      "resultPreview": "{"name":"Kamino Farms (kfarms)","verdict":"partial-fit","repo":"https://github.com/Kamino-Finance/kfarms — Rust/Anchor 0.29.0, rust 1.74.1, solana-sdk 1.17.18. Public repo is a squashed mirror (29 commits on `master`; audited commit hashes are NOT present in it, so audits were run against an internal repo). Mainnet program: FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr. THREE VERSIONS DIVERGE: repo…"
    },
    {
      "type": "workflow_agent",
      "index": 5,
      "label": "survey:raydium",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a2bea7ff55bba3425",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292401,
      "queuedAt": 1788318290455,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Raydium farming / staking programs (Farm V3 `EhhTKczWMGQt46…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319032057,
      "tokens": 119564,
      "toolCalls": 55,
      "durationMs": 737870,
      "resultPreview": "{"name":"Raydium farming / staking programs (Farm V3 `EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q`, Farm V5 `9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z`, Farm V6 `FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG`)","verdict":"unsuitable","fixedEmissions":"MEETS R2 — and this is the only requirement it meets, but it meets it cleanly and natively.\
\
Verified from the on-chain state layout in the off…"
    },
    {
      "type": "workflow_agent",
      "index": 6,
      "label": "survey:jupiter",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a5c2936170ec0c928",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292764,
      "queuedAt": 1788318290456,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Jupiter (WAGMI locked-voter / govern + Jupiter Lock "locker…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788318996406,
      "tokens": 119972,
      "toolCalls": 52,
      "durationMs": 702216,
      "resultPreview": "{"name":"Jupiter (WAGMI locked-voter / govern + Jupiter Lock \"locker\" + ASR merkle distributor)","verdict":"unsuitable","repo":"Governance/staking: https://github.com/TeamRaccoons/WAGMI (TeamRaccoons is the Jupiter/Meteora core dev org; README explicitly names Jupiter as the user). Programs: govern GovaE4iu227srtG2s3tZzB4RmWBzw8sTwrCLZz7kN7rY, locked_voter voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3Xq…"
    },
    {
      "type": "workflow_agent",
      "index": 7,
      "label": "survey:meteora",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "abefc9b124fd49855",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292643,
      "queuedAt": 1788318290456,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Meteora (Stake2Earn / M3M3 stake-for-fee, farming "reward-p…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788318892497,
      "tokens": 91900,
      "toolCalls": 50,
      "durationMs": 598309,
      "resultPreview": "{"name":"Meteora (Stake2Earn / M3M3 stake-for-fee, farming \"reward-pool\", Dynamic Vault)","verdict":"unsuitable","repo":"No on-chain program source exists for the staking product. https://github.com/MeteoraAg/stake-for-fee-sdk is an SDK ONLY — I pulled the full git tree (53 files): `stake_for_fee_interface/src/{accounts,errors,events,instructions,typedefs}.rs` (IDL-derived, machine-generated), `…"
    },
    {
      "type": "workflow_agent",
      "index": 8,
      "label": "survey:tribeca-ve",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a558d6923eee5040a",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292563,
      "queuedAt": 1788318290456,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Tribeca vote-escrow (ve) family on Solana — TribecaHQ `lock…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319347181,
      "tokens": 131429,
      "toolCalls": 60,
      "durationMs": 1052994,
      "resultPreview": "{"name":"Tribeca vote-escrow (ve) family on Solana — TribecaHQ `locked_voter` and its WAGMI / Jupiter fork","verdict":"unsuitable","repo":"Two distinct things travel under \"tribeca-ve\" and they must be judged separately.\
\
(A) CANONICAL — https://github.com/TribecaHQ/tribeca, program `locked_voter` deployed at `LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw`. Programs: govern, locked-voter, simple…"
    },
    {
      "type": "workflow_agent",
      "index": 9,
      "label": "survey:sweep-2026",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a820a8cdcec500fc2",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292576,
      "queuedAt": 1788318290456,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Kamino Farms (kfarms) — mainnet program FarmsPZpWu9i7Kky8tP…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319502269,
      "tokens": 145459,
      "toolCalls": 68,
      "durationMs": 1208081,
      "resultPreview": "{"name":"Kamino Farms (kfarms) — mainnet program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr (used WITHOUT a fork; permissionless farm creation on Kamino's own deployed, verified binary)","verdict":"strong-fit","repo":"https://github.com/Kamino-Finance/kfarms (program), https://github.com/Kamino-Finance/farms-sdk + npm @kamino-finance/farms-sdk (TS client/CLI: init-farm, init-reward, upsert-all-f…"
    },
    {
      "type": "workflow_agent",
      "index": 10,
      "label": "survey:exit-primitive",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a69cb2a4783f5e03c",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788318292682,
      "queuedAt": 1788318290456,
      "attempt": 1,
      "lastToolName": "StructuredOutput",
      "lastToolSummary": "Kamino Farms (kfarms) — program FarmsPZpWu9i7Kky8tPN37rs2Tp…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788318909252,
      "tokens": 107706,
      "toolCalls": 39,
      "durationMs": 615063,
      "resultPreview": "{"name":"Kamino Farms (kfarms) — program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr","verdict":"partial-fit","repo":"https://github.com/Kamino-Finance/kfarms — clone read locally at C:\\Users\\jimbo\\AppData\\Local\\Temp\\claude\\C--Users-jimbo-OneDrive-Desktop-bayteg\\e201e3fa-b7f5-413c-a8a8-73fa7552c02a\\scratchpad\\kfarms. All claims below are read from source at commit bfa186034ba8ecd36e7faf…"
    },
    {
      "type": "workflow_agent",
      "index": 11,
      "label": "licence:Quarry Protocol (quarry-mine)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "ad970d1ee2d0ba1a1",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505520,
      "queuedAt": 1788319503782,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "RPC=https://api.mainnet-beta.solana.com echo "=== blockTime…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319845625,
      "tokens": 78243,
      "toolCalls": 28,
      "durationMs": 339050,
      "resultPreview": "## VERDICT: Prior agent's licence call is CORRECT. Its legal reasoning is incomplete in two material ways, and one of its facts is wrong.

AGPL-3.0 confirmed against the actual repository. Not BSL. A commercial mainnet fork today **is permitted**.

---

## 1. Licence file — verified byte-for-byte

The prior agent said "LICENSE at repo root." It guessed the path; `LICENSE.txt` 404s. Actual file is …"
    },
    {
      "type": "workflow_agent",
      "index": 12,
      "label": "security:Quarry Protocol (quarry-mine)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "ab0918faaf3ec9393",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505852,
      "queuedAt": 1788319503782,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "curl -s "https://raw.githubusercontent.com/QuarryProtocol/q…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788320298746,
      "tokens": 134715,
      "toolCalls": 42,
      "durationMs": 792169,
      "resultPreview": "## ADVERSARIAL CHECK: Quarry Protocol (quarry-mine) — results

Three verdicts up front:

- **"Never hacked": I could not refute it. It stands, and I strengthened the negative.**
- **"Battle-tested $1.5B": REFUTED as stated.** The number is real but it is (a) DefiLlama-flagged double-counted TVL, (b) from the exact ecosystem a CoinDesk investigation showed was faked, and (c) secured by *pre-audit c…"
    },
    {
      "type": "workflow_agent",
      "index": 13,
      "label": "licence:Kamino Farms (kfarms)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a1b59859ec7e22dba",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505546,
      "queuedAt": 1788319503794,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd "C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319952666,
      "tokens": 90019,
      "toolCalls": 34,
      "durationMs": 446091,
      "resultPreview": "## VERDICT ON THE PRIOR AGENT'S LICENCE CLAIM

**Every verbatim quote they gave is accurate. Their conclusion about `master` is correct. But they got the most important thing wrong by omission: they treated "the licence" as one fact about the repo. BSL is explicitly per-version, and kfarms was Apache-2.0 for its first ten months. That grant is irrevocable and it covers a version that already has t…"
    },
    {
      "type": "workflow_agent",
      "index": 14,
      "label": "security:Kamino Farms (kfarms)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a71b6918864d0380b",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505406,
      "queuedAt": 1788319503794,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd "C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788320349937,
      "tokens": 141336,
      "toolCalls": 59,
      "durationMs": 844530,
      "resultPreview": "## VERDICT

The clean record largely survives, but **the prior agent's audit summary is wrong**, and I found two facts that outrank the security question entirely. **kfarms is BUSL-1.1 with "Additional Use Grant: None" — the same hard blocker that disqualified Armada** — and **the billion-dollar farms custody no staked tokens at all.**

---

## 1. REFUTED: "TWO audits, BOTH FROM 2023, never re-aud…"
    },
    {
      "type": "workflow_agent",
      "index": 15,
      "label": "licence:Kamino Farms (kfarms) — mainnet program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr (used WITHOUT a fork; permissionless farm creation on Kamino's own deployed, verified binary)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "ad5c669c19457d7f8",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319506059,
      "queuedAt": 1788319503810,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "D="C:/Users/jimbo/AppData/Local/Temp/claude/C--Users-jimbo-…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319907751,
      "tokens": 80442,
      "toolCalls": 23,
      "durationMs": 401174,
      "resultPreview": "VERDICT ON THE PRIOR AGENT: the BUSL text it quoted is real, but it read only `master` and missed the two facts that matter. Its licensor is wrong for the code that is actually deployed, and its central conclusion — "you cannot add the boost ladder, Token-2022 staking or multi-position yourself before 2027-11-17" — is FALSE. A permissively-licensed fork base exists today.

---

## 1. LICENSE on `m…"
    },
    {
      "type": "workflow_agent",
      "index": 16,
      "label": "security:Kamino Farms (kfarms) — mainnet program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr (used WITHOUT a fork; permissionless farm creation on Kamino's own deployed, verified binary)",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a560ef31b7445ca7e",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505655,
      "queuedAt": 1788319503810,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd /tmp/kf && python3 - <<'EOF' import json,urllib.request,…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788320251109,
      "tokens": 118039,
      "toolCalls": 46,
      "durationMs": 744533,
      "resultPreview": "Adversarial check complete. Here are my findings.

## VERDICT

**The clean record survives my attack — but "billion dollar code" does not, and I found a licence blocker the prior agent missed.**

---

## 1. REFUTED: kfarms is BSL 1.1 — the same blocker that killed Armada

I read the actual LICENSE file. Nobody had checked it.

| | Armada (rejected) | **kfarms** |
|---|---|---|
| Licence | BSL 1.1 …"
    },
    {
      "type": "workflow_agent",
      "index": 17,
      "label": "licence:Kamino Farms (kfarms) — program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "ac7dc2307897201fc",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505492,
      "queuedAt": 1788319503819,
      "attempt": 1,
      "lastToolName": "WebSearch",
      "lastToolSummary": "Kamino farms-sdk CLI "create-farm" third party create own f…",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788319761939,
      "tokens": 72307,
      "toolCalls": 26,
      "durationMs": 255365,
      "resultPreview": "## VERDICT: the prior agent's licence report is ACCURATE. I could not break it.

I re-read the LICENSE from source and cross-checked it against live GitHub. All five BSL parameters match what was reported, verbatim. No carelessness found on the licence axis. But the check surfaced four things that report missed, one of which is a live trap.

---

### 1. The licence header, verbatim

From `C:\Users…"
    },
    {
      "type": "workflow_agent",
      "index": 18,
      "label": "security:Kamino Farms (kfarms) — program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
      "phaseIndex": 2,
      "phaseTitle": "Verify",
      "agentId": "a3d32ed56885af064",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788319505656,
      "queuedAt": 1788319503819,
      "attempt": 1,
      "lastToolName": "WebSearch",
      "lastToolSummary": "Kamino exploit",
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788320144680,
      "tokens": 111133,
      "toolCalls": 47,
      "durationMs": 638103,
      "resultPreview": "## ADVERSARIAL CHECK: Kamino Farms (kfarms) — result

I could not refute the clean exploit record. I did refute or materially correct four other claims, and I found one item the prior agent missed that is **disqualifying under the operator's own stated rules**.

---

## 0. THE HEADLINE — kfarms is BSL 1.1. Same blocker that killed Armada.

`https://raw.githubusercontent.com/Kamino-Finance/kfarms/m…"
    },
    {
      "type": "workflow_agent",
      "index": 19,
      "label": "design:decision-doc",
      "phaseIndex": 3,
      "phaseTitle": "Design",
      "agentId": "a68ccd9ce83239d5a",
      "model": "claude-opus-5",
      "state": "done",
      "startedAt": 1788320354839,
      "queuedAt": 1788320351556,
      "attempt": 1,
      "promptPreview": "GOAL. The operator runs memetics.finance. Their EVM staking (TegridyStaking.sol,
"TOWELI") has economics they want reproduced on Solana. They will NOT accept a
custom/unaudited program: the standing house rule is battle-tested code only.
Their words: "battle tested and never hacked billion dollar code".

THE TARGET ECONOMICS, read from the live contract (exact, verified):
  MIN_LOCK_DURATION      …",
      "lastProgressAt": 1788320674781,
      "tokens": 217086,
      "toolCalls": 0,
      "durationMs": 319941,
      "resultPreview": "# TOWELI on Solana — Rail Selection: Decision Document

**Prepared 2026-09-01. All on-chain figures read from `api.mainnet-beta.solana.com` around slot ~443,590,000 on 2026-09-01/02.**

---

## 1. The Answer

**Nothing off-the-shelf reproduces TOWELI.** No Solana program in existence gives you a fixed daily emission, a per-user penalized exit, *and* a lock-duration boost ladder on a codebase with …"
    }
  ],
  "totalTokens": 2260075,
  "totalToolCalls
---

# OPERATOR ADDENDUM — verified directly, 2026-09-01

The report above ends by saying a Token-2022 staked mint "kills the
recommendation outright" and must be checked first. I checked it. The answer
splits the island in two.

## Which bungalow mints are Token-2022

Read from mainnet (`getMultipleAccounts`, owner program per mint):

| Bungalow | Mint | Token program |
|---|---|---|
| **BAYLA** | `7hmVkPXm…qxpump` | **Token-2022** |
| BOBO | `4nV5gNww…Ezpump` | legacy SPL |
| SOY | `8zsZESzr…Qpump` | legacy SPL |
| BRAINLET | `4XKGjKaK…E9pump` | legacy SPL |
| RIZZ | `5ad4puH6…BS8k` | legacy SPL |

## kfarms cannot stake a Token-2022 mint — verified at the source line

`programs/kfarms/src/handlers/handler_stake.rs`:

- line 2: `use anchor_spl::token::{Mint, Token, TokenAccount};` — the LEGACY
  types, not `token_interface`.
- line 97: `pub token_program: Program<'info, Token>` — Anchor validates this
  account equals the legacy Token program id. A Token-2022 mint cannot satisfy
  it.

`token_interface` DOES appear in the repo, but only in the REWARD path
(`handler_initialize_reward`, `handler_add_reward`, `handler_harvest_reward`,
`handler_withdraw_reward`, `handler_withdraw_treasury`, `token_operations`,
`constraints`). So the asymmetry is: **kfarms can PAY a Token-2022 reward, but
cannot ACCEPT a Token-2022 stake.**

## What that means

- **The four legacy-SPL bungalows (BOBO, SOY, BRAINLET, RIZZ) can use kfarms**
  exactly as the report describes.
- **BAYLA — the flagship, and the whole reason this project exists — cannot.**
  There is no configuration that fixes it. The options for BAYLA are: stay on
  Streamflow (no early exit at any price, emissions unbounded in TVL), wrap
  BAYLA in a legacy-SPL wrapper (a custom program in the money path — the exact
  thing the house rule forbids), or fork kfarms onto `token_interface` (custom
  program, zero TVL, and the BSL/Apache question in §6).
- Note the reward asymmetry is still useful: a kfarms farm could pay BAYLA
  rewards to stakers of a legacy mint. It is the staking leg that is blocked.

**So the decision the report frames — give up the ladder, or give up the rule —
is only the decision for four of the five. For BAYLA the choice is narrower and
worse: keep Streamflow's no-exit rail, or break the rule.**

---

# ADDENDUM 2 — the LP route WORKS for BAYLA. Verified end to end, 2026-09-01.

Addendum 1 concluded BAYLA could not use kfarms. That conclusion was right about
SINGLE-SIDED staking and wrong as a general statement. There is a route that
gives BAYLA the full TOWELI shape on battle-tested code with no custom program.

## The dead end first, so nobody retries it

The obvious LP — **PumpSwap BAYLA/SOL** (`8z52phbc…pK2n`) — is NOT usable. Its
pool account decodes (base_mint = BAYLA, quote_mint = wSOL, which validates the
offsets) to **lp_mint `8qJs53HCeFbfHJ5QPbuQAX4nhh3ECUeggv3nbjunAUU9`, owned by
Token-2022.** pump.fun's AMM issues Token-2022 LP mints, so kfarms refuses it
for exactly the same reason it refuses BAYLA itself.

## The route that works

**Raydium CP-swap issues a LEGACY SPL LP mint even when a pool side is
Token-2022.** Verified in `raydium-io/raydium-cp-swap`,
`programs/cp-swap/src/instructions/initialize.rs`:

- lines 55 / 61 — `mint::token_program = token_0_program` / `token_1_program`:
  each POOL SIDE carries its own token program, so a Token-2022 base mint is
  accepted.
- line 76 — `mint::token_program = token_program` on `lp_mint`.
- line 151 — `pub token_program: Program<'info, Token>` — **`Token` is the
  LEGACY program.** So the LP mint is legacy SPL regardless of the sides.

And kfarms can PAY BAYLA. `handler_harvest_reward.rs` line 7 imports
`token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface,
TokenInterface}` and line 122 declares `reward_mint: Box<InterfaceAccount<
MintInterface>>` — Token-2022 capable.

Line 26 calls `validate_reward_token_extensions`, so the reward mint's
extensions must pass. **BAYLA's do**: read from mainnet, its only extensions are
`metadataPointer` and `tokenMetadata` — the inert pump.fun metadata pair. No
transfer fee, no transfer hook, no permanent delegate, no confidential
transfer. (Also: `mintAuthority` and `freezeAuthority` are both `None` — fixed
supply, and no one can freeze a holder's account.)

## The resulting product

1. Liquidity providers deposit into a **Raydium CP-swap BAYLA/SOL** pool and
   receive a **legacy SPL** LP token.
2. They stake that LP token in a **kfarms** farm — legal, because the staked
   mint is legacy.
3. They earn **BAYLA** — legal, because the reward path is `token_interface`
   and BAYLA's extensions are inert.

That yields, natively and with zero custom code: **fixed daily emissions**
(`RewardType::Proportional`, TVL-independent), a **per-user penalized exit**
(`apply_early_withdrawal_penalty`, decaying, swept to a `has_one`-pinned
treasury), and **lock durations** (farm-level; the ladder is still N farms plus
the RPS rebalancer from §4.3).

## What this costs, honestly

- **It is an LP product, not single-sided staking.** Holders take impermanent
  loss. That is a different risk profile and must be said plainly in the UI.
- **It needs a new pool.** BAYLA's liquidity is on PumpSwap today; a CP-swap
  pool either splits it or requires a migration. That is a liquidity decision,
  not a technical one.
- Raydium's protocol has been exploited twice historically (2022 key
  compromise; a 2026 legacy-AMM incident) — neither in CP-swap, but "never
  hacked" is not a claim that survives contact with the organisation's record.
- The kfarms lock+penalty path still has ~$0 mainnet exposure and has never
  been audited. That caveat from §5 is unchanged.
