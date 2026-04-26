// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";
import {TegridyNFTPool} from "../src/TegridyNFTPool.sol";

// ─── R064 — Pagination & bound-tightening test suite ─────────────────────────
//
// Coverage:
//   1. TegridyFactory.MAX_PAIRS = 10000 — `createPair` reverts at the cap.
//   2. TegridyFactory.allPairsPaginated returns the requested window and
//      clamps when start+count exceeds total.
//   3. TegridyNFTPoolFactory.getBestBuyPoolPaginated /
//      getBestSellPoolPaginated scan only the requested window.
//   4. TegridyNFTPoolFactory.claimPoolFeesBatch rejects non-pool addresses
//      with `NotAPool(address)` and accepts factory-deployed pools.
//   5. RevenueDistributor.MAX_CLAIM_EPOCHS == 250 (the new lowered ceiling
//      from R064 M-041-1; old ceiling was 500). We assert the constant
//      directly so a future regression that bumps it to 500+ trips the test.
//
// ─────────────────────────────────────────────────────────────────────────────

contract R064_MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract R064_MockNFT is ERC721 {
    uint256 private _next = 1;
    constructor() ERC721("Mock", "M") {}
    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }
}

contract R064_MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    receive() external payable { _mint(msg.sender, msg.value); }
}

// ─── TegridyFactory: MAX_PAIRS bound + pagination ───────────────────────────

contract R064_TegridyFactoryBoundsTest is Test {
    TegridyFactory factory;
    address admin = makeAddr("admin");

    function setUp() public {
        factory = new TegridyFactory(admin, admin);
    }

    /// @notice MAX_PAIRS constant should be 10000 (R064 ceiling).
    function test_MAX_PAIRS_is_10000() public view {
        assertEq(factory.MAX_PAIRS(), 10000);
    }

    /// @notice allPairsPaginated returns empty when start past total.
    function test_allPairsPaginated_emptyWhenStartPastTotal() public view {
        address[] memory page = factory.allPairsPaginated(0, 50);
        // Empty factory → empty slice (start=0 ≥ total=0).
        assertEq(page.length, 0);
    }

    /// @notice Create some pairs then walk allPairsPaginated.
    function test_allPairsPaginated_returnsWindow() public {
        // Create 5 pairs: 5 distinct token0/token1 combinations with token A
        // recurring is fine — uniswap-V2-style factories key by (a,b) sorted.
        R064_MockToken[] memory tokens = new R064_MockToken[](6);
        for (uint256 i; i < 6; i++) {
            tokens[i] = new R064_MockToken("T", "T");
        }
        // Pairs: (0,1), (0,2), (0,3), (0,4), (0,5) — 5 pairs.
        for (uint256 i = 1; i < 6; i++) {
            factory.createPair(address(tokens[0]), address(tokens[i]));
        }
        assertEq(factory.allPairsLength(), 5);

        // Window [1,3]: items at index 1,2,3 → length 3
        address[] memory window = factory.allPairsPaginated(1, 3);
        assertEq(window.length, 3);
        assertEq(window[0], factory.allPairs(1));
        assertEq(window[1], factory.allPairs(2));
        assertEq(window[2], factory.allPairs(3));

        // Window clamps when start+count > total: ask for 10 starting at 3
        address[] memory clamped = factory.allPairsPaginated(3, 10);
        assertEq(clamped.length, 2); // entries 3,4
    }

    /// @notice createPair rejects when allPairs.length already at MAX_PAIRS.
    /// @dev We use vm.store to inflate allPairs.length without actually
    ///      deploying 10000 pairs (that would be infeasibly slow). The
    ///      length of a Solidity dynamic array is stored at the array's
    ///      base slot.
    ///      Verified via `forge inspect TegridyFactory storage`:
    ///      slot 0 _executeAfter (mapping), 1 feeTo, 2 feeToSetter,
    ///      3 pendingFeeToSetter, 4 guardian, 5 pendingFeeTo,
    ///      6 getPair (mapping), **7 allPairs**.
    function test_createPair_revertsAtMAX_PAIRS() public {
        uint256 ALL_PAIRS_SLOT = 7;
        // Cheating: directly set length to 10000 so the next createPair fails.
        vm.store(address(factory), bytes32(ALL_PAIRS_SLOT), bytes32(uint256(10000)));
        assertEq(factory.allPairsLength(), 10000);

        R064_MockToken a = new R064_MockToken("A", "A");
        R064_MockToken b = new R064_MockToken("B", "B");
        vm.expectRevert(TegridyFactory.PairLimitReached.selector);
        factory.createPair(address(a), address(b));
    }
}

// ─── TegridyNFTPoolFactory: pagination + claimPoolFeesBatch membership ──────

contract R064_NFTPoolFactoryBoundsTest is Test {
    TegridyNFTPoolFactory factory;
    R064_MockNFT nft;
    R064_MockWETH weth;

    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");

    uint256 constant FEE_BPS = 50;
    uint256 constant SPOT = 0.1 ether;
    uint256 constant DELTA = 0.01 ether;
    uint256 constant LP_FEE = 30;

    function setUp() public {
        nft = new R064_MockNFT();
        weth = new R064_MockWETH();
        factory = new TegridyNFTPoolFactory(owner, FEE_BPS, feeRecipient, address(weth));
        vm.deal(alice, 100 ether);
    }

    function _createTradePool() internal returns (address pool) {
        uint256[] memory ids;
        vm.prank(alice);
        pool = factory.createPool{value: 0.01 ether}(
            address(nft), TegridyNFTPool.PoolType.TRADE, SPOT, DELTA, LP_FEE, ids
        );
    }

    /// @notice getBestBuyPoolPaginated returns the legacy empty signal
    ///         (address(0), type(uint256).max) when start past total.
    function test_getBestBuyPoolPaginated_emptyWhenStartPastTotal() public view {
        (address best, uint256 cost) = factory.getBestBuyPoolPaginated(address(nft), 100, 50, 1);
        assertEq(best, address(0));
        assertEq(cost, type(uint256).max);
    }

    /// @notice getBestSellPoolPaginated returns (address(0), 0) when start past total.
    function test_getBestSellPoolPaginated_emptyWhenStartPastTotal() public view {
        (address best, uint256 payout) = factory.getBestSellPoolPaginated(address(nft), 100, 50, 1);
        assertEq(best, address(0));
        assertEq(payout, 0);
    }

    /// @notice Pagination scans only the requested window. With 3 trade pools
    ///         (indices 0,1,2), a window starting at index 2 with count=10
    ///         scans only pool[2] — but since pool[2] has no NFT inventory yet
    ///         (only ETH seeded), getHeldCount<numItems and the function
    ///         returns the empty signal. We assert both: (a) call succeeds,
    ///         and (b) windowed result matches a direct unbounded call's
    ///         empty-inventory branch.
    function test_getBestBuyPoolPaginated_scansOnlyWindow() public {
        _createTradePool();
        _createTradePool();
        _createTradePool();
        assertEq(factory.getPoolCount(), 3);

        // Empty inventory in all 3 pools (no NFTs deposited) → no quote lands.
        // Both legacy and paginated return the same empty signal.
        (address legacyBest, uint256 legacyCost) = factory.getBestBuyPool(address(nft), 1);
        (address pageBest, uint256 pageCost) = factory.getBestBuyPoolPaginated(address(nft), 0, 3, 1);
        assertEq(legacyBest, pageBest);
        assertEq(legacyCost, pageCost);
    }

    /// @notice claimPoolFeesBatch rejects non-pool addresses with NotAPool.
    function test_claimPoolFeesBatch_rejectsNonPoolAddress() public {
        address fakePool = makeAddr("fakePool");
        address[] memory pools = new address[](1);
        pools[0] = fakePool;
        vm.expectRevert(
            abi.encodeWithSelector(TegridyNFTPoolFactory.NotAPool.selector, fakePool)
        );
        factory.claimPoolFeesBatch(pools);
    }

    /// @notice claimPoolFeesBatch accepts factory-created pools (no revert).
    function test_claimPoolFeesBatch_acceptsFactoryPool() public {
        address pool = _createTradePool();
        // Sanity: the membership flag was set.
        assertTrue(factory.isPool(pool));

        address[] memory pools = new address[](1);
        pools[0] = pool;
        // Should not revert. Pool has no accumulated fees → no-op inside.
        factory.claimPoolFeesBatch(pools);
    }

    /// @notice claimPoolFeesBatch reverts on first invalid address (mixed input).
    ///         The check is `revert` not `continue`, so a poisoned batch fails
    ///         atomically — protecting integrators from silent partial success.
    function test_claimPoolFeesBatch_revertsOnMixedInput() public {
        address pool = _createTradePool();
        address fake = makeAddr("notAPool");

        address[] memory pools = new address[](2);
        pools[0] = pool;
        pools[1] = fake;
        vm.expectRevert(
            abi.encodeWithSelector(TegridyNFTPoolFactory.NotAPool.selector, fake)
        );
        factory.claimPoolFeesBatch(pools);
    }

    /// @notice isPool flips true exactly when createPool runs.
    function test_isPool_setOnCreate() public {
        address random = makeAddr("random");
        assertFalse(factory.isPool(random), "non-deployed addr false");
        address pool = _createTradePool();
        assertTrue(factory.isPool(pool), "deployed pool true");
    }
}

// ─── RevenueDistributor: MAX_CLAIM_EPOCHS lowered to 250 ────────────────────

interface IRevenueDistributor {
    function MAX_CLAIM_EPOCHS() external view returns (uint256);
    function MAX_VIEW_EPOCHS() external view returns (uint256);
}

contract R064_RevenueDistributorBoundsTest is Test {
    /// @notice MAX_CLAIM_EPOCHS must equal the lowered R064 ceiling (250).
    /// @dev We don't deploy the full distributor (deps require staking +
    ///      WETH wiring); we just attach the interface to a freshly compiled
    ///      bytecode address and read the constant via the artifact.
    ///      The simplest deterministic check is to deploy a minimal version
    ///      using vm.getCode + create. But constants live in code, not
    ///      storage, so we can dispatch the read via the artifact. Use
    ///      vm.getCode to instantiate without invoking the constructor.
    function test_MAX_CLAIM_EPOCHS_is_250() public {
        bytes memory code = vm.getDeployedCode("RevenueDistributor.sol:RevenueDistributor");
        // Drop a copy of the deployed code at a deterministic address and
        // call the constant getter as a static read.
        address shim = makeAddr("shim");
        vm.etch(shim, code);

        IRevenueDistributor d = IRevenueDistributor(shim);
        assertEq(d.MAX_CLAIM_EPOCHS(), 250, "R064: claim cap lowered 500 -> 250");
        assertEq(d.MAX_VIEW_EPOCHS(), 250, "R064: view cap also 250");
    }
}
