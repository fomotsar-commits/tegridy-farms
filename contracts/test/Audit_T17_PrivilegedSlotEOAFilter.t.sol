// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {TegridyLending} from "../src/TegridyLending.sol";
import {TegridyLendingAdmin} from "../src/TegridyLendingAdmin.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @title  [T17-EOA-TYPE-FILTER] — the last four unfiltered privileged address slots.
///
/// @notice THE CLASS. This repo type-filters privileged address slots against plain EOAs and
///         against 23-byte EIP-7702 delegated EOAs (`0xef0100` + 20-byte delegate). The filter
///         was applied inconsistently, and the earlier sweeps
///         (test/StakingLendingWhitelistEOA_2026_09_05.t.sol for the staking registry,
///         test/Audit_AdminRotationEOA_2026_09_05.t.sol for SwapFeeRouter / ReferralSplitter /
///         CommunityGrants) closed the instances they found. These are the four that survived:
///
///           RevenueDistributor.proposeRestakingChange    : zero-check ONLY
///           RevenueDistributor.executeRestakingChange     : NO check at all
///           TegridyLendingAdmin.proposeAcceptedCollateral : zero-check ONLY
///           TegridyLending.applyAcceptedCollateralChange  : zero-check ONLY
///
/// @notice CONSEQUENCE, per pair.
///
///         `restakingContract` on RevenueDistributor is read through `ITegridyRestaking`
///         high-level calls. A high-level call to a CODELESS address reverts in the CALLER's
///         frame rather than returning empty — so an EOA in that slot is not a
///         misconfiguration that degrades, it is a permanent brick of every path that reads
///         it. This is the identical mechanism already recorded for ReferralSplitter in
///         Audit_AdminRotationEOA_2026_09_05.t.sol.
///
///         `acceptedCollateralContracts` is an ERC721 collateral registry. Every consumer
///         calls it as a contract, so an EOA entry can never be a valid one; admitting one
///         pollutes the registry with an entry that can only fail at use time.
///
/// @notice SEVERITY — HARDENING, NOT A LIVE EXPLOIT. All four writes are owner- or
///         admin-gated behind timelocks, so reaching the bad state requires the privileged
///         key. TegridyLending is additionally NOT DEPLOYED (see
///         reference: TEGRIDY_LENDING_ADDRESS is zeroed in frontend/src/lib/constants.ts),
///         which is precisely why this is worth doing now: a code check on an
///         already-populated registry risks bricking a legitimate live entry, and there is no
///         live entry here to brick. The window shuts on deployment.
///
/// @notice WHAT THIS FILE PINS. Three of these tests are NOT about the new checks at all —
///         they are the regression surface of the DRY extraction. Folding the three verbatim
///         inline copies in TegridyLending (`setLendingAdmin`,
///         `proposeLendingAdminReplacement`, the constructor `sequencerFeed` guard) into one
///         private `_requireContract` turned three independent checks into three call sites
///         on one body. Each is mutation-checked below so a broken fold cannot pass silently.
///
///         The invariant pinned throughout is BEHAVIOURAL — "this address is refused" /
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

    // ════════════════════════════════════════════════════════════════════════
    //  Lending — accepted-collateral registry
    // ════════════════════════════════════════════════════════════════════════

    TegridyLending internal lending;
    TegridyLendingAdmin internal lendingAdmin;
    T17Weth internal weth;

    function _deployLending() internal {
        // chainid 1 so the constructor's sequencer branch no-ops on address(0),
        // matching every existing lending suite.
        vm.chainId(1);
        weth = new T17Weth();
        T17Pair pair = new T17Pair(address(weth), address(new T17Stub()));
        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(new T17Stub()), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));
    }

    function test_lendingAdmin_proposeCollateral_refusesPlainEOA_whenAdding() public {
        _deployLending();
        vm.expectRevert(TegridyLendingAdmin.NotAContract.selector);
        lendingAdmin.proposeAcceptedCollateral(eve, true);
    }

    function test_lendingAdmin_proposeCollateral_refuses7702DelegatedEOA_whenAdding() public {
        _deployLending();
        vm.etch(eve, _delegation());
        vm.expectRevert(TegridyLendingAdmin.NotAContract.selector);
        lendingAdmin.proposeAcceptedCollateral(eve, true);
    }

    function test_lendingAdmin_proposeCollateral_acceptsARealContract_whenAdding() public {
        _deployLending();
        address good = address(new T17Stub());
        lendingAdmin.proposeAcceptedCollateral(good, true);
        assertEq(lendingAdmin.pendingAcceptedCollateral(), good, "a genuine contract must still be proposable");
    }

    /// @dev THE GATE ON THE FLAG, propose side. A REMOVAL must never be blocked by the code
    ///      check. If it were, an entry that lost its code — a revoked 7702 delegation, or a
    ///      SELFDESTRUCTed legacy collateral — would become permanently unremovable, because
    ///      the check would brick the only path that cleans it up. Directly mirrors
    ///      StakingLendingWhitelistEOA_2026_09_05.t.sol's revoke-side test.
    function test_lendingAdmin_removalIsNeverBlockedByTheCodeCheck_evenForACodelessAddress() public {
        _deployLending();
        assertEq(eve.code.length, 0, "precondition: the address to remove has no code");
        lendingAdmin.proposeAcceptedCollateral(eve, false);
        assertEq(lendingAdmin.pendingAcceptedCollateral(), eve, "removal must not be gated on code");
    }

    /// @dev Execute-side recheck on the lending host. Called through the admin sister, which
    ///      is the only `onlyAdmin` caller, so this exercises the real live path rather than
    ///      an impersonated one.
    function test_lending_applyCollateral_refusesAnAddressThatLostItsCodeInsideTheWindow() public {
        _deployLending();
        // Real code at propose time so the admin-side filter passes.
        vm.etch(eve, hex"60016000f3");
        lendingAdmin.proposeAcceptedCollateral(eve, true);

        // Delegation revoked during the timelock.
        vm.etch(eve, hex"");
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);

        vm.expectRevert(TegridyLending.NotAContract.selector);
        lendingAdmin.executeAcceptedCollateral();
    }

    function test_lending_applyCollateral_acceptsARealContractEndToEnd() public {
        _deployLending();
        address good = address(new T17Stub());
        lendingAdmin.proposeAcceptedCollateral(good, true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();
        assertTrue(lending.acceptedCollateralContracts(good), "a genuine contract must still be admitted");
    }

    /// @dev THE GATE ON THE FLAG, execute side. The end-to-end removal of an entry that has
    ///      since lost its code must complete. This is the test that would fail if the check
    ///      were made unconditional, and it is the reason it is not.
    function test_lending_removalIsNeverBlockedByTheCodeCheck_evenAfterTheEntryLosesItsCode() public {
        _deployLending();
        // Admit a genuine contract the normal way.
        address good = address(new T17Stub());
        lendingAdmin.proposeAcceptedCollateral(good, true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();
        assertTrue(lending.acceptedCollateralContracts(good), "precondition: entry is admitted");

        // It then loses its code.
        vm.etch(good, hex"");
        assertEq(good.code.length, 0, "precondition: the admitted entry is now codeless");

        // Removal must still go all the way through, both halves.
        lendingAdmin.proposeAcceptedCollateral(good, false);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();
        assertFalse(lending.acceptedCollateralContracts(good), "a codeless entry must remain removable");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Regression surface of the `_requireContract` DRY extraction
    //  Three previously-inline checks now share one body. Each is pinned.
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Extraction site 1 of 3 — `setLendingAdmin`.
    function test_extraction_setLendingAdmin_stillRefusesEOAAnd7702() public {
        vm.chainId(1);
        weth = new T17Weth();
        T17Pair pair = new T17Pair(address(weth), address(new T17Stub()));
        TegridyLending fresh =
            new TegridyLending(treasury, 500, address(weth), address(pair), address(new T17Stub()), address(0));

        vm.expectRevert(TegridyLending.NotAContract.selector);
        fresh.setLendingAdmin(eve);

        vm.etch(eve, _delegation());
        vm.expectRevert(TegridyLending.NotAContract.selector);
        fresh.setLendingAdmin(eve);

        // Positive control: the slot is still wireable with a real contract.
        TegridyLendingAdmin good = new TegridyLendingAdmin(address(fresh));
        fresh.setLendingAdmin(address(good));
        assertEq(fresh.lendingAdmin(), address(good), "extraction must not break the happy path");
    }

    /// @dev Extraction site 2 of 3 — `proposeLendingAdminReplacement`.
    function test_extraction_proposeLendingAdminReplacement_stillRefusesEOAAnd7702() public {
        _deployLending();

        vm.expectRevert(TegridyLending.NotAContract.selector);
        lending.proposeLendingAdminReplacement(eve);

        vm.etch(eve, _delegation());
        vm.expectRevert(TegridyLending.NotAContract.selector);
        lending.proposeLendingAdminReplacement(eve);

        // Positive control.
        TegridyLendingAdmin good = new TegridyLendingAdmin(address(lending));
        lending.proposeLendingAdminReplacement(address(good));
        assertEq(lending.pendingLendingAdmin(), address(good), "extraction must not break the happy path");
    }

    /// @dev Extraction site 3 of 3 — the constructor's `sequencerFeed` guard. This one lives
    ///      in CREATION code, not runtime, which is exactly why it is worth its own test: a
    ///      fold that compiled fine for the runtime call sites could still have dropped this
    ///      one. Non-mainnet chainid so the feed is required rather than optional.
    function test_extraction_constructorSequencerFeed_stillRefusesEOAAnd7702() public {
        vm.chainId(8453); // Base — an L2, so the feed is mandatory.
        weth = new T17Weth();
        T17Pair pair = new T17Pair(address(weth), address(new T17Stub()));
        address twap = address(new T17Stub());

        vm.expectRevert(TegridyLending.NotAContract.selector);
        new TegridyLending(treasury, 500, address(weth), address(pair), twap, eve);

        vm.etch(eve, _delegation());
        vm.expectRevert(TegridyLending.NotAContract.selector);
        new TegridyLending(treasury, 500, address(weth), address(pair), twap, eve);

        // Positive control: a real feed contract still deploys on the same chainid.
        TegridyLending ok =
            new TegridyLending(treasury, 500, address(weth), address(pair), twap, address(new T17Stub()));
        assertTrue(address(ok) != address(0), "extraction must not break the happy path");
    }
}

// ─── Minimal fixtures ───────────────────────────────────────────────────────

/// @dev Any deployed contract. Used wherever the code under test only needs "this address
///      has code" to be true.
contract T17Stub {
    uint256 public x;
}

contract T17Weth {
    function deposit() external payable {}
    receive() external payable {}
}

/// @dev TegridyLending's constructor reads token0/token1 to snapshot the TOWELI side.
contract T17Pair {
    address public token0;
    address public token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }
}
