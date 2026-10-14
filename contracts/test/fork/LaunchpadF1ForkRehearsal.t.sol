// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {TegridyLaunchpadV2} from "../../src/TegridyLaunchpadV2.sol";
import {TegridyDropV2} from "../../src/TegridyDropV2.sol";

// Mainnet-fork REHEARSAL of the launchpad redeploy (audit finding F1, release 3 of
// docs/audits/audit_101/OPEN_FINDINGS_FIXED_IN_SOURCE_2026_10_14.md).
//
// It runs the same steps on two launchpads on one fork:
//   OLD  the live TegridyLaunchpadV2 0xa6149B4d…, whose template still has F1;
//   NEW  the replacement: the address in NEW_LAUNCHPAD when set (a deploy made by
//        script/DeployLaunchpadV2.s.sol on an anvil fork, or the real one after the
//        mainnet deploy), otherwise one built here from this checkout's source.
// and shows the F1 steps succeed on OLD and are refused on NEW, that NEW carries the
// live settings, and that a normal sale on NEW pays the creator and the venue.
//
// FORK-ONLY. It self-skips when ETH_RPC_URL is unset (CI has no fork RPC), and the
// slice manifest excludes test/fork/*.t.sol for the same reason. Run it with:
//   ETH_RPC_URL=https://eth.drpc.org [NEW_LAUNCHPAD=0x…] forge test \
//     --match-path "test/fork/LaunchpadF1ForkRehearsal.t.sol" -vv

contract LaunchpadF1ForkRehearsal is Test {
    // Real mainnet addresses (frontend/scripts/addresses.json).
    address constant OLD_LAUNCHPAD = 0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7;
    address constant OLD_TEMPLATE = 0xA35ec3e20C4361144b0D99573DEa00B67873e872;
    address constant OWNER = 0x14898258122C0740106391E6e8E4F17F3b6d456E; // owns every EVM contract
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d; // the fee recipient
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    uint256 constant FIXED_PRICE = 0.05 ether;
    uint256 constant CURVE_START = 1 ether;
    uint256 constant CURVE_END = 0.1 ether;
    uint256 constant CURVE_LENGTH = 12 hours;

    address creator = makeAddr("f1-creator");
    address buyer = makeAddr("f1-buyer");

    TegridyLaunchpadV2 oldLp;
    TegridyLaunchpadV2 newLp;
    bool forked;
    bool newBuiltHere;

    function setUp() public {
        string memory url = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(url).length == 0) return; // no fork RPC: self-skip
        vm.createSelectFork(url);
        forked = true;

        oldLp = TegridyLaunchpadV2(OLD_LAUNCHPAD);
        address given = vm.envOr("NEW_LAUNCHPAD", address(0));
        if (given == address(0)) {
            // The deploy script's constructor arguments, verbatim.
            vm.prank(OWNER);
            newLp = new TegridyLaunchpadV2(OWNER, 500, TREASURY, WETH, address(0));
            newBuiltHere = true;
        } else {
            newLp = TegridyLaunchpadV2(given);
        }
        vm.deal(buyer, 10 ether);
    }

    modifier onlyForked() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ─── helpers ──────────────────────────────────────────────────────

    function _cfg(string memory name, uint256 price, bool withCurve, TegridyDropV2.MintPhase phase)
        internal
        view
        returns (TegridyLaunchpadV2.CollectionConfig memory c)
    {
        c.name = name;
        c.symbol = "F1R";
        c.maxSupply = 100;
        c.mintPrice = price;
        c.royaltyBps = 500;
        if (withCurve) {
            c.dutchStartPrice = CURVE_START;
            c.dutchEndPrice = CURVE_END;
            c.dutchStartTime = block.timestamp;
            c.dutchDuration = CURVE_LENGTH;
        }
        c.initialPhase = phase;
    }

    /// A collection CLOSED, carrying a 0.05 ETH fixed price and a 1 -> 0.1 ETH curve.
    function _bothPrices(TegridyLaunchpadV2 lp, string memory name) internal returns (TegridyDropV2 drop) {
        vm.prank(creator);
        (, address c) = lp.createCollection(_cfg(name, FIXED_PRICE, true, TegridyDropV2.MintPhase.CLOSED));
        drop = TegridyDropV2(payable(c));
    }

    function _setPhase(TegridyDropV2 drop, TegridyDropV2.MintPhase phase) internal returns (bool ok, bytes4 err) {
        vm.prank(creator);
        try drop.setMintPhase(phase) {
            ok = true;
        } catch (bytes memory reason) {
            err = bytes4(reason);
        }
    }

    function _hasSelector(address target, bytes4 sel) internal view returns (bool) {
        // PUSH4 <selector>: how the dispatcher compares a call's selector.
        bytes memory code = target.code;
        for (uint256 i = 0; i + 4 < code.length; i++) {
            if (
                code[i] == 0x63 && code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2]
                    && code[i + 4] == sel[3]
            ) return true;
        }
        return false;
    }

    // ─── 0. the fork is mainnet, and NEW carries OLD's settings ──────────

    function test_0_newLaunchpadCarriesTheLiveSettings() public onlyForked {
        assertEq(block.chainid, 1, "not forked onto mainnet");
        assertEq(oldLp.dropTemplate(), OLD_TEMPLATE, "the fork does not hold the live launchpad");
        assertGt(address(newLp).code.length, 0, "no code at NEW_LAUNCHPAD");

        assertEq(newLp.owner(), oldLp.owner(), "owner");
        assertEq(newLp.owner(), OWNER, "owner is the deployer key");
        assertEq(newLp.protocolFeeBps(), oldLp.protocolFeeBps(), "fee bps");
        assertEq(newLp.protocolFeeRecipient(), oldLp.protocolFeeRecipient(), "fee recipient");
        assertEq(newLp.weth(), oldLp.weth(), "weth");
        assertEq(newLp.sequencerFeed(), oldLp.sequencerFeed(), "sequencer feed");
        assertEq(newLp.paused(), oldLp.paused(), "paused");
        assertEq(newLp.pendingProtocolFeeBps(), 0, "no fee change queued");
        assertEq(newLp.pendingProtocolFeeRecipient(), address(0), "no recipient change queued");
        assertEq(newLp.getCollectionCount(), 0, "new launchpad starts empty");
        assertEq(oldLp.getCollectionCount(), 0, "old launchpad has collections: something would have to move");

        address tpl = newLp.dropTemplate();
        assertTrue(tpl != OLD_TEMPLATE, "new launchpad reuses the old template");
        bytes4 flag = bytes4(keccak256("fixedPriceNeedsProposal()"));
        assertTrue(_hasSelector(tpl, flag), "new template lacks the F1 flag");
        assertFalse(_hasSelector(OLD_TEMPLATE, flag), "old template already has the F1 flag?");

        console.log("NEW launchpad      ", address(newLp), newBuiltHere ? "(built in-test)" : "(NEW_LAUNCHPAD)");
        console.log("NEW template       ", tpl);
        console.log("NEW template bytes ", tpl.code.length);
        console.log("OLD template bytes ", OLD_TEMPLATE.code.length);
        console.log("NEW pendingOwner   ", newLp.pendingOwner());
        console.log("OLD pendingOwner   ", oldLp.pendingOwner());
        console.log("fee bps / recipient", newLp.protocolFeeBps(), newLp.protocolFeeRecipient());
    }

    // ─── 1. one-transaction price-mode switch ────────────────────────────

    /// OLD: a public sale at 0.05 ETH flips straight onto the 1 ETH curve, and a buyer
    /// who sent 1 ETH pays 1 ETH instead of 0.05.
    function test_1_old_publicSaleFlipsOntoTheCurveInOneTx() public onlyForked {
        TegridyDropV2 drop = _bothPrices(oldLp, "F1 old switch");
        (bool ok,) = _setPhase(drop, TegridyDropV2.MintPhase.PUBLIC);
        assertTrue(ok, "open public");
        assertEq(drop.currentPrice(), FIXED_PRICE);

        (ok,) = _setPhase(drop, TegridyDropV2.MintPhase.DUTCH_AUCTION);
        assertTrue(ok, "OLD should allow the one-tx switch (that is F1)");

        vm.prank(buyer);
        drop.mint{value: 1 ether}(1, 0, new bytes32[](0));
        assertEq(drop.paidPerWallet(buyer), CURVE_START, "OLD buyer pays the curve price");
        console.log("OLD: buyer shown 0.05 ETH paid (wei)", drop.paidPerWallet(buyer));
    }

    /// NEW: opening the public sale switched the curve off, so the flip is refused.
    function test_1_new_publicSaleCannotFlipOntoTheCurve() public onlyForked {
        TegridyDropV2 drop = _bothPrices(newLp, "F1 new switch");
        (bool ok,) = _setPhase(drop, TegridyDropV2.MintPhase.PUBLIC);
        assertTrue(ok, "open public");
        assertEq(drop.dutchDuration(), 0, "the curve was switched off");

        bytes4 err;
        (ok, err) = _setPhase(drop, TegridyDropV2.MintPhase.DUTCH_AUCTION);
        assertFalse(ok, "NEW must refuse the one-tx switch");
        assertEq(err, TegridyDropV2.DutchAuctionNotActive.selector);

        vm.prank(buyer);
        drop.mint{value: 1 ether}(1, 0, new bytes32[](0));
        assertEq(drop.paidPerWallet(buyer), FIXED_PRICE, "NEW buyer pays the price shown");
    }

    // ─── 2. a fixed-price sale reopening after an auction ────────────────

    /// OLD: after an auction, the fixed-price sale reopens at once, with no 24h notice.
    function test_2_old_fixedPriceReopensRightAfterAnAuction() public onlyForked {
        TegridyDropV2 drop = _bothPrices(oldLp, "F1 old reopen");
        (bool ok,) = _setPhase(drop, TegridyDropV2.MintPhase.DUTCH_AUCTION);
        assertTrue(ok, "open auction");
        (ok,) = _setPhase(drop, TegridyDropV2.MintPhase.CLOSED);
        assertTrue(ok, "close");
        (ok,) = _setPhase(drop, TegridyDropV2.MintPhase.PUBLIC);
        assertTrue(ok, "OLD reopens a fixed-price sale with no notice");
        console.log("OLD: reopened fixed price (wei)", drop.mintPrice());
    }

    /// NEW: the same steps are refused until a new price has waited 24 hours, whatever
    /// the price (this is the "reopens free" hole the first F1 fix had).
    function test_2_new_fixedPriceNeedsA24hProposalAfterAnAuction() public onlyForked {
        TegridyDropV2 drop = _bothPrices(newLp, "F1 new reopen");
        (bool ok,) = _setPhase(drop, TegridyDropV2.MintPhase.DUTCH_AUCTION);
        assertTrue(ok, "open auction");
        assertEq(drop.mintPrice(), 0, "the auction switched the fixed price off");
        assertTrue(drop.fixedPriceNeedsProposal());
        (ok,) = _setPhase(drop, TegridyDropV2.MintPhase.CLOSED);
        assertTrue(ok, "close");

        bytes4 err;
        (ok, err) = _setPhase(drop, TegridyDropV2.MintPhase.PUBLIC);
        assertFalse(ok, "NEW must refuse to reopen without a proposal");
        assertEq(err, TegridyDropV2.FixedPriceNeedsProposal.selector);

        // The way back: propose, wait 24h, execute, open. The buyer pays the new price.
        vm.startPrank(creator);
        drop.proposeMintPrice(0.2 ether);
        uint256 readyAt = block.timestamp + drop.MINT_PRICE_DELAY();
        vm.warp(readyAt);
        drop.executeMintPrice(0.2 ether, readyAt);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
        vm.stopPrank();
        vm.prank(buyer);
        drop.mint{value: 1 ether}(1, 0, new bytes32[](0));
        assertEq(drop.paidPerWallet(buyer), 0.2 ether);
    }

    // ─── 3. created already open with the other mode's price armed ───────

    function test_3_old_createsAnOpenSaleWithTheOtherPriceArmed() public onlyForked {
        vm.prank(creator);
        oldLp.createCollection(_cfg("F1 old armed", FIXED_PRICE, true, TegridyDropV2.MintPhase.PUBLIC));
    }

    function test_3_new_refusesAnOpenSaleWithTheOtherPriceArmed() public onlyForked {
        vm.prank(creator);
        vm.expectRevert(TegridyDropV2.PricingModeConflict.selector);
        newLp.createCollection(_cfg("F1 new armed", FIXED_PRICE, true, TegridyDropV2.MintPhase.PUBLIC));
    }

    // ─── 4. a normal sale on NEW: who gets paid ──────────────────────────

    /// Two mints at 0.05 ETH, close, withdraw: the creator gets 95%, the venue's
    /// treasury 5% (as ETH, or WETH if its receive needs more gas than the stipend).
    function test_4_new_normalSalePaysCreatorAndVenue() public onlyForked {
        vm.prank(creator);
        (, address c) = newLp.createCollection(_cfg("F1 new sale", FIXED_PRICE, false, TegridyDropV2.MintPhase.PUBLIC));
        TegridyDropV2 drop = TegridyDropV2(payable(c));
        assertEq(drop.platformFeeRecipient(), TREASURY, "venue fee goes to the treasury");
        assertEq(drop.platformFeeBps(), 500);

        vm.prank(buyer);
        drop.mint{value: 2 * FIXED_PRICE}(2, 0, new bytes32[](0));

        uint256 treasuryBefore = TREASURY.balance + _weth(TREASURY);
        uint256 creatorBefore = creator.balance + _weth(creator);
        vm.startPrank(creator);
        drop.setMintPhase(TegridyDropV2.MintPhase.CLOSED);
        drop.withdraw();
        vm.stopPrank();

        uint256 venue = TREASURY.balance + _weth(TREASURY) - treasuryBefore;
        uint256 paid = creator.balance + _weth(creator) - creatorBefore;
        assertEq(venue, (2 * FIXED_PRICE * 500) / 10_000, "venue 5%");
        assertEq(paid, 2 * FIXED_PRICE - venue, "creator 95%");
        assertEq(venue + paid, 2 * FIXED_PRICE, "every wei of the sale is accounted for");
        console.log("sale 0.1 ETH -> creator (wei)", paid);
        console.log("sale 0.1 ETH -> venue treasury (wei)", venue);
    }

    function _weth(address a) internal view returns (uint256 b) {
        (bool ok, bytes memory out) = WETH.staticcall(abi.encodeWithSignature("balanceOf(address)", a));
        require(ok && out.length == 32, "WETH balanceOf unreadable");
        b = abi.decode(out, (uint256));
    }

    // ─── 5. retiring OLD: the owner's pause stops new collections ────────

    function test_5_old_pauseStopsNewCollections() public onlyForked {
        vm.prank(OWNER);
        oldLp.pause();
        vm.prank(creator);
        vm.expectRevert(); // Pausable: EnforcedPause()
        oldLp.createCollection(_cfg("after pause", FIXED_PRICE, false, TegridyDropV2.MintPhase.CLOSED));
    }
}
