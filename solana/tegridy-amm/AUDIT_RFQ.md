# Audit RFQ — Tegridy CP-AMM (Solana)

**One-line scope:** review a **verbatim fork** of Raydium's audited CPMM
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
Confined to two files, four constants (verifiable + CI-enforced, see below):

| Constant | File | Change |
|---|---|---|
| `declare_id!` (program ID) | `programs/cp-swap/src/lib.rs` | Raydium → Tegridy program keypair |
| `admin::ID` | `lib.rs` | Raydium → Tegridy admin (mainnet: Squads multisig) |
| `create_pool_fee_reveiver::ID` | `lib.rs` | Raydium WSOL acct → Tegridy's WSOL ATA (token account) |
| `create_support_mint_associated_owner::ID` | `instructions/admin/create_support_mint_associated.rs` | Raydium → Tegridy admin |

**All swap / curve / fee / deposit / withdraw / oracle / state logic is byte-identical to
upstream** and out of scope beyond confirming it is unchanged.

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
