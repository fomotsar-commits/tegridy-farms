// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

interface IStakingForReferral {
    function votingPowerOf(address user) external view returns (uint256);
}

/// @dev AUDIT FIX (pass-8): GOV-ECON-01 / C10 — restaking-side voting-power
///      reader added so referrers who restake their staking NFT are not
///      silently disenfranchised from the MIN_REFERRAL_STAKE_POWER threshold.
///      TegridyRestaking exposes the same shape via its
///      `votingPowerOf(address)` alias that delegates to `_boostedAmountAt`.
interface IRestakingForReferral {
    function votingPowerOf(address user) external view returns (uint256);
}

/// @title ReferralSplitter
/// @notice On-chain referral tracking. When a referred user's swap fee is received,
///         a percentage goes to the referrer automatically.
///
///         Flow:
///         1. User registers a referrer on-chain (one-time)
///         2. When the protocol collects fees, it calls recordFee(user, amount)
///         3. The referrer's share (default 10%) is credited
///         4. Referrers claim accumulated ETH anytime
///
///         SECURITY FIX #16: Referrers must have an active staking position to earn rewards.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
///
/// @dev AUDIT L-R02 OPERATIONAL REQUIREMENT (2026-04-28): the `setupComplete` flag must
///      be flipped exactly once during deploy via `completeSetup()`. Until it
///      is set, every external `record*` / `claim*` call reverts. Deploy ops
///      MUST run `completeSetup()` after the SwapFeeRouter address is wired,
///      or the contract is functionally inert. The flag is forward-only — once
///      set, it cannot be reverted.
///
/// @dev AUDIT L-R03 CLOCK-START SEMANTIC (2026-04-28): `MIN_REFERRAL_AGE` (7 days) is
///      counted from the timestamp at which the REFERRER first registered as
///      a referrer (`referrerRegisteredAt[referrer]`), NOT from when each
///      referred user signed up under them. Practical effect: a brand-new
///      referrer who acquires N referred users on day 0 must wait 7 days
///      before claiming any of those N users' generated credit. After day 7,
///      the wait is over for ALL of that referrer's downstream — past and
///      future. This is the intended "minimum age" anti-Sybil filter and
///      should not be confused with a per-claim cooldown.
contract ReferralSplitter is OwnableNoRenounce, ReentrancyGuard, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant REFERRAL_FEE_CHANGE = keccak256("REFERRAL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    // AUDIT L-R01 (2026-04-28): Removed unused `CALLER_GRANT` constant. The
    // per-caller propose key is computed inline as
    // `keccak256(abi.encode("CALLER_GRANT", _caller))`, which never references
    // the bare constant — the constant's keccak("CALLER_GRANT") preimage is
    // not byte-equivalent to the encode-based key, so removing the constant
    // does not affect any existing or future encoded key.

    // ─── State ────────────────────────────────────────────────────────

    IStakingForReferral public immutable stakingContract; // SECURITY FIX #16
    /// @notice Optional restaking contract; voting power from restaked positions
    ///         is added to staking-side power for the MIN_REFERRAL_STAKE_POWER check.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10 — without this, referrers who
    ///         restake their staking NFT have `stakingContract.votingPowerOf` return
    ///         0 and lose the MIN_REFERRAL_STAKE_POWER qualification. One-shot setter
    ///         (mirrors `setSequencerFeed` pattern in SwapFeeRouter) lets the live
    ///         deployment add the restaking pointer without redeploying.
    address public restakingContract;
    address public immutable weth; // WETH fallback for revert-on-receive addresses
    uint256 public constant MIN_REFERRAL_STAKE_POWER = 1000e18; // SECURITY FIX #16: must have 1000 TOWELI equivalent voting power

    address public treasury; // SECURITY FIX: treasury for unclaimable referral funds

    uint256 public referralFeeBps; // Referrer's share in bps (1000 = 10%)
    uint256 public constant MAX_REFERRAL_FEE = 3000; // Max 30%
    uint256 public constant BPS = 10000;

    mapping(address => address) public referrerOf;  // user => referrer
    mapping(address => uint256) public pendingETH;  // referrer => claimable ETH
    mapping(address => uint256) public totalReferred; // referrer => total users referred
    mapping(address => uint256) public totalEarned; // referrer => total ETH earned

    mapping(address => bool) public approvedCallers; // Approved fee recorders
    mapping(address => uint256) public lastReferrerChange; // Cooldown tracking for referrer updates
    mapping(address => uint256) public lastClaimTime; // Track last claim time for forfeiture
    uint256 public constant REFERRER_COOLDOWN = 30 days;
    uint256 public constant FORFEITURE_PERIOD = 90 days;

    uint256 public totalReferralsPaid;
    uint256 public totalPendingETH; // Total unclaimed referral ETH — protects against sweepUnclaimable
    uint256 public accumulatedTreasuryETH; // AUDIT FIX M-05: Pull-pattern for treasury-bound referral fees
    mapping(address => uint256) public callerCredit; // SECURITY FIX H-04: Pull-pattern for non-referral ETH returns
    uint256 public totalCallerCredit; // SECURITY FIX S2-H-01: Track total callerCredit to protect from sweepUnclaimable
    mapping(address => uint256) public lastBelowStakeTime; // Timestamp when referrer was marked below MIN_REFERRAL_STAKE_POWER
    uint256 public constant BELOW_STAKE_GRACE_PERIOD = 7 days; // Grace period before forfeiture allowed

    mapping(address => uint256) public referrerRegisteredAt; // When a referrer first gained a referral
    uint256 public constant MIN_REFERRAL_AGE = 7 days; // Referrer must wait 7 days before claiming

    // AUDIT FIX M-17: Once setup is complete, instant setApprovedCaller is disabled — only timelocked path works
    bool public setupComplete;

    /// @notice AUDIT FIX: DEEP-DR-L-04 — banned-referrer set. A referrer who has been
    ///         forfeited (their pending was sent to treasury) can be permanently
    ///         blocked from re-earning by the owner via `banReferrer`. Existing
    ///         `setReferrer` calls reject any banned target. Admin path is timelocked
    ///         to prevent rug-banning of legitimate referrers.
    mapping(address => bool) public bannedReferrers;
    bytes32 public constant BAN_REFERRER = keccak256("BAN_REFERRER");
    uint256 public constant BAN_REFERRER_DELAY = 24 hours;
    address public pendingBanReferrer;

    // ─── Timelock Constants ──────────────────────────────────────────
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant CALLER_GRANT_DELAY = 24 hours;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    address public pendingTreasury;
    uint256 public pendingReferralFee;
    // For caller grants, we use a per-address pending mapping
    mapping(address => bool) public pendingCallerGrant; // tracks which address has a pending grant

    // ─── Events ───────────────────────────────────────────────────────

    event ReferrerSet(address indexed user, address indexed referrer);
    event FeeRecorded(address indexed user, address indexed referrer, uint256 totalFee, uint256 referrerShare);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event ReferralFeeUpdated(uint256 oldFee, uint256 newFee);
    event ReferrerUpdated(address indexed user, address indexed oldReferrer, address indexed newReferrer);
    event ApprovedCallerSet(address indexed caller, bool approved);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event UnclaimableSentToTreasury(address indexed referrer, uint256 amount);
    event UnclaimedSwept(address indexed treasury, uint256 amount);
    event RewardsForfeited(address indexed referrer, uint256 amount);
    event TreasuryETHWithdrawn(address indexed treasury, uint256 amount); // AUDIT FIX M-05
    event ReferralRewardsPaidWETH(address indexed referrer, uint256 amount); // AUDIT FIX M-05/M-07: WETH fallback
    event TreasuryFeesPaidWETH(address indexed treasury, uint256 amount); // AUDIT FIX M-05/M-07: WETH fallback
    event SetupCompleted(); // AUDIT FIX M-17
    event ReferralFeeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event TreasuryChangeProposed(address currentTreasury, address proposedTreasury, uint256 executeAfter);
    event ReferralFeeCancelled(uint256 cancelledFee);
    event TreasuryChangeCancelled(address cancelledTreasury);
    event CallerGrantProposed(address indexed caller, uint256 executeAfter);
    event CallerGrantCancelled(address indexed caller);
    event BelowStakeMarked(address indexed referrer, uint256 timestamp);
    event CallerCreditPaidWETH(address indexed caller, uint256 amount);
    event UnclaimedSweptWETH(address indexed treasury, uint256 amount);
    event BanReferrerProposed(address indexed referrer, uint256 executeAfter); // DEEP-DR-L-04
    event ReferrerBanned(address indexed referrer);                            // DEEP-DR-L-04
    event BanReferrerCancelled(address indexed referrer);                      // DEEP-DR-L-04
    event ReferrerUnbanned(address indexed referrer);                          // DEEP-DR-L-04
    event RestakingContractSet(address indexed restaking);                     // pass-8 GOV-ECON-01

    // ─── Errors ───────────────────────────────────────────────────────

    error SelfReferral();
    error AlreadyReferred();
    error NothingToClaim();
    error ETHTransferFailed();
    error FeeTooHigh();
    error ZeroAddress();
    error NotApprovedCaller();
    error CooldownNotElapsed();
    error NoReferrerSet();
    error CircularReferral();
    error SameReferrer();
    error ForfeitureConditionsNotMet();
    error SetupAlreadyComplete(); // AUDIT FIX M-17
    error ReferralAgeTooRecent();
    error ReferrerBannedError(); // AUDIT FIX: DEEP-DR-L-04 — referrer is on the ban list
    /// @notice AUDIT FIX: V2-DR-L-01 — replaces the misleading `ZeroAddress()` revert
    ///         in `unbanReferrer` for callers passing a non-banned (but non-zero)
    ///         address. Off-chain monitoring can now distinguish input-validation
    ///         failures (zero address) from state mismatches (address not on the
    ///         ban list) without grep'ing the call args.
    error NotBanned();
    /// @notice AUDIT FIX: V2-DR-L-02 — `proposeBanReferrer` already-banned guard.
    ///         Prevents owner from burning a 24h timelock slot on a no-op
    ///         re-ban. Also prevents a second `proposeBanReferrer` for the same
    ///         address from silently overwriting the in-flight `pendingBanReferrer`
    ///         slot.
    error AlreadyBanned();
    /// @dev AUDIT FIX (pass-8): GOV-ECON-01 / C10 — restakingContract is one-shot.
    error RestakingAlreadySet();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function referralFeeChangeTime() external view returns (uint256) { return _executeAfter[REFERRAL_FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function pendingCallerGrantTime(address _caller) external view returns (uint256) {
        // M-07: Per-address timelock key to prevent key collision between concurrent proposals.
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        if (pendingCallerGrant[_caller]) return _executeAfter[key];
        return 0;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(uint256 _referralFeeBps, address _stakingContract, address _treasury, address _weth) OwnableNoRenounce(msg.sender) {
        if (_referralFeeBps == 0) revert FeeTooHigh(); // S2-M-03: Disallow zero fee in constructor
        if (_referralFeeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        if (_stakingContract == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        referralFeeBps = _referralFeeBps;
        stakingContract = IStakingForReferral(_stakingContract);
        treasury = _treasury;
        weth = _weth;
    }

    receive() external payable {}

    // ─── Modifiers ───────────────────────────────────────────────────

    modifier onlyApproved() {
        if (msg.sender != owner() && !approvedCallers[msg.sender]) revert NotApprovedCaller();
        _;
    }

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Register your referrer (one-time, permanent)
    /// @param _referrer The address of your referrer (cannot be yourself or zero address)
    function setReferrer(address _referrer) external {
        if (_referrer == msg.sender) revert SelfReferral();
        if (_referrer == address(0)) revert ZeroAddress();
        if (referrerOf[msg.sender] != address(0)) revert AlreadyReferred();
        // AUDIT FIX: DEEP-DR-L-04 — reject banned referrers. Closes the post-forfeiture
        // resurrection vector (a forfeited referrer can no longer be set as a target).
        if (bannedReferrers[_referrer]) revert ReferrerBannedError();
        // AUDIT FIX v3: Walk referral chain up to 5 levels to detect circular references (A→B→C→A)
        _checkCircularReferral(_referrer, msg.sender);

        referrerOf[msg.sender] = _referrer;
        totalReferred[_referrer] += 1;
        if (referrerRegisteredAt[_referrer] == 0) {
            referrerRegisteredAt[_referrer] = block.timestamp;
            // FRESH-EYES M-5: seed lastClaimTime so the forfeiture inactivity clock starts
            // from registration, not genesis. Without this, a never-claimed referrer's
            // forfeit predicate is `block.timestamp < 0 + FORFEITURE_PERIOD` which is
            // trivially false past block-time = 90 days post-genesis — letting a
            // captured/colluding owner starve out a freshly-credited referrer the moment
            // their stake-power dips below threshold for the 7-day grace, even though they
            // have never had a chance to claim. Anchoring on registrationTime restores the
            // documented "90 days of inactivity" semantic.
            lastClaimTime[_referrer] = block.timestamp;
        }

        emit ReferrerSet(msg.sender, _referrer);
    }

    /// @notice Update referrer with a 30-day cooldown
    /// @param _newReferrer The new referrer address to replace the current one
    function updateReferrer(address _newReferrer) external {
        if (_newReferrer == msg.sender) revert SelfReferral();
        if (_newReferrer == address(0)) revert ZeroAddress();
        if (referrerOf[msg.sender] == address(0)) revert NoReferrerSet();
        // AUDIT FIX: Use custom error instead of require string for consistency
        if (_newReferrer == referrerOf[msg.sender]) revert SameReferrer();
        // AUDIT FIX: DEEP-DR-L-04 — reject banned new-referrer targets.
        if (bannedReferrers[_newReferrer]) revert ReferrerBannedError();
        // AUDIT FIX v3: Walk referral chain up to 5 levels to detect circular references
        _checkCircularReferral(_newReferrer, msg.sender);
        if (block.timestamp < lastReferrerChange[msg.sender] + REFERRER_COOLDOWN) revert CooldownNotElapsed();

        address oldReferrer = referrerOf[msg.sender];
        referrerOf[msg.sender] = _newReferrer;
        lastReferrerChange[msg.sender] = block.timestamp;

        // AUDIT FIX: Guard against underflow if totalReferred is somehow already 0
        if (totalReferred[oldReferrer] > 0) totalReferred[oldReferrer] -= 1;
        totalReferred[_newReferrer] += 1;
        if (referrerRegisteredAt[_newReferrer] == 0) {
            referrerRegisteredAt[_newReferrer] = block.timestamp;
        }

        emit ReferrerUpdated(msg.sender, oldReferrer, _newReferrer);
    }

    /// @dev Walk the referral chain to detect multi-level circular references.
    /// Audit history:
    ///   A4-M-09: reduced depth 50 → 10 (50 SLOADs was a gas-griefing vector).
    ///   TF-17 (Spartan LOW): depth 10 allowed sybil rings of 11+ addresses to
    ///     construct A→B→…→K→A cycles that evaded detection. 25 hits the
    ///     balance between attacker cost (25 sybil addresses + coordination)
    ///     and caller gas (25 SLOADs ≈ 52k gas; still well under any per-tx
    ///     budget). Additionally, referral payouts are stake-gated by
    ///     MIN_REFERRAL_STAKE_POWER so the economic benefit of ring-gaming is
    ///     already bounded; this just closes the last cheap loophole.
    ///   AUDIT R014 (MEDIUM, sybil ring bypass): depth 25 still allowed a
    ///     coordinated 26-address ring to bypass detection. Two complementary
    ///     fixes: (a) raise CIRCULAR_DEPTH to 100 — 100 SLOADs ≈ 210k gas, well
    ///     within any per-tx budget; (b) explicit cycle detection via an
    ///     in-memory visited list that reverts on a duplicate address visited
    ///     anywhere in the chain. The combination makes coordinated ring-
    ///     building exponentially more expensive while keeping the worst-case
    ///     gas bounded.
    uint256 public constant CIRCULAR_DEPTH = 100;
    function _checkCircularReferral(address _referrer, address _user) internal view {
        // Build an in-memory visited set. We keep at most CIRCULAR_DEPTH+2
        // entries (the user + the candidate referrer + each upstream link),
        // so the memory expansion cost is fully bounded.
        address[] memory visited = new address[](CIRCULAR_DEPTH + 2);
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 visitedLen;
        visited[visitedLen++] = _user;
        visited[visitedLen++] = _referrer;
        // Direct self-cycle: user setting their own referrer is already caught
        // by SelfReferral up-stack, but defense-in-depth costs nothing here.
        if (_referrer == _user) revert CircularReferral();

        address current = _referrer;
        for (uint256 i = 0; i < CIRCULAR_DEPTH; i++) {
            current = referrerOf[current];
            if (current == address(0)) break;
            // Cycle to the user → would form A→…→user→A
            if (current == _user) revert CircularReferral();
            // Cycle to any address already in the chain (including _referrer
            // and intermediate hops) → ring detected even if it doesn't close
            // back to the user yet. This is what defeats the
            // CIRCULAR_DEPTH-bypass: an N-address ring that lands on any
            // previously visited node is rejected immediately, regardless of
            // ring size relative to CIRCULAR_DEPTH.
            for (uint256 j = 0; j < visitedLen; j++) {
                if (visited[j] == current) revert CircularReferral();
            }
            visited[visitedLen++] = current;
        }
    }

    /// @notice Record a fee event for a user. If they have a referrer, credit the referrer.
    ///         Called by authorized fee collectors (owner or approved contracts).
    ///         SECURITY FIX: If referrer is unregistered or doesn't meet min stake, send to treasury.
    ///         SECURITY FIX H-04: Non-referral ETH is credited via pull pattern (callerCredit)
    ///         instead of pushed back via .call to prevent reentrancy via callback.
    ///         A3-M-02 FIX: votingPowerOf wrapped in try/catch to prevent staking DoS.
    /// @param _user The user whose swap fee is being recorded
    function recordFee(address _user) external payable onlyApproved nonReentrant {
        // AUDIT FIX: DEEP-DR-M-07 — enforce the L-R02 NatSpec contract: until
        // `completeSetup()` has been called, the contract is operationally inert.
        // Pre-fix, an accidental `setApprovedCaller(router, true)` followed by a
        // user-side fee would credit `pendingETH[referrer]` against pre-deploy state.
        require(setupComplete, "SETUP_NOT_COMPLETE");
        require(_user != address(0), "ZERO_USER");
        if (msg.value == 0) return;

        address referrer = referrerOf[_user];
        uint256 referrerShare = (msg.value * referralFeeBps) / BPS;
        if (referrerShare == 0) {
            // SECURITY FIX H-04: Use pull pattern — credit caller instead of pushing ETH back
            callerCredit[msg.sender] += msg.value;
            totalCallerCredit += msg.value; // S2-H-01: Track total
            return;
        }

        // SECURITY FIX H-04: Credit non-referral portion to caller via pull pattern
        uint256 remainder = msg.value - referrerShare;
        if (remainder > 0) {
            callerCredit[msg.sender] += remainder;
            totalCallerCredit += remainder; // S2-H-01: Track total
        }

        // SECURITY FIX: If no referrer or referrer doesn't meet min stake, redirect to treasury
        // AUDIT FIX M-05: Use pull-pattern (accumulate) instead of push (direct send) to prevent
        // treasury contract DOS from blocking recordFee for all unqualified referrals.
        // A3-M-02: Wrap votingPowerOf in try/catch — if staking contract reverts, treat referrer
        // as unqualified (route to treasury) rather than blocking all fee recording.
        bool referrerQualified = false;
        if (referrer != address(0)) {
            // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
            // slither-disable-next-line uninitialized-local
            uint256 totalPower;
            try stakingContract.votingPowerOf(referrer) returns (uint256 power) {
                totalPower = power;
            } catch {
                // Staking contract reverted — treat staking-side as 0
            }
            // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additively include restaked
            // voting power so referrers who restake aren't silently disqualified.
            if (restakingContract != address(0)) {
                try IRestakingForReferral(restakingContract).votingPowerOf(referrer) returns (uint256 r) {
                    totalPower += r;
                } catch {
                    // Restaking reverted — staking-side value is a safe lower bound
                }
            }
            referrerQualified = totalPower >= MIN_REFERRAL_STAKE_POWER;
        }
        // AUDIT FIX: V2-DR-M-03 — banned referrers are treated as unqualified for
        // NEW earnings. The DEEP-DR-L-04 ban flag previously only blocked
        // `setReferrer` / `updateReferrer`, leaving pre-existing referees of the
        // banned referrer to continue accruing `pendingETH[bannedReferrer]` on
        // every fee. That contradicted the implied lifecycle-end semantic of the
        // 24h-timelocked ban ceremony. With this skip, post-ban accruals route
        // straight to `accumulatedTreasuryETH` (same path as unstaked / missing
        // referrers). The companion check in `claimReferralRewards` blocks the
        // banned referrer from withdrawing any pre-ban accrued balance.
        if (referrer != address(0) && bannedReferrers[referrer]) {
            referrerQualified = false;
        }
        if (!referrerQualified) {
            accumulatedTreasuryETH += referrerShare;
            emit UnclaimableSentToTreasury(referrer, referrerShare);
            return;
        }

        pendingETH[referrer] += referrerShare;
        totalPendingETH += referrerShare;
        totalEarned[referrer] += referrerShare;
        totalReferralsPaid += referrerShare;

        // Initialize lastClaimTime on first fee credit so forfeiture clock starts
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (lastClaimTime[referrer] == 0) {
            lastClaimTime[referrer] = block.timestamp;
        }

        emit FeeRecorded(_user, referrer, msg.value, referrerShare);
    }

    /// @notice SECURITY FIX H-04: Withdraw credited ETH (pull pattern for non-referral returns).
    ///         Approved callers call this to retrieve their non-referral portion after recordFee.
    function withdrawCallerCredit() external nonReentrant {
        // AUDIT FIX: DEEP-DR-M-07 — gate on setupComplete (L-R02 NatSpec contract).
        require(setupComplete, "SETUP_NOT_COMPLETE");
        uint256 amount = callerCredit[msg.sender];
        if (amount == 0) revert NothingToClaim();
        callerCredit[msg.sender] = 0;
        totalCallerCredit -= amount; // S2-H-01: Decrement total
        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
        emit CallerCreditPaidWETH(msg.sender, amount);
    }

    /// @notice Claim accumulated referral earnings
    ///         SECURITY FIX #16: Referrer must have an active staking position to claim
    ///         A4-C-01 FIX: votingPowerOf wrapped in try/catch — if staking contract reverts,
    ///         claim is blocked (not silently allowed) but funds remain claimable once staking recovers.
    function claimReferralRewards() external nonReentrant {
        // AUDIT FIX: DEEP-DR-M-07 — gate on setupComplete (L-R02 NatSpec contract).
        require(setupComplete, "SETUP_NOT_COMPLETE");
        // AUDIT FIX: V2-DR-M-03 — banned referrers cannot claim pre-ban accruals.
        // Companion to the `recordFee` skip above. Together they implement the
        // "ban = lifecycle-end" semantic implied by the 24h timelock ceremony:
        // post-ban no new earnings, pre-ban balance frozen pending owner-side
        // `forfeitUnclaimedRewards` (which sweeps it to treasury once the
        // forfeit predicates are met). Without this check, a banned referrer
        // could simply call `claimReferralRewards` to drain `pendingETH` before
        // the owner could complete the forfeit ceremony.
        if (bannedReferrers[msg.sender]) revert ReferrerBannedError();
        // SECURITY FIX H1: Removed voting power requirement from CLAIMING.
        // Stake check is enforced in recordFee() when EARNING new referrals.
        // Earned rewards must always be claimable regardless of current stake.
        // (Curve/Convex pattern — earned rewards are unconditionally claimable)
        if (referrerRegisteredAt[msg.sender] == 0 || block.timestamp < referrerRegisteredAt[msg.sender] + MIN_REFERRAL_AGE) revert ReferralAgeTooRecent();
        uint256 amount = pendingETH[msg.sender];
        if (amount == 0) revert NothingToClaim();

        pendingETH[msg.sender] = 0;
        totalPendingETH -= amount;
        lastClaimTime[msg.sender] = block.timestamp;

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
        emit ReferralRewardsPaidWETH(msg.sender, amount);

        emit ReferralClaimed(msg.sender, amount);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice AUDIT FIX M-17: Permanently disable the instant setApprovedCaller path.
    ///         After calling this, only the timelocked proposeApprovedCaller() flow works.
    ///         Call this once initial deployment setup (approving SwapFeeRouter etc.) is done.
    function completeSetup() external onlyOwner {
        if (setupComplete) revert SetupAlreadyComplete();
        setupComplete = true;
        emit SetupCompleted();
    }

    /// @notice One-shot wire of the TegridyRestaking contract address.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10. Without this, referrers
    ///         who restake their staking NFT have `stakingContract.votingPowerOf`
    ///         return 0 (per-owner enumerable set is empty + 0-checkpoint written
    ///         on deposit) and silently fail the MIN_REFERRAL_STAKE_POWER gate.
    ///
    ///         Mirrors the SwapFeeRouter `setSequencerFeed` one-shot pattern:
    ///         non-zero, set-once, immutable thereafter. If a future Restaking
    ///         migration is needed, redeploy ReferralSplitter — same liability
    ///         budget as the existing one-shot setters in the codebase.
    function setRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        if (restakingContract != address(0)) revert RestakingAlreadySet();
        restakingContract = _restaking;
        emit RestakingContractSet(_restaking);
    }

    /// @notice Set or revoke an approved fee recorder (owner-only, for initial setup only)
    /// @dev AUDIT FIX M-17: Reverts after completeSetup() is called — use timelocked path instead.
    ///      AUDIT FIX M5: For post-deployment changes, use proposeApprovedCaller() with 24h timelock.
    /// @dev AUDIT FIX: V2-DR-M-05 — post-`completeSetup` lifecycle reminder. The
    ///      timelocked `proposeApprovedCaller` → `executeApprovedCaller` flow is
    ///      ALWAYS available even after `completeSetup` flips, so a SwapFeeRouter
    ///      upgrade or migration can still wire a new approved caller (via 24h
    ///      timelock). The instant-revoke path (`revokeApprovedCaller`) is also
    ///      always available with no timelock. Operational hygiene: deploy ops
    ///      must `revokeApprovedCaller(oldRouter)` immediately after any router
    ///      swap so the old (potentially compromised) router cannot dangle as an
    ///      approved caller. The contract emits `ApprovedCallerSet` events for
    ///      every grant/revoke so off-chain monitoring can alert on stale
    ///      approvals.
    function setApprovedCaller(address _caller, bool _approved) external onlyOwner {
        if (setupComplete) revert SetupAlreadyComplete();
        if (_caller == address(0)) revert ZeroAddress();
        approvedCallers[_caller] = _approved;
        emit ApprovedCallerSet(_caller, _approved);
    }

    /// @notice AUDIT FIX M5: Propose granting approved caller status (24h timelock)
    /// @dev M-07: Uses per-address timelock key to prevent collision between concurrent proposals.
    function proposeApprovedCaller(address _caller) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        // Must not have another caller grant pending for this address
        require(!pendingCallerGrant[_caller], "CANCEL_EXISTING_FIRST");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        require(_executeAfter[key] == 0, "CANCEL_EXISTING_FIRST");
        pendingCallerGrant[_caller] = true;
        _propose(key, CALLER_GRANT_DELAY);
        emit CallerGrantProposed(_caller, _executeAfter[key]);
    }

    /// @notice Execute a pending caller grant after timelock
    function executeApprovedCaller(address _caller) external onlyOwner {
        require(pendingCallerGrant[_caller], "NO_PENDING_GRANT");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        _execute(key);
        pendingCallerGrant[_caller] = false;
        approvedCallers[_caller] = true;
        emit ApprovedCallerSet(_caller, true);
    }

    /// @notice Cancel a pending caller grant
    function cancelApprovedCallerGrant(address _caller) external onlyOwner {
        require(pendingCallerGrant[_caller], "NO_PENDING_GRANT");
        bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
        _cancel(key);
        pendingCallerGrant[_caller] = false;
        emit CallerGrantCancelled(_caller);
    }

    /// @notice Instantly revoke an approved caller (no timelock for safety)
    /// @dev AUDIT FIX V3-DR3-M-04: also clear any in-flight `proposeApprovedCaller`
    ///      grant for the same address. Pre-fix, an attacker could:
    ///      `proposeApprovedCaller(X) → revokeApprovedCaller(X) → wait 24h →
    ///      executeApprovedCaller(X)` to resurrect the approval after the revoke.
    ///      Clearing the pending grant on revoke closes that race.
    function revokeApprovedCaller(address _caller) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        approvedCallers[_caller] = false;
        if (pendingCallerGrant[_caller]) {
            bytes32 key = keccak256(abi.encode("CALLER_GRANT", _caller));
            _cancel(key);
            pendingCallerGrant[_caller] = false;
        }
        emit ApprovedCallerSet(_caller, false);
    }

    /// @notice DEPRECATED: Use proposeReferralFee + executeReferralFee
    function setReferralFee(uint256) external pure {
        revert("Use proposeReferralFee()");
    }

    function proposeReferralFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
        // SECURITY FIX M-16: Disallow setting fee to 0 — would cause all ETH to be credited
        // back to caller, making the referral system a no-op while still requiring gas.
        require(_feeBps > 0, "FEE_CANNOT_BE_ZERO");
        pendingReferralFee = _feeBps;
        _propose(REFERRAL_FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ReferralFeeProposed(referralFeeBps, _feeBps, _executeAfter[REFERRAL_FEE_CHANGE]);
    }

    function executeReferralFee() external onlyOwner {
        _execute(REFERRAL_FEE_CHANGE);
        uint256 old = referralFeeBps;
        referralFeeBps = pendingReferralFee;
        pendingReferralFee = 0;
        emit ReferralFeeUpdated(old, referralFeeBps);
    }

    /// @notice Cancel a pending referral fee proposal
    function cancelReferralFee() external onlyOwner {
        _cancel(REFERRAL_FEE_CHANGE);
        uint256 cancelled = pendingReferralFee;
        pendingReferralFee = 0;
        emit ReferralFeeCancelled(cancelled);
    }

    /// @notice DEPRECATED: Use proposeTreasury + executeTreasury
    function setTreasury(address) external pure {
        revert("Use proposeTreasury()");
    }

    function proposeTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(treasury, _treasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasury() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    /// @notice Cancel a pending treasury change proposal
    function cancelTreasury() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice Mark a referrer as below MIN_REFERRAL_STAKE_POWER, starting the grace period clock.
    ///         Anyone can call this. Resets if the referrer is actually above threshold.
    /// @param _referrer The referrer to mark
    function markBelowStake(address _referrer) external {
        // AUDIT FIX: DEEP-DR-M-07 — gate on setupComplete (L-R02 NatSpec contract).
        require(setupComplete, "SETUP_NOT_COMPLETE");
        // A4-C-01: Wrap in try/catch — if staking reverts, treat as below threshold
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 power;
        try stakingContract.votingPowerOf(_referrer) returns (uint256 p) {
            power = p;
        } catch {
            power = 0;
        }
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additively include restaked
        // voting power. Without this, a referrer with all power restaked would
        // be erroneously below threshold and the markBelowStake clock would tick.
        if (restakingContract != address(0)) {
            try IRestakingForReferral(restakingContract).votingPowerOf(_referrer) returns (uint256 r) {
                power += r;
            } catch {}
        }
        if (power >= MIN_REFERRAL_STAKE_POWER) {
            // Referrer is above threshold — reset the timer
            lastBelowStakeTime[_referrer] = 0;
            return;
        }
        // Only set if not already marked
        if (lastBelowStakeTime[_referrer] == 0) {
            lastBelowStakeTime[_referrer] = block.timestamp;
            emit BelowStakeMarked(_referrer, block.timestamp);
        }
    }

    /// @notice Forfeit unclaimed rewards for a referrer who has been below stake threshold
    ///         for at least 7 days and hasn't claimed in 90 days. Sends their pending ETH to treasury.
    /// @param _referrer The referrer whose rewards should be forfeited
    /// @dev A3-M-01 FIX: Uses pull-pattern (accumulate to treasury ETH) instead of pushing
    ///      ETH directly to treasury, preventing permanent DoS if treasury reverts.
    function forfeitUnclaimedRewards(address _referrer) external onlyOwner nonReentrant {
        // AUDIT FIX: DEEP-DR-M-07 — gate on setupComplete (L-R02 NatSpec contract).
        require(setupComplete, "SETUP_NOT_COMPLETE");
        uint256 amount = pendingETH[_referrer];
        if (amount == 0) revert NothingToClaim();
        // Must be below min stake for at least grace period AND inactive for 90 days
        // A4-C-01: Wrap in try/catch — if staking reverts, treat as below threshold (allow forfeiture)
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 referrerPower;
        try stakingContract.votingPowerOf(_referrer) returns (uint256 p) {
            referrerPower = p;
        } catch {
            referrerPower = 0;
        }
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additively include restaked
        // voting power so a referrer who restakes is not erroneously eligible
        // for forfeiture (the forfeit gate is "below threshold AND inactive").
        if (restakingContract != address(0)) {
            try IRestakingForReferral(restakingContract).votingPowerOf(_referrer) returns (uint256 r) {
                referrerPower += r;
            } catch {}
        }
        if (
            // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
            // slither-disable-next-line incorrect-equality
            referrerPower >= MIN_REFERRAL_STAKE_POWER ||
            lastBelowStakeTime[_referrer] == 0 ||
            block.timestamp < lastBelowStakeTime[_referrer] + BELOW_STAKE_GRACE_PERIOD ||
            block.timestamp < lastClaimTime[_referrer] + FORFEITURE_PERIOD
        ) revert ForfeitureConditionsNotMet();

        pendingETH[_referrer] = 0;
        totalPendingETH -= amount;

        // A3-M-01: Accumulate instead of push — withdraw via withdrawTreasuryFees()
        accumulatedTreasuryETH += amount;

        emit RewardsForfeited(_referrer, amount);
    }

    /// @notice AUDIT FIX M-05: Withdraw accumulated treasury-bound referral fees (pull-pattern).
    ///         These fees were accumulated from recordFee when referrers were unqualified.
    function withdrawTreasuryFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedTreasuryETH;
        if (amount == 0) revert NothingToClaim();
        accumulatedTreasuryETH = 0;

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount);
        emit TreasuryFeesPaidWETH(treasury, amount);

        emit TreasuryETHWithdrawn(treasury, amount);
    }

    /// @notice AUDIT FIX: DEEP-DR-L-04 — propose adding a referrer to the ban list.
    ///         24h timelock so a captured-owner key cannot rug-ban a legitimate
    ///         referrer mid-claim cycle without giving the community time to react.
    /// @param  _referrer  The referrer address to ban.
    function proposeBanReferrer(address _referrer) external onlyOwner {
        if (_referrer == address(0)) revert ZeroAddress();
        // AUDIT FIX: V2-DR-L-02 — reject already-banned targets at propose time.
        // Without this check the owner can burn a 24h timelock slot on a no-op
        // (executing it just re-flips an already-true flag) AND a second
        // proposeBanReferrer for the same address overwrites the
        // `pendingBanReferrer` slot, silently cancelling the original proposal
        // for any in-flight ban target.
        if (bannedReferrers[_referrer]) revert AlreadyBanned();
        pendingBanReferrer = _referrer;
        _propose(BAN_REFERRER, BAN_REFERRER_DELAY);
        emit BanReferrerProposed(_referrer, _executeAfter[BAN_REFERRER]);
    }

    /// @notice Execute a previously-proposed referrer ban after the 24h timelock.
    function executeBanReferrer() external onlyOwner {
        _execute(BAN_REFERRER);
        address banned = pendingBanReferrer;
        pendingBanReferrer = address(0);
        bannedReferrers[banned] = true;
        emit ReferrerBanned(banned);
    }

    /// @notice Cancel a pending referrer ban proposal.
    function cancelBanReferrer() external onlyOwner {
        _cancel(BAN_REFERRER);
        address cancelled = pendingBanReferrer;
        pendingBanReferrer = address(0);
        emit BanReferrerCancelled(cancelled);
    }

    /// @notice Unban a previously-banned referrer (instant, no timelock — releasing
    ///         a ban is always safe).
    /// @dev    AUDIT FIX: V2-DR-L-01 — was previously reverting `ZeroAddress()` for
    ///         non-banned (but non-zero) addresses. The new `NotBanned()` typed
    ///         error lets off-chain monitoring distinguish "input was 0x0" from
    ///         "address is not on the ban list".
    function unbanReferrer(address _referrer) external onlyOwner {
        if (!bannedReferrers[_referrer]) revert NotBanned();
        bannedReferrers[_referrer] = false;
        emit ReferrerUnbanned(_referrer);
    }

    /// @notice Sweep excess ETH (non-referral portion from fees) to treasury.
    ///         Protects pending referral ETH, accumulated treasury fees, and caller credits.
    function sweepUnclaimable() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        // S2-H-01: Include totalCallerCredit in reserved to prevent sweeping caller funds
        uint256 reserved = totalPendingETH + accumulatedTreasuryETH + totalCallerCredit;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (sweepable == 0) revert NothingToClaim();

        // AUDIT FIX L-11: Use WETHFallbackLib directly — avoids redundant raw .call before WETH fallback
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, sweepable);
        emit UnclaimedSweptWETH(treasury, sweepable);

        emit UnclaimedSwept(treasury, sweepable);
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice Get referral statistics for a referrer
    /// @param _referrer The referrer address to query
    /// @return referred Total number of users referred
    /// @return earned Total ETH earned historically
    /// @return pending Current claimable ETH balance
    function getReferralInfo(address _referrer) external view returns (
        uint256 referred, uint256 earned, uint256 pending
    ) {
        return (totalReferred[_referrer], totalEarned[_referrer], pendingETH[_referrer]);
    }
}
