// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployPoolOpeningFeeAMMScript} from "../../script/DeployPoolOpeningFeeAMM.s.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";

contract L2RehearsalToken is ERC20 {
    constructor() ERC20("Rehearsal", "RHR") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

// Base and Robinhood forks of the coin-pool opening fee (owner 2026-11-07: "Add Base + Robinhood
// too", fee to the treasury Safe). The script's factory, router and SwapFeeRouter, configured from
// that chain's LIVE SwapFeeRouter and factory, so a paste slip in the runbook shows up here first.
// What it proves that a local test cannot: the real treasury Safe on that chain takes the 0.006 ETH
// inside the factory's 30k-gas transfer, every role is a real Safe, and the live sequencer feed
// passes the script's check. FORK-ONLY: each contract self-skips without its RPC (CI has none). Run:
//   BASE_RPC_URL=https://mainnet.base.org ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
//     forge test --match-path "test/fork/PoolOpeningFeeL2ForkRehearsal.t.sol" -vv
abstract contract PoolOpeningFeeL2ForkRehearsal is Test {
    address internal constant L2_TREASURY_SAFE = 0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0;
    address internal constant L2_REMITTANCE_SAFE = 0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1;
    address internal constant L2_MULTISIG = 0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B;

    bool internal forked;
    TegridyFactory internal factory;
    TegridyRouter internal router;
    SwapFeeRouter internal swapFeeRouter;

    function _rpcEnv() internal pure virtual returns (string memory);
    function _liveFactory() internal pure virtual returns (address);
    function _liveSwapFeeRouter() internal pure virtual returns (address);

    function setUp() public {
        string memory url = vm.envOr(_rpcEnv(), string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        SwapFeeRouter live = SwapFeeRouter(payable(_liveSwapFeeRouter()));
        DeployPoolOpeningFeeAMMScript.Deployed memory d = new DeployPoolOpeningFeeAMMScript().runForTest(
            DeployPoolOpeningFeeAMMScript.Config({
                feeToSetter: L2_MULTISIG,
                guardian: TegridyFactory(_liveFactory()).guardian(),
                treasury: L2_TREASURY_SAFE,
                weth: live.WETH(),
                revenueDistributor: live.revenueDistributor(),
                referralSplitter: address(live.referralSplitter()),
                swapFeeBps: live.feeBps(),
                pauseGuardian: live.pauseGuardian(),
                sequencerFeed: live.sequencerFeed()
            })
        );
        (factory, router, swapFeeRouter) = (d.factory, d.router, d.swapFeeRouter);
    }

    function test_theLiveFactory_staysFree_theNewOnePaysTheTreasury() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(TegridyFactory(_liveFactory()).feeTo(), L2_REMITTANCE_SAFE, "live feeTo moved");
        assertEq(factory.feeTo(), L2_TREASURY_SAFE, "new feeTo is not the treasury Safe");
        assertEq(factory.POOL_OPENING_FEE(), 0.006 ether);
        SwapFeeRouter live = SwapFeeRouter(payable(_liveSwapFeeRouter()));
        assertEq(swapFeeRouter.feeBps(), live.feeBps(), "venue fee differs from the live pools'");
        assertEq(swapFeeRouter.treasury(), live.treasury(), "treasury differs");
        assertEq(swapFeeRouter.revenueDistributor(), L2_REMITTANCE_SAFE, "swap fees no longer queue for the bridge");
        assertEq(swapFeeRouter.sequencerFeed(), live.sequencerFeed(), "sequencer feed differs");
    }

    function test_openingAPool_paysTheTreasurySafe_andASwapTakesTheVenueFee() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address opener = makeAddr("opener");
        vm.deal(opener, 2 ether);
        vm.prank(opener);
        L2RehearsalToken token = new L2RehearsalToken();
        uint256 safeBefore = L2_TREASURY_SAFE.balance;
        uint256 remittanceBefore = L2_REMITTANCE_SAFE.balance;

        vm.startPrank(opener);
        token.approve(address(router), type(uint256).max);
        (, uint256 amountETH,) =
            router.addLiquidityETH{value: 1 ether + 0.006 ether}(address(token), 1_000_000 ether, 0, 0, opener, block.timestamp + 60);
        vm.stopPrank();

        assertEq(L2_TREASURY_SAFE.balance - safeBefore, 0.006 ether, "the treasury Safe did not take the fee");
        assertEq(L2_REMITTANCE_SAFE.balance, remittanceBefore, "the remittance Safe took opening money");
        assertEq(amountETH, 1 ether, "the fee went into the pool");

        address trader = makeAddr("trader");
        vm.deal(trader, 1 ether);
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(token);
        vm.prank(trader);
        swapFeeRouter.swapExactETHForTokens{value: 0.1 ether}(0, path, trader, block.timestamp + 60, 100);
        assertEq(swapFeeRouter.totalETHFees(), 0.0005 ether, "0.5% of the input is the venue's");
        assertGt(IERC20(address(token)).balanceOf(trader), 0, "the trader got tokens from the new pool");
    }
}

contract PoolOpeningFeeBaseForkRehearsal is PoolOpeningFeeL2ForkRehearsal {
    function _rpcEnv() internal pure override returns (string memory) {
        return "BASE_RPC_URL";
    }

    function _liveFactory() internal pure override returns (address) {
        return 0x12a249A027AA7DdF184E824b4bb63ba031A39fEC;
    }

    function _liveSwapFeeRouter() internal pure override returns (address) {
        return 0xa24C7287eC56A7DEFDc70033803451240e267a52;
    }
}

contract PoolOpeningFeeRobinhoodForkRehearsal is PoolOpeningFeeL2ForkRehearsal {
    function _rpcEnv() internal pure override returns (string memory) {
        return "ROBINHOOD_RPC_URL";
    }

    function _liveFactory() internal pure override returns (address) {
        return 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3;
    }

    function _liveSwapFeeRouter() internal pure override returns (address) {
        return 0xE9F83A07b071748E795d2489651d5310fA098Db8;
    }
}
