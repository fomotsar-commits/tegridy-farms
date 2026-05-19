// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ═══════════════════════════════════════════════════════════════════════
// SCOPE NOTE: The original .broken file also contained ~7 TegridyFeeHook
// red-team tests (ATTACKs 9, 9b, 9c, 10, 11, 11b, 12, 18). Those tests
// duplicated coverage in the dedicated R031_TegridyFeeHook suite without
// adding new threat vectors and required heavy v4-hook deployment
// scaffolding. They have been DELETED. This file focuses on POL +
// Premium red-team coverage that is unique to this suite.
//
// Also DELETED:
//  - ATTACK 7 (totalRevenue inflation): the underlying behavior changed
//    after R022 — the metric is no longer "inflatable" by cancel/resub
//    cycles in the way the test described, and the new accounting is
//    already covered by PremiumAccess.t.sol regression tests.
//  - ATTACK 13 (subscribe+cancel same block): now blocked by
//    MIN_HOLDING_PERIOD = 1 day. Coverage retained in
//    Audit195_PremiumHook.test_P03_sameBlockCancelBlocked.
//  - ATTACK 4b (sweep balance dropped): redundant with the cap-at-balance
//    test already in Audit195_POL.
// ═══════════════════════════════════════════════════════════════════════

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockToweliRT is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockJBACRT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] —
///      added getReserves/token0 surface.
contract MockLPRT is ERC20 {
    address public token0;
    uint112 public r0 = 1 ether;
    uint112 public r1 = 1 ether;
    uint32 public ts;
    constructor() ERC20("LP", "LP") {
        _mint(msg.sender, 1_000_000 ether);
        ts = uint32(block.timestamp);
    }
    function setToken0(address _t0) external { token0 = _t0; }
    function setReserves(uint112 _r0, uint112 _r1) external {
        r0 = _r0;
        r1 = _r1;
        ts = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, ts);
    }
}

contract MockFactoryRT {
    address public pair;
    function setPair(address _pair) external { pair = _pair; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract MockRouterRT {
    address public immutable wethAddr;
    address public immutable factoryAddr;
    MockToweliRT public immutable toweli;

    constructor(address _weth, address _factory, address _toweli) {
        wethAddr = _weth;
        factoryAddr = _factory;
        toweli = MockToweliRT(_toweli);
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

contract MockTWAPRT {
    uint32 public latestTs;
    function setLatestTimestamp(uint32 _ts) external { latestTs = _ts; }
    /// @dev AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] —
    ///      match MockLPRT's symmetric reserves so the deviation gate passes.
    function consult(address, address, uint256, uint256) external pure returns (uint256) { return 1 ether; }
    function getLatestObservation(address) external view returns (ITegridyTWAP.Observation memory) {
        return ITegridyTWAP.Observation({
            timestamp: latestTs,
            bypassed: false,
            price0Cumulative: 0,
            price1Cumulative: 0
        });
    }
    function lastBypassUsed(address) external pure returns (uint256) { return 0; }
}

/// @dev Contract that tries to call accumulate() — used to verify the post-
///      H-05 contract-caller path (tx.origin restriction was lifted).
contract AccumulateProxy {
    POLAccumulator public target;
    constructor(POLAccumulator _target) { target = _target; }
    function proxyAccumulate(uint256 _minTokens, uint256 _minLP, uint256 _minETH, uint256 _deadline) external {
        target.accumulate(_minTokens, _minLP, _minETH, _deadline);
    }
}

/// @dev Flash-loan NFT borrow attacker.
contract FlashBorrowerNFT {
    PremiumAccess public premium;
    MockJBACRT public nft;

    constructor(PremiumAccess _premium, MockJBACRT _nft) {
        premium = _premium;
        nft = _nft;
    }

    function attack(uint256 tokenId) external {
        premium.activateNFTPremium();
        bool hasPrem = premium.hasPremium(address(this));
        require(!hasPrem, "EXPLOIT: got premium in same tx!");
        nft.transferFrom(address(this), msg.sender, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// RED TEAM TEST SUITE
// ═══════════════════════════════════════════════════════════════════════

contract RedTeamPOLPremium is Test {
    POLAccumulator public pol;
    MockToweliRT public toweli;
    MockRouterRT public router;
    MockFactoryRT public factory;
    MockLPRT public lp;
    MockTWAPRT public twap;
    address public treasuryAddr = makeAddr("treasury");

    PremiumAccess public premium;
    MockJBACRT public nft;
    address public premTreasury = makeAddr("premTreasury");
    uint256 public constant MONTHLY_FEE = 1000 ether;

    address public owner;
    address public attacker = makeAddr("attacker");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerFeedNotConfigured guard now reverts
        // when feed=address(0) on chainid != 1. Set mainnet chainid for no-op path.
        vm.chainId(1);
        vm.warp(30 days);
        owner = address(this);

        // POL Accumulator setup
        toweli = new MockToweliRT();
        lp = new MockLPRT();
        factory = new MockFactoryRT();
        router = new MockRouterRT(makeAddr("WETH"), address(factory), address(toweli));
        factory.setPair(address(lp));
        // AUDIT FIX FRESH-2026: POL-ACCUMULATE-SPOT-TWAP-DEVIATION [HIGH] — wire token0.
        lp.setToken0(address(toweli));
        twap = new MockTWAPRT();
        twap.setLatestTimestamp(uint32(block.timestamp));

        pol = new POLAccumulator(
            address(toweli), address(router), address(lp),
            treasuryAddr, address(twap), address(0)
        );

        // Premium Access setup
        nft = new MockJBACRT();
        premium = new PremiumAccess(address(toweli), address(nft), premTreasury, MONTHLY_FEE);

        toweli.transfer(alice, 500_000 ether);
        toweli.transfer(bob, 500_000 ether);
        toweli.transfer(attacker, 500_000 ether);

        vm.prank(alice);
        toweli.approve(address(premium), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(premium), type(uint256).max);
        vm.prank(attacker);
        toweli.approve(address(premium), type(uint256).max);

        // Past accumulate cooldown.
        vm.warp(block.timestamp + 8 days);
        twap.setLatestTimestamp(uint32(block.timestamp));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 1: sweepTokens dust extraction now timelocked + treasury-only.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack1_sweepTokensDust() public {
        address eoa = makeAddr("eoa_owner");
        pol.transferOwnership(eoa);
        vm.prank(eoa);
        pol.acceptOwnership();

        vm.deal(address(pol), 2 ether);
        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.prank(eoa);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);

        uint256 dustBefore = toweli.balanceOf(address(pol));
        if (dustBefore > 0) {
            // M-P02: sweepTokens is now 48h timelocked, recipient is treasury.
            uint256 ownerBefore = toweli.balanceOf(eoa);
            vm.prank(eoa);
            pol.proposeSweepTokens(address(toweli));
            vm.warp(block.timestamp + 48 hours);
            vm.prank(eoa);
            pol.executeSweepTokens();

            assertEq(toweli.balanceOf(eoa), ownerBefore, "Owner extracted nothing");
            assertEq(toweli.balanceOf(treasuryAddr), dustBefore, "Dust to treasury");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 2: Contract-caller path — onlyOwner is the gate (tx.origin lifted).
    // ═══════════════════════════════════════════════════════════════════

    function test_attack2_contractCallerPath() public {
        vm.deal(address(pol), 2 ether);
        AccumulateProxy proxy = new AccumulateProxy(pol);

        // Proxy is not owner → onlyOwner blocks.
        vm.prank(attacker);
        vm.expectRevert();
        proxy.proxyAccumulate(1, 0, 0, block.timestamp + 30 seconds);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 3: maxAccumulateAmount cap limits per-tx exposure.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack3_exploitAccumulateCap() public {
        vm.deal(address(pol), 20 ether);

        vm.warp(block.timestamp + 1 hours);
        twap.setLatestTimestamp(uint32(block.timestamp));
        vm.prank(owner);
        pol.accumulate(1, 0, 0, block.timestamp + 30 seconds);

        uint256 remaining = address(pol).balance;
        // 10 ETH remains. Owner can propose sweep but only one at a time.
        pol.proposeSweepETH(remaining);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.SWEEP_ETH_CHANGE()));
        pol.proposeSweepETH(1 ether);

        assertTrue(remaining > 0, "Excess ETH safe behind 48h timelock");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 4: sweepETH amount lock — proposed amount is honored.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack4_sweepETHAmountLock() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(5 ether);

        // More ETH arrives.
        vm.deal(address(pol), 15 ether);

        vm.warp(block.timestamp + 48 hours);

        vm.deal(treasuryAddr, 0);
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 5 ether, "Only proposed amount swept");
        assertEq(address(pol).balance, 10 ether, "10 ETH retained");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 5: Flash-borrow NFT premium blocked by 15s activation delay.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack5_flashLoanNFTPremium() public {
        nft.mint(alice);
        FlashBorrowerNFT borrower = new FlashBorrowerNFT(premium, nft);

        vm.prank(alice);
        nft.transferFrom(alice, address(borrower), 1);

        borrower.attack(1);

        bool hasPrem = premium.hasPremium(address(borrower));
        assertFalse(hasPrem, "15s delay blocks same-block flash-loan");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 5b: Stale activation → flash-borrow window between 15s and 10min.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack5b_staleActivationExploit() public {
        uint256 tokenId = nft.mint(attacker);

        vm.prank(attacker);
        premium.activateNFTPremium();

        vm.warp(block.timestamp + 20 seconds);

        vm.prank(attacker);
        nft.transferFrom(attacker, alice, tokenId);

        // No premium without NFT.
        bool hasPrem = premium.hasPremium(attacker);
        assertFalse(hasPrem, "No premium without NFT");

        // Flash-borrow back: stale activation persists, premium granted.
        vm.prank(alice);
        nft.transferFrom(alice, attacker, tokenId);

        hasPrem = premium.hasPremium(attacker);
        assertTrue(hasPrem, "Stale activation grants premium");

        // Sell again, wait > 10min, deactivate, then flash-borrow won't help.
        vm.prank(attacker);
        nft.transferFrom(attacker, alice, tokenId);
        vm.warp(block.timestamp + 11 minutes);
        premium.deactivateNFTPremium(attacker);

        vm.prank(alice);
        nft.transferFrom(alice, attacker, tokenId);
        hasPrem = premium.hasPremium(attacker);
        assertFalse(hasPrem, "Post-deactivate, fresh activation needed");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 6: Deactivation griefing — 10min grace protects short transfers.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack6_deactivationGriefing() public {
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // Read the activation timestamp from the contract directly so we are
        // not relying on a compiler-cached `block.timestamp` snapshot in the
        // test contract (via_ir aggressively caches block.timestamp across
        // statements, even past external `vm.warp` calls).
        uint256 activatedAt = premium.nftActivationBlock(alice);

        // Wait 20s, premium active.
        this._warp20s();
        assertTrue(premium.hasPremium(alice));

        // Marketplace listing simulation.
        address marketplace = makeAddr("marketplace");
        vm.prank(alice);
        nft.transferFrom(alice, marketplace, 1);

        // Within 10min grace, deactivate is no-op.
        premium.deactivateNFTPremium(alice);
        assertEq(premium.nftActivationBlock(alice), activatedAt, "Grace protects");

        // Past grace.
        this._warp11min();
        premium.deactivateNFTPremium(alice);
        assertEq(premium.nftActivationBlock(alice), 0, "Cleared past grace");
    }

    function _warp20s() public { vm.warp(block.timestamp + 20 seconds); }
    function _warp11min() public { vm.warp(block.timestamp + 11 minutes); }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8: Cross-user escrow theft blocked by per-user isolation.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8_stealRefundEscrow() public {
        vm.prank(alice);
        premium.subscribe(12, type(uint256).max);

        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        uint256 totalEscrow = premium.totalRefundEscrow();
        assertEq(totalEscrow, 13 * MONTHLY_FEE);

        // R014 MIN_HOLDING_PERIOD = 1d.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        premium.cancelSubscription();

        uint256 bobEscrow = premium.userEscrow(bob);
        assertEq(bobEscrow, MONTHLY_FEE, "Bob escrow untouched");

        vm.prank(bob);
        premium.cancelSubscription();

        uint256 bobRefund = toweli.balanceOf(bob) - (500_000 ether - MONTHLY_FEE);
        assertTrue(bobRefund > 0, "Bob got refund");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8b: withdrawToTreasury respects totalRefundEscrow.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8b_withdrawDrainsEscrow() public {
        vm.prank(alice);
        premium.subscribe(6, type(uint256).max);

        uint256 escrow = premium.totalRefundEscrow();

        premium.withdrawToTreasury();

        uint256 afterBal = toweli.balanceOf(address(premium));
        assertTrue(afterBal >= escrow, "Contract retains escrow");

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        premium.cancelSubscription();

        uint256 aliceRefund = toweli.balanceOf(alice) - (500_000 ether - 6 * MONTHLY_FEE);
        assertTrue(aliceRefund > 0, "Alice still gets refund post-withdrawal");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8c: totalRefundEscrow desync fixable via reconcileExpired.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8c_escrowDesync() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        assertEq(premium.totalRefundEscrow(), 2 * MONTHLY_FEE);

        vm.warp(block.timestamp + 31 days);

        assertEq(premium.totalRefundEscrow(), 2 * MONTHLY_FEE, "Stale until reconciled");
        uint256 contractBal = toweli.balanceOf(address(premium));
        uint256 withdrawable = contractBal > premium.totalRefundEscrow()
            ? contractBal - premium.totalRefundEscrow()
            : 0;
        assertEq(withdrawable, 0, "Locked by stale escrow");

        premium.reconcileExpired(alice);
        premium.reconcileExpired(bob);
        assertEq(premium.totalRefundEscrow(), 0, "Cleared after reconcile");

        premium.withdrawToTreasury();
        assertTrue(toweli.balanceOf(premTreasury) > 0, "Treasury receives");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 14: Fee front-running protected by maxCost.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack14_feeFrontRunning() public {
        premium.proposeFeeChange(2000 ether);
        vm.warp(block.timestamp + 24 hours);
        premium.executeFeeChange();

        vm.prank(alice);
        vm.expectRevert("COST_EXCEEDS_MAX");
        premium.subscribe(1, 1000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 15: LP token sweep permanently blocked.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack15_sweepLPTokens() public {
        // M-P02: rejected at proposal time, no need to wait the timelock.
        vm.expectRevert("CANNOT_SWEEP_LP");
        pol.proposeSweepTokens(address(lp));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 16: Ownership transfer drain — sweeps still go to treasury.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack16_ownershipTransferDrain() public {
        vm.deal(address(pol), 10 ether);

        pol.transferOwnership(attacker);
        vm.prank(attacker);
        pol.acceptOwnership();

        vm.prank(attacker);
        pol.proposeSweepETH(10 ether);

        // 47h: not yet ready.
        vm.warp(block.timestamp + 47 hours);
        bytes32 sweepKey = pol.SWEEP_ETH_CHANGE();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sweepKey));
        pol.executeSweepETH();

        vm.warp(block.timestamp + 2 hours);
        vm.prank(attacker);
        pol.executeSweepETH();

        // Even attacker-as-owner can only sweep TO TREASURY, not to themselves.
        assertEq(treasuryAddr.balance, 10 ether, "Sweep destination is treasury, not owner");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 17: Extension escrow R022 — fresh per-period anchor; net cost
    //            ≈ forfeited remainder + tiny consumption of new period.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack17_extensionEscrow_R022() public {
        uint256 initialBalance = toweli.balanceOf(attacker);

        this._subscribeAttacker();
        // Past 1 day so the extension is not in the same block as initial sub.
        this._warpAndSubscribeAttacker();
        // Past MIN_HOLDING_PERIOD on the NEW per-period anchor.
        this._warpAndCancelAttacker();

        uint256 netCost = initialBalance - toweli.balanceOf(attacker);
        // R022: net cost = forfeit + small consumption of period 2.
        assertTrue(netCost > 0, "Some non-zero cost after extension+cancel");
        assertTrue(netCost < 1100 ether, "Net cost bounded");
    }

    function _subscribeAttacker() public {
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
    }

    function _warpAndSubscribeAttacker() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
    }

    function _warpAndCancelAttacker() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(attacker);
        premium.cancelSubscription();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 19: sweepETH proposal expiry enforced.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack19_sweepProposalExpiry() public {
        vm.deal(address(pol), 5 ether);
        pol.proposeSweepETH(5 ether);

        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.SWEEP_ETH_CHANGE()));
        pol.executeSweepETH();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 20: Subscriber counter underflow protection.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack20_subscriberCounterUnderflow() public {
        vm.startPrank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        premium.cancelSubscription();
        assertEq(premium.totalSubscribers(), 0);

        vm.prank(alice);
        vm.expectRevert(PremiumAccess.NoActiveSubscription.selector);
        premium.cancelSubscription();
        assertEq(premium.totalSubscribers(), 0, "No underflow");

        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);

        vm.warp(block.timestamp + 31 days);

        premium.reconcileExpired(bob);
        assertEq(premium.totalSubscribers(), 0);

        premium.reconcileExpired(bob); // idempotent
        assertEq(premium.totalSubscribers(), 0, "Double reconcile no underflow");
    }
}
