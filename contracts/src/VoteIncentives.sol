// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @dev Interface for TegridyStaking (voting escrow) — Curve-style checkpoint queries.
///      Same interface as RevenueDistributor uses.
interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    function userTokenId(address user) external view returns (uint256);
    // H-01 FIX: Aligned to actual TegridyStaking.Position struct ABI order
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    );
    function paused() external view returns (bool);
}

/// @dev Interface for TegridyFactory to validate pair addresses.
interface ITegridyFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @dev Interface for TegridyPair to read token addresses (H-04 fix).
interface ITegridyPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title VoteIncentives — Bribe Market for veTOWELI Voters
/// @notice External protocols deposit ETH or ERC20 bribes for specific pool pairs.
///         veTOWELI holders claim proportional to their votingPowerAtTimestamp().
///
///         How it works:
///         1. Protocols call depositBribe() or depositBribeETH() targeting a specific pair
///         2. Anyone calls advanceEpoch() to snapshot an epoch (permissionless, 1h cooldown)
///         3. Each epoch records: timestamp + totalBoostedStake at snapshot time
///         4. Users call claimBribes(epoch, pair) to receive their share of all bribe tokens
///         5. Share = (votingPowerAtTimestamp(user, epoch.timestamp) / epoch.totalPower) * bribeAmount
///
///         Design choices:
///         - Epoch-based (not streaming) for gas efficiency — Curve FeeDistributor pattern
///         - Per-pair bribes — Aerodrome/Velodrome model
///         - Whitelisted bribe tokens — prevents griefing with garbage tokens
///         - Bribe fee (default 3%) — sent to treasury
///         - Pull-pattern withdrawals for failed transfers — WETHFallbackLib
///         - Max 20 bribe tokens per pair per epoch — gas cap on claim iteration
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
///  - Epoch claim pattern: Curve FeeDistributor (billions distributed)
///  - Bribe model: Aerodrome/Velodrome (>$100M TVL)
contract VoteIncentives is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_CHANGE = keccak256("BRIBE_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("BRIBE_TREASURY_CHANGE");
    bytes32 public constant WHITELIST_CHANGE = keccak256("BRIBE_WHITELIST_CHANGE");
    /// @notice AUDIT NEW-G5 (HIGH): commit-reveal activation timelock key.
    bytes32 public constant COMMIT_REVEAL_ENABLE = keccak256("COMMIT_REVEAL_ENABLE");

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 500;         // Max 5% bribe fee
    uint256 public constant MAX_BRIBE_TOKENS = 20;     // Max unique tokens per pair per epoch
    uint256 public constant MIN_BRIBE_AMOUNT = 0.001 ether; // SECURITY FIX: Prevent dust spam DoS (Velodrome pattern)
    uint256 public constant MAX_CLAIM_EPOCHS = 500;     // Same as RevenueDistributor
    uint256 public constant MAX_BATCH_ITERATIONS = 200;  // SECURITY FIX H-8: Prevent block gas limit DoS
    /// @notice AUDIT NEW-G8 (HIGH): previously 1 hour. Per-hour cadence let an attacker
    ///         spam `advanceEpoch` 168x/week, splitting a week's bribe pool into dust
    ///         buckets each of which rounded a voter's share to zero — siphoning the
    ///         protocol's bribe flow. Weekly cadence matches Aerodrome / Velodrome and
    ///         makes bribe economics stable for voters.
    uint256 public constant MIN_EPOCH_INTERVAL = 7 days;
    /// @notice AUDIT NEW-G4 (HIGH): snapshot-lookback (matches CommunityGrants /
    ///         MemeBountyBoard). A staker who mints at T cannot influence an epoch
    ///         advanced at T — their checkpoint is at T, lookup at T - SNAPSHOT_LOOKBACK
    ///         returns the checkpoint from 1h earlier (before they staked). Without
    ///         this, an attacker could stake-max-boost, trigger permissionless
    ///         `advanceEpoch`, and capture the new epoch's full voting weight + bribes.
    uint256 public constant SNAPSHOT_LOOKBACK = 1 hours;
    uint256 public constant VOTE_DEADLINE = 7 days;     // SECURITY FIX: Voting deadline after epoch snapshot (Aerodrome pattern)
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant WHITELIST_CHANGE_DELAY = 24 hours;
    /// @notice AUDIT NEW-G5: 24h window between proposing commit-reveal activation and
    ///         actually flipping the switch. Without this, admin could flip the flag
    ///         and an attacker watching the mempool could front-run with an
    ///         `advanceEpoch()` call to lock in one more legacy epoch (up to 7 days
    ///         of mempool-visible voting). The timelock forces the flip to be
    ///         publicly announced so voters/bribers/keepers all see the transition
    ///         window.
    uint256 public constant COMMIT_REVEAL_ENABLE_DELAY = 24 hours;
    uint256 public constant MIN_DISTRIBUTE_STAKE = 1000e18; // Same as RevenueDistributor

    // ─── Immutables ──────────────────────────────────────────────────
    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;
    ITegridyFactory public immutable factory;

    // ─── State ───────────────────────────────────────────────────────
    address public treasury;
    uint256 public bribeFeeBps;  // Default 300 = 3%

    struct EpochInfo {
        uint256 totalPower;      // totalBoostedStake snapshot
        uint256 timestamp;       // Snapshot timestamp (block.timestamp - 1)
        // AUDIT H-2: commit-reveal flag. Set at advanceEpoch time from the
        // contract-level commitRevealEnabled switch. Legacy epochs keep
        // `usesCommitReveal == false` and continue to use the plain vote()
        // path; new epochs after the flip use commitVote() + revealVote().
        bool usesCommitReveal;
    }

    EpochInfo[] public epochs;
    uint256 public lastEpochTime;

    // ─── AUDIT H-2: Commit-Reveal Voting State ───────────────────────
    //
    // Addresses the see-bribes-then-vote arbitrage in the plain vote() path.
    // New epochs (flag flipped by admin) use a two-phase protocol:
    //   Phase 1 (commit window, 40% of VOTE_DEADLINE = 4d):
    //     voter submits keccak256(chainid, addr(this), user, epoch, pair,
    //     power, salt) + a 10 TOWELI bond per commit. Multiple commits
    //     per epoch allowed so voters can split power across pairs.
    //   Phase 2 (reveal window, remaining 60% = 3d):
    //     voter submits (pair, power, salt) matching their commit. Vote
    //     is applied to gaugeVotes/totalGaugeVotes/userTotalVotes using
    //     the existing accounting; bond is refunded.
    //   Post-reveal: any bond not claimed back is forfeited to treasury
    //     via sweepForfeitedBonds().
    //
    // Full design in DESIGN_H2_COMMIT_REVEAL_VOTING.md.
    IERC20 public immutable toweli;
    uint256 public constant COMMIT_RATIO_BPS = 4000;      // 40% of VOTE_DEADLINE
    uint256 public constant COMMIT_BOND = 10e18;          // 10 TOWELI per commit

    /// @notice AUDIT NEW-G9 (LOW): aggregate TOWELI bond reservation — sum of all
    ///         in-flight commit bonds. `sweepToken(toweli)` now subtracts this from
    ///         the sweepable balance so a malicious owner can't drain bonds pending
    ///         reveal/refund. Incremented on commitVote, decremented on bond
    ///         refund (revealVote path) or forfeit (sweepForfeitedBond).
    uint256 public totalCommitBonds;

    /// @notice Admin switch. Flip to true; next `advanceEpoch()` will flag
    /// the new epoch `usesCommitReveal = true`. Epochs created before the
    /// flip keep their legacy behaviour. Once flipped, leave it on.
    bool public commitRevealEnabled;

    struct CommitInfo {
        bytes32 commitHash;  // keccak256(chainid, addr, user, epoch, pair, power, salt)
        uint96 bond;         // TOWELI bond locked at commit time
        bool revealed;       // true once revealVote matched
    }

    /// @notice voterCommits[user][epoch][commitIndex]
    mapping(address => mapping(uint256 => CommitInfo[])) public voterCommits;

    // epochBribes[epoch][pair][token] = total bribe amount (after fee)
    mapping(uint256 => mapping(address => mapping(address => uint256))) public epochBribes;

    // epochBribeTokens[epoch][pair] = list of bribe token addresses
    mapping(uint256 => mapping(address => address[])) public epochBribeTokens;

    // claimed[user][epoch][pair][token] = true if already claimed
    mapping(address => mapping(uint256 => mapping(address => mapping(address => bool)))) public claimed;

    // Token whitelist
    mapping(address => bool) public whitelistedTokens;
    address[] public whitelistedTokenList;

    // Pull-pattern pending withdrawals (for contracts that can't receive ETH)
    mapping(address => uint256) public pendingETHWithdrawals;
    mapping(address => mapping(address => uint256)) public pendingTokenWithdrawals;
    uint256 public totalPendingETH;
    mapping(address => uint256) public totalPendingTokens; // SECURITY FIX: Track pending token withdrawals per token for sweep reservation

    // C-01/C-02 FIX: Track total unclaimed bribe amounts to prevent sweep from draining active bribes
    mapping(address => uint256) public totalUnclaimedBribes;  // token => total unclaimed amount
    uint256 public totalUnclaimedETHBribes;

    // C-02 FIX: Track first deposit timestamp per epoch for orphaned bribe rescue
    mapping(uint256 => uint256) public epochBribeFirstDeposit; // epoch => first deposit timestamp
    uint256 public constant BRIBE_RESCUE_DELAY = 30 days;

    // AUDIT NEW-G2 (CRITICAL): per-depositor bookkeeping so orphaned bribes refund to
    // their original depositors instead of sweeping to treasury. The prior design
    // let a compromised owner delay `advanceEpoch` for 30 days and then drain every
    // user's un-snapshotted bribe. The rescue delay now runs from the LATEST deposit
    // (so a dust bribe can't trigger premature sweep of later deposits), and the
    // rescue path is a permissionless per-depositor pull rather than an owner push
    // to treasury.
    mapping(uint256 => mapping(address => mapping(address => mapping(address => uint256)))) public bribeDeposits;
    mapping(uint256 => uint256) public epochBribeLastDeposit; // epoch => latest deposit timestamp

    /// @notice AUDIT NEW-G3 (defensive observability): cumulative share paid out per
    ///         (epoch, pair, token). Makes the accounting invariant explicit:
    ///         `dust = epochBribes[e][p][t] - totalClaimedBribes[e][p][t]`. The
    ///         existing `totalUnclaimedBribes[token]` already implicitly reserves
    ///         dust from sweep (it only decrements by actual share, never by the
    ///         full bribeAmount), but this per-bucket tracker turns the invariant
    ///         from coincidence into a checkable property via `dustOf(...)`.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public totalClaimedBribes;

    // H-03 FIX: Accumulated treasury ETH fees (pull pattern)
    uint256 public accumulatedTreasuryETH;

    // SECURITY FIX H-7: Per-token minimum bribe amounts (supports non-18-decimal tokens)
    mapping(address => uint256) public minBribeAmounts;

    /// @notice AUDIT R020 H-3 (HIGH): default minimum ERC20 bribe applied when
    ///         the owner has not configured a per-token minimum. Without this,
    ///         attackers fill a pair's MAX_BRIBE_TOKENS slots with 1-wei dust
    ///         deposits and block legitimate bribers. Default targets ~0.001
    ///         tokens at 18-decimal scale; non-18-decimal tokens (USDC, USDT)
    ///         require operators to set a per-token min via proposeMinBribeAmount.
    uint256 public constant DEFAULT_MIN_TOKEN_BRIBE = 1e15;

    bytes32 public constant MIN_BRIBE_CHANGE = keccak256("BRIBE_MIN_AMOUNT_CHANGE");
    uint256 public constant MIN_BRIBE_CHANGE_DELAY = 24 hours;
    address public pendingMinBribeToken;
    uint256 public pendingMinBribeAmount;

    // V2: Gauge Voting — Velodrome/Aerodrome pattern
    // Users must vote() to allocate power to specific pairs before claiming that pair's bribes.
    // gaugeVotes[user][epoch][pair] = voting power allocated to that pair
    mapping(address => mapping(uint256 => mapping(address => uint256))) public gaugeVotes;
    // totalGaugeVotes[epoch][pair] = total votes for that pair (denominator for share calc)
    mapping(uint256 => mapping(address => uint256)) public totalGaugeVotes;
    // userTotalVotes[user][epoch] = total power user has allocated across all pairs (capped at votingPower)
    mapping(address => mapping(uint256 => uint256)) public userTotalVotes;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistToken;
    bool public pendingWhitelistAction; // true = add, false = remove

    // ─── Events ──────────────────────────────────────────────────────
    event EpochAdvanced(uint256 indexed epochId, uint256 totalPower, uint256 timestamp);
    event BribeDeposited(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount, uint256 fee);
    event BribeDepositedETH(uint256 indexed epoch, address indexed pair, address indexed depositor, uint256 amount, uint256 fee);
    event BribeClaimed(address indexed user, uint256 indexed epoch, address indexed pair, address token, uint256 amount);
    event PendingETHCredited(address indexed user, uint256 amount);
    event PendingETHWithdrawn(address indexed user, uint256 amount);
    event PendingTokenCredited(address indexed user, address indexed token, uint256 amount);
    event PendingTokenWithdrawn(address indexed user, address indexed token, uint256 amount);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);
    event WhitelistChangeProposed(address indexed token, bool add, uint256 executeAfter);
    event WhitelistChangeCancelled(address indexed token);
    event GaugeVoted(address indexed user, uint256 indexed epoch, address indexed pair, uint256 power);
    // AUDIT H-2: commit-reveal events.
    event VoteCommitted(address indexed user, uint256 indexed epoch, uint256 commitIndex, bytes32 commitHash);
    event VoteRevealed(address indexed user, uint256 indexed epoch, uint256 commitIndex, address indexed pair, uint256 power);
    event BondRefunded(address indexed user, uint256 indexed epoch, uint256 commitIndex, uint256 amount);
    event BondForfeited(address indexed user, uint256 indexed epoch, uint256 commitIndex, uint256 amount);
    event CommitRevealEnabled(bool enabled);

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error TokenNotWhitelisted();
    error TooManyBribeTokens();
    error EpochTooSoon();
    error NoStakers();
    error NothingToClaim();
    error AlreadyClaimed();
    error InvalidEpoch();
    error InvalidPair();
    error NoPendingWithdrawal();
    error StakingPaused();
    error TooManyUnclaimedEpochs();
    error VoteDeadlinePassed();  // SECURITY FIX: Cannot vote after deadline
    // AUDIT H-2: commit-reveal errors.
    error LegacyVoteOnCommitRevealEpoch();
    error NotCommitRevealEpoch();
    error CommitDeadlinePassed();
    error CommitWindowNotOpen();
    error RevealWindowNotOpen();
    error RevealWindowClosed();
    error CommitNotFound();
    error AlreadyRevealed();
    error CommitHashMismatch();
    error BondStillLocked();
    error BondAlreadyClaimed();

    // ─── Legacy View Helpers (for test/frontend compatibility) ───────
    function feeChangeTime() external view returns (uint256) { return _executeAfter[FEE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function whitelistChangeTime() external view returns (uint256) { return _executeAfter[WHITELIST_CHANGE]; }

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address _votingEscrow,
        address _treasury,
        address _weth,
        address _factory,
        address _toweli,
        uint256 _bribeFeeBps
    ) OwnableNoRenounce(msg.sender) {
        if (_votingEscrow == address(0) || _treasury == address(0) || _weth == address(0) || _factory == address(0) || _toweli == address(0)) revert ZeroAddress();
        if (_bribeFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        votingEscrow = IVotingEscrow(_votingEscrow);
        weth = IWETH(_weth);
        factory = ITegridyFactory(_factory);
        toweli = IERC20(_toweli);
        treasury = _treasury;
        bribeFeeBps = _bribeFeeBps;
    }

    // ─── Epoch Management ────────────────────────────────────────────

    /// @notice Advance to a new epoch. Permissionless — anyone can call.
    ///         Snapshots totalBoostedStake at block.timestamp - 1 (same as RevenueDistributor).
    function advanceEpoch() external whenNotPaused {
        if (block.timestamp < lastEpochTime + MIN_EPOCH_INTERVAL) revert EpochTooSoon();

        uint256 totalPower = votingEscrow.totalBoostedStake();
        if (totalPower == 0) revert NoStakers();
        if (totalPower < MIN_DISTRIBUTE_STAKE) revert NoStakers();

        // AUDIT NEW-G4 (HIGH): snap the epoch timestamp back by SNAPSHOT_LOOKBACK so
        // same-block / near-block flash-stakes cannot influence THIS epoch's voting
        // power or bribe shares. `votingPowerAtTimestamp(user, snapshotTime)` reads
        // the checkpoint strictly before snapshotTime; the 1h lookback enforces a
        // cooling-off between stake and advance. Fallback to (timestamp - 1) on early
        // genesis/fork conditions.
        uint256 snapshotTime = block.timestamp > SNAPSHOT_LOOKBACK
            ? block.timestamp - SNAPSHOT_LOOKBACK
            : (block.timestamp > 0 ? block.timestamp - 1 : 0);

        epochs.push(EpochInfo({
            totalPower: totalPower,
            timestamp: snapshotTime,
            usesCommitReveal: commitRevealEnabled
        }));

        lastEpochTime = block.timestamp;

        emit EpochAdvanced(epochs.length - 1, totalPower, snapshotTime);
    }

    /// @notice Get the current epoch index (next epoch that bribes deposit into).
    function currentEpoch() external view returns (uint256) {
        return epochs.length;
    }

    /// @notice Get total number of completed epochs.
    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    // ─── V2: Gauge Voting (Velodrome/Aerodrome Pattern) ────────────────

    /// @notice Allocate voting power to a specific pair for a snapshotted epoch.
    ///         Users must vote() before claiming bribes for that pair — only voters share bribes.
    ///         Can be called multiple times to allocate power across multiple pairs.
    /// @param epoch The snapshotted epoch index to vote on
    /// @param pair The pool pair to vote for
    /// @param power Amount of voting power to allocate to this pair
    function vote(uint256 epoch, address pair, uint256 power) external whenNotPaused {
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();

        EpochInfo memory ep = epochs[epoch];
        // AUDIT H-2: epochs tagged with usesCommitReveal MUST use the
        // commitVote() + revealVote() pair; plain vote() is disabled for
        // them to prevent the bribery-arbitrage bypass.
        if (ep.usesCommitReveal) revert LegacyVoteOnCommitRevealEpoch();
        // SECURITY FIX: Enforce voting deadline — prevents retroactive vote gaming after seeing bribes.
        // Pattern: Aerodrome/Velodrome — votes must be cast within VOTE_DEADLINE of epoch snapshot.
        if (block.timestamp > ep.timestamp + VOTE_DEADLINE) revert VoteDeadlinePassed();
        uint256 userPower = votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp);
        if (userPower == 0) revert NothingToClaim();

        // Cap total allocated power at user's voting power for this epoch
        require(userTotalVotes[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");

        gaugeVotes[msg.sender][epoch][pair] += power;
        totalGaugeVotes[epoch][pair] += power;
        userTotalVotes[msg.sender][epoch] += power;

        emit GaugeVoted(msg.sender, epoch, pair, power);
    }

    // ─── Bribe Deposits ──────────────────────────────────────────────

    /// @notice Deposit ERC20 bribe for a specific pair in the current (not-yet-snapshotted) epoch.
    ///         Uses balance-diff to handle fee-on-transfer tokens correctly.
    /// @param pair The pool pair address this bribe is for
    /// @param token The ERC20 token being deposited as bribe
    /// @param amount Amount of tokens to deposit
    function depositBribe(address pair, address token, uint256 amount) external nonReentrant whenNotPaused {
        if (pair == address(0)) revert InvalidPair();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!whitelistedTokens[token]) revert TokenNotWhitelisted();
        _validatePair(pair);

        // Balance-diff for FoT tokens (same pattern as SwapFeeRouter)
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balBefore;
        if (actualReceived == 0) revert ZeroAmount();
        // SECURITY FIX H-7 + R020 H-3: per-token minimum bribe with a sensible
        // 18-decimal default. Owners must configure per-token mins for non-18-
        // decimal tokens (USDC, USDT) via proposeMinBribeAmount.
        uint256 tokenMin = minBribeAmounts[token];
        uint256 effectiveMin = tokenMin > 0 ? tokenMin : DEFAULT_MIN_TOKEN_BRIBE;
        require(actualReceived >= effectiveMin, "BRIBE_TOO_SMALL");

        // Take bribe fee
        uint256 fee = (actualReceived * bribeFeeBps) / BPS;
        uint256 netBribe = actualReceived - fee;

        // Send fee to treasury
        if (fee > 0) {
            IERC20(token).safeTransfer(treasury, fee);
        }

        // Current epoch = epochs.length (the next epoch to be snapshotted)
        uint256 epoch = epochs.length;

        // Check token cap for this pair in this epoch
        address[] storage tokenList = epochBribeTokens[epoch][pair];
        if (epochBribes[epoch][pair][token] == 0) {
            // New token for this pair/epoch — check cap
            if (tokenList.length >= MAX_BRIBE_TOKENS) revert TooManyBribeTokens();
            tokenList.push(token);
        }

        epochBribes[epoch][pair][token] += netBribe;
        totalUnclaimedBribes[token] += netBribe;

        // C-02 FIX: Track first deposit timestamp for orphaned bribe rescue
        if (epochBribeFirstDeposit[epoch] == 0) {
            epochBribeFirstDeposit[epoch] = block.timestamp;
        }
        // AUDIT NEW-G2: track per-depositor amount + latest deposit timestamp so orphan
        // refunds go back to the original depositor, keyed off the freshest activity.
        bribeDeposits[epoch][pair][token][msg.sender] += netBribe;
        epochBribeLastDeposit[epoch] = block.timestamp;

        emit BribeDeposited(epoch, pair, token, msg.sender, netBribe, fee);
    }

    /// @notice Deposit ETH bribe for a specific pair in the current epoch.
    /// @param pair The pool pair address this bribe is for
    function depositBribeETH(address pair) external payable nonReentrant whenNotPaused {
        if (pair == address(0)) revert InvalidPair();
        if (msg.value == 0) revert ZeroAmount();
        // SECURITY FIX: Enforce minimum bribe to prevent dust spam DoS (Velodrome pattern)
        require(msg.value >= MIN_BRIBE_AMOUNT, "BRIBE_TOO_SMALL");
        _validatePair(pair);

        // Take bribe fee
        uint256 fee = (msg.value * bribeFeeBps) / BPS;
        uint256 netBribe = msg.value - fee;

        // H-03 FIX: Accumulate treasury fees (pull pattern) to prevent DoS if treasury rejects ETH
        if (fee > 0) {
            accumulatedTreasuryETH += fee;
        }

        // Current epoch = epochs.length
        uint256 epoch = epochs.length;

        // Use address(0) as the "token" for ETH bribes
        address[] storage tokenList = epochBribeTokens[epoch][pair];
        if (epochBribes[epoch][pair][address(0)] == 0) {
            if (tokenList.length >= MAX_BRIBE_TOKENS) revert TooManyBribeTokens();
            tokenList.push(address(0));
        }

        epochBribes[epoch][pair][address(0)] += netBribe;
        totalUnclaimedETHBribes += netBribe;

        // C-02 FIX: Track first deposit timestamp for orphaned bribe rescue
        if (epochBribeFirstDeposit[epoch] == 0) {
            epochBribeFirstDeposit[epoch] = block.timestamp;
        }
        // AUDIT NEW-G2: track per-depositor amount + latest deposit timestamp.
        bribeDeposits[epoch][pair][address(0)][msg.sender] += netBribe;
        epochBribeLastDeposit[epoch] = block.timestamp;

        emit BribeDepositedETH(epoch, pair, msg.sender, netBribe, fee);
    }

    // ─── Claiming ────────────────────────────────────────────────────

    /// @notice Claim all bribe tokens for a specific epoch and pair.
    ///         V2: Share = (userGaugeVotes / totalGaugeVotes) * bribeAmount per token.
    ///         Users must call vote() first to allocate power to this pair.
    /// @param epoch The epoch index to claim from
    /// @param pair The pool pair to claim bribes for
    function claimBribes(uint256 epoch, address pair) external nonReentrant whenNotPaused {
        if (_isStakingPaused()) revert StakingPaused();
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (pair == address(0)) revert InvalidPair();

        // V2: Use gauge votes instead of raw voting power
        uint256 userVoteForPair = gaugeVotes[msg.sender][epoch][pair];
        if (userVoteForPair == 0) revert NothingToClaim();

        uint256 totalVotesForPair = totalGaugeVotes[epoch][pair];
        if (totalVotesForPair == 0) revert NothingToClaim();

        address[] memory tokens = epochBribeTokens[epoch][pair];
        bool anyClaimed = false;

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (claimed[msg.sender][epoch][pair][token]) continue;

            uint256 bribeAmount = epochBribes[epoch][pair][token];
            if (bribeAmount == 0) continue;

            // V2: Share proportional to gauge votes, not raw voting power
            uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
            if (share == 0) continue;

            claimed[msg.sender][epoch][pair][token] = true;
            anyClaimed = true;

            // NOTE: epochBribes is NOT decremented. Each user gets their proportional share
            // of the ORIGINAL deposit: (bribeAmount * userVoteForPair) / totalVotesForPair.
            // Solvency is guaranteed because sum(gaugeVotes) == totalGaugeVotes,
            // so sum(shares) <= bribeAmount. The `claimed` mapping prevents
            // double-claims. Rounding dust stays in the contract — see AUDIT NEW-G3
            // below for the explicit tracker that prevents sweep from touching it.

            // AUDIT NEW-G3 (defensive): track cumulative claimed-per-(epoch,pair,token)
            // so dust = bribeAmount - sum(shares) is always recoverable as a precise
            // number. `sweepExcessETH`/`sweepToken` now reserves total dust across all
            // bribed (epoch,pair,token) triples, so even if the unclaimed-running-total
            // accounting drifts (e.g., via a future refactor bug), sweep cannot touch
            // bribe dust. Users who roll up to share == 0 never consume the dust
            // budget — it belongs to no one and is permanently locked in the contract.
            totalClaimedBribes[epoch][pair][token] += share;

            // C-01 FIX: Safe subtraction to prevent underflow from rounding dust
            if (token == address(0)) {
                totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;
            } else {
                totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > share ? totalUnclaimedBribes[token] - share : 0;
            }

            if (token == address(0)) {
                // ETH bribe — try direct transfer, fallback to pending.
                // AUDIT FIX (critique 5.7 / battle-tested): raised from 10000 to 50000 to
                // handle Safe, Argent, and EIP-4337 smart accounts in the direct path.
                // Pending fallback retained as belt-and-suspenders for non-standard receivers.
                (bool ok,) = msg.sender.call{value: share, gas: 50000}("");
                if (!ok) {
                    pendingETHWithdrawals[msg.sender] += share;
                    totalPendingETH += share;
                    emit PendingETHCredited(msg.sender, share);
                }
            } else {
                // AUDIT FIX H-03: Use safeTransfer inside try/catch for USDT compatibility.
                // USDT's transfer() returns void, so try/returns(bool) always reverts into catch.
                // safeTransfer handles non-standard ERC20s (no return value) correctly.
                // Wrapped in try/catch so blacklisted/paused tokens fall back to pending.
                try this._safeTransferExternal(token, msg.sender, share) {
                    // Transfer succeeded
                } catch {
                    pendingTokenWithdrawals[msg.sender][token] += share;
                    totalPendingTokens[token] += share;
                    emit PendingTokenCredited(msg.sender, token, share);
                }
            }

            emit BribeClaimed(msg.sender, epoch, pair, token, share);
        }

        if (!anyClaimed) revert NothingToClaim();
    }

    /// @notice Batch claim bribes across multiple epochs for a single pair.
    ///         V2: Uses gauge votes — user must have voted for this pair in each epoch.
    /// @param epochStart First epoch to claim from (inclusive)
    /// @param epochEnd Last epoch to claim from (exclusive)
    /// @param pair The pool pair to claim bribes for
    function claimBribesBatch(uint256 epochStart, uint256 epochEnd, address pair) external nonReentrant whenNotPaused {
        if (_isStakingPaused()) revert StakingPaused();
        if (pair == address(0)) revert InvalidPair();
        if (epochEnd > epochs.length) epochEnd = epochs.length;
        if (epochStart >= epochEnd) revert NothingToClaim();
        if (epochEnd - epochStart > MAX_CLAIM_EPOCHS) revert TooManyUnclaimedEpochs();

        bool anyClaimed = false;
        uint256 totalIterations;

        for (uint256 e = epochStart; e < epochEnd; e++) {
            // V2: Use gauge votes instead of raw voting power
            uint256 userVoteForPair = gaugeVotes[msg.sender][e][pair];
            if (userVoteForPair == 0) continue;

            uint256 totalVotesForPair = totalGaugeVotes[e][pair];
            if (totalVotesForPair == 0) continue;

            address[] memory tokens = epochBribeTokens[e][pair];

            for (uint256 i = 0; i < tokens.length; i++) {
                address token = tokens[i];
                if (claimed[msg.sender][e][pair][token]) continue;

                uint256 bribeAmount = epochBribes[e][pair][token];
                if (bribeAmount == 0) continue;

                // V2: Share proportional to gauge votes
                uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
                if (share == 0) continue;

                claimed[msg.sender][e][pair][token] = true;
                anyClaimed = true;

                // NOTE: epochBribes NOT decremented — proportional share from original deposit.
                // Solvency guaranteed by sum(gaugeVotes) == totalGaugeVotes.

                // AUDIT NEW-G3 (defensive): mirror the claimBribes dust-tracking
                // invariant so single-epoch and batch flows stay in sync.
                totalClaimedBribes[e][pair][token] += share;

                // C-01 FIX: Safe subtraction to prevent underflow from rounding dust
                if (token == address(0)) {
                    totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;
                } else {
                    totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > share ? totalUnclaimedBribes[token] - share : 0;
                }

                // SECURITY FIX H-8: Track total iterations to prevent block gas limit DoS
                totalIterations++;
                require(totalIterations <= MAX_BATCH_ITERATIONS, "TOO_MANY_ITERATIONS");

                if (token == address(0)) {
                    // AUDIT FIX (critique 5.7 / battle-tested): raised from 10000 to 50000 to
                    // handle Safe, Argent, and EIP-4337 smart accounts in the direct path.
                    // Pending fallback retained as belt-and-suspenders for non-standard receivers.
                    (bool ok,) = msg.sender.call{value: share, gas: 50000}("");
                    if (!ok) {
                        pendingETHWithdrawals[msg.sender] += share;
                        totalPendingETH += share;
                        emit PendingETHCredited(msg.sender, share);
                    }
                } else {
                    // AUDIT FIX H-03: Use safeTransfer for USDT compatibility (same as claimBribes)
                    try this._safeTransferExternal(token, msg.sender, share) {
                        // Transfer succeeded
                    } catch {
                        pendingTokenWithdrawals[msg.sender][token] += share;
                        totalPendingTokens[token] += share;
                        emit PendingTokenCredited(msg.sender, token, share);
                    }
                }

                emit BribeClaimed(msg.sender, e, pair, token, share);
            }
        }

        if (!anyClaimed) revert NothingToClaim();
    }

    // ─── Pull-Pattern Withdrawals ────────────────────────────────────

    /// @notice Withdraw pending ETH that was credited due to a failed direct transfer.
    function withdrawPendingETH() external nonReentrant {
        uint256 amount = pendingETHWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingETHWithdrawals[msg.sender] = 0;
        totalPendingETH -= amount;

        WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);

        emit PendingETHWithdrawn(msg.sender, amount);
    }

    /// @notice Withdraw pending ERC20 tokens credited from a failed bribe claim transfer.
    /// @dev SECURITY FIX C-3: Pull-pattern for ERC20 bribes (Aave V3 pattern).
    function withdrawPendingToken(address token) external nonReentrant {
        uint256 amount = pendingTokenWithdrawals[msg.sender][token];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingTokenWithdrawals[msg.sender][token] = 0;
        totalPendingTokens[token] -= amount;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit PendingTokenWithdrawn(msg.sender, token, amount);
    }

    // ─── View Functions ──────────────────────────────────────────────

    /// @notice Preview claimable bribe amounts for a user in a specific epoch/pair.
    ///         V2: Uses gauge votes — returns 0 if user hasn't voted for this pair.
    function claimable(address user, uint256 epoch, address pair) external view returns (
        address[] memory tokens,
        uint256[] memory amounts
    ) {
        if (epoch >= epochs.length) return (new address[](0), new uint256[](0));

        // V2: Use gauge votes
        uint256 userVoteForPair = gaugeVotes[user][epoch][pair];
        uint256 totalVotesForPair = totalGaugeVotes[epoch][pair];

        tokens = epochBribeTokens[epoch][pair];
        amounts = new uint256[](tokens.length);

        if (userVoteForPair == 0 || totalVotesForPair == 0) return (tokens, amounts);

        for (uint256 i = 0; i < tokens.length; i++) {
            if (claimed[user][epoch][pair][tokens[i]]) continue;
            uint256 bribeAmount = epochBribes[epoch][pair][tokens[i]];
            if (bribeAmount > 0) {
                amounts[i] = (bribeAmount * userVoteForPair) / totalVotesForPair;
            }
        }
    }

    /// @notice Get all bribe tokens for a given epoch and pair.
    function getEpochBribeTokens(uint256 epoch, address pair) external view returns (address[] memory) {
        return epochBribeTokens[epoch][pair];
    }

    /// @notice Get the list of all whitelisted tokens.
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokenList;
    }

    // ─── Admin: Timelocked Fee Change (24h) ──────────────────────────

    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        require(newFee > 0, "FEE_CANNOT_BE_ZERO"); // M-08 FIX
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(bribeFeeBps, newFee, _executeAfter[FEE_CHANGE]);
    }

    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 old = bribeFeeBps;
        bribeFeeBps = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeUpdated(old, bribeFeeBps);
    }

    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Treasury Change (48h) ─────────────────────

    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    // ─── Admin: Timelocked Whitelist Change (24h) ────────────────────

    function proposeWhitelistChange(address token, bool add) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingWhitelistToken = token;
        pendingWhitelistAction = add;
        _propose(WHITELIST_CHANGE, WHITELIST_CHANGE_DELAY);
        emit WhitelistChangeProposed(token, add, _executeAfter[WHITELIST_CHANGE]);
    }

    function executeWhitelistChange() external onlyOwner {
        _execute(WHITELIST_CHANGE);
        address token = pendingWhitelistToken;
        bool add = pendingWhitelistAction;
        pendingWhitelistToken = address(0);

        if (add) {
            if (!whitelistedTokens[token]) {
                whitelistedTokens[token] = true;
                whitelistedTokenList.push(token);
                emit TokenWhitelisted(token);
            }
        } else {
            if (whitelistedTokens[token]) {
                whitelistedTokens[token] = false;
                // Remove from list (swap-and-pop)
                for (uint256 i = 0; i < whitelistedTokenList.length; i++) {
                    if (whitelistedTokenList[i] == token) {
                        whitelistedTokenList[i] = whitelistedTokenList[whitelistedTokenList.length - 1];
                        whitelistedTokenList.pop();
                        break;
                    }
                }
                emit TokenRemovedFromWhitelist(token);
            }
        }
    }

    function cancelWhitelistChange() external onlyOwner {
        _cancel(WHITELIST_CHANGE);
        address cancelled = pendingWhitelistToken;
        pendingWhitelistToken = address(0);
        emit WhitelistChangeCancelled(cancelled);
    }

    // ─── Admin: Pause ────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── H-03 FIX: Pull-Pattern Treasury Fees ─────────────────────────

    /// @notice Withdraw accumulated treasury ETH fees (pull pattern).
    /// SECURITY FIX: Added onlyOwner access control + WETHFallbackLib.
    /// Previously permissionless with full-gas .call — inconsistent with codebase security posture.
    function withdrawTreasuryFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedTreasuryETH;
        require(amount > 0, "NO_FEES");
        accumulatedTreasuryETH = 0;
        WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, amount);
    }

    // ─── Orphaned Bribe Refund (per-depositor pull) ─────────────────

    event OrphanedBribeRefunded(
        uint256 indexed epoch,
        address indexed pair,
        address indexed token,
        address depositor,
        uint256 amount
    );

    /// @notice AUDIT NEW-G2 (CRITICAL): refund your OWN bribe from an epoch that was
    ///         never snapshotted after BRIBE_RESCUE_DELAY since the latest deposit.
    ///
    ///         The prior `rescueOrphanedBribes` was owner-only and sent everything to
    ///         treasury. That let a compromised owner (or one willing to delay
    ///         `advanceEpoch` — permissionless but not keeper-incentivised) drain
    ///         every user's pending bribe to themselves. The delay also ran from the
    ///         FIRST deposit, so a dust bribe could enable early sweep of fresh
    ///         deposits stacked on top.
    ///
    ///         Now: permissionless, pull-pattern, per-depositor. Each depositor
    ///         reclaims exactly what they put in (net of fee, which was already
    ///         treasuried at deposit time). Delay runs from the LATEST deposit in
    ///         the epoch, so fresh bribes always get the full window.
    ///
    ///         Battle-tested against Curve FeeDistributor's refund-to-origin pattern.
    function refundOrphanedBribe(uint256 epoch, address pair, address token) external nonReentrant {
        require(epoch >= epochs.length, "EPOCH_ALREADY_SNAPSHOTTED");
        uint256 lastDeposit = epochBribeLastDeposit[epoch];
        require(lastDeposit != 0, "NO_BRIBES_IN_EPOCH");
        require(block.timestamp >= lastDeposit + BRIBE_RESCUE_DELAY, "RESCUE_TOO_EARLY");

        uint256 amount = bribeDeposits[epoch][pair][token][msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");

        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        uint256 remaining = epochBribes[epoch][pair][token];
        epochBribes[epoch][pair][token] = remaining > amount ? remaining - amount : 0;

        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > amount ? totalUnclaimedETHBribes - amount : 0;
            WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > amount ? totalUnclaimedBribes[token] - amount : 0;
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit OrphanedBribeRefunded(epoch, pair, token, msg.sender, amount);
    }

    /// @notice DEPRECATED: the owner drain path has been replaced by the permissionless
    ///         per-depositor `refundOrphanedBribe`. Reverts by design so any tooling
    ///         still calling the old signature surfaces a clear error instead of
    ///         sending user funds to treasury.
    function rescueOrphanedBribes(uint256, address, address) external pure {
        revert("USE_REFUND_ORPHANED_BRIBE");
    }

    /// @notice AUDIT R020 H-1 (CRIT): refund a bribe that was deposited for a
    ///         pair which received zero votes after the epoch was snapshotted.
    ///         Without this path, refundOrphanedBribe rejects (epoch IS snapshotted)
    ///         and claimBribes rejects (no votes for pair) — funds are permanently
    ///         locked. Permissionless per-depositor pull, gated by a 14-day grace
    ///         window after revealDeadline so honest claimers always get first chance.
    /// @dev    Mirrors Convex/Hidden Hand `refundOrphaned()` after grace.
    uint256 public constant UNVOTED_REFUND_GRACE = 14 days;
    event UnvotedBribeRefunded(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount);

    function refundUnvotedBribe(uint256 epoch, address pair, address token) external nonReentrant {
        if (epoch >= epochs.length) revert InvalidEpoch();
        require(totalGaugeVotes[epoch][pair] == 0, "PAIR_HAS_VOTES");
        require(block.timestamp >= revealDeadline(epoch) + UNVOTED_REFUND_GRACE, "GRACE_NOT_ELAPSED");

        uint256 amount = bribeDeposits[epoch][pair][token][msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");

        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        uint256 remaining = epochBribes[epoch][pair][token];
        epochBribes[epoch][pair][token] = remaining > amount ? remaining - amount : 0;

        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > amount ? totalUnclaimedETHBribes - amount : 0;
            WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > amount ? totalUnclaimedBribes[token] - amount : 0;
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit UnvotedBribeRefunded(epoch, pair, token, msg.sender, amount);
    }

    // ─── AUDIT R020 H-3: per-token min-bribe configuration (timelocked) ───

    event MinBribeAmountChangeProposed(address indexed token, uint256 amount, uint256 executeAfter);
    event MinBribeAmountChangeExecuted(address indexed token, uint256 oldAmount, uint256 newAmount);
    event MinBribeAmountChangeCancelled(address indexed token, uint256 amount);

    function proposeMinBribeAmount(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingMinBribeToken = token;
        pendingMinBribeAmount = amount;
        _propose(MIN_BRIBE_CHANGE, MIN_BRIBE_CHANGE_DELAY);
        emit MinBribeAmountChangeProposed(token, amount, _executeAfter[MIN_BRIBE_CHANGE]);
    }

    function executeMinBribeAmount() external onlyOwner {
        _execute(MIN_BRIBE_CHANGE);
        address token = pendingMinBribeToken;
        uint256 newAmount = pendingMinBribeAmount;
        uint256 oldAmount = minBribeAmounts[token];
        minBribeAmounts[token] = newAmount;
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        emit MinBribeAmountChangeExecuted(token, oldAmount, newAmount);
    }

    function cancelMinBribeAmount() external onlyOwner {
        address token = pendingMinBribeToken;
        uint256 amount = pendingMinBribeAmount;
        _cancel(MIN_BRIBE_CHANGE);
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        emit MinBribeAmountChangeCancelled(token, amount);
    }

    /// @notice AUDIT NEW-G3: permanently-locked rounding dust for a given
    ///         (epoch, pair, token). dust = epochBribes - totalClaimedBribes.
    ///         This is sum-of-voter-shares floor-rounding; it is NOT sweep-able.
    ///         Exposed for observability only.
    function dustOf(uint256 epoch, address pair, address token) external view returns (uint256) {
        uint256 deposited = epochBribes[epoch][pair][token];
        uint256 paidOut = totalClaimedBribes[epoch][pair][token];
        return deposited > paidOut ? deposited - paidOut : 0;
    }

    // ─── Admin: Emergency Sweep ──────────────────────────────────────

    /// @notice Sweep stuck ETH beyond what's owed to claimers and active bribes.
    ///         Reserves: unclaimed ETH bribes + pending pull-pattern withdrawals + accumulated treasury fees.
    function sweepExcessETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        uint256 reserved = totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        (bool ok,) = treasury.call{value: sweepable}("");
        require(ok, "SWEEP_FAILED");
    }

    /// @notice Sweep stuck ERC20 tokens beyond what's reserved as active bribes.
    ///         Only excess tokens (accidentally sent) can be swept — active bribes
    ///         and in-flight commit bonds (AUDIT NEW-G9, for TOWELI) are protected.
    function sweepToken(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = totalUnclaimedBribes[token] + totalPendingTokens[token];
        // AUDIT NEW-G9 (LOW): reserve active commit bonds so a malicious owner
        // can't drain bonds pending reveal or forfeit.
        if (token == address(toweli)) {
            reserved += totalCommitBonds;
        }
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        if (sweepable == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, sweepable);
    }

    // ─── AUDIT FIX H-03: External helper for try/catch safeTransfer ──

    /// @dev External wrapper around SafeERC20.safeTransfer so it can be used with try/catch.
    ///      Solidity's try only works on external calls. Only callable by this contract itself.
    function _safeTransferExternal(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "ONLY_SELF");
        IERC20(token).safeTransfer(to, amount);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Validate that pair is a registered factory pair (H-04 fix).
    ///      Reads token0/token1 from the pair contract, then verifies with factory.getPair().
    ///      Prevents bribes to arbitrary/non-existent/unregistered addresses.
    function _validatePair(address pair) internal view {
        if (pair.code.length == 0) revert InvalidPair();
        // H-04 FIX: Verify pair is a registered factory pair by reading its tokens
        // and checking against factory.getPair()
        try ITegridyPair(pair).token0() returns (address t0) {
            try ITegridyPair(pair).token1() returns (address t1) {
                if (factory.getPair(t0, t1) != pair) revert InvalidPair();
            } catch {
                revert InvalidPair();
            }
        } catch {
            revert InvalidPair();
        }
    }

    /// @dev Check if the staking contract is paused (same pattern as RevenueDistributor).
    function _isStakingPaused() internal view returns (bool) {
        try votingEscrow.paused() returns (bool isPaused) {
            return isPaused;
        } catch {
            return false;
        }
    }

    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════
    // AUDIT H-2: Commit-Reveal Voting
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Timestamp after which no new commits are accepted for `epoch`.
    ///         Equal to snapshot + 40% of VOTE_DEADLINE (= 2.8 days default).
    function commitDeadline(uint256 epoch) public view returns (uint256) {
        if (epoch >= epochs.length) revert InvalidEpoch();
        return epochs[epoch].timestamp + (VOTE_DEADLINE * COMMIT_RATIO_BPS) / BPS;
    }

    /// @notice Timestamp after which no reveals are accepted. Equal to
    ///         snapshot + VOTE_DEADLINE (= same total window as legacy vote).
    function revealDeadline(uint256 epoch) public view returns (uint256) {
        if (epoch >= epochs.length) revert InvalidEpoch();
        return epochs[epoch].timestamp + VOTE_DEADLINE;
    }

    /// @notice Number of commits the user has placed on this epoch.
    function voterCommitCount(address user, uint256 epoch) external view returns (uint256) {
        return voterCommits[user][epoch].length;
    }

    /// @notice Compute the canonical commit hash off-chain in the same way the
    ///         contract will validate on reveal. chainid + address(this) bind
    ///         the commit to this deployment — no cross-chain or cross-contract
    ///         replay is possible.
    function computeCommitHash(
        address user,
        uint256 epoch,
        address pair,
        uint256 power,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), user, epoch, pair, power, salt));
    }

    /// @notice Phase 1: commit a vote. Transfers COMMIT_BOND (10 TOWELI) in.
    ///         Caller must approve the contract for COMMIT_BOND first.
    ///         Multiple commits per epoch allowed — each reveals independently
    ///         with its own bond.
    /// @param epoch      The commit-reveal epoch to vote in.
    /// @param commitHash computeCommitHash(msg.sender, epoch, pair, power, salt).
    /// @return commitIndex The index of this commit in voterCommits[user][epoch].
    function commitVote(uint256 epoch, bytes32 commitHash) external nonReentrant whenNotPaused returns (uint256 commitIndex) {
        if (epoch >= epochs.length) revert InvalidEpoch();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();
        if (block.timestamp <= ep.timestamp) revert CommitWindowNotOpen();
        if (block.timestamp > commitDeadline(epoch)) revert CommitDeadlinePassed();

        // Voter needs at least the snapshot-time voting power to participate.
        // (We don't know at commit time which pair — that's the point — but
        // we do check that they had any power. Cap enforcement happens at reveal.)
        if (votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp) == 0) revert NothingToClaim();

        // Transfer bond. Balance-diff safe against FoT TOWELI (unlikely but
        // defensive — matches the depositBribe() pattern elsewhere in this file).
        uint256 balBefore = toweli.balanceOf(address(this));
        toweli.safeTransferFrom(msg.sender, address(this), COMMIT_BOND);
        uint256 received = toweli.balanceOf(address(this)) - balBefore;
        if (received < COMMIT_BOND) revert ZeroAmount();

        commitIndex = voterCommits[msg.sender][epoch].length;
        voterCommits[msg.sender][epoch].push(CommitInfo({
            commitHash: commitHash,
            bond: uint96(COMMIT_BOND),
            revealed: false
        }));
        // AUDIT NEW-G9: reserve this bond from sweep.
        totalCommitBonds += COMMIT_BOND;
        emit VoteCommitted(msg.sender, epoch, commitIndex, commitHash);
    }

    /// @notice Phase 2: reveal a prior commit. Applies the vote to the gauge
    ///         accounting and refunds the bond.
    /// @param epoch       The epoch this commit was placed in.
    /// @param commitIndex Index returned by commitVote.
    /// @param pair        Pair chosen at commit time.
    /// @param power       Voting power allocated to that pair at commit time.
    /// @param salt        Random 32 bytes used at commit time.
    function revealVote(
        uint256 epoch,
        uint256 commitIndex,
        address pair,
        uint256 power,
        bytes32 salt
    ) external nonReentrant whenNotPaused {
        if (epoch >= epochs.length) revert InvalidEpoch();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();

        uint256 cd = commitDeadline(epoch);
        uint256 rd = revealDeadline(epoch);
        if (block.timestamp <= cd) revert RevealWindowNotOpen();
        if (block.timestamp > rd) revert RevealWindowClosed();

        CommitInfo[] storage commits = voterCommits[msg.sender][epoch];
        if (commitIndex >= commits.length) revert CommitNotFound();
        CommitInfo storage c = commits[commitIndex];
        if (c.revealed) revert AlreadyRevealed();

        bytes32 expected = computeCommitHash(msg.sender, epoch, pair, power, salt);
        if (expected != c.commitHash) revert CommitHashMismatch();

        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();

        // Same cap enforcement as legacy vote(): total across all commits +
        // legacy votes in this epoch cannot exceed user's snapshot voting power.
        uint256 userPower = votingEscrow.votingPowerAtTimestamp(msg.sender, ep.timestamp);
        if (userPower == 0) revert NothingToClaim();
        require(userTotalVotes[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");

        // Apply vote (same effect as legacy vote()).
        gaugeVotes[msg.sender][epoch][pair] += power;
        totalGaugeVotes[epoch][pair] += power;
        userTotalVotes[msg.sender][epoch] += power;

        // Mark revealed + refund bond (CEI: state first, transfer last).
        c.revealed = true;
        uint96 bond = c.bond;
        c.bond = 0;

        emit VoteRevealed(msg.sender, epoch, commitIndex, pair, power);
        emit GaugeVoted(msg.sender, epoch, pair, power);

        if (bond > 0) {
            // AUDIT NEW-G9: release bond reservation before refund.
            if (totalCommitBonds >= bond) {
                totalCommitBonds -= bond;
            }
            toweli.safeTransfer(msg.sender, bond);
            emit BondRefunded(msg.sender, epoch, commitIndex, bond);
        }
    }

    /// @notice Sweep un-revealed bonds past revealDeadline to treasury. Callable
    ///         by anyone — permissionless clean-up, same pattern as advanceEpoch.
    /// @param user        Voter whose commits to check.
    /// @param epoch       Epoch index.
    /// @param commitIndex Specific commit index (callers iterate off-chain to
    ///                    keep per-call gas bounded).
    function sweepForfeitedBond(address user, uint256 epoch, uint256 commitIndex) external nonReentrant whenNotPaused {
        if (epoch >= epochs.length) revert InvalidEpoch();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();
        if (block.timestamp <= revealDeadline(epoch)) revert BondStillLocked();

        CommitInfo[] storage commits = voterCommits[user][epoch];
        if (commitIndex >= commits.length) revert CommitNotFound();
        CommitInfo storage c = commits[commitIndex];
        if (c.revealed) revert AlreadyRevealed();  // already refunded to user
        uint96 bond = c.bond;
        if (bond == 0) revert BondAlreadyClaimed();

        c.bond = 0;
        // AUDIT NEW-G9: release bond reservation before forfeit transfer.
        if (totalCommitBonds >= bond) {
            totalCommitBonds -= bond;
        }
        toweli.safeTransfer(treasury, bond);
        emit BondForfeited(user, epoch, commitIndex, bond);
    }

    /// @notice AUDIT NEW-G5 (HIGH): commit-reveal activation is now timelocked.
    ///         Step 1: owner calls `proposeEnableCommitReveal()` to queue the flip.
    ///         Step 2: after `COMMIT_REVEAL_ENABLE_DELAY` (24h), anyone calls
    ///         `executeEnableCommitReveal()` to flip `commitRevealEnabled = true`.
    ///         Optional cancel path via `cancelEnableCommitReveal()`.
    ///
    ///         Rationale: prior version was an instant owner flip. Mempool watchers
    ///         could front-run the flip tx with an `advanceEpoch()` that locks in
    ///         one more legacy epoch — attackers then had 7 days of mempool-visible
    ///         voting in the very epoch the migration was meant to protect.
    ///
    ///         Once enabled there is still no path to disable — forward-only by
    ///         design. `flipping back would let an attacker race the toggle.`
    event EnableCommitRevealProposed(uint256 executeAfter);
    event EnableCommitRevealCancelled();

    function proposeEnableCommitReveal() external onlyOwner {
        if (commitRevealEnabled) return; // idempotent
        _propose(COMMIT_REVEAL_ENABLE, COMMIT_REVEAL_ENABLE_DELAY);
        emit EnableCommitRevealProposed(_executeAfter[COMMIT_REVEAL_ENABLE]);
    }

    function cancelEnableCommitReveal() external onlyOwner {
        _cancel(COMMIT_REVEAL_ENABLE);
        emit EnableCommitRevealCancelled();
    }

    function executeEnableCommitReveal() external {
        _execute(COMMIT_REVEAL_ENABLE);
        commitRevealEnabled = true;
        emit CommitRevealEnabled(true);
    }

    /// @notice DEPRECATED: use the propose/execute flow above. Retained as a
    ///         descriptive revert so any tooling calling the old signature fails
    ///         loudly instead of silently no-op'ing.
    function enableCommitReveal() external view onlyOwner {
        revert("USE_PROPOSE_ENABLE_COMMIT_REVEAL");
    }
}
