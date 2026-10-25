// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DeployNFTPoolFactoryScript} from "../../script/DeployNFTPoolFactory.s.sol";
import {TegridyNFTPoolFactory} from "../../src/TegridyNFTPoolFactory.sol";
import {TegridyNFTPool} from "../../src/TegridyNFTPool.sol";
import {NFTPoolRoundTrip} from "../helpers/NFTPoolRoundTrip.sol";

// Mainnet-fork rehearsal of the NFT pool factory redeploy (docs/NFT_POOL_FACTORY_REDEPLOY.md).
// The live factory's template pays a buy's ERC-2981 royalty out of the pool's own ETH; the
// new one charges the buyer. FORK-ONLY: self-skips without ETH_RPC_URL (CI has none). Run:
//   ETH_RPC_URL=https://eth.drpc.org forge test --match-path "test/fork/NFTPoolRoyaltyForkRehearsal.t.sol" -vv
// Before the deploy it builds a new factory here: the live owner, treasury and WETH at the
// script's default fee. After it, add NEW_FACTORY=<address> to rehearse the deployed one.
contract NFTPoolRoyaltyForkRehearsal is NFTPoolRoundTrip {
    address internal constant LIVE_FACTORY = 0xbB8E49Ba4e3A85E2B8B70e00208770F429B56F5B;
    address internal constant LIVE_TEMPLATE = 0x98553C2a3593c388415f866dCBa4348532ff481A;
    bytes4 internal constant GET_BUY_QUOTE = bytes4(keccak256("getBuyQuote(uint256)"));
    bytes4 internal constant GET_BUY_QUOTE_WITH_ROYALTY = bytes4(keccak256("getBuyQuoteWithRoyalty(uint256)"));
    bytes4 internal constant GET_SELL_QUOTE_WITH_ROYALTY = bytes4(keccak256("getSellQuoteWithRoyalty(uint256)"));
    uint256 internal constant NEW_FEE_BPS = 25;

    bool internal forked;
    TegridyNFTPoolFactory internal live = TegridyNFTPoolFactory(payable(LIVE_FACTORY));
    TegridyNFTPoolFactory internal fresh;

    function setUp() public {
        string memory url = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        fresh = TegridyNFTPoolFactory(payable(vm.envOr("NEW_FACTORY", address(0))));
        if (address(fresh) == address(0)) {
            DeployNFTPoolFactoryScript script = new DeployNFTPoolFactoryScript();
            fresh = script.runForTest(
                DeployNFTPoolFactoryScript.Config({
                    multisig: live.owner(),
                    protocolFeeBps: script.DEFAULT_PROTOCOL_FEE_BPS(),
                    treasury: live.protocolFeeRecipient(),
                    weth: live.weth()
                })
            );
        }
    }

    function test_liveTemplate_isThePreFixBuild() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(live.poolImplementation(), LIVE_TEMPLATE, "live factory points elsewhere");
        assertEq(live.getPoolCount(), 0, "the live factory has pools: they need a migration plan");
        // Non-vacuity: the scan finds a selector both builds have.
        assertTrue(_dispatches(LIVE_TEMPLATE, GET_BUY_QUOTE), "selector scan is blind");
        assertFalse(_dispatches(LIVE_TEMPLATE, GET_BUY_QUOTE_WITH_ROYALTY), "live template has the fix");
        assertFalse(_dispatches(LIVE_TEMPLATE, GET_SELL_QUOTE_WITH_ROYALTY), "live template has the fix");
    }

    function test_liveFactory_poolPaysTheBuyRoyalty() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 loss = _roundTripLoss(LIVE_FACTORY);
        emit log_named_decimal_uint("live template: pool ETH lost over the round trips", loss, 18);
        assertGt(loss, 1 ether, "live template no longer drains");
    }

    // 0.25% a swap, half the live factory's 0.5%: the owner's call of 2026-10-18.
    function test_newFactory_at25Bps_toTheSameTreasury_andTheBuyerPays() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        address template = fresh.poolImplementation();
        assertTrue(fresh.owner().code.length > 0, "owner is not a contract");
        assertEq(fresh.protocolFeeBps(), NEW_FEE_BPS, "protocol fee is not 25 bps");
        assertEq(fresh.protocolFeeRecipient(), live.protocolFeeRecipient(), "fee recipient changed");
        assertEq(fresh.weth(), live.weth(), "weth changed");
        assertEq(fresh.POOL_OPENING_FEE(), 0.006 ether, "opening a pool does not cost 0.006 ETH");
        assertTrue(_dispatches(template, GET_BUY_QUOTE_WITH_ROYALTY), "new template lacks the fix");
        assertEq(keccak256(template.code), keccak256(type(TegridyNFTPool).runtimeCode), "template != this tree's build");
        assertEq(_roundTripLoss(address(fresh)), 0, "the pool paid the buy-side royalty");
    }

    /// True when `target`'s code PUSH4es `selector`, as solc's dispatcher does.
    function _dispatches(address target, bytes4 selector) internal view returns (bool) {
        bytes memory code = target.code;
        for (uint256 i = 0; i + 4 < code.length; i++) {
            if (
                code[i] == 0x63 && code[i + 1] == selector[0] && code[i + 2] == selector[1]
                    && code[i + 3] == selector[2] && code[i + 4] == selector[3]
            ) return true;
        }
        return false;
    }
}
