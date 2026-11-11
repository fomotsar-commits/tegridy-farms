// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DeployNFTPoolFactoryScript} from "../script/DeployNFTPoolFactory.s.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";
import {NFTPoolRoundTrip} from "./helpers/NFTPoolRoundTrip.sol";

// The script that ships the NFT pool template fix. The mainnet factory's template pays a
// buy's ERC-2981 royalty out of the pool's own ETH; the template this script deploys must
// charge it to the buyer. The same loop against mainnet: test/fork/NFTPoolRoyaltyForkRehearsal.t.sol.
contract TegridyNFTPoolFactoryDeployTest is NFTPoolRoundTrip {
    DeployNFTPoolFactoryScript internal script;

    address internal constant MULTISIG = address(0xA11CE);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant WETH = address(0xE7E7);

    function setUp() public {
        script = new DeployNFTPoolFactoryScript();
        vm.chainId(1);
        vm.etch(MULTISIG, hex"60006000fd"); // the owner must be a contract (a Safe)
    }

    function _cfg() internal view returns (DeployNFTPoolFactoryScript.Config memory) {
        return DeployNFTPoolFactoryScript.Config({
            multisig: MULTISIG, protocolFeeBps: script.DEFAULT_PROTOCOL_FEE_BPS(), treasury: TREASURY, weth: WETH
        });
    }

    // 0.25% a swap, half the live factory's 0.5%: the owner's call of 2026-10-18.
    function test_deploysAt25BpsOwnedByTheSafe() public {
        assertEq(script.DEFAULT_PROTOCOL_FEE_BPS(), 25, "default fee is not 25 bps");
        TegridyNFTPoolFactory factory = script.runForTest(_cfg());
        assertEq(factory.owner(), MULTISIG);
        assertEq(factory.protocolFeeBps(), 25);
        assertEq(factory.protocolFeeRecipient(), TREASURY);
        assertEq(factory.weth(), WETH);
        assertEq(factory.getPoolCount(), 0);
    }

    // Opening a pool costs 0.006 ETH, paid to the treasury: the owner's call of 2026-10-25.
    function test_scriptFactory_chargesTheOpeningFee_toTheTreasury() public {
        TegridyNFTPoolFactory factory = script.runForTest(_cfg());
        assertEq(factory.POOL_OPENING_FEE(), 0.006 ether);
        uint256 before = TREASURY.balance;
        _roundTripLoss(address(factory));
        assertEq(TREASURY.balance - before, 0.006 ether, "the treasury did not get the opening fee");
    }

    function test_scriptTemplate_roundTripsCostThePoolNothing() public {
        TegridyNFTPoolFactory factory = script.runForTest(_cfg());
        assertEq(_roundTripLoss(address(factory)), 0, "the pool paid the buy-side royalty");
    }

    function test_refusesOffMainnet() public {
        // Built first: _cfg() calls the script, and expectRevert would catch that call instead.
        DeployNFTPoolFactoryScript.Config memory cfg = _cfg();
        vm.chainId(31337);
        vm.expectRevert(bytes("MAINNET_ONLY: gated features deploy to Ethereum mainnet"));
        script.runForTest(cfg);
    }

    function test_refusesAnOwnerWithNoCode() public {
        DeployNFTPoolFactoryScript.Config memory cfg = _cfg();
        cfg.multisig = makeAddr("eoa-owner");
        vm.expectRevert(bytes("MULTISIG must be a contract (Safe)"));
        script.runForTest(cfg);
    }
}
