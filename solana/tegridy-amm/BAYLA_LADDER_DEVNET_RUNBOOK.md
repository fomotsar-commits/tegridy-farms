# bayla-ladder — Devnet Runbook

**Status: DEVNET ONLY. Do not deploy this to mainnet with real BAYLA yet.**

The internal audit (2026-09-06, 82 agents, `docs/` + the audit artifact) returned
**0 Critical / 1 High / 4 Medium / 11 Low**, and every one is fixed and merged. It also
returned a verdict on sequencing that has not changed: this program had **never executed
a single instruction** at audit time, and an external audit has not happened. Devnet
first, external audit second, mainnet third.

This runbook is the devnet half. The mainnet half is deliberately not written yet.

---

## 0. What this program is

Lock-ladder staking with a flat 25% early exit — the Solana port of
`contracts/src/LighthouseLadder.sol`. It exists to replace the Streamflow rail, whose
classic reward pool bricks claims permanently once `RewardEntry.accountedAmount` passes
`u64::MAX` (42.4% of all 13,809 mainnet entries are already past it).

The property that matters most: **principal is always recoverable.** Three doors:

| door | price | notes |
| --- | --- | --- |
| `withdraw_matured` | free | only after `lock_end` |
| `early_exit` | 25% | pays your rewards out on the way |
| `emergency_withdraw` (the hatch) | **25% while still locked**, free once matured or once the pool is `degraded` | principal only; touches no reward accounting, so it cannot revert on drift |

> 🔴 **THE HATCH IS NOT FREE WHILE LOCKED.** `lib.rs:607-613` charges the same
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
| `EARLY_EXIT_PENALTY_BPS` | 2 500 | flat 25%, stays in the pool as reward budget |
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

Devnet SOL: the `.so` is ~512 KB, so rent is `size * 2 * 0.00000696` ≈ **7.2 SOL**, plus
fees. The faucet caps each request, so ask repeatedly (`solana airdrop 2`) or use
<https://faucet.solana.com>. The old "~6 SOL" figure here was short of the real number.

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

On devnet you will not have the real BAYLA mint. Create a stand-in with **6 decimals
under Token-2022, then revoke both authorities**, or the pool will refuse it — which is
the gate working.

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

> ⚠️ **`deployer` is required for BOTH clusters.** A mainnet build with no deployer keeps
> the System-program sentinel, which is fail-closed: `initialize_pool` becomes uncallable
> and **no pool can ever be created** — and you would only discover that after paying for
> the deploy.

---

## 5. Deploy

```bash
solana config set --url devnet
solana address    # must print the $WALLET you built against
solana balance    # the .so is ~512 KB, so budget ~7.6 SOL of rent + fees

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
confusing constraint error against a deployed program.

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
tokens the pool **already holds** — retained early-exit penalties, principally. Either
may be zero; both zero is refused. This split is audit H-1's fix: before it, the retained
25% was permanently unspendable, because scheduling only ever read `amount`.

Two floors to respect:

- `rate = scheduled / 7_776_000`, integer division. **`scheduled` must be at least
  7 776 000 raw units** or the rate truncates to zero and the call is refused with
  `RewardRateTooSmall` (audit L-1) instead of silently emitting nothing. At 6dp that is
  **7.776 BAYLA** — a trivial floor, but it is a real one.
- `rate <= fundable / 7_776_000`, where `fundable = vault − (emitted − paid)`. The pool
  will not schedule what it does not physically hold after reserving what it already
  owes. This is the TegridyRestaking bug as a `require!`.

Calling `notify_reward` mid-window rolls the remainder forward into a fresh 90 days, the
standard Synthetix behaviour.

---

## 8. Smoke test on devnet, in this order

The integration suite (`tests/bayla-ladder.test.ts`, 27 tests) covers all of this against
a local validator in CI. On devnet, drive it with the CLI from §5b — dry-run each first,
then re-run with `--broadcast`:

```bash
node scripts/bayla-ladder-ops.mjs stake --pool <p> --amount 500 --lock-days 7
node scripts/bayla-ladder-ops.mjs claim --pool <p> --nonce 0
node scripts/bayla-ladder-ops.mjs exit  --pool <p> --nonce 0 --early   # 25% penalty
node scripts/bayla-ladder-ops.mjs hatch --pool <p> --nonce 0           # 25% WHILE LOCKED
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
5. `early_exit`. Confirm exactly 25% is retained and **the penalty lands in the reward
   vault**, and that `withdraw_matured` refuses the same position.
6. `emergency_withdraw` on a second position, and test BOTH arms — this is the step
   that was documented backwards. On a position that is **still locked** in a healthy
   pool, confirm the hatch retains exactly 25% (`hatch` prints the number before you
   broadcast) and that `pool.orphaned_penalty` rises by that amount. Then
   `declare_degraded` and confirm the hatch becomes free. Either way, confirm the
   accrued rewards were NOT destroyed: they land in `user_stats.rewards_carried` and
   `claim-carried` pays them out.
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
2. 🔑 **A real mainnet program keypair**, generated and backed up before use. Two
   own-venue program keypairs are currently gitignored and **unbacked-up**; do not add a
   third to that pile.
3. 💰 **`min_stake`, `deposit_cap`, `max_wallet_principal`.** `min_stake` is permanent.
4. 📋 **External audit engagement.** 2–4 week scheduling lead is normal. Book it before
   the code is "ready", not after.
5. 🔁 **Migration of the 8 existing Streamflow stakers** — including claiming the 1M
   position before it crosses the u64 ceiling.

---

## 10. Known coverage gap — state it to the auditor, do not bury it

**`withdraw_matured` has never executed.** The minimum lock is 7 days and
`solana-test-validator` has no clock warp, so no CI job can reach it. Both real harnesses
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
cargo test -p bayla-ladder --lib                    # 35 host tests
cargo test -p bayla-ladder --lib --features devnet  # 35, both configs matter
```

Both feature configs are run in CI deliberately: `deployer::ID` is cfg-gated, and the
failure a default build cannot see (devnet deployer == the program's own address) is
precisely the one that shipped.

The integration suite runs under `ladder-constraints` in `solana-ci.yml`, which builds
the SBF artifact, deploys to a local validator and drives the real instructions.
