# Audit RFQ — Tegridy CP-AMM (Solana)

> ⚠️ **TWO PROGRAMS, TWO VERY DIFFERENT ENGAGEMENTS. Price them separately.**
>
> - **Scope A — `cp-swap`:** a verbatim fork of Raydium's audited CPMM, delta = four
>   constants. A cheap **diff-audit**. Everything below the fold describes this.
> - **Scope B — `tegridy-launch`:** ~1,170 production nSLOC of **NOVEL code** with no upstream to
>   diff against — a bonding curve plus a 20-account migration CPI that moves an entire
>   launch's raised balance in one instruction. This is a **real audit** and is where the
>   risk actually is. See "Scope B" below.
>
> Quoting only Scope A would leave the dangerous program unreviewed.

**Scope A one-liner:** review a **verbatim fork** of Raydium's audited CPMM
(`raydium-cp-swap`) whose *entire* delta from upstream is **four hardcoded
authority/identity constants**. This is a **diff-audit**, not a from-scratch AMM audit.

---

## What it is
A Solana constant-product AMM so the protocol earns a config-set protocol fee on swaps
across pools it hosts. It is **not** novel code — it is `raydium-cp-swap` copied verbatim,
with only identity/authority constants changed.

- **Upstream:** https://github.com/raydium-io/raydium-cp-swap @ commit `78f254e1023751e706df7dc15c453fc3e046697c` (Apache-2.0)
- **Anchor** 0.32.1 · **Solana** 2.3.0 · program size ~692 KB (SBF)
- **Repo path:** `solana/tegridy-amm/` (see `TEGRIDY_FORK.md` for full detail)

## Exact scope — the whole code delta

**86 lines across three files**, and CI hashes that delta so it cannot drift (see
below). Reproduce it yourself with the `diff-guard` job in
`.github/workflows/solana-ci.yml` — it prints the full delta on every run.

Four identity constants. Each authority appears **twice**, once per `#[cfg]` arm
(`devnet` and default/mainnet), so the file shows six `pub const ID` edits for three
authorities:

| Constant | File | Change |
|---|---|---|
| `declare_id!` (program ID) | `programs/cp-swap/src/lib.rs` | Raydium → Tegridy program keypair. ⚠️ Both arms currently hold the same devnet throwaway; the mainnet arm is **not** fail-closed. |
| `admin::ID` | `lib.rs` | Raydium → Tegridy admin. Mainnet arm is a fail-closed System-Program sentinel pending a Squads multisig. |
| `create_pool_fee_reveiver::ID` | `lib.rs` | Raydium WSOL acct → Tegridy's WSOL ATA. **A token account, not a wallet** — it is consumed as `InterfaceAccount<TokenAccount>` at `instructions/initialize.rs:131-135`. Mainnet arm is a fail-closed sentinel. |
| `create_support_mint_associated_owner::ID` | `instructions/admin/create_support_mint_associated.rs` | Raydium → Tegridy admin. Mainnet arm is a fail-closed sentinel. |

Two **non-constant** changes are in the delta as well, and we call them out rather than
let you find them and wonder what else we did not mention:

- **`lib.rs` `security_txt!` block** — project name, URLs and contacts repointed from
  Raydium to us, and upstream's `auditors:` line (the MadShield report) **deliberately
  removed**, because that audit does not cover this fork and leaving it would be a false
  on-chain claim. Please confirm we removed it correctly and that nothing else in that
  block still asserts a Raydium property.
- **`Cargo.toml`** — the `description` string only. The old CI guard did not inspect
  `Cargo.toml` at all, which left a dependency swap unguarded; the current hash-based
  guard covers it.

**All swap / curve / fee / deposit / withdraw / oracle / state logic is byte-identical to
upstream** and out of scope beyond confirming it is unchanged.

---

# Scope B — `tegridy-launch` (NOVEL CODE, the real audit)

`solana/tegridy-amm/programs/tegridy-launch/` — **1,170 production nSLOC** (2,528 raw
lines; measured non-blank/non-comment, excluding the `#[cfg(test)]` module: `lib.rs` 815,
`curve.rs` 222, `state.rs` 78, `errors.rs` 55), Anchor 0.32.1. A
pump.fun-shaped bonding curve over virtual reserves. Tokens bond here and, on reaching a
graduation target, the whole raised balance migrates into a cp-swap pool **in a single
instruction**, with the **LP burned** so liquidity is permanently locked.

Instructions: `initialize_global`, `update_global`, `create_launch`, `buy`, `sell`,
`migrate_to_amm`. There is deliberately **no** `graduate` — an earlier split version was a
permissionless total-loss bug and was removed; see `MIGRATE_DESIGN.md`.

**Where to spend your time, in order:**

1. **`migrate_to_amm`** — permissionless, moves everything at once, CPIs 20 accounts, does
   direct lamport mutation, burns LP, closes three token accounts, sweeps a PDA to zero, and
   sets `complete` — all atomically. Every defect we found was in or around it.
2. **Account validation** — several accounts are `UncheckedAccount` and validated only
   inside cp-swap. Tell us whether that is actually sufficient.
3. **`curve.rs`** — pure, dependency-free, 23 host tests. Rounding is supposed to favour the
   curve on every path.
4. **Economic configuration** — `check_launch_economics` gates the reachability ceiling, a
   migration-reserve floor, and a graduation-price-continuity band. These are config-time
   only; we want to know what a hostile or careless authority can still configure.

**What we have already done (please confirm rather than rediscover):**

- CI (`solana-ci.yml`) runs a full **runtime rehearsal** on a local validator: create → buy →
  sell → migrate → assert LP supply is zero, replay-safety, post-migration refusal. It runs
  **adversarially** — it squats cp-swap's canonical pool AND dust-donates to the migration
  ATA before migrating — plus 16 account-constraint tests and 23 curve host tests.
- An internal multi-agent adversarial review with 3-vote refutation. **Already found and
  fixed — please do not re-report, but DO look for the same classes elsewhere:**
  per-CPI lamport reconciliation (`UnbalancedInstruction`); squattable canonical pool PDA;
  SBF 4 KB stack overflow in `try_accounts`; unsettable `cp_swap_program`/`amm_config`;
  a dust donation bricking `close_account`; graduation price gap; reserve floor.

**Known and accepted (argue if you disagree):**
- A 1-lamport `sell` front-run stalls a pending migration until the next buy. `sell` is
  unpausable by design. A stall, not a brick; the griefer pays a fee each time.
- The migration surplus is swept to whoever calls `migrate_to_amm`, deliberately — it makes
  a permissionless step self-financing rather than a guaranteed loss.

**Deployment history (corrected 2026-08-24 — the previous revision of this section said
"not deployed", which had been false since 2026-08-08):** both programs WERE deployed to
mainnet on 2026-08-08 and were CLOSED on/before 2026-08-15 — the program ids are
permanently spent and can never be reused. Any future deployment is a RESTART with fresh
keypairs and a new `declare_id!` (see MAINNET_RUNBOOK.md § "THE RESTART, IN ORDER").
The audit target is therefore the source at the commit under review, not a live program.

---

## Self-verification we've already done (please confirm)
- `diff -rq` against pinned upstream shows **only those two files differ**, and only in the
  four constants. This is **enforced on every push** by `.github/workflows/solana-ci.yml`
  (`diff-guard` job fails the build on any other divergence).
- The program **compiles** in CI (`cargo build-sbf`), which also publishes the `.so`.
- After the fork, **no external (Raydium) party retains any authority** on the program.

## What we're asking you to verify
1. The `diff-rq`/diff-guard claim holds — nothing beyond the four constants changed vs the
   audited upstream commit; the underlying upstream is at a safe, audited revision.
2. The four constants are wired correctly (each authority is used where intended; no
   authority path was missed or left pointing at a foreign key).
3. **Mainnet build** sets `admin` + support-mint owner to the **Squads multisig**, the
   `create_pool_fee_reveiver` to the treasury's **WSOL token account** (not a wallet — it's
   consumed as an `InterfaceAccount<TokenAccount>`), a fresh mainnet program keypair, and the
   **program upgrade authority** to the multisig (or burned). The non-devnet defaults are
   fail-closed System-Program sentinels — confirm none survive into the mainnet build.
4. The intended **deploy + `create_config`** process (create_config sets `protocol_owner =
   admin caller`; the real bound is `protocol_fee_rate + fund_fee_rate ≤ 1_000_000`) has no
   misconfiguration or front-running risk.
5. A **verifiable build** so on-chain bytecode is provably this source.

## Threat model / trust assumptions
See `TEGRIDY_FORK.md#threat-model`. In short: inherited risk ≈ Raydium CPMM in production
(unchanged); new surface = admin key (→ multisig) + upgrade authority (→ multisig/burned).
Fund-holding mainnet deploy is gated on this audit.

## Deliverables to you
- Read access to `solana/tegridy-amm/` (this repo) + `TEGRIDY_FORK.md`
- The pinned upstream commit for the reference diff
- CI (`solana-ci.yml`) showing the enforced invariant + a reproducible build

## Recommended firms (Solana)
OtterSec · Neodyme · Sec3 · Zellic. Please quote a **fork/diff review** (not a full AMM
audit) given the scope above.
