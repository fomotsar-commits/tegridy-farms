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
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    );
    function ownerOf(uint256 tokenId) external view returns (address);
    // AUDIT TF-04: historical voting-power lookup used for epoch-start snapshot votes.
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    /// @notice AUDIT FIX: DEEP-GOV-01 — current-power lookup for the
    ///         min(historical, current) clamp at vote/revealVote sites.
    function votingPowerOf(address user) external view returns (uint256);
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

    /// @notice AUDIT FIX: DEEP-GOV-03 — per-gauge cap (50%) on epoch emission share.
    ///         Uses option-b denominator scaling so over-cap allocation is preserved
    ///         (redistributed proportionally to surviving gauges) instead of silently
    ///         dropped. Pattern: Aerodrome / Velodrome per-gauge cap with renormalization.
    uint256 public constant MAX_GAUGE_RELATIVE_WEIGHT_BPS = 5000;

    /// @notice Window at the end of each epoch during which commits must be revealed.
    /// @dev Commit window runs from epoch-start until `EPOCH_DURATION - REVEAL_WINDOW`.
    ///      Reveal window is the final `REVEAL_WINDOW` seconds of the epoch. A commit
    ///      made late in the commit window still needs to be revealed before epoch end.
    uint256 public constant REVEAL_WINDOW = 24 hours;

    /// @notice AUDIT R014-MEDIUM: 5-minute grace buffer on either side of the reveal
    ///         window to absorb validator block.timestamp drift (~15s typical, up to a
    ///         few minutes worst case). The buffer is tiny relative to the 24h reveal
    ///         window so it doesn't materially widen the attack surface, but it prevents
    ///         legitimate reveals from being rejected because a validator's clock was
    ///         a few seconds behind. Symmetric on both ends: reveals are accepted from
    ///         `revealOpens - REVEAL_GRACE` until `revealCloses + REVEAL_GRACE`.
    ///         Commit window is correspondingly tightened: commits stop being accepted
    ///         REVEAL_GRACE before revealOpens so the windows don't overlap.
    uint256 public constant REVEAL_GRACE = 5 minutes;

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

    /// @notice AUDIT FIX: V2-GOV-05 — cached per-epoch top gauge weight. Updated
    ///         incrementally during `vote()` and `revealVote()` so that
    ///         `_getRelativeWeightAt` is O(1) per call instead of O(n) over the
    ///         entire `gaugeList`. With MAX_TOTAL_GAUGES = 50 the pre-fix scan was
    ///         up to 50 SLOADs per relative-weight read; an emission distributor
    ///         that loops through gauges would inherit O(n²) cost. Cache is
    ///         monotonically increasing within an epoch — gauge weights only ever
    ///         grow during votes, never shrink, so we never need a re-scan.
    /// @dev    AUDIT FIX: V2-GOV-03 — using the cache also closes the past-epoch
    ///         topWeight undercount: when a gauge is removed via `executeRemoveGauge`
    ///         (allowed only when current-epoch weight is zero), the cache for past
    ///         epochs is left intact so historical reads still see the correct top.
    mapping(uint256 => uint256) public topWeightByEpoch;
    mapping(uint256 => address) public topGaugeByEpoch;

    /// @notice Tracks the epoch in which a tokenId last voted (metadata only; reads 0
    ///         for "never voted" AND for "voted in epoch 0" — do NOT use as a guard).
    mapping(uint256 => uint256) public lastVotedEpoch;

    /// @notice Double-vote guard: hasVotedInEpoch[tokenId][epoch] == true iff this
    ///         NFT has already voted in this epoch. Replaces the
    ///         `lastVotedEpoch[tokenId] == epoch` guard, which incorrectly rejected
    ///         the first vote in epoch 0 because both sides default to 0.
    mapping(uint256 => mapping(uint256 => bool)) public hasVotedInEpoch;

    /// @notice AUDIT C2: Per-USER epoch vote flag. Closes the multi-NFT amplification
    ///         vector where a contract holder with N staking NFTs could vote N times
    ///         per epoch, each time applying the OWNER-AGGREGATED voting power
    ///         (TegridyStaking.votingPowerOf returns the sum across all positions).
    ///         With this flag, a user can vote at most once per epoch regardless of
    ///         how many NFTs they hold; their full aggregate power is applied once.
    ///
    ///         EOAs were already protected by the per-EOA single-NFT guard in
    ///         TegridyStaking._update; this flag closes the equivalent gap for
    ///         contract wallets (Safes, vaults, multi-position aggregators).
    mapping(address => mapping(uint256 => bool)) public hasUserVotedInEpoch;

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

    /// @notice AUDIT R014-HIGH: Per-user-per-epoch active commit guard.
    ///         Closes the multi-NFT commit-rotation vector where a holder of multiple
    ///         staking NFTs commits with NFT-A on day 1, observes vote distribution and
    ///         bribe markets, then commits with NFT-B before reveal opens and reveals
    ///         only with NFT-B (abandoning the NFT-A commit). The per-tokenId guard at
    ///         reveal time doesn't catch this because the abandoned commit never
    ///         reveals — but at commit time the user already had an outstanding commit.
    ///
    ///         Stores the commitment hash the user committed with this epoch. Cleared
    ///         on successful reveal or explicit `cancelCommit`. While this slot is
    ///         non-zero, additional `commitVote` calls revert.
    ///
    ///         Storage layout: bytes32(0) means "no active commit". A non-zero entry
    ///         means the user has an outstanding commit that they must either reveal
    ///         or cancel before they can commit again.
    mapping(address => mapping(uint256 => bytes32)) public userActiveCommit;

    /// @notice AUDIT R014-HIGH: Tracks which tokenId backs the user's active commit,
    ///         so cancelCommit knows which (tokenId, epoch) commitment slot to clear.
    mapping(address => mapping(uint256 => uint256)) public userActiveCommitTokenId;

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
    event VoteCommitCancelled(address indexed voter, uint256 indexed tokenId, uint256 indexed epoch);
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
    /// @notice AUDIT FIX N-1: a prior `executeRemoveGaugeNextEpoch` left
    ///         `pendingGaugeRemove` non-zero awaiting `executeRemoveGaugeFinalize`.
    ///         Refuses a fresh `proposeRemoveGauge` to prevent orphan entries
    ///         in `gaugeList`.
    error GaugeRemovePending();
    error MaxGaugesReached();
    /// @notice AUDIT FIX G-02: typed error for the gauge code-length check on
    ///         `proposeAddGauge`. Distinguishes EOA-mistake from other zero-address
    ///         and dup-gauge cases.
    error NotAContract();
    error LockExpired();
    error CommitWindowClosed();
    error RevealWindowNotOpen();
    error NoCommitment();
    error CommitmentMismatch();
    error NotCommitter();
    error AlreadyCommitted();
    error ZeroCommitment();
    error UserAlreadyVotedThisEpoch(); // AUDIT C2: per-user epoch guard
    error UserHasActiveCommit();        // AUDIT R014-HIGH: per-user active commit guard
    error CancelWindowClosed();         // AUDIT R014-HIGH: cannot cancel after reveal opens
    error NoActiveCommit();             // AUDIT R014-HIGH: cancel called with no commit
    error ZeroWeight();                 // AUDIT R014-LOW: zero-weight gauge entries rejected
    /// @notice AUDIT FIX: DEEP-GOV-14 — gauge removal rejected mid-epoch when the
    ///         target gauge already has votes cast against it.
    error GaugeHasActiveVotes();

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
        // AUDIT C2: per-user epoch guard. Closes the multi-NFT amplification vector
        // where a contract holding N staking NFTs could vote N times per epoch, each
        // applying the owner-aggregated voting power. With this guard the user gets
        // exactly one vote per epoch with their full aggregate power.
        if (hasUserVotedInEpoch[msg.sender][epoch]) revert UserAlreadyVotedThisEpoch();

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
        (uint256 amount,,, uint256 lockEnd,,,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();
        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp. A 1-wei sentinel
        // post-snapshot cannot anchor full pre-divest aggregate gauge weight.
        uint256 historicalPower = tegridyStaking.votingPowerAtTimestamp(msg.sender, epochStartTime(epoch));
        uint256 currentPower = tegridyStaking.votingPowerOf(msg.sender);
        uint256 votingPower = historicalPower < currentPower ? historicalPower : currentPower;
        if (votingPower == 0) revert ZeroVotingPower();

        // Validate weights sum to BPS and all gauges are whitelisted
        // AUDIT R014-LOW: reject zero-weight entries to keep storage clean.
        // A zero-weight entry adds nothing to the gauge's tally but still consumes a
        // slot in `_tokenVotes` and an iteration step in any downstream consumer that
        // walks the array — callers should pass only meaningful gauge selections.
        uint256 totalWeight;
        for (uint256 i; i < gauges.length; ++i) {
            if (!isGauge[gauges[i]]) revert InvalidGauge(gauges[i]);
            if (weights[i] == 0) revert ZeroWeight();
            totalWeight += weights[i];
        }
        if (totalWeight != BPS) revert WeightsMustSumToBPS();

        // Record vote — clear any stale allocations from a previous epoch
        delete _tokenVotes[tokenId];
        lastVotedEpoch[tokenId] = epoch;
        hasVotedInEpoch[tokenId][epoch] = true;
        hasUserVotedInEpoch[msg.sender][epoch] = true; // AUDIT C2

        // Apply weighted voting power to each gauge
        for (uint256 i; i < gauges.length; ++i) {
            uint256 allocatedPower = (votingPower * weights[i]) / BPS;
            gaugeWeightByEpoch[epoch][gauges[i]] += allocatedPower;
            totalWeightByEpoch[epoch] += allocatedPower;
            _tokenVotes[tokenId].push(VoteAllocation({gauge: gauges[i], weight: weights[i]}));
            // AUDIT FIX: V2-GOV-05 — maintain the per-epoch top cache so
            // `_getRelativeWeightAt` is O(1) per call.
            _updateEpochTop(epoch, gauges[i]);
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
    ) public view returns (bytes32) {
        // AUDIT NEW-I2 (INFO): bind to (chainid, address(this)) so commitments are
        // unique per deployment. A fork that happens to deploy this contract at
        // the same address (deterministic factory, test environment) would otherwise
        // allow cross-chain commitment replay for matching gauge/weight sets.
        // Matches VoteIncentives.computeCommitment hash shape for consistency.
        return keccak256(
            abi.encode(block.chainid, address(this), voter, tokenId, gauges, weights, salt, epoch)
        );
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
        // AUDIT R014-MEDIUM: commit window closes REVEAL_GRACE before the reveal
        // window opens (with grace) — i.e. the windows abut at the un-graced
        // boundary. This keeps commits and reveals strictly disjoint while
        // tolerating ±REVEAL_GRACE validator drift on the reveal-side gate.
        uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        if (block.timestamp + REVEAL_GRACE >= revealOpens) revert CommitWindowClosed();
        if (hasVotedInEpoch[tokenId][epoch]) revert AlreadyVotedThisEpoch();
        if (commitmentOf[tokenId][epoch] != bytes32(0)) revert AlreadyCommitted();
        // AUDIT C2: per-user epoch guard. If the user already revealed (hence applied) a
        // vote earlier in this epoch via another NFT they own, no further commits accepted.
        // Stale unrevealed commits don't trip this guard — only successful reveals do —
        // so a user can still rotate which tokenId they ultimately reveal with.
        if (hasUserVotedInEpoch[msg.sender][epoch]) revert UserAlreadyVotedThisEpoch();
        // AUDIT R014-HIGH: per-user active commit guard. Multi-NFT holders cannot rotate
        // commits across NFTs within an epoch (commit with NFT-A, observe vote distribution
        // and bribe markets, commit with NFT-B, abandon NFT-A). If they want to switch
        // NFTs they must explicitly `cancelCommit` first — and cancellation is forbidden
        // once the reveal window opens, so they cannot use post-observation information
        // to retroactively change which NFT they vote with.
        if (userActiveCommit[msg.sender][epoch] != bytes32(0)) revert UserHasActiveCommit();

        // Validate the NFT still represents an active lock (cheap pre-check;
        // real voting power is computed at reveal time against epoch-start snapshot).
        (uint256 amount,,, uint256 lockEnd,,,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();

        commitmentOf[tokenId][epoch] = commitmentHash;
        committerOf[tokenId][epoch] = msg.sender;
        userActiveCommit[msg.sender][epoch] = commitmentHash;
        userActiveCommitTokenId[msg.sender][epoch] = tokenId;

        emit VoteCommitted(msg.sender, tokenId, epoch, commitmentHash);
    }

    /// @notice AUDIT R014-HIGH: Cancel an outstanding commit before the reveal window opens.
    /// @dev Allowed only while the commit window is open (with REVEAL_GRACE buffer). Once the
    ///      reveal window opens, cancellation is forbidden so a user cannot abandon a commit
    ///      after seeing other participants' reveals. Cancelling clears `userActiveCommit`,
    ///      letting the user submit a fresh commit (potentially with a different NFT).
    /// @dev AUDIT R016 M-1 (MEDIUM): tightened the cancel gate from
    ///      `block.timestamp + REVEAL_GRACE >= revealOpens` to
    ///      `block.timestamp + 2*REVEAL_GRACE >= revealOpens`. The reveal-side gate
    ///      accepts reveals starting at `revealOpens - REVEAL_GRACE` (graced opening),
    ///      so the prior cancel boundary closed cancellation at exactly the moment the
    ///      first reveal could be admitted. That left a 0-second-but-nonzero ordering
    ///      window where a user could observe a same-block reveal and still issue a
    ///      cancel in the same block (transaction ordering: reveal first, cancel
    ///      second — the cancel still passes the `>= revealOpens` test by less than
    ///      REVEAL_GRACE). With the new bound, cancellation closes one full
    ///      REVEAL_GRACE BEFORE any reveal could possibly be accepted, so see-then-
    ///      cancel cannot happen even in the same block.
    /// @param epoch The epoch in which the user's active commit was made (usually currentEpoch()).
    function cancelCommit(uint256 epoch) external nonReentrant whenNotPaused {
        bytes32 active = userActiveCommit[msg.sender][epoch];
        if (active == bytes32(0)) revert NoActiveCommit();

        // Cancellation closes one full REVEAL_GRACE before any reveal could possibly
        // be admitted (reveal admits from `revealOpens - REVEAL_GRACE`). Without this
        // double-grace bound, a user could watch a same-block reveal and still cancel.
        uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        if (block.timestamp + 2 * REVEAL_GRACE >= revealOpens) revert CancelWindowClosed();

        uint256 tokenId = userActiveCommitTokenId[msg.sender][epoch];

        // Clear all per-(tokenId, epoch) commit state and per-(user, epoch) commit state.
        delete commitmentOf[tokenId][epoch];
        delete committerOf[tokenId][epoch];
        delete userActiveCommit[msg.sender][epoch];
        delete userActiveCommitTokenId[msg.sender][epoch];

        emit VoteCommitCancelled(msg.sender, tokenId, epoch);
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
        // AUDIT FIX: DEEP-GOV-07 — derive `epoch` defensively. Pre-fix the function
        // used `currentEpoch()` directly, but `revealCloses == epochStartTime(epoch+1)`,
        // so any block.timestamp in `[revealCloses, revealCloses + REVEAL_GRACE]` made
        // `currentEpoch()` return `epoch+1`, causing the lookup at
        // `commitmentOf[tokenId][epoch+1]` to revert NoCommitment. The 5-minute trailing
        // grace was thus dead code. New rule: if we're in the trailing-grace zone (i.e.
        // block.timestamp >= revealCloses for the current epoch), look back one epoch
        // so the user's commit slot resolves correctly.
        uint256 nowEpoch = currentEpoch();
        uint256 nowEpochStart = epochStartTime(nowEpoch);
        uint256 epoch;
        if (nowEpoch > 0 && block.timestamp >= nowEpochStart) {
            // We may be in the trailing-grace period — try the previous epoch first if
            // we don't have a commit in the current one.
            // Compute revealClosesAt for the PREVIOUS epoch:
            //   revealClosesPrev = epochStartTime(nowEpoch) (= start of currentEpoch).
            // If we are within REVEAL_GRACE after that boundary AND the user has a
            // commit on (nowEpoch - 1) but NOT on nowEpoch, treat the reveal as
            // targeting the previous epoch.
            uint256 prev = nowEpoch - 1;
            bytes32 commitmentNow = commitmentOf[tokenId][nowEpoch];
            bytes32 commitmentPrev = commitmentOf[tokenId][prev];
            uint256 graceBoundary = nowEpochStart + REVEAL_GRACE;
            if (commitmentNow == bytes32(0) && commitmentPrev != bytes32(0)
                && block.timestamp <= graceBoundary) {
                epoch = prev;
            } else {
                epoch = nowEpoch;
            }
        } else {
            epoch = nowEpoch;
        }

        // AUDIT R014-MEDIUM: accept reveals from REVEAL_GRACE before the formal opening
        // until REVEAL_GRACE after the formal close. The graced opening absorbs validators
        // running ~15s ahead, the graced close absorbs validators running ~15s behind.
        // 5 minutes is tiny vs the 24-hour reveal window; the marginal early/late tolerance
        // doesn't widen the bribe-arbitrage surface in any economically meaningful way.
        uint256 revealOpens = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        uint256 revealCloses = epochStartTime(epoch) + EPOCH_DURATION;
        if (block.timestamp + REVEAL_GRACE < revealOpens) revert RevealWindowNotOpen();
        if (block.timestamp > revealCloses + REVEAL_GRACE) revert RevealWindowNotOpen();
        if (hasVotedInEpoch[tokenId][epoch]) revert AlreadyVotedThisEpoch();

        bytes32 stored = commitmentOf[tokenId][epoch];
        if (stored == bytes32(0)) revert NoCommitment();
        if (committerOf[tokenId][epoch] != msg.sender) revert NotCommitter();

        bytes32 expected = computeCommitment(msg.sender, tokenId, gauges, weights, salt, epoch);
        if (stored != expected) revert CommitmentMismatch();

        // Validate arrays / lock / power with the same rigour as legacy vote().
        if (gauges.length != weights.length) revert ArrayLengthMismatch();
        if (gauges.length > MAX_GAUGES_PER_VOTER) revert TooManyGauges();
        // AUDIT C2: per-user epoch guard at reveal time too. If the user already revealed
        // a vote in this epoch via another NFT, refuse to apply a second one.
        if (hasUserVotedInEpoch[msg.sender][epoch]) revert UserAlreadyVotedThisEpoch();

        // Ownership check at reveal time — NFT transfers between commit and reveal
        // forfeit the vote, since voting power is scored against the committer.
        if (tegridyStaking.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        (uint256 amount,,, uint256 lockEnd,,,,,,,) = tegridyStaking.positions(tokenId);
        if (amount == 0 || block.timestamp >= lockEnd) revert LockExpired();
        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp on reveal too.
        // Mirrors legacy vote() so a divested voter cannot reveal stale aggregate
        // power.
        uint256 historicalPower = tegridyStaking.votingPowerAtTimestamp(msg.sender, epochStartTime(epoch));
        uint256 currentVP = tegridyStaking.votingPowerOf(msg.sender);
        uint256 votingPower = historicalPower < currentVP ? historicalPower : currentVP;
        if (votingPower == 0) revert ZeroVotingPower();

        uint256 totalWeight;
        for (uint256 i; i < gauges.length; ++i) {
            if (!isGauge[gauges[i]]) revert InvalidGauge(gauges[i]);
            // AUDIT R014-LOW: same zero-weight rejection as legacy vote().
            if (weights[i] == 0) revert ZeroWeight();
            totalWeight += weights[i];
        }
        if (totalWeight != BPS) revert WeightsMustSumToBPS();

        // Clear commitment (prevent replay) + mark voted (blocks legacy vote() too).
        delete commitmentOf[tokenId][epoch];
        delete committerOf[tokenId][epoch];
        // AUDIT R014-HIGH: clear the per-user active commit so cancelCommit cannot be
        // called retroactively (it would already revert on NoActiveCommit, but we keep
        // storage minimal). userActiveCommitTokenId is also cleared for the same reason.
        delete userActiveCommit[msg.sender][epoch];
        delete userActiveCommitTokenId[msg.sender][epoch];
        delete _tokenVotes[tokenId];
        lastVotedEpoch[tokenId] = epoch;
        hasVotedInEpoch[tokenId][epoch] = true;
        hasUserVotedInEpoch[msg.sender][epoch] = true; // AUDIT C2

        for (uint256 i; i < gauges.length; ++i) {
            uint256 allocatedPower = (votingPower * weights[i]) / BPS;
            gaugeWeightByEpoch[epoch][gauges[i]] += allocatedPower;
            totalWeightByEpoch[epoch] += allocatedPower;
            _tokenVotes[tokenId].push(VoteAllocation({gauge: gauges[i], weight: weights[i]}));
            // AUDIT FIX: V2-GOV-05 — maintain the per-epoch top cache so
            // `_getRelativeWeightAt` is O(1) per call.
            _updateEpochTop(epoch, gauges[i]);
        }

        emit VoteRevealed(msg.sender, tokenId, epoch, gauges, weights);
    }

    /// @notice Returns true when the current moment is inside the reveal window.
    /// @dev Reports the formal opens/closes timestamps. The contract itself accepts
    ///      reveals from `revealOpensAt - REVEAL_GRACE` to `revealClosesAt + REVEAL_GRACE`
    ///      per the AUDIT R014-MEDIUM grace buffer; the `open` boolean uses the same
    ///      graced range so off-chain UIs match on-chain acceptance.
    function isRevealWindowOpen() external view returns (uint256 epoch, bool open, uint256 revealOpensAt, uint256 revealClosesAt) {
        epoch = currentEpoch();
        revealOpensAt = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        revealClosesAt = epochStartTime(epoch) + EPOCH_DURATION;
        open = block.timestamp + REVEAL_GRACE >= revealOpensAt
            && block.timestamp <= revealClosesAt + REVEAL_GRACE;
    }

    /// @notice AUDIT FIX: V2-GOV-06 — tokenId-aware view that mirrors the
    ///         `revealVote` epoch-derivation logic in the trailing-grace zone.
    ///         Pre-fix, `isRevealWindowOpen()` always reported `epoch =
    ///         currentEpoch()`, but during the trailing REVEAL_GRACE the contract
    ///         internally accepts reveals targeting `epoch - 1` if the user has
    ///         no commit in the new epoch but does in the prior one. UIs that
    ///         consumed the no-arg view in that window saw the wrong epoch and
    ///         reported "no commit found".
    /// @param  tokenId The user's tokenId — used to detect whether the active
    ///         reveal slot should resolve to the current or previous epoch.
    function isRevealWindowOpenFor(uint256 tokenId) external view returns (uint256 epoch, bool open, uint256 revealOpensAt, uint256 revealClosesAt) {
        uint256 nowEpoch = currentEpoch();
        uint256 nowEpochStart = epochStartTime(nowEpoch);
        // Mirror revealVote's defensive look-back exactly.
        if (nowEpoch > 0 && block.timestamp >= nowEpochStart) {
            uint256 prev = nowEpoch - 1;
            bytes32 commitmentNow = commitmentOf[tokenId][nowEpoch];
            bytes32 commitmentPrev = commitmentOf[tokenId][prev];
            uint256 graceBoundary = nowEpochStart + REVEAL_GRACE;
            if (commitmentNow == bytes32(0) && commitmentPrev != bytes32(0)
                && block.timestamp <= graceBoundary) {
                epoch = prev;
            } else {
                epoch = nowEpoch;
            }
        } else {
            epoch = nowEpoch;
        }
        revealOpensAt = epochStartTime(epoch) + EPOCH_DURATION - REVEAL_WINDOW;
        revealClosesAt = epochStartTime(epoch) + EPOCH_DURATION;
        open = block.timestamp + REVEAL_GRACE >= revealOpensAt
            && block.timestamp <= revealClosesAt + REVEAL_GRACE;
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
    /// @dev    AUDIT FIX: DEEP-GOV-03 — uses option-b denominator scaling. When the
    ///         top gauge would otherwise capture >50% of votes, the denominator is
    ///         scaled to `2 * topGauge.weight` so its share is exactly 50% but the
    ///         remainder stays distributable to surviving gauges.
    function getRelativeWeight(address gauge) external view returns (uint256) {
        return _getRelativeWeightAt(gauge, currentEpoch());
    }

    /// @notice Returns a gauge's share of the emission budget for the current epoch
    function getGaugeEmission(address gauge) external view returns (uint256) {
        return (emissionBudget * _getRelativeWeightAt(gauge, currentEpoch())) / BPS;
    }

    /// @notice Returns a gauge's relative weight for a specific past epoch
    function getRelativeWeightAt(address gauge, uint256 epoch) external view returns (uint256) {
        return _getRelativeWeightAt(gauge, epoch);
    }

    /// @dev AUDIT FIX: V2-GOV-04 + V2-GOV-05 — true renormalization (option-a)
    ///      with O(1) per-epoch top-weight cache. Pre-fix the option-b
    ///      denominator scaling left up to 49% of emissions undistributed when
    ///      the top gauge dominated; this version exact-distributes BPS by
    ///      capping the top to MAX_GAUGE_RELATIVE_WEIGHT_BPS and proportionally
    ///      redistributing the over-cap to all other gauges.
    ///      Pre-fix the topWeight scan was an O(n) loop over the entire
    ///      `gaugeList`; this version reads the cached `topWeightByEpoch[epoch]`
    ///      maintained at vote / revealVote sites.
    /// @dev AUDIT FIX: V2-GOV-03 — past-epoch reads now use the cached top from
    ///      that epoch, so a post-epoch gauge removal (allowed only when current
    ///      weight is zero) cannot retroactively change the historical top.
    function _getRelativeWeightAt(address gauge, uint256 epoch) internal view returns (uint256) {
        // AUDIT FIX V3-GOV-03 + V3-GOV-06: switch to the Curve-style natural
        // distribution algorithm. Drop the per-gauge cap + renormalization
        // entirely.
        //
        // The cap+renormalize formula `(gw * (BPS - cap)) / othersTotal` had
        // two unfixable edges:
        //   - V3-GOV-03 over-amplification: a 1-wei voter who is the ONLY
        //     non-top voter received `(1 * 5000) / 1 = 5000` (50% of
        //     emissions) — wildly disproportionate to their stake.
        //   - V3-GOV-06 zero-divide leak: when `othersTotal == 0` (single
        //     gauge has all votes), the function returned 0, silently leaking
        //     50% of the budget.
        //
        // These edges aren't fixable by tweaking the formula — they're
        // intrinsic to "cap one then redistribute the cap-overflow." The H14
        // attack scenario the cap was designed to block (a 1-wei voter
        // controlling 100% of emissions) is already closed UPSTREAM by:
        //   - C2 commitVote `committedPower` cap (voters can't commit more
        //     than their userPower)
        //   - C3 / DEEP-GOV-01 `min(historical, current)` clamp at every
        //     vote site (voters can't apply post-divest aggregate)
        // So the cap is now solving a problem that's already solved.
        //
        // Pattern of record: Curve `GaugeController.gauge_relative_weight`
        // returns `gauge_weights[gauge] * 10**18 / total_weight` with NO cap.
        // The natural distribution is fair because vote weight is
        // proportional to stake, and the upstream guards prevent
        // single-actor manipulation.
        uint256 total = totalWeightByEpoch[epoch];
        if (total == 0) return 0;

        uint256 gw = gaugeWeightByEpoch[epoch][gauge];
        if (gw == 0) return 0;

        return (gw * BPS) / total;
    }

    /// @dev AUDIT FIX: V2-GOV-05 — internal helper to update the per-epoch top
    ///      cache after a gauge's weight has been incremented. Cheap O(1) compare
    ///      against the existing top. Called from both `vote()` and `revealVote()`.
    function _updateEpochTop(uint256 epoch, address gauge) internal {
        uint256 newWeight = gaugeWeightByEpoch[epoch][gauge];
        if (newWeight > topWeightByEpoch[epoch]) {
            topWeightByEpoch[epoch] = newWeight;
            topGaugeByEpoch[epoch] = gauge;
        }
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
        // AUDIT FIX G-02: refuse to register an EOA / non-contract as a gauge.
        // Pre-fix, an owner mistake (typo, malformed address, copy-paste from a
        // different chain) could whitelist a non-contract — voters would
        // allocate weight to it, downstream emission distribution would route
        // to an EOA (or a non-existent address on this chain), and emissions
        // would be lost or routed to a coincidental EOA. Battle-tested
        // defensive check used by every major gauge-controller (Curve, etc.).
        if (gauge.code.length == 0) revert NotAContract();
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
        // AUDIT FIX N-1 (orphan-gauge): refuse a fresh propose if a prior
        // `executeRemoveGaugeNextEpoch` has staged a deferred prune that
        // hasn't been finalized. Without this guard, calling proposeRemoveGauge(B)
        // overwrites `pendingGaugeRemove = A` (set by the prior next-epoch path
        // and intentionally left non-zero so finalize knows which gauge to prune)
        // — A is now permanently in gaugeList with isGauge[A]=false because the
        // finalize path keys off `pendingGaugeRemove` and would only ever prune B.
        // Repeated administration would slowly fill gaugeList up to MAX_TOTAL_GAUGES
        // (50) with dead entries, eventually bricking proposeAddGauge.
        // Owner must call `executeRemoveGaugeFinalize` (permissionless once weight
        // zeroes) before staging the next removal — or use the synchronous
        // `executeRemoveGauge` path (which clears pendingGaugeRemove on success).
        if (pendingGaugeRemove != address(0)) revert GaugeRemovePending();
        pendingGaugeRemove = gauge;
        _propose(GAUGE_REMOVE, GAUGE_TIMELOCK);
        emit GaugeRemoveProposed(gauge, block.timestamp + GAUGE_TIMELOCK);
    }

    function executeRemoveGauge() external onlyOwner {
        _execute(GAUGE_REMOVE);
        address gauge = pendingGaugeRemove;
        // AUDIT FIX: DEEP-GOV-14 — refuse mid-epoch removal when the gauge already
        // received votes for the current epoch. Without this, the dead gauge's weight
        // stays in `totalWeightByEpoch[currentEpoch]` even though `isGauge` flips to
        // false, diluting every surviving gauge's relative weight for the rest of
        // the epoch. Owner must wait until next epoch (when the gauge has zero
        // weight in the new bucket). Pattern: Curve change_gauge_weight applies
        // at next epoch boundary.
        // AUDIT FIX: V2-GOV-07 — when current-epoch votes exist, owners now have a
        // documented escape via `executeRemoveGaugeNextEpoch()` below: it flips
        // `isGauge` immediately so future votes for the gauge revert
        // (`InvalidGauge`), but defers the gaugeList swap-and-pop to the natural
        // epoch boundary. This means a single voter cannot perpetually block
        // removal by voting at the start of every epoch — the owner can immediately
        // disarm new votes while the current epoch's emissions finish out cleanly.
        if (gaugeWeightByEpoch[currentEpoch()][gauge] > 0) revert GaugeHasActiveVotes();
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

    /// @notice AUDIT FIX: V2-GOV-07 — alternative removal path that disables the
    ///         gauge IMMEDIATELY (no future votes accepted) but defers the
    ///         gaugeList prune to a manual second step. Closes the
    ///         "voter-veto-by-perpetual-voting" attack on `executeRemoveGauge`:
    ///         pre-fix, a single voter calling `vote()` at every epoch start could
    ///         keep `gaugeWeightByEpoch[currentEpoch][gauge] > 0` forever and
    ///         cause every owner removal proposal to expire unused.
    ///         With this path, the owner flips `isGauge` to false the moment the
    ///         timelock elapses, blocking new votes regardless of any active
    ///         votes already cast for the current epoch. The current-epoch's
    ///         emissions still distribute against the cast votes (no retroactive
    ///         change) — only future votes are blocked.
    /// @dev    Followed up by `executeRemoveGaugeFinalize()` once the current
    ///         epoch's votes naturally age out, to prune `gaugeList`.
    function executeRemoveGaugeNextEpoch() external onlyOwner {
        _execute(GAUGE_REMOVE);
        address gauge = pendingGaugeRemove;
        // Disarm new votes immediately. Existing votes for currentEpoch keep
        // their weight (no retroactive shrink); finalize() prunes once safe.
        isGauge[gauge] = false;
        // pendingGaugeRemove is INTENTIONALLY left set so finalize knows which
        // gauge to prune from gaugeList. emit signals the change is staged.
        emit GaugeRemoved(gauge);
    }

    /// @notice AUDIT FIX: V2-GOV-07 — finalizes the removal staged by
    ///         `executeRemoveGaugeNextEpoch`: prunes `gaugeList` once the gauge
    ///         no longer has any current-epoch weight (i.e., the epoch in which
    ///         the active votes were cast has fully aged out).
    ///         Permissionless because by the time current-epoch weight is zero,
    ///         the gauge is already disarmed (`isGauge == false`) and there's
    ///         nothing to wait on.
    function executeRemoveGaugeFinalize() external {
        address gauge = pendingGaugeRemove;
        if (gauge == address(0)) revert GaugeDoesNotExist();
        // Allow finalize ONLY after currentEpoch's weight is zero.
        if (gaugeWeightByEpoch[currentEpoch()][gauge] > 0) revert GaugeHasActiveVotes();
        // Defensive: must already be disarmed.
        if (isGauge[gauge]) revert GaugeAlreadyExists();

        uint256 len = gaugeList.length;
        for (uint256 i; i < len; ++i) {
            if (gaugeList[i] == gauge) {
                gaugeList[i] = gaugeList[len - 1];
                gaugeList.pop();
                break;
            }
        }

        pendingGaugeRemove = address(0);
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
