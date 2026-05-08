// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTLending.sol";

/// @title PASS7-NFTLENDING-01 — `claimStuckCollateral` silently deletes recovery
///        right when the malicious whitelisted collection no-ops the retry.
///
/// @notice The pass-6 LD-NEW-H2 fix added `_safeOutboundTransfer` to detect
///         silent-no-op `transferFrom` on `repayLoan` / `claimDefault` and
///         seeded `stuckCollateralRecipient[loanId] = recipient` so the user
///         could recover via `claimStuckCollateral` once the collection is
///         "fixed". HOWEVER, `claimStuckCollateral` itself does NOT apply the
///         same post-condition check — it issues a raw `transferFrom` and
///         deletes the mapping BEFORE the call. Per CEI, the delete commits if
///         the call returns successfully. A malicious collection that
///         continues to silently no-op `transferFrom` causes:
///           1. recipient calls claimStuckCollateral
///           2. mapping is deleted
///           3. transferFrom returns successfully without moving NFT
///           4. event StuckCollateralClaimed emitted (lying)
///           5. NFT still in lending; recipient's recovery right is GONE
///         All future `claimStuckCollateral` calls revert NoStuckCollateral.
///
///         This is a downstream regression of the LD-NEW-H2 patch surface:
///         the pass-6 fix added the post-condition to the OUT-bound legs of
///         repayLoan / claimDefault but missed the SAME defense on the
///         RECOVERY path that those legs feed into. Severity MEDIUM:
///         requires a malicious whitelisted collection (whitelist is
///         24h-timelocked + admin-controlled, so this requires a
///         compromised admin or a previously-honest collection that was
///         later upgraded to malicious behavior).
///
///         The natural fix mirrors `_safeOutboundTransfer`: post-call
///         `ownerOf` check, and either revert (so the mapping rolls back
///         and recipient can retry) or restore the mapping if the no-op is
///         detected.

contract MockWETH_PASS7_NFTLending {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "weth: bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @dev Persistent silent-no-op ERC721 — every `transferFrom` returns
///      success without moving the token. Mirrors the pass-6 P6_NoOpERC721
///      mock but WITHOUT the arm/disarm switch, modeling the case where
///      the operator never "unfreezes" the collection (i.e. it stays
///      malicious indefinitely).
contract PASS7_NoOpERC721 is ERC721 {
    uint256 private _id = 1;
    bool public outboundNoop; // only no-op outgoing-from-lending transfers

    constructor() ERC721("NoOp", "NOOP") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
    function arm(bool on) external { outboundNoop = on; }

    function transferFrom(address from, address to, uint256 id) public override {
        // Inbound (to lending) succeeds normally so the loan can open.
        // Outbound (from lending) silently no-ops — both for the original
        // settlement transfer AND for the claimStuckCollateral retry.
        if (outboundNoop) {
            return; // silent success, NFT stays at `from`
        }
        super.transferFrom(from, to, id);
    }
}

contract PASS7_NFTLENDING_01_StuckRecoveryNoOpTest is Test {
    MockWETH_PASS7_NFTLending weth;
    PASS7_NoOpERC721 nft;
    TegridyNFTLending lending;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // lender
    address bob = makeAddr("bob");     // borrower (whose NFT gets stuck)

    uint256 bobTokenId;

    function setUp() public {
        vm.warp(1_700_000_000);

        weth = new MockWETH_PASS7_NFTLending();
        nft = new PASS7_NoOpERC721();
        lending = new TegridyNFTLending(treasury, 500, address(weth), address(0));

        // Whitelist the malicious-but-future-discovered NFT collection.
        lending.proposeWhitelistCollection(address(nft));
        skip(25 hours);
        lending.executeWhitelistCollection();

        bobTokenId = nft.mint(bob);
        vm.prank(bob);
        nft.approve(address(lending), bobTokenId);

        vm.deal(alice, 100 ether);
    }

    /// @notice POST-FIX REGRESSION: with the malicious collection still in
    ///         silent-no-op mode at recovery time, `claimStuckCollateral`
    ///         silently deletes Bob's recovery right. The function emits the
    ///         success event, deletes the mapping, returns cleanly — but the
    ///         NFT did NOT move. Bob's subsequent recovery attempts revert
    ///         NoStuckCollateral. Permanent loss of the recovery channel that
    ///         LD-NEW-H2 was designed to provide.
    function test_PASS7_NFTLENDING_01_claimStuckCollateral_silentlyDeletesRecoveryWhenCollectionStillNoOps() public {
        // Open + repay loan.
        vm.prank(alice);
        uint256 offerId = lending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(nft), bobTokenId, uint64(block.timestamp + 30 days)
        );

        vm.prank(bob);
        uint256 loanId = lending.acceptOffer(offerId);
        assertEq(nft.ownerOf(bobTokenId), address(lending), "NFT escrowed at loan open");

        skip(7 days);

        // Arm the silent no-op for the OUTBOUND repay leg.
        nft.arm(true);

        // Bob repays — money flows, but the NFT stays escrowed because
        // `_safeOutboundTransfer` detects the no-op and seeds the recovery map.
        uint256 repay = 1.1 ether;
        vm.deal(bob, repay);
        vm.prank(bob);
        lending.repayLoan{value: repay}(loanId);

        // Sanity — the LD-NEW-H2 fix is intact: stuckCollateralRecipient[loanId] == bob.
        assertEq(
            lending.stuckCollateralRecipient(loanId),
            bob,
            "LD-NEW-H2 sanity: recovery map seeded"
        );
        assertEq(
            nft.ownerOf(bobTokenId),
            address(lending),
            "LD-NEW-H2 sanity: NFT still escrowed at lending"
        );

        // ── PASS7-NFTLENDING-01 FIX VALIDATION ───────────────────────────
        // claimStuckCollateral now wraps the retry in `_safeOutboundTransfer`
        // and reverts `StuckCollateralStillStuck` if the collection still
        // no-ops. The mapping rolls back via tx revert — bob's recovery
        // right is preserved.
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.StuckCollateralStillStuck.selector);
        lending.claimStuckCollateral(loanId);

        // Recovery right preserved.
        assertEq(
            lending.stuckCollateralRecipient(loanId),
            bob,
            "FIX: bob's recovery right preserved across failed retry"
        );

        // Now the collection becomes honest. Bob retries and succeeds.
        nft.arm(false);
        vm.prank(bob);
        lending.claimStuckCollateral(loanId);

        assertEq(nft.ownerOf(bobTokenId), bob, "FIX: bob recovered NFT once collection became honest");
        assertEq(lending.stuckCollateralRecipient(loanId), address(0), "FIX: mapping cleared on success");

        emit log_string("PASS7-NFTLENDING-01 FIX VALIDATED: claimStuckCollateral preserves recovery right on retry-no-op");
    }
}
