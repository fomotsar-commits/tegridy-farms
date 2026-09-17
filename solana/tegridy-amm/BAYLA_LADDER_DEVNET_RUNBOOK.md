# bayla-ladder — Devnet Runbook

**Status: DEVNET ONLY. Do not deploy this to mainnet with real BAYLA yet.**

---

## ✅ THIS RUNBOOK HAS BEEN EXECUTED — devnet, 2026-09-09

Everything below was run end to end, not just written. The addresses are real and live.

> ⚠️ **Measured on the superseded 25% build.** `HzxzfSQ…` was compiled with
> `EARLY_EXIT_PENALTY_BPS = 2_500` and has no reload rate guard. From the 2026-09-17
> rebuild on (branch `feat/bayla-ladder-75-penalty`), the ladder forfeits **75%** of
> principal on an early exit (the leaver keeps 25%) and `notify_reward` refuses a
> mid-window reload that would lower the rate. Every penalty figure in this section is a
> record of the old build. **Nothing has been measured at 75% on any cluster.** Upgrade
> this devnet program to the 75% build before any preview environment points at it.

| | |
| --- | --- |
| program | `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` |
| pool (nonce 0) | `2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4` |
| stand-in mint | `8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL` (Token-2022, 6dp, both authorities revoked) |
| deployer / authority | `Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj` |
| deployed with | `--max-len 512504` → **2.604 SOL** of rent |

**Eight instructions executed against the deployed program.** Compute, measured live,
against the 200 000 default budget:

| instruction | CU |
| --- | --- |
| `initialize_pool` | 35 031 |
| `stake` | 26 142 – 33 385 |
| `notify_reward` | 12 335 |
| `claim` | 16 022 |
| `early_exit` | 28 725 |
| `emergency_withdraw` | 18 957 |
| `claim_carried` | 13 631 |
| `sweep_orphaned_penalty` | 10 591 |

**The accounting reconciled exactly.** Funded 50 000, plus two penalties of 125 (25% of
a 500-token position each, measured on the superseded 25% build), minus 0.59156 paid
out → reward vault 50 249.408 44. `rewards_emitted == rewards_paid`,
outstanding 0, `total_principal` 0, stake vault 0, `orphaned_penalty` swept to 0.

**Two claims in this document became measurements:**

- **The ladder is real and linear.** 500 tokens at 7 days → weight 200 000 000 (the
  **0.40× floor**, not the 4.00× top); at 30 days → 228 450 000 (0.4569×). Both match
  `MIN_BOOST + (MAX_BOOST − MIN_BOOST) × (lock − MIN) / (MAX − MIN)` exactly.
- **The hatch penalty is real.** The `Withdrawn` event on a 500-token locked position
  decodes to `amount = 375.00, penalty = 125.00` — measured on the superseded 25% build,
  where 375 is what was RETURNED and 125 what was FORFEITED. (On the 75% build the same
  position would return 125 and forfeit 375: the two numbers trade places. That is
  arithmetic, not a measurement.) ⚠️ The `transfer_checked` in that same transaction
  moved **375**, the returned share — the penalty exists ONLY inside the event, so a reader
  watching token transfers, or a raw simulation, sees no penalty at all. That is exactly
  how the "the hatch is free" error survived in this document and in the CLI.

✅ **`withdraw_matured` EXECUTED on devnet, 2026-09-17** — position `#2`, 500 back,
penalty 0, on the superseded 25% build (the matured door charges nothing at any rate). The
transaction and the on-chain reconciliation are in `docs/TODO_OPERATOR.md` O-0909-1. It is
still unreachable from CI (§10).

---

The internal audit (2026-09-06, 82 agents, `docs/` + the audit artifact) returned
**0 Critical / 1 High / 4 Medium / 11 Low**, and every one is fixed and merged. It also
returned a verdict on sequencing that has not changed: this program had **never executed
a single instruction** at audit time, and an external audit has not happened. Devnet
first, external audit second, mainnet third.

This runbook is the devnet half. The mainnet half is `BAYLA_LADDER_MAINNET_RUNBOOK.md`.

---

## 0. What this program is

Lock-ladder staking with a flat **75% early-exit penalty** — a leaver before `lock_end`
keeps 25% of principal. It ports the lock ladder of `contracts/src/LighthouseLadder.sol`
(7 d–4 y, 0.40x–4.00x) but **not its penalty**: the EVM contract charges 25%, this
program 75% (owner decision 2026-09-17). The forfeited 75% is not paid to anyone on the
way out: it is forfeited to the reward pool, scheduled into a later window by the
operator, and then shared by weight among whoever is staked then.

It is a **separate product** from the Streamflow BAYLA lighthouse pool
(`EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`), which keeps running and still needs its
own reward funding through its last lock. The ladder neither replaces nor migrates it.
(An earlier version of this paragraph justified the ladder by a Streamflow "u64 claim
ceiling". That ceiling does not exist — see the 2026-09-12 correction in
`docs/TODO_OPERATOR.md`.)

The property that matters most: **principal is always recoverable** — some door always
opens. Before `lock_end`, in a healthy pool, that door returns 25% of it. Three doors:

| door | price | notes |
| --- | --- | --- |
| `withdraw_matured` | free | only after `lock_end` |
| `early_exit` | 75% of principal (25% returned); free once the pool is `degraded` | pays your rewards out on the way |
| `emergency_withdraw` (the hatch) | **75% while still locked** (the same penalty as `early_exit`), free once matured or once the pool is `degraded` | principal only; touches no reward accounting, so it cannot revert on drift |

> 🔴 **THE HATCH IS NOT FREE WHILE LOCKED.** `emergency_withdraw` in `lib.rs` charges the same
> `penalty_for(amount)` as `early_exit` whenever `now < lock_end` and the pool is not
> degraded. This document said "free" in two places and the CLI printed "no penalty"
> unconditionally; both were wrong, and a review caught it before anyone ran it.
>
> What the hatch actually buys is **independence from the reward ledger**: it uses the
> lenient accrual, moves anything owed to `rewards_carried` (claimable later with
> `claim-carried`), and so cannot be blocked by an accounting drift or a dry reward
> vault. At the same price, `early_exit` is the better door in a healthy pool because it
> also pays the rewards out. The hatch is for when `early_exit` will not go through.

| Constant | Value | Notes |
| --- | --- | --- |
| `MIN_LOCK_SECS` | 7 days | boost 0.40x |
| `MAX_LOCK_SECS` | 4 years | boost 4.00x |
| `EARLY_EXIT_PENALTY_BPS` | 7 500 | flat 75% forfeited (25% of principal returned), charged by `early_exit` and, while locked, `emergency_withdraw`; 0 in a `degraded` pool. Forfeited to the reward pool as budget for a later window. Compile-time, no setter. **The devnet build `HzxzfSQ…` was compiled with 2 500.** |
| `REWARDS_DURATION_SECS` | 90 days (7 776 000 s) | per-second distribution |
| `MAX_POSITIONS` | 20 | per wallet per pool |
| `CAP_TIMELOCK_SECS` | 48 h | deposit-cap raises only; the cap can only go UP |
| `HARD_MIN_STAKE_RAW` | 10 000 | absolute floor, decimals-blind |

Account sizes are a client contract and are pinned as literals in CI:
**Pool 508, Position 205, UserStats 126.**

---

## 1. Prereqs

You need **`solana`, `gh` and `node` locally. You do NOT need `anchor` or the SBF
toolchain** — neither can run on this machine (Application Control blocks `anchor.exe`
outright), and §4 builds in CI precisely because of that. Solana CLI **2.3.0 and 0.32.1
Anchor are what CI pins**; your local `solana` only signs and reads, so its version does
not have to match. Verified compatible: a local `solana-cli 4.1.x` deploys a CI-built
2.3.0 artifact, because `solana program deploy` still targets the upgradeable loader.

```bash
solana --version
gh auth status
```

**You will not have a wallet on a fresh machine.** `solana address` fails with
`No default signer found` until you make one, and every step below needs it:

```bash
solana-keygen new --no-bip39-passphrase --outfile <path-outside-the-repo>/devnet-deploy.json
solana config set --url devnet --keypair <path-outside-the-repo>/devnet-deploy.json
```

Keep keys **outside the repo** so git cannot swallow them.

**Devnet SOL — ask the chain, do not use the rule of thumb.** `size * 2 * 0.00000696`
is an approximation that OVERSTATES this by about 2 SOL. `solana rent` is authoritative:

```bash
solana rent 1025008    # 2 x the 512,504-byte .so -> Rent-exempt minimum: 5.21 SOL
solana rent 512504     # exact size, with --max-len -> 2.60 SOL
```

| deploy | ProgramData size | rent |
| --- | --- | --- |
| `solana program deploy` (default) | 2× the binary, so it can be upgraded to a larger one | **~5.21 SOL** |
| `solana program deploy --max-len 512504` | exactly the binary | **~2.60 SOL** |

Budget **~5.5 SOL** for the default, or **~2.8 SOL** with `--max-len`. On devnet, where
the faucet is the constraint, `--max-len` is the sensible choice: it only forecloses
upgrading to a *larger* binary, and a devnet program can simply be redeployed.

> ⚠️ **2026-09-11 - the 2× row above describes older CLIs.** The operator box now runs
> Solana CLI **4.1.1**, whose own `solana program deploy --help` says `--max-len` defaults to
> *"the length of the original deployed program"* (1×) and that upgrades **auto-extend**
> the program data account unless `--no-auto-extend` is passed. So with 4.1.1 a plain
> deploy costs **~2.60 SOL** and stays upgradeable: a later, larger binary pays its extra
> rent at upgrade time instead of up front. Check `solana --version` before relying on it.

⚠️ **The public faucet rate-limits hard by IP**, and `solana airdrop` then fails with
"airdrop request failed. This can happen when the rate limit is reached." That is not a
config error — the RPC is fine, the faucet is refusing. Use <https://faucet.solana.com>
(it needs a CAPTCHA, so it is a human step) or wait for the limit to reset.

---

## 2. The verified mint facts

Read live from mainnet on **2026-09-06**:

| Field | Value |
| --- | --- |
| Mint | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` |
| Owner program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (**Token-2022**) |
| Decimals | **6** |
| `mintAuthority` | **None** |
| `freezeAuthority` | **None** |
| Extensions | `metadataPointer`, `tokenMetadata` |

Both mint gates therefore **pass**: `initialize_pool` refuses a mint that still has a
mint authority (audit M-1) or a freeze authority (a freeze authority could freeze the
vault itself). Re-read these before the mainnet pool is created — `None` today is not a
guarantee for tomorrow, and the check is worth ten seconds.

`tokenMetadata` is the one admitted post-gate-mutable extension. That is an **accepted
risk**, documented in the program header: the mint account stays reallocatable for the
pool's life. A future `spl-token-2022` bump must re-verify the multisig-length padding
noted there.

On devnet you will not have the real BAYLA mint, so make a stand-in that passes both
gates. **ORDER MATTERS AND THE OBVIOUS ORDER BRICKS IT**: revoke the mint authority and
you can never mint again, so the supply has to exist first.

```bash
spl-token create-token --program-2022 --decimals 6      # -> MINT. No --enable-freeze,
                                                        #    so there is NO freeze
                                                        #    authority to revoke later.
spl-token create-account <MINT>                          # your ATA
spl-token mint <MINT> 10000000                           # SUPPLY FIRST...
spl-token authorize <MINT> mint --disable                # ...THEN revoke. Irreversible.
spl-token display <MINT>                                 # confirm both authorities empty
```

An earlier version of this section said "create, then revoke both authorities" with no
commands. Followed literally that mints nothing and then makes minting impossible, and
there is no freeze authority to revoke in the first place unless you asked for one.

`spl-token display` must show no mint authority and no freeze authority, or
`initialize_pool` will refuse the mint (audit M-1) — which is the gate working.

---

## 3. Program keypair and the two compile-time identities

`declare_id!` and `deployer::ID` are **compile-time constants**. Getting them wrong is
how audit L-5 happened: `deployer::ID` shipped equal to `declare_id!`, which made
`initialize_pool` demand a signature from the program's own loader-owned address —
uncallable, and every instruction downstream unreachable.

```bash
cd solana/tegridy-amm
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/bayla_ladder-keypair.json
PROGRAM_ID=$(solana-keygen pubkey target/deploy/bayla_ladder-keypair.json)
WALLET=$(solana address)
echo "program=$PROGRAM_ID deployer=$WALLET"
```

You do **not** patch these by hand — §4's workflow does it, with assertions. Keep both
values; you need them as workflow inputs and to verify the deploy. For reference, the
patch it applies is:

```bash
python3 - programs/bayla-ladder/src/lib.rs "$PROGRAM_ID" "$WALLET" <<'PY'
import re, sys
path, program_id, wallet = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
marker = "pub mod deployer {"
head, sep, tail = src.partition(marker)
assert sep, "could not locate `pub mod deployer` - lib.rs layout changed"
head, n = re.subn(r'declare_id!\("[^"]+"\)', f'declare_id!("{program_id}")', head)
assert n == 1, f"expected exactly 1 top-level declare_id!, patched {n}"
pat = r'(#\[cfg\(feature = "devnet"\)\]\s*pub const ID: Pubkey = pubkey!\(")[^"]+("\);)'
tail, n = re.subn(pat, r'\g<1>' + wallet + r'\g<2>', tail, count=1)
assert n == 1, f"expected 1 devnet deployer pubkey!, patched {n}"
assert program_id != wallet, "deployer must never equal the program id - audit L-5"
open(path, 'w').write(head + sep + tail)
PY
sed -i "s|^bayla_ladder = \".*\"|bayla_ladder = \"$PROGRAM_ID\"|" Anchor.toml
```

> ⚠️ **Do not hand-edit `lib.rs` around these constants.** The patcher's regex uses
> `\s*` between the `#[cfg]` attribute and `pub const`, and CI separately asserts the
> token `declare_id!` never appears after `pub mod deployer {`. A comment placed between
> them, or one that merely contains that token, breaks the build in two ways at once.
> This has already happened once.

**A non-devnet build keeps `deployer::ID = pubkey!("11111111111111111111111111111111")`**
— the System Program, as an explicit base58 sentinel rather than `Pubkey::default()`.
It is fail-closed and uncallable by design, which is correct for mainnet: the authority
is set deliberately, not left as a placeholder that happens to work.

That it is a `pubkey!` arm and not a `Pubkey::default()` matters mechanically: the
artifact workflow patches *one* of the two `pubkey!` arms and asserts there are exactly
two, so a change to that expression fails the build loudly instead of patching the wrong
one.

---

## 4. Build the artifact — in CI, because you cannot build it here

**Do not try to `anchor build` on the Windows box.** The SBF toolchain cannot be
installed on it (`Failed to install platform-tools: A required privilege is not held by
the client`, os error 1314 — it needs the symlink privilege). There is no local path to
a deployable `.so`, and that is not a temporary state.

Run **`solana-deploy-artifact`** instead, from the Actions tab or the CLI:

```bash
gh workflow run solana-deploy-artifact.yml \
  -f program=bayla-ladder \
  -f cluster=devnet \
  -f program_id=$PROGRAM_ID \
  -f deployer=$WALLET
```

It patches those two identities into the source, builds with `anchor build` (so you get
the **IDL as well as the `.so`** — `cargo build-sbf` emits no IDL), and publishes both
plus their sha256s as a downloadable artifact. It refuses up front if either input is not
a real base58 pubkey, if `deployer == program_id` (**audit L-5**), or if `deployer` is the
fail-closed `1111…` sentinel.

It also asserts, after building, that the IDL's `address` and the source's `declare_id!`
both equal the `program_id` you asked for. That mismatch is the single most common way a
deploy looks fine and is unusable, and it is checked for you now.

```bash
gh run download <run-id>          # -> deploy/bayla_ladder.so, idl/bayla_ladder.json
```

The run's summary page prints the sha256s, the rent estimate, and the deploy commands
below with your addresses already filled in.

> 📄 **You do not need a run to get an IDL any more.** `idl/bayla_ladder.json` is
> committed — it is the IDL from run `34336193019`, whose `.so` sha256 matches what
> is deployed at `HzxzfSQ…` on devnet byte for byte. GitHub deletes the artifact 30
> days after the run, so the committed copy is the durable one; `idl/README.md`
> carries the hashes and the two fields a mainnet build changes. `ladder-constraints`
> re-checks it against a fresh `anchor build` on every push, so it cannot go stale
> quietly. You still need the artifact for the **`.so`** — that is not committed.
>
> ⚠️ Run `34336193019` is the **superseded 25% build**. The 75% rebuild changes the
> IDL's bytes (the penalty docs strings, error 6007's message, and the new error 6028
> `RewardRateWouldDecrease`), so once its IDL is committed, the committed file no longer
> describes what `HzxzfSQ…` runs — until devnet is upgraded. `idl/README.md` carries the
> provenance of whichever IDL is committed.

> ⚠️ **`deployer` is required for BOTH clusters.** A mainnet build with no deployer keeps
> the System-program sentinel, which is fail-closed: `initialize_pool` becomes uncallable
> and **no pool can ever be created** — and you would only discover that after paying for
> the deploy.

---

## 5. Deploy

```bash
solana config set --url devnet
solana address    # must print the $WALLET you built against
solana balance    # need ~5.5 SOL, or ~2.8 with --max-len below

solana program deploy bayla_ladder.so \
  --program-id target/deploy/bayla_ladder-keypair.json

solana program show $PROGRAM_ID     # verify what actually landed
```

**Upgrade authority stays with the deploy wallet on devnet.** That is fine for devnet
and is *not* fine for mainnet — see §9.

---

## 5b. The operator CLI — everything after the deploy

`frontend/scripts/bayla-ladder-ops.mjs` drives the program directly. **Every command is a
DRY RUN unless you pass `--broadcast`**: it builds the transaction, runs it through
`simulateTransaction` against real chain state, and prints the program's own logs, error
code and compute usage. A dry run that reports a program error has told you something
true — it is not a formatting exercise.

Amounts are **whole tokens** and are converted using the mint's own decimals, read
on-chain. It refuses more precision than the mint has rather than truncating silently.

```bash
cd frontend
export BAYLA_LADDER_PROGRAM=$PROGRAM_ID
export SOLANA_RPC=https://api.devnet.solana.com

node scripts/bayla-ladder-ops.mjs read --pool <pool>
node scripts/bayla-ladder-ops.mjs positions --pool <pool> --owner <wallet>
```

Its discriminators, account ordering and struct offsets were verified field-by-field
against the program's own IDL (0 mismatches) and are pinned by
`scripts/bayla-ladder-ops.test.mjs`, so program drift fails in CI rather than as a
confusing constraint error against a deployed program. That test now **reads
`idl/bayla_ladder.json`** rather than restating a transcription of it, so the check is
live: it was a snapshot only for as long as the IDL lived in an expiring artifact.

---

## 6. Initialize the pool — the parameters are mostly IMMUTABLE

```bash
node scripts/bayla-ladder-ops.mjs init-pool --mint <mint> --nonce 0 --min-stake 100 --deposit-cap 1000000 --max-wallet 100000 --keypair <deployer.json>
# dry run by default — re-run with --broadcast once the simulation looks right
```

The CLI refuses a bad configuration locally, with an explanation, instead of letting it
surface as an on-chain constraint failure. The underlying instruction is:

```
initialize_pool(nonce: u8, min_stake: u64, deposit_cap: u64, max_wallet_principal: u64)
```

Enforced at init, in this order:

1. `decimals <= 9` — above 19 the `10u64.pow` overflows and `overflow-checks = true`
   turns that into a panic.
2. `min_stake >= HARD_MIN_STAKE_RAW` (10 000).
3. **`min_stake >= 100 * 10^decimals`** — a hundred whole tokens, whatever the decimals.
   **For BAYLA at 6dp that is `100_000_000` raw = 100 BAYLA.**
4. `deposit_cap >= min_stake`.
5. `min_stake <= max_wallet_principal <= deposit_cap` (audit M-4 — both bounds required,
   so the value cannot be reached by omission).
6. The mint gates from §2.
7. `token_program` is pinned to **what actually owns the mint**, detected, never assumed.
   The first Streamflow broadcast died with `IncorrectProgramId` for assuming legacy SPL.

> 🔴 **`min_stake` has no setter and never will.** Raising it later would lift the I-11
> burn threshold above the weight of already-open positions and start burning intervals
> for legitimate live stakers. A pool initialised at the wrong floor is unfixable except
> by migrating every staker. **Decide this number before you type it.**
>
> `deposit_cap` is the one parameter that can move, upward only, behind a 48h timelock
> (`propose_cap_raise` → wait → `execute_cap_raise`, with `cancel_cap_raise` available).

---

## 7. Fund the 90-day window

```bash
node scripts/bayla-ladder-ops.mjs notify --pool <pool> --amount 50000 --keypair <authority.json>
# dry run; add --broadcast to send
```

The CLI checks the L-1 floor and the authority match before building anything.

```
notify_reward(amount: u64, from_budget: u64)
```

`amount` is fresh capital transferred in from the funder's ATA. `from_budget` schedules
tokens the pool **already holds** — forfeited early-exit penalties, principally. Either
may be zero; both zero is refused. This split is audit H-1's fix: before it, the retained
penalty was permanently unspendable, because scheduling only ever read `amount`.

A penalty is not paid to anyone when it is forfeited. It sits in the reward pool until the
operator schedules it into a later window with `from_budget`, and is then shared by weight
among whoever is staked then.

Three rules to respect:

- `rate = scheduled / 7_776_000`, integer division. **`scheduled` must be at least
  7 776 000 raw units** or the rate truncates to zero and the call is refused with
  `RewardRateTooSmall` (audit L-1) instead of silently emitting nothing. At 6dp that is
  **7.776 BAYLA** — a trivial floor, but it is a real one.
- `rate <= fundable / 7_776_000`, where `fundable = vault − (emitted − paid)`. The pool
  will not schedule what it does not physically hold after reserving what it already
  owes. This is the TegridyRestaking bug as a `require!`.
- **The rate guard (75% rebuild on; the devnet build `HzxzfSQ…` does not have it).** While
  `now < period_finish`, the folded rate
  `(scheduled + (period_finish − now) × reward_rate) / 7_776_000` must be **at least the
  current `reward_rate`**, or the call is refused with **6028 `RewardRateWouldDecrease`**
  (`math::rate_change_allowed`, checked last in `notify_reward`). In operator terms: a
  mid-window reload must schedule at least
  `reward_rate × seconds elapsed since the last notify`, which is
  `reward_rate × (now − (period_finish − 7_776_000))`. Exactly that amount holds the rate;
  more raises it. The guard never refuses a same-second reload. **At or after `period_finish`
  there is no constraint** — any rate is accepted.

Calling `notify_reward` before `period_finish` rolls the remainder forward into a fresh
90 days (the standard Synthetix fold), but unlike Synthetix and `LighthouseLadder.sol` the
program refuses the call if the result would lower the rate. So a small top-up late in a
window, or a penalty-only `from_budget` reload that does not cover the elapsed emission,
is refused rather than silently diluting the rate. Recycle penalties at the regular
reload. The reload policy (cadence, sizing, what to publish) is in
`BAYLA_LADDER_MAINNET_RUNBOOK.md` §8.

---

## 8. Smoke test on devnet, in this order

The integration suite (`tests/bayla-ladder.test.ts`, 28 tests since the 75% rebuild added the rate-guard test) covers all of this against
a local validator in CI. On devnet, drive it with the CLI from §5b — dry-run each first,
then re-run with `--broadcast`:

```bash
# FUND FIRST. A claim against an unfunded pool succeeds and pays ZERO, which proves
# nothing and reads like the claim path working.
node scripts/bayla-ladder-ops.mjs notify --pool <p> --amount 50000 --keypair <authority.json>

# TWO positions: the exit below CLOSES the one it names, so a second is needed to
# exercise the hatch. Nonces are assigned by the program from UserStats.next_nonce -
# `positions` prints the real ones; do not assume 0 and 1.
node scripts/bayla-ladder-ops.mjs stake --pool <p> --amount 500 --lock-days 7
node scripts/bayla-ladder-ops.mjs stake --pool <p> --amount 500 --lock-days 7
node scripts/bayla-ladder-ops.mjs positions --pool <p> --owner <you>

# let a few minutes of the 90-day window accrue, then:
node scripts/bayla-ladder-ops.mjs claim --pool <p> --nonce 0
node scripts/bayla-ladder-ops.mjs exit  --pool <p> --nonce 0 --early   # 75% penalty (25% back), pays rewards
node scripts/bayla-ladder-ops.mjs hatch --pool <p> --nonce 1           # 75% penalty while locked, defers rewards
node scripts/bayla-ladder-ops.mjs claim-carried --pool <p>             # what the hatch deferred
node scripts/bayla-ladder-ops.mjs sweep --pool <p>                     # permissionless
```

Confirm each:

1. `initialize_pool` — then read Pool back and check `decimals`, `token_program`,
   `min_stake`, `deposit_cap` are what you passed.
2. `stake` a minimum-size position at a 7-day lock. Confirm the boost is **0.40x**, not
   4.00x. (A ladder that pays the top rung for the bottom lock is the expensive bug.)
3. `notify_reward` a small 90-day budget. Confirm `RewardAdded` and a non-zero rate.
4. Wait a few minutes, `claim`. **Confirm the payout comes from the reward vault only**
   (invariant I-12) and the stake vault is untouched.
5. `early_exit`. Confirm exactly 75% is retained (25% of principal returned) and **the
   penalty lands in the reward vault**, and that `withdraw_matured` refuses the same
   position.
6. `emergency_withdraw` on a second position, and test BOTH arms — this is the step
   that was documented backwards. On a position that is **still locked** in a healthy
   pool, confirm the hatch retains exactly 75% (`hatch` prints the number before you
   broadcast) and that `pool.orphaned_penalty` rises by that amount. Then
   `declare_degraded` and confirm the hatch becomes free. Either way, confirm the
   accrued rewards were NOT destroyed: they land in `user_stats.rewards_carried` and
   `claim-carried` pays them out.
   ⚠️ The CLI's penalty is a local constant (`EARLY_EXIT_PENALTY_BPS` in `bayla-ladder-ops.mjs`), not read from
   the chain, and nothing on chain exposes the rate. Against a program still on the 25%
   build — `HzxzfSQ…` today — a CLI built at 75% prints a penalty that program does not
   charge. The CLI and the program must be the same build: upgrade devnet first, and
   confirm steps 5 and 6 from the decoded `Withdrawn` event, not the CLI's preview.
7. `sweep_orphaned_penalty` from a **stranger's** keypair — it is permissionless by
   design, and the struct declares no `Signer`.

Compute units, measured in CI (default budget is 200 000 per instruction):
`early_exit` — the heaviest path, three `transfer_checked` CPIs plus a reload and a
close — measured at **24 455 CU**. Comfortable.

---

## 9. What must be decided by a human before mainnet

These are not tasks I can do, and none of them should be improvised on the day.

1. 🔑 **Upgrade authority.** The current BAYLA admin `GCCSLE7d…` is a bare on-curve
   keypair. For a program holding other people's principal that is not adequate. Choose:
   Squads multisig with a timelock, or burn the authority and make the program immutable.
   Immutable is the stronger promise and forecloses fixing anything.
   **DECIDED 2026-09-12: the Squads route, using the venue's EXISTING v4 vault**
   `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` (index 0 of multisig
   `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`, threshold 2 — all three facts read on
   chain that day, and the derivation pinned by `squadsRegistry.test.ts`). See the
   mainnet runbook §3, including why it must be the vault and never the multisig.
2. 🔑 **A real mainnet program keypair**, generated and backed up before use. Two
   own-venue program keypairs are currently gitignored and **unbacked-up**; do not add a
   third to that pile.
   **2026-09-11: generated.** Mainnet program id
   `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` (public key only - the keyfile lives
   outside the repo). ⚠️ **Not yet backed up.** Back it up before it deploys anything.
3. 💰 **`min_stake`, `deposit_cap`, `max_wallet_principal`.** `min_stake` is permanent.
   **So is `max_wallet_principal`** (found 2026-09-11): it is written only in
   `initialize_pool` and no instruction ever changes it. Only `deposit_cap`
   moves - upward only, 48 hours after `propose_cap_raise`, via the permissionless
   `execute_cap_raise`. Three consequences: `max_wallet_principal` must be **at least the
   largest single wallet expected to stake** (sizing reference, measured 2026-09-12: the
   largest wallet in the separate Streamflow pool holds **1,004,000 BAYLA across 6
   positions** — the limit is on the wallet TOTAL, not per position, and the older
   snapshot of a 1,000,000 single position understated it. Nobody is migrated from that
   pool; it is only the best available measure of demand); it must be **at most the
   INITIAL `deposit_cap`** (init refuses otherwise, and later cap raises do not lift it);
   and `min_stake` cannot go below
   **100 whole tokens** (`initialize_pool` enforces that floor).
4. 📋 **External audit engagement.** 2–4 week scheduling lead is normal. Book it before
   the code is "ready", not after.
   **2026-09-11:** the owner reports an external audit is underway.
5. ✅ **No migration — DECIDED 2026-09-17.** The Streamflow BAYLA lighthouse pool
   (`EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`) and this ladder are separate
   products. There is no migration integration, and nobody's position is moved, or
   announced as moving. A Streamflow staker may stake in the ladder like anyone else. The
   Streamflow pool keeps running and **still needs its own reward funding through its
   last lock**.
   (This item used to plan claiming the 1M Streamflow position "before it crosses the u64
   ceiling". The ceiling does not exist: `docs/TODO_OPERATOR.md`'s 2026-09-12 correction
   found 5,868 entries past `u64::MAX` still paying, and the 1,000,000 position paying.)
6. 💰 **Ladder reward funding never stops.** Every window is reloaded before its
   `period_finish`; there is no sunset and no wind-down. The reload policy is in
   `BAYLA_LADDER_MAINNET_RUNBOOK.md` §8.
7. 🔑 **The pool authority is a multisig before any funds** (decided 2026-09-17), and the
   mainnet deployer is a freshly generated key, not `GCCSLE7d…` (key rotation option A,
   `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md`).

---

## 10. Known coverage gap — state it to the auditor, do not bury it

**No CI job can execute `withdraw_matured`.** It ran once, by hand, on devnet on
2026-09-17 (O-0909-1, on the superseded 25% build), which proves the path works on a real
cluster but pins nothing: the minimum lock is 7 days and `solana-test-validator` has no
clock warp, so no CI job can reach it. Both real harnesses
that could (`solana-program-test`, `litesvm`) transitively pull `openssl-sys` through
`agave-precompiles`, whose vendored build needs a perl toolchain the dev box does not
have — verified with `cargo tree --invert openssl-sys` for both.

The gap is **bounded, and the bound is machine-checked**. `withdraw_matured` is
`exit_with_penalty(ctx, now, 0)`; `early_exit` is the same function with a non-zero
penalty and CI drives it end-to-end every run. The unexecuted delta is exactly:

1. the maturity `require!` **passing** — its failing arm is tested; and
2. `penalty == 0`, which `transfer_from_vault` short-circuits to a no-op, so the matured
   path issues **strictly fewer** CPIs than the path already proven.

Three mutation-checked tests pin those claims: `the_matured_door_charges_no_penalty`,
`the_two_doors_partition_time`, `a_zero_transfer_is_skipped_not_attempted`.

That is an argument, not evidence. **An external auditor on Linux should execute this
path in their own harness.** It is the first thing to hand them.

---

## 11. Test inventory

```bash
cd solana/tegridy-amm
cargo test -p bayla-ladder --lib                    # 40 host tests (35 before the 75% rebuild)
cargo test -p bayla-ladder --lib --features devnet  # 40, both configs matter
```

Both feature configs are run in CI deliberately: `deployer::ID` is cfg-gated, and the
failure a default build cannot see (devnet deployer == the program's own address) is
precisely the one that shipped.

The integration suite runs under `ladder-constraints` in `solana-ci.yml`, which builds
the SBF artifact, deploys to a local validator and drives the real instructions.
