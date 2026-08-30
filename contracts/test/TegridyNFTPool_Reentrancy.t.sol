// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";
import {IWETH} from "../src/lib/WETHFallbackLib.sol";

// ─── Mock Contracts (reused from TegridyNFTPool.t.sol) ─────────────

contract MockWETH_Reentry {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

contract MockNFT_Reentry is ERC721 {
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

// ─── Attacker Contracts ────────────────────────────────────────────

/// @dev Attacker that tries to re-enter the pool when it receives ETH
///      (via refund in swapETHForNFTs, payout in swapNFTsForETH, or withdrawal in removeLiquidity).
///      Two independent layers are supposed to stop it: `WETHFallbackLib`'s gas
///      stipend on the raw-ETH leg, and the pool's `nonReentrant` guard.
contract ReentrantAttacker {
    TegridyNFTPool public target;
    bool public attacking;
    bytes public attackCalldata;

    /// @dev One-shot arming state, deliberately encoded as a NON-ZERO sentinel
    ///      rather than a `bool`/counter pair.
    ///
    ///      This is a gas-budget decision, not a style one. `receive()` runs
    ///      inside `WETHFallbackLib`'s stipend, so every slot it touches is
    ///      charged against that budget. A `attackCount++` from 0 costs 20,000
    ///      gas (SSTORE_SET) all by itself; measured on forge 1.5.1 the old
    ///      shape burned 29,867 of the 32,300 available (30k stipend + the
    ///      2,300 value stipend), leaving 7.5% headroom — so an ordinary
    ///      codegen shift between toolchain releases changed the OUTCOME of
    ///      this test on unchanged contract code. Arming to a non-zero value
    ///      first makes the write inside `receive()` a cheap dirty-slot store
    ///      (~100 gas) and buys back an order of magnitude of headroom.
    ///
    ///      0 = idle, 1 = armed, 2 = attempted and rejected, 3 = attempted and
    ///      SUCCEEDED (i.e. reentrancy defence failed).
    uint8 public attackState;

    /// @dev Whether to forward `msg.value` on the re-entrant call.
    ///      Load-bearing: `swapNFTsForETH` and `removeLiquidity` are NOT
    ///      payable, so a call carrying value is rejected by the compiler's
    ///      callvalue check BEFORE `nonReentrant` is ever consulted (measured:
    ///      the inner call cost 994 gas and died at the dispatcher). A test
    ///      that forwards value to a non-payable target therefore proves
    ///      nothing about the guard. Callers targeting non-payable functions
    ///      set this false so the re-entrant call actually reaches the guard.
    bool public forwardValueOnReenter = true;

    constructor(address _target) {
        target = TegridyNFTPool(payable(_target));
    }

    function setAttackCalldata(bytes memory _data) external {
        attackCalldata = _data;
    }

    function setForwardValueOnReenter(bool _forward) external {
        forwardValueOnReenter = _forward;
    }

    /// @notice True once `receive()` has fired and made its one re-entrancy attempt.
    function attempted() external view returns (bool) {
        return attackState >= 2;
    }

    /// @notice True iff a re-entrant call actually returned successfully — i.e. the
    ///         reentrancy defence FAILED. This is recorded rather than reverted on:
    ///         a `revert` here would unwind the whole `receive()` frame including
    ///         the successful re-entry's state changes, so a broken guard would
    ///         erase its own evidence and become indistinguishable from a
    ///         `receive()` that merely ran out of gas.
    function reentrySucceeded() external view returns (bool) {
        return attackState == 3;
    }

    receive() external payable {
        if (attacking && attackState == 1) {
            attackState = 2; // disarm first: one-shot, and cheap (dirty-slot store)
            (bool success,) =
                address(target).call{value: forwardValueOnReenter ? msg.value : 0}(attackCalldata);
            if (success) attackState = 3;
        }
    }

    function startAttack() external {
        attacking = true;
        attackState = 1;
    }

    // Allow the attacker to hold NFTs
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Malicious NFT that tries to re-enter the pool via onERC721Received callback
///      when the pool calls safeTransferFrom to send NFTs to a buyer.
contract MaliciousNFTReceiver is IERC721Receiver {
    TegridyNFTPool public target;
    bool public attacking;
    uint256 public attackCount;

    constructor(address _target) {
        target = TegridyNFTPool(payable(_target));
    }

    function startAttack() external {
        attacking = true;
        attackCount = 0;
    }

    /// @dev When receiving an NFT, try to re-enter the pool by buying another NFT
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (attacking && attackCount < 1) {
            attackCount++;
            // Try to re-enter swapETHForNFTs — should be blocked by nonReentrant
            uint256[] memory ids = new uint256[](1);
            ids[0] = 2; // try to buy token 2
            try target.swapETHForNFTs{value: 2 ether}(ids, type(uint256).max, block.timestamp + 1 hours) {
                revert("REENTRANCY_SUCCEEDED");
            } catch {
                // Expected: nonReentrant blocks this
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

// ─── Test Suite ────────────────────────────────────────────────────

contract TegridyNFTPool_ReentrancyTest is Test {
    TegridyNFTPoolFactory public factory;
    MockNFT_Reentry public nft;
    MockWETH_Reentry public weth;

    address public admin = makeAddr("admin");
    address public feeRecipient = makeAddr("feeRecipient");
    address public alice = makeAddr("alice"); // pool creator / LP
    address public bob = makeAddr("bob");     // normal buyer

    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1%
    uint256 public constant SPOT_PRICE = 1 ether;
    uint256 public constant DELTA = 0.1 ether;

    function setUp() public {
        weth = new MockWETH_Reentry();
        factory = new TegridyNFTPoolFactory(admin, PROTOCOL_FEE_BPS, feeRecipient, address(weth));
        nft = new MockNFT_Reentry();

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);

        // Mint 10 NFTs to alice
        for (uint256 i = 0; i < 10; i++) {
            nft.mint(alice);
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _createSellPool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256[] memory tokenIds
    ) internal returns (address pool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool(
            address(nft),
            TegridyNFTPool.PoolType.SELL,
            _spotPrice,
            _delta,
            0,
            tokenIds
        );
        vm.stopPrank();
    }

    function _createTradePool(
        uint256 _spotPrice,
        uint256 _delta,
        uint256 _feeBps,
        uint256[] memory tokenIds,
        uint256 ethAmount
    ) internal returns (address pool) {
        vm.startPrank(alice);
        nft.setApprovalForAll(address(factory), true);
        pool = factory.createPool{value: ethAmount}(
            address(nft),
            TegridyNFTPool.PoolType.TRADE,
            _spotPrice,
            _delta,
            _feeBps,
            tokenIds
        );
        vm.stopPrank();
    }

    function _tokenIdArray(uint256 start, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = start + i;
        }
    }

    function _singleId(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: swapETHForNFTs refund path is safe (10k gas stipend)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice When a buyer overpays and the refund goes to a contract that tries to
    ///         re-enter, the 10k gas stipend prevents the re-entrant call. The refund
    ///         falls back to WETH wrapping instead.
    function test_reentrancy_swapETHForNFTs_refundBlocked() public {
        // Create a SELL pool with 3 NFTs
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        // Deploy attacker
        ReentrantAttacker attacker = new ReentrantAttacker(pool);
        vm.deal(address(attacker), 100 ether);

        // Get buy quote for 1 NFT
        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 cost,) = p.getBuyQuote(1);

        // Attacker will try to re-enter swapETHForNFTs when receiving refund
        uint256[] memory buyIds = _singleId(1);
        uint256[] memory reenterIds = _singleId(2);
        attacker.setAttackCalldata(
            abi.encodeCall(TegridyNFTPool.swapETHForNFTs, (reenterIds, type(uint256).max, block.timestamp + 1 hours))
        );
        attacker.startAttack();

        // Send extra ETH to trigger refund path
        uint256 overpayment = 5 ether;
        uint256 balBefore = address(attacker).balance + weth.balanceOf(address(attacker));
        vm.prank(address(attacker));
        p.swapETHForNFTs{value: cost + overpayment}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // Attacker got the NFT they paid for
        assertEq(nft.ownerOf(1), address(attacker));

        // The refund target `swapETHForNFTs` IS payable, so this attacker keeps the
        // default value-forwarding and its inner call does reach `nonReentrant`.
        assertTrue(attacker.attempted(), "re-entrancy must actually have been attempted");
        assertFalse(attacker.reentrySucceeded(), "re-entrant swapETHForNFTs must not succeed");

        // Net debit is exactly the cost — the overpayment came back, whether as raw
        // ETH or via the WETH fallback. Deliberately asset-agnostic: which leg of
        // `WETHFallbackLib` delivers is a gas-margin outcome, not an invariant.
        uint256 balAfter = address(attacker).balance + weth.balanceOf(address(attacker));
        assertEq(balBefore - balAfter, cost, "Net debit should equal cost; overpayment refunded");

        // Pool still has the remaining NFTs — the inner buy never took a second one.
        assertEq(p.getHeldCount(), 2);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: swapNFTsForETH payout path is safe
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A seller whose `receive()` tries to re-enter the pool during its ETH
    ///         payout is paid exactly once and cannot execute the inner swap.
    ///
    /// @dev    ASSERT THE SECURITY PROPERTY, NOT THE DELIVERY ASSET. Whether the
    ///         payout lands as raw ETH or as wrapped WETH is decided by whether the
    ///         attacker's `receive()` happens to fit inside `WETHFallbackLib`'s gas
    ///         stipend — a margin, not an invariant. This test previously asserted
    ///         `address(attacker).balance > 0` ("payout should arrive as raw ETH"),
    ///         which measured 29,867 gas used against 32,300 available: a 7.5%
    ///         margin. Toolchain drift alone (forge 1.7.1 -> 1.8.0, zero contract
    ///         changes) moved codegen across that line and turned the test red.
    ///
    ///         The asset type is also scheduled to change on purpose: the
    ///         provenance audit (docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md
    ///         §3.2, remediation row 3) replaces this library with Solady
    ///         `SafeTransferLib`, whose `GAS_STIPEND_NO_GRIEF` is 100_000 and
    ///         which never swaps the asset type at all. Every assertion here is
    ///         written to survive that migration unchanged — and to become MORE
    ///         load-bearing after it, since a 100k stipend is the first budget
    ///         under which the inner call can reach `nonReentrant` with enough
    ///         gas to matter.
    ///
    ///         What is invariant, and what is asserted below:
    ///           1. the seller is paid exactly once, counting ETH + WETH together;
    ///           2. the re-entrant inner call does not execute — its NFT never
    ///              transfers and no second payout is made;
    ///           3. pool accounting is intact — exactly one NFT in, exactly one
    ///              payout out.
    function test_reentrancy_swapNFTsForETH_payoutBlocked() public {
        // Create a TRADE pool with some NFTs and ETH
        uint256[] memory poolIds = _tokenIdArray(1, 3);
        address pool = _createTradePool(SPOT_PRICE, DELTA, 500, poolIds, 50 ether);

        // Mint NFTs to the attacker (they need NFTs to sell)
        uint256 attackerNftId = nft.mint(address(this));
        nft.transferFrom(address(this), address(bob), attackerNftId);

        // Deploy attacker
        ReentrantAttacker attacker = new ReentrantAttacker(pool);

        // Give attacker an NFT to sell
        uint256 sellerNftId = nft.mint(address(attacker));

        // Approve pool to transfer attacker's NFT
        vm.prank(address(attacker));
        nft.setApprovalForAll(pool, true);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        // Set up re-entry attack on payout
        uint256[] memory sellIds = _singleId(sellerNftId);
        // Try to re-enter with another sell
        uint256 anotherNftId = nft.mint(address(attacker));
        uint256[] memory reenterIds = _singleId(anotherNftId);
        attacker.setAttackCalldata(
            abi.encodeCall(TegridyNFTPool.swapNFTsForETH, (reenterIds, 0, block.timestamp + 1 hours))
        );
        // `swapNFTsForETH` is not payable — forwarding value would be rejected by the
        // callvalue check before `nonReentrant` is reached, making this test vacuous.
        attacker.setForwardValueOnReenter(false);
        attacker.startAttack();

        // Quote the single sale up front: this is the ONE payout the seller is owed.
        (uint256 expectedPayout,) = p.getSellQuote(1);
        uint256 poolEthBefore = address(pool).balance;
        uint256 poolHeldBefore = p.getHeldCount();
        uint256 attackerValueBefore = address(attacker).balance + weth.balanceOf(address(attacker));

        vm.prank(address(attacker));
        p.swapNFTsForETH(sellIds, 0, block.timestamp + 1 hours);

        // 0. The attack was actually attempted. Without this the test could pass
        //    vacuously if `receive()` never fired — which is exactly how the
        //    previous version rotted (its inner call died at the callvalue check
        //    for 994 gas and never reached the guard it claimed to be testing).
        assertTrue(attacker.attempted(), "re-entrancy must actually have been attempted");

        // 1. Paid EXACTLY once. Asset-type agnostic: a WETH fallback moves the value
        //    from the ETH balance to the WETH balance, so the sum is the invariant.
        uint256 received =
            address(attacker).balance + weth.balanceOf(address(attacker)) - attackerValueBefore;
        assertEq(received, expectedPayout, "seller paid exactly once (ETH and/or WETH)");

        // 2. The re-entrant inner call did NOT execute.
        assertFalse(attacker.reentrySucceeded(), "re-entrant swapNFTsForETH must not succeed");
        assertEq(nft.ownerOf(anotherNftId), address(attacker), "second NFT never left the attacker");
        assertFalse(p.isTokenHeld(anotherNftId), "pool must not have taken a second NFT");

        // 3. Pool accounting intact: exactly one NFT in, exactly one payout out.
        assertTrue(p.isTokenHeld(sellerNftId), "pool holds the NFT it paid for");
        assertEq(p.getHeldCount(), poolHeldBefore + 1, "exactly one NFT entered the pool");
        assertEq(poolEthBefore - address(pool).balance, expectedPayout, "pool paid out exactly once");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: removeLiquidity ETH withdrawal is safe
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A CONTRACT pool owner that tries to re-enter `removeLiquidity` during
    ///         its own ETH withdrawal withdraws exactly once.
    ///
    /// @dev    REWRITTEN: this test used to concede in its own comments that it did
    ///         not test re-entrancy at all ("since alice (an EOA) is the pool owner,
    ///         the re-entry via receive() on the owner is moot"), and closed with
    ///         `address(attacker).call{value: 1 ether, gas: 10000}("")` asserting
    ///         that 10k gas is not enough for a re-entrant `receive()`. That
    ///         assertion tested the EVM's gas schedule rather than this pool, and
    ///         its 10_000 literal had already drifted from the library it claimed to
    ///         mirror — `WETHFallbackLib.ETH_TRANSFER_GAS_STIPEND` has been 30_000
    ///         since M-36 [F-40-WFL-1].
    ///
    ///         The gap it left is now closed properly: ownership is handed to the
    ///         attacking contract through the real 48h timelock, so the withdrawal
    ///         genuinely pays a hostile `receive()` and the guard is genuinely
    ///         exercised. Assertions are asset-agnostic for the same reason as the
    ///         payout test above.
    function test_reentrancy_removeLiquidity_blocked() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);
        TegridyNFTPool p = TegridyNFTPool(payable(pool));

        ReentrantAttacker attacker = new ReentrantAttacker(pool);
        vm.deal(address(attacker), 100 ether);
        vm.deal(pool, 10 ether);

        uint256[] memory emptyIds = new uint256[](0);

        // ─── Normal path: an EOA owner withdraws in plain ETH ───────────────
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        p.removeLiquidity(emptyIds, 5 ether);
        assertEq(alice.balance, aliceBalBefore + 5 ether, "EOA owner withdraws as ETH");
        assertEq(address(pool).balance, 5 ether);
        assertEq(weth.balanceOf(alice), 0, "EOA owner should not receive WETH");

        // ─── Hand the pool to the attacking contract via the real timelock ───
        vm.prank(alice);
        p.proposeOwnerChange(address(attacker));
        vm.warp(block.timestamp + p.OWNER_TIMELOCK() + 1);
        vm.prank(address(attacker));
        p.acceptOwnership();
        assertEq(p.owner(), address(attacker), "attacker is now the pool owner");

        // Re-fund so a successful double-withdraw would be plainly visible.
        vm.deal(pool, 10 ether);

        // `removeLiquidity` is not payable, so the re-entrant call must carry no
        // value or it dies at the callvalue check before reaching `nonReentrant`.
        attacker.setAttackCalldata(
            abi.encodeCall(TegridyNFTPool.removeLiquidity, (emptyIds, 3 ether))
        );
        attacker.setForwardValueOnReenter(false);
        attacker.startAttack();

        uint256 attackerValueBefore = address(attacker).balance + weth.balanceOf(address(attacker));

        vm.prank(address(attacker));
        p.removeLiquidity(emptyIds, 4 ether);

        // The attack was actually attempted — guards against this test silently
        // regressing into a no-op the way its predecessor did.
        assertTrue(attacker.attempted(), "re-entrancy must actually have been attempted");

        // Withdrew EXACTLY once, whichever asset carried it.
        uint256 received =
            address(attacker).balance + weth.balanceOf(address(attacker)) - attackerValueBefore;
        assertEq(received, 4 ether, "owner withdrew exactly once (ETH and/or WETH)");

        // The re-entrant inner withdrawal did not execute.
        assertFalse(attacker.reentrySucceeded(), "re-entrant removeLiquidity must not succeed");
        assertEq(address(pool).balance, 6 ether, "pool paid out exactly once");

        // Inventory untouched by the ETH-only withdrawal.
        assertEq(p.getHeldCount(), 3, "no NFTs left the pool");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Malicious NFT receiver cannot re-enter via onERC721Received
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A buyer whose onERC721Received callback tries to call swapETHForNFTs
    ///         again is blocked by the nonReentrant modifier.
    function test_reentrancy_onERC721Received_blocked() public {
        // Create a SELL pool with 3 NFTs
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        // Deploy malicious receiver
        MaliciousNFTReceiver malicious = new MaliciousNFTReceiver(pool);
        vm.deal(address(malicious), 100 ether);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 cost,) = p.getBuyQuote(1);

        malicious.startAttack();

        // Buy 1 NFT — the onERC721Received callback will try to re-enter
        // The nonReentrant guard will block the re-entry
        uint256[] memory buyIds = _singleId(1);
        vm.prank(address(malicious));
        p.swapETHForNFTs{value: cost}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // Buyer got their NFT
        assertEq(nft.ownerOf(1), address(malicious));

        // The attack counter shows 1 attempt was made but it was caught
        assertEq(malicious.attackCount(), 1, "Attack was attempted");

        // Pool still has 2 NFTs (only 1 was sold, not 2)
        assertEq(p.getHeldCount(), 2, "Only 1 NFT should have been sold");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST: Normal EOA operations still work fine
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Verify that normal EOA buys/sells work correctly (no false positives
    ///         from the gas stipend -- EOAs receive ETH fine with 10k gas).
    function test_normalEOA_swapETHForNFTs_refundWorks() public {
        uint256[] memory ids = _tokenIdArray(1, 3);
        address pool = _createSellPool(SPOT_PRICE, DELTA, ids);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        (uint256 cost,) = p.getBuyQuote(1);

        uint256 bobBalanceBefore = bob.balance;
        uint256 overpayment = 2 ether;

        uint256[] memory buyIds = _singleId(1);
        vm.prank(bob);
        p.swapETHForNFTs{value: cost + overpayment}(buyIds, type(uint256).max, block.timestamp + 1 hours);

        // Bob got his NFT
        assertEq(nft.ownerOf(1), bob);

        // Bob got his refund in ETH (not WETH, because EOAs can receive ETH)
        assertEq(bob.balance, bobBalanceBefore - cost, "EOA refund should be in ETH");
        assertEq(weth.balanceOf(bob), 0, "EOA should not receive WETH");
    }

    /// @notice Verify normal EOA sells receive ETH payout correctly.
    function test_normalEOA_swapNFTsForETH_payoutWorks() public {
        // Create a TRADE pool with NFTs and ETH
        uint256[] memory poolIds = _tokenIdArray(1, 5);
        address pool = _createTradePool(SPOT_PRICE, DELTA, 500, poolIds, 50 ether);

        // Mint an NFT to bob
        uint256 bobNftId = nft.mint(bob);

        vm.startPrank(bob);
        nft.approve(pool, bobNftId);

        TegridyNFTPool p = TegridyNFTPool(payable(pool));
        uint256 bobBalanceBefore = bob.balance;

        uint256[] memory sellIds = _singleId(bobNftId);
        p.swapNFTsForETH(sellIds, 0, block.timestamp + 1 hours);
        vm.stopPrank();

        // Bob received ETH (not WETH)
        assertTrue(bob.balance > bobBalanceBefore, "EOA should receive ETH payout");
        assertEq(weth.balanceOf(bob), 0, "EOA should not receive WETH");
    }
}
