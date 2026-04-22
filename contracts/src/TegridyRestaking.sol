// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

interface ITegridyStaking {
    function getReward(uint256 tokenId) external returns (uint256 claimed);
    function toggleAutoMaxLock(uint256 tokenId) external;
    function claimUnsettled() external;
    function unsettledRewards(address user) external view returns (uint256);
    function earned(uint256 tokenId) external view returns (uint256);
    function revalidateBoost(uint256 tokenId) external; // M-26
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
contract TegridyRestaking is OwnableNoRenounce, ReentrancyGuard, Pausable, IERC721Receiver, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 private constant ACC_PRECISION = 1e12;

    // ─── TimelockAdmin Keys ──────────────────────────────────────────
    bytes32 public constant BONUS_RATE_CHANGE = keccak256("BONUS_RATE_CHANGE");
    bytes32 public constant ATTRIBUTION_CHANGE = keccak256("ATTRIBUTION_CHANGE");

    // ─── State ──────────────────────────────────────────────────────
    IERC20 public immutable rewardToken;       // TOWELI
    IERC20 public immutable bonusRewardToken;  // ETH (WETH) or any ERC20 for bonus
    ITegridyStaking public immutable staking;  // TegridyStaking contract
    IERC721 public immutable stakingNFT;       // tsTOWELI NFT (same address as staking)

    uint256 public bonusRewardPerSecond;
    uint256 public lastBonusRewardTime;
    uint256 public accBonusPerShare;
    uint256 public totalRestaked;              // Sum of all deposited boosted amounts (used for bonus reward distribution)

    struct RestakeInfo {
        uint256 tokenId;          // The tsTOWELI NFT token ID
        uint256 positionAmount;   // Amount of TOWELI in the position (cached)
        uint256 boostedAmount;    // Boosted amount (cached for reward calc)
        int256 bonusDebt;         // Bonus reward debt
        uint256 depositTime;      // When NFT was deposited
        uint256 unsettledSnapshot;// AUDIT H-06: TegridyStaking.unsettledRewards(this) at deposit time.
                                  // Used for unrestake/emergencyWithdrawNFT delta attribution,
                                  // replacing the race-prone before/after read pattern.
    }

    mapping(address => RestakeInfo) public restakers;
    mapping(uint256 => address) public tokenIdToRestaker; // reverse lookup

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

    // SECURITY FIX #13: Timelock for reward rate changes
    uint256 public constant BONUS_RATE_TIMELOCK = 48 hours;
    uint256 public constant MAX_BONUS_REWARD_RATE = 100e18;
    uint256 public pendingBonusRate;

    // SECURITY FIX: Timelock for attributeStuckBaseRewards
    uint256 public constant ATTRIBUTE_TIMELOCK = 24 hours;
    struct PendingAttribution {
        address restaker;
        uint256 amount;
    }
    PendingAttribution public pendingAttribution;

    // H-01 FIX: Track per-user recovery to prevent race condition in recoverStuckPrincipal
    mapping(address => bool) public hasRecoveredPrincipal;
    uint256 public totalRecoveredPrincipal;

    // H-02 FIX: Rate-limit emergencyForceReturn to prevent rapid sequential draining
    uint256 public lastForceReturnTime;
    uint256 public constant FORCE_RETURN_COOLDOWN = 1 hours;

    // ─── Events ─────────────────────────────────────────────────────
    event Restaked(address indexed user, uint256 indexed tokenId, uint256 positionAmount);
    event Unrestaked(address indexed user, uint256 indexed tokenId);
    event BonusClaimed(address indexed user, uint256 bonusAmount);
    event BaseClaimed(address indexed user, uint256 baseAmount);
    event BonusFunded(uint256 amount);
    event BonusRateUpdated(uint256 newRate);
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

    // ─── Errors ─────────────────────────────────────────────────────
    error NotRestaked();
    error AlreadyRestaked();
    error NotNFTOwner();
    error InvalidNFT();
    error ZeroAmount();
    // Legacy error aliases (kept for test compatibility — TimelockAdmin errors are thrown instead)
    // Note: ProposalExpired() removed — use TimelockAdmin.ProposalExpired(bytes32) instead
    error TimelockNotElapsed(); // SECURITY FIX #13
    error RateTooHigh(); // SECURITY FIX #13
    error NoPendingRateChange(); // SECURITY FIX #13
    error CannotSweepBonusToken(); // SECURITY FIX: Prevent sweeping bonus reward pool
    error CannotSweepRewardToken(); // SECURITY FIX: Prevent sweeping base reward token
    error NoPendingAttribution();
    error AttributionTimelockNotElapsed();
    error AttributionExpired();
    error ExistingAttributionPending();
    error RewardTokenMatchesBonusToken(); // SECURITY FIX: Constructor validation
    error ZeroAddress(); // L-01: Zero-address validation
    error OnlyStakingNFT(); // L-03: Custom error for onERC721Received
    error Int256Overflow(); // M-27: Safe int256 cast guard
    error NotRestakedToken(); // M-26: Token not restaked in this contract
    error Unauthorized(); // AUDIT NEW-S2: restrict revalidate-boost helpers to owner/restaker

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _staking,
        address _rewardToken,
        address _bonusRewardToken,
        uint256 _bonusRewardPerSecond
    ) OwnableNoRenounce(msg.sender) {
        // L-01: Zero-address validation for all constructor params
        if (_staking == address(0)) revert ZeroAddress();
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_bonusRewardToken == address(0)) revert ZeroAddress();
        if (_rewardToken == _bonusRewardToken) revert RewardTokenMatchesBonusToken();
        // AUDIT FIX M-20: Bounds check for bonusRewardPerSecond to prevent extreme values
        require(_bonusRewardPerSecond <= 10e18, "BONUS_RATE_TOO_HIGH");
        staking = ITegridyStaking(_staking);
        stakingNFT = IERC721(_staking); // TegridyStaking IS the ERC721
        rewardToken = IERC20(_rewardToken);
        bonusRewardToken = IERC20(_bonusRewardToken);
        bonusRewardPerSecond = _bonusRewardPerSecond;
        lastBonusRewardTime = block.timestamp;
    }

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function bonusRateChangeTime() external view returns (uint256) { return _executeAfter[BONUS_RATE_CHANGE]; }
    function attributionExecuteAfter() external view returns (uint256) { return _executeAfter[ATTRIBUTION_CHANGE]; }

    // ─── Modifiers ──────────────────────────────────────────────────
    modifier updateBonus() {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                available = bal;
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
    function pendingBonus(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;

        uint256 currentAcc = accBonusPerShare;
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available = bonusRewardToken.balanceOf(address(this));
            if (reward > available) reward = available;
            currentAcc += (reward * ACC_PRECISION) / totalRestaked;
        }

        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((info.boostedAmount * currentAcc) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    /// @notice Check pending base staking rewards for the deposited NFT
    function pendingBase(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;
        return staking.earned(info.tokenId);
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
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;
        if (info.depositTime > _timestamp) return 0;
        return info.boostedAmount;
    }

    // ─── User Functions ─────────────────────────────────────────────

    /// @notice Deposit your tsTOWELI NFT to earn bonus yield
    /// @dev Transfers the NFT from caller to this contract
    function restake(uint256 _tokenId) external nonReentrant whenNotPaused updateBonus {
        if (restakers[msg.sender].tokenId != 0) revert AlreadyRestaked();

        // Verify caller owns the NFT
        if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();

        // Get position data from TegridyStaking
        (uint256 amount, uint256 boostedAmount,,,,,,, , ,) = staking.positions(_tokenId);
        if (amount == 0) revert ZeroAmount();

        // Transfer NFT to this contract — M-16: safeTransferFrom for safe NFT handling
        stakingNFT.safeTransferFrom(msg.sender, address(this), _tokenId);

        // Record restaking info
        // M-27: Safe int256 cast via _safeInt256 helper
        uint256 debtUint = (boostedAmount * accBonusPerShare) / ACC_PRECISION;
        // AUDIT H-06: snapshot unsettledRewards[this] at deposit time so the per-user
        // delta on unrestake is computed against a stable baseline rather than a racy
        // before/after read pair that a concurrent claimUnsettled() can corrupt.
        uint256 unsettledAtDeposit = staking.unsettledRewards(address(this));
        restakers[msg.sender] = RestakeInfo({
            tokenId: _tokenId,
            positionAmount: amount,
            boostedAmount: boostedAmount,
            bonusDebt: _safeInt256(debtUint),
            depositTime: block.timestamp,
            unsettledSnapshot: unsettledAtDeposit
        });

        tokenIdToRestaker[_tokenId] = msg.sender;
        totalRestaked += boostedAmount;
        // AUDIT H-1: track active principal so recoverStuckPrincipal can reserve it.
        totalActivePrincipal += amount;

        emit Restaked(msg.sender, _tokenId, amount);
    }

    /// @notice C-05: Refresh cached position data from TegridyStaking
    /// @dev Re-reads staking.positions(tokenId) and updates positionAmount and totalRestaked.
    ///      AUDIT FIX: Claims pending bonus before resetting debt to prevent silent forfeiture.
    function refreshPosition() external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // AUDIT FIX: Claim pending bonus rewards BEFORE resetting debt
        int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
        if (bonusPending > 0) {
            bonusRewardToken.safeTransfer(msg.sender, bonusPending);
            totalBonusDistributed += bonusPending;
            emit BonusClaimed(msg.sender, bonusPending);
        }

        uint256 oldAmount = info.positionAmount;
        uint256 oldBoosted = info.boostedAmount;

        // Re-read current position from staking contract
        (uint256 newAmount, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(info.tokenId);

        // AUDIT FIX: Prevent setting positionAmount to zero (would break bonus calculations)
        if (newAmount == 0) revert ZeroAmount();

        // Update cached values
        info.positionAmount = newAmount;
        info.boostedAmount = newBoostedAmount;

        // Update totalRestaked
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;

        // Reset bonus debt to current accumulated (rewards already claimed above)
        // M-27: Safe int256 cast via _safeInt256 helper
        uint256 newDebtUint = (newBoostedAmount * accBonusPerShare) / ACC_PRECISION;
        info.bonusDebt = _safeInt256(newDebtUint);

        emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, newAmount);
    }

    /// @notice Claim base staking rewards + bonus restaking rewards
    /// @dev SECURITY FIX H-03: Auto-refreshes cached position data from TegridyStaking
    ///      before calculating bonus rewards, preventing stale position exploitation.
    function claimAll() external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // SECURITY FIX H-03: Auto-refresh cached position data before bonus calculation.
        // Prevents earning bonus rewards on phantom capital after underlying position changes.
        // AUDIT FIX M-07: Also refresh when boostedAmount changes (e.g., JBAC revalidation,
        // lock extension) even if positionAmount is unchanged. Previously boost-only changes
        // were invisible to auto-refresh, allowing stale bonus accrual.
        {
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            if (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount) {
                // S2-01: Handle currentAmount == 0 — position was fully withdrawn from base staking.
                // Still need to settle bonus on old amount and update cached value to prevent phantom accrual.
                if (currentAmount == 0) {
                    // Claim any pending bonus on the now-defunct position
                    int256 zeroAccum = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
                    int256 zeroDiff = zeroAccum - info.bonusDebt;
                    uint256 zeroBonus = zeroDiff > 0 ? uint256(zeroDiff) : 0;
                    if (zeroBonus > 0) {
                        bonusRewardToken.safeTransfer(msg.sender, zeroBonus);
                        totalBonusDistributed += zeroBonus;
                        emit BonusClaimed(msg.sender, zeroBonus);
                    }
                    uint256 oldAmt = info.positionAmount;
                    totalRestaked -= info.boostedAmount;
                    info.positionAmount = 0;
                    info.boostedAmount = 0;
                    info.bonusDebt = 0;
                    emit PositionRefreshed(msg.sender, info.tokenId, oldAmt, 0);
                } else if (currentAmount > 0) {
                // Claim pending bonus on OLD boostedAmount first
                int256 preAccum = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
                int256 preDiff = preAccum - info.bonusDebt;
                uint256 preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }
                // Update cached values
                uint256 oldAmount = info.positionAmount;
                uint256 oldBoosted = info.boostedAmount;
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                totalRestaked = totalRestaked - oldBoosted + currentBoosted;
                // Reset debt after payout — M-27: Safe int256 cast
                uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                info.bonusDebt = _safeInt256(newDebtUint);
                emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, currentAmount);
                }
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

        // 2. Claim bonus rewards (skip if auto-refresh above already settled and reset debt)
        // SECURITY FIX C4: Explicit guard — only claim if debt drift exists after refresh
        // M-27: Safe int256 cast via _safeInt256 helper
        if (info.boostedAmount > 0) {
            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            info.bonusDebt = accumulated;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;

            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(msg.sender, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(msg.sender, bonusPending);
            }
        }
    }

    /// @notice Withdraw your NFT and stop restaking
    function unrestake() external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // S2-03: Auto-refresh cached position data before bonus calculation (same as claimAll)
        // AUDIT FIX M-07: Also compare boostedAmount to catch boost-only changes
        {
            (uint256 currentAmount, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);
            if (currentAmount != info.positionAmount || currentBoosted != info.boostedAmount) {
                // Claim pending bonus on OLD boostedAmount first
                int256 preAccum = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
                int256 preDiff = preAccum - info.bonusDebt;
                uint256 preBonus = preDiff > 0 ? uint256(preDiff) : 0;
                if (preBonus > 0) {
                    bonusRewardToken.safeTransfer(msg.sender, preBonus);
                    totalBonusDistributed += preBonus;
                    emit BonusClaimed(msg.sender, preBonus);
                }
                uint256 oldAmount = info.positionAmount;
                uint256 oldBoosted = info.boostedAmount;
                info.positionAmount = currentAmount;
                info.boostedAmount = currentBoosted;
                totalRestaked = totalRestaked - oldBoosted + currentBoosted;
                // M-27: Safe int256 cast
                uint256 newDebtUint = (currentBoosted * accBonusPerShare) / ACC_PRECISION;
                info.bonusDebt = _safeInt256(newDebtUint);
                emit PositionRefreshed(msg.sender, info.tokenId, oldAmount, currentAmount);
            }
        }

        uint256 tokenId = info.tokenId;
        uint256 totalBaseEarned = 0;

        // Disable autoMaxLock before withdrawing to prevent perpetual lock extension trap
        // AUDIT FIX H-01: Wrapped in try/catch so unrestake() works even if staking is paused
        // (toggleAutoMaxLock has whenNotPaused modifier). Without this, paused staking
        // would force users into emergencyWithdrawNFT() which forfeits bonus rewards.
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

        // Claim bonus rewards
        // M-27: Safe int256 cast via _safeInt256 helper
        int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
        int256 diff = accumulated - info.bonusDebt;
        info.bonusDebt = accumulated;
        uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
        if (bonusPending > 0) {
            bonusRewardToken.safeTransfer(msg.sender, bonusPending);
            totalBonusDistributed += bonusPending;
            emit BonusClaimed(msg.sender, bonusPending);
        }

        // Update state
        // AUDIT H-1: release this user's principal reservation before transferring the NFT.
        totalActivePrincipal -= info.positionAmount;
        totalRestaked -= info.boostedAmount;
        // AUDIT H-06: cache the deposit-time snapshot before deleting RestakeInfo.
        uint256 depositSnapshot = info.unsettledSnapshot;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];

        // Return NFT to user.
        // AUDIT H-06: compute user's unsettled delta against the deposit-time snapshot
        // instead of a racy before/after read pair. A concurrent staking.claimUnsettled()
        // firing between the two reads used to silently undercount this user's share.
        stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId); // M-16: safeTransferFrom for NFT returns
        uint256 unsettledAfter = staking.unsettledRewards(address(this));

        uint256 userUnsettledDelta = unsettledAfter > depositSnapshot ? unsettledAfter - depositSnapshot : 0;

        // Include any previously unrecovered unsettled from a prior concurrent unrestake
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        uint256 totalOwed = userUnsettledDelta + priorPending;
        pendingUnsettledRewards[msg.sender] = 0;
        // SECURITY FIX: Decrement totalPendingUnsettled by prior amount being rolled into totalOwed
        if (priorPending > 0) totalPendingUnsettled -= priorPending;

        if (totalOwed > 0) {
            uint256 balBeforeUnsettled = rewardToken.balanceOf(address(this));
            uint256 currentUnsettled = staking.unsettledRewards(address(this));
            if (currentUnsettled > 0) {
                try staking.claimUnsettled() {} catch {}
            }
            uint256 unsettledGain = rewardToken.balanceOf(address(this)) - balBeforeUnsettled;

            uint256 userPortion = totalOwed > unsettledGain ? unsettledGain : totalOwed;
            uint256 shortfall = totalOwed - userPortion;
            if (shortfall > 0) {
                pendingUnsettledRewards[msg.sender] = shortfall;
                // SECURITY FIX: Track new shortfall in totalPendingUnsettled
                totalPendingUnsettled += shortfall;
            }
            if (userPortion > 0) {
                rewardToken.safeTransfer(msg.sender, userPortion);
                emit UnsettledRecovered(msg.sender, userPortion);
            }
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
    function claimPendingUnsettled() external nonReentrant {
        uint256 owed = pendingUnsettledRewards[msg.sender];
        if (owed == 0) revert ZeroAmount();

        uint256 currentUnsettled = staking.unsettledRewards(address(this));
        if (currentUnsettled > 0) {
            try staking.claimUnsettled() {} catch {}
        }

        uint256 available = rewardToken.balanceOf(address(this));
        uint256 payout = owed > available ? available : owed;
        pendingUnsettledRewards[msg.sender] = owed - payout;
        // SECURITY FIX: Decrement totalPendingUnsettled by the amount paid out
        if (payout > 0) {
            totalPendingUnsettled -= payout;
            rewardToken.safeTransfer(msg.sender, payout);
            emit UnsettledRecovered(msg.sender, payout);
        }
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Fund the bonus reward pool
    /// M-01, M-04: Added updateBonus and nonReentrant modifiers
    function fundBonus(uint256 _amount) external nonReentrant updateBonus {
        if (_amount == 0) revert ZeroAmount();
        bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalBonusFunded += _amount;
        emit BonusFunded(_amount);
    }

    /// @notice DEPRECATED: Use proposeBonusRate + executeBonusRateChange instead.
    function setBonusRewardPerSecond(uint256) external pure {
        revert("DEPRECATED: use proposeBonusRate()");
    }

    /// @notice SECURITY FIX #13: Propose a new bonus reward rate (subject to 48h timelock)
    function proposeBonusRate(uint256 _rate) external onlyOwner updateBonus {
        if (_rate > MAX_BONUS_REWARD_RATE) revert RateTooHigh();
        pendingBonusRate = _rate;
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
    function cancelBonusRateProposal() external onlyOwner {
        _cancel(BONUS_RATE_CHANGE);
        uint256 cancelledRate = pendingBonusRate;
        pendingBonusRate = 0;
        emit BonusRateCancelled(cancelledRate);
    }

    /// @notice AUDIT FIX H-02: Sweep stuck reward tokens (from revalidateBoost or other external calls).
    ///         Base reward tokens (rewardToken) may arrive outside of claimAll flows and become stuck.
    ///         Cannot sweep bonusRewardToken to protect the bonus reward pool.
    function sweepStuckRewards(address _token) external onlyOwner {
        if (_token == address(bonusRewardToken)) revert CannotSweepBonusToken();
        // AUDIT FIX v2: Block sweeping base reward token to protect user rewards in transit
        if (_token == address(rewardToken)) revert CannotSweepRewardToken();
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(_token).safeTransfer(owner(), balance);
        }
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
        require(!hasRecoveredPrincipal[msg.sender], "ALREADY_RECOVERED");

        // Verify the underlying position is actually zeroed out (force-closed)
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        require(currentAmount == 0, "POSITION_STILL_ACTIVE");

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

        // C-01 FIX: Require non-zero payout. Without this, calling when balance is fully reserved
        // sets hasRecoveredPrincipal=true and deletes state, permanently locking out the user.
        require(payout > 0, "NO_RECOVERABLE_BALANCE");

        // H-01 FIX: Mark as recovered before transfer (CEI pattern)
        hasRecoveredPrincipal[msg.sender] = true;

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
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 unattributed = balance > totalUnforwardedBase ? balance - totalUnforwardedBase : 0;
        require(p.amount <= unattributed, "EXCEEDS_UNATTRIBUTED");
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
        totalActivePrincipal -= info.positionAmount;
        totalRestaked -= info.boostedAmount;
        // AUDIT H-06: cache deposit-time snapshot before deleting RestakeInfo.
        uint256 depositSnapshot = info.unsettledSnapshot;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];

        // Return NFT without attempting any reward claims.
        // AUDIT H-06: use deposit-time snapshot instead of racy before/after reads.
        stakingNFT.safeTransferFrom(address(this), msg.sender, tokenId); // M-16: safeTransferFrom for NFT returns
        uint256 unsettledAfter = staking.unsettledRewards(address(this));

        uint256 userUnsettledDelta = unsettledAfter > depositSnapshot ? unsettledAfter - depositSnapshot : 0;
        uint256 priorPending = pendingUnsettledRewards[msg.sender];
        uint256 totalOwed = userUnsettledDelta + priorPending;
        pendingUnsettledRewards[msg.sender] = 0;
        // SECURITY FIX: Decrement totalPendingUnsettled by prior amount being rolled into totalOwed
        if (priorPending > 0) totalPendingUnsettled -= priorPending;

        if (totalOwed > 0) {
            uint256 balBefore = rewardToken.balanceOf(address(this));
            uint256 currentUnsettled = staking.unsettledRewards(address(this));
            if (currentUnsettled > 0) {
                try staking.claimUnsettled() {} catch {}
            }
            uint256 unsettledGain = rewardToken.balanceOf(address(this)) - balBefore;
            uint256 userPortion = totalOwed > unsettledGain ? unsettledGain : totalOwed;
            uint256 shortfall = totalOwed - userPortion;
            if (shortfall > 0) {
                pendingUnsettledRewards[msg.sender] = shortfall;
                // SECURITY FIX: Track new shortfall in totalPendingUnsettled
                totalPendingUnsettled += shortfall;
            }
            if (userPortion > 0) {
                rewardToken.safeTransfer(msg.sender, userPortion);
                emit UnsettledRecovered(msg.sender, userPortion);
            }
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

        emit EmergencyWithdraw(msg.sender, tokenId);
    }

    // ─── Pause ────────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Pause restaking to halt new deposits during emergencies
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Rescue ──────────────────────────────────────────────────────

    /// @notice AUDIT FIX: Rescue NFTs accidentally sent via safeTransferFrom (not through restake())
    /// @param _tokenId The NFT token ID to rescue
    /// @param _to The address to send the NFT to
    function rescueNFT(uint256 _tokenId, address _to) external onlyOwner {
        require(tokenIdToRestaker[_tokenId] == address(0), "ACTIVELY_RESTAKED");
        require(_to != address(0), "ZERO_ADDRESS");
        stakingNFT.safeTransferFrom(address(this), _to, _tokenId); // M-16: safeTransferFrom for NFT returns
    }

    // ─── H-05: Emergency Force Return ──────────────────────────────

    /// @notice H-05: Emergency force-return a staking NFT to the restaker even if the staking contract is broken.
    /// @dev onlyOwner + whenPaused. Uses try/catch on the NFT transfer — if transfer fails,
    ///      the restaking position is still cleaned up so the user's bonus rewards are settled.
    /// @param tokenId The tsTOWELI NFT token ID to force-return
    function emergencyForceReturn(uint256 tokenId) external onlyOwner whenPaused nonReentrant {
        // H-02 FIX: Rate-limit emergency force returns
        require(block.timestamp >= lastForceReturnTime + FORCE_RETURN_COOLDOWN, "FORCE_RETURN_COOLDOWN");
        lastForceReturnTime = block.timestamp;

        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();

        RestakeInfo storage info = restakers[restaker];

        // Settle any pending bonus rewards for the restaker
        if (totalRestaked > 0 && info.boostedAmount > 0) {
            // Update bonus accumulator inline (cannot rely on updateBonus modifier in emergency)
            if (block.timestamp > lastBonusRewardTime) {
                uint256 elapsed = block.timestamp - lastBonusRewardTime;
                uint256 reward = elapsed * bonusRewardPerSecond;
                uint256 available = bonusRewardToken.balanceOf(address(this));
                if (reward > available) reward = available;
                if (reward > 0) {
                    accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
                }
                lastBonusRewardTime = block.timestamp;
            }

            int256 accumulated = _safeInt256((info.boostedAmount * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(restaker, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(restaker, bonusPending);
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
        totalRestaked -= info.boostedAmount;

        // Attempt to return the NFT — if staking contract is broken, this may fail
        bool nftReturned;
        try stakingNFT.safeTransferFrom(address(this), restaker, tokenId) {
            nftReturned = true;
        } catch {
            // AUDIT FIX M-04: NFT transfer failed — preserve tokenIdToRestaker mapping
            // so rescueNFT can only send to the original restaker, preventing theft.
            nftReturned = false;
        }

        if (nftReturned) {
            // Full cleanup only if NFT was successfully returned
            delete tokenIdToRestaker[tokenId];
            delete restakers[restaker];
        } else {
            // NFT stuck — clear position data but preserve tokenIdToRestaker
            // so rescueNFT knows who owns it. restakers mapping cleared for bonus accounting.
            delete restakers[restaker];
        }

        emit EmergencyForceReturn(restaker, tokenId, nftReturned);
    }

    // ─── M-26: Revalidate Boost Proxy ───────────────────────────────

    /// @notice M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked position.
    /// @dev AUDIT NEW-S2 (HIGH): TegridyStaking.revalidateBoost is restricted to
    ///      owner/restakingContract to prevent permissionless boost-strip griefing
    ///      of legacy positions (a user whose JBAC is temporarily in a different
    ///      wallet). The prior permissionless wrapper in this contract punched
    ///      straight through that gate — an attacker could watch the JBAC market
    ///      and call this during any transfer-window to permanently strip a
    ///      victim's legacy JBAC boost. Now restricted to the restaker themselves
    ///      or the owner. Refreshes the cached boostedAmount after revalidation.
    /// @param tokenId The tsTOWELI NFT token ID to revalidate
    function revalidateBoostForRestaked(uint256 tokenId) external nonReentrant updateBonus {
        address restaker = tokenIdToRestaker[tokenId];
        if (restaker == address(0)) revert NotRestakedToken();
        // AUDIT NEW-S2: match Staking's auth model — only the position owner or
        // the restaking-contract owner can revalidate. Previously permissionless.
        if (msg.sender != restaker && msg.sender != owner()) revert Unauthorized();

        RestakeInfo storage info = restakers[restaker];

        // AUDIT FIX M-08: Use balance delta instead of staking.earned() snapshot.
        // Previously, earned() was credited as unforwardedBaseRewards regardless of whether
        // revalidateBoost actually triggered _getReward(). If boost was unchanged, no rewards
        // were transferred but the full earned() amount was phantom-credited.
        uint256 balBefore = rewardToken.balanceOf(address(this));

        // Call revalidateBoost on the staking contract
        staking.revalidateBoost(tokenId);

        // AUDIT FIX M-08: Only credit actually received tokens (balance delta)
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[restaker] += received;
            totalUnforwardedBase += received;
        }

        // Settle pending bonus before changing boostedAmount
        uint256 oldBoosted = info.boostedAmount;
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(restaker, bonusPending);
                totalBonusDistributed += bonusPending;
            }
        }

        // Refresh cached boostedAmount from staking contract
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;
        info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);

        emit BoostRevalidated(restaker, tokenId, oldBoosted, newBoostedAmount);
    }

    /// @notice #23/M-26 + AUDIT NEW-S2: Revalidate the JBAC boost for a restaked
    ///         position by user address.
    /// @dev Looks up the user's restaked tokenId and calls revalidateBoost via the
    ///      staking contract. AUDIT NEW-S2 (HIGH): restricted to the user themselves
    ///      or the owner — see revalidateBoostForRestaked above for the full
    ///      grief rationale.
    /// @param _user The restaker address whose boost should be revalidated
    function revalidateBoostForRestaker(address _user) external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[_user];
        if (info.tokenId == 0) revert NotRestaked();
        // AUDIT NEW-S2: only the restaker or owner may trigger revalidation.
        if (msg.sender != _user && msg.sender != owner()) revert Unauthorized();

        uint256 tokenId = info.tokenId;

        // AUDIT FIX M-08: Use balance delta instead of staking.earned() snapshot
        uint256 balBefore = rewardToken.balanceOf(address(this));

        // Call revalidateBoost on the staking contract
        staking.revalidateBoost(tokenId);

        // AUDIT FIX M-08: Only credit actually received tokens (balance delta)
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            unforwardedBaseRewards[_user] += received;
            totalUnforwardedBase += received;
        }

        // Settle pending bonus before changing boostedAmount
        uint256 oldBoosted = info.boostedAmount;
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(_user, bonusPending);
                totalBonusDistributed += bonusPending;
            }
        }

        // Refresh cached boostedAmount from staking contract
        (, uint256 newBoostedAmount,,,,,,, , ,) = staking.positions(tokenId);
        info.boostedAmount = newBoostedAmount;
        totalRestaked = totalRestaked - oldBoosted + newBoostedAmount;
        info.bonusDebt = _safeInt256((newBoostedAmount * accBonusPerShare) / ACC_PRECISION);

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

        // Read current position from staking contract (where decay has been applied)
        (, uint256 currentBoosted,,,,,,, , ,) = staking.positions(info.tokenId);

        // Only proceed if the cached value differs (i.e., decay happened)
        if (currentBoosted == info.boostedAmount) revert("NO_DECAY");

        // AUDIT NEW-S3 step 1 — run pending accrual against the STALE denominator one
        // last time. This finalises the expired restaker's prior share under the
        // accounting that was actually in effect, so their bonusDebt advances to
        // `oldBoosted × accBonusPerShare_now`. We'll pay out below, then correct
        // totalRestaked, then subsequent calls use the fixed denominator.
        _accrueBonus();

        // Settle pending bonus on old (stale) boostedAmount before updating
        uint256 oldBoosted = info.boostedAmount;
        if (oldBoosted > 0) {
            int256 accumulated = _safeInt256((oldBoosted * accBonusPerShare) / ACC_PRECISION);
            int256 diff = accumulated - info.bonusDebt;
            uint256 bonusPending = diff > 0 ? uint256(diff) : 0;
            if (bonusPending > 0) {
                bonusRewardToken.safeTransfer(_restaker, bonusPending);
                totalBonusDistributed += bonusPending;
                emit BonusClaimed(_restaker, bonusPending);
            }
        }

        // AUDIT NEW-S3 step 2 — update cached boostedAmount and totalRestaked. All
        // future accrual (next caller's updateBonus) reads the corrected denominator.
        info.boostedAmount = currentBoosted;
        totalRestaked = totalRestaked - oldBoosted + currentBoosted;
        info.bonusDebt = _safeInt256((currentBoosted * accBonusPerShare) / ACC_PRECISION);

        // Also refresh positionAmount
        (uint256 currentAmount,,,,,,,,, , ) = staking.positions(info.tokenId);
        info.positionAmount = currentAmount;

        emit PositionRefreshed(_restaker, info.tokenId, oldBoosted, currentBoosted);
    }

    /// @dev AUDIT NEW-S3: extract the `updateBonus` modifier body into a reusable
    ///      internal function so `decayExpiredRestaker` can run accrual at a
    ///      specific step of the decay workflow instead of at the modifier's
    ///      fixed always-first position.
    function _accrueBonus() internal {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available;
            try bonusRewardToken.balanceOf(address(this)) returns (uint256 bal) {
                available = bal;
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
        } else if (totalRestaked == 0) {
            lastBonusRewardTime = block.timestamp;
        }
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
}
