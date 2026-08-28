// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {
    TegridyNativeBuyRouter,
    AdvancedOrder,
    OrderParameters,
    ConsiderationItem,
    OfferItem,
    ItemType,
    OrderType,
    CriteriaResolver,
    ISeaport,
    IReferralSplitter
} from "../src/TegridyNativeBuyRouter.sol";

/// @dev Mock Seaport: records what it was called with and pays a configurable
///      "platform fee" BACK to msg.sender (the router) synchronously inside the
///      fill, exactly the way a native listing that names the router as its fee
///      recipient does. Whatever it does NOT pay back models the seller payout.
contract MockSeaport {
    address public lastRecipient;
    bytes32 public lastConduitKey;
    uint256 public lastValue;
    uint256 public feeToReturn; // wei paid back to the router (<= msg.value)
    bool public shouldFail;

    function setFeeToReturn(uint256 f) external {
        feeToReturn = f;
    }

    function setShouldFail(bool b) external {
        shouldFail = b;
    }

    function fulfillAdvancedOrder(
        AdvancedOrder calldata,
        CriteriaResolver[] calldata,
        bytes32 fulfillerConduitKey,
        address recipient
    ) external payable returns (bool) {
        lastRecipient = recipient;
        lastConduitKey = fulfillerConduitKey;
        lastValue = msg.value;
        if (shouldFail) return false;
        if (feeToReturn > 0) {
            (bool ok,) = msg.sender.call{value: feeToReturn}("");
            require(ok, "MockSeaport: fee refund failed");
        }
        return true;
    }

    receive() external payable {}
}

/// @dev Mock ReferralSplitter: records the fee it was handed, with a revert
///      toggle to prove the router best-effort (try/catch) attribution, and a
///      withdrawable caller-credit for the sweep path.
contract MockReferralSplitter {
    address public lastUser;
    uint256 public lastFee;
    uint256 public totalRecorded;
    uint256 public recordCallCount;
    bool public revertOnRecord;
    uint256 public creditToReturn;

    function setRevertOnRecord(bool b) external {
        revertOnRecord = b;
    }

    function setCreditToReturn(uint256 c) external {
        creditToReturn = c;
    }

    function recordFee(address user) external payable {
        recordCallCount++;
        if (revertOnRecord) revert("MockSplitter: down");
        lastUser = user;
        lastFee = msg.value;
        totalRecorded += msg.value;
    }

    function withdrawCallerCredit() external {
        uint256 c = creditToReturn;
        if (c == 0) revert("MockSplitter: NothingToClaim");
        creditToReturn = 0;
        (bool ok,) = msg.sender.call{value: c}("");
        require(ok, "MockSplitter: credit send failed");
    }

    receive() external payable {}
}

/// @dev Minimal WETH — only needed so construction has a non-zero weth and the
///      sweep WETH-fallback leg is real. buy() never touches it.
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        payable(msg.sender).transfer(a);
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

/// @dev A hostile Seaport that re-enters the router mid-fulfillment. Proves the
///      nonReentrant lock on buy() (and, via OZ's shared _status slot, sweep).
contract MaliciousSeaport {
    bytes public reentrantCall;

    function arm(bytes calldata data) external {
        reentrantCall = data;
    }

    function fulfillAdvancedOrder(AdvancedOrder calldata, CriteriaResolver[] calldata, bytes32, address)
        external
        payable
        returns (bool)
    {
        // Re-enter the router (msg.sender) mid-fill and re-throw its revert verbatim,
        // so the outer buy() surfaces ReentrancyGuardReentrantCall.
        (bool ok, bytes memory ret) = msg.sender.call(reentrantCall);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return true;
    }

    receive() external payable {}
}

/// @dev A treasury whose receive() reverts — forces the sweep's WETH-fallback leg.
contract RevertingReceiver {
    error NoEth();

    receive() external payable {
        revert NoEth();
    }
}

contract TegridyNativeBuyRouterTest is Test {
    TegridyNativeBuyRouter router;
    MockSeaport seaport;
    MockReferralSplitter splitter;
    MockWETH weth;

    address treasury = address(0x7EEA5427);
    address buyer = address(0xB0B);
    address constant SELLER = address(0x5E11E4);
    address constant NFT_ADDR = address(0x0FF5E7);

    event NativeBuyRouted(address indexed buyer, bytes32 indexed orderHash, uint256 paid, uint256 feeAttributed);
    event TreasurySwept(address indexed treasury, uint256 amount);

    function setUp() public {
        seaport = new MockSeaport();
        splitter = new MockReferralSplitter();
        weth = new MockWETH();
        // deployer (this test contract) is owner via OwnableNoRenounce(msg.sender)
        router = new TegridyNativeBuyRouter(address(seaport), address(splitter), treasury, address(weth));
        vm.deal(buyer, 100 ether);
    }

    // -- order builders --------------------------------------------------------

    function _oneNativeOrder(uint256 price, uint120 num, uint120 den) internal pure returns (AdvancedOrder memory o) {
        ConsiderationItem[] memory cons = new ConsiderationItem[](1);
        cons[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: price,
            endAmount: price,
            recipient: payable(SELLER)
        });
        o = _wrap(cons, num, den);
    }

    /// two native legs (price + royalty) to prove _nativeTotal SUMS every native item
    function _twoNativeOrder(uint256 legA, uint256 legB) internal pure returns (AdvancedOrder memory o) {
        ConsiderationItem[] memory cons = new ConsiderationItem[](2);
        cons[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: legA,
            endAmount: legA,
            recipient: payable(SELLER)
        });
        cons[1] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: legB,
            endAmount: legB,
            recipient: payable(SELLER)
        });
        o = _wrap(cons, 1, 1);
    }

    function _wrap(ConsiderationItem[] memory cons, uint120 num, uint120 den)
        internal
        pure
        returns (AdvancedOrder memory o)
    {
        OfferItem[] memory off = new OfferItem[](1);
        off[0] = OfferItem({
            itemType: ItemType.ERC721, token: NFT_ADDR, identifierOrCriteria: 42, startAmount: 1, endAmount: 1
        });
        OrderParameters memory p = OrderParameters({
            offerer: SELLER,
            zone: address(0),
            offer: off,
            consideration: cons,
            orderType: OrderType.FULL_OPEN,
            startTime: 0,
            endTime: type(uint256).max,
            zoneHash: bytes32(0),
            salt: 0,
            conduitKey: bytes32(0),
            totalOriginalConsiderationItems: cons.length
        });
        o = AdvancedOrder({parameters: p, numerator: num, denominator: den, signature: "", extraData: ""});
    }

    // -- happy path: fee delta -> referrer -------------------------------------

    function test_BuyAttributesExactFeeDeltaToReferrer() public {
        uint256 price = 1 ether;
        uint256 fee = 0.01 ether;
        seaport.setFeeToReturn(fee);
        AdvancedOrder memory o = _oneNativeOrder(price, 1, 1);

        vm.expectEmit(true, true, true, true, address(router));
        emit NativeBuyRouted(buyer, bytes32(uint256(0xABC)), price, fee);

        vm.prank(buyer);
        router.buy{value: price}(o, bytes32(uint256(0xABC)));

        assertEq(splitter.lastUser(), buyer, "fee attributed to buyer");
        assertEq(splitter.lastFee(), fee, "exact fee delta forwarded");
        assertEq(seaport.lastRecipient(), buyer, "NFT delivered to buyer, not router");
        assertEq(seaport.lastValue(), price, "buyer exact ETH forwarded to seaport");
        assertEq(address(router).balance, 0, "router custodies nothing after attribution");
    }

    // -- GUARD 1: exact payment ------------------------------------------------

    function test_RevertOnOverpay() public {
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);
        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.ValueMismatch.selector);
        router.buy{value: 1 ether + 1 wei}(o, bytes32(0));
    }

    function test_RevertOnUnderpay() public {
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);
        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.ValueMismatch.selector);
        router.buy{value: 1 ether - 1 wei}(o, bytes32(0));
    }

    function test_NativeTotalSumsEveryNativeLeg() public {
        // price 0.9 + royalty 0.1 = 1.0 ; sending the sum succeeds, sending one leg reverts
        AdvancedOrder memory o = _twoNativeOrder(0.9 ether, 0.1 ether);
        seaport.setFeeToReturn(0);

        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.ValueMismatch.selector);
        router.buy{value: 0.9 ether}(o, bytes32(0)); // only one leg -- must revert

        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0)); // full sum -- succeeds
        assertEq(seaport.lastValue(), 1 ether, "summed total forwarded");
    }

    // -- GUARD 0: full fills only ----------------------------------------------

    function test_RevertOnPartialFill() public {
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 2); // numerator != denominator
        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.PartialFillNotSupported.selector);
        router.buy{value: 1 ether}(o, bytes32(0));
    }

    // -- priorBalance excludes msg.value AND pre-existing dust ------------------

    function test_PreExistingDustIsNotMisattributedAsFee() public {
        vm.deal(address(router), 0.5 ether); // stray dust sitting in the router
        uint256 fee = 0.01 ether;
        seaport.setFeeToReturn(fee);
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);

        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0));

        // ONLY the seaport-returned fee is attributed; the 0.5 dust is not.
        assertEq(splitter.lastFee(), fee, "dust must not inflate the attributed fee");
        assertEq(address(router).balance, 0.5 ether, "dust remains, untouched, for the sweep path");
    }

    // -- zero-fee pass-through (OpenSea order that names no fee to the router) --

    function test_ZeroFeeSkipsRecordFee() public {
        seaport.setFeeToReturn(0);
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);

        vm.expectEmit(true, true, true, true, address(router));
        emit NativeBuyRouted(buyer, bytes32(0), 1 ether, 0);

        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0));

        assertEq(splitter.recordCallCount(), 0, "recordFee skipped when fee == 0");
        assertEq(seaport.lastRecipient(), buyer, "NFT still delivered to buyer");
    }

    // -- best-effort attribution: splitter revert must NOT brick the buy -------

    function test_SplitterRevertDoesNotBrickBuyAndFeeIsRetained() public {
        uint256 fee = 0.02 ether;
        seaport.setFeeToReturn(fee);
        splitter.setRevertOnRecord(true);
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);

        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0)); // must NOT revert

        // recordFee reverted, so every state change in that call frame rolled
        // back (its own counter included) -- the observable proof that the `if
        // (fee > 0)` branch ran is that the fee is RETAINED in the router rather
        // than forwarded, together with the buy itself not reverting. A skipped
        // (fee == 0) branch would leave the router at 0, not `fee`.
        assertEq(splitter.totalRecorded(), 0, "splitter credited nothing (it reverted)");
        assertEq(address(router).balance, fee, "retained fee proves try/catch swallowed the revert");
        assertEq(seaport.lastRecipient(), buyer, "buyer still got the NFT");
    }

    // -- KNOWN PRE-DEPLOY LIMITATION (audit-pinned, characterization test) ------

    /// AUDIT (Spartan 2026-07-22, MEDIUM): the platform fee is inferred from a
    /// whole-contract balance delta around the Seaport fill. If Seaport ever
    /// REFUNDS unused ETH to the router -- a Dutch listing that fills below
    /// startAmount, or any fill that consumes less than msg.value -- that refund
    /// is INDISTINGUISHABLE from an intended fee under the delta accounting and is
    /// mis-booked (attributed/swept) instead of returned to the buyer, who
    /// silently loses the change. GUARD 0 (full-fills-only) and GUARD 1 (exact
    /// payment) close the partial-fill and overpay vectors, but a full 1/1 Dutch
    /// fill below startAmount is NOT covered by the exact-value guard -- the
    /// contract docstring says such orders "must not be routed here".
    ///
    /// This test PINS the current (unsafe) behavior so the limitation is captured
    /// executably rather than only in prose, and so that when the pre-deploy fix
    /// lands (pin the fee to an explicit precomputed amount and refund the residual
    /// to msg.sender) this expectation flips and the fix is proven. It is NOT a
    /// substitute for the mandated mainnet-fork test with a real refunding order.
    function test_SeaportRefundIsMisbookedAsFee_KNOWN_LIMITATION() public {
        uint256 refundOwedToBuyer = 0.2 ether; // Seaport hands this back to the router
        seaport.setFeeToReturn(refundOwedToBuyer); // neither mock nor router can flag intent
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);

        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0));

        // CURRENT (defective) behavior, documented so the fix can flip it:
        assertEq(splitter.lastFee(), refundOwedToBuyer, "KNOWN LIMITATION: buyer refund mis-booked as platform fee");
        assertEq(buyer.balance, buyerBefore - 1 ether, "KNOWN LIMITATION: buyer does NOT get the refund back");
        // Post-fix, the correct assertions are:
        //   assertEq(buyer.balance, buyerBefore - (1 ether - refundOwedToBuyer));
        //   assertEq(splitter.lastFee(), 0);
    }

    // -- FulfillFailed: seaport returns false ----------------------------------

    function test_FulfillFailedReverts() public {
        seaport.setShouldFail(true);
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);
        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.FulfillFailed.selector);
        router.buy{value: 1 ether}(o, bytes32(0));
    }

    // -- sweep: onlyOwner, funds only ever move to treasury --------------------

    function test_SweepPullsCreditAndForwardsAllToTreasury() public {
        // router holds 0.03 stray + 0.05 caller-credit inside the splitter
        vm.deal(address(router), 0.03 ether);
        splitter.setCreditToReturn(0.05 ether);
        vm.deal(address(splitter), 0.05 ether);

        uint256 beforeBal = treasury.balance;
        vm.expectEmit(true, false, false, true, address(router));
        emit TreasurySwept(treasury, 0.08 ether);
        router.sweepToTreasury();

        assertEq(treasury.balance - beforeBal, 0.08 ether, "credit + stray both reach treasury");
        assertEq(address(router).balance, 0, "router emptied");
    }

    function test_SweepRevertsWhenNothingToSweep() public {
        vm.expectRevert(TegridyNativeBuyRouter.NothingToSweep.selector);
        router.sweepToTreasury();
    }

    function test_SweepOnlyOwner() public {
        vm.deal(address(router), 1 ether);
        vm.prank(buyer);
        vm.expectRevert();
        router.sweepToTreasury();
    }

    function test_SetTreasuryOnlyOwnerAndNonZero() public {
        vm.prank(buyer);
        vm.expectRevert();
        router.setTreasury(address(0xCAFE));

        vm.expectRevert(TegridyNativeBuyRouter.ZeroAddress.selector);
        router.setTreasury(address(0));

        router.setTreasury(address(0xCAFE));
        assertEq(router.treasury(), address(0xCAFE));
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(TegridyNativeBuyRouter.ZeroAddress.selector);
        new TegridyNativeBuyRouter(address(0), address(splitter), treasury, address(weth));
        vm.expectRevert(TegridyNativeBuyRouter.ZeroAddress.selector);
        new TegridyNativeBuyRouter(address(seaport), address(0), treasury, address(weth));
        vm.expectRevert(TegridyNativeBuyRouter.ZeroAddress.selector);
        new TegridyNativeBuyRouter(address(seaport), address(splitter), address(0), address(weth));
        vm.expectRevert(TegridyNativeBuyRouter.ZeroAddress.selector);
        new TegridyNativeBuyRouter(address(seaport), address(splitter), treasury, address(0));
    }

    // -- reentrancy: nonReentrant on buy() is real (shared _status slot covers sweep) --

    function test_BuyIsNonReentrant() public {
        MaliciousSeaport evil = new MaliciousSeaport();
        TegridyNativeBuyRouter r = new TegridyNativeBuyRouter(address(evil), address(splitter), treasury, address(weth));
        AdvancedOrder memory o = _oneNativeOrder(1 ether, 1, 1);
        // Arm the hostile seaport to call back into buy() during the fill. The
        // nonReentrant guard runs before any body logic, so a value-0 re-entry with
        // this same order trips it immediately.
        evil.arm(abi.encodeCall(TegridyNativeBuyRouter.buy, (o, bytes32(0))));

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        r.buy{value: 1 ether}(o, bytes32(0));
    }

    // -- sweep WETH-fallback leg: a brick-on-receive treasury still gets paid --

    function test_SweepWrapsToWethForRevertingTreasury() public {
        RevertingReceiver badTreasury = new RevertingReceiver();
        router.setTreasury(address(badTreasury)); // test contract is owner
        vm.deal(address(router), 0.03 ether);

        router.sweepToTreasury();

        // The raw ETH .call reverts (receive reverts), so the lib wraps to WETH and
        // sends the token instead — funds reach the treasury, nothing bricks.
        assertEq(weth.balanceOf(address(badTreasury)), 0.03 ether, "swept as WETH via fallback");
        assertEq(address(router).balance, 0, "router emptied");
        assertEq(address(badTreasury).balance, 0, "no raw ETH stuck at the bricked treasury");
    }

    // -- _nativeTotal sums ONLY native legs (the advertised ERC20 pass-through) --

    function test_NativeTotalIgnoresErc20Consideration() public {
        ConsiderationItem[] memory cons = new ConsiderationItem[](2);
        cons[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: 1 ether,
            endAmount: 1 ether,
            recipient: payable(SELLER)
        });
        cons[1] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: address(0xE12C20),
            identifierOrCriteria: 0,
            startAmount: 5 ether,
            endAmount: 5 ether,
            recipient: payable(SELLER)
        });
        AdvancedOrder memory o = _wrap(cons, 1, 1);
        seaport.setFeeToReturn(0);

        // Exact NATIVE total is 1 ETH; the 5-ETH ERC20 leg must not be counted.
        vm.prank(buyer);
        router.buy{value: 1 ether}(o, bytes32(0));
        assertEq(seaport.lastValue(), 1 ether, "only the native leg is required as msg.value");

        // Sending native+erc20 (6 ETH) overpays the native-only total -> revert.
        vm.prank(buyer);
        vm.expectRevert(TegridyNativeBuyRouter.ValueMismatch.selector);
        router.buy{value: 6 ether}(o, bytes32(0));
    }
}
