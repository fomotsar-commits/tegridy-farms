// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ============================================================================
// FINAL AUDIT: POL Accumulator + Premium Access (post-R022 / R015 / M-P02)
//
// SCOPE NOTE: The original .broken file also covered TegridyFeeHook (Findings
// 6 + 11). Those tests were a heavy v4-hook integration scaffold that
// duplicated the dedicated `R031_TegridyFeeHook` suite without adding new
// coverage. They have been DELETED here — the hook layer is exercised by
// the canonical R031 suite. This file focuses on POL + Premium findings
// only.
// ============================================================================

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockToweliFinal is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockJBACFinal is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract MockLPFinal is ERC20 {
    constructor() ERC20("LP", "LP") { _mint(msg.sender, 1_000_000 ether); }
}

contract MockFactoryFinal {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract MockRouterFinal {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    MockToweliFinal public immutable toweli;

    constructor(address _weth, address _factory, address _toweli) {
        wethAddr = _weth;
        factoryAddr = _factory;
        toweli = MockToweliFinal(_toweli);
    }

    function WETH() external view returns (address) { return wethAddr; }
    function factory() external view returns (address) { return factoryAddr; }

    function swapExactETHForTokens(
        uint256, address[] calldata, address to, uint256
    ) external payable returns (uint256[] memory amounts) {
        uint256 tokensOut = msg.value * 1000;
        toweli.mint(to, tokensOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokensOut;
    }

    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256, uint256, address, uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = msg.value;
    }

    receive() external payable {}
}

contract MockTWAPFinal {
    uint32 public latestTs;
    uint256 public consultReturn = 1;

    function setLatestTimestamp(uint32 _ts) external { latestTs = _ts; }
    function setConsultReturn(uint256 _v) external { consultReturn = _v; }

    function consult(address, address, uint256, uint256) external view returns (uint256) {
        return consultReturn;
    }

    function getLatestObservation(address) external view returns (ITegridyTWAP.Observation memory) {
        return ITegridyTWAP.Observation({
            timestamp: latestTs,
            bypassed: false,
            price0Cumulative: 0,
            price1Cumulative: 0
        });
    }

    /// @notice PASS7-POL-02 FIX: mock returns 0 (no bypass observed).
    function lastBypassUsed(address) external pure returns (uint256) { return 0; }
}

// ============================================================================
// TEST CONTRACT
// ============================================================================

contract FinalAuditPOLPremium is Test {
    // ─── POL ─────────────────────────────────────
    POLAccumulator public pol;
    MockToweliFinal public toweli;
    MockRouterFinal public router;
    MockFactoryFinal public factory;
    MockLPFinal public lp;
    MockTWAPFinal public twap;
    address public treasury = makeAddr("treasury");

    // ─── Premium ─────────────────────────────────
    PremiumAccess public premium;
    MockJBACFinal public nft;
    address public premTreasury = makeAddr("premTreasury");
    uint256 public constant MONTHLY_FEE = 1000 ether;

    // ─── Actors ──────────────────────────────────
    address public owner;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public attacker = makeAddr("attacker");

    function setUp() public {
        // FRESH-2026 TEST REALIGN: feed=address(0) only no-ops on chainid==1 now;
        // mainnet for sequencer no-op path.
        vm.chainId(1);
        // Stable baseline well past 0 so SNAPSHOT_LOOKBACK / cooldown math works.
        // Use absolute target timestamps to avoid via_ir's aggressive caching of
        // block.timestamp across vm.warp boundaries within a single function.
        uint256 t0 = 30 days;
        vm.warp(t0);
        owner = address(this);

        // POL setup
        toweli = new MockToweliFinal();
        lp = new MockLPFinal();
        factory = new MockFactoryFinal();
        router = new MockRouterFinal(makeAddr("WETH"), address(factory), address(toweli));
        factory.setPair(address(lp));
        twap = new MockTWAPFinal();

        pol = new POLAccumulator(
            address(toweli), address(router), address(lp),
            treasury, address(twap), address(0)
        );

        // Premium setup
        nft = new MockJBACFinal();
        premium = new PremiumAccess(address(toweli), address(nft), premTreasury, MONTHLY_FEE);

        // Past accumulate cooldown.
        uint256 t1 = t0 + 8 days;
        vm.warp(t1);
        twap.setLatestTimestamp(uint32(t1));

        // Fund users
        toweli.transfer(alice, 500_000 ether);
        toweli.transfer(bob, 500_000 ether);
        toweli.transfer(attacker, 500_000 ether);

        vm.prank(alice);
        toweli.approve(address(premium), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(premium), type(uint256).max);
        vm.prank(attacker);
        toweli.approve(address(premium), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 1: POL maxAccumulateAmount cap — verify cooldown blocks
    //            multi-call same-block bypass.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding1_accumulateCapBypassMultipleCalls() public {
        vm.deal(address(pol), 50 ether);
        _doAccumulate();

        // Second call in same block reverts on the 1h ACCUMULATE_COOLDOWN.
        vm.expectRevert("ACCUMULATE_COOLDOWN");
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);

        // Only 10 ETH consumed (default cap).
        assertEq(address(pol).balance, 40 ether, "Cooldown prevents same-block multi-call");
        assertEq(pol.totalAccumulations(), 1);

        // With proper cooldown spacing, multiple calls succeed sequentially.
        // Each call uses an external `_doAccumulateAfterCooldown` which forces
        // a fresh `block.timestamp` read (via_ir caches block.timestamp within a
        // single function — splitting into externalcalls breaks the cache).
        this._doAccumulateAfterCooldown();
        this._doAccumulateAfterCooldown();
        this._doAccumulateAfterCooldown();
        assertEq(pol.totalAccumulations(), 4);
    }

    function _doAccumulate() internal {
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);
    }

    /// @notice external (called via `this.`) so via_ir does NOT cache
    ///         block.timestamp across consecutive calls in the parent test body.
    function _doAccumulateAfterCooldown() public {
        vm.warp(block.timestamp + 1 hours + 1);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 2: POL sweepTokens routes to treasury (M-P02 timelocked).
    // ═══════════════════════════════════════════════════════════════════

    function test_finding2_sweepTokensGoesToTreasury() public {
        toweli.transfer(address(pol), 1000 ether);

        address currentOwner = pol.owner();
        uint256 ownerBefore = toweli.balanceOf(currentOwner);
        uint256 treasuryBefore = toweli.balanceOf(treasury);

        // M-P02: must go through 48h timelock.
        pol.proposeSweepTokens(address(toweli));
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepTokens();

        assertEq(toweli.balanceOf(currentOwner) - ownerBefore, 0, "Owner got nothing");
        assertEq(toweli.balanceOf(treasury) - treasuryBefore, 1000 ether, "Tokens to treasury");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 3: POL sweepETH sequential drain — informational. Each
    //            sweep is 48h-timelocked and capped at proposed amount.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding3_sweepETHSequentialDrain() public {
        vm.deal(address(pol), 30 ether);

        this._sweepRound();
        assertEq(address(pol).balance, 20 ether);

        this._sweepRound();
        assertEq(address(pol).balance, 10 ether);

        this._sweepRound();
        assertEq(address(pol).balance, 0 ether);

        assertEq(treasury.balance, 30 ether, "All ETH to treasury via 3 timelocked rounds");
    }

    /// @notice external (`this.`) so via_ir does not cache block.timestamp.
    function _sweepRound() public {
        pol.proposeSweepETH(10 ether);
        vm.warp(block.timestamp + 48 hours);
        pol.executeSweepETH();
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 4: Premium totalRevenue accounting on extension (R022).
    //            Post-R022, extending forfeits the OLD escrow's unconsumed
    //            remainder INTO totalRevenue and adds the new cost.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding4_totalRevenueOnExtension_R022() public {
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);
        assertEq(premium.totalRevenue(), 1000 ether, "Initial sub revenue");

        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        premium.subscribe(1, 1000 ether);

        // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): PASS5-PA-L1 — extension no
        // longer adds `consumedEscrow` to totalRevenue. The original 1000 ether
        // cost was already booked at first-subscribe; the M-06 "forfeit add" was
        // a double-count. Post-fix trajectory: 1000 (initial) + 1000 (extension
        // new cost) = 2000 ether exactly.
        assertEq(premium.totalRevenue(), 2000 ether,
            "PASS5-PA-L1: extension only adds new cost - no consumedEscrow double-count");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 5: Premium withdrawToTreasury locks until reconcile.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding5_withdrawLockedWithoutReconciliation() public {
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);
        vm.prank(bob);
        premium.subscribe(1, 1000 ether);

        vm.warp(block.timestamp + 31 days);

        uint256 escrowBefore = premium.totalRefundEscrow();
        assertEq(escrowBefore, 2000 ether, "Inflated escrow before reconcile");

        uint256 contractBalance = toweli.balanceOf(address(premium));
        uint256 withdrawable = contractBalance > escrowBefore ? contractBalance - escrowBefore : 0;
        assertEq(withdrawable, 0, "Zero withdrawable until reconcile");

        premium.reconcileExpired(alice);
        premium.reconcileExpired(bob);
        assertEq(premium.totalRefundEscrow(), 0, "Escrow cleared after reconciliation");

        uint256 treasuryBefore = toweli.balanceOf(premTreasury);
        premium.withdrawToTreasury();
        assertEq(toweli.balanceOf(premTreasury) - treasuryBefore, 2000 ether, "Treasury received funds");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 7: Premium NFT 15s activation delay — enforced.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding7_nftActivationDelay() public {
        nft.mint(attacker);

        vm.prank(attacker);
        premium.activateNFTPremium();
        uint256 activationTime = block.timestamp;

        vm.warp(activationTime + 14);
        assertFalse(premium.hasPremium(attacker), "No premium within 15s delay");

        vm.warp(activationTime + 16);
        assertTrue(premium.hasPremium(attacker), "Premium available after 15s");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 8: POL backstop=0 / below-MIN rejected (M-7).
    // ═══════════════════════════════════════════════════════════════════

    function test_finding8_backstopZeroAndBelowMinRejected() public {
        // M-7: MIN_BACKSTOP_BPS = 9000.
        vm.expectRevert("BACKSTOP_TOO_LOW");
        pol.proposeBackstopChange(0);

        vm.expectRevert("BACKSTOP_TOO_LOW");
        pol.proposeBackstopChange(8999);

        // Minimum allowed at exactly 9000.
        pol.proposeBackstopChange(9000);
        vm.warp(block.timestamp + 24 hours);
        pol.executeBackstopChange();
        assertEq(pol.backstopBps(), 9000);

        vm.deal(address(pol), 2 ether);
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);
        assertEq(pol.totalAccumulations(), 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 9: deploy script ownership transfer race condition —
    //            documentation only; no runtime vulnerability.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding9_deployOwnershipTimelockRace() public pure {
        // Documented operational concern. Mitigation guidance is in NEXT_STEPS docs.
        assertTrue(true, "Deploy script race is operational concern, not exploit");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 12: POL totalETHUsed accounting — correct (mock router uses
    //             all ETH; production V2 router refunds excess via return).
    // ═══════════════════════════════════════════════════════════════════

    function test_finding12_totalETHUsedAccounting() public {
        vm.deal(address(pol), 2 ether);

        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);

        // halfETH=1 + ethUsed=1 = 2 in mock; production caps at the actual return value.
        assertEq(pol.totalETHUsed(), 2 ether);
    }
}
