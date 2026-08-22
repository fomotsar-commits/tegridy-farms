// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployBaseLaunchRailScript} from "../../script/base/DeployBaseLaunchRail.s.sol";
import {DeployRobinhoodLaunchRailScript} from "../../script/robinhood/DeployRobinhoodLaunchRail.s.sol";
import {DeployBaseLPFarmingScript} from "../../script/base/DeployBaseLPFarming.s.sol";
import {DeployRobinhoodLPFarmingScript} from "../../script/robinhood/DeployRobinhoodLPFarming.s.sol";
import {BaseChainConfig} from "../../script/base/BaseChainConfig.sol";
import {RobinhoodChainConfig} from "../../script/robinhood/RobinhoodChainConfig.sol";
import {AttestedSequencerUptimeFeed} from "../../src/AttestedSequencerUptimeFeed.sol";
import {TegridyLaunchpadV2} from "../../src/TegridyLaunchpadV2.sol";
import {TegridyLockVault} from "../../src/TegridyLockVault.sol";
import {LaunchRugEscrow} from "../../src/LaunchRugEscrow.sol";
import {TegridyLPFarming} from "../../src/TegridyLPFarming.sol";
import {NullBoost} from "../../src/NullBoost.sol";

contract DummySafe {
    receive() external payable {}
}

contract MockSequencerFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 0, block.timestamp - 30 days, block.timestamp - 30 days, 1);
    }
}

contract Mock18 is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 100_000_000e18);
    }
}

contract Mock6 is ERC20 {
    constructor() ERC20("USDC-ish", "USD6") {
        _mint(msg.sender, 100_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @title Launch-rail + LP-farming legs for Base (8453) and Robinhood (4663).
/// @notice The rails' contracts are audited mainnet source; what these tests pin
///         is the PER-CHAIN CONFIG the new scripts are responsible for — the
///         chain gates, the WETH constants, the feed-into-every-clone hazard, the
///         guardian wiring, and the farm's flat-boost semantics on chains with no
///         TegridyStaking to boost from.
contract LaunchRailAndFarmingTest is Test {
    DummySafe treasury;
    DummySafe multisig;
    DummySafe pauseGuardian;

    function setUp() public {
        treasury = new DummySafe();
        multisig = new DummySafe();
        pauseGuardian = new DummySafe();
        // Absolute literal clock — MockSequencerFeed subtracts 30 days, and via_ir
        // folds relative warps (reference_via_ir_timestamp_cse).
        vm.warp(100 days);

        // The rail contracts verify their WETH actually carries code; a fresh test
        // VM has nothing at the canonical predeploy addresses. Etch a real ERC20's
        // runtime there so the code-presence checks see what a live chain would.
        bytes memory erc20Code = address(new Mock18("WETH")).code;
        vm.etch(BaseChainConfig.WETH, erc20Code);
        vm.etch(RobinhoodChainConfig.WETH, erc20Code);
    }

    // ─── Base launch rail ────────────────────────────────────────────

    function _baseRailCfg(address feed) internal view returns (DeployBaseLaunchRailScript.Config memory) {
        return DeployBaseLaunchRailScript.Config({
            treasury: address(treasury),
            multisig: address(multisig),
            pauseGuardian: address(pauseGuardian),
            sequencerFeed: feed
        });
    }

    function test_base_railDeploysWiredToBaseWETHAndFeed() public {
        vm.chainId(BaseChainConfig.CHAIN_ID);
        DeployBaseLaunchRailScript script = new DeployBaseLaunchRailScript();
        vm.etch(BaseChainConfig.SEQUENCER_UPTIME_FEED, address(new MockSequencerFeed()).code);

        DeployBaseLaunchRailScript.Deployed memory d =
            script.runForTest(_baseRailCfg(BaseChainConfig.SEQUENCER_UPTIME_FEED));

        TegridyLaunchpadV2 lp = TegridyLaunchpadV2(d.launchpad);
        assertEq(lp.weth(), BaseChainConfig.WETH, "Base WETH9 predeploy");
        assertEq(lp.sequencerFeed(), BaseChainConfig.SEQUENCER_UPTIME_FEED, "canonical Base feed");
        assertTrue(d.dropTemplate != address(0), "template auto-deployed");
        assertEq(lp.protocolFeeBps(), 500, "mainnet fee parity");
        assertEq(lp.protocolFeeRecipient(), address(treasury));

        assertEq(LaunchRugEscrow(payable(d.rugEscrow)).weth(), BaseChainConfig.WETH);
        assertFalse(LaunchRugEscrow(payable(d.rugEscrow)).openingsEnabled(), "openings ship dark");
        assertEq(TegridyLockVault(payable(d.lockVault)).pauseGuardian(), address(pauseGuardian));
        assertEq(lp.pendingOwner(), address(multisig), "two-step offer");
    }

    function test_base_railRefusesWrongChainAndZeroFeed() public {
        DeployBaseLaunchRailScript script = new DeployBaseLaunchRailScript();

        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(BaseChainConfig.NotBaseChain.selector, uint256(1)));
        script.runForTest(_baseRailCfg(BaseChainConfig.SEQUENCER_UPTIME_FEED));

        // A zero feed on an L2 is not "no gate" — it is every dutch mint reverting
        // forever, baked immutably into every clone. The script must refuse it.
        vm.chainId(BaseChainConfig.CHAIN_ID);
        vm.expectRevert(abi.encodeWithSelector(BaseChainConfig.ZeroRole.selector, "SEQUENCER_FEED"));
        script.runForTest(_baseRailCfg(address(0)));
    }

    // ─── Robinhood launch rail ───────────────────────────────────────

    function _rhRailCfg(address feed)
        internal
        view
        returns (DeployRobinhoodLaunchRailScript.Config memory)
    {
        return DeployRobinhoodLaunchRailScript.Config({
            treasury: address(treasury),
            multisig: address(multisig),
            pauseGuardian: address(pauseGuardian),
            sequencerFeed: feed
        });
    }

    function test_robinhood_railDeploysAgainstTheAttestedFeed() public {
        vm.chainId(RobinhoodChainConfig.CHAIN_ID);
        DeployRobinhoodLaunchRailScript script = new DeployRobinhoodLaunchRailScript();

        // The real sequence: the MVP leg deployed the attested feed first.
        AttestedSequencerUptimeFeed feed = new AttestedSequencerUptimeFeed(address(pauseGuardian));

        DeployRobinhoodLaunchRailScript.Deployed memory d = script.runForTest(_rhRailCfg(address(feed)));

        TegridyLaunchpadV2 lp = TegridyLaunchpadV2(d.launchpad);
        assertEq(lp.weth(), RobinhoodChainConfig.WETH, "Robinhood canonical WETH");
        assertEq(lp.sequencerFeed(), address(feed), "the attested stand-in, immutably");
        assertTrue(d.dropTemplate != address(0));
        assertEq(LaunchRugEscrow(payable(d.rugEscrow)).weth(), RobinhoodChainConfig.WETH);
        assertFalse(LaunchRugEscrow(payable(d.rugEscrow)).openingsEnabled());
    }

    function test_robinhood_railRefusesTestnetAndCodelessFeed() public {
        DeployRobinhoodLaunchRailScript script = new DeployRobinhoodLaunchRailScript();
        AttestedSequencerUptimeFeed feed = new AttestedSequencerUptimeFeed(address(pauseGuardian));

        // 46630 = the testnet, one digit from production.
        vm.chainId(46630);
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChainConfig.NotRobinhoodChain.selector, uint256(46630))
        );
        script.runForTest(_rhRailCfg(address(feed)));

        vm.chainId(RobinhoodChainConfig.CHAIN_ID);
        address typo = makeAddr("typo");
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChainConfig.NotAContract.selector, "SEQUENCER_FEED", typo)
        );
        script.runForTest(_rhRailCfg(typo));
    }

    // ─── LP farming on a chain with no staking ───────────────────────

    function _farmCfg(address reward, address lpToken)
        internal
        view
        returns (DeployRobinhoodLPFarmingScript.Config memory)
    {
        return DeployRobinhoodLPFarmingScript.Config({
            rewardToken: reward,
            stakingToken: lpToken,
            treasury: address(treasury),
            multisig: address(multisig),
            rewardsDuration: 7 days
        });
    }

    function test_farm_fullCycleAtFlatBoost() public {
        vm.chainId(RobinhoodChainConfig.CHAIN_ID);
        DeployRobinhoodLPFarmingScript script = new DeployRobinhoodLPFarmingScript();

        Mock18 reward = new Mock18("RWD");
        Mock18 lpToken = new Mock18("LP");
        DeployRobinhoodLPFarmingScript.Deployed memory d =
            script.runForTest(_farmCfg(address(reward), address(lpToken)));

        TegridyLPFarming farm = TegridyLPFarming(d.farm);
        assertEq(address(farm.tegridyStaking()), d.nullBoost, "boost source is NullBoost");

        // Complete the handoff, then fund + notify from the owner —
        // notifyRewardAmount pulls the reward via transferFrom(owner).
        vm.prank(address(multisig));
        farm.acceptOwnership();
        reward.transfer(address(multisig), 10_000e18);
        vm.startPrank(address(multisig));
        reward.approve(d.farm, 10_000e18);
        farm.notifyRewardAmount(10_000e18, 7 days);
        vm.stopPrank();

        // Two stakers, same amount, no staking contract anywhere in sight: the
        // whole point of NullBoost is that they earn EXACTLY the same.
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        lpToken.transfer(alice, 1_000e18);
        lpToken.transfer(bob, 1_000e18);

        vm.startPrank(alice);
        lpToken.approve(d.farm, type(uint256).max);
        farm.stake(1_000e18);
        vm.stopPrank();
        vm.startPrank(bob);
        lpToken.approve(d.farm, type(uint256).max);
        farm.stake(1_000e18);
        vm.stopPrank();

        vm.warp(107 days); // literal absolute: setUp pinned the clock at 100 days

        uint256 aliceEarned = farm.earned(alice);
        uint256 bobEarned = farm.earned(bob);
        assertGt(aliceEarned, 0, "rewards accrued");
        assertEq(aliceEarned, bobEarned, "flat 1.0x: identical stakes earn identically");

        // Withdraw + claim round-trips without ever touching a staking contract.
        vm.startPrank(alice);
        farm.getReward();
        farm.withdraw(1_000e18);
        vm.stopPrank();
        assertEq(lpToken.balanceOf(alice), 1_000e18, "principal back");
        assertGt(reward.balanceOf(alice), 0, "rewards paid");
    }

    function test_farm_refusesNon18DecimalRewardToken() public {
        vm.chainId(RobinhoodChainConfig.CHAIN_ID);
        DeployRobinhoodLPFarmingScript script = new DeployRobinhoodLPFarmingScript();

        Mock6 sixDecimals = new Mock6();
        Mock18 lpToken = new Mock18("LP");
        vm.expectRevert(bytes("REWARD_TOKEN: farm reward math assumes 18 decimals"));
        script.runForTest(_farmCfg(address(sixDecimals), address(lpToken)));
    }

    function test_farm_baseScriptGatesOnBaseChain() public {
        DeployBaseLPFarmingScript script = new DeployBaseLPFarmingScript();
        Mock18 reward = new Mock18("RWD");
        Mock18 lpToken = new Mock18("LP");

        vm.chainId(RobinhoodChainConfig.CHAIN_ID);
        vm.expectRevert(
            abi.encodeWithSelector(BaseChainConfig.NotBaseChain.selector, RobinhoodChainConfig.CHAIN_ID)
        );
        script.runForTest(
            DeployBaseLPFarmingScript.Config({
                rewardToken: address(reward),
                stakingToken: address(lpToken),
                treasury: address(treasury),
                multisig: address(multisig),
                rewardsDuration: 7 days
            })
        );
    }

    function test_nullBoost_isFlatForEveryone() public {
        NullBoost boost = new NullBoost();
        assertEq(boost.aggregateActiveBoostBps(address(0)), 0);
        assertEq(boost.aggregateActiveBoostBps(makeAddr("whale")), 0);
        assertEq(boost.aggregateActiveBoostBps(address(this)), 0);
    }
}
