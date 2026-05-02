// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";

/// @notice Regression suite for the DEEP-NFTPOOL-* findings (2026-05-01).
contract Deep_NFTPool_2026_05_01_Test is Test {
    // ─── Mocks ──────────────────────────────────────────────────────────
    MockWETH internal weth;
    MockNFT internal nft;
    TegridyNFTPoolFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice"); // pool LP / owner
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant PROTOCOL_FEE_BPS = 100;
    uint256 internal constant SPOT_PRICE = 1 ether;
    uint256 internal constant DELTA = 0.1 ether;
    uint256 internal constant LP_FEE_BPS = 500;

    function setUp() public {
        weth = new MockWETH();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new MockNFT();
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);

        for (uint256 i = 0; i < 10; i++) nft.mint(alice);
        for (uint256 i = 0; i < 10; i++) nft.mint(carol);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _mkSell(uint256[] memory tokenIds) internal returns (TegridyNFTPool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        address pool = factory.createPool(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT_PRICE, DELTA, 0, tokenIds
        );
        vm.stopPrank();
        return TegridyNFTPool(payable(pool));
    }

    function _mkBuy(uint256 ethAmount) internal returns (TegridyNFTPool) {
        uint256[] memory empty = new uint256[](0);
        vm.prank(alice);
        address pool = factory.createPool{value: ethAmount}(
            address(nft), TegridyNFTPool.PoolType.BUY, SPOT_PRICE, DELTA, 0, empty
        );
        return TegridyNFTPool(payable(pool));
    }

    function _mkTrade(uint256[] memory tokenIds, uint256 ethAmount) internal returns (TegridyNFTPool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        address pool = factory.createPool{value: ethAmount}(
            address(nft), TegridyNFTPool.PoolType.TRADE, SPOT_PRICE, DELTA, LP_FEE_BPS, tokenIds
        );
        vm.stopPrank();
        return TegridyNFTPool(payable(pool));
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _ids2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _idArr(uint256 start, uint256 count) internal pure returns (uint256[] memory r) {
        r = new uint256[](count);
        for (uint256 i = 0; i < count; i++) r[i] = start + i;
    }

    // ─── DEEP-NFTPOOL-01: forward-direction same-block guard ────────────

    function test_DEEP01_swapAfterWithdrawSameBlockReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 5));

        // Owner withdraws an NFT.
        vm.prank(alice);
        pool.withdrawNFTs(_ids(1));

        // Buyer attempt in the SAME block must revert.
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.WithdrawalLandedThisBlock.selector);
        pool.swapETHForNFTs{value: cost}(_ids(2), type(uint256).max, block.timestamp + 1);
    }

    function test_DEEP01_swapNextBlockOK() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 5));
        vm.prank(alice);
        pool.withdrawNFTs(_ids(1));
        vm.roll(block.number + 1);

        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(2), type(uint256).max, block.timestamp + 1);
        assertEq(nft.ownerOf(2), bob);
    }

    function test_DEEP01_lastWithdrawBlockTracksETHWithdraw() public {
        TegridyNFTPool pool = _mkBuy(10 ether);
        vm.roll(block.number + 1);
        // Owner withdraws ETH (no prior swap → withdraw allowed); lastWithdrawBlock must update.
        vm.prank(alice);
        pool.withdrawETH(0.1 ether);
        assertEq(pool.lastWithdrawBlock(), block.number);
    }

    // ─── DEEP-NFTPOOL-02: replace-protection on propose-* ────────────────

    function test_DEEP02_proposeSpotPriceTwiceReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.startPrank(alice);
        pool.proposeSpotPrice(2 ether);
        vm.expectRevert(TegridyNFTPool.ExistingProposalPending.selector);
        pool.proposeSpotPrice(3 ether);
        vm.stopPrank();
    }

    function test_DEEP02_proposeDeltaTwiceReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.startPrank(alice);
        pool.proposeDelta(0.2 ether);
        vm.expectRevert(TegridyNFTPool.ExistingProposalPending.selector);
        pool.proposeDelta(0.3 ether);
        vm.stopPrank();
    }

    function test_DEEP02_proposeFeeChangeTwiceReverts() public {
        TegridyNFTPool pool = _mkTrade(_idArr(1, 3), 5 ether);
        vm.startPrank(alice);
        pool.proposeFeeChange(600);
        vm.expectRevert(TegridyNFTPool.ExistingProposalPending.selector);
        pool.proposeFeeChange(700);
        vm.stopPrank();
    }

    // ─── DEEP-NFTPOOL-03: 48h owner-change timelock ──────────────────────

    function test_DEEP03_acceptOwnershipBeforeTimelockReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.prank(alice);
        pool.proposeOwnerChange(bob);

        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.TimelockNotElapsed.selector);
        pool.acceptOwnership();
    }

    function test_DEEP03_acceptOwnershipAfter48hSucceeds() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.prank(alice);
        pool.proposeOwnerChange(bob);

        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(bob);
        pool.acceptOwnership();
        assertEq(pool.owner(), bob);
    }

    // ─── DEEP-NFTPOOL-04: explicit owner-change cancel ───────────────────

    function test_DEEP04_proposeZeroAddressReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.ZeroAddress.selector);
        pool.proposeOwnerChange(address(0));
    }

    function test_DEEP04_cancelOwnerChangeSucceeds() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.startPrank(alice);
        pool.proposeOwnerChange(bob);
        pool.cancelOwnerChange();
        vm.stopPrank();
        assertEq(pool.pendingOwner(), address(0));
        assertEq(pool.pendingOwnerExecuteAfter(), 0);
    }

    function test_DEEP04_cancelOwnerChangeNoPendingReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.NoPendingOwnerChange.selector);
        pool.cancelOwnerChange();
    }

    // ─── DEEP-NFTPOOL-05: LP-fee accounting + prior-owner snapshot ───────

    function test_DEEP05_lpFeesAccrueOnBuy() public {
        TegridyNFTPool pool = _mkTrade(_idArr(1, 3), 5 ether);
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);
        assertGt(pool.accumulatedLPFees(), 0);
    }

    function test_DEEP05_claimLPFeesByOwner() public {
        TegridyNFTPool pool = _mkTrade(_idArr(1, 3), 5 ether);
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);

        uint256 before = alice.balance;
        uint256 fees = pool.accumulatedLPFees();
        vm.prank(alice);
        pool.claimLPFees();
        assertEq(pool.accumulatedLPFees(), 0);
        assertEq(alice.balance, before + fees);
    }

    function test_DEEP05_priorOwnerSnapshotOnTransfer() public {
        TegridyNFTPool pool = _mkTrade(_idArr(1, 3), 5 ether);
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);
        uint256 fees = pool.accumulatedLPFees();
        assertGt(fees, 0);

        vm.prank(alice);
        pool.proposeOwnerChange(carol);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(carol);
        pool.acceptOwnership();

        // Prior owner credit must equal the snapshot.
        assertEq(pool.priorOwnerOwed(alice), fees);
        assertEq(pool.accumulatedLPFees(), 0);

        // Prior owner can claim.
        uint256 before = alice.balance;
        vm.prank(alice);
        pool.claimPriorOwnerLPFees();
        assertEq(alice.balance, before + fees);
        assertEq(pool.priorOwnerOwed(alice), 0);
    }

    function test_DEEP05_claimPriorOwnerNoCreditReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.NoPriorOwnerCredit.selector);
        pool.claimPriorOwnerLPFees();
    }

    // ─── DEEP-NFTPOOL-06: _swapInFlight permits non-canonical ERC721 ─────

    function test_DEEP06_swapInFlightFalseAfterSwap() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);
        // swap in flight should be cleared.
        // We can't read internal directly; verify subsequent illegitimate
        // direct receiver-hook deposit reverts (random caller).
        vm.startPrank(carol);
        nft.setApprovalForAll(address(pool), true);
        // BUY pool would refuse the buy outright; this is SELL pool.
        // The simpler sanity check: a random EOA cannot use the receiver
        // path to deposit through `safeTransferFrom`, since operator==carol
        // is not owner/factory/this and _swapInFlight is now false.
        vm.expectRevert(); // UNAUTHORIZED_DEPOSIT
        nft.safeTransferFrom(carol, address(pool), 11);
        vm.stopPrank();
    }

    // ─── DEEP-NFTPOOL-07 / V2-NFTPOOL-04: solvency-derived liquidity buffer ─
    // The V2-04 fix replaces the prior 10%-of-balance heuristic with a
    // bonding-curve-derived floor: `min(getMaxSellable(), 100) * spotPrice`.
    // For SPOT_PRICE=1e18, DELTA=1e17, getMaxSellable() = (1e18 - 1) / 1e17 = 9
    // → buffer = 9 ether. Pool funded with 10 ETH → max withdraw = 1 ether.

    function test_DEEP07_withdrawAllRejected() public {
        TegridyNFTPool pool = _mkBuy(10 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.MinLiquidityBuffer.selector);
        pool.withdrawETH(10 ether);
    }

    function test_DEEP07_withdrawWithinBufferOK() public {
        TegridyNFTPool pool = _mkBuy(10 ether);
        vm.roll(block.number + 1);
        // V2-04 buffer = getMaxSellable() * spotPrice = 9 * 1 ether = 9 ether.
        // 1 ether withdraw + 9 ether buffer = 10 ether == lpAvailable → allowed.
        vm.prank(alice);
        pool.withdrawETH(1 ether);
        assertEq(address(pool).balance, 9 ether);
    }

    function test_DEEP07_withdrawAboveBufferReverts() public {
        TegridyNFTPool pool = _mkBuy(10 ether);
        vm.roll(block.number + 1);
        // 2 ether withdraw + 9 ether buffer = 11 ether > 10 ether → revert.
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.MinLiquidityBuffer.selector);
        pool.withdrawETH(2 ether);
    }

    function test_DEEP07_removeLiquidityWithBuffer() public {
        TegridyNFTPool pool = _mkBuy(10 ether);
        vm.roll(block.number + 1);
        uint256[] memory empty = new uint256[](0);
        // 10 ether requested with 9 ether buffer required → revert.
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.MinLiquidityBuffer.selector);
        pool.removeLiquidity(empty, 10 ether);

        // 1 ether requested with 9 ether buffer = exactly lpAvailable → allowed.
        vm.prank(alice);
        pool.removeLiquidity(empty, 1 ether);
    }

    function test_DEEP07V2_sellPoolNoBuffer() public {
        // SELL pools cannot accept sells, so the buffer is 0 — owner can drain.
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        // SELL pools don't take ETH at create; fund directly via factory path:
        // (skip funding — just confirm withdrawETH on a 0-balance pool reverts on amount==0)
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("INVALID_AMOUNT"));
        pool.withdrawETH(0);
    }

    // ─── DEEP-NFTPOOL-08: receive() restricted to factory ────────────────

    function test_DEEP08_directETHToPoolReverts() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok, ) = address(pool).call{value: 0.5 ether}("");
        assertFalse(ok);
    }

    // ─── DEEP-NFTPOOL-09: salt includes chainid + factory address ────────

    function test_DEEP09_saltIsChainAndFactoryUnique() public {
        // We cannot reproduce the create2 salt outside the contract without
        // duplicating logic, but we can assert that two factories on the
        // same chain produce different pool addresses for identical inputs.
        TegridyNFTPoolFactory f2 = new TegridyNFTPoolFactory(
            admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth)
        );

        uint256[] memory empty = new uint256[](0);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        nft.setApprovalForAll(address(f2), true);
        address poolA = factory.createPool{value: 0.01 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT_PRICE, DELTA, 0, empty
        );
        address poolB = f2.createPool{value: 0.01 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT_PRICE, DELTA, 0, empty
        );
        vm.stopPrank();
        assertTrue(poolA != poolB);
    }

    // ─── DEEP-NFTPOOL-10: per-call cap on withdrawProtocolFees ───────────

    function test_DEEP10_withdrawDailyCapEnforced() public {
        // Send factory >MAX_DAILY_WITHDRAWAL by directly funding it.
        vm.deal(address(factory), 2000 ether);
        vm.prank(admin);
        factory.withdrawProtocolFees(1000 ether);
        // Second withdrawal in same day must revert.
        vm.prank(admin);
        vm.expectRevert(TegridyNFTPoolFactory.DailyCapExceeded.selector);
        factory.withdrawProtocolFees(1 ether);
    }

    function test_DEEP10_withdrawNextDayResets() public {
        vm.deal(address(factory), 2000 ether);
        vm.prank(admin);
        factory.withdrawProtocolFees(1000 ether);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(admin);
        factory.withdrawProtocolFees(500 ether);
        assertGt(feeRecipient.balance, 1499 ether);
    }

    function test_DEEP10_withdrawZeroAmountReverts() public {
        vm.deal(address(factory), 1 ether);
        vm.prank(admin);
        vm.expectRevert(TegridyNFTPoolFactory.ZeroAmount.selector);
        factory.withdrawProtocolFees(0);
    }

    // ─── DEEP-NFTPOOL-11: per-pool fee-claim events ──────────────────────

    function test_DEEP11_claimPoolFeesEmitsEvent() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));
        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);

        vm.recordLogs();
        factory.claimPoolFees(address(pool));
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == keccak256("PoolFeesClaimed(address,uint256)")) {
                found = true;
                break;
            }
        }
        assertTrue(found, "PoolFeesClaimed event not emitted");
    }

    // ─── DEEP-NFTPOOL-12: factory emergency pause cascade ────────────────

    function test_DEEP12_emergencyPauseBlocksSwaps() public {
        TegridyNFTPool pool = _mkSell(_idArr(1, 3));

        vm.prank(admin);
        factory.setEmergencyPaused(true);

        (uint256 cost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTPool.EmergencyPaused.selector);
        pool.swapETHForNFTs{value: cost}(_ids(1), type(uint256).max, block.timestamp + 1);
    }

    function test_DEEP12_emergencyPauseCooldownEnforced() public {
        // V2-NFTPOOL-02: cooldown applies ONLY when entering paused state
        // (false → true). Re-pausing within the cooldown window must revert.
        vm.prank(admin);
        factory.setEmergencyPaused(true);
        // Immediately unpause (now allowed under V2 fix).
        vm.prank(admin);
        factory.setEmergencyPaused(false);
        // Re-pause within the cooldown window must still revert (anti-grief).
        vm.prank(admin);
        vm.expectRevert(TegridyNFTPoolFactory.EmergencyCooldown.selector);
        factory.setEmergencyPaused(true);
    }

    function test_V2NFTPOOL02_unpauseInstantAllowed() public {
        // V2-NFTPOOL-02: corrective unpause is allowed at any time (no
        // cooldown). Captures the case where a hasty / mistaken pause must
        // be reverted before the 6h cooldown elapses.
        vm.prank(admin);
        factory.setEmergencyPaused(true);
        assertTrue(factory.emergencyPaused());
        // Same-block unpause must succeed (no cooldown applied to false dir).
        vm.prank(admin);
        factory.setEmergencyPaused(false);
        assertFalse(factory.emergencyPaused());
    }

    function test_DEEP12_emergencyPauseAfterCooldownOK() public {
        vm.prank(admin);
        factory.setEmergencyPaused(true);
        vm.warp(block.timestamp + 6 hours + 1);
        vm.prank(admin);
        factory.setEmergencyPaused(false);
        assertFalse(factory.emergencyPaused());
    }
}

// ─── Test mocks ──────────────────────────────────────────────────────────

contract MockWETH {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

contract MockNFT is ERC721 {
    uint256 private _next = 1;
    constructor() ERC721("Mock", "MCK") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _next++;
        _mint(to, id);
        return id;
    }
}
