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

## The one genuine product decision left

### LP-token custody — NEEDS AN OWNER DECISION

cp-swap mints LP tokens to `creator_lp_token`, an account owned by the curve PDA.
Three options, and they are materially different promises:

| Option | Effect | Honesty cost |
| --- | --- | --- |
| **Burn** | Liquidity is permanently locked; nobody can ever withdraw it | Strongest claim, and irreversible. "LP burned" is verifiable on-chain. |
| **Hold in the curve PDA forever** | Functionally locked, but a future program upgrade could move it | Weaker than burning, and only as trustworthy as the upgrade authority |
| **Transfer to the launch creator** | Creator can withdraw the pool's liquidity | This is a rug vector. Do not do this without saying so extremely loudly. |

**Recommendation: burn.** It matches what the EVM leg does (`TegridyFeeLocker`
with `unlockDate == 0` is permanent and has no release path), it is the only
option that survives an upgrade-authority compromise, and it is the only one that
makes a "liquidity locked" Fact Sheet claim unconditionally true.

But it forecloses ever reclaiming that capital, so it is the operator's call, not
mine.

---

## Why the code is not written yet

Two reasons, both about verification rather than effort:

1. **The decisions above change the account layout and the state struct.** Writing
   the CPI first would mean rewriting it.
2. **This box cannot run any Solana runtime** — `cargo build-sbf` and
   `solana-test-validator` both fail with `os error 1314`, and
   `solana-program-test` / `litesvm` both fail building `openssl-sys`. A
   20-account fund-moving CPI written with no way to execute it is precisely how
   the `graduate` bug shipped.

The state and config groundwork the resolved decisions imply is being added now,
so that when the CPI is written it is a mechanical translation of this document
rather than design-on-the-fly. The CPI itself wants either Developer Mode enabled
locally or a devnet rehearsal in CI before it is trusted with funds.
