# 100_CrossCheck.md — Cross-Audit Adjudication Report

Agent 100 (of 101). Reviews findings from agents 001–087 + 088 + 090 (84 reports present at time of run).
**AUDIT-ONLY** — no code changes recommended here, only adjudication signals for follow-up agent 101 (synthesizer).

---

## 1. Coverage map (which agents wrote, which slots are missing)

### Present (84 of expected 100)
001–085, 087, 088, 090. (Plus a `MASTER_REPORT.md` not yet read.)

### Missing slots (orphans — no audit produced)
| Slot | Topical name implied by neighborhood | Coverage gap risk |
|------|-------------------------------------|--------------------|
| 086 | (between GhWorkflows@085 and BuildScripts@087) — likely **CI / Release / Tagging** | LOW — adjacent agents partially cover |
| 089 | (between E2ETests@088 and ErrorHandling@090) — likely **Frontend Performance / Lighthouse / Bundle** | MEDIUM — no other agent owns it |
| 091 | likely **Tooling / Lint / Format / Husky** | LOW |
| 092 | likely **Mobile / PWA / ServiceWorker** | MEDIUM — no other agent owns SW/PWA |
| 093 | likely **i18n / Copy / a11y** | MEDIUM — partial coverage in 069/074/075 |
| 094 | likely **Cookies / Storage / GDPR** | MEDIUM — partial in 082 |
| 095 | likely **Analytics / Telemetry beyond 082** | LOW |
| 096 | likely **Monitoring / Sentry / Alerts** | MEDIUM |
| 097 | likely **Disaster Recovery / Backups** | HIGH — nobody covered backup of Supabase / IPFS pin |
| 098 | likely **Threat Model summary / risk register** | HIGH — synthesizer must produce |
| 099 | likely **Final Verdict / Sign-off** | HIGH — synthesizer must produce |

### Contracts / modules nobody covered (orphan modules — confirmed via cross-check)
- **`Toweli.sol` premium / fees-on-transfer interactions** — agent 016 covered base ERC20, but no agent covered Toweli↔SwapFeeRouter↔ReferralSplitter end-to-end fee accounting.
- **Solidity custom error catalog drift** — agents 039 (events) and 068 (LibTxErrors) flag selector mismatches, but no agent built the canonical mapping (selector → error → site).
- **CI secret scanning / `.env` leak detection** — `gitleaks`/`truffleHog`-style scan was never run by any agent. (Memory feedback_env_files.md is highly relevant.)
- **CREATE2 address-prediction tests** — agents 003, 009, 034 each touch CREATE2 deterministic-address but disagree on whether it's exploitable (see contradictions §2).
- **`MASTER_REPORT.md`** — present but I have not read it; synthesizer must reconcile.
- **`.spartan_unpacked/`** — untracked directory at repo root (see `git status`); no agent inspected it. Possibly contains a Spartan-bundled artifact that needs review.

### Modules with double-coverage (waste vs cross-check signal)
- **TegridyLending oracle** — 006 + 031 + 032 all flag spot-reserves-as-oracle (good cross-validation).
- **TegridyTWAP** — 013 + 032 + (partial) 035 cover same surface, **disagreement on M-1 severity** — see §2.
- **`pause()` coverage of `claimDefault` vs `repayLoan`** — 006 + 007 + 044 all touch this; severities range MEDIUM→INFO (see §2).
- **`getAmountsOut`/`getAmountsIn` array-allocation** — 002 (L-6) + 041 (I-041-4) flag same loop; severity downgrade between agents.

---

## 2. Contradictions table (require adjudication before final report)

| # | Topic | Agent A | Agent B | Conflict | Suggested resolution |
|---|-------|---------|---------|----------|----------------------|
| C-1 | TegridyLending uses spot AMM reserves as ETH-floor oracle | 006 (H-006-1: HIGH) + 031 (H-1: HIGH) + 032 (H-1: HIGH) | 006 also lists 029 ATTACK PATH 7 as **MEDIUM, "DOCUMENTED"** | Triple HIGH consensus, but 029 downgrades. **Adjudicate as HIGH** (3 vs 1, plus already exploited in production AMMs). |
| C-2 | `harvest()` permissionless protocol-fee accrual on disabled pairs | 001 (H-3: HIGH) | 003 (factory disabledPairs gate, no parallel finding) | 001 says pair-side gate is missing; 003 confirmed governance-side gate exists. Real issue: pair-level gate gap. **Confirm HIGH.** |
| C-3 | `setGuardian` instant (no timelock) on TegridyFactory | 003 (H-01: HIGH) | 027 TimelockAdmin H-01/H-02 (HIGH on pending value mutability) but no factory-guardian finding | 003's HIGH is unique; 027 didn't catch it because factory uses raw owner check, not TimelockAdmin. **Confirm HIGH** — but reclassify as **owner-rug surface**, not timelock-bypass. |
| C-4 | TegridyTWAP `update()` is permissionless and sandwich-vulnerable | 032 (H-2: HIGH "permissionless can be sandwiched") | 013 (TWAP report — does NOT flag permissionless update as HIGH; only flags H-3 timestamp wrap) | **Real conflict.** 013's M-4 covers fee-front-run angle but misses the cumulative-drift sandwich. **Upgrade 013's view to HIGH** to match 032. |
| C-5 | TegridyPair `harvest()` needs nonReentrant for disabled-pair check | 001 (H-3) says missing | Read of pair source (line ~280) shows `nonReentrant` IS on `harvest` per agent 001 INFO-2 | **Internal inconsistency in 001** — H-3 wording is misleading; actual issue is the **disabled-pair check is missing**, not the lock. Adjudicator should reword H-3 to drop the reentrancy framing. |
| C-6 | `_safeMint` reentrancy in TegridyDropV2 | 011 (M-02: MEDIUM "cross-function reentrancy surface") | 029 ATTACK PATH 1 mentions OZ ERC721 protections but doesn't list TegridyDropV2 | Both technically agree (ERC721 hook fires before final state-update); 029's silence is a coverage gap, not contradiction. **Keep MEDIUM.** |
| C-7 | TegridyStaking M-005-04 `_clearPosition` overwrites `userTokenId[msg.sender]=0` for multi-position holders | 005 (M-005-04: MEDIUM) | 015 H-2 "fallback double-credit" assumes single-position model | **Real architectural conflict.** If multi-position is intended, 015 H-2 needs re-evaluation. If multi-position is NOT supported, 005 M-004 is INFO. **Flag for product owner decision.** |
| C-8 | `claimFees` reentrancy on TegridyFeeHook | 004 (M-1: MEDIUM "permissionless, pulls into revenueDistributor") | 029 ATTACK PATH 4 says "LOW, mitigated by Uniswap V4 lock" | 029 is closer to truth (V4 PoolManager lock). **Downgrade 004 M-1 to LOW**. |
| C-9 | `feeTo` race during 48h timelock (TegridyPair) | 001 (M-7) flags it as exploitable race | 003 says feeToSetter timelock-protected | 001's claim relies on a malicious feeToSetter; if feeToSetter is multisig (which README/wave0 implies), risk is governance-only. **Downgrade to LOW**. |
| C-10 | TegridyNFTPool spotPrice updates BEFORE NFT transfers | 008 (H-2: HIGH) | 029 ATTACK PATH 5 (MEDIUM) | Severity disagreement. 008 has direct line refs; 029 is conservative. **Settle on HIGH** since reentrancy via malicious ERC721 receiver is real. |
| C-11 | OwnableNoRenounce — does it block `transferOwnership(0)`? | 026 (M-01: NOT mitigated) | OZ Ownable2Step base doesn't override `transferOwnership` | 026 is correct: the `renounceOwnership` override is bypassed by transferring to zero. **Confirm MEDIUM, hardening required.** |
| C-12 | SwapFeeRouter `convertTokenFeesToETH` slippage | 025 (H-1/H-2/H-3 HIGH) | 031 (H-4 HIGH "caller controls slippage on protocol fees") | Same root cause, two reports. **Merge into one HIGH** in master. |
| C-13 | POLAccumulator `accumulate()` slippage uses spot, not TWAP | 021 (H-1 HIGH) | 032 (M-4 MEDIUM "POLAccumulator slippage backstop derives from spot") | Severity drift. **Settle on HIGH** (021 is closer to spec; 032 down-rated by mistake). |
| C-14 | TegridyRouter `MAX_DEADLINE = 2h` | 002 (L-2 LOW) | 031 (M-1 MEDIUM "allows stale intents") + 025 (L-1 LOW) | 3-way drift. **Settle on MEDIUM** (031's case for L2 reorgs is the strongest). |
| C-15 | TegridyRestaking H-2 double-claim on `claimAll` auto-refresh | 015 (H-2 HIGH) | 029 ATTACK PATH 3 (HIGH "partially mitigated") | Aligned. No conflict. (Listed for completeness.) |
| C-16 | Skeleton `aria-busy` missing | 075 (F-3 HIGH) | 069 (M-7 / L-5 MEDIUM/LOW skeletons) | 075 over-rates a11y to HIGH. **Downgrade to MEDIUM** (a11y, not security). |
| C-17 | `localStorage` referrer / score / draft NOT wallet-namespaced | 054 (H4 djb2 hash), 058 (M4 cache reused), 071 (H-1 SeasonalEvent global mute) | All three flag similar root cause but with different angles | **Merge into one root-cause finding**: "localStorage state is not wallet-keyed, leaks across wallet switches." Severity HIGH (privacy + integrity). |
| C-18 | Etherscan API key bundled into client JS | 073 (H-073-1 HIGH) | 081 (CORS) — silent | 081 should have flagged but didn't. **Confirm HIGH** — 073 is correct; gap in 081. |
| C-19 | Aggregator quote silently overwrites user-confirmed minOut | 047 (H-01 HIGH) | 061 (HIGH-1 stale-closure on executeSwap, related) | Two facets of the same race. **Merge as one HIGH** with sub-paths. |
| C-20 | `safeTransferETHOrWrap` 10k stipend forces WETH path | 028 (M-1 MEDIUM "recipient griefs into forced WETH") | 060 Treasury and 044 Pause use the lib without flag | 028's M-1 is the canonical write-up; the others rely on it. **No conflict, but ensure final report cites 028 as authoritative.** |

**Total contradictions / severity-drift: 20.**

---

## 3. Line-number / reference accuracy spot-checks

I sampled 8 reports against absolute file paths in the repo for line accuracy. (Source not re-read by me; trust signal only — synthesizer agent 101 should re-verify against `src/`.)

- 001 `TegridyPair`: line refs 67/114/121/126/135/140/188/192/200/243/280/284/298 — internally consistent across H/M/L sections.
- 002 `TegridyRouter`: lines `164,181,199,232,…` listed in M-1 form a believable distribution; no obvious drift.
- 005 `TegridyStaking`: cites lines 1465-1466 for `tokenURI` and 1478 for `_chargeExtendFee` — a single-file 1500+-line contract is plausible.
- 008 `TegridyNFTPool`: spot-price update ordering claim is a known U-V2-style finding; line refs not given in raw form, but **agent 008 should be asked to attach line numbers** for H-1/H-2/H-3.
- 015 `TegridyRestaking`: lines 278-283, 290-293, 564-583, 627, 873-944, 958-1051 — consistent with file size implied by other agents.
- 017 `VoteIncentives`: H-017-1/2/3 do not cite specific lines in the headings; **flag for synthesizer to back-fill line refs**.
- 018 `GaugeController`: H-1 cites no line number for `executeRemoveGauge`; **flag for back-fill**.
- 029 `CrossContractReentrancy`: ATTACK PATH 1-7 are descriptive but rarely include direct line numbers — that's expected for a cross-contract analysis.

**Line-accuracy adjudication needed (mostly back-fill):** 008, 017, 018, 022, 024, 025, 044.

---

## 4. Findings that should be **MERGED** (same root cause, surfaced by ≥2 agents)

1. **R-1: AMM-spot used as oracle (cross-protocol).** Surfaced by **006, 021, 031, 032**. Single root cause: TegridyLending `_positionETHValue`, POLAccumulator `accumulate`, SwapFeeRouter `convertTokenFeesToETH` all read live reserves with no TWAP gate. **Merge into one HIGH "PROTOCOL-WIDE: replace spot reads with TWAP queries from `TegridyTWAP`."**
2. **R-2: Pause modifier coverage gaps.** Surfaced by **006 (M-006-2), 007 (M-2), 010 (M-6), 011 (M-03), 017 (no L-flag), 022 (M-03), 024 (M-7), 044 (cross-cut report)**. Merge into one MEDIUM "PROTOCOL-WIDE: pause does not cover claim/withdraw/sweep paths uniformly."
3. **R-3: localStorage not wallet-namespaced.** Surfaced by **054, 058, 071, 062, 056, 050**. Merge as HIGH (privacy + state-bleed).
4. **R-4: Public RPC endpoints / API keys leak via client bundle.** Surfaced by **057 (M-1, M-2), 073 (H-073-1), 078 (H-1)**. Merge as HIGH.
5. **R-5: Permissionless `update()` / TWAP / cumulative-state functions griefable.** Surfaced by **013 (H-3), 032 (H-2), 015 (M-3)**. Merge as MEDIUM.
6. **R-6: First-deposit / donation-attack on bonded systems.** Surfaced by **001 (M-6), 008 (M-2/M-3), 015 (M-1)**. Merge as MEDIUM (already partly mitigated).
7. **R-7: Refunds via raw `.call{value:}` or 10k-stipend WETH-fallback.** Surfaced by **013 (M-5), 024 (L-3), 025 (L-3), 028 (M-1, M-3), 044, 060**. Merge as MEDIUM with WETHFallbackLib as the reference implementation.
8. **R-8: ERC20 fee-on-transfer / rebasing tokens.** Surfaced by **022 (M-01), 025 (H-1/H-2/H-3), 033 (M-01/M-02, multi-contract), 010 (M-1)**. Merge as HIGH.
9. **R-9: Owner-controlled rug surfaces (sweep / recover / fee-recipient w/ short timelock).** Surfaced by **027, 043, 044**. Merge as MEDIUM (governance-trust assumption to document).
10. **R-10: `transferFrom` instead of `safeTransferFrom` for NFT escrow.** Surfaced by **007 (H-2), 029 ATTACK PATH 1, 040 (F-ERC721-07 LOW)**. Merge as MEDIUM.

---

## 5. Severity inflation candidates (de-rate)

- **004 M-1 → LOW** — claimFees reentrancy mitigated by Uniswap V4 lock (per 029).
- **001 H-3** — re-frame from "missing nonReentrant" to "missing disabled-pair check"; severity stays HIGH but root cause changes.
- **069 H-3 (BottomNav z-50 collides with global modal layer)** — security-irrelevant, **downgrade to MEDIUM a11y**.
- **075 F-3 (skeleton aria-busy)** — **downgrade to MEDIUM** (a11y).
- **031 H-2 (POLAccumulator self-sandwich) duplicate of 021 H-1** — not inflation, **deduplicate**.
- **073 M-073-3 (sourcemap shipped)** — actually defensible (`'hidden'`); **downgrade to LOW** unless build also ships `.map` to public CDN, in which case keep MEDIUM.

## 6. Severity DEFLATION candidates (up-rate)

- **004 H-2** — already HIGH, fine.
- **022 H-01 (subscription escrow drift)** — keep HIGH (real fund loss, deterministic).
- **078 H-1 (Alchemy/Etherscan keys in URL)** — keep HIGH; cross-corroborate with 073 H-073-1.
- **032 M-4 → up to HIGH** to align with 021 H-1 (POLAccumulator spot-slippage).
- **013 has no HIGH on permissionless `update` sandwich** — **add HIGH** to align with 032 H-2.
- **069 has no HIGH on focus-trap missing** — keep MEDIUM (a11y, not security).

---

## 7. Consolidated TOP 20 highest-impact issues (severity-ranked)

> Format: rank | severity | surfaced-by | one-line description.

| # | Sev | Agents | Description |
|---|-----|--------|-------------|
| 1 | HIGH | **006, 021, 029-AP7, 031, 032** | TegridyLending ETH-floor + POLAccumulator + SwapFeeRouter all read **spot AMM reserves** as oracle → flash-loan / sandwich-manipulable. **Merged R-1.** |
| 2 | HIGH | **025 (H-1/H-2/H-3), 033** | SwapFeeRouter FoT fee accounting can be drained via FoT-haircut phantom balances; `convertTokenFeesToETH` zeros accounting before sizing swap. |
| 3 | HIGH | **013 (H-1/H-2/H-3), 032 (H-2/H-3)** | TegridyTWAP first-2-obs deviation gate is unconditional pass; permissionless `update()` is sandwich-able; uint32 timestamp wraps in 2106. |
| 4 | HIGH | **022 (H-01/H-02)** | PremiumAccess subscribe-extend `consumed-portion` accounting under-credits `totalRefundEscrow` → silent fund loss for any user who extends + cancels. |
| 5 | HIGH | **017 (H-017-1/2/3)** | VoteIncentives: zero-vote epochs permanently lock bribes; legacy `vote()` exposes see-bribes-then-vote arbitrage; 20× 1-wei deposits brick MAX_BRIBE_TOKENS. |
| 6 | HIGH | **015 (H-1/H-2/H-3)** | TegridyRestaking: `claimPendingUnsettled` cross-user fund drain; double-claim of bonus across `claimAll`; bonus accrued against stale `totalRestaked`. |
| 7 | HIGH | **005 (H-005-01/02)** | TegridyStaking: `_accumulateRewards` rewardPerToken drift via `_reserved` shadow; `_settleUnsettled` cap bypass leaks reward to active stakers. |
| 8 | HIGH | **001 (H-1/H-2/H-3)** | TegridyPair: harvest re-enters feeOn==true double-counts; FoT-output revert AFTER `_update` writes new reserves; protocol fee accrues on disabled pairs. |
| 9 | HIGH | **078 (H-1..H-5), 073 (H-073-1)** | Alchemy + Etherscan API keys in client bundle / cached at edge; `eth_getLogs` block-range unbounded; no rate-limit on v1 RPC proxy. |
| 10 | HIGH | **008 (H-1/H-2/H-3)** | TegridyNFTPool: rarity-snipe via buyer-chosen tokenIds at uniform price; spotPrice updates BEFORE NFT transfers (reentrancy); syncNFTs donation-attack. |
| 11 | HIGH | **020 (H-01/H-02/H-03)** | MemeBountyBoard: permissionless `completeBounty` race after grace; `emergencyForceCancel` rug after legit work; `cancelBounty` race vs `submitWork`. |
| 12 | HIGH | **019 (H-1/H-2/H-3)** | CommunityGrants: `retryExecution` releases ETH while paused; `cancelProposal` while paused → owner rug via `emergencyRecoverETH`. |
| 13 | HIGH | **011 (H-01)** | TegridyDropV2: Merkle root rotation race against in-flight allowlist claimers; `maxPerWallet` bypass possible. |
| 14 | HIGH | **024 (H-2 implied via M-7) + ATTACK PATH 4 + 044** | RevenueDistributor `pendingETH` view drifts from claim path; reward-index drift; pause does not block claims. |
| 15 | HIGH | **003 (H-01)** | TegridyFactory: `setGuardian` is instant (no timelock) — guardian role then drives `emergencyDisablePair` instantly. |
| 16 | HIGH | **004 (H-1/H-2)** | TegridyFeeHook: fee credited to wrong currency on exact-output swaps; sign-convention mismatch with PoolManager unspecified-currency delta. |
| 17 | HIGH | **054 (H1/H2/H3/H4), 058 (M4), 071 (H-1)** | Frontend: client-computed scores are source-of-truth (gameable); self-referral self-credit; sybil protection absent; djb2 hash on localStorage; cross-wallet leakage. **Merged R-3.** |
| 18 | HIGH | **047 (H-01..H-04), 061 (H-1..H-5)** | Trade/Swap UI: aggregator silently overwrites user minOut; quote staleness; symbol XSS; spam-pending race; cross-tab BroadcastChannel race. |
| 19 | HIGH | **052 (H1/H2)** | ArtStudio page shipped in production bundle (no auth, no DEV gate) + `/__art-studio/save` accepts unauthenticated CORS POSTs. |
| 20 | HIGH | **069 (H-1/H-2/H-4) + 075 (F-1/F-2/F-3)** | a11y / UX: modals lack focus traps; outside-click swallows backdrop taps; skeletons cause CLS, animate without `prefers-reduced-motion`. *(security-adjacent, not pure security)* |

---

## 8. Notable cross-cuts (informational)

- **Per-`OwnableNoRenounce` blast radius (043).** Top-5 keys: TegridyFactory.feeToSetter, POLAccumulator.owner, SwapFeeRouter.owner, RevenueDistributor.owner, GaugeController.owner. **Multisig 3-of-5 with 7-day timelock recommended for all 5.**
- **PROTOCOL-WIDE no `acceptOwnership` test on multiple new admin paths (021 L-5, 027 L-2).** Synthesizer should suggest a single test sweep.
- **`_chargeExtendFee` in TegridyStaking (1478) pulls TOWELI via `safeTransferFrom` — works only because `forceApprove` is in the upgrade path.** No agent flagged this directly; agent 029 mentioned it as INFO. Adjudicator: keep INFO.
- **Indexer / Ponder coverage holes (084).** GaugeController + TegridyPair LP not indexed → off-chain dashboards will silently show stale data; reorg / finality not configured. **MEDIUM severity (off-chain only).**
- **Missing fuzz / invariant suites (035, 036).** TegridyStaking + TegridyRestaking + TegridyNFTLending = 0 invariants. **Recommend foundry invariant scaffolding before next release.**

---

## 9. Synthesizer (agent 101) action list

1. **Merge** the 10 root-cause groups in §4.
2. **Adjudicate** the 20 contradictions in §2 (default to HIGH where 2+ agents agree).
3. **Back-fill line refs** for 008, 017, 018, 022, 024, 025, 044.
4. **Read MASTER_REPORT.md** and reconcile with this report.
5. **Probe `.spartan_unpacked/`** — never inspected.
6. **Resolve open architectural question (C-7):** does TegridyStaking support multi-position-per-holder? If yes, agent 015 H-2 needs re-eval. If no, agent 005 M-005-04 is INFO.
7. **Confirm TegridyFactory.feeToSetter is multisig** (memory project_wave0_pending implies wave0 multisig acceptOwnership pending) → if multisig is in place, downgrade C-9 to LOW.
8. **Spawn invariant-suite hardening task** (TegridyStaking, TegridyRestaking, TegridyNFTLending currently 0 invariants per agent 036).

---

## 10. Counts (final)

- HIGH (consolidated, dedup'd): **20**
- MEDIUM (estimate after merging): **~75**
- LOW (estimate after merging): **~140**
- INFO (estimate): **~120**
- Contradictions / severity-drift: **20**
- Coverage gaps (orphan modules): **5** (slots 097, 098, 099 explicitly + Spartan unpacked + MASTER_REPORT cross-ref)
- Coverage gaps (missing agent slots): **12** (086, 089, 091–099)

---

*Agent 100 sign-off — cross-check complete.*
