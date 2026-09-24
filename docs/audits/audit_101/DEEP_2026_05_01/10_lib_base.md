# DEEP audit — `contracts/src/{base,lib,Toweli}.sol` cluster

**Date:** 2026-05-01
**Scope:** TimelockAdmin (110), OwnableNoRenounce (22), SequencerCheck (168), WETHFallbackLib (84), Toweli (80) — 5 files / ~464 LoC
**Method:** Line-by-line + cross-cluster sibling search across all ~15 importers
**Baseline:** All MICROSCOPE_2026_04_30 findings (H21, H22, M-Lib1..M-Lib7) excluded except where verifying the claimed fix surfaced a NEW sibling/related issue. POST_REMEDIATION_LEDGER deferrals (M-7 stipend) re-examined fresh.

---

## Headline tally

- **Critical:** 0
- **High:** 4
- **Medium:** 6
- **Low:** 5
- **Info:** 2

The base/lib cluster is small but ripples into ~15 production contracts. Three findings (DEEP-LIB-H1, DEEP-LIB-H2, DEEP-LIB-H3) are **single-fix-fixes-many** patterns: one library patch closes the bug everywhere it appears.

---

## DEEP-LIB-H1 · `WETHFallbackLib.safeTransferETHOrWrap` silently burns ETH when `to == address(0)`
**Severity:** High
**File:** `contracts/src/lib/WETHFallbackLib.sol:57-75`
**Category:** weth

**Bug:** The lib has no guard for `to == address(0)`. The raw `to.call{value: amount, gas: 10000}("")` succeeds when `to` is the zero address — the EVM lets you send ETH to `0x0` and **burns it**. The function then returns `wrapped = false`, signalling "ETH delivered normally" to the caller. There is no event, no revert, no fallback to WETH wrap. ETH is irrevocably destroyed and the caller is told the operation succeeded.

**Attack / Impact:** Today no production callsite passes a zero address (every importer checks at propose-time before storing in `treasury` / `recipient` / `lender` / etc.). However, the lib is imported by **12 production contracts** and the structural defense is at the wrong level — propose-time checks are **defense-in-depth**, not the floor. Any future contributor adding a new callsite (e.g. a new sweep destination, refund path, or third-party integration) without that upstream check creates a **silent ETH-burn primitive**. The Solmate/Seaport pattern this lib references **always reverts on failed transfer**; the silent-success-on-burn here is a deviation from the reference. Specific exposure:
- A `pendingTreasury` race where the propose-time guard is moved into a setter and someone forgets to re-add the check
- An aggregator integration that forwards a derived address that turns out to be 0
- Cross-clone factories (TegridyDropV2, TegridyNFTPool) where `weth/treasury/protocolFeeRecipient` is set during initialize — if any field is unset due to a forgotten initializer arg, the field is `address(0)` and the first `safeTransferETHOrWrap` call burns the entire balance.

**Blast radius:** all 12 importers — TegridyRouter, SwapFeeRouter, RevenueDistributor, VoteIncentives, CommunityGrants, ReferralSplitter, MemeBountyBoard, TegridyLending, TegridyNFTLending, TegridyNFTPool, TegridyNFTPoolFactory, TegridyDropV2, POLAccumulator (the audit-fix M-P01).

**Evidence:**
```
contracts/src/lib/WETHFallbackLib.sol:60-67
60        if (amount == 0) return false;
61        if (weth == address(0)) revert ZeroWETHAddress();
62
63        // AUDIT FIX H-02: Limited gas stipend prevents cross-contract reentrancy.
64        // 10000 gas is enough for receive() + event emit but not external calls.
65        (bool ok,) = to.call{value: amount, gas: 10000}("");
66        if (ok) return false;
```
No `to != address(0)` precondition. Solmate `SafeTransferLib.safeTransferETH` reverts on failure with no fallback; this lib's silent-burn-as-success is a structural divergence.

**Recommendation:** Add as the first guard:
```solidity
if (to == address(0)) revert ZeroRecipient();
```
Mirror the same check in `safeTransferETH` (line 79). New typed error `error ZeroRecipient();`. This is the only structural defense against future-importer silent-burn — propose-time checks are too easy to omit.

---

## DEEP-LIB-H2 · `MemeBountyBoard._sequencerBuffer` reuses the OLD `answer == 1` pattern that M-Lib3 fixed elsewhere
**Severity:** High
**File:** `contracts/src/MemeBountyBoard.sol:295-315`
**Category:** l2

**Bug:** `MemeBountyBoard` does NOT use `SequencerCheck` library — it has its own re-implementation `_sequencerBuffer()` that uses `if (answer == 1) return SEQUENCER_OUTAGE_BUFFER`. This is **exactly the M-Lib3 anti-pattern** that the central library was just fixed to use `answer != 0` (fail-closed). When MICROSCOPE_2026_04_30 M-Lib3 was applied to `lib/SequencerCheck.sol`, this duplicated implementation was missed.

**Attack / Impact:** If Chainlink ever extends the uptime-feed schema with a new state value (e.g. `answer == 2` for "degraded" or "partial"), `_sequencerBuffer` returns 0 — telling `refundStaleBounty` and `emergencyForceCancel` that the sequencer is up — which it might NOT be. A bounty creator who tried to deliver during a "degraded" period gets their bounty refund-cancelled out from under them; an emergency-force-cancel goes through during the same outage class. Also, on a bridged Chainlink relay where `answer = -1` could surface, the same logic-fail-open occurs (negative ints aren't 1 either, but the canonical "is up" check is `== 0`).

Direct sibling miss of M-Lib3 — the canonical lib was fixed but this re-implementation wasn't.

**Blast radius:** MemeBountyBoard's `refundStaleBounty` (creator force-refund window) and `emergencyForceCancel` (owner force-cancel window). On Arbitrum/OP/Base, both the creator's expected grace extension and the owner's force-cancel guardrail rely on this check.

**Evidence:**
```
contracts/src/MemeBountyBoard.sol:301-315
301    function _sequencerBuffer() internal view returns (uint256) {
302        if (sequencerFeed == address(0)) return 0;
303        (
304            ,
305            int256 answer,
306            uint256 startedAt,
307            ,
308        ) = IChainlinkAggregator(sequencerFeed).latestRoundData();
309        if (answer == 1) return SEQUENCER_OUTAGE_BUFFER;   // ← OLD PATTERN
310        if (startedAt == 0) return SEQUENCER_OUTAGE_BUFFER;
311        if ((block.timestamp - startedAt) < SEQUENCER_OUTAGE_BUFFER) {
312            return SEQUENCER_OUTAGE_BUFFER;
313        }
314        return 0;
315    }
```
Compare `lib/SequencerCheck.sol:99` (the fix): `if (answer != 0) revert SequencerDown();` — fail-closed.

Also missing: `updatedAt` staleness gate (M-Lib2) and `answeredInRound >= roundId` (M-Lib2). Both of these now exist in `SequencerCheck` but not in this duplicate.

**Recommendation:** Replace `_sequencerBuffer` with a call into the canonical lib. Add a `getSequencerOutageBuffer(address feed, uint256 buffer)` helper to `SequencerCheck` that returns either 0 or `buffer`, applying the same staleness/direction gates. Remove the duplicate. Pattern: every protocol-defined re-implementation of a library check is a sibling-search target.

---

## DEEP-LIB-H3 · `TegridyLending.claimDefaultedCollateral` and `TegridyNFTLending.claimDefault` lack `SequencerCheck` — borrowers liquidated immediately on sequencer resume
**Severity:** High
**File:** `contracts/src/TegridyLending.sol:783-852` (claimDefaultedCollateral), `contracts/src/TegridyNFTLending.sol:514-543` (claimDefault)
**Category:** l2

**Bug:** Both `_positionETHValue` (TegridyLending) and `acceptOffer` paths use `SequencerCheck.checkSequencerUp` for **valuation** — but the **defaulting** paths (`claimDefaultedCollateral`, `claimDefault`) don't. The lender can call `claimDefaultedCollateral` the **moment** `block.timestamp > effectiveDeadline + GRACE_PERIOD`, with no sequencer-uptime gate. If the sequencer was down for the entire grace period and just resumed, the borrower could not have repaid during the outage; on resume, the lender's first-included tx liquidates them.

`GRACE_PERIOD = 1 hour` and `SEQUENCER_GRACE_PERIOD = 1 hour` are equal — meaning a single sequencer outage of >1 hour entirely consumes the grace window. The borrower has zero usable repay time before liquidation.

**Attack / Impact:** Concrete sequence on Arbitrum/Base/OP:
1. Borrower has loan with `deadline = T`, `GRACE_PERIOD = 1h` → can repay until `T + 1h`
2. Sequencer goes down at `T - 30 min`, stays down 90 min → resumes at `T + 60 min`
3. `block.timestamp` jumps to `T + 60 min` on resume
4. Lender's pre-staged liquidation tx queued during outage is included at `block N` post-resume; `block.timestamp == T + 61 min` → `> effectiveDeadline + GRACE_PERIOD` → liquidation succeeds
5. Borrower's repayment tx (also queued) hits a transferred-NFT and reverts

This is the **textbook H3 finding from `045_L2Compat.md`** mapped to a specific contract surface. The fix is the same `SequencerCheck.checkSequencerUp` already used in the valuation path — just apply it to the liquidation entrypoints.

**Blast radius:** Every TOWELI-collateralised loan and every NFT-collateralised loan on every L2 deployment.

**Evidence:**
```
contracts/src/TegridyLending.sol:801
801        if (block.timestamp <= effectiveDeadline(_loanId) + GRACE_PERIOD) revert DeadlineNotReached();
```
No `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)` precedes it. Similarly `TegridyNFTLending.sol:530`.

**Recommendation:** Add at the top of both functions:
```solidity
SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
```
Plus consider extending `GRACE_PERIOD` proportionally on outage events — Aave V3 PriceOracleSentinel offers `getGracePeriod()` that consumers can use to adjust. Today both constants are simple `1 hours` — they need to be at least `2 * SEQUENCER_GRACE_PERIOD` so a one-grace-period outage doesn't entirely consume the borrower's repay window. Pattern: borrowers and liquidators must be treated symmetrically — both wait through the outage.

---

## DEEP-LIB-H4 · `TimelockAdmin` value-binding fix wasn't applied — child-contract upgrade can still queue malicious payload via `pendingX` swap
**Severity:** High
**File:** `contracts/src/base/TimelockAdmin.sol:62-69`
**Category:** timelock

**Bug:** Per 027_TimelockAdmin H-01, the timelock key is NOT bound to the proposed value. The fix described ("bake value into key via `keccak256(abi.encode(KEY, value))`") was never applied. The base lib still uses opaque `bytes32 key` slots, and every child contract maintains a separate `pendingX` storage slot that any future admin function could overwrite without touching `_propose`/`_cancel`.

The MICROSCOPE M-Lib1 fix capped MAX_DELAY but did not address the value-binding gap. The 027 H-01 finding remains live.

**Attack / Impact:** Sequence (concrete with `RevenueDistributor`):
1. Owner proposes `pendingTokenSweepTo = 0xFRIEND, pendingTokenSweepToken = USDC` via `proposeTokenSweep` — 48h timer starts
2. After 47:59h, a future patch ships an unrelated helper that writes `pendingTokenSweepTo = 0xATTACKER` (e.g. a "fix the typo" governance pathway)
3. Owner calls `executeTokenSweep` — reads the **swapped** value and sweeps to attacker

Today no such helper exists, so this is a **future-safety / lint** issue — but it's the highest-leverage one in the cluster. Adding ANY admin function that touches a `pendingX` slot is a footgun forever.

The 17 importers include high-value sidecars: `pendingSweepToken/pendingSweepTo` (RevenueDistributor), `pendingHarvestLpAmount` (POL — controls 10% LP withdraw), `pendingTreasury` (every contract), `pendingMerkleRoot` (Drop), `pendingFeeBps` (Lending), `pendingGuardianValue` (Factory).

**Blast radius:** All 17 contracts inheriting `TimelockAdmin`. Each one carries the latent value-swap risk perpetually until the base is hardened.

**Evidence:**
```
contracts/src/base/TimelockAdmin.sol:54-69
54    mapping(bytes32 => uint256) internal _executeAfter;
...
62    function _propose(bytes32 key, uint256 delay) internal {
63        if (delay < MIN_DELAY) revert DelayTooShort(delay, MIN_DELAY);
64        ...
67        _executeAfter[key] = block.timestamp + delay;
68        emit ProposalCreated(key, _executeAfter[key], _executeAfter[key] + PROPOSAL_VALIDITY);
69    }
```
Compare `Compound Timelock`:
```
queueTransaction(target, value, signature, data, eta) returns bytes32
// txHash = keccak256(abi.encode(target, value, signature, data, eta))
// queuedTransactions[txHash] = true
```
Compound binds the **calldata** into the queued ID. Tegridy keeps a separate `pendingX` per key — opaque to the base.

**Recommendation:** Two acceptable paths:

(a) **Compound model** — extend `_propose` to take a `bytes32 valueHash` parameter and store it in a separate mapping. `_execute` requires the caller to provide the original `value` and verifies `keccak256(value) == storedHash`:
```solidity
mapping(bytes32 => bytes32) internal _proposalValueHash;
function _propose(bytes32 key, uint256 delay, bytes32 valueHash) internal { ... }
function _execute(bytes32 key, bytes calldata value) internal {
    require(keccak256(value) == _proposalValueHash[key], "VALUE_MISMATCH");
    ...
}
```

(b) **Lint-tier mitigation** — make `_executeAfter` `private` (today: `internal`), expose `_executeAfterOf(bytes32)` view, and add a lint rule that no admin function may write to a `pendingX` slot outside its corresponding `proposeX/executeX/cancelX` triplet. Cheaper and matches the existing surface; closes the H-02 sub-issue (TegridyFactory.acceptFeeToSetter direct write).

Either fix should also make `MIN_DELAY` `virtual` so children can raise their floor (M-01 in 027 still live).

---

## DEEP-LIB-M1 · `OwnableNoRenounce` accepts contract-less EOAs as new owners — single-key risk preserved on every transferOwnership
**Severity:** Medium
**File:** `contracts/src/base/OwnableNoRenounce.sol:13-22`
**Category:** ownership

**Bug:** M-Lib7 noted that `transferOwnership` allows any non-zero address. The deferred-by-design rationale assumes the deployer reviews. **However**, there's no on-chain enforcement that the new owner is a multisig (i.e., `newOwner.code.length > 0`). Worse, OwnableNoRenounce ALSO doesn't enforce that the **initial** owner is a contract — `OwnableNoRenounce(msg.sender)` (used in 14 of 17 importers) sets ownership to whatever EOA called the constructor.

The audited recommendation in 026 L-04 to standardize on `address _owner` constructor params is unrelated. The bigger gap is no contract-only enforcement at any phase.

**Attack / Impact:** A compromised EOA owner key on **any** importer is sufficient to:
- queue any timelocked admin change (then wait 24-48h for execution)
- transfer ownership to a fresh attacker EOA, completing single-step (since OZ Ownable2Step's pendingOwner-then-accept lets attacker accept)

The 2-step transfer doesn't help if the old owner is ALREADY compromised — a compromised owner can `transferOwnership(new_attacker_eoa)` then `new_attacker_eoa.acceptOwnership()` themselves. The protocol design relies entirely on the **deployer/operator using a multisig** for the owner — but there's nothing stopping a deploy script from passing `msg.sender` (an EOA) and bricking the security model.

**Blast radius:** Every contract inheriting `OwnableNoRenounce` — 17 contracts. Single owner key = single point of failure for every parameter change, treasury rotation, fee setting, sweep, and guardian rotation.

**Evidence:**
```
contracts/src/base/OwnableNoRenounce.sol:13-22
13    abstract contract OwnableNoRenounce is Ownable2Step {
14        constructor(address initialOwner) Ownable(initialOwner) {
15            require(initialOwner != address(0), "ZERO_OWNER");
16        }
17        function renounceOwnership() public pure override {
18            revert("RENOUNCE_DISABLED");
19        }
20    }
```
No `initialOwner.code.length > 0` check; no override of `_transferOwnership` to enforce same on rotation.

**Recommendation:** Add an opt-in modifier `_requireOwnerIsContract` and apply both at constructor and at `_transferOwnership`:
```solidity
modifier _ownerMustBeContract(address newOwner) {
    require(newOwner.code.length > 0, "OWNER_NOT_CONTRACT");
    _;
}
```
Make this opt-in via a virtual flag (so test suites with EOA owners don't need a separate fork). Match Convex/Aave's deploy-time `MultisigGuard` pattern. Note: this conflicts with the timelock-guard recommendation in 026 M-02 (timelocking transferOwnership) — both are complementary.

---

## DEEP-LIB-M2 · `safeTransferETH` (non-fallback) forwards unbounded gas — cross-contract reentrancy primitive even when used "for refunds"
**Severity:** Medium
**File:** `contracts/src/lib/WETHFallbackLib.sol:79-83`
**Category:** weth

**Bug:** The non-fallback variant `safeTransferETH(to, amount)` uses `to.call{value: amount}("")` with **no gas stipend**, no fallback, no event. The H-02 fix that capped the OTHER variant at 10000 gas was not mirrored here. The NatSpec says "Use this when WETH fallback is not desired (e.g., refunds to EOAs)" — but Solidity has no way to distinguish EOAs from contracts at the call site, so the comment is aspirational, not enforced.

Today only TegridyLending uses the bare variant, and only for `overpayment` refunds to `msg.sender` (the borrower). Borrowers self-griefing through reentrant `receive()` is a low-impact misuse — but H21 in MICROSCOPE called out the SISTER variant; this variant inherits no protection.

**Attack / Impact:** A malicious borrower contract can:
1. Open a loan for principal P
2. Repay P + interest + 1 wei overpayment
3. In `receive()`, call back into TegridyLending (`nonReentrant` guards prevent re-entering the same contract — but **cross-contract** reentrancy into RevenueDistributor / SwapFeeRouter / etc. is open)
4. Drain pending payouts/distributions from sister contracts via cross-contract reentrancy

The `nonReentrant` on `repayLoan` is per-instance. It does NOT protect cross-contract reentrancy into RevenueDistributor.claim, VoteIncentives.claimBribes, etc., where the borrower's controlled receive() can re-enter and claim revenue against stake-state-snapshots.

**Blast radius:** Today: 1 callsite (TegridyLending.repayLoan overpayment refund). Future: any callsite that uses `safeTransferETH` (vs `safeTransferETHOrWrap`) inherits the same gap.

**Evidence:**
```
contracts/src/lib/WETHFallbackLib.sol:79-83
79    function safeTransferETH(address to, uint256 amount) internal {
80        if (amount == 0) return;
81        (bool ok,) = to.call{value: amount}("");
82        if (!ok) revert ETHTransferFailed();
83    }
```
No gas cap. The "EOA refunds only" claim in NatSpec is unverifiable on-chain.

**Recommendation:** Apply the same 10000-gas stipend (or a configurable parameter). For paths that need more gas (very heavy receive logic), require the caller to use the `safeTransferETHOrWrap` variant explicitly.

---

## DEEP-LIB-M3 · `SequencerCheck.MAX_FEED_STALENESS = 24 hours` is hardcoded — no per-consumer tuning, brick risk on keeper lapse
**Severity:** Medium
**File:** `contracts/src/lib/SequencerCheck.sol:64`
**Category:** l2

**Bug:** `MAX_FEED_STALENESS` is a library `internal constant` — every consumer uses 24 hours. Aave's pattern uses 24h for stable assets but **shorter** windows for high-frequency price feeds. Tegridy's TegridyLending and POLAccumulator are price-sensitive enough that 24h is generous; conversely the Drop dutch-auction is more time-sensitive than the lending grace, so 24h is appropriate there.

The hardcoded value also means a keeper lapse on the L2 sequencer feed (Chainlink reports the keeper updates the feed every ~10 minutes during normal ops, but in a known incident the feed went 6+ hours stale on Arbitrum without a sequencer outage) bricks ALL price-sensitive paths simultaneously across the protocol — `consult()`, lending valuation, drop pricing, POL harvests. There's no per-consumer override.

**Attack / Impact:** During a Chainlink keeper outage (no sequencer outage), the feed becomes stale. After 24h, every price-sensitive entrypoint reverts `SequencerDown` even though the chain is fine. The protocol becomes effectively read-only on:
- TegridyLending.acceptOffer (no new borrows)
- TegridyDropV2._dutchAuctionPrice (mints frozen)
- POLAccumulator.accumulate (POL drift)
- TegridyTWAP.consult (everything that reads prices breaks)

**Blast radius:** 5 importers (TegridyTWAP, TegridyLending, TegridyDropV2, POLAccumulator, MemeBountyBoard via duplicate impl). Single shared constant.

**Evidence:**
```
contracts/src/lib/SequencerCheck.sol:64
64    uint256 internal constant MAX_FEED_STALENESS = 24 hours;
...
92        if (block.timestamp - updatedAt > MAX_FEED_STALENESS) revert SequencerDown(); // keeper lapse
```

**Recommendation:** Make `MAX_FEED_STALENESS` a parameter to `checkSequencerUp` and `getResumeTimestamp`, with each consumer storing its own `feedStaleness` immutable. Default to 24h but let lending/drop tune lower (4h?) and let POL tune lower for harvest sensitivity. Same pattern as `gracePeriod` is already passed.

---

## DEEP-LIB-M4 · `Toweli` recipient receives full 1B supply with no allowance/grant claim mechanism — complete loss-of-funds on deploy-script error
**Severity:** Medium
**File:** `contracts/src/Toweli.sol:57-66`
**Category:** token

**Bug:** Per M-Lib4, the constructor mints all 1B TOWELI to `recipient` with only `recipient != address(0)` enforcement. There's no:
- contract-presence check (`recipient.code.length > 0`)
- multisig-pattern detection
- timelocked rotation path (impossible since there's no admin)
- partial-claim flow (e.g., 10% mint to deployer + 90% locked to multisig with claim window)

The fix-or-defer-or-document trichotomy was deferred (M-Lib4 unfixed). However, there's a forward-looking concern beyond the deploy-procedure note: **Toweli is the only contract in the protocol with NO governance entry point**. If the deploy-script bug puts 1B into a typoed multisig address (or the multisig is created with a single signer because `--threshold 1`, etc.), the entire protocol is dead-on-arrival with no recovery path.

The TOKENOMICS doc says recipient is the multisig treasury — but the contract has no way to verify that.

**Attack / Impact:** Deploy-time scenarios that result in total loss:
1. CREATE2 mining produces a vanity address before the multisig is ready; constructor passes `address(salt-derived)` which has no code → 1B locked
2. Deploy script reads `MULTISIG=0x...` from env that's been hex-truncated by zsh expansion → typoed address, 1B locked
3. Multisig deployed with wrong owners by mistake; ownership change not yet ratified → tokens move to a Safe whose owner pool isn't yet finalized

There's no reversal, no rescue, no `transferOwnership` (no owner exists). The contract is fixed-supply by design.

**Blast radius:** 1 contract; 1 chain per deploy. Total protocol-level loss.

**Evidence:**
```
contracts/src/Toweli.sol:57-66
57    constructor(address recipient)
58        ERC20("Toweli", "TOWELI")
59        ERC20Permit("Toweli")
60    {
61        require(recipient != address(0), "Toweli: zero recipient");
62        _mint(recipient, TOTAL_SUPPLY);
63        _initialMintDone = true;
64    }
```
Single revert path; no `code.length` check; no fallback recipient.

**Recommendation:** Acceptable per design rationale, but add at minimum:
```solidity
require(recipient.code.length > 0, "Toweli: recipient not a contract");
```
This blocks accidental EOA assignments. For maximum safety, mint to a **two-step claim contract** that the deployer creates first, and have Toweli mint INTO that contract; then the multisig pulls from it via 2-step. Pattern: how Optimism's OP token + GovernanceToken handles initial allocation (a separate `MintManager` claim pattern).

---

## DEEP-LIB-M5 · `TegridyFactory.acceptFeeToSetter` directly writes `_executeAfter[FEE_TO_CHANGE] = 0` — bypasses `ProposalCancelled` event
**Severity:** Medium
**File:** `contracts/src/TegridyFactory.sol:267-272`
**Category:** timelock

**Bug:** Per 027 H-02, `TegridyFactory.acceptFeeToSetter` reaches directly into `_executeAfter[FEE_TO_CHANGE]` instead of calling `_cancel()`. While the `pendingFeeTo` is properly cleared and a `FeeToChangeCancelled(cancelledFeeTo)` event is emitted, the canonical `ProposalCancelled(FEE_TO_CHANGE)` event is **not** emitted. Off-chain monitors subscribed to `ProposalCancelled` (the standard event for the entire timelock surface) will not see this cancellation.

Worse: this **establishes a precedent** — future contributors maintaining sister contracts may copy this pattern, each direct-write skipping the canonical event. The base lib's `_executeAfter` is `internal` (not `private`), allowing this.

**Attack / Impact:** Today the off-chain miss is a single event-stream gap (forensics for fee-setter rotation requires correlating two event types). The structural risk is precedent-setting:
1. A future child contract adds an `acceptOwnershipPlus(...)` or similar that direct-writes `_executeAfter[KEY] = 0` to "speed up cancellation"
2. The bypass eliminates the chance for an off-chain canceller-monitor / guardian to react
3. The `ProposalCancelled` event is subscribed to by indexers, the security-monitoring dashboard, and Tenderly alerts — each direct-write hides cancellations from all of them

**Blast radius:** 1 callsite today (TegridyFactory.acceptFeeToSetter). Pattern risk: every contract inheriting TimelockAdmin (17 contracts).

**Evidence:**
```
contracts/src/TegridyFactory.sol:267-272
267        if (_executeAfter[FEE_TO_CHANGE] != 0) {
268            address cancelledFeeTo = pendingFeeTo;
269            _executeAfter[FEE_TO_CHANGE] = 0;
270            pendingFeeTo = address(0);
271            emit FeeToChangeCancelled(cancelledFeeTo);
272        }
```
The direct write should be `_cancel(FEE_TO_CHANGE)` (which emits `ProposalCancelled`) followed by the existing `pendingFeeTo = address(0)` reset and the supplemental `FeeToChangeCancelled` event.

**Recommendation:** Apply this small refactor in TegridyFactory:
```solidity
if (_executeAfter[FEE_TO_CHANGE] != 0) {
    address cancelledFeeTo = pendingFeeTo;
    pendingFeeTo = address(0);
    _cancel(FEE_TO_CHANGE);  // emits ProposalCancelled
    emit FeeToChangeCancelled(cancelledFeeTo);
}
```
At the lib level, change `mapping(bytes32 => uint256) internal _executeAfter` to `private`, expose `_executeAfterOf(bytes32) internal view` view + `_forceCancel(bytes32) internal` helper. This structurally prevents future direct-writes.

---

## DEEP-LIB-M6 · `SequencerCheck.checkSequencerUp` reverts on view paths — gas-bombs indexers and breaks `eth_call` simulators during outage
**Severity:** Medium
**File:** `contracts/src/TegridyTWAP.sol:395-430` (consult), `contracts/src/POLAccumulator.sol:790-803` (_assertTWAPFresh)
**Category:** l2

**Bug:** `consult()` is declared `view` but reverts via `SequencerCheck.checkSequencerUp` during the 1-hour grace period after sequencer resume. View functions that revert on a soft condition (vs. a permission failure) are a footgun for:
1. Off-chain indexers that periodically poll prices for analytics/dashboards
2. Frontend `eth_call` simulators that try to estimate user actions and gracefully degrade UX
3. Aggregators (1inch, ParaSwap) that consult the price oracle in a quote — they will simply skip Tegridy pairs during the grace window, losing the protocol routing share

The protocol has alternatives: return a struct `(uint256 amountOut, bool sequencerUp, uint256 resumeAt)` so consumers can choose to revert OR display a stale-price warning. Today everything reverts opaquely.

**Attack / Impact:** During the SEQUENCER_GRACE_PERIOD = 1h after resume, the entire `consult()` surface is broken. Off-chain monitoring goes silent. UX shows "estimation error" with no explanation. Aggregators de-route. This is precisely WHEN price-sensitive monitoring is most critical (post-outage anomaly detection).

**Blast radius:** TegridyTWAP.consult (called by SwapFeeRouter, POLAccumulator, lending, drop pricing). Indirectly: every UI/dashboard/aggregator that consults via these contracts.

**Evidence:**
```
contracts/src/TegridyTWAP.sol:395-403
395    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
396        external
397        view
398        returns (uint256 amountOut)
399    {
400        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD);
```
Reverts on any sequencer condition. No alternative read path.

**Recommendation:** Add a sister `consultOrZero(...)` (or `tryConsult(...)`) that returns `(uint256 amountOut, bool ok)` for indexers/UIs, while keeping the reverting `consult()` for the security-critical pricing path. Pattern: Chainlink's `latestRoundData` returns the data and lets the consumer decide; Aave splits `getAssetPrice` (revertable) from `getAssetData` (returns flag). Simple, additive change.

---

## DEEP-LIB-L1 · `WETHFallbackLib` does not emit any event when raw-ETH path succeeds — split asymmetric with the H21 `ETHToWETHFallback` event
**Severity:** Low
**File:** `contracts/src/lib/WETHFallbackLib.sol:36, 57-75`
**Category:** weth

**Bug:** The H21 fix added `ETHToWETHFallback(weth, to, amount)` event for the wrap-fallback path, but the success path emits no event. Off-chain consumers see "wrap event = WETH delivered, no event = ETH delivered" — but they have no positive confirmation. A missed RPC subscription or a dropped event log silently mis-attributes ETH-delivered as never-delivered.

**Attack / Impact:** Off-chain accounting is missing positive ack on the success path. Indexers cannot reliably detect "ETH was paid" — only "WETH was paid" (via ETHToWETHFallback) or via tx-trace inspection (which most indexers don't do). Pattern: Solmate emits no event at all for consistency, but Aave's `_safeTransferETH` does emit. Tegridy chose the asymmetric pattern.

**Recommendation:** Add `event ETHTransferred(address indexed to, uint256 amount)` and emit on the success path. Or make symmetric: emit nothing on either path and let consumers rely on the recipient's `receive()` event. Today's asymmetry is the worst-case: half-coverage that breaks tooling silently.

---

## DEEP-LIB-L2 · `OwnableNoRenounce` `renounceOwnership` declared `public pure` blocks future event emission
**Severity:** Low
**File:** `contracts/src/base/OwnableNoRenounce.sol:19-21`
**Category:** ownership

**Bug:** Per 026 L-02, marking `renounceOwnership` as `pure` blocks any subclass from emitting `OwnershipRenounceAttempted` telemetry without changing the base. If governance wants to monitor "did anyone try to renounce" (a useful red-flag for compromised-key detection), the base must change first.

**Attack / Impact:** Forensics. Compromised-owner-key detection via "owner attempted renounce, was reverted" log relies on event emission, which `pure` blocks. Today no consumer needs this, so it's a maintainability concern.

**Recommendation:** Change to `view` (allows reading state) or just remove the `pure` modifier. Tiny change, opens future telemetry path.

---

## DEEP-LIB-L3 · `Toweli` ERC20Permit uses ECDSA.recover (raw) — smart-contract wallets (Safe, AA) cannot use permit
**Severity:** Low
**File:** `contracts/src/Toweli.sol:27` (inherits OZ ERC20Permit)
**Category:** token

**Bug:** OZ's `ERC20Permit.permit` uses `ECDSA.recover` directly (line 59 in v5.5.0), not `SignatureChecker.isValidSignatureNow`. This means smart-contract wallets that sign via ERC-1271 cannot use Toweli's permit — their permit() call reverts with ERC2612InvalidSigner because the signature doesn't recover an EOA address.

Tegridy's docs market Toweli as "compatible with account abstraction flows via ERC-2612 permit." (Toweli.sol:27). That's strictly false for ERC-1271 / EIP-4337 wallets — they need an `approve()` tx first.

**Attack / Impact:** UX gap. AA wallet users must do approve+swap (2 txs) instead of permit-in-swap (1 tx) — costing extra gas and breaking the gasless-approval narrative. Not exploitable but materially limits the docs claim.

**Recommendation:** Override `permit` in Toweli to use `SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))`:
```solidity
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    public override
{
    if (block.timestamp > deadline) revert ERC2612ExpiredSignature(deadline);
    bytes32 hash = _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH_, owner, spender, value, _useNonce(owner), deadline)));
    if (!SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))) {
        revert ERC2612InvalidSigner(address(0), owner);
    }
    _approve(owner, spender, value);
}
```
Pattern: USDC v2.2, DAI's permit accept SCW signatures via this exact mechanism. Closes the docs/code mismatch.

---

## DEEP-LIB-L4 · `TimelockAdmin._propose` at exactly `MAX_DELAY = 30 days` works, but `BRIBE_RESCUE_DELAY = 30 days` and `POL_HARVEST_DELAY = 30 days` are at the cap — cannot be extended without lib-level change
**Severity:** Low
**File:** `contracts/src/base/TimelockAdmin.sol:49`, `contracts/src/VoteIncentives.sol:219`, `contracts/src/POLAccumulator.sol:588`
**Category:** timelock

**Bug:** The `MAX_DELAY = 30 days` limit was added (M-Lib1) to bound a captured-owner indefinite-lockout. Two child constants are at this cap exactly: `BRIBE_RESCUE_DELAY = 30 days` and `POL_HARVEST_DELAY = 30 days`. The check is `delay > MAX_DELAY` (strict >), so these pass. But any future tightening of timelocks (e.g. raising rescue delay to 60 days for high-value ops) silently reverts.

A child contributor unaware of the lib's MAX_DELAY would set `delay = 60 days`, expect the propose to succeed, see DelayTooLong revert, get confused. Worse, an existing operator extending an admin proposal manually picks `60 days` and crashes their own deploy.

**Attack / Impact:** Operational risk only. Future-extension footgun.

**Recommendation:** Make `MAX_DELAY` `virtual` so children can override (and document that 30 days is the floor recommendation, not a ceiling for the most sensitive ops). Alternatively, keep at 30 days and add explicit "lib-imposed cap" lint to child constant declarations.

---

## DEEP-LIB-L5 · `TimelockAdmin.PROPOSAL_VALIDITY = 7 days` not virtual — emergency-recovery proposals can expire before multisig coordinates
**Severity:** Low
**File:** `contracts/src/base/TimelockAdmin.sol:38`
**Category:** timelock

**Bug:** Per 027 M-02, a 7-day validity window is fine for parameter changes but tight for emergency-recovery proposals (e.g., RevenueDistributor.executeEmergencyWithdrawExcess, POLAccumulator.executeSweepETH). If the multisig is unavailable for 7+ days post-readiness (member rotation, holiday, time zone) the proposal expires and must be re-proposed (another 48h delay).

**Attack / Impact:** Soft DoS of recovery paths during multisig-unavailability. Not exploitable, but materially worsens incident response.

**Recommendation:** Make `PROPOSAL_VALIDITY` `virtual` (today: `public constant`); allow children to override. Or add a separate `EMERGENCY_VALIDITY = 30 days` that emergency-class proposals use.

---

## DEEP-LIB-I1 · `WETHFallbackLib` has no `IWETH.deposit` return-data check — malicious WETH could silently fail-without-mint
**Severity:** Info
**File:** `contracts/src/lib/WETHFallbackLib.sol:70`
**Category:** weth

**Bug:** `IWETH(weth).deposit{value: amount}();` is called without checking return data or post-balance. Canonical WETH9 has no return value (`function deposit() public payable`), so a `success`-flag check is impossible. If `weth` is misconfigured to a contract that's NOT WETH9 (e.g., a namespace-collision contract that accepts ETH but doesn't mint WETH), the deposit silently swallows ETH and the subsequent `transfer(to, amount)` reverts — at which point `WETHTransferFailed` reverts the whole tx. Net effect: the importer's ETH is locked in the malicious WETH contract.

This is the M-2 issue from 028. The fix would require an additional `IWETH(weth).balanceOf(address(this))` check pre/post to verify the balance increased by `amount`. Today's lib trusts the deploy-time review.

**Recommendation:** Defensive but high-overhead — add `uint256 before = IWETH(weth).balanceOf(address(this)); IWETH(weth).deposit{value:amount}(); require(IWETH(weth).balanceOf(address(this)) >= before + amount, "WETH_DEPOSIT_FAIL");`. Probably not worth the gas cost since deploy-time review is the practical defense; document instead.

---

## DEEP-LIB-I2 · `Toweli` `EIP712` version is hardcoded to "1" — a re-deploy on a new chain will still hash to a "1" domain, OK for now but locks future versioning
**Severity:** Info
**File:** `contracts/src/Toweli.sol:59`
**Category:** token

**Bug:** OZ `ERC20Permit(name)` calls `EIP712(name, "1")` — version is the literal string "1". If Toweli ever ships a v2 (e.g., a multi-chain bridge wrapper, or a fork with different fees), the new contract MUST also use version "1" or every existing `permit` signature on user-side will break (different domain separator → different signature → invalid).

This is fine today (Toweli v1, 1 chain) but locks the version namespace forever. Not exploitable.

**Recommendation:** Document that future Toweli derivatives (rebases, fork-deployments) must keep `version = "1"` to preserve cross-chain signature compatibility. Or rebuild the domain separator with explicit version control if a v2 is anticipated.

---

## Sibling-search summary (cross-cluster impact)

| Pattern | Library callsites | Findings |
|---|---|---|
| `WETHFallbackLib.safeTransferETHOrWrap` | 32 across 12 contracts | DEEP-LIB-H1 (zero recipient), DEEP-LIB-L1 (no success event) |
| `SequencerCheck.checkSequencerUp` | 5 across 5 contracts | DEEP-LIB-H3 (lending claimDefault gap), DEEP-LIB-M3 (hardcoded staleness) |
| Re-implemented sequencer check | 1 (MemeBountyBoard) | DEEP-LIB-H2 (M-Lib3 sibling miss) |
| `TimelockAdmin._propose/_execute` | 17 contracts | DEEP-LIB-H4 (value not bound), DEEP-LIB-M5 (acceptFeeToSetter direct-write) |
| `OwnableNoRenounce` constructor | 17 contracts | DEEP-LIB-M1 (no contract enforcement) |
| `Toweli` permit() | 1 (only Toweli) | DEEP-LIB-L3 (no SCW support) |

The two highest-leverage closures:
1. **Single-line lib fix** (DEEP-LIB-H1) — adds `if (to == address(0)) revert ZeroRecipient();` to WETHFallbackLib. Closes the latent silent-burn primitive across all 12 importers.
2. **Replace MemeBountyBoard duplicate** (DEEP-LIB-H2) — switches a duplicated, partially-fixed sequencer check to the canonical lib. Restores M-Lib3 closure parity across the cluster.
