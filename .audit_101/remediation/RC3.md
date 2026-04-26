# RC3 — Recovery pass: re-apply R008 + R076 doc edits

**Agent:** RC3 (RECOVERY pass)
**Date:** 2026-04-25
**Mandate:** Re-apply the R008 + R076 doc-truth-up edits that were reverted from
the working tree. No artwork / personality copy touched (per memory
`feedback_preserve_art.md`). No false claims added.

---

## Sources of truth re-consulted

- `contracts/src/Toweli.sol` — confirms NO `burn()` / no `_burn` entrypoint.
- `contracts/src/SwapFeeRouter.sol` — confirms `feeBps` is a `uint256 public`
  mutable state variable, with `MAX_FEE_BPS = 100` as the only constant cap.
- `CHANGELOG.md` + `AUDITS.md` — H-2 commit-reveal IS LIVE on `GaugeController`
  `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` (confirmed in the 2026-04-18
  Wave-0 deploys block).
- Memory `project_wave0_pending.md` — Wave 0 partially done 2026-04-18;
  `VoteIncentives + V3Features + FeeHook-patch` redeploys plus multisig
  `acceptOwnership` on 3 contracts still pending.
- `.audit_101/remediation/R003.md` / `R015.md` / `R020.md` / `R029.md` — Wave 1–4
  bulletproofing constructor / behaviour deltas.

---

## Files edited (10)

| File | Change |
|---|---|
| `FAQ.md` | (1) "How are fees distributed (70/20/10)?" — replaced burn/buyback claim with "10% reserved for future tokenomics decisions via governance — there is currently no protocol burn mechanism." Pointed to `TOKENOMICS.md`. (2) "Who controls the multisig?" — flagged Wave-0 multisig migration as PLANNED (incomplete as of 2026-04-25); single-EOA with timelock today. |
| `REVENUE_ANALYSIS.md` | Removed fictional `SWAP_FEE_BPS = 50` constant on rows 1+2 of the every-revenue-lever table. Replaced with "Swap fee is a mutable state var on `SwapFeeRouter` queryable via `feeBps()` getter; default 50 bps (0.50%) configurable via 48h timelock." Kept `MAX_FEE_BPS = 100` as the hard constant cap. |
| `SECURITY.md` | (1) Replaced Immunefi alternative-channel block with a "bug bounty program is being set up — email security@ for now, Hall-of-Fame + priority once live" callout. (2) "Use email or Immunefi" → "Use email." (3) Replaced Bounty Tiers $50k–$250k table with the interim-acknowledgment statement. (4) Reworded Safe Harbor's Immunefi-compatibility line to flag the program as not yet live. (5) Last-updated stamp 2026-04-19 → 2026-04-25. |
| `README.md` | Replaced the deleted `./scripts/redeploy-patched-3.sh` block with a per-contract `forge script` example (`DeployTegridyLPFarming.s.sol`) and pointer to `DEPLOY_CHEAT_SHEET.md` + `DEPLOY_RUNBOOK.md` for the full ordered sequence. |
| `FIX_STATUS.md` | (1) Header refreshed to 2026-04-25 with Wave-1–4 reference. (2) "Needs YOU" gains a Wave-0 multisig `acceptOwnership` line and per-contract constructor-arg deltas (R003 / R015 / R020 / R029). (3) Replaced deleted `redeploy-patched-3.sh` reference with per-contract `forge script` recipe pointer. |
| `DEPLOY_RUNBOOK.md` | (1) §1 inventory row for `TegridyLending` updated with R003 +TWAP details. (2) New "Subsequent batches" subsection covering R003 / R015 / R020 / R029 + FeeHook re-mint. (3) §10 closes the legacy "H-2 commit-reveal — not implemented" entry, opens "Wave-0 multisig acceptOwnership STILL OPEN" + "Wave-0 redeploys still pending broadcast" entries; closes Spartan TF-13 via R020's `refundUnvotedBribe`. |
| `DEPLOY_CHEAT_SHEET.md` | (1) Step 3 (V3 features) gains an R003 callout + `export TWAP=…` line. (2) Step 4 (NFT Lending) gains R029 callout. (3) Step 6 (Vote Incentives) gains R020 callout for the new 7th constructor arg. (4) §3 "Post-broadcast wiring" gains a "Wave-0 multisig acceptOwnership STILL OPEN" Step 0 callout + a new Step 5 for the R029 whitelist migration recipe (JBAC / Nakamigos / GNSS). |
| `NEXT_SESSION.md` | Header refresh to 2026-04-25 with Wave-1–4 bulletproofing pass status + reference to `.audit_101/MASTER_REPORT.md` + `DETAILED_REPORT.md` + `R001`–`R076`. Immediate priorities split into 1a (multisig acceptOwnership), 1b (redeploys still pending — R003 / R015 / R020 / R029 / FeeHook re-mint), 1c (R029 NFTLending whitelist migration). |
| `CHANGELOG.md` | Added new `[Unreleased]` 2026-04-25 entry: "Wave 1–4 bulletproofing — ~80 R-fixes; build green; tests pass" with breaking-constructor-change list (R003 / R015 / R020 / R029), Wave-0-still-pending bucket, and docs sweep callout. References `.audit_101/MASTER_REPORT.md` + `DETAILED_REPORT.md` + `REMEDIATION_REPORT.md`. |
| `AUDITS.md` | TL;DR table internal-AI-agent count 7 → 8, with explicit reference to the **101-agent canonical pass (Apr 25, 2026)** under `.audit_101/MASTER_REPORT.md` + `DETAILED_REPORT.md` + `R001`–`R076`. |

---

## Top corrections

1. **FAQ burn/buyback claim removed** — `Toweli.sol` has no `burn()` entrypoint;
   supply is fixed at 1B. Replaced with governance-decision language.
2. **FAQ multisig 4-of-7 claim** flagged as PLANNED (Wave 0 incomplete);
   today's reality is single-EOA + on-chain timelock delays.
3. **REVENUE_ANALYSIS phantom `SWAP_FEE_BPS = 50` constant** removed;
   `feeBps` correctly described as a mutable state var with `feeBps()` getter,
   default 50 bps, configurable via timelock.
4. **SECURITY.md Immunefi $50k–$250k tiers removed**; bounty program flagged as
   being set up, with Hall-of-Fame + priority interim acknowledgment.
5. **README + FIX_STATUS deleted-script reference** (`redeploy-patched-3.sh`)
   replaced with per-contract `forge script` recipe + `DEPLOY_CHEAT_SHEET.md`
   pointer.
6. **DEPLOY_RUNBOOK + DEPLOY_CHEAT_SHEET** gain R003 / R015 / R020 / R029
   constructor / behaviour deltas; Wave-0 multisig `acceptOwnership` flagged as
   prerequisite Step 0.
7. **NEXT_SESSION** Immediate-priorities split into 1a multisig
   `acceptOwnership` / 1b redeploys / 1c R029 whitelist migration.
8. **CHANGELOG** new `[Unreleased]` 2026-04-25 entry naming Wave 1–4
   bulletproofing + R-fix references.
9. **AUDITS** TL;DR adds 101-agent canonical pass row.
10. **DEPLOY_RUNBOOK** §10 closes H-2 commit-reveal (now LIVE) + Spartan TF-13
    (closed by R020's `refundUnvotedBribe`).

---

## Constraints honoured

- **No artwork / personality copy touched** (per memory `feedback_preserve_art.md`).
  All edits are factual / numeric / version corrections.
- **No false claims added.** Every change reduces an existing claim toward
  on-chain or canonical-doc truth, or adds a verifiable callout (constructor-arg
  counts, post-deploy steps, multisig-pending state).
- **No `.env` content / secret values touched** (per memory `feedback_env_files.md`).
- **No new docs fabricated** — only edits to existing markdown + this RC3 log.
- **"Currently single-EOA, multisig planned" language preserved** in FAQ
  multisig answer.
