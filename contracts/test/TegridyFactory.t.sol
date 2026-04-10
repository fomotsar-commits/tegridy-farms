// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyPair.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockERC20Factory is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract TegridyFactoryTest is Test {
    TegridyFactory public factory;
    MockERC20Factory public tokenA;
    MockERC20Factory public tokenB;
    address public admin = makeAddr("admin");
    address public newSetter = makeAddr("newSetter");
    address public random = makeAddr("random");

    function setUp() public {
        factory = new TegridyFactory(admin, admin);
        tokenA = new MockERC20Factory("Token A", "TKA");
        tokenB = new MockERC20Factory("Token B", "TKB");
    }

    // ===== 2-STEP feeToSetter TRANSFER (AUDIT FIX #34) =====

    function test_proposeFeeToSetter() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);
        assertEq(factory.pendingFeeToSetter(), newSetter);
    }

    function test_acceptFeeToSetter() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        // AUDIT FIX: Must wait 48h timelock before accepting
        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        assertEq(factory.feeToSetter(), newSetter);
        assertEq(factory.pendingFeeToSetter(), address(0));
    }

    function test_revert_proposeFeeToSetter_notCurrentSetter() public {
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposeFeeToSetter(newSetter);
    }

    function test_revert_proposeFeeToSetter_zeroAddress() public {
        vm.prank(admin);
        vm.expectRevert("ZERO_ADDRESS");
        factory.proposeFeeToSetter(address(0));
    }

    /// @notice ONLY pending setter can accept
    function test_revert_acceptFeeToSetter_notPending() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        // Random cannot accept
        vm.prank(random);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }

    function test_revert_acceptFeeToSetter_noPending() public {
        // No one proposed
        vm.prank(random);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }

    /// @notice After 2-step transfer, new setter can propose + execute feeTo change
    function test_newSetter_canSetFeeTo() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        address newFeeTo = makeAddr("newFeeTo");
        vm.prank(newSetter);
        factory.proposeFeeToChange(newFeeTo);

        // Advance past feeTo change timelock (another 48h from current time)
        vm.warp(block.timestamp + 49 hours);

        vm.prank(newSetter);
        factory.executeFeeToChange();
        assertEq(factory.feeTo(), newFeeTo);
    }

    /// @notice Old setter cannot propose feeTo change after transfer
    function test_revert_oldSetter_cannotSetFeeTo() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        vm.prank(admin);
        vm.expectRevert("FORBIDDEN");
        factory.proposeFeeToChange(makeAddr("x"));
    }

    /// @notice Deprecated setFeeTo reverts
    function test_revert_setFeeTo_deprecated() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToChange()");
        factory.setFeeTo(makeAddr("x"));
    }

    /// @notice Deprecated setFeeToSetter reverts
    function test_revert_setFeeToSetter_deprecated() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToSetter()");
        factory.setFeeToSetter(newSetter);
    }

    // ===== CREATE PAIR =====

    function test_createPair() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertGt(pair.code.length, 0);
        assertEq(factory.allPairsLength(), 1);
    }

    function test_revert_createPair_duplicate() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert("PAIR_EXISTS");
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_revert_createPair_identicalAddresses() public {
        vm.expectRevert("IDENTICAL_ADDRESSES");
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_getPair_bidirectional() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair);
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair);
    }

    // ===== M-12: TOKEN BLOCKLIST =====

    function test_setTokenBlocked() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();
        assertTrue(factory.blockedTokens(address(tokenA)));
    }

    function test_revert_createPair_blockedToken() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        vm.expectRevert("TOKEN_BLOCKED");
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_unblockToken_allowsCreatePair() public {
        // Block tokenA
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        uint256 t1 = block.timestamp + 24 hours + 1;
        vm.warp(t1);
        factory.executeTokenBlocked(address(tokenA));

        // Unblock tokenA
        factory.proposeTokenBlocked(address(tokenA), false);
        uint256 t2 = t1 + 24 hours + 1;
        vm.warp(t2);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertGt(pair.code.length, 0);
    }

    function test_revert_proposeTokenBlocked_notSetter() public {
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposeTokenBlocked(address(tokenA), true);
    }

    // ===== M-12: GRANULARITY CHECK =====

    function test_revert_createPair_erc777WithGranularity() public {
        MockERC777WithGranularity erc777 = new MockERC777WithGranularity();
        vm.expectRevert("ERC777_NOT_SUPPORTED");
        factory.createPair(address(erc777), address(tokenB));
    }

    // ===== M-13: DISABLED PAIRS =====

    function test_proposePairDisabled() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);
        assertEq(factory.pendingPairDisableTime(pair), block.timestamp + 48 hours);
        assertTrue(factory.pendingPairDisableValue(pair));
    }

    function test_executePairDisabled() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertTrue(factory.disabledPairs(pair));
    }

    function test_reEnablePair() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        // Disable
        vm.prank(admin);
        factory.proposePairDisabled(pair, true);
        vm.warp(48 hours + 1);
        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertTrue(factory.disabledPairs(pair));

        // Re-enable
        vm.prank(admin);
        factory.proposePairDisabled(pair, false);
        vm.warp(96 hours + 2);
        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertFalse(factory.disabledPairs(pair));
    }

    function test_revert_executePairDisabled_timelockNotElapsed() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        // Try before timelock
        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pairKey));
        factory.executePairDisabled(pair);
    }

    function test_revert_executePairDisabled_noPending() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pairKey));
        factory.executePairDisabled(pair);
    }

    function test_revert_proposePairDisabled_notSetter() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(random);
        vm.expectRevert("FORBIDDEN");
        factory.proposePairDisabled(pair, true);
    }

    receive() external payable {}
}

contract MockERC777WithGranularity is ERC20 {
    constructor() ERC20("ERC777Mock", "E777") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function granularity() external pure returns (uint256) {
        return 1;
    }
}
