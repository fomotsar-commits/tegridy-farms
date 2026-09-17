# BAYLA ladder — mainnet go-live checklist

**Status as of 2026-09-17: NOT READY. Do not move SOL yet. A REBUILD IS REQUIRED.**
(Updated 09-17: the devnet `withdraw_matured` precondition is now DONE — §3. Updated again
09-17: the owner decided a **75% early-exit penalty** and a **reload rate guard** for the
ladder, so the program changes, the mainnet artifact `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` is **SUPERSEDED**, and the
decisions are recorded in the next section. The hard gates in §1 and §2 still stand.)

This is the sequenced answer to "are we ready to load SOL, load the rewards, and get staking".
It is a companion to `solana/tegridy-amm/BAYLA_LADDER_MAINNET_RUNBOOK.md`, not a replacement:
the runbook has the exact commands, this file says what is actually true today, what is
blocking, and in what order to clear it.

Every claim below was checked against the chain, the machine, or a file at a line — not
inferred from a prior handoff. Where something was checked and found to be *fine*, it says so,
because an unrecorded "fine" gets re-litigated.

---

## The four-line summary

1. The code is **being rebuilt**: a 75% early-exit penalty and a reload rate guard
   ([#586](https://github.com/fomotsar-commits/tegridy-farms/pull/586)). That PR also moves
   the frontend's and the ops CLI's copies of the penalty to `7_500`, and tests read both
   back out of `math.rs`. The card renders nowhere until go-live (`VITE_BAYLA_LADDER_PROGRAM`
   is unset in every Vercel environment — checked 2026-09-17), so what must happen **in
   lockstep** is go-live itself: two environment variables and a redeploy (§6), pointed at a
   program that charges 75%.
2. The program is **not deployed**. The address is unclaimed, the deployer is being
   rotated, and the artifact built so far (`fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5`) is superseded.
3. The real blocker is **key custody quality**, not key custody existence — see §1.
4. **Rewards are one-way.** No instruction in the program returns BAYLA to the authority.
   Decide the amount as if you are spending it, because you are — and keep what is not yet
   scheduled in the multisig, not the vault.

---

## The 75% rebuild — decisions on record (2026-09-17)

Owner decisions. They are recorded here so they are not re-opened; the gates they create
are marked in the sections below.

| # | Decision | Where it bites |
|---|---|---|
| D1 | **Early-exit penalty 75% forfeited** (`EARLY_EXIT_PENALTY_BPS = 7_500`; the leaver keeps 25%). `emergency_withdraw` charges the same while locked; both early doors charge 0 once the pool is `degraded`. **Solana ladder only**: the EVM `LighthouseLadder.sol`, TOWELI and every EVM frontend file stay 25%. There is no TOWELI parity on the penalty. | §4, "What becomes irreversible" |
| D2 | **Reload rate guard.** While `now < period_finish`, `notify_reward` refuses a reload whose new rate is below the current `reward_rate`: error **6028 `RewardRateWouldDecrease`** (`math::rate_change_allowed(now, period_finish, old_rate, new_rate) = now >= period_finish \|\| new_rate >= old_rate`). At or after `period_finish` any rate is allowed. | §4 top-ups |
| D3 | **Key rotation — option (A)** (§1). A fresh deployer, generated outside any cloud-synced folder, is compiled into the rebuild. | §1, §5 |
| D4 | **The pool authority is a multisig before any funds.** The deployer creates the pool, hands the authority to the multisig, and only then is anything funded. | §5 |
| D5 | **Matured positions keep full boost indefinitely — disclosed, not changed.** Weight is frozen at stake time (`Position.weight` in `state.rs`) with no forced maturity, decay or kick (the `Pool.max_wallet_principal` doc in `state.rs`). A future upgrade MAY reset matured weight to 0.40x. | disclosure |
| D6 | **The program is upgradeable, and that is stated.** Upgrade authority: the Squads vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (runbook §3). Its **member set and time lock are unconfirmed** (runbook §3). A penalty change by upgrade would apply to every open position, because no account stores the rate. | disclosure |
| D7 | **Reward funding never stops.** No sunset, no wind-down: every window is reloaded before its `period_finish` (§4 reload policy). | §4 |
| D8 | **The Streamflow lighthouse pool and the ladder are separate products.** No migration, no integration. The Streamflow pool still needs its own funding through its last lock. | §4, §7 |

**What these decisions void or add:**

- **The 09-12 mainnet artifact is SUPERSEDED.** `.so` sha256
  `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` (CI run 34712334698)
  carries the 25% penalty, no rate guard, and the hot faucet key `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` as its
  compiled deployer. **Do not deploy it.** A rebuild from the audited commit, with the
  rotated deployer, is required (runbook §4).
- **The external audit must cover the constant change and the rate guard.** A sign-off on
  code from before them does not satisfy runbook §0's "deploy the exact commit the auditor
  signed off on" (§2).
- **The frontend must never point at a program charging a different rate.**
  `EARLY_EXIT_PENALTY_BPS` in `program.ts` is a separate literal from the program's `math.rs`
  constant (a test now reads one against the other), and nothing on chain exposes the rate,
  so a card built at one rate against a program at the other misquotes every early exit
  (§6).
- **Devnet must be upgraded to the 75% build before any preview environment points at
  it.** `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` still runs the 25% build with no rate
  guard. Every devnet penalty figure in the repo was measured on that superseded build;
  nothing has been measured at 75%.

---

## 0. Verified facts (so nobody re-checks these)

| Fact | Value | How it was checked |
|---|---|---|
| Program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | `BAYLA_LADDER_MAINNET_RUNBOOK.md` §1, and the local program keyfile derives to it exactly |
| Deployed on mainnet? | **No** | `getAccountInfo` → `null`, 2026-09-15 |
| Pool authority (compiled in) | `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` — **in the superseded `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` build only.** Rotated under option (A), D3: the rebuild compiles a fresh key, not yet recorded | `BAYLA_LADDER_MAINNET_RUNBOOK.md` §1 |
| Do we hold it? | **Yes** — `OneDrive\Desktop\faucet\main-keypair.json` | public half derived locally; matches exactly |
| Its balance | **0.0595 SOL** (a deployer needs ~2.62 — fund the **rotated** one, D3, not this key) | `getBalance`, 2026-09-15 |
| Program keypair | held, `solana-keys\mainnet\bayla_ladder-program.json` | derives to `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| `5MtoeJ8DXcgWZQJAgGgDefd5hbq4KAe3K47yL9Nc87vq` | **NOT the authority** — 0 SOL, never used on mainnet | a prior handoff wrongly named it; do not fund it |
| solana CLI | **4.1.1** — the version required for the 1× rent path | `solana --version` |
| Local CLI cluster | **devnet** | `.config\solana\cli\config.yml` — every command needs an explicit `--url`/`--rpc` |
| Mainnet artifact | **SUPERSEDED — do not deploy.** 25% penalty, no rate guard, hot faucet deployer. A rebuild is required. (It was live, expiring 2026-10-12.) | `gh api …/artifacts` → `expired=false`, 2026-09-15 |
| `.so` sha256 | `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` — **SUPERSEDED** | CI run 34712334698 |
| BAYLA mint | Token-2022, 6 decimals, mint gate passes | re-read 2026-09-15 |

**A correction worth recording.** An earlier pass in this session concluded we did not hold
`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`, having searched `C:\Users\jimbo\solana-keys\`, `.config\solana\` and the repo's
`keys/` directory. That was wrong. The key has never lived in any of those — it is the
SolanaDevnetFaucet bot's wallet, and `docs/BAYLA_BUNGALOW.md:293-298` already said so. Absence
from the three places one thinks to look is not absence.

---

## 1. 🔴 HARD GATE — the pool authority is a hot faucet key in a cloud-synced folder

This is the one that should stop the deploy, and it is already on file as **C3 / CRITICAL** in
`docs/LIGHTHOUSE_AUDIT_2026_09_01.md:78-89`.

The key compiled into the superseded mainnet binary (`BAYLA_LADDER_MAINNET_RUNBOOK.md` §1)
as the only caller of `initialize_pool` — and which becomes `pool.authority` — is the devnet faucet bot's wallet, stored **in plaintext inside the
OneDrive sync root**, and the `SolanaDevnetFaucet` scheduled task is still **State: Ready** on
a 2-hour trigger. It is held off only by a `DISABLED` marker file the script must voluntarily
honour (`faucet\src\run.js:13-16`).

The runbook's own precondition (§0) says both keyfiles must be backed up offline,
*"Not to OneDrive or any cloud folder in plaintext."* That box is unticked, and this key
violates its spirit today.

**What bounds the damage** (read before panicking): no pool-authority signature can move a
token out of either vault — every payout destination in the program is an `owner_ata`
constrained to a signing owner (every `owner_ata` constraint in `lib.rs`). The upgrade authority, which
is the real power, goes to the Squads vault. And the authority is transferable after init via
two-step `propose_authority` / `accept_authority`.

**DECIDED 2026-09-17: (A).** Written down here and as D3. Not yet executed: no fresh
deployer pubkey is recorded in the repo, and the rebuild has not run. And, separately (D4),
the **pool authority is handed to a multisig before any funds** — the bound above says what
a stolen authority key can take, not what it can do (`declare_degraded` is one-way and
waives every early penalty, including on the thief's own locked positions).

The two options as they were weighed:

- **(A) Rotate before deploying — recommended, and CHOSEN.** Generate a fresh deployer on a
  clean path outside any cloud-synced folder, re-run the artifact build with that pubkey as
  `deployer`, and use it. Cost: one CI run, and the current `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` artifact is void —
  which the 75% rebuild requires anyway.
- **(B) Deploy with `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`, rotate the authority immediately after init — NOT
  taken.** Cheaper, but the hot key is the sole authority during the deploy window, and the runbook records that a
  Squads vault **cannot** sign the CLI's `accept-authority` — that half must be driven from
  inside the Squads app.

**Either way, before anything:** delete the `SolanaDevnetFaucet` scheduled task outright rather
than trusting the marker file, and move `OneDrive\Desktop\faucet\` out of the sync tree.

---

## 2. 🔴 HARD GATE — the runbook's own go/no-go is unsatisfied

`BAYLA_LADDER_MAINNET_RUNBOOK.md` §0 is an explicit precondition list — *"all of them,
before anything costs SOL."* **Five of ten boxes are unchecked.** (It was five of seven
until 2026-09-17, when the devnet `withdraw_matured` box was ticked with evidence — §3. The
75% rebuild then added three: the penalty and the deployer rotation, both decided, and the
multisig pool authority, still open.)

- the external audit report being in, with every fix merged — its *"write the hash here:
  `________`"* line is still literally blank, **and the audited commit must now contain the
  75% constant and the rate guard**;
- both keyfiles backed up offline (see §1);
- the pool authority handed to a multisig before any funds (D4);
- a keyed mainnet RPC;
- ~3 SOL in the deployer — the **rotated** deployer (D3).

**The external audit must cover the constant change and the rate guard.** Both are
program changes made after the 2026-09-06 internal audit: `EARLY_EXIT_PENALTY_BPS` moves
from 2_500 to 7_500 (it prices both early doors), and `notify_reward` gains a refusal
(6028). A sign-off on code from before them — or on the superseded `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` build —
does not satisfy the runbook's "deploy the exact commit the auditor signed off on".

**And the audit scope is unconfirmed.** `AUDIT_RFQ.md:3-12` and `AUDIT_OUTREACH.md:17,24` scope
only `cp-swap` (Scope A) and `tegridy-launch` (Scope B). **`bayla-ladder` appears in neither** —
grepping `AUDIT_OUTREACH.md` for "ladder" returns nothing. The only evidence of a ladder audit
anywhere in the repo is one unverifiable sentence at `BAYLA_LADDER_DEVNET_RUNBOOK.md` §9
item 4 ("the owner reports an external audit is underway"), and no report is committed.

The internal audit's own sequencing verdict was **devnet → external audit → mainnet**
(`BAYLA_LADDER_DEVNET_RUNBOOK.md`, the paragraph after the executed-run record), and
`AUDIT_OUTREACH.md:46` says *"A mainnet deploy is gated on this audit."*

**Owner action:** state where the external audit actually stands — engaged, scoped, in
progress, or not started. If a report exists, commit it and write the signed-off commit hash
into the blank in runbook §0. If it is not in, deploying means overriding the repo's own stated
gate, which is what happened on 2026-08-08 and cost two program ids. That is a decision you are
entitled to make — but make it explicitly, in writing, rather than by omission.

---

## 3. Do these now — they are ready, cost nothing, and shorten the critical path

- [x] **Run `withdraw_matured` on devnet — ✅ DONE 2026-09-17.** The ordinary exit every
      staker will use had never executed on any cluster; it now has. Finalized tx
      `4AYtGTnHvSV3bCuaq4nhQPSLnvbc6pnJJfaNY7SqC2FeR2QYQK3ukdwJbAzFjEXNynWYxpBHP9pgRkPYSyAZWeAf`,
      read back on chain: **500 returned, penalty 0**, `penalty_collected_cumulative`
      **250 → 250**, `total_principal` **1,000 → 500**, and the `rewards_paid` delta equals the
      `RewardPaid` amount to the raw unit. Full table and the corrected command in
      `docs/TODO_OPERATOR.md` O-0909-1 — **the command previously recorded there did not run**:
      it omitted `--program` (devnet id `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK`,
      verified on chain as the pool's owner).
      ⚠️ **Measured on the superseded 25% build.** The `250 → 250` is two 25% penalties of
      125 from the 09-09 run. The matured door passes a zero penalty whatever the rate
      (`withdraw_matured` calls `exit_with_penalty(ctx, now, 0)`), so "500 returned,
      penalty 0" carries over to the 75% build; the 250 does not, and nothing has been
      measured at 75%.
- [ ] ~~**Download the mainnet artifact and verify its hash.**~~ **SUPERSEDED 2026-09-17 —
      do not download or deploy `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5`** (25% penalty, no rate guard, hot faucet
      deployer). Instead, once the audited commit contains the 75% constant and the rate
      guard, **rebuild** it with the rotated deployer (runbook §4) and verify the new
      artifact's hash. GitHub deletes an artifact 30 days after its run.
      ⚠️ The only `.so` on this machine today is the **devnet** one
      (`3e1b2b7b68292d92ef83e479a938c49aeda3480d4a3bbc58500cf166f6061ebd`), and the binaries have been the same size — verify by **hash**, never by
      filename or size.
- [ ] **Back up both mainnet keyfiles offline** — `solana-keys\mainnet\` holds a single
      unreplicated copy of each. Losing `bayla_ladder-program.json` *before* deploy means a new
      program id and a rebuild; after deploy it costs nothing, because the address is claimed.
- [ ] **Delete the `SolanaDevnetFaucet` scheduled task** and move the faucet folder out of
      OneDrive (§1).
- [ ] **Obtain a keyed mainnet RPC URL.** The public endpoint will rate-limit a deploy.

---

## 4. The economic decisions — only the owner can make these

### Rewards are one-way. There is no clawback.

The program exposes 15 instructions and **not one moves a token to the authority**.
`recover_tokens`, `close_pool` and a treasury-facing `sweep_penalty` are named in the module
docs as *deliberately* absent (the `lib.rs` module header). Every BAYLA that enters the reward vault leaves
only as a staker's reward.

### It is a different reward shape from Streamflow — which is why no APR is quoted

| | Streamflow (the separate lighthouse pool) | bayla-ladder |
|---|---|---|
| Shape | rate **per staked token** | Synthetix: a **fixed pool-wide budget** per window |
| Emission | scales with TVL — which is why that vault runs dry | capped by what you loaded |
| Per-staker yield | roughly independent of others | **dilutes** as others stake |

Quoting a Streamflow-style APR on a Synthetix pool will be wrong the moment TVL moves. Hence
the reload policy's rule below: **publish dates, never rates or APRs.**

### Where a penalty goes

A forfeited penalty is not paid to anyone on the way out. It is **forfeited to the reward
pool and scheduled into a later window by the operator, then shared by weight among whoever
is staked then.** `early_exit` moves it into the reward vault in the same instruction; the
hatch leaves it in the stake vault as `orphaned_penalty` until the permissionless `sweep`
carries it across. Either way it earns nobody anything until a `notify` schedules it with
`from_budget`.

### Reload policy — funding never stops (D7)

Operator policy; the program enforces none of it except the rate guard.

- **Reload every ~60–75 days, BEFORE `period_finish`,** with an amount that holds the rate:
  at least `reward_rate × seconds elapsed since the last notify`. Each reload starts a
  fresh 90 days, so the pool never lapses to a zero rate. There is no sunset and no
  wind-down.
- **Never fund an empty pool — stakers first.** A second in which nothing is staked emits
  nothing (`math::reward_per_weight_with_residue` leaves the accumulator unchanged while
  `total_weighted` is 0), so a window funded ahead of its stakers spends its clock on
  nobody.
- **Keep the first window small.** Loaded BAYLA is one-way, and the rate guard means a rate
  set too high cannot come down until that window's `period_finish`.
- **Keep the undeployed reward runway in the multisig, not the vault.**
- **Recycle penalties at the regular reload**, as `from_budget` beside fresh capital.
  Mid-window penalty-only reloads are refused unless they alone cover
  `reward_rate × elapsed` (see "Top-ups inside a window" below).
- **Publish dates, never rates or APRs.**

The exact commands and arithmetic are in runbook §8 and §11.

### How much BAYLA

The program's floors are trivial — they are not guidance:

- **Absolute minimum** 7,776,000 raw = **7.776 BAYLA** per 90-day window, below which the
  integer rate floors to zero and `notify` is refused (`RewardRateTooSmall`).
- A second floor applies only when the pool is non-empty: `rate × 1e12 >= total_weighted`.
- For scale: the separate Streamflow pool held **3,235,286 BAYLA across 18 positions / 9
  wallets** on 2026-09-12 (runbook §6). It is a sizing reference, not a migration cohort —
  nothing moves from that pool (D8).

**The number is an economic decision, not a technical one.**

### Top-ups inside a window cannot lower the rate — they are refused (D2)

A `notify` before `period_finish` resets `period_finish` to a fresh 90 days and folds the
un-emitted tail into a new rate:
`rate = (scheduled + remaining_secs × old_rate) / 7,776,000` (`math::new_reward_rate`).

On the superseded build that fold could **lower** the rate: a *small* top-up 80 days in took
the ~10 days of budget still to run and re-spread it over a fresh 90. **The rebuild refuses
that call.** While `now < period_finish`, if the folded rate is below the current
`reward_rate`, `notify_reward` fails with **6028 `RewardRateWouldDecrease`**
(`math::rate_change_allowed`, checked after every other refusal and before the rate is
written). Equivalently: a mid-window reload must schedule at least
`reward_rate × seconds elapsed since the last notify`. Exactly that holds the rate; more
raises it.

So a small late top-up is **rejected, not silently diluting**. Either top up enough to hold
the rate, or wait for `period_finish`, after which any rate is accepted — at the cost of a
gap in emission for as long as the reload waits. The guard also closes the grind a copied
authority key could otherwise run for free: `notify_reward(0, 1)` over and over, lowering
the rate each time while every solvency check still passed.

### ⚠️ Size a top-up from `read`'s `outstanding (LIVE)` and its I-4 verdict — never the stored figure

`rewards_emitted` is banked **lazily**, only when an instruction runs `checkpoint()`, so the
stored `rewards_emitted − rewards_paid` leaves out every second of emission since the last
interaction. The ops `read` command prints both figures:

- `outstanding (stored)` — banked emitted − paid, as the account holds it. **Stale on a
  quiet pool; do not size anything from it.**
- `outstanding (LIVE)` — what the pool owes at chain now: `checkpoint` replayed exactly
  (both residue carries and the burn branch), with the un-banked part printed beside it as
  `emitted since then`.

`read` then judges invariant I-4 (reward vault ≥ what the pool owes) against the **LIVE**
figure. `invariant I-4 holds: reward vault >= live outstanding` is the only pass.
`INVARIANT I-4 BROKEN: live outstanding > reward vault` and
`INVARIANT I-4 UNVERIFIED: the reward vault could not be read.` both make `read` exit 1;
an unverified row is an outage, not a pass. `notify` and `notify --preview` print the same
live figure as `owed (LIVE)`.

**Why this matters — found running the devnet test on 2026-09-17**, with the CLI as it was
before #588, which printed only the stored figure, as "outstanding owed". The devnet pool
had not been touched since 2026-09-09 09:57:24. `read` said **0.019 BAYLA** owed; the true
liability was **~4,275 BAYLA** — 7.70 days of un-banked emission. The dry run's 1,995-BAYLA
payout looked like a ~100,000× overpay until the pool account was decoded, at which point it
reconciled to within 0.012% of position #2's 46.68% weight share. #588 replaced that line
with the two above.

**The program is safe** — `notify_reward` calls `checkpoint()` before computing `outstanding`
and before both solvency `require!`s (in `notify_reward` itself), so the on-chain
guard always sees the real liability. The risk was purely an operator misreading the display
when deciding how much to top up, or whether the vault is covered.

A hand cross-check, not a replacement for the LIVE line:

`rewards_emitted + reward_rate × (min(now, period_finish) − last_update_time) − rewards_paid`

It agrees with `outstanding (LIVE)` to within rounding while stakers are in the pool. While
`total_weighted` is below `min_weight_floor(min_stake)` — an empty pool — it **overstates**
by the whole `reward_rate × (min(now, period_finish) − last_update_time)` term: the program
burns those seconds instead of emitting them (I-11; `math::reward_per_weight_with_residue`
returns the accumulator unchanged), and the CLI's replay does the same.

### Two pool parameters are permanent — and so is the penalty

(Corrected 2026-09-17: this section used to name `deposit_cap` and the penalty as the two
setter-less values. `deposit_cap` HAS a raise path — `propose_cap_raise` / `execute_cap_raise`,
both in `lib.rs` — and the `math.rs` constant is only the penalty.)

- **`min_stake` and `max_wallet_principal` have no setter** (runbook §6): written once in
  `initialize_pool`, never changed.
- **The early-exit penalty is a compile-time constant with no setter: 75% forfeited, 25%
  returned** (`EARLY_EXIT_PENALTY_BPS = 7_500` in `math.rs`, from #586, merged on trunk as
  `be20d8073fff0ab8d6ead3f5c4ff3791d91e9845`; only the superseded devnet deployment
  `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` and the superseded
  `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` artifact still carry
  `2_500`). Only a program upgrade through the Squads vault
  could change it (D6).
- **`deposit_cap` only rises,** 48 hours after `propose_cap_raise`, via the permissionless
  `execute_cap_raise`, which **has never succeeded anywhere**.

The values were sized against the separate Streamflow pool as a demand reference (runbook
§6); re-read that pool on the day if you want a fresher reference, but nothing migrates
from it (D8).

---

## 5. The sequence, and which key signs each step

Nothing here is runnable until §1 and §2 are resolved.

| # | Step | Signs | Notes |
|---|---|---|---|
| 1 | Resolve key custody | — | §1. **Decided: rotate (A)** — generate the fresh deployer outside any cloud-synced folder |
| 2 | Resolve audit scope | — | §2 — must cover the 75% constant and the rate guard |
| 3 | `withdraw_matured` on devnet | `devnet-deploy.json` | ✅ **done 2026-09-17** — §3 (on the superseded 25% build) |
| 4 | Rebuild the artifact from the audited commit | — | runbook §4, `deployer` = the rotated key. **Never `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5`** |
| 5 | Fund the deployer ~3 SOL | — | ~2.62 needed; the **rotated** deployer — never `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` or `5MtoeJ8DXcgWZQJAgGgDefd5hbq4KAe3K47yL9Nc87vq` |
| 6 | `solana config set` → mainnet | — | CLI is on **devnet** right now |
| 7 | `solana program deploy` | program keypair **+ fee payer** | fee payer becomes initial upgrade authority |
| 8 | Verify deployed bytes | — | `program dump` + hash vs the **rebuilt** artifact's sha256 (never `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5`) |
| 9 | Transfer upgrade authority → Squads | current upgrade authority | |
| 10 | `init-pool` | **the rotated deployer only** | sets `pool.authority` to itself; reward vault is a program PDA, rent 0.0062 SOL |
| 11 | Hand the pool authority → multisig | deployer proposes; multisig accepts **inside its own app** | D4 — **before any funds**. Confirm with `read` |
| 12 | Two Vercel vars + **redeploy** | — | §6 — the build must carry the 75% frontend constant |
| 13 | Let stakers arrive, then `notify` (fund rewards) | the multisig pool authority | one-way; never an empty pool; small first window — §4 |
| 14 | Reload every ~60–75 days, before `period_finish` | the multisig pool authority | never lapses — §4 reload policy |
| 15 | Register addresses | — | §7 |

⚠️ The ops CLI **defaults to devnet** (the `--rpc` default in `bayla-ladder-ops.mjs`). Every mainnet command needs
an explicit `--rpc`, or it will silently address the wrong cluster. Dry-run first — the
simulation runs against the real mint and program, so it doubles as the final mint check.

---

## 6. Frontend — one constant, in lockstep with the program

This is still mostly good news. The entire ladder stack is merged on trunk:
`SolanaLadderPoolLive.tsx`, `src/lib/ladder/{program,ix,read,write,format}.ts`, the lazy
import, and the registry field. **265 tests pass** (verified by running them, not inferred
from a glob — 2026-09-15, before the 75% decision).

**The one code change is carried by #586:** the card's penalty constant
(`EARLY_EXIT_PENALTY_BPS` in `frontend/src/lib/ladder/program.ts`) becomes `7_500`. It is a
separate literal from the program's `math.rs` constant, and the ops CLI carries a third
(`EARLY_EXIT_PENALTY_BPS` in `frontend/scripts/bayla-ladder-ops.mjs`); #586's tests read
both back out of `math.rs`, so they cannot drift from the source. Nothing on chain exposes
the rate — the IDL has no constants and no account stores it — so the card cannot read the
truth; it can only be built to match. Merging #586 changes nothing anyone sees, because the
card is not mounted in any Vercel environment. What must happen **in lockstep** is the
go-live below: the two variables go in only once the program they name charges 75%. A card at one rate in front of a program at the other misquotes every
early exit, in the direction that matters: at 25% copy over a 75% program it tells a
leaver they keep three times what they do.

**Devnet must be upgraded to the 75% build before any preview environment points at it.**
`HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` still runs the superseded 25% build with no rate guard, so a Preview pointed at
the devnet pool with a 75% frontend would misquote the same way in reverse.

Then two variables, then a redeploy:

| Variable | Value | Behaviour if unset |
|---|---|---|
| `VITE_BAYLA_LADDER_PROGRAM` | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | `ladderProgramId()` **throws** |
| `VITE_BAYLA_LADDER_POOL` | the pool PDA printed by `init-pool` | card simply does not mount |

- **They fail differently** — set both, or neither. `VITE_BAYLA_LADDER_POOL` has **no
  fallback**, deliberately the opposite shape to its Streamflow sibling.
- `VITE_` values are **baked at build time** — setting them changes nothing until a new build
  runs. Set them on **Preview first** and test on a preview URL while production is unchanged.
- **Both cards render at once.** The Streamflow card is not replaced; `depositsClosed` is read
  only inside `LighthousePoolLive.tsx` and is completely independent of the ladder.
- No change needed to the `/api/solrpc` method allowlist — the ladder read layer deliberately
  avoids `getProgramAccounts` and batches `getMultipleAccounts` instead.

⚠️ **Working-tree caution:** none of these files exist on `feat/island-wave-seven-arrival`.
They are on `mvp-launch` only. Branch from trunk.

---

## 7. After launch

- [ ] Register the program id and pool PDA in `addresses.json` — **neither is there today**, so
      the daily on-chain registry check currently covers none of this.
- [ ] Add gates for both new variables to `verify-env.mjs` — it has none.
- [ ] Create the `bayla-ladder-mainnet` tag. It is deliberately uncreated: it records what was
      *deployed*, and nothing is.
- [x] **No migration — DECIDED 2026-09-17 (D8).** The Streamflow lighthouse pool and the
      ladder are separate products; nobody's position is moved or announced as moving. The
      Streamflow pool keeps running and **still needs its own reward funding through its
      last lock** — the ladder's reloads do not cover it.
- [ ] **Reload the ladder before every `period_finish`** — the first reload ~60–75 days
      after the first `notify`, and every window after (D7, §4). Publish the date, not a
      rate.
- [ ] When registering the ladder in `addresses.json`, its `role` says **75%** early-exit
      penalty — not the 25% of the EVM `LighthouseLadder.sol` entries it may be copied
      from (runbook §10).

---

## What becomes irreversible

- **BAYLA in the reward vault.** No clawback, ever.
- **`pool.authority`**, until a two-step propose/accept completes. Loss is final.
- **`min_stake`, `max_wallet_principal`, and the 75% early-exit penalty** — no setter.
  (`deposit_cap` can only go up. The penalty could change only by a program upgrade, and
  that would reach every open position.)
- **A rate set too high** stays until that window's `period_finish` (up to 90 days): the
  rate guard refuses a mid-window reload that lowers it.
- **`declare_degraded`** is one-way and closes the pool to new stakes.
- **The program id**, once the address is claimed.

---

*Assembled 2026-09-15 from a 25-agent readiness audit (61 checklist items, blockers
adversarially verified), plus direct on-chain reads and local key derivation. Every "verified"
claim in §0 was re-checked by hand. Where this file and a prior handoff disagree, this file
states how it was checked — prefer the one with a method. Updated 2026-09-17 for the 75%
rebuild's decisions; nothing in that update was measured on chain, because nothing has
run at 75% anywhere.*
