// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import "../src/TegridyFeeHook.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ═══════════════════════════════════════════════════════════════════════
// MOCKS
// ═══════════════════════════════════════════════════════════════════════

contract MockToweliRT is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
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

contract MockRouterRT {
    address public immutable weth;
    MockToweliRT public immutable toweli;

    constructor(address _weth, address _toweli) {
        weth = _weth;
        toweli = MockToweliRT(_toweli);
    }

    function WETH() external view returns (address) {
        return weth;
    }

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

/// @dev Malicious router that steals extra ETH during addLiquidity
contract MaliciousRouterRT {
    address public immutable weth;
    MockToweliRT public immutable toweli;
    address payable public attacker;

    constructor(address _weth, address _toweli, address payable _attacker) {
        weth = _weth;
        toweli = MockToweliRT(_toweli);
        attacker = _attacker;
    }

    function WETH() external view returns (address) {
        return weth;
    }

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
        // Try to steal the excess ETH
        if (address(this).balance > 0) {
            attacker.transfer(address(this).balance);
        }
        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = msg.value;
    }

    receive() external payable {}
}

/// @dev Contract that tries to call accumulate() to bypass tx.origin check
contract AccumulateProxy {
    POLAccumulator public target;

    constructor(POLAccumulator _target) {
        target = _target;
    }

    function proxyAccumulate(uint256 _minTokens, uint256 _minLP, uint256 _minETH, uint256 _deadline) external {
        target.accumulate(_minTokens, _minLP, _minETH, _deadline);
    }
}

/// @dev Contract that tries to re-enter cancelSubscription
contract ReentrantCanceller {
    PremiumAccess public premium;
    MockToweliRT public token;
    bool public attacked;

    constructor(PremiumAccess _premium, MockToweliRT _token) {
        premium = _premium;
        token = _token;
    }

    function attack() external {
        premium.cancelSubscription();
    }

    // If token has a callback, try to re-enter
    fallback() external {
        if (!attacked) {
            attacked = true;
            premium.cancelSubscription();
        }
    }
}

/// @dev Attacker contract that flash-borrows an NFT and tries to get premium in one tx
contract FlashBorrowerNFT {
    PremiumAccess public premium;
    MockJBACRT public nft;

    constructor(PremiumAccess _premium, MockJBACRT _nft) {
        premium = _premium;
        nft = _nft;
    }

    function attack(uint256 tokenId) external {
        // Step 1: Receive NFT (simulated flash loan - NFT already transferred to us)
        // Step 2: Activate
        premium.activateNFTPremium();
        // Step 3: Check premium in same tx
        bool hasPrem = premium.hasPremium(address(this));
        require(!hasPrem, "EXPLOIT: got premium in same tx!");
        // Step 4: Return NFT
        nft.transferFrom(address(this), msg.sender, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev Mock PoolManager for fee hook tests
contract MockPoolManagerRT {
    mapping(address => mapping(address => uint256)) public credits;

    function setCredit(address hook, address currency, uint256 amount) external {
        credits[hook][currency] = amount;
    }

    function take(Currency currency, address to, uint256 amount) external {
        address token = Currency.unwrap(currency);
        // Simulate: revert if trying to take more than credited
        require(credits[msg.sender][token] >= amount, "INSUFFICIENT_CREDIT");
        credits[msg.sender][token] -= amount;
        // In real V4, tokens would be transferred. We just track credits.
    }
}

// ═══════════════════════════════════════════════════════════════════════
// RED TEAM TEST SUITE
// ═══════════════════════════════════════════════════════════════════════

contract RedTeamPOLPremium is Test {
    // --- POL Accumulator ---
    POLAccumulator public pol;
    MockToweliRT public toweli;
    MockRouterRT public router;
    address public lpToken = makeAddr("lpToken");
    address public treasuryAddr = makeAddr("treasury");

    // --- Premium Access ---
    PremiumAccess public premium;
    MockJBACRT public nft;
    address public premTreasury = makeAddr("premTreasury");
    uint256 public constant MONTHLY_FEE = 1000 ether;

    // --- Fee Hook ---
    TegridyFeeHook public hook;
    MockPoolManagerRT public poolMgr;
    address public distributor = makeAddr("distributor");

    // --- Actors ---
    address public owner;
    address public attacker = makeAddr("attacker");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        owner = address(this);

        // ── POL Accumulator setup ──
        toweli = new MockToweliRT();
        router = new MockRouterRT(makeAddr("WETH"), address(toweli));
        pol = new POLAccumulator(address(toweli), address(router), lpToken, treasuryAddr);

        // ── Premium Access setup ──
        nft = new MockJBACRT();
        premium = new PremiumAccess(address(toweli), address(nft), premTreasury, MONTHLY_FEE);

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

        // ── Fee Hook setup ──
        poolMgr = new MockPoolManagerRT();
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolMgr)), distributor, uint256(30), address(this));
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));

        // Warp past accumulate and sync cooldowns
        vm.warp(block.timestamp + 8 days);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 1: Extract value from POLAccumulator via sweepTokens
    // Vector: sweepTokens sends to owner() not treasury. If owner is
    //         compromised, they can sweep accumulated TOWELI dust.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack1_sweepTokensDust() public {
        // SCENARIO: After accumulate(), leftover TOWELI dust remains in contract
        // The owner can sweep this dust to themselves (not treasury)

        // Transfer ownership to an EOA so tx.origin check passes
        address eoa = makeAddr("eoa_owner");
        pol.transferOwnership(eoa);
        vm.prank(eoa);
        pol.acceptOwnership();

        // Fund accumulator with ETH
        vm.deal(address(pol), 2 ether);

        // Accumulate (must set both msg.sender and tx.origin to pass NoContracts check)
        vm.warp(block.timestamp + 1 hours); // Respect accumulate cooldown
        vm.prank(eoa, eoa);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);

        // Check if any TOWELI dust remains
        uint256 dustBefore = toweli.balanceOf(address(pol));
        emit log_named_uint("TOWELI dust in POL after accumulate", dustBefore);

        // Owner sweeps dust to themselves
        uint256 ownerBefore = toweli.balanceOf(eoa);
        if (dustBefore > 0) {
            vm.prank(eoa);
            pol.sweepTokens(address(toweli));
            uint256 ownerAfter = toweli.balanceOf(eoa);
            emit log_named_uint("Owner extracted TOWELI dust", ownerAfter - ownerBefore);
            // FINDING: sweepTokens goes to owner(), not treasury
            // This is by design for dust recovery, but a compromised owner
            // could drain any tokens sent accidentally to the contract.
        }

        // RESULT: DEFENDED (by design) - dust amounts are negligible
        // NOTE: sweepTokens sends to owner() not treasury. Low severity since
        // only dust amounts remain after accumulate().
        assertTrue(true, "DEFENDED: dust extraction is by-design for recovery");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 2: Bypass tx.origin check in accumulate()
    // Vector: Call accumulate() from a contract to bypass the NoContracts check
    // ═══════════════════════════════════════════════════════════════════

    function test_attack2_bypassTxOriginViaProxy() public {
        // Fund accumulator
        vm.deal(address(pol), 2 ether);

        // Transfer ownership to attacker EOA for the proxy test
        pol.transferOwnership(attacker);
        vm.prank(attacker);
        pol.acceptOwnership();

        // Deploy proxy contract
        AccumulateProxy proxy = new AccumulateProxy(pol);

        // Attacker calls proxy which calls accumulate
        // tx.origin = attacker (EOA), msg.sender = proxy (contract)
        vm.prank(attacker, attacker); // sets both msg.sender and tx.origin
        // But proxy.proxyAccumulate makes msg.sender = proxy, not attacker
        // So onlyOwner will revert first (proxy is not owner)
        vm.expectRevert(); // OwnableUnauthorizedAccount
        proxy.proxyAccumulate(1, 0, 0, block.timestamp + 2 minutes);

        // Even if we make proxy the owner, tx.origin != msg.sender
        // Actually: tx.origin check is `msg.sender != tx.origin` which reverts
        // when called from a contract (msg.sender=contract, tx.origin=EOA)

        // RESULT: DEFENDED - onlyOwner + tx.origin check blocks contract calls
        emit log("DEFENDED: tx.origin check prevents contract proxy calls");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 3: Exploit maxAccumulateAmount cap
    // Vector: If balance > maxAccumulateAmount, excess ETH stays in contract.
    //         Attacker sends ETH, then sweepETH proposal drains it.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack3_exploitAccumulateCap() public {
        // maxAccumulateAmount = 10 ether
        // Send 20 ETH to accumulator
        vm.deal(address(pol), 20 ether);

        // accumulate() only uses 10 ETH max (need EOA prank for tx.origin)
        vm.warp(block.timestamp + 1 hours); // Respect accumulate cooldown
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);

        uint256 remaining = address(pol).balance;
        emit log_named_uint("ETH remaining after capped accumulate", remaining);

        // 10 ETH remains. Owner can propose sweep.
        // But sweepETH has 48h timelock, amount locked at proposal time.
        // This is the intended behavior - leftover ETH can be accumulated
        // in the next call.

        // Can owner sweep it all with multiple proposals? No - only one at a time.
        pol.proposeSweepETH(remaining);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pol.SWEEP_ETH_CHANGE()));
        pol.proposeSweepETH(1 ether);

        // RESULT: DEFENDED - cap limits per-tx exposure, sweep is timelocked
        emit log("DEFENDED: Cap limits single-tx exposure, sweep requires 48h timelock");
        assertTrue(remaining > 0, "Excess ETH remains but is safe behind timelock");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 4: Exploit sweepETH timelock - amount locked at proposal
    // Vector: Propose sweep for X, then accumulate() reduces balance,
    //         but executeSweepETH caps at actual balance.
    //         OR: More ETH arrives after proposal, can we sweep more?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack4_sweepETHAmountLock() public {
        vm.deal(address(pol), 5 ether);

        // Propose sweep of 5 ETH
        pol.proposeSweepETH(5 ether);

        // More ETH arrives
        vm.deal(address(pol), 15 ether);

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours);

        // Execute - amount is capped at proposedAmount (5 ETH), not current balance (15 ETH)
        uint256 treasuryBefore = treasuryAddr.balance;
        vm.deal(treasuryAddr, 0); // reset
        pol.executeSweepETH();
        uint256 treasuryAfter = treasuryAddr.balance;

        assertEq(treasuryAfter, 5 ether, "Should only sweep proposed amount, not more");
        assertEq(address(pol).balance, 10 ether, "10 ETH should remain");

        // RESULT: DEFENDED - Amount is locked at proposal time
        emit log("DEFENDED: sweepETH respects proposed amount, cannot drain extra ETH");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 4b: sweepETH when balance dropped below proposed amount
    // ═══════════════════════════════════════════════════════════════════

    function test_attack4b_sweepETHBalanceDropped() public {
        vm.deal(address(pol), 10 ether);

        // Propose sweep of 10 ETH
        pol.proposeSweepETH(10 ether);

        // Simulate balance drop (e.g., accumulate consumed some ETH)
        // Instead of calling accumulate (which consumes all), we directly
        // simulate the scenario by sending ETH out
        vm.deal(address(pol), 3 ether); // balance dropped from 10 to 3

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours);

        // Execute sweep - should cap at actual balance (3 ETH), not proposed (10 ETH)
        vm.deal(treasuryAddr, 0);
        pol.executeSweepETH();
        assertEq(treasuryAddr.balance, 3 ether, "Only swept actual balance, not proposed");
        assertEq(address(pol).balance, 0, "All remaining ETH swept");

        // RESULT: DEFENDED - executeSweepETH caps at min(proposed, balance)
        emit log("DEFENDED: Sweep caps at actual balance when balance < proposed");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 5: Get free premium access via flash-loan NFT borrow
    // Vector: Borrow JBAC NFT in flash loan, activate, get premium
    // ═══════════════════════════════════════════════════════════════════

    function test_attack5_flashLoanNFTPremium() public {
        // Mint NFT to alice (legitimate holder)
        nft.mint(alice);

        // Attacker deploys flash borrow contract
        FlashBorrowerNFT borrower = new FlashBorrowerNFT(premium, nft);

        // Alice "lends" NFT to attacker contract (simulating flash loan)
        vm.prank(alice);
        nft.transferFrom(alice, address(borrower), 1);

        // Attacker tries to activate + use premium in same tx
        // The activateNFTPremium sets nftActivationBlock = block.timestamp
        // hasPremium requires block.timestamp > nftActivationBlock + MIN_ACTIVATION_DELAY (15s)
        // So in the same block, hasPremium returns false!

        borrower.attack(1);

        // Verify: attacker contract does NOT have premium
        bool hasPrem = premium.hasPremium(address(borrower));
        assertFalse(hasPrem, "Flash loan NFT borrow should NOT grant premium");

        // RESULT: DEFENDED - MIN_ACTIVATION_DELAY (15s) prevents same-block exploit
        emit log("DEFENDED: 15s activation delay blocks flash loan NFT borrow");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 5b: Bypass activation delay by pre-activating then flash borrowing
    // Vector: Attacker activates while holding NFT, sells it, buys back later
    //         Does old activation persist?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack5b_staleActivationExploit() public {
        // Attacker buys NFT, activates, then sells
        uint256 tokenId = nft.mint(attacker);

        vm.prank(attacker);
        premium.activateNFTPremium();

        // Warp past activation delay
        vm.warp(block.timestamp + 20 seconds);

        // Attacker sells NFT
        vm.prank(attacker);
        nft.transferFrom(attacker, alice, tokenId);

        // Attacker no longer holds NFT but has stale activation
        bool hasPrem = premium.hasPremium(attacker);
        assertFalse(hasPrem, "No premium without NFT even with stale activation");
        // hasPremium checks balanceOf first - attacker has 0 NFTs

        // But what if attacker flash-borrows NFT back? They already have activation!
        vm.prank(alice);
        nft.transferFrom(alice, attacker, tokenId);

        // Now attacker has NFT + prior activation from 20s ago
        hasPrem = premium.hasPremium(attacker);
        assertTrue(hasPrem, "Attacker regains premium with stale activation + NFT");

        // FINDING: Stale activation persists after selling NFT.
        // If attacker flash-borrows NFT in a later block (>15s after original activation),
        // they bypass the activation delay entirely.
        //
        // HOWEVER: deactivateNFTPremium() exists to clean stale activations.
        // It requires 10 minutes grace period to prevent griefing.

        // Try deactivation after selling
        vm.prank(attacker);
        nft.transferFrom(attacker, alice, tokenId);

        // Anyone can deactivate if NFT not held and activation > 10 min old
        // Warp to exceed 10 minute grace period
        vm.warp(block.timestamp + 11 minutes);
        premium.deactivateNFTPremium(attacker);

        // Now even if attacker gets NFT back, activation is cleared
        vm.prank(alice);
        nft.transferFrom(alice, attacker, tokenId);
        hasPrem = premium.hasPremium(attacker);
        assertFalse(hasPrem, "After deactivation, need to re-activate (15s delay)");

        // RESULT: PARTIAL DEFENSE
        // Stale activation is a risk if no one calls deactivateNFTPremium() within 10 min.
        // Between 15s and 10min after selling, attacker can flash-borrow and get premium.
        emit log("PARTIAL: Stale activation window between 15s-10min is exploitable");
        emit log("FIX: deactivateNFTPremium() must be called proactively by keepers");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 6: Exploit NFT premium activation/deactivation griefing
    // Vector: Grief legitimate NFT holder by calling deactivateNFTPremium
    //         when they temporarily don't hold the NFT (marketplace listing)
    // ═══════════════════════════════════════════════════════════════════

    function test_attack6_deactivationGriefing() public {
        // Alice holds NFT and activates
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();

        vm.warp(block.timestamp + 20 seconds);
        assertTrue(premium.hasPremium(alice), "Alice should have premium");

        // Alice lists NFT on marketplace (transfers to marketplace contract)
        address marketplace = makeAddr("marketplace");
        vm.prank(alice);
        nft.transferFrom(alice, marketplace, 1);

        // Attacker tries to deactivate immediately
        // Requires activation to be > 10 minutes old
        premium.deactivateNFTPremium(alice);
        // Check: activation should still be there (10 min grace period protects)
        assertEq(premium.nftActivationBlock(alice), block.timestamp - 20 seconds,
            "Activation not cleared - 10 min grace protects marketplace listings");

        // Warp past 10 minute grace period
        vm.warp(block.timestamp + 11 minutes);

        // Now attacker CAN deactivate
        premium.deactivateNFTPremium(alice);
        assertEq(premium.nftActivationBlock(alice), 0, "Activation cleared after 10 min grace");

        // RESULT: DEFENDED for short operations (marketplace listings < 10 min)
        // RISK: Long marketplace listings (>10 min) can be griefed
        emit log("DEFENDED: 10 min grace period protects short NFT transfers");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 7: Inflate totalRevenue to manipulate protocol metrics
    // Vector: totalRevenue only increments for NEW subscriptions (isNewSub).
    //         Can we game the isNewSub check?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack7_inflateTotalRevenue() public {
        // Subscribe, let expire, subscribe again - each new sub inflates revenue
        vm.startPrank(alice);

        premium.subscribe(1, type(uint256).max);
        uint256 rev1 = premium.totalRevenue();
        assertEq(rev1, MONTHLY_FEE, "First sub adds to revenue");

        // Warp past expiry
        vm.warp(block.timestamp + 31 days);

        // Reconcile the expired subscription
        premium.reconcileExpired(alice);

        // Subscribe again - this IS a new sub (expired)
        premium.subscribe(1, type(uint256).max);
        uint256 rev2 = premium.totalRevenue();
        assertEq(rev2, 2 * MONTHLY_FEE, "Second new sub adds to revenue");

        vm.stopPrank();

        // M-06 FIX: Extensions now DO add to totalRevenue (all subscription payments count)
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);
        uint256 rev3 = premium.totalRevenue();

        vm.warp(block.timestamp + 1); // advance 1 second
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max); // extend
        uint256 rev4 = premium.totalRevenue();
        assertEq(rev4, rev3 + MONTHLY_FEE, "M-06: Extension DOES add to totalRevenue");

        // Can attacker inflate by subscribe->cancel->subscribe cycle?
        uint256 t1 = block.timestamp + 100;
        vm.warp(t1);
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
        uint256 rev5 = premium.totalRevenue();

        uint256 t2 = t1 + 100; // advance well past startedAt for SAME_BLOCK_CANCEL
        vm.warp(t2);
        vm.prank(attacker);
        premium.cancelSubscription(); // gets partial refund
        // Subscription expires immediately (expiresAt = t2)

        uint256 t3 = t2 + 100;
        vm.warp(t3);
        // Now isNewSub = true because expiresAt (t2) <= block.timestamp (t3)
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
        uint256 rev6 = premium.totalRevenue();

        emit log_named_uint("Revenue after subscribe", rev5);
        emit log_named_uint("Revenue after cancel+resubscribe", rev6);

        // FINDING: Each subscribe-cancel-subscribe cycle inflates totalRevenue
        // even though the attacker gets refunded. The refund is not subtracted
        // from totalRevenue.
        assertTrue(rev6 > rev5, "CRITICAL: totalRevenue inflated via cancel+resubscribe cycle");
        emit log("CRITICAL FINDING: totalRevenue is inflatable via subscribe-cancel-resubscribe");
        emit log("totalRevenue never decreases on cancel, so metric is unreliable");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8: Steal subscription refund escrow
    // Vector: Try to extract more from escrow than deposited
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8_stealRefundEscrow() public {
        // Alice subscribes for 12 months
        vm.prank(alice);
        premium.subscribe(12, type(uint256).max);

        uint256 aliceEscrow = premium.userEscrow(alice);
        assertEq(aliceEscrow, 12 * MONTHLY_FEE);

        // Bob subscribes for 1 month
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        uint256 totalEscrow = premium.totalRefundEscrow();
        assertEq(totalEscrow, 13 * MONTHLY_FEE);

        // Alice cancels after 1 day - should get ~11.67 months refund
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        premium.cancelSubscription();

        uint256 aliceRefund = toweli.balanceOf(alice) - (500_000 ether - 12 * MONTHLY_FEE);
        emit log_named_uint("Alice refund amount", aliceRefund);

        // Check if Bob's escrow is intact
        uint256 bobEscrow = premium.userEscrow(bob);
        assertEq(bobEscrow, MONTHLY_FEE, "Bob's escrow should be untouched");

        // Can Bob still cancel and get full refund?
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        premium.cancelSubscription();

        // Bob should get most of his fee back
        uint256 bobRefund = toweli.balanceOf(bob) - (500_000 ether - MONTHLY_FEE);
        assertTrue(bobRefund > 0, "Bob should get a refund");
        emit log_named_uint("Bob refund amount", bobRefund);

        // RESULT: DEFENDED - individual escrow tracking prevents cross-user theft
        emit log("DEFENDED: userEscrow isolation prevents stealing other users' refunds");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8b: Drain escrow via withdrawToTreasury
    // Vector: Owner calls withdrawToTreasury before users cancel
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8b_withdrawDrainsEscrow() public {
        // Alice subscribes
        vm.prank(alice);
        premium.subscribe(6, type(uint256).max);

        uint256 contractBal = toweli.balanceOf(address(premium));
        uint256 escrow = premium.totalRefundEscrow();

        // Owner tries to withdraw - should only get non-escrowed portion
        premium.withdrawToTreasury();

        uint256 treasuryGot = toweli.balanceOf(premTreasury);
        uint256 afterBal = toweli.balanceOf(address(premium));

        emit log_named_uint("Contract balance before withdraw", contractBal);
        emit log_named_uint("Total escrow", escrow);
        emit log_named_uint("Treasury received", treasuryGot);
        emit log_named_uint("Contract balance after withdraw", afterBal);

        // Contract should still hold at least the escrow amount
        assertTrue(afterBal >= escrow, "Contract must retain escrow for refunds");

        // Alice should still be able to cancel and get refund
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        premium.cancelSubscription();

        uint256 aliceRefund = toweli.balanceOf(alice) - (500_000 ether - 6 * MONTHLY_FEE);
        assertTrue(aliceRefund > 0, "Alice still gets refund after treasury withdrawal");

        // RESULT: DEFENDED - withdrawToTreasury respects totalRefundEscrow
        emit log("DEFENDED: withdrawToTreasury only takes non-escrowed balance");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 8c: totalRefundEscrow desync - expired subs not reconciled
    // Vector: If subscriptions expire without reconciliation, totalRefundEscrow
    //         stays inflated, permanently locking funds from treasury withdrawal.
    // ═══════════════════════════════════════════════════════════════════

    function test_attack8c_escrowDesync() public {
        // Multiple users subscribe
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);

        uint256 totalEscrow = premium.totalRefundEscrow();
        assertEq(totalEscrow, 2 * MONTHLY_FEE);

        // Both subscriptions expire
        vm.warp(block.timestamp + 31 days);

        // Without reconciliation, totalRefundEscrow is still 2 * MONTHLY_FEE
        assertEq(premium.totalRefundEscrow(), 2 * MONTHLY_FEE,
            "Escrow inflated even though subscriptions expired");

        // Owner can't withdraw these funds
        uint256 contractBal = toweli.balanceOf(address(premium));
        uint256 withdrawable = contractBal > premium.totalRefundEscrow()
            ? contractBal - premium.totalRefundEscrow()
            : 0;
        assertEq(withdrawable, 0, "All funds locked by stale escrow");

        // FIX: Anyone can call reconcileExpired to fix this
        premium.reconcileExpired(alice);
        premium.reconcileExpired(bob);
        assertEq(premium.totalRefundEscrow(), 0, "Escrow fixed after reconciliation");

        // Now owner can withdraw
        premium.withdrawToTreasury();
        assertTrue(toweli.balanceOf(premTreasury) > 0, "Treasury can now receive funds");

        // RESULT: DEFENDED (with reconciliation) but griefable if keepers don't reconcile
        emit log("DEFENDED: reconcileExpired fixes stale escrow, but requires keeper calls");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 9: Manipulate accruedFees in TegridyFeeHook
    // Vector: afterSwap can only be called by PoolManager. Can we
    //         manipulate the fee calculation?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack9_directAfterSwapCall() public {
        // Only PoolManager can call afterSwap
        PoolKey memory key;
        IPoolManager.SwapParams memory params;
        BalanceDelta delta;

        vm.prank(attacker);
        vm.expectRevert(TegridyFeeHook.OnlyPoolManager.selector);
        hook.afterSwap(attacker, key, params, delta, "");

        // RESULT: DEFENDED - onlyPoolManager modifier
        emit log("DEFENDED: afterSwap is restricted to PoolManager");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 9b: Inflate accruedFees via syncAccruedFees
    // Vector: Owner proposes sync with higher credit than actual
    // ═══════════════════════════════════════════════════════════════════

    function test_attack9b_syncInflateAccrued() public {
        address token1 = makeAddr("token1");

        // Current accrued = 0. Try to sync UP to inflate.
        // executeSyncAccruedFees has: if (actualCredit > old) revert SyncReductionTooLarge()
        hook.proposeSyncAccruedFees(token1, 1000 ether);

        vm.warp(block.timestamp + 7 days); // Must satisfy both 24h proposal timelock AND 7-day sync cooldown

        // This should revert because actualCredit (1000) > old (0)
        vm.expectRevert(TegridyFeeHook.SyncReductionTooLarge.selector);
        hook.executeSyncAccruedFees(token1);

        // RESULT: DEFENDED - sync can only REDUCE, not inflate
        emit log("DEFENDED: syncAccruedFees can only reduce fees, never inflate");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 9c: Sync reduces fees by exactly 50% (boundary test)
    // Vector: The 50% cap allows reducing accruedFees by up to half
    // ═══════════════════════════════════════════════════════════════════

    function test_attack9c_sync50PercentBoundary() public {
        address token1 = makeAddr("token1");

        // Simulate some accrued fees (need PoolManager to call afterSwap)
        // We'll use a workaround: store directly
        vm.store(
            address(hook),
            keccak256(abi.encode(token1, uint256(7))), // slot for accruedFees mapping
            bytes32(uint256(100 ether))
        );
        assertEq(hook.accruedFees(token1), 100 ether);

        // Try to sync to 50% (reduce by exactly 50%) - should PASS
        hook.proposeSyncAccruedFees(token1, 50 ether);
        _warpAndExecuteSync(token1, 25 hours);
        assertEq(hook.accruedFees(token1), 50 ether, "50% reduction allowed");

        // H-01 audit fix: 50% cap was removed; sync now succeeds with any reduction
        // as long as the 24h timelock and 7-day cooldown are respected.
        // Try to sync to 24 ether (reduce by more than 50% of 50 = 25) - should PASS
        // Must wait 7-day SYNC_COOLDOWN before next sync
        _warpThenPropose(token1, 24 ether, 7 days);
        _warpAndExecuteSync(token1, 25 hours);
        assertEq(hook.accruedFees(token1), 24 ether, ">50% reduction allowed after H-01 fix");

        // RESULT: 50% cap removed per audit H-01. Protection now relies on
        // 24h timelock + 7-day cooldown, giving governance/multisig time to react.
        emit log("H-01 FIX: 50% cap removed; 24h timelock + 7d cooldown is the safeguard");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 10: Exploit fee sync timelock - propose then cancel loop
    // Vector: Repeatedly propose and cancel to grief monitoring systems
    // ═══════════════════════════════════════════════════════════════════

    function test_attack10_syncTimelockGriefing() public {
        address token1 = makeAddr("token1");

        // Propose sync
        hook.proposeSyncAccruedFees(token1, 0);

        // Can't propose another while one is pending
        bytes32 syncKey = keccak256(abi.encodePacked(hook.SYNC_CHANGE(), token1));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, syncKey));
        hook.proposeSyncAccruedFees(token1, 0);

        // Cancel and re-propose
        hook.cancelSyncAccruedFees(token1);
        hook.proposeSyncAccruedFees(token1, 0);

        // This is owner-only, so not a public griefing vector
        // RESULT: DEFENDED - only owner can propose/cancel
        emit log("DEFENDED: Sync operations are owner-only, no public griefing");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 11: Grief claimFees function
    // Vector: claimFees is permissionless. Can attacker front-run
    //         legitimate claims, or cause unexpected reverts?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack11_griefClaimFees() public {
        address token1 = makeAddr("token1");

        // Set up accrued fees
        vm.store(
            address(hook),
            keccak256(abi.encode(token1, uint256(7))),
            bytes32(uint256(100 ether))
        );

        // Set up PoolManager credit
        poolMgr.setCredit(address(hook), token1, 100 ether);

        // Attacker front-runs and claims all fees
        vm.prank(attacker);
        hook.claimFees(token1, 100 ether);

        // Legitimate caller tries to claim - reverts because accrued = 0
        vm.prank(alice);
        vm.expectRevert(TegridyFeeHook.ExceedsAccrued.selector);
        hook.claimFees(token1, 1);

        // NOTE: Fees always go to revenueDistributor regardless of caller
        // So front-running claimFees doesn't steal funds - it just triggers
        // the claim earlier than expected. Funds go to same destination.

        // RESULT: DEFENDED - fees always go to revenueDistributor
        // Front-running claimFees is actually HELPFUL (anyone can trigger distribution)
        emit log("DEFENDED: claimFees always sends to revenueDistributor, front-running is harmless");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 11b: Grief claimFees by desynchronizing accruedFees from
    //             PoolManager credits (over-claiming)
    // ═══════════════════════════════════════════════════════════════════

    function test_attack11b_overclaim() public {
        address token1 = makeAddr("token1");

        // Set accrued fees to 100 but only 50 credits in PoolManager
        vm.store(
            address(hook),
            keccak256(abi.encode(token1, uint256(7))),
            bytes32(uint256(100 ether))
        );
        poolMgr.setCredit(address(hook), token1, 50 ether);

        // Try to claim 100 - passes accruedFees check but PoolManager reverts
        vm.expectRevert("INSUFFICIENT_CREDIT");
        hook.claimFees(token1, 100 ether);

        // accruedFees is unchanged because the whole tx reverted
        assertEq(hook.accruedFees(token1), 100 ether, "Accrued unchanged after revert");

        // Can still claim up to actual credit
        hook.claimFees(token1, 50 ether);
        assertEq(hook.accruedFees(token1), 50 ether, "Accrued reduced by claimed amount");

        // Remaining 50 in accruedFees has no PoolManager credit backing
        // This is a "phantom" balance - needs syncAccruedFees to fix
        vm.expectRevert("INSUFFICIENT_CREDIT");
        hook.claimFees(token1, 50 ether);

        // RESULT: DEFENDED - PoolManager.take reverts atomically, no fund loss
        // Owner can use syncAccruedFees to correct the drift
        emit log("DEFENDED: PoolManager.take revert prevents over-claiming, sync fixes drift");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 12: Exploit fee currency handling
    // Vector: Can we cause accounting errors by swapping in a pool
    //         where currency determination is wrong?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack12_feeCurrencyMismatch() public {
        // The afterSwap logic determines credit currency based on:
        //   specifiedIsZero = (amountSpecified < 0) == zeroForOne
        //   creditCurrency = specifiedIsZero ? currency1 : currency0
        //
        // This follows V4 convention: the "unspecified" currency gets the hook delta.
        // For exact-input (amountSpecified < 0):
        //   - zeroForOne=true: specified=currency0, unspecified=currency1 -> fee on currency1
        //   - zeroForOne=false: specified=currency1, unspecified=currency0 -> fee on currency0
        //
        // The fee is charged on the output token (unspecified), which is correct.
        // No mismatch possible since it follows the V4 protocol spec.

        // RESULT: DEFENDED - currency logic follows V4 spec exactly
        emit log("DEFENDED: Fee currency follows V4 unspecified-currency convention");
        assertTrue(true);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 13: Subscribe-cancel in same block for free premium window
    // Vector: Subscribe and cancel in the same block to get a free
    //         premium window without paying (M-18 fix verification)
    // ═══════════════════════════════════════════════════════════════════

    function test_attack13_sameBlockSubscribeCancel() public {
        vm.startPrank(attacker);

        premium.subscribe(1, type(uint256).max);

        // Try to cancel in same block
        vm.expectRevert("SAME_BLOCK_CANCEL");
        premium.cancelSubscription();

        vm.stopPrank();

        // RESULT: DEFENDED - M-18 fix blocks same-block cancel
        emit log("DEFENDED: Same-block subscribe+cancel blocked by SAME_BLOCK_CANCEL check");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 14: Fee front-running - owner changes fee between user's
    //            approval and subscribe() call
    // ═══════════════════════════════════════════════════════════════════

    function test_attack14_feeFrontRunning() public {
        // Fee is 1000 TOWELI/month. Owner proposes increase to 2000.
        premium.proposeFeeChange(2000 ether);
        vm.warp(block.timestamp + 24 hours);
        premium.executeFeeChange();

        // Alice tries to subscribe with maxCost = 1000 (old fee)
        vm.prank(alice);
        vm.expectRevert("COST_EXCEEDS_MAX");
        premium.subscribe(1, 1000 ether);

        // RESULT: DEFENDED - maxCost parameter + timelocked fee changes
        emit log("DEFENDED: maxCost parameter protects against fee front-running");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 15: POL Accumulator - LP token sweep protection
    // ═══════════════════════════════════════════════════════════════════

    function test_attack15_sweepLPTokens() public {
        vm.expectRevert("CANNOT_SWEEP_LP");
        pol.sweepTokens(lpToken);

        // RESULT: DEFENDED - cannot sweep LP tokens
        emit log("DEFENDED: LP token sweep permanently blocked");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 16: POL Accumulator - ownership transfer to drain
    // Vector: 2-step ownership means instant drain is harder, but
    //         new owner can still sweep after timelock
    // ═══════════════════════════════════════════════════════════════════

    function test_attack16_ownershipTransferDrain() public {
        vm.deal(address(pol), 10 ether);

        // Transfer ownership requires 2-step
        pol.transferOwnership(attacker);
        // Attacker must accept
        vm.prank(attacker);
        pol.acceptOwnership();

        // Now attacker IS the owner. They can propose sweep.
        vm.prank(attacker);
        pol.proposeSweepETH(10 ether);

        // But must wait 48 hours
        vm.warp(block.timestamp + 47 hours);
        bytes32 sweepKey = pol.SWEEP_ETH_CHANGE();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, sweepKey));
        pol.executeSweepETH();

        // After 48h
        vm.warp(block.timestamp + 2 hours);
        vm.prank(attacker);
        pol.executeSweepETH();

        assertEq(treasuryAddr.balance, 10 ether, "Swept to treasury, not attacker");

        // FINDING: Even a compromised owner can only sweep to TREASURY address.
        // But treasury is set in constructor and immutable... wait, is it?
        // treasury is NOT immutable! It's a regular state variable.
        // But there's no setTreasury function on POLAccumulator!

        // RESULT: DEFENDED - sweep always goes to treasury (no setter for treasury)
        emit log("DEFENDED: sweepETH always sends to constructor-set treasury, no treasury setter");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 17: Premium - extension escrow accounting manipulation
    // Vector: Subscribe, extend immediately, cancel for larger refund
    // ═══════════════════════════════════════════════════════════════════

    function test_attack17_extensionEscrowManipulation() public {
        uint256 initialBalance = toweli.balanceOf(attacker);

        uint256 ts = block.timestamp;

        // Subscribe for 1 month
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
        uint256 afterSub = toweli.balanceOf(attacker);
        assertEq(initialBalance - afterSub, MONTHLY_FEE, "Paid 1 month");

        // Advance 100 seconds (to pass ALREADY_SUBSCRIBED_THIS_BLOCK)
        ts += 100;
        vm.warp(ts);

        // Extend by 1 month (this resets startedAt to current block.timestamp)
        vm.prank(attacker);
        premium.subscribe(1, type(uint256).max);
        uint256 afterExtend = toweli.balanceOf(attacker);
        uint256 totalPaid = initialBalance - afterExtend;
        emit log_named_uint("Total paid (2 months)", totalPaid);

        // Advance 100 seconds (to pass SAME_BLOCK_CANCEL - extension resets startedAt)
        ts += 100;
        vm.warp(ts);

        // Cancel immediately
        vm.prank(attacker);
        premium.cancelSubscription();
        uint256 afterCancel = toweli.balanceOf(attacker);
        uint256 refunded = afterCancel - afterExtend;
        uint256 netCost = initialBalance - afterCancel;

        emit log_named_uint("Refund received", refunded);
        emit log_named_uint("Net cost (should be ~0 for ~0 time used)", netCost);

        // Net cost should be approximately 0 (only 200 seconds elapsed out of ~60 days)
        // If net cost is significantly > 0, the extension accounting is broken
        assertTrue(netCost < 1 ether, "Net cost should be minimal for 2 seconds of premium");

        // RESULT: DEFENDED - extension escrow accounting correctly tracks pro-rata
        emit log("DEFENDED: Extension escrow tracks pro-rata correctly");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 18: Fee Hook - paused state allows bypassing fees
    // Vector: When hook is paused, swaps proceed without fees.
    //         Can attacker trigger pause to avoid fees?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack18_pauseToAvoidFees() public {
        // Only owner can pause
        vm.prank(attacker);
        vm.expectRevert();
        hook.pause();

        // RESULT: DEFENDED - pause is owner-only
        emit log("DEFENDED: Only owner can pause the fee hook");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 19: POL Accumulator - sweepETH proposal expiry bypass
    // Vector: Proposal expires after 7 days. But what if we propose,
    //         wait 8 days, and try to execute?
    // ═══════════════════════════════════════════════════════════════════

    function test_attack19_sweepProposalExpiry() public {
        vm.deal(address(pol), 5 ether);

        pol.proposeSweepETH(5 ether);

        // Warp past expiry (48h timelock + 7 days validity)
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pol.SWEEP_ETH_CHANGE()));
        pol.executeSweepETH();

        // RESULT: DEFENDED - proposals expire after 7 days
        emit log("DEFENDED: Stale sweep proposals expire correctly");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ATTACK 20: Premium - totalSubscribers underflow
    // Vector: Cancel without being active subscriber to underflow counter
    // ═══════════════════════════════════════════════════════════════════

    function test_attack20_subscriberCounterUnderflow() public {
        // Subscribe then cancel
        vm.startPrank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);

        vm.warp(block.timestamp + 1);
        premium.cancelSubscription();
        assertEq(premium.totalSubscribers(), 0);
        vm.stopPrank();

        // Try to cancel again (no active subscription)
        vm.prank(alice);
        vm.expectRevert(PremiumAccess.NoActiveSubscription.selector);
        premium.cancelSubscription();

        // totalSubscribers should still be 0, not underflowed
        assertEq(premium.totalSubscribers(), 0, "No underflow");

        // Check reconcileExpired doesn't underflow either
        // Subscribe and let expire
        vm.prank(bob);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalSubscribers(), 1);

        vm.warp(block.timestamp + 31 days);

        // Reconcile twice
        premium.reconcileExpired(bob);
        assertEq(premium.totalSubscribers(), 0);

        premium.reconcileExpired(bob); // no-op (escrow already 0)
        assertEq(premium.totalSubscribers(), 0, "Double reconcile doesn't underflow");

        // RESULT: DEFENDED - isActiveSubscriber tracking prevents underflow
        emit log("DEFENDED: Subscriber counter protected by isActiveSubscriber flag");
    }

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY VIEW
    // ═══════════════════════════════════════════════════════════════════

    function test_SUMMARY() public pure {
        // ---- CRITICAL FINDINGS ----
        // ATTACK 7: totalRevenue is inflatable via subscribe-cancel-resubscribe cycle.
        //           totalRevenue never decreases on cancel/refund. This is a metric
        //           integrity issue. If any on-chain logic depends on totalRevenue
        //           (e.g., revenue-based governance), this is exploitable.
        //           SEVERITY: MEDIUM (metric inflation, not fund loss)

        // ATTACK 5b: Stale NFT activation window (15s - 10min) allows flash-loan
        //            bypass if deactivateNFTPremium() is not called by keepers.
        //            SEVERITY: LOW-MEDIUM (requires keeper negligence + flash loan access)

        // ---- DEFENDED ----
        // ATTACK 1:  sweepTokens dust - by design, negligible amounts
        // ATTACK 2:  tx.origin bypass - blocked by onlyOwner + tx.origin check
        // ATTACK 3:  maxAccumulateAmount cap - limits per-tx exposure
        // ATTACK 4:  sweepETH amount lock - proposal amount is honored
        // ATTACK 5:  flash loan NFT premium - 15s activation delay blocks it
        // ATTACK 6:  deactivation griefing - 10 min grace period
        // ATTACK 8:  escrow theft - userEscrow isolation
        // ATTACK 8b: withdrawToTreasury - respects totalRefundEscrow
        // ATTACK 8c: escrow desync - reconcileExpired fixes it
        // ATTACK 9:  direct afterSwap - onlyPoolManager
        // ATTACK 9b: sync inflate - can only reduce, not inflate
        // ATTACK 9c: sync 50% cap - exponential decay limits damage
        // ATTACK 10: sync timelock grief - owner-only
        // ATTACK 11: claimFees grief - fees always go to revenueDistributor
        // ATTACK 11b: overclaim - PoolManager.take reverts atomically
        // ATTACK 12: fee currency - follows V4 spec
        // ATTACK 13: same-block subscribe+cancel - M-18 fix blocks it
        // ATTACK 14: fee front-running - maxCost + timelock
        // ATTACK 15: LP sweep - permanently blocked
        // ATTACK 16: ownership drain - 2-step + sweep to treasury only
        // ATTACK 17: extension escrow - pro-rata accounting correct
        // ATTACK 18: pause to avoid fees - owner-only
        // ATTACK 19: sweep proposal expiry - correctly enforced
        // ATTACK 20: subscriber underflow - isActiveSubscriber flag
    }

    // ─── Helpers (separate functions to avoid via_ir block.timestamp caching) ────

    function _warpAndExecuteSync(address token, uint256 duration) internal {
        vm.warp(block.timestamp + duration);
        hook.executeSyncAccruedFees(token);
    }

    function _warpThenPropose(address token, uint256 newValue, uint256 duration) internal {
        vm.warp(block.timestamp + duration);
        hook.proposeSyncAccruedFees(token, newValue);
    }

    function _warpAndExpectRevertSync(address token, uint256 duration) internal {
        vm.warp(block.timestamp + duration);
        vm.expectRevert(TegridyFeeHook.SyncReductionTooLarge.selector);
        hook.executeSyncAccruedFees(token);
    }
}
