// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TegridyCurveLauncher} from "../../src/curve/TegridyCurveLauncher.sol";
import {TegridyCurveToken} from "../../src/curve/TegridyCurveToken.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyFactoryLib} from "../../src/lib/TegridyFactoryLib.sol";
import {TegridyPair} from "../../src/TegridyPair.sol";

// Canonical-WETH9-shaped mock: deposit + bool-returning transfer, real balances.
contract MockWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

// Wraps a real factory but can be toggled to revert createPair — simulates the
// factory hitting MAX_PAIRS so the graduation-deferral path can be exercised
// without deploying 10,000 pairs. When unblocked, forwards to the real factory
// so createPair yields a genuine, mintable TegridyPair.
interface IMinimalFactory {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}

contract BlockableFactory {
    IMinimalFactory public immutable real;
    bool public blocked;

    constructor(address real_) {
        real = IMinimalFactory(real_);
    }

    function setBlocked(bool b) external {
        blocked = b;
    }

    function getPair(address a, address b) external view returns (address) {
        return real.getPair(a, b);
    }

    function createPair(address a, address b) external returns (address) {
        require(!blocked, "FACTORY_FULL");
        return real.createPair(a, b);
    }
}

// A creator whose receive() reverts — the EVM analog of the Solana rent-band
// bricking. Under pull-payment it can only hurt itself.
contract RevertingCreator {
    TegridyCurveLauncher public immutable launcher;

    constructor(TegridyCurveLauncher l) {
        launcher = l;
    }

    function createLaunch() external returns (address) {
        return launcher.create("Brick", "BRK");
    }

    function tryClaim(address token) external {
        launcher.claimCreatorFees(token);
    }

    receive() external payable {
        revert("no eth");
    }
}

// Attacker attempting to re-enter the launcher from the sell payout.
contract ReentrantSeller {
    TegridyCurveLauncher public immutable launcher;
    address public token;
    bool public attacked;

    constructor(TegridyCurveLauncher l) {
        launcher = l;
    }

    function buyIn(address token_) external payable {
        token = token_;
        launcher.buy{value: msg.value}(token_, 0);
    }

    function attack(uint256 amount) external {
        IERC20(token).approve(address(launcher), type(uint256).max);
        launcher.sell(token, amount, 0);
    }

    receive() external payable {
        if (!attacked) {
            attacked = true;
            // Any re-entry must bounce off the nonReentrant guard.
            launcher.sell(token, 1e18, 0);
        }
    }
}

contract TegridyCurveLauncherTest is Test {
    TegridyCurveLauncher internal launcher;
    TegridyFactory internal factory;
    MockWETH internal weth;

    address internal constant MULTISIG = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant RESERVE_CUSTODY = address(0xEC0);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant BUYER = address(0xB0B);
    address internal constant BUYER2 = address(0xB0B2);

    address internal constant JUNGLE_TREASURY = address(0x51ED);

    // Continuity-exact economics: T = 19 * Vs puts listing at exactly 95% of
    // the final curve price — the band's edge.
    uint128 internal constant VIRTUAL_ETH = 0.2 ether;
    uint128 internal constant GRADUATION_ETH = 3.8 ether;
    uint16 internal constant FEE_BPS = 100; // 1%
    uint16 internal constant CREATOR_SHARE_BPS = 4_000; // 40% of the fee
    uint16 internal constant TREASURY_SHARE_BPS = 2_500; // 25% of the fee
    // protocol keeps the remainder = 35% of the fee
    uint16 internal constant RESERVE_BPS = 500; // 5% of supply

    function _config() internal pure returns (TegridyCurveLauncher.LaunchConfig memory) {
        return TegridyCurveLauncher.LaunchConfig({
            virtualEth: VIRTUAL_ETH,
            graduationEth: GRADUATION_ETH,
            feeBps: FEE_BPS,
            creatorFeeShareBps: CREATOR_SHARE_BPS,
            treasuryFeeShareBps: TREASURY_SHARE_BPS,
            reserveBps: RESERVE_BPS,
            reserveRecipient: RESERVE_CUSTODY
        });
    }

    function setUp() public {
        weth = new MockWETH();
        factory = new TegridyFactory(MULTISIG, TREASURY, GUARDIAN);
        launcher = new TegridyCurveLauncher(
            address(factory), address(weth), MULTISIG, GUARDIAN, JUNGLE_TREASURY, _config()
        );
        vm.deal(CREATOR, 100 ether);
        vm.deal(BUYER, 100 ether);
        vm.deal(BUYER2, 100 ether);
    }

    function _create() internal returns (address token) {
        vm.prank(CREATOR);
        token = launcher.create("Towelie Jr", "TWLJR");
    }

    // ────────────────────────────── create ───────────────────────────────

    function test_CreateMintsFullSupplyToLauncherAndCarvesReserve() public {
        address token = _create();
        assertEq(IERC20(token).totalSupply(), launcher.TOTAL_SUPPLY());
        assertEq(IERC20(token).balanceOf(address(launcher)), launcher.TOTAL_SUPPLY());

        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        uint256 expectedReserve = (launcher.TOTAL_SUPPLY() * RESERVE_BPS) / 10_000;
        assertEq(l.reserveAmount, expectedReserve);
        assertEq(l.saleSupply, launcher.TOTAL_SUPPLY() - expectedReserve);
        assertEq(l.tokenReserve, l.saleSupply);
        assertEq(l.ethReserve, 0);
        assertEq(l.creator, CREATOR);
        assertEq(l.virtualEth, VIRTUAL_ETH);
        assertEq(l.graduationEth, GRADUATION_ETH);
        assertFalse(l.graduated);
        assertEq(launcher.launchCount(), 1);
    }

    function test_CreateWithValueExecutesAtomicFirstBuy() public {
        vm.prank(CREATOR);
        address token = launcher.create{value: 1 ether}("Towelie Jr", "TWLJR");

        uint256 fee = (1 ether * uint256(FEE_BPS)) / 10_000;
        uint256 ethIn = 1 ether - fee;
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(l.ethReserve, ethIn);
        // Creator holds exactly the constant-product output of the first buy.
        uint256 expectedOut = (l.saleSupply * ethIn) / (uint256(VIRTUAL_ETH) + ethIn);
        assertEq(IERC20(token).balanceOf(CREATOR), expectedOut);
    }

    function test_CreateRejectsDegenerateMetadata() public {
        vm.startPrank(CREATOR);
        vm.expectRevert(TegridyCurveLauncher.BadTokenMetadata.selector);
        launcher.create("", "TKN");
        vm.expectRevert(TegridyCurveLauncher.BadTokenMetadata.selector);
        launcher.create("Name", "");
        vm.expectRevert(TegridyCurveLauncher.BadTokenMetadata.selector);
        launcher.create(
            "0123456789012345678901234567890123456789012345678901234567890123X", "TKN"
        );
        vm.stopPrank();
    }

    function test_ConfigSnapshotShieldsLiveLaunchesFromOwnerChanges() public {
        address token = _create();

        TegridyCurveLauncher.LaunchConfig memory newCfg = _config();
        newCfg.feeBps = 300;
        newCfg.creatorFeeShareBps = 0;
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(newCfg);

        // The live launch still trades at its creation-time economics.
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(l.feeBps, FEE_BPS);
        assertEq(l.creatorFeeShareBps, CREATOR_SHARE_BPS);

        // A new launch snapshots the new economics.
        vm.prank(CREATOR);
        address token2 = launcher.create("Second", "SEC");
        TegridyCurveLauncher.Launch memory l2 = launcher.getLaunch(token2);
        assertEq(l2.feeBps, 300);
        assertEq(l2.creatorFeeShareBps, 0);
    }

    // ─────────────────────────────── buys ────────────────────────────────

    function test_BuyChargesFeeAndPricesOnVirtualReserves() public {
        address token = _create();
        TegridyCurveLauncher.Launch memory l0 = launcher.getLaunch(token);

        vm.prank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);

        uint256 fee = (1 ether * uint256(FEE_BPS)) / 10_000;
        uint256 ethIn = 1 ether - fee;
        uint256 expected = (l0.tokenReserve * ethIn) / (uint256(VIRTUAL_ETH) + ethIn);
        assertEq(out, expected);
        assertEq(IERC20(token).balanceOf(BUYER), expected);

        TegridyCurveLauncher.Launch memory l1 = launcher.getLaunch(token);
        assertEq(l1.ethReserve, ethIn);
        assertEq(l1.tokenReserve, l0.tokenReserve - expected);
    }

    function test_BuySlippageFloorReverts() public {
        address token = _create();
        (uint256 quote,,) = launcher.previewBuy(token, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                TegridyCurveLauncher.SlippageExceeded.selector, quote, quote + 1
            )
        );
        launcher.buy{value: 1 ether}(token, quote + 1);
    }

    function test_BuyZeroValueReverts() public {
        address token = _create();
        vm.prank(BUYER);
        vm.expectRevert(TegridyCurveLauncher.ZeroTradeAmount.selector);
        launcher.buy(token, 0);
    }

    function test_BuyUnknownTokenReverts() public {
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.UnknownLaunch.selector, address(0xDEAD))
        );
        launcher.buy{value: 1 ether}(address(0xDEAD), 0);
    }

    // ─────────────────────────────── sells ───────────────────────────────

    function test_SellRoundTripNeverProfitsAndCurveKeepsRounding() public {
        address token = _create();
        vm.startPrank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);

        IERC20(token).approve(address(launcher), out);
        uint256 balBefore = BUYER.balance;
        uint256 ethOut = launcher.sell(token, out, 0);
        vm.stopPrank();

        assertEq(BUYER.balance, balBefore + ethOut);
        // Round-trip through two 1% fees + rounding must strictly lose.
        assertLt(ethOut, 1 ether);
        // The curve is fully unwound: every real wei the buy deposited is
        // either returned, or retained as fees/rounding — never created.
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        uint256 fees = launcher.creatorFeeOf(token) + launcher.protocolFees() + launcher.treasuryFees();
        assertEq(l.ethReserve + fees + ethOut, 1 ether);
    }

    function test_SellSolvency_FullExitByAllHoldersCoveredByRealReserve() public {
        address token = _create();
        // Three staggered buyers at very different curve depths.
        vm.prank(BUYER);
        uint256 o1 = launcher.buy{value: 0.4 ether}(token, 0);
        vm.prank(BUYER2);
        uint256 o2 = launcher.buy{value: 1.7 ether}(token, 0);
        vm.prank(CREATOR);
        uint256 o3 = launcher.buy{value: 0.9 ether}(token, 0);

        // Everyone exits, LIFO. Every payout must succeed from real reserves.
        vm.startPrank(CREATOR);
        IERC20(token).approve(address(launcher), o3);
        launcher.sell(token, o3, 0);
        vm.stopPrank();
        vm.startPrank(BUYER2);
        IERC20(token).approve(address(launcher), o2);
        launcher.sell(token, o2, 0);
        vm.stopPrank();
        vm.startPrank(BUYER);
        IERC20(token).approve(address(launcher), o1);
        launcher.sell(token, o1, 0);
        vm.stopPrank();

        // Reserve never went negative (implicit: no revert) and the launcher
        // still holds every accrued fee.
        uint256 fees = launcher.creatorFeeOf(token) + launcher.protocolFees() + launcher.treasuryFees();
        assertGe(address(launcher).balance, fees);
        // Token side fully restored.
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(l.tokenReserve, l.saleSupply);
    }

    function test_SellIsNotPausable() public {
        address token = _create();
        vm.prank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);

        vm.prank(GUARDIAN);
        launcher.pause();

        // Buys are halted…
        vm.prank(BUYER2);
        vm.expectRevert();
        launcher.buy{value: 1 ether}(token, 0);

        // …but the holder exit still works.
        vm.startPrank(BUYER);
        IERC20(token).approve(address(launcher), out);
        uint256 ethOut = launcher.sell(token, out, 0);
        vm.stopPrank();
        assertGt(ethOut, 0);
    }

    function test_SellReentrancyBlocked() public {
        address token = _create();
        ReentrantSeller attacker = new ReentrantSeller(launcher);
        vm.deal(address(attacker), 5 ether);
        attacker.buyIn{value: 2 ether}(token);

        // The nested sell inside receive() reverts, which bubbles up and
        // reverts the outer sell too — no partial state, no double payout.
        vm.expectRevert();
        attacker.attack(1000e18);
        assertEq(attacker.attacked(), false);
    }

    // ─────────────────────────────── fees ────────────────────────────────

    function test_FeeSplitSumsExactlyThreeWayAndProtocolKeepsRemainder() public {
        address token = _create();
        // A gross value chosen so the fee is NOT cleanly divisible by the share
        // grid, so the rounding (creator + treasury DOWN, protocol remainder)
        // becomes observable.
        uint256 gross = 3_000_100;
        uint256 fee = (gross * uint256(FEE_BPS)) / 10_000; // 30_001

        vm.prank(BUYER);
        launcher.buy{value: gross}(token, 0);

        uint256 creatorCut = launcher.creatorFeeOf(token);
        uint256 treasuryCut = launcher.treasuryFees();
        uint256 protocolCut = launcher.protocolFees();
        // Creator + treasury round DOWN at their exact shares; protocol keeps
        // the remainder; the three always sum to exactly the fee.
        assertEq(creatorCut, (fee * CREATOR_SHARE_BPS) / 10_000);
        assertEq(treasuryCut, (fee * TREASURY_SHARE_BPS) / 10_000);
        assertEq(protocolCut, fee - creatorCut - treasuryCut);
        assertEq(creatorCut + treasuryCut + protocolCut, fee);
    }

    function test_CreatorClaimIsPullOnlyAndCreatorGated() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0);

        uint256 accrued = launcher.creatorFeeOf(token);
        assertGt(accrued, 0);

        // A stranger cannot claim someone else's fees.
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.NotLaunchCreator.selector, BUYER)
        );
        launcher.claimCreatorFees(token);

        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        uint256 claimed = launcher.claimCreatorFees(token);
        assertEq(claimed, accrued);
        assertEq(CREATOR.balance, before + accrued);
        assertEq(launcher.creatorFeeOf(token), 0);

        // Double-claim is empty.
        vm.prank(CREATOR);
        vm.expectRevert(TegridyCurveLauncher.NothingToClaim.selector);
        launcher.claimCreatorFees(token);
    }

    function test_RevertingCreatorOnlyBricksItself_TradesUnaffected() public {
        RevertingCreator brick = new RevertingCreator(launcher);
        address token = brick.createLaunch();

        // Trades flow normally even though the creator can't receive ETH —
        // the Solana rent-band lesson: fee legs must never sit on the trade path.
        vm.prank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);
        assertGt(out, 0);
        vm.startPrank(BUYER);
        IERC20(token).approve(address(launcher), out);
        launcher.sell(token, out, 0);
        vm.stopPrank();

        // Only the claim itself fails, for the creator alone.
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.EthSendFailed.selector, address(brick))
        );
        brick.tryClaim(token);
    }

    function test_ProtocolFeeWithdrawOwnerOnly() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0);

        uint256 accrued = launcher.protocolFees();
        assertGt(accrued, 0);

        vm.prank(BUYER);
        vm.expectRevert();
        launcher.withdrawProtocolFees(BUYER);

        vm.prank(MULTISIG);
        uint256 got = launcher.withdrawProtocolFees(TREASURY);
        assertEq(got, accrued);
        assertEq(TREASURY.balance, accrued);
        assertEq(launcher.protocolFees(), 0);
    }

    function test_TreasuryFeesSweepPermissionlessToTreasury() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0);

        uint256 fee = (1 ether * uint256(FEE_BPS)) / 10_000;
        uint256 accrued = launcher.treasuryFees();
        assertEq(accrued, (fee * TREASURY_SHARE_BPS) / 10_000);
        assertGt(accrued, 0);

        // Anyone can sweep, but it can only ever pay the treasury address.
        uint256 before = JUNGLE_TREASURY.balance;
        vm.prank(BUYER2); // a stranger keeper
        uint256 swept = launcher.sweepTreasuryFees();
        assertEq(swept, accrued);
        assertEq(JUNGLE_TREASURY.balance, before + accrued);
        assertEq(launcher.treasuryFees(), 0);

        // Nothing left to sweep.
        vm.expectRevert(TegridyCurveLauncher.NothingToClaim.selector);
        launcher.sweepTreasuryFees();
    }

    function test_SetTreasuryOwnerOnlyAndRedirectsSweep() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0);

        address newTreasury = address(0x515E2);
        // Stranger can't move it; zero is rejected.
        vm.prank(BUYER);
        vm.expectRevert();
        launcher.setTreasury(newTreasury);
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        launcher.setTreasury(address(0));

        // Owner repoints; accrued fees follow the new address on the next sweep.
        vm.prank(MULTISIG);
        launcher.setTreasury(newTreasury);
        assertEq(launcher.treasury(), newTreasury);
        uint256 accrued = launcher.treasuryFees();
        launcher.sweepTreasuryFees();
        assertEq(newTreasury.balance, accrued);
        assertEq(JUNGLE_TREASURY.balance, 0);
    }

    function test_DonationImmune_StrayEthNeverEntersAccounting() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0);
        TegridyCurveLauncher.Launch memory before = launcher.getLaunch(token);
        uint256 feesBefore = launcher.protocolFees() + launcher.creatorFeeOf(token) + launcher.treasuryFees();
        (uint256 quoteBefore,,) = launcher.previewBuy(token, 1 ether);

        // Plain sends revert (no receive function)…
        vm.prank(BUYER2);
        (bool ok,) = address(launcher).call{value: 1 ether}("");
        assertFalse(ok);

        // …and even force-pushed ETH (selfdestruct-style) moves no ledger:
        // reserves, fees, and pricing are all driven by internal accounting,
        // never by address(this).balance.
        vm.deal(address(launcher), address(launcher).balance + 5 ether);
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(l.ethReserve, before.ethReserve);
        assertEq(launcher.protocolFees() + launcher.creatorFeeOf(token) + launcher.treasuryFees(), feesBefore);
        (uint256 quoteAfter,,) = launcher.previewBuy(token, 1 ether);
        assertEq(quoteAfter, quoteBefore);
    }

    // ──────────────────────────── graduation ─────────────────────────────

    function _buyToGraduation(address token) internal returns (uint256 lastOut) {
        // Push past the threshold with a chunky final buy (overshoot allowed).
        vm.prank(BUYER);
        launcher.buy{value: 2 ether}(token, 0);
        vm.prank(BUYER2);
        lastOut = launcher.buy{value: 2.5 ether}(token, 0);
    }

    function test_CompletingBuyGraduatesAtomically() public {
        address token = _create();
        TegridyCurveLauncher.Launch memory l0 = launcher.getLaunch(token);
        _buyToGraduation(token);

        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertTrue(l.graduated);
        assertEq(l.ethReserve, 0);
        assertEq(l.tokenReserve, 0);

        // The pair exists on OUR factory and holds the raised ETH (as WETH)
        // plus the unsold tokens.
        address pair = factory.getPair(token, address(weth));
        assertTrue(pair != address(0));
        // Overshoot allowed: the pool receives AT LEAST the graduation target.
        assertGe(weth.balanceOf(pair), uint256(GRADUATION_ETH));
        assertGt(IERC20(token).balanceOf(pair), 0);

        // ALL LP is burned: pair total supply == dead balance (+ the 1000-wei
        // minimum the pair itself locks at 0xdead on first mint).
        assertEq(
            TegridyPair(pair).balanceOf(address(0xdead)), TegridyPair(pair).totalSupply()
        );

        // Ecosystem reserve moved to custody, exactly the carve from create.
        assertEq(IERC20(token).balanceOf(RESERVE_CUSTODY), l0.reserveAmount);

        // The launcher retains ONLY fee-backing ETH.
        uint256 fees = launcher.creatorFeeOf(token) + launcher.protocolFees() + launcher.treasuryFees();
        assertEq(address(launcher).balance, fees);
    }

    function test_ListingPriceWithinContinuityBandOfCurvePrice() public {
        address token = _create();
        // Buy to the threshold in many small steps so overshoot stays tiny and
        // we probe the WORST-case listing gap the config allows.
        vm.startPrank(BUYER);
        while (true) {
            TegridyCurveLauncher.Launch memory live = launcher.getLaunch(token);
            if (live.graduated) break;
            uint256 remaining = uint256(GRADUATION_ETH) - live.ethReserve;
            uint256 step = remaining < 0.2 ether ? remaining + 0.01 ether : 0.2 ether;
            launcher.buy{value: step}(token, 0);
        }
        vm.stopPrank();

        address pair = factory.getPair(token, address(weth));
        uint256 wethIn = weth.balanceOf(pair);
        // Listing price = wethIn/tokenIn; the curve's final spot price uses
        // (Vs + wethIn) on the ETH side over the same token reserve, so
        // listing/curve = wethIn / (Vs + wethIn) exactly. With minimal
        // overshoot this probes the worst-case gap the config permits.
        uint256 ratioBps = wethIn * 10_000 / (uint256(VIRTUAL_ETH) + wethIn);
        assertGe(ratioBps, 10_000 - launcher.PRICE_CONTINUITY_BAND_BPS());
        assertLe(ratioBps, 10_000);
    }

    function test_TradingFrozenAfterGraduation() public {
        address token = _create();
        uint256 lastOut = _buyToGraduation(token);

        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.AlreadyGraduated.selector, token)
        );
        launcher.buy{value: 1 ether}(token, 0);

        vm.startPrank(BUYER2);
        IERC20(token).approve(address(launcher), lastOut);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.AlreadyGraduated.selector, token)
        );
        launcher.sell(token, lastOut, 0);
        vm.stopPrank();
    }

    function test_FeesSurviveGraduationAndRemainClaimable() public {
        address token = _create();
        _buyToGraduation(token);

        uint256 accrued = launcher.creatorFeeOf(token);
        assertGt(accrued, 0);
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        launcher.claimCreatorFees(token);
        assertEq(CREATOR.balance, before + accrued);

        vm.prank(MULTISIG);
        launcher.withdrawProtocolFees(TREASURY);
        launcher.sweepTreasuryFees();
        // After ALL THREE pulls (creator claim + protocol withdraw + treasury
        // sweep) the launcher's ETH ledger is fully drained: no stranded value,
        // no over-payout (exact balance conservation across the 3-way split).
        assertEq(address(launcher).balance, 0);
    }

    function test_EmptyPairSquatterCannotBrickGraduation() public {
        address token = _create();
        // Squatter creates the EMPTY pair the moment the token exists.
        vm.prank(BUYER2);
        factory.createPair(token, address(weth));
        address pair = factory.getPair(token, address(weth));
        assertTrue(pair != address(0));

        // Graduation reuses the empty pair (pristine) instead of reverting.
        _buyToGraduation(token);
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertTrue(l.graduated);
        assertEq(
            TegridyPair(pair).balanceOf(address(0xdead)), TegridyPair(pair).totalSupply()
        );
    }

    // ─────────────── graduation-seeding defense (08-22 review) ───────────────

    function test_TokenTransferLockedToLauncherUntilGraduation() public {
        address token = _create();
        vm.prank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);
        assertGt(out, 0);

        // A holder cannot move curve tokens to anyone but the launcher while the
        // curve is live — this is what makes seeding a hostile pair impossible.
        vm.prank(BUYER);
        vm.expectRevert(TegridyCurveToken.TransferLockedUntilGraduation.selector);
        IERC20(token).transfer(BUYER2, 1e18);

        // Selling back to the launcher (to == launcher) is allowed.
        vm.startPrank(BUYER);
        IERC20(token).approve(address(launcher), out);
        launcher.sell(token, out, 0);
        vm.stopPrank();
    }

    function test_SeededHostilePairIsImpossible_TransferToPairReverts() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 0.5 ether}(token, 0);

        // Attacker creates the pair, then tries to seed it with a hostile,
        // token-heavy ratio — the token transfer INTO the pair reverts, so the
        // pool can never be pre-seeded (the CRITICAL's precondition is gone).
        vm.prank(BUYER2);
        address pair = factory.createPair(token, address(weth));
        vm.prank(BUYER);
        vm.expectRevert(TegridyCurveToken.TransferLockedUntilGraduation.selector);
        IERC20(token).transfer(pair, 1e18);
    }

    function test_TokenFreelyTransferableAfterGraduation() public {
        address token = _create();
        vm.prank(BUYER);
        uint256 out = launcher.buy{value: 1 ether}(token, 0);
        _buyToGraduation(token);
        assertTrue(launcher.getLaunch(token).graduated);
        assertTrue(TegridyCurveToken(token).graduated());

        // Post-graduation the lock is lifted: a plain holder→holder transfer to
        // a fresh (never-bought) address works and lands exactly `out`.
        address bystander = address(0xB57A);
        vm.prank(BUYER);
        IERC20(token).transfer(bystander, out);
        assertEq(IERC20(token).balanceOf(bystander), out);
    }

    function test_GraduationDefersWhenFactoryFull_ThenFinalizes() public {
        // Launcher wired to a factory we can force to "full".
        BlockableFactory bf = new BlockableFactory(address(factory));
        TegridyCurveLauncher l2 = new TegridyCurveLauncher(
            address(bf), address(weth), MULTISIG, GUARDIAN, JUNGLE_TREASURY, _config()
        );
        vm.prank(CREATOR);
        address token = l2.create("Deferred", "DEF");

        // Factory is full: the completing buy DEFERS instead of reverting.
        bf.setBlocked(true);
        vm.prank(BUYER);
        l2.buy{value: 2 ether}(token, 0);
        vm.prank(BUYER2);
        l2.buy{value: 2.5 ether}(token, 0); // crosses graduationEth

        TegridyCurveLauncher.Launch memory d = l2.getLaunch(token);
        assertFalse(d.graduated, "must defer, not graduate");
        assertGe(d.ethReserve, uint256(GRADUATION_ETH), "reserve intact for retry");

        // Complete-but-sell-open: further buys are blocked...
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(TegridyCurveLauncher.CurveComplete.selector, token));
        l2.buy{value: 0.1 ether}(token, 0);

        // ...finalizeGraduation reverts while the factory is still full (reserve
        // is at/over target, so this is GraduationBlocked, not NotComplete)...
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.GraduationBlocked.selector, token)
        );
        l2.finalizeGraduation(token);

        // ...and holders can still exit via sells (never trapped). This drops
        // the reserve below target.
        uint256 bal = IERC20(token).balanceOf(BUYER);
        vm.startPrank(BUYER);
        IERC20(token).approve(address(l2), bal);
        uint256 got = l2.sell(token, bal, 0);
        vm.stopPrank();
        assertGt(got, 0);
        assertLt(l2.getLaunch(token).ethReserve, uint256(GRADUATION_ETH));

        // Reserve below target ⇒ buys resume; push back over the line — still
        // deferred while the factory is full. (BUYER's full exit drained most
        // of the reserve, so this needs to re-raise the whole target.)
        vm.prank(BUYER);
        l2.buy{value: 2.5 ether}(token, 0);
        vm.prank(BUYER2);
        l2.buy{value: 2.5 ether}(token, 0);
        assertFalse(l2.getLaunch(token).graduated);
        assertGe(l2.getLaunch(token).ethReserve, uint256(GRADUATION_ETH));

        // Unblock the factory; anyone can finalize the stuck graduation.
        bf.setBlocked(false);
        l2.finalizeGraduation(token);

        TegridyCurveLauncher.Launch memory g = l2.getLaunch(token);
        assertTrue(g.graduated);
        assertEq(g.ethReserve, 0);
        address pair = factory.getPair(token, address(weth));
        assertTrue(pair != address(0));
        assertEq(
            TegridyPair(pair).balanceOf(address(0xdead)), TegridyPair(pair).totalSupply()
        );
    }

    function test_DonatePlusSyncCannotWedgeGraduation() public {
        // The re-review's HIGH: WETH isn't transfer-locked, so a griefer can
        // createPair, donate 1 wei WETH, and sync() to make RESERVES non-zero
        // irreversibly. Graduation must gate on LP totalSupply (still 0), not
        // reserves — so this must still finalize, not defer forever.
        address token = _create();
        vm.startPrank(BUYER2);
        address pair = factory.createPair(token, address(weth));
        weth.deposit{value: 1}();
        weth.transfer(pair, 1);
        TegridyPair(pair).sync();
        vm.stopPrank();
        // Reserves are now non-zero (the poisoned state)...
        (uint112 r0, uint112 r1,) = TegridyPair(pair).getReserves();
        assertTrue(r0 != 0 || r1 != 0, "sync should have poisoned reserves");
        assertEq(TegridyPair(pair).totalSupply(), 0, "but no LP exists");

        // ...graduation still completes: the stray wei is absorbed as depth and
        // all LP is burned to 0xdead.
        _buyToGraduation(token);
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertTrue(l.graduated, "must graduate despite the donated+synced reserve");
        assertEq(
            TegridyPair(pair).balanceOf(address(0xdead)), TegridyPair(pair).totalSupply()
        );
        assertGt(TegridyPair(pair).totalSupply(), 0);
    }

    function test_FinalizeGraduationRevertsWhenNotComplete() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0); // below threshold
        vm.expectRevert(abi.encodeWithSelector(TegridyCurveLauncher.NotComplete.selector, token));
        launcher.finalizeGraduation(token);
    }

    function test_ZeroReserveConfigSkipsCustodyLeg() public {
        TegridyCurveLauncher.LaunchConfig memory cfg = _config();
        cfg.reserveBps = 0;
        cfg.reserveRecipient = address(0); // allowed when the carve is zero
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(cfg);

        vm.prank(CREATOR);
        address token = launcher.create("NoReserve", "NORES");
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(l.reserveAmount, 0);
        assertEq(l.saleSupply, launcher.TOTAL_SUPPLY());

        _buyToGraduation(token);
        assertEq(IERC20(token).balanceOf(RESERVE_CUSTODY), 0);
    }

    function test_BurnOnFailure_ReserveNeverLeavesBeforeGraduation() public {
        address token = _create();
        vm.prank(BUYER);
        launcher.buy{value: 1 ether}(token, 0); // below threshold

        // No path moves the reserve tranche pre-graduation: the launcher holds
        // sale remainder + reserve, custody holds zero.
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertEq(IERC20(token).balanceOf(RESERVE_CUSTODY), 0);
        assertEq(
            IERC20(token).balanceOf(address(launcher)), l.tokenReserve + l.reserveAmount
        );
    }

    // ─────────────────────────────── admin ───────────────────────────────

    function test_ConfigBoundsEnforced() public {
        TegridyCurveLauncher.LaunchConfig memory cfg = _config();

        cfg.feeBps = 301;
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);

        // creator + treasury shares must not exceed the whole fee.
        cfg = _config();
        cfg.creatorFeeShareBps = 10_001;
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.FeeSharesExceedFee.selector);
        launcher.setLaunchConfig(cfg);

        // creator + treasury summing above 10000 also reverts (each alone is fine).
        cfg = _config();
        cfg.creatorFeeShareBps = 7_000;
        cfg.treasuryFeeShareBps = 3_001; // 10_001 total
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.FeeSharesExceedFee.selector);
        launcher.setLaunchConfig(cfg);

        // The exact-100% boundary (creator + treasury == 10000, protocol 0) is allowed.
        cfg = _config();
        cfg.creatorFeeShareBps = 6_000;
        cfg.treasuryFeeShareBps = 4_000;
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(cfg);

        cfg = _config();
        cfg.reserveBps = 1_001;
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);

        cfg = _config();
        cfg.reserveRecipient = address(0);
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ReserveNeedsRecipient.selector);
        launcher.setLaunchConfig(cfg);

        cfg = _config();
        cfg.virtualEth = 0;
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);
    }

    function test_ConfigContinuityBandEnforced() public {
        // T = 18 * Vs → listing at 94.7% of curve price — just outside 5%.
        TegridyCurveLauncher.LaunchConfig memory cfg = _config();
        cfg.virtualEth = 1 ether;
        cfg.graduationEth = 18 ether;
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);

        // T = 19 * Vs → exactly 95% — the band edge, allowed.
        cfg.graduationEth = 19 ether;
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(cfg);
    }

    function test_ConfigAbsoluteFloorsEnforcedOnChain() public {
        // The degenerate 1-wei config the deploy script's CV-4 catches is ALSO
        // rejected on-chain, so a later setLaunchConfig can't bypass the floor.
        TegridyCurveLauncher.LaunchConfig memory cfg = _config();
        cfg.virtualEth = 1; // 1 wei — well under MIN_VIRTUAL_ETH
        cfg.graduationEth = 19; // passes the ratio band but is dust
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);

        // A dust graduation target (band-satisfying) is rejected too.
        cfg = _config();
        cfg.virtualEth = uint128(launcher.MIN_VIRTUAL_ETH());
        cfg.graduationEth = uint128(launcher.MIN_GRADUATION_ETH() - 1);
        vm.prank(MULTISIG);
        vm.expectRevert(TegridyCurveLauncher.ConfigOutOfBounds.selector);
        launcher.setLaunchConfig(cfg);

        // The continuity default (graduationEth/19) clears both floors at the
        // minimum graduation target — the floors are mutually consistent.
        cfg = _config();
        cfg.graduationEth = uint128(launcher.MIN_GRADUATION_ETH());
        cfg.virtualEth = uint128(launcher.MIN_GRADUATION_ETH() / 19);
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(cfg);
    }

    function test_PauseMatrix() public {
        // Guardian can pause; stranger cannot; owner unpauses; guardian cannot.
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(TegridyCurveLauncher.NotGuardianOrOwner.selector, BUYER)
        );
        launcher.pause();

        vm.prank(GUARDIAN);
        launcher.pause();

        vm.prank(CREATOR);
        vm.expectRevert();
        launcher.create("Paused", "PSD");

        vm.prank(GUARDIAN);
        vm.expectRevert();
        launcher.unpause();

        vm.prank(MULTISIG);
        launcher.unpause();
        vm.prank(CREATOR);
        launcher.create("Unpaused", "UPSD");
    }

    function test_ConstructorValidation() public {
        TegridyCurveLauncher.LaunchConfig memory cfg = _config();
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        new TegridyCurveLauncher(address(0), address(weth), MULTISIG, GUARDIAN, JUNGLE_TREASURY, cfg);
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        new TegridyCurveLauncher(address(factory), address(0), MULTISIG, GUARDIAN, JUNGLE_TREASURY, cfg);
        // Zero treasury rejected.
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        new TegridyCurveLauncher(address(factory), address(weth), MULTISIG, GUARDIAN, address(0), cfg);
        // Non-contract factory/weth rejected (fat-finger protection).
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        new TegridyCurveLauncher(address(0xEA01), address(weth), MULTISIG, GUARDIAN, JUNGLE_TREASURY, cfg);
        vm.expectRevert(TegridyCurveLauncher.ZeroAddress.selector);
        new TegridyCurveLauncher(address(factory), address(0xEA02), MULTISIG, GUARDIAN, JUNGLE_TREASURY, cfg);
    }

    // ─────────────────────────────── fuzz ────────────────────────────────

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_BuySellRoundTripNeverProfits(uint96 buyWei) public {
        uint256 amount = bound(uint256(buyWei), 10_000, 3 ether); // below graduation
        address token = _create();

        vm.startPrank(BUYER);
        uint256 out = launcher.buy{value: amount}(token, 0);
        IERC20(token).approve(address(launcher), out);
        uint256 back = launcher.sell(token, out, 0);
        vm.stopPrank();

        assertLt(back, amount);
        // Conservation: reserve + fees + payout == deposit, to the wei.
        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        uint256 fees = launcher.creatorFeeOf(token) + launcher.protocolFees() + launcher.treasuryFees();
        assertEq(l.ethReserve + fees + back, amount);
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_FeeSplitAlwaysSumsToFeeThreeWay(uint96 buyWei, uint16 cShare, uint16 tShare)
        public
    {
        uint256 amount = bound(uint256(buyWei), 10_000, 3 ether);
        // creator + treasury must be <= 10000 (protocol takes the rest).
        uint16 creatorShare = uint16(bound(uint256(cShare), 0, 10_000));
        uint16 treasuryShare = uint16(bound(uint256(tShare), 0, 10_000 - creatorShare));

        TegridyCurveLauncher.LaunchConfig memory cfg = _config();
        cfg.creatorFeeShareBps = creatorShare;
        cfg.treasuryFeeShareBps = treasuryShare;
        vm.prank(MULTISIG);
        launcher.setLaunchConfig(cfg);

        vm.prank(CREATOR);
        address token = launcher.create("Fuzz", "FZZ");
        vm.prank(BUYER);
        launcher.buy{value: amount}(token, 0);

        uint256 fee = (amount * uint256(FEE_BPS)) / 10_000;
        uint256 creatorCut = launcher.creatorFeeOf(token);
        uint256 treasuryCut = launcher.treasuryFees();
        // The three cuts always sum to exactly the fee, and creator + treasury
        // round DOWN to their exact shares (protocol keeps the remainder).
        assertEq(creatorCut + treasuryCut + launcher.protocolFees(), fee);
        assertEq(creatorCut, (fee * uint256(creatorShare)) / 10_000);
        assertEq(treasuryCut, (fee * uint256(treasuryShare)) / 10_000);
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_ManyTradersThenFullExit_LauncherStaysSolvent(uint256 seed) public {
        address token = _create();
        address[5] memory traders =
            [address(0x9001), address(0x9002), address(0x9003), address(0x9004), address(0x9005)];
        uint256[5] memory holdings;

        for (uint256 i = 0; i < 12; i++) {
            uint256 t = uint256(keccak256(abi.encode(seed, i))) % 5;
            uint256 mode = uint256(keccak256(abi.encode(seed, i, "m"))) % 3;
            TegridyCurveLauncher.Launch memory live = launcher.getLaunch(token);
            if (live.graduated) break;

            if (mode < 2 || holdings[t] == 0) {
                // Buy, sized to stay under graduation.
                uint256 room = uint256(GRADUATION_ETH) - live.ethReserve;
                if (room < 0.02 ether) break;
                uint256 amt = bound(
                    uint256(keccak256(abi.encode(seed, i, "a"))), 10_000, room / 2
                );
                vm.deal(traders[t], amt);
                vm.prank(traders[t]);
                holdings[t] += launcher.buy{value: amt}(token, 0);
            } else {
                uint256 part = holdings[t] / 2 + 1;
                vm.startPrank(traders[t]);
                IERC20(token).approve(address(launcher), part);
                launcher.sell(token, part, 0);
                vm.stopPrank();
                holdings[t] -= part;
            }
        }

        // Full exit by everyone still standing must be payable from reserves.
        for (uint256 t = 0; t < 5; t++) {
            if (holdings[t] == 0) continue;
            TegridyCurveLauncher.Launch memory live = launcher.getLaunch(token);
            if (live.graduated) break;
            vm.startPrank(traders[t]);
            IERC20(token).approve(address(launcher), holdings[t]);
            launcher.sell(token, holdings[t], 0);
            vm.stopPrank();
        }

        // The contract's real balance always covers the internal ledger.
        TegridyCurveLauncher.Launch memory fin = launcher.getLaunch(token);
        uint256 owed = fin.ethReserve + launcher.creatorFeeOf(token) + launcher.protocolFees() + launcher.treasuryFees();
        assertGe(address(launcher).balance, owed);
    }
}
