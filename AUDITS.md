# Tegridy Farms — Audit Index

Every audit artifact in this repository, at a glance.

---

## How to read this

Tegridy Farms has accumulated **12+ audit artifacts** over the life of the protocol, ranging from a 40-agent parallel sweep to a 300-agent full-scale review plus an independent external review (Spartan). **These audits overlap heavily.** Many findings appear in two or three reports under different IDs; many earlier findings have since been fixed and re-validated in later passes.

**Canonical rule of thumb:**

> The most recent audit with the highest agent count is the canonical reference.
> Older audits are preserved for historical trail and fix provenance — they should not be used as the primary severity source for anything on `main`.

At the time of writing, the canonical pair is:

1. **`SECURITY_AUDIT_300_AGENT.md`** (Apr 16, 2026, 300 agents, ingests Spartan) — authoritative severity & blocker list for mainnet push.
2. **`AUDIT_FINDINGS.md`** (Apr 17, 2026, 35 parallel detectives) — authoritative for the *current* diff on `main` (deploy pipeline, constants.ts drift, LP farming exit, committed secrets). This is the freshest artifact in the tree.

Everything else is context. Use older audits to understand *why* a fix was made, not *what* still needs fixing.

---

## Artifact inventory

### Contract + full-stack audits

| File | Date (mtime) | Agents | Scope | Headline severity | Status |
|------|--------------|--------|-------|-------------------|--------|
| [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) | 2026-04-17 | 35 detectives | Frontend, contracts, indexer, API, deploy, env, tests | 4 BLOCKERS (B1-B4), HIGH, MED, LOW | **Canonical — current `main`** |
| [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) | 2026-04-16 | 300 | Monorepo (25 contracts + 19 pages + 150+ components + 30+ hooks + 8 API fns + CI/CD + a11y + perf) | 5 CRITICAL (C-01..C-05), 12 HIGH, many MED/LOW | **Canonical severity reference** |
| [`SPARTAN_AUDIT.txt`](./SPARTAN_AUDIT.txt) | 2026-04-16 | External (Spartan methodology) | 25 Solidity contracts, 12,644 LOC | 1 CRITICAL, 1 HIGH, 7 MED, 9 LOW (18 total) | Ingested into 300-agent |
| [`SECURITY_AUDIT_200_AGENT.md`](./SECURITY_AUDIT_200_AGENT.md) | 2026-04-04 | 150+ (labelled 200) | 17 contracts + frontend hooks + deploy | 3 CRITICAL, 12 HIGH | Superseded by 300-agent |
| [`SECURITY_AUDIT_OPUS.md`](./SECURITY_AUDIT_OPUS.md) | 2026-03-30 | 38 | 13 Solidity contracts | 0 CRITICAL, HIGH+MED inventory | Historical |
| [`SECURITY_AUDIT_40_AGENT.md`](./SECURITY_AUDIT_40_AGENT.md) | 2026-03-29 | 40 | 13 contracts, tests, deploy, foundry, hooks | 0 CRITICAL, 15 HIGH, 83 MED, 95 LOW, 49 INFO | Historical — test-coverage focus |
| [`SECURITY_AUDIT_FINAL.md`](./SECURITY_AUDIT_FINAL.md) | 2026-03-29 | 200 + manual | 13 contracts, 18 test files, deploy, frontend | Fix verification pass | Historical |
| [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) | 2026-03-29 | 100 | 13 contracts, deploy, tests, frontend | 7 CRITICAL, 32 HIGH, 85+ MED | Historical baseline |

### Domain-specific audits

| File | Date | Scope | Severity |
|------|------|-------|----------|
| [`API_INDEXER_AUDIT.md`](./API_INDEXER_AUDIT.md) | 2026-04-17 | `frontend/api/**` (8 serverless fns) + `indexer/` (Ponder + handlers) | HIGH + MED triage, false-positives stripped |

### Legacy `.docx` / text artifacts

| File | Date | Notes |
|------|------|-------|
| [`findings_clean.txt`](./findings_clean.txt) | 2026-03-26 | Plaintext of the 100-findings doc — 12 CRITICAL / 18 HIGH / 30 MED / 40 LOW |
| [`tegridy_100_findings.docx`](./tegridy_100_findings.docx) | 2026-03-26 | Source doc for `findings_clean.txt` |
| [`tegridy_farms_audit.docx`](./tegridy_farms_audit.docx) | 2026-03-25 | Earliest external-format audit artifact |
| `.spartan_unpacked/` | 2026-04-16 | Unpacked Spartan deliverable working dir |
| `.audit_findings.md` | 2026-04-16 | Scratch buffer, predecessor to `AUDIT_FINDINGS.md` |

---

## Cross-reference: known blockers on `main` (Apr 17, 2026)

| Blocker | Primary source | Corroborated in |
|---------|----------------|-----------------|
| Deploy pipeline Gap A sed never applied (4 scripts → stale staking addr) | `AUDIT_FINDINGS.md` B1 | — |
| `frontend/src/lib/constants.ts` points at stale staking/restaking/LP farming addrs | `AUDIT_FINDINGS.md` B2 | — |
| `TegridyLPFarming` missing `exit()` — UI will revert | `AUDIT_FINDINGS.md` B3 | 300-agent C-01 region |
| Committed secrets | `AUDIT_FINDINGS.md` B4 | — |
| `TegridyLPFarming._getEffectiveBalance` ABI mismatch → unbounded boost | `SECURITY_AUDIT_300_AGENT.md` C-01 | Spartan TF-01 |
| `TegridyNFTLending` deadline boundary same-block double-claim | `SECURITY_AUDIT_300_AGENT.md` C-02 | — |
| Privacy Policy misrepresents analytics collection | `SECURITY_AUDIT_300_AGENT.md` C-03 | — |
| Etherscan receipt links hardcoded to mainnet | `SECURITY_AUDIT_300_AGENT.md` C-04 | — |
| Smoke tests cover zero transactional flows | `SECURITY_AUDIT_300_AGENT.md` C-05 | — |

---

## Responsible disclosure & bounty

Found something that isn't in the list above? Report it privately — do not file a public GitHub issue.

- **Email:** `security@tegridyfarms.xyz` (PGP key on request)
- **Bounty platform:** [Immunefi — Tegridy Farms](https://immunefi.com/bounty/tegridyfarms) *(page listing; see the bounty program for scope, severity scale, and payout tiers)*
- **Response SLA:** acknowledgement within 48 hours, triage within 5 business days.

Please include: affected contract/file + line, reproduction steps or PoC, suggested severity, your preferred payout address/handle. Do **not** exploit against mainnet — test on a fork or on Sepolia.

See [`SECURITY.md`](./SECURITY.md) for the full disclosure policy.

---

*Maintained by: protocol maintainers. Last reviewed: 2026-04-17.*
