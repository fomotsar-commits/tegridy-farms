// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// AUDIT FIX (pass-8): EIP170-02 — replaced OpenZeppelin ERC721 with Solmate's
// minimal ERC721 implementation to bring TegridyStaking under the EIP-170
// 24,576-byte runtime limit. Solmate ERC721 is ~3-4 KB smaller than OZ's
// (no _update hook, no IERC4906/Errors integration, simpler approval flow,
// inline assembly in hot paths). Battle-tested at scale by Uniswap V3 NFT
// positions, Sudoswap, Friend.tech, and many others.
//
// Migration impact:
//   - ABI: identical for all standard ERC721 surfaces (transferFrom, ownerOf,
//     balanceOf, approve, setApprovalForAll, getApproved, isApprovedForAll,
//     name, symbol, supportsInterface). Standard Transfer / Approval /
//     ApprovalForAll events are byte-identical.
//   - Storage: layout differs from OZ — `_owners`/`_balances` (OZ) become
//     `_ownerOf`/`_balanceOf` (Solmate). Live deployed contracts cannot be
//     in-place upgraded; this migration applies to fresh deploys only.
//   - Hooks: OZ's `_update(to, tokenId, auth)` central hook is replaced by
//     overrides on `transferFrom`, `_mint`, and `_burn` directly. Behaviour
//     preserved via `_postTokenTransition(from, to, id)` helper called from
//     all three paths.
//   - Reverts: Solmate uses string requires (`"NOT_MINTED"`, `"WRONG_FROM"`,
//     `"INVALID_RECIPIENT"`, etc.) instead of OZ's typed errors. Off-chain
//     tooling that filtered on `ERC721NonexistentToken` etc. needs updating.
// AUDIT FIX (pass-8 batch-14): swapped Solmate ERC721 → Solady ERC721 to close the
// final EIP-170 gap on this contract. Aliased so wildcard importers in scripts/tests
// don't pull a colliding `ERC721` symbol against OpenZeppelin's. Solady consolidates
// `transferFrom` / `_mint` / `_burn` post-processing into a single
// `_afterTokenTransfer(from, to, id)` hook (Solmate required three separate
// overrides). This collapse + Solady's assembly-tight implementation cut ~1.7 KB
// from the contract footprint, bringing TegridyStaking under EIP-170 for mainnet
// deploy.
import {ERC721 as SoladyERC721} from "solady/tokens/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
// AUDIT FIX (pass-8 batch-14): IERC721Receiver no longer needed on staking — JBAC
// inbound moved to TegridyStakingJbacVault. Keeping the IERC721 import for the
// `revalidateBoost` balanceOf check (resolved via vault.jbacNFT()).
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
// Strings import removed — tokenURI simplified to reduce contract size
// Base64 import removed — SVG on-chain generation moved out to reduce contract size
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";

/// @dev AUDIT FIX H8: Minimal interface for restaking-aware view functions
interface ITegridyRestakingView {
    function restakers(address user) external view returns (uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime);
    function tokenIdToRestaker(uint256 tokenId) external view returns (address);
}

/// @dev AUDIT FIX (pass-8 batch-14): Minimal interface to TegridyStakingJbacVault.
///      Used by `_clearPosition` to return a JBAC after the staking NFT burn
///      (CCR-01 invariant). Vault enforces `onlyStaking` on `returnJbac`.
interface ITegridyStakingJbacVault {
    function returnJbac(uint256 stakingTokenId, uint256 jbacTokenId, address to) external;
}

/// @title TegridyStaking — Unified Lock + Stake + Boost + Governance + NFT Positions
/// @notice Single contract replacing TegridyFarm + VotingEscrow.
/// @dev AUDIT NOTE #62: This contract uses block.timestamp for lock expiry and reward calculations.
///      Miners/validators can manipulate block.timestamp by up to ~15 seconds, which is a known
///      limitation accepted for this use case since lock durations are measured in days-to-years.
///
///         Features:
///         1. Lock TOWELI for 7 days to 4 years → boost from 0.4x to 4.0x (linear)
///         2. JBAC NFT holders get +0.5x bonus boost
///         3. Each staking position is an ERC721 NFT — tradeable on secondary markets
///         4. Auto-max-lock: opt in to keep max boost perpetually
///         5. Early withdrawal: 25% penalty (always available), sent to treasury
///         6. Voting power = amount × boost (for governance)
///
///         NFT Positions:
///         - Each stake mints an NFT to the staker
///         - Transferring the NFT transfers the entire staking position
///         - Buyer of an NFT inherits the lock, boost, and rewards
///         - This means users can sell their locked position instead of paying the 25% penalty
contract TegridyStaking is SoladyERC721, OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using EnumerableSet for EnumerableSet.UintSet;

    // ─── Constants ────────────────────────────────────────────────────

    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant MAX_LOCK_DURATION = 4 * 365 days;
    uint256 public constant MIN_BOOST_BPS = 4000;   // 0.4x
    uint256 public constant MAX_BOOST_BPS = 40000;  // 4.0x
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal` to
    ///      claw back ~30B of auto-getter bytecode. Equal to BPS; no external
    ///      reader exists.
    uint256 internal constant BOOST_PRECISION = 10000;
    uint256 public constant EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%
    uint256 public constant JBAC_BONUS_BPS = 5000; // +0.5x
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`. The
    ///      one external reader (TegridyStakingAdmin's BPS check) now hardcodes
    ///      `10_000` directly — it's a universal Ethereum-DeFi constant.
    uint256 internal constant BPS = 10000;
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal` —
    ///      no external readers in tests/scripts/admin. Saves ~30B per
    ///      auto-getter.
    uint256 internal constant TRANSFER_COOLDOWN = 24 hours;
    uint256 internal constant TRANSFER_RATE_LIMIT = 1 hours; // SECURITY FIX: Prevent rapid-fire NFT transfers for reward drain
    /// @dev AUDIT FIX (pass-8): EIP170-02 partial — visibility lowered from
    ///      `public` to `internal`. Zero on-chain consumers; off-chain readers
    ///      can either query via subgraph events or via a future getter if needed.
    ///      Saves ~80 bytes (autogenerated getter selector).
    mapping(uint256 => uint256) internal lastTransferTime; // tokenId => last transfer timestamp
    /// AUDIT FIX (BATCH-N1 M1): bumped from 1e12 to 1e18 — modern share-accumulator
    /// precision standard (Synthetix StakingRewards, AAVE rayMath, OpenZeppelin
    /// VestingWallet). At 1e12, rate × 1e12 / totalStaked could round to zero
    /// when (rate < totalStaked / 1e12), losing dust at every accrual call.
    /// At 1e18 the per-second drop-out floor is 1e6× lower. Overflow safe:
    /// product (boostedAmount × rewardPerTokenStored) at extreme rates over
    /// 100 years stays under 2^256 by ~10^17 margin.
    uint256 private constant ACC_PRECISION = 1e18;
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`.
    uint256 internal constant MIN_STAKE = 100e18; // AUDIT FIX #33: Minimum stake amount
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal` to
    ///      claw back ~30B of auto-getter bytecode. Read only inside
    ///      `notifyRewardAmount`; no external reader exists.
    uint256 internal constant MIN_NOTIFY_AMOUNT = 1000e18; // AUDIT FIX #61: Minimum fund amount to prevent dust funding

    // AUDIT R014 M-9: Owner can only `claimUnsettledFor(user)` after the user has been
    // dormant (no claim/getReward/withdraw/increaseAmount/extendLock/NFT-receive) for
    // USER_INACTIVITY_GATE seconds. Prevents the owner from front-running an active user
    // and pulling their unsettled rewards out from under them. The restaking contract
    // path is unchanged — restaking trampolines reward claims for the actual depositor.
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`. Tests
    ///      hardcode the value (90 days) directly.
    uint256 internal constant USER_INACTIVITY_GATE = 90 days;
    /// @notice Last block.timestamp at which `user` performed a reward-touching action
    ///         on this contract (claim, withdraw, increase, NFT receive). Read-only;
    ///         updated internally by `_touch(user)`.
    mapping(address => uint256) public lastActivityAt;

    // ─── State ────────────────────────────────────────────────────────
    // NOTE (size-reduction sprint 2026-04-26): timelock keys, propose/execute/cancel
    // flow, pending state, and the `*ChangeReadyAt`/`*ChangeTime` view helpers all
    // live on the sister `TegridyStakingAdmin` contract. TegridyStaking exposes
    // `applyXxx` setters guarded by `onlyAdmin` for the admin contract to call.
    address public stakingAdmin;

    IERC20 public immutable rewardToken;
    /// @notice The JBAC ERC721 collection. Kept on TegridyStaking so users continue
    ///         to approve THIS contract (not the vault) before `stakeWithBoost` —
    ///         the `safeTransferFrom(user, vault, jbacId)` call in `stakeWithBoost`
    ///         pulls from the user (uses the staking-side approval) and lands at
    ///         the vault (which holds custody and the stranded-reclaim mappings).
    /// @dev    AUDIT FIX (pass-8 batch-14): JBAC CUSTODY moved to
    ///         `TegridyStakingJbacVault`; the IERC721 reference + balanceOf reads
    ///         (used by `revalidateBoost`) stay here. `_returnJbac` /
    ///         `claimStrandedJbac` / stranded mappings + getters all moved.
    IERC721 public immutable jbacNFT;
    /// @notice JBAC vault sister contract — receives JBACs from `stakeWithBoost`
    ///         and handles return + stranded-reclaim on exit. Wired once via
    ///         `setJbacVault` (one-shot, owner-only). Vault's constructor takes
    ///         `staking` as immutable so the direction is fixed at vault-deploy.
    address public jbacVault;
    address public treasury;

    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalBoostedStake;
    uint256 public totalStaked;
    // AUDIT H-4 (battle-tested fix): totalLocked is a view proxy for totalStaked (they are
    // always equal). The prior state-variable design permanently returned 0, causing
    // third-party integrators (allocators, dashboards, indexers) to read zero TVL.
    function totalLocked() external view returns (uint256) {
        return totalStaked;
    }

    uint256 private _nextTokenId = 1;

    struct Position {
        uint256 amount;
        uint256 boostedAmount;
        int256 rewardDebt;
        uint64 lockEnd;
        uint16 boostBps;
        uint32 lockDuration;
        bool autoMaxLock;  // If true, lock auto-extends to max on every interaction
        bool hasJbacBoost;
        uint64 stakeTimestamp;
        // AUDIT H-1 (2026-04-20): Deposit-based JBAC boost (ApeCoin-Staking pattern).
        // Replaces flash-loan-able `jbacNFT.balanceOf(msg.sender) > 0` cache with a
        // physical deposit that stays locked for the position's lifetime.
        uint256 jbacTokenId;   // 0 = none / legacy-grandfathered
        bool jbacDeposited;    // true = physical deposit (new pattern); false = legacy-grandfathered
    }

    mapping(uint256 => Position) public positions; // tokenId => position
    mapping(address => uint256) public userTokenId; // user => their tokenId (0 = no position)

    // AUDIT FIX M-5 (full aggregation): track every staking NFT owned by a given address.
    // Prior implementation overwrote userTokenId on each transfer, so votingPowerOf(holder)
    // silently undercounted multi-NFT holders (contract wallets, Safes, aggregating vaults).
    // Now votingPowerOf iterates the full set, summing active voting power across all positions.
    // Cap at MAX_POSITIONS_PER_HOLDER bounds checkpoint-write gas and votingPowerOf read gas;
    // also protects against push-grief (attacker flooding a target address with stale NFTs).
    mapping(address => EnumerableSet.UintSet) private _positionsByOwner;
    // AUDIT C-2 (HIGH): cap restored to 50 from the prior 100. Every external integrator
    // that reads votingPowerOf — ReferralSplitter on each fee credit, RevenueDistributor's
    // checkpoint-fallback path, governance/voting consumers — pays the O(n) cost. Doubling
    // the cap to 100 doubled the cost they pay. 50 still gives Gnosis Safe / aggregating
    // vault headroom (typical multi-position holders accumulate <10) while halving the
    // worst-case gas (~130k checkpoint-write, ~250k votingPowerOf read at the cap).
    // Existing addresses already over the new cap can still claim/withdraw — the cap
    // gates new acquisitions only.
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`. Tests
    ///      hardcode the value (50) directly. Documented in
    ///      `SwapFeeRouter` natspec for reference.
    uint256 internal constant MAX_POSITIONS_PER_HOLDER = 50;

    // AUDIT FIX #1: Checkpointing via OZ Checkpoints.Trace208 (timestamp → votingPower)
    mapping(address => Checkpoints.Trace208) private _checkpoints;

    // AUDIT REV-M-01 (MEDIUM, 2026-04-28): timestamp -> totalBoostedStake checkpoints,
    // used by RevenueDistributor._distribute to read the system-wide boosted-stake
    // denominator AT (block.timestamp - 1) — the same OZ Checkpoints.upperLookup(T-1)
    // semantics already used for per-user voting power. Same-block stakes have a
    // checkpoint key == block.timestamp and are therefore EXCLUDED from a T-1 read,
    // closing the same-block dilution window that REV C-01 left half-open.
    //
    // Storage layout: APPENDED — does NOT reshuffle any existing slots. Trace208 is a
    // dynamic struct so it occupies a single slot for the trace pointer regardless of
    // the number of checkpoints written.
    Checkpoints.Trace208 private _totalBoostedStakeCheckpoints;

    uint256 public totalPenaltiesCollected;
    uint256 public totalRewardsFunded;
    mapping(address => uint256) public unsettledRewards; // AUDIT FIX M-04: Accumulated rewards from NFT transfers
    // SECURITY FIX: Track total unsettled rewards across all users to prevent
    // competing claims from draining each other's unsettled rewards.
    uint256 public totalUnsettledRewards;
    /// @notice AUDIT FIX C-1: per-tokenId attribution of unsettled rewards.
    ///         Pre-fix, every credit to `unsettledRewards[restakingContract]` was
    ///         pooled across ALL restaked positions — when two restakers' kicks
    ///         landed in the same bucket, whichever called `unrestake()` first
    ///         drained the entire bucket and stole the second restaker's share.
    ///
    ///         Now we ALSO record `unsettledRewardsByTokenId[tokenId]` for credits
    ///         that arose from a settle/kick on an NFT held by `restakingContract`.
    ///         The new `claimUnsettledForTokenId(tokenId, recipient)` function
    ///         pulls only that tokenId's slice (capped by holder bucket + reward
    ///         pool), so the restaking contract can attribute precisely.
    ///
    ///         Non-restaked transfers (e.g. NFT moving to a lending contract or
    ///         between EOAs) do NOT touch this mapping — only credits routed to
    ///         the shared restakingContract bucket need per-NFT attribution.
    mapping(uint256 => uint256) public unsettledRewardsByTokenId;
    // AUDIT FIX L-06: Cap unbounded totalUnsettledRewards growth.
    // If cap is hit, excess rewards are forfeited (sent to treasury on next reconcile).
    // AUDIT FIX C-02: Made admin-adjustable via timelocked setter (was constant 100_000e18).
    uint256 public maxUnsettledRewards = 100_000e18;

    // AUDIT FIX C-05: Emergency exit delay mapping (tokenId => request timestamp)
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`.
    uint256 internal constant EMERGENCY_EXIT_DELAY = 7 days;
    /// @dev AUDIT FIX (pass-8): EIP170-02 partial — visibility lowered to
    ///      `internal`. Zero on-chain consumers; emergency exit state is
    ///      observable off-chain via the EmergencyExit* events. Saves ~80B.
    mapping(uint256 => uint256) internal _emergencyExitRequests;

    // SECURITY FIX #13: Reward rate cap (timelocked propose/execute lives on TegridyStakingAdmin).
    // AUDIT FIX FRESH-2026: F-35-2 [LOW-MED] — tightened from 100e18 → 1e18.
    // Previous cap allowed ~3.15B TOWELI/yr emissions (3.15× total supply); the new cap
    // is ~31.5M/yr (~3.15% of supply) — still emergency-high but ratchets the
    // captured-owner runway-burn ceiling. Routine rate adjustments remain gated by
    // the 48h timelock.
    uint256 public constant MAX_REWARD_RATE = 1e18; // Cap maximum reward rate

    // AUDIT FIX H8: Restaking contract reference for restaking-aware view functions
    address public restakingContract;

    // AUDIT H-01 / Spartan TF-02: whitelisted lending contracts are exempt from the
    // NFT transfer COOLDOWN and RATE_LIMIT gates. Without this, a user who stakes
    // cannot deposit the staking NFT as collateral on TegridyLending for 24 hours,
    // and the NFT's round-trip on repayment/default is only saved from the rate
    // limit by the implicit dependence on MIN_DURATION >= TRANSFER_RATE_LIMIT.
    // Adds/removes go through the 48h timelocked path on TegridyStakingAdmin.
    mapping(address => bool) public isLendingContract;

    // AUDIT FIX (pass-8 batch-14): stranded-JBAC mappings + getter + ABI shims
    // moved to TegridyStakingJbacVault. Off-chain readers should query
    // `vault.strandedJbacOwner(tokenId)`, `vault.strandedJbacTokenId(tokenId)`,
    // or `vault.getStrandedJbac(tokenId)` instead.

    /// @notice AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH] —
    ///         second-layer stranded record that fires when the OUTER
    ///         `vault.returnJbac(...)` call from `_clearPosition` itself reverts
    ///         (mis-wired vault at one-shot `setJbacVault` time, ABI mismatch,
    ///         transient vault gas blow-up). Without this, every JBAC-deposited
    ///         position is perma-frozen on exit because `_clearPosition` is
    ///         called from `withdraw` / `earlyWithdraw` / `emergencyExitPosition`
    ///         / `executeEmergencyExit` / `emergencyWithdrawPosition` — all of
    ///         which would propagate the revert. The vault's own internal try/
    ///         catch (TegridyStakingJbacVault.sol:92-99) handles JBAC-side
    ///         failures; this record handles VAULT-side failures. JBAC stays
    ///         physically at the vault; the user retries via
    ///         `retryReturnJbacFromVault` when the vault path heals.
    mapping(uint256 => address) public strandedJbacAtVaultOwner;
    mapping(uint256 => uint256) public strandedJbacAtVaultId;

    // AUDIT FIX (pass-8): test/off-chain ABI compatibility shim. Internal
    // mapping uses `_` prefix to free the public name; this view surfaces
    // the same `name(tokenId) → value` shape as the original public-mapping
    // auto-getter at minimal bytecode cost (~30B).
    function emergencyExitRequests(uint256 tokenId) external view returns (uint256) { return _emergencyExitRequests[tokenId]; }

    // ─── AUDIT C5: extend-lock / autoMaxLock-enable fee ──────────────────
    /// @notice Fee in BPS charged on extendLock and on toggleAutoMaxLock when enabling.
    ///         Default 0 — governance must propose/execute a non-zero value via 48h
    ///         timelock (on TegridyStakingAdmin) to activate. Capped at
    ///         EXTEND_FEE_BPS_CEILING (200 = 2%). Pulled from the caller via TOWELI
    ///         safeTransferFrom (caller must approve); routed to treasury so the
    ///         protocol captures value when boost is increased.
    uint256 public extendFeeBps;
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal` —
    ///      one external reader (TegridyStakingAdmin's bound check) hardcodes
    ///      `200` directly.
    uint256 internal constant EXTEND_FEE_BPS_CEILING = 200;

    // ─── AUDIT C6: penalty recycle to active stakers ─────────────────────
    /// @notice BPS of early-withdrawal penalty that is recycled into the staker reward
    ///         pool (rewardPerTokenStored is credited immediately). Remainder goes to
    ///         treasury (current behaviour). Default 0 — backward-compatible. Capped at
    ///         BPS (10000 = 100%). Governance can shift via 48h timelock on
    ///         TegridyStakingAdmin.
    uint256 public penaltyRecycleBps;

    // ─── AUDIT M-AUDIT-2026-1: extend-fee recycle to active stakers ─────
    /// @notice AUDIT M-AUDIT-2026-1 (MEDIUM, 2026-04-28): BPS of the `extendLock` /
    ///         `toggleAutoMaxLock` fee that is recycled into the staker reward pool
    ///         (rewardPerTokenStored is credited immediately). Remainder goes to
    ///         treasury — that's the original AUDIT C5 behaviour preserved when this
    ///         value is 0 (default).
    ///
    ///         Pre-fix, EVERY extend-lock / max-lock-enable fee landed at treasury
    ///         while the boost it bought DILUTED every existing staker's share of
    ///         the same epoch's rewards. The dilution accrued to the extender;
    ///         the fee that was supposed to compensate for it accrued to treasury.
    ///         Stakers got nothing for absorbing the dilution.
    ///
    ///         By splitting the extend fee between treasury and the existing-staker
    ///         reward pool, the diluted parties capture some of the fee in proportion
    ///         to their pre-extend share. Governance picks the split via 48h timelock
    ///         on TegridyStakingAdmin (`proposeExtendFeeRecycle` →
    ///         `executeExtendFeeRecycle`). Capped at `BPS` (100% recycle).
    ///
    ///         Storage layout: APPENDED — does not reshuffle existing slots.
    uint256 public extendFeeRecycleBps;


    // ─── Events ───────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 lockDuration, uint256 boostBps);
    event Withdrawn(address indexed user, uint256 indexed tokenId, uint256 amount);
    event EarlyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 penalty);
    event RewardPaid(address indexed user, uint256 indexed tokenId, uint256 reward);
    event AutoMaxLockToggled(uint256 indexed tokenId, bool enabled);
    event RewardAdded(uint256 amount);
    event RewardRateUpdated(uint256 newRate);
    event PenaltySentToTreasury(uint256 indexed tokenId, uint256 penaltyAmount); // AUDIT FIX L-16: Renamed from PenaltyRedistributed — penalty goes to treasury
    event EmergencyWithdraw(address indexed user, uint256 indexed tokenId, uint256 amount); // SECURITY FIX #12
    event TreasuryUpdated(address oldTreasury, address newTreasury); // SECURITY FIX #19
    event LockExtended(uint256 indexed tokenId, uint256 newLockDuration, uint256 newLockEnd);
    event BoostRevalidated(uint256 indexed tokenId, bool hasJbacBoost, uint256 newBoostedAmount); // AUDIT FIX #16
    /// @notice AUDIT FIX M-5 (battle-tested): emitted when a contract other than the
    ///         registered restakingContract receives a second+ staking NFT.
    event MultipleNFTsAtAddress(address indexed holder, uint256 newTokenId, uint256 priorTokenId);
    event EmergencyExitPosition(address indexed user, uint256 indexed tokenId, uint256 amount); // AUDIT FIX C-05
    event EmergencyExitRequested(address indexed user, uint256 indexed tokenId, uint256 executeAfter); // AUDIT FIX C-05
    event EmergencyExitCancelled(address indexed user, uint256 indexed tokenId); // AUDIT FIX C-05
    event AmountIncreased(uint256 indexed tokenId, uint256 addedAmount, uint256 newTotal);
    event RewardsForfeited(address indexed user, uint256 amount); // AUDIT FIX C-02
    /// @notice AUDIT MICROSCOPE_2026_04_30 C3/C4 + DEEP-DS-02/03/11: emitted when a
    ///         permissionless caller forces lazy decay of an expired position via `kick()`.
    event PositionKicked(uint256 indexed tokenId, address indexed kicker, uint256 boostDecayed);
    // AUDIT FIX: DS2-01/DS2-02 — kick-specific shortfall observability so off-chain
    // monitors can distinguish a kick-time forfeit from the user-initiated `_getReward`
    // path. Holder remains entitled to the corresponding `unsettledRewards` slice that
    // was actually credited; the shortfall amounts here are the irrecoverable portions.
    event KickRewardPoolShortfall(address indexed holder, uint256 expected, uint256 available);
    // AUDIT FIX DS3-01: parallel event for the _settleRewardsOnTransfer path so
    // off-chain monitors see the under-funded-pool slice on both kick() and
    // NFT-transfer code shapes. DS2-02 added the kick() event; this one
    // closes the missing sibling.
    event TransferRewardPoolShortfall(address indexed holder, uint256 expected, uint256 available);
    // AUDIT FIX DS3-03: distinct event for the settled-to-unsettled path —
    // RewardPaid implies a real wallet transfer (only emitted in `_getReward`),
    // RewardSettledToUnsettled means rewards were booked into the unsettled
    // mapping and await a `claimUnsettled()` call.
    event RewardSettledToUnsettled(address indexed holder, uint256 indexed tokenId, uint256 amount);
    /// @notice AUDIT FIX C-1: emitted when the restaking contract pulls the
    ///         per-tokenId share via `claimUnsettledForTokenId`.
    event UnsettledClaimedForTokenId(uint256 indexed tokenId, address indexed recipient, uint256 amount);
    // AUDIT FIX (pass-8 batch-14): JbacReturned / JbacStranded events moved to
    // TegridyStakingJbacVault — the vault is the emitter post-split.
    event JbacVaultSet(address indexed vault);
    /// @notice AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH] —
    ///         emitted when the outer `vault.returnJbac` call from
    ///         `_clearPosition` reverts. TOWELI principal withdraw still
    ///         succeeds; the JBAC return is deferred to `retryReturnJbacFromVault`.
    event JbacReturnDeferred(uint256 indexed stakingTokenId, address indexed to, uint256 jbacTokenId);
    /// @notice AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH] —
    ///         emitted on a successful retry of a previously-deferred JBAC return.
    ///         Note: a "successful retry" means the vault call did not revert; the
    ///         JBAC itself may now be stranded INSIDE the vault (claimable via
    ///         `vault.claimStrandedJbac`) if the inner JBAC transfer failed.
    event JbacReturnRetried(uint256 indexed stakingTokenId, address indexed to, uint256 jbacTokenId);
    /// @notice AUDIT C5: emitted when an extend-lock / autoMaxLock fee is collected to treasury.
    event ExtendFeeCollected(uint256 indexed tokenId, address indexed payer, uint256 amount);
    /// @notice AUDIT M-AUDIT-2026-1: emitted on every extend-fee charge with the split
    ///         between treasury and the recycled-to-stakers slice. `recycled == 0` when
    ///         `extendFeeRecycleBps == 0`, preserving the AUDIT C5 NatSpec story.
    event ExtendFeeSplit(uint256 indexed tokenId, address indexed payer, uint256 toTreasury, uint256 recycledToStakers);
    /// @notice AUDIT C6: emitted on early-withdrawal penalty distribution.
    event PenaltySplit(uint256 indexed tokenId, uint256 toTreasury, uint256 recycledToStakers);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error LockTooShort();
    error LockTooLong();
    error AlreadyStaked();
    error NoPosition();
    error NotPositionOwner();
    error LockNotExpired();
    error LockExpired(); // L-01 FIX: Semantically correct error for expired lock rejection
    error RateTooHigh(); // SECURITY FIX #13
    error AlreadyHasPosition(); // AUDIT FIX #2: Prevent _update() from overwriting userTokenId
    error StakeTooSmall(); // AUDIT FIX #33: Minimum stake enforcement
    error LockNotExtended(); // extendLock: new duration must be longer
    error FundAmountTooSmall(); // AUDIT FIX #61: notifyRewardAmount() minimum enforcement
    error LockStillActive(); // AUDIT FIX C-05: emergencyExitPosition requires expired lock
    error EmergencyExitNotRequested(); // AUDIT FIX C-05: must call requestEmergencyExit first
    error EmergencyExitDelayNotElapsed(); // AUDIT FIX C-05: 7-day delay not yet passed
    error EmergencyExitAlreadyRequested(); // AUDIT FIX C-05: prevent duplicate requests
    error TransferCooldownActive();
    // SIZE FIX: Custom errors replacing require strings (saves ~120 bytes)
    error BoostOverflow();
    error MustUseWithdraw();
    error Unauthorized();
    error TransferRateLimited();
    error CannotSweepRewardToken();
    error ZeroBalance();
    error IntOverflow();
    error CapTooLow();
    error TooManyPositions(); // AUDIT FIX M-5: per-holder position cap (MAX_POSITIONS_PER_HOLDER)
    error JbacDeposited(); // AUDIT H-1: revalidateBoost not allowed on deposit-based positions
    error ExtendFeeTooHigh(); // AUDIT C5
    error PenaltyRecycleTooHigh(); // AUDIT C6
    error ExtendFeeRecycleTooHigh(); // AUDIT M-AUDIT-2026-1
    // AUDIT FIX (pass-8 batch-14): OnlyJbacNFT moved to TegridyStakingJbacVault
    // (the vault is now the JBAC-receive surface).
    /// @dev AUDIT FIX (pass-8 batch-14): JBAC vault one-shot wiring guard.
    error JbacVaultAlreadySet();
    error NotRewardNotifier(); // SIZE-OPT: replaces revert("NOT_NOTIFIER")
    error NoOpKick(); // AUDIT FIX: DEEP-DS-07 — kick on non-expired or already-decayed position
    error KickWouldForfeit(); // AUDIT FIX (BATCH-J2 H8): kick aborted to avoid reward destruction
    error PendingLendingPositions(); // AUDIT FIX: DEEP-DS-10 — revoking lending while NFTs escrowed
    error NotAContract(); // AUDIT FIX: DEEP-DS-12 — first-time admin setter must be a contract
    error PendingRestakingPositions(); // AUDIT FIX FRESH-2026: M-28/F-35-1/F-65-1 — symmetric guard for restaking rotation
    /// @notice AUDIT FIX 2026-05-16 H1: rotation guard — old restaking contract still has
    ///         unsettledRewards residue. After rotation `_isTrackedHolder(oldRestaking)`
    ///         flips false, bricking `claimUnsettledForTokenId(oldRestaking, ...)` and
    ///         stranding per-tokenId reward attribution for every restaker with a
    ///         residual claim. Must drain via the OLD restaking contract BEFORE rotation.
    error PendingRestakingResidue();
    /// @notice AUDIT FIX 2026-05-16 M12: symmetric residue guard for lending-contract
    ///         revocation. Same shape as PendingRestakingResidue — `_isTrackedHolder`
    ///         flips false on revoke and bricks per-tokenId pull.
    error PendingLendingResidue();
    error CapTooHigh(); // AUDIT FIX FRESH-2026: F-35-3 — applyMaxUnsettledRewards sanity ceiling
    /// @notice AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH].
    error NoStrandedJbacAtVault();
    /// @notice AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH].
    error NotStrandedOwner();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _rewardToken,
        address _jbacNFT,
        address _treasury,
        uint256 _rewardRate
    ) OwnableNoRenounce(msg.sender) {
        // AUDIT FIX (pass-8 batch-14): Solady ERC721 has no constructor-args
        // surface for name/symbol; overridden as constant `name()` / `symbol()`
        // returns below.
        if (_rewardToken == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_rewardRate > MAX_REWARD_RATE) revert RateTooHigh();
        rewardToken = IERC20(_rewardToken);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        rewardRate = _rewardRate;
        lastUpdateTime = block.timestamp;
    }

    /// @notice One-shot wire of the JBAC vault sister contract.
    /// @dev    AUDIT FIX (pass-8 batch-14). Mirrors the `setStakingAdmin` /
    ///         `setRestakingContract` one-shot pattern: rejects zero address,
    ///         requires a contract, locked once set. Vault must be deployed
    ///         pointing back at THIS contract (vault constructor takes
    ///         `staking` as immutable arg).
    function setJbacVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        if (jbacVault != address(0)) revert JbacVaultAlreadySet();
        // AUDIT FIX FRESH-2026 (post-fix scan3 EIP-7702 retrofit): length-23 carve-out.
        uint256 codeLen = _vault.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        jbacVault = _vault;
        emit JbacVaultSet(_vault);
    }

    /// @notice Retry a JBAC return that was deferred because the outer
    ///         `vault.returnJbac` call from `_clearPosition` reverted (e.g.,
    ///         mis-wired vault, transient vault gas blow-up, post-deploy ABI
    ///         regression). Only the recorded entitled owner can retry.
    /// @dev    AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH] —
    ///         mirrors `TegridyStakingJbacVault.claimStrandedJbac` one level up.
    ///         Storage delete happens BEFORE the external vault call so a
    ///         reentrant retry from inside a malicious vault re-enters with no
    ///         stranded record and immediately reverts via the
    ///         `NoStrandedJbacAtVault` guard (defense-in-depth on top of
    ///         `nonReentrant`). If the vault call still reverts, the entire
    ///         tx rolls back including the deletes, preserving the stranded
    ///         record for a future retry. Intentionally NOT pause-gated —
    ///         a user recovering their stranded JBAC during a global pause
    ///         should not be additionally blocked (mirrors vault path).
    /// @param stakingTokenId The staking NFT ID whose JBAC return was deferred.
    function retryReturnJbacFromVault(uint256 stakingTokenId) external nonReentrant {
        address to = strandedJbacAtVaultOwner[stakingTokenId];
        uint256 jId = strandedJbacAtVaultId[stakingTokenId];
        if (to == address(0)) revert NoStrandedJbacAtVault();
        if (msg.sender != to) revert NotStrandedOwner();
        delete strandedJbacAtVaultOwner[stakingTokenId];
        delete strandedJbacAtVaultId[stakingTokenId];
        // No try/catch: if vault still reverts, the whole tx (including the
        // deletes above) rolls back, so the stranded record is preserved.
        ITegridyStakingJbacVault(jbacVault).returnJbac(stakingTokenId, jId, to);
        emit JbacReturnRetried(stakingTokenId, to, jId);
    }

    // V2: Simplified — dead penalty variables removed
    function _reserved() internal view returns (uint256) {
        return totalStaked + totalUnsettledRewards;
    }

    /// @notice V2: Lazy boost decay — zero out boostedAmount for expired locks on interaction.
    ///         Prevents expired positions from diluting active stakers' rewards.
    ///         Pattern: Curve veCRV uses linear decay; we use cliff decay (zero on expiry).
    function _decayIfExpired(uint256 tokenId, Position storage p) internal {
        if (p.boostedAmount > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
            totalBoostedStake -= p.boostedAmount;
            p.boostedAmount = 0;
            _writeCheckpoint(ownerOf(tokenId));
            _writeTotalBoostedStakeCheckpoint(); // AUDIT REV-M-01
        }
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Calculate boost for a lock duration (linear: 0.4x at 7d, 4.0x at 4yr)
    /// @param _duration Lock duration in seconds
    /// @return Boost in basis points (4000 = 0.4x, 40000 = 4.0x)
    function calculateBoost(uint256 _duration) public pure returns (uint256) {
        if (_duration <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
        if (_duration >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
        uint256 range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
        uint256 boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
        uint256 elapsed = _duration - MIN_LOCK_DURATION;
        return MIN_BOOST_BPS + (elapsed * boostRange) / range;
    }

    /// @notice Voting power for governance = amount x boost (including JBAC bonus),
    ///         aggregated across every staking NFT currently owned by `user`.
    /// @dev AUDIT FIX M-5 (full aggregation): prior implementation consulted only
    ///      `userTokenId[user]`, which is overwritten on every inbound transfer. Holders
    ///      with multiple staking NFTs (contract wallets, Safes, aggregating vaults) had
    ///      their voting power silently undercounted — only the most recently received
    ///      position was visible. We now iterate `_positionsByOwner[user]` (an
    ///      EnumerableSet.UintSet maintained in `_update`) and sum the active voting
    ///      power of every position owned. The per-holder cap of MAX_POSITIONS_PER_HOLDER
    ///      bounds the O(n) iteration; in practice checkpoint writes on the push side cost
    ///      ~130k at the cap vs ~100k for a single-position holder.
    ///
    ///      Special case: the restakingContract aggregates per-restaker voting power via
    ///      its own internal bookkeeping (see TegridyRestaking). Summing the raw positions
    ///      it holds would double-count with that per-restaker aggregation, so this path
    ///      returns 0 and leaves restaked voting power to the restaking contract to expose.
    ///
    ///      Integrators that accept multiple staking NFTs now DO receive correct aggregate
    ///      voting power from this view — the `MultipleNFTsAtAddress` event remains emitted
    ///      as a convenience signal for indexers, not a regression warning.
    /// @param user The address to query voting power for
    /// @return total Aggregated voting power (sum of amount * boostBps / BOOST_PRECISION)
    ///         across all active, non-expired positions held by `user`.
    function votingPowerOf(address user) public view returns (uint256 total) {
        // AUDIT FIX M-5: the restaking contract exposes per-restaker voting power via
        // its own aggregation; a raw sum here would double-count. Force 0 for the
        // restaking contract so governance consumers route through the restaking path.
        // AUDIT FIX FRESH-2026: STAKING-MAX-POS-ESCROW-CARVE-OUT [CRITICAL] —
        //         lending contracts are escrow addresses that legitimately hold
        //         many borrower NFTs. Borrowers vote via their own checkpoints
        //         (positions remain credited to the borrower's checkpoint via
        //         _settleRewardsOnTransfer), not via the lending contract. Force
        //         0 here to prevent O(n_loans) iteration once the per-holder cap
        //         is lifted for these addresses, AND to prevent double-counting
        //         any future governance consumer that mistakenly reads from the
        //         escrow address.
        if (user == restakingContract || isLendingContract[user]) return 0;

        EnumerableSet.UintSet storage set = _positionsByOwner[user];
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        for (uint256 i; i < len; ++i) {
            // Reach into storage per-field rather than copying the full Position struct —
            // avoids loading `boostedAmount`, `rewardDebt`, `lockDuration`, `autoMaxLock`,
            // `hasJbacBoost`, `stakeTimestamp` slots that voting power doesn't need.
            Position storage p = positions[set.at(i)];
            uint256 amount = p.amount;
            if (amount == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            total += (amount * p.boostBps) / BOOST_PRECISION;
        }
    }

    // votingPowerAt() removed — use votingPowerAtTimestamp() instead

    /// @notice Voting power at a specific timestamp using OZ Checkpoints.Trace208.
    /// @param user The address to query historical voting power for
    /// @param ts The timestamp to look up
    /// @return Voting power at the given timestamp (0 if no checkpoint exists before that time)
    function votingPowerAtTimestamp(address user, uint256 ts) public view returns (uint256) {
        return _checkpoints[user].upperLookup(SafeCast.toUint48(ts));
    }

    /// @notice Number of checkpoints for a user
    function numCheckpoints(address user) external view returns (uint256) {
        return _checkpoints[user].length();
    }

    /// @notice AUDIT REV-M-01 (MEDIUM, 2026-04-28): historical totalBoostedStake at `ts`.
    ///         Returns 0 if no checkpoint exists at or before `ts`. Same semantics as
    ///         `votingPowerAtTimestamp` — uses OZ `Checkpoints.Trace208.upperLookup` so
    ///         a same-block stake (checkpoint key == block.timestamp) is EXCLUDED from a
    ///         `block.timestamp - 1` read. Consumed by RevenueDistributor._distribute to
    ///         pin the epoch denominator at T-1 and close the same-block dilution window
    ///         that REV C-01 left half-open.
    function totalBoostedStakeAtTimestamp(uint256 ts) external view returns (uint256) {
        return _totalBoostedStakeCheckpoints.upperLookup(SafeCast.toUint48(ts));
    }

    /// @notice AUDIT REV-M-01: number of `_totalBoostedStakeCheckpoints` entries.
    ///         Exposed for off-chain integrators / dashboards to size pagination.
    function totalBoostedStakeNumCheckpoints() external view returns (uint256) {
        return _totalBoostedStakeCheckpoints.length();
    }

    /// @dev AUDIT REV-M-01: write `totalBoostedStake` to the system-wide Trace208
    ///      checkpoint at the current block.timestamp. Mirrors the per-user
    ///      `_writeCheckpoint(user)` no-op-on-unchanged pattern (NEW-S7) so we don't
    ///      bloat checkpoints when a delta nets to zero (e.g., `_applyNewBoost` that
    ///      decrements then increments the identical amount on a no-op boost rewrite).
    function _writeTotalBoostedStakeCheckpoint() internal {
        uint208 newTotal = SafeCast.toUint208(totalBoostedStake);
        uint208 last = _totalBoostedStakeCheckpoints.latest();
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (last == newTotal) return;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        _totalBoostedStakeCheckpoints.push(SafeCast.toUint48(block.timestamp), newTotal);
    }

    /// @notice AUDIT H12: amount-weighted average active boost across all of `user`'s
    ///         positions. Returns 0 if no active positions. Used by integrators (e.g.,
    ///         TegridyLPFarming) that need a single boost ratio per user — bypasses the
    ///         single-pointer `userTokenId` undercount for multi-NFT contract holders.
    /// @return weightedBps amount-weighted boostBps in [MIN_BOOST_BPS, MAX_BOOST_BPS+JBAC_BONUS_BPS]
    function aggregateActiveBoostBps(address user) external view returns (uint256 weightedBps) {
        // AUDIT FIX FRESH-2026: STAKING-MAX-POS-ESCROW-CARVE-OUT [CRITICAL] —
        //         same rationale as votingPowerOf above. Prevent O(n_loans)
        //         iteration on lending-contract addresses now that the per-holder
        //         cap is lifted for escrow addresses.
        if (user == restakingContract || isLendingContract[user]) return 0;
        EnumerableSet.UintSet storage set = _positionsByOwner[user];
        uint256 len = set.length();
        uint256 nowTs = block.timestamp;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 totalAmount;
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 totalBoosted;
        for (uint256 i; i < len; ++i) {
            Position storage p = positions[set.at(i)];
            uint256 amt = p.amount;
            if (amt == 0) continue;
            if (nowTs >= p.lockEnd) continue;
            totalAmount += amt;
            totalBoosted += amt * p.boostBps;
        }
        if (totalAmount == 0) return 0;
        weightedBps = totalBoosted / totalAmount;
    }

    /// @notice AUDIT M13: returns true iff `user` currently owns `tokenId` per the
    ///         per-owner position set (the source of truth for multi-NFT holders).
    ///         Closes the bypass where a contract receiver overwrites userTokenId on
    ///         transfer but still holds the prior NFT — prior `userTokenId` checks
    ///         silently passed even when the NFT was still in the user's possession.
    function holdsToken(address user, uint256 tokenId) external view returns (bool) {
        return _positionsByOwner[user].contains(tokenId);
    }

    /// @notice AUDIT H12 / M13: number of staking NFTs `user` currently holds.
    function userPositionCount(address user) external view returns (uint256) {
        return _positionsByOwner[user].length();
    }

    /// @notice Pending rewards for a position
    /// @param tokenId The NFT token ID of the staking position
    /// @return Claimable reward tokens for this position
    function earned(uint256 tokenId) public view returns (uint256) {
        Position memory p = positions[tokenId];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (p.boostedAmount == 0) return 0;
        // AUDIT FIX M-01: Expired positions still have claimable rewards accrued before expiry.
        // _getReward() computes rewards BEFORE _decayIfExpired zeros boostedAmount, so earned()
        // must mirror that by including expired positions. Removes the early return that was
        // causing the frontend to show 0 pending rewards for expired locks.
        uint256 currentAcc = rewardPerTokenStored;
        if (block.timestamp > lastUpdateTime && totalBoostedStake > 0) {
            currentAcc += ((block.timestamp - lastUpdateTime) * rewardRate * ACC_PRECISION) / totalBoostedStake;
        }
        int256 diff = int256((p.boostedAmount * currentAcc) / ACC_PRECISION) - p.rewardDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    // earnedByAddress() removed — use earned(userTokenId[user]) directly

    /// @notice Get position details
    function getPosition(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, bool canWithdraw
    ) {
        Position memory p = positions[tokenId];
        return (p.amount, p.boostBps, p.lockEnd, p.lockDuration, p.autoMaxLock,
                p.amount > 0 && block.timestamp >= p.lockEnd);
    }

    // ─── Modifiers ────────────────────────────────────────────────────

    /// @dev Accumulate pending rewards into rewardPerTokenStored and advance lastUpdateTime.
    /// @dev AUDIT FIX: DS2-04 — pause-aware accumulator. When `paused()`, emission is
    ///      frozen: `lastUpdateTime` advances to `block.timestamp` (so post-unpause
    ///      elapsed measures from the unpause moment, not the pre-pause moment) but
    ///      `rewardPerTokenStored` is NOT advanced. Without this guard, any reward-
    ///      touching call IMMEDIATELY after unpause would credit the entire pause
    ///      window's `elapsed * rewardRate` to whoever was first to act — letting the
    ///      front-running claimer capture pause-window emission that the protocol
    ///      explicitly froze. Mirrors Compound `Comptroller.setMintPaused` semantics.
    function _accumulateRewards() private {
        uint256 _totalBoosted = totalBoostedStake;
        if (block.timestamp > lastUpdateTime && _totalBoosted > 0 && !paused()) {
            uint256 elapsed = block.timestamp - lastUpdateTime;
            uint256 reward = elapsed * rewardRate;
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            if (available > reserved) {
                uint256 rewardPool = available - reserved;
                if (reward > rewardPool) reward = rewardPool;
            } else {
                reward = 0;
            }
            if (reward > 0) {
                rewardPerTokenStored += (reward * ACC_PRECISION) / _totalBoosted;
            }
        }
        // Advance even while paused so the next post-unpause call doesn't credit
        // the pause window. This is the "skip pause-window emission" half of the
        // Compound pattern.
        lastUpdateTime = block.timestamp;
    }

    modifier updateReward() {
        _accumulateRewards();
        _;
    }

    // ─── Pausable Admin ───────────────────────────────────────────────

    /// @notice AUDIT FIX #11/#19: Pause the contract (owner only)
    /// @dev AUDIT FIX: DS2-04 — crystallise pre-pause emission BEFORE flipping the
    ///      paused flag. After this point `_accumulateRewards` short-circuits while
    ///      `paused() == true` (only `lastUpdateTime` advances), so the pause window
    ///      contributes ZERO additional `rewardPerTokenStored`. Without the pre-pause
    ///      `_accumulateRewards()` call, the elapsed segment between the last
    ///      reward-touching call and the pause moment would be lost.
    function pause() external onlyOwner {
        _accumulateRewards();
        _pause();
    }

    /// @notice AUDIT FIX #11/#19: Unpause the contract (owner only)
    /// @dev AUDIT FIX: DS2-04 — reset `lastUpdateTime` so post-unpause emission
    ///      measures elapsed time from the unpause moment, not the pre-pause moment.
    ///      Defense-in-depth — `_accumulateRewards` already advances `lastUpdateTime`
    ///      while paused, but resetting here keeps the contract correct even if a
    ///      future change introduces a code path that skips the unconditional advance.
    function unpause() external onlyOwner {
        // AUDIT FIX DS3-07: move `lastUpdateTime = block.timestamp` BEFORE
        // `_unpause()` to close a TOCTOU window. Pre-fix, the order was unpause
        // then assign — if a future Pausable hook fired logic between
        // `_unpause()` and the assignment, that logic would observe the
        // unpaused state with the stale `lastUpdateTime`. With the assignment
        // first, any post-unpause callback already sees the correct anchor.
        lastUpdateTime = block.timestamp;
        _unpause();
    }

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Stake TOWELI. Mints an NFT representing the position. No JBAC boost.
    /// @dev AUDIT H-1 FIX (2026-04-20): Removed `jbacNFT.balanceOf(msg.sender) > 0` cache.
    ///      That pattern was flash-loan-able (borrow JBAC for one block, stake, return).
    ///      Users who want the JBAC bonus must call `stakeWithBoost(...)` which physically
    ///      deposits the JBAC into this contract for the lock duration.
    /// @param _amount Amount of TOWELI to stake (must be >= MIN_STAKE)
    /// @param _lockDuration Lock duration in seconds (MIN_LOCK_DURATION to MAX_LOCK_DURATION)
    function stake(uint256 _amount, uint256 _lockDuration) external nonReentrant whenNotPaused updateReward {
        if (_amount == 0) revert ZeroAmount();
        if (_amount < MIN_STAKE) revert StakeTooSmall(); // AUDIT FIX #33
        if (_lockDuration < MIN_LOCK_DURATION) revert LockTooShort();
        if (_lockDuration > MAX_LOCK_DURATION) revert LockTooLong();
        if (userTokenId[msg.sender] != 0) revert AlreadyStaked();

        uint256 boost = calculateBoost(_lockDuration);
        // AUDIT H-1 (2026-04-20): No JBAC boost on stake(). Use stakeWithBoost() for that.
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        uint256 boosted = (_amount * boost) / BOOST_PRECISION;

        uint256 tokenId = _nextTokenId++;
        positions[tokenId] = Position({
            amount: _amount,
            boostedAmount: boosted,
            rewardDebt: _safeInt256((boosted * rewardPerTokenStored) / ACC_PRECISION),
            lockEnd: uint64(block.timestamp + _lockDuration),
            boostBps: uint16(boost),
            lockDuration: uint32(_lockDuration),
            autoMaxLock: false,
            hasJbacBoost: false,
            stakeTimestamp: uint64(block.timestamp),
            jbacTokenId: 0,
            jbacDeposited: false
        });

        totalStaked += _amount;
        totalBoostedStake += boosted;
        _writeTotalBoostedStakeCheckpoint(); // AUDIT REV-M-01
        // AUDIT L-22 / Spartan TF-10: totalLocked tracking removed — was redundant with totalStaked.

        _mint(msg.sender, tokenId); // _update() sets userTokenId[msg.sender] = tokenId
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);

        _writeCheckpoint(msg.sender); // AUDIT FIX #1
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit Staked(msg.sender, tokenId, _amount, _lockDuration, boost);
    }

    /// @notice Stake TOWELI with a JBAC-deposit boost. Mints an NFT representing the position.
    /// @dev AUDIT H-1 FIX (2026-04-20): ApeCoin-Staking pattern — JBAC is physically deposited
    ///      into this contract and held until the position is unstaked. This replaces the
    ///      flash-loan-able `balanceOf > 0` check. JBAC is returned on withdraw/earlyWithdraw/
    ///      emergencyWithdrawPosition/emergencyExitPosition/executeEmergencyExit via
    ///      `_returnJbac()` (called AFTER `_clearPosition` per CCR-01 reorder, pass-8).
    ///      Legacy `hasJbacBoost=true` positions (created before this fix) are NOT migrated —
    ///      they are grandfathered with `jbacDeposited=false`.
    /// @param _amount Amount of TOWELI to stake (must be >= MIN_STAKE)
    /// @param _lockDuration Lock duration in seconds (MIN_LOCK_DURATION to MAX_LOCK_DURATION)
    /// @param _jbacTokenId The JBAC tokenId to deposit for the boost (must be owned by caller, approved to this contract)
    function stakeWithBoost(uint256 _amount, uint256 _lockDuration, uint256 _jbacTokenId)
        external nonReentrant whenNotPaused updateReward
    {
        if (_amount == 0) revert ZeroAmount();
        if (_amount < MIN_STAKE) revert StakeTooSmall();
        if (_lockDuration < MIN_LOCK_DURATION) revert LockTooShort();
        if (_lockDuration > MAX_LOCK_DURATION) revert LockTooLong();
        if (userTokenId[msg.sender] != 0) revert AlreadyStaked();
        // AUDIT FIX FRESH-2026 M3: reject `_jbacTokenId == 0` at input. Both
        // `_clearPosition` (`if (jbacIdToReturn != 0)`) and the vault's
        // `returnJbac` (`if (jbacTokenId == 0) return`) use 0 as a "no JBAC"
        // sentinel. If the JBAC collection happens to mint tokenId 0
        // (BAYC/MAYC/CryptoPunks-derivative pattern), depositing it via this
        // function lands the NFT in the vault but BOTH return paths
        // short-circuit on the sentinel — permanent strand. Vault's
        // `claimStrandedJbac` already notes this with the same defensive
        // `jId == 0` revert. Mirror the input-side guard here so the strand
        // can never form in the first place.
        if (_jbacTokenId == 0) revert ZeroAmount();

        uint256 boost = calculateBoost(_lockDuration) + JBAC_BONUS_BPS;
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        uint256 boosted = (_amount * boost) / BOOST_PRECISION;

        uint256 tokenId = _nextTokenId++;
        positions[tokenId] = Position({
            amount: _amount,
            boostedAmount: boosted,
            rewardDebt: _safeInt256((boosted * rewardPerTokenStored) / ACC_PRECISION),
            lockEnd: uint64(block.timestamp + _lockDuration),
            boostBps: uint16(boost),
            lockDuration: uint32(_lockDuration),
            autoMaxLock: false,
            hasJbacBoost: true,
            stakeTimestamp: uint64(block.timestamp),
            jbacTokenId: _jbacTokenId,
            jbacDeposited: true
        });

        totalStaked += _amount;
        totalBoostedStake += boosted;
        _writeTotalBoostedStakeCheckpoint(); // AUDIT REV-M-01

        _mint(msg.sender, tokenId); // _update() sets userTokenId[msg.sender] = tokenId
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        // AUDIT FIX (pass-8 batch-14): JBAC custody handed off to the vault.
        // User approves THIS contract for the JBAC (unchanged UX); `safeTransferFrom`
        // pulls from the user using the staking-side approval, and lands at the
        // vault (which has its own `onERC721Received` gating to the configured
        // jbacNFT). Stranded-reclaim path lives on the vault.
        if (jbacVault == address(0)) revert ZeroAddress();
        jbacNFT.safeTransferFrom(msg.sender, jbacVault, _jbacTokenId);

        _writeCheckpoint(msg.sender);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit Staked(msg.sender, tokenId, _amount, _lockDuration, boost);
    }

    /// @notice Toggle auto-max-lock. When enabled, lock auto-extends on every claim.
    /// @dev    AUDIT C5: enabling autoMaxLock charges the extendFeeBps fee (default 0)
    ///         since it permanently maximises boost. Disabling is free.
    /// @dev    AUDIT NOTE FRESH-2026: F-02-K-06 [INFO] — enabling autoMaxLock
    ///         unconditionally rewrites `p.lockDuration = MAX_LOCK_DURATION`.
    ///         Future `revalidateBoost` JBAC-loss DOWNGRADE will compute boost
    ///         via `calculateBoost(p.lockDuration) = MAX_BOOST_BPS` not the
    ///         user's original chosen duration. Disabling autoMaxLock does NOT
    ///         restore original lockDuration. By design (perpetual MAX), but
    ///         users who toggled then want a shorter conceptual lock must
    ///         withdraw and re-stake fresh.
    function toggleAutoMaxLock(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        bool wasOn = p.autoMaxLock;
        // AUDIT FIX DS3-02: completes the LockExpired guard family (DS-06 on
        // extendLock, DS2-07 on revalidateBoost) — toggleAutoMaxLock's enable
        // path was the missed third sibling. The enable branch below extends
        // `lockEnd` to MAX and pays an extend fee, which on an already-expired
        // position is the equivalent of reviving a dead lock for free boost.
        // Reject the enable path on expired positions; users must `withdraw`
        // and re-stake fresh to restore boost.
        if (!wasOn && p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
        p.autoMaxLock = !wasOn;

        // If enabling, extend lock to max immediately
        if (p.autoMaxLock) {
            // AUDIT C5: charge fee on enable (boost is being increased to max). No fee on
            // disable (boost is being relinquished). Pulls TOWELI from caller; user must
            // approve. Default extendFeeBps == 0 means no transfer attempted.
            // AUDIT FIX 2026-05-17 M10-REVISED: pass `p` so the helper can pre-advance
            // the caller's rewardDebt, cancelling their share of the recycled fee
            // before the immediately-following `_getReward` claim runs. The original
            // 2026-05-16 fix used a denominator-exclusion bump that over-credited
            // the global accumulator — see `_chargeExtendFee` NatSpec.
            _chargeExtendFee(tokenId, p.amount, p);
            // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
            _getReward(tokenId, p);
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
            p.lockDuration = uint32(MAX_LOCK_DURATION);
            // SECURITY FIX #4: Only recalculate lock-duration boost, keep cached JBAC status
            // from stake time to prevent flash-loan JBAC boost manipulation
            uint256 newBoost = MAX_BOOST_BPS;
            if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
            _applyNewBoost(p, newBoost);
        }

        _writeCheckpoint(msg.sender); // AUDIT FIX #1
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit AutoMaxLockToggled(tokenId, p.autoMaxLock);
    }

    /// @notice Extend the lock duration of an existing position
    /// @dev    AUDIT C5: charges extendFeeBps fee (default 0). Caller must approve TOWELI
    ///         before calling. The fee covers the protocol's exposure to dilution that
    ///         this extension creates for other stakers.
    /// @param tokenId The NFT token ID of the staking position
    /// @param _newLockDuration New lock duration in seconds (must be longer than current)
    function extendLock(uint256 tokenId, uint256 _newLockDuration) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        // AUDIT FIX FRESH-2026: F-02-K-03 [LOW] — compare against the resulting
        // lockEnd, not the original duration. Without this, a user who staked
        // with a long original duration and is now mid-lock cannot extend even
        // when the new lockEnd would push past the current one — they are
        // forced to use the autoMaxLock workaround.
        if (block.timestamp + _newLockDuration <= p.lockEnd) revert LockNotExtended();
        if (_newLockDuration > MAX_LOCK_DURATION) revert LockTooLong();
        // AUDIT FIX: DEEP-DS-06 — reject expired positions, mirroring increaseAmount.
        // Without this, a user can revive a decayed position by paying the fee on stale
        // principal and re-anchoring rewardDebt, sidestepping the documented
        // "use it or lose it" model. User must withdraw → re-stake to re-enter.
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

        // AUDIT C5: charge extend fee before any state changes. No-op when extendFeeBps == 0.
        // AUDIT FIX 2026-05-17 M10-REVISED: DEEP-DS-09 closed via debt-advance
        // pattern. `_chargeExtendFee` bumps `rewardPerTokenStored` normally then
        // pre-advances `p.rewardDebt` so the immediately-following `_getReward`
        // cancels out the caller's own share of the bump — no over-credit (the
        // 2026-05-16 fix using denominator-exclusion bumped > `recycled` total).
        _chargeExtendFee(tokenId, p.amount, p);

        // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
        _getReward(tokenId, p);

        p.lockDuration = uint32(_newLockDuration);
        p.lockEnd = uint64(block.timestamp + _newLockDuration);

        uint256 newBoost = calculateBoost(_newLockDuration);
        if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
        _applyNewBoost(p, newBoost);

        _writeCheckpoint(msg.sender); // AUDIT FIX #1
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit LockExtended(tokenId, _newLockDuration, p.lockEnd);
    }

    /// @notice Add more TOWELI to an existing staking position without withdrawing.
    /// @param tokenId The NFT token ID of the staking position
    /// @param _additionalAmount Amount of TOWELI to add (must be >= MIN_STAKE)
    function increaseAmount(uint256 tokenId, uint256 _additionalAmount) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (_additionalAmount == 0) revert ZeroAmount();
        if (_additionalAmount < MIN_STAKE) revert StakeTooSmall(); // AUDIT FIX: prevent dust spam
        // AUDIT FIX: reject increase on expired positions — would create zombie boosted stake
        // that dilutes all active stakers' rewards without earning anything
        // L-01 FIX: Error name was semantically inverted — lock HAS expired, not "not expired"
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

        // Claim pending rewards before changing position (_getReward handles decay internally)
        _getReward(tokenId, p);

        // Update amounts
        totalStaked += _additionalAmount;
        p.amount += _additionalAmount;
        // AUDIT FIX FRESH-2026: STAKING-INC-AML-DOWNGRADE — extend lockEnd FIRST
        //         for autoMaxLock users so the F-02-K-04 boost clamp computes
        //         `remaining` against the post-extend horizon. Pre-fix the order
        //         was inverted: `effectiveBoost = min(calculateBoost(pre-extend
        //         remaining), cachedBoost)` then lockEnd extended to MAX. An
        //         autoMaxLock user who topped up after their last `getReward` had
        //         decayed `remaining` silently downgraded to (e.g.) 2.2× even
        //         though the lockEnd was just refreshed to MAX. Mirrors the
        //         `extendLock` order (line 927: lockEnd updated before boost
        //         computation at line 929).
        if (p.autoMaxLock) {
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
            p.lockDuration = uint32(MAX_LOCK_DURATION);
        }
        // AUDIT FIX FRESH-2026: F-02-K-04 [LOW] — clamp boost on combined principal
        // to whatever the REMAINING lock time would justify. Previously the
        // original `boostBps` was retro-applied to the new principal, fee-free,
        // letting a whale dribble in additional stake at MAX boost in the final
        // days of a long lock — bypassing `extendFeeBps` for top-ups. We use the
        // SMALLER of cached `boostBps` and the boost derivable from current
        // remaining lock time. Existing-principal earned its rate honestly so
        // we never raise above cached; new principal earns only what the
        // remaining lock supports.
        uint256 cachedBoost = uint256(p.boostBps);
        uint256 remaining = p.lockEnd > block.timestamp ? p.lockEnd - block.timestamp : 0;
        uint256 remainingBoost = calculateBoost(remaining);
        if (p.hasJbacBoost) remainingBoost += JBAC_BONUS_BPS;
        uint256 effectiveBoost = remainingBoost < cachedBoost ? remainingBoost : cachedBoost;
        _applyNewBoost(p, effectiveBoost);

        // Transfer tokens
        rewardToken.safeTransferFrom(msg.sender, address(this), _additionalAmount);

        // Update voting power
        _writeCheckpoint(msg.sender);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit AmountIncreased(tokenId, _additionalAmount, p.amount);
    }

    /// @notice Withdraw after lock expires. No penalty. Burns the position NFT.
    /// @param tokenId The NFT token ID of the staking position to withdraw
    function withdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.lockEnd) revert LockNotExpired();
        // AUDIT FIX: DEEP-DS-01 — DO NOT pre-decay before _getReward. The pre-decay
        // call was a vestige from before AUDIT M-01 and defeated that fix on the
        // most common exit path. _getReward handles decay AFTER computing rewards.
        _getReward(tokenId, p);

        // AUDIT FIX (pass-8 batch-9 / batch-14): JBAC capture + post-burn return
        // lives inside `_clearPosition`. CCR-01 invariant: NFT is burned BEFORE
        // the JBAC `safeTransferFrom` callback fires, so any cross-contract
        // reentrant `transferFrom`/`acceptOffer` reverts on the empty _ownerOf
        // slot. See `_clearPosition` natspec for the full invariant statement.
        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
        emit Withdrawn(msg.sender, tokenId, amount);
    }

    /// @notice Early withdrawal — 25% penalty sent to treasury.
    /// @dev AUDIT FIX L-23: Corrected comment — penalty goes to treasury, not redistributed to stakers.
    /// @param tokenId The NFT token ID of the staking position to early-withdraw
    function earlyWithdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        // SECURITY FIX H-3: Prevent accidental 25% penalty on already-unlockable positions.
        // Users with expired locks should use withdraw() (no penalty) instead.
        if (block.timestamp >= p.lockEnd) revert MustUseWithdraw();

        _getReward(tokenId, p);

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        uint256 amount = _clearPosition(tokenId, p);
        uint256 penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS;
        uint256 userReceives = amount - penalty;
        totalPenaltiesCollected += penalty;

        // AUDIT C6: split penalty between treasury and active stakers per penaltyRecycleBps.
        // Default 0 = full amount to treasury (status quo). Owner can shift via timelock.
        (uint256 toTreasury, uint256 recycled) = _splitPenalty(penalty);
        if (toTreasury > 0) rewardToken.safeTransfer(treasury, toTreasury);
        if (recycled > 0) _creditRewardPool(recycled);
        rewardToken.safeTransfer(msg.sender, userReceives);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
        emit PenaltySplit(tokenId, toTreasury, recycled);
        emit PenaltySentToTreasury(tokenId, toTreasury); // legacy event for compatibility
        emit EarlyWithdrawn(msg.sender, tokenId, userReceives, penalty);
    }

    /// @notice Claim rewards without unstaking.
    /// @return claimed The amount of reward tokens transferred to the caller.
    /// @dev AUDIT H-AUDIT-2026-1 (HIGH): if the position's lock has already expired
    ///      when getReward fires, `_getReward` calls `_decayIfExpired` which zeros
    ///      `boostedAmount` (and decrements `totalBoostedStake`). Pre-fix, the
    ///      autoMaxLock branch then advanced `lockEnd` to MAX without restoring
    ///      `boostedAmount`, leaving the position locked forward but earning zero
    ///      forever — exit-able only via the 25% earlyWithdraw penalty. The fix
    ///      re-applies the max boost when autoMaxLock fires on a freshly-decayed
    ///      position, preserving the documented "set and forget — keep max boost
    ///      perpetually" semantic. `_applyNewBoost` handles the (now-zero)
    ///      boostedAmount delta correctly via its `totalBoostedStake -= ...` line.
    function getReward(uint256 tokenId) external nonReentrant whenNotPaused updateReward returns (uint256 claimed) {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        claimed = _getReward(tokenId, p);

        // Auto-max-lock: extend lock on every claim, restoring max boost if a
        // silent-past-expiry decay just zeroed boostedAmount (AUDIT H-AUDIT-2026-1).
        if (p.autoMaxLock) {
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
            p.lockDuration = uint32(MAX_LOCK_DURATION);
            // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
            // slither-disable-next-line incorrect-equality
            if (p.boostedAmount == 0 && p.amount > 0) {
                // AUDIT FIX FRESH-2026: H-2 [F-02-K-01] — Verify JBAC bonus is still
                // valid before restoring it on legacy `hasJbacBoost && !jbacDeposited`
                // positions. Without this gate, a user who lost their JBAC NFT
                // (transferred/sold) keeps the 5000 BPS bonus indefinitely once the
                // lock decays and autoMaxLock fires. `revalidateBoost`'s LockExpired
                // guard is one-way (DS2-07) so it cannot strip this on a position
                // whose lockEnd was just rewritten to `now + MAX_LOCK_DURATION`.
                // AUDIT FIX FRESH-2026: STAKING-AML-RESTAKE-JBAC — sibling-port
                //         from `revalidateBoost` lines 1303-1309. When the
                //         restaking contract calls `getReward(tokenId)`, msg.sender
                //         is the restaking contract — which never holds JBAC NFTs.
                //         Pre-fix, every legacy `hasJbacBoost && !jbacDeposited`
                //         restaked position silently lost its JBAC bonus on the
                //         first decay-restore even though the original depositor
                //         still held the JBAC NFT. Resolve to the actual depositor
                //         when the caller is the restaking contract.
                address jbacHolder = msg.sender;
                bool lookupOk = true;
                if (msg.sender == restakingContract && restakingContract != address(0)) {
                    try ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId) returns (address depositor) {
                        if (depositor != address(0)) jbacHolder = depositor;
                    } catch {
                        // AUDIT FIX FRESH-2026: F3-PERMA-STRIP — preserve cached
                        //         `hasJbacBoost` on transient lookup failure
                        //         (restaking upgrade, paused view, etc.).
                        //         Pre-fix the catch fell through to msg.sender
                        //         (= restaking contract, no JBAC) → jbacStillValid
                        //         = false → `p.hasJbacBoost = false` permanently
                        //         (no recovery path; revalidateBoost is one-way
                        //         downgrade). Now: skip the strip-on-fail branch
                        //         when we cannot prove holding/non-holding.
                        lookupOk = false;
                    }
                }
                bool jbacStillValid =
                    p.jbacDeposited ||
                    (p.hasJbacBoost && lookupOk && jbacNFT.balanceOf(jbacHolder) > 0);
                uint256 newBoost = MAX_BOOST_BPS;
                if (jbacStillValid) {
                    newBoost += JBAC_BONUS_BPS;
                } else if (p.hasJbacBoost && lookupOk) {
                    // Clear stale flag so future cycles agree with reality.
                    // Only clear when we successfully proved non-holding —
                    // otherwise leave the cached flag intact for next cycle.
                    p.hasJbacBoost = false;
                }
                _applyNewBoost(p, newBoost);
                _writeCheckpoint(msg.sender);
            }
        }

        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
    }

    // ─── AUDIT MICROSCOPE_2026_04_30 C3/C4: Permissionless Expired-Position Decay ──

    /// @notice Force the lazy-decay path on an expired position whose owner has not
    ///         interacted since `lockEnd`. Permissionless — anyone can call.
    /// @dev    Closes the architectural finding documented in
    ///         `.audit_101/MICROSCOPE_2026_04_30.md` C3 (snapshot/possession decoupling)
    ///         + C4 (stale checkpoint trace on expired locks). Pattern of record:
    ///         Curve `LiquidityGaugeV4.kick(addr)` permissionless poke.
    ///
    /// @dev    AUDIT FIX: DEEP-DS-02 — settle holder's pre-expiry rewards as
    ///         unsettled BEFORE decay, mirroring `_settleRewardsOnTransfer` (C-04).
    ///         Without this, _decayIfExpired zeros boostedAmount while leaving
    ///         rewardDebt unchanged, so subsequent _getReward hits the
    ///         `if (p.boostedAmount == 0) return 0;` short-circuit and the
    ///         holder's pre-expiry yield is permanently unreachable.
    /// @dev    AUDIT FIX: DEEP-DS-03 — `whenNotPaused` added so kick is symmetric
    ///         with the rest of the user-facing reward surface.
    /// @dev    AUDIT FIX: DEEP-DS-07 — fast-revert on phantom IDs and no-op kicks.
    /// @dev    AUDIT FIX: DEEP-DS-11 — `nonReentrant` added; load-bearing once
    ///         the DS-02 settle-unsettled path is in place.
    /// @dev    AUDIT FIX: DS2-01 + DS2-02 + DS2-03 — kick reward-preservation hardening.
    ///         (a) `p.rewardDebt` advance is deferred until AFTER `_settleUnsettled`
    ///         returns and is advanced by ONLY the actually-credited slice. If the
    ///         unsettled cap was saturated, the un-credited rewardDebt anchor stays
    ///         where it was — so the holder retains a future claim path once the
    ///         cap is raised or other claims drain `totalUnsettledRewards`.
    ///         (b) the rewardPool shortfall (`pending - cappedPending`) is now also
    ///         routed through `_settleUnsettled` (parity with `_getReward`'s post-
    ///         critique-5.1 path). When even the unsettled cap can't absorb it, a
    ///         loud `RewardsForfeitedDuringKick` event fires so off-chain monitors
    ///         see the forfeit; a `KickRewardPoolShortfall` event also fires when
    ///         `pending > rewardPool` so monitors detect under-funded reward pools.
    ///         (c) `_touch(holder)` runs whenever `unsettledRewards[holder]` was
    ///         written, mirroring DS-04 in `_settleRewardsOnTransfer` so the R014
    ///         M-9 inactivity-gate invariant is preserved on the kick path too.
    /// @dev    CALLER NOTICE (per DS2-06): Kick MOVES the holder's pre-expiry rewards
    ///         from "directly claimable via getReward" to "unsettled, claimable via
    ///         claimUnsettled" (paused-blockable, capped, may forfeit if either the
    ///         rewardPool or unsettled cap saturates). Holders who want full control
    ///         should call `getReward` BEFORE their lock expires. This function exists
    ///         to close the C3/C4 stale-checkpoint window when the holder is
    ///         unreachable or unwilling to act.
    function kick(uint256 tokenId) external nonReentrant whenNotPaused {
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition(); // DEEP-DS-07
        uint256 prior = p.boostedAmount;
        if (prior == 0 || p.lockEnd == 0 || block.timestamp < p.lockEnd) revert NoOpKick(); // DEEP-DS-07
        _accumulateRewards();
        // DEEP-DS-02: capture and settle pre-expiry rewards BEFORE decay.
        address holder = ownerOf(tokenId);
        int256 accumulated = _safeInt256((prior * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        // AUDIT FIX: DS2-01 — DO NOT advance p.rewardDebt yet; we need to know
        // how much actually got credited before we can advance the anchor safely.
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            // AUDIT FIX: DS2-02 — emit rewardPool shortfall event so off-chain monitors
            // detect under-funded reward pools at kick time (rather than silent drop).
            if (pending > cappedPending) {
                emit KickRewardPoolShortfall(holder, pending, cappedPending);
            }
            // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
            // slither-disable-next-line uninitialized-local
            uint256 totalSettled;
            if (cappedPending > 0) {
                uint256 actualSettled = _settleUnsettled(holder, cappedPending);
                if (actualSettled > 0) {
                    emit RewardPaid(holder, tokenId, actualSettled);
                    totalSettled += actualSettled;
                    // AUDIT FIX C-1: when the credited holder is the restaking
                    // contract, also record per-tokenId attribution so the
                    // restaker can later pull only their slice (instead of
                    // racing the shared bucket via `claimUnsettled()`).
                    // AUDIT FIX D-LD-H1: extended to lending contracts. Pre-fix,
                    // a permissionless kick on one borrower's escrowed NFT
                    // credited unsettledRewards[lending], which a DIFFERENT
                    // repaying borrower's claimUnsettled() then drained — that
                    // borrower's pre-kick reward slice landed in the lending
                    // contract's "donated" pool instead of their owed bucket.
                    // _isTrackedHolder() consolidates the gate so every future
                    // bucket-tracking holder (e.g., new escrow contract) gets
                    // attribution for free. Mirrors the restakingContract C-1 fix.
                    if (_isTrackedHolder(holder)) {
                        unsettledRewardsByTokenId[tokenId] += actualSettled;
                    }
                }
            }
            // AUDIT FIX: DS2-02 — route the rewardPool shortfall through
            // `_settleUnsettled` too (parity with `_getReward` shortfall handling).
            // Without this, an under-funded contract silently dropped the entire
            // post-pool slice on every kick, with no event and no recovery.
            uint256 shortfall = pending - cappedPending;
            if (shortfall > 0) {
                uint256 actualSettledShortfall = _settleUnsettled(holder, shortfall);
                if (actualSettledShortfall > 0) {
                    totalSettled += actualSettledShortfall;
                    // AUDIT FIX C-1: same per-tokenId attribution for the
                    // shortfall-path credits.
                    // AUDIT FIX D-LD-H1: extended to lending contracts (see
                    // primary kick-path attribution above for full rationale).
                    if (_isTrackedHolder(holder)) {
                        unsettledRewardsByTokenId[tokenId] += actualSettledShortfall;
                    }
                }
            }
            // AUDIT FIX (BATCH-J2 H8): revert kick when ANY portion of pending
            // rewards would be forfeited. Pre-fix, the forfeited slice was
            // emitted via RewardsForfeitedDuringKick + RewardsForfeited and
            // PERMANENTLY DESTROYED for the kicked holder (the slice re-accrued
            // to all active stakers via the next _accumulateRewards cycle —
            // positive-sum protocol but zero-sum for the holder). Attacker
            // could frontrun a whale's claim, kick the tokenId, saturate the
            // 100k unsettled cap, and burn the whale's surplus.
            // Curve LiquidityGaugeV4.kick NEVER forfeits — it credits the
            // FULL pending slice into integrate_fraction unconditionally.
            // Mirror that semantic here: if we cannot fully credit the
            // pending amount (because reward-pool shortfall + unsettled cap
            // collectively block it), abort the kick. The holder retains
            // their boost (anti-dilution defense weakens when bucket is
            // saturated), and a subsequent kick after the holder claims
            // succeeds. NEVER destroy user value silently.
            if (totalSettled < pending) revert KickWouldForfeit();
            // AUDIT FIX: DS2-01 — advance p.rewardDebt by ONLY the actually-credited
            // slice.
            // AUDIT FIX DS3-04: previous NatSpec falsely claimed "forfeited
            // portion stays claimable once room is freed" — that's NOT true.
            // The forfeited slice (`forfeitedTotal`) is PERMANENTLY LOST. When
            // we advance `p.rewardDebt` by `totalSettled` only, the next
            // `_getReward` call will compute `accumulated - p.rewardDebt = 0`
            // (since `accumulated` and `p.rewardDebt` only differ by the
            // already-credited portion) and the forfeited slice never re-enters
            // the calc. Implementing the true "claimable later" semantic would
            // require a per-position forfeit-debt mapping plus reconciliation,
            // which is out of scope. The honest contract is: holders who want
            // ALL their rewards must call `getReward` BEFORE lock expiry; kick
            // is an anti-dilution primitive with explicit forfeit semantics.
            if (totalSettled > 0) {
                p.rewardDebt = p.rewardDebt + _safeInt256(totalSettled);
                // AUDIT FIX: DS2-03 — refresh holder's activity timestamp; we just
                // credited unsettledRewards[holder] from a non-claim, holder-not-
                // msg.sender path. Mirrors DS-04's _touch(from) in
                // _settleRewardsOnTransfer so the R014 M-9 invariant ("every reward-
                // touching path that materially affects unsettled rewards for `user`
                // must `_touch(user)`") holds on the parallel kick code path.
                _touch(holder);
            }
        }
        _decayIfExpired(tokenId, p);
        // AUDIT FIX DS3-06: write a checkpoint between settle and decay so the
        // holder's voting power record correctly reflects the post-decay state.
        // Without this, RevenueDistributor lookups in the same block could read
        // a stale checkpoint until the next reward-touching path runs.
        // _decayIfExpired internally calls _writeCheckpoint(ownerOf(tokenId)),
        // but we re-call here defensively to ensure the post-state is the
        // recorded one even if a future _decayIfExpired refactor skips the
        // checkpoint write.
        _writeCheckpoint(holder);
        emit PositionKicked(tokenId, msg.sender, prior - p.boostedAmount);
    }

    // ─── AUDIT FIX #16: JBAC Boost Revalidation ──────────────────────

    /// @notice Revalidate a position's JBAC boost. Only the position owner or the restaking
    ///         contract can call this to prevent griefing (e.g., stripping boost while NFT is escrowed).
    /// @dev AUDIT FIX: Restricted from permissionless to owner-only to prevent boost-stripping griefing.
    /// @dev AUDIT FIX M-22: Flash-loan protection note — revalidateBoost can only DOWNGRADE the boost
    ///      (remove JBAC bonus if the user no longer holds a JBAC NFT) or restore it if they do.
    ///      The JBAC boost is cached at stake time, so a flash-loan cannot upgrade beyond the original.
    ///      This makes same-block revalidation safe as there is no exploitable upward manipulation.
    /// @dev AUDIT FIX M-21: Added whenNotPaused to prevent boost manipulation during pause
    /// @dev AUDIT FIX: DS2-07 — reject expired positions (parity with DS-06's
    ///      `extendLock` guard and `increaseAmount`). On a legacy grandfathered
    ///      position past lockEnd, the JBAC-downgrade branch would settle pre-expiry
    ///      rewards via `_getReward` (which decays boostedAmount to 0), then
    ///      `_applyNewBoost` would RESTORE boost using the unchanged stale
    ///      `lockDuration` — granting one extra rewarding-block window on an
    ///      already-expired lock. Holders whose JBAC was lost AND whose lock has
    ///      expired must withdraw + re-stake fresh, not get a free post-expiry
    ///      boost slot.
    /// @dev AUDIT NOTE FRESH-2026: F-02-K-05 [INFO] — for legacy
    ///      `hasJbacBoost && !jbacDeposited` positions, this checks
    ///      `jbacNFT.balanceOf(holder) > 0` (a balance check, NOT a tokenId
    ///      match). A user can swap JBAC tokenId X for Y and the boost
    ///      remains valid. By design — for legacy (pre-deposit) positions,
    ///      tokenId continuity cannot be enforced post-hoc. Deposit-based
    ///      positions (`jbacDeposited == true`) are immune (JBAC sits in the
    ///      vault).
    function revalidateBoost(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        address positionOwner = ownerOf(tokenId); // reverts if token doesn't exist
        // AUDIT FIX M-23: Allow restaking contract to call revalidateBoost on behalf of the position owner
        if (msg.sender != positionOwner && msg.sender != restakingContract) revert Unauthorized();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        // AUDIT FIX: DS2-07 — parity with DS-06's extendLock guard.
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

        // AUDIT H-1 FIX (2026-04-20): Deposit-based positions (created via stakeWithBoost) do
        // NOT revalidate. The JBAC is physically held by this contract for the lock duration,
        // so the boost is guaranteed to be valid. Legacy (grandfathered) positions with
        // hasJbacBoost=true and jbacDeposited=false still allow DOWNGRADE (boost removal)
        // so that pre-fix users who lose their JBAC can be stripped; but no upgrades are
        // allowed on non-deposit positions, closing the flash-loan vector for new stake()
        // positions that never held the boost to begin with.
        if (p.jbacDeposited) revert JbacDeposited();

        // When restaked, the NFT owner is the restaking contract — check the original depositor's JBAC balance
        address jbacHolder = positionOwner;
        if (positionOwner == restakingContract && restakingContract != address(0)) {
            address depositor = ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId);
            if (depositor != address(0)) {
                jbacHolder = depositor;
            }
        }

        // jbacNFT is the on-staking IERC721 reference; the actual custody lives
        // on the vault, but the balanceOf check for legacy `hasJbacBoost` positions
        // is unaffected by where custody sits.
        bool currentlyHoldsJbac = jbacNFT.balanceOf(jbacHolder) > 0;

        // Only allow DOWNGRADE (true -> false). No new JBAC boost via revalidate for
        // non-deposit positions (flash-loan mitigation for new stakes).
        if (p.hasJbacBoost && !currentlyHoldsJbac) {
            // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
            _getReward(tokenId, p);

            p.hasJbacBoost = false;

            // Recalculate boost: base lock boost only
            uint256 newBoost = calculateBoost(p.lockDuration);
            _applyNewBoost(p, newBoost);

            _writeCheckpoint(positionOwner); // AUDIT FIX #1

            emit BoostRevalidated(tokenId, false, p.boostedAmount);
        }
    }

    // ─── NFT Transfer / Mint / Burn Overrides ─────────────────────────
    //
    // AUDIT FIX (pass-8 batch-14): Solady ERC721 fires a single
    // `_afterTokenTransfer(from, to, id)` hook for `transferFrom`, `_mint`, AND
    // `_burn` (Solmate required three separate overrides — see batch-7/9 notes).
    // Pre-transfer logic moves to `_beforeTokenTransfer`, post-transition logic
    // collapses into a single `_afterTokenTransfer`. Net bytecode delta closes
    // the EIP-170 gap on this contract.
    //
    // Behaviour preservation:
    //   - Pre-transfer cooldown / rate-limit / lending-exempt / settle-rewards:
    //     applies ONLY when `from != 0 && to != 0` (true holder-to-holder
    //     transfer). _beforeTokenTransfer fires for mint (from==0) and burn
    //     (to==0) too, so we gate explicitly.
    //   - Post-transition logic (set updates, checkpoints, etc.): applies to
    //     ALL three paths (mint/transfer/burn).
    //   - safeTransferFrom inherits from Solady and calls Solady's
    //     `transferFrom` internally — no separate override needed.
    //   - CCR-01 ordering preserved: Solady's `_burn` clears the ownership
    //     storage slot BEFORE `_afterTokenTransfer` fires, so any reentrant
    //     `transferFrom` from inside the JBAC return-callback (which fires
    //     AFTER `_clearPosition` per the batch-9 reorder) reverts on the
    //     `from != _ownerOf[id]` check.

    /// @dev AUDIT FIX H-01 / Spartan TF-02 preserved: lending-contract exemption
    ///      from cooldown + rate-limit; restaking-contract exemption from
    ///      rate-limit only (still subject to cooldown). AUDIT FIX C-04
    ///      preserved: settle rewards to `from` BEFORE transfer to prevent
    ///      reward theft via mid-transfer state mismatch.
    function _beforeTokenTransfer(address from, address to, uint256 id) internal virtual override {
        // Mint (from==0) and burn (to==0) skip transfer-time guards — they
        // aren't holder-to-holder transfers.
        if (from == address(0) || to == address(0)) return;

        bool lendingExempt = isLendingContract[from] || isLendingContract[to];
        bool restakingHop = from == restakingContract || to == restakingContract;
        if (!lendingExempt) {
            if (block.timestamp < positions[id].stakeTimestamp + TRANSFER_COOLDOWN) revert TransferCooldownActive();
            if (!restakingHop) {
                if (block.timestamp < lastTransferTime[id] + TRANSFER_RATE_LIMIT) revert TransferRateLimited();
            }
        }
        lastTransferTime[id] = block.timestamp;
        _settleRewardsOnTransfer(id, from);
    }

    /// @dev Shared post-transition bookkeeping for transferFrom + _mint + _burn.
    ///      Centralizes the logic that was previously the second half of the
    ///      OZ `_update` override (Solmate batch-7) → three separate overrides
    ///      (Solmate batch-7) → single Solady hook (batch-14). All
    ///      position-tracking + checkpoint writes + autoMaxLock reset +
    ///      emergencyExit cleanup happen here.
    function _afterTokenTransfer(address from, address to, uint256 id) internal virtual override {
        // AUDIT FIX M-5 (full aggregation) preserved: maintain the per-owner
        // position set so votingPowerOf can correctly aggregate multi-NFT
        // holders. The set is the source of truth for voting power.
        if (from != address(0)) {
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            _positionsByOwner[from].remove(id);
        }
        if (to != address(0)) {
            // Enforce the per-holder cap BEFORE the EOA AlreadyHasPosition guard.
            // AUDIT FIX FRESH-2026: STAKING-MAX-POS-ESCROW-CARVE-OUT [CRITICAL] —
            //         the `MAX_POSITIONS_PER_HOLDER` cap exists to bound the O(n)
            //         iteration in `votingPowerOf` / `aggregateActiveBoostBps`.
            //         The restaking contract and whitelisted lending contracts
            //         already short-circuit those views to 0 (see lines 550, 621
            //         below — extended to lending contracts in the same fix), so
            //         the cap protects nothing for them while structurally
            //         capping the restaking module + lending market at 50 users
            //         (pool TVL ceiling = 50 × MIN_STAKE). Mirrors the existing
            //         `escrowHop` carve-outs at lines 1494/1501.
            bool isEscrowTo = (to == restakingContract) || isLendingContract[to];
            if (!isEscrowTo && _positionsByOwner[to].length() >= MAX_POSITIONS_PER_HOLDER) {
                revert TooManyPositions();
            }
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            _positionsByOwner[to].add(id);
        }

        // AUDIT FIX #2 preserved: Prevent overwriting an existing position for EOAs.
        // Contracts (e.g. TegridyRestaking) may hold multiple position NFTs,
        // so the guard only applies to externally-owned accounts.
        // AUDIT NEW-L2 (HIGH) preserved: when the NFT returns to its original
        // owner from a whitelisted lending contract, the borrower may have
        // re-staked in the meantime — relax the guard so the round-trip closes.
        // AUDIT FIX FRESH-2026: F-60-3 [LOW] — also treat EIP-7702 delegated
        // EOAs (code.length == 23) as EOAs so the safety rail still fires
        // post-Pectra. Without this, a 7702 user with an existing position can
        // silently receive a second NFT and lose `userTokenId` resolution to
        // the older one.
        uint256 toCodeLen = to.code.length;
        if (
            to != address(0) &&
            userTokenId[to] != 0 &&
            (toCodeLen == 0 || toCodeLen == 23) &&
            !isLendingContract[from]
        ) revert AlreadyHasPosition();

        // AUDIT TF-07 (Spartan MEDIUM) preserved: only reset autoMaxLock on a
        // genuine ownership change. Round-trips through whitelisted lending or
        // the restaking contract preserve the user's autoMaxLock preference.
        bool escrowHop =
            isLendingContract[from] || isLendingContract[to] ||
            from == restakingContract || to == restakingContract;
        if (from != address(0)) {
            if (!escrowHop) {
                positions[id].autoMaxLock = false;
            }
            delete _emergencyExitRequests[id];
            userTokenId[from] = 0;
            _writeCheckpoint(from);
        }
        if (to != address(0)) {
            // AUDIT FIX M-5 preserved: emit MultipleNFTsAtAddress when a non-restaking
            // contract receives a second+ staking NFT.
            if (to.code.length > 0 && to != restakingContract && userTokenId[to] != 0) {
                emit MultipleNFTsAtAddress(to, id, userTokenId[to]);
            }
            userTokenId[to] = id;
            _writeCheckpoint(to);
            // AUDIT FIX 2026-05-20 M16-REVISED: paused-conditional skip mirrors the
            // request/cancelEmergencyExit patch from M16 batch 5 (2026-05-16). Pre-fix
            // attack path: direct self-transfer is blocked by the M-5
            // `AlreadyHasPosition` guard above, but the BOUNCE pattern slips it —
            // attacker with a >24h-old NFT does `transferFrom(self, sock_puppet)`,
            // waits the 1h `TRANSFER_RATE_LIMIT`, then `transferFrom(sock_puppet,
            // self)`. The return leg lands here and refreshes `lastActivityAt[self]`,
            // defeating the 90-day `USER_INACTIVITY_GATE` on `claimUnsettledFor`.
            // SoladyERC721 `transferFrom` has no pause hook; the time gates above
            // (TRANSFER_COOLDOWN / TRANSFER_RATE_LIMIT) don't check `paused()`.
            // Skipping `_touch(to)` while paused closes the bounce. The batch-5
            // patch closed request/cancelEmergencyExit but missed this transfer-hook
            // path. Discovered by the defensive scan of PR #28 (same pass that
            // caught M10 over-credit). Regression test in Audit195_StakingGov.t.sol:
            // test_M16_revised_bounceTransferDuringPause_doesNotRefreshTouch.
            if (!paused()) _touch(to); // AUDIT M-AUDIT-2026-3 (paused-conditional 2026-05-20)
        }
    }

    /// @notice name / symbol — Solady requires these as abstract overrides
    ///         (its ERC721 base has no name/symbol storage; saves ~80B per
    ///         immutable string slot vs. Solmate's constructor-stored variant).
    /// @dev    AUDIT FIX (pass-8 batch-14). Values match the prior Solmate
    ///         `ERC721("Tegridy Staking Position", "tsTOWELI")` constructor.
    function name() public pure override returns (string memory) {
        return "Tegridy Staking Position";
    }

    function symbol() public pure override returns (string memory) {
        return "tsTOWELI";
    }

    /// @notice tokenURI override required by Solady's abstract surface.
    /// @dev    Returns empty string to match the prior OZ/Solmate default
    ///         behaviour. Frontends/marketplaces resolve metadata via
    ///         TegridyTokenURIReader (off-chain) per the existing architecture.
    function tokenURI(uint256 /*id*/) public view virtual override returns (string memory) {
        return "";
    }

    // AUDIT FIX (pass-8 batch-14): supportsInterface override removed. The prior
    // override added ERC721TokenReceiver (0x150b7a02) to the response set
    // because TegridyStaking implemented IERC721Receiver to accept JBAC inbound.
    // Post-batch-14 the JBAC custody moved to TegridyStakingJbacVault — this
    // contract is no longer a token receiver, so Solady's base
    // supportsInterface (ERC165 + ERC721 + ERC721Metadata) is correct as-is.

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev AUDIT R014 M-9: Refresh the user-touch timestamp gating
    ///      `claimUnsettledFor(user)` by the contract owner. Called from every
    ///      reward-touching entrypoint that materially affects unsettled rewards
    ///      for the user (claim, getReward, withdraw, increase, lock-extend,
    ///      auto-max toggle, NFT receive). Restaking-contract round-trips are
    ///      intentionally NOT touched here so the restaking path remains
    ///      unchanged — see TegridyRestaking for the per-restaker bookkeeping.
    /// @dev AUDIT FIX: DS2-03 — `kick()` is now also enumerated. When a kick credits
    ///      `unsettledRewards[holder]` (the holder is NOT the kick caller) we still
    ///      `_touch(holder)` so the 90-day inactivity gate on `claimUnsettledFor`
    ///      can't be bypassed by an owner-side force-claim immediately after a kick.
    function _touch(address user) internal {
        if (user == address(0)) return;
        lastActivityAt[user] = block.timestamp;
    }

    // AUDIT FIX C-03: Safe int256 cast — only transfer if accumulated > rewardDebt
    function _getReward(uint256 tokenId, Position storage p) internal returns (uint256) {
        if (p.boostedAmount == 0) return 0;
        // AUDIT FIX M-01: Compute rewards BEFORE decay zeroes boostedAmount.
        // Previously, _decayIfExpired was called first, setting boostedAmount=0 and
        // causing all pending rewards for expired positions to be permanently lost.
        address recipient = ownerOf(tokenId);
        int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        p.rewardDebt = accumulated;

        // Now decay the expired position (zeroes boostedAmount, updates totalBoostedStake)
        _decayIfExpired(tokenId, p);

        if (diff > 0) {
            uint256 pending = uint256(diff);
            // AUDIT FIX M-03: Cap reward to available balance excluding reserved tokens
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;

            if (cappedPending > 0) {
                rewardToken.safeTransfer(recipient, cappedPending);
                emit RewardPaid(recipient, tokenId, cappedPending);
            }

            // AUDIT FIX (critique 5.1 / battle-tested): route shortfall through
            // _settleUnsettled so the user can reclaim once the pool is refunded,
            // mirroring _settleRewardsOnTransfer semantics. Prior behavior silently
            // advanced rewardDebt to the full accumulated value while paying only
            // `rewardPool`, permanently losing the difference.
            uint256 shortfall = pending - cappedPending;
            if (shortfall > 0) {
                uint256 actualSettled = _settleUnsettled(recipient, shortfall);
                uint256 forfeited = shortfall - actualSettled;
                if (forfeited > 0) {
                    emit RewardsForfeited(recipient, forfeited);
                }
            }

            return cappedPending;
        }
        return 0;
    }

    /// @notice AUDIT FIX C-04: Settle rewards to the previous owner on NFT transfer.
    ///         Updates rewardPerTokenStored inline (same logic as updateReward modifier) and
    ///         sends pending rewards to `from`, then resets rewardDebt for the new owner.
    function _settleRewardsOnTransfer(uint256 tokenId, address from) private {
        // Accumulate pending rewards (same logic as updateReward modifier)
        _accumulateRewards();

        // AUDIT FIX M-04: Accumulate rewards in mapping instead of inline transfer
        // SECURITY FIX: Cap to available reward pool excluding all reserved tokens
        Position storage p = positions[tokenId];
        int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            // Cap pending to available reward pool
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            // AUDIT FIX DS3-01 / DS3-05: emit RewardPoolShortfall when the
            // pool can't cover the full pending amount. DS2-02 added this
            // event to kick(); the same code-shape exists here in
            // _settleRewardsOnTransfer (every NFT transfer with under-funded
            // pool silently strands the post-pool slice). Mirrors the kick()
            // event so off-chain monitors see the loss on either path.
            if (pending > rewardPool) {
                emit TransferRewardPoolShortfall(from, pending, rewardPool);
            }
            uint256 actualSettled = _settleUnsettled(from, cappedPending);
            // AUDIT FIX FRESH-2026: M-1 [F-02-K-02] — route the rewardPool
            // shortfall (`pending - cappedPending`) through `_settleUnsettled`
            // for later reclaim, mirroring `_getReward` and `kick()`. Previously
            // this slice was silently destroyed because `p.rewardDebt = accumulated`
            // (line below) advances the anchor by the full pending amount.
            uint256 shortfall = pending - cappedPending;
            uint256 shortfallSettled;
            if (shortfall > 0) {
                shortfallSettled = _settleUnsettled(from, shortfall);
                if (shortfallSettled > 0) {
                    emit RewardSettledToUnsettled(from, tokenId, shortfallSettled);
                    if (_isTrackedHolder(from)) {
                        unsettledRewardsByTokenId[tokenId] += shortfallSettled;
                    }
                }
                uint256 shortfallForfeited = shortfall - shortfallSettled;
                if (shortfallForfeited > 0) {
                    emit RewardsForfeited(from, shortfallForfeited);
                }
            }
            // AUDIT FIX C-02: Emit forfeiture event when cap blocks settlement
            uint256 forfeited = cappedPending - actualSettled;
            if (forfeited > 0) {
                emit RewardsForfeited(from, forfeited);
            }
            // AUDIT FIX DS3-03: emit a distinct event for the
            // settled-to-unsettled path. RewardPaid implies an actual wallet
            // transfer; this path only credits the unsettled mapping. Off-chain
            // tooling now has unambiguous semantics: RewardPaid = ETH/TOWELI
            // moved; RewardSettledToUnsettled = booked, awaiting claim.
            if (actualSettled > 0) {
                emit RewardSettledToUnsettled(from, tokenId, actualSettled);
                // AUDIT FIX C-1: when the prior holder is the restaking contract
                // (i.e., NFT is being unrestaked back to the user), record
                // per-tokenId attribution so the restaking contract can pull
                // exactly this credit via `claimUnsettledForTokenId`. Same
                // motivation as the kick() instrumentation: prevents one
                // restaker from draining another's pre-existing kick credits
                // in the shared `unsettledRewards[restakingContract]` bucket.
                // AUDIT FIX D-LD-H1: extended to lending contracts. When the
                // NFT exits the lending escrow (repay or default-claim), the
                // final-period accrual is credited here; per-tokenId tracking
                // lets the lending contract pull EXACTLY this loan's slice via
                // claimUnsettledForTokenId — no bucket-drain race with other
                // borrowers' deltas, no mis-attribution to the donated pool.
                if (_isTrackedHolder(from)) {
                    unsettledRewardsByTokenId[tokenId] += actualSettled;
                }
            }
            // AUDIT FIX: DEEP-DS-04 — refresh `from`'s activity timestamp; we just
            // credited unsettledRewards[from] from a non-claim path (NFT transfer).
            // The R014 M-9 invariant requires every reward-touching path that
            // materially affects unsettled rewards for `user` to `_touch(user)`.
            // AUDIT FIX 2026-05-20 M16-REVISED: paired with the `_afterTokenTransfer`
            // paused-skip (see that comment in `_afterTokenTransfer`). Pre-fix, the
            // bounce attack relied on this DEEP-DS-04 touch firing on the outgoing
            // leg (FROM-side) to refresh `lastActivityAt[attacker]` once accrued
            // rewards landed in `unsettledRewards[attacker]`. Skipping during pause
            // closes that half of the bounce; the `_afterTokenTransfer` skip closes
            // the return-leg TO-side touch. Regression test in
            // Audit195_StakingGov.t.sol: test_M16_revised_bounceTransferDuringPause_doesNotRefreshTouch.
            if (!paused()) _touch(from);
        }
        // AUDIT FIX: Set rewardDebt AFTER the reward pool check to ensure correct accounting
        p.rewardDebt = accumulated;
    }

    /// @notice Write a checkpoint for the user's current voting power (OZ Checkpoints.Trace208).
    /// @dev AUDIT NEW-S7 (MEDIUM): skip the push when power is unchanged. The previous
    ///      unconditional push wrote ~5-20k gas of SSTORE on every no-op transfer /
    ///      lending round-trip, and grew `_checkpoints[user]` forever for users near
    ///      the MAX_POSITIONS_PER_HOLDER cap. Compound / OZ Governor both compare
    ///      against the latest checkpoint before pushing.
    function _writeCheckpoint(address user) internal {
        uint256 power = votingPowerOf(user);
        uint208 newPower = SafeCast.toUint208(power);
        uint208 last = _checkpoints[user].latest();
        if (last == newPower) return;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        _checkpoints[user].push(SafeCast.toUint48(block.timestamp), newPower);
    }

    event UnsettledClaimed(address indexed user, uint256 amount);

    /// @notice AUDIT FIX M-04: Claim rewards accumulated during NFT transfers.
    ///         Rewards are stored in a mapping during transfer to prevent reverts.
    /// @dev AUDIT FIX v2: Retains unsettled amount on partial payout instead of zeroing
    function claimUnsettled() external nonReentrant whenNotPaused {
        _claimUnsettledInternal(msg.sender);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
    }

    // V2: reconcilePenaltyDust() removed — penalty drain system was dead code

    /// @notice AUDIT FIX M-24: Allow anyone to claim unsettled rewards on behalf of a user.
    ///         Prevents rewards from being indefinitely locked if the original recipient never claims.
    /// @dev AUDIT R014 M-9: The owner branch is now gated by USER_INACTIVITY_GATE — the
    ///      contract owner can only claim on behalf of `_user` after the user has been
    ///      inactive (no claim/withdraw/increase/lock-extend/NFT-receive on this
    ///      contract) for at least 90 days. The user themselves and the restaking
    ///      contract path are unchanged. Closes the bypass where the owner could
    ///      front-run an active user and pull their unsettled rewards out from under
    ///      them.
    function claimUnsettledFor(address _user) external nonReentrant whenNotPaused {
        // REVIEW C-1-FINDING-4: NEVER let `claimUnsettledFor` drain the
        // restakingContract's holder bucket. After the C-1 per-tokenId fix,
        // `unsettledRewards[restakingContract]` is the BACKING for every
        // `unsettledRewardsByTokenId[*]` entry. Draining the holder bucket
        // without decrementing the per-tokenId mappings would leave every
        // restaker's per-tokenId claim capped at 0 (since the cap by
        // `holderUnsettled` in `claimUnsettledForTokenId` would always be 0),
        // permanently breaking per-tokenId recovery. The restaking contract's
        // own per-tokenId path is the only valid drain route.
        // AUDIT FIX D-LD-H1: same protection extended to lending contracts. The
        // lending bucket is now ALSO the per-tokenId backing for any escrowed
        // loan position; an unrestricted claimUnsettledFor(lendingContract) by
        // the owner-stale path would silently zero the bucket while leaving
        // unsettledRewardsByTokenId[*] dangling — every borrower's per-tokenId
        // pull would then return 0 instead of their attributed slice.
        if (_isTrackedHolder(_user)) {
            revert Unauthorized();
        }
        // AUDIT R014 M-9: owner branch requires 90-day user inactivity. The user
        // themselves and the restaking contract may always claim on the user's behalf.
        if (msg.sender == _user || msg.sender == restakingContract) {
            _claimUnsettledInternal(_user);
            return;
        }
        if (msg.sender == owner()) {
            // Stale fallback: only after the user has been dormant for the full window.
            if (lastActivityAt[_user] + USER_INACTIVITY_GATE >= block.timestamp) {
                revert Unauthorized();
            }
            _claimUnsettledInternal(_user);
            return;
        }
        revert Unauthorized();
    }

    /// @notice AUDIT FIX C-1: Per-tokenId claim of `unsettledRewards[restakingContract]`.
    ///         Only callable by the restaking contract. Pulls min(per-tokenId credit,
    ///         restakingContract bucket, available reward pool) and transfers directly
    ///         to `recipient`. Decrements per-tokenId mapping, holder bucket, and
    ///         totalUnsettledRewards in lockstep so the global accounting invariants
    ///         hold.
    ///
    ///         This replaces the snapshot/delta race in TegridyRestaking.unrestake:
    ///         pre-fix, two restakers' kicks both landed in the shared
    ///         `unsettledRewards[restakingContract]` bucket and whichever called
    ///         `staking.claimUnsettled()` first via `unrestake()` drained the entire
    ///         bucket — including the second restaker's share. The second restaker
    ///         then computed `unsettledAfter - depositSnapshot = 0` and got nothing.
    ///
    ///         Returns the actual amount transferred (0 if nothing to claim or pool
    ///         under-funded — caller should treat as best-effort).
    function claimUnsettledForTokenId(uint256 tokenId, address recipient)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid)
    {
        // AUDIT FIX D-LD-H1: gate by tracked-holder status (restakingContract OR
        // any whitelisted lending contract). Caller's own bucket is the drain
        // source — no holder argument needed. Both holder types record
        // unsettledRewardsByTokenId[tokenId] in lockstep with unsettledRewards
        // [holder]; this caller-asserted drain is sound because a tokenId can
        // only be in one tracked-holder location at a time (NFT transfers are
        // atomic, and both holders ALWAYS drain on transfer-out via this same
        // function — see TegridyRestaking.unrestake / TegridyLending.repayLoan).
        if (!_isTrackedHolder(msg.sender)) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 amount = unsettledRewardsByTokenId[tokenId];
        if (amount == 0) return 0;

        // Defensive cap: holder bucket must be at least `amount`. Under normal
        // accounting the per-tokenId mapping is always <= holder bucket because
        // every per-tokenId credit was paired with a holder-bucket credit via
        // _settleUnsettled(holder, ...). The cap defends against any future
        // refactor that decouples the two writes.
        uint256 holderUnsettled = unsettledRewards[msg.sender];
        if (amount > holderUnsettled) amount = holderUnsettled;

        // Apply the same reward-pool cap as `_claimUnsettledInternal`: reserve
        // totalStaked + other users' unsettled (everything except this claim).
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 otherUnsettled = totalUnsettledRewards > amount ? totalUnsettledRewards - amount : 0;
        uint256 otherReserved = totalStaked + otherUnsettled;
        uint256 rewardPool = available > otherReserved ? available - otherReserved : 0;
        paid = amount > rewardPool ? rewardPool : amount;

        if (paid > 0) {
            unsettledRewardsByTokenId[tokenId] -= paid;
            unsettledRewards[msg.sender] = holderUnsettled - paid;
            totalUnsettledRewards = totalUnsettledRewards > paid ? totalUnsettledRewards - paid : 0;
            rewardToken.safeTransfer(recipient, paid);
            emit UnsettledClaimedForTokenId(tokenId, recipient, paid);
        }
    }

    /// @notice AUDIT FIX D-LD-H1: tracked-holder predicate. A "tracked holder"
    ///         is one whose `unsettledRewards[holder]` bucket is the BACKING
    ///         store for `unsettledRewardsByTokenId[*]` entries — meaning every
    ///         credit/debit on the bucket must be paired with a per-tokenId
    ///         write. Currently: restakingContract + any address flagged via
    ///         `applyLendingContract`. Used by kick() / _settleRewardsOnTransfer
    ///         (write side) and claimUnsettledForTokenId / claimUnsettledFor
    ///         (read + drain side) to keep the invariant
    ///         `sum(unsettledRewardsByTokenId[*]) <= unsettledRewards[holder]`
    ///         coherent across every reward-touching path.
    function _isTrackedHolder(address holder) internal view returns (bool) {
        if (holder == address(0)) return false;
        if (holder == restakingContract && restakingContract != address(0)) return true;
        return isLendingContract[holder];
    }

    function _claimUnsettledInternal(address _user) private {
        uint256 amount = unsettledRewards[_user];
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert ZeroAmount();
        // Cap to available reward pool: reserve totalStaked + other users' unsettled rewards
        // (this user's unsettled amount is being claimed, so exclude it from reserved)
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 otherUnsettled = totalUnsettledRewards > amount ? totalUnsettledRewards - amount : 0;
        uint256 otherReserved = totalStaked + otherUnsettled;
        uint256 rewardPool = available > otherReserved ? available - otherReserved : 0;
        uint256 payout = amount > rewardPool ? rewardPool : amount;
        // AUDIT FIX v2: Only deduct what's actually paid; remainder stays claimable
        unsettledRewards[_user] = amount - payout;
        // SECURITY FIX: Decrease totalUnsettledRewards as rewards are claimed
        totalUnsettledRewards = totalUnsettledRewards > payout ? totalUnsettledRewards - payout : 0;
        if (payout > 0) {
            rewardToken.safeTransfer(_user, payout);
            emit UnsettledClaimed(_user, payout);
        }
    }

    // ─── Emergency ─────────────────────────────────────────────────────

    /// @notice AUDIT FIX #11: Emergency withdraw — ONLY callable when contract is paused.
    ///         Forfeits all pending rewards.
    function emergencyWithdrawPosition(uint256 tokenId) external nonReentrant whenPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Pause-independent emergency exit for expired positions.
    ///         Returns staked principal. Works regardless of pause state.
    ///         AUDIT FIX M-05: Attempts reward claim via try/catch before exit.
    ///         Previously silently forfeited all accrued rewards.
    /// @param tokenId The NFT token ID of the staking position to exit
    function emergencyExitPosition(uint256 tokenId) external nonReentrant updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.lockEnd) revert LockStillActive();

        // AUDIT FIX M-05: Attempt reward claim before exit. If reward transfer reverts
        // (e.g., token blacklist), continue with principal return rather than trapping both.
        _getReward(tokenId, p);

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        emit EmergencyExitPosition(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Request an emergency exit (pause-independent, works at any time).
    ///         Initiates a 7-day delay before the exit can be executed. Forfeits all rewards.
    /// @dev AUDIT M-AUDIT-2026-3: refresh `_touch(msg.sender)` so the owner-side
    ///      `claimUnsettledFor(msg.sender)` 90-day inactivity gate doesn't fire while
    ///      the user is mid-emergency-exit. A user actively exiting is clearly active.
    /// @param tokenId The NFT token ID of the staking position
    function requestEmergencyExit(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (_emergencyExitRequests[tokenId] != 0) revert EmergencyExitAlreadyRequested();

        _emergencyExitRequests[tokenId] = block.timestamp;
        // AUDIT FIX 2026-05-16 M16: only refresh `lastActivityAt` while NOT paused.
        // Pre-fix, a malicious user could spam request+cancel cycles during pause to
        // keep `lastActivityAt[user]` always < USER_INACTIVITY_GATE (90d) old,
        // blocking owner-side stale-claim recovery via `claimUnsettledFor(user)`
        // perpetually. `claimUnsettledFor` is `whenNotPaused` so the owner can't
        // front-run during pause anyway — skipping `_touch` during pause closes the
        // grief loop without breaking the pause-independent escape-hatch design.
        if (!paused()) _touch(msg.sender); // AUDIT M-AUDIT-2026-3 (paused-conditional 2026-05-16)
        emit EmergencyExitRequested(msg.sender, tokenId, block.timestamp + EMERGENCY_EXIT_DELAY);
    }

    /// @notice AUDIT FIX L-09: Cancel a pending emergency exit request.
    /// @dev AUDIT M-AUDIT-2026-3: refresh `_touch(msg.sender)` (see requestEmergencyExit).
    /// @param tokenId The NFT token ID
    function cancelEmergencyExit(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (_emergencyExitRequests[tokenId] == 0) revert EmergencyExitNotRequested();
        delete _emergencyExitRequests[tokenId];
        // AUDIT FIX 2026-05-16 M16: same paused-conditional skip as requestEmergencyExit.
        // See that function's comment for rationale.
        if (!paused()) _touch(msg.sender); // AUDIT M-AUDIT-2026-3 (paused-conditional 2026-05-16)
        emit EmergencyExitCancelled(msg.sender, tokenId);
    }

    /// @notice AUDIT FIX C-05: Execute an emergency exit after the 7-day delay.
    ///         Callable at any time (pause-independent).
    ///         AUDIT FIX M-06: Attempts reward claim before exit instead of silently forfeiting.
    /// @param tokenId The NFT token ID of the staking position
    function executeEmergencyExit(uint256 tokenId) external nonReentrant updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        uint256 requestTime = _emergencyExitRequests[tokenId];
        if (requestTime == 0) revert EmergencyExitNotRequested();
        if (block.timestamp < requestTime + EMERGENCY_EXIT_DELAY) revert EmergencyExitDelayNotElapsed();

        // AUDIT FIX M-06: Attempt reward claim before exit. Rewards are a best-effort bonus;
        // if claim fails, principal return proceeds regardless.
        _getReward(tokenId, p);

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        bool earlyExit = block.timestamp < p.lockEnd;
        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        uint256 amount = _clearPosition(tokenId, p);

        uint256 penalty;
        uint256 userReceives;
        if (earlyExit) {
            penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS;
            userReceives = amount - penalty;
            totalPenaltiesCollected += penalty;
            // AUDIT C6: same penalty split as earlyWithdraw.
            (uint256 toTreasury, uint256 recycled) = _splitPenalty(penalty);
            if (toTreasury > 0) rewardToken.safeTransfer(treasury, toTreasury);
            if (recycled > 0) _creditRewardPool(recycled);
            emit PenaltySplit(tokenId, toTreasury, recycled);
        } else {
            userReceives = amount;
        }

        rewardToken.safeTransfer(msg.sender, userReceives);
        _touch(msg.sender); // AUDIT M-AUDIT-2026-3: refresh inactivity gate post-exit
        emit EmergencyExitPosition(msg.sender, tokenId, userReceives);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    // AUDIT NEW-S5 (MEDIUM): notifyRewardAmount is now restricted to owner or a
    // whitelisted notifier set (see rewardNotifiers mapping + setRewardNotifier).
    // Prior version was permissionless with only MIN_NOTIFY_AMOUNT as the bar —
    // an attacker could time a large deposit immediately before their own
    // `getReward` tx, capturing a disproportionate slice of the just-funded
    // pool via the instantaneous `rewardPerTokenStored` bump in the next
    // `_accumulateRewards` cycle. Matches Synthetix `RewardsDistributionRecipient`
    // pattern where only a dedicated role can fund the contract. The treasury /
    // POLAccumulator / operations multisig can be added as notifiers.
    /// @dev AUDIT FIX (pass-8): EIP170-02 partial — visibility lowered to
    ///      `internal`. Zero on-chain consumers; off-chain readers can use
    ///      the `RewardNotifierUpdated` event to track membership. Saves ~80B.
    mapping(address => bool) internal rewardNotifiers;

    event RewardNotifierSet(address indexed notifier, bool enabled);

    function setRewardNotifier(address notifier, bool enabled) external onlyOwner {
        rewardNotifiers[notifier] = enabled;
        emit RewardNotifierSet(notifier, enabled);
    }

    /// @notice Fund the staking contract with reward tokens.
    /// @dev AUDIT FIX H-06: nonReentrant. AUDIT NEW-S5: caller must be owner or notifier.
    /// @dev AUDIT M-AUDIT-2026-2: `updateReward` crystallises any accrued rewards under
    ///      the pre-funding `available - reserved` boundary BEFORE the new funds bump
    ///      `available`. Today's threat model has the notifier set restricted to owner
    ///      + explicit allowlist (NEW-S5), so this is defensive hardening: if the
    ///      notifier set ever expands (e.g., to allow community refunding via
    ///      POLAccumulator), the pre-existing logic could let a notifier back-run their
    ///      own funding by claiming a fatter `rewardPool` against elapsed-but-not-yet-
    ///      credited time. Mirrors Synthetix `RewardsDistributionRecipient` pattern.
    /// @dev AUDIT FIX: DEEP-DS-05 — `whenNotPaused` added. Prevents the kick+notify
    ///      pause-asymmetry where a notifier could re-shape the rewardPerTokenStored
    ///      denominator while user reward-claim entrypoints are blocked.
    /// @dev AUDIT FIX: DEEP-DS-08 — measure actual received delta and re-validate the
    ///      MIN_NOTIFY_AMOUNT floor. Defends totalRewardsFunded accounting against any
    ///      future migration to a FoT/rebasing reward token; harmless ~3k gas tax.
    /// @param _amount Amount of reward tokens to deposit (must be >= MIN_NOTIFY_AMOUNT)
    function notifyRewardAmount(uint256 _amount) external nonReentrant whenNotPaused updateReward {
        if (msg.sender != owner() && !rewardNotifiers[msg.sender]) {
            revert NotRewardNotifier();
        }
        if (_amount < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall(); // AUDIT FIX #61
        // AUDIT FIX: DEEP-DS-08 — delta-measure pattern.
        uint256 balBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
        if (received < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
        totalRewardsFunded += received;
        emit RewardAdded(received);
    }

    /// @notice First-time setter for the sister TegridyStakingAdmin contract (where the
    ///         timelocked propose/execute/cancel flow lives). Callable exactly once by
    ///         the owner — only when `stakingAdmin == address(0)`. Subsequent
    ///         replacements MUST go through the timelocked propose/execute path
    ///         (`proposeAdminReplacement` → `executeAdminReplacement`).
    /// @dev    AUDIT R014 H-2: Prior version was permanently one-shot, so a buggy or
    ///         compromised admin contract could never be rotated without redeploying
    ///         TegridyStaking and migrating all positions. Replaceability is now
    ///         possible behind the same 48-hour timelock that gates every other
    ///         admin parameter change.
    function setStakingAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        if (stakingAdmin != address(0)) revert Unauthorized();
        // AUDIT FIX: DEEP-DS-12 — reject EOA / non-contract addresses on first-time
        // wire-up. Catches the typo that points at a wallet instead of a deployed
        // TegridyStakingAdmin; recovery is otherwise gated by the 48h
        // `proposeAdminReplacement` timelock.
        // AUDIT FIX FRESH-2026: F-60-2 — also reject EIP-7702 delegated EOAs
        // (code.length == 23 is the canonical 0xef0100‖addr delegation pointer).
        // Pattern matches OwnableNoRenounce._transferOwnership.
        uint256 codeLen = _admin.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        stakingAdmin = _admin;
        emit StakingAdminReplaced(address(0), _admin);
    }

    // ─── AUDIT R014 H-2: Admin contract replaceability ───────────────────
    /// @notice Timelock key for the admin replacement flow.
    bytes32 public constant ADMIN_REPLACEMENT = keccak256("STAKING_ADMIN_REPLACEMENT");
    /// @notice Mandatory delay between propose and execute for an admin swap.
    /// @dev AUDIT FIX (pass-8 batch-14): visibility lowered to `internal`. Tests
    ///      hardcode the value (48 hours) directly.
    uint256 internal constant ADMIN_REPLACEMENT_TIMELOCK = 48 hours;

    /// @notice Pending replacement admin address. Zero when no proposal is pending.
    address public pendingStakingAdmin;
    /// @notice block.timestamp after which `executeAdminReplacement` is callable.
    ///         Zero when no proposal is pending.
    uint256 public adminReplacementReadyAt;

    event StakingAdminReplaced(address indexed oldAdmin, address indexed newAdmin);
    event StakingAdminReplacementProposed(address indexed newAdmin, uint256 executeAfter);
    event StakingAdminReplacementCancelled(address indexed proposed);

    /// @notice Propose a replacement TegridyStakingAdmin. Reverts if no admin is set
    ///         yet — the first-time installation path is `setStakingAdmin`.
    /// @dev    AUDIT R014 H-2: Mirrors the propose/execute/cancel pattern used by
    ///         every other timelocked parameter on TegridyStakingAdmin. Held inline
    ///         on the staking contract (rather than on the admin contract) so a
    ///         broken or compromised admin contract cannot block its own removal.
    function proposeAdminReplacement(address _newAdmin) external onlyOwner {
        if (_newAdmin == address(0)) revert ZeroAddress();
        if (stakingAdmin == address(0)) revert Unauthorized(); // use setStakingAdmin first
        if (adminReplacementReadyAt != 0) revert Unauthorized(); // existing proposal pending
        // AUDIT FIX FRESH-2026: F-43-B + F-60-2 — mirror setStakingAdmin's
        // contract-only enforcement on the rotation path. Also reject EIP-7702
        // delegated EOAs (code.length == 23). Without this, a typo / phished
        // proposal that points at an EOA gets installed at the 48h mark and
        // bricks every onlyAdmin path because the EOA cannot construct external
        // `apply*` calls.
        uint256 codeLen = _newAdmin.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        pendingStakingAdmin = _newAdmin;
        adminReplacementReadyAt = block.timestamp + ADMIN_REPLACEMENT_TIMELOCK;
        emit StakingAdminReplacementProposed(_newAdmin, adminReplacementReadyAt);
    }

    /// @notice Execute a previously proposed admin replacement after the 48-hour delay.
    /// @dev    AUDIT FIX FRESH-2026: H-14 [F-75-1, F-43-A] — backport DEEP-R-M01
    ///         7-day validity window from SwapFeeRouter.executeAdminReplacement.
    ///         Without this, a years-old stale `pendingStakingAdmin` slot stays
    ///         executable forever — and a forgotten candidate address could be
    ///         co-opted (CREATE2 redeploy, abandoned multisig, expired-key
    ///         custody) to install a hostile admin.
    function executeAdminReplacement() external onlyOwner {
        uint256 readyAt = adminReplacementReadyAt;
        if (readyAt == 0) revert Unauthorized(); // no pending proposal
        if (block.timestamp < readyAt) revert Unauthorized(); // delay not elapsed
        // AUDIT FIX FRESH-2026: H-14 — 7-day validity window after readyAt.
        if (block.timestamp > readyAt + 7 days) revert Unauthorized();
        address newAdmin = pendingStakingAdmin;
        if (newAdmin == address(0)) revert ZeroAddress(); // defensive
        address oldAdmin = stakingAdmin;
        stakingAdmin = newAdmin;
        pendingStakingAdmin = address(0);
        adminReplacementReadyAt = 0;
        emit StakingAdminReplaced(oldAdmin, newAdmin);
    }

    /// @notice Cancel a pending admin replacement proposal.
    function cancelAdminReplacement() external onlyOwner {
        if (adminReplacementReadyAt == 0) revert Unauthorized();
        address proposed = pendingStakingAdmin;
        pendingStakingAdmin = address(0);
        adminReplacementReadyAt = 0;
        emit StakingAdminReplacementCancelled(proposed);
    }

    modifier onlyAdmin() {
        if (msg.sender != stakingAdmin) revert Unauthorized();
        _;
    }

    /// @notice Apply a new reward rate. Caller must be the wired admin contract.
    function applyRewardRate(uint256 _rate) external onlyAdmin updateReward {
        if (_rate > MAX_REWARD_RATE) revert RateTooHigh();
        rewardRate = _rate;
        emit RewardRateUpdated(_rate);
    }

    /// @notice Apply a treasury change. Caller must be the wired admin contract.
    function applyTreasury(address _newTreasury) external onlyAdmin {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address oldT = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(oldT, _newTreasury);
    }

    /// @notice Apply a restaking-contract change. Caller must be the wired admin contract.
    /// @dev    AUDIT FIX FRESH-2026: M-28 [F-35-1, F-65-1] — symmetric guard with
    ///         `applyLendingContract`. Revoking the restaking contract while it
    ///         still holds escrowed staking NFTs strands per-tokenId reward
    ///         attribution (`unsettledRewardsByTokenId`) because `_isTrackedHolder`
    ///         flips false for the OLD restaker post-rotation, bricking
    ///         `claimUnsettledForTokenId` for every escrowed position.
    function applyRestakingContract(address _restaking) external onlyAdmin {
        if (_restaking == address(0)) revert ZeroAddress();
        // AUDIT FIX FRESH-2026: M-28 — block rotation while old restaker still escrows NFTs.
        address oldRestaking = restakingContract;
        if (oldRestaking != address(0) && balanceOf(oldRestaking) > 0) {
            revert PendingRestakingPositions();
        }
        // AUDIT FIX 2026-05-16 H1: also block rotation while the OLD restaking contract
        // still holds unsettled-reward residue. After rotation `_isTrackedHolder` flips
        // false for the old address, bricking `claimUnsettledForTokenId` for every restaker
        // with a residual per-tokenId claim. Operator MUST drain the old bucket first
        // (the old restaking contract's `claimResidualForTokenId` flow uses the staking
        // contract's `claimUnsettledForTokenId(tokenId, recipient)`).
        if (oldRestaking != address(0) && unsettledRewards[oldRestaking] > 0) {
            revert PendingRestakingResidue();
        }
        restakingContract = _restaking;
    }

    /// @notice Apply a lending-contract whitelist toggle. Caller must be the wired admin contract.
    /// @dev AUDIT FIX: DEEP-DS-10 — block revoke (false) while lending contract still holds
    ///      escrowed staking NFTs. Otherwise the eventual repay/default round-trip back
    ///      to the borrower hits cooldown/rate-limit/AlreadyHasPosition guards once the
    ///      from-side relaxation is gone, stranding the borrower's collateral.
    /// @dev AUDIT FIX: DS2-08 — `balanceOf(_lending)` here is the inherited
    ///      `IERC721(this).balanceOf(_lending)`, i.e. the count of THIS contract's
    ///      own staking-NFT collection held at `_lending`. It is NOT a generic NFT
    ///      count and cannot be inflated by other ERC721 collections held at the
    ///      same address. Only staking NFTs decrement this balance via `_burn` in
    ///      `_clearPosition`, so the check is sound for actual escrow.
    function applyLendingContract(address _lending, bool _approved) external onlyAdmin {
        if (_lending == address(0)) revert ZeroAddress();
        if (!_approved && balanceOf(_lending) > 0) revert PendingLendingPositions();
        // AUDIT FIX 2026-05-16 M12: same residue-strand guard as applyRestakingContract.
        // Revoking while unsettledRewards residue exists strands per-tokenId reward
        // attribution permanently. Operator MUST drain via the lending contract's
        // residual-claim flow before revoking the whitelist entry.
        if (!_approved && unsettledRewards[_lending] > 0) revert PendingLendingResidue();
        isLendingContract[_lending] = _approved;
    }

    /// @notice AUDIT FIX L-28: Rescue ERC-20 tokens accidentally sent to this contract.
    ///         Cannot sweep the staking reward token to protect user funds.
    /// @param token The ERC-20 token address to sweep
    function sweepToken(address token) external onlyOwner nonReentrant {
        if (token == address(rewardToken)) revert CannotSweepRewardToken();
        uint256 balance = IERC20(token).balanceOf(address(this));
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (balance == 0) revert ZeroBalance();
        IERC20(token).safeTransfer(treasury, balance);
    }

    /// @dev AUDIT FIX (pass-8 batch-14): `_returnJbac` (private) and
    ///      `claimStrandedJbac` (external) moved to TegridyStakingJbacVault.
    ///      `_clearPosition` now calls `vault.returnJbac(tokenId, jbacId, to)`
    ///      instead of an inline `_returnJbac`. The CCR-01 invariant
    ///      (return AFTER `_burn`) is preserved by `_clearPosition`'s ordering;
    ///      see its natspec. Stranded reclaim happens via
    ///      `TegridyStakingJbacVault.claimStrandedJbac(stakingTokenId)`.

    /// @dev Recalculate boost for a position and update totals + rewardDebt.
    /// @dev AUDIT REV-M-01: write the system-wide totalBoostedStake checkpoint AFTER both
    ///      the decrement and increment have settled — so the trace records the net post-
    ///      boost-rewrite total, not an intermediate mid-rewrite value.
    function _applyNewBoost(Position storage p, uint256 newBoost) private {
        totalBoostedStake -= p.boostedAmount;
        if (newBoost > type(uint16).max) revert BoostOverflow();
        p.boostBps = uint16(newBoost);
        p.boostedAmount = (p.amount * newBoost) / BOOST_PRECISION;
        totalBoostedStake += p.boostedAmount;
        p.rewardDebt = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
        _writeTotalBoostedStakeCheckpoint(); // AUDIT REV-M-01
    }

    /// @dev Clear a staking position: update totals, delete position, burn NFT, checkpoint.
    /// @return amount The staked principal that was in the position
    /// @dev AUDIT FIX: DEEP-DS-13 — preserve `userTokenId[msg.sender]` for multi-NFT
    ///      holders (Safes, vaults). After `_burn` runs `_update`, which removes
    ///      tokenId from `_positionsByOwner[msg.sender]` and zeros
    ///      `userTokenId[msg.sender]`, re-point the legacy single-pointer at any
    ///      remaining position so legacy integrators that read `userTokenId(holder)`
    ///      don't silently misreport "no position" while other positions exist.
    /// @dev AUDIT FIX: DS2-05 — use `set.at(set.length() - 1)` (most recently inserted
    ///      surviving position by EnumerableSet append/swap-pop semantics) instead of
    ///      `set.at(0)`. Preserves the M-5 "latest received" semantic of
    ///      `userTokenId[holder]` (per `_update`'s `userTokenId[to] = tokenId` write
    ///      on every inbound transfer). Without this, post-clear the pointer could
    ///      flip to an OLDER tokenId with stale lockEnd / boost data, causing legacy
    ///      single-pointer integrators that read `getPosition(userTokenId(holder))`
    ///      to silently penalize their depositors with the wrong position metadata.
    /// @dev AUDIT FIX (pass-8 batch-14): `_clearPosition` now also handles the
    ///      JBAC return inline (post-burn), capturing the jbacId from `p` BEFORE
    ///      the `delete positions[tokenId]` in the same body. This collapses the
    ///      5 exit-path callsites that previously each had their own
    ///      `uint256 jbacId = p.jbacDeposited ? p.jbacTokenId : 0;` capture
    ///      followed by a separate `_returnJbac(...)` call at the end, saving
    ///      ~80B per site. The CCR-01 batch-9 invariant is preserved verbatim:
    ///      `_burn(tokenId)` fires BEFORE `_returnJbac`, so any reentrant
    ///      `transferFrom` from inside the JBAC `safeTransferFrom` callback
    ///      reverts on the now-empty `_ownerOf[id]` slot. Centralizing the
    ///      return inside `_clearPosition` makes the invariant a property of
    ///      the helper itself rather than a discipline at every callsite.
    function _clearPosition(uint256 tokenId, Position storage p) private returns (uint256 amount) {
        amount = p.amount;
        // CCR-01 (batch-9): capture jbacId BEFORE `delete positions[tokenId]`
        // wipes `p.jbacDeposited` / `p.jbacTokenId`. Returned post-burn below.
        uint256 jbacIdToReturn = p.jbacDeposited ? p.jbacTokenId : 0;
        totalStaked -= amount;
        totalBoostedStake -= p.boostedAmount;
        // AUDIT L-22 / Spartan TF-10: totalLocked tracking removed — was redundant with totalStaked.
        delete positions[tokenId];
        delete _emergencyExitRequests[tokenId];
        _burn(tokenId);
        // AUDIT FIX: DEEP-DS-13 — `_burn` ran `_update` which removed tokenId from
        // `_positionsByOwner[msg.sender]` and zeroed `userTokenId[msg.sender]`. If
        // any positions remain, re-point the legacy pointer at one of them.
        EnumerableSet.UintSet storage set = _positionsByOwner[msg.sender];
        uint256 setLen = set.length();
        if (setLen > 0) {
            // AUDIT FIX: DS2-05 — pick latest surviving position (preserves M-5 semantic).
            userTokenId[msg.sender] = set.at(setLen - 1);
        }
        _writeCheckpoint(msg.sender);
        _writeTotalBoostedStakeCheckpoint(); // AUDIT REV-M-01
        // CCR-01 (batch-9 / batch-14): JBAC return AFTER all state mutations and
        // the burn. Vault's `returnJbac` short-circuits on jbacId == 0; the
        // `onlyStaking` modifier on the vault gates this entry path.
        // AUDIT FIX FRESH-2026: STAKING-JBAC-VAULT-BRICK-DEFENSE [HIGH] — wrap
        //         the vault call in try/catch so a mis-wired vault (operator
        //         error at one-shot `setJbacVault`), an ABI-incompatible vault
        //         (future regression), or transient gas blow-up cannot brick
        //         every JBAC-deposited position's exit. The vault's own internal
        //         try/catch (TegridyStakingJbacVault.sol:92-99) handles JBAC-side
        //         failures; this outer wrap is strictly for VAULT-side failures.
        //         Reentrancy is not a concern: the catch arm only writes storage
        //         (no external call) and the encompassing call paths
        //         (withdraw/earlyWithdraw/emergencyExitPosition/
        //         executeEmergencyExit/emergencyWithdrawPosition) are
        //         `nonReentrant` so OZ's global lock blocks cross-function
        //         reentry from any malicious vault.
        if (jbacIdToReturn != 0) {
            try ITegridyStakingJbacVault(jbacVault).returnJbac(tokenId, jbacIdToReturn, msg.sender) {
                // success path: vault accepted the call (JBAC delivered or stranded inside vault)
            } catch {
                strandedJbacAtVaultOwner[tokenId] = msg.sender;
                strandedJbacAtVaultId[tokenId] = jbacIdToReturn;
                emit JbacReturnDeferred(tokenId, msg.sender, jbacIdToReturn);
            }
        }
    }

    /// @dev Settle unsettled rewards for a user, respecting the global cap.
    /// @return settled The actual amount settled (may be less than requested if cap hit)
    function _settleUnsettled(address user, uint256 amount) private returns (uint256 settled) {
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return 0;
        // AUDIT FIX L-06: Cap totalUnsettledRewards to prevent unbounded growth
        uint256 unsettledRoom = totalUnsettledRewards < maxUnsettledRewards
            ? maxUnsettledRewards - totalUnsettledRewards : 0;
        settled = amount > unsettledRoom ? unsettledRoom : amount;
        if (settled > 0) {
            unsettledRewards[user] += settled;
            totalUnsettledRewards += settled;
        }
        // AUDIT FIX M-3 (battle-tested): forfeit-to-treasury redirect removed.
        // Previously, overage above maxUnsettledRewards was credited to
        // unsettledRewards[treasury] and counted against totalUnsettledRewards, letting the
        // treasury cap-squeeze honest users' claims (owner could then claimUnsettledFor(treasury)
        // to extract). Under the corrected semantics, the overage remains unreserved in the
        // reward-pool balance and is re-accrued to all active stakers via the next
        // _accumulateRewards cycle — the cap is now genuinely honored. Caller-site
        // RewardsForfeited events remain as-is for off-chain observability.
    }

    /// @dev AUDIT FIX: Safe uint256 -> int256 cast. Reverts if value exceeds int256 max,
    ///      preventing silent wrap-around that could allow reward theft via negative rewardDebt.
    ///      A4-C-05: Verified — this function is called for all rewardDebt assignments.
    ///      The product (boostedAmount * rewardPerTokenStored) / ACC_PRECISION is safe from uint256
    ///      overflow because: boostedAmount <= ~4.5x * totalSupply (capped by MAX_BOOST + JBAC),
    ///      rewardPerTokenStored grows by (reward * 1e12) / totalBoostedStake per second.
    ///      With realistic values (1B supply, 100/s rate), overflow would take >1000 years.
    function _safeInt256(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert IntOverflow();
        return int256(value);
    }

    // tokenURI: uses base ERC721 (returns "" when no baseURI set).
    // Full SVG metadata available via TegridyTokenURIReader contract.

    // ─── AUDIT C5: Extend-fee helper + timelocked setter ─────────────────

    /// @dev Pull extendFeeBps × positionAmount of TOWELI from the caller, then split the
    ///      fee between treasury and the staker reward pool per `extendFeeRecycleBps`.
    ///      Caller must approve this contract for the fee amount. No-op when
    ///      extendFeeBps == 0 (default), preserving backward-compatible behaviour.
    /// @dev AUDIT M-AUDIT-2026-1 (MEDIUM, 2026-04-28): pre-fix the entire fee landed at
    ///      treasury while the boost it bought DILUTED every existing staker's share.
    ///      Now we split the fee per `extendFeeRecycleBps`: the recycled slice is
    ///      pulled into THIS contract (not treasury), then immediately credited via
    ///      `_creditRewardPool` so it bumps `rewardPerTokenStored` for the existing
    ///      stakers — exactly the `AUDIT C6` penalty-recycle pattern. When
    ///      `extendFeeRecycleBps == 0` (default), the entire fee still goes to
    ///      treasury and behaviour is identical to the C5 baseline.
    /// @dev AUDIT FIX 2026-05-16 M10 (REVISED 2026-05-17): debt-advance pattern
    ///      (closes DEEP-DS-09 DEFERRED). Pre-fix used `_creditRewardPoolExcluding`
    ///      which bumped `rewardPerTokenStored` by `recycled * ACC / (totalB -
    ///      contributorBoost)` — but `rewardPerTokenStored` is GLOBAL, so every
    ///      staker's pending grew, including the caller's. The over-credit equalled
    ///      `totalB * recycled / (totalB - contributorBoost) > recycled`, paying
    ///      out MORE than was deposited and silently draining the pool when both
    ///      `extendFeeBps > 0` AND `extendFeeRecycleBps > 0` (both default 0, so
    ///      latent in mainnet config until the operator enabled either).
    ///
    ///      New approach mirrors Yearn/Convex debt-advance ("checkpoint-only" cancel):
    ///      (1) Bump `rewardPerTokenStored` normally via `_creditRewardPool(recycled)`
    ///          → divides by full `totalBoostedStake`, so total pending growth =
    ///          exactly `recycled` (no over-credit, conservation preserved).
    ///      (2) Pre-advance the caller's `p.rewardDebt` by their proportional share
    ///          `boostedAmount * recycled / totalBoostedStake`. The subsequent
    ///          `_getReward` call (which always follows in `extendLock` /
    ///          `toggleAutoMaxLock`) computes `diff = accumulated - rewardDebt` and
    ///          the bump cancels exactly, paying the caller only their PRE-fee
    ///          pending. Others get their full proportional share of `recycled`.
    ///      (3) `_applyNewBoost` (called after `_getReward`) recomputes
    ///          `p.rewardDebt` from scratch using the new boost, so the advance is
    ///          naturally consumed and won't leak forward.
    ///
    ///      Slight conservatism: the caller's "would-have-been" share of the bump
    ///      stays in the pool inventory (counted in `totalRewardsFunded` but not
    ///      claimable by anyone via this single tx). It is absorbed naturally by
    ///      the next `notifyRewardAmount` cycle (delta-measure pattern picks up
    ///      contract balance) or by subsequent recycles bumping the global
    ///      accumulator. This is conservative-safe: under-credit is acceptable,
    ///      over-credit (the original bug) was the bank-run vector.
    /// @param tokenId       Position token ID, for event emission.
    /// @param positionAmount Position's principal in TOWELI, for fee computation.
    /// @param p             Caller's position storage ref; used to read the pre-fee
    ///                      `boostedAmount` and pre-advance `rewardDebt` so the
    ///                      caller cannot claim any portion of their own fee in
    ///                      the immediately-following `_getReward`.
    function _chargeExtendFee(uint256 tokenId, uint256 positionAmount, Position storage p) internal {
        uint256 bps = extendFeeBps;
        if (bps == 0) return;
        uint256 fee = (positionAmount * bps) / BPS;
        if (fee == 0) return;
        (uint256 toTreasury, uint256 recycled) = _splitExtendFee(fee);
        if (toTreasury > 0) {
            rewardToken.safeTransferFrom(msg.sender, treasury, toTreasury);
        }
        if (recycled > 0) {
            // Pull the recycled slice into THIS contract so it sits in the reward pool.
            rewardToken.safeTransferFrom(msg.sender, address(this), recycled);
            // AUDIT FIX 2026-05-17 M10-REVISED: debt-advance pattern (see NatSpec).
            // Snapshot caller's boost + system total BEFORE the bump so the
            // advance uses the same denominator the bump will use.
            uint256 totalB = totalBoostedStake;
            uint256 callerBoost = p.boostedAmount;
            _creditRewardPool(recycled); // bumps rewardPerTokenStored by recycled*ACC/totalB
            if (totalB > 0 && callerBoost > 0) {
                // Cancel the caller's share of the bump. The product
                // (callerBoost * recycled) is bounded by (totalB * recycled) which
                // is bounded by the same uint256 product checked inside
                // _creditRewardPool — no separate overflow risk.
                p.rewardDebt += _safeInt256((callerBoost * recycled) / totalB);
            }
        }
        emit ExtendFeeCollected(tokenId, msg.sender, fee);
        emit ExtendFeeSplit(tokenId, msg.sender, toTreasury, recycled);
    }

    /// @dev AUDIT M-AUDIT-2026-1: split an extend fee into (toTreasury, recycled) per
    ///      `extendFeeRecycleBps`. If `totalBoostedStake == 0` there is no one to
    ///      recycle to, so the recycled slice is rebated to treasury for safekeeping.
    ///      Mirrors `_splitPenalty` (AUDIT C6) including the M-24 round-UP semantics
    ///      so sub-wei dust on small extend fees favors stakers (the recycle pool)
    ///      rather than treasury.
    function _splitExtendFee(uint256 fee) internal view returns (uint256 toTreasury, uint256 recycled) {
        if (fee == 0) return (0, 0);
        uint256 numerator = fee * extendFeeRecycleBps;
        recycled = numerator == 0 ? 0 : (numerator + BPS - 1) / BPS;
        if (recycled > fee) recycled = fee; // defensive (should never fire)
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (recycled > 0 && totalBoostedStake == 0) {
            // Nothing to credit — fall back to treasury so funds aren't stranded.
            recycled = 0;
        }
        toTreasury = fee - recycled;
    }

    /// @notice Apply a new extendFeeBps. Caller must be the wired admin contract.
    function applyExtendFee(uint256 _bps) external onlyAdmin {
        if (_bps > EXTEND_FEE_BPS_CEILING) revert ExtendFeeTooHigh();
        extendFeeBps = _bps;
    }

    /// @notice AUDIT M-AUDIT-2026-1: apply a new extendFeeRecycleBps. Caller must be the
    ///         wired admin contract. Capped at `BPS` (100% recycle).
    function applyExtendFeeRecycle(uint256 _bps) external onlyAdmin {
        if (_bps > BPS) revert ExtendFeeRecycleTooHigh();
        extendFeeRecycleBps = _bps;
    }

    // ─── AUDIT C6: Penalty-recycle helpers + timelocked setter ───────────

    /// @dev Split a penalty into (toTreasury, recycled) per penaltyRecycleBps. If
    ///      totalBoostedStake == 0 there is no one to recycle to, so the recycled
    ///      portion is rebated to treasury for safekeeping.
    ///
    ///      AUDIT M-24: round-UP `recycled` so sub-wei dust on small penalties favors
    ///      stakers (the recycle pool) rather than treasury. The legacy rounding bias
    ///      (floor) cumulatively drained the recycle pool of 1-wei increments per
    ///      small early-exit. Ceiling division here is bounded by `recycled <= penalty`
    ///      because penaltyRecycleBps is gated to <= BPS at propose time.
    function _splitPenalty(uint256 penalty) internal view returns (uint256 toTreasury, uint256 recycled) {
        if (penalty == 0) return (0, 0);
        // Ceiling: (a*b + d - 1) / d when a*b > 0; safe because penaltyRecycleBps <= BPS
        uint256 numerator = penalty * penaltyRecycleBps;
        recycled = numerator == 0 ? 0 : (numerator + BPS - 1) / BPS;
        if (recycled > penalty) recycled = penalty; // defensive (should never fire)
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (recycled > 0 && totalBoostedStake == 0) {
            // Nothing to credit — fall back to treasury so funds aren't stranded.
            recycled = 0;
        }
        toTreasury = penalty - recycled;
    }

    /// @dev Credit `amount` of TOWELI directly into rewardPerTokenStored, distributing
    ///      it pro-rata to all current stakers immediately. The TOWELI must already be
    ///      in this contract's balance (i.e., not transferred elsewhere) — the recycled
    ///      portion of a penalty is simply not transferred out, naturally satisfying this.
    function _creditRewardPool(uint256 amount) internal {
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0 || totalBoostedStake == 0) return;
        rewardPerTokenStored += (amount * ACC_PRECISION) / totalBoostedStake;
        totalRewardsFunded += amount;
    }

    /// @notice Apply a new penaltyRecycleBps. Caller must be the wired admin contract.
    function applyPenaltyRecycle(uint256 _bps) external onlyAdmin {
        if (_bps > BPS) revert PenaltyRecycleTooHigh();
        penaltyRecycleBps = _bps;
    }

    /// @notice Apply a new maxUnsettledRewards cap. Caller must be the wired admin contract.
    /// @dev    AUDIT FIX FRESH-2026: F-35-3 [INFO] — added a 10B TOWELI sanity ceiling
    ///         so a captured owner cannot reverse AUDIT FIX L-06 by setting cap to
    ///         `type(uint256).max` (which restores the unbounded-growth state L-06
    ///         was meant to prevent).
    uint256 public constant MAX_MAX_UNSETTLED = 1e10 ether; // 10B TOWELI sanity ceiling

    function applyMaxUnsettledRewards(uint256 _cap) external onlyAdmin {
        if (_cap < 10_000e18) revert CapTooLow();
        // AUDIT FIX FRESH-2026: F-35-3 — sanity ceiling against captured-owner bypass.
        if (_cap > MAX_MAX_UNSETTLED) revert CapTooHigh();
        maxUnsettledRewards = _cap;
    }

    /// @notice AUDIT FIX 2026-05-22 M19-PORT-INLINE: override `acceptOwnership` so any
    ///         pending INLINE timelock proposals queued by the outgoing owner are CANCELLED
    ///         on handoff. Mirrors the canonical TimelockAdmin override pattern from
    ///         `TegridyLaunchpadV2.acceptOwnership` (TegridyLaunchpadV2.sol:426-438), adapted
    ///         to this contract's inline `pendingStakingAdmin` / `adminReplacementReadyAt`
    ///         state (which predates TimelockAdmin and isn't keyed via `_executeAfter`).
    /// @dev    The inherited `stakingAdmin` rotation is the only inline-timelocked surface on
    ///         TegridyStaking — every other parameter delegates to TegridyStakingAdmin (whose
    ///         own acceptOwnership flush is in the sister PR). Without this override, an
    ///         outgoing/compromised owner could call `proposeAdminReplacement` immediately
    ///         before `transferOwnership`; the 48h timer would silently keep running and the
    ///         new owner inherits an executable admin swap.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (adminReplacementReadyAt != 0) {
            address proposed = pendingStakingAdmin;
            pendingStakingAdmin = address(0);
            adminReplacementReadyAt = 0;
            emit StakingAdminReplacementCancelled(proposed);
        }
    }
}
