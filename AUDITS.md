# Tegridy Farms — Audit Index

Every security review, external audit, fix tracker, and audit-derived test file in this repository. Nothing is hidden. If you find a reference to an audit artifact that isn't linked here, open an issue.

---

## TL;DR

- **14+ audit artifacts** across 7 rounds of review (Mar 25 — Apr 17, 2026).
- Each round is preserved as a separate file so the fix trail is reconstructible.
- The **canonical severity reference** is [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) (most recent full-scale review, ingests the external Spartan audit).
- The **current `main` blocker list** is [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) (35-detective parallel sweep against the latest working tree).
- **Live remediation status** is [`FIX_STATUS.md`](./FIX_STATUS.md) — rolling tracker of what's shipped on `main` and what's deferred. Read this before depositing significant capital.
- **Contract-level regression harness** — 27 audit-derived test files in [`contracts/test/`](./contracts/test/) (~1,921 tests total). Every finding that could be expressed as a test has one.

If you're in a hurry and want one number: **1 Critical and 1 High from the latest external audit (Spartan, Apr 16) have remediation patches on `main` but are pending on-chain redeploy.** See [FIX_STATUS.md](./FIX_STATUS.md) for the exact state.

---

## Canonical rule

> The most recent full-scale audit is the authoritative severity source. Older audits are preserved for provenance — they show *why* a fix was made, not *what* still needs fixing.

Current canonical pair (as of 2026-04-18):

1. **[`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md)** — Apr 16, 2026, 300-agent full-stack review, ingests Spartan. Authoritative severity & blocker list.
2. **[`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md)** — Apr 17, 2026, 35 parallel detectives against the current working tree. Authoritative for what's actually in-flight on `main`.

Everything else is context.

---

## Full artifact inventory

### Monorepo / full-stack audits (chronological)

| # | File | Date | Methodology | Scope | Headline severity | Status |
|---|------|------|-------------|-------|-------------------|--------|
| 1 | [`tegridy_farms_audit.docx`](./tegridy_farms_audit.docx) | 2026-03-25 | External, pre-release | Initial Solidity review | Baseline findings | Historical |
| 2 | [`tegridy_100_findings.docx`](./tegridy_100_findings.docx) | 2026-03-26 | Line-by-line manual + parallel agents | 14,454 LOC, 13 contracts + frontend | **12 Critical, 18 High, 30 Med, 40 Low** | Historical (text mirror: [`findings_clean.txt`](./findings_clean.txt)) |
| 3 | [`findings_clean.txt`](./findings_clean.txt) | 2026-03-26 | Plaintext export of #2 for grep-friendly browsing | Same as #2 | Same as #2 | Historical |
| 4 | [`findings_text.txt`](./findings_text.txt) | 2026-03-26 | Full unmodified text export (327 KB) | Same as #2 with raw annotations | Same as #2 | Historical |
| 5 | [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) | 2026-03-29 | 100 agents | 13 contracts, deploy, tests, frontend | **7 Critical, 32 High, 85+ Med** | Historical baseline |
| 6 | [`SECURITY_AUDIT_FINAL.md`](./SECURITY_AUDIT_FINAL.md) | 2026-03-29 | 200 parallel + manual | 13 contracts, 18 test files, deploy, frontend | Fix-verification pass | Historical |
| 7 | [`SECURITY_AUDIT_40_AGENT.md`](./SECURITY_AUDIT_40_AGENT.md) | 2026-03-29 | 40 agents | 13 contracts, tests, deploy, foundry, hooks | **0 Critical, 15 High, 83 Med, 95 Low, 49 Info** | Historical — test-coverage focus |
| 8 | [`SECURITY_AUDIT_OPUS.md`](./SECURITY_AUDIT_OPUS.md) | 2026-03-30 | 38 agents | 13 Solidity contracts | **0 Critical, High+Med inventory** | Historical |
| 9 | [`SECURITY_AUDIT_200_AGENT.md`](./SECURITY_AUDIT_200_AGENT.md) | 2026-04-04 | 150+ agents (labelled 200) | 17 contracts + frontend hooks + deploy | **3 Critical, 12 High** | Superseded by 300-agent |
| 10 | [`SPARTAN_AUDIT.txt`](./SPARTAN_AUDIT.txt) | 2026-04-16 | **External — Spartan methodology** | 25 Solidity contracts, 12,644 LOC | **1 Critical, 1 High, 7 Med, 9 Low** (18 total) | Ingested into 300-agent |
| 11 | [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) | 2026-04-16 | 300 agents, 10 planned waves + Spartan ingest | Full monorepo: 25 contracts, 19 pages, 150+ components, 30+ hooks, 8 API fns, CI/CD, a11y, perf | **5 Critical (C-01..C-05), 12 High, many Med/Low** | **🟢 Canonical severity reference** |
| 12 | [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) | 2026-04-17 | 35 parallel detectives | Frontend, contracts, indexer, API, deploy, env, tests | **4 Ship-blockers (B1–B4)** plus High/Med/Low | **🟢 Canonical for current `main`** |

### Domain-specific audits

| File | Date | Scope | Severity |
|------|------|-------|----------|
| [`API_INDEXER_AUDIT.md`](./API_INDEXER_AUDIT.md) | 2026-04-17 | `frontend/api/**` (8 serverless fns) + `indexer/` (Ponder + handlers) | High + Med triage, false-positives stripped |

### Fix tracking & remediation trail

| File | Purpose |
|------|---------|
| [`FIX_STATUS.md`](./FIX_STATUS.md) | Rolling tracker of what's landed on `main` across sessions 1–11. Marks resolved items, explicit deferred list, "needs you" action queue. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Keep-a-Changelog format of every shipped change, grouped by Added / Changed / Fixed / Deferred / Removed. |
| [`SECURITY.md`](./SECURITY.md) | Disclosure policy, bug-bounty scope, SLA. |
| [`HALL_OF_FAME.md`](./HALL_OF_FAME.md) | Security researchers thanked + process for getting listed. |

### Audit-derived test files

Every finding that could be expressed as a regression test has one. Located in [`contracts/test/`](./contracts/test/) (27 files total):

- `Audit195_*.t.sol` (13 files) — per-contract regression harnesses matching the 100-finding line-by-line review
- `AuditFixes_*.t.sol` (4 files) — cross-contract fix verification
- `FinalAudit_*.t.sol` (4 files) — fix-verification pass covering AMM, Restaking, Revenue, Staking, POLPremium
- `GaugeCommitReveal.t.sol` — Wave 2 H-2 closure (14 tests on the commit-reveal flow)
- Plus 5 more non-audit suites

Total forge tests passing at the current HEAD: **1,921 / 1,921**.

---

## Cross-reference: known blockers on `main`

State as of 2026-04-18. Cross-check against [FIX_STATUS.md](./FIX_STATUS.md) which is updated every session.

| Blocker | Primary source | Corroborated in | Patched in working tree? | On-chain yet? |
|---------|----------------|-----------------|--------------------------|---------------|
| Deploy-pipeline Gap A sed (4 scripts → stale staking addr) | AUDIT_FINDINGS.md B1 | — | ✅ Yes (session 1) | 🟡 Needs redeploy |
| `frontend/src/lib/constants.ts` stale addresses | AUDIT_FINDINGS.md B2 | — | ✅ Yes (session 1) | N/A (hot-reload) |
| `TegridyLPFarming.exit()` missing | AUDIT_FINDINGS.md B3 | 300-agent C-01 region | ✅ Yes (session 1) | 🟡 Needs redeploy |
| Committed secrets in `.env` working files | AUDIT_FINDINGS.md B4 | — | N/A — user rotation | 🔴 Needs user rotation |
| `TegridyLPFarming._getEffectiveBalance` ABI mismatch → unbounded boost | SECURITY_AUDIT_300_AGENT.md C-01 | Spartan TF-01 | ✅ Yes (interface + ceiling clamp) | 🟡 Needs redeploy |
| `TegridyNFTLending` deadline same-block race | SECURITY_AUDIT_300_AGENT.md C-02 | — | ✅ Yes — 1h grace period added | 🟡 Needs redeploy |
| Privacy Policy analytics misrepresentation | SECURITY_AUDIT_300_AGENT.md C-03 | — | ✅ Yes (SecurityPage + PrivacyPage rewrites) | N/A |
| Etherscan receipt links hardcoded mainnet | SECURITY_AUDIT_300_AGENT.md C-04 | — | ✅ Yes (chain-aware URL helper) | N/A |
| Smoke tests cover zero transactional flows | SECURITY_AUDIT_300_AGENT.md C-05 | — | 🟡 Partial — scaffolding shipped, Anvil fixture upgrade pending | N/A |
| H-2 bribe arbitrage (commit-reveal) | SPARTAN_AUDIT.txt TF-04 | 300-agent H-2 | ✅ Yes — commit-reveal added to `GaugeController.sol` + UI | 🟡 Needs redeploy |
| H-10 Drop refund flow missing | AUDIT_FINDINGS.md H10 | — | ✅ Yes — cancelSale + refund + UI on CollectionDetail | 🟡 Needs Drop-template redeploy |
| H-1 Frontend blind to 8 contracts (ABIs) | AUDIT_FINDINGS.md H1 | — | ✅ Yes — [`scripts/extract-missing-abis.mjs`](./scripts/extract-missing-abis.mjs) regenerated [`abi-supplement.ts`](./frontend/src/lib/abi-supplement.ts) | N/A |
| M-8 silent `.catch(() => {})` in nakamigos | AUDIT_FINDINGS.md M8 | — | ✅ Yes — scoped `console.warn` with component tag | N/A |
| B-7 TegridyFeeHook no deploy script | AUDIT_FINDINGS.md B7 | — | ✅ Yes — [`DeployTegridyFeeHook.s.sol`](./contracts/script/DeployTegridyFeeHook.s.sol) with CREATE2 salt-miner | 🟡 Needs user to run |

Legend: ✅ patched in working tree · 🟡 needs redeploy or user action · 🔴 blocker requires user

---

## Timeline of audit passes

```
Mar 25  ▸ Initial external review (tegridy_farms_audit.docx)
Mar 26  ▸ 100-finding line-by-line (tegridy_100_findings.docx + findings_clean/text.txt)
Mar 29  ▸ 100-agent SECURITY_AUDIT_REPORT.md → 200-manual SECURITY_AUDIT_FINAL.md → 40-agent SECURITY_AUDIT_40_AGENT.md
Mar 30  ▸ 38-agent SECURITY_AUDIT_OPUS.md
Apr 04  ▸ 150-agent SECURITY_AUDIT_200_AGENT.md (3C / 12H)
Apr 16  ▸ External Spartan audit (SPARTAN_AUDIT.txt, 1C/1H/7M/9L)
         + 300-agent full-stack SECURITY_AUDIT_300_AGENT.md (5C / 12H, ingests Spartan)  ← CANONICAL
Apr 17  ▸ 35-detective AUDIT_FINDINGS.md against main (4 ship-blockers)
         + API_INDEXER_AUDIT.md (serverless + Ponder)
Apr 18  ▸ Sessions 3–11 remediation (see FIX_STATUS.md + CHANGELOG.md)
```

Each pass was smaller + more targeted than the last. The early (March) passes flagged large inventories; the April passes narrowed to the remaining blockers.

---

## How to use these files as a reader

### Investor / diligence
- Start with [AUDITS.md](./AUDITS.md) (this file)
- Read the blocker table above + [FIX_STATUS.md](./FIX_STATUS.md)
- Skim [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) § Executive Summary (first page)
- Spot-check [`SPARTAN_AUDIT.txt`](./SPARTAN_AUDIT.txt) for the external-review finding list

### Developer / integrator
- Start with [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- Then [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) for current working-tree state
- Then [`contracts/test/Audit195_*.t.sol`](./contracts/test/) for regression-test examples

### Auditor / security researcher
- Start with [SECURITY.md](./SECURITY.md)
- Then [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) for canonical severity
- Then diff prior audits against the 300-agent to trace fix-deltas
- Contact `security@tegridyfarms.xyz` for private disclosure — do NOT open public issues

### Journalist / researcher writing about the protocol
- This file answers most questions. Contact `security@` or open a GitHub Discussion for anything else.

---

## Responsible disclosure & bounty

Found something that isn't in the list above? Report it privately.

- **Email:** `security@tegridyfarms.xyz` (PGP key on request)
- **Bounty platform:** [Immunefi — Tegridy Farms](https://immunefi.com/bounty/tegridyfarms) *(page listing; see the bounty program for scope, severity scale, and payout tiers)*
- **Response SLA:** acknowledgement within 48 hours, triage within 5 business days.

Include: affected contract/file + line, reproduction steps or PoC, suggested severity, your preferred payout address/handle. Do **not** exploit against mainnet — test on a fork or on Sepolia.

See [`SECURITY.md`](./SECURITY.md) for the full disclosure policy.

---

## What counts as an audit artifact?

To keep this index honest, an "artifact" is any file that either:

1. Was produced by an audit methodology (manual review, parallel agents, external engagement), OR
2. Tracks the status of remediation against findings.

We explicitly **exclude** from this index:

- Internal scratch files (`.audit_findings.md`, `.spartan_unpacked/`) — these are gitignored working-dir intermediates, not finished artifacts
- Generated test broadcast JSONs in `contracts/broadcast/` — those are deployment receipts, not audits
- OpenZeppelin's own audits in `contracts/lib/openzeppelin-contracts/audits/` — those cover the upstream library, not this protocol

If in doubt about a file's classification, ask in a GitHub Discussion.

---

*Maintained by: protocol maintainers. Last reviewed: 2026-04-18 (post-session-11 remediation pass).*
