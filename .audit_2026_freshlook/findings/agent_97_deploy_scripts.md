# Agent 97 — Fresh-Eyes Deploy Script Audit

**Lens:** Deploy / wire scripts — fund flow, owner transfer, sequence races, atomicity.
**Target:** `contracts/script/*.sol` (22 scripts).
**Date:** 2026-05-07
**Method:** Read every script end-to-end, cross-checked against the on-chain
init surface of each target contract (`setStakingAdmin`, `setSwapFeeRouterAdmin`,
`setVoteIncentivesAdmin`, `setApprovedCaller/completeSetup`, etc.) and compared
against `Verify.s.sol` post-conditions.

---

## F-97-1 — `staking.restakingContract` is documented but **never wired** by any deploy/wire script

**Severity:** HIGH — gap is acknowledged inside `Verify.s.sol` itself.

**Files (load-bearing comments / `console.log` lines):**
- `contracts/script/DeployFinal.s.sol:97-99`
- `contracts/script/DeployAuditFixes.s.sol:139-141`
- `contracts/script/DeployRemaining.s.sol:61-62`
- `contracts/script/DeploySepolia.s.sol:119-120`
- `contracts/script/DeployV2.s.sol:176-177`
- `contracts/script/WireV2.s.sol:68-69`
- Symptom check: `contracts/script/Verify.s.sol:82-89` (INV-1)

**Issue.** Six deploy/wire scripts each emit a `console.log("... must be proposed
via TegridyStakingAdmin")` placeholder instead of actually calling
`staking.setStakingAdmin(...)` followed by
`stakingAdmin.proposeRestakingContract(...)`. No deploy script in the tree:

1. Imports `TegridyStakingAdmin`,
2. Deploys it,
3. Calls `staking.setStakingAdmin(admin)` (one-shot setter — see
   `TegridyStaking.sol:1878`),
4. Calls `admin.proposeRestakingContract(...)`.

`Verify.s.sol` declares INV-1 as the very first invariant precisely because
"WireV2/DeployRemaining/etc. all SKIP this step" (verbatim comment
`Verify.s.sol:84-89`). The fact that the verifier was authored to **assume the
gap** is itself a deploy-script regression: ownership has historically been
handed off to the multisig with `restakingContract == address(0)`, breaking
every restaking-aware bonus path on `RevenueDistributor` and the
`getReward` boost path on `TegridyStaking`.

**Race window.** Between
`setStakingAdmin == address(0)` and the multisig later calling it, **anyone**
who can convince the multisig signer set to point `setStakingAdmin` at a
malicious contract can hijack the timelocked admin surface (replaceability is
still gated by `proposeAdminReplacement`, but the *first-time* setter on
`TegridyStaking.sol:1878` is `onlyOwner` only — it does **not** require code
length checks beyond `_admin.code.length == 0`, and it does **not** require
the candidate admin to expose any specific interface). Until ownership is
accepted by the multisig the deployer EOA can do this unilaterally.

**Fix.** Promote the manual step into the broadcast block: deploy
`TegridyStakingAdmin`, wire it via `setStakingAdmin`, then have the admin
queue `proposeRestakingContract(restaking)` BEFORE
`staking.transferOwnership(multisig)`.

---

## F-97-2 — `Verify.s.sol` invariants don't cover **eight** contracts the deploy scripts emit

**Severity:** MEDIUM — silently ships broken wiring as "verified".

**File:** `contracts/script/Verify.s.sol:115-123` (INV-5).

**Issue.** INV-5 only checks ownership for 9 V2 contracts. It does **not**
verify any of:

1. `POLAccumulator` (deployed in `DeployFinal.s.sol:138`,
   `DeployAuditFixes.s.sol:117`, `DeployRemaining.s.sol:50`,
   `DeploySepolia.s.sol:154`).
2. `TegridyLaunchpadV2` (`DeployLaunchpadV2.s.sol:39`).
3. `TegridyNFTLending` (`DeployNFTLending.s.sol:31`).
4. `TegridyFeeHook` (`DeployTegridyFeeHook.s.sol:77`).
5. `TegridyTWAP` (`DeployTWAP.s.sol:30`).
6. `TegridyLPFarming` (`DeployTegridyLPFarming.s.sol:43`).
7. `GaugeController` (`DeployGaugeController.s.sol:15`).
8. `TegridyTokenURIReader` (`DeployTokenURIReader.s.sol:17`).

Several of these have a "skip if MULTISIG env unset" clause (e.g.
`DeployGaugeController.s.sol:18-22`, `DeployTegridyLPFarming.s.sol:53-58`,
`DeploySwapFeeRouterV2.s.sol:55-62`) that the verifier has no chance of
catching. **A clean `forge script Verify.s.sol` exit code does NOT mean the
deployment is safe** — it means a 9-contract subset is safe.

**Fix.** Extend INV-5 to assert ownership on every Ownable contract; or have
the deploy scripts hard-fail when `MULTISIG` is unset rather than skipping
ownership transfer (LPFarming/Gauge/SFRv2 are the worst offenders here).

---

## F-97-3 — `MULTISIG == TREASURY == 0xE9B7…d53e` everywhere; not a multisig

**Severity:** HIGH — collapses all "transfer ownership to multisig" steps to
"transfer ownership to the same EOA that already holds protocol fees".

**Files:**
- `contracts/script/Verify.s.sol:71-72`
- `contracts/script/WireV2.s.sol:44-45`
- 11 other scripts hardcode `TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e`
  (e.g. `DeployFinal.s.sol:25`, `DeployAuditFixes.s.sol:21`,
  `DeployV2.s.sol:34`, `DeployVoteIncentives.s.sol:19`, …).

**Issue.** `WireV2.s.sol:45` declares `address constant MULTISIG =
0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;`, identical to the TREASURY
constant in every deploy script. `Verify.s.sol:71-72` repeats the same
collapse. Per the project memory file `project_relaunch.md` the protocol is
relaunching from a new wallet, but the script tree still bakes the
TREASURY-equals-MULTISIG conflation. INV-5 will pass even though every
contract is owned by the **treasury EOA**, not a real Safe.

**Risk.** A single compromised deployer key (no on-chain enforcement of
multi-party signing) controls every privileged surface — staking emergency
withdraw, factory feeTo, swap-fee admin proposals, NFT-lending emergencies.

**Fix.** Make MULTISIG a required `vm.envAddress` everywhere (`WireV2`,
`Verify`, `DeployTegridyLPFarming` already does in spirit) AND add an
explicit `require(multisig != TREASURY, "MULTISIG_EQUALS_TREASURY")` guard
before any `transferOwnership`.

---

## F-97-4 — `DeployFinal.s.sol` ships staking live but **unfunded**, with public address — first-staker grief race

**Severity:** MEDIUM (mainnet only — Sepolia funds atomically).

**Files:**
- `contracts/script/DeployFinal.s.sol:74` (deploy staking),
- `contracts/script/DeployFinal.s.sol:171` (transferOwnership to multisig),
- `contracts/script/DeployFinal.s.sol:211` (`Fund staking with TOWELI` listed
  as manual NEXT STEP).

**Issue.** On mainnet, `DeployFinal` finishes the broadcast with:
1. `TegridyStaking` deployed and addresses logged → public.
2. Ownership transfer **initiated** to multisig (Ownable2Step pending).
3. Staking has **zero** TOWELI rewards funded.

Step 6 of the `_logSummary` block (`DeployFinal.s.sol:211`) tells the
operator to fund staking after multisig acceptance — i.e. the staking
contract sits live and indexable for **at least one human-cycle** with a
known reward-per-second of `0.8243 TOWELI/s` and a 0 reward pool.

A first staker arriving in this window:
- Stakes a dust amount.
- When the operator finally calls `notifyRewardAmount(STAKING_FUND_AMOUNT)`,
  `_accumulateRewards` flushes `rewardPerTokenStored` against a tiny
  `totalStaked`, so the dust staker captures a disproportionately large
  slice of the freshly-funded pool relative to their actual stake share at
  the moment of funding.

This is exactly the funder-vs-back-runner pattern that
`TegridyStaking.sol:1816-1865` (NEW-S5 / DEEP-DS-05) attempts to mitigate at
the contract level via the `rewardNotifiers` allowlist. The deploy script
defeats the mitigation by pushing funding outside the broadcast.

**Fix.** Inside `_wireAndTransfer`, before `transferOwnership`:

```solidity
IERC20(TOWELI).approve(d.staking, FUND_AMOUNT);
TegridyStaking(d.staking).notifyRewardAmount(FUND_AMOUNT);
```

The deployer holds enough TOWELI from the treasury distribution per
TOKENOMICS.md — same pattern Sepolia uses (`DeploySepolia.s.sol:198-201`).

---

## F-97-5 — `setupComplete` is locked **before** ownership transfer, then ownership goes to a multisig with no plan to unbrick

**Severity:** MEDIUM — operational liveness, not theft.

**Files:**
- `contracts/script/DeployFinal.s.sol:130-131`
- `contracts/script/DeployAuditFixes.s.sol:128-132`
- `contracts/script/DeployRemaining.s.sol:54-55`
- `contracts/script/DeployV2.s.sol:163-165`
- `contracts/script/DeploySepolia.s.sol:146-147`
- `contracts/script/WireV2.s.sol:56-57`

**Issue.** Every deploy script approves SwapFeeRouter on ReferralSplitter,
then calls `splitter.completeSetup()` (locks instant `setApprovedCaller`),
then transfers ownership to the multisig. Per `ReferralSplitter.sol:524`
the post-`setupComplete` path requires the timelocked
`proposeApprovedCallerChange` flow.

If `DeploySwapFeeRouterV2.s.sol:29` is later run to redeploy SwapFeeRouter
(see e.g. its NEXT STEPS step 2: "Approve new SwapFeeRouter on
ReferralSplitter"), the multisig must navigate a 24h timelock proposal
flow on **every** SwapFeeRouter rotation, with no instant-approve safety
valve. The deploy script does not document this requirement at the
SwapFeeRouterV2 deploy site.

This isn't a theft surface but it is a known foot-gun: at least one
fix branch (`DeploySwapFeeRouterV2.s.sol:73`) tells the operator
"Approve new SwapFeeRouter on ReferralSplitter" without acknowledging
that this is now a 24h gated operation.

**Fix.** Add a banner in `DeploySwapFeeRouterV2.s.sol` reminding the operator
to use `proposeApprovedCallerChange` and warn that
`setApprovedCaller` will revert after `setupComplete`.

---

## F-97-6 — Four scripts have **no chain-ID guard** at all

**Severity:** MEDIUM — wrong-network deploys.

**Files / lines:**
- `contracts/script/DeployTWAP.s.sol` — only `console.log("Chain ID:")`
  (line 15). No `require(block.chainid == ...)`.
- `contracts/script/DeployToweli.s.sol` — no chain guard.
- `contracts/script/DeployTokenURIReader.s.sol` — no chain guard.
- `contracts/script/DeployTegridyFeeHook.s.sol` — no chain guard, despite
  hardcoded chain assumptions in the upstream README example
  (`DeployTegridyFeeHook.s.sol:33-44`).

**Issue.** `DeployTWAP.s.sol:27` reads `FACTORY = vm.envAddress("FACTORY")`
and binds `TegridyTWAP` to it. Pass a **Sepolia** factory address while
connected to a **mainnet** RPC and the deployment silently succeeds, then
every `update()`/`consult()` call fails the `isPair` vouch (`R014`) because
the factory at the bound address is the wrong-chain factory (or non-
existent on mainnet). The hostile twin: pass mainnet factory while pointed
at a fork — same problem.

`DeployTokenURIReader.s.sol:8` hardcodes the **mainnet** staking address
`0x6266…4819` but has no `require(block.chainid == 1)` — the resulting
deploy on any other chain would attach to a non-existent staking contract
and every `tokenURI()` static-call would revert.

**Fix.** Drop a `require(block.chainid == 1, "MAINNET_ONLY")` at the top of
each of these four scripts (matching the pattern `DeployFinal.s.sol:49`,
`DeployV2.s.sol:47`, etc.).

---

## F-97-7 — `SEQUENCER_FEED` defaults to `address(0)` everywhere — silent disable on every L2

**Severity:** MEDIUM (only material when deploying to Arbitrum / OP / Base).

**Files (`vm.envOr("SEQUENCER_FEED", address(0))` calls):**
- `contracts/script/DeployFinal.s.sol:137, 157`
- `contracts/script/DeployAuditFixes.s.sol:98, 123`
- `contracts/script/DeployRemaining.s.sol:49`
- `contracts/script/DeploySepolia.s.sol:153, 173`
- `contracts/script/DeployV2.s.sol:144`
- `contracts/script/DeployLaunchpadV2.s.sol:38`
- `contracts/script/DeployTWAP.s.sol:29`

**Issue.** Per `lib/SequencerCheck.sol`, a feed of `address(0)` is treated
as a **no-op** — the protective sequencer-up check is skipped entirely.
This is intentional on mainnet/Sepolia (no L2 sequencer), but **on any
real L2 deploy** an operator who forgets to export `SEQUENCER_FEED` will
ship POLAccumulator / TWAP / MemeBountyBoard / LaunchpadV2 with the
sequencer guard silently disabled. None of the deploy scripts cross-check
`block.chainid` against the SEQUENCER_FEED.

E.g. on Arbitrum (chain 42161), the canonical feed
`0xFdB631F5EE196F0ed6FAa767959853A9F217697D` is required; deploy with
`SEQUENCER_FEED` unset and POLAccumulator's
`SequencerCheck.checkSequencerUp` (POLAccumulator.sol:406, :663) becomes a
no-op, exposing the contract to stale-price attacks during sequencer
downtime.

**Fix.** Codify a chain-id → required-feed map in the deploy scripts:

```solidity
if (block.chainid == 42161) {
    require(SEQUENCER_FEED != address(0), "SEQUENCER_FEED required on Arbitrum");
}
```

`SequencerCheck.sol`'s comment block in `DeployTWAP.s.sol:21-23` lists the
feeds — but the check is purely advisory.

---

## F-97-8 — `DeployFinal.s.sol` proposes `feeToSetter` change but never proposes it back if the script reverts mid-way

**Severity:** LOW — recoverability.

**File:** `contracts/script/DeployFinal.s.sol:165-186` (`_wireAndTransfer`).

**Issue.** `_wireAndTransfer` is **not** atomic with respect to its constituent
calls: `proposeFeeToChange` (line 167), then 9 × `transferOwnership` (lines
171-180), then `proposeFeeToSetter` (line 184). If any of those calls
reverts (e.g. an Ownable2Step pre-existing pending owner on the wrong
contract, or a chained custom error from a contract that disagrees with
the deployer), every preceding `transferOwnership` has already broadcast.
The deployer is now in a state where SOME contracts have pending
`acceptOwnership` calls aimed at the multisig and others don't.

The script has no `try/catch` recovery and no idempotency: re-running it
will hit `OwnableInvalidOwner` because deployer no longer owns those
contracts (the pending transfer is one-way once initiated; only the
candidate owner can refuse via not calling `acceptOwnership`, leaving the
contract effectively un-handed-over).

**Fix.** Order the calls so non-reverting wiring (proposes) executes first,
then the reverting-prone batch (transfers) at the end, OR factor each
`transferOwnership` into an idempotent helper that no-ops if
`pendingOwner() == multisig`.

---

## F-97-9 — Verifier scripts (`Verify.s.sol`) read **stale** addresses for V1 vs V2

**Severity:** LOW — operational confusion / verifier false-positive.

**File:** `contracts/script/Verify.s.sol:62-72`.

**Issue.** All addresses in `Verify.s.sol` are V2 mainnet addresses
hardcoded as `address constant`. Per `project_relaunch.md` the user is
relaunching from a new wallet, so these addresses will be wrong from
day-1 of the relaunch. The script does not read addresses from env or
broadcast logs, so a fresh deploy must edit the source.

`Verify.s.sol` already prints `chain.id:` (line 79) but does **not**
require it equals 1 — meaning it will happily verify against the mainnet
addresses while connected to a Sepolia RPC, where every `staticcall`
would either revert or return zero-as-default, producing nonsense.

**Fix.** Read each invariant address from `vm.envAddress("STAKING")`
etc.; require `block.chainid == 1`; or accept a JSON deployment manifest
(`forge-deploy-utils` style).

---

## F-97-10 — `DeployTegridyFeeHook.s.sol` has no idempotency on CREATE2 collision

**Severity:** LOW — but it's the one script where a re-run is likely.

**File:** `contracts/script/DeployTegridyFeeHook.s.sol:77-84`.

**Issue.** The hook is deployed via CREATE2 with a precomputed salt. If a
previous run partially succeeded (deploy ok, post-checks failed for some
reason) the broadcast actually committed the deployment but the operator
re-runs the script, `new TegridyFeeHook{salt: salt}` reverts at the
EVM level (CREATE2 collision is `address already exists` from
`CREATE2_FAILED`). The script has no `address.code.length` pre-check, so
the operator can't tell the difference between "first run, failed" and
"second run after first succeeded but I lost the address" — the latter is
recoverable with `cast create2 --address` math.

**Fix.** Compute the predicted address from `(deployer, salt, initCodeHash)`
and check `code.length` before broadcasting.

---

## F-97-11 — `WireV2.s.sol` does not verify post-state after any of its 14 transactions

**Severity:** LOW — silent failure on partial broadcast.

**File:** `contracts/script/WireV2.s.sol:53-83`.

**Issue.** The wiring script runs a sequence of 14 calls and emits
`console.log` after each, but never reads back state. If
`IReferralSplitter(REFERRAL).completeSetup()` reverts because someone
already called it, the script reverts at line 57 but lines 56 and prior
have already broadcast. The remaining 12 calls **never run**, but the
script does not `try/catch` to make progress on the rest, and the
operator must read the broadcast log to figure out which transactions
are still owed.

`Verify.s.sol` was authored partly to plug this gap, but it covers only 6
high-level invariants — not "did `transferOwnership` actually emit
`OwnershipTransferStarted` for each of the 9 contracts".

**Fix.** Replace the bare calls with `try/catch` blocks that log status and
continue, OR drop in `Verify.s.sol`-style `_expectEq` assertions after
each call to fail loudly.

---

## F-97-12 — `MockTOWELI.mint(address,uint256)` is permissionless — anyone can dilute Sepolia stake

**Severity:** LOW (Sepolia only).

**File:** `contracts/script/mocks/MockTokens.sol:13-15`.

**Issue.** `MockTOWELI` exposes a fully permissionless `mint(to, amount)` —
no `onlyOwner`, no caller check. After `DeploySepolia.s.sol` finishes,
the mock TOWELI address is logged. Anyone can mint themselves
`type(uint256).max` TOWELI and instantly dominate every voting-power
check on the Sepolia testnet stack (governance, snapshot, etc.). For
testnet this might be intentional — to let testers fund themselves —
but it means *no testnet result reflects mainnet behaviour for any
governance/voting flow*.

**Fix.** Either gate `mint(...)` on the deployer-only path
(`require(msg.sender == owner)`) and add a separate
`faucet(uint256)` that drips a fixed amount per caller, OR document
explicitly that Sepolia governance results are non-comparable to mainnet.

---

## F-97-13 — `DeployFactory` is **not** present — wiring scripts assume a pre-existing factory

**Severity:** INFO / dead-end for the relaunch.

**Files:**
- `contracts/script/DeployV2.s.sol:36` — `address constant TEGRIDY_FACTORY = 0x8B78…dCB6`
- `contracts/script/DeployTegridyRouter.s.sol:11` — same hardcoded factory
- `contracts/script/DeployVoteIncentives.s.sol:21` — same
- `contracts/script/ConfigureFeePolicy.s.sol:35-44` — same

**Issue.** None of the deploy scripts ever **deploys** `TegridyFactory`. It
is referenced as a hardcoded mainnet constant in 4 scripts. For the
relaunch (per memory file `project_relaunch.md`), the new wallet has no
TegridyFactory yet — those 4 scripts will all attach to the *old*
factory at `0x8B78…`, which is owned by the *old* deployer key. Wiring
them to a new staking + new VoteIncentives produces a Frankenstein
deployment where the factory's `feeToSetter` and `guardian` are still
the relinquished old keys.

`DeployFinal.s.sol` is the only path that deploys a **fresh** factory
(`DeployFinal.s.sol:79`). For the relaunch this should be the only entry
point — but `DeployVoteIncentives`, `DeployTegridyRouter`,
`DeployV2`, `ConfigureFeePolicy` will still import the dead factory
constant.

**Fix.** Replace `TEGRIDY_FACTORY` constants with
`vm.envAddress("TEGRIDY_FACTORY")` and have a chain-of-trust check that
asserts the deployer owns / can call `setGuardian` on it.

---

## F-97-14 — `DeployFinal._wireAndTransfer` proposes `factory.feeToChange` but never executes — handover to multisig leaves a 48h-pending `feeTo`

**Severity:** LOW — operational only.

**File:** `contracts/script/DeployFinal.s.sol:167-186`.

**Issue.** Line 167 proposes `feeTo -> RevenueDistributor` (48h timelock).
Line 184 proposes `feeToSetter -> multisig`. Both are queued but never
executed; the script then transfers ownership of the surrounding
contracts to the multisig and exits.

The multisig now has TWO independent timelocks running in parallel on the
factory:
- `executeFeeToChange()` after 48h (any caller can execute, since this is
  not a multisig-gated path post-propose).
- `acceptFeeToSetter()` after 48h, gated by the new `feeToSetter`.

If the multisig accepts `feeToSetter` ownership BEFORE 48h elapses on the
`feeTo` proposal, OR if anyone calls `executeFeeToChange()` before the
multisig accepts feeToSetter, the order in which these settle matters.
There's no script that runs them in the correct order.

**Fix.** Add `ExecuteFinal.s.sol` that the multisig runs at T+48h to
execute both proposals, OR collapse them into a single `proposeFeeToSet`
behind the same timelock key.

---

## F-97-15 — `DeploySepolia.s.sol` mints **5 JBACs to deployer** but **no JBAC for the eventual stakers**

**Severity:** INFO / testnet-flow gap.

**File:** `contracts/script/DeploySepolia.s.sol:80`.

**Issue.** `jbac.mintBatch(deployer, 5)` is the only JBAC mint call. Any
testnet user who tries to test the boost path on TegridyStaking has no
way to acquire a JBAC — `MockJBAC` exposes `mint(address)` and
`mintBatch(...)` permissionlessly so a savvy tester can self-mint, but
the script doesn't wire a faucet UI or document the contract address as
a faucet. End-to-end boost-path testing requires the deployer to drop
JBACs to testers manually.

**Fix.** Document the JBAC mock's permissionless mint in the
`_logSummary` block, or wire it through a public faucet route.

---

## Notes / dead-ends explored

- **Atomicity of `_deployCore` / `_deployRevenue` / `_deployCommunity`** —
  these do run inside a single `vm.startBroadcast / vm.stopBroadcast`
  pair, so revert mid-flight rolls back the broadcast at the script
  level. (Verified: no `vm.stopBroadcast` between sub-functions in
  DeployFinal/DeploySepolia/DeployV2.) Mid-broadcast revert is the
  **same** as not running anything, so atomicity-within-broadcast is
  fine. The actual atomicity gap is the human gap *between* deploy and
  the explicit "manual NEXT STEPS" lines.

- **CREATE2 frontrun on Hook deploy.** Considered, but the deployer key is
  the only address with a known TOWELI balance for the gas + broadcast,
  and the salt is bound to the deployer in the `cast create2 --deployer`
  invocation. So the standard CREATE2 frontrun is mitigated unless the
  hot wallet is compromised, in which case you have bigger problems.

- **`SwapFeeRouterAdmin` / `VoteIncentivesAdmin` re-init race.** Both
  `setSwapFeeRouterAdmin` (`SwapFeeRouter.sol:1061`) and
  `setVoteIncentivesAdmin` (`VoteIncentives.sol:145`) are `onlyOwner` AND
  one-shot. While the deploy script is broadcasting, msg.sender is the
  deployer EOA. As long as the deployer is honest, no one else can
  initialize the admin sister contract. ✗ Not a frontrun vector.

- **Hardcoded WETH on L2.** `CheckCanonicalWETH.s.sol:32-36` does have the
  L2 WETH addresses, but `DeployFinal.s.sol:23` and `DeployV2.s.sol:32`
  hardcode the **mainnet** WETH `0xC02a…6Cc2` as a `constant`. Combined
  with the chain-ID guard `require(block.chainid == 1)` this is fine for
  mainnet — but the relaunch *cannot* re-use these scripts on any L2
  without source-edits. (Already covered by the `MAINNET_ONLY` guards.)

- **Sequence-race on `setApprovedCaller` post-deploy.** ReferralSplitter
  doesn't allow anonymous parties to setApprovedCaller (`onlyOwner`,
  `ReferralSplitter.sol:524`), so even with the contract live and
  ownership pending-multisig, no third party can intercept the wiring.
  ✗ Not a frontrun vector.

- **`DeployVoteIncentives.s.sol` BRIBE_FEE_BPS = 300 (3%).** Consistent
  with `DeployV2.s.sol:42`. No mismatch.

- **DEEP-DR-M-07 / `setupComplete` gate.** Verified that
  `proposeApprovedCallerChange` requires `setupComplete` (line 437), so
  the post-`completeSetup` rotation path is at least functional once
  ownership is in the multisig.

---

## Summary

15 distinct findings, surfaced from re-reading every script in
`contracts/script/`:

- **HIGH (2):** F-97-1 (staking ↔ restaking link not wired anywhere),
  F-97-3 (MULTISIG == TREASURY EOA collapse).
- **MEDIUM (5):** F-97-2 (Verify coverage gap), F-97-4 (unfunded staking
  publish race on mainnet), F-97-5 (`completeSetup` foot-gun on
  SwapFeeRouter rotation), F-97-6 (no chain-ID guard on TWAP / Toweli /
  TokenURIReader / FeeHook), F-97-7 (sequencer-feed silent disable on L2).
- **LOW (5):** F-97-8 (non-atomic wiring/transfer in DeployFinal),
  F-97-9 (Verify hardcoded V2 addresses, no chain check),
  F-97-10 (no CREATE2 collision pre-check),
  F-97-11 (WireV2 has no post-state asserts),
  F-97-12 (MockTOWELI permissionless mint on Sepolia).
- **INFO (3):** F-97-13 (no DeployFactory script for relaunch),
  F-97-14 (DeployFinal leaves two parallel 48h proposals on factory),
  F-97-15 (no JBAC faucet for testnet stakers).

The single most actionable finding is **F-97-1**: every deploy script
explicitly skips wiring `staking.restakingContract`, and the verifier
script was authored to expect this gap. For the new-wallet relaunch
the fix is to inline the `TegridyStakingAdmin` deploy + propose +
execute (after timelock) into the deploy broadcast itself.
