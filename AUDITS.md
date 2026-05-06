# Tegridy Farms — Audit Index

One page, one truth. Every security review, where it came from, what's still open. Nothing is hidden.

---

## Honest TL;DR

Before you read further, here's the methodology breakdown:

| Type | Count | Description |
|---|---|---|
| **External, third-party methodology** | 2 | `SPARTAN_AUDIT.txt` (Apr 16, 2026) and the pre-release doc archived at [`docs/audits/archive/tegridy_farms_audit.docx`](./docs/audits/archive/tegridy_farms_audit.docx) (Mar 25, 2026) |
| **Internal AI-agent reviews** | 14 | Parallel Claude/GPT agent sweeps. Useful as a breadth tool. **Not a substitute for a human audit firm.** Latest: **pass-8 adversarial 100-agent audit (May 4–6, 2026)** — see [`.audit_101/PASS8_2026_05_04.md`](./.audit_101/PASS8_2026_05_04.md). The lineage: 100→200→300→40-agent passes (Mar 2026), 101-agent canonical pass (Apr 25, 2026 — [`.audit_101/MASTER_REPORT.md`](./.audit_101/MASTER_REPORT.md) + remediation R001–R076), microscope (Apr 30), DEEP_2026_05_01 v1/v2/v3 (May 1), pass-5 cross-contract (May 2), pass-6 (May 3), pass-7 (May 3), pass-8 (May 4–6). |
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
| [`.audit_101/PASS8_2026_05_04.md`](./.audit_101/PASS8_2026_05_04.md) | **NEW (2026-05-04 → 2026-05-06)**: pass-8 adversarial 100-agent audit + 18-batch same-week remediation. Five waves: 30 per-contract deep + 40 vulnerability-class + 15 cross-contract integration + 10 economic / MEV / game-theory + 5 specialized (compiler / toolchain / size / test-coverage / 2026-exploit research). ~675 raw → ~275 unique findings after dedup (10 Critical / ~140 High / ~165 Medium / ~110 Low / ~250 Info). **All in-scope items closed across 18 batches** (commits adfa452 → 1d058e2). Owner-trust subset deferred to dedicated multisig-policy phase. Test posture: 2,574/0. 6 PoC files at `contracts/test/PASS8_*.t.sol` (46 tests). Cumulative: 418 (pass-7) + ~275 (pass-8 deduped) = ~693 audit-tracked items. |
| [`.audit_101/PASS7_2026_05_03.md`](./.audit_101/PASS7_2026_05_03.md) | **2026-05-03**: pass-7 adversarial multi-agent audit (3 parallel worktree agents on oracle/AMM, staking/governance, lending/NFT). 1 Critical (latent V4-hook accounting), 6 High (cross-contract per-tokenId reward bucket cluster + permanent gauge-removal brick + TWAP fail-open carve-out), 4 Medium, 1 Low, 1 Info — **all closed in same-week remediation** (commits b6b356d → 750e572). 9 runnable Foundry PoCs at `contracts/test/PASS7_*.t.sol`. Cumulative through pass-7: 418 audit-tracked items. |
| [`.audit_101/PASS6_2026_05_03.md`](./.audit_101/PASS6_2026_05_03.md) | **2026-05-03**: pass-6 fresh-eyes meta-audit informed by 2024-2026 DeFi exploit retrospectives. 5 NEW contract HIGH + 5 NEW contract MED + 1 frontend CRIT + 5 frontend HIGH + 1 frontend LOW — **all closed** in commits `722d1f1` / `b1fb6d4` / `8266289` / `21db70b` / `975e5af` / `4b3a47f` (+ `672e4d8` vercel.json catch-up, `378d70d` AUDITS bump, `eed1c65` polish, `7889f25` 4 NEW invariant suites). Pass-7 subsequently disputed two pass-6 closure descriptions (TWAP HIGH-3 V3-AMM-L1 carve-out, LD-NEW-H1 settled-vs-settled axis, LD-NEW-H2 missing on TegridyLending side and on `claimStuckCollateral`, FRESH-EYES L missing on NFTLending) — see PASS7 §7 disagreements. |
| [`.audit_101/PASS5_2026_05_02.md`](./.audit_101/PASS5_2026_05_02.md) | Pass-5 adversarial cross-contract audit (2026-05-02). 1 HIGH + 1 LOW + 1 INFO + 4 invariants (all PASS over 128k stateful calls each). |
| [`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md) | **2026-04-26**: post-remediation reconciliation. 14 fixes shipped across 11 commits closing 3 Critical + 7 High + 4 Medium findings, including R017/R020/R023/R028 fixes that prior docs claimed had shipped but had not. Pass-6 closures appended below the original ledger. |
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

**Current forge test count: 2,574 / 2,574 passing** (post-pass-8 closure).

Post-2026-04-26 additions: 8 demonstration tests in [`contracts/test/AuditDemonstration.t.sol`](./contracts/test/AuditDemonstration.t.sol) prove the new behavior of Batches A–J (commits 393b084 → 5fad774). See [`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md) for the full per-finding breakdown.

**Architectural changes (2026-04-26):**
- TegridyStaking split into [`TegridyStaking`](./contracts/src/TegridyStaking.sol) + [`TegridyStakingAdmin`](./contracts/src/TegridyStakingAdmin.sol) for EIP-170 fit. Final size: 22,492 bytes (+2,084 margin).
- SwapFeeRouter split into [`SwapFeeRouter`](./contracts/src/SwapFeeRouter.sol) + [`SwapFeeRouterAdmin`](./contracts/src/SwapFeeRouterAdmin.sol) for the same reason. Final size: 16,735 bytes (+7,841 margin).
- All 1,927 tests pass. User-facing swap and stake function signatures unchanged. Admin `propose/execute/cancel` calls moved to the new admin contracts (`staking.*`/`router.*` → `stakingAdmin.*`/`routerAdmin.*`) — frontend ABI imports + deploy scripts need updates. See ledger for details.

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
Apr 25  ▸ Wave 1–4 bulletproofing pass (101-agent canonical audit + remediation
            phase, .audit_101/MASTER_REPORT.md + .audit_101/remediation/R001..R076)
Apr 26  ▸ Post-remediation reconciliation (.audit_101/POST_REMEDIATION_LEDGER.md)
            — 14 fixes across 11 commits (3 Crit + 7 High + 4 Med)
May 02  ▸ Pass-5 adversarial cross-contract audit (.audit_101/PASS5_2026_05_02.md)
            — 1 HIGH + 1 LOW + 4 invariants × 128k stateful calls each
May 03  ▸ Pass-6 fresh-eyes meta-audit (.audit_101/PASS6_2026_05_03.md)
            — 5 NEW contract HIGH + 5 NEW contract MED
            + 7 frontend (1 CRIT + 5 HIGH + 1 LOW), all closed
            + 4 NEW invariant suites (13 invariants × 1.664M calls, 0 reverts)
            + dead-code cleanup, slither config schema fix
May 03  ▸ Pass-7 adversarial multi-agent audit (.audit_101/PASS7_2026_05_03.md)
            — 3 parallel worktree agents (oracle/AMM, staking/gov, lending/NFT)
            + 13 NEW findings (1 Critical / 6 High / 4 Medium / 1 Low / 1 Info)
            + 9 runnable Foundry PoCs at contracts/test/PASS7_*.t.sol
            — all closed same-week (commits b6b356d → 750e572).
May 04  ▸ Pass-8 adversarial 100-agent audit launched (.audit_101/PASS8_2026_05_04.md)
            — 5 waves: 30 per-contract deep + 40 vulnerability-class
            + 15 cross-contract integration + 10 economic / MEV / game-theory
            + 5 specialized (compiler/toolchain/size/test-coverage/2026-exploit)
            ~675 raw → ~275 unique findings after dedup (10 Crit / ~140 High /
            ~165 Med / ~110 Low / ~250 Info)
May 04-06 ▸ Pass-8 18-batch same-week remediation (commits adfa452 → 1d058e2)
            — Phase 0 (deployability: TegridyLending split, TegridyStaking
              under EIP-170 via Solady + JBAC vault split, VoteIncentives split)
            + Phase 1 (CCR-01/02 reentrancy reorder, JBAC vault sister,
              Phase 1.6 self-bribe arbitrage + sub-quorum claim)
            + Phase 2 (lending offer expiry, BendDAO pattern)
            + Phase 3 (TegridyFeeHook PoolKey allowlist, ERC20 fee unwrap,
              TegridyNFTPool ERC-2981 royalty enforcement)
            + Phase 4 (GaugeController pair binding, VotePowerOracle library)
            + Phase 5 (ETH-ingress counters POLAccumulator + SwapFeeRouter)
            6 PoC files (test/PASS8_*.t.sol), 46 tests; 2,574/0 forge total.
            All in-scope items closed; owner-trust subset deferred to
            dedicated multisig-policy phase.
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

*Last reviewed: 2026-05-06. Maintained by protocol maintainers.*
