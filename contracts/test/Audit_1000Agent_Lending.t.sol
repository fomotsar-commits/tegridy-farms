// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol";
import "../src/TegridyNFTLending.sol";
// Named import: TegridyTWAP.sol and TegridyLending.sol both declare `ITegridyPair`,
// so a wildcard import collides (Error 2333).
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

/// @title 1000-agent audit (2026-07-22) — lending-cluster findings L-1, L-2
/// @notice   L-1 — `TegridyNFTLending.setSequencerFeed` lacked the `block.chainid == 1`
///           guard its own constructor (:556) already implies. On mainnet the slot is
///           `address(0)` by design, so a captured owner key kept one free shot at
///           installing a hostile feed that reports "sequencer down", freezing every
///           `SequencerCheck`-gated path with no reset.
///
///           L-2 — the principal min/max window was the only min/max pair on
///           TegridyLending validated ONLY against its own individual bound. Because
///           `MAX_MIN_PRINCIPAL` (1 ether) sits far above `MAX_PRINCIPAL_FLOOR`
///           (0.01 ether), `min = 1 ether` and `max = 0.01 ether` each pass in
///           isolation while leaving the window empty — after the 48h timelock every
///           `createLoanOffer` is unsatisfiable. Captured-admin brick, no funds at
///           risk, recoverable only by a guardian owner-rotation. The APR (:2015) and
///           duration (:2023) siblings already carried the cross-guard.

contract MockWETH1kB is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 1e27);
    }
}

contract MockToweli1kB is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") {
        _mint(msg.sender, 1e27);
    }
}

/// @dev Minimal TegridyPair surface — the TegridyLending constructor reads
///      `token0()`/`token1()` to snapshot which side is TOWELI.
contract MockPair1kB {
    address public token0;
    address public token1;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }
}

contract Audit_1000Agent_Lending is Test {
    TegridyLending internal lending;
    TegridyLendingAdmin internal lendingAdmin;
    TegridyNFTLending internal nftLending;

    MockWETH1kB internal weth;
    MockToweli1kB internal toweli;

    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant CAP_TIMELOCK = 48 hours;

    function setUp() public {
        // Mainnet semantics: a zero sequencer feed only no-ops on chainid 1.
        vm.chainId(1);
        weth = new MockWETH1kB();
        toweli = new MockToweli1kB();
        MockPair1kB pair = new MockPair1kB(address(toweli), address(weth));
        TegridyTWAP twap = new TegridyTWAP(address(this), address(0));

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        nftLending = new TegridyNFTLending(treasury, 500, address(weth), address(0));
    }

    /// @dev Roll past the 48h cap-change timelock. Uses `vm.warp` against a freshly
    ///      read timestamp — `block.timestamp` is CSE'd across cheatcode calls under
    ///      this project's `via_ir = true` build.
    function _rollTimelock() internal {
        vm.warp(vm.getBlockTimestamp() + CAP_TIMELOCK + 1);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  L-1 — TegridyNFTLending.setSequencerFeed mainnet guard
    // ══════════════════════════════════════════════════════════════════════

    function test_L1_nftLending_setSequencerFeed_revertsOnMainnet() public {
        vm.chainId(1);
        address feed = address(new MockPair1kB(address(1), address(2))); // has code
        vm.expectRevert(TegridyNFTLending.SequencerFeedNotOnMainnet.selector);
        nftLending.setSequencerFeed(feed);
        assertEq(nftLending.sequencerFeed(), address(0), "mainnet feed must stay unset");
    }

    /// @dev The legitimate L2 deployment path must still work — the guard is a
    ///      mainnet carve-out, not a removal of the setter.
    function test_L1_nftLending_setSequencerFeed_stillWorksOnL2() public {
        vm.chainId(10); // Optimism
        address feed = address(new MockPair1kB(address(1), address(2)));
        nftLending.setSequencerFeed(feed);
        assertEq(nftLending.sequencerFeed(), feed, "L2 feed wiring broke");

        // One-shot property preserved (second contract deployed BEFORE expectRevert
        // so the cheatcode watches the setter call, not the CREATE).
        address second = address(new MockPair1kB(address(3), address(4)));
        vm.expectRevert(TegridyNFTLending.SequencerFeedAlreadySet.selector);
        nftLending.setSequencerFeed(second);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  L-2 — principal window cross-guard
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Sanity: the defaults the attack starts from.
    function test_L2_defaultWindowIsSane() public view {
        assertEq(lending.minPrincipal(), 0.001 ether, "default minPrincipal");
        assertEq(lending.maxPrincipal(), 1000 ether, "default maxPrincipal");
        assertLt(lending.maxPrincipal(), lending.MAX_PRINCIPAL_CEILING() + 1, "ceiling");
        // The bound asymmetry that makes the attack possible in the first place.
        assertGt(lending.MAX_MIN_PRINCIPAL(), lendingAdmin.MAX_PRINCIPAL_FLOOR(), "asymmetry premise");
    }

    /// @dev Attack order A — squeeze `max` down first, then raise `min` above it.
    ///      The second PROPOSE must now be refused.
    function test_L2_inversion_blocked_maxFirstThenMin() public {
        lendingAdmin.proposeMaxPrincipal(0.01 ether);
        _rollTimelock();
        lendingAdmin.executeMaxPrincipal();
        assertEq(lending.maxPrincipal(), 0.01 ether, "max not applied");

        // `1 ether` passes MAX_MIN_PRINCIPAL in isolation but inverts the window.
        vm.expectRevert(TegridyLendingAdmin.InvalidCapValue.selector);
        lendingAdmin.proposeMinPrincipal(1 ether);
    }

    /// @dev Attack order B — raise `min` first, then squeeze `max` beneath it.
    function test_L2_inversion_blocked_minFirstThenMax() public {
        lendingAdmin.proposeMinPrincipal(1 ether);
        _rollTimelock();
        lendingAdmin.executeMinPrincipalChange();
        assertEq(lending.minPrincipal(), 1 ether, "min not applied");

        vm.expectRevert(TegridyLendingAdmin.InvalidCapValue.selector);
        lendingAdmin.proposeMaxPrincipal(0.01 ether);
    }

    /// @dev THE case the propose-time guard alone cannot catch, and the reason the
    ///      apply-side re-check exists: queue BOTH proposals while the window is
    ///      still wide (each passes its propose-time cross-check against the
    ///      then-current bounds), then execute them in sequence. The second APPLY
    ///      must reject, or the window inverts.
    function test_L2_inversion_blocked_parallelTimelocks() public {
        // Both proposals are individually valid against the default window.
        lendingAdmin.proposeMaxPrincipal(0.01 ether);
        lendingAdmin.proposeMinPrincipal(1 ether);

        _rollTimelock();

        lendingAdmin.executeMaxPrincipal();
        assertEq(lending.maxPrincipal(), 0.01 ether, "max leg applied");

        // Executing the min leg would leave min(1e18) > max(0.01e18).
        vm.expectRevert(TegridyLendingAdmin.InvalidCapValue.selector);
        lendingAdmin.executeMinPrincipalChange();

        assertLe(lending.minPrincipal(), lending.maxPrincipal(), "window inverted");
    }

    /// @dev Mirror of the above with the legs executed in the opposite order.
    function test_L2_inversion_blocked_parallelTimelocks_reverseOrder() public {
        lendingAdmin.proposeMinPrincipal(1 ether);
        lendingAdmin.proposeMaxPrincipal(0.01 ether);

        _rollTimelock();

        lendingAdmin.executeMinPrincipalChange();
        assertEq(lending.minPrincipal(), 1 ether, "min leg applied");

        vm.expectRevert(TegridyLendingAdmin.InvalidCapValue.selector);
        lendingAdmin.executeMaxPrincipal();

        assertLe(lending.minPrincipal(), lending.maxPrincipal(), "window inverted");
    }

    /// @dev NO-REGRESSION: legitimate window moves must still succeed. Operators
    ///      widen the outer bound first, then move the inner one — the same ordering
    ///      the APR and duration pairs have always required.
    function test_L2_legitimateWindowMove_stillWorks() public {
        // Narrow the window to [0.5, 2] ether: raise min inside the existing max,
        // then bring max down to just above it.
        lendingAdmin.proposeMinPrincipal(0.5 ether);
        _rollTimelock();
        lendingAdmin.executeMinPrincipalChange();
        assertEq(lending.minPrincipal(), 0.5 ether, "min move rejected");

        lendingAdmin.proposeMaxPrincipal(2 ether);
        _rollTimelock();
        lendingAdmin.executeMaxPrincipal();
        assertEq(lending.maxPrincipal(), 2 ether, "max move rejected");

        assertLe(lending.minPrincipal(), lending.maxPrincipal(), "window must stay ordered");
    }

    /// @dev An equal min == max window is degenerate but not inverted, and the
    ///      guards use `>` / `<` — confirm the boundary is admitted rather than
    ///      accidentally over-rejected.
    function test_L2_equalBoundsAllowed() public {
        lendingAdmin.proposeMaxPrincipal(1 ether);
        _rollTimelock();
        lendingAdmin.executeMaxPrincipal();

        lendingAdmin.proposeMinPrincipal(1 ether);
        _rollTimelock();
        lendingAdmin.executeMinPrincipalChange();

        assertEq(lending.minPrincipal(), lending.maxPrincipal(), "equal bounds rejected");
    }
}
