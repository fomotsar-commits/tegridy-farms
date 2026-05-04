// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTLending.sol";

/// @title PASS7-NFTLENDING-02 — `cancelRemoveCollection` rate-limit lacks the
///        FRESH-EYES L "still-live" carve-out, allowing expired-cycle cancel
///        spam to permanently brick legitimate removal of a flagged collection.
///
/// @notice The pass-6 polish doc on TegridyLending's
///         `cancelAcceptedCollateral` (FRESH-EYES L) explicitly documents:
///
///           "only count toward the cancel budget when cancelling a STILL-LIVE
///            proposal. Without this carve-out, a captured admin can
///            `propose → wait for expiry → cancel` 3 times to consume the
///            COLLATERAL_REMOVAL_MAX_CANCELLATIONS budget on a flagged
///            collection without ever cancelling a live removal — bricking
///            legitimate future cancels."
///
///         The carve-out was applied to TegridyLending.cancelAcceptedCollateral
///         (TegridyLending.sol:1817-1826) but NOT to TegridyNFTLending.
///         cancelRemoveCollection (TegridyNFTLending.sol:996-1011) — the latter
///         counts EVERY cancel against the budget, including cancels of
///         already-expired proposals.
///
///         Attack scenario:
///           1. A flagged collection (e.g., a rugged NFT collection or a
///              compromised one) needs to be removed from the whitelist.
///           2. Admin proposes removal. 24h timelock elapses, then the 7-day
///              proposal-validity window. If admin doesn't execute (e.g.,
///              forgets, multisig coordination delay), the proposal expires.
///           3. Admin cancels (mandatory before re-proposing). retryCount += 1.
///           4. Repeat steps 2-3 twice more. retryCount reaches 3 = MAX.
///           5. Now `cancelRemoveCollection` reverts RemovalCancelLimitReached
///              for ANY future call — and `proposeRemoveCollection` reverts
///              because `_executeAfter[WHITELIST_REMOVE]` may still hold a
///              pending value (which itself can't be cancelled).
///         The flagged collection is permanently unremovable from the
///         whitelist. Borrowers can keep opening new loans against it (offers
///         created BEFORE proposeRemoveCollection are not blocked, only
///         offers WHILE pending block).
///
///         Severity: MEDIUM. The threat profile mirrors what the FRESH-EYES L
///         carve-out on TegridyLending was specifically designed to defend
///         against — captured admin OR coordination-delay leading to a
///         permanently blocked governance lever on a flagged collection. The
///         NFTLending side is the more critical of the two: the JBAC /
///         Nakamigos / GNSS collections are already auto-whitelisted in the
///         constructor, so the entire whitelist's manageability depends on
///         this path.

contract MockWETH_PASS7_NFTL_02 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract MockERC721_PASS7_NFTL_02 is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("M", "M") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract PASS7_NFTLENDING_02_RemovalRetryDosTest is Test {
    MockWETH_PASS7_NFTL_02 weth;
    MockERC721_PASS7_NFTL_02 nft;
    TegridyNFTLending lending;

    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockWETH_PASS7_NFTL_02();
        nft = new MockERC721_PASS7_NFTL_02();
        lending = new TegridyNFTLending(treasury, 500, address(weth));

        // Whitelist the collection we want to later remove.
        lending.proposeWhitelistCollection(address(nft));
        skip(25 hours);
        lending.executeWhitelistCollection();
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-NFTLENDING-02 fix —
    ///         NFTLending.cancelRemoveCollection now mirrors TegridyLending's
    ///         FRESH-EYES L still-live carve-out. Cancels of EXPIRED proposals
    ///         no longer charge the retry budget, so the propose → expire →
    ///         cancel cycle can be repeated indefinitely without bricking the
    ///         removal path.
    function test_PASS7_NFTLENDING_02_expiredProposalCyclesExhaustRetryBudget() public {
        // ── Run the same 3-cycle attack from pre-fix; budget should NOT charge ──
        lending.proposeRemoveCollection(address(nft));
        skip(8 days + 1 hours);
        lending.cancelRemoveCollection();
        assertEq(lending.removalRetryCount(address(nft)), 0, "cycle 1: expired-cancel must not charge budget");

        lending.proposeRemoveCollection(address(nft));
        skip(8 days + 1 hours);
        lending.cancelRemoveCollection();
        assertEq(lending.removalRetryCount(address(nft)), 0, "cycle 2: expired-cancel must not charge budget");

        lending.proposeRemoveCollection(address(nft));
        skip(8 days + 1 hours);
        lending.cancelRemoveCollection();
        assertEq(lending.removalRetryCount(address(nft)), 0, "cycle 3: expired-cancel must not charge budget");

        // ── Fourth propose + immediate cancel-while-live SHOULD charge budget ──
        lending.proposeRemoveCollection(address(nft));
        // Don't skip — proposal still live within readyAt window.
        lending.cancelRemoveCollection();
        assertEq(lending.removalRetryCount(address(nft)), 1, "cycle 4: live-cancel charges budget");

        // ── Path is recoverable: re-propose + cancel-while-live still works ──
        // (we're at retry=1, well below the limit of 3, so this is fine)
        lending.proposeRemoveCollection(address(nft));
        skip(25 hours); // past timelock — could now execute, but cancel instead to test
        lending.cancelRemoveCollection();
        assertEq(lending.removalRetryCount(address(nft)), 2, "cycle 5: live-cancel charges budget");

        // The flagged collection can ALWAYS be removed eventually — admin
        // simply needs to execute within the live window. Mirror parity with
        // TegridyLending FRESH-EYES L (TegridyLending.sol:1817-1826) achieved.
    }
}
