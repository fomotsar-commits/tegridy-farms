// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployPoolOpeningFeeAMMScript} from "../script/DeployPoolOpeningFeeAMM.s.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";

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
}

// The script that ships the 0.006 ETH opening fee for coin pools (owner ruling 2026-10-25):
// a new factory and a router bound to it, roles on Safes from the first block.
contract PoolOpeningFeeAMMDeployTest is Test {
    DeployPoolOpeningFeeAMMScript internal script;

    address internal constant SETTER = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant TREASURY = address(0x7EA5);
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
            feeToSetter: SETTER, guardian: GUARDIAN, treasury: TREASURY, weth: address(weth)
        });
    }

    function test_deploysTheFeeFactory_andARouterBoundToIt() public {
        (TegridyFactory factory, TegridyRouter router) = script.runForTest(_cfg());
        assertEq(factory.POOL_OPENING_FEE(), 0.006 ether);
        assertEq(factory.feeTo(), TREASURY);
        assertEq(factory.feeToSetter(), SETTER);
        assertEq(factory.guardian(), GUARDIAN);
        assertEq(router.factory(), address(factory));
        assertEq(router.WETH(), address(weth));
    }

    function test_scriptRouter_opensAPool_andTheTreasuryGetsTheFee() public {
        (TegridyFactory factory, TegridyRouter router) = script.runForTest(_cfg());
        DeployFeeToken token = new DeployFeeToken();
        token.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 1 ether + 0.006 ether}(
            address(token), 1_000 ether, 0, 0, address(this), block.timestamp + 60
        );
        assertEq(factory.allPairsLength(), 1);
        assertEq(TREASURY.balance, 0.006 ether, "the treasury did not get the opening fee");
        assertEq(weth.balanceOf(factory.getPair(address(token), address(weth))), 1 ether);
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

    receive() external payable {}
}
