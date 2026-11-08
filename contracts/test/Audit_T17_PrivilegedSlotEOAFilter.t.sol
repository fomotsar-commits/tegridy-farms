// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @title  [T17-EOA-TYPE-FILTER] — the last two unfiltered privileged address slots.
///
/// @notice THE CLASS. This repo type-filters privileged address slots against plain EOAs and
///         against 23-byte EIP-7702 delegated EOAs (`0xef0100` + 20-byte delegate). The filter
///         was applied inconsistently, and the earlier sweeps
///         (test/StakingLendingWhitelistEOA_2026_09_05.t.sol for the staking registry,
///         test/Audit_AdminRotationEOA_2026_09_05.t.sol for SwapFeeRouter / ReferralSplitter /
///         CommunityGrants) closed the instances they found. These are the two that survived
///         (a TegridyLending pair did too; it left the repo with that contract on 2026-10-27):
///
///           RevenueDistributor.proposeRestakingChange    : zero-check ONLY
///           RevenueDistributor.executeRestakingChange     : NO check at all
///
/// @notice CONSEQUENCE.
///
///         `restakingContract` on RevenueDistributor is read through `ITegridyRestaking`
///         high-level calls. A high-level call to a CODELESS address reverts in the CALLER's
///         frame rather than returning empty — so an EOA in that slot is not a
///         misconfiguration that degrades, it is a permanent brick of every path that reads
///         it. This is the identical mechanism already recorded for ReferralSplitter in
///         Audit_AdminRotationEOA_2026_09_05.t.sol.
///
/// @notice SEVERITY — HARDENING, NOT A LIVE EXPLOIT. Both writes are owner-gated behind a
///         timelock, so reaching the bad state requires the privileged key.
///
/// @notice The invariant pinned throughout is BEHAVIOURAL — "this address is refused" /
///         "this address is accepted" / "this revert is the timelock's, not the type
///         filter's" — never a function name or a revert string, so a rename cannot red
///         these while the property holds.
contract Audit_T17_PrivilegedSlotEOAFilterTest is Test {
    // ─── Shared fixtures ────────────────────────────────────────────────────

    /// @dev A plain EOA. Never has code unless a test etches some.
    address internal eve = makeAddr("t17_eve");
    address internal treasury = makeAddr("t17_treasury");

    /// @dev The canonical EIP-7702 delegation pointer: `0xef0100` + 20-byte delegate == 23
    ///      bytes. Same construction as StakingLendingWhitelistEOA_2026_09_05.t.sol.
    function _delegation() internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", bytes20(address(0xBEEF)));
    }

    /// @dev The property under test is "code length 23 is refused", not "this particular
    ///      delegate is refused". Assert the fixture really is 23 bytes so a future edit to
    ///      `_delegation()` cannot quietly turn every 7702 test into a duplicate of the
    ///      plain-EOA test.
    function test_fixture_delegationPointerIsExactly23Bytes() public {
        vm.etch(eve, _delegation());
        assertEq(eve.code.length, 23, "7702 fixture must be 23 bytes or the tests below are vacuous");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  RevenueDistributor — restaking slot
    // ════════════════════════════════════════════════════════════════════════

    function _newDistributor() internal returns (RevenueDistributor) {
        // The constructor only zero-checks these three; no restaking path reads them.
        return new RevenueDistributor(address(new T17Stub()), treasury, address(new T17Stub()));
    }

    function test_revenue_proposeRestaking_refusesPlainEOA() public {
        RevenueDistributor dist = _newDistributor();
        vm.expectRevert(RevenueDistributor.NotAContract.selector);
        dist.proposeRestakingChange(eve);
    }

    function test_revenue_proposeRestaking_refuses7702DelegatedEOA() public {
        RevenueDistributor dist = _newDistributor();
        vm.etch(eve, _delegation());
        vm.expectRevert(RevenueDistributor.NotAContract.selector);
        dist.proposeRestakingChange(eve);
    }

    /// @dev The positive control. Without this, a filter that refused EVERYTHING would pass
    ///      every test above.
    function test_revenue_proposeRestaking_acceptsARealContract() public {
        RevenueDistributor dist = _newDistributor();
        address good = address(new T17Stub());
        dist.proposeRestakingChange(good);
        assertEq(dist.pendingRestaking(), good, "a genuine contract must still be proposable");
    }

    /// @dev THE REASON THE EXECUTE-SIDE CHECK EXISTS. A 7702 delegation can be REVOKED inside
    ///      the 48h window, so propose-time validation alone is not sufficient: the address
    ///      that passes at propose time is not necessarily the address that lands in the slot.
    function test_revenue_executeRestaking_refusesAnAddressThatLostItsCodeInsideTheWindow() public {
        RevenueDistributor dist = _newDistributor();
        vm.etch(eve, _delegation());
        // Give it real (non-23-byte) code so the PROPOSE side accepts it...
        vm.etch(eve, hex"60016000f3");
        dist.proposeRestakingChange(eve);

        // ...then revoke the delegation during the timelock.
        vm.etch(eve, hex"");
        vm.warp(vm.getBlockTimestamp() + dist.RESTAKING_CHANGE_DELAY() + 1);

        vm.expectRevert(RevenueDistributor.NotAContract.selector);
        dist.executeRestakingChange();
    }

    function test_revenue_executeRestaking_acceptsAnAddressThatKeptItsCode() public {
        RevenueDistributor dist = _newDistributor();
        address good = address(new T17Stub());
        dist.proposeRestakingChange(good);
        vm.warp(vm.getBlockTimestamp() + dist.RESTAKING_CHANGE_DELAY() + 1);
        dist.executeRestakingChange();
        assertEq(address(dist.restakingContract()), good, "a genuine contract must still execute");
        assertEq(dist.pendingRestaking(), address(0), "pending slot must clear on execute");
    }

    /// @dev THE ORDERING PIN. `executeRestakingChange`'s type check MUST sit BELOW
    ///      `_execute(RESTAKING_CHANGE)`. Hoisted above it, the no-proposal path would read a
    ///      zeroed `pendingRestaking`, measure code length 0, and revert `NotAContract()`
    ///      where the caller is entitled to the typed `NoPendingProposal`. That is a real
    ///      regression in an existing behaviour — Audit195_Revenue.t.sol::test_restaking_cancel
    ///      asserts exactly this revert — so it is pinned here in the file that introduces
    ///      the hazard, not left to a distant suite to catch.
    function test_revenue_cancelThenExecute_stillReportsNoPendingProposal_notNotAContract() public {
        RevenueDistributor dist = _newDistributor();
        address good = address(new T17Stub());
        dist.proposeRestakingChange(good);
        dist.cancelRestakingChange();

        vm.expectRevert(
            abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.RESTAKING_CHANGE())
        );
        dist.executeRestakingChange();
    }

    /// @dev Same ordering property from the other side: a slot that was NEVER proposed must
    ///      also surface the timelock's error, not the type filter's.
    function test_revenue_executeWithNoProposalEver_reportsNoPendingProposal() public {
        RevenueDistributor dist = _newDistributor();
        vm.expectRevert(
            abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.RESTAKING_CHANGE())
        );
        dist.executeRestakingChange();
    }
}

// ─── Minimal fixtures ───────────────────────────────────────────────────────

/// @dev Any deployed contract. Used wherever the code under test only needs "this address
///      has code" to be true.
contract T17Stub {
    uint256 public x;
}
