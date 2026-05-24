// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// AUDIT FIX 2026-05-22 M19-PORT-INLINE: regression tests for the `acceptOwnership` override
// port to the 3 contracts whose admin-replacement / TWAP-snapshot-reset / sweep-ETH timelocks
// are INLINE (predate TimelockAdmin and don't use `_executeAfter`):
//   - TegridyLending: pendingLendingAdmin / lendingAdminReplacementReadyAt
//   - TegridyStaking: pendingStakingAdmin / adminReplacementReadyAt
//   - SwapFeeRouter:  pendingSwapFeeRouterAdmin / adminReplacementReadyAt
//                   + pendingResetToken / twapSnapshotResetReadyAt
//                   + pendingSweepETHAmount / sweepETHReadyAt
//
// VoteIncentives is intentionally NOT covered: its `setVoteIncentivesAdmin` is a one-shot
// setter with no rotation timelock (booby-trap surface doesn't exist).
//
// For each contract: deploy → wire admin (one-shot setter, real contract) → old owner proposes
// a hostile value → transferOwnership(newOwner) → newOwner acceptOwnership → assert readyAt == 0
// → assert re-propose works.

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {TegridyLending} from "../src/TegridyLending.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";

// ─── Shared mocks ───────────────────────────────────────────────────────────

contract MockTokenInline is ERC20 {
    constructor() ERC20("MockToken", "MOCK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockNFTInline is ERC721 {
    constructor() ERC721("MockNFT", "MNFT") {}
}

contract MockWETHInline is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WETH_WITHDRAW_FAIL");
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// @dev A "contract" that satisfies the `code.length > 0 && code.length != 23`
///      check imposed by `setXxxAdmin` / `proposeXxxAdminReplacement` (rejects
///      EOAs + EIP-7702 delegated EOAs). Any non-empty bytecode works; the
///      contract itself doesn't need to implement any specific interface for
///      these accept-ownership flush tests.
contract DummyAdminContract {}

/// @dev Minimal TegridyPair-shaped mock for TegridyLending construction. The
///      constructor reads `token0()` / `token1()` to figure out which side is
///      TOWELI vs WETH; nothing else is exercised by these regression tests.
contract MockPairInline {
    address public token0;
    address public token1;
    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }
}

/// @dev Minimal UniswapV2Router02-shaped mock for SwapFeeRouter construction.
///      The constructor reads `WETH()` and `factory()`; nothing else is
///      exercised by these regression tests.
contract MockUniRouterInline {
    address public immutable WETHAddr;
    address public immutable factoryAddr;
    constructor(address _weth, address _factory) {
        WETHAddr = _weth;
        factoryAddr = _factory;
    }
    function WETH() external view returns (address) { return WETHAddr; }
    function factory() external view returns (address) { return factoryAddr; }
}

// ─── TegridyLending: lendingAdmin rotation ──────────────────────────────────

contract M19PortInline_TegridyLending_Test is Test {
    TegridyLending lending;
    MockWETHInline weth;
    DummyAdminContract admin1;
    DummyAdminContract admin2;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        weth = new MockWETHInline();
        // Pair: WETH + a fake TOWELI side. Constructor only reads token0/token1.
        address fakeToweli = address(new MockTokenInline());
        MockPairInline pair = new MockPairInline(address(weth), fakeToweli);
        // twap: just needs to be a non-zero contract address (no methods called at construction).
        address twap = address(new MockPairInline(address(0), address(0)));
        vm.chainId(1); // mainnet → sequencerFeed may be zero
        vm.prank(creator);
        lending = new TegridyLending(makeAddr("treasury"), 500, address(weth), address(pair), twap, address(0));
        admin1 = new DummyAdminContract();
        admin2 = new DummyAdminContract();
        // One-shot wire of an initial admin so the rotation flow has a starting point.
        vm.prank(creator);
        lending.setLendingAdmin(address(admin1));
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesLendingAdminReplacement() public {
        vm.prank(creator);
        lending.proposeLendingAdminReplacement(address(admin2));
        assertGt(lending.lendingAdminReplacementReadyAt(), 0, "proposal should be live");
        assertEq(lending.pendingLendingAdmin(), address(admin2), "pending slot armed");

        vm.prank(creator);
        lending.transferOwnership(newOwner);
        vm.prank(newOwner);
        lending.acceptOwnership();

        // Flushed.
        assertEq(lending.lendingAdminReplacementReadyAt(), 0, "readyAt cleared on accept");
        assertEq(lending.pendingLendingAdmin(), address(0), "pending slot cleared");

        // Re-propose works: new owner can queue their own admin rotation immediately.
        DummyAdminContract admin3 = new DummyAdminContract();
        vm.prank(newOwner);
        lending.proposeLendingAdminReplacement(address(admin3));
        assertGt(lending.lendingAdminReplacementReadyAt(), 0, "re-propose succeeds");
        assertEq(lending.pendingLendingAdmin(), address(admin3));
    }
}

// ─── TegridyStaking: stakingAdmin rotation ─────────────────────────────────

contract M19PortInline_TegridyStaking_Test is Test {
    TegridyStaking staking;
    MockTokenInline token;
    MockNFTInline nft;
    DummyAdminContract admin1;
    DummyAdminContract admin2;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        token = new MockTokenInline();
        nft = new MockNFTInline();
        vm.prank(creator);
        staking = new TegridyStaking(address(token), address(nft), makeAddr("treasury"), 1 ether);
        admin1 = new DummyAdminContract();
        admin2 = new DummyAdminContract();
        vm.prank(creator);
        staking.setStakingAdmin(address(admin1));
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesStakingAdminReplacement() public {
        vm.prank(creator);
        staking.proposeAdminReplacement(address(admin2));
        assertGt(staking.adminReplacementReadyAt(), 0, "proposal should be live");
        assertEq(staking.pendingStakingAdmin(), address(admin2), "pending slot armed");

        vm.prank(creator);
        staking.transferOwnership(newOwner);
        vm.prank(newOwner);
        staking.acceptOwnership();

        assertEq(staking.adminReplacementReadyAt(), 0, "readyAt cleared on accept");
        assertEq(staking.pendingStakingAdmin(), address(0), "pending slot cleared");

        DummyAdminContract admin3 = new DummyAdminContract();
        vm.prank(newOwner);
        staking.proposeAdminReplacement(address(admin3));
        assertGt(staking.adminReplacementReadyAt(), 0, "re-propose succeeds");
        assertEq(staking.pendingStakingAdmin(), address(admin3));
    }
}

// ─── SwapFeeRouter: 3 inline timelocks ─────────────────────────────────────

contract M19PortInline_SwapFeeRouter_Test is Test {
    SwapFeeRouter router;
    DummyAdminContract admin1;
    DummyAdminContract admin2;
    address creator = makeAddr("creator");
    address newOwner = makeAddr("newOwner");

    function setUp() public {
        MockWETHInline weth = new MockWETHInline();
        address factoryAddr = makeAddr("uniFactory");
        // Etch some bytecode so the constructor's `factory != address(0)` check passes
        // — `factory()` itself isn't called again post-construction in these tests.
        vm.etch(factoryAddr, hex"6001"); // any non-empty bytecode
        MockUniRouterInline uniRouter = new MockUniRouterInline(address(weth), factoryAddr);
        vm.prank(creator);
        router = new SwapFeeRouter(address(uniRouter), makeAddr("treasury"), 30, address(0));
        admin1 = new DummyAdminContract();
        admin2 = new DummyAdminContract();
        vm.prank(creator);
        router.setSwapFeeRouterAdmin(address(admin1));
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesAdminReplacement() public {
        vm.prank(creator);
        router.proposeAdminReplacement(address(admin2));
        assertGt(router.adminReplacementReadyAt(), 0);
        assertEq(router.pendingSwapFeeRouterAdmin(), address(admin2));

        vm.prank(creator);
        router.transferOwnership(newOwner);
        vm.prank(newOwner);
        router.acceptOwnership();

        assertEq(router.adminReplacementReadyAt(), 0, "admin readyAt cleared");
        assertEq(router.pendingSwapFeeRouterAdmin(), address(0), "admin pending cleared");

        DummyAdminContract admin3 = new DummyAdminContract();
        vm.prank(newOwner);
        router.proposeAdminReplacement(address(admin3));
        assertGt(router.adminReplacementReadyAt(), 0, "admin re-propose succeeds");
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesTWAPSnapshotReset() public {
        address hostileToken = makeAddr("hostileToken");
        vm.prank(creator);
        router.proposeResetTWAPSnapshot(hostileToken);
        assertGt(router.twapSnapshotResetReadyAt(), 0);
        assertEq(router.pendingResetToken(), hostileToken);

        vm.prank(creator);
        router.transferOwnership(newOwner);
        vm.prank(newOwner);
        router.acceptOwnership();

        assertEq(router.twapSnapshotResetReadyAt(), 0, "TWAP readyAt cleared");
        assertEq(router.pendingResetToken(), address(0), "TWAP pending cleared");

        vm.prank(newOwner);
        router.proposeResetTWAPSnapshot(makeAddr("safeToken"));
        assertGt(router.twapSnapshotResetReadyAt(), 0, "TWAP re-propose succeeds");
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesSweepETH() public {
        vm.prank(creator);
        router.proposeSweepETH(5 ether);
        assertGt(router.sweepETHReadyAt(), 0);
        assertEq(router.pendingSweepETHAmount(), 5 ether);

        vm.prank(creator);
        router.transferOwnership(newOwner);
        vm.prank(newOwner);
        router.acceptOwnership();

        assertEq(router.sweepETHReadyAt(), 0, "sweep readyAt cleared");
        assertEq(router.pendingSweepETHAmount(), 0, "sweep pending cleared");

        vm.prank(newOwner);
        router.proposeSweepETH(1 ether);
        assertGt(router.sweepETHReadyAt(), 0, "sweep re-propose succeeds");
    }

    function test_M19PORT_INLINE_acceptOwnership_flushesAllThreeAtOnce() public {
        // Outgoing owner queues ALL THREE hostile proposals before handing off.
        vm.prank(creator);
        router.proposeAdminReplacement(address(admin2));
        vm.prank(creator);
        router.proposeResetTWAPSnapshot(makeAddr("hostileToken"));
        vm.prank(creator);
        router.proposeSweepETH(10 ether);

        vm.prank(creator);
        router.transferOwnership(newOwner);
        vm.prank(newOwner);
        router.acceptOwnership();

        assertEq(router.adminReplacementReadyAt(), 0);
        assertEq(router.pendingSwapFeeRouterAdmin(), address(0));
        assertEq(router.twapSnapshotResetReadyAt(), 0);
        assertEq(router.pendingResetToken(), address(0));
        assertEq(router.sweepETHReadyAt(), 0);
        assertEq(router.pendingSweepETHAmount(), 0);
    }
}
