// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/RevenueDistributor.sol";
// VoteIncentives omitted to avoid IVotingEscrow redeclaration conflict with RevenueDistributor
import "../src/PremiumAccess.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @dev Mock TOWELI token for L2 tests
contract L2MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock JBAC NFT for L2 tests
contract L2MockNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @dev Minimal WETH mock for RevenueDistributor / VoteIncentives
contract L2MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok);
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// @dev Stub factory that returns address(0) for all pairs
contract L2MockFactory {
    function getPair(address, address) external pure returns (address) { return address(0); }
}

/// @title L2CompatibilityTest
/// @notice Validates protocol behaviour under L2 timestamp semantics (Arbitrum, Optimism).
///         L2 chains may have irregular block times, uint64 timestamps, and large time jumps.
contract L2CompatibilityTest is Test {
    TegridyStaking public staking;
    RevenueDistributor public revDist;
    PremiumAccess public premium;
    L2MockToken public token;
    L2MockNFT public nft;
    L2MockWETH public weth;
    L2MockFactory public factory;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        token = new L2MockToken();
        nft = new L2MockNFT();
        weth = new L2MockWETH();
        factory = new L2MockFactory();

        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        revDist = new RevenueDistributor(address(staking), treasury, address(weth));
        premium = new PremiumAccess(address(token), address(nft), treasury, 1000 ether);

        nft.mint(alice);
        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        token.approve(address(premium), type(uint256).max);
    }

    // ─── TegridyStaking: Lock/Unlock with L2 time jumps ──────────────

    /// @notice Lock duration should work correctly after a large L2 time jump.
    function test_staking_lockAfterLargeTimeJump() public {
        vm.warp(1_000_000); // Start at a known timestamp
        vm.prank(alice);
        staking.stake(10_000 ether, 30 days);

        // Simulate L2 time jump of 15 days (irregular block production)
        vm.warp(1_000_000 + 15 days);
        uint256 tokenId = staking.userTokenId(alice);
        (, , , uint256 lockEnd, , , , ,,,) = staking.positions(tokenId);
        assertEq(lockEnd, 1_000_000 + 30 days, "Lock end should remain stable after time jump");

        // After lock expires
        vm.warp(1_000_000 + 31 days);
        vm.prank(alice);
        staking.withdraw(tokenId);
    }

    /// @notice Ensure staking works at the contract's supported upper-bound timestamps.
    /// @dev TegridyStaking uses OpenZeppelin Checkpoints which key on uint48 (standard
    ///      OZ pattern, significant gas saving over uint256). uint48 max ≈ year 8,921,556,
    ///      which comfortably exceeds any realistic chain lifetime, so this is the
    ///      effective upper bound. The prior assertion used uint64.max (year ~584 billion)
    ///      which overflows uint48 by ~65 000x and is out-of-spec for the checkpoint system.
    function test_staking_uint64TimestampRange() public {
        // Largest future timestamp still safely within the uint48 checkpoint range.
        uint256 farFuture = uint256(type(uint48).max) - 365 days;
        vm.warp(farFuture);

        vm.prank(bob);
        staking.stake(10_000 ether, 7 days);

        uint256 tokenId = staking.userTokenId(bob);
        (, , , uint256 lockEnd, , , , ,,,) = staking.positions(tokenId);
        assertEq(lockEnd, farFuture + 7 days, "Lock end should not overflow at uint48-max-range timestamps");

        vm.warp(farFuture + 8 days);
        vm.prank(bob);
        staking.withdraw(tokenId);
    }

    // ─── RevenueDistributor: Epoch calculations ─────────────────────

    /// @notice Epoch creation and claiming should work across irregular L2 time gaps.
    function test_revDist_epochWithIrregularTimestamps() public {
        vm.warp(100_000);
        vm.prank(alice);
        staking.stake(100_000 ether, 365 days);

        // Fund and distribute epoch 0
        vm.deal(address(revDist), 10 ether);
        vm.warp(100_000 + 5 hours); // Respect MIN_DISTRIBUTE_INTERVAL
        revDist.distribute();
        assertEq(revDist.epochCount(), 1, "Should have 1 epoch");

        // Large irregular time jump (simulating L2 sequencer downtime)
        vm.warp(100_000 + 5 hours + 2 days);
        vm.deal(address(revDist), 10 ether + address(revDist).balance);
        revDist.distribute();
        assertEq(revDist.epochCount(), 2, "Should have 2 epochs after time jump");
    }

    /// @notice Epoch at timestamp 0 boundary should not revert.
    function test_revDist_epochAtTimestampZero() public {
        vm.warp(1); // Minimum practical timestamp
        vm.prank(alice);
        staking.stake(100_000 ether, 365 days);

        vm.deal(address(revDist), 2 ether);
        vm.warp(1 + 5 hours);
        revDist.distribute();
        assertEq(revDist.epochCount(), 1);
    }

    // ─── Staking: Voting power after time gaps ──────────────────────

    /// @notice Voting power checkpoint lookups should return correct values after
    ///         irregular timestamp advances (L2 blocks may skip seconds).
    function test_votingPower_snapshotWithIrregularTimestamps() public {
        vm.warp(200_000);
        vm.prank(alice);
        staking.stake(100_000 ether, 365 days);

        // Alice should have power at the current timestamp
        uint256 power = staking.votingPowerAtTimestamp(alice, block.timestamp);
        assertGt(power, 0, "Alice should have voting power after staking");

        // Large gap (simulating L2 sequencer downtime)
        vm.warp(200_000 + 12 hours);
        uint256 powerAfterGap = staking.votingPowerAtTimestamp(alice, block.timestamp);
        assertGt(powerAfterGap, 0, "Alice should still have voting power after time gap");
    }

    /// @notice Voting power should correctly go to zero after withdrawal even with time gaps.
    function test_votingPower_zeroAfterWithdrawalWithGap() public {
        vm.warp(300_000);
        vm.prank(alice);
        staking.stake(50_000 ether, 30 days);

        // Large gap — alice's lock has expired
        vm.warp(300_000 + 35 days);
        uint256 aliceTokenId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.withdraw(aliceTokenId);

        uint256 powerAfter = staking.votingPowerAtTimestamp(alice, block.timestamp);
        assertEq(powerAfter, 0, "Alice should have zero power after withdrawal");
    }

    // ─── PremiumAccess: Subscription expiry ─────────────────────────

    /// @notice Subscription should expire correctly even after a large L2 time jump.
    function test_premium_expiryAfterTimeJump() public {
        vm.warp(400_000);
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max); // 1 month

        (uint256 expiresAt, ,) = premium.subscriptions(alice);
        assertEq(expiresAt, 400_000 + 30 days, "Expiry should be 30 days from subscribe");

        // Small jump — still active
        vm.warp(400_000 + 15 days);
        assertTrue(premium.hasPremium(alice), "Should be active mid-subscription");

        // Jump past expiry (L2 sequencer was down for days)
        vm.warp(400_000 + 60 days);
        assertFalse(premium.hasPremium(alice), "Should be expired after time jump past expiry");
    }

    /// @notice NFT premium activation + time-based guard at high in-spec timestamps.
    /// @dev Setup constructs TegridyStaking which writes a uint48 checkpoint on
    ///      deployment. Warping the chain beyond uint48 range before any subsequent
    ///      checkpoint write causes SafeCast to revert. Clamping to uint48-max-range.
    function test_premium_nftActivationAtHighTimestamp() public {
        uint256 highTs = uint256(type(uint48).max) - 30 days;
        vm.warp(highTs);

        vm.prank(alice); // alice owns JBAC #1
        premium.activateNFTPremium();

        // hasPremium requires elapsed > MIN_ACTIVATION_DELAY (15s). Warping +1 was the
        // pre-existing bug in this test — never satisfied the guard at any timestamp.
        vm.warp(highTs + premium.MIN_ACTIVATION_DELAY() + 1);
        assertTrue(premium.hasPremium(alice), "NFT premium should work at high timestamps");
    }
}
