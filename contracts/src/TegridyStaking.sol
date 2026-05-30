// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// AUDIT EIP-170 split (2026-05-30): OZ SafeERC20 swapped for Solady SafeTransferLib.
// Verbatim battle-tested code (Aerodrome, Uniswap V4 hooks ecosystem, many others);
// assembly-tight implementation is meaningfully smaller than OZ's Solidity version,
// with identical safety semantics (gracefully handles missing return values).
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
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
// AUDIT EIP-170 split (2026-05-30): OZ EnumerableSet swapped for Solady EnumerableSetLib.
// API-identical for UintSet → Uint256Set (length / contains / add / remove / at / values);
// Solady's assembly-tight storage layout is meaningfully smaller. Verbatim battle-tested
// (Aerodrome, Velodrome, many others). Fresh-deploy contract → storage layout change OK.
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";
// AUDIT EIP-170 split (2026-05-30): OZ SafeCast → Solady SafeCastLib. Verbatim
// battle-tested (Aerodrome, V4 hooks, many); assembly-tight checks vs OZ's Solidity
// implementation. API-compatible (toUint48 / toUint208 are byte-identical semantics).
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";
// AUDIT FIX (C1 EIP-170 split): Position struct + read-only view/math extracted to a
// linked (delegatecall) library to bring runtime bytecode under the 24,576-byte limit.
import {Position, StakingViewLib} from "./lib/StakingViewLib.sol";
// AUDIT FIX (C1 EIP-170 split): the LIVE reward-accounting cluster extracted to a
// linked (delegatecall) library to bring runtime bytecode under the 24,576-byte limit.
import {StakingRewardLib} from "./lib/StakingRewardLib.sol";

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
contract TegridyStaking is SoladyERC721, OwnableNoRenounce, ReentrancyGuard, Pausable, PauseGuardian {
    using SafeTransferLib for address;
    using Checkpoints for Checkpoints.Trace208;
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;

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

    // ─── mvp-launch Phase 0.7 — Stake Caps (Aave V3 / EigenLayer pattern) ──
    //
    // Caps gate every stake/increase entry-point to bound blast radius during
    // the TVL ramp. Per the battle plan:
    //   - Phase 6 (launch):  per-user 50_000 TOWELI,  global   5_000_000 TOWELI
    //   - Phase 7.1 ramp:    raise as 2-week clean windows clear, owner-only
    //                        propose/execute via TegridyStakingAdmin timelock.
    //
    // Initial defaults set in the constructor (NOT zero — zero is "no cap"
    // semantics in Aave; we use explicit conservative starting values).
    //
    // Reference: Aave V3 `supplyCap` + `borrowCap`, EigenLayer's per-token
    // deposit cap. Both shipped with caps in PRODUCTION on day 1 and lifted
    // only after monitored TVL stability windows.
    uint256 public maxStakePerUser;
    uint256 public maxTotalStaked;

    event MaxStakePerUserChanged(uint256 oldCap, uint256 newCap);
    event MaxTotalStakedChanged(uint256 oldCap, uint256 newCap);

    error PerUserStakeCapExceeded();
    error TotalStakeCapExceeded();
    error CapCannotBeZero();
    // EIP-170 golf 2026-05-30: `totalLocked()` removed. It was a 1-line alias for
    // `totalStaked` (the AUDIT H-4 fix for the old state-var-zero bug). `totalStaked` is
    // already public — integrators read it directly via the auto-getter. ABI rename only.

    uint256 private _nextTokenId = 1;

    // `Position` struct relocated to ./lib/StakingViewLib.sol (C1 EIP-170 split) so the
    // linked view library can operate on `positions` storage. Layout unchanged; the
    // `positions` public-getter ABI is identical. Field semantics preserved:
    //   amount, boostedAmount, rewardDebt, lockEnd, boostBps, lockDuration, autoMaxLock,
    //   hasJbacBoost, stakeTimestamp, jbacTokenId (0=none/legacy), jbacDeposited.

    mapping(uint256 => Position) public positions; // tokenId => position
    mapping(address => uint256) public userTokenId; // user => their tokenId (0 = no position)

    // AUDIT FIX M-5 (full aggregation): track every staking NFT owned by a given address.
    // Prior implementation overwrote userTokenId on each transfer, so votingPowerOf(holder)
    // silently undercounted multi-NFT holders (contract wallets, Safes, aggregating vaults).
    // Now votingPowerOf iterates the full set, summing active voting power across all positions.
    // Cap at MAX_POSITIONS_PER_HOLDER bounds checkpoint-write gas and votingPowerOf read gas;
    // also protects against push-grief (attacker flooding a target address with stale NFTs).
    mapping(address => EnumerableSetLib.Uint256Set) private _positionsByOwner;
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
    // AUDIT FIX (C1 EIP-170 split): visibility lowered public→internal to reclaim the
    // auto-getter bytecode (the final ~52B under the 24,576 limit). Zero off-chain
    // readers exist (verified repo-wide); the stranded record is observable via the
    // JbacReturnDeferred / JbacReturnRetried events, and recovery goes through
    // retryReturnJbacFromVault. Same de-getter pattern used across batch-14.
    mapping(uint256 => address) internal strandedJbacAtVaultOwner;
    mapping(uint256 => uint256) internal strandedJbacAtVaultId;

    // AUDIT FIX (pass-8): test/off-chain ABI compatibility shim. Internal
    // mapping uses `_` prefix to free the public name; this view surfaces
    // the same `name(tokenId) → value` shape as the original public-mapping
    // auto-getter at minimal bytecode cost (~30B).
    function emergencyExitRequests(uint256 tokenId) external view returns (uint256) { return _emergencyExitRequests[tokenId]; }

    // ─── REMOVED for EIP-170 size (deferred to a later version) ──────────
    // The extend-lock fee (AUDIT C5: `extendFeeBps` + `EXTEND_FEE_BPS_CEILING`),
    // the penalty-recycle split (AUDIT C6: `penaltyRecycleBps`), and the extend-fee
    // recycle split (AUDIT M-AUDIT-2026-1: `extendFeeRecycleBps`) were all removed
    // to bring this contract under the 24,576-byte limit. Every one of those bps
    // defaulted to 0, so at the launch config they were dormant: extendLock /
    // toggleAutoMaxLock charged no fee, and the entire early-withdrawal penalty
    // already went to treasury. Removal is therefore behaviour-identical to the
    // launch config. The matching propose/execute/cancel flows were removed from
    // TegridyStakingAdmin.sol in the same change.


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
    /// @notice AUDIT FIX 2026-05-26 [M-07] — observability for restaking-contract rotation
    ///         emitted directly on the staking contract (admin sister already emits
    ///         RestakingContractChanged on the admin path).
    event RestakingContractApplied(address indexed oldR, address indexed newR);
    /// @notice AUDIT FIX 2026-05-26 [M-08] — observability for lending-whitelist toggles
    ///         emitted directly on the staking contract (admin sister already emits
    ///         LendingContractUpdated on the admin path).
    event LendingContractApplied(address indexed lending, bool approved);
    // NOTE: ExtendFeeCollected / ExtendFeeSplit (AUDIT C5 / M-AUDIT-2026-1) and
    // PenaltySplit (AUDIT C6) were removed with the extend-fee + penalty-recycle
    // machinery (EIP-170 size). The full-penalty-to-treasury path emits the
    // existing `PenaltySentToTreasury` event instead.

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
    // NOTE: ExtendFeeTooHigh / PenaltyRecycleTooHigh / ExtendFeeRecycleTooHigh
    // removed with the extend-fee + penalty-recycle machinery (EIP-170 size).
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
    /// @notice AUDIT FIX 2026-05-26 [H-11] — claimUnsettledForTokenId caller must be
    ///         the current escrow holder of the staking NFT. Prevents one whitelisted
    ///         lending contract from draining per-tokenId rewards attributed to a
    ///         position physically held by a different lending/restaking contract.
    error NotEscrowedHere();
    /// @notice AUDIT FIX 2026-05-26 [L-27] — pause guardian must not equal owner
    ///         (enforce role separation on-chain).
    error PauseGuardianEqualsOwner();
    /// @notice AUDIT FIX 2026-05-26 [M-07] — applyRestakingContract no-op rotation guard.
    error SameValue();
    /// @notice AUDIT FIX 2026-05-26 [H-09] — clearer error than Unauthorized when the
    ///         one-shot setStakingAdmin is called a second time.
    error AdminAlreadySet();

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

        // mvp-launch Phase 0.7: caps default uncapped at construction. The
        // operator sets them DOWN to launch values (50k/5M per battle plan)
        // via setMaxStakePerUser / setMaxTotalStaked BEFORE transferOwnership.
        // Aave V3 follows the same "constructor uncapped, ops sets at deploy"
        // pattern via setSupplyCap on the PoolConfigurator. This keeps test
        // fixtures simple — unit tests that don't exercise caps don't need to
        // override the default.
        maxStakePerUser = type(uint256).max;
        maxTotalStaked  = type(uint256).max;
    }

    /// @notice Owner-only setter for the per-user stake cap. Initial value
    ///         50k TOWELI; raise as Phase 7 TVL ramp clears stability windows.
    /// @dev    Zero is forbidden — use pause()/guardianPause() to halt new
    ///         stakes, not zero-cap, so the semantic stays explicit. Cap can
    ///         be raised OR lowered; lowering does not retroactively shrink
    ///         existing positions (those keep their full stake).
    function setMaxStakePerUser(uint256 _newCap) external onlyOwner {
        if (_newCap == 0) revert CapCannotBeZero();
        uint256 old = maxStakePerUser;
        maxStakePerUser = _newCap;
        emit MaxStakePerUserChanged(old, _newCap);
    }

    /// @notice Owner-only setter for the global stake cap. Initial value
    ///         5M TOWELI; raise per Phase 7 schedule.
    function setMaxTotalStaked(uint256 _newCap) external onlyOwner {
        if (_newCap == 0) revert CapCannotBeZero();
        uint256 old = maxTotalStaked;
        maxTotalStaked = _newCap;
        emit MaxTotalStakedChanged(old, _newCap);
    }

    /// @notice Current global-stake-cap utilization in basis points.
    /// @dev    mvp-launch Phase 0.7 monitoring helper. Forta + Defender
    ///         alert at 8000 bps (80%) to trigger Phase 7 cap-raise review.
    ///         Returns 10000 (100%) if the cap is fully consumed; 0 if no
    ///         stakes yet; saturates at 10000 (cannot exceed because
    ///         stake() reverts above cap).
    function stakeCapUtilizationBps() external view returns (uint256) {
        uint256 cap = maxTotalStaked;
        if (cap == 0 || cap == type(uint256).max) return 0;
        uint256 staked = totalStaked;
        if (staked >= cap) return 10000;
        return (staked * 10000) / cap;
    }

    /// @notice Remaining headroom under the global stake cap, in TOWELI wei.
    /// @dev    Front-end consumes this to gate the "stake max" affordance.
    ///         Returns 0 if cap is reached or unset-as-max sentinel.
    function stakeCapHeadroom() external view returns (uint256) {
        uint256 cap = maxTotalStaked;
        if (cap == type(uint256).max) return type(uint256).max;
        uint256 staked = totalStaked;
        return staked >= cap ? 0 : cap - staked;
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
        // AUDIT FIX 2026-05-26 [L-25] — Type-filter only (rejects EOAs and 7702-delegated
        // EOAs); NOT a capability check. Operator MUST verify the vault contract
        // implements ITegridyStakingJbacVault.returnJbac and was deployed with
        // `staking = address(this)` immutable.
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

    // C1 EIP-170 split: `_reserved()` and `_settleUnsettled()` moved into
    // StakingRewardLib (their only callers — the reward cluster — now delegate there).
    // `_decayIfExpired` is kept here (and called by the host wrappers AFTER the
    // library settles): the library functions cannot also take the checkpoint/voting
    // storage refs without exceeding the via-IR stack depth, so the decay tail runs
    // host-side. This pattern applies to BOTH `kick` AND `getReward` post-M5 fix.
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
    ///      EnumerableSetLib.Uint256Set maintained in `_update`) and sum the active voting
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
    function votingPowerOf(address user) public view returns (uint256) {
        // Restaking/lending escrow carve-out (AUDIT FIX M-5 + FRESH-2026
        // STAKING-MAX-POS-ESCROW-CARVE-OUT): these addresses expose power via their
        // own per-holder aggregation; force 0 here to avoid double-count and O(n)
        // iteration. The per-position summation is delegated to StakingViewLib (C1).
        if (user == restakingContract || isLendingContract[user]) return 0;
        return StakingViewLib.votingPowerOf(_positionsByOwner[user], positions);
    }

    // votingPowerAt() removed — use votingPowerAtTimestamp() instead

    /// @notice Voting power at a specific timestamp using OZ Checkpoints.Trace208.
    /// @param user The address to query historical voting power for
    /// @param ts The timestamp to look up
    /// @return Voting power at the given timestamp (0 if no checkpoint exists before that time)
    function votingPowerAtTimestamp(address user, uint256 ts) public view returns (uint256) {
        return _checkpoints[user].upperLookup(SafeCastLib.toUint48(ts));
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
        return _totalBoostedStakeCheckpoints.upperLookup(SafeCastLib.toUint48(ts));
    }

    /// @notice AUDIT REV-M-01: number of `_totalBoostedStakeCheckpoints` entries.
    ///         Exposed for off-chain integrators / dashboards to size pagination.
    // AUDIT EIP-170 golf: external → internal (verified zero on-chain/script/test
    // callers via repo-wide grep 2026-05-29). _totalBoostedStakeCheckpoints itself
    // remains public; reconstruct length from that getter if needed off-chain.
    function totalBoostedStakeNumCheckpoints() internal view returns (uint256) {
        return _totalBoostedStakeCheckpoints.length();
    }

    /// @dev AUDIT REV-M-01: write `totalBoostedStake` to the system-wide Trace208
    ///      checkpoint at the current block.timestamp. Mirrors the per-user
    ///      `_writeCheckpoint(user)` no-op-on-unchanged pattern (NEW-S7) so we don't
    ///      bloat checkpoints when a delta nets to zero (e.g., `_applyNewBoost` that
    ///      decrements then increments the identical amount on a no-op boost rewrite).
    function _writeTotalBoostedStakeCheckpoint() internal {
        uint208 newTotal = SafeCastLib.toUint208(totalBoostedStake);
        uint208 last = _totalBoostedStakeCheckpoints.latest();
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (last == newTotal) return;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        _totalBoostedStakeCheckpoints.push(SafeCastLib.toUint48(block.timestamp), newTotal);
    }

    /// @notice AUDIT H12: amount-weighted average active boost across all of `user`'s
    ///         positions. Returns 0 if no active positions. Used by integrators (e.g.,
    ///         TegridyLPFarming) that need a single boost ratio per user — bypasses the
    ///         single-pointer `userTokenId` undercount for multi-NFT contract holders.
    /// @return weightedBps amount-weighted boostBps in [MIN_BOOST_BPS, MAX_BOOST_BPS+JBAC_BONUS_BPS]
    function aggregateActiveBoostBps(address user) external view returns (uint256) {
        // Same restaking/lending escrow carve-out as votingPowerOf; per-position
        // weighting delegated to StakingViewLib (C1 EIP-170 split).
        if (user == restakingContract || isLendingContract[user]) return 0;
        return StakingViewLib.aggregateActiveBoostBps(_positionsByOwner[user], positions);
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
    // AUDIT EIP-170 golf: external → internal (verified zero on-chain/script/test
    // callers via repo-wide grep 2026-05-29). EnumerableSet maintains cardinality;
    // off-chain consumers can derive from _positionsByOwner events.
    function userPositionCount(address user) internal view returns (uint256) {
        return _positionsByOwner[user].length();
    }

    // EIP-170 sibling: `earned(uint256)` and `getPosition(uint256)` moved verbatim to
    // src/StakingMonitorView.sol, deployed alongside this contract. Off-chain consumers
    // call those views on the sibling's address. ABI signatures are byte-identical.
    // The on-host pure-storage `StakingViewLib.earned` remains for any future in-contract
    // use; the sibling uses the memory variant `StakingViewLib.earnedFromMem`.

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
    // ─── C1 EIP-170 split: reward-state marshalling choke-points ─────────
    // Standalone scalar state vars cannot be passed to a delegatecall library by
    // storage reference, so the reward cluster is marshalled through these two
    // helpers: load the four mutable scalars into a memory struct, let the library
    // mutate them, then write ALL FOUR back in one place. Routing every cluster
    // wrapper through the SAME store helper makes a dropped write-back impossible.
    function _loadRewardState() private view returns (StakingRewardLib.RewardState memory rs) {
        rs.rewardPerTokenStored = rewardPerTokenStored;
        rs.lastUpdateTime = lastUpdateTime;
        rs.totalBoostedStake = totalBoostedStake;
        rs.totalUnsettledRewards = totalUnsettledRewards;
    }

    function _storeRewardState(StakingRewardLib.RewardState memory rs) private {
        rewardPerTokenStored = rs.rewardPerTokenStored;
        lastUpdateTime = rs.lastUpdateTime;
        totalBoostedStake = rs.totalBoostedStake;
        totalUnsettledRewards = rs.totalUnsettledRewards;
    }

    function _rewardCfg() private view returns (StakingRewardLib.Cfg memory cfg) {
        cfg.totalStaked = totalStaked;
        cfg.maxUnsettledRewards = maxUnsettledRewards;
        cfg.rewardRate = rewardRate;
        cfg.rewardToken = rewardToken;
        cfg.restakingContract = restakingContract;
        cfg.isPaused = paused();
    }

    function _accumulateRewards() private {
        // C1 EIP-170 split: body delegated to StakingRewardLib (behaviour-identical).
        StakingRewardLib.RewardState memory rs = _loadRewardState();
        rs = StakingRewardLib.accumulateRewards(rs, _rewardCfg());
        _storeRewardState(rs);
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

    // ─── Pause-Guardian Emergency Surface (mvp-launch Phase 0.4) ──────

    /// @notice Set the pause-only emergency multisig. Owner-gated, instant
    ///         rotation. Aave V3 EMERGENCY_ADMIN_ROLE pattern.
    /// @dev    Rotation is instant by design: if the hot guardian's keys are
    ///         compromised, the slow cold owner needs to react faster than any
    ///         timelock would allow. Compromising the guardian alone yields only
    ///         nuisance-pause risk (recoverable via owner.unpause), so a fast
    ///         rotation is the correct trade.
    function setPauseGuardian(address _newGuardian) external onlyOwner {
        // AUDIT FIX 2026-05-26 [L-27] — enforce role separation on-chain. If the
        // pause guardian were the same address as the owner, the "guardian can
        // freeze but cannot thaw" property documented above would silently
        // collapse (the merged role can both freeze AND thaw, defeating the
        // Aave/Lido GateSeal pattern this surface mimics). Reject the merge.
        if (_newGuardian == owner()) revert PauseGuardianEqualsOwner();
        _setPauseGuardian(_newGuardian);
    }

    /// @notice Emergency pause callable by the pause-only guardian multisig.
    /// @dev    Same pre-pause `_accumulateRewards` semantics as `pause()` so
    ///         the guardian-pause path does not lose the elapsed-segment
    ///         emission window. Unpause stays owner-only — the guardian can
    ///         freeze but cannot thaw, matching Aave / Lido GateSeal model.
    function guardianPause() external onlyPauseGuardian {
        _accumulateRewards();
        _pause();
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
        // mvp-launch Phase 0.7: stake caps. Aave V3 / EigenLayer pattern.
        if (_amount > maxStakePerUser) revert PerUserStakeCapExceeded();
        if (totalStaked + _amount > maxTotalStaked) revert TotalStakeCapExceeded();

        uint256 boost = calculateBoost(_lockDuration);
        // AUDIT H-1 (2026-04-20): No JBAC boost on stake(). Use stakeWithBoost() for that.
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        uint256 boosted = (_amount * boost) / BOOST_PRECISION;
        // AUDIT FIX 2026-05-26 [L-39] — defensive bounds check before uint16 cast.
        // Current MAX_BOOST_BPS (40000) is well below uint16 max (65535), so this
        // is dormant at launch — but mirrors `_applyNewBoost`'s guard so any
        // future raise of MAX_BOOST_BPS / JBAC_BONUS_BPS that breaches the
        // uint16 ceiling reverts here rather than silently truncating boostBps.
        if (boost > type(uint16).max) revert BoostOverflow();

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
        address(rewardToken).safeTransferFrom(msg.sender, address(this), _amount);

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
        // mvp-launch Phase 0.7: stake caps. Aave V3 / EigenLayer pattern.
        if (_amount > maxStakePerUser) revert PerUserStakeCapExceeded();
        if (totalStaked + _amount > maxTotalStaked) revert TotalStakeCapExceeded();
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
        // AUDIT FIX 2026-05-26 [L-39] — defensive bounds check before uint16 cast.
        // Current MAX_BOOST_BPS (40000) + JBAC_BONUS_BPS (5000) = 45000, well
        // under uint16 max (65535), so this is dormant at launch — but mirrors
        // `_applyNewBoost`'s guard so any future raise of the boost ceilings
        // reverts here rather than silently truncating boostBps.
        if (boost > type(uint16).max) revert BoostOverflow();

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
        address(rewardToken).safeTransferFrom(msg.sender, address(this), _amount);
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
    /// @dev    NOTE: the extend-lock fee (AUDIT C5) that previously applied on enable
    ///         was removed for EIP-170 size. Its bps defaulted to 0 (no fee at
    ///         launch); deferred to a later version. Enabling still maximises boost.
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
        // `lockEnd` to MAX, which on an already-expired position is the
        // equivalent of reviving a dead lock for free boost.
        // Reject the enable path on expired positions; users must `withdraw`
        // and re-stake fresh to restore boost.
        if (!wasOn && p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
        p.autoMaxLock = !wasOn;

        // If enabling, extend lock to max immediately
        if (p.autoMaxLock) {
            // NOTE: the extend-lock fee (AUDIT C5) was removed for EIP-170 size.
            // Its bps defaulted to 0 (no fee charged at launch), so removal is
            // behaviour-identical to the launch config; deferred to a later version.
            // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
            _getReward(tokenId, p);
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
            p.lockDuration = uint32(MAX_LOCK_DURATION);
            // SECURITY FIX #4: Only recalculate lock-duration boost, keep cached JBAC status
            // from stake time to prevent flash-loan JBAC boost manipulation
            uint256 newBoost = MAX_BOOST_BPS;
            // AUDIT FIX 2026-05-26 [L-11] — mirror the `getReward` JBAC re-validation
            // pattern (sibling at lines 1244-1262). Legacy
            // `hasJbacBoost && !jbacDeposited` positions can have their JBAC silently
            // sold/transferred between stake-time and now; restoring the bonus
            // unconditionally on enable perpetuates a stale flag. Deposited JBACs
            // (`jbacDeposited==true`) sit in the vault and are always valid; legacy
            // positions get a balanceOf re-check against the actual holder
            // (resolved via the restaking lookup when the caller IS the restaking
            // contract). On transient lookup failure the cached flag is preserved
            // — same F3-PERMA-STRIP defense as `getReward`.
            {
                // EIP-170/DRY: JBAC re-validation moved to StakingViewLib.resolveJbac
                // (behaviour-identical; F3-PERMA-STRIP preserved). Was inline here, in
                // extendLock, and in getReward — three copies of security-critical code.
                (bool jbacValid, bool clearStale) =
                    StakingViewLib.resolveJbac(p, tokenId, msg.sender, restakingContract, jbacNFT);
                if (jbacValid) {
                    newBoost += JBAC_BONUS_BPS;
                } else if (clearStale) {
                    p.hasJbacBoost = false;
                }
            }
            _applyNewBoost(p, newBoost);
        }

        _writeCheckpoint(msg.sender); // AUDIT FIX #1
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit AutoMaxLockToggled(tokenId, p.autoMaxLock);
    }

    /// @notice Extend the lock duration of an existing position
    /// @dev    NOTE: the extend-lock fee (AUDIT C5) was removed for EIP-170 size.
    ///         Its bps defaulted to 0 (no fee at launch); deferred to a later version.
    /// @param tokenId The NFT token ID of the staking position
    /// @param _newLockDuration New lock duration in seconds (must be longer than current)
    function extendLock(uint256 tokenId, uint256 _newLockDuration) external nonReentrant whenNotPaused updateReward {
        Position storage p = _ownedPosition(tokenId, msg.sender);
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

        // NOTE: the extend-lock fee (AUDIT C5) was removed for EIP-170 size. Its
        // bps defaulted to 0 (no fee at launch), so removal is behaviour-identical
        // to the launch config; deferred to a later version.

        // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
        _getReward(tokenId, p);

        p.lockDuration = uint32(_newLockDuration);
        p.lockEnd = uint64(block.timestamp + _newLockDuration);

        uint256 newBoost = calculateBoost(_newLockDuration);
        // AUDIT FIX 2026-05-26 [L-11] — mirror the `getReward` JBAC re-validation
        // pattern (sibling at lines 1244-1262). Extending a lock re-applies the
        // cached `hasJbacBoost` flag to the new boost — for legacy
        // `hasJbacBoost && !jbacDeposited` positions whose JBAC was sold/transferred
        // since stake-time, this perpetuates a stale flag. Same gate shape as
        // `getReward` / `toggleAutoMaxLock`: deposited JBACs are always valid;
        // legacy positions get a balanceOf re-check; restaking-contract callers
        // resolve to the depositor; transient lookup failure preserves the
        // cached flag (F3-PERMA-STRIP defense).
        {
            // EIP-170/DRY: see toggleAutoMaxLock — same lib call, byte-identical semantics.
            (bool jbacValid, bool clearStale) =
                StakingViewLib.resolveJbac(p, tokenId, msg.sender, restakingContract, jbacNFT);
            if (jbacValid) {
                newBoost += JBAC_BONUS_BPS;
            } else if (clearStale) {
                p.hasJbacBoost = false;
            }
        }
        _applyNewBoost(p, newBoost);

        _writeCheckpoint(msg.sender); // AUDIT FIX #1
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit LockExtended(tokenId, _newLockDuration, p.lockEnd);
    }

    /// @notice Add more TOWELI to an existing staking position without withdrawing.
    /// @param tokenId The NFT token ID of the staking position
    /// @param _additionalAmount Amount of TOWELI to add (must be >= MIN_STAKE)
    function increaseAmount(uint256 tokenId, uint256 _additionalAmount) external nonReentrant whenNotPaused updateReward {
        Position storage p = _ownedPosition(tokenId, msg.sender);
        if (_additionalAmount == 0) revert ZeroAmount();
        if (_additionalAmount < MIN_STAKE) revert StakeTooSmall(); // AUDIT FIX: prevent dust spam
        // AUDIT FIX: reject increase on expired positions — would create zombie boosted stake
        // that dilutes all active stakers' rewards without earning anything
        // L-01 FIX: Error name was semantically inverted — lock HAS expired, not "not expired"
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();
        // mvp-launch Phase 0.7: stake caps applied to post-increase totals.
        if (p.amount + _additionalAmount > maxStakePerUser) revert PerUserStakeCapExceeded();
        if (totalStaked + _additionalAmount > maxTotalStaked) revert TotalStakeCapExceeded();

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
        // original `boostBps` was retro-applied to the new principal, letting a
        // whale dribble in additional stake at MAX boost in the final days of a
        // long lock. We use the SMALLER of cached `boostBps` and the boost
        // derivable from current remaining lock time. Existing-principal earned
        // its rate honestly so we never raise above cached; new principal earns
        // only what the remaining lock supports.
        uint256 cachedBoost = uint256(p.boostBps);
        uint256 remaining = p.lockEnd > block.timestamp ? p.lockEnd - block.timestamp : 0;
        uint256 remainingBoost = calculateBoost(remaining);
        if (p.hasJbacBoost) remainingBoost += JBAC_BONUS_BPS;
        uint256 effectiveBoost = remainingBoost < cachedBoost ? remainingBoost : cachedBoost;
        _applyNewBoost(p, effectiveBoost);

        // Transfer tokens
        address(rewardToken).safeTransferFrom(msg.sender, address(this), _additionalAmount);

        // Update voting power
        _writeCheckpoint(msg.sender);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate

        emit AmountIncreased(tokenId, _additionalAmount, p.amount);
    }

    /// @notice Withdraw after lock expires. No penalty. Burns the position NFT.
    /// @param tokenId The NFT token ID of the staking position to withdraw
    function withdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        Position storage p = _ownedPosition(tokenId, msg.sender);
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

        address(rewardToken).safeTransfer(msg.sender, amount);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
        emit Withdrawn(msg.sender, tokenId, amount);
    }

    /// @notice Early withdrawal — 25% penalty sent to treasury.
    /// @dev AUDIT FIX L-23: Corrected comment — penalty goes to treasury, not redistributed to stakers.
    /// @param tokenId The NFT token ID of the staking position to early-withdraw
    function earlyWithdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        Position storage p = _ownedPosition(tokenId, msg.sender);
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

        // Entire penalty goes to treasury (AUDIT FIX L-23). The penalty-recycle
        // split was removed for EIP-170 size (its bps defaulted to 0, so this is
        // behaviour-identical to the launch config); deferred to a later version.
        address(rewardToken).safeTransfer(treasury, penalty);
        address(rewardToken).safeTransfer(msg.sender, userReceives);
        _touch(msg.sender); // AUDIT R014 M-9: refresh inactivity gate
        emit PenaltySentToTreasury(tokenId, penalty);
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
        Position storage p = _ownedPosition(tokenId, msg.sender);

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
                // EIP-170/DRY: JBAC re-validation moved to StakingViewLib.resolveJbac.
                // F3-PERMA-STRIP defence preserved inside the lib (transient restaking
                // lookup failure leaves the cached flag intact — no permanent strip since
                // revalidateBoost is one-way downgrade with no recovery path).
                (bool jbacValid, bool clearStale) =
                    StakingViewLib.resolveJbac(p, tokenId, msg.sender, restakingContract, jbacNFT);
                uint256 newBoost = MAX_BOOST_BPS;
                if (jbacValid) {
                    newBoost += JBAC_BONUS_BPS;
                } else if (clearStale) {
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
        // C1 EIP-170 split: the settle/forfeit body is delegated to StakingRewardLib
        // (behaviour-identical). Guards + `prior` capture stay here; `holder =
        // ownerOf(tokenId)` is resolved here (ownership storage is not reachable from a
        // delegatecall lib). The decay + post-decay checkpoint + PositionKicked emit run
        // host-side AFTER the library settles — keeping the library `kick` under the
        // via-IR stack-depth limit and preserving the exact original ordering
        // (settle pre-expiry rewards, then decay boost, then write the post-state).
        address holder = ownerOf(tokenId);
        StakingRewardLib.RewardState memory rs = _loadRewardState();
        rs = StakingRewardLib.kick(
            rs,
            p,
            tokenId,
            holder,
            prior,
            unsettledRewards,
            unsettledRewardsByTokenId,
            isLendingContract,
            lastActivityAt,
            _rewardCfg()
        );
        _storeRewardState(rs);
        _decayIfExpired(tokenId, p);
        _writeCheckpoint(holder); // DS3-06: record the post-decay voting power
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
        // AUDIT FIX 2026-05-26 [L-12] — wrap the external lookup in try/catch to
        // mirror the `getReward` sibling at lines 1244-1259. Without this, a
        // restaking-contract upgrade window (interface mismatch / paused view)
        // would propagate the revert up to revalidateBoost callers, bricking the
        // downgrade path for the legitimate case. On lookup failure we fall
        // through with positionOwner — for the restaking-contract path that
        // means the balanceOf check below evaluates against the restaking
        // contract itself (which never holds JBAC), reading as "no JBAC" → the
        // downgrade fires. Conservative outcome: legitimate restaked positions
        // whose depositor still holds the JBAC can re-call after the lookup heals.
        address jbacHolder = positionOwner;
        if (positionOwner == restakingContract && restakingContract != address(0)) {
            try ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId) returns (address depositor) {
                if (depositor != address(0)) { jbacHolder = depositor; }
            } catch { /* fall through with positionOwner */ }
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
        // C1 EIP-170 split: per-owner set / userTokenId / autoMaxLock / emergency-exit
        // bookkeeping delegated to StakingRewardLib (behaviour-identical, no reward-scalar
        // marshalling). The voting-power checkpoints + paused-conditional touch run here
        // AFTER the library returns — they sit after BOTH set updates so the recorded
        // values are identical, and host-side keeps the library under the via-IR stack limit.
        StakingRewardLib.afterTokenTransfer(
            from,
            to,
            id,
            _positionsByOwner,
            positions,
            userTokenId,
            _emergencyExitRequests,
            isLendingContract,
            restakingContract
        );
        if (from != address(0)) _writeCheckpoint(from);
        if (to != address(0)) {
            _writeCheckpoint(to);
            // AUDIT FIX 2026-05-20 M16-REVISED: paused-conditional skip closes the
            // bounce-transfer inactivity-gate bypass (SoladyERC721 has no pause hook).
            if (!paused()) _touch(to);
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

    /// @dev EIP-170 dedup: the (ownerOf == caller, Position storage p, p.amount != 0)
    ///      triplet appeared inline in 9 user-facing functions. Collapsing to one internal
    ///      helper that returns the storage ref preserves byte-identical behaviour AND
    ///      lets the optimizer keep one shared body instead of 9 copies.
    function _ownedPosition(uint256 tokenId, address caller)
        internal view returns (Position storage p)
    {
        if (ownerOf(tokenId) != caller) revert NotPositionOwner();
        p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
    }

    // AUDIT FIX C-03: Safe int256 cast — only transfer if accumulated > rewardDebt
    function _getReward(uint256 tokenId, Position storage p) internal returns (uint256 claimed) {
        // C1 EIP-170 split: body delegated to StakingRewardLib (behaviour-identical).
        // `ownerOf(tokenId)` is resolved here (immutables / ownership storage are not
        // reachable from a delegatecall lib) and passed as `recipient`.
        // AUDIT FIX 2026-05-27 [M5]: decay now runs HOST-side AFTER the library
        // credits rewards (mirrors the `kick` pattern — see kick() ~line 1448).
        // Pre-M5, the library called _decayIfExpired mid-function before crediting,
        // which could strand cap-blocked residual in the inert post-decay slot.
        // The library's M5 force-settle handles expiry residual before returning;
        // we decay here so checkpoints and totalBoostedStake are updated correctly.
        StakingRewardLib.RewardState memory rs = _loadRewardState();
        (claimed, rs) = StakingRewardLib.getReward(
            rs,
            p,
            tokenId,
            ownerOf(tokenId),
            unsettledRewards,
            unsettledRewardsByTokenId,
            _checkpoints,
            _totalBoostedStakeCheckpoints,
            _positionsByOwner,
            positions,
            isLendingContract,
            _rewardCfg()
        );
        _storeRewardState(rs);
        // [M5]: decay host-side AFTER crediting (same pattern as kick).
        _decayIfExpired(tokenId, p);
    }

    /// @notice AUDIT FIX C-04: Settle rewards to the previous owner on NFT transfer.
    ///         Updates rewardPerTokenStored inline (same logic as updateReward modifier) and
    ///         sends pending rewards to `from`, then resets rewardDebt for the new owner.
    function _settleRewardsOnTransfer(uint256 tokenId, address from) private {
        // C1 EIP-170 split: body delegated to StakingRewardLib (behaviour-identical).
        StakingRewardLib.RewardState memory rs = _loadRewardState();
        rs = StakingRewardLib.settleRewardsOnTransfer(
            rs,
            positions[tokenId],
            tokenId,
            from,
            unsettledRewards,
            unsettledRewardsByTokenId,
            isLendingContract,
            lastActivityAt,
            _rewardCfg()
        );
        _storeRewardState(rs);
    }

    /// @notice Write a checkpoint for the user's current voting power (OZ Checkpoints.Trace208).
    /// @dev AUDIT NEW-S7 (MEDIUM): skip the push when power is unchanged. The previous
    ///      unconditional push wrote ~5-20k gas of SSTORE on every no-op transfer /
    ///      lending round-trip, and grew `_checkpoints[user]` forever for users near
    ///      the MAX_POSITIONS_PER_HOLDER cap. Compound / OZ Governor both compare
    ///      against the latest checkpoint before pushing.
    function _writeCheckpoint(address user) internal {
        uint256 power = votingPowerOf(user);
        uint208 newPower = SafeCastLib.toUint208(power);
        uint208 last = _checkpoints[user].latest();
        if (last == newPower) return;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        _checkpoints[user].push(SafeCastLib.toUint48(block.timestamp), newPower);
    }

    event UnsettledClaimed(address indexed user, uint256 amount);

    /// @notice AUDIT FIX M-04: Claim rewards accumulated during NFT transfers.
    ///         Rewards are stored in a mapping during transfer to prevent reverts.
    /// @dev AUDIT FIX v2: Retains unsettled amount on partial payout instead of zeroing
    function claimUnsettled() external nonReentrant whenNotPaused {
        // AUDIT FIX (guard symmetry): tracked holders (restakingContract + whitelisted
        // lending contracts) MUST drain only via `claimUnsettledForTokenId` so the
        // per-tokenId backing stays in lockstep with the holder bucket. Without this,
        // a tracked-holder contract calling `claimUnsettled()` would zero its bucket
        // while leaving `unsettledRewardsByTokenId[*]` dangling — permanently bricking
        // every restaker/borrower's per-tokenId recovery. Mirrors the identical guard
        // in `claimUnsettledFor`.
        if (_isTrackedHolder(msg.sender)) revert Unauthorized();
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
        // AUDIT FIX 2026-05-26 [H-11 REVERTED 2026-05-26 self-audit] — the
        // ownership-at-drain-time check broke the documented C-1 POST-transfer
        // residue pull pattern: TegridyRestaking.unrestake/emergencyWithdrawNFT/
        // emergencyForceReturn pull per-tokenId residue AFTER transferring the
        // NFT to the user, at which point `ownerOf(tokenId)` is the user (not
        // the restakingContract that credited the residue). The H-11 check
        // silently reverted (try/catch absorbed) and stranded user residue.
        //
        // The original H-11 threat ("cross-lending attribution theft") is
        // bounded by `min(perTokenId, msg.sender's bucket, pool)` so a
        // captured lending contract can only drain UP TO ITS OWN BUCKET. That
        // is the existing _isTrackedHolder gate behavior. The full fix
        // requires per-tokenId attribution tracking (new storage slot) — a
        // larger surgery deferred to a dedicated PR. The `NotEscrowedHere`
        // error declaration is preserved for that future fix.
        if (recipient == address(0)) revert ZeroAddress();

        // C1 EIP-170 split: body delegated to StakingRewardLib (behaviour-identical).
        (paid, totalUnsettledRewards) = StakingRewardLib.claimUnsettledForTokenId(
            unsettledRewardsByTokenId,
            unsettledRewards,
            tokenId,
            msg.sender,
            recipient,
            totalUnsettledRewards,
            totalStaked,
            rewardToken
        );
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
        // C1 EIP-170 split: body delegated to StakingRewardLib (behaviour-identical).
        totalUnsettledRewards = StakingRewardLib.claimUnsettledInternal(
            unsettledRewards, _user, totalUnsettledRewards, totalStaked, rewardToken
        );
    }

    // ─── Emergency ─────────────────────────────────────────────────────

    /// @notice AUDIT FIX #11: Emergency withdraw — ONLY callable when contract is paused.
    ///         Forfeits all pending rewards.
    function emergencyWithdrawPosition(uint256 tokenId) external nonReentrant whenPaused {
        Position storage p = _ownedPosition(tokenId, msg.sender);

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        uint256 amount = _clearPosition(tokenId, p);

        address(rewardToken).safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Pause-independent emergency exit for expired positions.
    ///         Returns staked principal. Works regardless of pause state.
    ///         AUDIT FIX M-05: Attempts reward claim via try/catch before exit.
    ///         Previously silently forfeited all accrued rewards.
    /// @param tokenId The NFT token ID of the staking position to exit
    function emergencyExitPosition(uint256 tokenId) external nonReentrant updateReward {
        Position storage p = _ownedPosition(tokenId, msg.sender);
        if (block.timestamp < p.lockEnd) revert LockStillActive();

        // AUDIT FIX M-05: Attempt reward claim before exit. If reward transfer reverts
        // (e.g., token blacklist), continue with principal return rather than trapping both.
        _getReward(tokenId, p);

        // CCR-01 (batch-9 / batch-14): JBAC capture + post-burn return inside `_clearPosition`.
        uint256 amount = _clearPosition(tokenId, p);

        address(rewardToken).safeTransfer(msg.sender, amount);
        emit EmergencyExitPosition(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Request an emergency exit (pause-independent, works at any time).
    ///         Initiates a 7-day delay before the exit can be executed. Forfeits all rewards.
    /// @dev AUDIT M-AUDIT-2026-3: refresh `_touch(msg.sender)` so the owner-side
    ///      `claimUnsettledFor(msg.sender)` 90-day inactivity gate doesn't fire while
    ///      the user is mid-emergency-exit. A user actively exiting is clearly active.
    /// @param tokenId The NFT token ID of the staking position
    function requestEmergencyExit(uint256 tokenId) external nonReentrant {
        Position storage p = _ownedPosition(tokenId, msg.sender);
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
        Position storage p = _ownedPosition(tokenId, msg.sender);
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
            // Entire penalty goes to treasury — same path as earlyWithdraw. The
            // penalty-recycle split was removed for EIP-170 size (bps defaulted
            // to 0, so this is behaviour-identical); deferred to a later version.
            address(rewardToken).safeTransfer(treasury, penalty);
            emit PenaltySentToTreasury(tokenId, penalty);
        } else {
            userReceives = amount;
        }

        address(rewardToken).safeTransfer(msg.sender, userReceives);
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
        address(rewardToken).safeTransferFrom(msg.sender, address(this), _amount);
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
        // AUDIT FIX 2026-05-26 [H-09] — one-shot semantic preserved (only callable
        // when current admin is zero) with a clearer typed error. The recovery
        // path from a forgotten initial wire — re-set when current is zero — was
        // ALREADY supported by this gate (`if (stakingAdmin != address(0)) revert ...`).
        // Swapping Unauthorized → AdminAlreadySet improves caller diagnostics
        // without changing behaviour. Post-deploy rotation continues to flow
        // through proposeAdminReplacement / executeAdminReplacement (48h timelock).
        if (stakingAdmin != address(0)) revert AdminAlreadySet();
        // AUDIT FIX: DEEP-DS-12 — reject EOA / non-contract addresses on first-time
        // wire-up. Catches the typo that points at a wallet instead of a deployed
        // TegridyStakingAdmin; recovery is otherwise gated by the 48h
        // `proposeAdminReplacement` timelock.
        // AUDIT FIX FRESH-2026: F-60-2 — also reject EIP-7702 delegated EOAs
        // (code.length == 23 is the canonical 0xef0100‖addr delegation pointer).
        // Pattern matches OwnableNoRenounce._transferOwnership.
        // AUDIT FIX 2026-05-26 [L-25] — Type-filter only (rejects EOAs and 7702-delegated
        // EOAs); NOT a capability check. Operator MUST verify the admin contract
        // implements ITegridyStakingApply.
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
        // AUDIT FIX 2026-05-26 [L-25] — Type-filter only (rejects EOAs and 7702-delegated
        // EOAs); NOT a capability check. Operator MUST verify the proposed admin
        // contract implements ITegridyStakingApply.
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
        // AUDIT FIX 2026-05-26 [L-18]: execute-time code.length recheck.
        // Pre-fix, the admin's `proposeRestakingContract` checked
        // `code.length != 0 && != 23` at propose-time only. EIP-6780 closed
        // SELFDESTRUCT-as-clear on mainnet post-Cancun, but pending checks
        // remain useful as defense-in-depth against:
        //   (a) EIP-7702 delegation revocation during the 48h propose→exec
        //       window (a 7702-delegated EOA could un-delegate and end up
        //       as raw code.length == 0),
        //   (b) any future EVM upgrade that re-enables full SELFDESTRUCT,
        //   (c) script bugs that pass an address that was a contract at
        //       propose-time but is no longer at execute-time.
        // Mirrors the propose-time check; cheap ~2k gas.
        uint256 codeLen = _restaking.code.length;
        if (codeLen == 0 || codeLen == 23) revert ZeroAddress();
        // AUDIT FIX FRESH-2026: M-28 — block rotation while old restaker still escrows NFTs.
        address oldRestaking = restakingContract;
        // AUDIT FIX 2026-05-26 [M-07] — no-op rotation guard + observability event.
        // Without this, an accidental same-address apply would silently consume the
        // 48h timelock window and emit no on-chain signal (the prior body wrote the
        // identical value without an event).
        if (oldRestaking == _restaking) revert SameValue();
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
        // AUDIT FIX 2026-05-26 [M-07] — emit on the contract itself; previously only
        // TegridyStakingAdmin emitted RestakingContractChanged, leaving direct-admin
        // callers (e.g., timelock multisigs reading staking-only event streams) blind.
        emit RestakingContractApplied(oldRestaking, _restaking);
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
    /// @dev AUDIT FIX 2026-05-26 [L-17] — `updateReward` modifier added for parity with
    ///      every other admin path that mutates state visible to the reward
    ///      accumulator. Defensive only: a stale `rewardPerTokenStored` could in
    ///      principle let a toggling whitelist change land between the prior
    ///      `_accumulateRewards` tick and the next user-action tick, allowing a
    ///      whitelist flip to subtly re-shape the next accrual window. Mirrors
    ///      applyRewardRate's `updateReward` decoration.
    function applyLendingContract(address _lending, bool _approved) external onlyAdmin updateReward {
        if (_lending == address(0)) revert ZeroAddress();
        if (!_approved && balanceOf(_lending) > 0) revert PendingLendingPositions();
        // AUDIT FIX 2026-05-16 M12: same residue-strand guard as applyRestakingContract.
        // Revoking while unsettledRewards residue exists strands per-tokenId reward
        // attribution permanently. Operator MUST drain via the lending contract's
        // residual-claim flow before revoking the whitelist entry.
        if (!_approved && unsettledRewards[_lending] > 0) revert PendingLendingResidue();
        isLendingContract[_lending] = _approved;
        // AUDIT FIX 2026-05-26 [M-08] — emit on the contract itself so direct-admin
        // observability matches the staking-admin sister event (LendingContractUpdated).
        emit LendingContractApplied(_lending, _approved);
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
        SafeTransferLib.safeTransfer(token, treasury, balance);
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
        EnumerableSetLib.Uint256Set storage set = _positionsByOwner[msg.sender];
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

    // C1 EIP-170 split: `_settleUnsettled()` moved into StakingRewardLib (its only
    // callers — the reward cluster — now delegate there). AUDIT FIX L-06 cap +
    // M-3 (forfeit-to-treasury redirect removed) semantics preserved verbatim there.

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

    // ─── REMOVED for EIP-170 size (deferred to a later version) ──────────
    // The extend-fee helpers (_chargeExtendFee / _splitExtendFee), the
    // penalty-recycle helpers (_splitPenalty / _creditRewardPool), and their
    // apply* setters (applyExtendFee / applyExtendFeeRecycle / applyPenaltyRecycle)
    // were removed to bring this contract under the 24,576-byte limit. All of the
    // governing bps (extendFeeBps / extendFeeRecycleBps / penaltyRecycleBps)
    // defaulted to 0, so at the launch config the extend-lock fee was never
    // charged and the entire early-withdrawal penalty already went to treasury —
    // making the removal behaviour-identical to the launch config. The matching
    // propose/execute/cancel timelock flows were removed from TegridyStakingAdmin.sol.

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
