// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";

/// @title PASS8 batch-17 — ERC-2981 royalty enforcement on TegridyNFTPool
/// @notice Validates the pass-8 batch-17 fix that adds ERC-2981 royalty
///         payments to TegridyNFTPool's swap flows. Pre-fix, NFT trades
///         on the AMM bypassed creator royalties entirely (the contract
///         did not import IERC2981 nor query royaltyInfo). Post-fix:
///         - swapETHForNFTs: pays royalty out of pool spot-revenue.
///         - swapNFTsForETH: pays royalty out of seller's payout.
///         - Non-ERC-2981 collections continue to work (try-call returns
///           zero royalty silently).
///         - Misbehaving royalty receiver does NOT brick the sale —
///           the WETHFallbackLib safeTransferETHOrWrapNoRevert path
///           skips the royalty if both ETH and WETH legs fail.

// ─── Mocks ───────────────────────────────────────────────────────────

/// @dev Bare ERC721 — no ERC-2981. Existing tests use this shape, so the
///      pre-batch-17 behavior (zero royalty) is preserved for non-royalty
///      collections.
contract NoRoyaltyNFT is ERC721 {
    uint256 private _id;
    constructor() ERC721("NoRoyalty", "NR") {}
    function mint(address to) external returns (uint256) {
        uint256 id = ++_id;
        _mint(to, id);
        return id;
    }
}

/// @dev ERC-2981-aware ERC721. 5% royalty (500 BPS) flat across all tokens.
contract RoyaltyNFT is ERC721 {
    uint256 private _id;
    address public royaltyReceiver;
    uint256 public royaltyBps;

    constructor(address _receiver, uint256 _bps) ERC721("Royalty", "RY") {
        royaltyReceiver = _receiver;
        royaltyBps = _bps;
    }
    function mint(address to) external returns (uint256) {
        uint256 id = ++_id;
        _mint(to, id);
        return id;
    }
    /// ERC-2981 surface — the contract under test queries this.
    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address, uint256)
    {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        // 0x2a55205a is the ERC-2981 selector for royaltyInfo.
        return interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
    }
}

contract MaliciousReceiver {
    fallback() external payable {
        revert("noETHForYou");
    }
    receive() external payable {
        revert("noETHForYou");
    }
}

contract MockWETH {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "ins");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

// ─── Test ────────────────────────────────────────────────────────────

contract PASS8_ROYALTY is Test {
    TegridyNFTPoolFactory factory;
    MockWETH weth;
    address feeRecipient = makeAddr("feeRecipient");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");   // LP / pool owner
    address bob = makeAddr("bob");       // buyer / seller

    uint256 constant SPOT = 1 ether;
    uint256 constant DELTA = 0;
    uint256 constant LP_FEE_BPS = 0; // simplify expected math

    function setUp() public {
        weth = new MockWETH();
        factory = new TegridyNFTPoolFactory(address(this), 100, feeRecipient, address(weth));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _idsArr(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a; r[1] = b;
    }

    // ─────────────────────────────────────────────────────────────────
    // Path 1: swapETHForNFTs (BUYER pays ETH, gets NFTs from pool)
    // Royalty deducted from pool spot-revenue.
    // ─────────────────────────────────────────────────────────────────

    function test_royalty_swapETHForNFTs_paysRoyalty() public {
        RoyaltyNFT nft = new RoyaltyNFT(creator, 500); // 5%
        uint256 id1 = nft.mint(alice);
        uint256 id2 = nft.mint(alice);

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        uint256[] memory seedIds = _idsArr(id1, id2);
        address poolAddr = factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT, DELTA, LP_FEE_BPS, seedIds
        );
        vm.stopPrank();
        TegridyNFTPool pool = TegridyNFTPool(payable(poolAddr));

        uint256 creatorBalBefore = creator.balance;

        // Buyer pays the live quote.
        uint256[] memory buyIds = new uint256[](1);
        buyIds[0] = id1;
        (uint256 quotedCost, uint256 protocolFee) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: quotedCost}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // 5% royalty on the spot revenue (LP_FEE=0; only protocol fee deducted).
        uint256 spotRevenue = quotedCost - protocolFee;
        uint256 expectedRoyalty = (spotRevenue * 500) / 10_000;

        assertEq(creator.balance - creatorBalBefore, expectedRoyalty, "royalty paid to creator");
        assertEq(nft.ownerOf(id1), bob, "buyer received NFT");
    }

    // ─────────────────────────────────────────────────────────────────
    // Path 2: swapNFTsForETH (SELLER provides NFTs, gets ETH from pool)
    // Royalty deducted from seller's payout.
    // ─────────────────────────────────────────────────────────────────

    function test_royalty_swapNFTsForETH_paysRoyalty() public {
        RoyaltyNFT nft = new RoyaltyNFT(creator, 500); // 5%

        // Alice creates a BUY pool (it pays ETH for NFTs from sellers).
        uint256[] memory empty = new uint256[](0);
        vm.startPrank(alice);
        address poolAddr = factory.createPool{value: 10 ether}(
            address(nft), TegridyNFTPool.PoolType.BUY, SPOT, DELTA, LP_FEE_BPS, empty
        );
        vm.stopPrank();
        TegridyNFTPool pool = TegridyNFTPool(payable(poolAddr));

        // Bob mints + approves + sells.
        uint256 id = nft.mint(bob);
        vm.startPrank(bob);
        nft.setApprovalForAll(address(pool), true);
        uint256 bobBalBefore = bob.balance;
        uint256 creatorBalBefore = creator.balance;
        uint256[] memory sellIds = new uint256[](1);
        sellIds[0] = id;
        pool.swapNFTsForETH(sellIds, 0, block.timestamp + 1 hours);
        vm.stopPrank();

        // Pool's BUY pricing: outputAmount = SPOT - delta - protocolFee - lpFee.
        // With delta=0, LP_FEE=0, only protocol fee.
        uint256 protocolFee = (SPOT * factory.protocolFeeBps()) / 10_000;
        uint256 outputAmount = SPOT - protocolFee;
        uint256 expectedRoyalty = (outputAmount * 500) / 10_000;
        uint256 expectedSellerPayout = outputAmount - expectedRoyalty;

        assertEq(creator.balance - creatorBalBefore, expectedRoyalty, "royalty paid to creator");
        assertEq(bob.balance - bobBalBefore, expectedSellerPayout, "seller payout net of royalty");
        assertEq(nft.ownerOf(id), address(pool), "pool received NFT");
    }

    // ─────────────────────────────────────────────────────────────────
    // Non-ERC-2981 collection: zero royalty paid (no behavior change).
    // ─────────────────────────────────────────────────────────────────

    function test_royalty_nonERC2981_collection_zeroRoyalty() public {
        NoRoyaltyNFT nft = new NoRoyaltyNFT();
        uint256 id1 = nft.mint(alice);

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        uint256[] memory seedIds = new uint256[](1);
        seedIds[0] = id1;
        address poolAddr = factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT, DELTA, LP_FEE_BPS, seedIds
        );
        vm.stopPrank();
        TegridyNFTPool pool = TegridyNFTPool(payable(poolAddr));

        uint256 creatorBalBefore = creator.balance;

        uint256[] memory buyIds = new uint256[](1);
        buyIds[0] = id1;
        (uint256 quotedCost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: quotedCost}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // Creator (a sentinel address) should have received NOTHING from a
        // non-ERC-2981 collection.
        assertEq(creator.balance, creatorBalBefore, "no royalty for non-ERC2981 collection");
        assertEq(nft.ownerOf(id1), bob, "buyer received NFT");
    }

    // ─────────────────────────────────────────────────────────────────
    // Misbehaving royalty receiver: sale completes; royalty silently skipped.
    // ─────────────────────────────────────────────────────────────────

    function test_royalty_misbehavingReceiver_saleCompletes() public {
        MaliciousReceiver mal = new MaliciousReceiver();
        RoyaltyNFT nft = new RoyaltyNFT(address(mal), 500);
        uint256 id1 = nft.mint(alice);

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        uint256[] memory seedIds = new uint256[](1);
        seedIds[0] = id1;
        address poolAddr = factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT, DELTA, LP_FEE_BPS, seedIds
        );
        vm.stopPrank();
        TegridyNFTPool pool = TegridyNFTPool(payable(poolAddr));

        uint256[] memory buyIds = new uint256[](1);
        buyIds[0] = id1;
        (uint256 quotedCost, ) = pool.getBuyQuote(1);
        // Sale must complete despite the malicious receiver.
        vm.prank(bob);
        pool.swapETHForNFTs{value: quotedCost}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // ETH royalty leg failed. WETH fallback also failed (Mock doesn't
        // accept WETH). Royalty is silently skipped. Buyer still gets NFT.
        assertEq(nft.ownerOf(id1), bob, "sale completes with malicious royalty receiver");
    }

    // ─────────────────────────────────────────────────────────────────
    // Pathological royalty rate: amount >= salePrice → royalty refused.
    // ─────────────────────────────────────────────────────────────────

    function test_royalty_pathologicalRate_refused() public {
        // 100% royalty (10000 BPS) — the receiver would zero out the seller.
        // Our defensive guard refuses to honor this.
        RoyaltyNFT nft = new RoyaltyNFT(creator, 10_000);
        uint256 id1 = nft.mint(alice);

        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        uint256[] memory seedIds = new uint256[](1);
        seedIds[0] = id1;
        address poolAddr = factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.SELL, SPOT, DELTA, LP_FEE_BPS, seedIds
        );
        vm.stopPrank();
        TegridyNFTPool pool = TegridyNFTPool(payable(poolAddr));

        uint256 creatorBalBefore = creator.balance;

        uint256[] memory buyIds = new uint256[](1);
        buyIds[0] = id1;
        (uint256 quotedCost, ) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: quotedCost}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // 100% royalty is refused (defense-in-depth). Sale completes; creator
        // gets nothing because the rate was rejected as pathological.
        assertEq(creator.balance, creatorBalBefore, "100% royalty rate refused");
        assertEq(nft.ownerOf(id1), bob, "buyer still got NFT");
    }
}
