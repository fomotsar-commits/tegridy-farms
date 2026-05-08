# Agent 04 — TegridyRestaking Reward Forwarding & Fee-Skim Audit

Target: `contracts/src/TegridyRestaking.sol` (2131 lines)
Scope: Reward forwarding, harvest path, slippage on compound, fee skim, performance fee, reward router whitelist gaps, approval residue, callback re-entrancy, reward-token migration, empty-reward / spam DoS.

Methodology: Fresh-eyes review against the project lens prompt. The contract turned out to be a **bonus-token accumulator + base-reward forwarder**, with NO swap router, NO performance fee, NO compounding, and NO harvest. The bonus pool is funded out-of-band by `fundBonus()` and emitted on a constant-rate schedule. So most of the lens items (sandwich, amountOutMin=0, router whitelist, approval residue) DO NOT APPLY here. The realised attack surface lives around:

- Reward-token vs bonus-token unit confusion in fallback paths.
- Blacklist / hostile-token DoS on user-side claim transfers.
- Permanent re-restake lockout via abandoned residual claimant.
- `rescueNFT` constraint that targets a non-receiver address.

---

## F-04-1 — Wrong-token credit when `decayExpiredRestaker` falls back

Severity: HIGH
Location: `contracts/src/TegridyRestaking.sol:1965-1982`

`decayExpiredRestaker(_restaker)` is permissionless. When it settles the
restaker's pending bonus, it wraps the bonus transfer in a self-call
`this._safeBonusTransferExt(_restaker, bonusPending)` with try/catch. On revert
(blacklist, ERC777 hook, paused token, OFAC tag, etc.) the catch arm credits
the deferred amount into `unforwardedBaseRewards` — a TOWELI-denominated bucket:

```solidity
try this._safeBonusTransferExt(_restaker, bonusPending) {
    totalBonusDistributed += bonusPending;
    emit BonusClaimed(_restaker, bonusPending);
} catch {
    unforwardedBaseRewards[_restaker] += bonusPending;   // <-- bonus units
    totalUnforwardedBase += bonusPending;                 //     credited as
    emit BonusTransferDeferred(_restaker, bonusPending); //     TOWELI debt
}
```

Every consumer of `unforwardedBaseRewards` then redeems in `rewardToken`
(TOWELI), not `bonusRewardToken`. See:

- `claimAll` L919-932: `rewardToken.safeTransfer(msg.sender, actual)`
- `unrestake` L1163-1174: `rewardToken.safeTransfer(msg.sender, actual)`
- `emergencyWithdrawNFT` L1625-1636: `rewardToken.safeTransfer(msg.sender, actual)`
- `recoverStuckPrincipal` L1475-1485: `rewardToken.safeTransfer(msg.sender, paid)`
- `emergencyForceReturn` L1721-1732: `rewardToken.safeTransfer(restaker, actual)`
- `revalidateBoostFor*` L1842-1843, L1892-1893: write side increments same bucket
  (these are NOT wrong-token because they came from staking.getReward → TOWELI).

Concrete impact when bonusToken = WETH and rewardToken = TOWELI:
1. Alice has `bonusPending = 5 WETH` (in 18-dec units, value ~$10k+).
2. Alice gets blacklisted by WETH (or, more realistically, bonusToken = USDC
   and Alice triggers OFAC). Her bonus transfer reverts.
3. Bob calls `decayExpiredRestaker(Alice)` (permissionless).
4. Catch fires; `unforwardedBaseRewards[Alice] += 5e18` is recorded.
5. Alice removes blacklist, calls `claimAll()`. She receives **5 TOWELI**
   (worth ~$0.50 if TOWELI is sub-dollar) instead of 5 WETH (~$10k).
6. The 5 WETH stays trapped in the bonus pool, no longer attributed to anyone
   (`totalBonusDistributed` was never incremented for this slice).
7. Other restakers' bonus accrual continues unchanged — the 5 WETH IS still
   in `bonusRewardToken.balanceOf(this)`, so future `_accrueBonus` will count
   it as available. Effectively, Alice's bonus is silently donated back to the
   pool, AND the contract pays Alice 5 TOWELI from the unrelated base-reward /
   principal-recovery pool.

Cross-contamination: `totalUnforwardedBase` is increased by 5e18 (WETH units),
which is then subtracted from the unattributed pool in
`recoverStuckPrincipal` (L1441) and `executeAttributeStuckRewards` (L1527).
This silently shrinks the recoverable pool that backs HONEST force-closed
users' principal — a second-order DoS on `recoverStuckPrincipal`.

Trigger conditions:
- Restaker is on a sanctions list for `bonusRewardToken`.
- Restaker is a contract whose receive hook reverts.
- Restaker has a 7702-delegated EOA whose authority script reverts on inbound.
- `bonusRewardToken` is paused.

For a malicious actor: ONLY profitable if they value TOWELI (per unit) more
than they value the equivalent unit of bonusToken. Most realistic attack is
"loss-prevention insurance" — Alice's bonus is going to be slashed by an
OFAC blacklist, so she ROUTES the loss into `unforwardedBaseRewards` to at
least extract pennies-on-the-dollar in TOWELI. Net protocol loss: ~5 TOWELI
plus Alice's permanent forfeit of 5 WETH. The WETH becomes phantom inventory.

Recommendation: split `unforwardedBaseRewards` into two buckets — one for
bonus-token-denominated deferred credits and one for reward-token. Mirror in
`totalUnforwardedBase` accounting and in the redemption sites (claimAll /
unrestake / emergency / recoverStuckPrincipal). Or, simpler: do NOT route
bonus-transfer failures into `unforwardedBaseRewards`; instead leave the
transfer responsibility on the restaker's side and only roll back the bonus
debt anchor (i.e., credit them via a `pendingBonus[user]` mapping that pays
back in `bonusRewardToken`).

---

## F-04-2 — `rescueNFT` cannot rescue stranded NFTs (target rejects ERC721 receiver)

Severity: MEDIUM
Location: `contracts/src/TegridyRestaking.sol:1675-1679`
        and `contracts/src/TegridyStaking.sol:82` (no `IERC721Receiver` impl)

`rescueNFT` is constrained to send to `address(staking)` only:

```solidity
function rescueNFT(uint256 _tokenId, address _to) external onlyOwner {
    if (tokenIdToRestaker[_tokenId] != address(0)) revert BadParam();
    if (_to != address(staking)) revert BadParam();
    stakingNFT.safeTransferFrom(address(this), _to, _tokenId); // M-16
}
```

`stakingNFT.safeTransferFrom` follows solady's ERC721 contract which calls
`_checkOnERC721Received` whenever `_hasCode(to) == true`. `address(staking)` is
the SoladyERC721 implementation itself — it has code but does NOT implement
`onERC721Received` (the inheritance chain `SoladyERC721, OwnableNoRenounce,
ReentrancyGuard, Pausable` carries no `IERC721Receiver`). `_checkOnERC721Received`
will revert with `TransferToNonERC721ReceiverImplementer`.

Consequence: any tsTOWELI NFT that lands in TegridyRestaking out-of-band
(direct `safeTransferFrom` from the user, bypassing `restake()`) is permanently
stuck. The contract's `onERC721Received` ALLOWS arbitrary deposits:

```solidity
function onERC721Received(address, address, uint256, bytes calldata) external view override returns (bytes4) {
    if (msg.sender != address(staking)) revert OnlyStakingNFT();
    return IERC721Receiver.onERC721Received.selector;
}
```

The check is on `msg.sender == staking` — i.e., "the ERC721 contract calling
this hook is the right one" — which is always true for tsTOWELI inbound. So
ANYONE can deposit a tsTOWELI directly to the restaking contract via
`stakingNFT.safeTransferFrom(themselves, restaking, tokenId)`. There is no
restakers[] entry; the NFT is dead weight.

Mitigation paths considered (all blocked):
- `rescueNFT(tokenId, address(staking))` reverts on receiver check.
- `rescueNFT(tokenId, anywhere_else)` reverts on the constant check at L1677.
- No other admin function can move it.

Permanent fund loss for whoever sent the NFT (typically the legitimate owner
who fat-fingered a transfer instead of calling `restake()`). The NFT carries
the underlying staked TOWELI principal and accrued staking-side rewards; both
are lost.

Recommendation: either (a) drop the `_to != address(staking)` constraint
and route to `_to`-passed-by-owner with stronger guard rails (e.g., 24h
timelock, like `proposeAttributeStuckRewards`), or (b) add an
`onERC721Received` to TegridyStaking that simply returns the selector
(making it an idempotent self-pass-through — there's no re-entry vector
because the staking contract knows tokenId is one of its own tokens).
Option (b) is safer; option (a) reverts a prior J1-H18 hardening.

---

## F-04-3 — Permanent re-restake lockout via abandoned residual claimant

Severity: LOW (DoS / feature loss, not fund loss)
Location: `contracts/src/TegridyRestaking.sol:606-611`, `1236-1247`, `1256-1303`

When a restaker (Alice) unrestakes while the staking-side reward pool is
under-funded, `_reserveResidual(tokenId, msg.sender)` records Alice as the
exclusive `_residualClaimant[tokenId]`. The restake() guard at L610-611
blocks any non-Alice re-restaker as long as `staking.unsettledRewardsByTokenId(_tokenId) > 0`:

```solidity
if (claimant != address(0) && claimant != msg.sender
    && staking.unsettledRewardsByTokenId(_tokenId) > 0) revert TokenIdHasPendingResidual();
```

Three lockout scenarios:

1. Alice loses keys / dies. The residual stays > 0 forever (unless drained
   externally). New owner Bob cannot restake the NFT in this contract — only
   via TegridyStaking. He keeps base-staking emissions but cannot accumulate
   bonus yield until pool replenishes AND someone (only Alice) calls
   `claimResidualForTokenId(tokenId)` to clear it.

2. Alice unrestakes successfully, then calls `staking.emergencyExitPosition`
   on the underlying NFT (which `_burn`s tokenId). `unsettledRewardsByTokenId[tokenId]`
   stays non-zero in the staking-side mapping (it's never cleared on burn).
   `claimResidualForTokenId(tokenId)` then reverts on `staking.ownerOf(tokenId)`
   (L1281) — the NFT was burned. `_residualClaimant[tokenId]` is never cleared.
   Bob mints a NEW tsTOWELI by re-staking TOWELI; he gets a different tokenId,
   so this lockout doesn't bite for HIM, but the original tokenId is dead.
   No real damage in practice, but the mapping accumulates dust.

3. The token is in TegridyLending escrow when Alice (claimant) tries to drain.
   `claimResidualForTokenId` returns 0 with `ResidualPullDeferredCrossHolder`
   event (L1281-1287). This is correct behavior, but the residual stays parked
   indefinitely if the borrower never repays.

There is NO admin override to clear `_residualClaimant`. If the project ever
needs to retire a tokenId from the residual map (e.g., the residue was
recovered through some other mechanism), there is no path.

Recommendation: add an owner-callable, 24h-timelocked
`adminClearResidualClaim(tokenId)` that wipes `_residualClaimant[tokenId]`
when `staking.unsettledRewardsByTokenId(tokenId) == 0`. Pattern of record:
TimelockAdmin already in place; reuse it.

---

## F-04-4 — Dead storage: `RestakeInfo.unsettledSnapshot` written, never read

Severity: INFO (gas / clarity)
Location: `contracts/src/TegridyRestaking.sol:107`, `640`, `647`

`RestakeInfo.unsettledSnapshot` was added per AUDIT H-06 as the baseline for
`unrestake`'s "delta attribution" path. After the C-1 per-tokenId attribution
refactor (`claimUnsettledForTokenId`), the delta-snapshot path is dead — every
unrestake / emergencyWithdrawNFT / emergencyForceReturn now uses per-tokenId
pulls instead. The field is written on every `restake()` (consuming an SSTORE
gas slot ~20k on first write) and never read anywhere in the contract.

```bash
grep -n "unsettledSnapshot" contracts/src/TegridyRestaking.sol
107:        uint256 unsettledSnapshot;...
647:            unsettledSnapshot: unsettledAtDeposit
```

No security impact. Pure dead-code clutter. Removing it would save ~20k gas
per `restake()` and ~5k per re-restake, AND simplify the audit surface.

Recommendation: drop the field from `RestakeInfo`, drop the
`uint256 unsettledAtDeposit = staking.unsettledRewards(address(this))` call
at L640, drop the storage write at L647. Storage layout MUST be preserved if
this is on a live deploy with proxy semantics — but TegridyRestaking is an
immutable, non-upgradable contract per the constructor pattern, so removal is
safe.

---

## F-04-5 — `claimAll` / `unrestake` revert if user is blacklisted on rewardToken

Severity: LOW (escape hatch exists)
Location: `contracts/src/TegridyRestaking.sol:865`, `929`, `1047`, `1058`,
        `1154`, `1171`

The base-reward forward at L865 (claimAll) and L1047 (unrestake) — and the
bonus-reward forwards at L944 (claimAll) and L1058 (unrestake) — are NOT
wrapped in try/catch. If `msg.sender` is blacklisted on `rewardToken` (e.g.,
USDC sanctions, future-state TOWELI blacklist) OR on `bonusRewardToken`
(WETH-extended, USDC, etc.), the safeTransfer reverts and the entire
function reverts.

User flows:
- `claimAll` reverts → user cannot collect rewards. Funds stay in this
  contract. Alternative paths: emergencyWithdrawNFT (forfeits bonus, retains
  NFT but no reward forwarding to user — so STILL reverts on
  `claimUnsettledForTokenId`'s `safeTransfer(recipient, paid)` at staking L1667
  if user is blacklisted on rewardToken).
- `unrestake` reverts → user cannot retrieve NFT. They MUST use
  `emergencyWithdrawNFT` which doesn't transfer bonus (L1550-1639 has no
  bonusRewardToken.safeTransfer call). But the path STILL calls
  `staking.claimUnsettledForTokenId(tokenId, msg.sender)` (L1569, L1590) which
  transfers TOWELI to user — reverts if user is blacklisted on TOWELI.
  Try/catch on those calls (yes — L1571, L1592) handles the staking-side
  revert gracefully. So `emergencyWithdrawNFT` is a working escape for
  rewardToken-blacklisted users.

Net result: a user blacklisted on EITHER token can always exit via
`emergencyWithdrawNFT` (forfeiting bonus). Permanent fund loss for them on
the bonus side; no other-user impact.

Practical concern: TOWELI is the protocol's own token, presumed
non-blacklisting. Bonus token is admin-set and could be USDC/USDT/WETH-with-
blacklist. This is a governance risk — admins SHOULD pick a token without
blacklist semantics.

Recommendation: defense-in-depth — wrap user-side reward and bonus transfers
in try/catch on the user-facing claim path, routing failures to a per-user
`pendingBonusDeferred[user]` and `pendingBaseDeferred[user]` mapping the user
can self-claim later (after un-blacklisting). The `decayExpiredRestaker` path
(L1974-1982) already adopts this pattern for the bonus side, but with the
wrong-token bug noted in F-04-1.

---

## F-04-6 — `recoverStuckPrincipal` reverts when fully reserved, blocking
              user's `unforwardedBaseRewards` claim

Severity: LOW
Location: `contracts/src/TegridyRestaking.sol:1449`

`recoverStuckPrincipal` reverts if `payout == 0` (L1449). The `payout` is
derived from `recoverable = balance - reserved`, where `reserved` includes
all OTHER active restakers' principal. If the contract's TOWELI balance is
fully accounted for by other users, the caller's payout is 0 and the function
reverts WITHOUT paying the caller's `stuckBase` (their personal share of
`unforwardedBaseRewards`, paid out at L1475-1485 LATER in the same function).

Consequence: a force-closed user whose principal is currently un-recoverable
(due to other-user reservations) ALSO cannot claim their pre-existing
`unforwardedBaseRewards` slice via this entrypoint.

Mitigation: the user can call `unrestake()` instead (L961). `unrestake` calls
the same `unforwardedBaseRewards` sweep at L1164-1174 without the reservation
gate. But `unrestake` requires `info.tokenId != 0` — true for force-closed
positions (positionAmount went to 0, but tokenId persists in restakers[]).
`unrestake` then attempts `stakingNFT.safeTransferFrom(this, msg.sender, tokenId)`
at L1108 — if the underlying staking NFT was burned externally (which it
ISN'T in current force-close flow, since restaking owns the NFT), this would
fail. Otherwise, `unrestake` succeeds and the user collects their unforwarded
base rewards.

So the user has a workaround. Severity LOW.

Recommendation: split the early revert at L1449 into two checks: revert only
when BOTH `payout == 0` AND `unforwardedBaseRewards[msg.sender] == 0`.
Otherwise, skip the principal payout and proceed to the `stuckBase` sweep.

---

## F-04-7 — Asymmetric bonus rate cap: constructor 10e18 vs proposal 100e18

Severity: INFO
Location: `contracts/src/TegridyRestaking.sol:180`, `318`

```solidity
uint256 public constant MAX_BONUS_REWARD_RATE = 100e18;       // L180
...
if (_bonusRewardPerSecond > 10e18) revert BadParam();           // L318
```

Constructor caps the initial rate at 10e18 (10 tokens/sec) but
`proposeBonusRate` (L1333) permits up to `MAX_BONUS_REWARD_RATE = 100e18`.
After deploy, owner can ratchet the rate up 10x via the 48h timelock. Either
the deploy-time cap is too strict OR the upper cap is too loose. Probably
the latter — 100 tokens/second of bonus emission is enormous (3.15B/year on
an 18-dec token).

Note: emission is bounded by `bonusRewardToken.balanceOf(this)` at runtime
(L348, L2071), so the rate can never over-mint the funded pool. The cap is
about long-term economic plausibility, not solvency.

Recommendation: align the two caps. Either both at 10e18 or both at 100e18.

---

## F-04-8 — `_safeBonusTransferExt` self-call lacks nonReentrant; relies on outer guard

Severity: INFO (no exploit identified)
Location: `contracts/src/TegridyRestaking.sol:2127-2130`

```solidity
function _safeBonusTransferExt(address to, uint256 amount) external {
    if (msg.sender != address(this)) revert OnlyStakingNFT(); // reuse error for size
    bonusRewardToken.safeTransfer(to, amount);
}
```

Marked `external`, gated to `address(this)` only, NO `nonReentrant`. The only
caller is `decayExpiredRestaker` which IS `nonReentrant`. The OZ
ReentrancyGuard uses a single `_status` slot; an outer-guarded function can
make external self-calls only if the inner function does NOT also try to
take the guard (it would fail with `ReentrancyGuardReentrantCall`). Skipping
the guard on `_safeBonusTransferExt` is therefore CORRECT and load-bearing
for the try/catch wrapper to function.

Risk: if a future refactor adds `nonReentrant` to `_safeBonusTransferExt`,
the entire decay-with-blacklisted-recipient path will revert outright,
silently breaking the fallback mechanism. Add a comment to lock the design:
"NEVER add nonReentrant — required for self-call try/catch wrapping by
decayExpiredRestaker".

---

## F-04-9 — `emergencyWithdrawNFT` calls `claimUnsettledForTokenId`
              post-transfer-success but body of try is loosely structured

Severity: INFO (correctness — works but confusing)
Location: `contracts/src/TegridyRestaking.sol:1588-1594`

```solidity
uint256 postPaid;
if (emNftDelivered)
try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) {
    postPaid = _p2;
} catch {
    postPaid = 0;
}
```

The `if (emNftDelivered)` guard is on the same logical line as the `try`,
without explicit braces. Solidity parses this as `if (emNftDelivered) { try ... }`
because `try` is a statement. Verified — this is structurally correct. But
the formatting differs from the `unrestake` analog at L1119-1126 which uses
explicit braces. Stylistic inconsistency; not exploitable.

Recommendation: add explicit braces for clarity. No security impact.

---

## Notes / dead-ends

- **No swap path**: TegridyRestaking does NOT perform any AMM swaps,
  compounding, or harvest. The bonus pool is funded externally via
  `fundBonus()`. The lens items "amountOutMin=0", "sandwich the harvest
  swap", "router whitelist gaps", "approval residue", "untrusted callback in
  swap router" do NOT apply here. Suggest the swap-path attack lens move to
  POLAccumulator / SwapFeeRouter / TegridyRouter for relevance.

- **No performance fee**: there is no protocol skim on bonus or base
  rewards. `totalBonusFunded` and `totalBonusDistributed` are informational.
  The "fee skim" / "performance fee siphon" lens items don't bite here.
  Closest analog is `proposeAttributeStuckRewards` which is gated by 24h
  timelock + `balance - reserved` cap (L1527 — checked correctly).

- **No reward router whitelist**: rewards flow staking → restaking →
  user. No external swap router. No allowed-target list. The reward token
  cannot be migrated mid-flight because both `rewardToken` and
  `bonusRewardToken` are `immutable`.

- **No fee-on-transfer / rebasing tokens issue confirmed**: every
  `safeTransfer` from this contract uses raw amounts; there's no `balanceOf`
  delta accounting on the SEND side. On RECEIVE side, `revalidateBoost*`
  uses balance-delta correctly (L1834-1840, L1884-1890), so an FoT base
  reward token would correctly credit only the actual received amount.
  However `fundBonus` (L1311) credits `_amount` to `totalBonusFunded`
  WITHOUT balance-delta accounting — for an FoT bonus token, this would
  over-count `totalBonusFunded` (informational only, no security).

- **Empty-reward edge**: `claimAll` works fine with 0 rewards (no revert
  in the path). `getReward` returns 0 cleanly per staking L1428. No DoS via
  spam — caller pays gas, no external grief.

- **Harvest frequency spam**: `decayExpiredRestaker` is permissionless but
  reverts with `NoDecay` after the first call (L1951). `claimAll` /
  `refreshPosition` charge the caller for gas. No reset of bonus rate via
  spam. `_accrueBonus` advances `lastBonusRewardTime` only forward.

- **Forwarding pattern that re-enters claim**: every claim path uses CEI
  (debt anchored before transfer) AND `nonReentrant`. Cross-contract calls
  to `staking.getReward` are external but `staking.getReward` is also
  `nonReentrant`. No re-entrant claim path identified.

- **Approval residue**: `safeTransferFrom` is used only for the NFT and
  `fundBonus`. No long-lived approvals to external routers. Restaking
  contract holds no token approvals.

- **R014 / R017 retry path**: extensively documented in code comments. The
  stale-vs-non-stale branching in `claimAll` / `unrestake` / `refreshPosition`
  / `decayExpiredRestaker` is consistent: settle pending bonus on OLD
  boost at PRE-accrue, anchor `bonusDebt` BEFORE transfer (CEI), then accrue
  against the corrected denominator, then re-anchor at POST-accrue. Verified
  by tracing each entrypoint. No new findings here.

- **Cross-contract `_isTrackedHolder` invariant**: TegridyStaking treats
  TegridyRestaking as a tracked holder. Per-tokenId attribution
  (`unsettledRewardsByTokenId`) is maintained in lockstep. Verified by
  inspecting the staking-side write sites (L1130, L1148, L1527 in staking).
  No race between restaking's `claimUnsettledForTokenId` and lending's
  same call — token can only be in ONE holder at a time (NFT transfers are
  atomic).

- **Bonus token migration**: NOT POSSIBLE. `bonusRewardToken` is
  `immutable`. The only way to "migrate" is to deploy a new restaking
  contract.

- **Fee-on-transfer on bonus token**: `fundBonus` (L1311) does
  `safeTransferFrom(msg.sender, this, _amount)` and increments
  `totalBonusFunded += _amount`. For an FoT bonus token, the contract
  receives less than `_amount` — the `totalBonusFunded` counter overstates
  funding. Real emission is bounded by `balanceOf(this)` so no
  OVER-distribution; just informational drift. Same for `fundBonus`
  contributors (typically owner) being aware of the FoT impact. Negligible.

---

## Summary

Findings (severity descending):
- **F-04-1 HIGH** — `decayExpiredRestaker` falls back into wrong-token bucket
  (`unforwardedBaseRewards` is rewardToken-denominated; bonus-transfer
  failures dump `bonusPending` units in there). Concrete user/protocol fund
  divergence.
- **F-04-2 MEDIUM** — `rescueNFT` constrained to `address(staking)` but
  staking does not implement `IERC721Receiver`; rescue path always reverts.
  Stranded NFTs (sent direct to restaking, not via `restake()`) are
  permanently lost.
- **F-04-3 LOW** — Permanent re-restake lockout via lost-key residual
  claimant. No admin override to clear `_residualClaimant`.
- **F-04-4 INFO** — Dead storage `unsettledSnapshot` (write-only post-C-1
  refactor).
- **F-04-5 LOW** — `claimAll` / `unrestake` revert on user-blacklist; escape
  via `emergencyWithdrawNFT` exists.
- **F-04-6 LOW** — `recoverStuckPrincipal` reverts when fully reserved,
  blocking the user's `unforwardedBaseRewards` collection at the same call.
- **F-04-7 INFO** — Asymmetric bonus rate cap (deploy 10e18 vs propose
  100e18).
- **F-04-8 INFO** — `_safeBonusTransferExt` lacks nonReentrant by design;
  add comment to prevent regression.
- **F-04-9 INFO** — Stylistic inconsistency in `emergencyWithdrawNFT`
  try/catch braces.

Most lens items (slippage, sandwich, router, performance fee, approval
residue) do not apply because TegridyRestaking has no swap/router/fee logic.
The contract is a constant-rate accumulator + base-forwarder, with
extensive R014/R017 retry hardening already in place.
