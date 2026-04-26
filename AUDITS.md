# Tegridy Farms — Audit Index

One page, one truth. Every security review, where it came from, what's still open. Nothing is hidden.

---

## Honest TL;DR

Before you read further, here's the methodology breakdown:

| Type | Count | Description |
|---|---|---|
| **External, third-party methodology** | 2 | `SPARTAN_AUDIT.txt` (Apr 16, 2026) and the pre-release doc archived at [`docs/audits/archive/tegridy_farms_audit.docx`](./docs/audits/archive/tegridy_farms_audit.docx) (Mar 25, 2026) |
| **Internal AI-agent reviews** | 8 | Parallel Claude/GPT agent sweeps. Useful as a breadth tool. **Not a substitute for a human audit firm.** Latest: **101-agent canonical pass (Apr 25, 2026)** under [`.audit_101/MASTER_REPORT.md`](./.audit_101/MASTER_REPORT.md) + [`.audit_101/DETAILED_REPORT.md`](./.audit_101/DETAILED_REPORT.md) + remediation phase tracked in [`.audit_101/remediation/`](./.audit_101/remediation/) (R001–R076). |
| **Rolling remediation docs** | 3 | `FIX_STATUS.md`, `AUDIT_FINDINGS.md`, `CHANGELOG.md` |

**If you are diligencing this protocol, read `SPARTAN_AUDIT.txt` + `AUDIT_FINDINGS.md` + `FIX_STATUS.md`. The rest is context.**

A paid human audit by a recognised firm (OpenZeppelin / Trail of Bits / Spearbit / Cyfrin / Code4rena) is **on the roadmap and not yet scheduled**. Deposits should be sized accordingly.

---

## What to read first

| If you are… | Start with… | Then read… |
|---|---|---|
| **A depositor sizing risk** | [`RisksPage` on tegridyfarms.xyz](https://tegridyfarms.xyz/risks) | [`SPARTAN_AUDIT.txt`](./SPARTAN_AUDIT.txt) + [`FIX_STATUS.md`](./FIX_STATUS.md) |
| **An auditor / researcher** | [`SECURITY.md`](./SECURITY.md) | [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) |
| **A developer / integrator** | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) |

---

## Canonical artifacts (current truth)

These live at the repo root because they are actively referenced:

| File | Purpose |
|---|---|
| [`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md) | **NEW (2026-04-26)**: post-remediation reconciliation. 14 fixes shipped across 11 commits closing 3 Critical + 7 High + 4 Medium findings, including R017/R020/R023/R028 fixes that prior docs claimed had shipped but had not. **Single source of truth for post-Apr-26 main.** |
| [`SECURITY_AUDIT_300_AGENT.md`](./SECURITY_AUDIT_300_AGENT.md) | Canonical severity reference. 300-agent internal sweep + Spartan ingest. Apr 16, 2026. |
| [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md) | Current `main`-branch blocker list. 35-detective parallel sweep. Apr 17, 2026. |
| [`SPARTAN_AUDIT.txt`](./SPARTAN_AUDIT.txt) | **External** review. 25 contracts, 12,644 LOC. 1 Critical / 1 High / 7 Medium / 9 Low. Apr 16, 2026. |
| [`API_INDEXER_AUDIT.md`](./API_INDEXER_AUDIT.md) | Domain-specific: serverless API + Ponder indexer. Apr 17, 2026. |
| [`FIX_STATUS.md`](./FIX_STATUS.md) | Rolling remediation tracker. Updated every session. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Keep-a-Changelog record of every shipped change. |
| [`SECURITY.md`](./SECURITY.md) | Disclosure policy, bug-bounty scope. |
| [`HALL_OF_FAME.md`](./HALL_OF_FAME.md) | Acknowledged security researchers. |

## Archived artifacts (context / provenance)

Historical reviews preserved for provenance. **Read `FIX_STATUS.md` to learn what's actually live on `main` today** — these archives describe the protocol at earlier points in time.

Moved to [`docs/audits/archive/`](./docs/audits/archive/):

| File | Date | Methodology | Status |
|---|---|---|---|
| [`tegridy_farms_audit.docx`](./docs/audits/archive/tegridy_farms_audit.docx) | 2026-03-25 | External, pre-release | Historical — earliest artifact |
| [`tegridy_100_findings.docx`](./docs/audits/archive/tegridy_100_findings.docx) | 2026-03-26 | Line-by-line manual + parallel agents | Historical |
| [`findings_clean.txt`](./docs/audits/archive/findings_clean.txt) | 2026-03-26 | Plaintext mirror of 100-finding doc | Historical |
| [`findings_text.txt`](./docs/audits/archive/findings_text.txt) | 2026-03-26 | Full unmodified text export | Historical |
| [`SECURITY_AUDIT_REPORT.md`](./docs/audits/archive/SECURITY_AUDIT_REPORT.md) | 2026-03-29 | 100 AI agents | Historical baseline |
| [`SECURITY_AUDIT_FINAL.md`](./docs/audits/archive/SECURITY_AUDIT_FINAL.md) | 2026-03-29 | 200 parallel AI + manual | Historical |
| [`SECURITY_AUDIT_40_AGENT.md`](./docs/audits/archive/SECURITY_AUDIT_40_AGENT.md) | 2026-03-29 | 40 AI agents, test-coverage focus | Historical |
| [`SECURITY_AUDIT_OPUS.md`](./docs/audits/archive/SECURITY_AUDIT_OPUS.md) | 2026-03-30 | 38 AI agents | Historical |
| [`SECURITY_AUDIT_200_AGENT.md`](./docs/audits/archive/SECURITY_AUDIT_200_AGENT.md) | 2026-04-04 | 150+ AI agents | Superseded by 300-agent |

---

## Regression tests

Every finding that can be expressed as a test has one, under [`contracts/test/`](./contracts/test/). Naming convention:

- `Audit195_*.t.sol` — per-contract harnesses from the 100-finding review
- `AuditFixes_*.t.sol` — cross-contract fix verification
- `FinalAudit_*.t.sol` — fix-verification pass for AMM / Restaking / Revenue / Staking / POLPremium
- `RedTeam_*.t.sol` — adversarial attack suites
- `GaugeCommitReveal.t.sol` — H-2 commit-reveal closure (14 tests)

**Current forge test count: 1,933 / 1,933 passing.**

Post-2026-04-26 additions: 8 demonstration tests in [`contracts/test/AuditDemonstration.t.sol`](./contracts/test/AuditDemonstration.t.sol) prove the new behavior of Batches A–J (commits 393b084 → 5fad774). See [`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md) for the full per-finding breakdown.

---

## Known blockers on `main`

State as of 2026-04-18. Cross-check [`FIX_STATUS.md`](./FIX_STATUS.md), which is updated every session.

| Blocker | Source | Patched in working tree? | On-chain? |
|---|---|---|---|
| Deploy-pipeline sed (4 scripts → stale staking addr) | `AUDIT_FINDINGS.md` B1 | ✅ | 🟡 Needs redeploy |
| `frontend/src/lib/constants.ts` stale addresses | `AUDIT_FINDINGS.md` B2 | ✅ | N/A — hot-reload |
| `TegridyLPFarming.exit()` missing | `AUDIT_FINDINGS.md` B3 + 300-agent C-01 | ✅ | 🟡 Needs redeploy |
| Committed secrets in `.env` working files | `AUDIT_FINDINGS.md` B4 | 🔴 User rotation required | 🔴 Needs user rotation |
| `TegridyLPFarming._getEffectiveBalance` ABI mismatch | 300-agent C-01 + Spartan TF-01 | ✅ | 🟡 Needs redeploy |
| `TegridyNFTLending` deadline same-block race | 300-agent C-02 | ✅ 1h grace period added | 🟡 Needs redeploy |
| Privacy Policy analytics misrepresentation | 300-agent C-03 | ✅ SecurityPage + PrivacyPage rewrites | N/A |
| Etherscan receipt links hardcoded mainnet | 300-agent C-04 | ✅ chain-aware URL helper | N/A |
| Smoke tests cover zero transactional flows | 300-agent C-05 | 🟡 Partial — Anvil fixture upgrade pending | N/A |
| H-2 bribe arbitrage (commit-reveal) | Spartan TF-04 + 300-agent H-2 | ✅ commit-reveal added to `GaugeController.sol` + UI | 🟡 Needs redeploy |
| H-10 Drop refund flow missing | `AUDIT_FINDINGS.md` H10 | ✅ cancelSale + refund + UI | 🟡 Needs Drop-template redeploy |
| H-1 Frontend blind to 8 contracts (ABIs) | `AUDIT_FINDINGS.md` H1 | ✅ abi-supplement regenerated | N/A |
| M-8 silent `.catch(() => {})` | `AUDIT_FINDINGS.md` M8 | ✅ scoped `console.warn` | N/A |
| B-7 TegridyFeeHook no deploy script | `AUDIT_FINDINGS.md` B7 | ✅ CREATE2 salt-miner | 🟡 Needs user to run |

**Legend:** ✅ patched in working tree · 🟡 awaiting on-chain action · 🔴 requires user

---

## Timeline

```
Mar 25  ▸ External pre-release review (archive/tegridy_farms_audit.docx)
Mar 26  ▸ 100-finding line-by-line (archive/tegridy_100_findings.docx + plaintext mirrors)
Mar 29  ▸ Three internal AI rounds: 100-agent → 200-manual → 40-agent coverage focus
Mar 30  ▸ 38-agent internal AI round (archive/SECURITY_AUDIT_OPUS.md)
Apr 04  ▸ 150-agent internal AI round (archive/SECURITY_AUDIT_200_AGENT.md)
Apr 16  ▸ External Spartan review (SPARTAN_AUDIT.txt)
         + 300-agent full-stack internal AI sweep (SECURITY_AUDIT_300_AGENT.md)  ← CANONICAL
Apr 17  ▸ 35-detective internal pass against main (AUDIT_FINDINGS.md)
         + API/indexer domain pass (API_INDEXER_AUDIT.md)
Apr 18  ▸ Remediation sessions 3–11 (see FIX_STATUS.md + CHANGELOG.md)
```

Each pass narrowed scope; March passes inventoried broadly, April passes tracked specific blockers.

---

## Responsible disclosure

Found something not listed? Report privately:

- **Email:** `security@tegridyfarms.xyz` (PGP on request)
- **Bounty:** [Immunefi — Tegridy Farms](https://immunefi.com/bounty/tegridyfarms)
- **SLA:** acknowledgement < 48 hours, triage < 5 business days

Include: affected contract/file + line, reproduction or PoC, suggested severity, payout address/handle. Do **not** exploit against mainnet; test on fork or Sepolia.

Full policy: [`SECURITY.md`](./SECURITY.md).

---

## What counts as an audit artifact?

Anything produced by an audit methodology (human review, parallel agents, external engagement) **or** that tracks remediation against findings.

**Excluded:**

- Internal scratch files (`.audit_findings.md`, `.spartan_unpacked/`) — gitignored working intermediates
- `contracts/broadcast/` JSONs — deployment receipts, not audits
- `contracts/lib/openzeppelin-contracts/audits/` — upstream library audits, not ours

---

*Last reviewed: 2026-04-20. Maintained by protocol maintainers.*
