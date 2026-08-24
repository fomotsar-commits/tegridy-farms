// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {StreamingRevenueDistributor} from "../../src/v2/StreamingRevenueDistributor.sol";

contract RVE {
    mapping(address => uint256) public rawPower;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) private _userTokenId;
    mapping(uint256 => address) public tokenOwner;
    bool public paused;
    uint256 private _next = 1;

    function setPosition(address user, uint256 power, uint256 lockEnd) external {
        if (_userTokenId[user] == 0) { uint256 t = _next++; _userTokenId[user] = t; tokenOwner[t] = user; }
        rawPower[user] = power; lockEnds[user] = lockEnd;
    }
    /// @dev mirrors TegridyStaking.withdraw: delete positions[id]; _burn(id) -> userTokenId = 0
    function clearPosition(address user) external {
        uint256 t = _userTokenId[user];
        if (t != 0) delete tokenOwner[t];
        delete _userTokenId[user]; delete rawPower[user]; delete lockEnds[user];
    }
    function userTokenId(address u) external view returns (uint256) { return _userTokenId[u]; }
    function votingPowerOf(address u) external view returns (uint256) {
        if (block.timestamp >= lockEnds[u]) return 0;
        return rawPower[u];
    }
    function positions(uint256 t) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        address u = tokenOwner[t];
        return (rawPower[u], rawPower[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract RWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 a) external { balanceOf[msg.sender] -= a; payable(msg.sender).transfer(a); }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

contract RefuteAnchorResetTest is Test {
    StreamingRevenueDistributor internal dist;
    RVE internal ve;
    RWETH internal weth;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    uint256 internal constant DURATION = 7 days;
    uint256 internal constant FAR_FUTURE = 3650 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        ve = new RVE(); weth = new RWETH();
        dist = new StreamingRevenueDistributor(address(ve), address(weth), DURATION);
        dist.proposeEnableStreaming();
        vm.warp(block.timestamp + dist.STREAMING_ENABLE_DELAY());
        dist.executeEnableStreaming();
    }

    function _fund(uint256 a) internal { (bool ok, ) = address(dist).call{value: a}(""); assertTrue(ok); }

    // ═══ INVARIANT UNDER TEST ═══
    // An account past `lockEnd + CLAIM_GRACE_PERIOD` is forfeitable and MUST NOT be
    // paid. Burning its own position NFT is a purely user-side act with no outage
    // involved; it must not re-open a closed claim window.
    // PASSES on pre-fix HEAD~1. FAILS on fe560b06.
    function test_PastGraceStakerCannotEscapeForfeitByBurningTheNFT() public {
        uint256 aliceEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, aliceEnd);
        ve.setPosition(bob, 500e18, block.timestamp + FAR_FUTURE);
        dist.sync(alice); dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(aliceEnd + dist.CLAIM_GRACE_PERIOD() + 1);

        // baseline: the rule is enforced while the NFT exists
        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();

        uint256 owedToPool = dist.earned(alice);
        assertGt(owedToPool, 0, "vacuous fixture");
        emit log_named_decimal_uint("wei destined for totalForfeitedToPool", owedToPool, 18);

        ve.clearPosition(alice); // TegridyStaking.withdraw()

        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
        assertEq(alice.balance, before, "past-grace account was PAID after burning its NFT");
    }

    // Same scenario, asserted the other way, so the size of the leak stays on the record.
    //
    // ADAPTED FOR ATTEMPT 2 — the only edit made to this file, and it is not a rename.
    // As written this was an exploit DEMO: a bare `dist.getReward()` with zero assertions,
    // which passes only while the bug is open and fails the instant it is closed (it is
    // already red on pre-fix trunk, `[FAIL: NoLockedTokens()]`, because trunk refuses that
    // claim too). It could therefore never be a permanent regression test. Inverted here
    // into the statement it was always trying to make: the wei is not merely refused, it
    // is RECYCLED to the staker pool. Nothing else in this file changed — the two real
    // tests below and above are byte-identical and never mention any anchor field.
    function test_EXPLOIT_measureTheLeak() public {
        uint256 aliceEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, aliceEnd);
        ve.setPosition(bob, 500e18, block.timestamp + FAR_FUTURE);
        dist.sync(alice); dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(aliceEnd + dist.CLAIM_GRACE_PERIOD() + 1);

        uint256 owedToPool = dist.earned(alice);
        assertGt(owedToPool, 0, "vacuous fixture");
        ve.clearPosition(alice);            // TegridyStaking.withdraw()

        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
        assertEq(alice.balance, before, "the leak is open: alice was paid after burning the NFT");

        uint256 recycledBefore = dist.totalForfeitedToPool();
        dist.sync(alice);
        assertEq(
            dist.totalForfeitedToPool(),
            recycledBefore + owedToPool,
            "refused but never recycled: the wei is stranded, not returned to stakers"
        );
        emit log_named_decimal_uint("recycled to the pool instead of paid out", owedToPool, 18);
    }

    // ═══ INVARIANT 2 ═══ an account with NO position must not be paid for windows in
    // which it held nothing. Unbounded because nothing forces an observation.
    // PASSES on pre-fix HEAD~1 (claim refused, wei recycled). FAILS on fe560b06.
    function test_PositionlessAccountIsNotPaidForPhantomAccrual() public {
        ve.setPosition(alice, 500e18, block.timestamp + FAR_FUTURE);
        ve.setPosition(bob, 500e18, block.timestamp + FAR_FUTURE);
        dist.sync(alice); dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION / 2);
        dist.sync(alice);
        uint256 legit = dist.rewards(alice);
        assertGt(legit, 0);

        ve.clearPosition(alice);            // alice fully exits. no outage. nobody syncs her.

        // NOTE: `block.timestamp` inside the loop is CSE-folded under via_ir, so the
        // clock is carried in an explicit accumulator.
        uint256 t = block.timestamp;
        for (uint256 i; i < 20; ++i) {      // a season of streams she is not entitled to
            t += DURATION;
            vm.warp(t);
            _fund(7 ether);
            dist.notifyRewardAmount();
        }
        t += DURATION;
        vm.warp(t);

        uint256 claimable = dist.earned(alice);
        emit log_named_decimal_uint("legitimate at exit", legit, 18);
        emit log_named_decimal_uint("earned by a position-less account", claimable, 18);

        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
        assertEq(alice.balance, before, "position-less account was paid phantom accrual");
    }

    receive() external payable {}
}
