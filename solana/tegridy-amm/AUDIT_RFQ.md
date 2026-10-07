# Audit RFQ — Tegridy CP-AMM (Solana)

> ⚠️ **TWO PROGRAMS, TWO VERY DIFFERENT ENGAGEMENTS. Price them separately.**
>
> - **Scope A, `cp-swap`:** a fork of Raydium's audited CPMM, delta = four constants plus
>   one added instruction (`create_lp_metadata`, about 150 lines, added 2026-10-06). A
>   **diff-audit**, with one instruction that needs a real read. Everything below the fold
>   describes this.
> - **Scope B — `tegridy-launch`:** ~1,170 production nSLOC of **NOVEL code** with no upstream to
>   diff against — a bonding curve plus a 20-account migration CPI that moves an entire
>   launch's raised balance in one instruction. This is a **real audit** and is where the
>   risk actually is. See "Scope B" below.
>
> Quoting only Scope A would leave the dangerous program unreviewed.

**Scope A one-liner:** review a **fork** of Raydium's audited CPMM
(`raydium-cp-swap`) whose *entire* delta from upstream is **four hardcoded
authority/identity constants** and **one added instruction, `create_lp_metadata`**. This is a
**diff-audit**, not a from-scratch AMM audit.

**The added instruction, and why it needs a real read.** A pool's lp token is a classic SPL
mint with no name record, so wallets list it as an unknown token. Metaplex only creates the
record when the mint authority signs, and that authority is the program's own address, so
only the program can ask. `create_lp_metadata` makes that one Metaplex call. It takes no
arguments (the name, symbol and link are fixed in the program), anyone may call it, and the
record's editor is `admin::ID`. The address that signs the inner call also owns every pool
vault, so the question for a reviewer is narrow and important: can this instruction do
anything other than create the name record of a real pool's lp mint? One fact to start
from: the caller picks the account that goes in the record slot, and the program does not
check it (Metaplex does). `TEGRIDY_FORK.md` ("The one added instruction") has the design, the
source it was taken from, and why we think the vaults are out of reach all the same.

---

## What it is
A Solana constant-product AMM so the protocol earns a config-set protocol fee on swaps
across pools it hosts. It is `raydium-cp-swap` with its identity and authority constants
changed and one instruction added (`create_lp_metadata`, above). Everything else is
upstream's code, unchanged.

- **Upstream:** https://github.com/raydium-io/raydium-cp-swap @ commit `78f254e1023751e706df7dc15c453fc3e046697c` (Apache-2.0)
- **Anchor** 0.32.1 · **Solana** 2.3.0 · program size (SBF): 691,640 bytes for the binary live on mainnet, which was built before `create_lp_metadata`; 724,672 bytes for a mainnet build of this source (2026-10-06)
- **Repo path:** `solana/tegridy-amm/` (see `TEGRIDY_FORK.md` for full detail)

## Exact scope: the whole code delta

**About 260 lines across three files** (the guard prints 261; it was 94 before
`create_lp_metadata` was added on 2026-10-06), and CI hashes that delta so it cannot drift
(see below). Reproduce it yourself with the `diff-guard` job in
`.github/workflows/solana-ci.yml`: it prints the full delta on every run.

Four identity constants. Each authority appears **twice**, once per `#[cfg]` arm
(`devnet` and default/mainnet), so the file shows six `pub const ID` edits for three
authorities:

| Constant | File | Change |
|---|---|---|
| `declare_id!` (program ID) | `programs/cp-swap/src/lib.rs` | Raydium → our program id. Mainnet arm: `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, the live program. Devnet arm: a throwaway. |
| `admin::ID` | `lib.rs` | Raydium → our admin. Mainnet arm: the Squads **vault PDA** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`, never the Squads multisig account. Devnet arm: a throwaway key. |
| `create_pool_fee_reveiver::ID` | `lib.rs` | Raydium WSOL acct → `2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa`, the vault's WSOL ATA. **A token account, not a wallet**: it is consumed as `InterfaceAccount<TokenAccount>` at `instructions/initialize.rs:131-135`. |
| `create_support_mint_associated_owner::ID` | `instructions/admin/create_support_mint_associated.rs` | Raydium → the same Squads vault PDA on the mainnet arm. |

(Corrected 2026-10-06. Until then this table described the mainnet arms as fail-closed
sentinels and both `declare_id!` arms as one devnet throwaway. They have held the real mainnet
identities since 2026-09-26, and the program has been live at that id since 2026-09-29.)

Three **non-constant** changes are in the delta as well, and we call them out rather than
let you find them and wonder what else we did not mention:

- **`lib.rs` `create_lp_metadata`** (added 2026-10-06): the one new instruction, about 150
  lines with its comments. Seven `use` lines, a 17-line handler with no arguments, a
  nine-account struct, and two helpers taken from Raydium CLMM's `open_position.rs`. It is
  described at the top of this document and in `TEGRIDY_FORK.md`, and it is the part of
  Scope A that needs a real read: it signs a Metaplex call with the address that owns every
  pool vault.
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

**Corrected again 2026-10-06:** the restart happened. Both programs have been live on mainnet
since 2026-09-29, at `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` (cp-swap) and
`64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2` (tegridy-launch), and cp-swap holds funded
pools. Neither has been audited. So the audit target is a live program as well as its source.
For cp-swap the two differ by one instruction: the binary on mainnet (sha256 `88b98aa9…`,
691,640 bytes, read on chain 2026-10-06) was built before `create_lp_metadata` was added, and
the instruction reaches mainnet only through an upgrade that the Squads vault signs.

---

## Self-verification we've already done (please confirm)
- `diff -rq` against pinned upstream shows **only those two files differ**, and only in the
  four constants and the one added instruction (`create_lp_metadata`, whole in `lib.rs`).
  This is **enforced on every push** by `.github/workflows/solana-ci.yml`
  (`diff-guard` job fails the build on any other divergence).
- `create_lp_metadata` was run on a local validator against copies of the two real mainnet
  pools (`frontend/scripts/solana-localnet/prove-lp-metadata.mjs`): the record it writes;
  twenty-five refused calls, each by its own error (twelve by this program's checks, eleven
  by Metaplex, two by the System program), eleven of them hostile record slots and payers
  such as a pool vault or the lp mint in the record slot; the inner call's exact account
  list; and every vault, lp mint and pool account byte-identical before and after.
- The program **compiles** in CI (`cargo build-sbf`), which also publishes the `.so`.
- After the fork, **no external (Raydium) party retains any authority** on the program.

## What we're asking you to verify
1. The `diff-rq`/diff-guard claim holds: nothing beyond the four constants and the one
   added instruction changed vs the audited upstream commit; the underlying upstream is at a
   safe, audited revision.
2. The four constants are wired correctly (each authority is used where intended; no
   authority path was missed or left pointing at a foreign key).
2a. `create_lp_metadata` can only create the Metaplex name record of a real pool's lp mint:
   the caller passes no words, `lp_mint` is bound to `pool_state`, the editor is `admin::ID`,
   and the inner call gets six accounts and no remaining account. Four of the six are fixed
   by the program. The caller picks the payer and the record slot, and **the program does not
   check the record slot**: a caller can put a pool vault, the lp mint or the signing address
   there, and it is passed on writable beside the signature of the address that owns every
   vault. We rely on two things for that: the runtime (a program can only call a program it
   was handed, so a vault and the token program can never both be in the call) and Metaplex
   (no upgrade authority on mainnet; it refuses every wrong record slot). Tell us whether
   that is enough, or whether the program should derive and check the record address itself.
3. **Mainnet build** sets `admin` and the support-mint owner to the Squads **vault PDA**
   `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`, the `create_pool_fee_reveiver` to that
   vault's **WSOL token account** (not a wallet: it's consumed as an
   `InterfaceAccount<TokenAccount>`), the program id to `EKS4C6x…`, and the **program upgrade
   authority** to the same vault PDA. Never the Squads multisig ACCOUNT `EVGSnRZ…`: it can
   neither sign nor pay, and naming it as admin is what bricked the August deploy.
   `scripts/verify-program-constants.mjs` checks a built binary for exactly this. (Until
   2026-10-06 this item named the multisig and described the mainnet defaults as sentinels.
   Both were out of date.)
4. The intended **deploy + `create_config`** process (create_config sets `protocol_owner =
   admin caller`; the real bound is `protocol_fee_rate + fund_fee_rate ≤ 1_000_000`) has no
   misconfiguration or front-running risk.
5. A **verifiable build** so on-chain bytecode is provably this source.

## Threat model / trust assumptions
See `TEGRIDY_FORK.md#threat-model`. In short: inherited risk ≈ Raydium CPMM in production
(unchanged); new surface = the admin key and the upgrade authority (both the Squads vault
PDA) and, since 2026-10-06, the one added instruction. The program is already live and holds
funds: this audit did not gate that deploy. The added instruction is not on mainnet yet.

## Deliverables to you
- Read access to `solana/tegridy-amm/` (this repo) + `TEGRIDY_FORK.md`
- The pinned upstream commit for the reference diff
- CI (`solana-ci.yml`) showing the enforced invariant + a reproducible build

## Recommended firms (Solana)
OtterSec · Neodyme · Sec3 · Zellic. Please quote a **fork/diff review** (not a full AMM
audit) given the scope above.
