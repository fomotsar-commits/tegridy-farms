// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
// AUDIT FIX (pass-8): EIP170-01 — TimelockAdmin and the entire propose/execute/
// cancel admin surface moved to TegridyLendingAdmin sister contract during the
// Phase 0.1 split. TegridyLending now exposes `applyXxx` onlyAdmin setters that
// the admin contract calls after consuming its own timelocked proposal slot.
import {WETHFallbackLib} from "./lib/WETHFallbackLib.sol";
import {SequencerCheck} from "./lib/SequencerCheck.sol";
import {SafeERC721Call} from "./lib/SafeERC721Call.sol";

/// @notice Minimal admin interface for the cross-contract reads TegridyLending
///         performs against TegridyLendingAdmin. Just the views needed by
///         createOffer's pre-acceptance gate.
interface ITegridyLendingAdminView {
    function acceptedCollateralRemovalPending(address collateral) external view returns (bool);
}

/// @dev Minimal interface for TegridyStaking NFT position queries and transfers.
///      AUDIT R014: extended with `unsettledRewards(address)` and `claimUnsettled()`
///      so escrow contracts can recover the rewards that accrue to the position
///      while it is held as collateral. See TegridyLending.pullEscrowRewards.
interface ITegridyStaking {
    function getPosition(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostBps,
        uint256 lockEnd,
        uint256 lockDuration,
        bool autoMaxLock,
        bool canWithdraw
    );
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    /// @notice Read the cached unsettled rewards balance for `who`. AUDIT R014.
    function unsettledRewards(address who) external view returns (uint256);
    /// @notice Sweep the caller's unsettled rewards to its own balance. AUDIT R014.
    function claimUnsettled() external;
    /// @notice AUDIT FIX D-LD-H1: per-tokenId claim of the caller's unsettled
    ///         bucket. Lending contract is now a tracked holder in TegridyStaking,
    ///         so each escrowed loan can pull its OWN slice — no cross-loan
    ///         drain when an unrelated `kick()` credits unsettledRewards[lending]
    ///         while another loan settles. Returns the actual amount transferred.
    function claimUnsettledForTokenId(uint256 tokenId, address recipient) external returns (uint256 paid);
    /// @notice PASS7-LENDING-03 FIX: per-tokenId outstanding bucket. Read at
    ///         loan acceptance to snapshot pre-existing rewards that belong to
    ///         a prior holder, then re-read at settlement to compute the delta
    ///         the current loan actually earned. Public mapping in TegridyStaking.
    function unsettledRewardsByTokenId(uint256 tokenId) external view returns (uint256);
}

/// @dev Minimal interface for TegridyPair reserve queries (used by the ETH-floor check).
interface ITegridyPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @dev Minimal interface for TegridyTWAP — exposes only the read paths needed by the
///      ETH-floor oracle. `consult` returns the time-weighted output for `amountIn`
///      of `tokenIn` over `period` seconds. `getLatestObservation` lets us check
///      staleness explicitly before relying on a TWAP read (defence-in-depth: the
///      TWAP's internal MAX_STALENESS check also reverts, but we surface a typed
///      error here so consumers can disambiguate).
interface ITegridyTWAP {
    /// @dev AUDIT R014 (oracle layer, Wave-014): cumulative slots widened uint224 → uint256
    ///      to mirror the TegridyTWAP storage layout. Adds `bypassed` flag downstream
    ///      consumers can read to detect a rebootstrap-window observation.
    struct Observation {
        uint32 timestamp;
        bool bypassed;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external view returns (uint256 amountOut);
    function getLatestObservation(address pair) external view returns (Observation memory);
    /// @notice AUDIT R014: timestamp of the most recent dormancy bypass for `pair`. When
    ///         non-zero and recent, the TWAP just absorbed a single observation that
    ///         skipped the deviation gate (post-dormancy rebootstrap). Lending refuses
    ///         to value collateral within `TWAP_PERIOD * 2` of this stamp so a single
    ///         post-bypass observation cannot sole-source the reported price.
    function lastBypassUsed(address pair) external view returns (uint256);
}

/// @title TegridyLending — P2P NFT-Collateralized Lending Protocol
/// @notice Gondi-inspired peer-to-peer lending where lenders create ETH loan offers
///         and borrowers accept by escrowing their TegridyStaking NFT position (ERC721).
///
///         How it works:
///         1. Lender creates a loan offer by depositing ETH (specifies APR, duration, min collateral value)
///         2. Borrower accepts an offer by transferring their staking NFT to this contract
///         3. Contract sends the principal ETH to the borrower
///         4. Borrower repays principal + pro-rata interest before deadline → NFT returned
///         5. If borrower defaults (misses deadline) → lender claims the NFT
///
///         Key design: NO oracle — lender evaluates risk themselves (Gondi pattern).
///         Interest: pro-rata fixed APR = principal * aprBps * elapsed / 10000 / 365 days
///         Protocol fee: percentage of interest earned (default 500 bps = 5%)
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - ReentrancyGuard + Pausable: OpenZeppelin 5.6.1
contract TegridyLending is OwnableNoRenounce, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Sister contract holding the propose/execute/cancel timelock
    ///         admin surface. Wired once via `setLendingAdmin`. All admin
    ///         setters on this contract (`applyXxx*`) are gated on
    ///         `msg.sender == lendingAdmin`.
    /// @dev    AUDIT FIX (pass-8): EIP170-01 — split into sister contract to
    ///         bring this contract under the 24,576-byte EIP-170 limit.
    ///         Mirrors `swapFeeRouterAdmin` pattern. One-shot setter; for
    ///         operational rotation use a new TegridyLending deploy.
    address public lendingAdmin;

    error LendingAdminNotSet();
    error LendingAdminAlreadySet();
    error NotLendingAdmin();
    /// @dev AUDIT FIX (F-60-2 / F-43-B-class): admin pointer must be a genuine
    ///      contract — not an EOA, and not an EIP-7702 (Pectra) delegated EOA
    ///      whose runtime length is exactly 23 bytes (`0xef0100 ‖ addr`).
    error NotAContract();
    /// @dev AUDIT FIX (H-15): admin replacement lifecycle errors. Mirror
    ///      TegridyStaking's pattern but split into typed errors here for
    ///      off-chain alerting clarity.
    error AdminReplacementNoProposal();
    error AdminReplacementNotReady();
    error AdminReplacementExpired();
    error AdminReplacementProposalPending();

    event LendingAdminSet(address indexed admin);
    /// @dev AUDIT FIX (H-15): rotation lifecycle events.
    event LendingAdminReplacementProposed(address indexed newAdmin, uint256 executeAfter);
    event LendingAdminReplaced(address indexed oldAdmin, address indexed newAdmin);
    event LendingAdminReplacementCancelled(address indexed proposed);

    modifier onlyAdmin() {
        if (msg.sender != lendingAdmin) revert NotLendingAdmin();
        _;
    }

    function setLendingAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        if (lendingAdmin != address(0)) revert LendingAdminAlreadySet();
        // AUDIT FIX (F-60-2): reject EOA AND EIP-7702 delegated EOA
        // (length 23 = `0xef0100 ‖ addr` delegation pointer).
        uint256 codeLen = _admin.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        lendingAdmin = _admin;
        emit LendingAdminSet(_admin);
    }

    // ─── AUDIT FIX (H-15 / F-43-D / F-75-2): Admin replacement flow ──
    // Pre-fix, `setLendingAdmin` was permanently one-shot — a compromised
    // or buggy admin contract could only be replaced by redeploying
    // TegridyLending and migrating every active loan + offer. The flow
    // below mirrors TegridyStaking's `proposeAdminReplacement` /
    // `executeAdminReplacement` pattern with 48h timelock + 7-day
    // proposal validity expiry (DEEP-R-M01) — held inline here (rather
    // than on the admin sister) so a broken or compromised admin contract
    // cannot block its own removal.
    /// @notice Mandatory delay between propose and execute for an admin swap.
    /// @dev    Mirrors TegridyStaking.ADMIN_REPLACEMENT_TIMELOCK = 48h.
    uint256 internal constant ADMIN_REPLACEMENT_TIMELOCK = 48 hours;
    /// @notice Validity window after `readyAt`. Past this point the proposal
    ///         is no longer executable and must be re-proposed.
    /// @dev    AUDIT FIX (DEEP-R-M01): mirror SwapFeeRouter's 7-day expiry on
    ///         `executeAdminReplacement`. A years-old stale proposal must NOT
    ///         remain executable indefinitely — a forgotten candidate address
    ///         could be co-opted (CREATE2 redeploy, abandoned multisig,
    ///         expired-key custody) to install a hostile admin.
    uint256 internal constant ADMIN_REPLACEMENT_VALIDITY = 7 days;

    /// @notice Pending replacement admin address. Zero when no proposal is pending.
    address public pendingLendingAdmin;
    /// @notice block.timestamp after which `executeLendingAdminReplacement` is callable.
    ///         Zero when no proposal is pending.
    uint256 public lendingAdminReplacementReadyAt;

    /// @notice Propose a replacement TegridyLendingAdmin. Reverts if no admin
    ///         is set yet — the first-time installation path is `setLendingAdmin`.
    /// @dev    AUDIT FIX (H-15): mirror of TegridyStaking.proposeAdminReplacement.
    ///         Held inline on the lending contract (rather than on the admin
    ///         sister) so a broken or compromised admin contract cannot block
    ///         its own removal. The 48h delay + 7d validity provides the same
    ///         rotation path SwapFeeRouter / TegridyStaking already enjoy.
    /// @dev    AUDIT FIX (F-60-2): same EOA + 7702-delegated-EOA filter as
    ///         setLendingAdmin so a stale-handoff or typo cannot install
    ///         a `code.length == 23` impostor at rotation time.
    function proposeLendingAdminReplacement(address _newAdmin) external onlyOwner {
        if (_newAdmin == address(0)) revert ZeroAddress();
        if (lendingAdmin == address(0)) revert LendingAdminNotSet(); // use setLendingAdmin first
        if (lendingAdminReplacementReadyAt != 0) revert AdminReplacementProposalPending();
        // AUDIT FIX (F-60-2): same EOA / 7702 filter as setLendingAdmin.
        uint256 codeLen = _newAdmin.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        pendingLendingAdmin = _newAdmin;
        lendingAdminReplacementReadyAt = block.timestamp + ADMIN_REPLACEMENT_TIMELOCK;
        emit LendingAdminReplacementProposed(_newAdmin, lendingAdminReplacementReadyAt);
    }

    /// @notice Execute a previously proposed admin replacement after the 48-hour
    ///         delay has elapsed and before the 7-day validity window expires.
    /// @dev    AUDIT FIX (DEEP-R-M01): typed `AdminReplacementExpired` revert
    ///         caps the validity window at 7 days; without this, a years-old
    ///         stale proposal (forgotten + un-cancelled) could be executed at
    ///         any later block to install a now-hostile admin.
    function executeLendingAdminReplacement() external onlyOwner {
        uint256 readyAt = lendingAdminReplacementReadyAt;
        if (readyAt == 0) revert AdminReplacementNoProposal();
        if (block.timestamp < readyAt) revert AdminReplacementNotReady();
        if (block.timestamp > readyAt + ADMIN_REPLACEMENT_VALIDITY) revert AdminReplacementExpired();
        address newAdmin = pendingLendingAdmin;
        if (newAdmin == address(0)) revert ZeroAddress(); // defensive
        address oldAdmin = lendingAdmin;
        lendingAdmin = newAdmin;
        pendingLendingAdmin = address(0);
        lendingAdminReplacementReadyAt = 0;
        emit LendingAdminReplaced(oldAdmin, newAdmin);
    }

    /// @notice Cancel a pending admin replacement proposal.
    function cancelLendingAdminReplacement() external onlyOwner {
        if (lendingAdminReplacementReadyAt == 0) revert AdminReplacementNoProposal();
        address proposed = pendingLendingAdmin;
        pendingLendingAdmin = address(0);
        lendingAdminReplacementReadyAt = 0;
        emit LendingAdminReplacementCancelled(proposed);
    }

    // ─── Safety Caps ─────────────────────────────────────────────────
    // AUDIT TF-06 (Spartan MEDIUM): lending caps were compile-time constants with
    // no way to adjust as ETH price / market demand evolves. They are now timelocked
    // state variables (48h delay) with absolute *_CEILING hard caps no admin can
    // exceed. MAX_PROTOCOL_FEE_BPS remains a constant — 10% is already a ceiling
    // nobody should exceed.
    // AUDIT H-05: overflow risk on `principal * aprBps * elapsed` is addressed in
    // calculateInterest via OpenZeppelin's Math.mulDiv (512-bit intermediate,
    // overflow-safe even if the caps are raised up to their ceilings).
    uint256 public maxPrincipal = 1000 ether;
    uint256 public maxAprBps = 50000;        // 500% APR
    uint256 public minDuration = 1 days;
    uint256 public maxDuration = 365 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% — hard-cap constant
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice Absolute ceilings. Admin can adjust cap values below these but never above.
    /// @dev Chosen to leave substantial headroom while bounding the worst-case damage from
    ///      a compromised owner key or a mispriced proposal.
    uint256 public constant MAX_PRINCIPAL_CEILING = 100_000 ether;
    uint256 public constant MAX_APR_BPS_CEILING = 100_000;      // 1000% APR hard cap
    // AUDIT FIX: DEEP-LD-L5 — raised from 1h to 4h
    uint256 public constant MIN_DURATION_FLOOR = 4 hours;       // never lower than 4h
    uint256 public constant MIN_DURATION_CEILING = 7 days;      // never higher than 7d
    uint256 public constant MAX_DURATION_CEILING = 3650 days;   // 10-year hard cap

    /// @notice AUDIT FIX (M-25 / F-33-1): bricking-resistant floor on `maxPrincipal`.
    ///         Mirrors `MIN_DURATION_FLOOR`. Defense-in-depth — the admin sister
    ///         contract enforces this at propose time too. 0.01 ETH (= 1e16 wei).
    uint256 public constant MAX_PRINCIPAL_FLOOR = 0.01 ether;

    uint256 public constant CAP_CHANGE_TIMELOCK = 48 hours;

    // ─── AUDIT FIX (F-95-K-2 MED): offer-list caps ───────────────────────
    /// @notice Hard ceiling on total offer-array length to bound worst-case
    ///         storage / enumeration cost. Mirrors `MAX_PAIRS` on TegridyFactory.
    ///         A would-be griefer minting offers at `minPrincipal` (0.001 ETH)
    ///         is bounded to MAX_TOTAL_OFFERS=10_000 entries protocol-wide, plus
    ///         MAX_OFFERS_PER_LENDER=100 active offers per lender. cancelOffer
    ///         frees a slot's `active` flag and decrements per-lender counter
    ///         but does NOT shrink the array (each slot's storage is permanently
    ///         consumed); MAX_TOTAL_OFFERS therefore caps lifetime, MAX_OFFERS_PER_LENDER
    ///         caps active-only.
    /// @dev    Mirrors the NFTLending-side liquidity-griefing fix
    ///         (F-95-K-2 paired finding).
    uint256 public constant MAX_TOTAL_OFFERS = 10_000;
    uint256 public constant MAX_OFFERS_PER_LENDER = 100;
    /// @notice AUDIT FIX (F-95-K-2): per-lender ACTIVE offer count. Decremented
    ///         on cancelOffer / acceptOffer so legitimate lenders are not
    ///         permanently capped by their own cancellation history.
    mapping(address => uint256) public activeOffersByLender;

    // ─── AUDIT FIX: DEEP-LD-M6 — minimum interest floor ──────────────
    /// @notice Minimum interest charged on any repayment, equivalent to 1 full day
    ///         of accrued interest at the loan's APR. Defeats same-block flash-loan.
    uint256 public constant MIN_INTEREST_DURATION = 1 days;

    // ─── AUDIT FIX: LD3-H2 — APR-independent interest floor ──────────
    /// @notice Flat principal-percentage interest floor (5 bps = 0.05%) that
    ///         activates regardless of the offer's `aprBps`. Mirrors NFTLending's
    ///         LD2-H2 fix. Defeats the 0% APR loophole in DEEP-LD-M6 where
    ///         `principal * 0 == 0` made the duration-based floor evaluate to
    ///         zero, leaving same-block flash-borrows free against any 0-APR
    ///         offer. The 5-bps level is conservatively small for honest 1-day
    ///         repayments (0.05% of principal per loan, fixed) but enough to
    ///         make sub-block flash attacks uneconomical when stacked against
    ///         gas + slippage. CRITICAL on TegridyLending vs NFTLending: the
    ///         100x larger MAX_PRINCIPAL_CEILING (100k vs 1k ETH) makes this
    ///         loophole 100x more attractive without the floor.
    uint256 public constant MIN_INTEREST_PRINCIPAL_BPS = 5;

    // ─── AUDIT C7: origination fee charged on createLoanOffer ────────────
    /// @notice Fee in BPS deducted from the lender's deposited principal at offer creation.
    ///         Sent to treasury immediately. The borrower receives (msg.value - origination fee).
    ///         Default 0 — backward-compatible. Capped at MAX_ORIGINATION_FEE_BPS (200 = 2%).
    ///         48h timelocked setter. Closes the "lender uses protocol as free escrow"
    ///         silent killer: now every accepted offer pays a fee, regardless of repay/default.
    uint256 public originationFeeBps;
    uint256 public constant MAX_ORIGINATION_FEE_BPS = 200;

    // ─── AUDIT H14: minimum APR enforced on createLoanOffer ──────────────
    /// @notice Minimum acceptable APR in BPS. Default 0 — backward-compatible. Capped at
    ///         MAX_MIN_APR_BPS (1000 = 10%). Closes the 0-APR free-NFT-acquisition channel.
    uint256 public minAprBps;
    uint256 public constant MAX_MIN_APR_BPS = 1000;

    // AUDIT FIX (pass-8): EIP170-01 — pendingOriginationFeeBps + pendingMinAprBps
    // moved to TegridyLendingAdmin storage during the Phase 0.1 split.

    // ─── AUDIT R014: Minimum principal floor (anti-dust) ────────────────
    /// @notice Lenders cannot create offers with principal below this floor. Closes
    ///         the dust-offer griefing vector where attackers spam the index with
    ///         microscopic offers that would never be accepted but bloat enumeration
    ///         and force borrowers to filter through noise. Default 0.001 ETH.
    ///         48h-timelocked, capped at MAX_MIN_PRINCIPAL (1 ETH) so a malicious
    ///         admin can never make the protocol unusable for small lenders.
    uint256 public minPrincipal = 0.001 ether;
    uint256 public constant MAX_MIN_PRINCIPAL = 1 ether;
    // AUDIT FIX (pass-8): EIP170-01 — pendingMinPrincipal moved to TegridyLendingAdmin.

    // ─── AUDIT R014: Per-collateral-contract whitelist ──────────────────
    /// @notice Only collateral contracts in this map may back loans. Replaces the
    ///         "trust the lender to check the contract" model with a governance-gated
    ///         allowlist. 48h-timelocked add/remove. Closes the channel where a
    ///         malicious lender posts an offer pointing at a fake `ITegridyStaking`
    ///         that mirrors the interface but burns the borrower's NFT on transfer
    ///         (or otherwise grieves repayment).
    /// @dev    AUDIT NFT-CL-L1 DEPLOY-OPS NOTE (2026-04-28): adding a TegridyStaking
    ///         (or similar) contract to this whitelist is HALF the wire-up. The
    ///         OTHER half lives on the staking-side `isLendingContract` allowlist
    ///         (see TegridyStaking.sol — `_isLendingContract` mapping with sister
    ///         48h timelock). A loan against staking-position collateral cannot
    ///         physically settle until BOTH directions are wired:
    ///           1. lending-side  : `proposeAcceptedCollateral(stakingAddr, true)`
    ///                              + `executeAcceptedCollateral`
    ///           2. staking-side  : `proposeLendingContract(thisAddr, true)`
    ///                              + `executeLendingContract`
    ///         Wire ordering doesn't matter, but skipping either step bricks
    ///         all loans in flight against that collateral type until the
    ///         missing direction lands and clears its 48h delay.
    mapping(address => bool) public acceptedCollateralContracts;
    // AUDIT FIX (pass-8): EIP170-01 — pendingAcceptedCollateral / pendingAcceptedCollateralAdd
    // moved to TegridyLendingAdmin. Read via `lendingAdmin.acceptedCollateralRemovalPending(...)`.

    /// @notice AUDIT FIX: DEEP-LD-M1 — active-loan count per collateral contract.
    mapping(address => uint256) public activeLoansAgainstCollateral;

    /// @notice AUDIT FIX: LD3-M3 — cancel-rate-limit per collateral so a captured
    ///         admin cannot loop cancel-and-re-propose to keep a flagged
    ///         staking contract on the whitelist indefinitely. Mirrors LD-L2 on
    ///         TegridyNFTLending. Counter resets on a successful removal
    ///         execution. Gate uses the LD3-M1 corrected order (gate → cancel)
    ///         so over-budget reverts don't leave the slot in a stuck state.
    mapping(address => uint256) public collateralRemovalRetryCount;
    uint256 public constant COLLATERAL_REMOVAL_MAX_CANCELLATIONS = 3;

    // AUDIT FIX (pass-8): EIP170-01 — pendingMaxPrincipal / pendingMaxAprBps /
    // pendingMinDuration / pendingMaxDuration moved to TegridyLendingAdmin.
    /// @notice AUDIT M-1: post-deadline grace window during which a borrower can still
    ///         repay before the lender is allowed to claim default. Buffer against
    ///         transient failures (gas spikes, provider outages, wallet delays). Interest
    ///         still accrues through the grace period so the lender isn't penalised.
    uint256 public constant GRACE_PERIOD = 1 hours;
    /// @notice AUDIT FIX: DEEP-LD-M5 — buffer between deadline and lockEnd.
    /// @dev    AUDIT FIX: LD3-M2 — reduced 7d → 1d. The 7-day buffer was
    ///         structurally locking out borrowers whose `lockEnd == stake_start
    ///         + max_lock` from max-duration loans (the "natural choice" of
    ///         lockDuration == loan_duration always failed `lockEnd >= deadline
    ///         + 7d`). 1 day matches the GRACE_PERIOD philosophy of "small but
    ///         non-zero cushion" while keeping the lender-protection intent.
    ///         INFO LD3-INFO1: this buffer is enforced at acceptance only — see
    ///         claimDefaultedCollateral NatSpec for the 7d-vs-claim-time
    ///         distinction. Lender's actual usable post-claim window is
    ///         `lockEnd - block.timestamp_at_claim`, which can be anywhere
    ///         between `LIQUIDATION_GRACE - GRACE_PERIOD` and 0+.
    uint256 public constant LIQUIDATION_GRACE = 1 days;

    // ─── WETH Fallback ──────────────────────────────────────────────
    address public immutable weth; // WETH for fallback payout to revert-on-receive lenders

    // ─── Pair / TOWELI references (ETH-floor oracle) ────────────────
    // AUDIT critique 5.4 / R003: TegridyPair is retained for orientation metadata
    // (token0/token1) but is no longer used as a spot-price source. The optional
    // ETH-denominated collateral floor now reads a time-weighted price from
    // `TegridyTWAP.consult` (see `_positionETHValue`). The `toweli` address is
    // snapshotted at construction so we know which side of the pair represents
    // TOWELI when calling `consult(pair, toweli, …)`.
    address public immutable pair;
    address public immutable toweli;

    /// @notice TWAP oracle used by the ETH-floor pricing path. Replaces the prior
    ///         raw `getReserves()` read which was sandwich-manipulable in the same
    ///         transaction (R003 / agents 006/031/032). `consult(pair, toweli,
    ///         amount, TWAP_PERIOD)` returns a time-weighted ETH-equivalent value.
    ITegridyTWAP public immutable twap;

    /// @notice TWAP averaging window used by the ETH-floor check. 30 minutes matches
    ///         Aave V3's default oracle window — long enough to dilute single-block
    ///         reserve manipulation, short enough to track real price movement.
    uint256 public constant TWAP_PERIOD = 30 minutes;

    /// @notice Maximum acceptable age of the most-recent TWAP observation. If the
    ///         keeper has stopped pushing `update()` calls, the floor check reverts
    ///         rather than silently falling back to a stale price. Matches the
    ///         TegridyTWAP contract's own MAX_STALENESS — kept here for explicit
    ///         typed-error feedback.
    uint256 public constant TWAP_MAX_STALENESS = 2 hours;

    // ─── AUDIT R062: L2 Sequencer Uptime gating ──────────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet / non-L2 (no-op). Stored immutable so it cannot be
    ///         hot-swapped post-deploy.
    address public immutable sequencerFeed;
    /// @notice Post-resume grace window. After the sequencer transitions back
    ///         to "up", `_positionETHValue` still reverts for
    ///         `SEQUENCER_GRACE_PERIOD` seconds so AMM reserves and TWAP
    ///         observations have time to refresh before lender collateral is
    ///         valued at potentially stale post-outage prices. 1h matches
    ///         Aave V3's default grace.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    // ─── Timelock Delays ─────────────────────────────────────────────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;

    // AUDIT FIX (pass-8 batch-15): Phase 3.5 offer-expiry bounds.
    /// @notice Minimum delta `(expiry - block.timestamp)` accepted by `createLoanOffer`.
    ///         1 hour is short enough to support a quote-then-accept flow within a
    ///         single user session, long enough to defend against pure-spam expiries
    ///         that would brick the offer before a borrower can even index it.
    uint256 public constant MIN_OFFER_VALIDITY = 1 hours;
    /// @notice Maximum delta `(expiry - block.timestamp)` accepted by `createLoanOffer`.
    ///         90 days caps a stale-quote attack window: even a forgotten offer ages
    ///         out before market drift becomes catastrophic.
    uint256 public constant MAX_OFFER_VALIDITY = 90 days;

    // ─── Structs ─────────────────────────────────────────────────────

    struct LoanOffer {
        address lender;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        address collateralContract;
        uint256 minPositionValue;
        /// @notice AUDIT critique 5.4: Optional ETH-denominated collateral floor. When
        ///         non-zero, `acceptOffer` additionally requires that the position's TOWELI
        ///         amount valued at the current TegridyPair spot reserves >= this threshold.
        ///         Zero = disabled (backward-compatible default — no ETH-floor check applied).
        uint256 minPositionETHValue;
        bool active;
        /// @dev AUDIT FIX: DEEP-LD-M8 — origination fee held in escrow on the offer
        ///      until acceptance. cancelOffer refunds principal + this; acceptOffer
        ///      forwards this to treasury. Closes silent-tax-on-cancel vector.
        uint256 originationFee;
        /// @dev AUDIT FIX: LD3-H3 — snapshot of `treasury` at offer creation.
        ///      acceptOffer forwards the held origination fee to THIS address
        ///      rather than the live treasury, so a treasury change between
        ///      create and accept cannot silently redirect a lender's fee.
        ///      Mirrors LD2-M3 fix on TegridyNFTLending. Escalated to High here
        ///      because TegridyLending's MAX_PRINCIPAL_CEILING (100k ETH) +
        ///      MAX_ORIGINATION_FEE_BPS (200) means a worst-case redirect can
        ///      reach 2000 ETH per offer (100x NFTLending's blast radius).
        address treasuryAtCreate;
        /// @notice AUDIT FIX (pass-8 batch-15): Phase 3.5 — offer expiry timestamp.
        ///         Pre-fix, an offer with stale market terms could be accepted
        ///         indefinitely until the lender remembered to call `cancelOffer`.
        ///         A lender's quote from when ETH was 4,000 USD remained accept-able
        ///         after the market fell to 2,000 USD; combined with the fixed
        ///         `aprBps` and `minPositionETHValue`, the borrower could acquire
        ///         a loan at obsolete terms. Mirrors offer expiry pattern from
        ///         BendDAO, NFTfi, ParaSpace.
        ///
        ///         `expiry == 0` is rejected at creation (createLoanOffer enforces
        ///         the bounds [MIN_OFFER_VALIDITY, MAX_OFFER_VALIDITY] from now);
        ///         `acceptOffer` reverts `OfferExpired` once `block.timestamp > expiry`.
        ///         The lender can still `cancelOffer` an unexpired offer to recover
        ///         their principal + originationFee at any time.
        uint64 expiry;
        /// @notice AUDIT FIX (BATCH-D H9, mirrors LD3-H3 treasuryAtCreate):
        ///         Snapshot of `protocolFeeBps` at offer creation, used at
        ///         `repayLoan` instead of live `protocolFeeBps`. Closes the
        ///         retroactive-tax-on-in-flight-loans vector — pre-fix, owner
        ///         could increase fee bps mid-loan and silently siphon up to
        ///         MAX_PROTOCOL_FEE_BPS (1000 / 10%) of the lender's interest
        ///         net at every repay.
        /// @dev    AUDIT FIX (M-8 / F-07-01): widened from `uint16` to `int16`.
        ///         A NEGATIVE value (e.g. type(int16).min) is now the explicit
        ///         "unset / legacy" sentinel — pre-fix a `uint16` field could
        ///         not differentiate "zero because unset" from "zero because
        ///         the live fee was zero at creation", causing offers minted
        ///         while `protocolFeeBps == 0` to silently fall through to the
        ///         live fee at repay (defeating the snapshot's purpose for
        ///         that class of offer). Freshly minted offers always store
        ///         `int16(uint16(protocolFeeBps))` (a non-negative value
        ///         `[0..1000]`); the negative branch covers any pre-fix
        ///         legacy storage state. uint16 0..1000 fits cleanly in int16
        ///         (-32768..32767) — change is a storage-layout-compatible
        ///         reinterpretation of the same slot.
        int16 protocolFeeBpsAtCreate;
    }

    struct Loan {
        address borrower;
        address lender;
        uint256 offerId;
        uint256 tokenId;
        uint256 principal;
        uint256 aprBps;
        uint256 startTime;
        uint256 deadline;
        bool repaid;
        bool defaultClaimed;
        /// @dev AUDIT FIX: DEEP-LD2-M4 (mirror H10) — snapshot of `totalPausedDuration`
        ///      at loan creation. Only post-loan-start pause time extends deadline.
        uint256 pausedDurationAtStart;
    }

    // ─── State ───────────────────────────────────────────────────────

    LoanOffer[] public offers;
    Loan[] public loans;

    uint256 public protocolFeeBps;    // Fee on interest earned (default 500 = 5%)
    address public treasury;

    // AUDIT FIX (pass-8): EIP170-01 — pendingProtocolFeeBps + pendingTreasury
    // moved to TegridyLendingAdmin during the Phase 0.1 split.

    // ─── AUDIT R014: Escrow rewards recovery ─────────────────────────
    /// @notice Per-loan reward attribution recovered after the loan settles. While
    ///         the position NFT is held by this contract, TegridyStaking's
    ///         `unsettledRewards[address(this)]` accrues — those rewards belong to
    ///         the borrower (if repaid) or the lender (if defaulted). This map is
    ///         keyed by loanId and decremented when `pullEscrowRewards` pays out.
    mapping(uint256 => uint256) public escrowRewardsOwed;
    /// @notice Sum of all `escrowRewardsOwed` entries. Used as the denominator when
    ///         the contract's available unsettled-rewards balance is less than the
    ///         total claim — payouts fall back to `owed * available / total`.
    uint256 public totalEscrowRewardsOwed;

    /// @notice PASS7-LENDING-03 FIX: snapshot of `unsettledRewardsByTokenId[tokenId]`
    ///         taken at `acceptOffer` time. Used at settlement to split a claim
    ///         into `priorShare` (rewards that pre-existed the loan and belong
    ///         to a prior holder's deferred claim) and `myShare` (rewards this
    ///         loan actually earned). Pre-fix, the two-phase pull drained the
    ///         entire per-tokenId bucket to the current loan's recipient,
    ///         enabling a settled-vs-settled cross-loan drain when staking
    ///         was paused at a prior settlement (see PASS7 §3.6).
    mapping(uint256 => uint256) public loanRewardsSnapshot;

    /// @notice PASS7-LENDING-02 FIX: stuck-collateral recovery scaffolding
    ///         mirroring TegridyNFTLending. Populated when an outbound
    ///         `staking.transferFrom` silently no-ops (a malicious whitelisted
    ///         collateral contract whose `transferFrom` returns without moving
    ///         the token). The intended recipient (borrower on repay, lender
    ///         on default) can later call `claimStuckCollateral(loanId)` to
    ///         retry once the collateral becomes honest. Mirrors the
    ///         NFTLending L176 + L743-L793 pattern; sibling closure on
    ///         TegridyLending was missed in the original LD-NEW-H2 sweep.
    mapping(uint256 => address) public stuckCollateralRecipient;

    // ─── AUDIT R014: Pause-aware deadlines ───────────────────────────
    /// @notice Unix timestamp at which the most-recent `_pause()` was called. Zero
    ///         when the contract has never been paused. Reset to zero on `_unpause()`.
    uint256 public pauseStartTime;
    /// @notice Cumulative seconds the contract has spent paused since deployment.
    ///         Added to every loan's deadline check (see `effectiveDeadline`) so
    ///         neither side is penalised by an admin pause.
    uint256 public totalPausedDuration;

    // ─── AUDIT FIX FRESH-2026 (post-fix scan2 S-6): cumulative pause history ──
    /// @notice Append-only log of completed pause windows used by
    ///         `_cumulativePausedInWindow` to compute the rolling 30-day
    ///         cumulative pause budget. Sibling-port from TegridyNFTLending.
    struct PauseEpisode {
        uint128 startedAt;
        uint128 endedAt;
    }
    PauseEpisode[] public pauseHistory;

    // ─── Events ──────────────────────────────────────────────────────

    event LoanOfferCreated(
        uint256 indexed offerId,
        address indexed lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue,
        uint256 minPositionETHValue
    );
    event LoanOfferCancelled(uint256 indexed offerId, address indexed lender);
    // AUDIT FIX (pass-8): EIP170-01 — AcceptedCollateralCancelled moved to TegridyLendingAdmin.
    event LoanAccepted(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed borrower,
        address lender,
        uint256 tokenId,
        uint256 principal,
        uint256 deadline
    );
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 interest,
        uint256 protocolFee
    );
    event DefaultClaimed(
        uint256 indexed loanId,
        address indexed lender,
        uint256 tokenId
    );
    // AUDIT FIX (pass-8): EIP170-01 — Proposed/Cancelled events moved to
    // TegridyLendingAdmin. The "happened" events stay here.
    event ProtocolFeeChanged(uint256 oldBps, uint256 newBps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    // AUDIT TF-06: cap-change events (48h timelock observability)
    // AUDIT FIX (pass-8): EIP170-01 — Proposed events moved to TegridyLendingAdmin.
    event MaxPrincipalChanged(uint256 oldCap, uint256 newCap);
    event MaxAprBpsChanged(uint256 oldCap, uint256 newCap);
    event MinDurationChanged(uint256 oldValue, uint256 newValue);
    event MaxDurationChanged(uint256 oldValue, uint256 newValue);
    // AUDIT C7 / H14
    // AUDIT FIX (pass-8): EIP170-01 — Proposed events moved to TegridyLendingAdmin.
    event OriginationFeeChanged(uint256 oldBps, uint256 newBps);
    event OriginationFeeCollected(address indexed lender, uint256 amount);
    event MinAprChanged(uint256 oldBps, uint256 newBps);

    // ─── AUDIT R014 events ──────────────────────────────────────────────
    // AUDIT FIX (pass-8): EIP170-01 — Proposed events moved to TegridyLendingAdmin.
    event MinPrincipalChanged(uint256 oldValue, uint256 newValue);
    event AcceptedCollateralChanged(address indexed collateral, bool add);
    /// @notice Emitted when `pullEscrowRewards`/the inline settlement path attempted
    ///         `staking.claimUnsettled()` and the call reverted. Records the raw
    ///         revert data so off-chain operators can diagnose the staking-side
    ///         issue and retry. Loan settlement still completes — the rewards
    ///         remain claimable via a follow-up `pullEscrowRewards` call.
    event EscrowRewardsClaimDeferred(uint256 indexed loanId, bytes reason);
    /// @notice Emitted whenever escrow rewards are paid out to the loan's beneficiary
    ///         (borrower if repaid, lender if defaulted). `payout` may be less than
    ///         `owed` when the contract holds less than `totalEscrowRewardsOwed`.
    event EscrowRewardsPaid(uint256 indexed loanId, address indexed recipient, uint256 owed, uint256 payout);
    /// @notice Records loan-period reward attribution at settlement time.
    event EscrowRewardsAttributed(uint256 indexed loanId, uint256 amount);
    /// @notice PASS7-LENDING-02 FIX: emitted when an outbound NFT transfer
    ///         silently no-ops on a malicious whitelisted staking-shaped
    ///         collateral contract. The recipient is recorded so they can
    ///         retry via `claimStuckCollateral(loanId)`.
    event CollateralStuck(uint256 indexed loanId, address indexed recipient, uint256 tokenId, address staking);
    /// @notice PASS7-LENDING-02 FIX: emitted when `claimStuckCollateral`
    ///         successfully recovers an NFT after the collateral became honest.
    event StuckCollateralClaimed(uint256 indexed loanId, address indexed recipient, uint256 tokenId);
    /// @notice PASS7-LENDING-02 FIX: emitted when a malicious staking contract
    ///         redirects an outbound transfer to a third party. Loan settlement
    ///         still completes; the event flags the contract for delisting.
    event CollateralRedirected(
        uint256 indexed tokenId,
        address indexed staking,
        address indexed intendedRecipient,
        address actualOwner
    );
    /// @notice PASS7-LENDING-03 FIX: emitted when an attempted reward claim
    ///         during repay/default deferred (paused staking) and the un-claimable
    ///         slice was recorded into `escrowRewardsOwed[loanId]` for later
    ///         retrieval via `pullEscrowRewards`. Distinct from
    ///         `EscrowRewardsClaimDeferred` which only signals the try/catch
    ///         absorbed without quantifying the deferred amount.
    event EscrowRewardsDeferredAndOwed(uint256 indexed loanId, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrincipal();
    error ZeroAmount();             // AUDIT TF-06 — cap-propose value is zero
    error InvalidCapValue();        // AUDIT TF-06 — cap-propose outside the [*_FLOOR, *_CEILING] window
    error PrincipalTooLarge();
    error AprTooHigh();
    error AprTooLow();                  // AUDIT H14
    error OriginationFeeTooHigh();      // AUDIT C7
    error MinAprTooHigh();              // AUDIT H14
    error DurationTooShort();
    error DurationTooLong();
    error FeeTooHigh();
    error OfferNotActive();
    error NotOfferLender();
    error InsufficientCollateralValue();
    /// AUDIT FIX (BATCH-G H22): applySweepDonatedToweli `to` must equal treasury.
    error InvalidSweepRecipient();
    /// AUDIT FIX (BATCH-J3 H10): pause-asymmetry bound on lender liquidation.
    uint256 public constant MAX_PAUSE_BLOCK_LIQUIDATION = 7 days;
    /// @notice AUDIT FIX FRESH-2026 (post-fix scan2 S-6): cumulative pause window.
    ///         Sibling-port from TegridyNFTLending.F-71-9. Pre-port the cap was
    ///         measured from `pauseStartTime` (resets on every pause), so a
    ///         captured owner could cycle pause/unpause indefinitely below the
    ///         7-day single-window threshold and never trip the bound. Now we
    ///         sum pause durations within a rolling 30-day window.
    uint256 public constant CUMULATIVE_PAUSE_WINDOW = 30 days;
    error NotNFTOwner();
    error LoanAlreadyRepaid();
    error LoanTooRecent();
    error LockExpiresBeforeDeadline();
    error LoanAlreadyDefaultClaimed();
    error NotBorrower();
    error NotLoanLender();
    error DeadlineNotReached();
    error DeadlineExpired(); // AUDIT FIX C-04: Renamed from LoanNotDefaulted — borrower missed the deadline
    error InsufficientRepayment();
    error ETHTransferFailed();
    error InvalidLoanId();
    error InvalidOfferId();
    error MsgValueMismatch();
    /// @dev R003: raised when the TWAP observation backing the ETH-floor check is
    ///      older than `TWAP_MAX_STALENESS`. Lender / borrower must wait for a
    ///      keeper to refresh the oracle (or call `twap.update(pair)` themselves)
    ///      before `acceptOffer` will succeed for a non-zero ETH floor.
    error OracleStale();
    /// @dev R014: lender opened an offer at less than `minPrincipal`.
    error PrincipalTooSmall();
    /// @dev AUDIT FIX (pass-8 batch-15): Phase 3.5 — caller-supplied offer
    ///      `expiry` is outside `[now + MIN_OFFER_VALIDITY, now + MAX_OFFER_VALIDITY]`.
    error InvalidOfferExpiry();
    /// @dev AUDIT FIX (pass-8 batch-15): Phase 3.5 — `acceptOffer` called after
    ///      the offer's `expiry` timestamp. Lender can `cancelOffer` to recover
    ///      principal + the held origination fee.
    error OfferExpired();
    /// @dev R014: lender pointed offer at a collateral contract that is not on the
    ///      whitelist, OR an admin proposed to remove the contract while the offer
    ///      was being created (handled in createLoanOffer).
    error CollateralNotAccepted();
    /// @dev R014: pullEscrowRewards called for a loan with no recoverable rewards.
    error NoEscrowRewards();
    /// @dev R014: pullEscrowRewards called by a non-beneficiary.
    error NotEscrowBeneficiary();
    /// @dev R014: pullEscrowRewards called before the loan has settled (still active).
    error LoanStillActive();
    /// @dev AUDIT FIX: LD3-M3 — rate-limit reached on cancelAcceptedCollateral.
    error RemovalCancelLimitReached();
    // PASS7-LENDING-01 FIX: post-condition check on inbound staking transferFrom.
    error CollateralNotEscrowed();
    // PASS7-LENDING-02 FIX: stuck-collateral recovery surface mirroring NFTLending.
    error NoStuckCollateral();
    error NotStuckCollateralRecipient();
    error StuckCollateralStillStuck();
    /// @dev AUDIT FIX: LD3-L2 — typed error for the active-loans-present revert
    ///      previously emitted as `revert("ACTIVE_LOANS_PRESENT")`. Off-chain
    ///      monitoring can now select on the 4-byte selector and decode the
    ///      collateral + count without ABI string handling.
    error ActiveLoansPresent(address collateral, uint256 count);
    /// @dev AUDIT FIX (F-95-K-2 MED): MAX_TOTAL_OFFERS / MAX_OFFERS_PER_LENDER
    ///      caps tripped by lender attempting to mint more offers than the
    ///      protocol-wide or per-lender ceiling permits.
    error TooManyOffers();
    error TooManyOffersPerLender();
    /// @dev AUDIT FIX (F-95-K-7 LOW): admin sweepUnsolicitedNFT against an NFT
    ///      that is currently in active escrow (a loan reference exists for
    ///      this `(collection, tokenId)` pair).
    error CollateralInUse();
    /// @dev AUDIT FIX (F-95-K-7 LOW): sweepUnsolicitedNFT must target a token
    ///      this contract actually holds.
    error NotHeldByContract();

    // AUDIT FIX (pass-8): EIP170-01 — `protocolFeeChangeReadyAt` and
    // `treasuryChangeReadyAt` view helpers moved to TegridyLendingAdmin
    // alongside the propose/execute/cancel functions whose readiness they
    // exposed. Off-chain readers should call the admin contract directly
    // for these view helpers (selector parity preserved).

    // ─── Constructor ─────────────────────────────────────────────────

    /// @notice Deploy the lending protocol.
    /// @param _treasury Address to receive protocol fees
    /// @param _protocolFeeBps Initial protocol fee in basis points (applied to interest)
    /// @param _weth Canonical WETH address (e.g., 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on mainnet)
    /// @param _pair TegridyPair (TOWELI/WETH) used by the optional ETH-denominated
    ///              collateral floor in `acceptOffer`. Reserve-slot orientation is resolved
    ///              at deploy time via `token0()` / `token1()`.
    /// @param _twap TegridyTWAP oracle used to price the optional ETH-floor. R003 fix:
    ///              prior implementation read raw `getReserves()` and was provably
    ///              sandwich-manipulable in a single transaction. NOTE: the TWAP must be
    ///              bootstrapped (>=2 observations spaced by `TegridyTWAP.MIN_PERIOD`)
    ///              before `acceptOffer` will succeed for a non-zero ETH floor; deploy
    ///              scripts must call `twap.update(_pair)` twice with a wait between
    ///              calls before any lender posts a non-zero `minPositionETHValue`.
    /// @param _sequencerFeed AUDIT R062 — Chainlink L2 Sequencer Uptime feed;
    ///        pass `address(0)` for mainnet / non-L2 deployments to disable
    ///        gating (no-op).
    constructor(
        address _treasury,
        uint256 _protocolFeeBps,
        address _weth,
        address _pair,
        address _twap,
        address _sequencerFeed
    ) OwnableNoRenounce(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_pair == address(0)) revert ZeroAddress();
        if (_twap == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        // AUDIT FIX FRESH-2026 (post-fix scan2 S-4): mirror TegridyNFTLending.F-14-1
        //         deploy-time enforcement. lib/SequencerCheck reverts at runtime if
        //         feed == address(0) on chainid != 1; this require surfaces that
        //         loud at deploy time so an L2 deploy that forgets the env var
        //         cannot ship silently disabled. Mainnet (chainid 1) skip is
        //         intentional — Ethereum L1 has no sequencer concept.
        require(block.chainid == 1 || _sequencerFeed != address(0), "L2 needs sequencerFeed");

        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        weth = _weth;
        pair = _pair;
        twap = ITegridyTWAP(_twap);
        sequencerFeed = _sequencerFeed;

        // Snapshot the TOWELI side of the pair at construction so we don't depend
        // on an externally passed address later. Whichever slot isn't WETH is TOWELI.
        address t0 = ITegridyPair(_pair).token0();
        address t1 = ITegridyPair(_pair).token1();
        if (t0 == _weth) {
            toweli = t1;
        } else if (t1 == _weth) {
            toweli = t0;
        } else {
            // Pair does not contain WETH — misconfiguration.
            revert ZeroAddress();
        }
    }

    // ─── Loan Offers ─────────────────────────────────────────────────

    /// @notice Create a loan offer by depositing ETH. Lender specifies terms.
    /// @param _aprBps Annual percentage rate in basis points
    /// @param _duration Loan duration in seconds
    /// @param _collateralContract Address of the TegridyStaking contract (ERC721)
    /// @param _minPositionValue Minimum staked TOWELI amount in the NFT position
    /// @param _minPositionETHValue Optional ETH-denominated collateral floor. Zero disables
    ///        the check (backward-compatible default); non-zero enforces the floor inside
    ///        `acceptOffer` using current TegridyPair spot reserves. See `_positionETHValue`
    ///        for the caveats on spot-reserve reliance.
    /// @return offerId The ID of the created offer
    /// @dev AUDIT FIX: DEEP-LD-H3 — `nonReentrant` added to mirror the rest of the
    ///      ETH-paying surface. AUDIT FIX: DEEP-LD-M8 — origination fee held in
    ///      LoanOffer struct until acceptance. AUDIT FIX: DEEP-LD-M4 — refuse new
    ///      offers when collateral has a pending removal proposal.
    /// @notice AUDIT FIX (pass-8 batch-15): Phase 3.5 backward-compat entry. Defaults
    ///         the offer expiry to `block.timestamp + MAX_OFFER_VALIDITY` (90 days).
    ///         Lenders that want a tighter expiry should call
    ///         `createLoanOfferWithExpiry` directly. Pre-fix, offers had NO expiry —
    ///         callers using this 5-arg form now get a 90-day cap automatically,
    ///         which is a strict improvement over the prior unbounded behavior.
    function createLoanOffer(
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _minPositionValue,
        uint256 _minPositionETHValue
    ) external payable returns (uint256 offerId) {
        return _createLoanOffer(
            _aprBps,
            _duration,
            _collateralContract,
            _minPositionValue,
            _minPositionETHValue,
            uint64(block.timestamp + MAX_OFFER_VALIDITY)
        );
    }

    /// @param _expiry Absolute unix timestamp after which this offer can no longer
    ///                be accepted. Must be in
    ///                `[block.timestamp + MIN_OFFER_VALIDITY, block.timestamp + MAX_OFFER_VALIDITY]`
    ///                — short bound (1h) prevents pure-spam expiries that brick the
    ///                offer before a borrower can act; long bound (90d) caps the
    ///                stale-quote attack window. Lender retains `cancelOffer` for
    ///                early withdrawal at any time. AUDIT FIX (pass-8 batch-15) Phase 3.5.
    function createLoanOfferWithExpiry(
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _minPositionValue,
        uint256 _minPositionETHValue,
        uint64 _expiry
    ) external payable returns (uint256 offerId) {
        return _createLoanOffer(
            _aprBps,
            _duration,
            _collateralContract,
            _minPositionValue,
            _minPositionETHValue,
            _expiry
        );
    }

    function _createLoanOffer(
        uint256 _aprBps,
        uint256 _duration,
        address _collateralContract,
        uint256 _minPositionValue,
        uint256 _minPositionETHValue,
        uint64 _expiry
    ) private nonReentrant whenNotPaused returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPrincipal();
        if (msg.value < minPrincipal) revert PrincipalTooSmall();
        if (msg.value > maxPrincipal) revert PrincipalTooLarge();
        if (_aprBps > maxAprBps) revert AprTooHigh();
        if (_aprBps < minAprBps) revert AprTooLow();
        if (_duration < minDuration) revert DurationTooShort();
        if (_duration > maxDuration) revert DurationTooLong();
        if (_collateralContract == address(0)) revert ZeroAddress();
        if (!acceptedCollateralContracts[_collateralContract]) revert CollateralNotAccepted();
        // AUDIT FIX (pass-8 batch-15): Phase 3.5 — bound the offer-validity window.
        if (
            _expiry < block.timestamp + MIN_OFFER_VALIDITY ||
            _expiry > block.timestamp + MAX_OFFER_VALIDITY
        ) revert InvalidOfferExpiry();

        // AUDIT FIX: DEEP-LD-M4 — refuse new offers when this exact collateral has
        // a pending removal proposal in the timelock window.
        // AUDIT FIX (pass-8): EIP170-01 — pending state moved to TegridyLendingAdmin;
        // single view-call replaces three storage reads. lendingAdmin set-once at
        // deploy; reverts via the LendingAdminNotSet typed error if called pre-wire.
        if (lendingAdmin == address(0)) revert LendingAdminNotSet();
        if (ITegridyLendingAdminView(lendingAdmin).acceptedCollateralRemovalPending(_collateralContract)) {
            revert CollateralNotAccepted();
        }

        // AUDIT FIX (F-95-K-2 MED): MAX_TOTAL_OFFERS / MAX_OFFERS_PER_LENDER
        // caps. Mirrors the NFTLending-side liquidity-griefing fix. Without
        // these caps, a 1-ETH attack budget mints 1000 dust offers per
        // protocol; both views/indexers degrade and borrowers must filter
        // through noise. activeOffersByLender is a per-lender ACTIVE counter
        // (decremented on cancel/accept) so legitimate lenders are never
        // permanently squeezed out by their own cancel history.
        if (offers.length >= MAX_TOTAL_OFFERS) revert TooManyOffers();
        if (activeOffersByLender[msg.sender] >= MAX_OFFERS_PER_LENDER) {
            revert TooManyOffersPerLender();
        }

        // AUDIT FIX: DEEP-LD-M8 — origination fee held on offer struct until accept.
        uint256 originationFee = (msg.value * originationFeeBps) / BPS;
        uint256 effectivePrincipal = msg.value - originationFee;

        offerId = offers.length;
        // AUDIT FIX (F-95-K-2): bump active counter BEFORE the push so
        // re-entrancy through a callback can't desync. nonReentrant on the
        // function plus CEI throughout already preclude actual re-entry,
        // but ordering here matches the cancel/accept decrements at the
        // counterpart sites.
        activeOffersByLender[msg.sender] += 1;
        offers.push(LoanOffer({
            lender: msg.sender,
            principal: effectivePrincipal,
            aprBps: _aprBps,
            duration: _duration,
            collateralContract: _collateralContract,
            minPositionValue: _minPositionValue,
            minPositionETHValue: _minPositionETHValue,
            active: true,
            originationFee: originationFee,
            // AUDIT FIX: LD3-H3 — snapshot the live treasury at offer creation.
            treasuryAtCreate: treasury,
            // AUDIT FIX (BATCH-D H9, mirrors LD3-H3): snapshot protocolFeeBps at
            // offer creation so live governance changes cannot retroactively tax
            // in-flight loans. Lenders quote APR off the post-fee net; if the fee
            // changes after acceptance, the lender's expected net is silently
            // reduced. By snapshotting at create-time, the lender's expectation
            // is contractually pinned.
            // AUDIT FIX (M-8 / F-07-01): now an `int16`. Cast through `uint16`
            // first so the BPS value fits cleanly in the non-negative range
            // [0..1000] (uint16 of protocolFeeBps is bounded by
            // MAX_PROTOCOL_FEE_BPS = 1000). Zero is now a VALID captured
            // snapshot — distinct from "unset" which never occurs on freshly
            // minted offers. The repay-side fallback only applies to legacy
            // storage state where the field reads as `< 0`.
            protocolFeeBpsAtCreate: int16(uint16(protocolFeeBps)),
            // AUDIT FIX (pass-8 batch-15): Phase 3.5 — offer expiry.
            expiry: _expiry
        }));

        emit LoanOfferCreated(
            offerId,
            msg.sender,
            effectivePrincipal,
            _aprBps,
            _duration,
            _collateralContract,
            _minPositionValue,
            _minPositionETHValue
        );
    }

    /// @notice Cancel an active loan offer and refund ETH to lender.
    /// @dev    AUDIT FIX: DEEP-LD-M8 — refund principal + held origination fee.
    /// @dev    AUDIT FIX (F-95-K-2): decrement per-lender active counter.
    function cancelOffer(uint256 _offerId) external nonReentrant {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        if (offer.lender != msg.sender) revert NotOfferLender();

        // CEI: state change before external call
        offer.active = false;
        // AUDIT FIX (F-95-K-2): release lender's per-lender quota slot.
        if (activeOffersByLender[msg.sender] > 0) {
            activeOffersByLender[msg.sender] -= 1;
        }
        // AUDIT FIX: DEEP-LD-M8 — refund principal + held origination fee.
        uint256 refundAmount = offer.principal + offer.originationFee;
        offer.originationFee = 0;

        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, refundAmount);

        emit LoanOfferCancelled(_offerId, msg.sender);
    }

    // ─── Borrowing ───────────────────────────────────────────────────

    /// @notice Accept a loan offer by escrowing a TegridyStaking NFT position.
    ///         The borrower receives the principal ETH. NFT is held by this contract.
    /// @param _offerId The ID of the offer to accept
    /// @param _tokenId The TegridyStaking NFT token ID to use as collateral
    /// @return loanId The ID of the created loan
    /// @notice IMPORTANT — the optional ETH floor (`minPositionETHValue`) is checked
    ///         at acceptance, NOT at default. Lender bears price-decline risk over
    ///         the loan duration. AUDIT FIX: DEEP-LD-M5 — `lockEnd >= deadline +
    ///         LIQUIDATION_GRACE` (7 days). AUDIT FIX: DEEP-LD-L3 — re-validate
    ///         whitelist at acceptance. AUDIT FIX: DEEP-LD-M1 — register active
    ///         loan against collateral. AUDIT FIX: DEEP-LD-M8 — forward escrowed
    ///         origination fee to treasury at acceptance.
    function acceptOffer(
        uint256 _offerId,
        uint256 _tokenId
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer storage offer = offers[_offerId];

        if (!offer.active) revert OfferNotActive();
        // AUDIT FIX (pass-8 batch-15): Phase 3.5 — reject acceptance once the
        // offer has expired. Lender can `cancelOffer` to recover principal +
        // the held origination fee at any time. Pre-fix, an offer with stale
        // market terms could be accepted indefinitely.
        if (block.timestamp > offer.expiry) revert OfferExpired();

        // GAS: Cache storage reads into local variables
        uint256 principal = offer.principal;
        uint256 aprBps = offer.aprBps;
        address lender = offer.lender;
        uint256 duration = offer.duration;
        address collateralContract = offer.collateralContract;
        uint256 minPositionValue = offer.minPositionValue;
        uint256 minPositionETHValue = offer.minPositionETHValue;
        uint256 originationFee = offer.originationFee;
        // AUDIT FIX: LD3-H3 — use the snapshotted treasury for fee routing so a
        // treasury change between create and accept cannot redirect the fee.
        // Migration safety: pre-LD3-H3 offers default to address(0); fall back
        // to the live treasury so legacy offers remain payable.
        address feeRecipient = offer.treasuryAtCreate;
        if (feeRecipient == address(0)) feeRecipient = treasury;
        // AUDIT FIX D-LD-M1: honor an originationFee CUT between create and
        // accept (mirrors the LD3-M4 fix on TegridyNFTLending.acceptOffer).
        // Pre-fix, lenders paid yesterday's bps after a fee-rate cut, harming
        // UX fairness — and at MAX_PRINCIPAL_CEILING (100k ETH) × MAX_ORIGINATION_FEE_BPS (200bps)
        // the per-offer overpay reached 2,000 ETH. Now: re-derive the fee from
        // the offer's *gross* (principal + originationFee) using the lower of
        // (snapshot, live) bps. Surplus rejoins the borrower's principal flow.
        // Asymmetric design: a fee INCREASE between create and accept does NOT
        // raise the lender's cost (snapshot wins) — only fee CUTS are honored.
        if (originationFee > 0) {
            uint256 grossDeposit = principal + originationFee;
            uint256 liveFee = (grossDeposit * originationFeeBps) / BPS;
            if (liveFee < originationFee) {
                principal = grossDeposit - liveFee;
                originationFee = liveFee;
            }
        }

        // AUDIT FIX: DEEP-LD-L3 — refuse acceptance if collateral was de-whitelisted.
        if (!acceptedCollateralContracts[collateralContract]) revert CollateralNotAccepted();

        // Validate collateral: check position value meets minimum
        ITegridyStaking staking = ITegridyStaking(collateralContract);
        (uint256 positionAmount,, uint256 lockEnd,,,) = staking.getPosition(_tokenId);
        if (positionAmount < minPositionValue) revert InsufficientCollateralValue();

        if (minPositionETHValue > 0) {
            uint256 ethValue = _positionETHValue(positionAmount);
            if (ethValue < minPositionETHValue) revert InsufficientCollateralValue();
        }

        // AUDIT FIX: DEEP-LD-M5 — require lockEnd >= deadline + LIQUIDATION_GRACE.
        uint256 deadline = block.timestamp + duration;
        if (lockEnd == 0 || lockEnd < deadline + LIQUIDATION_GRACE) {
            revert LockExpiresBeforeDeadline();
        }

        // Verify borrower owns the NFT
        if (staking.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();

        // CEI: state changes before external calls
        offer.active = false;
        // AUDIT FIX (F-95-K-2): release lender's per-lender quota slot — the
        // offer just transitioned active→consumed (the slot stays in offers[]
        // for historical-record but no longer counts against the lender's
        // ACTIVE budget).
        if (activeOffersByLender[lender] > 0) {
            activeOffersByLender[lender] -= 1;
        }
        // AUDIT FIX: DEEP-LD-M8 — clear escrowed fee on offer.
        offer.originationFee = 0;

        loanId = loans.length;
        loans.push(Loan({
            borrower: msg.sender,
            lender: lender,
            offerId: _offerId,
            tokenId: _tokenId,
            principal: principal,
            aprBps: aprBps,
            startTime: block.timestamp,
            deadline: deadline,
            repaid: false,
            defaultClaimed: false,
            // AUDIT FIX: DEEP-LD2-M4 — snapshot pause budget at loan-create.
            pausedDurationAtStart: totalPausedDuration
        }));

        // PASS7-LENDING-03 FIX: snapshot the per-tokenId reward bucket BEFORE
        // the inbound transfer. At settlement, this loan claims only the
        // DELTA (`claimedDuringLoan - snapshot`) and leaves the snapshot
        // slice in lending's balance for a prior holder's deferred-claim
        // path via `pullEscrowRewards`. Reading BEFORE the transfer ensures
        // the inbound `_settleRewardsOnTransfer` credit (which represents
        // the borrower's pre-loan position accrual settled into the lending
        // bucket) is attributed to THIS loan's delta, not to the prior
        // holder. Without this snapshot, a borrower whose loan opens after a
        // prior loan deferred its settlement (paused staking) would drain
        // the prior loan's slice. Reads via the staking interface's
        // `unsettledRewardsByTokenId` getter (now in ITegridyStaking) —
        // public mapping in TegridyStaking.sol:174.
        loanRewardsSnapshot[loanId] = staking.unsettledRewardsByTokenId(_tokenId);

        // Transfer NFT from borrower to this contract (collateral escrow)
        staking.transferFrom(msg.sender, address(this), _tokenId);

        // PASS7-LENDING-01 FIX: post-condition check mirroring NFTLending.
        // A malicious whitelisted staking-shaped contract whose `transferFrom`
        // silently no-ops would otherwise let the loan record while the NFT
        // stayed with the borrower — lender's principal flows out, no real
        // escrow exists. Sister to TegridyNFTLending L506-508
        // (CollateralNotEscrowed). LD-NEW-H2 closed the NFT side; this closes
        // the symmetric Lending side that pass-6 missed.
        if (staking.ownerOf(_tokenId) != address(this)) revert CollateralNotEscrowed();

        // AUDIT FIX: DEEP-LD-M1 — register loan against collateral.
        activeLoansAgainstCollateral[collateralContract] += 1;

        // AUDIT FIX: DEEP-LD-M8 — forward escrowed origination fee to treasury.
        // AUDIT FIX: LD3-H3 — route to the snapshotted feeRecipient so a
        // treasury change between create and accept cannot redirect the fee.
        if (originationFee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, feeRecipient, originationFee);
            emit OriginationFeeCollected(lender, originationFee);
        }

        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, principal);

        emit LoanAccepted(
            loanId,
            _offerId,
            msg.sender,
            lender,
            _tokenId,
            principal,
            deadline
        );
    }

    // ─── Repayment ───────────────────────────────────────────────────

    /// @notice Repay a loan. Borrower sends principal + interest.
    ///         NFT is returned to borrower. Interest goes to lender (minus protocol fee).
    ///         SECURITY FIX: Callable even when paused — prevents forced defaults during pause.
    ///         If repayLoan were paused, deadlines would still expire, letting lenders claim
    ///         collateral on loans that borrowers intended to repay (griefing vector).
    /// @param _loanId The ID of the loan to repay
    function repayLoan(uint256 _loanId) external payable nonReentrant {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // GAS: Cache storage reads into local variables
        address borrower = loan.borrower;
        address lender = loan.lender;
        uint256 principal = loan.principal;
        uint256 aprBps = loan.aprBps;
        uint256 startTime = loan.startTime;
        uint256 tokenId = loan.tokenId;
        uint256 offerId = loan.offerId;

        if (msg.sender != borrower) revert NotBorrower();
        if (block.timestamp == startTime) revert LoanTooRecent();

        // AUDIT FIX: DEEP-LD-M7 — gate on deadline+grace BEFORE state mutation
        // or interest math. Cheap-checks-first; mirrors NFTLending.repayLoan.
        // AUDIT FIX: LD3-H1 — extend the deadline by `getSequencerOutageBuffer`
        // so an L2 sequencer outage that consumes part of the grace window does
        // NOT eat the borrower's repay window. Mirrors LD2-H1 on NFTLending.
        // checkSequencerUp on the lender path keeps the lender blocked during
        // grace; this extension restores symmetric outage handling.
        // AUDIT FIX FRESH-2026 (post-fix scan2 S-3): pass 4h staleness to match
        //         claimDefaultedCollateral's symmetric posture. Without this, repay
        //         path uses the lib's 24h default while claim path uses 4h —
        //         creating an asymmetric grace window if Chainlink ever lags
        //         between 4h and 24h on the L2 sequencer feed.
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD,
            4 hours
        );
        if (block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
            revert DeadlineExpired();
        }

        // AUDIT FIX: DEEP-LD2-M5 — pause-adjusted interest. AUDIT FIX: DEEP-LD-M6
        // — minimum interest floor (1-day equivalent). AUDIT FIX: DEEP-LD2-M2 —
        // skip floor when loan was 100% paused since start. AUDIT FIX: LD3-H2 —
        // APR-independent flat floor (5 bps of principal) defeats the 0% APR
        // loophole where the LD-M6 floor evaluates to zero.
        uint256 interest = calculateLoanInterest(_loanId);
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
        if (elapsed > 0) {
            uint256 minInterest = Math.mulDiv(
                principal * aprBps,
                MIN_INTEREST_DURATION,
                BPS * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
            // AUDIT FIX: LD3-H2 — APR-independent flat floor (mirror LD2-H2).
            uint256 flatFloor = (principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
            if (minInterest < flatFloor) minInterest = flatFloor;
            if (interest < minInterest) interest = minInterest;
        }
        uint256 totalRepayment = principal + interest;
        if (msg.value < totalRepayment) revert InsufficientRepayment();

        // CEI: state change before external calls
        loan.repaid = true;

        // AUDIT FIX: DEEP-LD-M1 — release collateral slot.
        address collateralContract = offers[offerId].collateralContract;
        if (activeLoansAgainstCollateral[collateralContract] > 0) {
            activeLoansAgainstCollateral[collateralContract] -= 1;
        }

        // Calculate protocol fee on interest
        // AUDIT FIX (BATCH-D H9): use the snapshot taken at offer creation
        // (offer.protocolFeeBpsAtCreate), not live `protocolFeeBps`. Closes
        // the retroactive-tax surface where a captured-key fee bump silently
        // re-prices in-flight loans against the lender's net expectation.
        // Mirrors the LD3-H3 treasuryAtCreate snapshot already used at
        // origination-fee leg. Backward-compat: for legacy offers created
        // before this fix (where protocolFeeBpsAtCreate == 0), fall back to
        // live protocolFeeBps so existing loans don't see free-fee at repay.
        // AUDIT FIX (M-8 / F-07-01): widened `protocolFeeBpsAtCreate` from
        // `uint16` to `int16`. A NEGATIVE value is now the explicit "unset
        // sentinel" — fall back to live `protocolFeeBps`. A non-negative
        // value (`0..1000`) is the captured snapshot and is used verbatim,
        // including the legitimate 0-bps captured-snapshot case that the
        // pre-fix `snapBps == 0` heuristic could not distinguish from
        // legacy/unset. Freshly minted offers always write `int16(uint16(bps))`
        // which is non-negative.
        int16 snapBps = offers[offerId].protocolFeeBpsAtCreate;
        uint256 effectiveFeeBps = snapBps < 0
            ? protocolFeeBps
            : uint256(uint16(snapBps));
        uint256 fee = (interest * effectiveFeeBps) / BPS;
        uint256 lenderAmount = principal + interest - fee;

        // Return NFT to borrower
        ITegridyStaking staking = ITegridyStaking(collateralContract);

        // PASS7-LENDING-03 FIX: drain the per-tokenId bucket to LENDING (not
        // directly to borrower) so we can split the claim into:
        //   - `priorShare`: rewards present in the bucket BEFORE this loan
        //     opened (snapshotted in `loanRewardsSnapshot[loanId]`). These
        //     belong to a prior holder whose settlement deferred (paused
        //     staking) and will be recovered via that prior loan's
        //     `pullEscrowRewards`. Stays in lending balance.
        //   - `myShare`: rewards credited to the bucket DURING this loan
        //     (delta above the snapshot). Forwarded to the borrower.
        //
        // Pre-fix (D-LD-H1): the two-phase pull drained the entire bucket
        // directly to the borrower, enabling a settled-vs-settled cross-loan
        // drain (PASS7-LENDING-03) when a prior loan deferred its claim
        // during a staking pause. The new split preserves the prior holder's
        // slice for their own pullEscrowRewards call.
        //
        // PASS7-LENDING-02 FIX: the outbound `staking.transferFrom` is now
        // wrapped in `_safeOutboundTransfer` so a malicious whitelisted
        // staking-shaped contract that silently no-ops the transfer cannot
        // strand the NFT in lending forever. Mirrors NFTLending.repayLoan.
        // On no-op, the borrower is recorded as `stuckCollateralRecipient`
        // and can recover via `claimStuckCollateral(loanId)` once the
        // collateral becomes honest.
        //
        // Two-phase claim still covers (a) any pre-existing per-tokenId
        // residue from kicks during the loan, AND (b) the final-period
        // accrual credited by the transferFrom hook itself. On try/catch
        // deferral, the un-claimable slice is recorded into
        // `escrowRewardsOwed[loanId]` so the borrower can recover via
        // `pullEscrowRewards` once staking is unpaused.
        uint256 snapshot = loanRewardsSnapshot[_loanId];
        uint256 totalDrained = 0;
        try staking.claimUnsettledForTokenId(tokenId, address(this)) returns (uint256 _prePaid) {
            totalDrained += _prePaid;
        } catch (bytes memory reason) {
            emit EscrowRewardsClaimDeferred(_loanId, reason);
        }

        bool moved = _safeOutboundTransferStaking(address(staking), address(this), borrower, tokenId);
        if (!moved) {
            stuckCollateralRecipient[_loanId] = borrower;
            emit CollateralStuck(_loanId, borrower, tokenId, address(staking));
        }

        try staking.claimUnsettledForTokenId(tokenId, address(this)) returns (uint256 _postPaid) {
            totalDrained += _postPaid;
        } catch (bytes memory reason) {
            emit EscrowRewardsClaimDeferred(_loanId, reason);
        }

        // Split: priorShare (≤ snapshot) belongs to a prior holder; myShare
        // (drained above snapshot) is this loan's recipient's earnings.
        uint256 priorShare = totalDrained > snapshot ? snapshot : totalDrained;
        uint256 myShare = totalDrained - priorShare;
        if (myShare > 0) {
            IERC20(toweli).safeTransfer(borrower, myShare);
            emit EscrowRewardsAttributed(_loanId, myShare);
        }
        // priorShare stays in lending balance — flows out via pullEscrowRewards'
        // legacy pro-rata path against `escrowRewardsOwed`. No bookkeeping
        // increment here because the prior loan's `escrowRewardsOwed` slot was
        // populated at THAT loan's deferral time (see deferral handler below).

        // Track the deferred slice that COULDN'T be drained from the staking
        // bucket (try/catch absorbed). Account for what's STILL in the bucket
        // beyond our snapshot — that's our slice the borrower can recover via
        // `pullEscrowRewards` once staking is unpaused.
        uint256 remainingInBucket = staking.unsettledRewardsByTokenId(tokenId);
        if (remainingInBucket > snapshot) {
            uint256 myDeferred = remainingInBucket - snapshot;
            escrowRewardsOwed[_loanId] += myDeferred;
            totalEscrowRewardsOwed += myDeferred;
            emit EscrowRewardsDeferredAndOwed(_loanId, myDeferred);
        }

        // SECURITY FIX: Use WETHFallbackLib to prevent DoS by revert-on-receive lender contracts.
        // A malicious lender could deploy a contract that reverts on ETH receive, permanently blocking
        // repayment and stealing the NFT collateral via claimDefaultedCollateral(). With WETH fallback,
        // if the raw ETH send fails, funds are wrapped as WETH and sent as ERC-20 instead.
        WETHFallbackLib.safeTransferETHOrWrap(weth, lender, lenderAmount);

        // Send protocol fee to treasury (also uses WETH fallback for robustness)
        if (fee > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, fee);
        }

        // AUDIT NFT-CL-M1: refund overpayment via WETH fallback. Plain
        // safeTransferETH reverts when the borrower is a contract whose
        // receive() rejects ETH or burns gas — bricking the borrower's
        // own repay path even though they paid principal + interest in
        // full. Mirrors the lender/treasury payout pattern above so all
        // three legs share one robust transfer primitive.
        uint256 overpayment = msg.value - totalRepayment;
        if (overpayment > 0) {
            WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, overpayment);
        }

        emit LoanRepaid(_loanId, borrower, principal, interest, fee);
    }

    // ─── Default ─────────────────────────────────────────────────────

    /// @notice Claim the collateral NFT after a loan defaults (borrower missed deadline).
    /// @dev    AUDIT FIX (BATCH-J3 H10): bound pause-blocking of lender claims
    ///         to MAX_PAUSE_BLOCK_LIQUIDATION (7 days). Pre-fix, captured-key
    ///         owner could pause indefinitely to block lender's exit — the
    ///         pause-asymmetry weapon (borrower's repayLoan was always open).
    ///         Now: pause for incident-response works for the first 7 days
    ///         (legitimate use case); beyond that, lender claims proceed even
    ///         while paused. 7d > GRACE_PERIOD + reasonable incident windows
    ///         while ensuring no captured-key indefinite freeze. Pattern:
    ///         MakerDAO Emergency Shutdown Module similar bounded-grace
    ///         design.
    /// @param _loanId The ID of the defaulted loan
    function claimDefaultedCollateral(uint256 _loanId) external nonReentrant {
        // AUDIT FIX FRESH-2026 (post-fix scan2 S-6): cumulative pause cap.
        //         Sibling-port from TegridyNFTLending.F-71-9. Pre-port a captured
        //         owner could pause/unpause within the 7-day single-window
        //         threshold indefinitely; now the threshold is summed across a
        //         rolling 30-day window so cycle-pause cannot evade the bound.
        if (paused()) {
            require(
                _cumulativePausedInWindow() > MAX_PAUSE_BLOCK_LIQUIDATION,
                "PausedShortOfBound"
            );
        }
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];

        if (loan.repaid) revert LoanAlreadyRepaid();
        if (loan.defaultClaimed) revert LoanAlreadyDefaultClaimed();

        // AUDIT FIX: DEEP-LIB-H3 — sequencer-uptime gate at the liquidation
        // entrypoint. Pre-fix the lender could call claimDefaultedCollateral
        // the instant `block.timestamp > effectiveDeadline + GRACE_PERIOD`
        // even when a sequencer outage had consumed the entire grace
        // window, leaving the borrower zero usable repay time. Matches the
        // symmetric fix on TegridyNFTLending.claimDefault and the existing
        // _positionETHValue guard.
        // AUDIT FIX (BATCH-L3 M4): tighten staleness to 4h (price-sensitive path).
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);

        // GAS: Cache storage reads into local variables
        address lender = loan.lender;
        uint256 tokenId = loan.tokenId;
        uint256 offerId = loan.offerId;

        if (msg.sender != lender) revert NotLoanLender();
        // AUDIT M-1: lender must wait for the post-deadline grace period to expire
        // before claiming the collateral, giving the borrower a 1h cushion to repay.
        // AUDIT R014: deadline now reads `effectiveDeadline` so an admin pause
        // extends the lender's wait by the same amount it extended the borrower's
        // repay window. Both sides wait through pause symmetrically.
        // AUDIT FIX: LD3-H1 — symmetric outage-buffer extension so both repay
        // and claim see the same effectiveDeadline + grace + outage window.
        // checkSequencerUp above enforces the steady-state grace; this returns
        // a non-zero buffer only during in-flight transitions / future buffer
        // adjustments. Mirrors LD2-H1 fix on TegridyNFTLending.claimDefault.
        uint256 outageBuffer = SequencerCheck.getSequencerOutageBuffer(
            sequencerFeed,
            SEQUENCER_GRACE_PERIOD
        );
        if (block.timestamp <= effectiveDeadline(_loanId) + GRACE_PERIOD + outageBuffer) {
            revert DeadlineNotReached();
        }

        // CEI: state change before external call
        loan.defaultClaimed = true;

        // AUDIT FIX: DEEP-LD-M1 — release collateral slot.
        address collateralContract = offers[offerId].collateralContract;
        if (activeLoansAgainstCollateral[collateralContract] > 0) {
            activeLoansAgainstCollateral[collateralContract] -= 1;
        }

        // Transfer NFT to lender
        ITegridyStaking staking = ITegridyStaking(collateralContract);

        // PASS7-LENDING-03 + PASS7-LENDING-02 FIX (mirror of repayLoan).
        // Drain to LENDING and split into priorShare (snapshot — belongs to
        // a prior holder's deferred-claim) vs myShare (delta — this loan's
        // earnings, forwarded to the defaulted-side lender). Outbound NFT
        // transfer wrapped in `_safeOutboundTransferStaking` for malicious-
        // collateral defense; on no-op, `lender` is recorded as
        // `stuckCollateralRecipient` for later `claimStuckCollateral`. On
        // try/catch deferral, the un-claimable slice is recorded into
        // `escrowRewardsOwed[loanId]` for `pullEscrowRewards`.
        uint256 snapshot = loanRewardsSnapshot[_loanId];
        uint256 totalDrained = 0;
        try staking.claimUnsettledForTokenId(tokenId, address(this)) returns (uint256 _prePaid) {
            totalDrained += _prePaid;
        } catch (bytes memory reason) {
            emit EscrowRewardsClaimDeferred(_loanId, reason);
        }

        bool moved = _safeOutboundTransferStaking(address(staking), address(this), lender, tokenId);
        if (!moved) {
            stuckCollateralRecipient[_loanId] = lender;
            emit CollateralStuck(_loanId, lender, tokenId, address(staking));
        }

        try staking.claimUnsettledForTokenId(tokenId, address(this)) returns (uint256 _postPaid) {
            totalDrained += _postPaid;
        } catch (bytes memory reason) {
            emit EscrowRewardsClaimDeferred(_loanId, reason);
        }

        uint256 priorShare = totalDrained > snapshot ? snapshot : totalDrained;
        uint256 myShare = totalDrained - priorShare;
        if (myShare > 0) {
            IERC20(toweli).safeTransfer(lender, myShare);
            emit EscrowRewardsAttributed(_loanId, myShare);
        }

        uint256 remainingInBucket = staking.unsettledRewardsByTokenId(tokenId);
        if (remainingInBucket > snapshot) {
            uint256 myDeferred = remainingInBucket - snapshot;
            escrowRewardsOwed[_loanId] += myDeferred;
            totalEscrowRewardsOwed += myDeferred;
            emit EscrowRewardsDeferredAndOwed(_loanId, myDeferred);
        }

        emit DefaultClaimed(_loanId, lender, tokenId);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  PASS7-LENDING-02 FIX — Stuck-collateral recovery surface  ║
    // ║  (mirror of TegridyNFTLending L704-L793 + L176)             ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice PASS7-LENDING-02 FIX: outbound staking-NFT transfer with both
    ///         revert AND silent-no-op detection. A whitelisted staking-shaped
    ///         contract that no-ops `transferFrom` (returns without revert AND
    ///         without moving the token) would silently let a loan settle while
    ///         leaving the NFT escrowed forever. Returns `true` only when the
    ///         post-call ownership confirms the transfer landed at `to`.
    ///         Mirrors NFTLending._safeOutboundTransfer L755-L782.
    function _safeOutboundTransferStaking(
        address stakingAddr,
        address from,
        address to,
        uint256 tokenId
    ) internal returns (bool moved) {
        // AUDIT FIX (pass-8): GAS-01 — bounded-returndata transferFrom + ownerOf.
        // Mirrors the same fix applied to NFTLending._safeOutboundTransfer.
        // Solidity's `try/catch` ALWAYS copies returndata before the catch
        // fires, so a malicious staking-shaped contract returning huge
        // returndata OOG-griefs every call. SafeERC721Call uses inline
        // assembly to cap returndata at 0/32 bytes via raw call/staticcall.
        bool ok = SafeERC721Call.safeTransferFromBounded(stakingAddr, from, to, tokenId);
        if (!ok) {
            return false;
        }
        (bool ownerOk, address newOwner) = SafeERC721Call.safeOwnerOfBounded(stakingAddr, tokenId);
        if (!ownerOk) {
            return false;
        }
        moved = (newOwner == to);
        if (!moved && newOwner != from) {
            emit CollateralRedirected(tokenId, stakingAddr, to, newOwner);
        }
    }

    /// @notice PASS7-LENDING-02 FIX: recover an NFT whose `transferFrom`
    ///         silently no-op'd during repayLoan / claimDefaultedCollateral.
    ///         Callable by the recipient recorded at the time of the original
    ///         call's NFT-transfer leg failure. The retry is wrapped in
    ///         `_safeOutboundTransferStaking` so a still-malicious collateral
    ///         contract REVERTS this call (and the mapping rolls back via
    ///         tx revert), letting the recipient retry later. Mirrors
    ///         NFTLending.claimStuckCollateral L721-L741 PLUS the
    ///         PASS7-NFTLENDING-01 post-condition fix applied below.
    ///
    ///         No `nonReentrant` because there is no value out-flow — the NFT
    ///         is the only asset moved, and ERC721 transfer cannot itself
    ///         trigger reentrant state mutation on this contract. The
    ///         `whenNotPaused` modifier is intentionally OMITTED so users
    ///         can recover their NFT even during a contract pause.
    function claimStuckCollateral(uint256 _loanId) external {
        if (_loanId >= loans.length) revert InvalidLoanId();
        address recipient = stuckCollateralRecipient[_loanId];
        if (recipient == address(0)) revert NoStuckCollateral();
        if (msg.sender != recipient) revert NotStuckCollateralRecipient();

        Loan storage loan = loans[_loanId];
        address collateralContract = offers[loan.offerId].collateralContract;
        uint256 tokenId = loan.tokenId;

        // Retry under the SAME no-op detector. If the collateral still no-ops,
        // `moved == false` → revert so the recipient retains the recovery
        // right (no silent loss). Cleared only on success. Closes the
        // PASS7-NFTLENDING-01-class hole that pass-6 LD-NEW-H2 left on the
        // recovery path.
        bool moved = _safeOutboundTransferStaking(collateralContract, address(this), recipient, tokenId);
        if (!moved) revert StuckCollateralStillStuck();

        delete stuckCollateralRecipient[_loanId];
        emit StuckCollateralClaimed(_loanId, recipient, tokenId);
    }

    // ─── View Functions ──────────────────────────────────────────────

    /// @notice Get a loan offer by ID.
    /// @param _offerId The offer ID to query
    /// @return lender The address of the lender
    /// @return principal The ETH principal amount (post origination fee)
    /// @return aprBps The annual percentage rate in basis points
    /// @return duration The loan duration in seconds
    /// @return collateralContract The TegridyStaking contract address
    /// @return minPositionValue The minimum collateral position value (TOWELI)
    /// @return minPositionETHValue Optional ETH-denominated collateral floor (0 = disabled)
    /// @return active Whether the offer is still active
    /// @return originationFee Origination fee held in escrow on the offer (AUDIT FIX: LD3-L1)
    /// @return treasuryAtCreate Treasury snapshot at offer creation (AUDIT FIX: LD3-L1)
    /// @dev    AUDIT FIX: LD3-L1 — view extended with the originationFee and
    ///         treasuryAtCreate fields added in LD-M8 / LD3-H3 so off-chain
    ///         integrators can reconcile lender deposits and verify fee routing.
    ///         Backward-compatible: tuple expansion appends elements at the end.
    function getOffer(uint256 _offerId) external view returns (
        address lender,
        uint256 principal,
        uint256 aprBps,
        uint256 duration,
        address collateralContract,
        uint256 minPositionValue,
        uint256 minPositionETHValue,
        bool active,
        uint256 originationFee,
        address treasuryAtCreate
    ) {
        if (_offerId >= offers.length) revert InvalidOfferId();
        LoanOffer memory o = offers[_offerId];
        return (
            o.lender,
            o.principal,
            o.aprBps,
            o.duration,
            o.collateralContract,
            o.minPositionValue,
            o.minPositionETHValue,
            o.active,
            o.originationFee,
            o.treasuryAtCreate
        );
    }

    /// @notice Get a loan by ID.
    /// @param _loanId The loan ID to query
    /// @return borrower The borrower address
    /// @return lender The lender address
    /// @return offerId The associated offer ID
    /// @return tokenId The escrowed NFT token ID
    /// @return principal The ETH principal amount
    /// @return aprBps The annual percentage rate in basis points
    /// @return startTime The loan start timestamp
    /// @return deadline The repayment deadline timestamp
    /// @return repaid Whether the loan has been repaid
    /// @return defaultClaimed Whether the lender has claimed the defaulted collateral
    /// @return pausedDurationAtStart `totalPausedDuration` snapshot at loan creation (AUDIT FIX: LD3-L1)
    /// @dev    AUDIT FIX: LD3-L1 — view extended with the pausedDurationAtStart
    ///         field added in LD2-M4 so off-chain integrators can compute
    ///         effectiveDeadline locally without an extra contract call.
    function getLoan(uint256 _loanId) external view returns (
        address borrower,
        address lender,
        uint256 offerId,
        uint256 tokenId,
        uint256 principal,
        uint256 aprBps,
        uint256 startTime,
        uint256 deadline,
        bool repaid,
        bool defaultClaimed,
        uint256 pausedDurationAtStart
    ) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return (
            l.borrower,
            l.lender,
            l.offerId,
            l.tokenId,
            l.principal,
            l.aprBps,
            l.startTime,
            l.deadline,
            l.repaid,
            l.defaultClaimed,
            l.pausedDurationAtStart
        );
    }

    /// @notice Calculate pro-rata interest accrued (rounds up to protect protocol).
    /// @param _principal The loan principal
    /// @param _aprBps The annual percentage rate in basis points
    /// @param _startTime The loan start time
    /// @param _currentTime The current time (or repayment time)
    /// @return interest The interest amount in wei
    function calculateInterest(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _startTime,
        uint256 _currentTime
    ) public pure returns (uint256 interest) {
        if (_currentTime <= _startTime) return 0;
        uint256 elapsed = _currentTime - _startTime;
        // AUDIT FIX (300-agent #3 / battle-tested): OZ Math.mulDiv with Ceil rounding.
        // 512-bit intermediate removes the cap-ceiling overflow constraint that the
        // prior naive multiplication relied on. Ceil rounding preserves the
        // protocol-favoring invariant for ragged sub-second pro-rata fractions.
        interest = Math.mulDiv(
            _principal * _aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
    }

    /// @notice AUDIT FIX: DEEP-LD2-M5 — pause-adjusted elapsed for a loan.
    function pauseAdjustedElapsed(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        if (block.timestamp <= loan.startTime) return 0;
        uint256 raw = block.timestamp - loan.startTime;
        uint256 pausedSinceStart = totalPausedDuration > loan.pausedDurationAtStart
            ? totalPausedDuration - loan.pausedDurationAtStart
            : 0;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pausedSinceStart += block.timestamp - pauseStartTime;
        }
        return pausedSinceStart >= raw ? 0 : raw - pausedSinceStart;
    }

    /// @notice AUDIT FIX: DEEP-LD2-M5 — pause-adjusted interest for a loan.
    function calculateLoanInterest(uint256 _loanId) public view returns (uint256 interest) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
        if (elapsed == 0) return 0;
        interest = Math.mulDiv(
            loan.principal * loan.aprBps,
            elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
    }

    /// @notice Get the total repayment amount for a loan at the current time.
    /// @dev    AUDIT FIX: DEEP-LD2-M5 — pause-adjusted interest. AUDIT FIX:
    ///         DEEP-LD-M6 — minimum interest floor. AUDIT FIX: DEEP-LD2-M2 —
    ///         skip floor when loan was 100% paused. AUDIT FIX: LD3-H2 —
    ///         APR-independent flat floor (mirror LD2-H2) for view parity.
    function getRepaymentAmount(uint256 _loanId) external view returns (uint256 total) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        uint256 interest = calculateLoanInterest(_loanId);
        uint256 elapsed = pauseAdjustedElapsed(_loanId);
        if (elapsed > 0) {
            uint256 minInterest = Math.mulDiv(
                l.principal * l.aprBps,
                MIN_INTEREST_DURATION,
                BPS * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
            // AUDIT FIX: LD3-H2 — APR-independent flat floor for view parity.
            uint256 flatFloor = (l.principal * MIN_INTEREST_PRINCIPAL_BPS) / BPS;
            if (minInterest < flatFloor) minInterest = flatFloor;
            if (interest < minInterest) interest = minInterest;
        }
        total = l.principal + interest;
    }

    /// @notice Check whether a loan has defaulted.
    /// @dev    AUDIT FIX: DEEP-LD-M3 — view reads `effectiveDeadline + GRACE_PERIOD`.
    function isDefaulted(uint256 _loanId) external view returns (bool) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory l = loans[_loanId];
        return !l.repaid
            && !l.defaultClaimed
            && block.timestamp > effectiveDeadline(_loanId) + GRACE_PERIOD;
    }

    /// @notice Get the total number of offers created.
    function offerCount() external view returns (uint256) {
        return offers.length;
    }

    /// @notice Value a TOWELI amount in ETH using the TegridyTWAP time-weighted price.
    /// @dev AUDIT critique 5.4 / R003 (agents 006/031/032): the prior implementation
    ///      read raw `ITegridyPair.getReserves()` and was provably sandwich-manipulable
    ///      inside the same transaction (see `test_NoSpotManipulation_AfterTWAP`). We
    ///      now consult the TegridyTWAP oracle over a 30-minute averaging window
    ///      (`TWAP_PERIOD`), matching Aave V3's default. A defence-in-depth staleness
    ///      check rejects the read if the most-recent observation is older than
    ///      `TWAP_MAX_STALENESS` (2h). Single-block manipulation cannot move a
    ///      30-minute average enough to change the outcome.
    /// @param toweliAmount Amount of TOWELI to value (18-decimal fixed-point).
    /// @return ETH-equivalent value as reported by `TegridyTWAP.consult` over the
    ///         `TWAP_PERIOD` window. Reverts `OracleStale` if the latest observation
    ///         is older than `TWAP_MAX_STALENESS`. Reverts with the TWAP's own
    ///         `InsufficientObservations` if the oracle has not been bootstrapped
    ///         with at least two observations spaced by `MIN_PERIOD`.
    /// @dev AUDIT FIX (F-09-L1): position size limits — `toweliAmount` SHOULD be
    ///      bounded by the realistic TOWELI supply (≤ 1e30 in 18-decimal wei).
    ///      The downstream `twap.consult` computes `toweliAmount * priceDiff`
    ///      in checked uint256; at TOWELI's 1e30 supply ceiling and a maximum
    ///      `priceDiff ≈ 2^112 × ratio` the product stays comfortably under
    ///      2^256. A caller that fabricated a position with `toweliAmount`
    ///      orders of magnitude above supply (only possible via a malicious
    ///      whitelisted staking-shaped contract) could trigger Panic(0x11);
    ///      the lender can recover by re-creating the offer with
    ///      `minPositionETHValue = 0`. Defense-in-depth: the staking-side
    ///      whitelist (acceptedCollateralContracts) and the 50% deviation
    ///      gate on TWAP updates jointly bound this surface.
    function _positionETHValue(uint256 toweliAmount) internal view returns (uint256) {
        // R062 (HIGH): refuse to value collateral when the L2 sequencer is
        // currently down or has just resumed within SEQUENCER_GRACE_PERIOD.
        // Without this gate, a borrower could accept an offer the moment a
        // sequencer comes back online and force the lender to value their
        // TOWELI collateral at pre-outage TWAP observations. address(0)
        // sequencerFeed is a no-op (mainnet / non-L2 deployments). The
        // downstream `twap.consult` ALSO performs this check, but having it
        // at the call site gives a typed revert before any TWAP read happens.
        // AUDIT FIX (BATCH-L3 M4): tighten staleness to 4h (price-sensitive path).
        SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours);

        // Defence-in-depth staleness gate. The TWAP itself enforces the same
        // 2-hour bound inside `consult`, but we want a typed `OracleStale` error
        // for callers and to keep the staleness window explicit at the call site.
        // AUDIT FIX LD-NEW-M4: directional check before subtraction. A bridged feed or
        // sequencer replay can momentarily produce `latest.timestamp > block.timestamp`
        // (the V3-LIB-M1 fix already hardened SequencerCheck against this same shape).
        // Pre-fix, the underflow tripped Solidity 0.8 checked-math `Panic(0x11)`,
        // bricking every lending operation reading the floor — typed OracleStale lets
        // callers retry instead of reverting on an opaque panic.
        ITegridyTWAP.Observation memory latest = twap.getLatestObservation(pair);
        if (latest.timestamp > block.timestamp) revert OracleStale();
        if (block.timestamp - latest.timestamp > TWAP_MAX_STALENESS) revert OracleStale();

        // AUDIT R014: dormancy-bypass cooldown. When the TWAP recently absorbed an
        // observation that skipped the deviation gate (post-dormancy rebootstrap),
        // the next `TWAP_PERIOD * 2` of consults rely on a single un-gated price
        // sample. Refuse to value collateral until the cooldown elapses so a
        // single dormant-then-attacker-chosen observation cannot sole-source the
        // ETH-floor read. Same surface as the staleness gate — typed OracleStale.
        // AUDIT FIX LD-NEW-M4: same directional check.
        uint256 lastBypass = twap.lastBypassUsed(pair);
        if (lastBypass > block.timestamp) revert OracleStale();
        if (lastBypass != 0 && block.timestamp - lastBypass < TWAP_PERIOD * 2) {
            revert OracleStale();
        }

        // consult(pair, tokenIn=toweli, amountIn=toweliAmount, period=30 min)
        // returns the time-weighted ETH-equivalent over the window. Same return
        // semantics as the previous reserve-ratio math but immune to single-block
        // reserve manipulation.
        return twap.consult(pair, toweli, toweliAmount, TWAP_PERIOD);
    }

    /// @notice Get the total number of loans created.
    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    // ─── Admin: applyXxx setters (called by TegridyLendingAdmin) ─────
    // AUDIT FIX (pass-8): EIP170-01 — the propose/execute/cancel triplets and
    // their pending storage moved to TegridyLendingAdmin during the Phase 0.1
    // contract split. Validation rules (ceilings, floors, cross-cap consistency)
    // are duplicated on the admin side BEFORE the call lands here; this contract
    // additionally re-validates against its own constants as defense in depth.

    function applyProtocolFeeChange(uint256 newFee) external onlyAdmin {
        if (newFee > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        uint256 old = protocolFeeBps;
        protocolFeeBps = newFee;
        emit ProtocolFeeChanged(old, newFee);
    }

    function applyTreasuryChange(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryChanged(old, newTreasury);
    }

    /// @dev AUDIT FIX (M-25 / F-33-1): `MAX_PRINCIPAL_FLOOR` defense-in-depth
    ///      check. Mirrors the propose-time check on TegridyLendingAdmin so a
    ///      direct admin call cannot collapse the principal window to a
    ///      single-wei range and brick offer creation.
    function applyMaxPrincipalChange(uint256 newCap) external onlyAdmin {
        if (newCap == 0) revert ZeroAmount();
        // AUDIT FIX (M-25 / F-33-1): floor enforcement on the apply path.
        if (newCap < MAX_PRINCIPAL_FLOOR) revert InvalidCapValue();
        if (newCap > MAX_PRINCIPAL_CEILING) revert InvalidCapValue();
        uint256 old = maxPrincipal;
        maxPrincipal = newCap;
        emit MaxPrincipalChanged(old, newCap);
    }

    function applyMaxAprBpsChange(uint256 newCap) external onlyAdmin {
        if (newCap == 0) revert ZeroAmount();
        if (newCap > MAX_APR_BPS_CEILING) revert InvalidCapValue();
        if (newCap < minAprBps) revert InvalidCapValue();
        uint256 old = maxAprBps;
        maxAprBps = newCap;
        emit MaxAprBpsChanged(old, newCap);
    }

    function applyMinDurationChange(uint256 newValue) external onlyAdmin {
        if (newValue < MIN_DURATION_FLOOR || newValue > MIN_DURATION_CEILING) revert InvalidCapValue();
        if (newValue >= maxDuration) revert InvalidCapValue();
        uint256 old = minDuration;
        minDuration = newValue;
        emit MinDurationChanged(old, newValue);
    }

    function applyMaxDurationChange(uint256 newValue) external onlyAdmin {
        if (newValue > MAX_DURATION_CEILING) revert InvalidCapValue();
        if (newValue <= minDuration) revert InvalidCapValue();
        uint256 old = maxDuration;
        maxDuration = newValue;
        emit MaxDurationChanged(old, newValue);
    }

    // ─── Pausable ────────────────────────────────────────────────────
    //
    // AUDIT R014: pause-aware deadlines. Both `_pause` and `_unpause` are
    // overridden so we can record the wall-clock duration the protocol spends
    // paused. `effectiveDeadline(loanId)` adds the accumulated paused duration
    // (plus the in-flight pause window) to every loan's nominal deadline so
    // neither side is forced into default by an admin pause that locks
    // `claimDefaultedCollateral`. Borrowers can still call `repayLoan` while
    // paused, but if they do not, the lender's claim path waits.

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _pause() internal override {
        super._pause();
        pauseStartTime = block.timestamp;
    }

    function _unpause() internal override {
        // Snapshot before clearing so we accrue exactly the elapsed window.
        uint256 start = pauseStartTime;
        if (start != 0 && block.timestamp > start) {
            totalPausedDuration += block.timestamp - start;
            // AUDIT FIX FRESH-2026 (post-fix scan2 S-6): append the completed
            //         pause window so `_cumulativePausedInWindow` can sum
            //         across a rolling 30-day window. Closes the cycle-pause
            //         bypass identified in TegridyNFTLending F-71-9 and
            //         carried forward as a sibling-miss to this contract.
            pauseHistory.push(PauseEpisode({
                startedAt: uint128(start),
                endedAt: uint128(block.timestamp)
            }));
        }
        pauseStartTime = 0;
        super._unpause();
    }

    /// @notice Sum of pause durations intersecting the rolling 30-day window.
    ///         Includes the in-flight pause if currently paused. Sibling-port
    ///         from TegridyNFTLending.F-71-9.
    function _cumulativePausedInWindow() internal view returns (uint256 total) {
        uint256 windowStart = block.timestamp > CUMULATIVE_PAUSE_WINDOW
            ? block.timestamp - CUMULATIVE_PAUSE_WINDOW
            : 0;
        uint256 len = pauseHistory.length;
        for (uint256 i = 0; i < len; i++) {
            PauseEpisode storage ep = pauseHistory[i];
            uint256 epEnd = uint256(ep.endedAt);
            if (epEnd <= windowStart) continue;
            uint256 epStart = uint256(ep.startedAt);
            uint256 lo = epStart > windowStart ? epStart : windowStart;
            if (epEnd > lo) total += (epEnd - lo);
        }
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            uint256 lo = pauseStartTime > windowStart ? pauseStartTime : windowStart;
            total += (block.timestamp - lo);
        }
    }

    /// @notice Pause-extended deadline for a loan.
    /// @dev    AUDIT FIX: DEEP-LD2-M4 — subtract per-loan `pausedDurationAtStart`
    ///         snapshot so pre-loan pauses cannot retroactively extend deadlines.
    function effectiveDeadline(uint256 _loanId) public view returns (uint256) {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan storage loan = loans[_loanId];
        uint256 base = loan.deadline;
        uint256 pauseExt = totalPausedDuration > loan.pausedDurationAtStart
            ? totalPausedDuration - loan.pausedDurationAtStart
            : 0;
        if (paused() && pauseStartTime != 0 && block.timestamp > pauseStartTime) {
            pauseExt += block.timestamp - pauseStartTime;
        }
        return base + pauseExt;
    }

    // ─── Origination Fee + Min APR (apply hooks) ─────────────────────
    function applyOriginationFeeChange(uint256 newBps) external onlyAdmin {
        if (newBps > MAX_ORIGINATION_FEE_BPS) revert OriginationFeeTooHigh();
        uint256 old = originationFeeBps;
        originationFeeBps = newBps;
        emit OriginationFeeChanged(old, newBps);
    }

    function applyMinAprChange(uint256 newBps) external onlyAdmin {
        if (newBps > MAX_MIN_APR_BPS) revert MinAprTooHigh();
        // Don't allow min > max — would brick createLoanOffer.
        require(newBps <= maxAprBps, "MIN_EXCEEDS_MAX");
        uint256 old = minAprBps;
        minAprBps = newBps;
        emit MinAprChanged(old, newBps);
    }

    // ─── AUDIT R014: Escrow Rewards Recovery ──────────────────────────
    //
    // While a loan is active, the staking position NFT is held by this contract.
    // Any rewards that accrue during that window land in
    // TegridyStaking.unsettledRewards[address(this)] when the NFT is transferred
    // back at settlement time. We attribute those rewards to the loan's
    // beneficiary (borrower if repaid, lender if defaulted) and let them pull the
    // proportional payout via this function.
    //
    // The proportional payout (`payout = available >= total ? owed : owed * available / total`)
    // protects against the case where the staking contract is paused and the
    // try/catch'd `claimUnsettled` deferred — only some of the cumulative escrow
    // rewards actually live in this contract. Beneficiaries get their pro-rata share
    // of whatever is available; the leftover stays claimable.

    /// @notice Pull the escrow-rewards payout for a settled loan. Anyone can call,
    ///         but only the loan's beneficiary receives funds.
    ///         - Repaid loan → recipient is the borrower.
    ///         - Defaulted loan → recipient is the lender.
    ///         Reverts if the loan is still active or has no recoverable rewards.
    /// @dev    AUDIT NFT-CL-L2 DONOR WARNING (2026-04-28): TOWELI sent directly to
    ///         this contract address (i.e., NOT routed through the staking-contract
    ///         claim path) is NOT refundable — it joins the contract's TOWELI
    ///         balance and is distributed pro-rata across all settled-loan
    ///         escrow beneficiaries on their next `pullEscrowRewards` call. Do
    ///         not airdrop or accidentally transfer TOWELI here. The pro-rata
    ///         distribution math is intentional (it allows the contract to
    ///         keep paying beneficiaries even if a staking-side claim deferred),
    ///         but it makes any direct donation effectively a public good for
    ///         the current set of escrow holders.
    /// @param _loanId The loan to pull rewards for.
    function pullEscrowRewards(uint256 _loanId) external nonReentrant {
        if (_loanId >= loans.length) revert InvalidLoanId();
        Loan memory loan = loans[_loanId];

        // Reward attribution only makes sense after the NFT has left this contract.
        if (!loan.repaid && !loan.defaultClaimed) revert LoanStillActive();

        address recipient = loan.repaid ? loan.borrower : loan.lender;
        if (msg.sender != recipient) revert NotEscrowBeneficiary();

        ITegridyStaking staking = ITegridyStaking(offers[loan.offerId].collateralContract);

        // AUDIT FIX D-LD-H1: per-tokenId pull. After repayLoan/claimDefaultedCollateral
        // wired the two-phase per-tokenId attribution (D-LD-H1 fix), most settled loans
        // will have escrowRewardsOwed[loanId] == 0. The per-tokenId path here covers
        // (a) loans where the repay/claim try/catch deferred (paused staking), and
        // (b) any kick on this NFT that landed AFTER settlement but before pull
        // (rare — only relevant if NFT briefly reentered escrow). Best-effort try/catch
        // matches the deferred-claim semantics.
        //
        // AUDIT FIX LD-NEW-H1 (cross-loan drain): refuse the per-tokenId pull when
        // the NFT is currently re-escrowed at this lending contract — those credits
        // belong to the active loan and will be drained by ITS repay/default flow.
        // Pre-fix, an old settled-loan beneficiary could call this fn during a NEW
        // active loan on the same tokenId and drain the active loan's accruing
        // kick rewards via the shared `unsettledRewardsByTokenId[tokenId]` mapping.
        // The check uses ownerOf rather than balanceOf so we can isolate the
        // specific tokenId. The bug-closing predicate is the staking-side
        // `_isTrackedHolder` check inside `claimUnsettledForTokenId` plus this
        // contract-side `ownerOf` gate — together they ensure cross-loan and
        // cross-period theft cannot drain credits that belong to a different
        // settlement scope than the one the caller is claiming for.
        uint256 directPaid = 0;
        bool nftHeldHere = false;
        try staking.ownerOf(loan.tokenId) returns (address currentOwner) {
            nftHeldHere = (currentOwner == address(this));
        } catch {
            // ownerOf reverted — token doesn't exist (burned). Treat as "not held".
        }
        if (!nftHeldHere) {
            try staking.claimUnsettledForTokenId(loan.tokenId, recipient) returns (uint256 _p) {
                directPaid = _p;
            } catch (bytes memory reason) {
                emit EscrowRewardsClaimDeferred(_loanId, reason);
            }
        }

        // Legacy path: any pre-fix escrowRewardsOwed entry (set by the prior
        // snapshot/delta + claimUnsettled flow) gets paid out via the existing
        // pro-rata math. New loans typically arrive here with owed == 0.
        uint256 owed = escrowRewardsOwed[_loanId];

        // AUDIT FIX PASS7-LENDING-04: reconcile the legacy ledger against the
        // `directPaid` path. PASS7-LENDING-03's deferral-tracker (in
        // repayLoan / claimDefaultedCollateral) increments
        // `escrowRewardsOwed[_loanId]` when a paused-staking try/catch leaves
        // a slice in the per-tokenId bucket. When staking later unpauses and
        // the recipient calls this function, the `directPaid` path drains
        // that same slice from the staking bucket directly to the recipient.
        // Without reconciliation, the legacy ledger stays at the deferred
        // amount — and any future TOWELI inflow (donation, sibling loan's
        // priorShare landing here, sweep return) becomes double-claimable via
        // the legacy pro-rata branch below. Decrement both per-loan and
        // global counters by min(directPaid, owed); they MUST stay in lockstep
        // because the directPaid economically pays off the same slice that
        // was booked into escrowRewardsOwed at the deferral.
        if (directPaid > 0 && owed > 0) {
            uint256 reconcile = directPaid > owed ? owed : directPaid;
            escrowRewardsOwed[_loanId] = owed - reconcile;
            if (totalEscrowRewardsOwed >= reconcile) {
                totalEscrowRewardsOwed -= reconcile;
            } else {
                totalEscrowRewardsOwed = 0;
            }
            owed = escrowRewardsOwed[_loanId];
        }

        if (owed == 0) {
            // No legacy attribution — direct path is the only payout. Revert
            // ONLY if neither leg paid anything, so a no-op call still gives a
            // typed error rather than a silent zero-cost succeed.
            if (directPaid == 0) revert NoEscrowRewards();
            emit EscrowRewardsPaid(_loanId, recipient, 0, directPaid);
            return;
        }

        // Compute the proportional payout. `toweli` is the reward token (snapshotted
        // at construction). When the contract holds enough to cover everyone, the
        // beneficiary gets the full `owed`. When it doesn't, payouts shrink pro-rata
        // so the remaining `owed - payout` stays claimable as more rewards arrive.
        uint256 available = IERC20(toweli).balanceOf(address(this));
        uint256 total = totalEscrowRewardsOwed;
        uint256 payout;
        if (available == 0 || total == 0) {
            payout = 0;
        } else if (available >= total) {
            payout = owed;
        } else {
            // AUDIT FIX: DEEP-LD-M2 — Math.mulDiv to remove `owed*available` overflow.
            // Synthetix-pull order-dependency refactor deferred (see DEEP audit).
            payout = Math.mulDiv(owed, available, total, Math.Rounding.Floor);
        }

        // Always decrement the per-loan and global counters by `payout` (zero is a
        // valid no-op when nothing is available). When the underlying balance grows
        // later, a subsequent call picks up the next slice.
        escrowRewardsOwed[_loanId] = owed - payout;
        if (totalEscrowRewardsOwed >= payout) {
            totalEscrowRewardsOwed -= payout;
        } else {
            totalEscrowRewardsOwed = 0;
        }

        // AUDIT FIX D-LD-H1: emit the COMBINED payout (legacy pro-rata + per-
        // tokenId direct) so off-chain monitors see the full economic effect
        // of a single pullEscrowRewards call. `owed` reflects the legacy slot
        // only, matching the existing event ABI.
        emit EscrowRewardsPaid(_loanId, recipient, owed, payout + directPaid);

        if (payout > 0) {
            IERC20(toweli).safeTransfer(recipient, payout);
        }
    }

    // ─── Sweep + MinPrincipal + AcceptedCollateral (apply hooks) ─────
    // AUDIT FIX (pass-8): EIP170-01 — propose/execute/cancel + pending state +
    // proposed/cancelled events all moved to TegridyLendingAdmin. The reservation-
    // guard, active-loans gate, and cancel-rate-limit logic are preserved on the
    // admin side; the `applyXxx` setters here perform the underlying state
    // mutation + emit the "happened" events. Reservation guard for the sweep
    // MUST stay here (it's a balance-time invariant on this contract's TOWELI),
    // hence the inline check below.

    event SweepDonatedToweliExecuted(uint256 amount, address to);

    /// @dev    AUDIT FIX (BATCH-G H22): the `to` parameter is preserved for ABI
    ///         compatibility with TegridyLendingAdmin's existing propose/execute
    ///         pair, but is now CONSTRAINED to equal the contract's `treasury`
    ///         field (which is itself 48h-timelocked via TREASURY_TIMELOCK).
    ///         Pre-fix, a captured admin key could route donated TOWELI to ANY
    ///         arbitrary address in one 48h cycle. Now the captured key must
    ///         additionally rotate `treasury` first (+48h) — chaining two
    ///         timelocks, so the effective drain window grows from 48h to 96h
    ///         and is fully observable on-chain. Pattern: Aave V3 rescueTokens
    ///         relies on the treasury-recipient invariant + role layer for the
    ///         same reason. The reservation guard against escrowRewardsOwed
    ///         is preserved verbatim (DEEP-LD-M2).
    function applySweepDonatedToweli(uint256 amount, address to) external onlyAdmin nonReentrant {
        if (to != treasury) revert InvalidSweepRecipient();
        uint256 bal = IERC20(toweli).balanceOf(address(this));
        // Reservation guard: sweep MUST leave totalEscrowRewardsOwed fully covered.
        if (bal < totalEscrowRewardsOwed || bal - totalEscrowRewardsOwed < amount) {
            revert InsufficientCollateralValue();
        }
        IERC20(toweli).safeTransfer(to, amount);
        emit SweepDonatedToweliExecuted(amount, to);
    }

    function applyMinPrincipalChange(uint256 newValue) external onlyAdmin {
        if (newValue == 0) revert ZeroAmount();
        if (newValue > MAX_MIN_PRINCIPAL) revert InvalidCapValue();
        uint256 old = minPrincipal;
        minPrincipal = newValue;
        emit MinPrincipalChanged(old, newValue);
    }

    function applyAcceptedCollateralChange(address collateral, bool add) external onlyAdmin {
        if (collateral == address(0)) revert ZeroAddress();
        // AUDIT FIX preserved: DEEP-LD-M1 / LD3-M5 — refuse removal while loans
        // in flight, mirrored on the admin side as a pre-_execute gate. Re-checked
        // here as defense in depth; should never trip if admin path runs first.
        if (!add && activeLoansAgainstCollateral[collateral] > 0) {
            revert ActiveLoansPresent(collateral, activeLoansAgainstCollateral[collateral]);
        }
        acceptedCollateralContracts[collateral] = add;
        // AUDIT FIX preserved: LD3-M3 — reset cancel-counter on successful removal.
        if (!add) collateralRemovalRetryCount[collateral] = 0;
        emit AcceptedCollateralChanged(collateral, add);
    }

    /// @notice AUDIT FIX preserved: LD3-M3 — admin contract calls this on each
    ///         live cancellation of a removal proposal so the rate-limit counter
    ///         increments. Restricted to admin to prevent direct manipulation.
    function bumpCollateralRemovalRetryCount(address collateral) external onlyAdmin {
        collateralRemovalRetryCount[collateral] += 1;
    }

    /// @notice AUDIT FIX (F-33-4): admin contract calls this on a successful
    ///         cancel of an ADD proposal to reset the per-collateral retry
    ///         counter. A cancel is a legitimate revoke and should not burn
    ///         the budget for that collateral if a future legitimate REMOVAL
    ///         is needed. Mirrors the success-path reset inside
    ///         `applyAcceptedCollateralChange`. Restricted to admin to
    ///         prevent direct manipulation.
    function resetCollateralRemovalRetryCount(address collateral) external onlyAdmin {
        collateralRemovalRetryCount[collateral] = 0;
    }

    // ─── AUDIT FIX (F-95-K-7 LOW): orphan NFT recovery ─────────────────
    /// @notice Sweep an unsolicited NFT that was sent to this contract via
    ///         `transferFrom` (NOT through `acceptOffer`). Recipient is the
    ///         current TegridyLending owner. Refuses to sweep an NFT that is
    ///         currently in active escrow against any open loan.
    /// @dev    AUDIT FIX (F-95-K-7): pre-fix, an attacker could `transferFrom`
    ///         a (possibly worthless) NFT of any whitelisted collection into
    ///         this contract; without this admin sweeper the NFT was orphaned
    ///         forever and the contract's balanceOf(collection) was polluted
    ///         off-chain. The active-loan gate uses a tokenId scan over loans[]
    ///         (capped by MAX_TOTAL_OFFERS — bounded enumeration). Pattern
    ///         mirrored from every mature P2P NFT-lending protocol.
    /// @param  _collection ERC721 contract whose NFT is stuck in this address.
    /// @param  _tokenId    Token ID held at `address(this)`.
    /// @param  _to         Recipient. Owner-controlled to avoid griefer-influences.
    function sweepUnsolicitedNFT(
        address _collection,
        uint256 _tokenId,
        address _to
    ) external onlyOwner nonReentrant {
        if (_collection == address(0)) revert ZeroAddress();
        if (_to == address(0)) revert ZeroAddress();
        // Defense-in-depth: ensure the NFT is actually held here (no-op
        // sweep otherwise wastes gas without changing state).
        (bool ownerOk, address currentOwner) = SafeERC721Call.safeOwnerOfBounded(_collection, _tokenId);
        if (!ownerOk) revert NotHeldByContract();
        if (currentOwner != address(this)) revert NotHeldByContract();
        // Refuse to sweep an NFT that is collateral to an active loan. We
        // walk loans[] and check (collateralContract, tokenId, !repaid &&
        // !defaultClaimed) — bounded by MAX_TOTAL_OFFERS in the worst case.
        // For typical operating volumes this scan is well under any block
        // gas limit; the alternative (a per-(collection, tokenId) reverse
        // index) costs a slot per active loan and is overkill given owner-
        // only callability + nonReentrant + bounded loans[] cap.
        uint256 nLoans = loans.length;
        for (uint256 i = 0; i < nLoans; i++) {
            Loan storage l = loans[i];
            if (l.repaid || l.defaultClaimed) continue;
            if (l.tokenId != _tokenId) continue;
            address coll = offers[l.offerId].collateralContract;
            if (coll == _collection) revert CollateralInUse();
        }
        // Use the bounded transferFrom helper so a malicious whitelisted
        // collection cannot OOG-grief this admin path via giant returndata.
        bool moved = SafeERC721Call.safeTransferFromBounded(_collection, address(this), _to, _tokenId);
        if (!moved) revert NotHeldByContract();
    }
}
