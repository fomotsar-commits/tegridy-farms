# `migrate_to_amm` — design, before any code

The instruction that graduates a bonded launch into a Tegridy CP-AMM pool. It is
the highest-risk code in this program: it moves the entire raised balance in one
call, CPIs into a 20-account instruction, and has no audited upstream to diff
against.

This document exists because writing it straight from intuition already went
wrong once. The removed `graduate` instruction was plausible, deliberately
designed, and justified in a commit message — and it permanently locked every
lamport of any launch that called it. So the decisions come first.

Everything below marked **VERIFIED** was read out of `programs/cp-swap/src`
directly, not assumed.

---

## What cp-swap's `initialize` actually requires

**VERIFIED** — `instructions/initialize.rs`, 20 accounts:

| Account | Implication for us |
| --- | --- |
| `creator: Signer` | The curve PDA must sign via seeds. |
| `amm_config` | Must ALREADY EXIST, created by the cp-swap admin. Not ours to make. |
| `pool_state`, `token_0_vault`, `token_1_vault`, `lp_mint`, `observation_state` | All `init` — **the creator pays rent for five accounts**. |
| `token_0_mint` / `token_1_mint` | `constraint = token_0_mint.key() < token_1_mint.key()` — **ordering is enforced**, so we must sort WSOL against the launch mint. |
| `creator_token_0` / `creator_token_1` | **TokenAccounts owned by the creator.** Our curve holds SOL as raw lamports, so the SOL leg must be WRAPPED to WSOL first. |
| `creator_lp_token` | LP tokens are minted here — to an account owned by the curve PDA. **Custody decision required.** |
| `create_pool_fee` | Fixed address (`crate::create_pool_fee_reveiver::ID`). |

**VERIFIED, and this one is a trap:** the pool-creation fee is charged as a
*native SOL* `system_instruction::transfer` from `creator`
(`initialize.rs:318-325`), not a token transfer. Combined with rent on five new
accounts, **the curve PDA must retain a lamport budget beyond what it deposits as
liquidity.** A curve that raises exactly `graduation_target_lamports` and tries to
seed the pool with all of it CANNOT migrate.

That single fact invalidates the naive "deposit every real lamport" design, and it
is why `migration_reserve_lamports` appears below.

---

## Decisions

### 1. Migration budget — RESOLVED

Reserve lamports at launch creation, not at migration time. `GlobalConfig` gains
`migration_reserve_lamports`; a curve's effective graduation target becomes
`graduation_target_lamports + migration_reserve_lamports`, and only the target
portion is ever deposited as liquidity.

Rationale: the reserve must be raised *by traders*, not donated by the protocol
per launch, and it must be known before anyone buys so the Fact Sheet can state
it. Discovering the shortfall at migration time would strand the launch at the
finish line — the worst possible moment.

`initialize_global` must also validate `target + reserve` against
`max_reachable_real_sol`, not just `target`, or the reserve can push a
configuration past the curve's ceiling and make graduation unreachable again.

### 2. Mint ordering — RESOLVED

Sort `(WSOL, launch_mint)` by pubkey and assign token_0/token_1 accordingly,
carrying the amounts with them. Non-negotiable: cp-swap enforces it as a
constraint, so getting it backwards is a hard revert, not a silent mispricing.

### 3. Pool seed price — RESOLVED

Seed with the curve's final real reserves as-is.

The alternative — matching the curve's last *marginal* price — would require
depositing at a ratio the curve does not actually hold, which means either
withholding tokens from the pool or topping up SOL from somewhere. Both are worse
than a one-off price step at graduation, and both are harder to explain honestly
on a Fact Sheet. A visible discontinuity beats an invisible subsidy.

### 4. Replay safety and observability — RESOLVED

`BondingCurve` gains `pool: Pubkey` and sets `complete = true` **in the same
instruction** that moves the funds. Both are required:

- Without `complete`, migration is replayable and the second call drains nothing
  but corrupts state.
- Without `pool`, nothing off-chain can find the pool a launch graduated into, so
  the Fact Sheet cannot link it and the frontend cannot route to it.

**And `complete` must be set ONLY here.** That is the entire lesson of the removed
`graduate`: a flag that closes the only exit must be written by the same
instruction that opens the new one.

### 5. Config addresses — RESOLVED

`GlobalConfig` gains `cp_swap_program: Pubkey` and `amm_config: Pubkey`. Neither
is derivable and neither should be hardcoded, since the AmmConfig is created by an
operator action after deploy. `migrate_to_amm` must verify the passed accounts
match these, or a caller substitutes a hostile AMM and the launch graduates into
someone else's pool.

---

### 6. LP-token custody — RESOLVED: **BURN** (operator decision, 2026-07-29)

cp-swap mints LP tokens to `creator_lp_token`, an account owned by the curve PDA.
Three options, and they are materially different promises:

| Option | Effect | Honesty cost |
| --- | --- | --- |
| **Burn** | Liquidity is permanently locked; nobody can ever withdraw it | Strongest claim, and irreversible. "LP burned" is verifiable on-chain. |
| **Hold in the curve PDA forever** | Functionally locked, but a future program upgrade could move it | Weaker than burning, and only as trustworthy as the upgrade authority |
| **Transfer to the launch creator** | Creator can withdraw the pool's liquidity | This is a rug vector. Do not do this without saying so extremely loudly. |

**Chosen: burn.** It matches the EVM leg (`TegridyFeeLocker` with
`unlockDate == 0` is permanent and has no release path), it is the only option
that survives an upgrade-authority compromise, and the only one that makes a
"liquidity locked" Fact Sheet claim unconditionally true. It forecloses ever
reclaiming that capital — an accepted cost, not an oversight.

Implemented with a follow-up assertion that the LP balance is ZERO after the burn.
A silently-partial burn would leave the published claim false while looking fine.

---

### 7. Pool address — RESOLVED: **our PDA, not cp-swap's canonical one**

`pool_state` is `[b"launchpool", launch_mint]` derived from THIS program, and the
CPI signs for it.

cp-swap's `initialize` is permissionless (`creator` is "Can be anyone") and
`create_pool` refuses a `pool_state` that is no longer System-owned
(`initialize.rs:372-374`, VERIFIED). So the canonical
`[POOL_SEED, amm_config, mint0, mint1]` address is a **public brick**: buy one
token off the curve, wrap dust SOL, call cp-swap directly, and that launch can
never graduate. Not theft — sells keep working while `complete` is false — but the
product promise is gone for the price of one transaction.

cp-swap's own second branch is the fix: a non-canonical `pool_state` is accepted
provided it SIGNS (`initialize.rs:386-388`, VERIFIED). Signer privilege propagates
through CPI, so only this program can ever occupy the address. It works despite
the seeds mismatch because `create_or_allocate_account` signs System's
`CreateAccount` with the canonical seeds while System only requires the NEW
ACCOUNT to sign — and that privilege comes down from our `invoke_signed`. A
dust-funded PDA survives too, via the allocate+assign branch.

Constraining it also stops the CALLER choosing where a launch's liquidity lands.

### 8. Migration costs — RESOLVED: **reimburse the caller**

Migration is permissionless, so `payer` fronts rent for `auth_wsol`/`auth_token`
plus the authority's rent-exempt floor, and the authority absorbs whatever
`migration_reserve_lamports` over-provisioned. None of it is reachable afterwards
(only this program signs for the authority; a `complete` curve never releases
lamports), so the instruction closes all three token accounts and sweeps the
authority to zero, destination `payer`. Otherwise every migration is a permanent
leak AND a guaranteed loss for whoever calls it.

## Implemented and RUNTIME-PROVEN

Green in CI's `migration-rehearsal`: curve created, bought to target, migrated,
pool inspected, LP supply confirmed zero, plus replay safety and post-migration
buy/sell refusal. The canonical pool is deliberately OCCUPIED before migrating, so
a regression to the canonical derivation fails the test.

**Runtime-only defects found on this one instruction — the standing argument for
never trusting `cargo check` here.** Seven CI iterations, every one a real defect:

1. Unbudgeted `create_pool_fee` (found by reading cp-swap, not by tooling).
2. Wrapping the SOL leg with `system_program::transfer` FROM the curve PDA. Can
   never work: System requires a System-owned, data-less source. `cargo check`
   accepted it.
3. cp-swap's `creator` must be System-owned for the same reason → the data-less
   `migration_authority` PDA.
4. `init_if_needed` on `curve_lp` ran during account validation, before `lp_mint`
   existed.
5. A buy cap of `target` alone made `migration_reserve_lamports` unraisable, so
   every mainnet migration would have failed for want of rent.
6. Crediting a not-yet-existing account manually.
7. **The lamport-reconciliation rule.** A `try_borrow_mut_lamports` write lands in
   the SBF input buffer and is flushed to the runtime only at instruction end, or
   per-CPI for the accounts named in THAT CPI's meta list. So the first CPI after a
   manual move must name every account it touched, or none. Fixed with a
   zero-lamport System transfer barrier. The arithmetic was correct the whole time
   — instrumentation, not reasoning, settled it. See
   `reference_solana_lamport_cpi_reconcile` in memory.

## Still not proven, even with CI green

- **`create_pool_fee` is 0 in CI.** `createAmmConfig(..., new BN(0), ...)` and
  cp-swap gates the native fee transfer on `create_pool_fee != 0`. The mainnet fee
  path — the entire reason `migration_reserve_lamports` exists — has never
  executed. Green here does NOT prove the reserve is sized correctly.
- **Compute cost is unmeasured.** Nothing had ever run past the WSOL transfer
  before the barrier landed, so the test now sets an explicit 400k CU limit, which
  means CI reports nothing about real consumption. Read the CUs from a rehearsal
  log and size the mainnet limit deliberately.
- **`sell` has never executed successfully anywhere in the repo.** It carries the
  same manual-mutation idiom and is safe only because nothing follows it. Appending
  any CPI there — or switching `emit!` to `emit_cpi!` — silently reintroduces
  defect 7 on the holders' only exit.
- Local box still cannot run a validator (`os error 1314`; `openssl-sys` fails for
  `solana-program-test` and `litesvm`). CI's Ubuntu runner is the gate.
