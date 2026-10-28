// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployPoolOpeningFeeAMMScript} from "../../script/DeployPoolOpeningFeeAMM.s.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";

// Mainnet-fork rehearsal of the coin-pool opening fee (docs/POOL_OPENING_FEE_EVM.md): the
// script's factory, router and SwapFeeRouter, wired to the live treasury Safe, RevenueDistributor
// and ReferralSplitter, with real WETH and a real token. What it proves that a local test cannot:
// the treasury Safe accepts the 0.006 ETH inside the factory's 30k-gas transfer, and a swap on
// the new pool through the new SwapFeeRouter takes the venue's 0.5% with the live splitter wired.
// FORK-ONLY: self-skips without ETH_RPC_URL (CI has none). Run:
//   ETH_RPC_URL=https://eth.drpc.org forge test --match-path "test/fork/PoolOpeningFeeForkRehearsal.t.sol" -vv
// After the deploy, add NEW_FACTORY=<address> NEW_ROUTER=<address> NEW_SWAP_FEE_ROUTER=<address>
// to rehearse the deployed contracts.
contract PoolOpeningFeeForkRehearsal is Test {
    address internal constant LIVE_FACTORY = 0xa24C7287eC56A7DEFDc70033803451240e267a52;
    address internal constant TREASURY_SAFE = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;
    address internal constant OWNER_SAFE = 0xA36053477568Fb5382492F3A5970D35Fe896b7F8;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address internal constant LIVE_SWAP_FEE_ROUTER = 0x6d5791A660e79175F74C6D639584C98422d5956E;

    bool internal forked;
    TegridyFactory internal factory;
    TegridyRouter internal router;
    SwapFeeRouter internal swapFeeRouter;

    function setUp() public {
        string memory url = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        factory = TegridyFactory(vm.envOr("NEW_FACTORY", address(0)));
        router = TegridyRouter(payable(vm.envOr("NEW_ROUTER", address(0))));
        swapFeeRouter = SwapFeeRouter(payable(vm.envOr("NEW_SWAP_FEE_ROUTER", address(0))));
        if (address(factory) == address(0)) {
            SwapFeeRouter live = SwapFeeRouter(payable(LIVE_SWAP_FEE_ROUTER));
            DeployPoolOpeningFeeAMMScript.Deployed memory d = new DeployPoolOpeningFeeAMMScript().runForTest(
                DeployPoolOpeningFeeAMMScript.Config({
                    feeToSetter: OWNER_SAFE,
                    guardian: OWNER_SAFE,
                    treasury: TREASURY_SAFE,
                    weth: WETH,
                    revenueDistributor: live.revenueDistributor(),
                    referralSplitter: address(live.referralSplitter()),
                    swapFeeBps: live.feeBps(),
                    pauseGuardian: live.pauseGuardian()
                })
            );
            (factory, router, swapFeeRouter) = (d.factory, d.router, d.swapFeeRouter);
        }
    }

    function test_theLiveFactory_isStillTheFreeOne_andFeeToIsTheTreasury() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(TegridyFactory(LIVE_FACTORY).feeTo(), TREASURY_SAFE, "live feeTo moved");
        assertEq(factory.feeTo(), TREASURY_SAFE, "new feeTo is not the treasury Safe");
        assertEq(factory.POOL_OPENING_FEE(), 0.006 ether);
        assertEq(router.factory(), address(factory));
        SwapFeeRouter live = SwapFeeRouter(payable(LIVE_SWAP_FEE_ROUTER));
        assertEq(address(swapFeeRouter.router()), address(router), "new SwapFeeRouter not on the new router");
        assertEq(swapFeeRouter.feeBps(), live.feeBps(), "venue fee differs from the live pool's");
        assertEq(swapFeeRouter.treasury(), live.treasury(), "treasury differs");
        assertEq(swapFeeRouter.revenueDistributor(), live.revenueDistributor(), "distributor differs");
    }

    function test_aSwapOnTheNewPool_throughTheNewSwapFeeRouter_takesTheVenueFee() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address opener = makeAddr("opener");
        vm.deal(opener, 2 ether);
        deal(TOWELI, opener, 1_000_000 ether);
        vm.startPrank(opener);
        IERC20(TOWELI).approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 1 ether + 0.006 ether}(TOWELI, 1_000_000 ether, 0, 0, opener, block.timestamp + 60);
        vm.stopPrank();

        address trader = makeAddr("trader");
        vm.deal(trader, 1 ether);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = TOWELI;
        uint256 feesBefore = swapFeeRouter.totalETHFees();
        vm.prank(trader);
        swapFeeRouter.swapExactETHForTokens{value: 0.1 ether}(0, path, trader, block.timestamp + 60, 100);

        assertEq(swapFeeRouter.totalETHFees() - feesBefore, 0.0005 ether, "0.5% of the input is the venue's");
        assertGt(IERC20(TOWELI).balanceOf(trader), 0, "the trader got TOWELI from the new pool");
    }

    function test_openingAToweliEthPool_paysTheTreasurySafe() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address opener = makeAddr("opener");
        vm.deal(opener, 2 ether);
        deal(TOWELI, opener, 1_000_000 ether);
        uint256 safeBefore = TREASURY_SAFE.balance;

        vm.startPrank(opener);
        IERC20(TOWELI).approve(address(router), type(uint256).max);
        (, uint256 amountETH,) = router.addLiquidityETH{value: 1 ether + 0.006 ether}(
            TOWELI, 1_000_000 ether, 0, 0, opener, block.timestamp + 60
        );
        vm.stopPrank();

        assertEq(TREASURY_SAFE.balance - safeBefore, 0.006 ether, "the Safe did not take the fee");
        assertEq(amountETH, 1 ether, "the fee went into the pool");
        assertEq(opener.balance, 2 ether - 1 ether - 0.006 ether);
    }
}
