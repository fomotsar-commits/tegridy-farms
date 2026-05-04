// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TegridyNFTPool} from "../src/TegridyNFTPool.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";
import {TegridyDropV2} from "../src/TegridyDropV2.sol";

// ─── AUDIT R014 — NFT layer remediation tests ─────────────────────────────────
//
// Covers three discrete fixes applied in this batch:
//
//   M-4 (NFTPool): `removeLiquidity` now reverts with `WaitOneBlock` when
//                  called in the same block as a swap (BUY or SELL). Closes
//                  the same-block remove-after-swap MEV vector where the LP
//                  observes a profitable swap in the mempool, lets it land,
//                  and pulls the freshly accumulated proceeds in the same
//                  block. Pattern: Uniswap V2 block-locked LP burn.
//
//   H-8 (DropV2):  `setMintPhase` now reverts with `MerkleRotationPending`
//                  whenever a merkle-root rotation proposal is queued. Without
//                  this, the owner could:
//                    1. propose root rotation while CLOSED
//                    2. flip the phase to ALLOWLIST mid-window
//                    3. wait 24h and execute the rotation mid-mint
//                  ...exactly the in-flight-claimer exclusion the timelock
//                  was meant to block.
//
//   L-4 (DropV2):  `weth` is set exactly once in `initialize()` (gated by OZ
//                  Initializable.initializer — re-init reverts) and there is
//                  no setter. Test pins this single-write invariant by
//                  asserting re-initialize reverts and that `weth` remains
//                  unchanged after every admin path that mutates other
//                  state. Clones cannot use the `immutable` keyword; this is
//                  the equivalent guarantee.
// ─────────────────────────────────────────────────────────────────────────────

// Minimal WETH mock (matches the shape used by other tests in this repo).
contract MockWETH {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

// Drop tests reuse a slightly different WETH (ERC20) — pattern lifted from
// TegridyDropV2.t.sol to keep behaviour parity between the two test suites.
contract MockWETHERC20 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

contract MockNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("MockApes", "MAPE") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
    function mintBatch(address to, uint256 count) external returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = _nextId++;
            _mint(to, ids[i]);
        }
    }
}

contract AuditR014_NFT_Test is Test {
    // Pool layer
    TegridyNFTPoolFactory public factory;
    MockNFT public nft;
    MockWETH public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // pool owner / LP / drop creator
    address public bob = makeAddr("bob");     // buyer / minter
    address public carol = makeAddr("carol"); // seller

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;

    // Drop layer
    TegridyDropV2 public drop;
    MockWETHERC20 public dropWeth;

    address public dropPlatform = makeAddr("dropPlatform");

    function setUp() public {
        // ── Pool ────────────────────────────────────────────────────
        weth = new MockWETH();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new MockNFT();

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);

        // Mint NFTs to alice (LP), carol (seller).
        for (uint256 i = 0; i < 10; i++) nft.mint(alice);
        for (uint256 i = 0; i < 5; i++) nft.mint(carol);

        // ── Drop ────────────────────────────────────────────────────
        dropWeth = new MockWETHERC20();
        // Implementation calls `_disableInitializers()` in its constructor — clone it.
        address impl = address(new TegridyDropV2());
        drop = TegridyDropV2(payable(Clones.clone(impl)));
    }

    // ── Pool helpers ────────────────────────────────────────────────────

    function _tokenIdArray(uint256 start, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) ids[i] = start + i;
    }

    function _singleId(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    /// SELL pool seeded with `count` NFTs starting at id 1 (alice's batch).
    function _createSellPool(uint256 count) internal returns (TegridyNFTPool pool) {
        uint256[] memory ids = _tokenIdArray(1, count);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        address poolAddr = factory.createPool(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            SPOT_PRICE,
            DELTA,
            0,
            ids
        );
        vm.stopPrank();
        pool = TegridyNFTPool(payable(poolAddr));
    }

    /// BUY pool seeded with `ethAmount` of ETH liquidity, no NFTs.
    function _createBuyPool(uint256 ethAmount) internal returns (TegridyNFTPool pool) {
        uint256[] memory empty = new uint256[](0);
        vm.prank(alice);
        address poolAddr = factory.createPool{value: ethAmount}(
            address(nft),
            TegridyNFTPool.PoolType.BUY,
            SPOT_PRICE,
            DELTA,
            0,
            empty
        );
        pool = TegridyNFTPool(payable(poolAddr));
    }

    // ─── M-4: removeLiquidity same-block-after-swap defense ─────────────

    /// AUDIT R014 M-4: a swap stamps `lastSwapBlock = block.number`. Calling
    /// `removeLiquidity` in the same block must revert.
    /// AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-NFTPOOL-H1 renamed
    /// `WaitOneBlock()` → `WaitForNFTWithdrawCooldown()` and lengthened the
    /// guard window from 1 block to WITHDRAW_NFT_COOLDOWN_BLOCKS (50). The
    /// same-block revert assertion is unchanged in semantics.
    function test_M4_removeLiquidity_revertsInSameBlockAsBuySwap() public {
        TegridyNFTPool pool = _createSellPool(3);

        // Buyer purchases token 1 (this stamps lastSwapBlock).
        (uint256 cost,) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_singleId(1), type(uint256).max, block.timestamp + 1 hours);

        assertEq(pool.lastSwapBlock(), block.number, "lastSwapBlock stamped after BUY swap");

        // Owner attempts to pull liquidity in the same block — must revert.
        uint256[] memory pull = _singleId(2);
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.WaitForNFTWithdrawCooldown.selector);
        pool.removeLiquidity(pull, 0);
    }

    /// AUDIT R014 M-4: same defense applies to SELL-side swaps. carol sells
    /// an NFT into a BUY pool; LP cannot pull in the same block.
    /// AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-NFTPOOL-H1 renamed
    /// `WaitOneBlock()` → `WaitForNFTWithdrawCooldown()`.
    function test_M4_removeLiquidity_revertsInSameBlockAsSellSwap() public {
        TegridyNFTPool pool = _createBuyPool(20 ether);

        // carol approves and sells token 11 (her first id) into the BUY pool.
        vm.startPrank(carol);
        nft.setApprovalForAll(address(pool), true);
        (uint256 minOutput,) = pool.getSellQuote(1);
        pool.swapNFTsForETH(_singleId(11), minOutput, block.timestamp + 1 hours);
        vm.stopPrank();

        assertEq(pool.lastSwapBlock(), block.number, "lastSwapBlock stamped after SELL swap");

        // Owner attempts to pull the freshly received NFT in the same block.
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.WaitForNFTWithdrawCooldown.selector);
        pool.removeLiquidity(_singleId(11), 0);

        // ETH-only pull also blocked in the same block.
        vm.prank(alice);
        vm.expectRevert(TegridyNFTPool.WaitForNFTWithdrawCooldown.selector);
        pool.removeLiquidity(new uint256[](0), 1 ether);
    }

    /// AUDIT R014 M-4: bumping past the swap block lets the pull go through.
    /// AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-NFTPOOL-H1 lengthened the
    /// cooldown from 1 block to WITHDRAW_NFT_COOLDOWN_BLOCKS (50), so we must
    /// roll forward >50 blocks for the guard to release.
    function test_M4_removeLiquidity_succeedsInNextBlock() public {
        TegridyNFTPool pool = _createSellPool(3);

        (uint256 cost,) = pool.getBuyQuote(1);
        vm.prank(bob);
        pool.swapETHForNFTs{value: cost}(_singleId(1), type(uint256).max, block.timestamp + 1 hours);

        // Roll past the WITHDRAW_NFT_COOLDOWN_BLOCKS (50) window — guard releases.
        vm.roll(block.number + pool.WITHDRAW_NFT_COOLDOWN_BLOCKS() + 1);

        uint256[] memory pull = _singleId(2);
        vm.prank(alice);
        pool.removeLiquidity(pull, 0);

        assertEq(nft.ownerOf(2), alice, "NFT returned to LP after cooldown wait");
    }

    /// AUDIT R014 M-4: pools never swapped (lastSwapBlock == 0) freely
    /// permit removeLiquidity. Guard is `block.number <= lastSwapBlock`,
    /// and no production block.number can be 0 — invariant holds.
    function test_M4_removeLiquidity_succeedsWithNoPriorSwap() public {
        TegridyNFTPool pool = _createSellPool(3);

        assertEq(pool.lastSwapBlock(), 0, "lastSwapBlock zero before any swap");

        uint256[] memory pull = _singleId(1);
        vm.prank(alice);
        pool.removeLiquidity(pull, 0);

        assertEq(nft.ownerOf(1), alice, "no-swap pool always allows removal");
    }

    // ─── H-8: setMintPhase race against pending merkleRoot rotation ─────

    function _dropDefaults() internal view returns (TegridyDropV2.InitParams memory p) {
        p.name = "R014 Drop";
        p.symbol = "R14";
        p.maxSupply = 100;
        p.mintPrice = 0.05 ether;
        p.maxPerWallet = 5;
        p.royaltyBps = 500;
        p.creator = alice;
        p.platformFeeRecipient = dropPlatform;
        p.platformFeeBps = 500;
        p.weth = address(dropWeth);
        p.placeholderURI = "ipfs://placeholder";
        p.contractURI_ = "ipfs://collection";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.CLOSED;
    }

    /// AUDIT R014 H-8: while a merkle rotation proposal is pending,
    /// `setMintPhase` reverts with `MerkleRotationPending`. This freezes the
    /// owner from flipping into ALLOWLIST mid-window and smuggling the queued
    /// rotation into an active mint phase.
    function test_H8_setMintPhase_revertsWhileMerkleProposalPending() public {
        TegridyDropV2.InitParams memory p = _dropDefaults();
        drop.initialize(p);

        // Owner queues a root rotation while CLOSED (allowed).
        bytes32 newRoot = keccak256("R014.rotation");
        vm.prank(alice);
        drop.proposeMerkleRoot(newRoot);
        assertTrue(drop.hasPendingProposal(drop.MERKLE_ROOT_CHANGE()));

        // Phase change to ALLOWLIST must revert until the rotation is
        // either executed or cancelled.
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.MerkleRotationPending.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);

        // PUBLIC and DUTCH_AUCTION are equally blocked — same defense path.
        vm.prank(alice);
        vm.expectRevert(TegridyDropV2.MerkleRotationPending.selector);
        drop.setMintPhase(TegridyDropV2.MintPhase.PUBLIC);
    }

    /// AUDIT R014 H-8: cancelling the proposal unfreezes setMintPhase. The
    /// owner can then legitimately open the mint without leaving a queued
    /// rotation lurking in the timelock.
    function test_H8_setMintPhase_succeedsAfterMerkleProposalCancelled() public {
        TegridyDropV2.InitParams memory p = _dropDefaults();
        // Pre-set the root so ALLOWLIST is a legal target phase.
        p.merkleRoot = keccak256("initial-root");
        drop.initialize(p);

        // Queue a rotation, then cancel it.
        vm.startPrank(alice);
        drop.proposeMerkleRoot(keccak256("new-root"));
        drop.cancelMerkleRoot();
        vm.stopPrank();
        assertFalse(drop.hasPendingProposal(drop.MERKLE_ROOT_CHANGE()));

        // Now the phase change goes through.
        vm.prank(alice);
        drop.setMintPhase(TegridyDropV2.MintPhase.ALLOWLIST);
        assertEq(uint8(drop.mintPhase()), uint8(TegridyDropV2.MintPhase.ALLOWLIST));
    }

    // ─── L-4: WETH single-write invariant ───────────────────────────────

    /// AUDIT R014 L-4: `weth` is set exactly once in `initialize()`. Re-init
    /// reverts via the OZ Initializable guard, and there is intentionally no
    /// setter — clones can't use `immutable`, so this is the equivalent
    /// security guarantee.
    function test_L4_weth_cannotBeChangedPostInit() public {
        TegridyDropV2.InitParams memory p = _dropDefaults();
        drop.initialize(p);
        assertEq(drop.weth(), address(dropWeth), "weth wired by initialize");

        // Re-initialize must revert (OZ Initializable). This is the single
        // path that touches `weth` post-construction.
        MockWETHERC20 attackerWeth = new MockWETHERC20();
        TegridyDropV2.InitParams memory p2 = _dropDefaults();
        p2.weth = address(attackerWeth);
        vm.expectRevert(); // InvalidInitialization (OZ Initializable)
        drop.initialize(p2);

        // `weth` remains pinned to the original.
        assertEq(drop.weth(), address(dropWeth), "weth still original after re-init attempt");

        // Confirm no admin path can mutate `weth`. Exercise every owner-only
        // setter that touches drop state: each one returns and `weth` is
        // unchanged. Any future setter that mutates `weth` would break
        // this assertion (intentional canary for the L-4 invariant).
        // AUDIT FIX: V2-DROP-01 — `setMintPrice` is now a deprecated shim;
        // exercise the propose/execute timelocked path instead.
        vm.startPrank(alice);
        drop.proposeMintPrice(0.01 ether);
        // AUDIT FIX V3-DROP-02: execute now value-binds expectedExecuteAfter.
        uint256 priceExecAfter = block.timestamp + 24 hours;
        vm.warp(block.timestamp + 25 hours);
        drop.executeMintPrice(0.01 ether, priceExecAfter);
        drop.setMaxPerWallet(2);
        drop.setBaseURI("ipfs://changed");
        drop.setContractURI("ipfs://changed-collection");
        vm.stopPrank();

        assertEq(drop.weth(), address(dropWeth), "weth immutable across admin paths");
    }
}
