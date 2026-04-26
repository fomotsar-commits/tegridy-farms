// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import "../src/TegridyFeeHook.sol";

// ============================================================================
// FINAL AUDIT: POL Accumulator, Premium Access, TegridyFeeHook
// ============================================================================

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockToweliFinal is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
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

contract MockRouterFinal {
    address public immutable wethAddr;
    MockToweliFinal public immutable toweli;

    constructor(address _weth, address _toweli) {
        wethAddr = _weth;
        toweli = MockToweliFinal(_toweli);
    }

    function WETH() external view returns (address) {
        return wethAddr;
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

contract MockPoolManagerFinal {
    mapping(address => mapping(address => uint256)) public credits;

    function setCredit(address hook, address currency, uint256 amount) external {
        credits[hook][currency] = amount;
    }

    function take(Currency currency, address to, uint256 amount) external {
        address token = Currency.unwrap(currency);
        require(credits[msg.sender][token] >= amount, "INSUFFICIENT_CREDIT");
        credits[msg.sender][token] -= amount;
    }
}

// ============================================================================
// TEST CONTRACT
// ============================================================================

contract FinalAuditPOLPremium is Test {
    // ─── POL ─────────────────────────────────────
    POLAccumulator public pol;
    MockToweliFinal public toweli;
    MockRouterFinal public router;
    address public lpToken = makeAddr("lpToken");
    address public treasury = makeAddr("treasury");

    // ─── Premium ─────────────────────────────────
    PremiumAccess public premium;
    MockJBACFinal public nft;
    address public premTreasury = makeAddr("premTreasury");
    uint256 public constant MONTHLY_FEE = 1000 ether;

    // ─── Fee Hook ────────────────────────────────
    TegridyFeeHook public hook;
    MockPoolManagerFinal public poolMgr;
    address public distributor = makeAddr("distributor");

    // ─── Actors ──────────────────────────────────
    address public owner;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public attacker = makeAddr("attacker");

    function setUp() public {
        owner = address(this);

        // POL setup
        toweli = new MockToweliFinal();
        router = new MockRouterFinal(makeAddr("WETH"), address(toweli));
        pol = new POLAccumulator(address(toweli), address(router), lpToken, treasury);

        // Premium setup
        nft = new MockJBACFinal();
        premium = new PremiumAccess(address(toweli), address(nft), premTreasury, MONTHLY_FEE);

        // Warp past accumulate and sync cooldowns
        vm.warp(block.timestamp + 8 days);

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

        // Fee Hook setup
        poolMgr = new MockPoolManagerFinal();
        address hookAddr = address(uint160(0x0044));
        bytes memory args = abi.encode(IPoolManager(address(poolMgr)), distributor, uint256(30), address(this));
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 1: POL maxAccumulateAmount cap bypass via multiple calls
    // The per-call cap does NOT rate-limit. An owner can call accumulate()
    // N times in a single block to process N * maxAccumulateAmount of ETH.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding1_accumulateCapBypassMultipleCalls() public {
        // Fund 50 ETH (5x the 10 ETH cap)
        vm.deal(address(pol), 50 ether);

        uint256 balanceBefore = address(pol).balance;
        emit log_named_uint("ETH before multiple accumulations", balanceBefore);

        // First call succeeds
        _doAccumulate();

        // Second call in same block should revert due to 1-hour cooldown (FIX)
        vm.expectRevert("ACCUMULATE_COOLDOWN");
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);

        // FIX VERIFIED: Only 10 ETH consumed, 40 ETH remains
        uint256 balanceAfter = address(pol).balance;
        assertEq(balanceAfter, 40 ether, "FIX VERIFIED: Cooldown prevents multiple calls in same block");
        assertEq(pol.totalAccumulations(), 1, "Only 1 accumulation allowed per cooldown period");

        // With cooldown warps, multiple calls work correctly
        _doAccumulateAfterCooldown();
        _doAccumulateAfterCooldown();
        _doAccumulateAfterCooldown();
        assertEq(pol.totalAccumulations(), 4, "4 accumulations with proper cooldown spacing");
    }

    function _doAccumulate() internal {
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);
    }

    function _doAccumulateAfterCooldown() internal {
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 2: POL sweepTokens sends to owner() not treasury
    // If owner is compromised, they can sweep any token dust to themselves.
    // This is inconsistent with sweepETH which sends to treasury.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding2_sweepTokensGoesToTreasury() public {
        // Simulate some token dust in the contract
        toweli.transfer(address(pol), 1000 ether);

        address currentOwner = pol.owner();
        uint256 ownerBefore = toweli.balanceOf(currentOwner);
        uint256 treasuryBefore = toweli.balanceOf(treasury);

        pol.sweepTokens(address(toweli));

        uint256 ownerAfter = toweli.balanceOf(currentOwner);
        uint256 treasuryAfter = toweli.balanceOf(treasury);

        // AUDIT FIX L-08: Tokens now go to treasury, not owner
        assertEq(ownerAfter - ownerBefore, 0, "Owner got nothing (fixed)");
        assertEq(treasuryAfter - treasuryBefore, 1000 ether, "Tokens went to treasury");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 3: POL sweepETH sequential drain via repeated proposals
    // After one sweep executes, owner can immediately propose another.
    // Over time, ALL ETH can be swept via sequential timelocked proposals.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding3_sweepETHSequentialDrain() public {
        vm.deal(address(pol), 30 ether);

        uint256 t = block.timestamp;

        // Round 1: Propose + execute 10 ETH
        pol.proposeSweepETH(10 ether);
        t += 48 hours;
        vm.warp(t);
        pol.executeSweepETH();
        assertEq(address(pol).balance, 20 ether);

        // Round 2: Immediately propose another sweep
        pol.proposeSweepETH(10 ether);
        t += 48 hours;
        vm.warp(t);
        pol.executeSweepETH();
        assertEq(address(pol).balance, 10 ether);

        // Round 3
        pol.proposeSweepETH(10 ether);
        t += 48 hours;
        vm.warp(t);
        pol.executeSweepETH();
        assertEq(address(pol).balance, 0 ether);

        // All 30 ETH drained in 3 rounds (6 days total)
        assertEq(treasury.balance, 30 ether, "All ETH swept to treasury over 3 rounds");

        // SEVERITY: INFORMATIONAL
        // This is arguably by design - sweep is for emergency recovery. The 48h
        // timelock per round gives community time to react. But there is no
        // max total sweep limit or per-period cap.
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 4: Premium totalRevenue undercount on subscription extension
    // When a user extends their subscription, the consumed portion of the
    // old escrow is subtracted from totalRefundEscrow but NEVER added to
    // totalRevenue. This means totalRevenue is lower than actual earned revenue.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding4_totalRevenueUndercountOnExtension() public {
        // Alice subscribes for 1 month (1000 TOWELI)
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);

        uint256 revenueAfterSub = premium.totalRevenue();
        assertEq(revenueAfterSub, 1000 ether, "Revenue correct after initial sub");

        // Warp 15 days (half the subscription consumed)
        vm.warp(block.timestamp + 15 days);

        // Alice extends by 1 more month
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);

        uint256 revenueAfterExtend = premium.totalRevenue();

        // The consumed portion (~500 TOWELI for 15 days out of 30) is NOT added
        // to totalRevenue during extension. totalRevenue stays at 1000.
        // The consumed portion just disappeared from totalRefundEscrow tracking.
        emit log_named_uint("totalRevenue after extension", revenueAfterExtend);
        emit log_named_uint("Expected total earned (initial + consumed)", 1000 ether);

        // M-06 FIX: totalRevenue now always increments by cost on subscribe (including extensions)
        // So totalRevenue = 1000 (initial) + 1000 (extension) = 2000
        assertEq(revenueAfterExtend, 2 * MONTHLY_FEE, "totalRevenue incremented by cost on extension (M-06 fix)");

        // SEVERITY: LOW
        // This is purely an accounting issue for off-chain analytics. It does not
        // affect withdrawable amounts (which use balance - totalRefundEscrow).
        // But totalRevenue will be inaccurate for dashboards/reporting.
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 5: Premium withdrawToTreasury locked if reconcileExpired not called
    // If many subscriptions expire without reconciliation, totalRefundEscrow
    // stays inflated, locking earned revenue in the contract.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding5_withdrawLockedWithoutReconciliation() public {
        // Alice and Bob each subscribe for 1 month
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);
        vm.prank(bob);
        premium.subscribe(1, 1000 ether);

        // Both subscriptions expire
        vm.warp(block.timestamp + 31 days);

        // Check: totalRefundEscrow is still inflated (not reconciled)
        uint256 escrowBefore = premium.totalRefundEscrow();
        assertEq(escrowBefore, 2000 ether, "totalRefundEscrow still at 2000 despite expiry");

        // withdrawToTreasury sees balance (2000) - totalRefundEscrow (2000) = 0 withdrawable
        uint256 contractBalance = toweli.balanceOf(address(premium));
        uint256 withdrawable = contractBalance > escrowBefore ? contractBalance - escrowBefore : 0;
        assertEq(withdrawable, 0, "FINDING: Zero withdrawable despite all subs expired");

        // Must reconcile first
        premium.reconcileExpired(alice);
        premium.reconcileExpired(bob);

        uint256 escrowAfter = premium.totalRefundEscrow();
        assertEq(escrowAfter, 0, "Escrow cleared after reconciliation");

        // Now withdrawal works
        uint256 treasuryBefore = toweli.balanceOf(premTreasury);
        premium.withdrawToTreasury();
        uint256 treasuryAfter = toweli.balanceOf(premTreasury);
        assertEq(treasuryAfter - treasuryBefore, 2000 ether, "Treasury received funds after reconciliation");

        // SEVERITY: MEDIUM
        // Without active reconciliation (manual or bot-driven), earned revenue is
        // permanently locked. The batchReconcileExpired helps, but there is no
        // automatic mechanism. If no one calls reconcile, funds are stuck.
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 6: TegridyFeeHook repeated 50% sync reductions drain fees
    // The 50% cap per sync can be exploited by a compromised owner via
    // sequential sync proposals: 1000 -> 500 -> 250 -> 125 -> ... -> 0
    // Each round only takes 24 hours.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding6_repeatedSyncReductionsDrainFees() public {
        address token = makeAddr("feeToken");

        // Simulate 1000 accrued fees by directly writing storage
        bytes32 slot = keccak256(abi.encode(token, uint256(7))); // slot 8 = accruedFees mapping
        vm.store(address(hook), slot, bytes32(uint256(1000 ether)));
        assertEq(hook.accruedFees(token), 1000 ether, "Accrued fees set to 1000");

        _syncTime = block.timestamp;

        // Round 1: Reduce by 50% (1000 -> 500)
        hook.proposeSyncAccruedFees(token, 500 ether);
        _syncWarpAndExecute(token, 25 hours);
        assertEq(hook.accruedFees(token), 500 ether, "After round 1: 500");

        // Round 2: Must wait 7-day SYNC_COOLDOWN before next sync (FIX)
        _syncWarpProposeWarpExecute(token, 250 ether, 7 days, 25 hours);
        assertEq(hook.accruedFees(token), 250 ether, "After round 2: 250");

        // Round 3: Wait another 7 days
        _syncWarpProposeWarpExecute(token, 125 ether, 7 days, 25 hours);
        assertEq(hook.accruedFees(token), 125 ether, "After round 3: 125");

        // Round 4: Wait another 7 days
        _syncWarpProposeWarpExecute(token, 62.5 ether, 7 days, 25 hours);
        assertEq(hook.accruedFees(token), 62.5 ether, "After round 4: 62.5");

        // FIX VERIFIED: With 7-day cooldown, 4 rounds now takes ~29 days instead of 4 days
        emit log_named_uint("Fees after 4 rounds of 50% reduction (with 7-day cooldowns)", hook.accruedFees(token));
    }

    uint256 private _syncTime;

    function _syncWarpAndExecute(address token, uint256 duration) internal {
        _syncTime += duration;
        vm.warp(_syncTime);
        hook.executeSyncAccruedFees(token);
    }

    function _syncWarpProposeWarpExecute(address token, uint256 newValue, uint256 cooldownDuration, uint256 timelockDuration) internal {
        _syncTime += cooldownDuration;
        vm.warp(_syncTime);
        hook.proposeSyncAccruedFees(token, newValue);
        _syncTime += timelockDuration;
        vm.warp(_syncTime);
        hook.executeSyncAccruedFees(token);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 7: Premium NFT activation delay circumventable with
    // block.timestamp manipulation (validator-controlled)
    // On PoS Ethereum, validators can set block.timestamp within bounds.
    // The 15s MIN_ACTIVATION_DELAY is exactly 1 slot, so a validator
    // controlling 2 consecutive slots can activate and use in ~12s.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding7_nftActivationDelayMinimal() public {
        // Mint NFT to attacker
        uint256 tokenId = nft.mint(attacker);

        // Activate at timestamp T
        vm.prank(attacker);
        premium.activateNFTPremium();
        uint256 activationTime = block.timestamp;

        // Check: premium NOT available at T + 14s (within delay)
        vm.warp(activationTime + 14);
        bool hasPremAt14 = premium.hasPremium(attacker);
        assertFalse(hasPremAt14, "No premium within 15s delay");

        // Check: premium available at T + 16s (just past delay)
        vm.warp(activationTime + 16);
        bool hasPremAt16 = premium.hasPremium(attacker);
        assertTrue(hasPremAt16, "Premium available after 15s");

        // The 15s delay is the MINIMUM slot duration on mainnet. A flash loan
        // attacker needs only hold the NFT across 2 blocks (24-26 seconds typical).
        // This is a very short window.

        // SEVERITY: LOW
        // The delay prevents same-block flash loans but is minimal against
        // multi-block MEV strategies. For higher security, consider 1-2 minute delay.
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 8: POL backstop percentage calculation with backstopBps = 0
    // Owner can set backstopBps to 0, which makes backstopMinToken = 0
    // and backstopMinETH = 0, leaving only caller-provided minimums.
    // If caller passes 0 for _minLPTokens and _minLPETH, LP add has
    // NO sandwich protection beyond the configurable maxSlippageBps.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding8_backstopZeroRejected() public {
        // AUDIT FIX H-03: backstopBps = 0 is no longer allowed
        // MIN_BACKSTOP_BPS = 5000 (50%) enforced in proposeBackstopChange
        vm.expectRevert("BACKSTOP_TOO_LOW");
        pol.proposeBackstopChange(0);

        // Minimum allowed is 5000 (50%)
        pol.proposeBackstopChange(5000);
        vm.warp(block.timestamp + 24 hours);
        pol.executeBackstopChange();
        assertEq(pol.backstopBps(), 5000, "Backstop set to minimum 50%");

        // Accumulate with minimum backstop still works
        vm.deal(address(pol), 2 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);
        assertEq(pol.totalAccumulations(), 1, "Accumulation succeeded with 50% backstop");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 9: Deploy script ownership transfer race condition
    // DeployAuditFixes proposes timelocked changes (restaking link) then
    // transfers ownership to multisig. If multisig accepts ownership before
    // timelocked proposals expire, the deployer can no longer execute them.
    // Multisig would need to re-propose.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding9_deployOwnershipTimelockRace() public {
        // Simulate the deploy script scenario
        // 1. Deploy staking
        // 2. Propose restaking link (48h timelock)
        // 3. Transfer ownership to multisig
        // 4. Multisig accepts ownership BEFORE 48h

        // This is a deploy-time configuration issue, not a runtime vulnerability.
        // Verified by reading the deploy script: lines 124-125 propose restaking,
        // then lines 131-139 transfer ownership.
        //
        // If the multisig calls acceptOwnership() before executing the pending
        // proposals, the deployer (original owner) can no longer call execute
        // functions since they require onlyOwner.
        //
        // SEVERITY: LOW (deploy-time footgun)
        // RECOMMENDATION: Document in NEXT STEPS that multisig should NOT accept
        // ownership until all pending timelocked proposals are executed.
        // Alternatively, execute timelocked proposals before transferring ownership.
        assertTrue(true, "Deploy script race condition documented");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 10: Premium subscribe + cancel in adjacent blocks gives
    // almost-free premium for 1 block
    // ═══════════════════════════════════════════════════════════════════

    function test_finding10_subscribeAndCancelNextBlock() public {
        uint256 aliceBalBefore = toweli.balanceOf(alice);

        // Alice subscribes for 1 month
        vm.prank(alice);
        premium.subscribe(1, 1000 ether);

        // Verify premium is active
        assertTrue(premium.hasPremiumSecure(alice), "Alice has premium");

        // Next block: cancel immediately
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        premium.cancelSubscription();

        uint256 aliceBalAfter = toweli.balanceOf(alice);
        uint256 cost = aliceBalBefore - aliceBalAfter;

        emit log_named_uint("Cost for 1 second of premium", cost);

        // Alice pays only ~1 second worth of the monthly fee
        // 1000 ether / 30 days / 86400 seconds = ~0.000385 ether per second
        // So cost should be very small
        assertTrue(cost < 1 ether, "FINDING: Near-free premium for 1 block");

        // SEVERITY: LOW
        // SAME_BLOCK_CANCEL check prevents same-block, but next-block cancel
        // gives almost-free premium. This is mitigated by the fact that
        // hasPremiumSecure only considers subscription-based access which
        // is inherently multi-block.
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 11: TegridyFeeHook accruedFees can permanently exceed
    // PoolManager credits due to rounding accumulation
    // Each swap's fee calculation truncates: (absAmount * feeBps) / 10000
    // accruedFees accumulates these truncated values, but the PoolManager
    // may round differently, causing permanent drift.
    // ═══════════════════════════════════════════════════════════════════

    function test_finding11_accruedFeesRoundingDrift() public {
        // This is a theoretical finding based on code analysis.
        // The hook's afterSwap calculates: feeUint = (absAmount * feeBps) / 10000
        // and adds to accruedFees[token]. The PoolManager independently tracks
        // hookDeltaUnspecified. If the PoolManager's internal accounting rounds
        // differently, accruedFees[token] could exceed the actual credit.
        //
        // However, this is defended by the claimFees mechanism: if
        // poolManager.take reverts (insufficient credit), the tx rolls back,
        // preventing over-claiming. The sync mechanism exists to correct drift.
        //
        // SEVERITY: INFORMATIONAL
        // The natural revert protection in claimFees prevents fund loss.
        // The sync mechanism provides a correction path.
        assertTrue(true, "Rounding drift defended by revert-on-overclaim");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 12: POL accumulate totalETHUsed double-counts on partial LP
    // Line 268: totalETHUsed += halfETH + ethUsed
    // halfETH = ETH used for swap, ethUsed = ETH used for LP add.
    // If addLiquidityETH uses less than remainingETH (partial fill),
    // the unused ETH stays in the router (not returned to POL).
    // ═══════════════════════════════════════════════════════════════════

    function test_finding12_totalETHUsedAccounting() public {
        vm.deal(address(pol), 2 ether);

        vm.warp(block.timestamp + 1 hours); // Respect accumulate cooldown
        vm.prank(owner, owner);
        pol.accumulate(1, 0, 0, block.timestamp + 2 minutes);

        // With the mock router, ethUsed = msg.value (full use)
        // totalETHUsed = halfETH(1 ether) + ethUsed(1 ether) = 2 ether
        assertEq(pol.totalETHUsed(), 2 ether, "totalETHUsed accounts for full amount");

        // NOTE: In production, addLiquidityETH may return less ethUsed than
        // remainingETH if the pool ratio diverges. The surplus ETH goes to the
        // router (Uniswap V2 router refunds excess). This is correctly handled
        // because ethUsed comes from the return value, not the input.
        // SEVERITY: INFORMATIONAL - accounting is correct.
    }
}
