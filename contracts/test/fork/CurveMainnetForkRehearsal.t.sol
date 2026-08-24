// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TegridyCurveLauncher} from "../../src/curve/TegridyCurveLauncher.sol";

// Mainnet-fork REHEARSAL of the own-curve go-live: deploy TegridyCurveLauncher
// against the REAL mainnet TegridyFactory + REAL WETH9, then run a full
// create -> buy -> graduation against them. This proves the graduation actually
// creates a pair on the live factory, deposits into real WETH9, burns all LP,
// and delivers the reserve — before any gas is spent on a real deploy.
//
// FORK-ONLY. It self-skips when ETH_RPC_URL is unset (CI has no fork RPC), and
// the slice manifest excludes test/fork/*.t.sol for the same reason. Run it with:
//   ETH_RPC_URL=https://ethereum-rpc.publicnode.com forge test \
//     --match-path "test/fork/CurveMainnetForkRehearsal.t.sol" -vv

interface IFactoryFork {
    function getPair(address, address) external view returns (address);
    function allPairsLength() external view returns (uint256);
}

interface IPairFork {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

contract CurveMainnetForkRehearsal is Test {
    // Real mainnet addresses (frontend/scripts/addresses.json).
    address constant FACTORY = 0xa24C7287eC56A7DEFDc70033803451240e267a52; // Tegridy DEX factory
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // canonical WETH9
    address constant TREASURY_SAFE = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d; // a real Safe (contract)
    // The owner-decided reserve recipient (operator EOA — CV-3c accepts it).
    address constant RESERVE_RECIPIENT = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address constant CREATOR = address(0xC0FFEE);
    address constant BUYER = address(0xB0B);

    TegridyCurveLauncher internal launcher;
    bool internal forked;
    // On a mainnet fork the freshly-deployed launcher's CREATE address can
    // collide with a real account that already holds ETH; the launcher is not
    // payable, so any starting balance is that artifact. Record it and measure
    // the DELTA so the conservation check stays exact.
    uint256 internal initialLauncherBalance;

    function setUp() public {
        string memory url = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(url).length == 0) return; // no fork RPC → self-skip
        vm.createSelectFork(url);
        forked = true;

        // The mainnet deploy defaults, verbatim from the deploy script.
        TegridyCurveLauncher.LaunchConfig memory cfg = TegridyCurveLauncher.LaunchConfig({
            virtualEth: uint128(uint256(4 ether) / 19),
            graduationEth: 4 ether,
            feeBps: 100,
            creatorFeeShareBps: 4_000,
            treasuryFeeShareBps: 2_500,
            reserveBps: 369,
            reserveRecipient: RESERVE_RECIPIENT
        });
        // MULTISIG + PAUSE_GUARDIAN use the real Treasury Safe (a live contract),
        // TREASURY = the same Safe (its registry role IS the fee-line destination).
        launcher = new TegridyCurveLauncher(
            FACTORY, WETH, TREASURY_SAFE, TREASURY_SAFE, TREASURY_SAFE, cfg
        );
        initialLauncherBalance = address(launcher).balance;
    }

    function test_FullLifecycleAgainstRealMainnetFactory() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        // We are really on mainnet, and the real integration points have code.
        assertEq(block.chainid, 1, "not forked onto mainnet");
        assertGt(FACTORY.code.length, 0, "real factory missing");
        assertGt(WETH.code.length, 0, "real WETH missing");
        assertEq(address(launcher.FACTORY()), FACTORY);
        assertEq(launcher.owner(), TREASURY_SAFE);

        vm.deal(CREATOR, 20 ether);
        vm.deal(BUYER, 20 ether);

        vm.prank(CREATOR);
        address token = launcher.create("Fork Rehearsal", "FORK");

        uint256 expectedReserve = (launcher.TOTAL_SUPPLY() * 369) / 10_000;
        TegridyCurveLauncher.Launch memory l0 = launcher.getLaunch(token);
        assertEq(l0.reserveAmount, expectedReserve);
        assertFalse(l0.graduated);

        // Buy past the 4-ETH graduation target.
        vm.prank(BUYER);
        launcher.buy{value: 2 ether}(token, 0);
        vm.prank(CREATOR);
        launcher.buy{value: 3 ether}(token, 0); // crosses 4 ETH → graduates

        TegridyCurveLauncher.Launch memory l = launcher.getLaunch(token);
        assertTrue(l.graduated, "must graduate against the real factory");
        assertEq(l.ethReserve, 0);

        // The pair was created on the REAL mainnet factory.
        address pair = IFactoryFork(FACTORY).getPair(token, WETH);
        assertTrue(pair != address(0), "real factory should now hold the pair");
        assertGt(IPairFork(pair).totalSupply(), 0);

        // ALL LP burned to 0xdead — the credibility floor is real.
        assertEq(
            IPairFork(pair).balanceOf(DEAD),
            IPairFork(pair).totalSupply(),
            "all LP must be burned"
        );
        // Real WETH9 balance sits in the pool (>= the graduation target).
        assertGe(IERC20(WETH).balanceOf(pair), 4 ether);
        // Unsold curve tokens are in the pool.
        assertGt(IERC20(token).balanceOf(pair), 0);
        // The 3.69% reserve was delivered to custody.
        assertEq(IERC20(token).balanceOf(RESERVE_RECIPIENT), expectedReserve);

        // Fees survived and reconcile: creator + treasury + protocol == the
        // launcher's whole ETH balance (nothing stranded, nothing over-paid).
        uint256 cf = launcher.creatorFeeOf(token);
        uint256 tf = launcher.treasuryFees();
        uint256 pf = launcher.protocolFees();
        uint256 fees = cf + tf + pf;
        // The 3-way split is exact (40/25/35 of the 1% fee on 5 ETH of buys).
        assertEq(cf, 0.02 ether);
        assertEq(tf, 0.0125 ether);
        assertEq(pf, 0.0175 ether);
        // Conservation: everything the launcher gained beyond its fork-artifact
        // starting balance is exactly the accrued fees (pool got the rest).
        assertEq(address(launcher).balance - initialLauncherBalance, fees);
        assertGt(fees, 0);
    }
}
