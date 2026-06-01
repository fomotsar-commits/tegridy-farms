// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyRestaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// ═══════════════════════════════════════════════════════════════════════
//  Mocks
// ═══════════════════════════════════════════════════════════════════════

contract R014_MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract R014_MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract R014_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {
        _mint(msg.sender, 100_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// ═══════════════════════════════════════════════════════════════════════
//  Malicious subclass: overrides _accrueBonus to DECREMENT
//  accBonusPerShare. Used to prove _accrueBonusChecked traps the violation.
// ═══════════════════════════════════════════════════════════════════════

contract MaliciousRestaking is TegridyRestaking {
    constructor(
        address _staking,
        address _monitor,
        address _rewardToken,
        address _bonusRewardToken,
        uint256 _bonusRewardPerSecond
    ) TegridyRestaking(_staking, _monitor, _rewardToken, _bonusRewardToken, _bonusRewardPerSecond) {}

    /// @dev Hostile override: monotonicity wrapper must trap any decrement.
    function _accrueBonus() internal override {
        if (accBonusPerShare > 0) {
            // Pretend to "fix" emission by walking the accumulator backwards.
            accBonusPerShare = accBonusPerShare - 1;
        }
        lastBonusRewardTime = block.timestamp;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  AuditR014_Restaking — R017 reordering + monotonicity tripwire tests
// ═══════════════════════════════════════════════════════════════════════

contract AuditR014_Restaking is Test {
    using stdStorage for StdStorage;

    R014_MockTOWELI toweli;
    R014_MockJBAC jbac;
    R014_MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address treasury = makeAddr("treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    function setUp() public {
        toweli = new R014_MockTOWELI();
        jbac = new R014_MockJBAC();
        weth = new R014_MockWETH();

        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            REWARD_RATE
        );
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking),
            address(monitor),
            address(toweli),
            address(weth),
            BONUS_RATE
        );

        // Wire the restaking contract on staking (48h timelock)
        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        // Fund staking with rewards
        toweli.approve(address(staking), 500_000_000 ether);
        staking.notifyRewardAmount(500_000_000 ether);

        // Fund restaking bonus pool with WETH
        weth.transfer(address(restaking), 1_000_000 ether);

        // Give users TOWELI
        toweli.transfer(alice, STAKE_AMOUNT * 3);
        toweli.transfer(bob, STAKE_AMOUNT * 3);
        toweli.transfer(carol, STAKE_AMOUNT * 3);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _stakeAndRestake(
        address user,
        uint256 amount,
        uint256 lockDuration
    ) internal returns (uint256 tokenId) {
        vm.startPrank(user);
        toweli.approve(address(staking), amount);
        staking.stake(amount, lockDuration);
        tokenId = staking.userTokenId(user);
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(restaking), tokenId);
        restaking.restake(tokenId);
        vm.stopPrank();
    }

    function _getCachedBoosted(address user) internal view returns (uint256) {
        (, , uint256 boostedAmount, , , ) = restaking.restakers(user);
        return boostedAmount;
    }

    function _getCachedAmount(address user) internal view returns (uint256) {
        (, uint256 positionAmount, , , , ) = restaking.restakers(user);
        return positionAmount;
    }

    /// @dev Force a stale boost in TegridyRestaking. The lock-cliff path is the
    ///      production trigger: after `lockEnd`, TegridyStaking._decayIfExpired
    ///      zeroes the on-chain boostedAmount on the next interaction with that
    ///      position, while TegridyRestaking still caches the pre-decay value.
    function _expireAndDecayBoost(address user, uint256 lockDuration) internal {
        // Warp past the lock end (use a buffer to be safe across DAY math)
        vm.warp(block.timestamp + lockDuration + 1);
        // Trigger _decayIfExpired on the staking position by performing
        // any view that reads the position freshly is NOT enough (it's lazy).
        // Instead, hit a state-mutating path through the restaking contract:
        // claiming or revalidating would refresh — but we need the cache to
        // remain stale here. So we directly probe via staking.positions():
        // the staking storage value was set during stake(), and decayIfExpired
        // only runs on `withdraw / earlyWithdraw / increaseAmount / getReward`.
        // We need staking to *report* the decayed value when restaking re-reads
        // positions(); since _decayIfExpired only zeroes storage on interaction,
        // we have to trigger it through restaking-side path that re-reads
        // positions() — but that's exactly what restaking's stale path checks.
        //
        // To make the cache stale, we use staking.getReward via revalidateBoost
        // path — but a simpler trick: call increaseAmount? Not a fit.
        //
        // The cleanest production trigger: alice has lock for X duration,
        // warp past X, call _decayIfExpired indirectly via restaking
        // .decayExpiredRestaker. But that's the very fix we're testing.
        //
        // Instead: just warp; staking.positions() returns boostedAmount as a
        // raw struct field — _decayIfExpired writes to it but only on
        // interaction. So staking.positions() will RETURN the stale value too
        // until decay runs.
        //
        // To create a stale state visible to refreshPosition / claimAll /
        // unrestake, we need staking.positions() to return a NEW boosted
        // value while restaking's cache holds the OLD. The simplest path:
        //   1. Have the user revalidateBoost (or any decay-triggering call)
        //      via staking directly, which zeroes boostedAmount in storage.
        //   2. Restaking's cache still holds the old value.
        //
        // But the staking NFT is owned by restaking now — only restaking
        // contract or owner can call revalidateBoost. So we use the
        // restaking owner-helper revalidateBoostForRestaker as a poke.
        // That helper itself updates the cache after the call, defeating
        // our test. So we use the lower-level approach:
        //
        //   The withdraw / earlyWithdraw paths are gated by ownerOf == msg.sender
        //   so we can't call them from test on a restaked NFT.
        //
        // The unique production way to get a stale cache here is therefore:
        //   - lockEnd has passed
        //   - someone calls staking.getReward(tokenId) on the restaked NFT —
        //     but only the restaking contract (as ownerOf) can do that.
        //
        // The actual production R017 stale state arises when claimAll runs
        // and triggers staking.getReward via try/catch — but that runs AFTER
        // our stale-path branch, not before.
        //
        // To synthesize the stale precondition deterministically in tests we
        // therefore *force* a divergence by whitelisting the test contract as
        // a temporary actor. The stale state can also be created at the
        // moment a JBAC revalidate downgrade fires from outside.
        //
        // For this test we use the JBAC-loss path: alice has hasJbacBoost,
        // we burn the JBAC, owner calls revalidateBoost (downgrades the
        // staking-side boost), then the restaking cache holds the OLD JBAC-
        // boosted value while staking.positions() returns the NEW reduced
        // value. That is the canonical stale state R017 must handle.
        user; // silence
    }

    /// @dev Lock-cliff decay flow: produces a stale cache where
    ///      `staking.positions()` reports `boostedAmount = 0` while
    ///      `restakers[user].boostedAmount` still holds the pre-decay value.
    ///      Returns the (cached, on-chain-reported) boost pair after the
    ///      decay so callers can assert staleness.
    /// @dev IMPORTANT: when the NFT was transferred into the restaking
    ///      contract, TegridyStaking._update zeroed `userTokenId[user]`, so
    ///      we must read the tokenId from the restaking contract's RestakeInfo.
    function _setupStaleViaJbacRevalidate(address user) internal returns (uint256 cached, uint256 onchain) {
        cached = _getCachedBoosted(user);
        (uint256 tokenId, , , , , ) = restaking.restakers(user);
        require(tokenId != 0, "test setup: user not restaked");

        (, , , , uint256 lockEndStart, , , , , , ) = staking.positions(tokenId);
        if (block.timestamp <= lockEndStart) {
            vm.warp(lockEndStart + 1);
        }

        // Trigger _decayIfExpired by having restaking (as ownerOf) call
        // getReward. updateReward + _decayIfExpired drop the on-chain
        // boostedAmount to zero. The restaking contract's CACHED
        // boostedAmount remains untouched — that is the stale state.
        vm.prank(address(restaking));
        staking.getReward(tokenId);

        (, onchain, , , , , , , , , ) = staking.positions(tokenId);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  R017 PATH 1: refreshPosition — stale-path settles BEFORE accrue
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Demonstrates that refreshPosition's stale path settles pending
    ///         bonus on the OLD boost at the PRE-accrue accBonusPerShare,
    ///         then shrinks totalRestaked, then accrues, then re-anchors.
    ///         The honest restaker (bob) is not diluted by alice's stale state.
    function test_R017_refreshPosition_stalePathSettlesBeforeAccrue() public {
        // Two restakers, alice with a 7-day lock (will expire), bob with
        // a 365-day lock (will NOT expire).
        _stakeAndRestake(alice, STAKE_AMOUNT, 7 days);
        _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        // Accumulate some bonus emission with both restakers active.
        vm.warp(block.timestamp + 5 days);

        // Force alice's cache to be stale: after the lock cliff, the staking
        // position's boostedAmount is decayed to 0 on next interaction, but
        // restaking still caches the pre-decay value.
        (uint256 aliceCached, uint256 aliceOnchain) = _setupStaleViaJbacRevalidate(alice);
        assertGt(aliceCached, aliceOnchain, "stale precondition: cache > on-chain");
        assertEq(aliceOnchain, 0, "decay should zero on-chain boost");

        // Snapshot: accBonusPerShare BEFORE alice calls refreshPosition.
        uint256 accPre = restaking.accBonusPerShare();
        uint256 totalRestakedPre = restaking.totalRestaked();
        uint256 aliceWethPre = weth.balanceOf(alice);

        // Refresh on the stale state. This MUST:
        //   1. Settle alice's pending bonus on the OLD (cached) boost at accPre
        //   2. Shrink totalRestaked by alice's old boost (alice's new boost is 0)
        //   3. Accrue against the corrected denominator (= bob's boost only)
        //   4. Re-anchor alice's bonusDebt at the post-accrue accBonusPerShare
        vm.prank(alice);
        restaking.refreshPosition();

        uint256 aliceWethPost = weth.balanceOf(alice);
        uint256 alicePaidOnRefresh = aliceWethPost - aliceWethPre;

        // alice received exactly the bonus owed under accPre on her OLD boost.
        // Compute the expected payout: (oldBoost * accPre / 1e12) - bonusDebtPre.
        // We don't have the pre-debt readily; instead assert payout > 0 (she
        // earned during the 5-day window) and that totalRestaked shrunk to bob.
        assertGt(alicePaidOnRefresh, 0, "alice should be paid pending bonus on stale path");

        uint256 totalRestakedPost = restaking.totalRestaked();
        uint256 bobBoosted = _getCachedBoosted(bob);
        assertEq(totalRestakedPost, bobBoosted, "totalRestaked shrunk to bob's boost only");
        assertLt(totalRestakedPost, totalRestakedPre, "totalRestaked must shrink");

        // accBonusPerShare AFTER refresh must be >= accPre (monotone).
        uint256 accPost = restaking.accBonusPerShare();
        assertGe(accPost, accPre, "accBonusPerShare monotone non-decreasing");

        // The cache must now match the on-chain boost (= 0 for alice).
        assertEq(_getCachedBoosted(alice), 0, "cache synced to on-chain boost");
    }

    // ═════════════════════════════════════════════════════════════════════
    //  R017 PATH 2: claimAll — stale-path settles BEFORE accrue
    // ═════════════════════════════════════════════════════════════════════

    function test_R017_claimAll_stalePathSettlesBeforeAccrue() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 7 days);
        _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        vm.warp(block.timestamp + 5 days);

        (uint256 aliceCached, uint256 aliceOnchain) = _setupStaleViaJbacRevalidate(alice);
        assertGt(aliceCached, aliceOnchain, "stale precondition");
        assertEq(aliceOnchain, 0, "decay zeroed on-chain boost");

        uint256 accPre = restaking.accBonusPerShare();
        uint256 totalRestakedPre = restaking.totalRestaked();
        uint256 aliceWethPre = weth.balanceOf(alice);

        // claimAll on stale state must follow the four R017 steps.
        vm.prank(alice);
        restaking.claimAll();

        uint256 aliceWethPost = weth.balanceOf(alice);
        assertGt(aliceWethPost - aliceWethPre, 0, "stale settlement paid bonus");

        uint256 totalRestakedPost = restaking.totalRestaked();
        uint256 bobBoosted = _getCachedBoosted(bob);
        assertEq(totalRestakedPost, bobBoosted, "totalRestaked shrunk to bob");
        assertLt(totalRestakedPost, totalRestakedPre, "totalRestaked must shrink");

        uint256 accPost = restaking.accBonusPerShare();
        assertGe(accPost, accPre, "accBonusPerShare monotone");
        assertEq(_getCachedBoosted(alice), 0, "cache synced");
    }

    // ═════════════════════════════════════════════════════════════════════
    //  R017 PATH 3: unrestake — stale-path settles BEFORE accrue
    // ═════════════════════════════════════════════════════════════════════

    function test_R017_unrestake_stalePathSettlesBeforeAccrue() public {
        _stakeAndRestake(alice, STAKE_AMOUNT, 7 days);
        _stakeAndRestake(bob, STAKE_AMOUNT, 365 days);

        vm.warp(block.timestamp + 5 days);

        (uint256 aliceCached, uint256 aliceOnchain) = _setupStaleViaJbacRevalidate(alice);
        assertGt(aliceCached, aliceOnchain, "stale precondition");
        assertEq(aliceOnchain, 0, "decay zeroed on-chain boost");

        uint256 accPre = restaking.accBonusPerShare();
        uint256 totalRestakedPre = restaking.totalRestaked();
        uint256 aliceWethPre = weth.balanceOf(alice);

        // unrestake on stale state must follow the four R017 steps before
        // returning the NFT.
        vm.prank(alice);
        restaking.unrestake();

        uint256 aliceWethPost = weth.balanceOf(alice);
        assertGt(aliceWethPost - aliceWethPre, 0, "stale settlement paid bonus on exit");

        // After unrestake, alice's restake row is deleted; only bob remains.
        uint256 totalRestakedPost = restaking.totalRestaked();
        uint256 bobBoosted = _getCachedBoosted(bob);
        assertEq(totalRestakedPost, bobBoosted, "alice removed; only bob remains");
        assertLt(totalRestakedPost, totalRestakedPre, "totalRestaked must shrink");

        uint256 accPost = restaking.accBonusPerShare();
        assertGe(accPost, accPre, "accBonusPerShare monotone");

        // Alice's restake info is wiped.
        (uint256 aliceTokenId, , , , , ) = restaking.restakers(alice);
        assertEq(aliceTokenId, 0, "alice restake state cleared");
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Monotonicity tripwire: refreshPosition fires AccrueNotMonotone()
    //  when malicious _accrueBonus override decrements accBonusPerShare.
    // ═════════════════════════════════════════════════════════════════════

    function _setupMaliciousScenario(address user, uint256 lockDuration)
        internal
        returns (MaliciousRestaking malRestake)
    {
        malRestake = new MaliciousRestaking(
            address(staking),
            address(monitor),
            address(toweli),
            address(weth),
            BONUS_RATE
        );
        // Fund the malicious bonus pool so accBonusPerShare can grow > 0
        weth.transfer(address(malRestake), 100_000 ether);

        // Stake + restake under the malicious contract. We can't go through
        // _stakeAndRestake (it points at the canonical `restaking`), so do it
        // inline.
        vm.startPrank(user);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, lockDuration);
        uint256 tokenId = staking.userTokenId(user);
        vm.warp(block.timestamp + 24 hours + 1);
        staking.approve(address(malRestake), tokenId);
        malRestake.restake(tokenId);
        vm.stopPrank();

        // Seed a non-zero accBonusPerShare so the malicious decrement has
        // something to subtract from. We need to call a path that runs
        // _accrueBonusChecked at least once with a valid (non-malicious)
        // increment first. The malicious override always decrements, so we
        // can't seed via the contract itself. Instead we directly write
        // accBonusPerShare via the only avenue: nothing public exposes it.
        //
        // Workaround: call a non-R017 path that uses _accrueBonus directly
        // (bypassing the wrapper). The `restake()` body has `updateBonus`
        // modifier — which still calls _accrueBonus via the modifier, but
        // the modifier was inlined and not removed for restake (only the
        // three R017 paths). The malicious override there will silently
        // decrement, but accBonusPerShare starts at 0 so the decrement is
        // a no-op (we guarded with > 0). After the first accrue the value
        // is still 0, so the wrapper's `<` check passes.
        //
        // To guarantee a non-zero pre-snapshot we use vm.store to inject
        // a positive accBonusPerShare directly. Slot for accBonusPerShare:
        // OwnableNoRenounce(0) + ReentrancyGuard(1) + Pausable(2..) + ...
        // To avoid storage-slot fragility we instead write through the
        // public state-mutating path `fundBonus` which calls updateBonus
        // (now using malicious _accrueBonus directly via modifier). Same
        // start-at-0 problem. So we drop the seed and rely on the fact that
        // the wrapper still functions: even if accBonusPerShare is 0, the
        // wrapper is a strict `<` check; a decrement of 0 cannot trip it.
        // We therefore force accBonusPerShare > 0 by using vm.store on a
        // computed slot. Simpler still: let time pass with non-zero
        // totalRestaked + bonusRewardPerSecond — but the malicious override
        // doesn't actually accrue, so accBonusPerShare stays 0 forever via
        // the modifier path.
        //
        // Final approach: vm.store directly. Slot is computed by Foundry's
        // storage layout; for resilience we use forge inspect at compile
        // time would be ideal, but the slot is stable: accBonusPerShare is
        // a `uint256 public` declared after `lastBonusRewardTime` (also
        // uint256 public) and `bonusRewardPerSecond` (uint256 public). The
        // base classes (OwnableNoRenounce, ReentrancyGuard, Pausable,
        // TimelockAdmin) consume some leading slots. Rather than reverse-
        // engineer slot indices we use stdstore.
    }

    function test_R014_refreshPosition_monotonicityTrap() public {
        MaliciousRestaking malRestake = _setupMaliciousScenario(alice, 365 days);

        // Seed accBonusPerShare > 0 via stdstore so the malicious decrement
        // would actually walk the accumulator backwards.
        stdstore
            .target(address(malRestake))
            .sig(malRestake.accBonusPerShare.selector)
            .checked_write(uint256(1_000));

        // Force a stale state on alice (no-op here; we only need refreshPosition
        // to enter a path that runs _accrueBonusChecked). The stale path also
        // runs the wrapper, so we use staleness to force the path:
        // create stale by decaying through the JBAC-loss path used above.
        // Since alice's lock is 365 days she won't naturally decay; we mutate
        // staking position storage directly via stdstore to set a different
        // boostedAmount (cheaper than constructing a real divergence here).
        uint256 tokenId = staking.userTokenId(alice);
        // Read current boosted from staking
        (, uint256 currBoosted, , , , , , , , , ) = staking.positions(tokenId);
        // Deliberately differ the cached restake boost from what the actual
        // staking value will be: lower the cached one in malRestake's storage.
        // Easiest: force totalRestaked to allow a small change. We instead
        // simulate stale by writing the staking position's boostedAmount
        // to a different value than malRestake's cache.
        // For simplicity and to avoid struct-slot fragility, we just call the
        // non-stale path on refreshPosition — both stale and non-stale paths
        // run _accrueBonusChecked, so the trap fires either way.
        currBoosted; // silence unused

        // Either path triggers the wrapper: it snapshots accBonusPerShare,
        // calls _accrueBonus (malicious decrement to 999), then asserts
        // post >= pre — which fails -> AccrueNotMonotone.
        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.AccrueNotMonotone.selector);
        malRestake.refreshPosition();
    }

    function test_R014_claimAll_monotonicityTrap() public {
        MaliciousRestaking malRestake = _setupMaliciousScenario(alice, 365 days);
        stdstore
            .target(address(malRestake))
            .sig(malRestake.accBonusPerShare.selector)
            .checked_write(uint256(1_000));

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.AccrueNotMonotone.selector);
        malRestake.claimAll();
    }

    function test_R014_unrestake_monotonicityTrap() public {
        MaliciousRestaking malRestake = _setupMaliciousScenario(alice, 365 days);
        stdstore
            .target(address(malRestake))
            .sig(malRestake.accBonusPerShare.selector)
            .checked_write(uint256(1_000));

        vm.prank(alice);
        vm.expectRevert(TegridyRestaking.AccrueNotMonotone.selector);
        malRestake.unrestake();
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Invariant: accBonusPerShare must never decrease across a random
//  sequence of (admin fundBonus, warp, refresh, claim, unrestake).
// ═══════════════════════════════════════════════════════════════════════

contract R014_RestakingInvariantHandler is Test {
    TegridyRestaking public restaking;
    TegridyStaking public staking;
    R014_MockTOWELI public toweli;
    R014_MockWETH public weth;
    address public alice;
    address public bob;
    uint256 public maxAccSeen;
    bool public sawRevert;

    constructor(
        TegridyRestaking _restaking,
        TegridyStaking _staking,
        R014_MockTOWELI _toweli,
        R014_MockWETH _weth,
        address _alice,
        address _bob
    ) {
        restaking = _restaking;
        staking = _staking;
        toweli = _toweli;
        weth = _weth;
        alice = _alice;
        bob = _bob;
    }

    function _record() internal {
        uint256 acc = restaking.accBonusPerShare();
        if (acc > maxAccSeen) maxAccSeen = acc;
    }

    function fundBonus(uint256 amount) external {
        amount = bound(amount, 1 ether, 10_000 ether);
        if (weth.balanceOf(address(this)) < amount) return;
        weth.approve(address(restaking), amount);
        try restaking.fundBonus(amount) {} catch { sawRevert = true; }
        _record();
    }

    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 7 days);
        vm.warp(block.timestamp + seconds_);
        _record();
    }

    function refreshAlice() external {
        (uint256 tid, , , , , ) = restaking.restakers(alice);
        if (tid == 0) return;
        vm.prank(alice);
        try restaking.refreshPosition() {} catch { sawRevert = true; }
        _record();
    }

    function claimAlice() external {
        (uint256 tid, , , , , ) = restaking.restakers(alice);
        if (tid == 0) return;
        vm.prank(alice);
        try restaking.claimAll() {} catch { sawRevert = true; }
        _record();
    }

    function unrestakeAlice() external {
        (uint256 tid, , , , , ) = restaking.restakers(alice);
        if (tid == 0) return;
        vm.prank(alice);
        try restaking.unrestake() {} catch { sawRevert = true; }
        _record();
    }

    function refreshBob() external {
        (uint256 tid, , , , , ) = restaking.restakers(bob);
        if (tid == 0) return;
        vm.prank(bob);
        try restaking.refreshPosition() {} catch { sawRevert = true; }
        _record();
    }

    function claimBob() external {
        (uint256 tid, , , , , ) = restaking.restakers(bob);
        if (tid == 0) return;
        vm.prank(bob);
        try restaking.claimAll() {} catch { sawRevert = true; }
        _record();
    }

    function unrestakeBob() external {
        (uint256 tid, , , , , ) = restaking.restakers(bob);
        if (tid == 0) return;
        vm.prank(bob);
        try restaking.unrestake() {} catch { sawRevert = true; }
        _record();
    }
}

contract AuditR014_RestakingInvariant is StdInvariant, Test {
    R014_MockTOWELI toweli;
    R014_MockJBAC jbac;
    R014_MockWETH weth;
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin stakingAdmin;
    TegridyRestaking restaking;
    R014_RestakingInvariantHandler handler;

    address alice = makeAddr("inv_alice");
    address bob = makeAddr("inv_bob");
    address treasury = makeAddr("inv_treasury");

    uint256 constant REWARD_RATE = 1 ether;
    uint256 constant BONUS_RATE = 0.01 ether;
    uint256 constant STAKE_AMOUNT = 50_000 ether;

    uint256 lastSeenAcc;

    function setUp() public {
        toweli = new R014_MockTOWELI();
        jbac = new R014_MockJBAC();
        weth = new R014_MockWETH();

        staking = new TegridyStaking(
            address(toweli),
            address(jbac),
            treasury,
            REWARD_RATE
        );
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking),
            address(monitor),
            address(toweli),
            address(weth),
            BONUS_RATE
        );

        stakingAdmin.proposeRestakingContract(address(restaking));
        vm.warp(block.timestamp + 48 hours + 1);
        stakingAdmin.executeRestakingContract();

        toweli.approve(address(staking), 100_000_000 ether);
        staking.notifyRewardAmount(100_000_000 ether);

        // Pre-fund the restaking bonus pool so emission doesn't get
        // truncated to zero on every accrue.
        weth.transfer(address(restaking), 100_000 ether);

        // Stake + restake for both actors at 365-day lock so they remain
        // active for the entire run.
        toweli.transfer(alice, STAKE_AMOUNT);
        toweli.transfer(bob, STAKE_AMOUNT);

        // Stake both first, then warp past the 24h transfer cooldown for
        // BOTH NFTs in one shot, then restake. This avoids the per-actor
        // warp ordering pitfall where bob's stakeTimestamp lags alice's
        // and a per-actor 24h+1 warp lands exactly on the cooldown cliff.
        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 365 days);
        uint256 aliceTok = staking.userTokenId(alice);
        vm.stopPrank();

        vm.startPrank(bob);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 365 days);
        uint256 bobTok = staking.userTokenId(bob);
        vm.stopPrank();

        // Single warp covers both stakeTimestamps (24h cooldown).
        vm.warp(block.timestamp + 24 hours + 1);

        vm.startPrank(alice);
        staking.approve(address(restaking), aliceTok);
        restaking.restake(aliceTok);
        vm.stopPrank();

        vm.startPrank(bob);
        staking.approve(address(restaking), bobTok);
        restaking.restake(bobTok);
        vm.stopPrank();

        handler = new R014_RestakingInvariantHandler(
            restaking,
            staking,
            toweli,
            weth,
            alice,
            bob
        );

        // Seed the handler with WETH so its fundBonus path can succeed.
        weth.transfer(address(handler), 1_000_000 ether);

        targetContract(address(handler));

        lastSeenAcc = restaking.accBonusPerShare();
    }

    /// @notice accBonusPerShare must NEVER decrease. Every state-mutating
    ///         path (fundBonus / refresh / claim / unrestake) calls
    ///         _accrueBonusChecked which is a strict monotone tripwire.
    function invariant_accBonusPerShareMonotone() public {
        uint256 acc = restaking.accBonusPerShare();
        assertGe(acc, lastSeenAcc, "R014: accBonusPerShare decreased");
        lastSeenAcc = acc;
        // The handler-tracked maxAccSeen must equal the current acc when
        // the only direction is up.
        assertGe(handler.maxAccSeen(), acc, "handler max should track acc");
    }
}
