// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";

/// @title FreshEyes_2026_05_18 — regression PoCs for H2 + M7
/// @notice H2 — stacked-defense regression for the
///         `TegridyNFTPool.swapNFTsForETH` payout path. The end-to-end
///         exploit (bonus tokenId smuggled into `_heldIds` via
///         `onERC721Received` re-entry during the seller's `receive()`)
///         is defended by two layers stacked in CEI order:
///           (a) the `WETHFallbackLib.safeTransferETHOrWrap` 30k gas
///               stipend, which OOGs any non-trivial re-entry payload
///               (`_addHeldId` alone costs ~50k SSTOREs, dominating any
///               cheap-NFT path), AND
///           (b) the FRESH-2026 H2 fix that clears `_swapCaller` BEFORE
///               `_sendETH` so even if the stipend ever grows (legitimate
///               first-ingress cold-SSTORE pattern already bumped it from
///               10k → 30k), the gate-check rejects the re-entrant deposit
///               with `UNAUTHORIZED_DEPOSIT`.
///         The test exercises the full path under realistic constraints
///         (gas stipend = 30k, OZ-style ERC721 too heavy to fit, so we
///         use a minimal-gas NFT). It passes pre-patch too because layer
///         (a) holds — this test is the regression for the COMBINED
///         defense, not a differentiator for layer (b) alone.
/// @notice M7 — differentiating regression for
///         `TegridyDropV2.transferOwnership`. Pending hostile admin
///         proposals are now flushed eagerly so the outgoing owner cannot
///         execute them during the 14-day `pendingOwner` window while
///         still the active owner. Fails on pre-patch source: the
///         `pendingMerkleRoot` survives `transferOwnership` and would
///         execute 24h later.

// ─── Mocks ──────────────────────────────────────────────────────────

contract MockWETH_FE is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external { _burn(msg.sender, amount); payable(msg.sender).transfer(amount); }
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @dev Minimal ERC721-like collection used to keep the re-entrant
///      `safeTransferFrom` cheap enough to fit within the WETHFallbackLib's
///      30k gas stipend. A standard OZ ERC721's transferFrom alone costs
///      ~50k+ (multiple SSTOREs + Transfer event), which would OOG inside
///      the receive() and mask the H2 surface behind the gas-stipend
///      defense rather than the gate-check defense the patch hardens.
contract MockNFT_FE is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("MockApes", "MAPE") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}

/// @dev Bare-bones ERC721 surface — single SSTORE on transfer, no balance
///      tracking, no event, no approval table. Total `safeTransferFrom`
///      gas including the receiver call ≈ 12-15k, leaving budget for the
///      pool's `onERC721Received` + `_addHeldId` inside a 30k stipend.
///      Only used in the H2 PoC; never deployed.
contract MinimalReentrantNFT {
    mapping(uint256 => address) public ownerOf;
    uint256 internal _next = 1;

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        ownerOf[id] = to;
    }

    function setApprovalForAll(address, bool) external pure {}
    function isApprovedForAll(address, address) external pure returns (bool) { return true; }
    function supportsInterface(bytes4) external pure returns (bool) { return true; }

    function safeTransferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "NOT_OWNER");
        ownerOf[id] = to;
        if (to.code.length > 0) {
            IERC721Receiver(to).onERC721Received(msg.sender, from, id, "");
        }
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata) external {
        safeTransferFrom(from, to, id);
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "NOT_OWNER");
        ownerOf[id] = to;
    }
}

/// @dev Seller-side attacker: when receiving ETH payout from
///      `swapNFTsForETH`, re-enters via `nftCollection.safeTransferFrom(this,
///      pool, bonusId)` to stuff an extra tokenId into the pool's `_heldIds`.
///      Pre-fix the pool's `onERC721Received` accepts the bonus deposit
///      because `_swapInFlight && from == _swapCaller` is still true at
///      payout time. Post-fix `_swapCaller` is cleared BEFORE `_sendETH`
///      so the inner `onERC721Received` reverts `UNAUTHORIZED_DEPOSIT`,
///      the re-entrant `safeTransferFrom` reverts, the seller's `receive`
///      reverts, and the payout falls back to WETH wrap.
contract MaliciousSeller is IERC721Receiver {
    TegridyNFTPool public pool;
    MinimalReentrantNFT public nft;
    uint256 public bonusTokenId;
    bool public attacking;

    constructor(address _pool, address _nft) {
        pool = TegridyNFTPool(payable(_pool));
        nft = MinimalReentrantNFT(_nft);
    }

    function arm(uint256 _bonusTokenId) external {
        bonusTokenId = _bonusTokenId;
        attacking = true;
    }

    function sell(uint256 tokenId, uint256 deadline) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        pool.swapNFTsForETH(ids, 0, deadline);
    }

    // Required so the pool can transfer the legitimate tokenId IN
    // (loop iteration in swapNFTsForETH).
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Called by WETHFallbackLib's `.call{value:, gas:30000}` during the
    ///      ETH payout leg. We attempt to dump `bonusTokenId` into the pool.
    ///      Post-patch this should revert via `UNAUTHORIZED_DEPOSIT` from
    ///      the pool's `onERC721Received` (because `_swapCaller` is now 0).
    receive() external payable {
        if (attacking) {
            attacking = false; // one-shot
            nft.safeTransferFrom(address(this), address(pool), bonusTokenId);
        }
    }
}

// ─── Test ───────────────────────────────────────────────────────────

contract FreshEyes_2026_05_18_Test is Test {
    TegridyNFTPoolFactory factory;
    MinimalReentrantNFT nft;
    MockWETH_FE weth;

    address admin = makeAddr("admin");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");

    function setUp() public {
        weth = new MockWETH_FE();
        factory = new TegridyNFTPoolFactory(admin, 100, feeRecipient, address(weth));
        nft = new MinimalReentrantNFT();
        vm.deal(alice, 1000 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // H2 — Seller-side `onERC721Received` re-entry is blocked
    // ═══════════════════════════════════════════════════════════════

    function test_freshEyes_H2_sellerReceiveCallback_cannotDepositBonusTokenId() public {
        // 1. Alice creates a TRADE pool with 3 NFTs + 10 ETH liquidity.
        //    We use MinimalReentrantNFT (not OZ ERC721) so the re-entrant
        //    safeTransferFrom inside the seller's receive() fits within
        //    the WETHFallbackLib 30k gas stipend. With OZ's ~50k-gas
        //    safeTransferFrom the receive() OOGs first and the gate-check
        //    defense never gets exercised — the test would pass under both
        //    pre- and post-patch source (the stipend masks the gap).
        uint256[] memory liqIds = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) liqIds[i] = nft.mint(alice);

        vm.startPrank(alice);
        address pool = factory.createPool{value: 10 ether}(
            address(nft),
            TegridyNFTPool.PoolType.TRADE,
            1 ether,    // spot
            0.1 ether,  // delta
            500,        // 5% LP fee
            liqIds
        );
        vm.stopPrank();

        // 2. Deploy the MaliciousSeller. Mint two NFTs to it:
        //    - `legitId` will be sold normally
        //    - `bonusId` is what attacker tries to bridge via re-entry
        MaliciousSeller seller = new MaliciousSeller(pool, address(nft));
        uint256 legitId = nft.mint(address(seller));
        uint256 bonusId = nft.mint(address(seller));

        seller.arm(bonusId);

        // 3. Snapshot the pool's held-count BEFORE the swap.
        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        uint256 heldBefore = p.getHeldCount();
        assertEq(heldBefore, 3, "initial liquidity");

        // 4. Execute the sell. The pool's seller-payout calls
        //    `WETHFallbackLib.safeTransferETHOrWrap` which first tries the
        //    raw `.call{value:, gas:30k}` — that hits the seller's
        //    `receive()` which re-enters via the NFT collection.
        seller.sell(legitId, block.timestamp + 1 hours);

        // 5. Assert the bonus tokenId did NOT land in the pool's inventory.
        //    Post-patch: receiver gate rejects the re-entrant deposit
        //    (UNAUTHORIZED_DEPOSIT), which reverts the safeTransferFrom,
        //    which reverts the seller's receive(), which forces the
        //    WETH-wrap fallback. The bonus stays with the seller; the
        //    pool gains only the one legitimate token.
        assertEq(p.getHeldCount(), heldBefore + 1, "only legit token in pool");
        assertTrue(p.isTokenHeld(legitId), "legit token held");
        assertFalse(p.isTokenHeld(bonusId), "bonus token NOT smuggled in");
        assertEq(nft.ownerOf(bonusId), address(seller), "bonus still owned by seller");

        // 6. Because the receive() reverted, the payout was delivered as
        //    WETH (fallback leg). Seller has WETH balance, zero raw ETH.
        //    This is the on-chain breadcrumb that the re-entry was caught.
        assertEq(address(seller).balance, 0, "no raw ETH (receive reverted)");
        assertGt(weth.balanceOf(address(seller)), 0, "payout via WETH fallback");
    }

    // ═══════════════════════════════════════════════════════════════
    // M7 — transferOwnership flushes pending admin proposals
    // ═══════════════════════════════════════════════════════════════

    function test_freshEyes_M7_outgoingOwnerCannotExecuteHostileRootAfterTransfer() public {
        // 1. Stand up a fresh DropV2 clone with `creator` (= alice here) as
        //    initial owner, phase = CLOSED so root rotation is allowed.
        TegridyDropV2 drop = TegridyDropV2(payable(Clones.clone(address(new TegridyDropV2()))));

        TegridyDropV2.InitParams memory p;
        p.name = "Test";
        p.symbol = "T";
        p.maxSupply = 100;
        p.mintPrice = 0.01 ether;
        p.maxPerWallet = 5;
        p.royaltyBps = 0;
        p.creator = alice;
        p.platformFeeRecipient = feeRecipient;
        p.platformFeeBps = 0;
        p.weth = address(weth);
        p.placeholderURI = "ipfs://x";
        p.contractURI_ = "ipfs://y";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
        drop.initialize(p);

        address victim = makeAddr("victim");
        bytes32 hostileRoot = keccak256("hostile");

        // 2. The current (outgoing-to-be) owner queues a hostile merkle root
        //    proposal — 24h timelock. Allowed because phase == CLOSED.
        vm.prank(alice);
        drop.proposeMerkleRoot(hostileRoot);
        assertEq(drop.pendingMerkleRoot(), hostileRoot, "proposal queued");

        // Capture the executeAfter timestamp the proposal was bound to.
        uint256 readyAt = block.timestamp + drop.MERKLE_ROOT_DELAY();

        // 3. The outgoing owner initiates transfer to `victim`. Post-patch
        //    this MUST also cancel the pending proposal — the whole point
        //    of FRESH-2026 M7. We assert `pendingMerkleRoot` is zeroed.
        vm.prank(alice);
        drop.transferOwnership(victim);
        assertEq(drop.pendingMerkleRoot(), bytes32(0), "M7: proposal flushed at transferOwnership");

        // 4. Wait out the original 24h delay. Alice is STILL owner (victim
        //    hasn't accepted). Pre-patch, alice could now executeMerkleRoot
        //    and the hostile root would land.
        vm.warp(readyAt + 1);

        // 5. Post-patch the execute call MUST revert. The proposal was
        //    cancelled, so `pendingMerkleRoot == bytes32(0)` — the
        //    `require(pendingMerkleRoot == expectedRoot, "ROOT_MISMATCH")`
        //    check fires first.
        vm.expectRevert(bytes("ROOT_MISMATCH"));
        vm.prank(alice);
        drop.executeMerkleRoot(hostileRoot, readyAt);

        // 6. Cross-check: the actual merkleRoot is still the initial zero
        //    value — no hostile rotation landed.
        assertEq(drop.merkleRoot(), bytes32(0), "merkleRoot untouched");
    }
}
