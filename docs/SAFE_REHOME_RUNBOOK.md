# Safe Re-Home Runbook

> HIGH-STAKES CUSTODY OPERATION. Read the whole document once before touching a wallet. Every re-home tx is broadcast from the deployer EOA; a mistake can strand ownership or hand control to the wrong Safe. When a step is marked **⚠ VERIFY ON-CHAIN**, do not proceed on the strength of this doc alone — read the live contract state first.

## 1. What this does + why

This runbook rebuilds three clean, disjoint Gnosis Safes and moves every privileged role of the Tegridy Farms protocol off the two liabilities it currently sits on: the **hot deployer EOA** `0x14898258122C0740106391E6e8E4F17F3b6d456E` (0x1489…456E), which owns nearly every contract, and the **flagged Safe** `0xA36053477568Fb5382492F3A5970D35Fe896b7F8` (0xA360…b7F8), whose signer set has a cross-role minority quorum and EIP-7702 delegation overlap. It then unblocks the launcher integrator address (points it at the rebuilt treasury Safe) so the gated launcher can go live once the other go-live gates clear.

Net end state: owner / feeToSetter / pauseGuardian / sister-admin ownership all held by the rebuilt **Admin** and **Guardian** Safes; fee revenue + launcher fees flowing to the rebuilt **Treasury** Safe; deployer EOA and 0xA360 hold no live authority.

---

## 2. Preconditions / safety

**Do these before any broadcast. All of them.**

- **Fresh RPC.** Use a fresh, trusted mainnet RPC endpoint. Verify liveness with `eth_blockNumber` (NOT `eth_chainId` — cloudflare-eth answers chainId while dead). Do not use a cached/stale provider.
- **On-chain state must match this doc.** For every contract in the Step B table, read `owner()`, `pendingOwner()`, and `ownershipTransferExpiresAt()` live before acting. The inventory here is grounded in `contracts/broadcast/*/1/run-latest.json` deploy *intent* plus a `--resume` artifact (DeployMVP shows 16 receipts for 40 planned txs), **not** a live chain read. If live state disagrees with this table, STOP and reconcile. Mark any mismatch **⚠ VERIFY ON-CHAIN**.
- **Fork-rehearse first.** Fork mainnet at head, impersonate the deployer, and dry-run the entire Step B sequence (transfer + accept) against the rebuilt Safe addresses. Confirm each `acceptOwnership()` succeeds and each `owner()` flips. Only broadcast to mainnet after a clean fork pass.
- **NEVER renounce.** `renounceOwnership()` is permanently disabled in `OwnableNoRenounce` (by design). Do not attempt any renounce/zero-address transfer — `transferOwnership(address(0))` reverts `PendingOwnerZeroAddress` (`contracts/src/base/OwnableNoRenounce.sol:170`). There is no "burn ownership" step anywhere in this runbook.
- **Key-management rules (non-negotiable):**
  - Every Safe signer must be an **independent hardware-wallet key**.
  - **No two signers on the same hardware model** (`docs/MULTISIG_MIGRATION.md:49`).
  - **No EIP-7702 delegation overlap.** Before adding any signer, `eth_getCode` the address: a cold independent key has **empty code** (`code.length == 0`); a 7702-delegated EOA has code beginning with the delegation designator `0xef0100 || <delegate address>`. If two candidate signers delegate to the same target, they are NOT independent — reject one. Re-check code-length **immediately before** the transferOwnership broadcast (a 7702 delegation can be added after Safe creation).
  - Signer sets across the three Safes must be **disjoint** (see Step A). Publicly attribute the final signer identities within 24h (`docs/MULTISIG_MIGRATION.md:47-59`) — hidden signers = no multisig for trust purposes.

---

## 3. Step A — Rebuild the Safe signer sets

Build **three distinct Safes, one per role**, so no single Safe both holds funds and controls admin params. Use canonical Safe contracts (official Safe deployment). Target **15 distinct keys total (5+5+5)**.

| Safe | Threshold | Role / authority | Notes |
|---|---|---|---|
| **TREASURY** | **3-of-5** | Holds fee revenue / POL; is the `LAUNCHER_INTEGRATOR_ADDRESS` fee sink | Do NOT ship the current 2-of-2 fee Safe (no key-loss redundancy). `docs/MULTISIG_MIGRATION.md:39-45` |
| **ADMIN / GOVERNANCE** | **3-of-5** | `owner()` re-homed onto all core + gated contracts + sister-admins + NFTPoolFactory | Must be a **contract** Safe — gated-deploy scripts enforce `require(multisig.code.length > 0)`. `docs/GATED_DEPLOY_RUNBOOK.md:32,46` |
| **GUARDIAN** | **2-of-3** | `pause()`-only fast path (PauseGuardian). No fund movement, no timelock | 2-of-3 acceptable ONLY here — worst case is a recoverable wrongful pause. `docs/GOVERNANCE.md:82-92` |

**Disjointness constraint (the core red-team fix):** the union of any TWO Safes' signer sets must NOT reconstitute a threshold on the third. No pair of signers that clears threshold on one Safe may appear together on another. Clean target = 15 disjoint keys. If reuse is unavoidable, cap overlap so any set large enough to execute on Safe X is strictly below threshold on Safes Y and Z.

**Retire stale addresses.** `0xE9B7…f53e` appears BOTH as a current Safe signer AND as a hardcoded treasury/fee-recipient address baked into clones/docs. "Replace the signer" and "replace the fee recipient" are two SEPARATE actions — do not blind-replace; review each occurrence.

**Verify independence (per §2 key rules)** for all 13–15 signers before creating the Safes: empty-code check, no shared 7702 delegate, distinct hardware models.

---

## 4. Step B — Re-home ownership (per-contract ordered checklist)

### 4.0 Mechanism (read once)

All standard contracts use `OwnableNoRenounce` = OZ **Ownable2Step** + a **14-day expiry** on the pending slot (`contracts/src/base/OwnableNoRenounce.sol`). Per-contract recipe:

```
# 1. from deployer EOA:
<contract>.transferOwnership(ADMIN_SAFE)     # stamps ownershipTransferExpiresAt = now + 14d
# 2. from ADMIN_SAFE, WITHIN 14 DAYS:
<contract>.acceptOwnership()                 # reverts OwnershipTransferExpired() if late
```

Key facts from `OwnableNoRenounce.sol`:
- `OWNERSHIP_TRANSFER_EXPIRY = 14 days` (line 50); expiry stamped on transfer (lines 155-173); accept checks expiry FIRST then finalizes (lines 182-192); finalize zeros the expiry slot (line 139).
- **Re-arming is just calling `transferOwnership` again.** OZ `super.transferOwnership` deletes the old `_pendingOwner` then re-sets it, and the override re-stamps a fresh 14d window. No separate re-arm function.
- After expiry there is **NO auto-clear** of `pendingOwner()` — it still reads the stale 0xA360 address (a readability footgun, not a stranding one). Re-calling `transferOwnership(ADMIN_SAFE)` overwrites it.
- To clear a stale pending slot without rotating owner, use `cancelOwnershipTransfer(reason)` (owner-only; reverts `NoPendingOwnershipTransfer` if none). `transferOwnership(address(0))` is rejected.

### 4.1 ⚠ TIME-SENSITIVE — the still-open 0xA360 windows

Two waves proposed 0xA360:
- **Wave 1 (DeployMVP, 2026-06-06)** and **LPFarming (2026-06-08)** — 14d windows **EXPIRED** (~2026-06-20/21). 0xA360 can no longer accept; deployer remains owner.
- **Wave 2 (gated batch, deployed 2026-07-16)** — Gauge, NFTLending(+Admin), VoteIncentives(+Admin), CommunityGrants, LaunchpadV2, MemeBountyBoard, PremiumAccess. **Their 14-day windows do NOT expire until ~2026-07-30 — as of today (2026-07-18) they are STILL OPEN (~12 days left) and 0xA360 could call `acceptOwnership()` on any of them right now.**

**Action:** For every Wave-2 contract, do NOT wait for expiry. Either (a) `deployer.transferOwnership(ADMIN_SAFE)` — this overwrites the 0xA360 pending slot and re-stamps a fresh 14d window — or (b) `deployer.cancelOwnershipTransfer(reason)`, **BEFORE ~2026-07-30**. Prefer (a) since you are re-homing anyway. **⚠ VERIFY ON-CHAIN** each Wave-2 `pendingOwner()`/`ownershipTransferExpiresAt()` before acting.

### 4.2 Ownership transfer checklist (ordered)

Execute in this order. For each: `transferOwnership(ADMIN_SAFE)` from deployer → `acceptOwnership()` from ADMIN_SAFE within 14 days → verify (Step C) before moving on.

**Core MVP (Wave-1, windows expired — deployer still owns; re-arm fresh):**

- [ ] **TegridyStaking** `0xcaDc93E96De58EA554c71ca609974625615E046D` — OwnableNoRenounce. ctor `OwnableNoRenounce(msg.sender)` `TegridyStaking.sol:511`. Also carries a pauseGuardian + stake caps (see 4.3).
- [ ] **TegridyStakingAdmin** `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` — OwnableNoRenounce (2-step). EIP-170 sister of Staking; re-home in lock-step.
- [ ] **TegridyTWAP** `0xdFdd6D72539A425dC917F49FB834901105cA98c9` — OwnableNoRenounce. Oracle for native pool / lending.
- [ ] **RevenueDistributor** `0xF993316E2fC079de4358c489A935E01e03E23E17` — OwnableNoRenounce `RevenueDistributor.sol:71`. NOTE: ctor arg `votingEscrow`(=Staking) is a wiring param, NOT the owner — owner = deployer. Carries a pauseGuardian (4.3).
- [ ] **SwapFeeRouter** `0x6d5791A660e79175F74C6D639584C98422d5956E` — OwnableNoRenounce `SwapFeeRouter.sol:53`. Carries a SwapFeeRouterAdmin + pauseGuardian (4.3, 4.4).
- [ ] **POLAccumulator** `0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2` — OwnableNoRenounce `POLAccumulator.sol:253`. Protocol-owned-liquidity accumulator. Carries a pauseGuardian (4.3).
- [ ] **ReferralSplitter** `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` — OwnableNoRenounce. `constants.ts:51` tracks it live. Setup (`setApprovedCaller`/`completeSetup`) already done pre-transfer.

**TegridyFactory — DIFFERENT MODEL (no 14d expiry):**

- [ ] **TegridyFactory** `0xa24C7287eC56A7DEFDc70033803451240e267a52` — owner-equivalent is **feeToSetter** (custom `TimelockAdmin` propose/accept, NOT Ownable2Step). Re-home it to the **ADMIN_SAFE** (it governs pair fee config — an admin role, not the treasury fund sink). **⚠ VERIFY ON-CHAIN FIRST** — read live `feeToSetter()`, `pendingFeeToSetter()`, `feeToSetterChangeTime()`, then:
  1. **If `feeToSetterChangeTime != 0`** a proposal is still live (likely the stale `0xA360` one from deploy) — you MUST call **`cancelFeeToSetterProposal()` FIRST**, because `proposeFeeToSetter` reverts `CANCEL_EXISTING_FIRST` while any proposal exists (`TegridyFactory.sol:358`). Skipping this makes the re-point revert.
  2. `proposeFeeToSetter(ADMIN_SAFE)` from the deployer.
  3. After the `FEE_TO_SETTER_DELAY` timelock elapses, ADMIN_SAFE calls `acceptFeeToSetter()` — **within the 7-day `MAX_SETTER_PROPOSAL_VALIDITY` window** (`:368`) or it reverts `PROPOSAL_EXPIRED` and must be re-proposed.
  - **NOT a live seizure threat:** any `0xA360` proposal from the 2026-06-06 deploy is ALREADY EXPIRED — `acceptFeeToSetter` enforces a 7-day validity (`:368`, `MAX_SETTER_PROPOSAL_VALIDITY=7 days` `:143`), so a June-06 proposal lapsed ~2026-06-14. 0xA360 can no longer accept it; the only action is the re-point above (this corrects an earlier draft that wrongly said it "may STILL be acceptable by 0xA360").
  4. **THEN, and only then, the guardian.** Live read 2026-08-19: `guardian()` is still the **deployer EOA `0x14898258…456E`** (zero code), so audit M6 is not satisfied on this factory and the EOA still holds `emergencyDisablePair` — instant, no timelock. Fixing that is a *fourth* step, after step 3, because `acceptFeeToSetter` force-cancels any pending `GUARDIAN_CHANGE` queued by the outgoing setter (`TegridyFactory.sol:396-401`, audit F-30-10). Queue it before step 3 and step 3 eats it; `executeGuardianChange()` then reverts `NoPendingProposal`. So: ADMIN_SAFE calls `proposeGuardianChange(<pauseGuardian Safe>)` **after** it holds the setter role, waits the 48h `GUARDIAN_CHANGE_DELAY`, then calls `executeGuardianChange()`. The target's code length must be neither 0 nor 23 (plain EOAs and 7702-delegated EOAs are rejected).
  - **The deploy-time `pendingGuardian` is dead, and it is in the way.** `pendingGuardian()` reads `0xCDCA0F06…F354` from the 2026-06-07 deploy; it became executable 2026-06-09 and expired 2026-06-16 (`MAX_PROPOSAL_VALIDITY` 7 days). An expired proposal still occupies its slot — `TimelockAdmin._propose` rejects on `_executeAfter[key] != 0` without consulting expiry — so `cancelGuardianChange()` from the deployer is required before any new guardian proposal, exactly as `cancelFeeToSetterProposal()` is in step 1.
  - Also governs the TOWELI/WETH pair fee config; it separately proposed `feeTo=RevenueDistributor` — live `feeTo()` still reads the treasury Safe `0x7D26…Bd7d`, so that change never executed either; confirm/re-propose via the same flow.

**Gated batch (Wave-2, windows OPEN until ~2026-07-30 — act before expiry, see 4.1):**

> Addresses below are from each feature's `contracts/broadcast/Deploy*.s.sol/1/run-latest.json` CREATE record (the source of truth — `constants.ts` still zeroes these while frontend-gated). **⚠ VERIFY ON-CHAIN** each contract's `owner()`/`pendingOwner()`/`ownershipTransferExpiresAt()` before acting.

- [ ] **GaugeController** `0x6c79522d47cf6d1051cb474e81d9b6f3996c1054` — OwnableNoRenounce `GaugeController.sol:52`.
- [ ] **NFTLending** `0x89BeB6cc0255B7465c01aA38a6f937efd345f14F` — OwnableNoRenounce `TegridyNFTLending.sol:560`. Has an **NFTLendingAdmin** sister (4.4) + pauseGuardian. Fund-touching (P2P NFT lending) — do NOT un-gate until re-homed.
- [ ] **NFTLendingAdmin** `0x693787831e9C36A98aFEDAd39f8728491F580a9C` — OwnableNoRenounce sister-admin; re-home in lock-step with NFTLending.
- [ ] **VoteIncentives** `0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF` — OwnableNoRenounce. Has a **VoteIncentivesAdmin** sister (4.4).
- [ ] **VoteIncentivesAdmin** `0xf87Ec231BA7FA3975619309bc16C698B2ea3B300` — OwnableNoRenounce sister-admin; lock-step with VoteIncentives.
- [ ] **CommunityGrants** `0xebc3aaf48297b8ccfa8272d9e68c1545eb9cd471` — OwnableNoRenounce.
- [ ] **LaunchpadV2** `0xa6149b4d05138a4073902a0ca0345c2d0e470df7` — OwnableNoRenounce `TegridyLaunchpadV2.sol:188` (ctor takes explicit `_owner`). Historically had a deployer/owner `--sender` mismatch on deploy — double-check `owner()` reads the deployer, not something else, before re-homing.
- [ ] **MemeBountyBoard** `0x6d2c6ec29d97fe8b6d1471091deee36baf69d890` — OwnableNoRenounce `MemeBountyBoard.sol:260`.
- [ ] **PremiumAccess** `0x9dc2675b2017687dd9768c63d15f0ad5194fa3f5` — OwnableNoRenounce.
- [ ] **TegridyLPFarming** `0x1171268AE5B69791c47Fd589b7825932c957e149` — OwnableNoRenounce. Deployed 2026-06-08; **window EXPIRED** (~2026-06-22), so treat like Wave-1 (deployer still owns, re-arm fresh). `constants.ts:39` tracks it live.

**Already elsewhere / special handling:**

- [ ] **TegridyNFTPoolFactory** `0xbb8e49ba4e3a85e2b8b70e00208770f429b56f5b` — **constructor-owned directly by the flagged Safe 0xA360** (highest friction). Re-home REQUIRES **0xA360 itself** to execute `transferOwnership(ADMIN_SAFE)`, then ADMIN_SAFE `acceptOwnership()` within 14d. This is the ONE contract the deployer cannot re-home. Sequence 0xA360's signers to do this while 0xA360 is still trusted enough to sign, and verify the flip immediately.

**No re-homing needed (non-ownable / not a protocol target):** Router, JbacVault, TokenURIReader, MonitorView, the 4 CREATE2 libs (no owner). Clone templates (DropV2, NFTPool reference impls) — individual clones are owned by their creators, not a protocol re-home target.

> **⚠ VERIFY ON-CHAIN** — This list also references sister-admins for **TegridyV4Hook** and **TegridyFeeExecutorRouter / POLAccumulator / TegridyRestaking** environments (V4HookAdmin, plus these contracts' owners + guardians). If any are live on your target surface, re-home their `owner()` (OwnableNoRenounce, same recipe) and confirm they were not omitted from this table. Read each live contract's `owner()` before assuming it is out of scope.

### 4.3 pauseGuardian → GUARDIAN Safe (instant, owner-set, no 2-step)

`pauseGuardian` is a pause-only role (`contracts/src/base/PauseGuardian.sol`), set instantly by the owner via `setPauseGuardian(GUARDIAN_SAFE)` — **no accept step**. Because it is owner-set, you can do this EITHER as deployer before re-homing, OR from ADMIN_SAFE after. Set on each contract that has it:

- [ ] **SwapFeeRouter** (`SwapFeeRouter.sol:1457`)
- [ ] **RevenueDistributor** (`:754`)
- [ ] **TegridyStaking** (`:867`)
- [ ] **TegridyFeeExecutorRouter** (`:555`) — ⚠ VERIFY ON-CHAIN if live
- [ ] **POLAccumulator** (`:528`) — ⚠ VERIFY ON-CHAIN if live
- [ ] **TegridyRestaking** (`:2001`) — ⚠ VERIFY ON-CHAIN if live
- [ ] **TegridyV4Hook** (`:306`, set via paramAdmin) — ⚠ VERIFY ON-CHAIN if live

Current pauseGuardian on the core set reads `0xCDCA…F354`; confirm and replace with GUARDIAN_SAFE. TegridyFactory has its own `guardian`/`pendingGuardian` (custom propose/accept, not PauseGuardian) — re-point via its guardian-change flow.

### 4.4 Sister-admin ownership (the applyXxx role holders)

Six Ownable sister-admins hold the privileged `applyXxx` role and are themselves deployer-owned — their OWN ownership must be re-homed to ADMIN_SAFE with the standard 4.0 recipe, in lock-step with their parent:

- [ ] **TegridyStakingAdmin** (with TegridyStaking) — `TegridyStakingAdmin.sol:47`
- [ ] **SwapFeeRouterAdmin** (with SwapFeeRouter) — `SwapFeeRouterAdmin.sol:51` — current admin ref `0xa517…`
- [ ] **NFTLendingAdmin** (with NFTLending)
- [ ] **VoteIncentivesAdmin** (with VoteIncentives)
- [ ] **TegridyV4HookAdmin** — `TegridyV4HookAdmin.sol:40` — ⚠ VERIFY ON-CHAIN if live
- [ ] (any **LendingAdmin** for a base Lending contract, if live) — ⚠ VERIFY ON-CHAIN

---

## 5. Step C — Verify

After each contract's accept (and at the end, sweep all of them):

- [ ] **owner()** returns `ADMIN_SAFE` (not deployer, not 0xA360).
- [ ] **pendingOwner()** returns `address(0)` — a successful accept zeros it. If it still reads 0xA360, the accept did NOT run; the transfer either expired or was never accepted. Re-arm and re-accept.
- [ ] **ownershipTransferExpiresAt()** returns `0` (zeroed on finalize).
- [ ] **TegridyFactory.feeToSetter()** returns the intended Safe; `pendingFeeToSetter()` is `address(0)`.
- [ ] **pauseGuardian()** returns `GUARDIAN_SAFE` on all 4.3 contracts.
- [ ] Each **sister-admin `owner()`** returns `ADMIN_SAFE`.
- [ ] **TegridyNFTPoolFactory.owner()** returns `ADMIN_SAFE` (this one moved from 0xA360, not deployer).
- [ ] Spot-check ADMIN_SAFE can actually execute a benign owner-only call on one contract (proves the Safe is a working owner, not just the recorded address).
- [ ] Re-run the **7702/empty-code check** on every signer once more post-migration.

Read all of the above from a fresh RPC, independent of the one used to broadcast.

---

## 6. Step D — Unblock the launcher

Only after the treasury Safe exists and is verified (Step C):

- [ ] Set **`LAUNCHER_INTEGRATOR_ADDRESS = TREASURY_SAFE`** (the fee sink). This is the launcher's fee recipient — it must be the 3-of-5 treasury Safe, never the deployer or 0xA360.
- [ ] The launcher **stays gated** behind the other go-live gates (TOWELI-liveness gate, TWAP bootstrap / reserve floor, and the frontend un-gating that flips zeroed `constants.ts` addresses live). Setting the integrator address does NOT itself un-gate the launcher.
- [ ] Do NOT un-gate any fund-touching gated feature until its owner is confirmed re-homed onto ADMIN_SAFE (Step C green) — never while it is still deployer- or 0xA360-parked.

---

## 7. Rollback / footguns

- **The expiry trap (primary footgun).** `acceptOwnership()` must land within **14 days** of `transferOwnership`. Miss it and it reverts `OwnershipTransferExpired()` forever — but ownership is NOT stranded: the deployer still owns the contract and simply re-calls `transferOwnership(ADMIN_SAFE)` to re-arm a fresh window. Coordinate so the Safe signers are ready to accept the same day you broadcast the transfer.
- **The still-open 0xA360 window (time bomb).** Wave-2 gated contracts let 0xA360 `acceptOwnership()` until ~2026-07-30. If you do nothing, 0xA360 could seize them. Overwrite (transferOwnership to ADMIN_SAFE) or cancel BEFORE that date. (See 4.1.)
- **pendingOwner never auto-clears.** A stale `pendingOwner()` reading 0xA360 after expiry is cosmetic, not control — 0xA360 cannot accept once expired. Do not panic-react to the read; verify `ownershipTransferExpiresAt()` and timestamp.
- **NEVER renounce / never transfer to `address(0)`.** Renounce is disabled and zero-address is rejected — there is no path to burn ownership, and you should never want one. Anything that looks like "give up ownership" is wrong.
- **What strands ownership:** transferring to a Safe that cannot sign (wrong address, not-yet-deployed Safe, a Safe whose signers you don't control, or a Safe that itself has no working quorum). Mitigate by (a) fork-rehearsing the accept, and (b) Step C's benign owner-only call proving the Safe works — BEFORE relying on it.
- **NFTPoolFactory dependency.** It can only move if 0xA360 signs. If 0xA360's signer set is compromised or unavailable, this contract cannot be re-homed — plan the 0xA360 transfer while its signers are still cooperative, and verify the flip immediately.
- **TegridyFactory is not Ownable2Step.** Do not use `transferOwnership`/`acceptOwnership` on it — that reverts or no-ops. Use `proposeFeeToSetter`/`acceptFeeToSetter` and its guardian-change flow.
- **Rollback stance:** ownership is never irreversibly lost mid-migration because the deployer retains it until a Safe accepts. If a Safe turns out wrong AFTER accept, the new Safe (now owner) must `transferOwnership` to the corrected Safe — so verify the Safe is correct and functional (Step C benign call) before you consider a step "done."
