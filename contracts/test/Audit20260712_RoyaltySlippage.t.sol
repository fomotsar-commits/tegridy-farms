// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";

// Minimal WETH mock (mirrors TegridyNFTPool.t.sol) — only used as the pool's
// WETH fallback sink; the royalty receiver in these tests is a plain EOA that
// takes the ETH leg directly, so no wrapping actually occurs.
contract MockWETH_Royalty {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

// ERC-721 collection with a fixed ERC-2981 royalty rate. The pool queries
// `royaltyInfo(firstTokenId, totalSale)` (no supportsInterface gate), so a
// single royaltyInfo implementation is sufficient.
contract RoyaltyNFT is ERC721 {
    uint256 private _nextId = 1;
    address public royaltyReceiver;
    uint256 public royaltyBps;

    constructor(address _receiver, uint256 _bps) ERC721("RoyaltyApes", "RAPE") {
        royaltyReceiver = _receiver;
        royaltyBps = _bps;
    }

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        return (royaltyReceiver, salePrice * royaltyBps / 10_000);
    }
}

/// @notice AUDIT FIX 2026-07-12 regression: `swapNFTsForETH` must enforce the
///         `minOutput` slippage floor against the NET proceeds the seller
///         actually receives (gross curve payout minus the ERC-2981 royalty),
///         not the pre-royalty gross. Pre-fix a seller could receive strictly
///         less ETH than the `minOutput` they specified.
contract Audit20260712_RoyaltySlippageTest is Test {
    TegridyNFTPoolFactory public factory;
    RoyaltyNFT public nft;
    MockWETH_Royalty public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // pool creator / LP (buyer-side)
    address public carol = makeAddr("carol"); // seller
    address public royaltyReceiver = makeAddr("royaltyReceiver");

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;
    uint256 public constant ROYALTY_BPS = 2000; // 20% (< 25% pool cap → actually paid)

    function setUp() public {
        weth = new MockWETH_Royalty();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new RoyaltyNFT(royaltyReceiver, ROYALTY_BPS);

        vm.deal(alice, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    function _createBuyPool(uint256 ethAmount) internal returns (address pool) {
        uint256[] memory emptyIds = new uint256[](0);
        vm.prank(alice);
        pool = factory.createPool{value: ethAmount}(
            address(nft), TegridyNFTPool.PoolType.BUY, SPOT_PRICE, DELTA, 0, emptyIds
        );
    }

    function _singleId(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    /// @dev DE-DRIFT FRESH-2026 (NFTPOOL-ROYALTY-SELL-QUOTE): `getSellQuote` used
    ///      to return the PRE-royalty gross, so these tests read it as `gross` and
    ///      derived the net themselves. It now returns the NET (the whole point of
    ///      the fix: the quote must equal what the seller receives). The invariant
    ///      under test is UNCHANGED — `minOutput` gates the amount that actually
    ///      lands — only the way we obtain `gross` moves, from "the quote" to
    ///      "the quote plus its disclosed royalty component".
    function _quoteGrossAndNet(TegridyNFTPool p)
        internal
        view
        returns (uint256 gross, uint256 net, uint256 royalty)
    {
        (net, , , , royalty) = p.getSellQuoteWithRoyalty(1);
        // The reconciliation view must agree with the plain one.
        (uint256 plainNet,) = p.getSellQuote(1);
        require(plainNet == net, "QUOTE_VIEWS_DISAGREE");
        gross = net + royalty;
    }

    /// @notice Core regression. `minOutput == gross curve payout` passes the OLD
    ///         (pre-fix) gross check, but the seller would only net
    ///         `gross - royalty`. With the fix the swap MUST revert
    ///         `InsufficientPayout` because the net is below `minOutput`.
    function test_sellSwap_royaltyBelowMinOutput_reverts() public {
        address pool = _createBuyPool(50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 tokenId = nft.mint(carol);

        // Gross curve payout AFTER protocol/LP fees but BEFORE royalty — the
        // exact value the pre-fix check compared against.
        (uint256 grossOutput, , uint256 royalty) = _quoteGrossAndNet(p);
        assertGt(royalty, 0, "the 20% royalty must actually be priced");

        vm.startPrank(carol);
        nft.approve(address(p), tokenId);
        // Seller demands at least the gross. Post-fix this is unsatisfiable
        // because a 20% royalty is skimmed → revert.
        vm.expectRevert(TegridyNFTPool.InsufficientPayout.selector);
        p.swapNFTsForETH(_singleId(tokenId), grossOutput, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    /// @notice With `minOutput` set to the true net (gross − royalty) the swap
    ///         succeeds and the seller receives EXACTLY the net, the royalty
    ///         receiver is paid, and the seller never gets less than minOutput.
    function test_sellSwap_royaltyAtNetOutput_succeeds() public {
        address pool = _createBuyPool(50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 tokenId = nft.mint(carol);
        (uint256 grossOutput, uint256 expectedNet, uint256 expectedRoyalty) = _quoteGrossAndNet(p);
        assertEq(expectedRoyalty, grossOutput * ROYALTY_BPS / 10_000, "royalty rate");

        uint256 carolBefore = carol.balance;
        uint256 receiverBefore = royaltyReceiver.balance;

        vm.startPrank(carol);
        nft.approve(address(p), tokenId);
        p.swapNFTsForETH(_singleId(tokenId), expectedNet, block.timestamp + 1 hours);
        vm.stopPrank();

        // Seller received exactly the net, and it is >= the minOutput they set.
        assertEq(carol.balance - carolBefore, expectedNet, "seller nets gross - royalty");
        assertGe(carol.balance - carolBefore, expectedNet, "never below minOutput");
        assertEq(royaltyReceiver.balance - receiverBefore, expectedRoyalty, "royalty paid");
        assertTrue(p.isTokenHeld(tokenId), "pool holds the sold NFT");
    }

    /// @notice Just-above-net minOutput must revert (boundary): asking for one
    ///         wei more than the achievable net is InsufficientPayout.
    function test_sellSwap_oneWeiAboveNet_reverts() public {
        address pool = _createBuyPool(50 ether);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        uint256 tokenId = nft.mint(carol);
        (, uint256 expectedNet, ) = _quoteGrossAndNet(p);

        vm.startPrank(carol);
        nft.approve(address(p), tokenId);
        vm.expectRevert(TegridyNFTPool.InsufficientPayout.selector);
        p.swapNFTsForETH(_singleId(tokenId), expectedNet + 1, block.timestamp + 1 hours);
        vm.stopPrank();
    }
}
