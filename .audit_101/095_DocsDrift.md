# Agent 095 — Documentation Drift Audit

**Mission:** Documentation drift vs implementation. AUDIT-ONLY.
**Date:** 2026-04-25
**Targets:** README.md, CHANGELOG.md, TOKENOMICS.md, REVENUE_ANALYSIS.md, ROADMAP.md, SECURITY.md, FAQ.md, DEPLOY_RUNBOOK.md, CONTRIBUTING.md, NEXT_SESSION.md, FIX_STATUS.md, AUDITS.md, AUDIT_FINDINGS.md
**Scope:** root-level docs only; node_modules + worktrees skipped.

---

## 1. Summary counts

| Severity | Count |
|---|---|
| **CRITICAL** (false security claim, vaporware shipping fee/yield) | 4 |
| **HIGH** (contradiction with on-chain constants, dead scripts in runbook) | 7 |
| **MEDIUM** (outdated dates, internal-link drift, stale agent-session counts) | 9 |
| **LOW / INFO** (style, “coming soon” without ETA) | 6 |
| **Verify-with-user** (email bounce, Immunefi listing) | 2 |
| **Total** | **28** |

---

## 2. Per-doc findings table

### README.md (`/README.md`)

| ID | Severity | Drift | Evidence in code |
|---|---|---|---|
| README-01 | HIGH | Claims "**67 test suites, 1,933 tests passing**" (3×) but `contracts/test/*.sol` contains only **61 .sol files**. NEXT_SESSION.md (same repo, 2026-04-18) records **1,921/1,921 across 66 suites**. CHANGELOG.md cite is absent. README is over-counting by ≥ 12 tests / 1 suite, OR test files were deleted and stat not refreshed (V1 deletions 2026-04-19). | `contracts/test/*.sol` count = 61; NEXT_SESSION.md L15 |
| README-02 | HIGH | Audit summary block says "**2 external reviews**" but AUDITS.md lists Spartan + a `.docx` archive. Spartan audit dated `2026-04-16` while latest commit `0b22479` is post-`2026-04-21`; **no human-firm audit** is referenced — wording "2 external reviews" can mislead a casual reader into thinking firms like OpenZeppelin/Trail of Bits engaged. README L266 contradicts itself ("not yet scheduled"). | README L248 vs README L266 |
| README-03 | MEDIUM | Repo layout shows `27 production contracts` and "27+ audit-derived Foundry test files" — `contracts/src/*.sol` (depth 1) = **25 files**. Two-contract over-count. | `find contracts/src -maxdepth 1 -name "*.sol"` = 25 |
| README-04 | MEDIUM | Lock-duration table (L83–90) shows boost `1 year → ~2.0×`, `2 years → ~3.0×`. TOKENOMICS.md (L116) says `1 year → 2.5×`, `2 years → 3.5×`. **Internal contradiction between two flagship docs.** | README L88 vs TOKENOMICS L116 |
| README-05 | HIGH | "Quick start — contracts" block (L162-168) tells the user to run `./scripts/redeploy-patched-3.sh`. **That file does not exist** — NEXT_SESSION.md L153 explicitly says "deleted 2026-04-19". | `ls scripts/redeploy-patched-3.sh` → `No such file or directory` |
| README-06 | MEDIUM | "**100% of protocol revenue** as real ETH yield" headline (L16) — accurate today (SwapFeeRouter sends 100% to RevenueDistributor) but TOKENOMICS L72 says "If a treasury / POL split activates, this drops to 70-90%". Headline lacks the live-state caveat that other docs include. | README L16 vs TOKENOMICS L72 |
| README-07 | MEDIUM | Claims "**403+ passing unit tests**" frontend (L275). NEXT_SESSION L17 says exactly **403**. README "+" shading is fine but **the same line claims "20+ Playwright E2E specs"** — `frontend/e2e/` count not verified in this pass; flag for spot-check. | README L275 |
| README-08 | INFO | "A public Discord / Twitter / Telegram presence is on the roadmap" (L401). No ETA. Coupled with `> Until those exist…`. Acceptable per honest-status convention. | — |
| README-09 | INFO | Internal link `docs/LAUNCHPAD_GUIDE.md` (L113, L240) — file exists. OK. | verified |

### TOKENOMICS.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| TOKEN-01 | HIGH | Boost-table double-state: L107 cites code constant `MAX_BOOST_BPS_CEILING = 45000` (4.5×). Same file L111-118 lists `1y → 2.5×`, `2y → 3.5×` — inconsistent with README L88's `1y → ~2.0×`, `2y → ~3.0×`. **Two-doc contradiction.** | TOKENOMICS L107 vs L116 vs README L88 |
| TOKEN-02 | MEDIUM | Distribution table presents Team `5%` with a "3-year linear vest + 6-month cliff" but says "Private vesting contract — contact the team for schedule". **Private contract un-verifiable** is a transparency gap given the rest of the doc emphasizes on-chain auditability. | TOKENOMICS L31 |
| TOKEN-03 | INFO | "Last updated: 2026-04-18" footer (L186). 7 days stale relative to today (2026-04-25); 11 commits have landed since. | TOKENOMICS L186 |
| TOKEN-04 | MEDIUM | LPFarming address listed at `0xa5AB522C99F86dEd9F429766872101c75517D77c` (L154). README L319 lists the **C-01-fixed** redeploy at `0xa7EF711Be3662B9557634502032F98944eC69ec1`. **TOKENOMICS still points at the old paused contract.** | TOKENOMICS L154 vs README L319 |

### REVENUE_ANALYSIS.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| REV-01 | CRITICAL | L14 claims `SWAP_FEE_BPS = 50` (0.50% default). **The actual SwapFeeRouter has no `SWAP_FEE_BPS` constant** — fee is a non-final state variable `feeBps` (commented `30 = 0.3%`) initialized via constructor `_feeBps`. The doc invents a constant name and asserts a default value the source cannot guarantee. | `SwapFeeRouter.sol` L37, L86 (`MAX_FEE_BPS = 100`); no `SWAP_FEE_BPS` token |
| REV-02 | HIGH | L17 cites `REFERRAL_FEE_BPS = 2000` (20%) "in Final" or **10% (V2/AuditFixes)** — admits the doc itself doesn't know what was deployed ("Which actually deployed depends on broadcast — confirm"). Self-acknowledged drift; should be resolved before publishing. | REVENUE_ANALYSIS L17 |
| REV-03 | HIGH | L19: "`LAUNCHPAD_FEE_BPS = 500`" (5%). Check confirms `TegridyLaunchpadV2.MAX_PROTOCOL_FEE_BPS = 1000` is a **cap**, not a default. Source for actual default not verified in REVENUE_ANALYSIS — drift risk. | TegridyLaunchpadV2.sol L56 |
| REV-04 | HIGH | L24 admits `bribeFeeBps` is "not fixed in scripts — live value via `VoteIncentives.bribeFeeBps()`. Expected 3% = 300 bps based on `useBribes.ts:27` fallback." VoteIncentives.sol L78 sets `MAX_FEE_BPS = 500` (5% cap). **Doc derives a fact from frontend fallback constant; on-chain reality is unverified.** | VoteIncentives.sol L78 |
| REV-05 | MEDIUM | "Prepared 2026-04-17" header. Vapor-staleness — no patch since. 8+ days behind code. | REVENUE_ANALYSIS L3 |

### ROADMAP.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| ROAD-01 | HIGH | Q3 2026 item #5 promises "**70/20/10 fee split**" as a Q3 deliverable. FAQ L13 claims this **already** exists ("Protocol fees split as: 70% to stakers..."). Two docs **disagree on whether the feature ships in Q3 2026 or is live now.** | ROADMAP L34 vs FAQ L13 |
| ROAD-02 | MEDIUM | Item #1 "TegridyLPFarming redeploy" is listed as Q2 2026 work. CHANGELOG L98 / README L272 say redeploy already happened **2026-04-18**. Roadmap is outdated. | ROADMAP L12 |
| ROAD-03 | MEDIUM | "See `V2_ROADMAP.md` for the backlog of technical issues" — file does exist (`V2_ROADMAP.md` 3.6 KB at root) but README's repo-layout section never mentions it; orphaned in nav. | V2_ROADMAP.md confirmed |

### SECURITY.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| SEC-01 | VERIFY-WITH-USER | "Preferred channel: security@tegridyfarms.xyz" (L7). Domain serves the website but I did not fetch — flag for user to confirm the inbox is monitored / SPF / MX records receive mail (per audit instructions). | SECURITY L7 |
| SEC-02 | CRITICAL | "Alternative channel: Immunefi bug bounty program" (L11). **NEXT_SESSION.md L87 explicitly states "that page 404s until someone submits the project. Actual listing takes ~2 weeks"**. SECURITY.md publishes a bounty SLA + tier table linked to a non-existent program. Public-facing false claim. | SECURITY L11 vs NEXT_SESSION L87 |
| SEC-03 | HIGH | "Bounty Tiers" table (L52-58) advertises rewards `$50,000 – $250,000` for Critical. **No funded escrow shown anywhere in repo**, and roadmap explicitly calls multisig migration "deferred". Users cannot rely on this without funding visibility. | SECURITY L55 |
| SEC-04 | MEDIUM | In-scope list (L25-31) names `TegridyToken (ERC-20)` — token contract is **`Toweli.sol`** (per TOKENOMICS L17, README L294). Inconsistent contract naming. | SECURITY L25 |

### FAQ.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| FAQ-01 | CRITICAL | L13 ("70% stakers / 20% treasury / **10% burn/buyback** that permanently reduces circulating supply"). TOKENOMICS L13 explicitly states "**No protocol burn path. The circulating float can only shrink via the POL sink**." There is **no burn entrypoint on Toweli.sol**. FAQ describes vaporware. | TOKENOMICS L13 vs FAQ L13 |
| FAQ-02 | CRITICAL | L25 ("treasury multisig is a **4-of-7 Gnosis Safe**"). NEXT_SESSION.md L50 ("**Multisig migration — deferred** … When ready, ask me to write `docs/MULTISIG_MIGRATION.md`"). README L281 honest-states "Admin keys are timelocked but **not (yet) multisig**". FAQ asserts a multisig that does not exist. | NEXT_SESSION L50, README L281 |
| FAQ-03 | HIGH | "Yes" to "Is it audited?" (L10). Mentions `TegridyDropV2`, `GaugeController`, `TegridyLPFarming`, `TegridyNFTLending` "reviewed internally" — but next sentence: "**External audits are scheduled pre-mainnet**". README L266: "A paid human audit … on the roadmap and **not yet scheduled**." Direct contradiction within FAQ + cross-doc. Plus protocol is **already on mainnet** (README L11–13) — "pre-mainnet" framing is materially false. | FAQ L10 vs README L11/L266 |
| FAQ-04 | MEDIUM | Boost answer (L16) "0.4×–4.0× boost on LP rewards depending on lock duration, plus an additional +0.5× if they hold a JBAC NFT (ceiling 4.5×)" — this matches code. ✅ |  |
| FAQ-05 | INFO | "Is there a Base L2 plan? Yes" (L31) — matches ROADMAP Q4 2026 #10 (consideration only, decision-memo gated). FAQ tone too definitive vs roadmap's go/no-go phrasing. | ROADMAP L57 |
| FAQ-06 | INFO | Creator-portal flow described (L34) — **not yet shipped per FIX_STATUS L42**. UI ships V2 wizard but the "apply via in-app creator portal with a sample collection, social links, pitch" approval gate is vaporware. | FIX_STATUS L42 |

### DEPLOY_RUNBOOK.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| RUN-01 | HIGH | Header references commits `714d839` (baseline) → `25014a0` (tip), claims "18 commits, 13 contracts touched, 480 net source lines". Today's HEAD is `0b22479` (well past `25014a0`); doc has not been refreshed across the last 280+ commits. | git rev-list head distance |
| RUN-02 | HIGH | §1 inventory lists `TegridyLaunchpad` and `TegridyDrop` as RETIRED (✅ matches commit `8f82280` "delete V1 TegridyLaunchpad + TegridyDrop"). But §3 deploy-order step 7 still says "TegridyLaunchpadV2 + DropV2" — **OK**. However, §5 "Frontend coupling" table mentions `TEGRIDY_LAUNCHPAD_V2_ADDRESS` only — leaves V1 constants drift unspecified. | DEPLOY_RUNBOOK L23, L114 |
| RUN-03 | MEDIUM | §10 known trade-offs: "**H-2 commit-reveal voting** — design spec in `DESIGN_H2_COMMIT_REVEAL_VOTING.md`, **not implemented**." But CHANGELOG (L144) **and** AUDITS L97 both mark H-2 commit-reveal **shipped to mainnet at `0xb93264aB…0Fdb`**. Direct contradiction. | DEPLOY_RUNBOOK L207 vs AUDITS L97 |
| RUN-04 | MEDIUM | §6 "Indexer re-sync" instructs `Update startBlock per contract … was 24500000`. Block number is hard-coded into a procedure that should reference `ponder.config.ts`. Drifts the moment that file changes. | DEPLOY_RUNBOOK L132 |

### NEXT_SESSION.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| NEXT-01 | HIGH | "Current branch: `main` at `9b6e7da`" (L9). Today: `0b22479` after **283 commits of work since the doc claims to have been written**. NEXT_SESSION is fossilized at session 13 (2026-04-18). | git log L0 |
| NEXT-02 | HIGH | "13 commits pushed across sessions 1–13" (L11). Repo `git log --oneline | wc -l` = **348**. Numbers diverge by 25× — implies session-counting model collapsed and was not refreshed. | git log count |
| NEXT-03 | MEDIUM | L153 references `scripts/redeploy-patched-3.sh` as **deleted** — README still tells the user to run it. Internal contradiction across sibling docs. | README L166 |
| NEXT-04 | MEDIUM | "Live test health: `forge test`: 1,921/1,921" — README claims 1,933. **12-test gap, no explanation.** | README L180 |

### FIX_STATUS.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| FIX-01 | HIGH | "Last refreshed after sessions 1–6 ending 2026-04-18" (L7). 7 days stale; 11+ "audit batch" commits have landed (Batches A-F + economic-design + bulletproof) which this file does not reflect at all. | FIX_STATUS L7 vs git log |
| FIX-02 | MEDIUM | L235 references `scripts/redeploy-patched-3.sh` — file was deleted (per NEXT_SESSION L153). Operator following the runbook will hit "command not found". | FIX_STATUS L235 |
| FIX-03 | MEDIUM | "1921 existing forge tests" (L19). Drift vs README "1,933". Two adjacent docs disagree by 12. | FIX_STATUS L19 |

### AUDITS.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| AUD-01 | MEDIUM | "Last reviewed: 2026-04-20" (L152). Five days behind today's HEAD; many "audit batch" commits since. | AUDITS L152 |
| AUD-02 | HIGH | L78 "Current forge test count: 1,933 / 1,933 passing." Same number as README. **Did anyone run forge test in the last 7 days, or is this copy-pasted across docs?** | AUDITS L78 |
| AUD-03 | MEDIUM | Timeline (L109-119) ends `Apr 18 ▸ Remediation sessions 3-11`. Repo has commits dated `2026-04-19`, `2026-04-20`, `2026-04-21`, plus the "full-force" / "bulletproof" batch series. **Timeline is a frozen artifact.** | AUDITS L119 |

### AUDIT_FINDINGS.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| AF-01 | INFO | Document is **the working-tree blocker list** snapshot from 2026-04-17. By design it doesn't update. README points users at it as **"Current main-branch blocker list"** which may mislead because B1 / B2 / B3 / etc. are ✅ resolved per FIX_STATUS but AUDIT_FINDINGS.md presents them un-annotated as "BLOCKERS". Re-publish or annotate. | AUDIT_FINDINGS L9-44 |

### CONTRIBUTING.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| CON-01 | LOW | Pre-PR commands `npx prettier --check .` and `npx eslint .` — neither root-level prettier nor ESLint config visible at repo root. Frontend has its own configs. Newcomers run from root and fail silently. | repo root scan |
| CON-02 | INFO | `Squash merge is the default` — okay, just hope hooks honour it. | — |

### CHANGELOG.md

| ID | Severity | Drift | Evidence |
|---|---|---|---|
| CHG-01 | MEDIUM | Top entry `[Unreleased]` claims "ETH-denominated collateral floor on TegridyLending" added 2026-04-19 with `createLoanOffer` taking a "5th arg". Confirms in TegridyLending source — ✅ matches. | TegridyLending.sol |
| CHG-02 | MEDIUM | Bottom of Unreleased mentions `redeploy-patched-3.sh` shipped (L184). Same script later deleted (NEXT_SESSION L153). CHANGELOG should have a `### Removed` line. | CHANGELOG L184 |
| CHG-03 | LOW | `[v3.0.0-pre] - 2026-04-17` link points at `https://github.com/fomotsar-commits/tegriddy-farms/tree/main` — link to `main` head, not a real tag. No `v3.0.0-pre` tag exists per NEXT_SESSION L78 ("Cut `v3.0.0-rc1` tag" still TODO). | CHANGELOG L374 |

---

## 3. Top-5 highest-impact drifts (ranked by user-trust risk)

1. **FAQ-01 / FAQ-02** — FAQ.md publishes a **fictitious 10% burn/buyback** *and* a **fictitious 4-of-7 Gnosis Safe**. Both are flatly contradicted by TOKENOMICS, README's honest-status, and NEXT_SESSION. Public-facing false claims → either fix the contracts or rewrite the FAQ.
2. **REV-01** — REVENUE_ANALYSIS.md cites a contract constant `SWAP_FEE_BPS = 50` that **does not exist** in `SwapFeeRouter.sol`. The fee is a mutable state variable. Every downstream calibration recommendation flowing from "we are at 0.50%" rests on that assumption.
3. **SEC-02** — SECURITY.md links to an **Immunefi page that 404s** (NEXT_SESSION openly admits this). Bug-bounty SLA + $50k–$250k reward range is published; submission flow is not yet live.
4. **README-05 / FIX-02** — README's "Quick start — contracts" tells users to `./scripts/redeploy-patched-3.sh`, **a deleted file**. Anyone following the README will fail at copy-paste step 1.
5. **RUN-03** — DEPLOY_RUNBOOK §10 says H-2 commit-reveal "**not implemented**", AUDITS.md + CHANGELOG say it's **live on mainnet**. Operations doc trails the actual deploy by ≥ 7 days; risk: someone shipping a duplicate redeploy or skipping a needed step.

Honourable mention: README-04 / TOKEN-01 — the **boost ladder differs by 0.5× between README and TOKENOMICS** for the 1-year and 2-year locks. Users see two different boost numbers depending on which doc they open.

---

## 4. Verify-with-user list (do not fetch)

- `security@tegridyfarms.xyz` — verify the mailbox actually receives mail and is monitored. (Per audit instruction: do not fetch.)
- `https://immunefi.com/bounty/tegridyfarms` — page status (NEXT_SESSION says 404; needs visual confirmation by user before public launch).
- `tegridyfarms.xyz/community`, `/lending`, `/farm` URLs in README — confirm they resolve and route to the documented pages.

---

*End of agent 095 output. Audit-only; no fixes performed.*
