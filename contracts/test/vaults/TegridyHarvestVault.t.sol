// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyPair} from "../../src/TegridyPair.sol";
import {TegridyStaking} from "../../src/TegridyStaking.sol";
import {TegridyLPFarming} from "../../src/TegridyLPFarming.sol";
import {TegridyHarvestVault} from "../../src/vaults/TegridyHarvestVault.sol";
import {TimelockAdmin} from "../../src/base/TimelockAdmin.sol";

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
}

contract WETH9Mock is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external {
        _mint(to, _nextId++);
    }
}

/// @title TegridyHarvestVault — integration suite against the real farm, router and pair.
/// @dev Nothing here is mocked on the money path: the LP is a real TegridyPair, the farm is
///      the deployed TegridyLPFarming source, and the harvest swap goes through TegridyRouter.
contract TegridyHarvestVaultTest is Test {
    TegridyFactory internal factory;
    TegridyRouter internal router;
    TegridyStaking internal staking;
    TegridyLPFarming internal farm;
    TegridyHarvestVault internal vault;

    MockTOWELI internal toweli;
    WETH9Mock internal weth;
    MockJBAC internal jbac;
    TegridyPair internal pair;

    address internal deployer;
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal feeSink = makeAddr("feeSink");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant REWARD_AMOUNT = 100_000 ether;
    uint256 internal constant DURATION = 7 days;

    function setUp() public {
        deployer = address(this);

        toweli = new MockTOWELI();
        weth = new WETH9Mock();
        jbac = new MockJBAC();

        factory = new TegridyFactory(deployer, deployer, deployer);
        router = new TegridyRouter(address(factory), address(weth));

        pair = TegridyPair(factory.createPair(address(toweli), address(weth)));

        // Deep pool so the harvest swap's price impact does not dominate the assertions.
        vm.deal(deployer, 20_000 ether);
        weth.deposit{value: 10_000 ether}();
        toweli.transfer(address(pair), 10_000_000 ether);
        weth.transfer(address(pair), 10_000 ether);
        pair.mint(deployer);

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        farm = new TegridyLPFarming(address(toweli), address(pair), address(staking), treasury, DURATION);

        vault = new TegridyHarvestVault(
            address(pair),
            address(farm),
            address(router),
            deployer,
            "Tegridy Auto-Compounding TOWELI/WETH",
            "acTLP"
        );

        uint256 lpBal = pair.balanceOf(deployer);
        pair.transfer(alice, lpBal / 4);
        pair.transfer(bob, lpBal / 4);
        pair.transfer(attacker, lpBal / 8);

        vm.prank(alice);
        pair.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        pair.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        pair.approve(address(vault), type(uint256).max);

        toweli.approve(address(farm), type(uint256).max);
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
    }

    // ─── helpers ────────────────────────────────────────────────────

    function _lpOf(address who) internal view returns (uint256) {
        return pair.balanceOf(who);
    }

    function _harvest() internal returns (uint256) {
        vm.prank(keeper);
        // minLpOut == 0 is rejected by the vault; 1 is the weakest bound it will accept.
        return vault.harvest(0, 1);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  WIRING                                                     ║
    // ═══════════════════════════════════════════════════════════════

    function test_constructor_wiresAssetRewardAndPairedLegs() public view {
        assertEq(vault.asset(), address(pair), "asset");
        assertEq(address(vault.rewardToken()), address(toweli), "reward");
        assertEq(address(vault.pairedToken()), address(weth), "paired");
        assertEq(vault.farmMinStake(), farm.MIN_STAKE(), "min stake snapshot");
        assertEq(vault.performanceFeeBps(), 0, "fee ships at zero");
        assertEq(vault.feeRecipient(), address(0), "sink ships unwired");
    }

    function test_constructor_revertsOnFarmAssetMismatch() public {
        TegridyLPFarming other =
            new TegridyLPFarming(address(toweli), address(weth), address(staking), treasury, DURATION);
        vm.expectRevert(TegridyHarvestVault.AssetFarmMismatch.selector);
        new TegridyHarvestVault(address(pair), address(other), address(router), deployer, "x", "x");
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(TegridyHarvestVault.ZeroAddress.selector);
        new TegridyHarvestVault(address(0), address(farm), address(router), deployer, "x", "x");
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  DEPOSIT / WITHDRAW ACCOUNTING                               ║
    // ═══════════════════════════════════════════════════════════════

    function test_deposit_stakesIntoFarm() public {
        uint256 amount = 1_000 ether;
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertGt(shares, 0, "shares minted");
        assertEq(farm.rawBalanceOf(address(vault)), amount, "LP forwarded to farm");
        assertEq(pair.balanceOf(address(vault)), 0, "nothing left idle");
        assertEq(vault.totalAssets(), amount, "totalAssets tracks the farm position");
    }

    function test_deposit_belowFarmMinStake_staysIdleAndIsWithdrawable() public {
        uint256 dust = farm.MIN_STAKE() - 1;
        vm.prank(alice);
        vault.deposit(dust, alice);

        assertEq(farm.rawBalanceOf(address(vault)), 0, "farm rejects sub-floor stakes");
        assertEq(pair.balanceOf(address(vault)), dust, "held idle instead");
        assertEq(vault.totalAssets(), dust, "idle LP still counted");

        uint256 before = _lpOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertEq(_lpOf(alice) - before, dust, "idle LP is fully withdrawable");
    }

    function test_deployIdle_isPermissionlessAndStakesBufferedDust() public {
        uint256 dust = farm.MIN_STAKE() - 1;
        vm.prank(alice);
        vault.deposit(dust, alice);
        assertEq(farm.rawBalanceOf(address(vault)), 0);

        // A second sub-floor deposit lifts the buffer over the farm's floor.
        vm.prank(bob);
        vault.deposit(dust, bob);
        assertEq(farm.rawBalanceOf(address(vault)), 2 * dust, "buffer deployed once it clears");

        vm.prank(attacker);
        vault.deployIdle(); // permissionless, no-op here
        assertEq(farm.rawBalanceOf(address(vault)), 2 * dust);
    }

    function test_deposit_skipsFarmWhilePaused_thenDeploysAfterUnpause() public {
        farm.pause();
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        assertEq(farm.rawBalanceOf(address(vault)), 0, "paused farm not touched");
        assertEq(vault.totalAssets(), 1_000 ether, "principal still accounted");

        farm.unpause();
        vault.deployIdle();
        assertEq(farm.rawBalanceOf(address(vault)), 1_000 ether, "deployed after unpause");
    }

    function test_withdraw_unwindsExactShortfallFromFarm() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        uint256 before = _lpOf(alice);
        vm.prank(alice);
        vault.withdraw(400 ether, alice, alice);

        assertEq(_lpOf(alice) - before, 400 ether, "exact assets delivered");
        assertEq(farm.rawBalanceOf(address(vault)), 600 ether, "remainder still farming");
        assertEq(pair.balanceOf(address(vault)), 0, "no stranded idle after unwind");
    }

    function test_redeem_fullRoundTripReturnsPrincipal() public {
        uint256 amount = 5_000 ether;
        uint256 before = _lpOf(alice);
        vm.prank(alice);
        vault.deposit(amount, alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        assertEq(_lpOf(alice), before, "round trip is lossless absent yield");
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    function test_totalAssets_excludesPendingRewards() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        assertGt(vault.pendingRewards(), 0, "farm owes the vault rewards");
        assertEq(vault.totalAssets(), 1_000 ether, "unrealised rewards never enter share price");
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  INFLATION / DONATION ATTACK                                ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice The classic first-depositor attack: seed 1 wei, donate a large balance to
    ///         inflate the share price, then let the victim's deposit round down to zero
    ///         shares. The virtual-offset must make the victim whole and the attacker poor.
    function test_inflationAttack_firstDepositorIsNotRobbed() public {
        uint256 donation = 10_000 ether;
        uint256 victimDeposit = 5_000 ether;

        vm.startPrank(attacker);
        vault.deposit(1, attacker);
        pair.transfer(address(vault), donation); // direct donation, no shares minted
        vm.stopPrank();

        vm.prank(alice);
        uint256 victimShares = vault.deposit(victimDeposit, alice);
        assertGt(victimShares, 0, "victim must not round to zero shares");

        uint256 attackerOut = vault.previewRedeem(vault.balanceOf(attacker));
        uint256 victimOut = vault.previewRedeem(victimShares);

        // The attacker sank `donation + 1`; anything they can pull back out must be less.
        assertLt(attackerOut, donation + 1, "attack must be unprofitable");
        // The victim's loss is bounded to the virtual-offset rounding residue — under one
        // part per million of their deposit — not to a share of the donation, which is what
        // an unmitigated vault would have handed the attacker.
        assertGe(victimOut, victimDeposit - (victimDeposit / 1e6), "victim keeps their deposit");
    }

    function test_inflationAttack_realisedRedeemsConfirmPreview() public {
        uint256 donation = 1_000 ether;
        vm.startPrank(attacker);
        uint256 attackerLpBefore = _lpOf(attacker);
        vault.deposit(1, attacker);
        pair.transfer(address(vault), donation);
        vm.stopPrank();

        vm.prank(alice);
        vault.deposit(2_000 ether, alice);

        uint256 attackerShares = vault.balanceOf(attacker);
        vm.prank(attacker);
        vault.redeem(attackerShares, attacker, attacker);
        assertLt(_lpOf(attacker), attackerLpBefore, "attacker ends down on the round trip");
    }

    function test_decimalsOffsetIsAppliedToShareDecimals() public view {
        assertEq(vault.decimals(), 18 + 6, "virtual offset surfaced in decimals()");
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  HARVEST                                                    ║
    // ═══════════════════════════════════════════════════════════════

    function test_harvest_compoundsAndRaisesPricePerShare() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(10_000 ether, alice);

        uint256 ppsBefore = vault.previewRedeem(shares);
        vm.warp(block.timestamp + 3 days);
        assertGt(vault.pendingRewards(), 0);

        vault.setKeeper(keeper, true);
        uint256 lp = _harvest();

        assertGt(lp, 0, "harvest minted LP");
        assertGt(vault.previewRedeem(shares), ppsBefore, "share price stepped up");
        assertEq(pair.balanceOf(address(vault)), 0, "compounded LP was re-staked");
        assertGt(farm.rawBalanceOf(address(vault)), 10_000 ether, "farm position grew");
        assertEq(vault.lastHarvestTimestamp(), block.timestamp);
        assertGt(vault.totalHarvested(), 0);
    }

    function test_harvest_leavesOnlyRatioDustUnconverted() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 2 days);

        vault.setKeeper(keeper, true);
        _harvest();

        // Adding liquidity consumes the two legs at the pool ratio, so the swap fee and price
        // impact leave a remainder on one side. It must be a rounding-scale residue, not a
        // material unconverted balance the share price does not reflect — and it is swept
        // into the next harvest rather than stranded.
        uint256 residue = toweli.balanceOf(address(vault));
        assertLt(residue, vault.totalHarvested() / 20, "residue is ratio dust, not unconverted yield");

        uint256 assetsAfterFirst = vault.totalAssets();
        vm.warp(block.timestamp + 2 days);
        _harvest();
        assertGt(vault.totalAssets(), assetsAfterFirst, "residue is carried forward, not lost");
    }

    function test_harvest_withNoRewardsIsANoOp() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        vault.setKeeper(keeper, true);
        uint256 assetsBefore = vault.totalAssets();
        vm.prank(keeper);
        uint256 lp = vault.harvest(0, 1);

        assertEq(lp, 0, "nothing to compound");
        assertEq(vault.totalAssets(), assetsBefore, "no-op leaves accounting untouched");
        assertEq(vault.lastHarvestTimestamp(), 0, "a no-op is not a harvest");
    }

    function test_harvest_onlyKeeperOrOwner() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 1 days);

        vm.prank(attacker);
        vm.expectRevert(TegridyHarvestVault.NotKeeper.selector);
        vault.harvest(0, 1);

        vault.setKeeper(keeper, true);
        vm.prank(keeper);
        vault.harvest(0, 1);

        vault.setKeeper(keeper, false);
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        vm.expectRevert(TegridyHarvestVault.NotKeeper.selector);
        vault.harvest(0, 1);

        // Owner never needs the allow-list.
        vault.harvest(0, 1);
    }

    function test_harvest_respectsMinLpOut() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        vault.setKeeper(keeper, true);
        vm.prank(keeper);
        vm.expectRevert(TegridyHarvestVault.SlippageTooHigh.selector);
        vault.harvest(0, type(uint128).max);
    }

    function test_harvest_respectsMinPairedOut() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        vault.setKeeper(keeper, true);
        vm.prank(keeper);
        vm.expectRevert(TegridyRouter.InsufficientOutputAmount.selector);
        vault.harvest(type(uint128).max, 1);
    }

    /// @notice `minLpOut` is the only price bound on the harvest re-add (the per-leg
    ///         minimums are deliberately zero, and both operands of the NothingToCompound
    ///         check are donatable raw balances), so an allow-listed keeper must not be
    ///         able to disable it by passing zero.
    function test_harvest_rejectsZeroMinLpOut() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        vault.setKeeper(keeper, true);
        vm.prank(keeper);
        vm.expectRevert(TegridyHarvestVault.ZeroMinLpOut.selector);
        vault.harvest(0, 0);
    }

    /// @notice A 1-wei reward-token donation while the farm owes ~nothing must be a no-op,
    ///         not a revert: one wei cannot split into a swap leg and a liquidity leg, and
    ///         before the dust threshold it walked past the zero check into
    ///         NothingToCompound, rolling back `getReward()` on every keeper attempt.
    function test_harvest_oneWeiDonationIsANoOpNotAGrief() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vault.setKeeper(keeper, true);

        // No time has passed, so the farm owes zero and the griefer's wei is the whole
        // reward balance.
        toweli.transfer(attacker, 1);
        vm.prank(attacker);
        toweli.transfer(address(vault), 1);

        vm.prank(keeper);
        uint256 lp = vault.harvest(0, 1);
        assertEq(lp, 0, "dust harvest is a no-op, never a revert");
        assertEq(toweli.balanceOf(address(vault)), 1, "the wei waits as sweepable dust");
        assertEq(vault.lastHarvestTimestamp(), 0, "a no-op is not a harvest");

        // Self-heals: once real rewards accrue the wei is swept in with them.
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        assertGt(vault.harvest(0, 1), 0, "next real harvest compounds normally");
    }

    /// A dust donation ABOVE 1 wei is the same grief: the fix must gate on the swap's
    /// OUTPUT quote, not on a raw reward-wei count. In the 1000:1 pool a ~999-wei TOWELI
    /// donation's swap leg (~499 wei) quotes to zero WETH out, so on a `rewards < 2`
    /// threshold it would pass the threshold, swap 499, get 0 out, and revert
    /// INSUFFICIENT_OUTPUT — rolling back getReward() on every keeper attempt at ~zero
    /// cost. This test would FAIL on that threshold fix and passes on the output gate.
    /// (Structured like the 1-wei case: no time passes, so the farm owes zero and the
    /// donation is the entire reward balance — no accumulation confound.)
    function test_harvest_multiWeiDustDonationIsStillANoOp() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vault.setKeeper(keeper, true);

        uint256 amount = 999;

        // Precondition: the swap leg genuinely quotes to zero WETH out — this is what
        // makes the donation a grief candidate rather than a legitimate tiny harvest.
        address[] memory path = new address[](2);
        path[0] = address(toweli);
        path[1] = address(weth);
        assertEq(router.getAmountsOut(amount / 2, path)[1], 0, "swap leg must quote 0 out for this case to matter");

        toweli.transfer(attacker, amount);
        vm.prank(attacker);
        toweli.transfer(address(vault), amount);

        vm.prank(keeper);
        uint256 lp = vault.harvest(0, 1);
        assertEq(lp, 0, "sub-quote dust harvest is a no-op, never a revert");
        assertEq(toweli.balanceOf(address(vault)), amount, "the dust waits as sweepable dust");
        assertEq(vault.lastHarvestTimestamp(), 0, "a no-op is not a harvest");

        // Self-heals: the dust rides in with the next real harvest.
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        assertGt(vault.harvest(0, 1), 0, "next real harvest compounds normally");
    }

    function test_harvest_neverReducesTotalAssets() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vault.setKeeper(keeper, true);

        uint256 last = vault.totalAssets();
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 1 days);
            _harvest();
            uint256 next = vault.totalAssets();
            assertGe(next, last, "compounding is monotone in assets");
            last = next;
        }
    }

    function test_twoDepositors_shareCompoundedYieldProRata() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.prank(bob);
        vault.deposit(10_000 ether, bob);

        vault.setKeeper(keeper, true);
        vm.warp(block.timestamp + 3 days);
        _harvest();

        uint256 aliceOut = vault.previewRedeem(vault.balanceOf(alice));
        uint256 bobOut = vault.previewRedeem(vault.balanceOf(bob));
        assertGt(aliceOut, 10_000 ether, "alice earned");
        assertApproxEqRel(aliceOut, bobOut, 1e12, "equal stakes earn equally");
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  PERFORMANCE FEE                                            ║
    // ═══════════════════════════════════════════════════════════════

    function test_fee_defaultsToZeroWithNoSink_soHarvestPaysNobody() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        vault.setKeeper(keeper, true);
        _harvest();

        assertEq(vault.totalFeesCharged(), 0, "no fee charged out of the box");
        assertEq(toweli.balanceOf(feeSink), 0, "no sink is wired, so nothing can be paid");
    }

    function _enableFee(uint256 bps) internal {
        vault.proposeFeeRecipient(feeSink);
        vault.proposePerformanceFee(bps);
        vm.warp(block.timestamp + vault.FEE_RECIPIENT_TIMELOCK() + 1);
        vault.executeFeeRecipient();
        vault.executePerformanceFee();
    }

    function test_fee_requiresBothGatesOpen() public {
        // Fee set but sink unwired: still nothing is charged.
        vault.proposePerformanceFee(MAX());
        vm.warp(block.timestamp + vault.PERFORMANCE_FEE_TIMELOCK() + 1);
        vault.executePerformanceFee();
        assertEq(vault.performanceFeeBps(), MAX());
        assertEq(vault.feeRecipient(), address(0));

        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);
        vault.setKeeper(keeper, true);
        _harvest();

        assertEq(vault.totalFeesCharged(), 0, "zero-address sink keeps the fee branch dead");
    }

    function MAX() internal view returns (uint256) {
        return vault.MAX_PERFORMANCE_FEE_BPS();
    }

    function test_fee_isChargedOnlyOnHarvestedYield() public {
        _enableFee(MAX());

        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 3 days);

        uint256 pending = vault.pendingRewards();
        vault.setKeeper(keeper, true);
        _harvest();

        uint256 charged = toweli.balanceOf(feeSink);
        assertGt(charged, 0, "fee reached the sink");
        assertEq(charged, vault.totalFeesCharged(), "counter matches transfers");
        // The fee is exactly `bps` of what the farm actually paid — never a slice of principal.
        assertApproxEqRel(charged, (pending * MAX()) / vault.BPS_DENOMINATOR(), 1e14, "fee == bps of realised yield");
    }

    function test_fee_cannotExceedImmutableCap() public {
        uint256 overCap = MAX() + 1;
        vm.expectRevert(TegridyHarvestVault.FeeAboveCap.selector);
        vault.proposePerformanceFee(overCap);
    }

    function test_fee_changeRequiresTimelockToElapse() public {
        vault.proposePerformanceFee(500);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, vault.PERFORMANCE_FEE_CHANGE()));
        vault.executePerformanceFee();

        vm.warp(block.timestamp + vault.PERFORMANCE_FEE_TIMELOCK() + 1);
        vault.executePerformanceFee();
        assertEq(vault.performanceFeeBps(), 500);
    }

    function test_fee_proposalCanBeCancelled() public {
        vault.proposePerformanceFee(500);
        vault.cancelPerformanceFeeProposal();
        vm.warp(block.timestamp + vault.PERFORMANCE_FEE_TIMELOCK() + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, vault.PERFORMANCE_FEE_CHANGE()));
        vault.executePerformanceFee();
        assertEq(vault.performanceFeeBps(), 0);
    }

    function test_fee_recipientCannotBeZero() public {
        vm.expectRevert(TegridyHarvestVault.ZeroAddress.selector);
        vault.proposeFeeRecipient(address(0));
    }

    function test_feeAdmin_isOwnerOnly() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.proposePerformanceFee(100);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.proposeFeeRecipient(feeSink);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.setKeeper(attacker, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  PRINCIPAL IS NOT THE OWNER'S TO TAKE                       ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice The load-bearing safety claim: with the fee at its maximum and every owner
    ///         lever pulled, a depositor still redeems at least the LP they put in.
    function test_owner_cannotTouchPrincipal_evenAtMaxFee() public {
        _enableFee(MAX());
        vault.setKeeper(keeper, true);

        uint256 deposited = 10_000 ether;
        uint256 aliceBefore = _lpOf(alice);
        vm.prank(alice);
        vault.deposit(deposited, alice);

        // Every owner-callable lever, in sequence, while the position is live.
        vm.warp(block.timestamp + 2 days);
        vault.harvest(0, 1);
        vault.setKeeper(keeper, false);
        vault.setKeeper(keeper, true);
        vault.pause();
        vault.unpause();
        vm.warp(block.timestamp + 2 days);
        vault.harvest(0, 1);
        vault.panic();
        vault.unpause();
        vault.deployIdle();

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        assertGe(_lpOf(alice), aliceBefore, "depositor never ends below their principal");
        assertEq(vault.totalSupply(), 0);
        // The owner's own LP balance cannot have grown at the depositor's expense: the fee
        // is denominated in the reward token and goes to the sink, never in the asset.
        assertEq(pair.balanceOf(feeSink), 0, "fee sink never receives the asset");
    }

    function test_harvest_neverWithdrawsPrincipalFromFarm() public {
        _enableFee(MAX());
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vault.setKeeper(keeper, true);

        uint256 stakedBefore = farm.rawBalanceOf(address(vault));
        vm.warp(block.timestamp + 3 days);
        _harvest();
        assertGe(farm.rawBalanceOf(address(vault)), stakedBefore, "farm position only ever grows on harvest");
    }

    function test_vaultEarnsBaseRateOnly_noBoostFromDepositors() public {
        // The vault holds no TegridyStaking NFT, so the farm floors it to 1.0x. This is the
        // documented boost boundary; if it ever changes, this assertion is the tripwire.
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        assertEq(
            farm.effectiveBalanceOf(address(vault)),
            farm.rawBalanceOf(address(vault)),
            "vault is un-boosted: effective == raw"
        );
        assertEq(staking.aggregateActiveBoostBps(address(vault)), 0, "vault holds no staking position");
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  PAUSE / PANIC                                              ║
    // ═══════════════════════════════════════════════════════════════

    function test_pause_blocksDepositsButNeverWithdrawals() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);

        vault.pause();
        assertEq(vault.maxDeposit(alice), 0);
        assertEq(vault.maxMint(alice), 0);

        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1_000 ether, bob);

        uint256 before = _lpOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertGe(_lpOf(alice) - before, 10_000 ether, "withdrawals survive a pause");
    }

    function test_panic_pullsPrincipalHomeAndKeepsItRedeemable() public {
        vm.prank(alice);
        vault.deposit(10_000 ether, alice);
        vm.warp(block.timestamp + 2 days);

        vault.panic();

        assertEq(farm.rawBalanceOf(address(vault)), 0, "farm position unwound");
        assertEq(pair.balanceOf(address(vault)), 10_000 ether, "principal held by the vault");
        assertEq(vault.totalAssets(), 10_000 ether, "accounting unchanged by the hatch");
        assertTrue(vault.paused());

        uint256 before = _lpOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertEq(_lpOf(alice) - before, 10_000 ether, "principal fully redeemable after panic");
    }

    function test_panic_revertsWithNothingStaked() public {
        vm.expectRevert(TegridyHarvestVault.NothingStaked.selector);
        vault.panic();
    }

    function test_panic_isOwnerOnly() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vault.panic();
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  FUZZ                                                       ║
    // ═══════════════════════════════════════════════════════════════

    function testFuzz_depositRedeemNeverMintsValue(uint256 amount) public {
        amount = bound(amount, 1, _lpOf(alice));
        uint256 before = _lpOf(alice);
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertLe(_lpOf(alice), before, "round trip can never mint assets");
    }

    function testFuzz_partialWithdrawKeepsFarmAndIdleConsistent(uint256 depositAmt, uint256 withdrawAmt) public {
        depositAmt = bound(depositAmt, farm.MIN_STAKE(), _lpOf(alice));
        withdrawAmt = bound(withdrawAmt, 1, depositAmt);

        vm.prank(alice);
        vault.deposit(depositAmt, alice);
        vm.prank(alice);
        vault.withdraw(withdrawAmt, alice, alice);

        assertEq(vault.totalAssets(), depositAmt - withdrawAmt, "assets reconcile after partial exit");
        assertEq(
            vault.totalAssets(),
            pair.balanceOf(address(vault)) + farm.rawBalanceOf(address(vault)),
            "idle + staked is the whole of it"
        );
    }
}
