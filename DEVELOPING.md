# DEVELOPING.md — moved

**The maintained developer guide is [`docs/DEVELOPING.md`](docs/DEVELOPING.md). Read that one.**

## Why this file is a pointer

There were two developer guides in this repository, with overlapping content and no statement
of which was authoritative:

| File | Last substantive update | State |
|---|---|---|
| `DEVELOPING.md` (this file) | **2026-04-20** | Four months stale |
| [`docs/DEVELOPING.md`](docs/DEVELOPING.md) | **2026-08-21** | Maintained — carries the gotchas |

Two guides is not redundancy, it is a coin flip. A contributor who opened this one got a
setup guide that predated the 2026-06-06 relaunch, the 2026-07-16 gated batch, the
multichain legs, and every hard-won environment gotcha the other file records — the junction
`node_modules` that `rm -rf` will follow and delete the real tree through, the PowerShell 5.1
non-ASCII round-trip that corrupts files, the Git Bash path mangling that produces false
negatives, and the standing rule that **a search which could not run is not a negative
result.**

Deleting this file outright would break inbound links from older docs and from external
references, and a missing file reads as a mistake rather than as a decision. A stub that
names its replacement is the cheaper failure — the same reasoning
[`NEXT_SESSION.md`](NEXT_SESSION.md) is kept under.

The previous contents are in git history.

## Everything else you might have come here for

| You want | Read |
|---|---|
| Local setup, running the three workspaces, the gotchas | [`docs/DEVELOPING.md`](docs/DEVELOPING.md) |
| How to contribute, and **which branch to target** | [`CONTRIBUTING.md`](CONTRIBUTING.md) — the trunk is `mvp-launch`, not `main` |
| How the contracts fit together | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| The canonical contract addresses | [`CONTRACTS.md`](CONTRACTS.md) and [`frontend/scripts/addresses.json`](frontend/scripts/addresses.json) |
| Deploy flow and rollback | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| What is left to do | [`docs/TODO_OPERATOR.md`](docs/TODO_OPERATOR.md) |

*Pointer written 2026-09-04.*
