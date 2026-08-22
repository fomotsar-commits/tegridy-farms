# Creator fee split — implementation spec

> **STATUS, corrected 2026-08-02 when this file was first pushed to a remote.**
>
> Relative to this branch the body below is still accurate: `tegridy-launch` here pays the
> creator nothing, and `curve.rs` has no `split_fee`. But an implementation **does** exist,
> on branch `claude/launcher-own-venue`, and it **diverges from §1**:
>
> | §1 prescribes | What was actually built |
> | --- | --- |
> | share is a **compile-time constant** | `creator_fee_share_bps: u64` stored on `GlobalConfig` **and** snapshotted onto each `BondingCurve` at `create_launch`, so a live launch can never be repriced |
> | (not anticipated) | `payable_creator_split()` folds an **undeliverable** creator credit into the protocol leg — paying an arbitrary creator account makes it writable on every trade, and Solana rejects a writable account moved into the rent-paying band, which otherwise bricked *sells* under ~0.178 SOL |
>
> Read §1 as the decision record, not as a description of the code. Reconcile the two before
> the audit RFQ goes out — the RFQ prices the trade paths, and these change them.

## The problem

`tegridy-launch` pays the token creator **nothing**. 100% of every trade fee goes to
`global.fee_recipient` (`lib.rs:509-520` on buy, `lib.rs:626-638` on sell). `curve.creator`
exists (`state.rs:127`) but is never paid.

Our own Meteora DBC config pays creators **48 bps** of every trade. Pump.fun pays **30 bps**.
As built, our own venue is the least attractive of the three to the exact people it must
attract — and post-graduation it is structurally zero too, because `migrate_to_amm` calls
cp-swap's permissionless `initialize`, which hardcodes `enable_creator_fee = false`, and the
fork has no setter. **The curve is the only place a creator can ever be paid.**

## 1. Decision

Ship **Constant-Split Direct Pay**: partition the fee that already exists, do not add a
second fee. The creator's share is a **compile-time constant**, not stored governable state.
Pay `curve.creator` directly in the same instruction that charges the fee — no accrual
balance, no claim instruction, no escrow.

```rust
pub const CREATOR_FEE_SHARE_BPS: u64 = 4_800;
const _: () = assert!(CREATOR_FEE_SHARE_BPS <= 8_000);
```

**Why 4,800.** It is exact parity with the Meteora config we already operate, so the
creator-facing claim is checkable against something public rather than something they must
take on trust, and it beats pump.fun by 60% at the same 1% trader fee. Our own net *rises*
from 32 bps (DBC) to **52 bps** here, because there is no Meteora leg to pay — migrating a
creator from our DBC rail to our own curve is +62.5% revenue per trade at zero creator cost,
and that argument only exists if the share is held at parity rather than bid above it.

**Why a constant rather than a `GlobalConfig` field.** The snapshot invariant
(`state.rs:136-138`) exists so a governance *signature* cannot reprice a live launch. A
constant is immune to every signature — it moves only by a program upgrade, which can already
rewrite every other rule. So it is snapshotted for free: no field, no `update_global`
argument, no config-time validation, no account-size change, and — decisively, given that the
frontend has **no committed IDL** and every layout and discriminator is hand-encoded — no
decoder-offset change anywhere.

Trade-off, accepted deliberately: **the ratio is not governable.** Changing it needs a program
upgrade. `trade_fee_bps` *is* governable (`lib.rs:288-291`), so absolute creator revenue still
moves. Nothing is deployed, so the number is free to fix now with full information.

## 2. State changes

| Location | Change |
| --- | --- |
| `curve.rs:37` | ADD `CREATOR_FEE_SHARE_BPS` + compile-time bound assertion |
| `curve.rs:106` | ADD `pub fn split_fee(fee) -> (creator, protocol)` beside `fee_up` |
| `state.rs:205` | ADD `creator_fee_lamports: u64` to `Traded`, **appended last** |
| `lib.rs:1499` | ADD one account to `Trade`, **declared last** |

**Nothing else changes.** State the negative explicitly in the commit: `GlobalConfig` stays
186 bytes, `BondingCurve` stays 162 with `complete` at offset 128, no new error variant
(reuse `Unauthorized`, 6008), no new instruction argument, and `migrate_to_amm`
(`lib.rs:693-1188`) is untouched — verified it never reads `curve.creator`; its `creator:`
references are cp-swap's, bound to the `migauth` PDA.

```rust
/// Split an already-computed fee into (creator, protocol).
///
/// ONE division and ONE subtraction — never two divisions. `protocol` is DEFINED as
/// the remainder, so `creator + protocol == fee` is an identity, not a coincidence.
#[inline]
pub fn split_fee(fee_lamports: u64) -> (u64, u64) {
    let creator = ((fee_lamports as u128) * (CREATOR_FEE_SHARE_BPS as u128)
        / (BPS_DENOMINATOR as u128)) as u64;   // FLOOR — contrast fee_up's div_ceil
    (creator, fee_lamports - creator)
}
```

Computing the protocol leg as a second independent `fee_up(fee, 10_000 - share)` sums to
`fee + 1` and leaves `sell`'s manual lamport block one lamport short — a reconciliation
failure on **every** trade, discoverable only on a validator. Two independent floors sum to
`fee - 1` and strand a lamport in the curve PDA, permanently desynchronising its balance from
`real_sol_reserves`.

The account, declared **after** `system_program` so indices 0-8 do not shift:

```rust
/// CHECK: address-constrained to this launch's own immutable creator.
#[account(mut, address = curve.creator @ LaunchError::Unauthorized)]
pub creator: UncheckedAccount<'info>,
```

## 3. Buy path — `lib.rs:497-520`

`buy` contains **zero** `try_borrow_mut_lamports` writes; every lamport leg is a
`system_program::transfer` signed by the trader. **Defect 7 cannot apply on this path in any
ordering** — say that in the RFQ so the auditor does not re-derive it.

Compute `split_fee(q.fee_lamports)`, send `protocol_cut` to `fee_recipient` in the existing
block, then add a third trader-signed transfer of the creator's cut. Ordering: principal stays
first (a fee-first order would make `simulateTransaction` report "fee transfer failed" for a
plain insufficient-funds buy); protocol leg keeps its existing position so log scrapers see an
*appended* leg, not a reordered one; both before the token transfer so `lib.rs:497`'s "Move
SOL first" comment stays literally true.

**`creator == trader` is the common case (the dev buy) and needs no special case.** The System
program's `transfer_verified` borrows `from`, subtracts, **explicitly drops `from`**, then
borrows `to` — precisely so self-transfer works. Do *not* "optimise" it away with a
`creator.key() != trader.key()` branch: skipping the leg would make the trader's total debit
differ between aliased and non-aliased trades, and would make `creator_fee_lamports` report
lamports that never moved.

## 4. Sell path — `lib.rs:602-660` ⚠️ the hazardous one

`MIGRATE_DESIGN.md:315-320` names this exact modification by name. **The creator leg MUST be a
fourth manual lamport credit inside the same uncommitted block — never a
`system_program::transfer`.** Two independent reasons: the curve PDA is program-owned and
cannot sign one, and any CPI appended after the manual moves flushes a partial view and aborts
with "sum of account balances before and after instruction do not match."

Order within the block: debit curve (unchanged) → credit trader (unchanged) → credit creator
(rent-guarded, §5) → credit protocol **last**, so the fold is already resolved. State writes
and `emit!` follow, unchanged.

**Balance identity:** the curve debit stays `q.gross_lamports`, so the rent-floor check at
`lib.rs:605-614` needs no change. Credits total
`lamports_out + paid_creator + protocol_cut == lamports_out + fee_lamports == gross_lamports`
exactly, because `protocol_cut` is defined by subtraction and the fold moves lamports
*between* legs rather than out of the sum.

**Four hard rules for the implementer:**

- **(a)** Do **not** convert `emit!` to `emit_cpi!`. `emit!` is `sol_log_data`, a syscall, not
  a CPI. `grep emit_cpi` returns nothing today; keep it that way.
- **(b)** Do **not** append any CPI after the manual block, ever.
- **(c)** Each credit stays its own `**ai.try_borrow_mut_lamports()? = ai.lamports() + x;`
  statement. This is safe **only** because Rust evaluates the assigned value before the
  assignee place expression, so `.lamports()` takes and drops its shared borrow first. A
  "tidy-up" to `let mut l = ai.try_borrow_mut_lamports()?; **l = ai.lamports() + x;` panics
  with `AccountBorrowFailed` whenever `creator` aliases `trader`. **Safe by evaluation order,
  not by design — comment on it.**
- **(d)** Do not reorder the protocol leg before the creator leg.

## 5. The rent-band guard — a blocker, and the reason this spec is not a two-liner

**This program already documents the mechanism in its own words**, at `lib.rs:836-850`: a
writable account whose post-instruction balance lands strictly between 1 lamport and
`minimum_balance(0)` (= 890,880) is rejected with `InsufficientFundsForRent`. Because
`creator` must be `mut` to be credited, it enters that check.

Against a creator account at zero, at 100 bps / 4,800 share:

| gross trade size X (lamports) | `creator_cut` | outcome with no guard |
| --- | --- | --- |
| X ≤ 200 | 0 | succeeds (nothing credited) |
| 201 ≤ X ≤ 185,599,900 | 1 … 890,879 | **whole transaction fails** |
| X ≥ 185,599,901 (≈0.1856 SOL) | ≥ 890,880 | succeeds, and repairs the account |

This is **not** an acceptable stall. It lands on `sell` — the instruction `lib.rs:563-564` and
`state.rs:116-118` both declare must stay open through a pause, "the one instruction holders
cannot be denied." It converts an operator-proof exit into a **creator-pausable** one: exit
priority is worth money on a constant-product curve, rent state is checked per instruction so
`[sell][drain creator to 0]` in one transaction takes the exit and re-arms the freeze
atomically, and repairing it costs a third party 890,880 lamports **which land in the
creator's wallet** while re-draining costs the creator a 5,000-lamport fee. The griefer pays
the griefer's victim.

Worse, `curve.creator` need not be a wallet: a data-less PDA is System-owned and can sign
`create_launch` via CPI, so a third-party program with any permissionless drain path makes the
freeze externally triggerable on any launch, and the creator cannot stop it.

**The fix must fold, not top up**, because a top-up CPI on `sell` reintroduces defect 7:

```rust
/// How much of `creator_cut` may be credited without pushing `creator` into the
/// SVM's rejected rent band. Returns 0 (fold to protocol) rather than reverting.
///
/// The predicate is a property of the POST state, not the zero-ness of the pre
/// state — `lib.rs:847-850` is on record that an `== 0` guard is insufficient here.
fn payable_creator_cut_with(rent: &Rent, creator_ai: &AccountInfo, cut: u64) -> Result<u64> {
    if cut == 0 { return Ok(0); }
    let post = creator_ai.lamports().checked_add(cut).ok_or(LaunchError::Overflow)?;
    Ok(if post < rent.minimum_balance(creator_ai.data_len()) { 0 } else { cut })
}
```

The guard fires **exactly** when the credit would abort and never otherwise. Do **not** reduce
it to `lamports() == 0 && data_is_empty()`: that misses the sub-floor-but-nonzero band and
*over*-fires on a rent-exempt data-carrying creator, silently diverting their money to the
protocol. Note the incentive that creates — the protocol would profit from misclassifying the
creator's account. The band predicate has no such asymmetry.

**One contradiction to escalate rather than paper over.** `lib.rs:847-850` justifies its
top-up with "this address is derivable, so anyone can send it 1 lamport." Under the transition
rule above, a bare 1-lamport transfer to a zero-lamport address would itself be rejected — so
either that comment's threat model is unreachable (code still correct, just over-defended) or
the transition rule is not what we believe (in which case this finding gets *worse*). **The
guard above is correct under either reading.** Put it in the RFQ as a "confirm which holds"
line item and fix the comment either way.

## 6. Why no theft is possible

The substitution chain is closed at every link, each verified:

1. The caller chooses `mint`, but `curve` is then forced three ways — `seeds`, `bump`,
   `has_one = mint` (`lib.rs:1475-1481`). One curve per mint.
2. `c.creator = ...` appears **exactly once**, at `lib.rs:425`, from a `Signer`
   (`lib.rs:1257`). No setter exists; `update_global` cannot reach a curve at all.
3. **No `close =` constraint exists anywhere in the program** — verified — so the curve PDA
   cannot be closed and re-`init`ed with a fresh creator. Even if it could, `create_launch`
   requires `mint.mint_authority == Some(creator)` and `mint.supply == 0`, both destroyed by
   the first launch: a mint can be launched exactly once, ever.
4. `#[account(mut)]` on an `UncheckedAccount` does generate the `is_writable` check, so a
   read-only `creator` meta fails closed with `ConstraintMut`.

Wash-trading is unprofitable: a creator round-trip costs 2 × 100 bps and recovers 2 × 48 bps,
a net ~1.04% loss of notional — identical to our existing DBC exposure, not a new class.

**Deliberately NOT added:** a mutable `creator_fee_recipient` or a `set_creator_fee_recipient`
instruction. That is a new authorization surface and a ready-made social-engineering vector. A
creator who wants fees elsewhere launches from that address. **Consequence to accept now: the
payout address is immutable for the life of the curve — no sale of creator rights, no rotation
on key loss.**

## 7. Frontend blast radius

Must change: `ix.ts:143-154` (`TradeAccounts` gains a **required** `creator`), `ix.ts:156-168`
(`tradeKeys` appends index 9 — `buyIx`/`sellIx` need no edit, both delegate), `ix.test.ts`
(five literals, plus **add** a `keys.length === 10` assertion — `Trade` has no length
assertion today, a real gap), `math.ts` (add `splitFee` using **floor `/`, not `divCeil`** —
`divCeil` sits four lines above `feeUp` and is exactly the wrong function to copy),
`curveVectors.fixture.ts` + `gen_curve_vectors.rs` (regenerate with a `SPLIT_FEE_VECTORS`
block), `math.test.ts`, the Anchor test account maps, and `OWN_CURVE_FRONTEND_CONTRACT.md`.

Must **not** change, and the commit should say so: `GLOBAL_CONFIG_SIZE = 186`,
`BONDING_CURVE_SIZE = 162`, every decoder byte offset, all three discriminator tables (Anchor
derives them from `sha256("global:<name>")` — the **name**, not the signature or account
list), and `LAUNCH_ERROR_CODES`. If `program.test.ts:93`/`:98` or `read.test.ts:591-592` move,
a layout was touched and the change is wrong.

`CurveLaunchPage.tsx` needs no change — `grep` for `buyIx|sellIx` outside `curve/ix*` returns
nothing, so the write surface has no production caller yet.

## 8. Test plan

**Host** (`cargo test`, no validator): proptest `∀f: c + p == f` (kills any
two-independent-roundings mutation); `split_fee(3) == (1,2)` and `split_fee(2) == (0,2)`
(kills a floor→ceil flip); `split_fee(u64::MAX)` no panic; `split_fee(0) == (0,0)`.

**Differential:** `SPLIT_FEE_VECTORS` replayed against `math.ts` — kills a `divCeil`-for-floor
transcription in TypeScript, which no Rust test can catch.

**Validator — this is where the money is.** The required mutation test is **M1**: after a buy
and after a sell, `creator`'s balance increased by exactly `floor(fee × 4800 / 10000)` taken
from the emitted `Traded` event, and `fee_recipient`'s by exactly the remainder. **It fails on
pre-change code** (creator delta 0, fee_recipient gets the full fee) and it pins the split
*relation*, not a lamport literal.

Then: **M3** — drain the creator to 0 and trade at **three sizes** spanning the rent band
(dust ≤200, mid ≈0.05 SOL, large ≥0.19 SOL) and assert all three succeed. **One size is not
enough**: without the guard, dust passes (nothing credited) and large passes (the credit
clears the floor), so *only the mid case exposes it*. **M4** — same with a data-carrying
creator below its own `minimum_balance(data_len)`. **M5** — the atomic `[sell][drain creator]`
griefing transaction, then a bare third-party `sellIx` must still succeed. **M6a/M6b** —
`creator == trader` on both paths with exact delta assertions (buy and sell are safe by
*different* mechanisms; one test does not cover both). **M7** — `creator == fee_recipient`.
**M8/M9** — wrong creator → `Unauthorized`; read-only creator → `ConstraintMut`.

## 9. Audit scope delta

**Zero delta to the pricing math** — `quote_buy`, `quote_sell`, `fee_up`,
`lamports_until_target`, `continuity_target` all unchanged, so the 3,815-row fixture stays
valid. **Zero delta to `migrate_to_amm`.** No new instruction, stored state, account-size or
discriminator change, error code, governance parameter, or instruction argument.

What genuinely grows, ranked: (1) `sell` acquires a fourth manual lamport credit on the
holders' unpausable exit; (2) a new rent-band branch on both trade paths — new logic, not a
second instance of a reviewed pattern, and the highest-value thing to audit; (3) `Trade` gains
an account whose payee is chosen by the launch creator rather than governance — one operator
address becomes N creator-nominatable ones; (4) aliasing safety rests on duplicate-`AccountInfo`
lamport-cell sharing plus Rust evaluation order — **both reasoned here, neither observed.**

**Realistic incremental cost: +0.5 to 1 auditor-day** (~45-60 lines of Rust across three
files). Do not let it be scoped as "read the diff": the two defects this program has already
paid for were invisible to `cargo check` *and* to source review, and seven CI iterations on
`migrate_to_amm` were seven real runtime-only defects.

⚠️ **Do not repeat the retracted claim that `sell` "has never executed successfully anywhere in
the repo."** That entry was corrected on 2026-08-02 — `sell` executes for real at
`tests/tegridy-launch-migration.test.ts:236-249`. The unproven thing is the *modification
hazard*, not the instruction.

## 10. What this does not solve

- **Post-graduation creator fees remain structurally impossible.** Marketing must say
  "creators earn on the curve," never "creators earn forever," and the Fact Sheet should show
  the stream terminating at graduation. Someone will check.
- **The ratio is not governable** without a program upgrade.
- **Creator identity is fixed forever** at `create_launch`. No transfer, no rotation on key
  loss. Decide now, not after the audit.
- **A creator can still forfeit their own fees** by holding a sub-rent-exempt balance — §5
  folds to the protocol rather than reverting. Correct trade (holders' exit beats the
  creator's fee), but their revenue is silently zero until they fund the address.
  `creator_fee_lamports` is what makes it visible; the UI should surface it.
- **`global.fee_recipient` retains the identical pre-existing rent hazard.** Unchanged by
  design, operator-controlled, out of scope — but name it in the RFQ.
- **No indexer work.** `Traded` is decoded nowhere in `frontend/src` today.

---

## Provenance and confidence

Produced 2026-08-02 by a judged design bake-off (three competing designs, three judge lenses,
four adversarial passes on fee theft / lamport accounting / rounding-and-dust / invariant
breaks). Two limitations worth knowing:

- **One design was truncated before reaching two of the three judges**, so
  `configurable-per-launch` was scored by only one. Its central idea — operator-selectable
  per-launch splits — was rejected on audit-surface grounds by both delivered designs, but it
  did not get a full hearing. Revisit if a fee-tier product surface is ever wanted.
- **The rent-band mechanism (§5) is documented in this program's own comments and the guard is
  correct under either reading of the SVM transition rule — but it has not been observed on a
  validator.** The local box cannot run one (`os error 1314`; `openssl-sys` fails for
  `solana-program-test` and `litesvm`), so CI's Ubuntu runner is the gate. Treat M3/M4/M5 as
  the acceptance criteria, not this document.

Every file:line citation in this spec was re-verified against the source, including the four
that carry the no-theft argument: the single `c.creator` write, the absence of any `close =`,
the `fee_recipient` constraint being mirrored, and `migrate_to_amm` not reading `curve.creator`.
