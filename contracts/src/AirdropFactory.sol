// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {PauseGuardian} from "./base/PauseGuardian.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyAirdropDistributor} from "./TegridyAirdropDistributor.sol";

/// @title  AirdropFactory — self-serve Merkle airdrop campaigns
/// @notice Anyone funds a distribution, supplies a merkle root and a claim window, and
///         gets back an immutable, ownerless `TegridyAirdropDistributor`. Claimants prove
///         a leaf; whatever nobody claims goes back to the creator after expiry.
///
///         Battle-tested source: the claim path is Uniswap's `merkle-distributor` at
///         commit `25a79e8ec8c22076a735b1a675b961c8184e7931`, vendored verbatim under
///         `src/vendor/uniswap-merkle-distributor/` (see VENDOR.md, including the
///         GPL-3.0-or-later note) and extended by inheritance rather than by edit.
///
/// @dev    What this factory can and cannot do, because the distinction is the whole
///         security story:
///
///         CAN: refuse to create NEW campaigns (pause), and change the fee/sink that
///         FUTURE campaigns will snapshot.
///
///         CANNOT: touch an existing campaign. Distributors hold no reference to factory
///         state — fee, sink, creator and expiry are `immutable` on each distributor —
///         so neither the owner, nor the pause guardian, nor a compromised factory can
///         re-price, freeze, redirect or drain a campaign that already exists. Pausing
///         this factory does not stop a single claim anywhere.
///
/// @dev    Fee posture. `claimFeeWei` ships at ZERO and `feeSink` ships at
///         `address(0)`. The contract refuses to create a fee-bearing campaign while the
///         sink is unset, and refuses to arm a fee before a sink exists. Enabling the fee
///         is two timelocked owner ceremonies, in that order, and is not done here.
///
/// @dev    Deployment shape: distributors are deployed with `new` (CREATE), not with
///         minimal proxies. Clones would require the vendored distributor's `token` and
///         `merkleRoot` immutables to become initializable storage — an edit to the
///         verbatim core in exchange for deployment gas. The verbatim core wins.
contract AirdropFactory is OwnableNoRenounce, Pausable, PauseGuardian, TimelockAdmin, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Timelock operation keys ─────────────────────────────────────
    bytes32 public constant CLAIM_FEE_CHANGE = keccak256("AIRDROP_CLAIM_FEE_CHANGE");
    bytes32 public constant FEE_SINK_CHANGE = keccak256("AIRDROP_FEE_SINK_CHANGE");

    /// @notice 48h, matching the SwapFeeRouter / MemeBountyBoard treasury-rotation
    ///         window. A fee change only affects campaigns created after execution, but
    ///         the window is what lets an integrator notice the change before their next
    ///         campaign quotes a different number to claimants.
    uint256 public constant FEE_CHANGE_DELAY = 48 hours;

    // ─── Hard bounds ─────────────────────────────────────────────────

    /// @notice Ceiling on the per-claim fee, enforced at propose time and unchangeable
    ///         for the life of the contract (no proxy, no setter). Sized at roughly four
    ///         times the ~0.0005 ETH the build note targets, so the operator has room to
    ///         track gas costs without the cap ever becoming the thing that has to be
    ///         renegotiated by redeploy.
    uint256 public constant MAX_CLAIM_FEE_WEI = 0.002 ether;

    /// @notice Shortest claim window a campaign may set. Below a day, a claimant in the
    ///         wrong timezone loses their allocation to the creator's reclaim.
    uint64 public constant MIN_CLAIM_WINDOW = 1 days;

    /// @notice Longest claim window. Bounds how long a creator's capital can sit
    ///         unreachable behind their own campaign.
    uint64 public constant MAX_CLAIM_WINDOW = 365 days;

    // ─── Errors ──────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroMerkleRoot();
    error ZeroAmount();
    /// @notice `claimWindow` outside [MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW].
    error InvalidClaimWindow(uint64 supplied, uint64 min, uint64 max);
    /// @notice Proposed fee above `MAX_CLAIM_FEE_WEI`.
    error FeeAboveCap(uint256 supplied, uint256 cap);
    /// @notice A non-zero fee was proposed, or a fee-bearing campaign attempted, while
    ///         `feeSink` is still `address(0)`. Fee ETH with nowhere to go is the
    ///         orphan-fee-account failure this repo has already paid for once.
    error FeeSinkUnset();
    /// @notice The pending value did not match what the executing owner expected. Binds
    ///         the execute call to a specific value so a queued proposal cannot be
    ///         executed into a different meaning than the one that was reviewed.
    error PendingValueMismatch();
    /// @notice Proposing the value that is already live.
    error ValueUnchanged();
    /// @notice The token moved zero balance into the fresh distributor. Catches a
    ///         fee-on-transfer token configured to take 100%, and any token whose
    ///         `transferFrom` silently no-ops.
    error NoFundsReceived();

    // ─── Events ──────────────────────────────────────────────────────

    /// @param distributor The campaign contract.
    /// @param funded      Balance the distributor ACTUALLY received, measured, not the
    ///                    amount requested — the two differ for fee-on-transfer tokens
    ///                    and the measured figure is the one a claim page may show.
    event CampaignCreated(
        address indexed distributor,
        address indexed creator,
        address indexed token,
        bytes32 merkleRoot,
        uint256 funded,
        uint64 expiresAt,
        uint256 claimFeeWei,
        address feeSink
    );
    event ClaimFeeChangeProposed(uint256 currentFee, uint256 newFee, uint256 executeAfter);
    event ClaimFeeChanged(uint256 oldFee, uint256 newFee);
    event FeeSinkChangeProposed(address currentSink, address newSink, uint256 executeAfter);
    event FeeSinkChanged(address indexed oldSink, address indexed newSink);

    // ─── State ───────────────────────────────────────────────────────

    /// @notice Flat ETH fee that the NEXT campaign will snapshot. Ships at zero.
    uint256 public claimFeeWei;
    /// @notice Fee recipient that the NEXT campaign will snapshot. Ships at
    ///         `address(0)`, which is what makes a fee impossible until an operator acts.
    address public feeSink;

    uint256 public pendingClaimFeeWei;
    address public pendingFeeSink;

    /// @notice Every campaign this factory has created, in creation order.
    address[] public campaigns;
    /// @notice Provenance check for anything reading a campaign address from an untrusted
    ///         source: a distributor not in this mapping was not created here and its
    ///         parameters were never bounds-checked by this contract.
    mapping(address => bool) public isCampaign;

    mapping(address => address[]) internal _campaignsByCreator;
    mapping(address => address[]) internal _campaignsByToken;

    constructor(address initialOwner) OwnableNoRenounce(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    // ─── Campaign creation ───────────────────────────────────────────

    /// @notice Create and fund an airdrop campaign.
    /// @dev    Caller must have approved `fundingAmount` of `token` to this factory. The
    ///         tokens are pulled straight through to the fresh distributor; this factory
    ///         never holds a balance between transactions and has no token sweep path,
    ///         so there is nothing here to steal.
    /// @param  token         ERC-20 to distribute.
    /// @param  merkleRoot    Root over `keccak256(abi.encodePacked(index, account, amount))`.
    /// @param  fundingAmount Amount to pull from the caller.
    /// @param  claimWindow   Seconds from now until claims close.
    /// @return distributor   The new campaign.
    function createCampaign(address token, bytes32 merkleRoot, uint256 fundingAmount, uint64 claimWindow)
        external
        whenNotPaused
        nonReentrant
        returns (address distributor)
    {
        if (token == address(0)) revert ZeroAddress();
        if (merkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (fundingAmount == 0) revert ZeroAmount();
        if (claimWindow < MIN_CLAIM_WINDOW || claimWindow > MAX_CLAIM_WINDOW) {
            revert InvalidClaimWindow(claimWindow, MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW);
        }

        uint256 feeSnapshot = claimFeeWei;
        address sinkSnapshot = feeSink;
        // Unreachable while `proposeClaimFee` refuses a non-zero fee without a sink and
        // `proposeFeeSink` refuses to unset a sink under a live fee. Kept because the
        // cost of being wrong is fee ETH forwarded to address(0) on every claim.
        if (feeSnapshot != 0 && sinkSnapshot == address(0)) revert FeeSinkUnset();

        uint64 expiresAt = uint64(block.timestamp) + claimWindow;

        distributor = address(
            new TegridyAirdropDistributor(token, merkleRoot, msg.sender, expiresAt, feeSnapshot, sinkSnapshot)
        );

        // Registry before the external token call: a token that re-enters on
        // `transferFrom` finds the registry already consistent, and `nonReentrant`
        // rejects it anyway.
        campaigns.push(distributor);
        isCampaign[distributor] = true;
        _campaignsByCreator[msg.sender].push(distributor);
        _campaignsByToken[token].push(distributor);

        // Measured, not assumed. A fresh CREATE address starts at zero balance, but the
        // delta is read explicitly so the event carries the truth for fee-on-transfer
        // tokens instead of the requested figure.
        uint256 balanceBefore = IERC20(token).balanceOf(distributor);
        IERC20(token).safeTransferFrom(msg.sender, distributor, fundingAmount);
        uint256 funded = IERC20(token).balanceOf(distributor) - balanceBefore;
        // SLITHER 2026-08-30: measured-funding sentinel (FoT-honest delta) under nonReentrant;
        // a pre-funded CREATE address cancels on both sides of the delta, and `funded` feeds
        // only the event — never state, never a transfer
        // slither-disable-next-line incorrect-equality
        if (funded == 0) revert NoFundsReceived();

        emit CampaignCreated(
            distributor, msg.sender, token, merkleRoot, funded, expiresAt, feeSnapshot, sinkSnapshot
        );
    }

    // ─── Fee administration (48h timelock, value-bound execute) ──────

    /// @notice Queue a change to the per-claim fee applied to FUTURE campaigns.
    /// @dev    A non-zero fee requires a wired sink first, so the two-ceremony ordering
    ///         (sink, then fee) is enforced on-chain rather than by runbook discipline.
    function proposeClaimFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_CLAIM_FEE_WEI) revert FeeAboveCap(newFee, MAX_CLAIM_FEE_WEI);
        if (newFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        if (newFee == claimFeeWei) revert ValueUnchanged();
        pendingClaimFeeWei = newFee;
        _propose(CLAIM_FEE_CHANGE, FEE_CHANGE_DELAY);
        emit ClaimFeeChangeProposed(claimFeeWei, newFee, _executeAfter[CLAIM_FEE_CHANGE]);
    }

    /// @param expectedFee Must equal the pending value, binding this execution to the
    ///        proposal that was actually reviewed.
    function executeClaimFee(uint256 expectedFee) external onlyOwner {
        if (expectedFee != pendingClaimFeeWei) revert PendingValueMismatch();
        _execute(CLAIM_FEE_CHANGE);
        // Re-checked at execute time: the sink could have been changed to zero by a
        // separate proposal that landed inside this one's 48h window.
        if (expectedFee != 0 && feeSink == address(0)) revert FeeSinkUnset();
        uint256 old = claimFeeWei;
        claimFeeWei = expectedFee;
        pendingClaimFeeWei = 0;
        emit ClaimFeeChanged(old, expectedFee);
    }

    function cancelClaimFee() external onlyOwner {
        _cancel(CLAIM_FEE_CHANGE);
        pendingClaimFeeWei = 0;
    }

    /// @notice Queue a change to the fee recipient applied to FUTURE campaigns.
    /// @dev    Unsetting the sink while a fee is live is rejected, which keeps the
    ///         invariant "fee non-zero implies sink non-zero" true at every instant.
    function proposeFeeSink(address newSink) external onlyOwner {
        if (newSink == address(0) && claimFeeWei != 0) revert FeeSinkUnset();
        if (newSink == feeSink) revert ValueUnchanged();
        pendingFeeSink = newSink;
        _propose(FEE_SINK_CHANGE, FEE_CHANGE_DELAY);
        emit FeeSinkChangeProposed(feeSink, newSink, _executeAfter[FEE_SINK_CHANGE]);
    }

    function executeFeeSink(address expectedSink) external onlyOwner {
        if (expectedSink != pendingFeeSink) revert PendingValueMismatch();
        _execute(FEE_SINK_CHANGE);
        if (expectedSink == address(0) && claimFeeWei != 0) revert FeeSinkUnset();
        address old = feeSink;
        feeSink = expectedSink;
        pendingFeeSink = address(0);
        emit FeeSinkChanged(old, expectedSink);
    }

    function cancelFeeSink() external onlyOwner {
        _cancel(FEE_SINK_CHANGE);
        pendingFeeSink = address(0);
    }

    // ─── Pause surface ───────────────────────────────────────────────

    /// @notice Stops NEW campaign creation. Existing campaigns are untouched — they hold
    ///         no reference to this contract — so no claim and no reclaim is ever blocked
    ///         by anything an admin here can do.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pause-only emergency role. Cannot unpause, cannot move funds.
    function guardianPause() external onlyPauseGuardian {
        _pause();
    }

    function setPauseGuardian(address newGuardian) external onlyOwner {
        _setPauseGuardian(newGuardian);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    function campaignsOf(address creator) external view returns (address[] memory) {
        return _campaignsByCreator[creator];
    }

    function campaignsForToken(address token) external view returns (address[] memory) {
        return _campaignsByToken[token];
    }

    /// @notice Paginated read over `campaigns`, for indexers that must not risk an
    ///         unbounded return once the registry is large.
    /// @return page   Slice of campaign addresses.
    /// @return next   Offset to pass on the following call, or 0 when the scan is
    ///                complete. A non-zero `next` means the caller is looking at a
    ///                PARTIAL view and must not present it as the whole registry.
    function campaignsSlice(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 next)
    {
        uint256 total = campaigns.length;
        if (offset >= total || limit == 0) return (new address[](0), 0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = campaigns[i];
        }
        // SLITHER 2026-08-30: pagination boundary on a push-only array length — exact-match
        // end-of-list sentinel, no value at stake
        // slither-disable-next-line incorrect-equality
        next = end == total ? 0 : end;
    }

    /// @notice The fee a campaign created in this block would snapshot. A frontend must
    ///         read this immediately before signing `createCampaign` and print it, rather
    ///         than caching a value that a landed proposal may have moved.
    function currentCampaignFee() external view returns (uint256 fee, address sink) {
        return (claimFeeWei, feeSink);
    }
}
