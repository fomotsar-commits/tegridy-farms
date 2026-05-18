// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
// AUDIT FIX (pass-8): EIP170-03 — TimelockAdmin and the propose/execute/cancel
// admin surface moved to VoteIncentivesAdmin sister contract during Phase 0.3.
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";
import {VotePowerOracle} from "./lib/VotePowerOracle.sol";

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
/// @dev AUDIT R016 M-1: extended with `disabledPairs` so `_validatePair` can refuse
///      bribes against pairs the factory has disabled (timelocked governance OR
///      guardian emergency disable). Without this gate a briber could waste TOWELI
///      / ETH on a pair that voters can no longer route swaps through.
interface ITegridyFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function disabledPairs(address pair) external view returns (bool);
}

/// @dev Interface for TegridyPair to read token addresses (H-04 fix).
interface ITegridyPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @dev AUDIT FIX (pass-8): GOV-INT-01 / C8 — minimal interface to GaugeController's
///      `pairToGauge` registry. Used by VoteIncentives to gate `depositBribe` /
///      `depositBribeETH` on the existence of a registered gauge for the briber's pair,
///      so a briber cannot strand a bond on a pair that has no emission distributor.
interface IGaugeControllerPairs {
    function pairToGauge(address pair) external view returns (address);
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
contract VoteIncentives is OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Sister contract holding the propose/execute/cancel timelock
    ///         admin surface for this contract. Wired once via
    ///         `setVoteIncentivesAdmin`. All `applyXxx` setters on this
    ///         contract are gated `msg.sender == voteIncentivesAdmin`.
    /// @dev    AUDIT FIX (pass-8): EIP170-03 — split into sister contract to
    ///         bring this contract under the 24,576-byte EIP-170 limit.
    ///         Mirrors `swapFeeRouterAdmin` / `lendingAdmin` patterns.
    address public voteIncentivesAdmin;

    error LendingAdminNotSet();
    error VoteIncentivesAdminAlreadySet();
    error NotVoteIncentivesAdmin();
    /// @notice AUDIT FIX (pass-8): GOV-INT-01 — `setGaugeController` is one-shot,
    ///         mirrors the `setVoteIncentivesAdmin` / `setRestakingContract` patterns.
    ///         Locks the GaugeController address once wired so a captured owner
    ///         cannot retarget the bribe-eligibility check.
    error GaugeControllerAlreadySet();
    /// @notice AUDIT FIX (pass-8): GOV-INT-01 — `depositBribe`/`depositBribeETH`
    ///         reverts when the briber's pair has no registered gauge. Closes
    ///         the stranded-bond bug where bribes deposited on un-gauged pairs
    ///         flowed into the contract with no recovery path.
    error NoGaugeForPair();

    event VoteIncentivesAdminSet(address indexed admin);
    event GaugeControllerSet(address indexed gaugeController);

    /// @notice GaugeController address used as the source-of-truth for
    ///         pair → gauge mapping. When zero, the bribe-eligibility check is
    ///         skipped — preserves backwards compatibility for fixtures /
    ///         deploys that haven't wired a GaugeController yet, but a
    ///         production deploy MUST wire it post-construction via
    ///         `setGaugeController(address)` to close GOV-INT-01.
    /// @dev    Wired exactly once. Pattern of record: Velodrome / Aerodrome's
    ///         pair → gauge registry on the Voter contract.
    address public gaugeController;

    function setGaugeController(address _gaugeController) external onlyOwner {
        if (_gaugeController == address(0)) revert ZeroAddress();
        if (gaugeController != address(0)) revert GaugeControllerAlreadySet();
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): mirror the
        //         OwnableNoRenounce length-23 carve-out so a typo'd 7702-EOA
        //         doesn't compile-pass and brick this one-shot setter.
        uint256 codeLen = _gaugeController.code.length;
        require(codeLen > 0 && codeLen != 23, "GC_MUST_BE_CONTRACT");
        gaugeController = _gaugeController;
        emit GaugeControllerSet(_gaugeController);
    }

    /// @dev AUDIT FIX (pass-8): GOV-INT-01 — internal pair-eligibility check.
    ///      No-op when `gaugeController == address(0)` (pre-wiring fallback).
    ///      Once a GaugeController is wired, every bribe deposit must target a
    ///      pair that has a registered gauge.
    function _requireGaugedPair(address pair) internal view {
        address gc = gaugeController;
        if (gc == address(0)) return;
        if (IGaugeControllerPairs(gc).pairToGauge(pair) == address(0)) {
            revert NoGaugeForPair();
        }
    }

    modifier onlyAdmin() {
        if (msg.sender != voteIncentivesAdmin) revert NotVoteIncentivesAdmin();
        _;
    }

    function setVoteIncentivesAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        if (voteIncentivesAdmin != address(0)) revert VoteIncentivesAdminAlreadySet();
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): length-23 carve-out.
        uint256 codeLen = _admin.code.length;
        require(codeLen > 0 && codeLen != 23, "ADMIN_MUST_BE_CONTRACT");
        voteIncentivesAdmin = _admin;
        emit VoteIncentivesAdminSet(_admin);
    }

    // AUDIT FIX (pass-8): EIP170-03 — timelock keys moved to VoteIncentivesAdmin
    // alongside the propose/execute/cancel functions whose state they keyed.

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

    /// @notice AUDIT FIX (pass-8) Phase 1.6 — minimum aggregate voting power
    ///         required for a (epoch, pair) bribe pool to be claimable.
    ///         Pre-fix, claims succeeded against any non-zero `totalGaugeVotes`,
    ///         so a briber could deposit a bribe, vote with a 1-wei VP themselves,
    ///         and claim ~100% of the bribe back via
    ///         `share = bribeAmount * 1 / 1`. This threshold forces the pool
    ///         to attract a meaningful amount of honest voting weight before
    ///         any payout — reverting `BribePoolBelowQuorum` otherwise so
    ///         orphan-rescue / depositor-refund paths can recover the bond.
    /// @dev    Set to 10% of `MIN_DISTRIBUTE_STAKE` (= 100e18 voting power).
    ///         A briber gaming the threshold needs at least 100 VP of attacker-
    ///         controlled stake to satisfy the quorum, which combined with the
    ///         `SelfBribeClaimForbidden` rule below makes pure self-bribe
    ///         arbitrage uneconomical (the briber is locked out of the pool
    ///         their own VP unlocks).
    uint256 public constant MIN_BRIBE_CLAIM_QUORUM = 100e18;

    // ─── Immutables ──────────────────────────────────────────────────
    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;
    ITegridyFactory public immutable factory;

    /// @notice Optional restaking contract; voting power from restaked positions
    ///         is added to staking-side power for vote/commit/reveal eligibility.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10 — without this, voters who
    ///         restake their staking NFT have `votingEscrow.votingPower*` return
    ///         0 and silently lose ALL bribe-vote power. One-shot setter mirrors
    ///         the `setSequencerFeed` pattern in SwapFeeRouter.
    address public restakingContract;

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
    /// @dev    AUDIT FIX (BATCH-F H14): defaults to TRUE so fresh deployments
    ///         start with commit-reveal active from epoch 0. Pre-fix, the
    ///         field defaulted to false, meaning all initial epochs ran with
    ///         the see-bribes-then-vote legacy path until the admin flipped
    ///         it via the 24h-timelocked applyEnableCommitReveal call. That
    ///         left an N-epoch window of bribe-arbitrage-by-design at every
    ///         relaunch. Hidden Hand v2 / Aerodrome ship commit-reveal ON
    ///         from genesis for the same reason.
    bool public commitRevealEnabled = true;

    struct CommitInfo {
        bytes32 commitHash;  // keccak256(chainid, addr, user, epoch, pair, power, salt)
        uint96 bond;         // TOWELI bond locked at commit time
        bool revealed;       // true once revealVote matched
    }

    /// @notice voterCommits[user][epoch][commitIndex]
    mapping(address => mapping(uint256 => CommitInfo[])) public voterCommits;
    /// @notice AUDIT FIX: MICROSCOPE C2 — sum of declared powers across a user's
    ///         commits in a given epoch. Capped at `min(historical, current)` voting
    ///         power at commit time. Closes the multi-commit options-arbitrage primitive
    ///         where a voter could commit hashes for every candidate pair (10-TOWELI bond
    ///         per commit) and reveal only the most lucrative subset.
    mapping(address => mapping(uint256 => uint256)) public committedPower;

    // epochBribes[epoch][pair][token] = total bribe amount (after fee)
    //
    // AUDIT R014 H-4 (HIGH): write path is the live (un-snapshotted) bucket only.
    // The on-chain "snapshotted" boundary is enforced by `epochBribesFinalized[N]`
    // below. Read paths (vote/claim/preview/refundUnvotedBribe/dustOf) MUST guard
    // on `epochBribesFinalized[epoch] == true` so a future refactor that lets a
    // depositor target a specific epoch index cannot retroactively change a
    // confirmed snapshot.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public epochBribes;

    /// @notice AUDIT R014 H-4 (HIGH): per-epoch finalization flag, set atomically
    ///         inside `advanceEpoch()`. Equivalent to the audit's proposed
    ///         `confirmedEpochBribes` ledger without the O(pairs * tokens) copy
    ///         on advance — which would otherwise be a gas bomb on heavily-bribed
    ///         weeks. Read paths refuse to surface a per-(pair, token) amount
    ///         until this flag flips, so a briber cannot atomically deposit +
    ///         advance + vote and have voters see/claim the just-deposited pool.
    mapping(uint256 => bool) public epochBribesFinalized;

    // epochBribeTokens[epoch][pair] = list of bribe token addresses
    // SLITHER 2026-05-18: intentional default-zero storage slot — see in-file NatSpec
    // slither-disable-next-line uninitialized-state
    mapping(uint256 => mapping(address => address[])) public epochBribeTokens;

    // claimed[user][epoch][pair][token] = true if already claimed
    mapping(address => mapping(uint256 => mapping(address => mapping(address => bool)))) public claimed;

    /// @notice AUDIT FIX (pass-8) Phase 1.6 — `depositedOnPair[user][epoch][pair]` is
    ///         true once `user` has deposited any bribe on the (epoch, pair). Read by
    ///         `claimBribes` / `claimBribesBatch` to lock out self-claim arbitrage:
    ///         a depositor cannot claim ANY token on the (epoch, pair) they bribed,
    ///         which closes the path where a briber votes with their own VP and
    ///         claims their own bond back proportionally. Captures the strictest
    ///         interpretation — even a depositor who only bribed token A is locked
    ///         out of token B claims on the same pair, since cross-token swaps would
    ///         re-open the round-trip. Strict per-(epoch, pair) granularity is
    ///         preserved across the whole epoch lifecycle.
    mapping(address => mapping(uint256 => mapping(address => bool))) public depositedOnPair;

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
    /// AUDIT FIX (BATCH-N2 M12): per-depositor last-deposit-at, indexed by
    /// (epoch, pair, token, depositor). Closes the dust-grief shared-key
    /// vulnerability where an attacker's MIN_BRIBE_AMOUNT dust deposit
    /// extended the rescue clock for ALL legitimate depositors in the epoch.
    /// Now refundOrphanedBribe is per-depositor-clocked: my rescue window
    /// opens 30d after MY last deposit, regardless of others' activity.
    mapping(uint256 => mapping(address => mapping(address => mapping(address => uint256)))) public lastBribeDepositPerUser;

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

    // AUDIT FIX (pass-8): EIP170-03 — MIN_BRIBE_CHANGE key + MIN_BRIBE_CHANGE_DELAY +
    // pendingMinBribe* state moved to VoteIncentivesAdmin.

    // V2: Gauge Voting — Velodrome/Aerodrome pattern
    // Users must vote() to allocate power to specific pairs before claiming that pair's bribes.
    // gaugeVotes[user][epoch][pair] = voting power allocated to that pair
    mapping(address => mapping(uint256 => mapping(address => uint256))) public gaugeVotes;
    // totalGaugeVotes[epoch][pair] = total votes for that pair (denominator for share calc)
    mapping(uint256 => mapping(address => uint256)) public totalGaugeVotes;
    // userTotalVotes[user][epoch] = total power user has allocated across all pairs (capped at votingPower)
    mapping(address => mapping(uint256 => uint256)) public userTotalVotes;

    // AUDIT FIX (pass-8): EIP170-03 — pendingFeeBps / pendingTreasury /
    // pendingWhitelistToken / pendingWhitelistAction moved to VoteIncentivesAdmin.

    // ─── Events ──────────────────────────────────────────────────────
    event EpochAdvanced(uint256 indexed epochId, uint256 totalPower, uint256 timestamp);
    event BribeDeposited(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount, uint256 fee);
    event BribeDepositedETH(uint256 indexed epoch, address indexed pair, address indexed depositor, uint256 amount, uint256 fee);
    event BribeClaimed(address indexed user, uint256 indexed epoch, address indexed pair, address token, uint256 amount);
    event PendingETHCredited(address indexed user, uint256 amount);
    event PendingETHWithdrawn(address indexed user, uint256 amount);
    event PendingTokenCredited(address indexed user, address indexed token, uint256 amount);
    event PendingTokenWithdrawn(address indexed user, address indexed token, uint256 amount);
    // AUDIT FIX (pass-8): EIP170-03 — Proposed/Cancelled events moved to
    // VoteIncentivesAdmin. The "happened" events stay here.
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);
    event GaugeVoted(address indexed user, uint256 indexed epoch, address indexed pair, uint256 power);
    // AUDIT H-2: commit-reveal events.
    event VoteCommitted(address indexed user, uint256 indexed epoch, uint256 commitIndex, bytes32 commitHash);
    event VoteRevealed(address indexed user, uint256 indexed epoch, uint256 commitIndex, address indexed pair, uint256 power);
    event BondRefunded(address indexed user, uint256 indexed epoch, uint256 commitIndex, uint256 amount);
    event BondForfeited(address indexed user, uint256 indexed epoch, uint256 commitIndex, uint256 amount);
    /// @notice AUDIT FIX: V2-GOV-01 — emitted when a voter abandons a commit whose pair
    ///         was disabled by the factory after commit time. Bond is refunded (not
    ///         forfeited) because the voter is being kicked off through no fault of
    ///         their own; `committedPower` is decremented so the voter regains the
    ///         power they cannot reveal.
    event CommitForfeitedOnDisabledPair(address indexed user, uint256 indexed epoch, uint256 commitIndex, address indexed pair, uint256 power, uint256 bond);
    event CommitRevealEnabled(bool enabled);
    event RestakingContractSet(address indexed restaking); // pass-8 GOV-ECON-01

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    /// @notice AUDIT FIX G-01: typed error for the `forfeitCommitOnDisabledPair`
    ///         caller-restriction. Only the commit owner or the contract owner
    ///         may force-unwind a commit during a disabled-pair window.
    error Unauthorized();
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
    /// @dev AUDIT FIX (pass-8): GOV-ECON-01 / C10 — restakingContract is one-shot.
    error RestakingAlreadySet();
    /// @dev AUDIT FIX (pass-8) Phase 1.6 — claim refused because the (epoch, pair)
    ///      bribe pool attracted aggregate voting power below `MIN_BRIBE_CLAIM_QUORUM`.
    ///      Bond is recoverable via the existing orphan-rescue / depositor-refund
    ///      paths once the rescue window opens.
    error BribePoolBelowQuorum();
    /// @dev AUDIT FIX (pass-8) Phase 1.6 — caller deposited a bribe on this
    ///      (epoch, pair) and is therefore locked out of claims for it. Closes the
    ///      self-arbitrage path where a briber votes with their own VP, claims
    ///      their own bribe back proportionally, and pockets the difference
    ///      (minus the protocol fee) when their VP dominates `totalGaugeVotes`.
    error SelfBribeClaimForbidden();
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
    /// @notice AUDIT R014 H-4: bribes for an epoch are not visible until the
    ///         epoch is finalized via `advanceEpoch`. Surfaces clearly in
    ///         vote/claim/preview/dust paths instead of silently zeroing.
    error EpochNotFinalized();
    /// AUDIT FIX (BATCH-H M14): claim attempted before VOTE_DEADLINE crystallizes
    /// the totalGaugeVotes denominator (early-claimer over-share defense).
    error ClaimWindowNotOpen();
    /// @notice AUDIT R016 M-1 (MEDIUM): the targeted pair is currently flagged as
    ///         disabled by the TegridyFactory (governance-timelocked OR guardian
    ///         emergency disable). Bribes against a disabled pair would be wasted —
    ///         voters can no longer route swaps through it — so all read/write paths
    ///         that name a pair refuse it up-front.
    error PairDisabled();
    /// @notice AUDIT L-2 (2026-04-28): legacy `enableCommitReveal()` selector reverts
    ///         with this typed error so any tooling on the old signature fails loudly
    ///         and clearly redirects callers to the propose/execute flow.
    error UseProposeEnableCommitReveal();
    /// @notice AUDIT FIX: V2-GOV-01 — `forfeitCommitOnDisabledPair` was called against
    ///         a pair that is currently NOT disabled. Refusing here forces voters to
    ///         honour live commits via the normal reveal path.
    error PairNotDisabled();

    // AUDIT FIX (pass-8): EIP170-03 — view-helpers (`feeChangeTime`,
    // `treasuryChangeTime`, `whitelistChangeTime`, `minBribeChangeTime`,
    // `commitRevealEnableTime`) moved to VoteIncentivesAdmin alongside the
    // propose/execute/cancel functions whose readiness they exposed.

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

        // AUDIT R014 H-4 (HIGH): the index that was the LIVE bucket up to this
        // call is the one being finalized. Capture it BEFORE pushing so the
        // finalized flag flips atomically with the snapshot — voters reading
        // bribes for `newEpoch` post-tx see the confirmed pool, never a partial
        // pre-snapshot view. Pending deposits in the live bucket made BEFORE
        // this call are now committed; deposits made AFTER (which target
        // `epochs.length` post-push, i.e., the next live bucket) cannot
        // retroactively change `newEpoch`'s finalized pool.
        uint256 newEpoch = epochs.length;

        epochs.push(EpochInfo({
            totalPower: totalPower,
            timestamp: snapshotTime,
            usesCommitReveal: commitRevealEnabled
        }));

        // AUDIT R014 H-4: finalize. From this point, vote/claim/preview/dust
        // paths see the bribe pool for `newEpoch`; any further `depositBribe`
        // call for `newEpoch` reverts via the EPOCH_FINALIZED guard in
        // depositBribe / depositBribeETH.
        epochBribesFinalized[newEpoch] = true;

        lastEpochTime = block.timestamp;

        emit EpochAdvanced(newEpoch, totalPower, snapshotTime);
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
        // AUDIT R014 H-4 (HIGH): refuse votes against epochs whose bribe ledger
        // isn't finalized. Identical to `epoch < epochs.length` today (advance
        // flips both atomically) but the explicit guard defends against future
        // refactors that push to `epochs[]` without finalizing the bribe ledger.
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();
        // AUDIT FIX: DEEP-GOV-08 — refuse votes for disabled pairs. Pre-fix, R016 M-1
        // only gated `depositBribe`; `vote()` accepted disabled pairs, letting voters
        // waste their `userTotalVotes` allocation on a dead pair (locking out future
        // votes for live pairs). _validatePair now checks pair registration AND the
        // factory's disabled-pairs flag.
        _validatePair(pair);

        EpochInfo memory ep = epochs[epoch];
        // AUDIT H-2: epochs tagged with usesCommitReveal MUST use the
        // commitVote() + revealVote() pair; plain vote() is disabled for
        // them to prevent the bribery-arbitrage bypass.
        if (ep.usesCommitReveal) revert LegacyVoteOnCommitRevealEpoch();
        // SECURITY FIX: Enforce voting deadline — prevents retroactive vote gaming after seeing bribes.
        // Pattern: Aerodrome/Velodrome — votes must be cast within VOTE_DEADLINE of epoch snapshot.
        if (block.timestamp > ep.timestamp + VOTE_DEADLINE) revert VoteDeadlinePassed();
        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp on vote(). Closes
        // the snapshot/possession decoupling: a voter who held N power at snapshot and
        // divested 99.999% of NFTs after snapshot (keeping a 1-wei sentinel) cannot
        // apply the full pre-divest aggregate. Uses smaller of historical / current.
        // Pattern: Curve veCRV non-transferability; Aave aTokens min(checkpointed, balance).
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additive read across staking +
        // restaking. Without this, every restaker's vote() would silently revert
        // NothingToClaim (their staking-side power is forced to 0 on restake).
        uint256 historicalPower = VotePowerOracle.powerAt(
            msg.sender, ep.timestamp, address(votingEscrow), restakingContract
        );
        uint256 currentPower = VotePowerOracle.powerOf(msg.sender, address(votingEscrow), restakingContract);
        uint256 userPower = historicalPower < currentPower ? historicalPower : currentPower;
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
        _requireGaugedPair(pair); // AUDIT FIX (pass-8): GOV-INT-01 / C8

        // Balance-diff for FoT tokens (same pattern as SwapFeeRouter)
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balBefore;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
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
        // AUDIT R014 H-4 (HIGH): defense in depth. By construction
        // `epochs.length` is always the LIVE (un-finalized) bucket because
        // `epochBribesFinalized[N]` is set inside `advanceEpoch()` for the
        // index that EQUALS `epochs.length` BEFORE the push, and `epochs.length`
        // increments atomically inside the same call. So this require can only
        // trigger if a future refactor changes the deposit-target derivation;
        // surfacing the invariant explicitly prevents that class of bug.
        require(!epochBribesFinalized[epoch], "EPOCH_FINALIZED");

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
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (epochBribeFirstDeposit[epoch] == 0) {
            epochBribeFirstDeposit[epoch] = block.timestamp;
        }
        // AUDIT NEW-G2: track per-depositor amount + latest deposit timestamp so orphan
        // refunds go back to the original depositor, keyed off the freshest activity.
        bribeDeposits[epoch][pair][token][msg.sender] += netBribe;
        epochBribeLastDeposit[epoch] = block.timestamp;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = block.timestamp; // BATCH-N2 M12
        // AUDIT FIX (pass-8) Phase 1.6 — flag depositor so the same address cannot
        // claim ANY token on this (epoch, pair). See `SelfBribeClaimForbidden` natspec.
        depositedOnPair[msg.sender][epoch][pair] = true;

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
        _requireGaugedPair(pair); // AUDIT FIX (pass-8): GOV-INT-01 / C8

        // Take bribe fee
        uint256 fee = (msg.value * bribeFeeBps) / BPS;
        uint256 netBribe = msg.value - fee;

        // H-03 FIX: Accumulate treasury fees (pull pattern) to prevent DoS if treasury rejects ETH
        if (fee > 0) {
            accumulatedTreasuryETH += fee;
        }

        // Current epoch = epochs.length
        uint256 epoch = epochs.length;
        // AUDIT R014 H-4 (HIGH): same defense-in-depth guard as depositBribe.
        require(!epochBribesFinalized[epoch], "EPOCH_FINALIZED");

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
        lastBribeDepositPerUser[epoch][pair][address(0)][msg.sender] = block.timestamp; // BATCH-N2 M12
        // AUDIT FIX (pass-8) Phase 1.6 — flag depositor for self-bribe lockout.
        depositedOnPair[msg.sender][epoch][pair] = true;

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
        // AUDIT R014 H-4 (HIGH): refuse to surface the bribe pool until the
        // epoch is finalized. Equivalent to `epoch < epochs.length` today
        // (advance flips both atomically); explicit guard defends future code.
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        if (pair == address(0)) revert InvalidPair();
        // AUDIT FIX: DEEP-GOV-08 — refuse claims for disabled pairs.
        _validatePair(pair);

        // AUDIT FIX (BATCH-H M14): gate claim on post-VOTE_DEADLINE so early
        // claimers cannot over-share against an in-flight `totalGaugeVotes`
        // denominator that grows as more voters cast through the vote window.
        // Pre-fix, an early claimer's share was computed against a smaller
        // totalVotesForPair, then late voters' arrivals reduced their effective
        // share — late claimers saw under-pay or insolvency-fallback.
        // Pattern: Aerodrome gates claim on `nextEpochStart` to ensure the
        // denominator is fully crystallized before any payout flows.
        EpochInfo memory _ep = epochs[epoch];
        uint256 _voteEnd = _ep.usesCommitReveal
            ? revealDeadline(epoch)
            : _ep.timestamp + VOTE_DEADLINE;
        if (block.timestamp <= _voteEnd) revert ClaimWindowNotOpen();

        // V2: Use gauge votes instead of raw voting power
        uint256 userVoteForPair = gaugeVotes[msg.sender][epoch][pair];
        if (userVoteForPair == 0) revert NothingToClaim();

        uint256 totalVotesForPair = totalGaugeVotes[epoch][pair];
        if (totalVotesForPair == 0) revert NothingToClaim();
        // AUDIT FIX (pass-8) Phase 1.6 — minimum aggregate VP gate. Bribers cannot
        // claim their own bond back via a sub-quorum self-vote-and-claim cycle.
        if (totalVotesForPair < MIN_BRIBE_CLAIM_QUORUM) revert BribePoolBelowQuorum();
        // AUDIT FIX (pass-8) Phase 1.6 — depositor-side lockout. Anyone who
        // deposited a bribe on this (epoch, pair) is barred from claiming any
        // token on it; the bond is recoverable via the orphan-rescue path.
        if (depositedOnPair[msg.sender][epoch][pair]) revert SelfBribeClaimForbidden();

        address[] memory tokens = epochBribeTokens[epoch][pair];
        bool anyClaimed = false;

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (claimed[msg.sender][epoch][pair][token]) continue;

            uint256 bribeAmount = epochBribes[epoch][pair][token];
            if (bribeAmount == 0) continue;

            // V2: Share proportional to gauge votes, not raw voting power
            uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
            if (share == 0) {
                // AUDIT FIX: DEEP-GOV-02 — mark claimed AND set anyClaimed even when
                // share rounds to zero, so the writes persist even if EVERY token's
                // share rounds to zero. Pre-fix, the all-zeros case hit the
                // `if (!anyClaimed) revert NothingToClaim();` guard, the EVM rolled
                // back ALL claimed=true writes, and the small voter was forced to
                // re-iterate every epoch — pure gas griefing. Pattern: Aerodrome
                // dustOf forward-carry.
                claimed[msg.sender][epoch][pair][token] = true;
                anyClaimed = true;
                continue;
            }

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
                // SLITHER 2026-05-18: nonReentrant on entrypoint; CEI verified in audit
                // slither-disable-next-line reentrancy-eth
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
        // AUDIT FIX: DEEP-GOV-08 — refuse batch claims for disabled pairs.
        _validatePair(pair);
        if (epochEnd > epochs.length) epochEnd = epochs.length;
        if (epochStart >= epochEnd) revert NothingToClaim();
        if (epochEnd - epochStart > MAX_CLAIM_EPOCHS) revert TooManyUnclaimedEpochs();

        bool anyClaimed = false;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 totalIterations;

        for (uint256 e = epochStart; e < epochEnd; e++) {
            // AUDIT R014 H-4: skip un-finalized epochs (defensive — today
            // `e < epochEnd <= epochs.length` already guarantees finalization,
            // but mirroring the single-epoch guard makes the invariant local).
            if (!epochBribesFinalized[e]) continue;

            // V2: Use gauge votes instead of raw voting power
            uint256 userVoteForPair = gaugeVotes[msg.sender][e][pair];
            if (userVoteForPair == 0) continue;

            uint256 totalVotesForPair = totalGaugeVotes[e][pair];
            if (totalVotesForPair == 0) continue;
            // AUDIT FIX (pass-8) Phase 1.6 — same gates as `claimBribes`. We `continue`
            // (skip the epoch) instead of revert because batch claim spans multiple
            // epochs; a sub-quorum or self-bribe match on one epoch shouldn't unwind
            // the entire batch when other epochs have legitimate claims.
            if (totalVotesForPair < MIN_BRIBE_CLAIM_QUORUM) continue;
            if (depositedOnPair[msg.sender][e][pair]) continue;

            address[] memory tokens = epochBribeTokens[e][pair];

            for (uint256 i = 0; i < tokens.length; i++) {
                address token = tokens[i];
                if (claimed[msg.sender][e][pair][token]) continue;

                uint256 bribeAmount = epochBribes[e][pair][token];
                if (bribeAmount == 0) continue;

                // V2: Share proportional to gauge votes
                uint256 share = (bribeAmount * userVoteForPair) / totalVotesForPair;
                if (share == 0) {
                    // AUDIT FIX: DEEP-GOV-02 — mirror M-G5 in batch path so small voters
                    // aren't gas-griefed. Mark claimed and set anyClaimed when share
                    // rounds to zero so the writes persist.
                    claimed[msg.sender][e][pair][token] = true;
                    anyClaimed = true;
                    continue;
                }

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
                    // SLITHER 2026-05-18: nonReentrant on entrypoint; CEI verified in audit
                    // slither-disable-next-line reentrancy-eth
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
        // AUDIT R014 H-4: hide pending pools from the preview view too.
        // Front-end / aggregators relying on `claimable()` should only ever see
        // confirmed snapshots — never the live MEV-able bucket.
        if (!epochBribesFinalized[epoch]) return (new address[](0), new uint256[](0));

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

    /// @notice AUDIT R014 H-4 (HIGH): canonical "confirmed snapshot" view of an
    ///         epoch's bribe pool. Returns 0 for un-finalized epochs (the live
    ///         bucket); returns the finalized post-snapshot amount for past
    ///         epochs. Voters / aggregators / claim simulations should call
    ///         this rather than reading the raw `epochBribes` mapping, which
    ///         exposes the MEV-able pending bucket.
    function confirmedEpochBribes(
        uint256 epoch,
        address pair,
        address token
    ) external view returns (uint256) {
        if (epoch >= epochs.length) return 0;
        if (!epochBribesFinalized[epoch]) return 0;
        return epochBribes[epoch][pair][token];
    }

    /// @notice Get all bribe tokens for a given epoch and pair.
    function getEpochBribeTokens(uint256 epoch, address pair) external view returns (address[] memory) {
        return epochBribeTokens[epoch][pair];
    }

    /// @notice Get the list of all whitelisted tokens.
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokenList;
    }

    // ─── Admin: applyXxx setters (called by VoteIncentivesAdmin) ─────
    // AUDIT FIX (pass-8): EIP170-03 — propose/execute/cancel triplets and
    // pending state moved to VoteIncentivesAdmin. Validation rules are
    // re-checked here as defense in depth.

    function applyFeeChange(uint256 newFee) external onlyAdmin {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        require(newFee > 0, "FEE_CANNOT_BE_ZERO"); // M-08 FIX preserved
        uint256 old = bribeFeeBps;
        bribeFeeBps = newFee;
        emit FeeUpdated(old, newFee);
    }

    function applyTreasuryChange(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    function applyWhitelistChange(address token, bool add) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
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

    // ─── Admin: Pause ────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice One-shot wire of the TegridyRestaking contract address.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10. Without this, voters who
    ///         restake their staking NFT have `votingEscrow.votingPower*` return
    ///         0 and silently lose ALL bribe-vote power. Mirrors `setSequencerFeed`
    ///         one-shot pattern.
    function setRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        if (restakingContract != address(0)) revert RestakingAlreadySet();
        restakingContract = _restaking;
        emit RestakingContractSet(_restaking);
    }

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
        // AUDIT FIX (BATCH-N2 M12): per-depositor rescue clock. Pre-fix used
        // shared `epochBribeLastDeposit[epoch]` which let an attacker dust-deposit
        // to extend the rescue clock for ALL depositors in the epoch. Now MY
        // rescue window opens 30d after MY last deposit only.
        uint256 lastDeposit = lastBribeDepositPerUser[epoch][pair][token][msg.sender];
        require(lastDeposit != 0, "NO_BRIBES_IN_EPOCH");
        require(block.timestamp >= lastDeposit + BRIBE_RESCUE_DELAY, "RESCUE_TOO_EARLY");

        uint256 amount = bribeDeposits[epoch][pair][token][msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");

        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = 0; // BATCH-N2 M12 cleanup
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
        // AUDIT R014 H-4: refunds operate on confirmed (post-snapshot) bribe
        // pools; refuse if the epoch was somehow not finalized.
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        require(totalGaugeVotes[epoch][pair] == 0, "PAIR_HAS_VOTES");
        // AUDIT R014 M-6: deadline branches on the epoch's voting model. Legacy
        // (plain `vote()`) epochs gate on `epoch.timestamp + VOTE_DEADLINE`;
        // commit-reveal epochs gate on `revealDeadline(epoch)`. Today both
        // expressions equal `timestamp + VOTE_DEADLINE` so the explicit branch
        // is a no-op — but keeping `revealDeadline` and `VOTE_DEADLINE` decoupled
        // means a future change that lengthens the reveal window (e.g., to
        // accommodate hardware-wallet reveal cadence) won't accidentally let
        // depositors yank legacy-epoch bribes early.
        EpochInfo memory ep = epochs[epoch];
        uint256 voteEnd = ep.usesCommitReveal
            ? revealDeadline(epoch)
            : ep.timestamp + VOTE_DEADLINE;
        require(block.timestamp >= voteEnd + UNVOTED_REFUND_GRACE, "GRACE_NOT_ELAPSED");

        uint256 amount = bribeDeposits[epoch][pair][token][msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");

        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = 0; // BATCH-N2 M12 cleanup
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

    // ─── AUDIT FIX (BATCH-A C1): SUB-QUORUM BRIBE REFUND ───────────────
    /// @notice AUDIT FIX (BATCH-A C1, Hidden Hand BribeVault per-depositor pattern):
    ///         Closes the THREE-WAY REJECT TRAP discovered by the 100-agent audit.
    ///         When `0 < totalGaugeVotes[epoch][pair] < MIN_BRIBE_CLAIM_QUORUM`:
    ///         (a) `claimBribes` reverts `BribePoolBelowQuorum` — voters cannot pull;
    ///         (b) `refundOrphanedBribe` reverts because epoch IS finalized;
    ///         (c) `refundUnvotedBribe` reverts because votes != 0.
    ///         Result: the bribe is permanently locked. This refund path lets the
    ///         original depositor recover after the same `UNVOTED_REFUND_GRACE` window
    ///         applied to refundUnvotedBribe — symmetric and trustless.
    ///
    ///         Pattern: per-depositor `bribeDeposits[e][p][t][msg.sender]` is the
    ///         already-tracked ledger (per-depositor accounting was added pre-launch
    ///         specifically to enable this class of recovery, mirroring the per-deposit
    ///         struct that Hidden Hand v2 BribeVault uses for its multi-year-live
    ///         `emergencyWithdraw`-equivalent recovery — but trustless here, no admin
    ///         multisig in the loop).
    ///
    ///         Velodrome v2 / Aerodrome / Curve BribeV2 LACK this path entirely
    ///         (Code4rena 2022 #168 documents the stranded-bribe outcome on Velodrome) —
    ///         every production bribe market either accepts the loss or relies on
    ///         off-chain admin reimbursement. We add the trustless on-chain recovery.
    /// @dev    Atomicity: same CEI ordering as refundUnvotedBribe (state cleared
    ///         before transfer); 14d grace prevents racing legitimate late voters
    ///         and dust-pump griefs.
    /// @dev    Voters who voted on a sub-quorum pair CANNOT recover their voting
    ///         allocation through this path — the bribe-side refund does not affect
    ///         the gauge-controller-side accounting (commit bond is its own track).
    ///         This matches refundUnvotedBribe's symmetric scope.
    event SubQuorumBribeRefunded(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount);

    function refundSubQuorumBribe(uint256 epoch, address pair, address token) external nonReentrant {
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        // STRICTLY SUB-QUORUM: 0 < votes < MIN_BRIBE_CLAIM_QUORUM. The == 0 case is
        // owned by refundUnvotedBribe (semantic separation preserved); the >= quorum
        // case is owned by claimBribes. This branch is the third leg that closes
        // the 100-agent-audited C1 trap.
        uint256 totalVotes = totalGaugeVotes[epoch][pair];
        require(totalVotes > 0 && totalVotes < MIN_BRIBE_CLAIM_QUORUM, "NOT_SUB_QUORUM");

        EpochInfo memory ep = epochs[epoch];
        uint256 voteEnd = ep.usesCommitReveal
            ? revealDeadline(epoch)
            : ep.timestamp + VOTE_DEADLINE;
        require(block.timestamp >= voteEnd + UNVOTED_REFUND_GRACE, "GRACE_NOT_ELAPSED");

        uint256 amount = bribeDeposits[epoch][pair][token][msg.sender];
        require(amount > 0, "NOTHING_TO_REFUND");

        // CEI: clear depositor record + total ledger BEFORE outbound transfer.
        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = 0; // BATCH-N2 M12 cleanup
        uint256 remaining = epochBribes[epoch][pair][token];
        epochBribes[epoch][pair][token] = remaining > amount ? remaining - amount : 0;

        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > amount ? totalUnclaimedETHBribes - amount : 0;
            WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > amount ? totalUnclaimedBribes[token] - amount : 0;
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit SubQuorumBribeRefunded(epoch, pair, token, msg.sender, amount);
    }

    // ─── AUDIT R020 H-3: per-token min-bribe configuration (timelocked) ───
    // AUDIT FIX (pass-8): EIP170-03 — propose/execute/cancel + Proposed/Cancelled
    // events moved to VoteIncentivesAdmin.

    event MinBribeAmountChangeExecuted(address indexed token, uint256 oldAmount, uint256 newAmount);

    /// AUDIT FIX (BATCH-H M13): cap at 1e24 (1M tokens with 18 decimals).
    /// Pre-fix, captured admin could set min to type(uint256).max → DoS all
    /// future deposits of that token until next 24h propose/execute cycle.
    /// Aave V3 reserve params have analogous on-chain sanity bounds.
    uint256 public constant MAX_MIN_BRIBE_AMOUNT = 1e24;

    function applyMinBribeAmountChange(address token, uint256 amount) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        if (amount > MAX_MIN_BRIBE_AMOUNT) revert ZeroAmount(); // BATCH-H M13: reuse existing error
        uint256 oldAmount = minBribeAmounts[token];
        minBribeAmounts[token] = amount;
        emit MinBribeAmountChangeExecuted(token, oldAmount, amount);
    }

    /// @notice AUDIT NEW-G3: permanently-locked rounding dust for a given
    ///         (epoch, pair, token). dust = epochBribes - totalClaimedBribes.
    ///         This is sum-of-voter-shares floor-rounding; it is NOT sweep-able.
    ///         Exposed for observability only.
    function dustOf(uint256 epoch, address pair, address token) external view returns (uint256) {
        // AUDIT R014 H-4: dust is only meaningful AFTER an epoch is finalized;
        // the live (un-snapshotted) bucket has no claim accounting yet.
        if (epoch >= epochs.length || !epochBribesFinalized[epoch]) return 0;
        uint256 deposited = epochBribes[epoch][pair][token];
        uint256 paidOut = totalClaimedBribes[epoch][pair][token];
        return deposited > paidOut ? deposited - paidOut : 0;
    }

    // ─── Admin: Emergency Sweep ──────────────────────────────────────

    /// @notice Sweep stuck ETH beyond what's owed to claimers and active bribes.
    ///         Reserves: unclaimed ETH bribes + pending pull-pattern withdrawals + accumulated treasury fees.
    /// @dev    AUDIT FIX: DEEP-GOV-15 — use WETHFallbackLib stipend transfer instead
    ///         of unbounded `.call`. Pre-fix, the raw call forwarded all gas to the
    ///         treasury, and a contract treasury could re-enter sibling protocol
    ///         contracts (RevenueDistributor, GaugeController, MemeBountyBoard) that
    ///         do not share VoteIncentives' nonReentrant lock. The 10k stipend is
    ///         enough for receive() + event emit but not arbitrary external calls,
    ///         and the WETH fallback ensures contract treasuries with heavier
    ///         receive() logic still get paid (as WETH instead of ETH).
    function sweepExcessETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        uint256 reserved = totalUnclaimedETHBribes + totalPendingETH + accumulatedTreasuryETH;
        uint256 sweepable = balance > reserved ? balance - reserved : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (sweepable == 0) revert ZeroAmount();
        WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, sweepable);
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
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
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
    /// @dev AUDIT R016 M-1 (MEDIUM): also rejects pairs the factory has disabled
    ///      (timelocked governance disable OR guardian emergency disable). Without
    ///      this gate a briber could waste TOWELI / ETH on a pair that voters can no
    ///      longer route swaps through — the bribes would sit in the contract until
    ///      sweep, and any voter who allocates power to the disabled pair burns
    ///      voting weight that would otherwise have gone to a live pair. Mirrors the
    ///      same disabled-pair gate already in TegridyPair.swap() (line 201) and
    ///      TegridyRouter._pairFor (line 455).
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
        // AUDIT R016 M-1: refuse disabled pairs.
        if (factory.disabledPairs(pair)) revert PairDisabled();
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
    /// @notice Commit a vote — phase 1 of commit-reveal.
    /// @dev    AUDIT FIX: MICROSCOPE C2 / DEEP-GOV — voter declares the `power`
    ///         they're committing at commit time so the contract can enforce
    ///         `sum(committedPower[user][epoch]) <= userPower`. Reveal MUST use
    ///         the same power (it's part of the hash) — declaring it here lets
    ///         us cap the multi-commit options-arbitrage primitive without
    ///         needing to reveal which pair was chosen.
    function commitVote(uint256 epoch, bytes32 commitHash, uint256 power) external nonReentrant whenNotPaused returns (uint256 commitIndex) {
        if (epoch >= epochs.length) revert InvalidEpoch();
        // AUDIT R014 H-4: refuse commits against epochs whose bribe ledger isn't
        // finalized. Equivalent today to `epoch < epochs.length`.
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();
        if (block.timestamp <= ep.timestamp) revert CommitWindowNotOpen();
        if (block.timestamp > commitDeadline(epoch)) revert CommitDeadlinePassed();
        if (power == 0) revert ZeroAmount();

        // AUDIT FIX: MICROSCOPE C2 — `committedPower` cap closes the multi-commit
        // options-arbitrage primitive (10-TOWELI bond was trivially cheap relative
        // to bribe value when a voter could commit hashes for every candidate pair
        // and reveal only the most lucrative subset). The cap also subsumes the
        // DEEP-GOV-01 min-clamp by anchoring the comparison against the smaller of
        // the two voting-power figures.
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additive read across staking + restaking.
        uint256 historical = VotePowerOracle.powerAt(
            msg.sender, ep.timestamp, address(votingEscrow), restakingContract
        );
        uint256 current = VotePowerOracle.powerOf(msg.sender, address(votingEscrow), restakingContract);
        uint256 userPower = historical < current ? historical : current;
        if (userPower == 0) revert NothingToClaim();
        require(committedPower[msg.sender][epoch] + power <= userPower, "EXCEEDS_POWER");
        committedPower[msg.sender][epoch] += power;

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
        // AUDIT R014 H-4: refuse reveals against epochs whose bribe ledger
        // isn't finalized. Equivalent today to `epoch < epochs.length`.
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
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
        // AUDIT FIX: DEEP-GOV-08 — refuse reveals for disabled pairs. Voters who
        // committed pre-disable can simply abandon the commit (forfeiting bond) —
        // applying votes to a dead pair would lock out their `userTotalVotes`
        // allocation on a pair they cannot route swaps through.
        _validatePair(pair);

        // AUDIT FIX: V2-GOV-10 — at reveal time, cap against `committedPower`
        // (the sum of declared commit-time powers, already capped at
        // `min(historical, current)` AT COMMIT TIME via the C2 fix), NOT against
        // a freshly-resampled `min(historical, current)`. Pre-fix, the reveal
        // cap was the dynamic min-clamp, so a voter who divested between commit
        // and reveal would fail the reveal even though their commit was valid at
        // commit time — losing both bond and slot. Anchoring on
        // `committedPower` keeps commit-time and reveal-time semantics consistent
        // (Compound Bravo `castVote` snapshots `getPriorVotes` once per proposal,
        // used everywhere downstream). The post-divest power-leak risk is bounded
        // because the C2 cap was already applied at commit time — voter cannot
        // reveal more than they declared.
        // AUDIT FIX: DEEP-GOV-01 — historical clamp at COMMIT time (via
        // committedPower) is preserved; this is purely a consistency fix on the
        // reveal-side cap source.
        uint256 cap = committedPower[msg.sender][epoch];
        if (cap == 0) revert NothingToClaim();
        require(userTotalVotes[msg.sender][epoch] + power <= cap, "EXCEEDS_POWER");

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

    /// @notice AUDIT FIX: V2-GOV-01 + V2-GOV-02 — escape path for voters whose committed
    ///         pair is currently disabled. Handles two cases uniformly:
    ///           (a) V2-GOV-01: pair was live at commit time and was disabled by the
    ///               factory before the reveal window — without this path the
    ///               monotonic `committedPower` cap combined with `_validatePair` at
    ///               reveal-time produced a permanent epoch-scoped lockup (user could
    ///               neither reveal nor commit again, AND lost the bond on sweep).
    ///           (b) V2-GOV-02: pair was already disabled when the user (or a
    ///               malicious tx-builder) committed. `commitVote` cannot validate
    ///               the hashed pair, so the bad commit was accepted; this path lets
    ///               the voter unwind it BEFORE the sweep deadline so they recover
    ///               both bond AND committedPower for fresh commits.
    ///         Voter proves the commit's preimage, contract decrements
    ///         `committedPower`, refunds the bond, and marks the slot revealed (no
    ///         double-claim). Callable any time between commit and the bond-sweep
    ///         deadline. Permissionless caller (a keeper could unwind on the
    ///         voter's behalf), but the bond + power refund always go to the
    ///         original committer (`user`).
    /// @param user        Voter who placed the commit (also recipient of the bond refund).
    /// @param epoch       Commit-reveal epoch index.
    /// @param commitIndex Index returned by commitVote.
    /// @param pair        Pair the commit was for (validated against the hash).
    /// @param power       Voting power declared at commit (validated against the hash).
    /// @param salt        Salt used at commit time (validated against the hash).
    function forfeitCommitOnDisabledPair(
        address user,
        uint256 epoch,
        uint256 commitIndex,
        address pair,
        uint256 power,
        bytes32 salt
    ) external nonReentrant whenNotPaused {
        // AUDIT FIX G-01 (Governance Medium): restrict to the commit owner OR
        // the contract owner. Pre-fix any caller could destroy a victim's
        // commit during a transient pair disable: attacker iterates VoteCommitted
        // events for the disabled pair, force-forfeits each, then the factory
        // re-enables — victims' commits are permanently revealed/zeroed even
        // though the pair is live again. The bond was refunded but the VOTE
        // is destroyed (slot marked revealed with no impact). The owner branch
        // is preserved as an admin escape for users who can't transact (e.g.
        // SCW signer key lost) but want their bond + commit clawed out.
        if (msg.sender != user && msg.sender != owner()) revert Unauthorized();

        if (epoch >= epochs.length) revert InvalidEpoch();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();

        CommitInfo[] storage commits = voterCommits[user][epoch];
        if (commitIndex >= commits.length) revert CommitNotFound();
        CommitInfo storage c = commits[commitIndex];
        if (c.revealed) revert AlreadyRevealed();

        // Validate the (pair, power, salt) match the committed hash. This is the
        // proof that the caller is unwinding THIS commit and not a different one.
        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();
        bytes32 expected = computeCommitHash(user, epoch, pair, power, salt);
        if (expected != c.commitHash) revert CommitHashMismatch();

        // Refuse the escape path if the pair is still live. Voters can't bail out
        // of a live commit just because they've changed their minds — the normal
        // reveal/sweep windows govern that case.
        if (!factory.disabledPairs(pair)) revert PairNotDisabled();

        // CEI: state first, transfer last. Mark revealed (no double-claim) AND zero
        // the bond before the external transfer.
        c.revealed = true;
        uint96 bond = c.bond;
        c.bond = 0;

        // Decrement committedPower so the voter is no longer locked out of further
        // commits this epoch (the central point of the fix).
        if (committedPower[user][epoch] >= power) {
            committedPower[user][epoch] -= power;
        } else {
            // Defensive: if accounting somehow drifted, clear to zero rather than
            // underflow. Cannot happen under current logic — committedPower only
            // ever increases by `power` at commit time.
            committedPower[user][epoch] = 0;
        }

        emit CommitForfeitedOnDisabledPair(user, epoch, commitIndex, pair, power, bond);

        if (bond > 0) {
            if (totalCommitBonds >= bond) {
                totalCommitBonds -= bond;
            }
            // Refund (not forfeit) — voter is being kicked off through no fault of
            // their own, so they get the bond back.
            toweli.safeTransfer(user, bond);
            emit BondRefunded(user, epoch, commitIndex, bond);
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
    // AUDIT FIX (pass-8): EIP170-03 — propose/execute/cancel + Proposed/Cancelled
    // events for commit-reveal enable moved to VoteIncentivesAdmin.

    function applyEnableCommitReveal() external onlyAdmin {
        if (commitRevealEnabled) return; // idempotent (mirrors pre-split semantic)
        commitRevealEnabled = true;
        emit CommitRevealEnabled(true);
    }

    /// @notice DEPRECATED: use the propose/execute flow above. Retained as a
    ///         descriptive revert so any tooling calling the old signature fails
    ///         loudly instead of silently no-op'ing.
    /// @dev    AUDIT L-2 (2026-04-28): mutability changed from `view` to plain
    ///         non-payable (a `view` `onlyOwner` function is unusual style — the
    ///         owner-check itself is a state-affecting concept), and the string
    ///         revert is replaced with a typed `UseProposeEnableCommitReveal`
    ///         error matching the rest of this contract's error convention.
    ///         Selector is preserved for ABI compatibility.
    function enableCommitReveal() external onlyOwner {
        revert UseProposeEnableCommitReveal();
    }
}
