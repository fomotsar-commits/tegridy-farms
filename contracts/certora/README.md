# Certora Formal Verification — TegridyStaking

Phase 1.4 starter — formal-verification rules for the highest-stakes
`TegridyStaking` invariants. These rules are the Certora-CVL translation
of the six `check_*` symbolic properties already written in
[`contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol`](../test/halmos/MVPLaunch_HalmosSpecs.t.sol)
(Phase 1.3 handoff). Halmos exhausts symbolic inputs; Certora aims for
unbounded mathematical proof.

## Layout

```
contracts/certora/
├── README.md                           ← this file
├── specs/
│   ├── TegridyStaking.conf             ← Certora invocation config
│   └── TegridyStaking.spec             ← 6 CVL rules
└── harness/
    └── TegridyStakingHarness.sol       ← thin wrapper for FV deployment
```

Mirrors the layout used by OpenZeppelin's `fv/` directory (see
`contracts/lib/openzeppelin-contracts/fv/` for reference).

## Properties verified

| Rule | Halmos source | Property |
|---|---|---|
| `globalCapRespected` | `check_globalCap` | `stake()` either reverts or `totalStaked` stays ≤ `maxTotalStaked` |
| `perUserCapRespected` | `check_perUserCap` | Successful `stake()` implies `amount ≤ maxStakePerUser` |
| `principalRecoverableAfterStake` | `check_principalRecoverableAfterStake` | After successful `stake()`, the contract's TOWELI balance is ≥ `totalStaked` |
| `capCannotBeZeroed` | `check_capCannotBeZero` | `setMaxStakePerUser(0)` and `setMaxTotalStaked(0)` always revert |
| `pauseAuthExclusive` | `check_pauseAuth` | `pause()` is owner-only; `guardianPause()` is guardian-only |
| `guardianCannotUnpause` | `check_guardianCannotUnpause` | Guardian role has pause-only authority — `unpause()` is owner-only |

These are the canonical Phase 1.3 → Phase 1.4 starter set per the
mvp-launch sprint plan.

## How to run

Certora is a cloud-based prover that requires a license and the
`certora-cli` Python package. Auditors with access can invoke it like:

```bash
pip install certora-cli                 # one-time setup
export CERTORAKEY=<your-cli-key>        # provided by Certora

cd contracts
certoraRun certora/specs/TegridyStaking.conf
```

The `.conf` file pins:
- The harness contract under verification
- The link to the spec
- Optimizer settings + Solidity compiler version

Expected first-run output (per rule):
- `globalCapRespected`        : status pending
- `perUserCapRespected`       : status pending
- `principalRecoverableAfterStake` : status pending
- `capCannotBeZeroed`         : status pending
- `pauseAuthExclusive`        : status pending
- `guardianCannotUnpause`     : status pending

A green tick = mathematical proof; a red X = counterexample (Certora
prints the trace). Treat any red as a finding to triage before
production engagement (Spearbit/Sherlock/Certora-paid run).

## Why this exists before engagement

These specs are the **vendor-facing artefact** that signals
"this protocol has a written invariant set worth proving." Engaging
Certora-paid means handing this file (+ the threat model in
`TRUST_ASSUMPTIONS_MVP.md`) to their team as the brief, NOT starting
from scratch. Pre-written specs cut engagement scoping from
~2-3 weeks to ~3-5 days.

## Not in this PR

- A Certora license / cloud subscription — that's the
  engagement decision Phase 1.4 itself is gating on.
- Additional contracts (TegridyRestaking, RevenueDistributor, etc.) —
  this PR covers only the staking-cap + pause-authority surface,
  which is the highest-stakes invariant set per the Phase 1.3
  prioritisation. Other contracts can land in follow-up PRs once the
  TegridyStaking rules are accepted by the Certora team.

## Maintenance contract

When `TegridyStaking` storage layout shifts or when new public methods
are added that could affect the invariants above, the rules MUST be
re-reviewed. The CI `forge build` on this PR's branch typechecks the
harness contract; the `.spec` file is text-only and is verified by
Certora's own typecheck only when `certoraRun` is invoked.
