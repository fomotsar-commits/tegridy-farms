// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../../src/RevenueDistributor.sol";

/// @title RevenueDistributor invariant suite (R061)
/// @notice Stateful invariants for `RevenueDistributor` covering the two
///         protocol-level conservation laws:
///           - voteWeightConservation:  sum of every epoch's totalETH ==
///             totalDistributed (no silent epoch-amount drift).
///           - ETHSolvency:             totalEarmarked - totalClaimed +
///             totalPendingWithdrawals  <=  contract ETH balance + WETH
///             balance (the protocol can always cover every outstanding
///             obligation with on-hand assets).

/// @dev Minimal IVotingEscrow mock — same interface as the canonical
///      RevenueDistributor.t.sol mock, simplified for the invariant harness.
contract RevenueR061Escrow {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public totalLocked;
    uint256 private _nextTokenId = 1;

    function setLock(address user, uint256 amount, uint256 end) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _nextTokenId++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        if (lockedAmounts[user] == 0) {
            totalLocked += amount;
        } else {
            totalLocked = totalLocked - lockedAmounts[user] + amount;
        }
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return lockedAmounts[user];
    }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return lockedAmounts[user];
    }
    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }
    function locks(address user) external view returns (uint256, uint256) {
        return (lockedAmounts[user], lockEnds[user]);
    }
    function positions(uint256 tokenId) external view returns (
        uint256, uint256, uint256, uint256, uint256, bool, int256, uint256, bool, uint256, bool
    ) {
        address user = tokenOwner[tokenId];
        return (
            lockedAmounts[user], lockedAmounts[user], 10000, lockEnds[user],
            0, false, int256(0), 0, false, 0, false
        );
    }
    function paused() external pure returns (bool) { return false; }
}

contract RevenueR061WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @notice Narrow handler — fund + distribute + claim. notifyReward / treasury
///         changes are kept out so the invariants can rely on the static
///         RevenueDistributor.totalDistributed field as the upper bound.
contract RevenueR061Handler is Test {
    RevenueDistributor public dist;
    address public alice;

    constructor(RevenueDistributor _dist, address _alice) {
        dist = _dist;
        alice = _alice;
    }

    function doFundAndDistribute(uint256 amount) external {
        amount = bound(amount, 1 ether, 100 ether);
        // distribute() requires MIN_DISTRIBUTE_INTERVAL since the last call.
        vm.warp(block.timestamp + 4 hours + 1);
        vm.deal(address(this), amount);
        (bool ok,) = address(dist).call{value: amount}("");
        if (!ok) return;
        try dist.distribute() {} catch {}
    }

    function doClaim() external {
        vm.prank(alice);
        try dist.claim() {} catch {}
    }

    function doWarp(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 1 hours, 7 days);
        vm.warp(block.timestamp + secondsAhead);
    }
}

contract RevenueInvariantsTest is Test {
    RevenueDistributor public dist;
    RevenueR061Escrow public ve;
    RevenueR061WETH public weth;
    RevenueR061Handler public handler;

    address public treasury = makeAddr("r061_rev_treasury");
    address public alice = makeAddr("r061_rev_alice");

    function setUp() public {
        // Avoid distribute()'s initial cooldown.
        vm.warp(5 hours);
        ve = new RevenueR061Escrow();
        weth = new RevenueR061WETH();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        // Single-actor lock so claim() has a well-defined denominator.
        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);

        handler = new RevenueR061Handler(dist, alice);
        targetContract(address(handler));
    }

    /// @notice invariant_voteWeightConservation — the sum of every epoch's
    ///         `totalETH` must equal `totalDistributed`. Catches a class of
    ///         off-by-one or partial-write bugs in `_distribute` where the
    ///         counter and the epoch array could drift.
    function invariant_voteWeightConservation() public view {
        uint256 sum;
        uint256 n = dist.epochCount();
        for (uint256 i = 0; i < n; i++) {
            (uint256 epochETH, ,) = dist.getEpoch(i);
            sum += epochETH;
        }
        assertEq(sum, dist.totalDistributed(), "R061 epoch sum != totalDistributed");
    }

    /// @notice invariant_ETHSolvency — outstanding obligations
    ///         (earmarked-not-claimed PLUS queued pending withdrawals) must
    ///         be coverable by on-hand assets (raw ETH + WETH balance).
    ///         The protocol must never owe more than it holds.
    function invariant_ETHSolvency() public view {
        uint256 earmarked = dist.totalEarmarked();
        uint256 claimed = dist.totalClaimed();
        uint256 unclaimed = earmarked > claimed ? earmarked - claimed : 0;
        uint256 obligation = unclaimed + dist.totalPendingWithdrawals();
        uint256 onHand = address(dist).balance + weth.balanceOf(address(dist));
        assertLe(obligation, onHand, "R061 protocol insolvent");
    }
}
