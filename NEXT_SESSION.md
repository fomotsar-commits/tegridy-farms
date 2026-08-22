# Next Session — superseded

**This file is no longer the handoff. Do not follow it. Retired 2026-08-19.**

Everything below the line used to be a session-13 handoff written 2026-04-18. It was
left in place for four months while the repo moved, and by August it had stopped being
merely stale and become dangerous: its "immediate priorities" walked the operator through
claiming ownership from a Safe on three contracts that the 2026-06-06 `DeployMVP` relaunch
superseded, and through redeploys whose constructor arguments no longer match the sources
in `contracts/src/`. One of those three addresses is the Wave-0
`GaugeController` whose `pairToGauge(address)` reverts — the brick that
`frontend/src/lib/docsAddressTruth.test.ts` exists to keep out of the docs. A runbook a
human executes is an on-chain action, so the content is removed rather than annotated.

The historical text is not lost: it is in git history, and the audit archive under
`.audit_101/` quotes the parts that mattered (`095_DocsDrift.md` records it as
fossilised at session 13).

## Where the handoff actually lives now

| You want | Read |
|---|---|
| The ordered list of things only the operator can do | [`docs/OPERATOR_NEXT.md`](docs/OPERATOR_NEXT.md) |
| The same list ranked by unlock-per-minute | [`docs/WHAT_I_NEED_FROM_YOU.md`](docs/WHAT_I_NEED_FROM_YOU.md) |
| What to build next, per item, with preconditions | [`docs/BATTLE_PLAN.md`](docs/BATTLE_PLAN.md) |
| The 12-month plan and its quarter gates | [`docs/YEAR_PLAN_2026_2027.md`](docs/YEAR_PLAN_2026_2027.md) |
| What is unfinished, half-built, dead or stale | [`docs/EVERYTHING_LEFT_2026_08_15.md`](docs/EVERYTHING_LEFT_2026_08_15.md) |
| Which address is canonical and which is retired | [`docs/MIGRATION_HISTORY.md`](docs/MIGRATION_HISTORY.md), [`frontend/scripts/addresses.json`](frontend/scripts/addresses.json) |
| The custody re-home ceremony | [`docs/SAFE_REHOME_RUNBOOK.md`](docs/SAFE_REHOME_RUNBOOK.md) |

`frontend/scripts/addresses.json` is the registry of record for every address, and
`frontend/scripts/verify-addresses.mjs` fails CI when a doc and the chain disagree.
Prefer it over any prose — including this file — when the two conflict.

## Why this file still exists at all

Deleting it would leave the paste-me block that several earlier sessions distributed
("Read NEXT_SESSION.md at the repo root") pointing at nothing, and a missing file reads
as a mistake rather than as a decision. A stub that names its own replacement is the
cheaper failure.
