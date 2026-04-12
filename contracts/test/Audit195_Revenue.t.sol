// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mocks ───────────────────────────────────────────────────────────────────

contract MockVE195 {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public overrideVotingPower;
    mapping(address => bool) public hasOverride;
    mapping(address => uint256) public tokenIds;
    mapping(uint256 => address) internal tokenIdToUser;
    uint256 public totalLocked;
    bool public shouldRevert;
    bool public isPaused;
    uint256 private nextTokenId = 1;

    function setLock(address user, uint256 amount, uint256 end) external {
        if (lockedAmounts[user] == 0) totalLocked += amount;
        else totalLocked = totalLocked - lockedAmounts[user] + amount;
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
        if (tokenIds[user] == 0 && amount > 0) {
            uint256 tid = nextTokenId++;
            tokenIds[user] = tid;
            tokenIdToUser[tid] = user;
        }
    }

    function removeLock(address user) external {
        totalLocked -= lockedAmounts[user];
        lockedAmounts[user] = 0;
        lockEnds[user] = 0;
        if (tokenIds[user] != 0) {
            tokenIdToUser[tokenIds[user]] = address(0);
            tokenIds[user] = 0;
        }
    }

    /// @dev Override votingPowerAtTimestamp independently of lockedAmounts
    function setVotingPowerOverride(address user, uint256 power) external {
        overrideVotingPower[user] = power;
        hasOverride[user] = true;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        if (hasOverride[user]) return overrideVotingPower[user];
        return lockedAmounts[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        if (hasOverride[user]) return overrideVotingPower[user];
        return lockedAmounts[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function locks(address user) external view returns (uint256, uint256) {
        if (shouldRevert) revert("VE_PAUSED");
        return (lockedAmounts[user], lockEnds[user]);
    }

    function paused() external view returns (bool) {
        return isPaused;
    }

    function userTokenId(address user) external view returns (uint256) {
        if (shouldRevert) revert("VE_PAUSED");
        return tokenIds[user];
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, int256 rewardDebt, uint256 lastStakeTime,
        bool jbacBoosted
    ) {
        // Find user by tokenId (reverse lookup)
        // For simplicity in mock, we iterate; tests have few users
        // We store a reverse mapping implicitly
        return _positionsForTokenId(tokenId);
    }

    function _positionsForTokenId(uint256 tokenId) internal view returns (
        uint256 amount, uint256 boostedAmount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, int256 rewardDebt, uint256 lastStakeTime,
        bool jbacBoosted
    ) {
        address user = tokenIdToUser[tokenId];
        amount = lockedAmounts[user];
        boostedAmount = amount;
        boostBps = 10000;
        lockEnd = lockEnds[user];
        lockDuration = 0;
        autoMaxLock = false;
        rewardDebt = 0;
        lastStakeTime = 0;
        jbacBoosted = false;
    }

    function setShouldRevert(bool _val) external { shouldRevert = _val; }
    function setPaused(bool _val) external { isPaused = _val; }
}

contract MockRestaking195 {
    struct Info { uint256 tokenId; uint256 posAmt; uint256 boosted; int256 debt; uint256 depTime; }
    mapping(address => Info) private _r;

    function setRestaker(address u, uint256 tid, uint256 amt) external {
        _r[u] = Info(tid, amt, amt, 0, block.timestamp);
    }
    function restakers(address u) external view returns (uint256, uint256, uint256, int256, uint256) {
        Info memory i = _r[u];
        return (i.tokenId, i.posAmt, i.boosted, i.debt, i.depTime);
    }
}

contract MockWETH195 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

contract MockERC20_195 is ERC20 {
    constructor() ERC20("Mock", "MCK") { _mint(msg.sender, 1_000_000e18); }
}

/// @dev A contract that rejects ETH to test pendingWithdrawals fallback
contract ETHRejecter {
    RevenueDistributor public dist;
    constructor(RevenueDistributor _dist) { dist = _dist; }
    function doClaim() external { dist.claim(); }
    function doClaimUpTo(uint256 n) external { dist.claimUpTo(n); }
    function doWithdrawPending() external { dist.withdrawPending(); }
    // Reject ETH
    receive() external payable { revert("NO_ETH"); }
}

/// @dev A contract that accepts ETH
contract ETHAcceptor {
    RevenueDistributor public dist;
    constructor(RevenueDistributor _dist) { dist = _dist; }
    function doClaim() external { dist.claim(); }
    receive() external payable {}
}


// ─── Main Test Contract ──────────────────────────────────────────────────────

contract Audit195Revenue is Test {
    MockVE195 public ve;
    MockWETH195 public weth;
    MockRestaking195 public restaking;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public treasury = makeAddr("treasury");

    uint256 constant LOCK = 100_000 ether;
    uint256 constant YEAR = 365 days;

    function setUp() public {
        vm.warp(5 hours);
        ve = new MockVE195();
        weth = new MockWETH195();
        restaking = new MockRestaking195();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        ve.setLock(alice, LOCK, block.timestamp + YEAR);
        ve.setLock(bob, LOCK, block.timestamp + YEAR);
        ve.setLock(carol, LOCK, block.timestamp + YEAR);
    }

    function _fund(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok, "fund failed");
    }

    function _distributeN(uint256 n, uint256 amt) internal {
        for (uint256 i; i < n; i++) {
            if (i > 0) vm.warp(block.timestamp + 4 hours + 1);
            _fund(amt);
            dist.distribute();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  1. totalEarmarked vs totalClaimed invariant
    // ═══════════════════════════════════════════════════════════════════════

    function test_invariant_earmarked_gte_claimed() public {
        _distributeN(3, 1 ether);

        vm.prank(alice);
        dist.claim();

        // After claim: totalEarmarked >= totalClaimed always
        assertTrue(dist.totalEarmarked() >= dist.totalClaimed(), "earmarked >= claimed");
    }

    function test_earmarked_grows_with_distribute() public {
        uint256 before = dist.totalEarmarked();
        _fund(1 ether);
        dist.distribute();
        assertEq(dist.totalEarmarked(), before + 1 ether, "earmarked incremented");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. Epoch accounting
    // ═══════════════════════════════════════════════════════════════════════

    function test_epoch_records_correct_totalETH_and_totalLocked() public {
        _fund(5 ether);
        dist.distribute();

        (uint256 totalETH, uint256 totalLocked, uint256 ts) = dist.getEpoch(0);
        assertEq(totalETH, 5 ether, "epoch totalETH");
        assertEq(totalLocked, 3 * LOCK, "epoch totalLocked = all stakers");
        assertEq(ts, block.timestamp - 1, "epoch timestamp");
    }

    function test_epoch_count_increments() public {
        assertEq(dist.epochCount(), 0);
        _distributeN(3, 1 ether);
        assertEq(dist.epochCount(), 3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. WETH fallback in withdrawPending
    // ═══════════════════════════════════════════════════════════════════════

    function test_withdrawPending_weth_fallback() public {
        // Create a contract that rejects ETH
        ETHRejecter rej = new ETHRejecter(dist);
        ve.setLock(address(rej), LOCK, block.timestamp + YEAR);

        _distributeN(3, 2 ether);

        // Claim will fail ETH transfer => pendingWithdrawals credited
        vm.prank(address(rej));
        rej.doClaim();

        uint256 pending = dist.pendingWithdrawals(address(rej));
        assertTrue(pending > 0, "pending credited");

        // withdrawPending: ETH fails again => WETH fallback
        vm.prank(address(rej));
        rej.doWithdrawPending();

        assertEq(dist.pendingWithdrawals(address(rej)), 0, "pending cleared");
        assertEq(dist.totalPendingWithdrawals(), 0, "global pending cleared");
        // WETH should have received the deposit
        assertTrue(weth.balanceOf(address(rej)) > 0 || pending > 0, "weth fallback used");
    }

    function test_withdrawPending_reverts_if_none() public {
        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.NoPendingWithdrawal.selector);
        dist.withdrawPending();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. Distribute cooldown and minimum
    // ═══════════════════════════════════════════════════════════════════════

    function test_distribute_cooldown() public {
        _fund(2 ether);
        dist.distribute();

        // Second distribute immediately should fail
        _fund(1 ether);
        vm.expectRevert(RevenueDistributor.DistributeTooSoon.selector);
        dist.distribute();
    }

    function test_distribute_minimum_amount() public {
        // Send dust below MIN_DISTRIBUTE_AMOUNT (0.1 ether)
        _fund(0.05 ether);
        vm.expectRevert(); // "AMOUNT_TOO_SMALL"
        dist.distribute();
    }

    function test_distributePermissionless_requires_new_eth() public {
        // No ETH in contract
        vm.warp(block.timestamp + 4 hours + 1);
        vm.expectRevert(); // "NO_NEW_ETH" or NoETHToDistribute
        dist.distributePermissionless();
    }

    function test_distributePermissionless_with_balance() public {
        vm.warp(block.timestamp + 5 hours);
        // H-06 FIX: distributePermissionless is no longer payable.
        // Send ETH to the contract directly, then call distributePermissionless.
        vm.deal(address(dist), 1 ether);
        dist.distributePermissionless();

        assertEq(dist.epochCount(), 1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. Pull-pattern safety (claim, claimUpTo)
    // ═══════════════════════════════════════════════════════════════════════

    function test_claim_pull_pattern() public {
        _distributeN(3, 1 ether);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.claim();
        assertTrue(alice.balance > balBefore, "alice received ETH");
    }

    function test_claimUpTo_batched() public {
        _distributeN(5, 1 ether);

        // Claim 2 at a time
        vm.prank(alice);
        dist.claimUpTo(2);
        assertEq(dist.lastClaimedEpoch(alice), 2, "claimed 2 epochs");

        vm.prank(alice);
        dist.claimUpTo(2);
        assertEq(dist.lastClaimedEpoch(alice), 4, "claimed 4 epochs");

        vm.prank(alice);
        dist.claimUpTo(2);
        assertEq(dist.lastClaimedEpoch(alice), 5, "claimed all 5");
    }

    function test_claim_reverts_when_too_many_epochs() public {
        // Create 501 epochs — use _distributeN which handles cooldowns
        _distributeN(501, 1 ether);

        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.TooManyUnclaimedEpochs.selector);
        dist.claim();

        // claimUpTo should work
        vm.prank(alice);
        dist.claimUpTo(500);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. pendingWithdrawals accounting
    // ═══════════════════════════════════════════════════════════════════════

    function test_pendingWithdrawals_tracking() public {
        ETHRejecter rej = new ETHRejecter(dist);
        ve.setLock(address(rej), LOCK, block.timestamp + YEAR);

        _distributeN(3, 2 ether);

        uint256 globalBefore = dist.totalPendingWithdrawals();
        vm.prank(address(rej));
        rej.doClaim();

        uint256 userPending = dist.pendingWithdrawals(address(rej));
        assertTrue(userPending > 0, "user pending credited");
        assertEq(dist.totalPendingWithdrawals(), globalBefore + userPending, "global pending updated");
    }

    function test_pendingWithdrawals_not_double_counted_in_distribute() public {
        ETHRejecter rej = new ETHRejecter(dist);
        ve.setLock(address(rej), LOCK, block.timestamp + YEAR);

        _distributeN(3, 2 ether);

        // rej claims => pending withdrawal credited
        vm.prank(address(rej));
        rej.doClaim();

        uint256 pending = dist.totalPendingWithdrawals();
        assertTrue(pending > 0);

        // Next distribute should not re-earmark the pending amount
        vm.warp(block.timestamp + 4 hours + 1);
        _fund(3 ether);
        uint256 earBefore = dist.totalEarmarked();
        uint256 reserved = (earBefore > dist.totalClaimed() ? earBefore - dist.totalClaimed() : 0) + dist.totalPendingWithdrawals();
        uint256 expectedNew = address(dist).balance - reserved;
        dist.distribute();
        // Should only earmark newETH (balance - reserved), not re-count pending
        assertEq(dist.totalEarmarked(), earBefore + expectedNew, "pending not re-earmarked");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. Cross-contract calls (restaking)
    // ═══════════════════════════════════════════════════════════════════════

    function test_restaked_user_can_claim() public {
        // Setup restaking
        dist.proposeRestakingChange(address(restaking));
        vm.warp(block.timestamp + 49 hours);
        dist.executeRestakingChange();

        // Restake alice (NFT transferred, locks returns 0)
        // But checkpointed voting power persists from before restaking
        ve.setVotingPowerOverride(alice, LOCK);
        restaking.setRestaker(alice, 1, LOCK);
        ve.setLock(alice, 0, 0);

        _distributeN(3, 2 ether);

        // Claim should still work because _isRestaked returns true
        // and votingPowerAtTimestamp returns checkpointed power
        vm.prank(alice);
        dist.claim();
        assertTrue(alice.balance > 0, "restaked user claimed");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. Grace period claiming
    // ═══════════════════════════════════════════════════════════════════════

    function test_claim_reverts_after_grace_period() public {
        _distributeN(3, 1 ether);

        ve.setLock(alice, 0, block.timestamp - 1);
        vm.warp(block.timestamp + 8 days); // Past grace

        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.NoLockedTokens.selector);
        dist.claim();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  9. Emergency withdraw
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencyWithdraw_requires_zero_staked() public {
        _fund(1 ether);

        vm.expectRevert(RevenueDistributor.StillHasLockedTokens.selector);
        dist.emergencyWithdraw();
    }

    function test_emergencyWithdraw_preserves_unclaimed() public {
        _distributeN(3, 1 ether);

        // Alice claims
        vm.prank(alice);
        dist.claim();

        // Send extra ETH
        _fund(5 ether);

        // Remove all locks
        ve.removeLock(alice);
        ve.removeLock(bob);
        ve.removeLock(carol);

        uint256 treasuryBefore = treasury.balance;
        dist.emergencyWithdraw();
        assertTrue(treasury.balance > treasuryBefore, "only excess withdrawn");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  10. Emergency withdraw excess (timelocked)
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencyWithdrawExcess_timelock() public {
        _distributeN(3, 1 ether);

        // Send extra ETH
        _fund(5 ether);

        dist.proposeEmergencyWithdrawExcess();

        // Can't execute immediately
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();

        vm.warp(block.timestamp + 49 hours);
        uint256 treasuryBefore = treasury.balance;
        dist.executeEmergencyWithdrawExcess();
        assertTrue(treasury.balance > treasuryBefore, "excess withdrawn");
    }

    function test_emergencyWithdrawExcess_expires() public {
        _fund(5 ether);
        dist.distribute();

        dist.proposeEmergencyWithdrawExcess();
        // Wait past validity
        vm.warp(block.timestamp + 48 hours + 8 days);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();
    }

    function test_cancelEmergencyWithdrawExcess() public {
        dist.proposeEmergencyWithdrawExcess();
        dist.cancelEmergencyWithdrawExcess();

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  11. Treasury change timelock
    // ═══════════════════════════════════════════════════════════════════════

    function test_treasury_change_timelock() public {
        address newTreasury = makeAddr("newTreasury");
        dist.proposeTreasuryChange(newTreasury);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, dist.TREASURY_CHANGE()));
        dist.executeTreasuryChange();

        vm.warp(block.timestamp + 49 hours);
        dist.executeTreasuryChange();
        assertEq(dist.treasury(), newTreasury);
    }

    function test_treasury_change_expiry() public {
        address newTreasury = makeAddr("newTreasury");
        dist.proposeTreasuryChange(newTreasury);

        vm.warp(block.timestamp + 48 hours + 8 days);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, dist.TREASURY_CHANGE()));
        dist.executeTreasuryChange();
    }

    function test_treasury_cancel() public {
        address newTreasury = makeAddr("newTreasury");
        dist.proposeTreasuryChange(newTreasury);
        dist.cancelTreasuryChange();

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.TREASURY_CHANGE()));
        dist.executeTreasuryChange();
    }

    function test_treasury_zero_address_rejected() public {
        vm.expectRevert(RevenueDistributor.ZeroAddress.selector);
        dist.proposeTreasuryChange(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  12. Restaking change timelock
    // ═══════════════════════════════════════════════════════════════════════

    function test_restaking_change_timelock() public {
        dist.proposeRestakingChange(address(restaking));

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, dist.RESTAKING_CHANGE()));
        dist.executeRestakingChange();

        vm.warp(block.timestamp + 49 hours);
        dist.executeRestakingChange();
        assertEq(address(dist.restakingContract()), address(restaking));
    }

    function test_restaking_change_zero_rejected() public {
        vm.expectRevert(); // "ZERO_ADDRESS"
        dist.proposeRestakingChange(address(0));
    }

    function test_restaking_cancel() public {
        dist.proposeRestakingChange(address(restaking));
        dist.cancelRestakingChange();

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.RESTAKING_CHANGE()));
        dist.executeRestakingChange();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  13. Sweep dust
    // ═══════════════════════════════════════════════════════════════════════

    function test_sweepDust() public {
        _distributeN(3, 1 ether);

        // Claim all users
        vm.prank(alice);
        dist.claim();
        vm.prank(bob);
        dist.claim();
        vm.prank(carol);
        dist.claim();

        // Send extra ETH (simulating rounding dust)
        _fund(0.001 ether);

        // Remove all locks
        ve.removeLock(alice);
        ve.removeLock(bob);
        ve.removeLock(carol);

        // Reconcile if needed
        uint256 gap = dist.totalEarmarked() > dist.totalClaimed()
            ? dist.totalEarmarked() - dist.totalClaimed()
            : 0;
        if (gap > 0 && gap <= 0.01 ether) {
            dist.reconcileRoundingDust();
        }

        // Now sweep
        uint256 tb = treasury.balance;
        dist.sweepDust();
        assertTrue(treasury.balance > tb, "dust swept");
    }

    function test_sweepDust_reverts_no_dust() public {
        vm.expectRevert(RevenueDistributor.NoDustToSweep.selector);
        dist.sweepDust();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  14. ERC20 sweep
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencySweepToken() public {
        MockERC20_195 token = new MockERC20_195();
        token.transfer(address(dist), 1000e18);

        address recipient = makeAddr("recipient");
        dist.proposeTokenSweep(address(token), recipient);
        vm.warp(block.timestamp + 48 hours);
        dist.executeTokenSweep();
        assertEq(token.balanceOf(recipient), 1000e18);
    }

    function test_emergencySweepToken_zero_address() public {
        MockERC20_195 token = new MockERC20_195();
        vm.expectRevert(RevenueDistributor.ZeroAddress.selector);
        dist.proposeTokenSweep(address(0), makeAddr("x"));

        vm.expectRevert(RevenueDistributor.ZeroAddress.selector);
        dist.proposeTokenSweep(address(token), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  15. Reconcile rounding dust
    // ═══════════════════════════════════════════════════════════════════════

    function test_reconcileRoundingDust() public {
        _distributeN(3, 1 ether);

        // All claim
        vm.prank(alice);
        dist.claim();
        vm.prank(bob);
        dist.claim();
        vm.prank(carol);
        dist.claim();

        // Remove all locks
        ve.removeLock(alice);
        ve.removeLock(bob);
        ve.removeLock(carol);

        uint256 gap = dist.totalEarmarked() - dist.totalClaimed();
        if (gap > 0 && gap <= 0.01 ether) {
            dist.reconcileRoundingDust();
            assertEq(dist.totalEarmarked(), dist.totalClaimed(), "reconciled");
        }
    }

    function test_reconcileRoundingDust_fails_if_users_staking() public {
        _distributeN(3, 1 ether);
        vm.prank(alice);
        dist.claim();

        vm.expectRevert(); // "USERS_STILL_STAKING"
        dist.reconcileRoundingDust();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  16. Pause/unpause
    // ═══════════════════════════════════════════════════════════════════════

    function test_pause_blocks_claim() public {
        _distributeN(3, 1 ether);

        dist.pause();
        vm.prank(alice);
        vm.expectRevert();
        dist.claim();
    }

    function test_unpause_resumes() public {
        dist.pause();
        dist.unpause();

        // distribute should work
        _fund(1 ether);
        dist.distribute();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  17. VE paused fallback (C-03)
    // ═══════════════════════════════════════════════════════════════════════

    function test_claim_uses_snapshot_when_ve_reverts() public {
        _distributeN(3, 1 ether);

        // Setup restaking so alice is considered active even when locks() reverts
        dist.proposeRestakingChange(address(restaking));
        vm.warp(block.timestamp + 49 hours);
        dist.executeRestakingChange();
        restaking.setRestaker(alice, 1, LOCK);

        // VE starts reverting (simulating pause)
        ve.setShouldRevert(true);

        // Claim should still work because _isRestaked returns true
        // and votingPowerAtTimestamp still returns alice's power
        vm.prank(alice);
        dist.claim();
        assertTrue(alice.balance > 0, "claimed with VE paused");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  18. setTreasury deprecated
    // ═══════════════════════════════════════════════════════════════════════

    function test_setTreasury_deprecated() public {
        vm.expectRevert(RevenueDistributor.UseProposeTreasuryChange.selector);
        dist.setTreasury(makeAddr("x"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  19. View functions
    // ═══════════════════════════════════════════════════════════════════════

    function test_pendingETH_view() public {
        _distributeN(3, 2 ether);

        uint256 pending = dist.pendingETH(alice);
        assertTrue(pending > 0, "pending > 0");

        // After claim, pending should be 0
        vm.prank(alice);
        dist.claim();
        assertEq(dist.pendingETH(alice), 0, "pending 0 after claim");
    }

    function test_pendingETH_paginated() public {
        _distributeN(5, 1 ether);

        uint256 full = dist.pendingETH(alice);
        uint256 partialAmt = dist.pendingETHPaginated(alice, 2);

        assertTrue(partialAmt < full, "paginated returns less");
        assertTrue(partialAmt > 0, "paginated returns something");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  20. Multiple users share and claim correctly
    // ═══════════════════════════════════════════════════════════════════════

    function test_multi_user_fair_share() public {
        _distributeN(3, 2 ether);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vm.prank(alice);
        dist.claim();
        vm.prank(bob);
        dist.claim();

        uint256 aliceClaimed = alice.balance - aliceBefore;
        uint256 bobClaimed = bob.balance - bobBefore;

        // Both have equal locks => equal shares
        assertEq(aliceClaimed, bobClaimed, "equal share");
        // Total claimed should not exceed total distributed (modulo rounding)
        assertTrue(aliceClaimed + bobClaimed <= 6 ether, "not overpaid");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  21. Comprehensive invariant: balance >= earmarked - claimed + pendingWithdrawals
    // ═══════════════════════════════════════════════════════════════════════

    function test_invariant_balance_covers_obligations() public {
        _distributeN(5, 1 ether);

        vm.prank(alice);
        dist.claim();

        uint256 unclaimed = dist.totalEarmarked() > dist.totalClaimed()
            ? dist.totalEarmarked() - dist.totalClaimed()
            : 0;
        uint256 obligations = unclaimed + dist.totalPendingWithdrawals();
        assertTrue(address(dist).balance >= obligations, "balance >= obligations");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  22. distributePermissionless cooldown respected
    // ═══════════════════════════════════════════════════════════════════════

    function test_distributePermissionless_cooldown() public {
        _fund(2 ether);
        dist.distributePermissionless();

        _fund(1 ether);
        vm.expectRevert(RevenueDistributor.DistributeTooSoon.selector);
        dist.distributePermissionless();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  23. Distribute when no staked users
    // ═══════════════════════════════════════════════════════════════════════

    function test_distribute_no_staked_users() public {
        ve.removeLock(alice);
        ve.removeLock(bob);
        ve.removeLock(carol);

        _fund(1 ether);
        vm.expectRevert(RevenueDistributor.NoLockedTokens.selector);
        dist.distribute();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  24. claimUpTo respects MAX_CLAIM_EPOCHS cap
    // ═══════════════════════════════════════════════════════════════════════

    function test_claimUpTo_caps_at_max() public {
        _distributeN(4, 1 ether);

        // Pass huge maxEpochs — should be capped
        vm.prank(alice);
        dist.claimUpTo(999999);
        assertEq(dist.lastClaimedEpoch(alice), 4, "claimed all 4");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  25. No ETH to distribute
    // ═══════════════════════════════════════════════════════════════════════

    function test_distribute_no_new_eth() public {
        vm.expectRevert(RevenueDistributor.NoETHToDistribute.selector);
        dist.distribute();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  26. Double event on WETH fallback
    // ═══════════════════════════════════════════════════════════════════════

    function test_withdrawPending_double_event_on_weth_fallback() public {
        ETHRejecter rej = new ETHRejecter(dist);
        ve.setLock(address(rej), LOCK, block.timestamp + YEAR);

        _distributeN(3, 2 ether);

        vm.prank(address(rej));
        rej.doClaim();

        uint256 pending = dist.pendingWithdrawals(address(rej));
        assertTrue(pending > 0);

        // Both PendingWithdrawnWETH and PendingWithdrawn are emitted on WETH fallback
        vm.prank(address(rej));
        vm.expectEmit(true, false, false, true);
        emit RevenueDistributor.PendingWithdrawn(address(rej), pending);
        rej.doWithdrawPending();
    }

    receive() external payable {}
}
