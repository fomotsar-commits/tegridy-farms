// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// Named imports â€” TegridyPair, TegridyFactory and VoteIncentives all expose
// helper interfaces with the same name (`ITegridyPair`, `ITegridyFactory`),
// so importing whole files would clash. Pull only the contracts we need.
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyLPFarming} from "../src/TegridyLPFarming.sol";
import {GaugeController} from "../src/GaugeController.sol";
import {VoteIncentives} from "../src/VoteIncentives.sol";
import {VoteIncentivesAdmin} from "../src/VoteIncentivesAdmin.sol"; // AUDIT FIX (pass-8): EIP170-03 split

/// @title AuditR016_AMMGov â€” regression coverage for the R016 AMM + governance audit.
/// @notice One test per FIX finding from the R016 batch:
///   * M-1 (LPFarming) â€” multi-NFT contract holders get correct effective balance
///                       via the canonical `aggregateActiveBoostBps` path (the
///                       legacy single-pointer fallback removal must not break
///                       multi-NFT crediting).
///   * M-1 (GaugeController) â€” tightened cancelCommit gate: the see-then-cancel
///                       window is closed by requiring `block.timestamp + 2*REVEAL_GRACE
///                       >= revealOpens`.
///   * M-1 (VoteIncentives) â€” `_validatePair` rejects bribes against pairs the
///                       factory has flagged disabled.
///   * L-1 (Factory)   â€” `cancelPairDisabled` emits `PairDisableCancelled`.
/// (Pair harvest rate-limit is covered in TegridyPair.t.sol next to its other
/// harvest tests.)

// â”€â”€â”€ Shared mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract MockToweli_R016 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockBribe_R016 is ERC20 {
    constructor() ERC20("Bribe", "BRB") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract MockWETH_R016 {
    function deposit() external payable {}
    function withdraw(uint256) external {}
    function transfer(address, uint256) external pure returns (bool) { return true; }
}

contract MockVE_R016 {
    mapping(address => uint256) public power;
    uint256 public totalBoosted;
    bool public _paused;

    function setPower(address u, uint256 p) external {
        totalBoosted = totalBoosted - power[u] + p;
        power[u] = p;
    }
    function votingPowerOf(address u) external view returns (uint256) { return power[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return power[u]; }
    function totalBoostedStake() external view returns (uint256) { return totalBoosted; }
    function totalLocked() external view returns (uint256) { return totalBoosted; }
    function userTokenId(address u) external pure returns (uint256) { return uint256(uint160(u)); }
    function paused() external view returns (bool) { return _paused; }
    function positions(uint256) external pure returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) { return (0,0,0,0,0,0,false,false,0,0,false); }
}

/// @dev Real factory plus real pair, used by the VoteIncentives + Factory tests.
contract MockPair_R016 {
    address public token0;
    address public token1;
    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }
}

contract MockFactory_R016 {
    mapping(address => mapping(address => address)) public _pair;
    mapping(address => bool) public disabledPairs;

    function setPair(address a, address b, address p) external {
        _pair[a][b] = p; _pair[b][a] = p;
    }
    function getPair(address a, address b) external view returns (address) {
        return _pair[a][b];
    }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

contract MockJBAC_R016 is ERC20 {
    // ERC721-shaped placeholder (satisfies TegridyStaking's IERC721 reads at the
    // surface; we never actually mint/transfer JBAC NFTs in these tests).
    constructor() ERC20("JBAC", "JBAC") {}
}

/// @notice Multi-NFT staking mock for the LPFarming regression. We control
///         `aggregateActiveBoostBps` directly so we can verify the contract
///         relies on it (not the removed single-pointer fallback).
contract MockStaking_R016LP {
    mapping(address => uint256) public agg;
    mapping(address => uint256) public _userTokenId;

    /// @dev If `revertAgg[user]` is true, aggregateActiveBoostBps reverts.
    ///      Used to prove the LPFarming path no longer falls back silently.
    mapping(address => bool) public revertAgg;

    function setAggBoost(address u, uint256 boost) external { agg[u] = boost; }
    function setRevert(address u, bool r) external { revertAgg[u] = r; }
    function setUserTokenId(address u, uint256 t) external { _userTokenId[u] = t; }

    function aggregateActiveBoostBps(address user) external view returns (uint256) {
        require(!revertAgg[user], "AGG_REVERT");
        return agg[user];
    }
    function userTokenId(address user) external view returns (uint256) {
        return _userTokenId[user];
    }
    /// @dev Returns a phantom "active" position so the legacy fallback path WOULD
    ///      have undercounted multi-NFT contract holders had it not been removed.
    function positions(uint256) external view returns (
        uint256, uint256, int256, uint64, uint16, uint32, bool, bool, uint64, uint256, bool
    ) {
        return (
            1, 1, int256(0),
            uint64(block.timestamp + 365 days),
            uint16(20000), // 2.0x â€” but only ONE tokenId pointer
            uint32(365 days),
            false, false,
            uint64(block.timestamp), 0, false
        );
    }
}

/// @notice Multi-NFT staking mock for the GaugeController cancelCommit regression.
contract MockStaking_R016Gov {
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => uint256) internal _amount;
    mapping(uint256 => uint256) internal _lockEnd;
    mapping(address => uint256) public power;

    function setOwner(uint256 t, address o) external { _owners[t] = o; }
    function setPosition(uint256 t, uint256 a, uint256 lE) external {
        _amount[t] = a; _lockEnd[t] = lE;
    }
    function setPower(address u, uint256 p) external { power[u] = p; }

    function ownerOf(uint256 t) external view returns (address) { return _owners[t]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) {
        return power[u];
    }
    function positions(uint256 t) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    ) {
        amount = _amount[t];
        boostedAmount = _amount[t];
        lockEnd = _lockEnd[t];
        boostBps = 10000;
        lockDuration = 365 days;
        stakeTimestamp = 1;
    }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   Test contract
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

contract AuditR016_AMMGovTest is Test {
    // â”€â”€ LPFarming side â”€â”€
    MockToweli_R016 public toweliLP;
    ERC20 public lp;
    MockStaking_R016LP public stakingLP;
    TegridyLPFarming public farm;

    // â”€â”€ GaugeController side â”€â”€
    MockStaking_R016Gov public stakingGov;
    GaugeController public gauge;

    // â”€â”€ VoteIncentives + Factory side â”€â”€
    VoteIncentives public vi;
    VoteIncentivesAdmin public viAdmin; // AUDIT FIX (pass-8): EIP170-03 split
    MockFactory_R016 public viFactory;
    MockBribe_R016 public bribeToken;
    MockWETH_R016 public weth;
    MockToweli_R016 public viToweli;
    MockVE_R016 public ve;
    MockPair_R016 public viPair;

    // â”€â”€ Real factory for cancelPairDisabled event test â”€â”€
    TegridyFactory public realFactory;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public multiSafe = makeAddr("multiSafe");
    address public treasury = makeAddr("treasury");
    address public g1 = makeAddr("gauge1");

    uint256 public constant TOKEN_A = 7001;
    uint256 public constant TOKEN_B = 7002;

    function setUp() public {
        // â”€â”€ LPFarming â”€â”€
        toweliLP = new MockToweli_R016();
        lp = new MockToweli_R016(); // reuse ERC20 for staking token mock
        stakingLP = new MockStaking_R016LP();
        farm = new TegridyLPFarming(address(toweliLP), address(lp), address(stakingLP), treasury, 7 days);
        toweliLP.transfer(alice, 1_000 ether);
        toweliLP.approve(address(farm), type(uint256).max);
        lp.transfer(multiSafe, 10_000 ether);
        vm.prank(multiSafe);
        lp.approve(address(farm), type(uint256).max);

        // â”€â”€ GaugeController â”€â”€
        stakingGov = new MockStaking_R016Gov();
        gauge = new GaugeController(address(stakingGov), 1_000_000 ether);
        stakingGov.setOwner(TOKEN_A, multiSafe);
        stakingGov.setOwner(TOKEN_B, multiSafe);
        stakingGov.setPosition(TOKEN_A, 100_000 ether, block.timestamp + 365 days);
        stakingGov.setPosition(TOKEN_B, 100_000 ether, block.timestamp + 365 days);
        stakingGov.setPower(multiSafe, 100_000 ether);
        // AUDIT FIX G-02: proposeAddGauge requires gauge.code.length > 0.
        // AUDIT FIX (pass-8) GOV-INT-01: also requires non-zero `pair`.
        if (g1.code.length == 0) vm.etch(g1, hex"60006000fd");
        address g1Pair = address(uint160(g1) ^ uint160(1));
        if (g1Pair.code.length == 0) vm.etch(g1Pair, hex"60006000fd");
        gauge.proposeAddGauge(g1, g1Pair);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeAddGauge();

        // â”€â”€ VoteIncentives â”€â”€
        viToweli = new MockToweli_R016();
        bribeToken = new MockBribe_R016();
        weth = new MockWETH_R016();
        ve = new MockVE_R016();
        viFactory = new MockFactory_R016();
        viPair = new MockPair_R016(address(0xAAAA), address(0xBBBB));
        viFactory.setPair(address(0xAAAA), address(0xBBBB), address(viPair));
        vi = new VoteIncentives(
            address(ve), treasury, address(weth), address(viFactory),
            address(viToweli), 300
        );
        // AUDIT FIX (pass-8): EIP170-03 split â€” wire admin sister.
        viAdmin = new VoteIncentivesAdmin(address(vi));
        vi.setVoteIncentivesAdmin(address(viAdmin));
        // Whitelist the bribe token via timelock so depositBribe can run.
        viAdmin.proposeWhitelistChange(address(bribeToken), true);
        // Warp generously past the 24h timelock to avoid any boundary issues.
        vm.warp(block.timestamp + 2 days);
        viAdmin.executeWhitelistChange(viAdmin.pendingWhitelistToken(), viAdmin.pendingWhitelistAction(), viAdmin.whitelistChangeTime());

        // Fund + approve a depositor.
        bribeToken.transfer(alice, 100_000 ether);
        vm.prank(alice);
        bribeToken.approve(address(vi), type(uint256).max);

        // â”€â”€ Real factory â”€â”€
        realFactory = new TegridyFactory(address(this), address(this), address(this)); // F-30-9 initial guardian
    }

    // â”€â”€â”€ Finding 3 (LPFarming) â€” multi-NFT contract holder credited via
    //     aggregateActiveBoostBps after legacy fallback removal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /// @notice AUDIT R016 M-1 (LPFarming): with the legacy single-pointer fallback
    ///         REMOVED, a multi-NFT contract holder must still receive boost via
    ///         the canonical aggregate view. We set `userTokenId(multiSafe) == 0`
    ///         (simulating the contract holder case where userTokenId points
    ///         nowhere because it tracks last-received NFT only) AND set a
    ///         non-trivial aggregateActiveBoostBps. After staking, effective
    ///         balance must reflect the aggregate boost.
    function test_R016M1_LPFarming_multiNFTContractHolderUsesAggregate() public {
        // userTokenId == 0 (legacy fallback would have returned 0 boost here).
        stakingLP.setUserTokenId(multiSafe, 0);
        // 1.5x aggregate boost across the holder's positions.
        stakingLP.setAggBoost(multiSafe, 15000);

        vm.prank(multiSafe);
        farm.stake(1_000 ether);

        // raw = 1000, effective = 1000 * 15000 / 10000 = 1500
        assertEq(farm.rawBalanceOf(multiSafe), 1_000 ether, "raw recorded");
        assertEq(
            farm.effectiveBalanceOf(multiSafe),
            1_500 ether,
            "R016 M-1: aggregate boost path applied"
        );
    }

    /// @notice AUDIT R016 M-1 (LPFarming): with the fallback removed, a revert
    ///         from the staking aggregate view propagates LOUDLY instead of
    ///         silently undercounting. Confirms the catch path is gone.
    function test_R016M1_LPFarming_aggregateRevertNoLongerSilenced() public {
        stakingLP.setRevert(multiSafe, true);
        vm.prank(multiSafe);
        vm.expectRevert(bytes("AGG_REVERT"));
        farm.stake(1_000 ether);
    }

    // â”€â”€â”€ Finding 4 (GaugeController) â€” tightened cancel gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /// @notice AUDIT R016 M-1 (GaugeController): the cancel window must close one
    ///         full REVEAL_GRACE BEFORE any reveal could possibly be admitted.
    ///         Previous gate closed at exactly `revealOpens - REVEAL_GRACE`, the
    ///         same instant the first reveal becomes valid â€” giving a 1-block
    ///         see-then-cancel ordering window. New gate closes at
    ///         `revealOpens - 2 * REVEAL_GRACE`.
    function test_R016M1_GaugeCancelGateClosesBeforeAnyRevealCouldLand() public {
        // Get into a fresh epoch.
        uint256 epoch = gauge.currentEpoch();
        // Move a bit into the epoch (commit window is wide open here).
        vm.warp(gauge.epochStartTime(epoch) + 1 hours);

        // Build a valid commit so userActiveCommit slot is populated.
        address[] memory gauges = new address[](1);
        uint256[] memory weights = new uint256[](1);
        gauges[0] = g1;
        weights[0] = 10000;
        bytes32 salt = keccak256("salt");
        bytes32 hash = gauge.computeCommitment(multiSafe, TOKEN_A, gauges, weights, salt, epoch);
        vm.prank(multiSafe);
        gauge.commitVote(TOKEN_A, hash);

        uint256 revealOpens = gauge.epochStartTime(epoch) + 7 days - 24 hours;
        uint256 grace = gauge.REVEAL_GRACE();

        // Warp into the OLD permissive window: `revealOpens - REVEAL_GRACE - 1`
        // would have been allowed under the previous `+ 1*REVEAL_GRACE` gate.
        // Under the new `+ 2*REVEAL_GRACE` gate this must REVERT.
        // Pick a moment where (block.timestamp + 2*GRACE >= revealOpens) but
        // (block.timestamp + 1*GRACE < revealOpens) â€” i.e. the closed slice.
        uint256 t = revealOpens - grace - 1; // old gate: pass (<= revealOpens - grace - 1 + grace = revealOpens - 1)
        vm.warp(t);
        vm.prank(multiSafe);
        vm.expectRevert(GaugeController.CancelWindowClosed.selector);
        gauge.cancelCommit(epoch);

        // And of course at revealOpens-1 (the old boundary) cancellation also reverts.
        vm.warp(revealOpens - 1);
        vm.prank(multiSafe);
        vm.expectRevert(GaugeController.CancelWindowClosed.selector);
        gauge.cancelCommit(epoch);
    }

    /// @notice AUDIT R016 M-1 (GaugeController): cancellation is still permitted in
    ///         the bulk of the commit window â€” the tightened gate doesn't lock
    ///         users out of legitimate cancels.
    function test_R016M1_GaugeCancelStillAllowedDuringCommitWindow() public {
        uint256 epoch = gauge.currentEpoch();
        vm.warp(gauge.epochStartTime(epoch) + 1 hours);

        address[] memory gauges = new address[](1);
        uint256[] memory weights = new uint256[](1);
        gauges[0] = g1;
        weights[0] = 10000;
        bytes32 salt = keccak256("salt-2");
        bytes32 hash = gauge.computeCommitment(multiSafe, TOKEN_A, gauges, weights, salt, epoch);
        vm.prank(multiSafe);
        gauge.commitVote(TOKEN_A, hash);

        // Mid-commit-window cancellation must succeed.
        vm.prank(multiSafe);
        gauge.cancelCommit(epoch);
        assertEq(
            gauge.userActiveCommit(multiSafe, epoch),
            bytes32(0),
            "active commit cleared mid-window"
        );
    }

    // â”€â”€â”€ Finding 5 (VoteIncentives) â€” disabled-pair rejection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /// @notice AUDIT R016 M-1 (VoteIncentives): bribes against a factory-disabled
    ///         pair must be refused. Without this gate the bribe sits unspendable
    ///         because votes/swaps against the disabled pair are themselves
    ///         rejected downstream.
    function test_R016M1_VoteIncentives_rejectsBribeAgainstDisabledPair() public {
        // First: a bribe against a live pair succeeds (sanity).
        vm.prank(alice);
        vi.depositBribe(address(viPair), address(bribeToken), 1 ether);

        // Now flag the pair disabled at the factory.
        viFactory.setDisabled(address(viPair), true);

        // Subsequent deposit must revert with PairDisabled.
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.PairDisabled.selector);
        vi.depositBribe(address(viPair), address(bribeToken), 1 ether);
    }

    // â”€â”€â”€ Finding 7 (Factory) â€” cancelPairDisabled emits event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    /// @notice AUDIT R016 L-1: cancelPairDisabled must emit PairDisableCancelled.
    function test_R016L1_FactoryCancelPairDisabledEmitsEvent() public {
        // Need a pair to disable. Use a valid pair via createPair.
        // Prepare a couple of mock contracts with code so factory.createPair admits them.
        MockBribe_R016 t0 = new MockBribe_R016();
        MockBribe_R016 t1 = new MockBribe_R016();
        address pair = realFactory.createPair(address(t0), address(t1));

        // Propose a disable to populate the timelock slot.
        realFactory.proposePairDisabled(pair, true);

        // expectEmit then cancel.
        vm.expectEmit(true, false, false, false, address(realFactory));
        emit TegridyFactory.PairDisableCancelled(pair);
        realFactory.cancelPairDisabled(pair);
    }
}
