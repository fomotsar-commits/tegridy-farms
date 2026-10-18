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

    function _cfg() internal pure returns (DeployNFTPoolFactoryScript.Config memory) {
        return
            DeployNFTPoolFactoryScript.Config({multisig: MULTISIG, protocolFeeBps: 50, treasury: TREASURY, weth: WETH});
    }

    function test_deploysTheLiveTermsOwnedByTheSafe() public {
        TegridyNFTPoolFactory factory = script.runForTest(_cfg());
        assertEq(factory.owner(), MULTISIG);
        assertEq(factory.protocolFeeBps(), 50);
        assertEq(factory.protocolFeeRecipient(), TREASURY);
        assertEq(factory.weth(), WETH);
        assertEq(factory.getPoolCount(), 0);
    }

    function test_scriptTemplate_roundTripsCostThePoolNothing() public {
        TegridyNFTPoolFactory factory = script.runForTest(_cfg());
        assertEq(_roundTripLoss(address(factory)), 0, "the pool paid the buy-side royalty");
    }

    function test_refusesOffMainnet() public {
        vm.chainId(31337);
        vm.expectRevert(bytes("MAINNET_ONLY: gated features deploy to Ethereum mainnet"));
        script.runForTest(_cfg());
    }

    function test_refusesAnOwnerWithNoCode() public {
        DeployNFTPoolFactoryScript.Config memory cfg = _cfg();
        cfg.multisig = makeAddr("eoa-owner");
        vm.expectRevert(bytes("MULTISIG must be a contract (Safe)"));
        script.runForTest(cfg);
    }
}
