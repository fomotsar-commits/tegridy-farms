// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";
import "../src/StakingMonitorView.sol";
import "../src/TegridyRestaking.sol";

/// @title  [staking-attribution] a FOREIGN tracked holder's residue must not arm or
///         sustain TegridyRestaking's residual reservation.
///
/// @notice THE DEFECT (LOW — over-long reservation / re-restake lock).
///         `TegridyRestaking._reserveResidual` decided whether to reserve a tokenId by
///         reading the AGGREGATE:
///
///             uint256 residue = staking.unsettledRewardsByTokenId(tokenId);
///             if (residue == 0) { ...clear...; return; }
///             _residualClaimant[tokenId] = claimant;
///
///         Under the per-(tokenId, holder) ledger that aggregate can be composed
///         ENTIRELY of another tracked holder's entry (e.g. TegridyLending's, left over
///         from a loan that settled against a short pool). Restaking cannot drain one
///         wei of it — `claimUnsettledForTokenId` only ever touches the caller's own
///         entry — yet the non-zero aggregate:
///           * armed a reservation on an exiting restaker who had NO residue of their
///             own, and
///           * kept that reservation alive forever, because the two clearing sites
///             (`claimResidualForTokenId`'s early-return and its final clear) ALSO
///             tested the aggregate, which the claimant can never drive to zero.
///         The user-visible harm is `restake()`'s `TokenIdHasPendingResidual` gate: the
///         NFT's next owner is locked out of restaking indefinitely, on residue that
///         belongs to someone else and that no call can clear.
///
/// @notice THE FIX: all four residual-path reads use
///         `staking.unsettledByTokenIdHolder(tokenId, address(this))` — the exact
///         quantity restaking can actually recover. They are changed TOGETHER on
///         purpose: arming on the own-entry while clearing on the aggregate would have
///         produced precisely the unclearable lock described above.
contract StakingAttributionRestakingReservationTest is Test {
    ResvToken public toweli;
    ResvNFT public jbac;
    ResvWETH public weth;

    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyStakingJbacVault public vault;
    StakingMonitorView public monitor;
    TegridyRestaking public restaking;

    /// @dev The FOREIGN tracked holder — stands in for TegridyLending.
    ResvEscrow public foreign;

    address public treasury = makeAddr("rv_treasury");
    address public alice = makeAddr("rv_alice");
    address public carol = makeAddr("rv_carol");

    uint256 constant REWARD_RATE = 1e14;
    uint256 constant BONUS_RATE = 0.1 ether;
    uint256 constant STAKE_AMOUNT = 100_000 ether;

    uint256 public aliceTokenId;

    function setUp() public {
        toweli = new ResvToken();
        jbac = new ResvNFT();
        weth = new ResvWETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, REWARD_RATE);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        restaking = new TegridyRestaking(
            address(staking), address(monitor), address(toweli), address(weth), BONUS_RATE
        );
        foreign = new ResvEscrow(staking);

        toweli.approve(address(staking), 500_000 ether);
        staking.notifyRewardAmount(500_000 ether);
        weth.transfer(address(restaking), 100_000 ether);

        // Link restaking, whitelist the foreign escrow, and raise the unsettled cap.
        stakingAdmin.proposeRestakingContract(address(restaking));
        stakingAdmin.proposeLendingContract(address(foreign), true);
        stakingAdmin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        stakingAdmin.executeRestakingContract();
        stakingAdmin.executeLendingContract();
        stakingAdmin.executeMaxUnsettledRewards();

        assertEq(staking.restakingContract(), address(restaking), "setup: restaking linked");
        assertTrue(staking.isLendingContract(address(foreign)), "setup: foreign tracked");

        toweli.transfer(alice, STAKE_AMOUNT);
        toweli.transfer(carol, STAKE_AMOUNT);

        vm.startPrank(alice);
        toweli.approve(address(staking), STAKE_AMOUNT);
        staking.stake(STAKE_AMOUNT, 365 days); // long lock: the position must still be live when carol restakes at the end
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(uint256 amt) internal {
        toweli.approve(address(staking), amt);
        staking.notifyRewardAmount(amt);
    }

    function _rewardPool() internal view returns (uint256) {
        uint256 bal = toweli.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 d = pool - leavePool;
        if (d == 0) return;
        vm.prank(address(staking));
        toweli.transfer(address(0xDEAD), d);
    }

    /// @dev Park the NFT at the FOREIGN tracked holder, book it a real shortfall credit
    ///      on `aliceTokenId`, then hand the NFT back to Alice. Mirrors a loan that
    ///      settled while the staking reward pool was short.
    function _seedForeignResidue() internal returns (uint256 residue) {
        vm.prank(alice);
        staking.transferFrom(alice, address(foreign), aliceTokenId);
        foreign.callGetReward(aliceTokenId); // clean baseline

        vm.warp(vm.getBlockTimestamp() + 100_000); // accrue
        _fund(1_000 ether);                        // bake accrual at a healthy pool
        _drainPoolTo(0);                           // starve => next settle books a shortfall
        foreign.callGetReward(aliceTokenId);

        residue = staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign));
        assertGt(residue, 0, "setup: foreign holder must hold a real per-tokenId residue");

        vm.warp(vm.getBlockTimestamp() + 25 hours);
        foreign.callTransfer(alice, aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), alice, "setup: NFT back with alice");
    }

    // ═══════════════════ THE OVER-LONG RESERVATION ═══════════════════

    /// @notice An exiting restaker with NO residue of their own must not have a residual
    ///         reservation armed just because a FOREIGN holder has residue on the same
    ///         tokenId — and the tokenId must stay open for the next owner to restake.
    ///
    ///         PRE-FIX: `_reserveResidual` reads the aggregate (== the foreign residue),
    ///         sees non-zero, and writes `_residualClaimant[tokenId] = alice`. Carol,
    ///         the NFT's next owner, is then permanently locked out by
    ///         `TokenIdHasPendingResidual` — and no call can clear it, because both
    ///         clearing sites also test the aggregate.
    ///
    ///         POST-FIX: restaking's own entry is 0, so nothing is reserved.
    function test_foreignResidue_mustNotArmResidualReservation() public {
        uint256 foreignResidue = _seedForeignResidue();

        // Alice restakes and exits against a HEALTHY pool, so restaking's own entry is
        // fully drained by the exit and it is owed nothing on this tokenId.
        _fund(500_000 ether);
        vm.startPrank(alice);
        staking.approve(address(restaking), aliceTokenId);
        restaking.restake(aliceTokenId);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 31 days);
        _fund(500_000 ether);

        vm.prank(alice);
        restaking.unrestake();

        // The precondition that makes this a real test: the aggregate is still polluted
        // by the foreign entry, while restaking's own entry is clean.
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(restaking)),
            0,
            "restaking must be owed nothing on this tokenId"
        );
        assertGt(
            staking.unsettledRewardsByTokenId(aliceTokenId),
            0,
            "precondition: the AGGREGATE is still non-zero (foreign residue)"
        );

        // THE ASSERTION THAT FAILS PRE-FIX.
        assertEq(
            restaking.residualClaimant(aliceTokenId),
            address(0),
            "reservation must NOT be armed on a foreign holder's residue"
        );

        // ...and the user-visible consequence: the next owner can still restake.
        // Warp BEFORE the alice -> carol hop: that one is neither lending-exempt nor a
        // restaking hop, so it is subject to TRANSFER_RATE_LIMIT (1h) on top of the
        // 24h TRANSFER_COOLDOWN.
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        vm.prank(alice);
        staking.transferFrom(alice, carol, aliceTokenId);
        vm.startPrank(carol);
        staking.approve(address(restaking), aliceTokenId);
        restaking.restake(aliceTokenId); // pre-fix: reverts TokenIdHasPendingResidual
        vm.stopPrank();
        assertEq(staking.ownerOf(aliceTokenId), address(restaking), "carol restaked successfully");

        // The foreign holder's money was never touched by any of it.
        assertEq(
            staking.unsettledByTokenIdHolder(aliceTokenId, address(foreign)),
            foreignResidue,
            "foreign entry untouched"
        );
    }
}

// ─── Mocks ──────────────────────────────────────────────────────────

contract ResvToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract ResvNFT is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

contract ResvWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev A whitelisted tracked holder standing in for TegridyLending.
contract ResvEscrow {
    TegridyStaking public immutable staking;

    constructor(TegridyStaking _staking) {
        staking = _staking;
    }

    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function callTransfer(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
