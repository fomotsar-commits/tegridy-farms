// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";
import {TegridyNFTPool} from "../src/TegridyNFTPool.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─── AUDIT FIX 2026-07-12 [MED]: single-actor per-collection censorship ──────
//
// FINDING: `createPool` caps pools per collection at MAX_POOLS_PER_COLLECTION
// (200) but `_poolsByCollection` is append-only and the 0.05 ETH MIN_DEPOSIT is
// recoverable (never-swapped pool skips its withdraw cooldown). So one actor
// could fill all 200 slots for a targeted collection for ~gas and permanently
// censor pool creation for everyone else on that collection.
//
// FIX: a per-creator-per-collection cap (MAX_POOLS_PER_CREATOR_COLLECTION = 20)
// so no single msg.sender can exhaust the shared 200-slot namespace.
//
// These tests FAIL on the pre-fix contract (alice could create an unbounded
// number of pools for one collection) and PASS with the cap in place.
// ─────────────────────────────────────────────────────────────────────────────

contract MockNFT is ERC721 {
    uint256 private _next = 1;

    constructor() ERC721("MockNFT", "MOCK") {}

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract Audit20260712_PoolFactoryCensorshipTest is Test {
    TegridyNFTPoolFactory factory;
    MockNFT nft;
    MockWETH weth;

    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("feeRecipient");
    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");

    uint256 constant INITIAL_FEE_BPS = 50; // 0.5%
    uint256 constant SPOT_PRICE = 0.1 ether;
    uint256 constant DELTA = 0.01 ether;
    uint256 constant LP_FEE_BPS = 30; // 0.3%

    function setUp() public {
        nft = new MockNFT();
        weth = new MockWETH();
        factory = new TegridyNFTPoolFactory(owner, INITIAL_FEE_BPS, feeRecipient, address(weth));
        vm.deal(attacker, 1000 ether);
        vm.deal(victim, 100 ether);
    }

    function _create(address who) internal returns (address pool) {
        uint256[] memory ids;
        vm.prank(who);
        pool = factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.TRADE, SPOT_PRICE, DELTA, LP_FEE_BPS, ids
        );
    }

    /// @notice A single creator is capped at MAX_POOLS_PER_CREATOR_COLLECTION
    ///         pools for one collection. On the pre-fix contract the 21st (and
    ///         beyond) would succeed, letting one actor march toward the global
    ///         200-slot cap alone.
    function test_singleCreator_cappedPerCollection() public {
        uint256 cap = factory.MAX_POOLS_PER_CREATOR_COLLECTION();

        // The cap-th pool succeeds.
        for (uint256 i = 0; i < cap; i++) {
            _create(attacker);
        }
        assertEq(factory.poolsByCreatorCollection(attacker, address(nft)), cap, "counter tracks creator's pools");
        assertEq(factory.getPoolsForCollection(address(nft)).length, cap);

        // The (cap+1)-th by the SAME creator must revert.
        uint256[] memory ids;
        vm.prank(attacker);
        vm.expectRevert(bytes("MAX_POOLS_PER_CREATOR_COLLECTION"));
        factory.createPool{value: 0.05 ether}(
            address(nft), TegridyNFTPool.PoolType.TRADE, SPOT_PRICE, DELTA, LP_FEE_BPS, ids
        );
    }

    /// @notice After one actor hits their per-creator cap, the collection
    ///         namespace is NOT exhausted: other creators can still create.
    ///         This is the anti-censorship property the fix restores.
    function test_otherCreatorNotCensoredByExhaustedActor() public {
        uint256 cap = factory.MAX_POOLS_PER_CREATOR_COLLECTION();
        for (uint256 i = 0; i < cap; i++) {
            _create(attacker);
        }

        // Victim can still create a pool for the same collection.
        address victimPool = _create(victim);
        assertTrue(victimPool != address(0), "victim must not be censored");
        assertEq(factory.poolsByCreatorCollection(victim, address(nft)), 1);
    }

    /// @notice The per-creator cap is scoped per-collection: hitting the cap on
    ///         one collection does not block the same creator on another.
    function test_capIsPerCollectionNotGlobal() public {
        MockNFT other = new MockNFT();
        uint256 cap = factory.MAX_POOLS_PER_CREATOR_COLLECTION();
        for (uint256 i = 0; i < cap; i++) {
            _create(attacker);
        }

        // Same attacker, DIFFERENT collection — still allowed.
        uint256[] memory ids;
        vm.prank(attacker);
        address p = factory.createPool{value: 0.05 ether}(
            address(other), TegridyNFTPool.PoolType.TRADE, SPOT_PRICE, DELTA, LP_FEE_BPS, ids
        );
        assertTrue(p != address(0));
        assertEq(factory.poolsByCreatorCollection(attacker, address(other)), 1);
    }
}
