// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployPoolOpeningFeeAMMScript} from "../script/DeployPoolOpeningFeeAMM.s.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";

contract DeployFeeToken is ERC20 {
    constructor() ERC20("Token", "TKN") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract DeployFeeWETH is ERC20 {
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

// The script that ships the 0.006 ETH opening fee for coin pools (owner ruling 2026-10-25):
// a new factory, a router bound to it, and a SwapFeeRouter bound to that router so its pools
// pay the same venue fee as the live pool. Roles on Safes from the first block.
contract PoolOpeningFeeAMMDeployTest is Test {
    DeployPoolOpeningFeeAMMScript internal script;

    address internal constant SETTER = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant DISTRIBUTOR = address(0xD157);
    DeployFeeWETH internal weth;

    function setUp() public {
        script = new DeployPoolOpeningFeeAMMScript();
        weth = new DeployFeeWETH();
        vm.chainId(1);
        vm.etch(SETTER, hex"60006000fd"); // both roles must be contracts (Safes)
        vm.etch(GUARDIAN, hex"60006000fd");
    }

    function _cfg() internal view returns (DeployPoolOpeningFeeAMMScript.Config memory) {
        return DeployPoolOpeningFeeAMMScript.Config({
            feeToSetter: SETTER,
            guardian: GUARDIAN,
            treasury: TREASURY,
            weth: address(weth),
            revenueDistributor: DISTRIBUTOR,
            referralSplitter: address(0),
            swapFeeBps: 50,
            pauseGuardian: address(0)
        });
    }

    function test_deploysTheFeeFactory_andARouterBoundToIt() public {
        DeployPoolOpeningFeeAMMScript.Deployed memory d = script.runForTest(_cfg());
        assertEq(d.factory.POOL_OPENING_FEE(), 0.006 ether);
        assertEq(d.factory.feeTo(), TREASURY);
        assertEq(d.factory.feeToSetter(), SETTER);
        assertEq(d.factory.guardian(), GUARDIAN);
        assertEq(d.router.factory(), address(d.factory));
        assertEq(d.router.WETH(), address(weth));
    }

    function test_deploysASwapFeeRouter_onTheNewRouter_handedToTheSafe() public {
        DeployPoolOpeningFeeAMMScript.Deployed memory d = script.runForTest(_cfg());
        SwapFeeRouter sfr = d.swapFeeRouter;
        assertEq(address(sfr.router()), address(d.router), "bound to the new router");
        assertEq(sfr.feeBps(), 50, "the live SwapFeeRouter's fee");
        assertEq(sfr.treasury(), TREASURY);
        assertEq(sfr.revenueDistributor(), DISTRIBUTOR);
        assertEq(sfr.swapFeeRouterAdmin(), address(d.swapFeeRouterAdmin));
        assertEq(sfr.pendingOwner(), SETTER, "the Safe accepts ownership");
        assertEq(d.swapFeeRouterAdmin.pendingOwner(), SETTER);
    }

    function test_scriptRouter_opensAPool_andTheTreasuryGetsTheFee() public {
        DeployPoolOpeningFeeAMMScript.Deployed memory d = script.runForTest(_cfg());
        DeployFeeToken token = new DeployFeeToken();
        token.approve(address(d.router), type(uint256).max);
        d.router.addLiquidityETH{value: 1 ether + 0.006 ether}(
            address(token), 1_000 ether, 0, 0, address(this), block.timestamp + 60
        );
        assertEq(d.factory.allPairsLength(), 1);
        assertEq(TREASURY.balance, 0.006 ether, "the treasury did not get the opening fee");
        assertEq(weth.balanceOf(d.factory.getPair(address(token), address(weth))), 1 ether);
    }

    // A pool opened on the new factory is swapped through the new SwapFeeRouter, which keeps
    // the venue's 0.5% exactly as the live one does on today's pool.
    function test_swapOnANewPool_throughTheNewSwapFeeRouter_takesTheVenueFee() public {
        DeployPoolOpeningFeeAMMScript.Deployed memory d = script.runForTest(_cfg());
        DeployFeeToken token = new DeployFeeToken();
        token.approve(address(d.router), type(uint256).max);
        d.router.addLiquidityETH{value: 10 ether + 0.006 ether}(
            address(token), 10_000 ether, 0, 0, address(this), block.timestamp + 60
        );

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(token);
        address trader = makeAddr("trader");
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        d.swapFeeRouter.swapExactETHForTokens{value: 1 ether}(0, path, trader, block.timestamp + 60, 100);

        assertEq(d.swapFeeRouter.totalETHFees(), 0.005 ether, "0.5% of the input is the venue's");
        assertEq(address(d.swapFeeRouter).balance, 0.005 ether, "the fee waits in the SwapFeeRouter");
        assertGt(token.balanceOf(trader), 0, "the trader got tokens from the new pool");
    }

    function test_refusesOffMainnet() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("MAINNET_ONLY: gated features deploy to Ethereum mainnet"));
        script.runForTest(_cfg());
    }

    function test_refusesASetterWithNoCode() public {
        DeployPoolOpeningFeeAMMScript.Config memory cfg = _cfg();
        cfg.feeToSetter = makeAddr("hot-eoa");
        vm.expectRevert(bytes("FEE_TO_SETTER must be a contract (Safe)"));
        script.runForTest(cfg);
    }

    function test_refusesAGuardianWithNoCode() public {
        DeployPoolOpeningFeeAMMScript.Config memory cfg = _cfg();
        cfg.guardian = makeAddr("hot-eoa");
        vm.expectRevert(bytes("GUARDIAN must be a contract (Safe)"));
        script.runForTest(cfg);
    }

    function test_refusesASwapFeeOtherThanTheLiveOne() public {
        DeployPoolOpeningFeeAMMScript.Config memory cfg = _cfg();
        cfg.swapFeeBps = 30;
        vm.expectRevert(bytes("SWAP_FEE_BPS != the live SwapFeeRouter's 50"));
        script.runForTest(cfg);
    }

    receive() external payable {}
}
