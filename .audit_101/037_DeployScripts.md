# Agent 037 — Deploy Scripts Audit (contracts/script/)

Scope: 19 .sol scripts (excluding mocks/). AUDIT-ONLY. Findings classified
HIGH / MEDIUM / LOW with operator-only remediation notes (no code edits).

---

## DeployFinal.s.sol

**HIGH-1: Setter ordering — Factory.proposeFeeToChange runs BEFORE
transferOwnership but feeToSetter is NEVER moved to multisig.**
Lines 155 and 168-172: script proposes feeTo change (which lives behind a
48h timelock executable only by feeToSetter), then transfers ownership of
the 9 Ownable contracts to MULTISIG, but the `feeToSetter` role on
TegridyFactory remains the deployer. The "next steps" mention `executeFeeToChange()`
as if multisig will perform it — they cannot. The deployer EOA must call
executeFeeToChange() AND must call proposeFeeToSetter(MULTISIG) /
acceptFeeToSetter(). DeployFinal omits the proposeFeeToSetter step entirely
(unlike DeployAuditFixes line 165 narrative). **Remediation note:** before
running this script's successor, manually `proposeFeeToSetter(MULTISIG)`
on TegridyFactory and have multisig accept after 48h.

**MEDIUM-1: Restaking is `proposed` on Staking BEFORE ownership transfer
but `executeRestakingContract()` cannot fire until 48h after proposal.**
Once ownership is transferred and multisig accepts, only the new owner
(multisig) can execute. Net effect is fine (multisig is intended executor)
but the script's "NEXT STEPS" line 195 silently assumes multisig will
acceptOwnership() before 48h elapses.

**MEDIUM-2: `Deployed.factory` ownership not transferred.**
Lines 159-167: only 9 of the 12 deployed addresses are sent to multisig.
TegridyFactory ownership/feeToSetter retention is implicit (factory uses
custom feeToSetter pattern not Ownable), but if any owner-gated function
exists on Factory it's deployer-controlled.

**LOW-1: `multisig` is fetched mid-broadcast on line 51; if env var
malformed, the whole broadcast aborts after deploys. No partial-state
recovery noted.**

---

## DeployAuditFixes.s.sol

**HIGH-1: Same Factory feeToSetter problem as DeployFinal.**
Line 165 narrative mentions `proposeFeeToSetter(MULTISIG)` as a manual
post-step, never broadcast inside the script. Operators must remember.

**MEDIUM-1: All 9 contracts use Ownable2Step — script ends with deployer
still as effective owner until multisig calls acceptOwnership().** Script
docs (line 162) acknowledge it. Risk: if ops forget acceptOwnership for >7
days, deployer remains operationally in control silently.

**LOW-1: `LP_TOKEN` env var is consumed AFTER the 8 prior `new` deploys
on line 105. If LP_TOKEN env is unset, script reverts AFTER spending gas
on 8 deploys.** Move `vm.envAddress("LP_TOKEN")` and `MULTISIG` reads to
the top of `run()`.

**LOW-2: Two console.log lines mislabeled `9.` (lines 113, 121).** Cosmetic.

---

## DeployRemaining.s.sol

**HIGH-1: Cross-contract linking runs BEFORE ownership transfer (correct),
BUT no validation that hardcoded addresses (lines 19-26) are actually owned
by the deployer key being used.** If the wrong PRIVATE_KEY is loaded, every
call reverts mid-broadcast leaving partial wiring. **Remediation note:**
prepend `require(Ownable2Step(STAKING).owner() == vm.addr(pk))` checks
similar to WireAuditFixes.

**MEDIUM-1: Hardcoded RESTAKING / REFERRAL / etc. addresses (lines
19-26) differ from V2's WireV2.s.sol addresses.** This is the V1 audit-fix
deploy set. If operator runs both scripts on a fresh chain, they wire
different address sets. Document which script supersedes which.

**LOW-1: `LP_TOKEN` env consumed mid-broadcast (line 39 read, line 48 use)
— script aborts after partial deploy if LP_TOKEN unset.**

---

## DeployV2.s.sol

**MEDIUM-1: `voteIncentives.proposeWhitelistChange(TOWELI, true)` (line 154)
proposed under deployer ownership — once `transferOwnership(MULTISIG)` runs
(line 172) and multisig accepts, multisig executes the whitelist after 24h.
This is correct, but if multisig accepts before the 24h matures, no race —
fine.**

**MEDIUM-2: PremiumAccess in V2 is a fresh deploy (line 136-142) with
deployer set as initial owner. The script ALSO calls
`premium.transferOwnership(MULTISIG)` (line 179). Critical: PremiumAccess's
constructor parameters do NOT validate non-zero treasury. If TREASURY
constant were ever zero, deploy succeeds with broken state.** TREASURY is
hardcoded so currently safe; flag for any future env-driven version.

**LOW-1: SwapFeeRouter V2 needs `proposeRevenueDistributor` and
`proposePremiumAccessChange` calls (per next-steps lines 205-206) but
those proposals are NOT broadcast by the script.** Operator must remember.

**LOW-2: `BRIBE_FEE_BPS = 300` hardcoded constant (line 38) — no console
log of the value at deploy time.** Cosmetic.

---

## WireV2.s.sol

**HIGH-1: This script is a recovery / catch-up wiring tool. The 9
`transferOwnership` calls on lines 74-82 will SILENTLY SUCCEED even if
ownership has already been transferred (transferOwnership is idempotent on
Ownable2Step — overwrites pendingOwner).** No `require(owner() == deployer)`
guard. If misrun against already-transferred contracts owned by multisig,
all 9 calls revert with `OwnableUnauthorizedAccount` — partial damage,
gas wasted.

**HIGH-2: Hardcoded V2 addresses (lines 35-46) lack any chain-state
validation.** Unlike WireAuditFixes which checks `feeToSetter() == deployer`,
this script blindly trusts the constants. If an address is wrong/stale,
the call reverts mid-broadcast. **Remediation note:** add
`require(IOwnable(STAKING).owner() == vm.addr(pk))` at the top.

**MEDIUM-1: `proposeWhitelistChange`, `proposeRestakingChange`,
`proposeRestakingContract` (lines 62, 66, 70) all run via deployer — fine
for proposing, but executeXxx must come from multisig POST-acceptOwnership.
Script's docstring does not link to a follow-up runbook.**

---

## WireAuditFixes.s.sol

**LOW-1: `setRewardNotifier` calls (lines 91, 98, 105) run BEFORE the
implied ownership transfer to multisig. The script's tail comment (line 139)
says "Next: transfer ownership of Factory + Staking to multisig" — but that
transfer is NOT in this script.** Operator-only step, easy to forget.

**LOW-2: Post-broadcast staticcall checks (lines 113-135) are excellent —
this is the gold-standard wiring script.** No defects.

**LOW-3: `setGuardian` accepts `guardian = deployer` per docstring (line 30)
as a placeholder. If operator forgets to rotate guardian to a separate
multisig later, factory's emergency-pair-disable is held by an EOA.**
Remediation note: add a calendar reminder + post-deploy check that
`factory.guardian() != deployer` after Day-N.

---

## DeploySepolia.s.sol

**MEDIUM-1: Deployer is owner AND treasury for everything (lines 99, 103,
126, 133, 137, 145, 149, 157, 161). No `transferOwnership` calls
anywhere.** Acceptable for testnet, but the file lacks a `--mainnet check`
counter-warning beyond `chainid == 11155111`. If anyone copy-pastes this
pattern for mainnet, deployer remains owner permanently.

**MEDIUM-2: `notifyRewardAmount` is called inline (line 187) with deployer
as caller. After the NEW-S5 audit fix, notifyRewardAmount requires owner OR
allowlisted notifier — deployer IS owner here so it works. Flag: Sepolia
script will diverge from mainnet behavior after rewardNotifiers landed.**

**LOW-1: `addLiquidityETH` slippage = 0 (lines 195-196).** Testnet only —
acceptable, comment says so explicitly.

---

## DeployVoteIncentives.s.sol

**MEDIUM-1: TOWELI whitelist proposed (line 47) by deployer. Once
ownership transfers (line 59), multisig must execute after 24h.** Standard
Ownable2Step caveat: `acceptOwnership()` MUST land in multisig before 24h
matures or the whitelist sits unexecuted indefinitely.

**LOW-1: WETH whitelist deferred to manual step (line 71) — easy to
forget.** Operator runbook risk.

---

## DeployGaugeController.s.sol

**HIGH-1: `vm.startBroadcast()` on line 14 with NO PRIVATE_KEY arg.**
Forge will fall back to default sender or ledger — broadcast key handling
is implicit and inconsistent with all sibling scripts. Easy footgun if
operator runs with `--private-key` flag vs an env-var workflow.

**MEDIUM-1: `multisig = vm.envOr("MULTISIG", address(0))` (line 18) — if
MULTISIG env unset, `gauge.transferOwnership` is silently skipped (line 19
guard). Deployer keeps ownership.** Make MULTISIG required.

**LOW-1: No proposeAddGauge inside the script — manual step (line 26).**

---

## DeployTegridyFeeHook.s.sol

**MEDIUM-1: `HOOK_OWNER` defaults to deployer EOA (line 53) via
`vm.envOr`.** If the operator forgets to set HOOK_OWNER to multisig, deployer
permanently owns the V4 hook (TegridyFeeHook is single-step Ownable per
constructor). No follow-up `transferOwnership(MULTISIG)` call.

**LOW-1: `feeBps = 30` hardcoded fallback (line 54) — could conflict with
the 75-bps global fee planned in ConfigureFeePolicy.** Out-of-band drift.

**LOW-2: Salt-mining instructions in docstring rely on shell pipelines —
correct but fragile copy-paste.** Documentation note.

---

## ConfigureFeePolicy.s.sol

**HIGH-1: Setter calls run AGAINST a contract whose ownership is already
intended to be on multisig (per V2 deployment narrative).** Script's
comment (line 30-31) acknowledges this: "If ownership was transferred to a
multisig, run these as proposals from the multisig UI instead." There is no
`require(SwapFeeRouter(...).owner() == vm.addr(pk))` guard — operator can
broadcast and watch every call revert AFTER paying gas.

**MEDIUM-1: Phase-1 proposals queue 4 separate timelocks (lines 59-75) but
`proposePairFeeChange` only has ONE pending slot per the comment on line
108-110. Phase-1 queues TWO pair proposes back-to-back — the second
overwrites the first.** This is acknowledged in Phase-2 NOTE (line 117) but
the Phase-1 script will silently corrupt the queue. **Remediation note:**
remove line 75 (TEGRIDY_LP propose) from Phase 1 — it must be a separate
run after the first executes.

**LOW-1: Mainnet captive fee 100 bps hardcoded — not env-driven.** Future
flexibility issue only.

---

## DeployTegridyRouter.s.sol

**MEDIUM-1: TegridyRouter has NO Ownable surface — deployment is fine.
But the next-steps (line 39-41) require `feeToSetter` actions on the
Factory which are out-of-script — same systemic feeToSetter issue as
DeployFinal.**

**LOW-1: No initial pair creation or factory linkage check.** Script just
deploys an isolated router.

---

## DeployTegridyLPFarming.s.sol

**MEDIUM-1: `multisig = vm.envOr("MULTISIG", address(0))` (line 55) —
silently skips ownership transfer if env unset, leaving deployer as
permanent owner.** Make MULTISIG required.

**LOW-1: `notifyRewardAmount` is a manual post-step (line 71) — fine, but
boost source `tegridyStaking` is taken as env addr without verification.**

---

## DeployTokenURIReader.s.sol

**LOW-1: Reader contract is stateless / has no owner.** No risk surface.

**LOW-2: Hardcoded TEGRIDY_STAKING address (line 8) — if redeployed,
script must be updated.** Hygiene note.

---

## DeployToweli.s.sol

**MEDIUM-1: `Toweli` is a one-time mint to `treasury` — ownership /
admin surface depends on the contract itself (not loaded into this audit).
If Toweli has owner functions, they're deployer-owned at end-of-script.**

**LOW-1: This is documented as testnet-only reference (line 8-12).**
Operator note in docstring is sufficient.

---

## DeployNFTLending.s.sol

**MEDIUM-1: Single-step transferOwnership (line 36) on TegridyNFTLending
— if multisig forgets `acceptOwnership`, contract is bricked-pending.**
Standard Ownable2Step caveat.

**LOW-1: Whitelisted collections set in constructor (line 32) — addresses
shown in console.log (lines 47-49) but never validated to be the same set
the contract actually stored.**

---

## DeploySwapFeeRouterV2.s.sol

**HIGH-1: This deploys a NEW SwapFeeRouter and immediately proposes
PremiumAccess + premium discount changes (lines 40, 44) — but the existing
ReferralSplitter (REFERRAL_SPLITTER constant line 12) needs
`setApprovedCaller(newSwapFeeRouter, true)` to actually wire the new
router into the referral pipeline. This step is in next-steps (line 64)
but NOT broadcast.** Until done, all swaps via new router with referrals
revert.

**MEDIUM-1: `multisig = vm.envOr` silently skips transfer (line 48-54)
— same pattern, deployer keeps ownership if env unset.**

**LOW-1: PREMIUM_DISCOUNT_BPS = 5000 hardcoded.** Configurable via env
would be safer.

---

## DeployLaunchpadV2.s.sol

**MEDIUM-1: Standard Ownable2Step transferOwnership — multisig must
acceptOwnership.** Caveat repeated.

**LOW-1: `dropTemplate` is auto-deployed in constructor (line 36-41)
and verified separately (line 67) — operator must verify the implicit
template too. Easy to skip.**

---

## DeployTWAP.s.sol

**LOW-1: TegridyTWAP is stateless / no owner — no transfer needed.**
Script is clean.

**LOW-2: Update steps (line 32-35) are manual — no keeper deployment.**

---

# Summary Counts

- HIGH: 8 (DeployFinal, DeployAuditFixes, DeployRemaining, WireV2 ×2,
  DeployGaugeController, ConfigureFeePolicy, DeploySwapFeeRouterV2)
- MEDIUM: 19
- LOW: 16

# Cross-Script Patterns

1. **feeToSetter is the systemic blind spot.** DeployFinal /
   DeployAuditFixes propose feeTo changes but never proposeFeeToSetter to
   multisig. The deployer EOA retains the executor role on Factory
   indefinitely unless an out-of-script step runs.

2. **`vm.envOr("MULTISIG", address(0))` pattern silently skips ownership
   transfer.** Affects DeployGaugeController, DeployTegridyLPFarming,
   DeploySwapFeeRouterV2 — make MULTISIG hard-required.

3. **Wire scripts (WireV2, ConfigureFeePolicy) lack state guards** that
   WireAuditFixes pioneered. Add `require(owner() == deployer)` preflight.

4. **Mid-broadcast env reads** (DeployAuditFixes line 105, DeployRemaining
   line 39) cause partial-state aborts. Move to top of run().

5. **2-step ownership = pendingOwner trap.** Every script ends with
   `pendingOwner = multisig`; if multisig forgets `acceptOwnership()` for
   N days, the deployer remains effective owner. No script enforces or
   logs an acceptance deadline.
