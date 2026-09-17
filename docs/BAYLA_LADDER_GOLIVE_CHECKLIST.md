# BAYLA ladder — mainnet go-live checklist

**Status as of 2026-09-17: NOT READY. Do not move SOL yet.** (Updated 09-17: the devnet
`withdraw_matured` precondition is now DONE — §3. The two hard gates in §1 and §2 are unchanged.)

This is the sequenced answer to "are we ready to load SOL, load the rewards, and get staking".
It is a companion to `solana/tegridy-amm/BAYLA_LADDER_MAINNET_RUNBOOK.md`, not a replacement:
the runbook has the exact commands, this file says what is actually true today, what is
blocking, and in what order to clear it.

Every claim below was checked against the chain, the machine, or a file at a line — not
inferred from a prior handoff. Where something was checked and found to be *fine*, it says so,
because an unrecorded "fine" gets re-litigated.

---

## The four-line summary

1. The code is done. **No frontend change is required** — go-live is two environment variables
   and a redeploy.
2. The program is **not deployed**. The address is unclaimed and the deployer is unfunded.
3. The real blocker is **key custody quality**, not key custody existence — see §1.
4. **Rewards are one-way.** No instruction in the program returns BAYLA to the authority.
   Decide the amount as if you are spending it, because you are.

---

## 0. Verified facts (so nobody re-checks these)

| Fact | Value | How it was checked |
|---|---|---|
| Program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | `BAYLA_LADDER_MAINNET_RUNBOOK.md:120`, and the local program keyfile derives to it exactly |
| Deployed on mainnet? | **No** | `getAccountInfo` → `null`, 2026-09-15 |
| Pool authority (compiled in) | `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` | `BAYLA_LADDER_MAINNET_RUNBOOK.md:37` |
| Do we hold it? | **Yes** — `OneDrive\Desktop\faucet\main-keypair.json` | public half derived locally; matches exactly |
| Its balance | **0.0595 SOL** (needs ~2.62) | `getBalance`, 2026-09-15 |
| Program keypair | held, `solana-keys\mainnet\bayla_ladder-program.json` | derives to `EJLP5GEJ…` |
| `5MtoeJ8D…` | **NOT the authority** — 0 SOL, never used on mainnet | a prior handoff wrongly named it; do not fund it |
| solana CLI | **4.1.1** — the version required for the 1× rent path | `solana --version` |
| Local CLI cluster | **devnet** | `.config\solana\cli\config.yml` — every command needs an explicit `--url`/`--rpc` |
| Mainnet artifact | live, **expires 2026-10-12** (27 days) | `gh api …/artifacts` → `expired=false` |
| `.so` sha256 | `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` | CI run 34712334698 |
| BAYLA mint | Token-2022, 6 decimals, mint gate passes | re-read 2026-09-15 |

**A correction worth recording.** An earlier pass in this session concluded we did not hold
`GCCSLE7d…`, having searched `C:\Users\jimbo\solana-keys\`, `.config\solana\` and the repo's
`keys/` directory. That was wrong. The key has never lived in any of those — it is the
SolanaDevnetFaucet bot's wallet, and `docs/BAYLA_BUNGALOW.md:293-298` already said so. Absence
from the three places one thinks to look is not absence.

---

## 1. 🔴 HARD GATE — the pool authority is a hot faucet key in a cloud-synced folder

This is the one that should stop the deploy, and it is already on file as **C3 / CRITICAL** in
`docs/LIGHTHOUSE_AUDIT_2026_09_01.md:78-89`.

The key compiled into the mainnet binary (`BAYLA_LADDER_MAINNET_RUNBOOK.md:37`) as the only caller of `initialize_pool` — and which
becomes `pool.authority` — is the devnet faucet bot's wallet, stored **in plaintext inside the
OneDrive sync root**, and the `SolanaDevnetFaucet` scheduled task is still **State: Ready** on
a 2-hour trigger. It is held off only by a `DISABLED` marker file the script must voluntarily
honour (`faucet\src\run.js:13-16`).

The runbook's own precondition (`:20-22`) says both keyfiles must be backed up offline,
*"Not to OneDrive or any cloud folder in plaintext."* That box is unticked, and this key
violates its spirit today.

**What bounds the damage** (read before panicking): no pool-authority signature can move a
token out of either vault — every payout destination in the program is an `owner_ata`
constrained to a signing owner (`lib.rs:1125, 1158, 1194, 1216`). The upgrade authority, which
is the real power, goes to the Squads vault. And the authority is transferable after init via
two-step `propose_authority` / `accept_authority` (`lib.rs:837-859`).

**Pick one, and write the choice down:**

- **(A) Rotate before deploying — recommended.** Generate a fresh deployer on a clean path
  outside any cloud-synced folder, re-run the artifact build with that pubkey as `deployer`,
  and use it. Cost: one CI run, and the current `fada8148…` artifact is void.
- **(B) Deploy with `GCCSLE7d…`, rotate the authority immediately after init.** Cheaper, but
  the hot key is the sole authority during the deploy window, and the runbook records that a
  Squads vault **cannot** sign the CLI's `accept-authority` — that half must be driven from
  inside the Squads app.

**Either way, before anything:** delete the `SolanaDevnetFaucet` scheduled task outright rather
than trusting the marker file, and move `OneDrive\Desktop\faucet\` out of the sync tree.

---

## 2. 🔴 HARD GATE — the runbook's own go/no-go is unsatisfied

`BAYLA_LADDER_MAINNET_RUNBOOK.md:13-30` is an explicit precondition list — *"all of them,
before anything costs SOL."* **Four of seven boxes are unchecked** (it was five until
2026-09-17, when the devnet `withdraw_matured` box was ticked with evidence — §3):

- the external audit report being in, with every fix merged — its *"write the hash here:
  `________`"* line is still literally blank;
- both keyfiles backed up offline (see §1);
- a keyed mainnet RPC;
- ~3 SOL in the deployer.

**And the audit scope is unconfirmed.** `AUDIT_RFQ.md:3-12` and `AUDIT_OUTREACH.md:17,24` scope
only `cp-swap` (Scope A) and `tegridy-launch` (Scope B). **`bayla-ladder` appears in neither** —
grepping `AUDIT_OUTREACH.md` for "ladder" returns nothing. The only evidence of a ladder audit
anywhere in the repo is one unverifiable sentence at `BAYLA_LADDER_DEVNET_RUNBOOK.md:514-516`
("the owner reports an external audit is underway"), and no report is committed.

The internal audit's own sequencing verdict was **devnet → external audit → mainnet**
(`:56-59`), and `AUDIT_OUTREACH.md:46` says *"A mainnet deploy is gated on this audit."*

**Owner action:** state where the external audit actually stands — engaged, scoped, in
progress, or not started. If a report exists, commit it and write the signed-off commit hash
into the blank at `:16`. If it is not in, deploying means overriding the repo's own stated
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
- [ ] **Download the mainnet artifact and verify its hash.** 27 days on the clock.
      ⚠️ The only `.so` on this machine today is the **devnet** one
      (`3e1b2b7b…`), and the two binaries are the same size — verify by **hash**, never by
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
docs as *deliberately* absent (`lib.rs:92-95`). Every BAYLA that enters the reward vault leaves
only as a staker's reward.

### It is a different reward shape from Streamflow — settle this before quoting an APR

| | Streamflow (the old pool) | bayla-ladder (the new one) |
|---|---|---|
| Shape | rate **per staked token** | Synthetix: a **fixed pool-wide budget** per window |
| Emission | scales with TVL — which is why that vault runs dry | capped by what you loaded |
| Per-staker yield | roughly independent of others | **dilutes** as others stake |

Quoting a Streamflow-style APR on a Synthetix pool will be wrong the moment TVL moves.

### How much BAYLA

The program's floors are trivial — they are not guidance:

- **Absolute minimum** 7,776,000 raw = **7.776 BAYLA** per 90-day window, below which the
  integer rate floors to zero and `notify` is refused (`RewardRateTooSmall`).
- A second floor applies only when the pool is non-empty: `rate × 1e12 >= total_weighted`.
- For scale: the measured migration cohort is **3,235,286 BAYLA across 18 positions / 9
  wallets** (`runbook:206-219`, measured 2026-09-12).

**The number is an economic decision, not a technical one.**

### The top-up trap

A mid-window top-up **resets `period_finish` to a fresh 90 days unconditionally** and folds the
un-emitted tail into a new rate:
`rate = (scheduled + remaining_secs × old_rate) / 7,776,000` (`lib.rs:824-826`, `math.rs:295-299`).

So a *small* top-up 80 days in takes the ~10 days of budget still to run and re-spreads it over
a fresh 90 — **lowering** the instantaneous rate. Top-ups are not free; size them deliberately.

### ⚠️ Do not size a top-up from `read`'s "outstanding owed" — it is stale

Found running the devnet test on 2026-09-17. `rewards_emitted` is banked **lazily**, only when
an instruction runs `checkpoint()`, and the ops `read` command prints
`rewards_emitted − rewards_paid` as "outstanding owed". On a quiet pool that leaves out every
second of emission since the last interaction.

Measured: the devnet pool had not been touched since 2026-09-09 09:57:24. `read` said
**0.019 BAYLA** owed; the true liability was **~4,275 BAYLA** — 7.70 days of un-banked
emission. The dry run's 1,995-BAYLA payout looked like a ~100,000× overpay until the pool
account was decoded, at which point it reconciled to within 0.012% of position #2's 46.68%
weight share.

**The program is safe** — `notify_reward` calls `checkpoint()` before computing `outstanding`
and before both solvency `require!`s (`lib.rs:752`, checkpoint at `:763`), so the on-chain
guard always sees the real liability. The risk is purely an operator misreading the display
when deciding how much to top up, or whether the vault is covered. Use instead:

`rewards_emitted + reward_rate × (min(now, period_finish) − last_update_time) − rewards_paid`

(Straight after `init-pool` nothing has emitted, so the runbook §7 `read` is accurate there.
Correcting the display itself is an ops-script change, not made here.)

### Two pool parameters are permanent

`deposit_cap` and the early-exit penalty have no setter (`math.rs:72-75`). The cap can only be
raised via `execute_cap_raise`, which **has never succeeded anywhere**. Re-confirm both against
the Streamflow pool on the day, because the number they were sized against has already moved
once.

---

## 5. The sequence, and which key signs each step

Nothing here is runnable until §1 and §2 are resolved.

| # | Step | Signs | Notes |
|---|---|---|---|
| 1 | Resolve key custody | — | §1. Rotate or accept, in writing |
| 2 | Resolve audit scope | — | §2 |
| 3 | `withdraw_matured` on devnet | `devnet-deploy.json` | ✅ **done 2026-09-17** — §3 |
| 4 | Fund the deployer ~3 SOL | — | ~2.62 needed; **`GCCSLE7d…`**, never `5MtoeJ8D…` |
| 5 | `solana config set` → mainnet | — | CLI is on **devnet** right now |
| 6 | `solana program deploy` | program keypair **+ fee payer** | fee payer becomes initial upgrade authority |
| 7 | Verify deployed bytes | — | `program dump` + hash vs `fada8148…` |
| 8 | Transfer upgrade authority → Squads | current upgrade authority | |
| 9 | `init-pool` | **`GCCSLE7d…` only** | sets `pool.authority` to itself; reward vault is a program PDA, rent 0.0062 SOL |
| 10 | `notify` (fund rewards) | pool authority | one-way — see §4 |
| 11 | Two Vercel vars + **redeploy** | — | §6 |
| 12 | Register addresses | — | §7 |

⚠️ The ops CLI **defaults to devnet** (`bayla-ladder-ops.mjs:698`). Every mainnet command needs
an explicit `--rpc`, or it will silently address the wrong cluster. Dry-run first — the
simulation runs against the real mint and program, so it doubles as the final mint check.

---

## 6. Frontend — no code change required

This is the good news. The entire ladder stack is merged on trunk: `SolanaLadderPoolLive.tsx`,
`src/lib/ladder/{program,ix,read,write,format}.ts`, the lazy import, and the registry field.
**265 tests pass** (verified by running them, not inferred from a glob).

Two variables, then a redeploy:

| Variable | Value | Behaviour if unset |
|---|---|---|
| `VITE_BAYLA_LADDER_PROGRAM` | `EJLP5GEJ…` | `ladderProgramId()` **throws** |
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
- [ ] Plan the migration of the 18 Streamflow positions. Locks cannot be carried across —
      Streamflow has no migration between pools — so the old pool stays open until the last
      lock matures.

---

## What becomes irreversible

- **BAYLA in the reward vault.** No clawback, ever.
- **`pool.authority`**, until a two-step propose/accept completes. Loss is final.
- **`deposit_cap` and the early-exit penalty** — no setter.
- **`declare_degraded`** is one-way and closes the pool to new stakes.
- **The program id**, once the address is claimed.

---

*Assembled 2026-09-15 from a 25-agent readiness audit (61 checklist items, blockers
adversarially verified), plus direct on-chain reads and local key derivation. Every "verified"
claim in §0 was re-checked by hand. Where this file and a prior handoff disagree, this file
states how it was checked — prefer the one with a method.*
