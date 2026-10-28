// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {TegridyPair} from "../src/TegridyPair.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";
import {TegridyNFTPool} from "../src/TegridyNFTPool.sol";

// ─── Opening a pool costs 0.006 ETH (owner ruling 2026-10-25) ────────────────
//
// Coin pools: TegridyFactory.createPair takes exactly the fee and sends it to feeTo,
// whether a caller opens the pair directly or the router opens it inside addLiquidity /
// addLiquidityETH. In addLiquidityETH the fee is NOT liquidity: the pool gets the rest.
// NFT pools: TegridyNFTPoolFactory.createPool takes the fee off the top of msg.value and
// sends it to protocolFeeRecipient; only the remainder is the opener's deposit.
// Every test here passes on the fee build and fails on the free one it replaces.
// ─────────────────────────────────────────────────────────────────────────────

contract OpenFeeToken is ERC20 {
    constructor(string memory s) ERC20(s, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract OpenFeeWETH is ERC20 {
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

contract OpenFeeNFT is ERC721 {
    uint256 private _next = 1;

    constructor() ERC721("OpenFeeNFT", "OFN") {}

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }
}

/// A fee recipient that refuses plain ETH (the NFT factory must wrap, not brick).
contract RefusesETH {
    receive() external payable {
        revert("NO_ETH");
    }
}

contract PoolOpeningFeeTest is Test {
    uint256 constant FEE = 0.006 ether;

    address constant MULTISIG = address(0x5AFE);
    address constant GUARDIAN = address(0x6A2D);
    address treasury = makeAddr("treasury");
    address opener = makeAddr("opener");

    TegridyFactory factory;
    TegridyRouter router;
    OpenFeeWETH weth;
    OpenFeeToken tokenA;
    OpenFeeToken tokenB;

    TegridyNFTPoolFactory nftFactory;
    OpenFeeNFT nft;

    function setUp() public {
        weth = new OpenFeeWETH();
        factory = new TegridyFactory(MULTISIG, treasury, GUARDIAN);
        router = new TegridyRouter(address(factory), address(weth));
        tokenA = new OpenFeeToken("AAA");
        tokenB = new OpenFeeToken("BBB");
        tokenA.transfer(opener, 1_000_000 ether);
        tokenB.transfer(opener, 1_000_000 ether);
        vm.deal(opener, 100 ether);
        vm.startPrank(opener);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        vm.stopPrank();

        nftFactory = new TegridyNFTPoolFactory(MULTISIG, 25, treasury, address(weth));
        nft = new OpenFeeNFT();
    }

    // ── The fee itself ────────────────────────────────────────────────────

    function test_feeIsExactly0006Eth_onBothFactories() public view {
        assertEq(factory.POOL_OPENING_FEE(), 0.006 ether);
        assertEq(nftFactory.POOL_OPENING_FEE(), 0.006 ether);
    }

    // ── Coin pools: a direct createPair ───────────────────────────────────

    function test_createPair_paysExactlyTheFee_toFeeTo() public {
        uint256 before = treasury.balance;
        vm.prank(opener);
        address pair = factory.createPair{value: FEE}(address(tokenA), address(tokenB));
        assertTrue(factory.isPair(pair));
        assertEq(treasury.balance - before, FEE, "feeTo gets the fee");
        assertEq(address(factory).balance, 0, "nothing stays in the factory");
    }

    function test_createPair_free_reverts() public {
        vm.prank(opener);
        vm.expectRevert(bytes("OPENING_FEE"));
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_createPair_underpay_reverts() public {
        vm.prank(opener);
        vm.expectRevert(bytes("OPENING_FEE"));
        factory.createPair{value: FEE - 1}(address(tokenA), address(tokenB));
    }

    function test_createPair_overpay_reverts() public {
        vm.prank(opener);
        vm.expectRevert(bytes("OPENING_FEE"));
        factory.createPair{value: FEE + 1}(address(tokenA), address(tokenB));
    }

    // ── Coin pools: the router opens the pair inside addLiquidity ─────────

    function _addTokens(uint256 value) internal returns (uint256 liquidity) {
        vm.prank(opener);
        (,, liquidity) = router.addLiquidity{value: value}(
            address(tokenA), address(tokenB), 1_000 ether, 2_000 ether, 0, 0, opener, block.timestamp + 60
        );
    }

    function test_router_addLiquidity_opening_paysTheFee_toFeeTo() public {
        uint256 before = treasury.balance;
        uint256 openerBefore = opener.balance;
        _addTokens(FEE);
        assertTrue(factory.getPair(address(tokenA), address(tokenB)) != address(0));
        assertEq(treasury.balance - before, FEE, "feeTo gets the fee");
        assertEq(openerBefore - opener.balance, FEE, "the opener pays exactly the fee");
        assertEq(address(router).balance, 0, "nothing stays in the router");
        assertEq(address(factory).balance, 0, "nothing stays in the factory");
    }

    function test_router_addLiquidity_opening_free_reverts() public {
        vm.expectRevert(bytes("OPENING_FEE"));
        _addTokens(0);
    }

    function test_router_addLiquidity_opening_overpay_reverts() public {
        vm.expectRevert(bytes("OPENING_FEE"));
        _addTokens(FEE + 1);
    }

    function test_router_addLiquidity_existingPair_isFree_andTakesNoETH() public {
        _addTokens(FEE);
        uint256 before = treasury.balance;
        _addTokens(0);
        assertEq(treasury.balance, before, "an existing pair pays no fee");

        vm.expectRevert(bytes("OPENING_FEE"));
        _addTokens(FEE);
    }

    // ── Coin pools: the router opens the pair inside addLiquidityETH ──────

    function _addETH(uint256 value) internal returns (uint256 amountToken, uint256 amountETH) {
        vm.prank(opener);
        (amountToken, amountETH,) = router.addLiquidityETH{value: value}(
            address(tokenA), 1_000 ether, 0, 0, opener, block.timestamp + 60
        );
    }

    function test_router_addLiquidityETH_opening_feeIsNotLiquidity() public {
        uint256 before = treasury.balance;
        uint256 openerBefore = opener.balance;
        (, uint256 amountETH) = _addETH(1 ether + FEE);

        address pair = factory.getPair(address(tokenA), address(weth));
        assertEq(amountETH, 1 ether, "the pool gets the liquidity ETH, not the fee");
        assertEq(weth.balanceOf(pair), 1 ether, "pair holds exactly the liquidity ETH");
        assertEq(treasury.balance - before, FEE, "feeTo gets the fee");
        assertEq(openerBefore - opener.balance, 1 ether + FEE, "opener pays liquidity + fee, nothing more");
        assertEq(address(router).balance, 0, "nothing stays in the router");
    }

    function test_router_addLiquidityETH_opening_belowFee_reverts() public {
        vm.expectRevert(bytes("OPENING_FEE"));
        _addETH(FEE - 1);
    }

    function test_router_addLiquidityETH_existingPair_isFree_allValueIsLiquidity() public {
        _addETH(1 ether + FEE);
        uint256 before = treasury.balance;
        uint256 openerBefore = opener.balance;
        address pair = factory.getPair(address(tokenA), address(weth));
        uint256 pairWethBefore = weth.balanceOf(pair);

        // The pool is 1,000 AAA : 1 ETH. Offer 0.5 ETH and enough AAA: all 0.5 ETH goes in.
        (, uint256 amountETH) = _addETH(0.5 ether);
        assertEq(amountETH, 0.5 ether);
        assertEq(weth.balanceOf(pair) - pairWethBefore, 0.5 ether);
        assertEq(treasury.balance, before, "an existing pair pays no fee");
        assertEq(openerBefore - opener.balance, 0.5 ether);
    }

    function test_router_addLiquidityETH_existingPair_refundsUnusedETH() public {
        // The pool is 1,000 AAA : 1 ETH; add again where the token side binds, so the
        // unused ETH comes back in full and no fee is taken out of it.
        _addETH(1 ether + FEE);
        uint256 openerBefore = opener.balance;
        vm.prank(opener);
        (, uint256 amountETH,) = router.addLiquidityETH{value: 2 ether}(
            address(tokenA), 100 ether, 0, 0, opener, block.timestamp + 60
        );
        assertEq(amountETH, 0.1 ether, "100 AAA pairs with 0.1 ETH");
        assertEq(openerBefore - opener.balance, 0.1 ether, "the other 1.9 ETH is refunded");
    }

    // ── NFT pools ─────────────────────────────────────────────────────────

    function _createPool(uint256 value, uint256[] memory ids) internal returns (address pool) {
        vm.prank(opener);
        pool = nftFactory.createPool{value: value}(
            address(nft), TegridyNFTPool.PoolType.BUY, 0.1 ether, 0.01 ether, 0, ids
        );
    }

    function test_nft_createPool_feeToRecipient_restIsTheDeposit() public {
        uint256[] memory ids;
        uint256 before = treasury.balance;
        address pool = _createPool(1 ether + FEE, ids);
        assertEq(pool.balance, 1 ether, "the pool gets the deposit, not the fee");
        assertEq(treasury.balance - before, FEE, "the recipient gets the fee");
        assertEq(address(nftFactory).balance, 0, "nothing stays in the factory");
    }

    function test_nft_createPool_minDepositWithoutFee_reverts() public {
        // 0.05 ETH opened a pool on the free factory; now 0.006 of it is the fee.
        uint256[] memory ids;
        uint256 minDeposit = nftFactory.MIN_DEPOSIT();
        vm.expectRevert(bytes("MIN_DEPOSIT"));
        _createPool(minDeposit, ids);

        address pool = _createPool(minDeposit + FEE, ids);
        assertEq(pool.balance, minDeposit);
    }

    function test_nft_createPool_nftOnly_stillPaysTheFee() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = nft.mint(opener);
        vm.prank(opener);
        nft.setApprovalForAll(address(nftFactory), true);

        vm.expectRevert(bytes("OPENING_FEE"));
        _createPool(0, ids);

        uint256 before = treasury.balance;
        address pool = _createPool(FEE, ids);
        assertEq(nft.ownerOf(ids[0]), pool);
        assertEq(pool.balance, 0, "no ETH deposit");
        assertEq(treasury.balance - before, FEE);
    }

    function test_nft_createPool_recipientRefusingETH_getsWETH() public {
        RefusesETH refuser = new RefusesETH();
        TegridyNFTPoolFactory f = new TegridyNFTPoolFactory(MULTISIG, 25, address(refuser), address(weth));
        uint256[] memory ids;
        vm.prank(opener);
        address pool = f.createPool{value: 1 ether + FEE}(
            address(nft), TegridyNFTPool.PoolType.BUY, 0.1 ether, 0.01 ether, 0, ids
        );
        assertEq(pool.balance, 1 ether);
        assertEq(weth.balanceOf(address(refuser)), FEE, "fee wrapped, pool creation not bricked");
    }
}
