// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @dev Minimal interface for TegridyStaking voting power queries.
interface ITegridyStakingGauge {
    // H-01 FIX: Aligned to actual TegridyStaking.Position struct ABI order
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp
    );
    function ownerOf(uint256 tokenId) external view returns (address);
    // AUDIT TF-04: historical voting-power lookup used for epoch-start snapshot votes.
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
}

/// @title GaugeController — Curve-style emission voting for Tegridy LP pools
/// @notice TOWELI stakers vote with their staking NFT's voting power to allocate
///         emission weights across whitelisted LP gauge pools each epoch (7 days).
///
///         Voting power = amount * boostBps / BOOST_PRECISION (mirrors TegridyStaking).
///         Votes lock for the entire epoch — users cannot change votes mid-epoch.
///         Admin adds/removes gauges via timelock. Total emission budget set by admin.
///
/// @dev Inspired by Curve's GaugeController. Epoch-based with discrete weight snapshots.
///      AUDIT NOTE: Uses block.timestamp for epoch boundaries. Validator manipulation of
///      ~15 seconds is negligible relative to 7-day epochs.
contract GaugeController is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── Constants ──────────────────────────────────────────────────
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant MAX_GAUGES_PER_VOTER = 8;
    uint256 public constant MAX_TOTAL_GAUGES = 50;
    uint256 public constant BPS = 10000;
    uint256 public constant BOOST_PRECISION = 10000;

    /// @notice Window at the end of each epoch during which commits must be revealed.
    /// @dev Commit window runs from epoch-start until `EPOCH_DURATION - REVEAL_WINDOW`.
    ///      Reveal window is the final `REVEAL_WINDOW` seconds of the epoch. A commit
    ///      made late in the commit window still needs to be revealed before epoch end.
    uint256 public constant REVEAL_WINDOW = 24 hours;

    bytes32 public constant GAUGE_ADD = keccak256("GAUGE_ADD");
    bytes32 public constant GAUGE_REMOVE = keccak256("GAUGE_REMOVE");
    bytes32 public constant EMISSION_BUDGET_CHANGE = keccak256("EMISSION_BUDGET_CHANGE");
    uint256 public constant GAUGE_TIMELOCK = 24 hours;
    uint256 public constant EMISSION_TIMELOCK = 48 hours;

    // ─── Immutables ─────────────────────────────────────────────────
    ITegridyStakingGauge public immutable tegridyStaking;
    uint256 public immutable genesisEpoch; // Timestamp of first epoch start

    // ─── Gauge Registry ─────────────────────────────────────────────
    address[] public gaugeList;
    mapping(address => bool) public isGauge;

    // ─── Voting State ───────────────────────────────────────────────
    /// @notice Total weight allocated to each gauge in a given epoch
    mapping(uint256 => mapping(address => uint256)) public gaugeWeightByEpoch;

    /// @notice Total voting power cast across all gauges in a given epoch
    mapping(uint256 => uint256) public totalWeightByEpoch;

    /// @notice Tracks the epoch in which a tokenId last voted (metadata only; reads 0
    ///         for "never voted" AND for "voted in epoch 0" — do NOT use as a guard).
    mapping(uint256 => uint256) public lastVotedEpoch;

    /// @notice Double-vote guard: hasVotedInEpoch[tokenId][epoch] == true iff this
    ///         NFT has already voted in this epoch. Replaces the
    ///         `lastVotedEpoch[tokenId] == epoch` guard, which incorrectly rejected
    ///         the first vote in epoch 0 because both sides default to 0.
    mapping(uint256 => mapping(uint256 => bool)) public hasVotedInEpoch;

    /// @notice Stores each tokenId's vote allocations for the epoch they voted in
    mapping(uint256 => VoteAllocation[]) internal _tokenVotes;

    struct VoteAllocation {
        address gauge;
        uint256 weight;
    }

    // ─── Commit-Reveal Voting State ─────────────────────────────────
    /// @notice Outstanding commitment hash for (tokenId, epoch).
    /// @dev bytes32(0) means no commitment. Populated by commitVote(), cleared by revealVote().
    mapping(uint256 => mapping(uint256 => bytes32)) public commitmentOf;

    /// @notice Records which address posted the commitment (binds reveal to committer).
    mapping(uint256 => mapping(uint256 => address)) public committerOf;

    // ─── Emission Budget ────────────────────────────────────────────
    /// @notice Total TOWELI emission budget per epoch (set by admin)
    uint256 public emissionBudget;
    uint256 public pendingEmissionBudget;

    // ─── Timelocked Pending State ───────────────────────────────────
    address public pendingGaugeAdd;
    address public pendingGaugeRemove;

    // ─── Events ─────────────────────────────────────────────────────
    event Voted(address indexed voter, uint256 indexed tokenId, uint256 indexed epoch, address[] gauges, uint256[] weights);
    event VoteCommitted(address indexed voter, uint256 indexed tokenId, uint256 indexed epoch, bytes32 commitmentHash);
    event VoteRevealed(address indexed voter, uint256 indexed tokenId, uint256 indexed epoch, address[] gauges, uint256[] weights);
    event GaugeAddProposed(address gauge, uint256 executeAfter);
    event GaugeAdded(address gauge);
    event GaugeRemoveProposed(address gauge, uint256 executeAfter);
    event GaugeRemoved(address gauge);
    event EmissionBudgetProposed(uint256 newBudget, uint256 executeAfter);
    event EmissionBudgetUpdated(uint256 oldBudget, uint256 newBudget);

    // ─── Errors ─────────────────────────────────────────────────────
    error ZeroAddress();
    error NotTokenOwner();
    error AlreadyVotedThisEpoch();
    error TooManyGauges();
    error InvalidGauge(address gauge);
    error ArrayLengthMismatch();
    error WeightsMustSumToBPS();
    error ZeroVotingPower();
    error GaugeAlreadyExists();
    error GaugeDoesNotExist();
    error MaxGaugesReached();
    error LockExpired();
    error CommitWindowClosed();
    error RevealWindowNotOpen();
    error NoCommitment();
    error CommitmentMismatch();
    error NotCommitter();
    error AlreadyCommitted();
    error ZeroCommitment();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _tegridyStaking,
        uint256 _emissionBudget
    ) OwnableNoRenounce(msg.sender) {
        if (_tegridyStaking == address(0)) revert ZeroAddress();
        tegridyStaking = ITegridyStakingGauge(_tegridyStaking);
        emissionBudget = _emissionBudget;
        // Align genesis to the start of the current week (Monday 00:00 UTC convention)
        genesisEpoch = (block.timestamp / EPOCH_DURATION) * EPOCH_DURATION;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  EPOCH HELPERS                                              ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Returns the current epoch number (0-indexed from genesis)
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesisEpoch) / EPOCH_DURATION;
    }

    /// @notice Returns the start timestamp of a given epoch
    function epochStartTime(uint256 epoch) public view returns (uint256) {
        return genesisEpoch + (epoch * EPOCH_DURATION);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  VOTING                                                     ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Vote on gauge weight allocation using a staking NFT's voting power
    /// @param tokenId  The TegridyStaking NFT token ID owned by msg.sender
    /// @param gauges   Array of gauge addresses to allocate weight to
    /// @param weights  Array of weights in BPS (must sum to 10000)
    function vote(
        uint256 tokenId,
        address[] calldata gauges,
        uint256[] calldata weights
    ) external nonReentrant whenNotPaused {
        // Validate ownership
        if (tegridyStaking.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        // Validate arrays
        if (gauges.length != weights.length) revert ArrayLengthMismatch();
        if (gauges.length > MAX_GAUGES_PER_VOTER) revert TooManyGauges();

        // Prevent double-voting within the same epoch
        // Previously used `lastVotedEpoch[tokenId] == epoch` which collided on epoch 0
        // (default mapping value == default epoch value), rejecting legitimate first votes.
        uint256 epoch = currentEpoch();
        if (hasVotedInEpoch[tokenId][epoch]) revert AlreadyVotedThisEpoch();

        // Compute voting power from staking position.
        // AUDIT TF-04 (Spartan MEDIUM): voting power is now pinned to the EPOCH-START
        // snapshot via TegridyStaking's existing checkpoint infrastructure, rather than
        // read live at vote time. Previous live read let an attacker stake at the start
        // of an epoch, vote (gaining full gauge weight for the epoch's emissions), and
        // then early-withdraw (25% penalty) before epoch end — profitable when emission
        // value on their chosen gauge exceeded the penalty. Snapshot lookup makes that
        // arbitrage impossible because the voter's power at epoch-start is what gets
        // recorded, and any subsequent unstake doesn't retro-reduce it. The lock
        // validity is still checked against live state so expired-lock votes are
        // rejected regardless.
        // H-01 FIX: Updated destructuring to match corrected ABI order
        (uint256 amount,,, uint256 lockEnd,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();
        uint256 votingPower = tegridyStaking.votingPowerAtTimestamp(msg.sender, epochStartTime(epoch));
        if (votingPower == 0) revert ZeroVotingPower();

        // Validate weights sum to BPS and all gauges are whitelisted
        uint256 totalWeight;
        for (uint256 i; i < gauges.length; ++i) {
            if (!isGauge[gauges[i]]) revert InvalidGauge(gauges[i]);
            totalWeight += weights[i];
        }
        if (totalWeight != BPS) revert WeightsMustSumToBPS();

        // Record vote — clear any stale allocations from a previous epoch
        delete _tokenVotes[tokenId];
        lastVotedEpoch[tokenId] = epoch;
        hasVotedInEpoch[tokenId][epoch] = true;

        // Apply weighted voting power to each gauge
        for (uint256 i; i < gauges.length; ++i) {
            uint256 allocatedPower = (votingPower * weights[i]) / BPS;
            gaugeWeightByEpoch[epoch][gauges[i]] += allocatedPower;
            totalWeightByEpoch[epoch] += allocatedPower;
            _tokenVotes[tokenId].push(VoteAllocation({gauge: gauges[i], weight: weights[i]}));
        }

        emit Voted(msg.sender, tokenId, epoch, gauges, weights);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  COMMIT-REVEAL VOTING (AUDIT H-2)                           ║
    // ║                                                             ║
    // ║  Closes the remaining bribe-arbitrage vector that the       ║
    // ║  epoch-start snapshot (TF-04) didn't fully address:         ║
    // ║  even with snapshot voting power, observers can watch       ║
    // ║  vote() transactions in the mempool and adjust bribes       ║
    // ║  before votes finalise. Commit-reveal hides the preferred   ║
    // ║  gauges until the reveal window, so bribe markets can't     ║
    // ║  react.                                                     ║
    // ║                                                             ║
    // ║  Timing within each 7-day epoch:                            ║
    // ║    [epoch-start … epoch-end - REVEAL_WINDOW]: COMMIT ONLY   ║
    // ║    [epoch-end - REVEAL_WINDOW … epoch-end]:   REVEAL ONLY   ║
    // ║                                                             ║
    // ║  Compatibility: legacy vote() is preserved so existing UIs  ║
    // ║  keep working. A future timelocked flag can gate vote() off ║
    // ║  once all UIs migrate to commit+reveal.                     ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Compute the commitment hash a voter must commit to.
    /// @dev Binds the commitment to tokenId, voter, gauges, weights, salt, AND epoch,
    ///      so a commitment cannot be replayed across epochs or stolen by a third party.
    /// @param voter    The address that will submit both the commit and the reveal.
    /// @param tokenId  TegridyStaking NFT the vote will be cast with.
    /// @param gauges   Gauge addresses the voter intends to allocate weight to.
    /// @param weights  Weights (BPS, summing to 10000).
    /// @param salt     Random 32-byte salt — the voter must keep this secret until reveal.
    /// @param epoch    Target epoch number (usually `currentEpoch()` at commit time).
    function computeCommitment(
        address voter,
        uint256 tokenId,
        address[] calldata gauges,
        uint256[] calldata weights,
        bytes32 salt,
        uint256 epoch
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(voter, tokenId, gauges, weights, salt, epoch));
    }

    /// @notice Commit a hidden vote for the current epoch.
    /// @dev Must be called during the commit window: from epoch-start until
    ///      `epoch-end - REVEAL_WINDOW`. Commitment must be revealed during the
    ///      reveal window or the vote does not count.
    /// @param tokenId        TegridyStaking NFT owned by msg.sender.
    /// @param commitmentHash Output of computeCommitment() with your chosen salt.
    function commitVote(uint256 tokenId, bytes32 commitmentHash) external nonReentrant whenNotPaused {
        if (commitmentHash == bytes32(0)) revert ZeroCommitment();
        if (tegridyStaking.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        uint256 epoch = currentEpoch();
        uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        if (block.timestamp >= revealOpens) revert CommitWindowClosed();
        if (hasVotedInEpoch[tokenId][epoch]) revert AlreadyVotedThisEpoch();
        if (commitmentOf[tokenId][epoch] != bytes32(0)) revert AlreadyCommitted();

        // Validate the NFT still represents an active lock (cheap pre-check;
        // real voting power is computed at reveal time against epoch-start snapshot).
        (uint256 amount,,, uint256 lockEnd,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();

        commitmentOf[tokenId][epoch] = commitmentHash;
        committerOf[tokenId][epoch] = msg.sender;

        emit VoteCommitted(msg.sender, tokenId, epoch, commitmentHash);
    }

    /// @notice Reveal a previously committed vote. Applies the vote to gauge weights.
    /// @dev Must be called during the reveal window: `epoch-end - REVEAL_WINDOW`
    ///      until `epoch-end`. The reveal must come from the same address that
    ///      committed (prevents front-running a reveal with a stolen commitment).
    /// @param tokenId  Same tokenId used in commitVote.
    /// @param gauges   Same gauges passed to computeCommitment.
    /// @param weights  Same weights.
    /// @param salt     The secret salt used in the commitment.
    function revealVote(
        uint256 tokenId,
        address[] calldata gauges,
        uint256[] calldata weights,
        bytes32 salt
    ) external nonReentrant whenNotPaused {
        uint256 epoch = currentEpoch();
        uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        if (block.timestamp < revealOpens) revert RevealWindowNotOpen();
        if (hasVotedInEpoch[tokenId][epoch]) revert AlreadyVotedThisEpoch();

        bytes32 stored = commitmentOf[tokenId][epoch];
        if (stored == bytes32(0)) revert NoCommitment();
        if (committerOf[tokenId][epoch] != msg.sender) revert NotCommitter();

        bytes32 expected = computeCommitment(msg.sender, tokenId, gauges, weights, salt, epoch);
        if (stored != expected) revert CommitmentMismatch();

        // Validate arrays / lock / power with the same rigour as legacy vote().
        if (gauges.length != weights.length) revert ArrayLengthMismatch();
        if (gauges.length > MAX_GAUGES_PER_VOTER) revert TooManyGauges();

        // Ownership check at reveal time — NFT transfers between commit and reveal
        // forfeit the vote, since voting power is scored against the committer.
        if (tegridyStaking.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        (uint256 amount,,, uint256 lockEnd,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();
        uint256 votingPower = tegridyStaking.votingPowerAtTimestamp(msg.sender, epochStartTime(epoch));
        if (votingPower == 0) revert ZeroVotingPower();

        uint256 totalWeight;
        for (uint256 i; i < gauges.length; ++i) {
            if (!isGauge[gauges[i]]) revert InvalidGauge(gauges[i]);
            totalWeight += weights[i];
        }
        if (totalWeight != BPS) revert WeightsMustSumToBPS();

        // Clear commitment (prevent replay) + mark voted (blocks legacy vote() too).
        delete commitmentOf[tokenId][epoch];
        delete committerOf[tokenId][epoch];
        delete _tokenVotes[tokenId];
        lastVotedEpoch[tokenId] = epoch;
        hasVotedInEpoch[tokenId][epoch] = true;

        for (uint256 i; i < gauges.length; ++i) {
            uint256 allocatedPower = (votingPower * weights[i]) / BPS;
            gaugeWeightByEpoch[epoch][gauges[i]] += allocatedPower;
            totalWeightByEpoch[epoch] += allocatedPower;
            _tokenVotes[tokenId].push(VoteAllocation({gauge: gauges[i], weight: weights[i]}));
        }

        emit VoteRevealed(msg.sender, tokenId, epoch, gauges, weights);
    }

    /// @notice Returns true when the current moment is inside the reveal window.
    function isRevealWindowOpen() external view returns (uint256 epoch, bool open, uint256 revealOpensAt, uint256 revealClosesAt) {
        epoch = currentEpoch();
        revealOpensAt = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        revealClosesAt = epochStartTime(epoch) + EPOCH_DURATION;
        open = block.timestamp >= revealOpensAt && block.timestamp < revealClosesAt;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  WEIGHT QUERIES                                             ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Returns the absolute weight for a gauge in the current epoch
    function getGaugeWeight(address gauge) external view returns (uint256) {
        return gaugeWeightByEpoch[currentEpoch()][gauge];
    }

    /// @notice Returns a gauge's share of total emissions in basis points for the current epoch
    /// @return Relative weight in BPS (0-10000). Returns 0 if no votes cast.
    function getRelativeWeight(address gauge) external view returns (uint256) {
        uint256 epoch = currentEpoch();
        uint256 total = totalWeightByEpoch[epoch];
        if (total == 0) return 0;
        return (gaugeWeightByEpoch[epoch][gauge] * BPS) / total;
    }

    /// @notice Returns a gauge's share of the emission budget for the current epoch
    function getGaugeEmission(address gauge) external view returns (uint256) {
        uint256 epoch = currentEpoch();
        uint256 total = totalWeightByEpoch[epoch];
        if (total == 0) return 0;
        return (emissionBudget * gaugeWeightByEpoch[epoch][gauge]) / total;
    }

    /// @notice Returns a gauge's relative weight for a specific past epoch
    function getRelativeWeightAt(address gauge, uint256 epoch) external view returns (uint256) {
        uint256 total = totalWeightByEpoch[epoch];
        if (total == 0) return 0;
        return (gaugeWeightByEpoch[epoch][gauge] * BPS) / total;
    }

    /// @notice Returns the vote allocations for a tokenId in its last voted epoch
    function getTokenVotes(uint256 tokenId) external view returns (VoteAllocation[] memory) {
        return _tokenVotes[tokenId];
    }

    /// @notice Returns the number of whitelisted gauges
    function gaugeCount() external view returns (uint256) {
        return gaugeList.length;
    }

    /// @notice Returns all whitelisted gauge addresses
    function getGauges() external view returns (address[] memory) {
        return gaugeList;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN — GAUGE MANAGEMENT                        ║
    // ═══════════════════════════════════════════════════════════════

    function proposeAddGauge(address gauge) external onlyOwner {
        if (gauge == address(0)) revert ZeroAddress();
        if (isGauge[gauge]) revert GaugeAlreadyExists();
        if (gaugeList.length >= MAX_TOTAL_GAUGES) revert MaxGaugesReached();
        pendingGaugeAdd = gauge;
        _propose(GAUGE_ADD, GAUGE_TIMELOCK);
        emit GaugeAddProposed(gauge, block.timestamp + GAUGE_TIMELOCK);
    }

    function executeAddGauge() external onlyOwner {
        _execute(GAUGE_ADD);
        address gauge = pendingGaugeAdd;
        isGauge[gauge] = true;
        gaugeList.push(gauge);
        pendingGaugeAdd = address(0);
        emit GaugeAdded(gauge);
    }

    function cancelAddGauge() external onlyOwner {
        _cancel(GAUGE_ADD);
        pendingGaugeAdd = address(0);
    }

    function proposeRemoveGauge(address gauge) external onlyOwner {
        if (!isGauge[gauge]) revert GaugeDoesNotExist();
        pendingGaugeRemove = gauge;
        _propose(GAUGE_REMOVE, GAUGE_TIMELOCK);
        emit GaugeRemoveProposed(gauge, block.timestamp + GAUGE_TIMELOCK);
    }

    function executeRemoveGauge() external onlyOwner {
        _execute(GAUGE_REMOVE);
        address gauge = pendingGaugeRemove;
        isGauge[gauge] = false;

        // Remove from gaugeList (swap-and-pop)
        uint256 len = gaugeList.length;
        for (uint256 i; i < len; ++i) {
            if (gaugeList[i] == gauge) {
                gaugeList[i] = gaugeList[len - 1];
                gaugeList.pop();
                break;
            }
        }

        pendingGaugeRemove = address(0);
        emit GaugeRemoved(gauge);
    }

    function cancelRemoveGauge() external onlyOwner {
        _cancel(GAUGE_REMOVE);
        pendingGaugeRemove = address(0);
    }

    // ─── Emission Budget (48h timelock) ─────────────────────────────

    function proposeEmissionBudgetChange(uint256 _newBudget) external onlyOwner {
        pendingEmissionBudget = _newBudget;
        _propose(EMISSION_BUDGET_CHANGE, EMISSION_TIMELOCK);
        emit EmissionBudgetProposed(_newBudget, block.timestamp + EMISSION_TIMELOCK);
    }

    function executeEmissionBudgetChange() external onlyOwner {
        _execute(EMISSION_BUDGET_CHANGE);
        uint256 old = emissionBudget;
        emissionBudget = pendingEmissionBudget;
        pendingEmissionBudget = 0;
        emit EmissionBudgetUpdated(old, emissionBudget);
    }

    function cancelEmissionBudgetProposal() external onlyOwner {
        _cancel(EMISSION_BUDGET_CHANGE);
        pendingEmissionBudget = 0;
    }

    // ─── Pause / Unpause ────────────────────────────────────────────
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
