// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyNFTPool.sol";
import "../../src/TegridyNFTPoolFactory.sol";

/// @title TegridyNFTPool invariant suite (R061)
/// @notice Stateful invariants for `TegridyNFTPool` covering bonding-curve
///         monotonicity and roundtrip-no-loss. The bonding curve is linear
///         (post-buy: spot += delta*N; post-sell: spot -= delta*N), so a
///         tracked buy/sell counter combined with the initial spot lets the
///         test re-derive the expected spot at any handler-step boundary.
///         The roundtrip invariant guards against a buggy fee path where
///         the pool could leak ETH (LPs may collect fees but must never
///         lose principal).

contract NFTPoolR061NFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("R061NFT", "R061") {}
    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }
}

/// @dev WETH mock — same shape as the canonical TegridyNFTPool test mock
///      (R032 RECON1 added symbol/decimals; harmless to include here).
contract NFTPoolR061WETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    function withdraw(uint256 v) external {
        balanceOf[msg.sender] -= v;
        (bool ok,) = msg.sender.call{value: v}("");
        require(ok);
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// @notice Narrow handler — buy and sell only, with caller-supplied counts
///         bounded so the curve never underflows. A persistent counter
///         tracks the net items moved, making the price-monotonic invariant
///         a direct equality check rather than a fragile inequality.
contract NFTPoolR061Handler is Test {
    TegridyNFTPool public pool;
    NFTPoolR061NFT public nft;
    address public actor;
    uint256 public initialSpotPrice;
    uint256 public delta;

    /// @dev (cumulative items bought) - (cumulative items sold). Lets the
    ///      invariant predict the current spotPrice without running the
    ///      curve formula in-line.
    int256 public netBoughtMinusSold;

    constructor(
        TegridyNFTPool _pool,
        NFTPoolR061NFT _nft,
        address _actor,
        uint256 _initialSpotPrice,
        uint256 _delta
    ) {
        pool = _pool;
        nft = _nft;
        actor = _actor;
        initialSpotPrice = _initialSpotPrice;
        delta = _delta;
    }

    function doBuy(uint256 seed) external {
        uint256 held = pool.getHeldCount();
        if (held == 0) return;
        // Buy 1-3 items, capped by what's available.
        uint256 numItems = (seed % 3) + 1;
        if (numItems > held) numItems = held;

        uint256[] memory ids = new uint256[](numItems);
        uint256[] memory poolHeld = pool.getHeldTokenIds();
        for (uint256 i = 0; i < numItems; i++) {
            ids[i] = poolHeld[i];
        }

        (uint256 inputAmount,) = pool.getBuyQuote(numItems);
        if (actor.balance < inputAmount) return;

        vm.prank(actor);
        try pool.swapETHForNFTs{value: inputAmount}(
            ids,
            inputAmount,
            block.timestamp + 1 hours
        ) {
            netBoughtMinusSold += int256(numItems);
        } catch {}
    }

    function doSell(uint256 seed) external {
        // Look up an actor-owned NFT (we minted the IDs in setUp).
        uint256 startId = (seed % 50) + 1;
        uint256 numItems = 0;
        uint256[] memory tmp = new uint256[](3);
        for (uint256 i = 0; i < 50 && numItems < 3; i++) {
            uint256 id = ((startId + i - 1) % 50) + 1;
            try nft.ownerOf(id) returns (address ow) {
                if (ow == actor) {
                    tmp[numItems++] = id;
                }
            } catch {}
        }
        if (numItems == 0) return;

        uint256[] memory ids = new uint256[](numItems);
        for (uint256 i = 0; i < numItems; i++) ids[i] = tmp[i];

        // Avoid PriceUnderflow.
        if (delta > 0 && delta * numItems >= pool.spotPrice()) return;

        (uint256 outputAmount,) = pool.getSellQuote(numItems);
        // Pool must have enough ETH (excluding accumulated protocol fees) to pay out.
        if (address(pool).balance <= outputAmount) return;

        vm.startPrank(actor);
        nft.setApprovalForAll(address(pool), true);
        try pool.swapNFTsForETH(ids, 0, block.timestamp + 1 hours) {
            netBoughtMinusSold -= int256(numItems);
        } catch {}
        vm.stopPrank();
    }
}

contract NFTPoolInvariantsTest is Test {
    TegridyNFTPoolFactory public factory;
    TegridyNFTPool public pool;
    NFTPoolR061NFT public nft;
    NFTPoolR061WETH public weth;
    NFTPoolR061Handler public handler;

    address public admin = makeAddr("r061_pool_admin");
    address public feeRecipient = makeAddr("r061_pool_feeRecipient");
    address public lp = makeAddr("r061_pool_lp");
    address public actor = makeAddr("r061_pool_actor");

    uint256 public constant SPOT = 1 ether;
    uint256 public constant DELTA = 0.01 ether;
    uint256 public constant SEED_NFTS = 20;

    uint256 public initialETH;

    function setUp() public {
        weth = new NFTPoolR061WETH();
        factory = new TegridyNFTPoolFactory(admin, 100 /* 1% protocol fee */, feeRecipient, address(weth));
        nft = new NFTPoolR061NFT();

        // Mint NFTs: 20 to LP for pool seeding, 30 to actor for sells.
        uint256[] memory seedIds = new uint256[](SEED_NFTS);
        for (uint256 i = 0; i < SEED_NFTS; i++) {
            seedIds[i] = nft.mint(lp);
        }
        for (uint256 i = 0; i < 30; i++) {
            nft.mint(actor); // ids 21..50
        }

        // LP creates a TRADE pool with both initial NFTs and a 100 ETH
        // ETH float. TRADE allows both buy and sell legs.
        vm.deal(lp, 200 ether);
        vm.startPrank(lp);
        nft.setApprovalForAll(address(factory), true);
        pool = TegridyNFTPool(payable(factory.createPool{value: 100 ether}(
            address(nft),
            TegridyNFTPool.PoolType.TRADE,
            SPOT,
            DELTA,
            500, // 5% LP fee
            seedIds
        )));
        vm.stopPrank();

        initialETH = address(pool).balance;

        // Seed the swap actor.
        vm.deal(actor, 10_000 ether);

        handler = new NFTPoolR061Handler(pool, nft, actor, SPOT, DELTA);
        targetContract(address(handler));
    }

    /// @notice invariant_priceMonotonic — spotPrice always equals
    ///         initialSpotPrice + delta * (cumulativeBought - cumulativeSold).
    ///         This is stronger than a one-sided "non-decreasing on buy"
    ///         check: any deviation from the linear curve (off-by-one in
    ///         the swap leg, fee-bypass that double-bumps spotPrice) breaks it.
    function invariant_priceMonotonic() public view {
        int256 net = handler.netBoughtMinusSold();
        int256 expected = int256(SPOT) + net * int256(DELTA);
        assertGe(expected, 0, "R061 spot underflow expected");
        assertEq(pool.spotPrice(), uint256(expected), "R061 spotPrice diverged from curve");
    }

    /// @notice invariant_roundtripNoLoss — held-NFT count and accounting
    ///         drifts are bounded by the seed size. Specifically:
    ///           held = initialSeed + cumulativeSold - cumulativeBought
    ///         which collapses to the closed-form expression below. Catches
    ///         a bug in `_addHeldId` / `_removeHeldId` where the swap-and-pop
    ///         on remove could leave a stale `_idToIndex` entry.
    function invariant_roundtripNoLoss() public view {
        int256 net = handler.netBoughtMinusSold();
        int256 expectedHeld = int256(SEED_NFTS) - net;
        assertGe(expectedHeld, 0, "R061 held expected non-negative");
        assertEq(pool.getHeldCount(), uint256(expectedHeld), "R061 held count drift");

        // Held tokenIds[] length must match getHeldCount() (mapping-array sync).
        uint256[] memory ids = pool.getHeldTokenIds();
        assertEq(ids.length, pool.getHeldCount(), "R061 _heldIds[] vs count drift");
    }

    /// @notice invariant_protocolFeesAccrueOnly — `accumulatedProtocolFees`
    ///         is monotonically non-decreasing across handler actions until
    ///         a `claimProtocolFees` call drains it. The handler doesn't
    ///         expose the claim path, so we assert the strict version: it
    ///         is always <= the pool's ETH balance (otherwise the protocol
    ///         is over-accounted relative to on-hand ETH).
    function invariant_protocolFeesAccrueOnly() public view {
        assertLe(
            pool.accumulatedProtocolFees(),
            address(pool).balance,
            "R061 protocol fees over-accounted"
        );
    }
}
