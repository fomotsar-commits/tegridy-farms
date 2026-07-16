// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TegridyLendingTest, MockJBAC} from "./TegridyLending.t.sol";
import {TegridyLending} from "../src/TegridyLending.sol";

/// @title  TegridyLending_SweepIndexTest — coverage for the 2026-07-16 pre-deploy fix that
///         replaced sweepUnsolicitedNFT's O(lifetime-loans) loans[] scan with the O(1)
///         `collateralEscrowLoanIdPlus1` escrow reverse-index.
/// @notice Inherits the full TegridyLendingTest fixture (collateral == the staking-position
///         NFT `aliceTokenId`; the lending contract's owner == this test contract). Asserts:
///           - the index is set to loanId+1 when escrow is confirmed on acceptOffer,
///           - it is cleared ONLY when the NFT physically leaves (repay AND default),
///           - the sweep guard reads it: blocked for live collateral, allowed for a donation,
///           - and that a cleared index no longer produces a CollateralInUse false-positive.
///         (The prior scan had NO test coverage at all.)
contract TegridyLending_SweepIndexTest is TegridyLendingTest {
    function _index() internal view returns (uint256) {
        return lending.collateralEscrowLoanIdPlus1(address(staking), aliceTokenId);
    }

    function test_escrowIndex_setOnAccept_clearedOnRepay() public {
        uint256 loanId = _createAndAcceptLoan();
        assertEq(_index(), loanId + 1, "index set to loanId+1 on accept");

        // Full-duration repay (mirrors test_repayLoan_interestMath).
        vm.warp(block.timestamp + 30 days);
        uint256 interest = lending.calculateInterest(1 ether, 1000, block.timestamp - 30 days, block.timestamp);
        uint256 totalRepayment = 1 ether + interest;
        vm.deal(alice, totalRepayment + 1 ether);
        vm.prank(alice);
        lending.repayLoan{value: totalRepayment}(loanId);

        assertEq(staking.ownerOf(aliceTokenId), alice, "NFT physically returned to borrower");
        assertEq(_index(), 0, "index cleared once the NFT leaves on repay");
    }

    function test_escrowIndex_clearedOnDefault() public {
        uint256 loanId = _createAndAcceptLoan();
        assertEq(_index(), loanId + 1, "index set on accept");

        vm.warp(block.timestamp + 31 days);
        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        assertEq(staking.ownerOf(aliceTokenId), bob, "collateral seized to lender");
        assertEq(_index(), 0, "index cleared once the NFT leaves on default");
    }

    function test_sweep_revertsWhileCollateralActive() public {
        _createAndAcceptLoan();
        // owner == this test contract; sweeping live collateral must revert CollateralInUse.
        vm.expectRevert(TegridyLending.CollateralInUse.selector);
        lending.sweepUnsolicitedNFT(address(staking), aliceTokenId, treasury);
    }

    function test_sweep_succeedsForUnsolicitedNFT() public {
        // A random NFT donated to the lending contract is NOT registered as collateral
        // (index == 0), so the owner can sweep it back out.
        MockJBAC donated = new MockJBAC();
        uint256 id = donated.mint(address(this));
        donated.transferFrom(address(this), address(lending), id);
        assertEq(donated.ownerOf(id), address(lending), "donated NFT held by lending");

        lending.sweepUnsolicitedNFT(address(donated), id, treasury);
        assertEq(donated.ownerOf(id), treasury, "unsolicited NFT swept to recipient");
    }

    function test_sweep_clearedIndexIsNotAFalsePositive() public {
        // After a full repay the index is cleared, so the sweep guard must NOT report the
        // (now-departed) collateral as CollateralInUse. The NFT is back with alice, so the
        // held-here precheck reverts first with NotHeldByContract — proving the index no
        // longer blocks it.
        uint256 loanId = _createAndAcceptLoan();
        vm.warp(block.timestamp + 30 days);
        uint256 interest = lending.calculateInterest(1 ether, 1000, block.timestamp - 30 days, block.timestamp);
        vm.deal(alice, 1 ether + interest + 1 ether);
        vm.prank(alice);
        lending.repayLoan{value: 1 ether + interest}(loanId);

        vm.expectRevert(TegridyLending.NotHeldByContract.selector);
        lending.sweepUnsolicitedNFT(address(staking), aliceTokenId, treasury);
    }
}
