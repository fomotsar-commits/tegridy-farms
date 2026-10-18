// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// Only functions the July 16 mainnet template and the buyer-pays build both answer, so one
// harness can drive either: the live bytecode on a fork, or a factory built from this tree.
interface INFTPoolFactoryAnyVersion {
    function createPool(address, uint8, uint256, uint256, uint256, uint256[] calldata)
        external
        payable
        returns (address);
}

interface INFTPoolAnyVersion {
    function getBuyQuote(uint256) external view returns (uint256 inputAmount, uint256 protocolFee);
    function swapETHForNFTs(uint256[] calldata, uint256, uint256) external payable;
    function swapNFTsForETH(uint256[] calldata, uint256, uint256) external;
}

/// ERC-2981 collection whose royalty receiver is chosen by its deployer: the hostile case.
contract HostileRoyaltyNFT is ERC721 {
    address public immutable receiver;
    uint256 public immutable bps;
    uint256 private _nextId = 1;

    constructor(address receiver_, uint256 bps_) ERC721("HostileRoyalty", "HSTL") {
        receiver = receiver_;
        bps = bps_;
    }

    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (receiver, salePrice * bps / 10_000);
    }
}

abstract contract NFTPoolRoundTrip is Test {
    uint8 internal constant TRADE = 2; // TegridyNFTPool.PoolType.TRADE
    uint256 internal constant ROYALTY_BPS = 2500; // the pool's 25% cap: the most a receiver gets
    uint256 internal constant SPOT_PRICE = 1 ether;
    uint256 internal constant DELTA = 0.1 ether;
    uint256 internal constant POOL_ETH = 20 ether;
    uint256 internal constant LOOPS = 10;

    /// Pool ETH lost when a trader who is also the collection's royalty receiver buys and
    /// sells one NFT LOOPS times. Each round trip is curve-neutral, so any loss is royalty
    /// the pool paid. Protocol fees stay in the pool's balance and count in its favour.
    function _roundTripLoss(address factory) internal returns (uint256 loss) {
        address lp = makeAddr("nft-pool-rehearsal-lp");
        address trader = makeAddr("nft-pool-rehearsal-trader");
        HostileRoyaltyNFT nft = new HostileRoyaltyNFT(trader, ROYALTY_BPS);
        uint256[] memory ids = new uint256[](1);
        ids[0] = nft.mint(lp);
        vm.deal(lp, POOL_ETH);
        vm.deal(trader, 100 ether);

        vm.startPrank(lp);
        nft.setApprovalForAll(factory, true);
        address pool = INFTPoolFactoryAnyVersion(factory).createPool{value: POOL_ETH}(
            address(nft), TRADE, SPOT_PRICE, DELTA, 0, ids
        );
        vm.stopPrank();

        uint256 start = pool.balance;
        vm.startPrank(trader);
        nft.setApprovalForAll(pool, true);
        for (uint256 i = 0; i < LOOPS; i++) {
            (uint256 cost,) = INFTPoolAnyVersion(pool).getBuyQuote(1);
            INFTPoolAnyVersion(pool).swapETHForNFTs{value: cost}(ids, type(uint256).max, block.timestamp + 1 hours);
            INFTPoolAnyVersion(pool).swapNFTsForETH(ids, 0, block.timestamp + 1 hours);
        }
        vm.stopPrank();
        loss = start > pool.balance ? start - pool.balance : 0;
    }
}
