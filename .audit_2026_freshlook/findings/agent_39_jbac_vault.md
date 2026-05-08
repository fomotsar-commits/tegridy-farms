# Agent 39 — TegridyStakingJbacVault Fresh-Eyes Hunt

**Target:** `contracts/src/TegridyStakingJbacVault.sol` (~132 lines)
**Related:** `contracts/src/TegridyStaking.sol`
**Lens:** JBAC NFT escrow vault for staking bonus path; reentrancy via ERC721 receiver callback; stranded NFT path; orphaned NFT recovery; cross-collection acceptance; approvals; pause / circuit-breaker; vault upgrade.

---

## F-39-1 — `returnJbac` lacks `nonReentrant` while invoking external `safeTransferFrom` (LOW / Best-Practice)

**Severity:** LOW (defense-in-depth — no concrete exploit, but unusual omission)

**Location:** `TegridyStakingJbacVault.sol:87-99` — `returnJbac(stakingTokenId, jbacTokenId, to)`

**Observation:**
`returnJbac` is gated `onlyStaking` but performs an external call (`jbacNFT.safeTransferFrom(this, to, jbacTokenId)`) that triggers `to.onERC721Received` if `to` is a contract. The function has no `nonReentrant` modifier of its own. The sister function `claimStrandedJbac` IS `nonReentrant`. The asymmetry is jarring and merits documentation.

**Reentrancy analysis:**
1. `withdraw`/`earlyWithdraw`/`emergencyWithdrawPosition` on staking are all `nonReentrant`.
2. `_clearPosition` runs the JBAC return AFTER `_burn` (CCR-01 invariant).
3. The receiver `to` is `msg.sender` (original caller). If `to` is a malicious contract, its `onERC721Received` fires while staking's reentrancy guard is held → all callbacks into staking revert.
4. **Cross-contract reentrancy:** the user's `onERC721Received` could re-enter `vault.claimStrandedJbac(otherStakingTokenId)` for an UNRELATED stranded record. Since the vault's guard is NOT held during `returnJbac`, this re-entry would succeed.
5. Both paths use proper CEI ordering (state writes/deletes BEFORE external calls), so re-entry is benign in the current shape.

**Why it still warrants a flag:**
- Future refactor of `claimStrandedJbac` that introduces post-transfer state writes would break silently.
- Attaching `nonReentrant` to `returnJbac` adds ~2.3k gas but eliminates the asymmetry and seals an entire class of cross-call concerns.

**Battle-tested precedent:** SuperRare/Foundation marketplaces and ApeCoin Staking apply `nonReentrant` to ALL ERC721 entry points that emit/receive callbacks, even when state is CEI-clean.

**Recommendation:** Add `nonReentrant` to `returnJbac`. The `try/catch` semantics are preserved. Caller (`_clearPosition`) is single-entry per top-level tx and already wrapped; the modifier is effectively idempotent.

---

## F-39-2 — JBAC `tokenId == 0` permanently locked in vault (LOW — JBAC-collection-shape dependent)

**Severity:** LOW (only realizable if the wired JBAC collection mints `tokenId 0`)

**Location:**
- `TegridyStakingJbacVault.sol:91` — `if (jbacTokenId == 0) return;` in `returnJbac`
- `TegridyStakingJbacVault.sol:114` — `if (jId == 0) revert ZeroAmount();` in `claimStrandedJbac`
- `TegridyStaking.sol:791-836` — `stakeWithBoost` does not pre-validate `_jbacTokenId != 0`

**Scenario:**
1. JBAC collection mints `tokenId == 0` (some collections, e.g., older OpenZeppelin patterns, do).
2. User calls `stakeWithBoost(amount, dur, 0)`.
3. `jbacNFT.safeTransferFrom(user, vault, 0)` succeeds — JBAC #0 lands at vault, position recorded with `jbacTokenId: 0, jbacDeposited: true`.
4. On `withdraw` → `_clearPosition` captures `jbacIdToReturn = p.jbacDeposited ? p.jbacTokenId : 0`. Since `p.jbacTokenId == 0`, `jbacIdToReturn == 0`.
5. Staking guards on line 2074 (`if (jbacIdToReturn != 0)`) skip the `returnJbac` call entirely.
6. Even if `returnJbac` were called, line 91 short-circuits without state writes.
7. **JBAC #0 is permanently locked in the vault with no recovery path** — no admin sweep, no stranded record.

**JBAC contract assumption:** The L-AUDIT-2026-2 carry-over comment on line 106 acknowledges this concern but only patches `claimStrandedJbac`. The deposit-path defense (rejecting `_jbacTokenId == 0` at `stakeWithBoost`) is missing.

**Mitigation status check needed:** Verify that the JBAC collection actually skips tokenId 0 (i.e., starts minting at 1). Many ERC721 contracts do (`_nextTokenId = 1`), but this isn't guaranteed.

**Recommendation:**
- Add `if (_jbacTokenId == 0) revert ZeroAmount();` in `stakeWithBoost` at the start, OR
- Document explicitly in deployment runbook that JBAC contract MUST not mint tokenId 0.

---

## F-39-3 — Direct ERC721 transfer to vault permanently strands JBAC (INFO — defense-in-depth tradeoff)

**Severity:** INFO

**Location:** `TegridyStakingJbacVault.sol` — entire contract has zero admin / rescue surface.

**Observation:**
A user mistakenly calling `jbacNFT.safeTransferFrom(user, vault, tokenId)` (instead of `staking.stakeWithBoost`) will have their JBAC accepted by the vault's `onERC721Received` (which only checks `msg.sender == jbacNFT`, not whether the transfer originated from `stakeWithBoost`). The NFT lands in the vault with no position record. Permanent loss.

**Why this is a tradeoff, not a bug:**
- Adding admin recovery (`onlyOwner` rescueERC721) reintroduces centralization risk — the owner could rugpull every staker's JBAC.
- Adding a "pull-back" function that lets the original sender reclaim is feasible but adds bytecode (already at EIP-170 limit per the contract natspec).
- Current shape protects honest stakers at the cost of careless users.

**Recommendation:** No code change recommended. Surface the risk in user-facing docs: *"JBACs must be deposited via `stakeWithBoost`. Direct transfers to the vault are permanent."* If desired, add a `recoverDirectTransfer(tokenId)` callable by the original sender provided the vault never received `pullJbac` for that id (would require tracking inbound senders — non-trivial).

---

## F-39-4 — Vault is non-upgradeable; staking redeploy orphans all custodied JBACs (MEDIUM — operational risk)

**Severity:** MEDIUM (operational, not exploitable directly)

**Location:**
- `TegridyStakingJbacVault.sol:34-37` — `staking` is `immutable`
- `TegridyStakingJbacVault.sol:32` — no `Ownable`, no `setStaking()`, no `pause()`, no rescue
- `TegridyStaking.sol:466-472` — `setJbacVault` is one-shot on staking side

**Scenario:**
1. Staking contract has a critical bug discovered post-launch.
2. Owner deploys `TegridyStakingV2` to fix.
3. The vault is hard-wired (immutable) to V1 staking. Only V1 can call `returnJbac`.
4. New stakers move to V2; existing JBAC depositors at V1 must withdraw via V1 to retrieve their JBACs.
5. **If V1 has a bug that BLOCKS withdraw (e.g., a permanent revert path)**, the JBACs in the vault become PERMANENTLY UNRECOVERABLE — no admin escape hatch exists on the vault.

**Comparison to peer pattern:**
- TegridyRestaking has a `claimStrandedRestakeNFT` permissionless self-recovery path (line 1641-1652 of TegridyRestaking.sol per the natspec reference).
- TegridyStakingJbacVault only stranded-records when `returnJbac`'s `safeTransferFrom` itself fails — NOT when the staking contract is dead/unreachable.

**Recommendation (depending on threat model):**
- (a) Add an `onlyOwner` `pause()` + `emergencyClaim(stakingTokenId, claimant, jbacTokenId)` gated by a 7-day timelock and per-tokenId stranded-record check. Adds bytecode but provides escape hatch.
- (b) Document that staking redeployment requires migrating JBACs out FIRST (i.e., V1 must support a "drain" mode where it iterates active positions and calls `vault.returnJbac`). This is operational discipline.
- (c) Accept the trust boundary as final — current design.

---

## F-39-5 — `try/catch` swallows ALL revert reasons including out-of-gas (LOW)

**Severity:** LOW

**Location:** `TegridyStakingJbacVault.sol:92-98`

**Observation:**
The `try jbacNFT.safeTransferFrom { ... } catch { ... }` block catches:
- JBAC contract reverts (paused, etc.) — INTENDED
- Receiver `onERC721Received` reverts — INTENDED for malicious receivers
- **Out-of-gas in the called frame** — UNINTENDED side effect
- **Panic reverts** (e.g., assertion failure inside the JBAC contract) — UNINTENDED

In the OOG case, the catch block must execute three SSTOREs + one event emission with whatever gas remains. Solidity 0.8.x's `try/catch` reserves 1/64th of remaining gas for the parent (EIP-150), but if the original gas budget is tight (e.g., metatx via 4337 with strict gas limits), the catch block could itself fail, reverting the entire `_clearPosition` and locking the staker's principal.

**Realistic impact:**
The catch block needs ~25k gas (two SSTORE-from-zero ≈ 22k each at first write, but subsequent overwrites are ~5k; one event ≈ 3k). A user MUST budget enough gas for the entire staking exit including the catch path. Most front-ends auto-budget +50%, which is sufficient. But contract-mediated calls (Safe modules, account abstraction) may tightly bound gas.

**Recommendation:**
Consider `try { ... } catch (bytes memory) { ... }` and inspect the reason. Or, more practically, verify the catch-block gas cost is bounded and document the minimum gas budget required for `_clearPosition` exit paths.

---

## F-39-6 — Stranded record overwrite on duplicate strand for same `stakingTokenId` (DEAD-END — not reachable)

**Severity:** N/A (dead end)

**Investigation:**
If `returnJbac` is called twice for the same `stakingTokenId` and both fail, the second call OVERWRITES the first stranded record. This would lose the entitlement to the first JBAC.

**Why it's not reachable:**
- `_nextTokenId` is monotonically incrementing (`TegridyStaking.sol:178`, `751`, `803`).
- After `_clearPosition` is called once for a given `tokenId`, the position is `delete`d and the staking NFT is `_burn`ed.
- Subsequent attempts to call `_clearPosition(tokenId, ...)` for the same `tokenId` would fail at the `ownerOf(tokenId)` check (token doesn't exist) before reaching `vault.returnJbac`.
- Therefore `returnJbac` is invoked exactly once per `stakingTokenId`.

**Status:** Theoretical concern, not reachable.

---

## F-39-7 — `onERC721Received` returns correct magic value (DEAD-END — verified)

**Severity:** N/A (verified safe)

**Investigation:** Line 130 returns `IERC721Receiver.onERC721Received.selector == 0x150b7a02`. Standard. `onERC721Received` is `view` — no state mutation. Sender check (`msg.sender == address(jbacNFT)`) prevents accepting any non-JBAC ERC721. No magic-value confusion possible.

---

## F-39-8 — Approval residue (DEAD-END — verified)

**Severity:** N/A (verified safe)

**Investigation:**
- Vault never calls `approve` or `setApprovalForAll` on JBAC (greped — zero matches).
- ERC-721 `_transfer` clears any single-token approvals automatically.
- When JBAC arrives at the vault via `safeTransferFrom`, no approval state is set on the vault's behalf.
- When vault sends JBAC out, no approval residue is left because the vault was the owner directly.

**Status:** No leak.

---

## F-39-9 — Single-NFT-per-staker invariant (DEAD-END — enforced upstream)

**Severity:** N/A (correct by construction)

**Investigation:**
- `stakeWithBoost` checks `userTokenId[msg.sender] != 0` before allowing a second deposit (`TegridyStaking.sol:798`).
- A user with TWO stakingTokenIds (acquired via transfer) can hold two positions, but only the LATEST `userTokenId[holder]` is tracked. JBAC mapping is per-position, so JBACs are correctly returned per-tokenId on `_clearPosition`.
- No path allows two JBACs to be associated with the same staking position.

**Status:** Invariant holds.

---

## F-39-10 — `claimStrandedJbac` replay (DEAD-END — verified)

**Severity:** N/A (verified safe)

**Investigation:**
- `claimStrandedJbac` deletes both `strandedJbacOwner[stakingTokenId]` and `strandedJbacTokenId[stakingTokenId]` BEFORE the external `safeTransferFrom`.
- `nonReentrant` guard prevents re-entry within the same call stack.
- Even without the guard, deleted state means a re-entry would hit `to == address(0)` → `Unauthorized`.
- Authorization check `msg.sender != to` prevents any address other than the recorded owner from claiming.

**Status:** No replay path.

---

## F-39-11 — `returnJbac` called with non-canonical `to` (DEAD-END — caller-trust by design)

**Severity:** N/A

**Investigation:**
`returnJbac(stakingTokenId, jbacTokenId, to)` has `onlyStaking`. The vault TRUSTS staking to pass the correct `to` (the original depositor). Staking calls it with `msg.sender` (the user invoking `withdraw`/`earlyWithdraw`/etc.), which is verified upstream as the position owner via `ownerOf(tokenId) != msg.sender` checks.

**Edge cases checked:**
- `to == staking` itself → would be a contract; staking has no `onERC721Received` (post batch-14, removed) → JBAC's `safeTransferFrom` reverts → catch fires → stranded record written with `owner = staking`. Then `claimStrandedJbac` requires `msg.sender == staking`, which staking can't trigger. JBAC permanently stuck. **But this requires staking to call `returnJbac(_, _, staking)` deliberately** — only happens if the staking contract is buggy. Out of scope.
- `to == vault` itself → similar: vault can't `claimStrandedJbac` to itself. Permanent stuck. Same out-of-scope reasoning.

**Status:** Trust assumption documented; no exploit path from the vault's surface alone.

---

## Summary

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| F-39-1 | `returnJbac` lacks `nonReentrant` (asymmetric with `claimStrandedJbac`) | LOW | Add `nonReentrant` modifier |
| F-39-2 | JBAC `tokenId == 0` permanently locked | LOW | Add `_jbacTokenId == 0` revert in `stakeWithBoost`, or document JBAC must mint from id 1 |
| F-39-3 | Direct ERC721 transfer to vault permanently strands NFT | INFO | Document tradeoff in user-facing materials |
| F-39-4 | Vault has no escape hatch if staking dies / has bug | MEDIUM | Consider timelocked `emergencyClaim` or document migration runbook |
| F-39-5 | `try/catch` may absorb OOG and revert `_clearPosition` | LOW | Verify minimum gas budget for `_clearPosition` exit paths |
| F-39-6..F-39-11 | Verified safe / dead ends | — | — |

**Hot recommendations:**
1. **F-39-2** — patch is one-line, prevents permanent JBAC #0 loss if collection mints from 0.
2. **F-39-4** — consider escape hatch with strong governance (7-day timelock) for operational resilience.
3. **F-39-1** — `nonReentrant` on `returnJbac` is cheap defense-in-depth.

**Architectural notes (not bugs):**
- The CCR-01 invariant (burn before JBAC return) is correctly preserved by `_clearPosition`'s ordering.
- The `onlyStaking` + immutable `staking` design eliminates governance attack surface but makes the system rigid.
- Stranded path is well-designed for a paused/temporarily-broken JBAC contract; it does NOT cover the staking-redeploy scenario (F-39-4).
