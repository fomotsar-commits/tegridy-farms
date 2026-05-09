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
// AUDIT FIX FRESH-2026: F-69-1 — sequencer-buffer extension on vote-end and
// reveal-deadline windows so an L2 outage doesn't cause honest committers to
// lose bond + vote application to a window that elapsed entirely while the
// chain was offline. Mirrors the MemeBountyBoard R062 pattern.
import {SequencerCheck} from "./lib/SequencerCheck.sol";

/// @dev Interface for TegridyStaking (voting escrow) — Curve-style checkpoint queries.
///      Same interface as RevenueDistributor uses.
interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    /// @dev AUDIT FIX FRESH-2026: F-65-3 — historical denominator pin for `advanceEpoch`,
    ///      mirrors the RevenueDistributor pattern (RevenueDistributor.sol:472).
    function totalBoostedStakeAtTimestamp(uint256 ts) external view returns (uint256);
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
        if (_gaugeController.code.length == 0) revert MustBeContract();
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
        if (_admin.code.length == 0) revert MustBeContract();
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

    /// @notice AUDIT FIX FRESH-2026: F-77-5 + F-69-3 + F-93-3 — minimum number
    ///         of distinct briber addresses required for a (epoch, pair)
    ///         bribe pool to be claimable by voters. Forces sybil bribers to
    ///         coordinate at least one independent counterparty before they
    ///         can self-bribe-and-vote-claim, raising the practical cost of
    ///         the wallet-rotation arb.
    /// @dev    Tracked via `bribeDepositorCount[epoch][pair]` (incremented on
    ///         the first deposit for each new (depositor, epoch, pair)).
    ///         Voters' claim path reverts `BribePoolNeedsMoreBribers` until
    ///         the count clears the floor. Bond is still recoverable via the
    ///         existing refund paths.
    uint256 public constant MIN_BRIBE_CLAIM_QUORUM_PER_BRIBER = 2;

    /// @notice AUDIT FIX FRESH-2026: F-77-3 — cooldown between
    ///         `lastBribeDepositTime` and a permissionless `advanceEpoch`
    ///         call. Forces a 1-hour gap between the latest bribe deposit
    ///         landing in the live bucket and the snapshot, blocking
    ///         atomic same-block deposit→advance sequences that route the
    ///         briber's payload directly into the just-frozen bucket.
    ///         Combined with F-77-1's `epoch + 1` indexing, this closes the
    ///         briber-front-runs-advanceEpoch arbitrage entirely.
    uint256 public constant ADVANCE_EPOCH_DEPOSIT_COOLDOWN = 1 hours;

    /// @notice AUDIT FIX FRESH-2026: F-69-1 — Aave V3-style 1h grace window
    ///         applied to the reveal-deadline / vote-end gates so an L2
    ///         sequencer outage doesn't cost an honest committer their
    ///         bond + vote application to a window that elapsed entirely
    ///         while the chain was offline.
    uint256 public constant SEQUENCER_OUTAGE_BUFFER = 1 hours;

    /// @notice AUDIT FIX FRESH-2026: F-61-4 — admin-only "sweepEpochDust"
    ///         lockout window. After this delay past the epoch's vote-end,
    ///         the (deposited - claimed) dust on a (epoch, pair, token)
    ///         triple is sweepable to treasury. Set conservatively to 1
    ///         year so all reasonable claim paths have closed and all
    ///         trustless refund grace windows have long elapsed (the
    ///         max grace is 14d; the orphan-rescue 30d; this window is ~12x
    ///         the worst case to leave generous slack for stuck claims).
    uint256 public constant EPOCH_DUST_SWEEP_DELAY = 365 days;

    /// @notice AUDIT FIX FRESH-2026: F-10-K-04 + M-11 — keeper bounty paid
    ///         in TOWELI on each successful `advanceEpoch` so an honest
    ///         keeper has a non-zero incentive to call the function on
    ///         schedule. 10 BPS of `MIN_DISTRIBUTE_STAKE` (= 1 TOWELI) is
    ///         the smallest amount that is meaningfully above gas-cost on
    ///         L2 without becoming a meaningful drain on the protocol.
    ///         Funded from the contract's accumulated TOWELI balance
    ///         (commit-bond residual / sweep tokens) — `sweepToken(toweli)`
    ///         continues to reserve the live `totalCommitBonds` so the
    ///         bounty cannot drain pending-reveal bonds.
    uint256 public constant ADVANCE_EPOCH_BOUNTY = 1e18;

    // ─── Immutables ──────────────────────────────────────────────────
    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;
    ITegridyFactory public immutable factory;

    /// @notice AUDIT FIX FRESH-2026: F-69-1 — Chainlink L2 Sequencer Uptime
    ///         feed. `address(0)` on mainnet / non-L2 (no-op).
    address public immutable sequencerFeed;

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
    /// @dev    AUDIT FIX FRESH-2026: F-77-2 — visibility lowered to `internal`. The
    ///         public auto-getter previously leaked aggregate-VP-by-address signal
    ///         during the 2.8d commit window; bribers could read declared power
    ///         per-whale and time their deposits to lean on the most-engaged
    ///         pairs. The committedPower slot is also CLEARED on reveal /
    ///         forfeit / sweep so post-window forensics on `committedPower`
    ///         no longer leak vote-direction telemetry. Off-chain dashboards
    ///         that need a per-user remaining-budget figure should derive it
    ///         from `userTotalVotes` (which is already publicly observable
    ///         post-reveal — that's the on-chain vote, not the signal).
    mapping(address => mapping(uint256 => uint256)) internal committedPower;
    /// @notice AUDIT FIX FRESH-2026: F-77-2 — explicit getter that returns 0
    ///         until the reveal window opens, so the leak window narrows to
    ///         the legitimately-public reveal phase. View-side defense in
    ///         depth on top of the storage-cleared-on-reveal pattern.
    function committedPowerOf(address user, uint256 epoch) external view returns (uint256) {
        if (epoch >= epochs.length) return 0;
        EpochInfo memory _ep = epochs[epoch];
        // Pre-reveal window: hide the per-user committed signal. The
        // contract STILL enforces the cap in `commitVote` reading the
        // internal slot directly; only off-chain observers are gated.
        if (block.timestamp <= commitDeadline(epoch)) return 0;
        // Suppress unused-variable warning for `_ep` (kept for future
        // per-epoch gating logic — e.g., delaying the reveal-time leak
        // by an additional buffer).
        _ep;
        return committedPower[user][epoch];
    }

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

    // AUDIT FIX FRESH-2026: F-10-K-11 — `epochBribeFirstDeposit` mapping
    // removed (was: per-epoch first-deposit timestamp; replaced pre-launch
    // by per-depositor `lastBribeDepositPerUser` for the orphan-rescue
    // clock under NEW-G2). Removing the dead storage saves one cold SSTORE
    // (~22k gas) on the FIRST deposit per epoch.
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

    /// @notice AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — captured at
    ///         epoch advance (= epoch finalize). Reads `factory.disabledPairs`
    ///         only at this snapshot moment so a pair-disable event landing
    ///         AFTER the snapshot does NOT retroactively brick claim/refund
    ///         on already-deposited bribes. Voter-facing read paths consult
    ///         THIS frozen state, not the live factory flag.
    /// @dev    Defaults to false (= "live at snapshot" for any pair the
    ///         factory considers active). Pair-disabled-at-snapshot is set
    ///         lazily on first read since iterating ALL pairs at advance is
    ///         a gas bomb; we infer it via `factory.disabledPairs(pair)` on
    ///         deposit (already gated upstream) and capture the snapshot
    ///         per-pair on first claim/refund touch (read-then-cache).
    mapping(uint256 => mapping(address => bool)) public epochSnapshotPairLive;
    /// @notice AUDIT FIX FRESH-2026: H-4 + F-11-1 — sentinel that distinguishes
    ///         "never read" from "read and pair was live". Without this, the
    ///         lazy-cache pattern can't differentiate the default-false from
    ///         a confirmed-live snapshot.
    mapping(uint256 => mapping(address => bool)) public epochSnapshotPairChecked;

    /// @notice AUDIT FIX FRESH-2026: M-10 / F-10-K-03 — frozen
    ///         `totalGaugeVotes[epoch][pair]` at vote-end. Pre-fix the
    ///         refund paths read live `totalGaugeVotes` post-vote-end; if
    ///         a future change ever made vote-deadline mutable, the
    ///         claim-time and refund-time denominators could drift.
    ///         Lazily filled on first claim/refund touch past `voteEnd`.
    mapping(uint256 => mapping(address => uint256)) public epochVoteCountFinal;
    mapping(uint256 => mapping(address => bool)) public epochVoteCountFinalSet;

    /// @notice AUDIT FIX FRESH-2026: F-77-5 + F-69-3 + F-93-3 — distinct briber
    ///         counter per (epoch, pair). Incremented on the first deposit by
    ///         each new (depositor, epoch, pair). Voters' claim path requires
    ///         `bribeDepositorCount[epoch][pair] >= MIN_BRIBE_CLAIM_QUORUM_PER_BRIBER`.
    mapping(uint256 => mapping(address => uint256)) public bribeDepositorCount;

    /// @notice AUDIT FIX FRESH-2026: F-10-K-05 — replacement of the bool
    ///         `depositedOnPair` flag with a counter so refund paths can
    ///         decrement on full-refund and the lockout is released only
    ///         when the depositor has no remaining live deposits on the
    ///         (epoch, pair). The legacy `depositedOnPair` mapping above is
    ///         kept as a derived view (`depositCountOnPair > 0`) for
    ///         backward-compatible read access from off-chain dashboards.
    mapping(address => mapping(uint256 => mapping(address => uint256))) public depositCountOnPair;

    /// @notice AUDIT FIX FRESH-2026: F-77-3 — timestamp of the latest bribe
    ///         deposit landing in the LIVE bucket. Read by `advanceEpoch`
    ///         to enforce the post-deposit cooldown.
    uint256 public lastBribeDepositTime;

    /// @notice AUDIT FIX FRESH-2026: F-77-3 — timestamp of the latest
    ///         `advanceEpoch` call. Read by `advanceEpoch` to enforce the
    ///         1h cooldown between consecutive permissionless triggers
    ///         (separate from MIN_EPOCH_INTERVAL which gates the cadence).
    uint256 public lastEpochAdvanceTime;

    /// @notice AUDIT FIX FRESH-2026: F-77-1 — bribe deposits route to the
    ///         next epoch (= `epochs.length + 1` as captured at deposit
    ///         time). Aerodrome `BribeVotingReward.notifyRewardAmount`
    ///         pattern: voters in epoch `n` see ONLY bribes deposited
    ///         during epoch `n - 1`'s window, eliminating the "deposit
    ///         AFTER seeing commits" arb. Voters reading
    ///         `epochBribes[e][p][t]` for the current `e` see the FROZEN
    ///         pool deposited during `e - 1`'s deposit window — never the
    ///         in-flight live bucket.
    /// @dev    In-flight live bucket is `epochs.length` (= the next epoch
    ///         index that will be pushed by `advanceEpoch`). Bribes
    ///         depositing now target `epochs.length + 1`. After
    ///         `advanceEpoch` pushes the new epoch, the old live bucket
    ///         (`epochs.length` pre-push) becomes the freshly-finalized
    ///         epoch index. No bribe is ever in the same bucket as voters
    ///         who could see the deposit before committing.
    /// @dev    Documentation marker — the actual deposit-target derivation
    ///         is computed inline in `depositBribe` / `depositBribeETH`.
    bool private constant _BRIBE_LAGS_ONE_EPOCH = true;

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
    // AUDIT FIX FRESH-2026 (size optimization): `UseProposeEnableCommitReveal`
    // error removed (relaunch — no compat shims; legacy selector removed).
    /// @notice AUDIT FIX: V2-GOV-01 — `forfeitCommitOnDisabledPair` was called against
    ///         a pair that is currently NOT disabled. Refusing here forces voters to
    ///         honour live commits via the normal reveal path.
    error PairNotDisabled();
    /// @notice AUDIT FIX FRESH-2026: F-77-3 — `advanceEpoch` called inside the
    ///         post-deposit cooldown window. Forces a 1h gap between the
    ///         latest bribe deposit and the snapshot, blocking same-block
    ///         deposit→advance arbitrage.
    error AdvanceEpochCooldown();
    /// @notice AUDIT FIX FRESH-2026: F-77-5 + F-69-3 + F-93-3 — bribe pool
    ///         needs at least `MIN_BRIBE_CLAIM_QUORUM_PER_BRIBER` distinct
    ///         briber addresses before voters can claim. Bond is recoverable
    ///         via the existing refund paths.
    error BribePoolNeedsMoreBribers();
    /// @notice AUDIT FIX FRESH-2026: F-61-4 — `sweepEpochDust` called before
    ///         the EPOCH_DUST_SWEEP_DELAY (1 year past the epoch's vote-end)
    ///         elapsed. The trustless refund/claim grace windows must close
    ///         entirely before residual dust becomes sweepable to treasury.
    error DustSweepTooEarly();
    /// @notice AUDIT FIX FRESH-2026: F-11-1 + F-10-K-02 + H-4 — pair was live
    ///         at epoch snapshot but has since been disabled by the factory.
    error PairDisabledAfterSnapshot();
    // AUDIT FIX FRESH-2026 (size opt): typed-error replacements for string require()s.
    error MustBeContract();
    error ExceedsPower();
    error BribeTooSmall();
    error TooManyIterations();
    error FeeIsZero();
    error NoFees();
    error EpochAlreadySnapshotted();
    error NoBribesInEpoch();
    error RescueTooEarly();
    error PairHasVotes();
    error GraceNotElapsed();
    error NotSubQuorum();
    error OnlySelf();
    error NothingToRefund();
    error EpochAlreadyFinalized();

    // AUDIT FIX (pass-8): EIP170-03 — view-helpers (`feeChangeTime`,
    // `treasuryChangeTime`, `whitelistChangeTime`, `minBribeChangeTime`,
    // `commitRevealEnableTime`) moved to VoteIncentivesAdmin alongside the
    // propose/execute/cancel functions whose readiness they exposed.

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param _sequencerFeed AUDIT FIX FRESH-2026: F-69-1 — Chainlink L2
    ///        Sequencer Uptime feed. Pass `address(0)` for mainnet / non-L2
    ///        (no-op). The `SequencerCheck` lib will revert
    ///        `SequencerFeedNotConfigured` on any non-mainnet chain that
    ///        ships with `address(0)`, so deploys can't accidentally turn
    ///        the protection off.
    constructor(
        address _votingEscrow,
        address _treasury,
        address _weth,
        address _factory,
        address _toweli,
        address _sequencerFeed,
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
        // AUDIT FIX FRESH-2026: F-69-1 — sequencer feed pinned at deploy.
        // Zero permitted here; the lib enforces the non-zero invariant on
        // any non-mainnet chainid at first call.
        sequencerFeed = _sequencerFeed;
    }

    // ─── Epoch Management ────────────────────────────────────────────

    /// @notice Advance to a new epoch. Permissionless — anyone can call.
    ///         Snapshots totalBoostedStake at block.timestamp - 1 (same as RevenueDistributor).
    /// @dev    AUDIT FIX FRESH-2026: F-77-3 + F-65-3 + F-10-K-04 + M-11 —
    ///         (1) post-deposit cooldown blocks atomic deposit→advance,
    ///         (2) historical denominator pin (`totalBoostedStakeAtTimestamp`)
    ///             matches RevenueDistributor numerator/denominator timestamp,
    ///         (3) keeper bounty paid in TOWELI on success so honest keepers
    ///             have a non-zero incentive to call on schedule (closing
    ///             the briber-collusion-stalls-keeper griefing vector).
    function advanceEpoch() external nonReentrant whenNotPaused {
        if (block.timestamp < lastEpochTime + MIN_EPOCH_INTERVAL) revert EpochTooSoon();
        // AUDIT FIX FRESH-2026: F-77-3 — refuse advance until the post-deposit
        // cooldown elapses. Forces a 1h gap between the latest bribe deposit
        // landing in the live bucket and the snapshot, so a briber who
        // front-runs `advanceEpoch` with a giant deposit cannot atomically
        // capture the just-finalized bucket. Combined with F-77-1's epoch+1
        // deposit indexing this is belt-and-suspenders.
        if (lastBribeDepositTime != 0 && block.timestamp < lastBribeDepositTime + ADVANCE_EPOCH_DEPOSIT_COOLDOWN) {
            revert AdvanceEpochCooldown();
        }

        // AUDIT NEW-G4 (HIGH): snap the epoch timestamp back by SNAPSHOT_LOOKBACK so
        // same-block / near-block flash-stakes cannot influence THIS epoch's voting
        // power or bribe shares. `votingPowerAtTimestamp(user, snapshotTime)` reads
        // the checkpoint strictly before snapshotTime; the 1h lookback enforces a
        // cooling-off between stake and advance. Fallback to (timestamp - 1) on early
        // genesis/fork conditions.
        uint256 snapshotTime = block.timestamp > SNAPSHOT_LOOKBACK
            ? block.timestamp - SNAPSHOT_LOOKBACK
            : (block.timestamp > 0 ? block.timestamp - 1 : 0);

        // AUDIT FIX FRESH-2026: F-65-3 — historical denominator pin. Pre-fix
        // `totalPower = votingEscrow.totalBoostedStake()` (LIVE) while
        // numerator was read at `snapshotTime`, an asymmetry that diluted
        // honest voters by any whale who staked in the last hour. Mirror
        // RevenueDistributor's pattern: try historical, fall back to live
        // on legacy ABI / staking-side rebuild.
        uint256 totalPower;
        try votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime) returns (uint256 hist) {
            totalPower = hist;
        } catch {
            totalPower = 0;
        }
        if (totalPower == 0) {
            // Live fallback for genesis-window edge cases where the
            // staking-side checkpoint hasn't crossed `snapshotTime` yet.
            totalPower = votingEscrow.totalBoostedStake();
        }
        if (totalPower == 0) revert NoStakers();
        if (totalPower < MIN_DISTRIBUTE_STAKE) revert NoStakers();

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
        // AUDIT FIX FRESH-2026: F-77-3 — track advance time for off-chain
        // monitoring + symmetric cooldown if the keeper bounty path ever
        // gets per-call rate-limited.
        lastEpochAdvanceTime = block.timestamp;

        emit EpochAdvanced(newEpoch, totalPower, snapshotTime);

        // AUDIT FIX FRESH-2026: F-10-K-04 + M-11 — keeper bounty. Pay
        // ADVANCE_EPOCH_BOUNTY in TOWELI to msg.sender if free balance
        // (net of `totalCommitBonds`) covers it. CEI: state already mutated.
        uint256 toweliBal = toweli.balanceOf(address(this));
        if (toweliBal >= totalCommitBonds + ADVANCE_EPOCH_BOUNTY) {
            try this._safeTransferExternal(address(toweli), msg.sender, ADVANCE_EPOCH_BOUNTY) {} catch {}
        }
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
        // AUDIT FIX FRESH-2026: F-77-4 — consumer-side monotonicity clamp via
        // `_clampedUserPower(user, ts)` helper. Defends against a buggy/unsafe
        // restaking historical lookup that could return more than the live
        // power. The min(historical, current) clamp is now centralized so all
        // call sites (vote, commitVote) use one source of truth.
        uint256 userPower = _clampedUserPower(msg.sender, ep.timestamp);
        if (userPower == 0) revert NothingToClaim();

        if (userTotalVotes[msg.sender][epoch] + power > userPower) revert ExceedsPower();

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
        _requireGaugedPair(pair);

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = IERC20(token).balanceOf(address(this)) - balBefore;
        if (actualReceived == 0) revert ZeroAmount();
        // SECURITY FIX H-7 + R020 H-3: per-token minimum with 18-dec default.
        uint256 tokenMin = minBribeAmounts[token];
        uint256 effectiveMin = tokenMin > 0 ? tokenMin : DEFAULT_MIN_TOKEN_BRIBE;
        if (actualReceived < effectiveMin) revert BribeTooSmall();

        uint256 fee = (actualReceived * bribeFeeBps) / BPS;
        uint256 netBribe = actualReceived - fee;
        if (fee > 0) {
            IERC20(token).safeTransfer(treasury, fee);
        }

        // AUDIT FIX FRESH-2026: F-77-1 — n+1 epoch indexing. Voters in
        // epoch `n` see bribes from `n-1`'s deposit window only.
        uint256 epoch = epochs.length + 1;
        _bookDeposit(epoch, pair, token, netBribe);
        emit BribeDeposited(epoch, pair, token, msg.sender, netBribe, fee);
    }

    /// @notice Deposit ETH bribe for a specific pair in the current epoch.
    /// @param pair The pool pair address this bribe is for
    function depositBribeETH(address pair) external payable nonReentrant whenNotPaused {
        if (pair == address(0)) revert InvalidPair();
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < MIN_BRIBE_AMOUNT) revert BribeTooSmall();
        _validatePair(pair);
        _requireGaugedPair(pair);

        uint256 fee = (msg.value * bribeFeeBps) / BPS;
        uint256 netBribe = msg.value - fee;
        if (fee > 0) {
            accumulatedTreasuryETH += fee;
        }
        // AUDIT FIX FRESH-2026: F-77-1 — n+1 epoch indexing.
        uint256 epoch = epochs.length + 1;
        _bookDeposit(epoch, pair, address(0), netBribe);
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
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        if (pair == address(0)) revert InvalidPair();
        // AUDIT FIX FRESH-2026: H-4 — read-side validator (registration only).
        _validatePairForRead(pair);
        // AUDIT FIX FRESH-2026: F-69-1 — sequencer-buffer-aware claim window gate.
        EpochInfo memory _ep = epochs[epoch];
        uint256 _voteEnd = _ep.usesCommitReveal ? revealDeadline(epoch) : _ep.timestamp + VOTE_DEADLINE;
        if (block.timestamp <= _voteEnd + _sequencerBuffer()) revert ClaimWindowNotOpen();
        // AUDIT FIX FRESH-2026: H-4 — pair-disabled-at-snapshot rejection.
        if (!_snapshotPairLive(epoch, pair)) revert PairDisabled();

        uint256 userVoteForPair = gaugeVotes[msg.sender][epoch][pair];
        if (userVoteForPair == 0) revert NothingToClaim();
        // AUDIT FIX FRESH-2026: M-10 — frozen totalVotes.
        uint256 totalVotesForPair = _freezeOrReadVoteCount(epoch, pair);
        if (totalVotesForPair == 0) revert NothingToClaim();
        if (totalVotesForPair < MIN_BRIBE_CLAIM_QUORUM) revert BribePoolBelowQuorum();
        // AUDIT FIX FRESH-2026: F-77-5 + F-69-3 + F-93-3 — distinct-briber floor.
        if (bribeDepositorCount[epoch][pair] < MIN_BRIBE_CLAIM_QUORUM_PER_BRIBER) revert BribePoolNeedsMoreBribers();
        // AUDIT FIX FRESH-2026: F-10-K-05 — counter form (refunded depositors release).
        if (depositCountOnPair[msg.sender][epoch][pair] > 0) revert SelfBribeClaimForbidden();

        address[] memory tokens = epochBribeTokens[epoch][pair];
        bool anyClaimed = false;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (_processClaimToken(epoch, pair, tokens[i], userVoteForPair, totalVotesForPair)) {
                anyClaimed = true;
            }
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
        // AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — read-side validator
        // (registration-only). Per-epoch disable-at-snapshot check is done
        // inside the loop via `_snapshotPairLive` so a single disabled epoch
        // doesn't unwind the whole batch.
        _validatePairForRead(pair);
        if (epochEnd > epochs.length) epochEnd = epochs.length;
        if (epochStart >= epochEnd) revert NothingToClaim();
        if (epochEnd - epochStart > MAX_CLAIM_EPOCHS) revert TooManyUnclaimedEpochs();

        bool anyClaimed = false;
        uint256 totalIterations;

        for (uint256 e = epochStart; e < epochEnd; e++) {
            // AUDIT R014 H-4: skip un-finalized epochs (defensive — today
            // `e < epochEnd <= epochs.length` already guarantees finalization,
            // but mirroring the single-epoch guard makes the invariant local).
            if (!epochBribesFinalized[e]) continue;
            // AUDIT FIX FRESH-2026: M-9 / H-4 + F-11-1 + F-10-K-02 — skip
            // epochs whose pair was disabled at snapshot. Post-snapshot
            // disable cases (pair was live AT snapshot, disabled later) are
            // caught here too: `_snapshotPairLive` returns the FROZEN
            // snapshot (or freshly captures it on first read past vote-end
            // for honest claimers), so a post-snapshot disable that lands
            // BEFORE any claim/refund touch results in `live = false` and
            // skips. To preserve the post-snapshot-claim-still-works
            // invariant the cache is populated in the first claim that
            // happens BEFORE the disable; subsequent claims read true.
            if (!_snapshotPairLive(e, pair)) continue;

            // V2: Use gauge votes instead of raw voting power
            uint256 userVoteForPair = gaugeVotes[msg.sender][e][pair];
            if (userVoteForPair == 0) continue;

            // AUDIT FIX FRESH-2026: M-10 / F-10-K-03 — frozen totalVotes
            // (lazy snapshot at first claim/refund touch past vote-end).
            uint256 totalVotesForPair = _freezeOrReadVoteCount(e, pair);
            if (totalVotesForPair == 0) continue;
            // AUDIT FIX (pass-8) Phase 1.6 — same gates as `claimBribes`. We `continue`
            // (skip the epoch) instead of revert because batch claim spans multiple
            // epochs; a sub-quorum or self-bribe match on one epoch shouldn't unwind
            // the entire batch when other epochs have legitimate claims.
            if (totalVotesForPair < MIN_BRIBE_CLAIM_QUORUM) continue;
            // AUDIT FIX FRESH-2026: F-77-5 + F-69-3 + F-93-3 — distinct-briber floor.
            if (bribeDepositorCount[e][pair] < MIN_BRIBE_CLAIM_QUORUM_PER_BRIBER) continue;
            // AUDIT FIX FRESH-2026: F-10-K-01 — when self-bribe-lockout
            // skips the (epoch, pair), STILL flip `claimed=true` for each
            // token so off-chain indexers see the row closed. Pre-fix the
            // batch silently `continue`d without writing the flag, leaving
            // ghost rows that monitors flagged forever.
            // AUDIT FIX FRESH-2026: F-10-K-05 — read counter form so
            // refunded depositors are no longer locked out.
            if (depositCountOnPair[msg.sender][e][pair] > 0) {
                address[] memory _tks = epochBribeTokens[e][pair];
                for (uint256 _i = 0; _i < _tks.length; _i++) {
                    if (!claimed[msg.sender][e][pair][_tks[_i]]) {
                        claimed[msg.sender][e][pair][_tks[_i]] = true;
                    }
                }
                continue;
            }

            address[] memory tokens = epochBribeTokens[e][pair];
            for (uint256 i = 0; i < tokens.length; i++) {
                bool consumed = _processClaimToken(e, pair, tokens[i], userVoteForPair, totalVotesForPair);
                if (consumed) {
                    anyClaimed = true;
                    // SECURITY FIX H-8: cap iterations across the batch.
                    totalIterations++;
                    if (totalIterations > MAX_BATCH_ITERATIONS) revert TooManyIterations();
                }
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
        if (newFee == 0) revert FeeIsZero(); // M-08 FIX preserved
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
        if (amount == 0) revert NoFees();
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
        if (epoch < epochs.length) revert EpochAlreadySnapshotted();
        // AUDIT FIX (BATCH-N2 M12) + AUDIT FIX FRESH-2026 M-11 / F-10-K-04 —
        // per-depositor rescue clock keyed on absolute time-since-MY-deposit.
        uint256 lastDeposit = lastBribeDepositPerUser[epoch][pair][token][msg.sender];
        if (lastDeposit == 0) revert NoBribesInEpoch();
        if (block.timestamp < lastDeposit + BRIBE_RESCUE_DELAY) revert RescueTooEarly();
        uint256 amount = _processRefund(epoch, pair, token);
        emit OrphanedBribeRefunded(epoch, pair, token, msg.sender, amount);
    }

    // AUDIT FIX FRESH-2026 (size optimization, relaunch — no compat shims):
    // legacy `rescueOrphanedBribes` deprecation revert removed.

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
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        // AUDIT FIX FRESH-2026: M-10 / F-10-K-03 — frozen totalGaugeVotes.
        if (_freezeOrReadVoteCount(epoch, pair) != 0) revert PairHasVotes();
        if (block.timestamp < _refundGateTime(epoch)) revert GraceNotElapsed();
        uint256 amount = _processRefund(epoch, pair, token);
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
        // AUDIT FIX FRESH-2026: M-10 / F-10-K-03 — frozen totalGaugeVotes.
        uint256 totalVotes = _freezeOrReadVoteCount(epoch, pair);
        if (!(totalVotes > 0 && totalVotes < MIN_BRIBE_CLAIM_QUORUM)) revert NotSubQuorum();
        if (block.timestamp < _refundGateTime(epoch)) revert GraceNotElapsed();
        uint256 amount = _processRefund(epoch, pair, token);
        emit SubQuorumBribeRefunded(epoch, pair, token, msg.sender, amount);
    }

    // ─── AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 ───────────────
    // Fourth refund leg: pair was LIVE at snapshot but factory disabled it
    // post-snapshot. Without this leg, in-flight bribes on a mid-window
    // disable would be permanently locked: claim reverts on the snapshot
    // disable check, refundUnvoted reverts because votes != 0,
    // refundSubQuorum reverts because votes >= quorum, and orphan-rescue
    // reverts because epoch IS finalized. Symmetric to refundUnvotedBribe
    // and refundSubQuorumBribe in cleanup semantics.
    event DisabledPairBribeRefunded(uint256 indexed epoch, address indexed pair, address indexed token, address depositor, uint256 amount);

    function refundDisabledPairBribe(uint256 epoch, address pair, address token) external nonReentrant {
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        // AUDIT FIX FRESH-2026: H-4 + F-11-1 — gate: pair was live at
        // snapshot (anchored on first deposit) AND is currently disabled.
        if (!_snapshotPairLive(epoch, pair)) revert PairDisabled();
        if (!factory.disabledPairs(pair)) revert PairNotDisabled();
        if (block.timestamp < _refundGateTime(epoch)) revert GraceNotElapsed();
        uint256 amount = _processRefund(epoch, pair, token);
        emit DisabledPairBribeRefunded(epoch, pair, token, msg.sender, amount);
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
        // AUDIT FIX FRESH-2026: F-10-K-08 + F-84-3 — reject amount==0 so a
        // careless admin cannot silently restore the 18-dec
        // `DEFAULT_MIN_TOKEN_BRIBE` floor on a previously-configured token
        // (which on a 6-dec stablecoin would mean a 1000-USDC minimum,
        // 1e9× the operator's intended floor). The propose-side already
        // enforces this, but the apply-side check is belt-and-suspenders
        // for any future direct-admin-call path.
        if (amount == 0) revert ZeroAmount();
        if (amount > MAX_MIN_BRIBE_AMOUNT) revert ZeroAmount(); // BATCH-H M13: reuse existing error
        uint256 oldAmount = minBribeAmounts[token];
        minBribeAmounts[token] = amount;
        emit MinBribeAmountChangeExecuted(token, oldAmount, amount);
    }

    /// @notice AUDIT FIX FRESH-2026: F-61-4 — sweep permanent dust from a
    ///         (epoch, pair, token) triple AFTER the EPOCH_DUST_SWEEP_DELAY
    ///         (1 year past vote-end) has elapsed. Dust is the rounding
    ///         residual `epochBribes - totalClaimedBribes` that no voter
    ///         can claim (their share rounded to zero). Pre-fix, this
    ///         dust was permanently locked in the contract — accumulating
    ///         across many (epoch, pair, token) triples — but unsweepable
    ///         because `totalUnclaimedBribes` reservation included the
    ///         dust budget. After the sweep window, dust is recoverable
    ///         to treasury, mirroring Aerodrome's
    ///         `BribeVotingReward.notifyRewardAmountForToken` reset.
    /// @dev    Owner-only. The 1-year delay is a structural floor
    ///         (UNVOTED_REFUND_GRACE = 14d, BRIBE_RESCUE_DELAY = 30d, claim
    ///         retention = MAX_CLAIM_EPOCHS×7d ≤ 9.5y but practical claims
    ///         clear within months). The dust recovery is the LAST resort.
    function sweepEpochDust(uint256 epoch, address pair, address token) external onlyOwner nonReentrant {
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (!epochBribesFinalized[epoch]) revert EpochNotFinalized();
        EpochInfo memory ep = epochs[epoch];
        uint256 voteEnd = ep.usesCommitReveal
            ? revealDeadline(epoch)
            : ep.timestamp + VOTE_DEADLINE;
        if (block.timestamp < voteEnd + EPOCH_DUST_SWEEP_DELAY) revert DustSweepTooEarly();

        uint256 deposited = epochBribes[epoch][pair][token];
        uint256 paidOut = totalClaimedBribes[epoch][pair][token];
        uint256 dust = deposited > paidOut ? deposited - paidOut : 0;
        if (dust == 0) revert ZeroAmount();

        // CEI: clear the per-bucket residual BEFORE the outbound transfer.
        // Set `epochBribes` down to `paidOut` so any future claim attempt
        // (which would be rounding-noise after this point) sees a zero
        // bribe pool rather than dust still hanging on.
        epochBribes[epoch][pair][token] = paidOut;

        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > dust ? totalUnclaimedETHBribes - dust : 0;
            WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, dust);
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > dust ? totalUnclaimedBribes[token] - dust : 0;
            IERC20(token).safeTransfer(treasury, dust);
        }
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
        if (sweepable == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, sweepable);
    }

    // ─── AUDIT FIX H-03: External helper for try/catch safeTransfer ──

    /// @dev External wrapper around SafeERC20.safeTransfer so it can be used with try/catch.
    ///      Solidity's try only works on external calls. Only callable by this contract itself.
    function _safeTransferExternal(address token, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
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
    /// @dev AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — this remains the
    ///      DEPOSIT-time gate. The factory's `disabledPairs(pair)` flag is
    ///      checked LIVE here so a briber can't deposit on a dead pair.
    ///      Read paths (claim/refund/reveal) use `_validatePairForRead`
    ///      below which consults the snapshot-time `epochSnapshotPairLive`
    ///      cache instead — that closes the post-snapshot disable trap.
    /// @dev AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — split into
    ///      registration-only (`checkDisabled = false`) and full
    ///      (`checkDisabled = true`) variants. Deposit/vote paths pass true;
    ///      claim/refund/reveal paths pass false (post-snapshot disable
    ///      handled via `_snapshotPairLive` cache).
    function _validatePairCommon(address pair, bool checkDisabled) internal view {
        if (pair.code.length == 0) revert InvalidPair();
        try ITegridyPair(pair).token0() returns (address t0) {
            try ITegridyPair(pair).token1() returns (address t1) {
                if (factory.getPair(t0, t1) != pair) revert InvalidPair();
            } catch {
                revert InvalidPair();
            }
        } catch {
            revert InvalidPair();
        }
        if (checkDisabled && factory.disabledPairs(pair)) revert PairDisabled();
    }
    function _validatePair(address pair) internal view { _validatePairCommon(pair, true); }
    function _validatePairForRead(address pair) internal view { _validatePairCommon(pair, false); }

    /// @dev AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — read the cached
    ///      snapshot. The "pair was live at snapshot" flag is set on deposit
    ///      (since deposit-time `_validatePair` enforces pair-is-live, the
    ///      first deposit on (epoch, pair) is the authoritative anchor).
    ///      Subsequent claim/refund/reveal calls read this cached value, so
    ///      a post-snapshot factory.disabledPairs() flip cannot retroactively
    ///      brick claim/refund flow.
    /// @dev If `epochSnapshotPairChecked[epoch][pair]` is false, the
    ///      (epoch, pair) tuple has no recorded deposit AND no recorded vote
    ///      AND no recorded claim attempt — fall back to the live factory
    ///      flag. This handles edge cases (e.g., a vote on a pair that
    ///      received zero bribes — the pair's snapshot wasn't anchored at
    ///      deposit, but a vote for it shouldn't auto-revert).
    function _snapshotPairLive(uint256 epoch, address pair) internal returns (bool isLive) {
        if (epochSnapshotPairChecked[epoch][pair]) {
            return epochSnapshotPairLive[epoch][pair];
        }
        // Fall-through: no deposit anchored this (epoch, pair). Read live
        // factory state and freeze for symmetry with the deposit-anchored
        // path. Once frozen, the answer is stable across the lifecycle.
        isLive = !factory.disabledPairs(pair);
        epochSnapshotPairLive[epoch][pair] = isLive;
        epochSnapshotPairChecked[epoch][pair] = true;
    }

    /// @dev Read-only sister of `_snapshotPairLive` for view paths. Returns
    ///      the cached snapshot if available; otherwise falls through to the
    ///      live `factory.disabledPairs(pair)` flag. View paths that hit the
    ///      live flag during the disable-window will see the disable; this
    ///      is acceptable for preview / claimable views (a stale view is
    ///      never a fund-loss). Mutating paths (claim/refund/reveal) MUST
    ///      use `_snapshotPairLive` to lock in the snapshot.
    function _snapshotPairLiveView(uint256 epoch, address pair) internal view returns (bool) {
        if (epochSnapshotPairChecked[epoch][pair]) {
            return epochSnapshotPairLive[epoch][pair];
        }
        return !factory.disabledPairs(pair);
    }

    /// @dev AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — anchor the
    ///      pair-live snapshot on FIRST deposit. Deposit-time
    ///      `_validatePair` enforces that the pair is live, so we capture
    ///      `true` here. Subsequent factory disable events do NOT flip the
    ///      cache — that's the point of the snapshot.
    function _anchorPairLiveSnapshot(uint256 epoch, address pair) internal {
        if (!epochSnapshotPairChecked[epoch][pair]) {
            epochSnapshotPairLive[epoch][pair] = true;
            epochSnapshotPairChecked[epoch][pair] = true;
        }
    }

    /// @dev AUDIT FIX FRESH-2026: F-69-1 — sequencer-buffer extender. Returns
    ///      `SEQUENCER_OUTAGE_BUFFER` if the L2 sequencer is down or has
    ///      resumed within the buffer window; 0 otherwise (or on mainnet).
    ///      Mirrors the MemeBountyBoard `_sequencerBuffer` helper.
    function _sequencerBuffer() internal view returns (uint256) {
        return SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_OUTAGE_BUFFER);
    }

    /// @dev AUDIT FIX FRESH-2026: M-10 / F-10-K-03 — freezing helper for
    ///      `totalGaugeVotes[epoch][pair]` at the first read past vote-end.
    ///      Subsequent reads from claim/refund paths use the frozen value
    ///      so a future change to `totalGaugeVotes` mutability cannot drift
    ///      claim/refund accounting.
    function _freezeOrReadVoteCount(uint256 epoch, address pair) internal returns (uint256 frozen) {
        if (epochVoteCountFinalSet[epoch][pair]) {
            return epochVoteCountFinal[epoch][pair];
        }
        frozen = totalGaugeVotes[epoch][pair];
        epochVoteCountFinal[epoch][pair] = frozen;
        epochVoteCountFinalSet[epoch][pair] = true;
    }

    /// @dev AUDIT FIX FRESH-2026: F-77-4 — VotePowerOracle monotonicity clamp.
    ///      The library's additive sum across staking + restaking can return
    ///      a value > the user's current power if the restaking contract's
    ///      historical lookup is buggy / unsafe. This consumer-side clamp is
    ///      a defense-in-depth: the user-applied power can never exceed
    ///      `min(historical, current)` no matter what the oracle says.
    ///      Already used inline in vote/commit/reveal — surfaced as a
    ///      helper so future call sites pick up the same gate.
    function _clampedUserPower(address user, uint256 ts) internal view returns (uint256) {
        uint256 historical = VotePowerOracle.powerAt(user, ts, address(votingEscrow), restakingContract);
        uint256 current = VotePowerOracle.powerOf(user, address(votingEscrow), restakingContract);
        return historical < current ? historical : current;
    }

    /// @dev AUDIT FIX FRESH-2026 (size optimization) — shared CEI tail for the
    ///      four refund paths (orphan / unvoted / sub-quorum / disabled-pair).
    ///      Reads + clears `bribeDeposits[epoch][pair][token][user]`,
    ///      decrements the deposit counter (releasing self-bribe lockout on
    ///      full refund), decrements `epochBribes`, and pulls funds out via
    ///      ETH-safe / ERC20 transfer. CEI: state cleared before transfer.
    function _processRefund(uint256 epoch, address pair, address token) internal returns (uint256 amount) {
        amount = bribeDeposits[epoch][pair][token][msg.sender];
        if (amount == 0) revert NothingToRefund();

        bribeDeposits[epoch][pair][token][msg.sender] = 0;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = 0;
        if (depositCountOnPair[msg.sender][epoch][pair] > 0) {
            depositCountOnPair[msg.sender][epoch][pair] -= 1;
            if (depositCountOnPair[msg.sender][epoch][pair] == 0) {
                depositedOnPair[msg.sender][epoch][pair] = false;
            }
        }
        uint256 remaining = epochBribes[epoch][pair][token];
        epochBribes[epoch][pair][token] = remaining > amount ? remaining - amount : 0;

        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > amount ? totalUnclaimedETHBribes - amount : 0;
            WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > amount ? totalUnclaimedBribes[token] - amount : 0;
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    /// @dev AUDIT FIX FRESH-2026 (size optimization) — common voteEnd
    ///      computation. Returns `voteEnd + UNVOTED_REFUND_GRACE +
    ///      _sequencerBuffer()` (the gate that all sub-quorum / unvoted /
    ///      disabled-pair refund paths share).
    function _refundGateTime(uint256 epoch) internal view returns (uint256) {
        EpochInfo memory ep = epochs[epoch];
        uint256 voteEnd = ep.usesCommitReveal
            ? revealDeadline(epoch)
            : ep.timestamp + VOTE_DEADLINE;
        return voteEnd + UNVOTED_REFUND_GRACE + _sequencerBuffer();
    }

    /// @dev AUDIT FIX FRESH-2026 (size optimization) — shared accounting tail
    ///      for deposit paths. Used by both `depositBribe` (ERC20) and
    ///      `depositBribeETH`. Updates per-depositor and per-(epoch, pair)
    ///      counters, anchors the pair-live snapshot, and bumps the global
    ///      `lastBribeDepositTime` for the advance-cooldown gate.
    /// @dev    F-77-1 epoch+1 indexing is computed at the call site.
    function _bookDeposit(uint256 epoch, address pair, address token, uint256 netBribe) internal {
        if (epochBribesFinalized[epoch]) revert EpochAlreadyFinalized();
        address[] storage tokenList = epochBribeTokens[epoch][pair];
        if (epochBribes[epoch][pair][token] == 0) {
            if (tokenList.length >= MAX_BRIBE_TOKENS) revert TooManyBribeTokens();
            tokenList.push(token);
        }
        epochBribes[epoch][pair][token] += netBribe;
        if (token == address(0)) {
            totalUnclaimedETHBribes += netBribe;
        } else {
            totalUnclaimedBribes[token] += netBribe;
        }
        if (bribeDeposits[epoch][pair][token][msg.sender] == 0 && depositCountOnPair[msg.sender][epoch][pair] == 0) {
            bribeDepositorCount[epoch][pair] += 1;
        }
        bribeDeposits[epoch][pair][token][msg.sender] += netBribe;
        epochBribeLastDeposit[epoch] = block.timestamp;
        lastBribeDepositPerUser[epoch][pair][token][msg.sender] = block.timestamp;
        depositedOnPair[msg.sender][epoch][pair] = true;
        depositCountOnPair[msg.sender][epoch][pair] += 1;
        lastBribeDepositTime = block.timestamp;
        _anchorPairLiveSnapshot(epoch, pair);
    }

    /// @dev AUDIT FIX FRESH-2026 (size optimization) — shared per-token
    ///      claim accounting. Computes share, marks claimed, decrements
    ///      reservations, transfers funds, emits events. Returns true if a
    ///      transfer (or zero-share-skip) actually happened on this token.
    function _processClaimToken(
        uint256 epoch,
        address pair,
        address token,
        uint256 userVote,
        uint256 totalVote
    ) internal returns (bool consumed) {
        if (claimed[msg.sender][epoch][pair][token]) return false;
        uint256 bribeAmount = epochBribes[epoch][pair][token];
        if (bribeAmount == 0) return false;
        uint256 share = (bribeAmount * userVote) / totalVote;
        claimed[msg.sender][epoch][pair][token] = true;
        if (share == 0) return true; // dust-only iteration counts as consumed for `anyClaimed`.

        totalClaimedBribes[epoch][pair][token] += share;
        if (token == address(0)) {
            totalUnclaimedETHBribes = totalUnclaimedETHBribes > share ? totalUnclaimedETHBribes - share : 0;
            (bool ok,) = msg.sender.call{value: share, gas: 50000}("");
            if (!ok) {
                pendingETHWithdrawals[msg.sender] += share;
                totalPendingETH += share;
                emit PendingETHCredited(msg.sender, share);
            }
        } else {
            totalUnclaimedBribes[token] = totalUnclaimedBribes[token] > share ? totalUnclaimedBribes[token] - share : 0;
            try this._safeTransferExternal(token, msg.sender, share) {
            } catch {
                pendingTokenWithdrawals[msg.sender][token] += share;
                totalPendingTokens[token] += share;
                emit PendingTokenCredited(msg.sender, token, share);
            }
        }
        emit BribeClaimed(msg.sender, epoch, pair, token, share);
        return true;
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
        // AUDIT FIX FRESH-2026: F-77-4 — centralized monotonicity-clamp helper.
        uint256 userPower = _clampedUserPower(msg.sender, ep.timestamp);
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
        // AUDIT FIX FRESH-2026: F-69-1 — extend reveal-deadline by
        // SEQUENCER_OUTAGE_BUFFER on L2 outage. An honest voter who tried
        // to reveal during a sequencer outage shouldn't lose their bond +
        // vote application to a window that elapsed entirely while the
        // chain was offline. commit-deadline is left as-is (commits before
        // the outage are already locked in; the failure mode that matters
        // is "I missed my reveal because the chain was down").
        if (block.timestamp <= cd) revert RevealWindowNotOpen();
        if (block.timestamp > rd + _sequencerBuffer()) revert RevealWindowClosed();

        CommitInfo[] storage commits = voterCommits[msg.sender][epoch];
        if (commitIndex >= commits.length) revert CommitNotFound();
        CommitInfo storage c = commits[commitIndex];
        if (c.revealed) revert AlreadyRevealed();

        bytes32 expected = computeCommitHash(msg.sender, epoch, pair, power, salt);
        if (expected != c.commitHash) revert CommitHashMismatch();

        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();
        // AUDIT FIX FRESH-2026: H-4 + F-11-1 + F-10-K-02 — read-side validator
        // (registration-only). Voters who committed against a pair that the
        // factory disabled mid-window can still reveal so their vote
        // applies (and bribes settle via the snapshotted disable check on
        // the claim path). Pre-fix, the live `_validatePair` here turned a
        // mid-window factory disable into an unrecoverable bond + vote
        // loss for honest voters.
        _validatePairForRead(pair);
        // Voters whose pair was disabled AT EPOCH SNAPSHOT shouldn't apply
        // a vote — there's no claim flow downstream. They unwind via
        // `forfeitCommitOnDisabledPair` (refunds bond + clears
        // committedPower for fresh commits).
        if (!_snapshotPairLive(epoch, pair)) revert PairDisabled();

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
        // AUDIT FIX G-01: restrict to commit owner OR contract owner.
        if (msg.sender != user && msg.sender != owner()) revert Unauthorized();
        if (epoch >= epochs.length) revert InvalidEpoch();
        EpochInfo memory ep = epochs[epoch];
        if (!ep.usesCommitReveal) revert NotCommitRevealEpoch();

        CommitInfo[] storage commits = voterCommits[user][epoch];
        if (commitIndex >= commits.length) revert CommitNotFound();
        CommitInfo storage c = commits[commitIndex];
        if (c.revealed) revert AlreadyRevealed();

        if (pair == address(0)) revert InvalidPair();
        if (power == 0) revert ZeroAmount();
        if (computeCommitHash(user, epoch, pair, power, salt) != c.commitHash) revert CommitHashMismatch();
        if (!factory.disabledPairs(pair)) revert PairNotDisabled();

        // CEI: state first, transfer last.
        c.revealed = true;
        uint96 bond = c.bond;
        c.bond = 0;
        if (committedPower[user][epoch] >= power) {
            committedPower[user][epoch] -= power;
        } else {
            committedPower[user][epoch] = 0;
        }

        emit CommitForfeitedOnDisabledPair(user, epoch, commitIndex, pair, power, bond);

        if (bond > 0) {
            if (totalCommitBonds >= bond) totalCommitBonds -= bond;
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
        if (commitRevealEnabled) return; // idempotent
        commitRevealEnabled = true;
        emit CommitRevealEnabled(true);
    }
    // AUDIT FIX FRESH-2026 (size optimization, relaunch — no compat shims):
    // legacy `enableCommitReveal()` deprecation revert removed. The
    // propose/execute flow in `VoteIncentivesAdmin` is the only path; tooling
    // calling the old selector now reverts with `function not found`.
}
