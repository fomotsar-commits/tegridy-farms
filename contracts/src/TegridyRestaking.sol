// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
// EIP-170 split (2026-05-30): pendingBase delegates to StakingMonitorView since
// `earned(uint256)` moved off TegridyStaking into the read-only sister.
import {StakingMonitorView} from "./StakingMonitorView.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";

interface ITegridyStaking {
    function getReward(uint256 tokenId) external returns (uint256 claimed);
    function toggleAutoMaxLock(uint256 tokenId) external;
    function claimUnsettled() external;
    function unsettledRewards(address user) external view returns (uint256);
    /// @dev AUDIT FIX C-1: per-tokenId attribution claim. Pulls only the
    ///      `unsettledRewardsByTokenId[tokenId]` slice (capped by holder bucket
    ///      and reward pool) and transfers directly to `recipient`. Replaces
    ///      the racy `claimUnsettled()` / snapshot-delta flow so two restakers
    ///      with kick credits in the same bucket no longer race for each
    ///      other's share. Returns the actual amount transferred.
    function claimUnsettledForTokenId(uint256 tokenId, address recipient) external returns (uint256 paid);
    /// @dev REVIEW C-1-FINDING-1/2: per-tokenId attribution view, used by the
    ///      residual-reservation path in unrestake/emergencyWithdraw* to detect
    ///      pool-shortfall residue.
    function unsettledRewardsByTokenId(uint256 tokenId) external view returns (uint256);
    function earned(uint256 tokenId) external view returns (uint256);
    function revalidateBoost(uint256 tokenId) external; // M-26
    /// @dev AUDIT FIX 2026-05-16 H2: permissionless kick triggers
    ///      `_decayIfExpired` on the underlying position. Restaking-side stale
    ///      paths call this via try-catch BEFORE reading `staking.positions`
    ///      so lazy decay fires and the stale-detect flag triggers correctly
    ///      on the restaker's OWN actions (closes the dilution case where the
    ///      restaker's lock expired but staking-side `boostedAmount` cache
    ///      was still inflated). Reverts `NoOpKick` on non-expired or already-
    ///      decayed positions — try-catch absorbs.
    function kick(uint256 tokenId) external;
    /// @dev AUDIT FIX: DEEP-DR-11 — defense-in-depth ownership check to mirror
    ///      the per-owner enumerable set added in M13. A future TegridyStaking
    ///      upgrade that wraps ownership through a proxy or share-token would
    ///      still pass `ownerOf` but may diverge from the staking contract's
    ///      authoritative `_positionsByOwner` set. Cheap belt-and-suspenders
    ///      for `restake`.
    function holdsToken(address user, uint256 tokenId) external view returns (bool);
    /// @dev AUDIT FIX LD-NEW-H1 mirror: surface ownerOf so claimResidualForTokenId
    ///      can refuse to drain when the NFT is currently held by ANOTHER tracked
    ///      holder (e.g. TegridyLending). See `claimResidualForTokenId` for the
    ///      full cross-holder attack chain.
    function ownerOf(uint256 tokenId) external view returns (address);
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint256 lockEnd,
        uint256 boostBps,
        uint256 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost,
        uint256 stakeTimestamp,
        uint256 jbacTokenId,
        bool jbacDeposited
    );
}

/// @title TegridyRestaking — Restake your tsTOWELI NFT for additional yield
/// @notice Deposit your TegridyStaking NFT (tsTOWELI) to earn BONUS rewards
///         on top of your base staking rewards.
///
///         How it works:
///         1. You stake TOWELI in TegridyStaking → get tsTOWELI NFT
///         2. You deposit that NFT here → this contract holds it
///         3. You earn base staking rewards (auto-claimed by this contract)
///            PLUS bonus restaking rewards from a separate reward pool
///         4. Withdraw anytime → get your NFT back
///
///         The bonus yield comes from protocol fees, incentive programs,
///         or funded reward pools — separate from base staking emissions.
///
///         Think of it like:
///         - Base staking = earning interest on a savings account
///         - Restaking = lending your savings certificate for extra yield
contract TegridyRestaking is OwnableNoRenounce, ReentrancyGuard, Pausable, IERC721Receiver, TimelockAdmin, PauseGuardian {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    /// AUDIT FIX (BATCH-N1 M1): bumped from 1e12 to 1e18 (same as TegridyStaking).
    /// Modern share-accumulator precision standard.
    uint256 private constant ACC_PRECISION = 1e18;

    // ─── TimelockAdmin Keys ──────────────────────────────────────────
    bytes32 public constant BONUS_RATE_CHANGE = keccak256("BONUS_RATE_CHANGE");
    bytes32 public constant ATTRIBUTION_CHANGE = keccak256("ATTRIBUTION_CHANGE");
    /// @notice AUDIT FIX FRESH-2026: M-4 [F-04-2] — timelock key for rescueNFT.
    bytes32 public constant RESCUE_NFT_CHANGE = keccak256("RESCUE_NFT_CHANGE");

    // ─── State ──────────────────────────────────────────────────────
    IERC20 public immutable rewardToken;       // TOWELI
    IERC20 public immutable bonusRewardToken;  // ETH (WETH) or any ERC20 for bonus
    ITegridyStaking public immutable staking;  // TegridyStaking contract
    IERC721 public immutable stakingNFT;       // tsTOWELI NFT (same address as staking)
    StakingMonitorView public immutable monitor; // EIP-170 sister: earned(tokenId), etc.

    uint256 public bonusRewardPerSecond;
    uint256 public lastBonusRewardTime;
    uint256 public accBonusPerShare;
    uint256 public totalRestaked;              // Sum of all deposited boosted amounts (used for bonus reward distribution)

    // AUDIT FIX FRESH-2026: F-04-4 (INFO) — `unsettledSnapshot` is preserved
    // for the auto-getter ABI contract that 40+ test sites bind by tuple
    // shape. The field is write-only post-C-1 attribution refactor (no live
    // reader); removal saves ~22k gas per `restake()` but breaks the public
    // getter shape. Kept as documented dead-state with the SSTORE site
    // dropped at the `restake()` call site below (the staking.unsettledRewards
    // external call that fed it is now a `0` literal). Net effect: ~2.6k
    // gas saved (no external call), full ABI compatibility preserved. The
    // field stays at 0 forever — the getter returns 0 on every read, which
    // is consistent with no consumer expecting a meaningful value.
    struct RestakeInfo {
        uint256 tokenId;          // The tsTOWELI NFT token ID
        uint256 positionAmount;   // Amount of TOWELI in the position (cached)
        uint256 boostedAmount;    // Boosted amount (cached for reward calc)
        int256 bonusDebt;         // Bonus reward debt
        uint256 depositTime;      // When NFT was deposited
        uint256 unsettledSnapshot;// AUDIT FIX FRESH-2026: F-04-4 — preserved
                                  // for ABI compat (always 0 post-fix; the
                                  // delta-attribution flow it once fed was
                                  // replaced by per-tokenId attribution).
    }

    mapping(address => RestakeInfo) public restakers;
    mapping(uint256 => address) public tokenIdToRestaker; // reverse lookup

    /// @notice REVIEW C-1-FINDING-1/2/3: post-exit residual claimant for tokens
    ///         whose `unsettledRewardsByTokenId` could not be fully drained during
    ///         unrestake / emergencyWithdrawNFT / emergencyForceReturn (e.g. because
    ///         the staking reward pool was under-funded at exit time).
    ///
    ///         Pre-fix the residual stayed silently in `staking.unsettledRewardsByTokenId[tokenId]`
    ///         and the next entity to restake the SAME tokenId would drain it on
    ///         their next unrestake — a covert leak from the original restaker to
    ///         whoever later acquires the NFT.
    ///
    ///         With this mapping the original restaker (or `restaker` for the
    ///         force-return path) keeps an exclusive claim. `restake()` rejects
    ///         attempts to re-restake a tokenId with a residual claim from a
    ///         different account; `claimResidualForTokenId(tokenId)` lets the
    ///         claimant pull their residue once the staking pool is replenished.
    /// @dev AUDIT FIX (pass-8): EIP170-04 — visibility lowered to `internal`.
    ///      Zero on-chain consumers; off-chain readers can use the
    ///      ResidualClaimant* events to track. Saves ~80B (autogenerated getter).
    /// @dev AUDIT FIX (pass-8 followup): ABI shim re-exposed via the public view
    ///      `residualClaimant(tokenId)` below — the audit test surface binds the
    ///      auto-getter shape by name. Internal slot uses leading underscore.
    mapping(uint256 => address) internal _residualClaimant;

    /// @notice AUDIT FIX (BATCH-C H5, mirrors TegridyStakingJbacVault.strandedJbacOwner):
    ///         Records the entitled recipient when an NFT-out transfer (`unrestake` /
    ///         `emergencyWithdrawNFT`) reverts because the recipient is a hostile
    ///         contract OR an EIP-7702-delegated EOA without `onERC721Received`.
    ///         Permissionless retry via `claimStrandedRestakeNFT(tokenId)` mirrors
    ///         the `TegridyStakingJbacVault.claimStrandedJbac` battle-tested pattern
    ///         already live in this codebase. Pre-fix, a 7702-EOA restaker who
    ///         ran `unrestake` would self-DoS — the only recovery path was admin
    ///         pause + 24h cooldown + emergencyForceReturn. Now they self-recover
    ///         after removing their delegation.
    mapping(uint256 => address) public strandedRestakeRecipient;
    event RestakeNFTStranded(uint256 indexed tokenId, address indexed to);
    event RestakeNFTReclaimed(uint256 indexed tokenId, address indexed to);

    /// @notice AUDIT H-8 (HIGH): per-restaker historical boost checkpoints. Without
    ///         this, boostedAmountAt(_user, _ts) was returning the CURRENT (already
    ///         decayed) cached boostedAmount for any historical timestamp — silently
    ///         under-crediting restakers in RevenueDistributor when their lock decays
    ///         between epoch creation and claim time. Trace208.upperLookup gives the
    ///         actual value at `_ts`. Pattern matches TegridyStaking._checkpoints.
    using Checkpoints for Checkpoints.Trace208;
    mapping(address => Checkpoints.Trace208) private _boostCheckpoints;

    /// @dev H-8: write a new boost checkpoint for `user` with the given value.
    ///      Called from every site that mutates info.boostedAmount.
    function _writeBoostCheckpoint(address user, uint256 newBoost) internal {
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        _boostCheckpoints[user].push(SafeCast.toUint48(block.timestamp), SafeCast.toUint208(newBoost));
    }

    uint256 public totalBonusFunded;
    uint256 public totalBonusDistributed;
    mapping(address => uint256) public unforwardedBaseRewards; // AUDIT FIX H-02: Track base rewards arriving outside claimAll
    uint256 public totalUnforwardedBase; // SECURITY FIX: Track total unforwarded to cap attribution
    mapping(address => uint256) public pendingUnsettledRewards;
    uint256 public totalPendingUnsettled; // SECURITY FIX: Track total pending unsettled for recoverStuckPrincipal
    /// @notice AUDIT H-1: running sum of active restakers' original principal amounts.
    ///         Reserved from recoverStuckPrincipal's recoverable pool so late callers
    ///         can't get shortchanged by earlier callers who already drained it.
    uint256 public totalActivePrincipal;

    /// @notice AUDIT FIX FRESH-2026: H-3 [F-04-1] — separate bucket for deferred
    ///         BONUS-token credits. Pre-fix, `decayExpiredRestaker`'s catch-arm
    ///         routed `bonusPending` (bonusRewardToken units) into the
    ///         rewardToken-denominated `unforwardedBaseRewards`, silently
    ///         swapping (e.g.) WETH-denominated bonus for TOWELI-denominated
    ///         base. This bucket is denominated in `bonusRewardToken` and
    ///         redeemed in `bonusRewardToken`.
    mapping(address => uint256) public unforwardedBonusRewards;
    uint256 public totalUnforwardedBonus;

    /// @notice AUDIT FIX FRESH-2026: F-04-3 — owner-only timelocked clear of
    ///         an abandoned residual claimant (e.g. lost-keys restaker).
    uint256 public constant CLEAR_RESIDUAL_TIMELOCK = 7 days;
    /// @notice AUDIT FIX (2026-05-25 2nd pass): validity window after the timelock
    ///         elapses, so an abandoned residual-clear proposal self-expires instead of
    ///         staying executable forever (parity with sibling inline timelocks).
    uint256 public constant CLEAR_RESIDUAL_VALIDITY = 7 days;
    struct PendingResidualClear {
        address newClaimant;
        uint256 executeAfter;
    }
    mapping(uint256 => PendingResidualClear) public pendingResidualClears;
    event ResidualClearProposed(uint256 indexed tokenId, address indexed newClaimant, uint256 executeAfter);
    event ResidualClearExecuted(uint256 indexed tokenId, address indexed oldClaimant, address indexed newClaimant);
    event ResidualClearCancelled(uint256 indexed tokenId);

    /// @notice AUDIT FIX FRESH-2026: M-4 [F-04-2] — propose/execute pair for
    ///         the rescueNFT path (48h timelock).
    uint256 public constant RESCUE_NFT_TIMELOCK = 48 hours;
    struct PendingRescueNFT {
        uint256 tokenId;
        address to;
    }
    PendingRescueNFT public pendingRescueNFT;
    event RescueNFTProposed(uint256 indexed tokenId, address indexed to, uint256 executeAfter);
    event RescueNFTExecuted(uint256 indexed tokenId, address indexed to);
    event RescueNFTCancelled(uint256 indexed tokenId);

    /// @notice AUDIT FIX FRESH-2026: F-84-1 — bonus-token-decimal-scaled cap
    ///         unit. Cached at construction; raw-wei scale of one whole bonus
    ///         token. Defaults to 1e18 if `decimals()` reverts.
    uint256 public immutable bonusRewardTokenUnit;

    // SECURITY FIX #13: Timelock for reward rate changes
    uint256 public constant BONUS_RATE_TIMELOCK = 48 hours;
    /// @notice AUDIT FIX FRESH-2026: F-04-7 + F-84-1 — symmetric, decimal-
    ///         scaled cap. Pre-fix the constructor bound rate to `10e18`
    ///         while `proposeBonusRate` allowed up to `100e18` — asymmetric
    ///         and not scaled to `bonusRewardToken.decimals()`. Now both
    ///         sites share `maxBonusRewardRate()` evaluating to
    ///         `10 * bonusRewardTokenUnit`.
    uint256 public constant MAX_BONUS_REWARD_RATE_MULTIPLIER = 10;
    uint256 public pendingBonusRate;

    // SECURITY FIX: Timelock for attributeStuckBaseRewards
    uint256 public constant ATTRIBUTE_TIMELOCK = 24 hours;
    struct PendingAttribution {
        address restaker;
        uint256 amount;
    }
    PendingAttribution public pendingAttribution;

    // H-01 FIX: Track per-user recovery to prevent race condition in recoverStuckPrincipal
    /// @dev AUDIT FIX (pass-8): EIP170-04 — visibility lowered to `internal`.
    ///      Zero on-chain consumers; flag is observable off-chain via the
    ///      `PrincipalRecovered` event. Saves ~80B.
    /// @dev AUDIT FIX (pass-8 followup): ABI shim re-exposed via the public view
    ///      `hasRecoveredPrincipal(user)` below for test compatibility.
    mapping(address => bool) internal _hasRecoveredPrincipal;
    uint256 public totalRecoveredPrincipal;

    // H-02 FIX: Rate-limit emergencyForceReturn to prevent rapid sequential draining
    uint256 public lastForceReturnTime;
    uint256 public constant FORCE_RETURN_COOLDOWN = 1 hours;

    // AUDIT FIX: DEEP-DR-07 — cooldown between bonus-rate propose/cancel sequences
    // so a captured-key signer cannot churn the rate-change state indefinitely
    // (preventing legitimate signers from enacting a counter-rate during an
    // incident). Tracks the timestamp of the most recent propose OR cancel; the
    // next propose/cancel pair is gated by `BONUS_RATE_ACTION_COOLDOWN`.
    uint256 public lastBonusRateActionAt;
    uint256 public constant BONUS_RATE_ACTION_COOLDOWN = 24 hours;

    // ─── Events ─────────────────────────────────────────────────────
    event Restaked(address indexed user, uint256 indexed tokenId, uint256 positionAmount);
    event Unrestaked(address indexed user, uint256 indexed tokenId);
    event BonusClaimed(address indexed user, uint256 bonusAmount);
    event BaseClaimed(address indexed user, uint256 baseAmount);
    event BonusFunded(uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed tokenId); // SECURITY FIX #12
    event BonusRateProposed(uint256 newRate, uint256 executeAfter); // SECURITY FIX #13
    event BonusRateExecuted(uint256 newRate); // SECURITY FIX #13
    event BaseClaimFailed(uint256 indexed tokenId, address indexed user); // SECURITY FIX #21
    event BonusRateCancelled(uint256 cancelledRate); // M-03: Cancel mechanism
    event PositionRefreshed(address indexed user, uint256 indexed tokenId, uint256 oldAmount, uint256 newAmount); // C-05
    event StuckBaseRewardsAttributed(address indexed restaker, uint256 amount); // AUDIT FIX: attribute external base rewards
    event AttributionProposed(address indexed restaker, uint256 amount, uint256 executeAfter);
    event AttributionCancelled(address indexed restaker, uint256 amount);
    event UnsettledRecovered(address indexed user, uint256 amount); // AUDIT FIX: recover unsettled from NFT transfer
    event EmergencyForceReturn(address indexed restaker, uint256 indexed tokenId, bool nftReturned); // H-05
    event BoostRevalidated(address indexed restaker, uint256 indexed tokenId, uint256 oldBoosted, uint256 newBoosted); // M-26
    /// @notice AUDIT H13: emitted when the bonus reward pool cannot cover the expected
    ///         elapsed * bonusRewardPerSecond accrual. Restakers silently earn less than
    ///         the advertised rate; off-chain monitors must surface this so the pool can
    ///         be refunded before users notice their APR drift.
    event BonusShortfall(uint256 elapsed, uint256 shortfall);
    /// @notice REVIEW C-1-FINDING-1/2: emitted when a post-exit residual is recorded
    ///         (i.e. the staking pool was under-funded at unrestake time and some
    ///         per-tokenId-attributed reward stayed in `staking.unsettledRewardsByTokenId`).
    event ResidualReserved(uint256 indexed tokenId, address indexed claimant, uint256 amount);
    /// @notice REVIEW C-1-FINDING-1/2: emitted when the claimant pulls their residue
    ///         after the staking pool is replenished.
    event ResidualClaimed(uint256 indexed tokenId, address indexed claimant, uint256 amount);
    /// @notice AUDIT FIX LD-NEW-H1 mirror: emitted when `claimResidualForTokenId`
    ///         declines to drain because the NFT is currently held by a third party
    ///         (most commonly a tracked-holder lending contract). The residual claim
    ///         remains live; off-chain monitoring uses this event to surface
    ///         "your residual is parked while the NFT is in lending" UX.
    event ResidualPullDeferredCrossHolder(uint256 indexed tokenId, address indexed currentOwner);
    /// @notice AUDIT FIX FRESH-2026: RESTAKE-RESIDUAL-WAIVE-SECONDARY-MARKET [HIGH] —
    ///         emitted when the residual claimant voluntarily forfeits an
    ///         unclaimed residue to unblock secondary-market resale of the
    ///         underlying NFT. The on-chain residue stays at staking
    ///         (claimable by the next legit holder via the normal restake
    ///         path); only the per-tokenId claimant gate is cleared.
    event ResidualClaimWaived(uint256 indexed tokenId, address indexed waivedBy);

    // ─── Errors ─────────────────────────────────────────────────────
    error NotRestaked();
    error AlreadyRestaked();
    error BadParam(); // BATCH-M2: typed error for compressed require strings (size budget)
    error NotNFTOwner();
    /// @notice REVIEW C-1-FINDING-1: re-restake of a tokenId is blocked while a
    ///         prior restaker still has an unrecovered residual claim.
    error TokenIdHasPendingResidual();
    /// @notice REVIEW C-1-FINDING-1: caller is not the recorded residual claimant
    ///         for `tokenId` (i.e. they are not the prior restaker who unrestaked
    ///         while the staking pool was under-funded).
    error NotResidualClaimant();
    error ZeroAmount();
    error RateTooHigh(); // SECURITY FIX #13
    error CannotSweepBonusToken(); // SECURITY FIX: Prevent sweeping bonus reward pool
    error CannotSweepRewardToken(); // SECURITY FIX: Prevent sweeping base reward token
    error RewardTokenMatchesBonusToken(); // SECURITY FIX: Constructor validation
    error ZeroAddress(); // L-01: Zero-address validation
    error OnlyStakingNFT(); // L-03: Custom error for onERC721Received
    error Int256Overflow(); // M-27: Safe int256 cast guard
    error NotRestakedToken(); // M-26: Token not restaked in this contract
    error Unauthorized(); // AUDIT NEW-S2: restrict revalidate-boost helpers to owner/restaker
    /// @notice R014 RETRY: emitted by `_accrueBonusChecked` when an `_accrueBonus`
    ///         override decreases `accBonusPerShare`. The accumulator is monotonically
    ///         non-decreasing by construction; any overriding subclass that violates
    ///         this invariant is malicious and must trip this assertion.
    error AccrueNotMonotone();
    /// @notice AUDIT NFT-CL-M4: typed-error replacement for the legacy
    ///         `revert("NO_DECAY")` string in `decayExpiredRestaker`. Raised when
    ///         the cached boost matches the current staking-side boost (i.e., no
    ///         decay has happened yet — the helper has nothing to do).
    error NoDecay();
    /// @notice AUDIT FIX: DEEP-DR-07 — propose/cancel of bonus rate must be at
    ///         least `BONUS_RATE_ACTION_COOLDOWN` apart so a captured-signer key
    ///         cannot churn rate-change state continuously.
    error BonusRateActionCooldown();
    /// @notice AUDIT FIX: DR2-08 — distinct typed error for the staking-side
    ///         per-owner-set divergence check (DR-11 fix). Pre-DR2-08, this
    ///         shared `NotNFTOwner()` with the ERC721 ownership check, so
    ///         off-chain monitors couldn't distinguish "ERC721 ownership
    ///         mismatch" from "TegridyStaking per-owner-set divergence" — the
    ///         latter being a future-compat tripwire that signals a TegridyStaking
    ///         ABI/semantics drift. Distinct typed error makes the failure
    ///         surface diagnosable for Tenderly alerts.
    error StakingOwnershipDesync();
    /// @notice AUDIT FIX FRESH-2026: H-1 [F-03-K1, F-87-K-01, F-93-1] — restake
    ///         of an expired-lock position is rejected because TegridyStaking's
    ///         lazy-decay leaves `boostedAmount` inflated until `_decayIfExpired`
    ///         fires. Pre-fix, copying that inflated cache into the restaking
    ///         struct let the attacker siphon honest restakers' bonus emission.
    error PositionExpired();
    /// @notice AUDIT FIX FRESH-2026: F-04-3 — typed errors for the timelocked
    ///         residual-clear admin path.
    error NoPendingResidualClear();
    error ResidualClearTimelockNotElapsed();
    /// @notice AUDIT FIX (2026-05-25 2nd pass): residual-clear proposal expired (past validity).
    error ResidualClearExpired();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _staking,
        address _monitor,
        address _rewardToken,
        address _bonusRewardToken,
        uint256 _bonusRewardPerSecond
    ) OwnableNoRenounce(msg.sender) {
        // L-01: Zero-address validation for all constructor params
        if (_staking == address(0)) revert ZeroAddress();
        if (_monitor == address(0)) revert ZeroAddress();
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_bonusRewardToken == address(0)) revert ZeroAddress();
        if (_rewardToken == _bonusRewardToken) revert RewardTokenMatchesBonusToken();
        // AUDIT NOTE (2026-05-25 2nd pass): `_bonusRewardToken` MUST be a standard,
        // non-callback ERC-20 (no ERC-777 `tokensReceived` / transfer hook). Reentrancy
        // safety of every bonus payout already holds via the `nonReentrant` guards + CEI
        // ordering (bonusDebt anchored BEFORE each transfer; `_safeBonusTransferExt` is a
        // self-call inside a nonReentrant parent), so a hook token still cannot re-enter
        // — but a non-hook bonus token is the intended deploy invariant. On-chain ERC-777
        // detection is intentionally NOT added: best-effort ERC-1820/165 probing is
        // bypassable and adds attack surface for a value the deployer fully controls at
        // construction. Enforce via the deploy checklist (mirrors TegridyFactory's
        // documented "standard ERC-20 only" envelope).
        staking = ITegridyStaking(_staking);
        stakingNFT = IERC721(_staking); // TegridyStaking IS the ERC721
        monitor = StakingMonitorView(_monitor);
        rewardToken = IERC20(_rewardToken);
        bonusRewardToken = IERC20(_bonusRewardToken);

        // AUDIT FIX FRESH-2026: F-84-1 — query bonus-token decimals at deploy
        // and cache the per-whole-token raw-wei scale. Mirrors POLAccumulator's
        // `toweliUnit` pattern. Falls back to 18-dec if the call reverts
        // (legacy tokens without decimals()) or reports a pathological scale.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 _unit;
        try IERC20Metadata(_bonusRewardToken).decimals() returns (uint8 d) {
            _unit = d <= 36 ? 10 ** uint256(d) : 1e18;
        } catch {
            _unit = 1e18;
        }
        bonusRewardTokenUnit = _unit;

        // AUDIT FIX FRESH-2026: F-04-7 + F-84-1 — symmetric, decimal-scaled cap.
        // Pre-fix this used the 18-dec-baked literal `10e18`.
        if (_bonusRewardPerSecond > MAX_BONUS_REWARD_RATE_MULTIPLIER * _unit) revert BadParam();

        bonusRewardPerSecond = _bonusRewardPerSecond;
        lastBonusRewardTime = block.timestamp;
    }

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function bonusRateChangeTime() external view returns (uint256) { return _executeAfter[BONUS_RATE_CHANGE]; }
    function attributionExecuteAfter() external view returns (uint256) { return _executeAfter[ATTRIBUTION_CHANGE]; }

    /// @notice AUDIT FIX FRESH-2026: F-04-7 + F-84-1 — single decimal-scaled
    ///         cap used by both constructor and `proposeBonusRate`.
    function maxBonusRewardRate() public view returns (uint256) {
        return MAX_BONUS_REWARD_RATE_MULTIPLIER * bonusRewardTokenUnit;
    }

    // ─── Modifiers ──────────────────────────────────────────────────
    /// @dev AUDIT FIX 2026-05-26 [L-02]: this modifier reads
    ///      `bonusRewardToken.balanceOf(address(this))` and distributes the
    ///      delta as bonus. Anyone direct-transferring bonus tokens to the
    ///      contract (bypassing `fundBonus`) will have those tokens silently
    ///      distributed at the next `updateBonus` invocation. This is the
    ///      intended "donations welcome" semantic but means `totalBonusFunded`
    ///      does NOT track direct sends — operators MUST use `fundBonus` for
    ///      observable accounting. No code fix; ABI is correct.
    modifier updateBonus() {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                // AUDIT FIX FRESH-2026 [H-RESTAKE-BONUS-CAP-DEBT]: subtract the
                // already-committed `totalUnforwardedBonus` (deferred-payout
                // debt sitting in `unforwardedBonusRewards[user]` queues from
                // prior failed bonus-token transfers) BEFORE using the on-hand
                // balance as the accrual cap. Pre-fix the cap conflated
                // uncommitted pool liquidity with already-owed debt, letting
                // fresh emission shares be minted into `accBonusPerShare`
                // backed by funds already promised to deferred-payout users.
                // Pattern of record: SushiSwap MasterChefV2 / Curve gauge
                // factories track "queued debt" separately from "claimable
                // pool" — emission flows against the uncommitted slice only.
                // Honest restakers' bonus values then stay claimable in full
                // and deferred-payout users (Carol after blacklist lift) are
                // not silently shortchanged by Bob's normal claim runs.
                available = bal > totalUnforwardedBonus ? bal - totalUnforwardedBonus : 0;
            } catch {
                available = 0;
            }
            // AUDIT H13: surface bonus-pool drought so off-chain monitors can refund the
            // pool before restakers see APR drift. The truncation behavior itself is
            // preserved (reward = available) — this only adds observability.
            if (reward > available) {
                emit BonusShortfall(elapsed, reward - available);
                reward = available;
            }
            if (reward > 0) {
                accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
            }
            lastBonusRewardTime = block.timestamp;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        } else if (totalRestaked == 0) {
            // AUDIT FIX H-01: Always advance lastBonusRewardTime when totalRestaked == 0
            // to prevent first-restaker reward dump after a gap period.
            // Rewards during empty periods are forfeited (no one to distribute to).
            lastBonusRewardTime = block.timestamp;
        }
        _;
    }

    // ─── View Functions ─────────────────────────────────────────────

    /// @notice Check pending bonus rewards for a user
    /// @dev AUDIT FIX: DEEP-DR-08 — route through the clamped historical boost
    ///      view so frontends/integrators see a value consistent with what the
    ///      RevenueDistributor (or a `claimAll` after `staking.kick`) would
    ///      actually settle. Pre-fix, between staking-side lock expiry and the
    ///      next restaking-side mutation, this view returned the inflated cached
    ///      `info.boostedAmount` — users would see a "100 TOWELI pending" toast
    ///      that silently shrinks to ~30 TOWELI on claim because `claimAll`'s
    ///      stale path correctly clamps to the current staking boost.
    function pendingBonus(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (info.tokenId == 0) return 0;

        uint256 currentAcc = accBonusPerShare;
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            // AUDIT FIX: DR2-06 — wrap `bonusRewardToken.balanceOf` in try/catch
            // for parity with `_accrueBonus` (which DR-06 fix made tolerant).
            // Without this, a hostile/paused/blacklisted bonus token would
            // revert this view, breaking every frontend dashboard, off-chain
            // indexer, and integrator that reads `pendingBonus`/`pendingTotal`.
            // The mutator path tolerates it; the view should too.
            // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
            // slither-disable-next-line uninitialized-local
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                // AUDIT FIX FRESH-2026 [H-RESTAKE-BONUS-CAP-DEBT]: view-side
                // mirror of the updateBonus cap fix — subtract deferred-payout
                // debt from the cap so the view shows the same number a
                // mutator-side accrual would actually credit. Avoids
                // frontend/indexer drift relative to on-chain accrual.
                available = bal > totalUnforwardedBonus ? bal - totalUnforwardedBonus : 0;
            } catch {
                available = 0;
            }
            if (reward > available) reward = available;
            currentAcc += (reward * ACC_PRECISION) / totalRestaked;
        }

        // AUDIT FIX: DEEP-DR-08 — use the staleness-clamped boost (min(cached,
        // current)) instead of the raw cached `info.boostedAmount`. Same fix as
        // DEEP-DR-04 applied to the pendingBonus view surface.
        uint256 effectiveBoost = _boostedAmountAt(_user, block.timestamp);
        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((effectiveBoost * currentAcc) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    /// @notice Check pending base staking rewards for the deposited NFT
    function pendingBase(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (info.tokenId == 0) return 0;
        return monitor.earned(info.tokenId);
    }

    /// @notice AUDIT FIX 2026-05-26 [L-03]: sum of accruing bonus + deferred
    ///         payout sitting in `unforwardedBonusRewards`. The standalone
    ///         `pendingBonus(user)` view returns 0 when the user has no
    ///         active restake — but a previously-deferred bonus payout (e.g.
    ///         caught by a blacklist arm in claimAll/unrestake) still owes
    ///         them ETH/tokens via `claimPendingBonusPayout`. This combined
    ///         view lets UIs surface the full claimable in one read.
    function totalBonusClaimable(address user) external view returns (uint256) {
        return pendingBonus(user) + unforwardedBonusRewards[user];
    }

    /// @notice Total pending rewards (base + bonus) for display
    function pendingTotal(address _user) external view returns (uint256 base, uint256 bonus) {
        base = pendingBase(_user);
        bonus = pendingBonus(_user);
    }

    /// @notice AUDIT NEW-S1 (CRITICAL): voting-power source for RevenueDistributor.
    ///         When an NFT is transferred into this contract, TegridyStaking zeroes the
    ///         user's voting-power checkpoint (the NFT no longer belongs to them on the
    ///         staking side). RevenueDistributor.votingPowerAtTimestamp(user, ts) therefore
    ///         reads 0 for every epoch during the user's restake window, silently paying
    ///         them $0 of protocol revenue — the exact opposite of the intent.
    ///
    ///         This view exposes the restaker's boosted-amount at a given timestamp so the
    ///         distributor can fall through when the staking checkpoint is zero. Returns
    ///         the current `boostedAmount` if the user held a restaked position at or
    ///         before `_timestamp` (i.e., `depositTime <= _timestamp`), zero otherwise.
    ///
    ///         Note: the current boostedAmount is a lower bound for the power the user
    ///         actually held at `_timestamp` (boost can only decay between then and now),
    ///         so this is a safe proxy — never over-credits. Users who unrestake without
    ///         claiming first will forfeit their share for epochs distributed during the
    ///         restake window; frontends should surface a "claim before unrestake" hint.
    function boostedAmountAt(address _user, uint256 _timestamp) external view returns (uint256) {
        return _boostedAmountAt(_user, _timestamp);
    }

    // ─── AUDIT FIX: GOV-ECON-01 / C10 — restaker disenfranchisement ────────────────
    /// @notice Live voting power of `_user`'s restaked position.
    /// @dev    AUDIT FIX: GOV-ECON-01 — depositing into restaking moves the
    ///         staking NFT into this contract. `staking.votingPowerOf(restaker)`
    ///         returns 0 (per-owner enumerable set is empty AND the deposit
    ///         wrote a 0-checkpoint). Without this view, GaugeController,
    ///         VoteIncentives, MemeBountyBoard, and CommunityGrants all read
    ///         0 for restakers, silently disenfranchising every TOWELI
    ///         deposited into restaking from on-chain governance.
    ///
    ///         This alias delegates to `_boostedAmountAt(user, now)` which
    ///         is the existing lazy-decay-safe historical reader. Returns the
    ///         current `boostedAmount` if the user holds an active restake,
    ///         clamped against the staking-side current value to defend
    ///         against `kick()` / autoMaxLock non-monotonic restoration
    ///         (existing DEEP-DR-04 / DR2-02 hardening preserved).
    ///
    ///         Consumed by `lib/VotePowerOracle.sol::powerOfLiveUnsafe` which
    ///         sums this with `staking.votingPowerOf(user)`. Safe to call at any
    ///         time; returns 0 when user has no restake or it has expired.
    function votingPowerOf(address _user) external view returns (uint256) {
        return _boostedAmountAt(_user, block.timestamp);
    }

    // AUDIT FIX (pass-8 followup): ABI shims for tests/off-chain readers that
    // bind the auto-getter shape by name. Internal slots use `_` prefix.
    function residualClaimant(uint256 tokenId) external view returns (address) { return _residualClaimant[tokenId]; }
    function hasRecoveredPrincipal(address user) external view returns (bool) { return _hasRecoveredPrincipal[user]; }

    /// @notice Historical voting power of `_user`'s restaked position at `_timestamp`.
    /// @dev    AUDIT FIX: GOV-ECON-01 — semantic alias of `boostedAmountAt`
    ///         exposing the same data under the `votingPowerAtTimestamp` name
    ///         used by all four governance consumers and `RevenueDistributor`.
    ///         Consumed by `lib/VotePowerOracle.sol::powerAt`.
    ///
    ///         Returns 0 if the user did not yet hold a restake at `_timestamp`
    ///         (`info.depositTime > _timestamp`) or has no restake at all.
    ///         Clamped against the staking-side live `boostedAmount` to defend
    ///         against `kick()` / autoMaxLock cache-staleness — existing
    ///         DEEP-DR-04 / DR2-02 / autoMaxLock carve-outs preserved verbatim.
    function votingPowerAtTimestamp(address _user, uint256 _timestamp) external view returns (uint256) {
        return _boostedAmountAt(_user, _timestamp);
    }

    /// @dev AUDIT FIX: DEEP-DR-04 / DEEP-DR-08 / DEEP-DR-10 — internal helper used
    ///      by the public `boostedAmountAt` view AND by `pendingBonus` so both
    ///      surface the same lazy-decay-safe value.
    ///
    ///      The trace-checkpoint cache on this side is only updated by RESTAKING-
    ///      side mutations (restake / unrestake / refresh / decayExpiredRestaker /
    ///      revalidateBoost / emergency exits). When TegridyStaking's
    ///      permissionless `kick(tokenId)` is invoked from the outside (Curve-
    ///      style decay sweeper) or via `withdraw`/`unstake`, the staking-side
    ///      `boostedAmount` is zeroed/decayed but our cache and Trace208 stay
    ///      stuck on the pre-expiry inflated value. RevenueDistributor (and other
    ///      consumers) calling `boostedAmountAt(user, ts)` with `ts` after the
    ///      kick used to receive the inflated checkpoint, over-crediting the user.
    ///
    ///      Fix: clamp the checkpointed value with the CURRENT staking-side
    ///      `boostedAmount`. Boost monotonically decays over time, so the current
    ///      value is a safe upper bound for any past timestamp ≤ now. Wrapping
    ///      the staking call in try/catch keeps the view robust if the staking
    ///      contract is ever upgraded with a temporarily-incompatible ABI.
    function _boostedAmountAt(address _user, uint256 _timestamp) internal view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (info.tokenId == 0) return 0;
        if (info.depositTime > _timestamp) return 0;

        uint256 cached;
        if (_boostCheckpoints[_user].length() == 0) {
            cached = info.boostedAmount;
        } else {
            cached = _boostCheckpoints[_user].upperLookup(SafeCast.toUint48(_timestamp));
        }

        // AUDIT FIX: DEEP-DR-04 — clamp by current staking-side boost. `min(cached,
        // current)` guarantees no over-credit even when the cache is lazy: the
        // value can only ever be too HIGH due to staleness, never too low.
        // try/catch defends against future staking ABI breakage.
        //
        // AUDIT FIX: DR2-02 — the `min(cached, current)` clamp rests on the
        // assumption that boost monotonically decays over time, so the current
        // value is a safe upper bound for any past timestamp. That assumption
        // is FALSE for `autoMaxLock` positions: after `staking.kick(tokenId)`
        // zeroes `boostedAmount`, the next `staking.getReward(tokenId)` (which
        // claimAll calls) detects `p.autoMaxLock && p.boostedAmount == 0` and
        // RE-APPLIES MAX_BOOST. The staking-side `boostedAmount` jumps from 0
        // back to MAX in the same transaction — non-monotonic restoration.
        //
        // Without this carve-out, RevenueDistributor's `_boostedAmountAt`
        // lookup for an epoch in the kick-window returns
        // `min(prev_checkpoint_X, MAX) = X` (the inflated pre-kick value)
        // instead of the correct 0 — reopening the DR-04 over-credit attack
        // via the user's own `claimAll` trigger.
        //
        // Fix: when staking-side `autoMaxLock` is true, the per-checkpoint
        // historical Trace208 lookup IS the authoritative answer (it was
        // written at each restaking-side mutation, including the post-kick
        // claimAll stale-path which correctly recorded the post-kick value).
        // Skip the live-current clamp and trust the checkpoint.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 current;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 liveLockEnd;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        try staking.positions(info.tokenId) returns (
            uint256, uint256 stakingBoosted, int256, uint256 lockEnd_, uint256, uint256, bool, bool, uint256, uint256, bool
        ) {
            current = stakingBoosted;
            liveLockEnd = lockEnd_;
        } catch {
            // If the staking call reverts, fall back to the cached value rather
            // than zeroing — the cache is at worst stale-inflated, never stale-
            // deflated, and zero would over-penalize honest users.
            return cached;
        }

        // AUDIT FIX DR3-01: lockEnd-anchored clamp. The DR2-02 carve-out
        // (`if (autoMaxLock) return cached;`) was a NET REGRESSION: it
        // returned the stale-inflated cache during the kick-window for
        // autoMaxLock positions, reopening exactly the DR-04 over-credit
        // attack. Replacement: when the live lock has EXPIRED
        // (`block.timestamp >= liveLockEnd`), the position is in the
        // kick-window and `current` is conservative (0 if not yet restored,
        // post-kick MAX if restored — either way `min(cached, current)`
        // bounds the over-credit). When the live lock is ACTIVE
        // (`block.timestamp < liveLockEnd`), the user has a live position —
        // the per-checkpoint Trace208 cache is the authoritative historical
        // record, so return `cached` directly (avoids the DR2-07 edge case
        // for unrestake → restake-smaller flows where current would
        // under-credit historical epochs).
        if (block.timestamp >= liveLockEnd) {
            // AUDIT FIX F-1 (under-credit on historical lookups in kick window):
            // The clamp `min(cached, current)` is correct for _timestamps AT OR AFTER
            // `liveLockEnd` (the lock has decayed; current is the post-decay ceiling).
            // For _timestamps STRICTLY BEFORE `liveLockEnd`, the position was active
            // at that historical instant and the per-checkpoint Trace208 cache is the
            // authoritative record for that snapshot. Pre-fix, when an attacker (or
            // honest decay sweeper) called staking.kick() to zero `current` after lockEnd,
            // every historical RevenueDistributor.claim for prior epochs returned
            // `min(cached, 0) = 0` — wiping out the user's legitimate share for epochs
            // that had snapshotted them with a non-zero boost. This was a SILENT
            // under-credit on the restaker, opposite-direction of the original DR-04
            // over-credit but still a wrong answer. Splitting the predicate keeps the
            // DR-04 / DR2-02 over-credit defense intact while restoring honest
            // historical accounting.
            if (_timestamp < liveLockEnd) {
                return cached;
            }
            return cached < current ? cached : current;
        }
        return cached;
    }

    // ─── User Functions ─────────────────────────────────────────────

    /// @notice Deposit your tsTOWELI NFT to earn bonus yield
    /// @dev Transfers the NFT from caller to this contract
    function restake(uint256 _tokenId) external nonReentrant whenNotPaused updateBonus {
        if (restakers[msg.sender].tokenId != 0) revert AlreadyRestaked();

        // REVIEW C-1-FINDING-1: prevent the next entity to acquire this NFT from
        // covertly draining a prior restaker's per-tokenId residue. If a prior
        // restaker exited with an under-funded pool, `_residualClaimant[_tokenId]`
        // points at them — only they may re-restake until the residue is recovered.
        // Self-re-restake (the same claimant) is allowed because their existing
        // claim survives the second deposit and they can recover it on their next
        // unrestake.
        address claimant = _residualClaimant[_tokenId];
        // AUDIT FIX (BATCH-M2 M28): only block if residue is non-zero. Pre-fix
        // a stale-but-not-cleared zero-residue record locked re-restake by anyone
        // but the original claimant.
        if (claimant != address(0) && claimant != msg.sender
            && staking.unsettledRewardsByTokenId(_tokenId) > 0) revert TokenIdHasPendingResidual();

        // Verify caller owns the NFT
        if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();
        // AUDIT FIX: DEEP-DR-11 — additionally enforce the staking-side per-owner
        // enumerable set as the authoritative source of truth (M13 pattern). For
        // present semantics this is redundant with `ownerOf`, but if a future
        // staking upgrade ever wraps ownership through a proxy or share-token,
        // this check guarantees the restaking contract still tracks the staking
        // contract's authoritative ownership view.
        // AUDIT FIX: DR2-08 — distinct typed error so off-chain monitors can
        // distinguish this future-compat divergence from a plain ERC721
        // ownership mismatch. If it ever fires it indicates a TegridyStaking
        // ABI/semantics drift and should page the team.
        if (!staking.holdsToken(msg.sender, _tokenId)) revert StakingOwnershipDesync();

        // Get position data from TegridyStaking
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (uint256 amount, uint256 boostedAmount,, uint256 lockEnd,,,,, , ,) = staking.positions(_tokenId);
        if (amount == 0) revert ZeroAmount();
        // AUDIT FIX FRESH-2026: H-1 [F-03-K1, F-87-K-01, F-93-1] — reject expired
        // locks. TegridyStaking's `_decayIfExpired` is lazy (only fires on
        // `_getReward` / `kick`); if the lock has expired but no decay-trigger
        // has run, `boostedAmount` is still the pre-decay (inflated) value.
        // Pre-fix, a `restake(_tokenId)` at `T_exp + 1s` copied that inflated
        // cache into `info.boostedAmount`, bumped `totalRestaked`, and let the
        // attacker siphon honest restakers' bonus emission until the next
        // decay fires — and `claimAll`'s post-claim re-sync gates with
        // `postClaimBoosted > 0`, so even the user's own claim couldn't reset
        // the cache once `staking.getReward` zeroed `boostedAmount`. Cleanest
        // fix: refuse expired locks at the entrypoint; users must trigger
        // `staking.kick(_tokenId)` (or unstake/restake fresh) first.
        if (lockEnd <= block.timestamp) revert PositionExpired();

        // Transfer NFT to this contract — M-16: safeTransferFrom for safe NFT handling
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        stakingNFT.safeTransferFrom(msg.sender, address(this), _tokenId);

        // Record restaking info
        // M-27: Safe int256 cast via _safeInt256 helper
        uint256 debtUint = (boostedAmount * accBonusPerShare) / ACC_PRECISION;
        // AUDIT FIX FRESH-2026: F-04-4 — drop the external staking.unsettledRewards
        // call that fed `unsettledSnapshot`. Saves ~2.6k gas per `restake()`.
        // Field is preserved for ABI compat (see struct comment) but always
        // 0 post-fix. The pre-fix delta-attribution flow that read this field
        // was replaced by per-tokenId attribution (claimUnsettledForTokenId).
        restakers[msg.sender] = RestakeInfo({
            tokenId: _tokenId,
            positionAmount: amount,
            boostedAmount: boostedAmount,
            bonusDebt: _safeInt256(debtUint),
            depositTime: block.timestamp,
            unsettledSnapshot: 0
        });
        // AUDIT FIX 2026-05-26 [M-02]: reset the per-user one-shot recovery flag
        // when entering a NEW position. Pre-fix, a user who used
        // `recoverStuckPrincipal()` once for a force-closed position could never
        // use it again for any FUTURE position — the per-user flag was sticky.
        // Reset here ties the flag's lifecycle to the position's lifecycle.
        _hasRecoveredPrincipal[msg.sender] = false;

        tokenIdToRestaker[_tokenId] = msg.sender;
        totalRestaked += boostedAmount;
        // AUDIT H-1: track active principal so recoverStuckPrincipal can reserve it.
        totalActivePrincipal += amount;
        // AUDIT H-8: write initial boost checkpoint so RevenueDistributor / other
        // consumers can read historical boost via boostedAmountAt.
        _writeBoostCheckpoint(msg.sender, boostedAmount);

        emit Restaked(msg.sender, _tokenId, amount);
    }

    /// @notice C-05: Refresh cached position data from TegridyStaking
    /// @dev Re-reads staking.positions(tokenId) and updates positionAmount and totalRestaked.
    ///      AUDIT FIX: Claims pending bonus before resetting debt to prevent silent forfeiture.
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. When the caller's
    ///      cached boost was stale (e.g., lock decayed in TegridyStaking but not
    ///      yet synced here), the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share. Fix: drop the
    ///      modifier and branch on `stale`. Stale path settles pending bonus on
    ///      the OLD boost at the PRE-accrue `accBonusPerShare`, anchors
    ///      `bonusDebt` BEFORE transfer (CEI), shrinks `totalRestaked`, then
    ///      runs `_accrueBonusChecked` against the corrected denominator and
    ///      re-anchors `bonusDebt` at the POST-accrue `accBonusPerShare`.
    function refreshPosition() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        uint256 oldAmount = info.positionAmount;
        uint256 oldBoosted = info.boostedAmount;

        // AUDIT FIX 2026-05-16 H2: force lazy decay before the stale read.
        // See claimAll for full rationale.
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        try staking.kick(info.tokenId) {} catch {}

        // Re-read current position from staking contract
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (uint256 newAmount, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(info.tokenId);

        // AUDIT FIX: Prevent setting positionAmount to zero (would break bonus calculations)
        if (newAmount == 0) revert ZeroAmount();

        bool stale = (newAmount != info.positionAmount || newBoostedAmount != info.boostedAmount);

        if (stale) {
            // R014 RETRY step 1 — settle pending bonus on OLD boost at the
            // PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt` BEFORE the
            // external transfer (CEI) so a hostile bonus token cannot re-enter.
            // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
            // slither-disable-next-line uninitialized-local
            uint256 preBonus;
            if (oldBoosted > 0) {
                int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                int256 preDiff = preAccum - info.bonusDebt;
                preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
            }
            if (preBonus > 0) {
                bonusRewardToken.safeTransfer(msg.sender, preBonus);
                totalBonusDistributed += preBonus;
                emit BonusClaimed(msg.sender, preBonus);
            }

            // R014 RETRY step 2 — update cached values and adjust
            // `totalRestaked` (shrink, in the typical decay case).
            // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new
            // cached principal BEFORE overwrite. DR-02 fix sibling-port: every
            // site that overwrites `info.positionAmount` must adjust the
            // running `totalActivePrincipal` total by the delta, otherwise
            // force-closed positions (where `newAmount == 0`) leak `oldAmount`
            // worth of principal into the reservation pool — silently DOS'ing
            // `recoverStuckPrincipal` for honest force-closed users.
            if (oldAmount >= newAmount) {
                uint256 principalDelta = oldAmount - newAmount;
                if (principalDelta <= totalActivePrincipal) {
                    totalActivePrincipal -= principalDelta;
                } else {
                    totalActivePrincipal = 0;
                }
            } else {
                totalActivePrincipal += (newAmount - oldAmount);
            }
            info.positionAmount = newAmount;
            info.boostedAmount = newBoostedAmount;
            _writeBoostCheckpoint(msg.sender, newBoostedAmount); // AUDIT H-8
            totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;

            // R014 RETRY step 3 — accrue against the corrected (smaller)
            // denominator. This is the key reordering: the elapsed-period
            // emission is now divided by the honest `totalRestaked`.
            _accrueBonusChecked();

            // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on the
            // NEW boost so residual rounding cannot credit emission the caller
            // is no longer entitled to share in.
            uint256 newDebtUint = (newBoostedAmount * accBonusPerShare) / ACC_PRECISION;
            info.bonusDebt = _safeInt256(newDebtUint);
        } else {
            // Non-stale path: cached boost matches the staking contract. Run
            // accrual first, then claim against the user's actual boost at the
            // current `accBonusPerShare`. Behavior matches pre-R014 semantics.
            _accrueBonusChecked();

            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            info.bonusDebt = accumulated; // CEI: anchor BEFORE external call
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(msg.sender, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(msg.sender, bonusPending);
            }
        }

        emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, newAmount);
    }

    /// @notice Claim base staking rewards + bonus restaking rewards
    /// @dev SECURITY FIX H-03: Auto-refreshes cached position data from TegridyStaking
    ///      before calculating bonus rewards, preventing stale position exploitation.
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. With a stale
    ///      cached boost the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share. Fix: drop the
    ///      modifier and branch on `stale`. The stale path settles the OLD boost
    ///      at PRE-accrue, anchors `bonusDebt` BEFORE transfer (CEI), shrinks
    ///      `totalRestaked`, then runs `_accrueBonusChecked` against the
    ///      corrected denominator and re-anchors `bonusDebt` POST-accrue.
    function claimAll() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // SECURITY FIX H-03: Auto-refresh cached position data before bonus calculation.
        // Prevents earning bonus rewards on phantom capital after underlying position changes.
        // AUDIT FIX M-07: Also refresh when boostedAmount changes (e.g., JBAC revalidation,
        // lock extension) even if positionAmount is unchanged.
        // AUDIT FIX 2026-05-16 H2: force lazy decay before the stale read. Pre-fix,
        // a restaker whose lock had expired (but `staking.kick` had not yet fired)
        // saw `currentBoosted == info.boostedAmount` and the stale flag missed —
        // the non-stale path then ran `_accrueBonusChecked` at the INFLATED
        // `totalRestaked` denominator, capturing dilution they were no longer
        // entitled to. `try staking.kick` is no-op-reverts (NoOpKick) on non-
        // expired / already-decayed positions; try/catch absorbs.
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        try staking.kick(info.tokenId) {} catch {}
        {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            bool stale = (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount);

            if (stale) {
                // R014 RETRY step 1 — settle pending bonus on the OLD boost at
                // the PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt`
                // BEFORE the external transfer (CEI).
                uint256 oldBoosted = info.boostedAmount;
                // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
                // slither-disable-next-line uninitialized-local
                uint256 preBonus;
                if (oldBoosted > 0) {
                    int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                    int256 preDiff = preAccum - info.bonusDebt;
                    preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                    info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
                }
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }

                // R014 RETRY step 2 — update cached values + adjust
                // `totalRestaked` (shrink in typical decay case). Handles both
                // the position-zeroed (force-closed) sub-case and the normal
                // refresh sub-case in a single arithmetic update.
                uint256 oldAmt = info.positionAmount;
                // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new
                // cached `info.positionAmount` BEFORE the overwrite. Pre-fix,
                // `info.positionAmount = currentAmount` (where currentAmount = 0
                // for force-closed positions) would orphan `oldAmt` worth of
                // principal in `totalActivePrincipal`, silently DOS'ing
                // `recoverStuckPrincipal` for honest force-closed users (the
                // entrypoint's `othersPrincipal` reservation grows unbounded).
                // DR-02 fixed this for `emergencyForceReturn`; DR2-01 ports the
                // same pattern to all four sibling stale-paths.
                if (oldAmt >= currentAmount) {
                    uint256 principalDelta = oldAmt - currentAmount;
                    if (principalDelta <= totalActivePrincipal) {
                        totalActivePrincipal -= principalDelta;
                    } else {
                        totalActivePrincipal = 0;
                    }
                } else {
                    totalActivePrincipal += (currentAmount - oldAmt);
                }
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                _writeBoostCheckpoint(msg.sender, currentBoosted); // AUDIT H-8
                // AUDIT FIX 2026-05-26 [L-38] defensive underflow guard on totalRestaked
                // See refreshPosition stale path for full rationale.
                totalRestaked = (totalRestaked >= oldBoosted ? totalRestaked - oldBoosted : 0) + currentBoosted;

                // R014 RETRY step 3 — accrue against the corrected (smaller)
                // denominator. The micro-period elapsed since
                // `lastBonusRewardTime` is now divided by the honest
                // `totalRestaked`, so honest restakers earn their fair share.
                _accrueBonusChecked();

                // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on
                // the NEW boost so residual rounding cannot credit emission the
                // caller is no longer entitled to share in.
                if (currentBoosted > 0) {
                    uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                    info.bonusDebt = _safeInt256(newDebtUint);
                } else {
                    info.bonusDebt = 0;
                }

                emit PositionRefreshed(msg.sender, info.tokenId, oldAmt, currentAmount);
            } else {
                // Non-stale path: cached boost matches the staking contract.
                // Run accrual first; the post-accrue claim further down uses
                // the resulting `accBonusPerShare` against the user's actual
                // boost. Behavior matches pre-R014 semantics.
                _accrueBonusChecked();
            }
        }

        // 1. Claim base rewards from TegridyStaking (wrapped in try/catch so bonus still works)
        // Uses the return value from claim() instead of balance deltas to prevent
        // MEV sandwich attacks that inflate rewards via concurrent transfers.
        try staking.getReward(info.tokenId) returns (uint256 baseEarned) {
            // Forward base rewards to user
            if (baseEarned > 0) {
                rewardToken.safeTransfer(msg.sender, baseEarned);
                emit BaseClaimed(msg.sender, baseEarned);
            }
        } catch {
            emit BaseClaimFailed(info.tokenId, msg.sender);
        }

        // AUDIT FIX: DR2-04 — re-read staking-side `boostedAmount` AFTER
        // `staking.getReward` to detect autoMaxLock-induced boost restoration.
        // When a previously-decayed autoMaxLock position has its lock extended
        // by `getReward`, the staking-side branch re-applies MAX_BOOST. Pre-fix,
        // the stale-path above had just zeroed `info.boostedAmount` and
        // dropped the user from `totalRestaked`, so the user silently earned
        // ZERO bonus emission until they manually called `refreshPosition`.
        // The discovery surface is poor: `pendingBonus` returns 0 honestly,
        // and most users wouldn't notice the APR drop. Re-syncing here keeps
        // the restaker in the bonus accrual loop without manual intervention.
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        try staking.positions(info.tokenId) returns (
            uint256, uint256 postClaimBoosted, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
        ) {
            if (postClaimBoosted > 0 && postClaimBoosted != info.boostedAmount) {
                uint256 oldB = info.boostedAmount;
                info.boostedAmount = postClaimBoosted;
                _writeBoostCheckpoint(msg.sender, postClaimBoosted);
                // AUDIT FIX 2026-05-26 [L-38] defensive underflow guard on totalRestaked
                // See refreshPosition stale path for full rationale.
                totalRestaked = (totalRestaked >= oldB ? totalRestaked - oldB : 0) + postClaimBoosted;
                // Re-anchor bonusDebt at current accBonusPerShare on the new
                // boost so the restaker doesn't immediately accrue against
                // emission they haven't earned (the upcoming bonus claim
                // would otherwise mint a phantom delta).
                info.bonusDebt = _safeInt256((postClaimBoosted * accBonusPerShare) / ACC_PRECISION);
                // Sync positionAmount as well in case the staking-side mutated
                // it during getReward (defensive — typical autoMaxLock branch
                // doesn't, but keeps the restaking cache consistent).
                // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
                // slither-disable-next-line unused-return
                (uint256 postClaimAmount,,,,,,,,, ,) = staking.positions(info.tokenId);
                if (postClaimAmount != info.positionAmount) {
                    uint256 oldP = info.positionAmount;
                    if (oldP >= postClaimAmount) {
                        uint256 delta = oldP - postClaimAmount;
                        if (delta <= totalActivePrincipal) {
                            totalActivePrincipal -= delta;
                        } else {
                            totalActivePrincipal = 0;
                        }
                    } else {
                        totalActivePrincipal += (postClaimAmount - oldP);
                    }
                    info.positionAmount = postClaimAmount;
                }
            }
        } catch {
            // If the post-claim re-read reverts, leave the cache as-is — the
            // user can always call refreshPosition manually.
        }

        // AUDIT FIX H-02: Forward any unforwarded base rewards (from revalidateBoost or other external calls)
        uint256 unforwarded = unforwardedBaseRewards[msg.sender];
        if (unforwarded > 0) {
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 actual = unforwarded > available ? available : unforwarded;
            // AUDIT FIX v3: Only subtract the amount actually transferred to prevent silent reward loss
            unforwardedBaseRewards[msg.sender] = unforwarded - actual;
            // SECURITY FIX: Track total unforwarded for attribution cap
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        // AUDIT FIX FRESH-2026: H-3 [F-04-1] — sweep deferred BONUS-token credits
        // (paid in bonusRewardToken via the self-call try/catch wrapper).
        _sweepUnforwardedBonus(msg.sender);

        // 2. Claim bonus rewards (skip if auto-refresh above already settled and reset debt)
        // SECURITY FIX C4: Explicit guard — only claim if debt drift exists after refresh
        // M-27: Safe int256 cast via _safeInt256 helper
        if (info.boostedAmount > 0) {
            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            info.bonusDebt = accumulated;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;

            if (bonusPending > 0) {
                // AUDIT FIX FRESH-2026: F-04-5 — wrap user-side bonus transfer
                // in try/catch via the existing self-call. Pre-fix, a user
                // blacklisted on the bonus token DoS'd their own claimAll.
                // On failure: queue into the bonus bucket so the user can
                // self-claim via `claimPendingBonusPayout()` after un-
                // blacklisting. Mirrors decayExpiredRestaker pattern.
                try this._safeBonusTransferExt(msg.sender, bonusPending) {
                    totalBonusDistributed += bonusPending;
                    emit BonusClaimed(msg.sender, bonusPending);
                } catch {
                    unforwardedBonusRewards[msg.sender] += bonusPending;
                    totalUnforwardedBonus += bonusPending;
                    emit BonusTransferDeferred(msg.sender, bonusPending);
                }
            }
        }
    }

    /// @notice Withdraw your NFT and stop restaking
    /// @dev R014 RETRY (R017): the prior implementation used the `updateBonus`
    ///      modifier which ran `_accrueBonus()` BEFORE the body. With a stale
    ///      cached boost the elapsed-period emission was minted into
    ///      `accBonusPerShare` against an INFLATED `totalRestaked` denominator —
    ///      letting the caller siphon honest restakers' share at exit time.
    ///      Fix: drop the modifier and branch on `stale`. Stale path settles the
    ///      OLD boost at PRE-accrue, anchors `bonusDebt` BEFORE transfer (CEI),
    ///      shrinks `totalRestaked`, then runs `_accrueBonusChecked` against the
    ///      corrected denominator and re-anchors `bonusDebt` POST-accrue.
    function unrestake() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // AUDIT FIX: DR2-01 — capture the cached principal BEFORE the stale-path
        // can overwrite it. The post-stale-block `totalActivePrincipal -= ...`
        // decrement (~50 lines below) must use this captured value, not the
        // post-overwrite `info.positionAmount` (which may be 0 for force-closed
        // positions, leaking the original principal into `totalActivePrincipal`).
        uint256 cachedPrincipalAtEntry = info.positionAmount;

        // S2-03: Auto-refresh cached position data before bonus calculation (same as claimAll)
        // AUDIT FIX M-07: Also compare boostedAmount to catch boost-only changes
        // AUDIT FIX 2026-05-16 H2: force lazy decay before the stale read. See
        // claimAll for full rationale.
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        try staking.kick(info.tokenId) {} catch {}
        {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            bool stale = (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount);

            if (stale) {
                // R014 RETRY step 1 — settle pending bonus on OLD boost at the
                // PRE-accrue `accBonusPerShare`. Anchor `info.bonusDebt` BEFORE
                // the external transfer (CEI).
                uint256 oldBoosted = info.boostedAmount;
                // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
                // slither-disable-next-line uninitialized-local
                uint256 preBonus;
                if (oldBoosted > 0) {
                    int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
                    int256 preDiff = preAccum - info.bonusDebt;
                    preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                    info.bonusDebt = preAccum; // CEI: anchor BEFORE external call
                }
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }

                // R014 RETRY step 2 — update cached values + adjust
                // `totalRestaked` (shrink in typical decay case).
                uint256 oldAmount = info.positionAmount;
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                _writeBoostCheckpoint(msg.sender, currentBoosted); // AUDIT H-8
                // AUDIT FIX 2026-05-26 [L-38] defensive underflow guard on totalRestaked
                // See refreshPosition stale path for full rationale.
                totalRestaked = (totalRestaked >= oldBoosted ? totalRestaked - oldBoosted : 0) + currentBoosted;

                // R014 RETRY step 3 — accrue against the corrected (smaller)
                // denominator.
                _accrueBonusChecked();

                // R014 RETRY step 4 — re-anchor `bonusDebt` at POST-accrue on
                // the NEW boost.
                if (currentBoosted > 0) {
                    uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                    info.bonusDebt = _safeInt256(newDebtUint);
                } else {
                    info.bonusDebt = 0;
                }
                emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, currentAmount);
            } else {
                // Non-stale path: run accrual first, then claim against current
                // `accBonusPerShare` with the user's actual boost.
                _accrueBonusChecked();
            }
        }

        uint256 tokenId = info.tokenId;
        uint256 totalBaseEarned = 0;

        // Disable autoMaxLock before withdrawing to prevent perpetual lock extension trap
        // AUDIT FIX H-01: Wrapped in try/catch so unrestake() works even if staking is paused
        // (toggleAutoMaxLock has whenNotPaused modifier). Without this, paused staking
        // would force users into emergencyWithdrawNFT() which forfeits bonus rewards.
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (,,,,,, bool autoMaxLock,,,,) = staking.positions(tokenId);
        if (autoMaxLock) {
            try staking.toggleAutoMaxLock(tokenId) {} catch {
                emit BaseClaimFailed(tokenId, msg.sender);
            }
        }

        // Claim any remaining base rewards (wrapped in try/catch so unrestake works even if staking is paused)
        // Uses the return value from claim() instead of balance deltas to prevent
        // MEV sandwich attacks that inflate rewards via concurrent transfers.
        try staking.getReward(tokenId) returns (uint256 baseEarned) {
            totalBaseEarned = baseEarned;
        } catch { emit BaseClaimFailed(tokenId, msg.sender); }

        // Forward base rewards to user
        if (totalBaseEarned > 0) {
            rewardToken.safeTransfer(msg.sender, totalBaseEarned);
            emit BaseClaimed(msg.sender, totalBaseEarned);
        }

        // AUDIT FIX FRESH-2026: H-3 [F-04-1] — sweep deferred BONUS-token credits
        // before clearing state. Mirrors claimAll path (paid in bonusRewardToken).
        _sweepUnforwardedBonus(msg.sender);

        // Claim bonus rewards
        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        info.bonusDebt = accumulated;
        uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
        if (bonusPending > 0) {
            // AUDIT FIX FRESH-2026: F-04-5 — wrap user-side bonus transfer in
            // try/catch via the existing self-call. Pre-fix, a user blacklisted
            // on the bonus token DoS'd their own unrestake, forcing them into
            // emergencyWithdrawNFT and forfeiting bonus. Now: defer to the
            // bonus bucket; user self-claims via `claimPendingBonusPayout`.
            try this._safeBonusTransferExt(msg.sender, bonusPending) {
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(msg.sender, bonusPending);
            } catch {
                unforwardedBonusRewards[msg.sender] += bonusPending;
                totalUnforwardedBonus += bonusPending;
                emit BonusTransferDeferred(msg.sender, bonusPending);
            }
        }

        // Update state
        // AUDIT H-1: release this user's principal reservation before transferring the NFT.
        // AUDIT FIX: DR2-01 — use the principal captured BEFORE the stale-path
        // mutated `info.positionAmount`. Pre-fix, when the stale-path overwrote
        // `info.positionAmount = currentAmount` (== 0 for force-closed
        // positions), this decrement subtracted 0 and the original principal
        // leaked into `totalActivePrincipal` permanently — silently DOS'ing
        // `recoverStuckPrincipal` for honest force-closed users.
        if (cachedPrincipalAtEntry <= totalActivePrincipal) {
            totalActivePrincipal -= cachedPrincipalAtEntry;
        } else {
            totalActivePrincipal = 0;
        }
        totalRestaked -= info.boostedAmount;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8: zero historical boost on unrestake

        // AUDIT FIX C-1: pull this tokenId's pre-transfer kick credits BEFORE
        // returning the NFT. Per-tokenId attribution (added to TegridyStaking)
        // ensures we drain ONLY this tokenId's share of the
        // `unsettledRewards[restakingContract]` bucket — not other restakers'
        // shares as the prior snapshot/delta path did under multi-restaker
        // contention. `claimUnsettledForTokenId` transfers directly to msg.sender
        // and is a no-op (returns 0) when there's nothing attributed.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 prePaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) {
            prePaid = _p;
        } catch {
            prePaid = 0;
        }

        // Return NFT to user. The transfer triggers `_settleRewardsOnTransfer`
        // on the staking side, which credits any final-period accrual to BOTH
        // the holder bucket AND `unsettledRewardsByTokenId[tokenId]` (for the
        // restakingContract → user transfer leg).
        // AUDIT FIX (BATCH-C H5): wrap in try/catch — if recipient is a hostile
        // contract or 7702-delegated EOA without onERC721Received, record stranded
        // mapping so user can self-recover via claimStrandedRestakeNFT after fixing
        // their wallet. Mirrors TegridyStakingJbacVault.returnJbac pattern (already
        // battle-tested in this codebase). Restaking-side state is already cleared
        // pre-transfer (lines 1056-1058) so a re-entrant double-vote is not possible
        // even on a hostile receive callback. The post-transfer claim is gated on
        // success because no _settleRewardsOnTransfer fires when the transfer reverts.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        bool nftDelivered;
        try stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId) {
            nftDelivered = true;
        } catch {
            strandedRestakeRecipient[tokenId] = msg.sender;
            emit RestakeNFTStranded(tokenId, msg.sender);
        }

        // AUDIT FIX C-1: pull the just-credited per-tokenId share from the
        // transfer hook, again going directly to msg.sender. Two-step claim
        // (pre + post) is what makes per-tokenId attribution exact.
        // (skipped on stranded path — _settleRewardsOnTransfer didn't fire)
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 postPaid;
        if (nftDelivered) {
            try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) {
                postPaid = _p2;
            } catch {
                postPaid = 0;
            }
        }

        uint256 totalUnsettled = prePaid + postPaid;

        // REVIEW C-1-FINDING-1: if either claim was pool-capped, residue stays in
        // `staking.unsettledRewardsByTokenId[tokenId]`. Reserve it to msg.sender
        // so a future restaker of the same NFT cannot drain it. Recoverable via
        // `claimResidualForTokenId(tokenId)` once the pool is replenished.
        _reserveResidual(tokenId, msg.sender);

        // Recover any previously deferred share from a prior under-funded
        // claim. `pendingUnsettledRewards` is preserved as a deferred-payment
        // mechanism — orthogonal to the per-tokenId attribution fix. We pull
        // from this contract's own balance (not from the staking bucket) since
        // that balance was funded by an earlier per-tokenId pull that the
        // staking pool couldn't fully service.
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        if (priorPending > 0) {
            pendingUnsettledRewards[msg.sender] = 0;
            totalPendingUnsettled -= priorPending;
            uint256 localBal = rewardToken.balanceOf(address(this));
            uint256 paid = priorPending > localBal ? localBal : priorPending;
            uint256 stillOwed = priorPending - paid;
            if (stillOwed > 0) {
                pendingUnsettledRewards[msg.sender] = stillOwed;
                totalPendingUnsettled += stillOwed;
            }
            if (paid > 0) {
                rewardToken.safeTransfer(msg.sender, paid);
                totalUnsettled += paid;
            }
        }

        if (totalUnsettled > 0) {
            emit UnsettledRecovered(msg.sender, totalUnsettled);
        }

        // Forward any unforwarded base rewards for this user (from revalidateBoost or other external calls)
        uint256 userUnforwarded = unforwardedBaseRewards[msg.sender];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[msg.sender] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        emit Unrestaked(msg.sender, tokenId);
    }

    /// @notice Recover unsettled rewards that could not be forwarded during a prior unrestake
    ///         (e.g., because another user's concurrent unrestake drained the shared bucket first).
    /// @dev AUDIT FIX: DEEP-DR-01 — mirror `recoverStuckPrincipal`'s reservation
    ///      logic. Pre-fix, this entrypoint paid `min(owed, balance)` directly,
    ///      with no protection for other users' attributed `unforwardedBaseRewards`
    ///      or for still-active restakers' principal. An attacker (or unlucky
    ///      sequencing) could drain rewardToken earmarked for honest users:
    ///      Bob has `unforwardedBaseRewards` after `proposeAttributeStuckRewards`,
    ///      Carol has shortfall in `pendingUnsettledRewards`, and Carol's
    ///      `claimPendingUnsettled` payout is computed as `min(owed, balance)` —
    ///      drains Bob's attributed share AND every active restaker's principal
    ///      reservation. The fix subtracts `totalUnforwardedBase + totalActivePrincipal`
    ///      from `available` BEFORE payout. Caller's own pending share is
    ///      decremented from `totalPendingUnsettled` AFTER computing `available`
    ///      to keep the reservation honest in the multi-claimer race.
    function claimPendingUnsettled() external nonReentrant {
        uint256 owed = pendingUnsettledRewards[msg.sender];
        if (owed == 0) revert ZeroAmount();

        // AUDIT FIX C-1 (follow-up): we INTENTIONALLY do NOT call
        // `staking.claimUnsettled()` here. The pre-C-1 implementation drained
        // the entire `unsettledRewards[restakingContract]` bucket, which (after
        // the C-1 fix) would silently consume per-tokenId attributions belonging
        // to other restakers — re-introducing the very race the C-1 fix closes.
        //
        // For NEW (post-fix) shortfalls, the user-facing recovery path is
        // `claimResidualForTokenId(tokenId)` below — it pulls the per-tokenId
        // residue directly from staking using the new attribution. This
        // function (`claimPendingUnsettled`) only services LEGACY entries that
        // were written by pre-fix code. For a fresh relaunch there are no
        // legacy entries and this function is effectively dead code; kept so
        // any pre-existing entry can still be redeemed against local balance
        // once an admin tops up via `attributeStuckRewards`.
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 reserved = totalUnforwardedBase + totalActivePrincipal;
        uint256 available = balance > reserved ? balance - reserved : 0;
        uint256 payout = owed > available ? available : owed;
        pendingUnsettledRewards[msg.sender] = owed - payout;
        // SECURITY FIX: Decrement totalPendingUnsettled by the amount paid out
        if (payout > 0) {
            totalPendingUnsettled -= payout;
            rewardToken.safeTransfer(msg.sender, payout);
            emit UnsettledRecovered(msg.sender, payout);
        }
    }

    /// @notice AUDIT FIX FRESH-2026: H-3 [F-04-1] + F-04-5 — internal helper
    ///         to sweep a user's deferred bonus credit. Wraps the transfer in
    ///         try/catch via the existing `_safeBonusTransferExt` self-call so
    ///         a still-blacklisted recipient doesn't brick the caller's exit
    ///         path. Returns the actually paid amount (zero if the recipient
    ///         is still blacklisted — credit stays in `unforwardedBonusRewards`
    ///         until they self-claim via `claimPendingBonusPayout`).
    function _sweepUnforwardedBonus(address user) internal returns (uint256 paid) {
        uint256 owed = unforwardedBonusRewards[user];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (owed == 0) return 0;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 available;
        try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
            available = bal;
        } catch {
            available = 0;
        }
        uint256 attempt = owed > available ? available : owed;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (attempt == 0) return 0;
        // Optimistically debit; rollback on transfer failure.
        unforwardedBonusRewards[user] = owed - attempt;
        if (totalUnforwardedBonus >= attempt) {
            totalUnforwardedBonus -= attempt;
        } else {
            totalUnforwardedBonus = 0;
        }
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        try this._safeBonusTransferExt(user, attempt) {
            totalBonusDistributed += attempt;
            emit BonusClaimed(user, attempt);
            paid = attempt;
        } catch {
            // Rollback: still owed.
            unforwardedBonusRewards[user] = owed;
            totalUnforwardedBonus += attempt;
            paid = 0;
        }
    }

    /// @notice AUDIT FIX FRESH-2026: F-04-5 — pull-pattern self-claim for a
    ///         user whose previous bonus payout was deferred (e.g. blacklisted
    ///         at exit time, now un-blacklisted). Reads from
    ///         `unforwardedBonusRewards` — the redemption-currency match
    ///         closes the H-3 wrong-token bug at the user-claim leg.
    // AUDIT FIX 2026-05-26 [M-05]: add `whenNotPaused` so deferred bonus payouts cannot
    // continue mid-incident. Closes the asymmetric-pause gap noted in the swarm audit —
    // sibling state-mutating paths (`claimResidualForTokenId` at line 1543) already gate
    // on pause. `emergencyWithdrawNFT` remains pause-free (true-emergency exit path).
    function claimPendingBonusPayout() external nonReentrant whenNotPaused {
        uint256 paid = _sweepUnforwardedBonus(msg.sender);
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (paid == 0) revert ZeroAmount();
    }

    /// @notice REVIEW C-1-FINDING-1/2: record a residual claim on `tokenId` for
    ///         `claimant` if the staking-side per-tokenId attribution wasn't
    ///         fully drained during the exit.
    /// @dev Called from unrestake / emergencyWithdrawNFT / emergencyForceReturn
    ///      AFTER both pre-transfer and post-transfer pulls. If
    ///      `staking.unsettledRewardsByTokenId(tokenId) > 0`, mark `claimant`
    ///      as the only entity allowed to recover that residue. Restake() of
    ///      the same tokenId by anyone else is then blocked until either the
    ///      claimant calls `claimResidualForTokenId` (and drains it) or the
    ///      claimant themselves restakes the same NFT again (preserves their
    ///      claim through the next exit cycle).
    function _reserveResidual(uint256 tokenId, address claimant) internal {
        uint256 residue = staking.unsettledRewardsByTokenId(tokenId);
        if (residue == 0) return;
        // AUDIT FIX 2026-05-26 [H-04]: ALWAYS overwrite `_residualClaimant` when
        // residue is non-zero. Pre-fix, the "preserve prior claimant" branch
        // was a hijack vector: Alice self-re-restakes (M28 carve-out admits
        // her because residue == 0 at that instant), exits during a later
        // pool-short event leaving residue R, and the function returned
        // without writing because `prior == alice` and `claimant == alice`
        // would have matched anyway — BUT if Alice sold the NFT to Bob and
        // Bob restaked + exited with residue, this function's old logic
        // would have left `_residualClaimant[tokenId] = alice` because
        // `prior == alice && prior != bob`, locking Bob's residue to Alice
        // (cross-holder gate blocks Alice from pulling). The residue
        // physically belongs to the current exit caller; preserving a
        // stale prior is incorrect. The audit doc cites this as the
        // "residual claim hijack" class — closes that surface.
        _residualClaimant[tokenId] = claimant;
        emit ResidualReserved(tokenId, claimant, residue);
    }

    /// @notice REVIEW C-1-FINDING-1/2/3: recover a previously-reserved
    ///         per-tokenId residue once the staking reward pool is replenished.
    /// @dev Auth gates by `_residualClaimant[tokenId]` so only the original
    ///      restaker can pull. Pulls from staking via the existing per-tokenId
    ///      path (which transfers DIRECTLY to `recipient = msg.sender`). When
    ///      the staking-side residue is fully drained the claim is cleared,
    ///      reopening the tokenId for re-restake by any new owner.
    function claimResidualForTokenId(uint256 tokenId) external nonReentrant whenNotPaused returns (uint256 paid) {
        if (_residualClaimant[tokenId] != msg.sender) revert NotResidualClaimant();

        uint256 residueBefore = staking.unsettledRewardsByTokenId(tokenId);
        if (residueBefore == 0) {
            // Already drained (e.g. by a self-re-restake + unrestake cycle).
            // Clear the stale claim so the tokenId is reopened.
            delete _residualClaimant[tokenId];
            return 0;
        }

        // AUDIT FIX LD-NEW-H1 (cross-protocol mirror): refuse the per-tokenId pull
        // when the NFT is currently held by ANOTHER tracked holder (e.g. TegridyLending
        // or a future lending whitelist entry). The `unsettledRewardsByTokenId[tokenId]`
        // mapping is shared across all tracked holders that the NFT may pass through;
        // the residualClaimant guard prevents OTHER restakers from acquiring the NFT
        // and accruing fresh credits, but does NOT prevent the NFT from going into
        // lending escrow — where lending-side kicks would credit the same per-tokenId
        // bucket. Without this check, the prior restaker (still set as residualClaimant)
        // could drain a borrower's loan-period rewards via the same shared mapping.
        // Returning early (with `paid = 0`) keeps the residual claim live so the
        // restaker can retry once the NFT exits lending; legitimate pre-fix residue
        // is unaffected because by the time this fix evaluates, the NFT is in lending,
        // meaning any pre-fix residue has either been drained by restaking's own
        // settlement OR was never created (the lending escrow accumulates fresh).
        address currentOwner = staking.ownerOf(tokenId);
        if (currentOwner != address(this) && currentOwner != msg.sender) {
            // NFT is at a third party — most likely a tracked-holder lending contract.
            // Drain attempt aborted; claim stays live for a future window when the
            // NFT returns to msg.sender (the residual claimant) or is unstaked entirely.
            emit ResidualPullDeferredCrossHolder(tokenId, currentOwner);
            return 0;
        }

        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) {
            paid = _p;
        } catch {
            paid = 0;
        }

        if (paid > 0) emit ResidualClaimed(tokenId, msg.sender, paid);

        // If the staking-side residue is fully drained, clear the claim so
        // any future owner of the NFT can restake without being blocked.
        if (staking.unsettledRewardsByTokenId(tokenId) == 0) {
            delete _residualClaimant[tokenId];
        }
    }

    /// @notice Voluntary forfeit of an unclaimed residual claim by the current
    ///         claimant. Closes the secondary-market grief documented in
    ///         FRESH-2026 finding RESTAKE-RESIDUAL-WAIVE-SECONDARY-MARKET:
    ///         pre-fix, a prior restaker who held a non-zero residual claim
    ///         on `tokenId` could only release it by either (a) calling
    ///         `claimResidualForTokenId` when the staking pool was replenished,
    ///         OR (b) waiting 7 days for the owner-timelocked
    ///         `proposeClearResidualClaimant` / `executeClearResidualClaimant`
    ///         flow. Neither helped a prior restaker who had sold the NFT and
    ///         wanted to enable the buyer to restake immediately: the new owner
    ///         was locked out for at least 7 days through no fault of their own,
    ///         and the prior restaker had no way to forfeit the claim
    ///         instantly even though it was *their* right to forfeit.
    /// @dev    AUDIT FIX FRESH-2026: RESTAKE-RESIDUAL-WAIVE-SECONDARY-MARKET [HIGH]
    ///         — Compound governance pattern (proposer can cancel their own
    ///         proposal pre-execution). No timelock because the caller is
    ///         giving up a right that belongs only to them; no third party
    ///         is harmed. Any unclaimed residue on the staking side stays
    ///         attributable per `unsettledRewardsByTokenId[tokenId]` and is
    ///         claimable by the next legitimate restaker.
    /// @param tokenId The tsTOWELI NFT token ID whose residual claim to waive.
    // AUDIT FIX 2026-05-26 [M-05]: `whenNotPaused` mirrors claimPendingBonusPayout +
    // claimResidualForTokenId. Waiving is irreversible — must not be triggerable
    // during pause when owner is investigating compromised keys.
    function waiveResidualClaim(uint256 tokenId) external nonReentrant whenNotPaused {
        if (_residualClaimant[tokenId] != msg.sender) revert NotResidualClaimant();
        delete _residualClaimant[tokenId];
        emit ResidualClaimWaived(tokenId, msg.sender);
    }

    // ─── AUDIT FIX FRESH-2026: F-04-3 — abandoned residual claimant escape ──

    /// @notice Owner-only timelocked clear/retarget of an abandoned residual
    ///         claimant on `tokenId`. Pre-fix, a lost-key restaker who held
    ///         a residual lock perma-blocked re-restake of that NFT (the
    ///         `restake()` guard requires either claimant == msg.sender OR
    ///         `staking.unsettledRewardsByTokenId == 0`). 7-day timelock +
    ///         per-tokenId proposal + visible events let the original
    ///         claimant surface and object before clearance.
    /// @param tokenId The tsTOWELI NFT token ID whose residual claim to clear.
    /// @param newClaimant Pass `address(0)` to fully clear; pass a non-zero
    ///         address (e.g. the new NFT owner) to retarget the claim.
    function proposeClearResidualClaimant(uint256 tokenId, address newClaimant) external onlyOwner {
        if (_residualClaimant[tokenId] == address(0)) revert BadParam();
        // AUDIT FIX FRESH-2026 [H-RESTAKE-CLEAR-ABANDONS-RESIDUE]: reject the
        // `newClaimant == address(0)` "fully abandon" path. Pre-fix, executing
        // with newClaimant=0 would `delete _residualClaimant[tokenId]` while
        // leaving the staking-side `unsettledRewardsByTokenId[tokenId]`
        // residue UNCLAIMED. The next restaker of that NFT would then trigger
        // `claimUnsettledForTokenId(tokenId, newRestaker)` on the next
        // unrestake, silently inheriting the abandoned lost-key user's
        // residue. Owner intent ("clear the local claim") quietly leaked
        // those funds to a third party.
        //
        // Fix (option b from finding): force owner to nominate a successor.
        // If no clear successor exists, the original `_residualClaimant`
        // stays in place; the lost-key user's residue remains stuck (no
        // worse than the pre-fix state) but no one else can siphon it. The
        // legitimate claimant retains the self-help path via
        // `waiveResidualClaim` (L1681-1685) if they ever recover their key.
        if (newClaimant == address(0)) revert ZeroAddress();
        // AUDIT FIX 2026-05-26 [M-03]: reject when a proposal is already pending.
        // Pre-fix, a captured-key owner could spam re-proposals to keep resetting
        // the 7-day executeAfter clock; multisig would have to cancel each one.
        // Mirrors sibling timelocked setters' `ExistingProposalPending` shape from
        // TimelockAdmin (uses tokenId as the disambiguator key).
        if (pendingResidualClears[tokenId].executeAfter != 0) {
            revert ExistingProposalPending(bytes32(tokenId));
        }
        pendingResidualClears[tokenId] = PendingResidualClear({
            newClaimant: newClaimant,
            executeAfter: block.timestamp + CLEAR_RESIDUAL_TIMELOCK
        });
        emit ResidualClearProposed(tokenId, newClaimant, block.timestamp + CLEAR_RESIDUAL_TIMELOCK);
    }

    function executeClearResidualClaimant(uint256 tokenId) external onlyOwner {
        PendingResidualClear memory p = pendingResidualClears[tokenId];
        if (p.executeAfter == 0) revert NoPendingResidualClear();
        if (block.timestamp < p.executeAfter) revert ResidualClearTimelockNotElapsed();
        // AUDIT FIX (2026-05-25 2nd pass): stale-proposal expiry — matches the 7-day
        // validity every sibling inline timelock enforces, so a proposal from a since-
        // rotated/compromised owner key cannot be executed an arbitrary time later.
        if (block.timestamp > p.executeAfter + CLEAR_RESIDUAL_VALIDITY) revert ResidualClearExpired();
        address oldClaimant = _residualClaimant[tokenId];
        if (p.newClaimant == address(0)) {
            delete _residualClaimant[tokenId];
        } else {
            _residualClaimant[tokenId] = p.newClaimant;
        }
        delete pendingResidualClears[tokenId];
        emit ResidualClearExecuted(tokenId, oldClaimant, p.newClaimant);
    }

    function cancelClearResidualClaimant(uint256 tokenId) external onlyOwner {
        if (pendingResidualClears[tokenId].executeAfter == 0) revert NoPendingResidualClear();
        delete pendingResidualClears[tokenId];
        emit ResidualClearCancelled(tokenId);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Fund the bonus reward pool
    /// M-01, M-04: Added updateBonus and nonReentrant modifiers
    /// @dev AUDIT FIX FRESH-2026: F-51-1 — measure balance-delta to defend
    ///      against a fee-on-transfer / rebasing bonus token. Pre-fix,
    ///      `totalBonusFunded` counted the nominal `_amount` while the
    ///      contract actually received `_amount * (1 - feeBps)`. Late
    ///      claimers saw their `safeTransfer` revert when the on-hand
    ///      balance ran out before `totalBonusFunded` exhausted. Mirrors
    ///      `TegridyStaking.notifyRewardAmount` pattern.
    function fundBonus(uint256 _amount) external nonReentrant updateBonus {
        if (_amount == 0) revert ZeroAmount();
        uint256 balBefore = bonusRewardToken.balanceOf(address(this));
        bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = bonusRewardToken.balanceOf(address(this)) - balBefore;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert ZeroAmount();
        totalBonusFunded += received;
        emit BonusFunded(received);
    }

    /// @notice DEPRECATED: Use proposeBonusRate + executeBonusRateChange instead.
    function setBonusRewardPerSecond(uint256) external pure {
        revert("DEPRECATED: use proposeBonusRate()");
    }

    /// @notice SECURITY FIX #13: Propose a new bonus reward rate (subject to 48h timelock)
    /// @dev AUDIT FIX: DEEP-DR-07 — gate proposals behind a 24h cooldown shared
    ///      with `cancelBonusRateProposal` so a captured signer cannot loop
    ///      propose+cancel to keep rate-change state churning indefinitely.
    ///      Order of checks:
    ///        1. RateTooHigh (input validation)
    ///        2. _propose's ExistingProposalPending (legacy back-compat — preserves
    ///           audit195 test suite expectations)
    ///        3. cooldown gate (only relevant after a previous propose+cancel)
    ///      The cooldown only applies AFTER the first action (lastBonusRateActionAt
    ///      is left zero at deploy so the first rate proposal is unblocked).
    function proposeBonusRate(uint256 _rate) external onlyOwner updateBonus {
        // AUDIT FIX FRESH-2026: F-04-7 + F-84-1 — symmetric decimal-scaled cap.
        if (_rate > maxBonusRewardRate()) revert RateTooHigh();
        // _propose handles the ExistingProposalPending check internally.
        // We delay the cooldown check until AFTER that so the legacy
        // "second propose reverts with ExistingProposalPending" test passes.
        if (lastBonusRateActionAt != 0 &&
            _executeAfter[BONUS_RATE_CHANGE] == 0 &&
            block.timestamp < lastBonusRateActionAt + BONUS_RATE_ACTION_COOLDOWN) {
            revert BonusRateActionCooldown();
        }
        pendingBonusRate = _rate;
        lastBonusRateActionAt = block.timestamp;
        _propose(BONUS_RATE_CHANGE, BONUS_RATE_TIMELOCK);
        emit BonusRateProposed(_rate, _executeAfter[BONUS_RATE_CHANGE]);
    }

    /// @notice SECURITY FIX #13: Execute pending bonus rate change after timelock
    function executeBonusRateChange() external onlyOwner updateBonus {
        _execute(BONUS_RATE_CHANGE);
        bonusRewardPerSecond = pendingBonusRate;
        emit BonusRateExecuted(pendingBonusRate);
        pendingBonusRate = 0;
    }

    /// @notice M-03: Cancel a pending bonus rate proposal
    /// @dev AUDIT FIX: DR2-05 — REMOVED the cooldown gate from
    ///      `cancelBonusRateProposal`. The DR-07 v1 fix gated BOTH propose and
    ///      cancel behind the same 24h cooldown. While that stopped the
    ///      propose+cancel churn loop, it also blocked the FIRST cancel within
    ///      24h of a propose — halving the multisig's defensive responsiveness
    ///      against a captured-signer malicious propose. The asymmetric trade
    ///      was wrong: defensive cancel is exactly the action the multisig
    ///      MUST be able to take immediately when it spots a hostile proposal.
    ///
    ///      Fix: cancel is now always allowed. Anti-churn protection remains
    ///      via the propose-side cooldown — a compromised signer cannot
    ///      indefinitely re-propose at sub-24h cadence even if they cancel
    ///      between proposes. Pattern of record: OZ TimelockController allows
    ///      cancel without cooldown; only propose is rate-limited.
    function cancelBonusRateProposal() external onlyOwner {
        _cancel(BONUS_RATE_CHANGE);
        uint256 cancelledRate = pendingBonusRate;
        pendingBonusRate = 0;
        // AUDIT FIX: DR2-05 — still update `lastBonusRateActionAt` on cancel so
        // the propose-side cooldown observes this cancel as a recent action.
        // The next propose remains gated by the 24h window from this cancel
        // (anti-churn). Defensive cancel itself is unblocked.
        lastBonusRateActionAt = block.timestamp;
        emit BonusRateCancelled(cancelledRate);
    }

    /// @notice AUDIT FIX H-02: Sweep stuck reward tokens (from revalidateBoost or other external calls).
    /// @dev AUDIT FIX 2026-05-26 [M-09]: split into propose/execute behind a 24h
    ///      timelock. Pre-fix, the function was instant-onlyOwner. The chained
    ///      defense via `address(staking)` + Staking's own 24h timelocked sweep
    ///      already mitigated drain (BATCH-J1 H17), but the visible 24h propose
    ///      window here gives off-chain monitoring an extra signal AND aligns
    ///      with every other captured-owner-residual-surface fix in this batch.
    ///      DELETE > ADD principle: kept the original receiver invariants
    ///      (address(staking), bonus/reward token rejects); only added the
    ///      timelock wrapper using existing TimelockAdmin base.
    bytes32 public constant SWEEP_STUCK_CHANGE = keccak256("RESTAKING_SWEEP_STUCK_REWARDS");
    uint256 public constant SWEEP_STUCK_TIMELOCK = 24 hours;
    address public pendingSweepStuckToken;

    event SweepStuckProposed(address indexed token, uint256 executeAfter);
    event SweepStuckCancelled(address indexed token);
    event SweepStuckExecuted(address indexed token, uint256 amount);

    function proposeSweepStuckRewards(address _token) external onlyOwner {
        if (_token == address(bonusRewardToken)) revert CannotSweepBonusToken();
        if (_token == address(rewardToken)) revert CannotSweepRewardToken();
        if (_token == address(0)) revert ZeroAddress();
        pendingSweepStuckToken = _token;
        _propose(SWEEP_STUCK_CHANGE, SWEEP_STUCK_TIMELOCK);
        emit SweepStuckProposed(_token, _executeAfter[SWEEP_STUCK_CHANGE]);
    }

    function executeSweepStuckRewards() external onlyOwner {
        _execute(SWEEP_STUCK_CHANGE);
        address _token = pendingSweepStuckToken;
        pendingSweepStuckToken = address(0);
        // Re-check guards at execute time — defends against a token classification
        // changing during the 24h window (e.g., rewardToken rotated on staking side
        // via that contract's 48h timelock).
        if (_token == address(bonusRewardToken)) revert CannotSweepBonusToken();
        if (_token == address(rewardToken)) revert CannotSweepRewardToken();
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance > 0) {
            // Route to address(staking) (immutable) — see BATCH-J1 H17 rationale.
            IERC20(_token).safeTransfer(address(staking), balance);
            emit SweepStuckExecuted(_token, balance);
        }
    }

    function cancelSweepStuckRewards() external onlyOwner {
        address cancelled = pendingSweepStuckToken;
        pendingSweepStuckToken = address(0);
        _cancel(SWEEP_STUCK_CHANGE);
        emit SweepStuckCancelled(cancelled);
    }

    /// @notice DEPRECATED — pre-2026-05-26 instant sweep. Use the
    ///         propose/execute pair above. Reverts to flag to callers
    ///         that migration is required.
    function sweepStuckRewards(address) external view onlyOwner {
        revert("AUDIT 2026-05-26 [M-09]: use proposeSweepStuckRewards/executeSweepStuckRewards");
    }

    /// @notice AUDIT FIX H-06: Recover stuck principal TOWELI when the underlying staking
    ///         position was force-closed (e.g., via emergencyExitPosition) while the NFT was
    ///         held by this contract. The principal is sent to the restaking contract as the
    ///         NFT owner, but the original restaker has no path to retrieve it.
    ///         Callable by a restaker whose position amount dropped to zero.
    function recoverStuckPrincipal() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // H-01 FIX: Prevent duplicate recovery
        if (_hasRecoveredPrincipal[msg.sender]) revert BadParam();

        // Verify the underlying position is actually zeroed out (force-closed)
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        if (currentAmount != 0) revert BadParam();

        // Calculate how much rewardToken (TOWELI) this contract has beyond tracked obligations.
        // SECURITY FIX: Include totalPendingUnsettled in reserved amount to protect other
        // users' unclaimed rewards.
        // AUDIT H-1: also reserve the principal of all still-active restakers so a burst
        // of force-closed users competing for the recoverable pool can't let the first
        // callers drain everything and leave later callers with zero. We subtract the
        // caller's own positionAmount from the reservation because they're about to be
        // paid out of that very amount; if we didn't subtract, a solo recoverer would
        // see payout=0. The subtraction is safe because info.positionAmount <=
        // totalActivePrincipal (invariant maintained by restake/unrestake/emergencyWithdrawNFT).
        uint256 originalAmount = info.positionAmount;
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 othersPrincipal = totalActivePrincipal >= originalAmount
            ? totalActivePrincipal - originalAmount
            : 0;
        uint256 reserved = totalUnforwardedBase + totalPendingUnsettled + othersPrincipal;
        uint256 recoverable = balance > reserved ? balance - reserved : 0;

        // Cap to the user's original position amount (they shouldn't get more than they staked)
        uint256 payout = recoverable > originalAmount ? originalAmount : recoverable;

        // AUDIT FIX FRESH-2026: F-04-6 — allow `recoverStuckPrincipal` to ALSO
        // sweep the caller's `unforwardedBaseRewards` even when principal is
        // fully reserved (payout == 0). Pre-fix, the C-01 revert here gated
        // the ENTIRE function — including the `unforwardedBaseRewards` sweep
        // below. A force-closed user whose principal was fully reserved
        // could not collect their personal stuck-base rewards via this
        // entrypoint. Now: only revert when BOTH payout==0 AND
        // unforwardedBaseRewards == 0; non-zero stuck base falls through.
        uint256 stuckBaseAtEntry = unforwardedBaseRewards[msg.sender];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (payout == 0 && stuckBaseAtEntry == 0) revert BadParam();

        // H-01 FIX: Mark as recovered before transfer (CEI pattern)
        _hasRecoveredPrincipal[msg.sender] = true;

        // H-02 FIX: Clear restaker state to prevent repeated drains.
        // Must be done BEFORE the transfer (CEI pattern).
        uint256 boosted = info.boostedAmount;
        if (boosted <= totalRestaked) {
            totalRestaked -= boosted;
        }
        // AUDIT H-1: release this user's principal reservation (guarded against underflow
        // in the exotic case where totalActivePrincipal got out of sync).
        if (originalAmount <= totalActivePrincipal) {
            totalActivePrincipal -= originalAmount;
        } else {
            totalActivePrincipal = 0;
        }
        delete tokenIdToRestaker[info.tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8

        // AUDIT FIX (BATCH-M2 M27): sweep unforwardedBaseRewards inline. Pre-fix
        // force-closed user lost their revalidateBoost-credited rewards forever
        // since restakers[msg.sender] is now deleted. Mirrors unrestake() base-
        // forward path (compressed inline to fit EIP-170 budget).
        uint256 stuckBase = unforwardedBaseRewards[msg.sender];
        if (stuckBase > 0) {
            unforwardedBaseRewards[msg.sender] = 0;
            if (totalUnforwardedBase >= stuckBase) totalUnforwardedBase -= stuckBase;
            uint256 baseBal = rewardToken.balanceOf(address(this));
            uint256 paid = stuckBase > baseBal ? baseBal : stuckBase;
            if (paid > 0) {
                rewardToken.safeTransfer(msg.sender, paid);
                emit BaseClaimed(msg.sender, paid);
            }
        }

        // AUDIT FIX FRESH-2026: H-3 [F-04-1] — also sweep deferred BONUS-token
        // credits so a force-closed restaker recovers everything in one call.
        _sweepUnforwardedBonus(msg.sender);

        if (payout > 0) {
            totalRecoveredPrincipal += payout;
            rewardToken.safeTransfer(msg.sender, payout);
            emit BaseClaimed(msg.sender, payout);
        }
    }

    /// @notice SECURITY FIX: Propose attributing stuck base rewards (24h timelock).
    ///         When revalidateBoost() is called externally on a restaked NFT, _getReward()
    ///         sends TOWELI to this contract with no way to identify the recipient.
    ///         Owner proposes attribution, then executes after 24h delay.
    /// @param _restaker The restaker address to credit
    /// @param _amount The amount of rewardToken to attribute
    function proposeAttributeStuckRewards(address _restaker, uint256 _amount) external onlyOwner {
        if (restakers[_restaker].tokenId == 0) revert NotRestaked();
        if (_amount == 0) revert ZeroAmount();
        pendingAttribution = PendingAttribution({
            restaker: _restaker,
            amount: _amount
        });
        _propose(ATTRIBUTION_CHANGE, ATTRIBUTE_TIMELOCK);
        emit AttributionProposed(_restaker, _amount, _executeAfter[ATTRIBUTION_CHANGE]);
    }

    /// @notice Execute a previously proposed stuck reward attribution after the 24h timelock.
    function executeAttributeStuckRewards() external onlyOwner {
        _execute(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        if (restakers[p.restaker].tokenId == 0) revert NotRestaked();
        // Cap attribution to actual unattributed rewardToken balance.
        // AUDIT FIX F-2: subtract `totalActivePrincipal` AND `totalPendingUnsettled`
        // from the unattributed pool. Pre-fix, the cap only excluded `totalUnforwardedBase`,
        // letting a captured-or-colluding owner credit a chosen restaker with rewards
        // that were actually backing OTHER users' principal reservations or pending
        // unsettled deferral. The colluder's subsequent `claimAll`/`unrestake` then
        // pulled funds that legitimate restakers needed for their `recoverStuckPrincipal`
        // path — driving honest recoveries to revert with NO_RECOVERABLE_BALANCE.
        // Three-line subtract keeps the cap honest: only TRULY unbacked balance can
        // be retro-attributed.
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 reserved = totalUnforwardedBase + totalActivePrincipal + totalPendingUnsettled;
        uint256 unattributed = balance > reserved ? balance - reserved : 0;
        if (p.amount > unattributed) revert BadParam();
        unforwardedBaseRewards[p.restaker] += p.amount;
        totalUnforwardedBase += p.amount;
        delete pendingAttribution;
        emit StuckBaseRewardsAttributed(p.restaker, p.amount);
    }

    /// @notice Cancel a pending stuck reward attribution proposal.
    function cancelAttributeStuckRewards() external onlyOwner {
        _cancel(ATTRIBUTION_CHANGE);
        PendingAttribution memory p = pendingAttribution;
        delete pendingAttribution;
        emit AttributionCancelled(p.restaker, p.amount);
    }

    /// @notice SECURITY FIX #12: Emergency withdraw NFT without attempting reward calculations.
    ///         Forfeits all pending bonus rewards. Use if reward math is broken.
    /// H-02: Added updateBonus modifier so accBonusPerShare is current before state changes
    /// @dev AUDIT FIX: Removed updateBonus modifier — if bonusRewardToken is paused/blacklisted,
    ///      updateBonus would revert on balanceOf(), permanently bricking this emergency exit.
    ///      User forfeits bonus anyway, so skipping the update is safe.
    function emergencyWithdrawNFT() external nonReentrant {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        uint256 tokenId = info.tokenId;
        // AUDIT H-1: release this user's principal reservation.
        // AUDIT FIX FRESH-2026: RESTAKE-EMERGENCY-WITHDRAW-UNDERFLOW [MEDIUM] —
        //         use the same `<=` guarded subtraction the other exit paths
        //         already use (lines 856/858, 971/973, 1058/1060, 1266/1268,
        //         1787/1789, 2134-2138, 2511-2513). Pre-fix, this single
        //         emergency-exit path subtracted unconditionally — if global
        //         accounting ever drifted (a prior exit path's stranded
        //         remainder, future invariant break, etc.), the emergency
        //         exit would underflow-revert and brick the user's escape
        //         hatch. The clamp-to-zero pattern preserves the emergency
        //         primitive's "always succeed if you have a position" semantic.
        if (info.positionAmount <= totalActivePrincipal) {
            totalActivePrincipal -= info.positionAmount;
        } else {
            totalActivePrincipal = 0;
        }
        if (info.boostedAmount <= totalRestaked) {
            totalRestaked -= info.boostedAmount;
        } else {
            totalRestaked = 0;
        }
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];
        _writeBoostCheckpoint(msg.sender, 0); // AUDIT H-8

        // AUDIT FIX C-1: pull per-tokenId pre-transfer kick credits before
        // returning the NFT. Same exact pattern as `unrestake()` — per-NFT
        // attribution on the staking side (`unsettledRewardsByTokenId`)
        // prevents the prior multi-restaker race where the snapshot/delta
        // path drained other restakers' shares from the shared
        // `unsettledRewards[restakingContract]` bucket.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 prePaid;
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p) {
            prePaid = _p;
        } catch {
            prePaid = 0;
        }

        // Return NFT to user. The transfer triggers `_settleRewardsOnTransfer`
        // which credits any final-period accrual to BOTH holder bucket AND
        // `unsettledRewardsByTokenId[tokenId]`.
        // AUDIT FIX (BATCH-C H5): same try/catch + stranded-record pattern as
        // unrestake() above. Self-DoS protection for hostile / 7702 EOAs.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        bool emNftDelivered;
        try stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId) {
            emNftDelivered = true;
        } catch {
            strandedRestakeRecipient[tokenId] = msg.sender;
            emit RestakeNFTStranded(tokenId, msg.sender);
        }

        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 postPaid;
        if (emNftDelivered)
        try staking.claimUnsettledForTokenId(tokenId, msg.sender) returns (uint256 _p2) {
            postPaid = _p2;
        } catch {
            postPaid = 0;
        }

        uint256 totalUnsettled = prePaid + postPaid;

        // REVIEW C-1-FINDING-2: same residual reservation as unrestake() so a
        // pool-shortfall doesn't leak this restaker's per-tokenId share to a
        // future restaker of the same NFT.
        _reserveResidual(tokenId, msg.sender);

        // Recover any previously deferred share. Same logic as `unrestake()`.
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        if (priorPending > 0) {
            pendingUnsettledRewards[msg.sender] = 0;
            totalPendingUnsettled -= priorPending;
            uint256 localBal = rewardToken.balanceOf(address(this));
            uint256 paid = priorPending > localBal ? localBal : priorPending;
            uint256 stillOwed = priorPending - paid;
            if (stillOwed > 0) {
                pendingUnsettledRewards[msg.sender] = stillOwed;
                totalPendingUnsettled += stillOwed;
            }
            if (paid > 0) {
                rewardToken.safeTransfer(msg.sender, paid);
                totalUnsettled += paid;
            }
        }

        if (totalUnsettled > 0) {
            emit UnsettledRecovered(msg.sender, totalUnsettled);
        }

        // S2-05: Forward any unforwarded base rewards before clearing state
        uint256 userUnforwarded = unforwardedBaseRewards[msg.sender];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[msg.sender] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(msg.sender, actual);
                emit BaseClaimed(msg.sender, actual);
            }
        }

        // AUDIT FIX FRESH-2026: H-3 [F-04-1] — also sweep deferred BONUS-token
        // credits even on emergency exit (paid in bonusRewardToken via the
        // self-call try/catch wrapper; failure stays queued for self-claim).
        _sweepUnforwardedBonus(msg.sender);

        emit EmergencyWithdraw(msg.sender, tokenId);
    }

    /// @notice AUDIT FIX (BATCH-C H5, mirrors TegridyStakingJbacVault.claimStrandedJbac):
    ///         Permissionless retry path for an NFT that failed delivery during
    ///         `unrestake` / `emergencyWithdrawNFT` (recipient was a hostile contract
    ///         or 7702-delegated EOA without `onERC721Received`). Caller must be the
    ///         recorded entitled recipient — they typically retry after removing
    ///         their EIP-7702 delegation or upgrading their wallet.
    /// @dev    CEI: clear stranded record BEFORE outbound transfer so a re-entrant
    ///         claim cannot double-collect. nonReentrant adds defense-in-depth.
    /// @dev    No try/catch on the retry — if it still fails, the user can call
    ///         again until they fix their wallet (state was rolled back by the
    ///         outer `tx.revert`, so the stranded mapping persists).
    function claimStrandedRestakeNFT(uint256 tokenId) external nonReentrant {
        address to = strandedRestakeRecipient[tokenId];
        if (to == address(0) || to != msg.sender) revert NotRestakedToken();
        delete strandedRestakeRecipient[tokenId];
        stakingNFT.safeTransferFrom(address(this), to, tokenId);
        emit RestakeNFTReclaimed(tokenId, to);
    }

    // ─── Pause ────────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Pause restaking to halt new deposits during emergencies
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice mvp-launch Phase 0.4 — pause-only emergency guardian role.
    ///         See base/PauseGuardian.sol. setPauseGuardian rotates instantly
    ///         (owner-gated); guardianPause freezes (no unpause authority).
    function setPauseGuardian(address _newGuardian) external onlyOwner {
        _setPauseGuardian(_newGuardian);
    }

    function guardianPause() external onlyPauseGuardian { _pause(); }

    // ─── Rescue ──────────────────────────────────────────────────────

    /// @notice AUDIT FIX FRESH-2026: M-3 [F-03-K3] + M-4 [F-04-2] — converted
    ///         to a timelocked propose/execute pair. Pre-fix:
    ///           * rescueNFT was instant onlyOwner constrained to
    ///             `address(staking)`, but staking has no IERC721Receiver, so
    ///             rescue ALWAYS reverted — NFTs sent direct (bypassing
    ///             restake()) were permanently stuck.
    ///           * No `strandedRestakeRecipient` check — captured owner could
    ///             rescue a stranded NFT into a dead-end before user's claim
    ///             path could fire.
    ///         Post-fix:
    ///           * Free `_to` with 48h timelock for visibility.
    ///           * Stranded-recipient check denies rescue while a user's
    ///             claim path is live (M-3).
    ///           * tokenIdToRestaker check preserved (BATCH-J1 H18 intent).
    function proposeRescueNFT(uint256 _tokenId, address _to) external onlyOwner {
        if (tokenIdToRestaker[_tokenId] != address(0)) revert BadParam();
        // AUDIT FIX FRESH-2026: M-3 [F-03-K3] — refuse rescue while a user's
        // stranded claim is live; user's `claimStrandedRestakeNFT` takes
        // precedence over owner rescue.
        if (strandedRestakeRecipient[_tokenId] != address(0)) revert BadParam();
        // AUDIT FIX 2026-05-26 [M-06]: refuse rescue while a residual claim is live.
        // Pre-fix, rescue would extract the NFT to `_to`, leaving the residue
        // permanently unreachable (the cross-holder gate at claimResidualForTokenId
        // line 1568 then blocks recovery because ownerOf is now `_to`). Owner can
        // still clear via the 7-day `proposeClearResidualClaimant` path first.
        if (_residualClaimant[_tokenId] != address(0)) revert BadParam();
        if (_to == address(0)) revert ZeroAddress();
        pendingRescueNFT = PendingRescueNFT({tokenId: _tokenId, to: _to});
        _propose(RESCUE_NFT_CHANGE, RESCUE_NFT_TIMELOCK);
        emit RescueNFTProposed(_tokenId, _to, _executeAfter[RESCUE_NFT_CHANGE]);
    }

    function executeRescueNFT() external onlyOwner {
        _execute(RESCUE_NFT_CHANGE);
        PendingRescueNFT memory p = pendingRescueNFT;
        // Re-check at execute (proposal could go stale during 48h window —
        // tokenId re-restaked, user filed stranded claim, etc).
        if (tokenIdToRestaker[p.tokenId] != address(0)) revert BadParam();
        if (strandedRestakeRecipient[p.tokenId] != address(0)) revert BadParam();
        // SELF-AUDIT FIX 2026-05-26 [M-06 SYMMETRIC RECHECK]: also re-check
        // residual claimant at execute time. Pre-fix the propose-time check
        // (M-06) was asymmetric — a residue claim materializing during the 48h
        // window (currently unreachable but defense-in-depth) would let rescue
        // strand the residue. Mirrors the propose-time guard at line ~2199.
        if (_residualClaimant[p.tokenId] != address(0)) revert BadParam();
        delete pendingRescueNFT;
        stakingNFT.safeTransferFrom(address(this), p.to, p.tokenId); // M-16
        emit RescueNFTExecuted(p.tokenId, p.to);
    }

    function cancelRescueNFT() external onlyOwner {
        _cancel(RESCUE_NFT_CHANGE);
        uint256 tid = pendingRescueNFT.tokenId;
        delete pendingRescueNFT;
        emit RescueNFTCancelled(tid);
    }

    // ─── H-05: Emergency Force Return ──────────────────────────────

    /// @notice H-05: Emergency force-return a staking NFT to the restaker even if the staking contract is broken.
    /// @dev onlyOwner + whenPaused. Uses try/catch on the NFT transfer — if transfer fails,
    ///      the restaking position is still cleaned up so the user's bonus rewards are settled.
    /// @param tokenId The tsTOWELI NFT token ID to force-return
    function emergencyForceReturn(uint256 tokenId) external onlyOwner whenPaused nonReentrant {
        // H-02 FIX: Rate-limit emergency force returns
        if (block.timestamp < lastForceReturnTime + FORCE_RETURN_COOLDOWN) revert BadParam();
        lastForceReturnTime = block.timestamp;

        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();

        RestakeInfo storage info = restakers[restaker];

        // AUDIT FIX: DEEP-DR-03 / DEEP-DR-06 — delegate accrual to
        // `_accrueBonusChecked()` instead of inlining the unguarded logic.
        // The wrapped path:
        //   - is monotonicity-checked (any subclass that decrements
        //     accBonusPerShare trips `AccrueNotMonotone()` — DEEP-DR-03), and
        //   - wraps `bonusRewardToken.balanceOf` in try/catch via `_accrueBonus`
        //     (so a hostile or paused bonus token cannot brick the emergency
        //     exit — DEEP-DR-06).
        // Pre-fix, both protections existed in the modifier path but were absent
        // from this critical-path inline copy.
        _accrueBonusChecked();

        // AUDIT FIX FRESH-2026: H-3 [F-04-1] — sweep deferred BONUS-token credits
        // first (paid in bonusRewardToken via the self-call try/catch wrapper).
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        _sweepUnforwardedBonus(restaker);

        // Settle any pending bonus rewards for the restaker
        if (info.boostedAmount > 0) {
            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            // AUDIT FIX FRESH-2026: anchor bonusDebt regardless of transfer
            // success so post-recovery accounting stays consistent. Pre-fix
            // this path never wrote bonusDebt — a re-fired emergencyForceReturn
            // could re-credit the same emission slice.
            info.bonusDebt = accumulated;
            if (bonusPending > 0) {
                // AUDIT FIX FRESH-2026: F-51-5 — wrap in try/catch via existing
                // self-call so a blacklisted recipient does NOT brick the
                // last-resort recovery path. Defer into the bonus bucket;
                // restaker self-claims via `claimPendingBonusPayout()` after
                // un-blacklisting.
                try this._safeBonusTransferExt(restaker, bonusPending) {
                    totalBonusDistributed += bonusPending;
                    emit BonusClaimed(restaker, bonusPending);
                } catch {
                    unforwardedBonusRewards[restaker] += bonusPending;
                    totalUnforwardedBonus += bonusPending;
                    emit BonusTransferDeferred(restaker, bonusPending);
                }
            }
        }

        // Forward any unforwarded base rewards
        uint256 userUnforwarded = unforwardedBaseRewards[restaker];
        if (userUnforwarded > 0) {
            uint256 remainingBase = rewardToken.balanceOf(address(this));
            uint256 actual = userUnforwarded > remainingBase ? remainingBase : userUnforwarded;
            unforwardedBaseRewards[restaker] -= actual;
            if (totalUnforwardedBase >= actual) totalUnforwardedBase -= actual;
            if (actual > 0) {
                rewardToken.safeTransfer(restaker, actual);
                emit BaseClaimed(restaker, actual);
            }
        }

        // Clean up restaking state
        // AUDIT FIX FRESH-2026: RESTAKE-EMERGENCY-WITHDRAW-UNDERFLOW [MEDIUM] —
        //         apply the same `<=` guard to `totalRestaked` that DEEP-DR-02
        //         applied to `totalActivePrincipal` below. Both globals should
        //         use the clamp-to-zero pattern so a single drifted invariant
        //         cannot brick the emergency-force-return primitive.
        if (info.boostedAmount <= totalRestaked) {
            totalRestaked -= info.boostedAmount;
        } else {
            totalRestaked = 0;
        }
        // AUDIT FIX: DEEP-DR-02 — release this user's principal reservation. Pre-fix,
        // `emergencyForceReturn` was the ONLY NFT-exit path that omitted this update,
        // leaving `totalActivePrincipal` permanently inflated by the force-returned
        // user's principal. The phantom reservation then drove `recoverStuckPrincipal`'s
        // `othersPrincipal` calculation upward, silently DOS'ing legitimate force-closed
        // recoveries. Underflow guard mirrors `recoverStuckPrincipal`.
        if (info.positionAmount <= totalActivePrincipal) {
            totalActivePrincipal -= info.positionAmount;
        } else {
            totalActivePrincipal = 0;
        }

        // REVIEW C-1-FINDING-2: pull per-tokenId pre-transfer kick credits before
        // returning the NFT — same pattern as unrestake/emergencyWithdrawNFT.
        // Without this, the restaker's per-tokenId-attributed credit was orphaned
        // (credited to `unsettledRewards[restakingContract]` and recorded in
        // `unsettledRewardsByTokenId[tokenId]`), and any subsequent restaker of
        // the SAME NFT would silently drain it on their unrestake.
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        try staking.claimUnsettledForTokenId(tokenId, restaker) {} catch {}

        // AUDIT FIX (BATCH-C H4 — re-entrant double-vote close):
        // CLEAR restaking-side state BEFORE the safeTransferFrom callback fires.
        // Pre-fix sequence: stakingNFT.safeTransferFrom → staking-side _afterTokenTransfer
        // adds tokenId to _positionsByOwner[restaker] and writes a vote checkpoint at T,
        // so staking.votingPowerOf(restaker) returns boostedAmount. The recipient's
        // onERC721Received callback can then read VotePowerOracle.powerOf(restaker)
        // which sums staking + restaking. Because restakers[restaker].boostedAmount
        // was STILL set at this moment (deletion was after the transfer), the read
        // returned 2X — letting a malicious-recipient contract vote with double
        // their real power inside any governance consumer (GaugeController,
        // VoteIncentives, CommunityGrants, etc.).
        // Fix: zero restaker boost in BOTH the storage struct AND the Trace208
        // checkpoint BEFORE invoking safeTransferFrom. The unrestake() path at
        // L1057-1078 already does this correctly — emergencyForceReturn was the
        // outlier. Pattern: standard CEI (effects before interactions).
        delete restakers[restaker];
        _writeBoostCheckpoint(restaker, 0);
        // tokenIdToRestaker is preserved here pre-transfer so the M-04 stuck-NFT
        // recovery (rescueNFT only-original-restaker) still works. We delete it
        // post-transfer-success, NOT pre-transfer.

        // Attempt to return the NFT — if staking contract is broken, this may fail
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        bool nftReturned;
        try stakingNFT.safeTransferFrom(address(this), restaker, tokenId) {
            nftReturned = true;
        } catch {
            // AUDIT FIX FRESH-2026: M-2 [F-03-K2] — record stranded recipient so
            // the user can self-recover via `claimStrandedRestakeNFT(tokenId)`
            // after fixing their wallet (e.g. removing EIP-7702 delegation,
            // or deploying an `IERC721Receiver`-compliant wrapper). Pre-fix,
            // this catch arm only flipped `nftReturned = false` — the NFT
            // became permanently stuck because:
            //   * `restakers[restaker]` was already cleared (line ~1771),
            //     locking out `unrestake` / `emergencyWithdrawNFT`.
            //   * `claimStrandedRestakeNFT` required `strandedRestakeRecipient
            //     [tokenId] == msg.sender` — never set on this branch.
            //   * `rescueNFT` (BATCH-J1 H18 hardening) was constrained to
            //     `address(staking)` AND blocked by `tokenIdToRestaker
            //     [tokenId] != address(0)`, so even owner-routed rescue
            //     reverted.
            // Now: parallel to unrestake/emergencyWithdrawNFT (both already
            // record the stranded mapping on transfer failure), this path
            // also writes it. The user-facing recovery path is now uniform
            // across all three exit points.
            //
            // AUDIT FIX M-04 (legacy): tokenIdToRestaker mapping preserved
            // (handled below post-catch). Primary recovery path is now via
            // strandedRestakeRecipient.
            strandedRestakeRecipient[tokenId] = restaker;
            emit RestakeNFTStranded(tokenId, restaker);
            nftReturned = false;
        }

        // REVIEW C-1-FINDING-2: post-transfer pull captures the final-period
        // accrual that `_settleRewardsOnTransfer` just credited (only fires if
        // the NFT actually moved — try/catch handles the stuck-NFT case).
        if (nftReturned) {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            try staking.claimUnsettledForTokenId(tokenId, restaker) {} catch {}
        }

        // REVIEW C-1-FINDING-2: reserve any remaining per-tokenId residue to the
        // original restaker so a future acquirer of the NFT cannot drain it.
        _reserveResidual(tokenId, restaker);

        if (nftReturned) {
            // Full cleanup only if NFT was successfully returned (restakers + boost
            // checkpoint already cleared above pre-transfer for re-entrancy CEI).
            delete tokenIdToRestaker[tokenId];
        }
        // If !nftReturned, tokenIdToRestaker is preserved so rescueNFT can route
        // the stuck NFT back to the original restaker (M-04).

        emit EmergencyForceReturn(restaker, tokenId, nftReturned);
    }

    // ─── M-26: Revalidate Boost Proxy ───────────────────────────────

    /// @notice M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked position.
    /// @dev AUDIT NEW-S2 (HIGH): TegridyStaking.revalidateBoost is restricted to
    ///      owner/restakingContract to prevent permissionless boost-strip griefing.
    ///      Now restricted to the restaker themselves or the owner.
    /// @dev AUDIT FIX 2026-05-16 M11: dropped the `updateBonus` modifier; the
    ///      modifier accrued at the INFLATED `totalRestaked` (still including
    ///      `oldBoosted`) BEFORE `staking.revalidateBoost` downgraded the boost.
    ///      The elapsed-period emission was credited against an inflated denominator
    ///      so the downgrading restaker captured their share of bonus they were
    ///      no longer entitled to (JBAC-lost dilution). Now uses the canonical
    ///      R014 RETRY pattern from `claimAll` (lines 880-941): settle pending
    ///      bonus on OLD boost at PRE-accrue → shrink `totalRestaked` →
    ///      `_accrueBonusChecked` against corrected denominator → re-anchor
    ///      `bonusDebt` on NEW boost POST-accrue.
    /// @param tokenId The tsTOWELI NFT token ID to revalidate
    function revalidateBoostForRestaked(uint256 tokenId) external nonReentrant {
        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();
        if (msg.sender != restaker && msg.sender != owner()) revert Unauthorized();

        RestakeInfo storage info = restakers[restaker];

        // AUDIT FIX M-08: Balance-delta tracking around revalidateBoost.
        // SLITHER NOTE 2026-05-17: the `staking.revalidateBoost(tokenId)` external
        // call MUST precede the bonus-settle below because the settle needs the
        // NEW boostedAmount that only becomes readable after staking-side decay.
        // Slither flags `info.bonusDebt`/`info.boostedAmount`/`totalRestaked`
        // state-writes-after-external-call as reentrancy-no-eth. False positive:
        //   (a) `nonReentrant` on this contract blocks re-entry from outside,
        //   (b) `staking.revalidateBoost` is itself nonReentrant on the staking
        //       side and only triggers `rewardToken.safeTransfer` to THIS
        //       contract (standard ERC20, no callback) which lands in the
        //       `unforwardedBaseRewards` mapping (unrelated to bonusDebt),
        //   (c) cross-function reentrancy via `pendingBonus`/`pendingBase` is
        //       view-only and cannot enable theft.
        // Same structural pattern as `claimAll` lines 880-941; the ordering
        // difference is forced by revalidate's "need post-decay boost" semantic.
        uint256 balBefore = rewardToken.balanceOf(address(this));
        // slither-disable-next-line reentrancy-no-eth,reentrancy-benign,reentrancy-events
        staking.revalidateBoost(tokenId);
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[restaker] += received;
            totalUnforwardedBase += received;
        }

        // AUDIT FIX 2026-05-16 M11: R014 RETRY pattern. Step 1 — settle bonus on
        // OLD boost at PRE-accrue accBonusPerShare. Anchor bonusDebt BEFORE the
        // external bonus transfer (CEI).
        uint256 oldBoosted = info.boostedAmount;
        // SLITHER NOTE 2026-05-17: explicit `= 0` silences uninitialized-local
        // warning. Solidity defaults uint256 to 0 anyway; this is cosmetic.
        uint256 preBonus = 0;
        if (oldBoosted > 0) {
            int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 preDiff = preAccum - info.bonusDebt;
            preBonus = preDiff > 0 ? uint256(preDiff) : 0;
            info.bonusDebt = preAccum;
        }
        if (preBonus > 0) {
            bonusRewardToken.safeTransfer(restaker, preBonus);
            totalBonusDistributed += preBonus;
        }

        // Step 2 — shrink totalRestaked using the new boost from staking.
        // SLITHER NOTE 2026-05-17: the 10 unused tuple-element destructures are
        // intentional — only `boostedAmount` is needed here. Acknowledged false
        // positive ("unused-return"); the staking-side tuple shape is fixed by
        // the position struct and there's no cheaper read.
        // slither-disable-next-line unused-return
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        _writeBoostCheckpoint(restaker, newBoostedAmount);
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;

        // Step 3 — accrue against the corrected (smaller) denominator. Honest
        // restakers earn their fair share of the elapsed-since-last-accrue period.
        _accrueBonusChecked();

        // Step 4 — re-anchor bonusDebt at POST-accrue accBonusPerShare so the
        // caller cannot share in future emission on a boost they no longer hold.
        if (newBoostedAmount > 0) {
            info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);
        } else {
            info.bonusDebt = 0;
        }

        emit BoostRevalidated(restaker, tokenId, oldBoosted, newBoostedAmount);
    }

    /// @notice #23/M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked
    ///         position by user address.
    /// @dev AUDIT FIX 2026-05-16 M11: same `updateBonus` modifier drop + R014 RETRY
    ///      pattern as the sister `revalidateBoostForRestaked` above. See that
    ///      function's NatSpec for full rationale.
    /// @param _user The restaker address whose boost should be revalidated
    function revalidateBoostForRestaker(address _user) external nonReentrant {
        RestakeInfo storage info = restakers[_user];
        if (info.tokenId == 0) revert NotRestaked();
        if (msg.sender != _user && msg.sender != owner()) revert Unauthorized();

        uint256 tokenId = info.tokenId;

        // AUDIT FIX M-08: Balance-delta tracking around revalidateBoost.
        // SLITHER NOTE 2026-05-17: same false-positive rationale as the sister
        // `revalidateBoostForRestaked` above — see that function's note.
        uint256 balBefore = rewardToken.balanceOf(address(this));
        // slither-disable-next-line reentrancy-no-eth,reentrancy-benign,reentrancy-events
        staking.revalidateBoost(tokenId);
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[_user] += received;
            totalUnforwardedBase += received;
        }

        // AUDIT FIX 2026-05-16 M11: R014 RETRY pattern (see sister
        // revalidateBoostForRestaked for full step-by-step rationale).
        uint256 oldBoosted = info.boostedAmount;
        // SLITHER NOTE 2026-05-17: explicit `= 0` for clarity (Solidity default).
        uint256 preBonus = 0;
        if (oldBoosted > 0) {
            int256 preAccum = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 preDiff = preAccum - info.bonusDebt;
            preBonus = preDiff > 0 ? uint256(preDiff) : 0;
            info.bonusDebt = preAccum;
        }
        if (preBonus > 0) {
            bonusRewardToken.safeTransfer(_user, preBonus);
            totalBonusDistributed += preBonus;
        }

        // SLITHER NOTE 2026-05-17: intentional unused-tuple destructure.
        // slither-disable-next-line unused-return
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        _writeBoostCheckpoint(_user, newBoostedAmount);
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;

        _accrueBonusChecked();

        if (newBoostedAmount > 0) {
            info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);
        } else {
            info.bonusDebt = 0;
        }

        emit BoostRevalidated(_user, tokenId, oldBoosted, newBoostedAmount);
    }

    // ─── SECURITY FIX: Decay Expired Restaker ─────────────────────
    /// @notice Permissionless: force-refresh a restaker whose staking lock has expired.
    /// @dev Without this, a restaker whose lock expires continues earning bonus rewards
    ///      at their full boosted rate because TegridyRestaking's cached `totalRestaked`
    ///      and per-user `boostedAmount` are never updated when TegridyStaking decays them.
    ///      This function reads the current position from TegridyStaking (where boostedAmount
    ///      is decayed to 0 on expiry) and syncs the cached values here.
    /// @param _restaker The restaker address to decay
    ///
    /// @dev AUDIT NEW-S3 (HIGH): the `updateBonus` modifier accrues bonus based on
    ///      the current `totalRestaked` BEFORE this function body runs. When a
    ///      restaker's lock expires, their cached `boostedAmount` stays inflated
    ///      until someone calls this helper — during which time `totalRestaked`
    ///      overstates the true denominator. Accrual against the inflated
    ///      denominator mints less `accBonusPerShare` per unit, so honest
    ///      restakers earn less, and the expired restaker's own pending bonus at
    ///      settlement is computed against the inflated cached amount — they
    ///      siphon the delta from honest users.
    ///
    ///      Fix: settle the expired restaker and update totalRestaked FIRST, then
    ///      run the bonus accrual against the corrected denominator. The period
    ///      immediately before this call still used the stale denominator (that
    ///      part of the past is sunk), but every future elapsed unit from now on
    ///      accrues fairly.
    function decayExpiredRestaker(address _restaker) external nonReentrant {
        RestakeInfo storage info = restakers[_restaker];
        if (info.tokenId == 0) revert NotRestaked();

        // AUDIT FIX 2026-05-26 [M-01]: trigger staking-side lazy decay BEFORE reading
        // the cached boosted amount. Without this, the staking position's
        // `boostedAmount` is still inflated (lazy-decay model — only updates on
        // touch), so the equality check below trips `NoDecay` even though
        // decay IS due. Mirrors the pattern at claimAll / unrestake / refreshPosition.
        // try/catch absorbs any future revert from staking-side kick.
        try staking.kick(info.tokenId) {} catch { /* fall through with stale cache */ }

        // Read current position from staking contract (where decay has been applied)
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);

        // Only proceed if the cached value differs (i.e., decay happened).
        // AUDIT NFT-CL-M4: typed error replaces legacy revert("NO_DECAY") string.
        if (currentBoosted == info.boostedAmount) revert NoDecay();

        uint256 oldBoosted = info.boostedAmount;

        // R017 RETRY step 1 — settle the expired restaker on the stale (cached)
        // oldBoosted against the CURRENT accBonusPerShare (reflects accrual up
        // to lastBonusRewardTime ONLY — NOT yet to block.timestamp). This pays
        // them their fair share under the accounting that was actually in
        // effect for prior periods. Anchor bonusDebt BEFORE transfer (CEI).
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            info.bonusDebt = accumulated; // CEI: anchor BEFORE external call
            if (bonusPending > 0) {
                // AUDIT FIX (BATCH-N4 M26): wrap bonus transfer in try/catch
                // via this.* self-call so a bricked-recipient (blacklist, hook
                // revert) doesn't brick the entire decay sync. Pre-fix, totalRestaked
                // would stay inflated indefinitely after a bricked decay attempt,
                // siphoning honest restakers' bonus emission until owner ran
                // emergencyForceReturn. Now: on transfer failure, accumulate to
                // unforwardedBaseRewards (re-uses existing path; restaker can
                // sweep later via recoverStuckPrincipal or unrestake's stuck-base).
                // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
                // slither-disable-next-line reentrancy-no-eth
                try this._safeBonusTransferExt(_restaker, bonusPending) {
                    totalBonusDistributed += bonusPending;
                    emit BonusClaimed(_restaker, bonusPending);
                } catch {
                    // AUDIT FIX FRESH-2026: H-3 [F-04-1] — route the deferred
                    // BONUS-token credit into the bonus bucket (not the
                    // rewardToken-denominated `unforwardedBaseRewards` that
                    // the pre-fix code used). Pre-fix, every redemption site
                    // (claimAll/unrestake/emergency*/recoverStuckPrincipal)
                    // paid `unforwardedBaseRewards` out in `rewardToken`
                    // (TOWELI), silently swapping a (potentially WETH-valued)
                    // bonus credit for a TOWELI-valued payout. Now: deferred
                    // bonus credits stay denominated in `bonusRewardToken`
                    // and are paid out via the same self-call wrapper later
                    // (see `claimPendingBonusPayout` and the redemption sites
                    // in claimAll/unrestake/etc.).
                    unforwardedBonusRewards[_restaker] += bonusPending;
                    totalUnforwardedBonus += bonusPending;
                    emit BonusTransferDeferred(_restaker, bonusPending);
                }
            }
        }

        // R017 RETRY step 2 — shrink totalRestaked and update cached
        // boostedAmount BEFORE running fresh accrual. The micro-period from
        // lastBonusRewardTime to block.timestamp will be divided by the
        // corrected (smaller) denominator, so honest restakers earn their
        // fair share for every future second.
        info.boostedAmount = currentBoosted;
        _writeBoostCheckpoint(_restaker, currentBoosted); // AUDIT H-8
        totalRestaked = totalRestaked - oldBoosted + currentBoosted;

        // R017 RETRY step 3 — accrue the elapsed period against the corrected
        // denominator. This is the key reordering: previously, _accrueBonus
        // ran BEFORE the totalRestaked shrink, so the elapsed-period emission
        // was minted into accBonusPerShare against the inflated denominator —
        // letting the expired restaker siphon the delta from honest users.
        // AUDIT FIX: DEEP-DR-03 — use the monotonicity-checked wrapper so a
        // malicious subclass overriding `_accrueBonus` (the function is
        // explicitly `virtual` to bait such overrides per AUDIT NFT-CL-L5)
        // cannot decrement `accBonusPerShare` from this permissionless
        // entrypoint. The wrapper reverts with `AccrueNotMonotone()`.
        _accrueBonusChecked();

        // R017 RETRY step 4 — re-anchor expired restaker's bonusDebt to the
        // post-accrue accBonusPerShare so residual rounding can't credit them
        // for emission they no longer share in.
        info.bonusDebt = _safeInt256((currentBoosted * accBonusPerShare) / ACC_PRECISION);

        // Also refresh positionAmount
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        // AUDIT FIX: DR2-01 — sync `totalActivePrincipal` to the new cached
        // principal BEFORE overwrite. Permissionless entrypoint, highest
        // leverage of the four sibling sites.
        // AUDIT FIX DR3-05: skip the totalActivePrincipal/positionAmount sync
        // entirely when currentAmount == 0 (force-closed staking position).
        // The pass-2 fix above eagerly synced positionAmount → 0, which broke
        // `recoverStuckPrincipal` for force-closed users (the recovery path
        // needs the ORIGINAL deposit amount to know what's recoverable; once
        // positionAmount is zeroed by a permissionless `decayExpiredRestaker`
        // call, the principal anchor is lost forever). The correct semantic
        // for force-closed positions is "unrestake / emergencyForceReturn
        // owns the cleanup"; this permissionless decay primitive only resyncs
        // when there's a non-zero principal to sync against.
        if (currentAmount > 0) {
            uint256 oldPositionAmount = info.positionAmount;
            if (oldPositionAmount >= currentAmount) {
                uint256 principalDelta = oldPositionAmount - currentAmount;
                if (principalDelta <= totalActivePrincipal) {
                    totalActivePrincipal -= principalDelta;
                } else {
                    totalActivePrincipal = 0;
                }
            } else {
                totalActivePrincipal += (currentAmount - oldPositionAmount);
            }
            info.positionAmount = currentAmount;
        }

        emit PositionRefreshed(_restaker, info.tokenId, oldBoosted, currentBoosted);
    }

    /// @dev AUDIT NEW-S3: extract the `updateBonus` modifier body into a reusable
    ///      internal function so `decayExpiredRestaker` can run accrual at a
    ///      specific step of the decay workflow instead of at the modifier's
    ///      fixed always-first position.
    /// @dev R014 RETRY: marked `virtual` so audit/red-team subclasses can override
    ///      to demonstrate that the `_accrueBonusChecked` wrapper traps any
    ///      `accBonusPerShare` decrement.
    /// @dev AUDIT NFT-CL-L5 (2026-04-28): the `virtual` modifier here is part of a
    ///      DEFENSIVE PATTERN — by exposing `_accrueBonus` as overridable, the
    ///      `_accrueBonusChecked` wrapper below becomes a meaningful runtime
    ///      tripwire. The base implementation is monotonically non-decreasing
    ///      by construction (it only writes via `accBonusPerShare += ...`),
    ///      so any override that decrements is, by definition, malicious or
    ///      buggy. This is NOT an extension hook for new product features —
    ///      it is bait for misbehaving subclasses, and the wrapper is the
    ///      enforcement mechanism. If you ever need a legitimate accrual
    ///      reset, do it through a NEW function, not by overriding this one.
    function _accrueBonus() internal virtual {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
            // slither-disable-next-line uninitialized-local
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                // AUDIT FIX FRESH-2026 [H-RESTAKE-BONUS-CAP-DEBT]: sibling-port
                // of the updateBonus modifier cap fix — see L468-489 for full
                // rationale. _accrueBonus is the stale-path settlement helper
                // called by claimAll / unrestake / refreshPosition / etc; it
                // must apply the same uncommitted-pool cap as the modifier.
                available = bal > totalUnforwardedBonus ? bal - totalUnforwardedBonus : 0;
            } catch {
                available = 0;
            }
            if (reward > available) {
                emit BonusShortfall(elapsed, reward - available);
                reward = available;
            }
            if (reward > 0) {
                accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
            }
            lastBonusRewardTime = block.timestamp;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        } else if (totalRestaked == 0) {
            lastBonusRewardTime = block.timestamp;
        }
    }

    /// @notice R014 RETRY: monotonicity-checked wrapper around `_accrueBonus`.
    /// @dev `accBonusPerShare` is monotonically non-decreasing by construction
    ///      (`_accrueBonus` only ever performs `accBonusPerShare += ...`). This
    ///      wrapper snapshots the value before the call and reverts with
    ///      `AccrueNotMonotone()` if the post-call value is strictly less. It is
    ///      a runtime tripwire for malicious or buggy subclasses that override
    ///      `_accrueBonus` to siphon emission. Replace every direct call to
    ///      `_accrueBonus()` in stale-path / R017 code paths with this wrapper.
    /// @dev AUDIT NFT-CL-L5 (2026-04-28): co-designed with the `virtual` marker
    ///      on `_accrueBonus` above. Together they form a "trust but verify"
    ///      pattern — subclasses are PERMITTED to override (the `virtual` lets
    ///      them), but their override is BOUND by this wrapper to remain
    ///      monotonic. Any subclass that decrements `accBonusPerShare` (e.g.,
    ///      to siphon already-accrued share back to itself) trips the
    ///      `AccrueNotMonotone()` revert and is unable to settle the
    ///      transaction. This is one of two defense-in-depth layers protecting
    ///      restaker accounting; the other is the post-hoc settlement-side
    ///      cap on per-position payouts.
    function _accrueBonusChecked() internal {
        uint256 snapshotPre = accBonusPerShare;
        _accrueBonus();
        if (accBonusPerShare < snapshotPre) revert AccrueNotMonotone();
    }

    // ─── M-27: Safe Int256 Helper ───────────────────────────────────

    /// @notice M-27: Safe cast from uint256 to int256, reverts on overflow
    function _safeInt256(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert Int256Overflow();
        return int256(value);
    }

    // ─── ERC721 Receiver ────────────────────────────────────────────

    /// L-03: Replace require string with custom error
    function onERC721Received(address, address, uint256, bytes calldata) external view override returns (bytes4) {
        if (msg.sender != address(staking)) revert OnlyStakingNFT();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// AUDIT FIX (BATCH-N4 M26): self-call wrapper for try/catch on bonus transfer.
    /// Permission-gated to address(this) so external callers can't grief.
    event BonusTransferDeferred(address indexed restaker, uint256 amount);
    function _safeBonusTransferExt(address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlyStakingNFT(); // reuse error for size
        bonusRewardToken.safeTransfer(to, amount);
    }

    /// @notice AUDIT FIX 2026-05-21 M19-PORT: override `acceptOwnership` so that any
    ///         pending proposals queued by the outgoing owner are CANCELLED on handoff.
    ///         Mirrors `TegridyLaunchpadV2.acceptOwnership` (TegridyLaunchpadV2.sol:426-438).
    ///         Without this override, an outgoing/compromised owner could queue hostile
    ///         proposals (e.g. `proposeBonusRateChange(10000)`, `proposeRescueNFT(tokenId, attacker)`)
    ///         immediately before `transferOwnership`; the timelock would silently keep running
    ///         and the new owner inherits an executable booby-trap.
    /// @dev    `lastBonusRateActionAt` is NOT updated here — the override is a one-shot
    ///         post-handoff sweep, not an operational cancel. Updating the anti-churn
    ///         cooldown would gate the new owner's first legitimate propose.
    ///         Per-tokenId `ResidualClear` proposals use a separate (non-TimelockAdmin)
    ///         state mapping (`pendingResidualClears`) and are NOT enumerable on-chain —
    ///         the new owner triages those individually via `cancelClearResidualClaimant(id)`.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[BONUS_RATE_CHANGE] != 0) {
            uint256 cancelledRate = pendingBonusRate;
            _cancel(BONUS_RATE_CHANGE);
            pendingBonusRate = 0;
            emit BonusRateCancelled(cancelledRate);
            // AUDIT FIX 2026-05-22 M19-PORT-REVIEW F-2: reset
            //   `lastBonusRateActionAt` so the propose-side BONUS_RATE_ACTION_COOLDOWN
            //   gate (lines 1684-1687) does NOT carry the outgoing owner's last-action
            //   timestamp into the new owner's first propose call. Pre-fix, the override
            //   left the timestamp set, gating the new owner with up to 24h of inherited
            //   cooldown even after the booby-trap proposal was cleared.
            lastBonusRateActionAt = 0;
        }
        if (_executeAfter[ATTRIBUTION_CHANGE] != 0) {
            PendingAttribution memory p = pendingAttribution;
            _cancel(ATTRIBUTION_CHANGE);
            delete pendingAttribution;
            emit AttributionCancelled(p.restaker, p.amount);
        }
        if (_executeAfter[RESCUE_NFT_CHANGE] != 0) {
            uint256 tid = pendingRescueNFT.tokenId;
            _cancel(RESCUE_NFT_CHANGE);
            delete pendingRescueNFT;
            emit RescueNFTCancelled(tid);
        }
        // AUDIT FIX FRESH-2026 [H-RESTAKE-ACCEPT-OWNERSHIP-SWEEP-STUCK]: cancel
        // any pending `SWEEP_STUCK_CHANGE` proposal on owner handoff. Pre-fix
        // the override only swept 3 of the 4 TimelockAdmin keys; an outgoing
        // owner could pre-queue `proposeSweepStuckRewards(arbitraryToken)`
        // immediately before transferOwnership, and the new owner would
        // inherit a live timelock. The execute destination IS hard-pinned to
        // `address(staking)` (L1870), but the new owner's first inadvertent
        // execute would still move tokens out of the restaking contract that
        // the new owner may have NOT intended to relocate. Sweep here for
        // parity with the BONUS_RATE / ATTRIBUTION / RESCUE_NFT clears.
        if (_executeAfter[SWEEP_STUCK_CHANGE] != 0) {
            address cancelledToken = pendingSweepStuckToken;
            pendingSweepStuckToken = address(0);
            _cancel(SWEEP_STUCK_CHANGE);
            emit SweepStuckCancelled(cancelledToken);
        }
    }
}
