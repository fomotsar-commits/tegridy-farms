# Solana own-venue graduation — what is actually left

Owner directive 2026-07-28: build a **pump.fun-style bonding curve of our own**, and have
launched tokens **graduate into a venue we own**.

> **Correction (2026-07-28).** An earlier draft of this file estimated the Solana AMM as a
> ~700–1,000 LoC from-scratch build with a $60–150k audit. **That was wrong.** It was
> written from memory without checking the repo. `solana/tegridy-amm/` already contains a
> working Anchor project — a verbatim fork of Raydium's audited CPMM — and the operator
> already took the own-venue decision there on **2026-07-10**. The AMM half is largely
> done. Only the curve is missing. Figures below are the corrected ones.

## Ground truth in the repo today

**`solana/tegridy-amm/` — Tegridy CP-AMM. EXISTS, 72 tracked files.**

- Verbatim fork of [`raydium-cp-swap`](https://github.com/raydium-io/raydium-cp-swap)
  @ `78f254e`, **Apache-2.0**, audited, billions in production TVL.
- **The entire delta from upstream is four authority/identity constants across two files.**
  All swap, curve, and fee math is byte-identical to upstream. `solana-ci.yml` has a
  `diff-guard` job that enforces this automatically.
- Protocol fee is **config-driven, not hardcoded** — `amm_config.protocol_fee_rate` set at
  `create_config`, collected by `protocol_owner`. So the venue economics need no code change.
- Ships with `AUDIT_RFQ.md`, `MAINNET_RUNBOOK.md`, `SECURITY.md`, and a devnet deploy script.
- **Status: Phase 0. Devnet. NOT audited. NOT on mainnet. Holds no real funds.**

**The bonding curve now EXISTS.** ⚠️ Corrected 2026-08-02: this section previously read *"What
does NOT exist: the bonding curve. `programs/` contains only `cp-swap`."* That was written
before `tegridy-launch` landed and was never updated. It is false on this branch and has been
false since 2026-07-30. Telling an auditor a fund-holding program does not exist is the
wrong direction to be wrong in, so it is corrected here rather than left to the RFQ.

`programs/` contains **both** `cp-swap` and `tegridy-launch`. The latter is real Anchor code
under `programs/tegridy-launch/src/` — `lib.rs` (1,501 lines), `curve.rs` (750), `state.rs`,
`errors.rs` — with a `MIGRATE_DESIGN.md` and a graduation path. It is **unaudited and
undeployed**, which is a different claim from not existing.

## So the remaining work is auditing and deploying the curve, not writing it

| Piece | State | Remaining |
| --- | --- | --- |
| AMM to graduate into | **Built** (4-constant fork) | Diff-audit + mainnet deploy per the existing runbook |
| Bonding curve program | **Built, CI-green, UNAUDITED, UNDEPLOYED** | Full from-scratch audit of ~2,250 LoC; no audited upstream to diff against |
| Curve → AMM graduation | **Built** (`migrate_to_amm`) | Still the highest-risk instruction in the design; audit it as such |
| Creator fee split | **Not on this branch** — built on `claude/launcher-own-venue`, diverges from `programs/tegridy-launch/CREATOR_FEE_SPEC.md` §1 | Reconcile spec vs code, then land, then audit. It changes BOTH trade paths, so it must be settled **before** the RFQ is priced |
| Fee/treasury routing | Config-driven in the AMM | Curve-side claim path, Squads-vault-only |
| `create_pool_fee_reveiver` WSOL ATA | **Does not exist on mainnet** (verified 2026-08-02) | ~0.00204 SOL to create; until it does, every cp-swap `create_pool` fails |

### Corrected cost

- **AMM audit:** a *diff-audit* of four constants against audited upstream. Fast and cheap
  relative to a from-scratch AMM review — that is the entire point of the verbatim fork.
  `AUDIT_RFQ.md` is already written and names OtterSec / Neodyme / Sec3 / Zellic.
- **Curve audit:** this is where the real money goes. The curve and its graduation
  instruction are genuinely new, fund-holding code with no audited upstream to diff against.
- **Engineering:** roughly 3–6 weeks for the curve, not the 2–4 months the from-scratch
  framing implied.

## The risk that did not change

**The curve→AMM graduation instruction is where Solana launchpads get drained.** It moves
the entire raised balance in one instruction, and unlike the AMM it has no audited
reference to copy. Whatever else gets trimmed, that instruction deserves the deepest
review in the whole program.

Two other standing constraints, both unchanged:

- **Jupiter routing.** Our pools are invisible to retail until the Tegridy CP-AMM is
  submitted to Jupiter's DEX integration (step 8 of the mainnet runbook). Until then volume
  comes only from our own swap UI. Owning the venue costs discovery before it earns fees.
- **Break-even.** The ~$11.7M/mo figure is a property of running our own venue, not of how
  the AMM got written. Forking cheaply lowers the build cost, not the volume needed.

## The doctrine question, settled

`project_2026_06_18_solana_fee_capture`'s "no own AMM on Solana" was **superseded on
2026-07-10**, when the operator chose Model B (own venue) over Model A (be an LP) — recorded
in `TEGRIDY_FORK.md`. The 2026-07-28 directive continues that line rather than reversing it.

**"No TOWELI on Solana" is untouched and still absolute.** Nothing in the AMM fork or the
proposed curve puts TOWELI on Solana, and the two decisions must not be conflated.

## Recommended order

1. **Curve program** — the one genuinely missing piece. Graduates into a Tegridy CP-AMM pool.
2. **Send the AMM diff-audit RFQ now**, in parallel. It is written, the scope is tiny, and
   audit calendars — not engineering — are usually the schedule constraint.
3. **Curve audit** once the curve is feature-complete.
4. **Mainnet**, following the existing `MAINNET_RUNBOOK.md`: dedicated program keypair,
   `admin::ID` → Squads multisig, upgrade authority → multisig or burned, verifiable build,
   then Jupiter submission.

## Open decisions for the operator

- Curve shape: constant-product on virtual reserves (pump.fun-like), or a configurable
  price band? The former is better understood and easier to audit.
- Does the curve graduate into a **new** Tegridy CP-AMM pool per launch, or into a shared one?
  (Per-launch is the pump.fun model and keeps launches isolated.)
- Squads multisig + threshold for `admin::ID` and the program upgrade authority. Threshold
  must be ≥2 — the existing `squads.ts` threshold requirement is already a documented
  go-live blocker.
