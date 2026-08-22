// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleDistributor} from "./vendor/uniswap-merkle-distributor/MerkleDistributor.sol";

/// @title  TegridyAirdropDistributor — one airdrop campaign, deployed by AirdropFactory
/// @notice Merkle-claim distribution. The claim path, the claimed-bitmap, and the leaf
///         encoding are Uniswap's `merkle-distributor` at commit
///         `25a79e8ec8c22076a735b1a675b961c8184e7931`, vendored under
///         `src/vendor/uniswap-merkle-distributor/` and reached here by inheritance so
///         that the vendored bytes are never edited. See that directory's VENDOR.md for
///         the diff-guard command and the GPL-3.0-or-later license note.
///
///         The delta added by this contract is three things and nothing else:
///           1. an expiry after which claims close and the creator — only the creator —
///              can take back what nobody claimed;
///           2. an optional flat per-claim ETH fee, snapshotted immutable at campaign
///              creation from the factory's owner-settable value;
///           3. a single read surface for the scanner and the fact sheets.
///
/// @dev    No owner. No pause. No admin. No proxy. Every parameter is `immutable`, set
///         once by the factory constructor call and never writable again — including by
///         the factory owner, who has no reference to this contract after creation. The
///         only two state-changing entry points are the claim paths and `reclaim`.
///
/// @dev    Deployment-order note: the factory deploys this contract FIRST and funds it
///         SECOND, so between those two calls (same transaction) the contract exists with
///         a zero balance. There is no window an outsider can observe, because both
///         happen inside `AirdropFactory.createCampaign`.
contract TegridyAirdropDistributor is MerkleDistributor, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ──────────────────────────────────────────────────────
    /// @notice The claim window has closed; `reclaim` is the only remaining path.
    error ClaimWindowClosed(uint64 expiresAt);
    /// @notice `reclaim` called while claims are still open.
    error ClaimWindowOpen(uint64 expiresAt);
    /// @notice Only the address that funded the campaign may reclaim.
    error NotCreator();
    /// @notice Reclaim would move zero tokens; reverted so an operator script cannot
    ///         mistake an empty sweep for a successful one.
    error NothingToReclaim();
    /// @notice This campaign carries a non-zero claim fee, so the fee-free `claim`
    ///         entry point is unavailable. Use `claimWithFee`.
    error ClaimFeeRequired(uint256 required);
    /// @notice `msg.value` did not equal the campaign's fee exactly. Exact-value is
    ///         required rather than a minimum so the contract never has to refund
    ///         change to an untrusted claimant.
    error IncorrectClaimFee(uint256 required, uint256 supplied);
    /// @notice The fee sink rejected the forwarded ETH. The whole claim reverts rather
    ///         than letting fee ETH accumulate in a contract that has no sweep path.
    error FeeForwardFailed();

    // ─── Events ──────────────────────────────────────────────────────
    /// @notice Emitted once per successful fee-bearing claim. The vendored `Claimed`
    ///         event still fires alongside this one; indexers keyed on `Claimed`
    ///         continue to work unchanged.
    event ClaimFeePaid(address indexed payer, address indexed sink, uint256 amount);
    /// @notice Emitted when the creator takes back the unclaimed remainder.
    event Reclaimed(address indexed creator, uint256 amount);

    // ─── Immutable campaign parameters ───────────────────────────────

    /// @notice The address that funded this campaign and the sole address that may
    ///         `reclaim`. Never the factory, never the factory owner.
    address public immutable creator;

    /// @notice The factory that deployed this campaign. Recorded for provenance only —
    ///         no call is ever made to it, so a compromised or paused factory cannot
    ///         reach the funds held here.
    address public immutable factory;

    /// @notice Claims are accepted while `block.timestamp < expiresAt`. At exactly
    ///         `expiresAt` the window is closed and `reclaim` opens: the two paths are
    ///         disjoint at every instant, so there is no timestamp at which both a
    ///         claimant and the creator can be paid the same tokens.
    uint64 public immutable expiresAt;

    /// @notice Flat ETH fee per claim, snapshotted from the factory at creation.
    ///         Zero unless the operator has explicitly enabled a fee AND wired a sink.
    /// @dev    Snapshotting is the point: a later fee change on the factory cannot
    ///         re-price a campaign whose claimants have already been told the number.
    uint256 public immutable claimFeeWei;

    /// @notice Where a non-zero `claimFeeWei` is forwarded, snapshotted at creation.
    ///         `address(0)` whenever `claimFeeWei == 0`; the factory refuses to create a
    ///         fee-bearing campaign without a sink.
    address public immutable feeSink;

    /// @param  token_       ERC-20 being distributed.
    /// @param  merkleRoot_  Root over leaves `keccak256(abi.encodePacked(index, account, amount))`.
    /// @param  creator_     Funder; the only address that may reclaim after expiry.
    /// @param  expiresAt_   Instant at which claims close.
    /// @param  claimFeeWei_ Flat per-claim ETH fee, already validated against the
    ///                      factory's hard cap by the caller.
    /// @param  feeSink_     Recipient of the fee; must be non-zero iff the fee is non-zero.
    constructor(
        address token_,
        bytes32 merkleRoot_,
        address creator_,
        uint64 expiresAt_,
        uint256 claimFeeWei_,
        address feeSink_
    ) MerkleDistributor(token_, merkleRoot_) {
        creator = creator_;
        factory = msg.sender;
        expiresAt = expiresAt_;
        claimFeeWei = claimFeeWei_;
        feeSink = feeSink_;
    }

    // ─── Claim paths ─────────────────────────────────────────────────

    /// @notice Fee-free claim. Available only while this campaign's fee is zero, which
    ///         is the default and the only state a campaign can be created in until the
    ///         operator both raises the fee and wires a sink.
    /// @dev    The `nonReentrant` guard is belt-and-braces: the vendored body already
    ///         sets the claimed bit before the transfer, so a re-entrant claimant
    ///         re-entering on an ERC-777-style callback hits `AlreadyClaimed`. The guard
    ///         is kept because it also covers a token whose `transfer` calls back into
    ///         `reclaim`, which the vendored body knows nothing about.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)
        public
        override
        nonReentrant
    {
        uint256 fee = claimFeeWei;
        if (fee != 0) revert ClaimFeeRequired(fee);
        _requireClaimsOpen();
        super.claim(index, account, amount, merkleProof);
    }

    /// @notice Claim while paying the campaign's flat ETH fee. Works for zero-fee
    ///         campaigns too (with `msg.value == 0`), so a frontend can hold one code
    ///         path regardless of whether a fee is live.
    /// @dev    `claim` cannot be made `payable` by override — Solidity forbids widening
    ///         mutability — so the fee-bearing path is a sibling entry point rather than
    ///         an edit to the vendored function.
    /// @param  index       Leaf index.
    /// @param  account     Recipient encoded in the leaf. Tokens always go to `account`,
    ///                     never to `msg.sender`, so a third party may pay the fee and
    ///                     claim on someone's behalf but can never redirect the tokens.
    /// @param  amount      Amount encoded in the leaf.
    /// @param  merkleProof Proof for the leaf.
    function claimWithFee(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)
        external
        payable
        nonReentrant
    {
        uint256 fee = claimFeeWei;
        if (msg.value != fee) revert IncorrectClaimFee(fee, msg.value);
        _requireClaimsOpen();
        super.claim(index, account, amount, merkleProof);
        if (fee != 0) {
            // Forwarded last, after the vendored body has already written the claimed
            // bit and moved the tokens. A sink that reverts fails the whole claim; the
            // alternative — swallowing the failure — would strand ETH in a contract with
            // no sweep path, which is the shape of the ReferralSplitter dust incident.
            (bool ok,) = feeSink.call{value: fee}("");
            if (!ok) revert FeeForwardFailed();
            emit ClaimFeePaid(msg.sender, feeSink, fee);
        }
    }

    // ─── Expiry ──────────────────────────────────────────────────────

    /// @notice After expiry, return everything unclaimed to the creator.
    /// @dev    Sends to `creator`, not to a caller-supplied address, and is callable by
    ///         `creator` alone. There is deliberately no owner path, no factory path and
    ///         no rescue path: the set of addresses that can ever remove tokens from
    ///         this contract is exactly {leaf accounts, creator-after-expiry}.
    /// @return amount Tokens returned.
    function reclaim() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        uint64 deadline = expiresAt;
        if (block.timestamp < deadline) revert ClaimWindowOpen(deadline);
        IERC20 t = IERC20(token);
        amount = t.balanceOf(address(this));
        if (amount == 0) revert NothingToReclaim();
        emit Reclaimed(creator, amount);
        t.safeTransfer(creator, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice Whether claims are currently being accepted.
    function claimsOpen() public view returns (bool) {
        return block.timestamp < expiresAt;
    }

    /// @notice Everything a campaign page, the launch scanner, or a fact sheet needs, in
    ///         one call.
    /// @dev    `remaining` is the live token balance, not a bookkeeping figure, so a
    ///         fee-on-transfer or rebasing token reports its truth rather than the
    ///         number the creator intended to fund. Callers must not present `remaining`
    ///         as "unclaimed allocation" for such tokens.
    struct CampaignInfo {
        address token;
        bytes32 merkleRoot;
        address creator;
        uint64 expiresAt;
        bool claimsOpen;
        uint256 claimFeeWei;
        address feeSink;
        uint256 remaining;
    }

    /// @notice Single-call campaign read surface.
    function campaignInfo() external view returns (CampaignInfo memory) {
        return CampaignInfo({
            token: token,
            merkleRoot: merkleRoot,
            creator: creator,
            expiresAt: expiresAt,
            claimsOpen: claimsOpen(),
            claimFeeWei: claimFeeWei,
            feeSink: feeSink,
            remaining: IERC20(token).balanceOf(address(this))
        });
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _requireClaimsOpen() internal view {
        uint64 deadline = expiresAt;
        if (block.timestamp >= deadline) revert ClaimWindowClosed(deadline);
    }
}
