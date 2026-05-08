# Agent 43 — Fresh-Eyes Access Control Audit

Lens: ACCESS CONTROL across all `contracts/src/*.sol` (and `contracts/src/base/*.sol`,
`contracts/src/lib/*.sol`).
Date: 2026-05-07.
Methodology: walked every `external` / `public` non-view function and inspected the
intended-caller restriction (modifiers + inline `require`/`revert` checks). Compared
admin-rotation and one-shot setter patterns across the 30+ contracts to surface
divergences and missing-defense-in-depth gaps. Did not review reentrancy / math /
oracle correctness (other agents own those lenses).

Coverage notes:
- Read all 30 production Solidity files in `contracts/src/` and the 6 base/lib helpers.
- Did not read any `.audit_2026_freshlook/findings/agent_*.md` (per instructions).
- Did not edit any source.

Format: F-43-K (sequential, K = letter). Severity is the agent's lens-only judgment;
calibration to protocol-wide impact is the deduper's responsibility.

---

## F-43-A — `TegridyStaking.executeAdminReplacement` has no proposal-validity expiry

**File:** `contracts/src/TegridyStaking.sol:1924-1935`
**Function:** `executeAdminReplacement()`
**Lens:** owner-only — gating is correct; the gap is in the proposal lifecycle.

The proposal flow on TegridyStaking is:
- `proposeAdminReplacement(_newAdmin)` writes `pendingStakingAdmin` and
  `adminReplacementReadyAt = block.timestamp + 48h` (`L1914-1921`).
- `executeAdminReplacement()` requires `block.timestamp >= readyAt` (`L1927`),
  but does NOT enforce an upper bound on `block.timestamp - readyAt`.

The sister contract `SwapFeeRouter` has the SAME pattern but explicitly adds
a 7-day validity window after `readyAt`:
```text
SwapFeeRouter.sol:1115     if (block.timestamp > readyAt + 7 days) revert AdminReplacementUnavailable();
```
with the rationale comment at `SwapFeeRouter.sol:1104-1109` (DEEP-R-M01) explicitly
calling out that "a years-old stale proposal stays live forever — and a forgotten
candidate address could be co-opted (CREATE2 redeploy, abandoned multisig, expired-key
custody) to install a hostile admin."

The same threat applies verbatim to TegridyStaking: a stale `pendingStakingAdmin` set
years ago (e.g. if the original 48h-elapsed propose was forgotten and never executed
or cancelled) remains executable indefinitely. The candidate address could in the
intervening years become an attacker-controlled CREATE2 redeploy or an abandoned
multisig the attacker now controls.

**Attacker scenario:** Owner proposes replacement to a multisig at T0; the proposal
goes unexecuted because plans change but `cancelAdminReplacement` is forgotten.
The multisig's signers later rotate or the multisig is decommissioned at T0+1y, leaving
the address effectively orphaned. An attacker who eventually gains control of even one
signer can call `executeAdminReplacement()` years later to seize stakingAdmin. While
it's owner-only — so the attacker still needs the owner key — the bigger risk is the
inverse: the owner loses sight of the stale proposal and a future ops keeper executes
it forgetting that the multisig's threat model has evolved.

**Impact:** Lower than active key compromise but a documented departure from
DEEP-R-M01's reasoning, applied inconsistently across the two near-identical sister
contracts (SwapFeeRouter has the fix; TegridyStaking does not).

**Fix sketch:** Mirror SwapFeeRouter's pattern — add `if (block.timestamp > readyAt + 7 days) revert Unauthorized();`
right after the `block.timestamp < readyAt` check.

---

## F-43-B — `TegridyStaking.proposeAdminReplacement` does not enforce contract-only admin

**File:** `contracts/src/TegridyStaking.sol:1914-1921`
**Function:** `proposeAdminReplacement(_newAdmin)`
**Lens:** owner-only — gating is correct; the gap is in input validation.

`proposeAdminReplacement` validates only `_newAdmin != address(0)`. It does NOT
check `_newAdmin.code.length > 0`. The first-time setter `setStakingAdmin` correctly
enforces the contract-only constraint:
```text
TegridyStaking.sol:1885    if (_admin.code.length == 0) revert NotAContract();
```
with the rationale at `L1881-1885` (DEEP-DS-12) explicitly stating: "reject EOA /
non-contract addresses on first-time wire-up. Catches the typo that points at a
wallet instead of a deployed TegridyStakingAdmin; recovery is otherwise gated by the
48h proposeAdminReplacement timelock."

That rationale fully applies to the rotation path too — if the owner typos an EOA
address into `proposeAdminReplacement` and the 48h elapses without anyone noticing,
`executeAdminReplacement` will install an EOA as `stakingAdmin`, breaking the
`onlyAdmin` modifier (L1946-1949) such that NO admin path works. Every `apply*`
setter (`applyRewardRate`, `applyTreasury`, `applyRestakingContract`,
`applyLendingContract`, `applyExtendFee`, `applyExtendFeeRecycle`,
`applyPenaltyRecycle`, `applyMaxUnsettledRewards`) becomes uncallable because the
EOA cannot construct an `external` call from the admin address. This bricks ALL
admin parameter changes on the staking contract.

The sister contract `TegridyLending.setLendingAdmin` correctly enforces this:
```text
TegridyLending.sol:137    require(_admin.code.length > 0, "ADMIN_MUST_BE_CONTRACT");
```
SwapFeeRouter's `proposeAdminReplacement` is also missing the check (`L1095-1102`),
so this is a paired finding (see F-43-C below).

**Attacker scenario:** Owner-key compromise where the attacker proposes their own
EOA as admin. Because there's no propose-time contract check, the proposal sits in
the queue. The owner has 48h to cancel, but if the cancel path is also blocked (e.g.
captured key continuously re-proposing), the EOA gets installed at the 48h mark and
permanently bricks every admin parameter change on staking. The attacker doesn't gain
exploitative power — they brick the admin surface, which is itself a denial-of-service
weapon (the only recovery is `proposeAdminReplacement` again, which the same captured
key blocks).

**Impact:** Brick-the-admin DoS. Cannot exfiltrate funds via this path (the
`applyXxx` setters don't transfer tokens; user funds are protected by `onlyOwner`
and `nonReentrant` on the user-facing paths). Severity-cap is "admin DoS during a
key-compromise incident" — but the timelock window is the exact recovery vector that
this gap weaponises against itself.

**Fix sketch:** Mirror `setStakingAdmin`'s contract-only enforcement:
```solidity
if (_newAdmin.code.length == 0) revert NotAContract();
```

---

## F-43-C — `SwapFeeRouter.proposeAdminReplacement` and `setSwapFeeRouterAdmin` do not enforce contract-only admin

**File:** `contracts/src/SwapFeeRouter.sol:1061-1067` (first-time setter), `L1095-1102` (rotation propose)
**Functions:** `setSwapFeeRouterAdmin(address)`, `proposeAdminReplacement(address)`
**Lens:** owner-only — gating is correct; the gap is in input validation.

Mirrors F-43-B on the sister contract. The first-time wire-up `setSwapFeeRouterAdmin`
checks `_admin == address(0)` and one-shot but does NOT check
`_admin.code.length > 0`. Same threat model: a captured-or-mistyped EOA gets installed
as `swapFeeRouterAdmin` and every `applyXxx` setter on SwapFeeRouter becomes
uncallable (the SFR onlyAdmin modifier is checked via the modifier in
`SwapFeeRouter.sol:976`).

The TegridyLending equivalent (`setLendingAdmin`) gets this right
(`TegridyLending.sol:137`); the SwapFeeRouter / TegridyStaking sisters do not.

**Impact / fix:** Same shape as F-43-B. Add `_newAdmin.code.length > 0` enforcement
in both `setSwapFeeRouterAdmin` and `proposeAdminReplacement`.

---

## F-43-D — `TegridyLending.setLendingAdmin` is permanently one-shot — no rotation path

**File:** `contracts/src/TegridyLending.sol:134-140`
**Function:** `setLendingAdmin(address _admin)`
**Lens:** owner-only — gating is correct; the gap is in lifecycle / replaceability.

`setLendingAdmin` reverts with `LendingAdminAlreadySet` once `lendingAdmin != address(0)`,
and there is NO `proposeAdminReplacement` / `executeAdminReplacement` flow on
TegridyLending. Compare:

- TegridyStaking: `setStakingAdmin` is one-shot, but `proposeAdminReplacement` /
  `executeAdminReplacement` provide a 48h-timelocked rotation path
  (`TegridyStaking.sol:1914-1944`).
- SwapFeeRouter: same pattern, with a 7-day rotation path
  (`SwapFeeRouter.sol:1095-1135`).
- TegridyLending: ONLY the first-time setter exists. If `lendingAdmin` becomes
  compromised, buggy, or simply needs to be rotated for ops reasons, the only
  recovery is to redeploy TegridyLending entirely and migrate every active loan
  + offer.

The TegridyStaking R014 H-2 NatSpec at `L1873-1877` explicitly motivates the
rotation path: "Prior version was permanently one-shot, so a buggy or compromised
admin contract could never be rotated without redeploying TegridyStaking and
migrating all positions." That rationale applies verbatim to TegridyLending.

**Attacker scenario:** A bug in TegridyLendingAdmin's timelock state-machine OR a
private-key compromise on the address that controls TegridyLendingAdmin (e.g. its
multisig). Recovery on Staking / SwapFeeRouter goes through the
`proposeAdminReplacement` path; on TegridyLending it requires a full migration of
every active offer + loan + escrowed NFT — orders of magnitude more disruptive.

**Impact:** Operational lock-in. Not an exploitable bug per se but a divergence from
the protocol-wide pattern that creates a "privileged setter that never expires" —
exactly the foot-gun the sister contracts went out of their way to fix.

**Fix sketch:** Add the same propose/execute/cancel rotation surface that
TegridyStaking has (`TegridyStaking.sol:1908-1944`), mirroring the timelock key
choice and 48h delay.

---

## F-43-E — `GaugeController.setRestakingContract` and `VoteIncentives.setRestakingContract` accept EOA addresses

**Files:**
- `contracts/src/GaugeController.sol:1048-1053`
- `contracts/src/VoteIncentives.sol:1135-1140`
- `contracts/src/ReferralSplitter.sol:503-508`
- `contracts/src/MemeBountyBoard.sol:354-358` (similar pattern)

All four contracts implement a one-shot `setRestakingContract(address _restaking)`
gated by `onlyOwner` with the canonical pattern:
```solidity
if (_restaking == address(0)) revert ZeroAddress();
if (restakingContract != address(0)) revert RestakingAlreadySet();
restakingContract = _restaking;
emit RestakingContractSet(_restaking);
```
None of them verify `_restaking.code.length > 0`. A typo / stale-config / wrong-chain
address (EOA, or a non-existent contract) can be installed permanently. After install
the consuming code-paths in each contract:
- `GaugeController` reads `restakingContract` for vote-power lookups
  (e.g. via `VotePowerOracle.powerAt`).
- `VoteIncentives` reads `restakingContract` for additive vote-power on `vote()`
  / `claimBribes` paths.
- `ReferralSplitter.recordFee` and `markBelowStake` / `forfeitUnclaimedRewards` all
  do `try IRestakingForReferral(restakingContract).votingPowerOf(referrer) returns ...`.
- `MemeBountyBoard.submitWork` / `voteForSubmission` consult `restakingContract`
  via `VotePowerOracle.powerAt`.

If `_restaking` is an EOA, every consult returns either `try`-catch-empty or reverts
with no calldata. The graceful try/catch in some sites means the protocol continues
to function with restaked voting power silently zeroed — an invariant violation that
shows up as undercounted votes / refused referral fee credits / undercounted bounty
votes. The contract becomes operationally permanently degraded with no recovery path
(one-shot setter).

**Sister contracts that DO check:**
- `TegridyStaking.setStakingAdmin` (`L1885`): `if (_admin.code.length == 0) revert NotAContract();`
- `TegridyLending.setLendingAdmin` (`L137`): `require(_admin.code.length > 0, "ADMIN_MUST_BE_CONTRACT");`
- `TegridyStaking.setJbacVault` (`L469`): `if (_vault.code.length == 0) revert NotAContract();`

Same protocol; same `OwnableNoRenounce` base; inconsistent input validation.

**Impact:** Permanent silent degradation under owner mistype. Not exploitable by an
external attacker, but contradicts the pattern established by the sister contracts.

**Fix sketch:** Add `if (_restaking.code.length == 0) revert NotAContract();` to
each of the four `setRestakingContract` paths.

---

## F-43-F — `TegridyTWAP.transferOwnership` allows zero proposal validity / no contract check on pendingOwner

**File:** `contracts/src/TegridyTWAP.sol:46-76` (the inline `TWAPAdmin` mini-Ownable2Step)
**Function:** `transferOwnership(address newOwner)`
**Lens:** owner-only — gating is correct; gap is in lifecycle hardening.

TegridyTWAP rolls its own `TWAPAdmin` 2-step ownership flow rather than inheriting
`OwnableNoRenounce`. The flow (`L61-72`):
1. `transferOwnership(newOwner)` checks `newOwner != address(0)`, sets `pendingOwner`,
   emits `OwnershipTransferStarted`. **No timelock**, **no contract-only check**,
   **no expiry**.
2. `acceptOwnership()` checks `msg.sender == pendingOwner`, sets `owner = pendingOwner`.

Compared to `OwnableNoRenounce` (`base/OwnableNoRenounce.sol:38-103`), which
inherits OZ's Ownable2Step and overrides `_transferOwnership` to optionally enforce
contract-only ownership via `_ownerMustBeContract()` (DEEP-LIB-M1). TegridyTWAP's
inline impl predates this and does not connect to it.

Specifically, TWAP's owner controls `setMinReserveFloor`, `setUpdateFee`,
`setFeeRecipient`, `proposeAdminResetPair` / `executeAdminResetPair` —
i.e. it can reset a pair's TWAP observation buffer (admin-controlled rebootstrap of
the price oracle). A captured-then-handed-off owner (or one that
`transferOwnership(EOA)`s by mistake) installs an EOA owner who can:
- Set `updateFee` to `MAX_UPDATE_FEE` (0.01 ETH) to grief downstream consumers.
- Withdraw accumulated update fees to themselves (the EOA path of
  `withdrawFees`).
- Propose a `proposeAdminResetPair` to clear an inconvenient-to-them pair's
  observation buffer (24h timelock applies, so this is detectable but not blocked).

The two-step flow's pendingOwner-must-call-acceptOwnership requirement is the
defense — but pendingOwner is set instantly and there's no expiry, so a stale
pendingOwner from years ago can still call acceptOwnership today if the address is
still controlled.

**Impact:** Operational hardening gap. The acceptOwnership requirement is a real
defense against pure typo (an EOA that has no key is harmless). The risk surfaces
only under a specific scenario — owner sets pendingOwner to a contract, that contract
gets compromised or its multisig signers churn, and acceptOwnership is called years
later under attacker control.

**Fix sketch:**
- Add an expiry: `pendingOwnerExecuteAfter = block.timestamp + 7 days`, refuse
  `acceptOwnership` past that window. Mirrors the SwapFeeRouter
  `executeAdminReplacement` 7-day validity (`SwapFeeRouter.sol:1115`) and matches
  TegridyNFTPool's flow (`TegridyNFTPool.sol:531-580`, which DOES have an
  `OWNER_TIMELOCK` validity window).
- Optionally add a timelock between propose and accept (TegridyNFTPool uses
  `OWNER_TIMELOCK`, `L78`).

---

## F-43-G — `TegridyDropV2.transferOwnership` has no expiry on `pendingOwner`

**File:** `contracts/src/TegridyDropV2.sol:1087-1090`
**Function:** `transferOwnership(address newOwner)`
**Lens:** owner-only — gating is correct; gap is in lifecycle hardening.

TegridyDropV2 rolls its own 2-step transfer flow:
```text
TegridyDropV2.sol:1087    function transferOwnership(address newOwner) external onlyOwner {
TegridyDropV2.sol:1088        if (newOwner == address(0)) revert ZeroAddress();
TegridyDropV2.sol:1089        pendingOwner = newOwner;
TegridyDropV2.sol:1090    }
TegridyDropV2.sol:1092    function acceptOwnership() external {
TegridyDropV2.sol:1093        if (msg.sender != pendingOwner) revert NotOwner();
TegridyDropV2.sol:1094        owner = msg.sender;
TegridyDropV2.sol:1095        pendingOwner = address(0);
```

Same shape as F-43-F: no contract-only check on `newOwner`, no expiry on `pendingOwner`,
no timelock between propose and accept. The booby-trap-flush logic in
`acceptOwnership` (`L1096-1129`) cleans up MERKLE_ROOT_CHANGE / MINT_PRICE_CHANGE /
DUTCH_CONFIG_CHANGE proposals — which is good — but the underlying ownership flow
itself has no expiry.

The DropV2 owner controls `setMintPhase`, `proposeMerkleRoot`, `proposeMintPrice`,
`setBaseURI`, `freezeBaseURI`, `setContractURI`, `reveal`, `cancelDutchAuction`,
`pause`, `unpause`, `withdraw` (the proceeds path), `cancelSale`, and
`rescueAfterCancellation`. Many of these are timelocked, but `setMintPhase`,
`setBaseURI`, `freezeBaseURI`, `pause`, `unpause`, and `withdraw` are instant. A
stale pendingOwner that gets co-opted years later under attacker control can:
- Pause/unpause the contract to grief minters.
- Set the `baseURI` to a malicious-content URI before reveal.
- `withdraw` proceeds to the attacker (more concerning — `withdraw` sends to
  `creator` not `owner`, so this is mitigated by `creator` being immutable; need to
  verify the rest of the contract).

**Impact:** Same shape as F-43-F. The `withdraw` path's `creator` immutability
softens the cash-out vector, but pause/baseURI griefing and `cancelSale` are still
attacker leverage points.

**Fix sketch:** Add `pendingOwnerExecuteAfter` with a 7-day validity window or
inherit `OwnableNoRenounce`.

---

## F-43-H — `TegridyTWAP` and `TegridyDropV2` reimplement Ownable2Step instead of inheriting `OwnableNoRenounce`

**Files:**
- `contracts/src/TegridyTWAP.sol:46-76` (`TWAPAdmin`)
- `contracts/src/TegridyDropV2.sol:280-282` (the `onlyOwner` modifier)

Both contracts roll inline 2-step transfer flows. The `OwnableNoRenounce` base
(`base/OwnableNoRenounce.sol`) provides:
- `RenounceDisabled` typed error (vs the inline string `"RENOUNCE_DISABLED"` both
  inline impls use).
- The `_ownerMustBeContract()` opt-in hook that all production children can use
  to enforce contract-only ownership rotations (DEEP-LIB-M1).
- EIP-7702 detection that rejects `code.length == 23` 7702-delegation pointers,
  preventing post-Pectra (live as of 2025-05-07 per the M29 NatSpec) EOAs from
  sliding through any future contract-only check (`OwnableNoRenounce.sol:88-100`).

The two inline impls do not get any of these protections. F-43-F and F-43-G are
the immediate consequences; F-43-H is the structural root.

**Impact:** Defense-in-depth gap. Refactor risk if a future audit / fix targets
`OwnableNoRenounce` — both inline impls would need to be patched in parallel to stay
in sync with the base contract's hardening.

**Fix sketch:** Refactor both contracts to inherit `OwnableNoRenounce` (or the
clone-friendly equivalent for TegridyDropV2 since it's deployed via
`Clones.clone()` per `L218-219`). The clone constraint may rule out `immutable`
fields but does NOT preclude inheriting `OwnableNoRenounce` — its fields are all
storage.

---

## F-43-I — `claimUnsettledForTokenId` recipient is fully caller-controlled (trusted-caller pattern)

**File:** `contracts/src/TegridyStaking.sol:1627-1670`
**Function:** `claimUnsettledForTokenId(uint256 tokenId, address recipient)`
**Lens:** authorisation — the gate is correct, but the trust assumption is total.

The function is gated by `_isTrackedHolder(msg.sender)` — only `restakingContract`
or any whitelisted lending contract may call. The caller passes an arbitrary
`recipient` that receives the per-tokenId reward bucket payout. There is no further
gate on `recipient` — no "must equal the original depositor", no "must equal the NFT
owner".

This is by design (the calling lending / restaking contract handles its own
borrower/restaker authorisation upstream), but the consequence is that a bug or
exploit in EITHER `TegridyRestaking.unrestake` / `TegridyLending.repayLoan` /
`TegridyLending.claimDefaultedCollateral` / `TegridyLending.pullEscrowRewards` /
`TegridyNFTLending.repayLoan` / etc. that allows the attacker to specify the
`recipient` parameter on the call into staking flows the entire per-tokenId bucket
to the attacker.

The TegridyLending side correctly hard-codes `address(this)` (drains to lending,
then forwards to borrower/lender via the split logic — `L1120, 1132, 1272, 1284`).
The TegridyRestaking side passes `restaker` (which is `tokenIdToRestaker[tokenId]`,
a stored mapping the contract controls — `L1754, L1860, L1959`).

**Current state:** Both call-sites pass internally-controlled addresses. The
attacker has no leverage today.

**Impact:** Defense-in-depth gap. Any future change that relaxes the
TegridyLending or TegridyRestaking authorisation around `claimUnsettledForTokenId`
turns this into an attacker-controlled exfiltration vector. Documented here so the
trust boundary is explicit.

**Fix sketch:** Optional — add a defense-in-depth assertion that `recipient` is
either the NFT owner OR a lending-contract beneficiary recorded for this tokenId.
Adds gas and complexity for a defense-in-depth that today carries no exploitable
surface.

---

## F-43-J — `executeRemoveGaugeFinalize` is permissionless (intentional, but worth noting)

**File:** `contracts/src/GaugeController.sol:993-1011`
**Function:** `executeRemoveGaugeFinalize()`
**Lens:** permissionless — the contract NatSpec confirms intent.

This function has no `onlyOwner` modifier. The NatSpec at `L990-992` explicitly
says: "Permissionless because by the time current-epoch weight is zero, the gauge
is already disarmed (`isGauge == false`) and there's nothing to wait on."

The function checks:
- `pendingGaugeRemove != address(0)` (something is staged)
- `gaugeWeightByEpoch[currentEpoch()][gauge] == 0` (current-epoch weight is zero)
- `!isGauge[gauge]` (already disarmed)

Then it walks `gaugeList[]` (capped at MAX_TOTAL_GAUGES = 50) and prunes the entry.

Threat surface: an attacker can call this to finalise a removal slightly earlier
than a keeper — but the only effect is gauge removal that is already a foregone
conclusion. No state mutation outside the prune. No funds at risk.

**Verdict:** Not a finding. Documented here as a sanity-check of the permissionless
admin-shaped function (per the agent prompt's #1 directive).

---

## F-43-K — `TegridyTWAP.update` is permissionless and accepts unbounded ETH refunds (sanity check only)

**File:** `contracts/src/TegridyTWAP.sol:266-291`
**Function:** `update(address pair) external payable nonReentrant`
**Lens:** permissionless — by design, but worth noting the refund path.

`update` is permissionless (anyone can post observations). When `updateFee == 0`
(default), the function requires `msg.value == 0`:
```text
TegridyTWAP.sol:290    require(msg.value == 0, "FEE_NOT_SET");
```
When `updateFee > 0`, the function accepts `msg.value >= updateFee`, takes the
fee, and refunds the excess via raw `.call`:
```text
TegridyTWAP.sol:283-287   uint256 excess = msg.value - updateFee;
                          if (excess > 0) {
                              (bool ok,) = msg.sender.call{value: excess}("");
                              if (!ok) revert InsufficientFee();
                          }
```
Threat surface:
- Overpayment is refunded to msg.sender; if msg.sender is a contract with a heavy
  `receive`, the refund consumes gas. `nonReentrant` on the function prevents
  re-entry. The gas consumption is paid by msg.sender, not by the protocol.
- `accumulatedFees` is incremented before the refund; on refund failure, the
  function reverts and the increment is undone. Atomic.

**Verdict:** Not a finding. Documented as a sanity check.

---

## Notes / dead-ends explored (not findings)

- **TegridyPair.initialize** (`L103-111`): correctly gated by `factory` check and
  `_initialized` flag. Cannot be re-called.
- **TegridyNFTPool.initialize** (`L219-255`): gated by OZ `initializer` modifier
  (and the constructor calls `_disableInitializers` at `L216`). Clones are init
  exactly once.
- **TegridyDropV2.initialize** (`L377`): same OZ `initializer` pattern; gates the
  one-time setup on a clone.
- **Toweli** (entire file): no admin surface, immutable supply enforced at
  `_update` hook (`L116-122`). No access-control holes.
- **TegridyStakingJbacVault** (entire file): correctly gated. `returnJbac` is
  `onlyStaking`; `claimStrandedJbac` checks `msg.sender == strandedJbacOwner[id]`;
  `onERC721Received` rejects any ERC721 except the configured `jbacNFT`. Trust
  assumptions documented in NatSpec at `L20-31`.
- **TegridyFactory** (entire file): all admin-shaped functions either explicitly
  check `msg.sender == feeToSetter` or `msg.sender == guardian`. The
  `emergencyDisablePair` allows guardian OR feeToSetter — explicitly documented
  intent at `L495-510`. The `setGuardian` is one-shot (`L455-460`); subsequent
  rotations go through the 48h timelock.
- **TegridyRestaking._safeBonusTransferExt** (`L2127-2130`): self-call gated
  (`msg.sender == address(this)`). External callers cannot call directly.
- **VoteIncentives._safeTransferExternal** (`L1407-1410`): same self-call gate
  (`msg.sender == address(this)`). Used for try/catch from inside the contract.
- **PremiumAccess.activateNFTPremium** (`L208-213`): caller-implicit (acts on
  msg.sender's own state). No spoof risk.
- **PremiumAccess.deactivateNFTPremium** (`L231-238`): permissionless cleanup of
  stale activation; only succeeds when `block.timestamp > activation + 10 minutes`
  AND the user no longer holds a JBAC. NatSpec at `L218-229` documents the intent.
- **MemeBountyBoard.completeBounty** (`L566`): permissionless — fine, gated on
  voter consensus and submission validity, no funds-at-risk-to-caller.
- **CommunityGrants.executeProposal** (`L564`): permissionless — fine, gated on
  vote count and proposal status; pulls from the contract's own ETH balance and
  routes to recipient.
- **TegridyFeeHook.afterSwap** (`L320-438`): gated by `onlyPoolManager`. PoolKey
  is allowlist-checked via `approvedPools[h]`; non-approved pools return
  zero-fee instead of reverting (NatSpec rationale at `L327-335`).
- **TegridyFeeHook.claimFees** (`L491`): permissionless by design — fees always
  flow to revenueDistributor (NatSpec at `L454-460`).
- **TegridyNFTPoolFactory.createPool** (`L194-201`): permissionless creation —
  factory pattern, owner-of-pool is the creator. The factory enforces creation
  preconditions via `_validateInitialDeposit` (sibling — not investigated under
  this lens).
- **No selector clashes detected** in a manual scan of the function-name
  surface across all 30 contracts. Common names (`pause`, `unpause`, `claim*`,
  `withdraw*`, etc.) appear across many files but each lives in its own contract,
  so 4-byte selector collisions can't matter at the contract-instance boundary.
  Within any single contract, no two state-changing externals share a name. The
  only two-implementation overload is `withdrawProtocolFees` on
  `TegridyNFTPoolFactory.sol:593, 621` (one no-arg, one with a `uint256` cap) —
  these have distinct selectors by signature.

---

## Summary

11 findings, none critical, calibrated to lens-only severity:

| ID    | File                          | Class                                | Severity (lens)        |
| ----- | ----------------------------- | ------------------------------------ | ---------------------- |
| F-43-A | TegridyStaking.sol            | Missing proposal-validity expiry     | Low (DoS / lifecycle)  |
| F-43-B | TegridyStaking.sol            | Missing contract-only on rotation    | Low (admin DoS)        |
| F-43-C | SwapFeeRouter.sol             | Missing contract-only on first-set + rotation | Low (admin DoS) |
| F-43-D | TegridyLending.sol            | No admin rotation path at all        | Low (operational)      |
| F-43-E | GaugeController/VoteIncentives/ReferralSplitter/MemeBountyBoard | Missing contract-only on one-shot setRestakingContract | Info (silent degradation) |
| F-43-F | TegridyTWAP.sol               | Inline Ownable2Step lacks expiry / contract check on transferOwnership | Info |
| F-43-G | TegridyDropV2.sol             | Same as F-43-F on the clone-deployed Drop | Info               |
| F-43-H | TegridyTWAP / TegridyDropV2   | Should inherit `OwnableNoRenounce`   | Info (refactor)        |
| F-43-I | TegridyStaking.sol            | claimUnsettledForTokenId recipient is caller-controlled | Info (defense-in-depth) |
| F-43-J | GaugeController.sol           | Permissionless `executeRemoveGaugeFinalize` (intentional) | Sanity check |
| F-43-K | TegridyTWAP.sol               | Permissionless `update` ETH refund (intentional)        | Sanity check |

Primary themes:
1. **Inconsistent admin-rotation patterns across sister contracts.** Three near-
   identical "owner-controls-an-admin-contract" wirings exist (TegridyStaking,
   SwapFeeRouter, TegridyLending) with three different lifecycles. Both fixes —
   adding a 7-day validity to TegridyStaking's executeAdminReplacement and a
   rotation path to TegridyLending — would normalise the pattern.
2. **Missing `code.length > 0` checks on rotation/wire paths.** The first-time
   setters for staking and lending get this right. The rotation paths and the
   `setRestakingContract` setters do not.
3. **Two contracts (TegridyTWAP, TegridyDropV2) reimplement Ownable2Step inline
   instead of inheriting `OwnableNoRenounce`** — divergence risk during future
   base-contract hardening.

No selector clashes, no missing modifiers on user-funds paths, no permissionless
admin-shaped functions that mutate sensitive state. All `pause()` functions are
properly `onlyOwner`. No tx.origin substitutions found.

Path: `.audit_2026_freshlook/findings/agent_43_access_control.md`
