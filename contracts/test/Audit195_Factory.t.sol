// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyPair.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ======================== MOCK CONTRACTS ========================

contract MockToken195 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev ERC-777 that hides from ERC-165 check and granularity check
contract StealthERC777 is ERC20 {
    constructor() ERC20("Stealth777", "S777") {
        _mint(msg.sender, 1_000_000 ether);
    }
    // No granularity(), no ERC-165 supportsInterface => bypasses _rejectERC777
}

/// @dev Token that returns true for ERC-165 ERC-777 interface
contract FlaggedERC777 is ERC20 {
    constructor() ERC20("Flagged777", "F777") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xe58e113c; // ERC-777 interface ID
    }
}

/// @dev Token with granularity() function (ERC-777 marker)
contract GranularityToken is ERC20 {
    constructor() ERC20("Gran777", "G777") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function granularity() external pure returns (uint256) {
        return 1;
    }
}

/// @dev Token whose supportsInterface reverts
contract RevertingERC165Token is ERC20 {
    constructor() ERC20("Reverting", "REV") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function supportsInterface(bytes4) external pure returns (bool) {
        revert("no ERC165");
    }
}

/// @dev Token that returns true for ALL ERC-165 queries
contract OverlyCompliantToken is ERC20 {
    constructor() ERC20("Compliant", "CMP") {
        _mint(msg.sender, 1_000_000 ether);
    }
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

// ======================== AUDIT TEST CONTRACT ========================

contract Audit195Factory is Test {
    TegridyFactory public factory;
    MockToken195 public tokenA;
    MockToken195 public tokenB;
    MockToken195 public tokenC;

    address public admin = makeAddr("admin");
    address public treasury = makeAddr("treasury");
    address public attacker = makeAddr("attacker");
    address public newSetter = makeAddr("newSetter");
    address public newTreasury = makeAddr("newTreasury");

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);
    event FeeToUpdated(address indexed oldFeeTo, address indexed newFeeTo);
    event TokenBlocked(address indexed token, bool blocked);
    event PairDisableProposed(address indexed pair, bool disabled, uint256 executeAfter);
    event PairDisableExecuted(address indexed pair, bool disabled);
    event FeeToChangeProposed(address indexed current, address indexed proposed, uint256 executeAfter);
    event FeeToChangeCancelled(address indexed cancelled);
    event FeeToSetterProposed(address indexed current, address indexed proposed, uint256 executeAfter);
    event FeeToSetterAccepted(address indexed oldSetter, address indexed newSetter);
    event FeeToSetterProposalCancelled(address indexed cancelledSetter);
    event FactoryInitialized(address indexed feeToSetter, address indexed feeTo);

    function setUp() public {
        factory = new TegridyFactory(admin, treasury);
        tokenA = new MockToken195("Token A", "TKA");
        tokenB = new MockToken195("Token B", "TKB");
        tokenC = new MockToken195("Token C", "TKC");
    }

    // ============================================================
    // F-01: Constructor zero-address checks [Informational]
    // ============================================================

    function test_F01_constructor_rejects_zero_setter() public {
        vm.expectRevert("ZERO_SETTER");
        new TegridyFactory(address(0), treasury);
    }

    function test_F01_constructor_rejects_zero_feeTo() public {
        vm.expectRevert("ZERO_FEE_TO");
        new TegridyFactory(admin, address(0));
    }

    function test_F01_constructor_emits_event() public {
        vm.expectEmit(true, true, false, false);
        emit FactoryInitialized(admin, treasury);
        new TegridyFactory(admin, treasury);
    }

    // ============================================================
    // F-02: CREATE2 salt correctness & pair address prediction [Low]
    // Salt = keccak256(abi.encodePacked(token0, token1)) is
    // deterministic but NO INIT_CODE_PAIR_HASH is exposed publicly.
    // Off-chain callers cannot predict pair addresses without the
    // full TegridyPair bytecode, unlike Uniswap V2.
    // ============================================================

    function test_F02_create2_salt_deterministic() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        address pair = factory.createPair(address(tokenA), address(tokenB));

        bytes32 salt = keccak256(abi.encodePacked(t0, t1));
        bytes32 initCodeHash = keccak256(type(TegridyPair).creationCode);
        address predicted = address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(factory),
            salt,
            initCodeHash
        )))));

        assertEq(pair, predicted, "CREATE2 address mismatch");
    }

    function test_F02_reversed_tokens_same_pair() public {
        address pair1 = factory.createPair(address(tokenA), address(tokenB));

        vm.expectRevert("PAIR_EXISTS");
        factory.createPair(address(tokenB), address(tokenA));

        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair1);
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair1);
    }

    // ============================================================
    // F-03: Missing INIT_CODE_PAIR_HASH constant [Low]
    // No public constant for off-chain pair address prediction.
    // ============================================================

    function test_F03_no_init_code_hash_exposed() public pure {
        bytes32 h = keccak256(type(TegridyPair).creationCode);
        assertTrue(h != bytes32(0));
    }

    // ============================================================
    // F-04: Zero address & identical address checks [Informational]
    // ============================================================

    function test_F04_rejects_identical() public {
        vm.expectRevert("IDENTICAL_ADDRESSES");
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_F04_rejects_zero_address_left() public {
        vm.expectRevert("ZERO_ADDRESS");
        factory.createPair(address(0), address(tokenA));
    }

    function test_F04_rejects_zero_address_right() public {
        vm.expectRevert("ZERO_ADDRESS");
        factory.createPair(address(tokenA), address(0));
    }

    function test_F04_rejects_both_zero() public {
        vm.expectRevert("IDENTICAL_ADDRESSES");
        factory.createPair(address(0), address(0));
    }

    // ============================================================
    // F-05: EOA (non-contract) token rejection [Informational]
    // ============================================================

    function test_F05_rejects_eoa_token() public {
        address eoa = makeAddr("eoaToken");
        vm.expectRevert("NOT_CONTRACT");
        factory.createPair(eoa, address(tokenB));
    }

    // ============================================================
    // F-06: ERC-777 detection bypass [Medium]
    // _rejectERC777 is best-effort. A malicious token that hides
    // ERC-777 behavior (no ERC-165, no granularity(), no ERC-1820
    // registration) will pass all checks.
    // ============================================================

    function test_F06_erc777_detected_via_erc165() public {
        FlaggedERC777 flagged = new FlaggedERC777();
        vm.expectRevert("ERC777_NOT_SUPPORTED");
        factory.createPair(address(flagged), address(tokenB));
    }

    function test_F06_erc777_detected_via_granularity() public {
        GranularityToken gran = new GranularityToken();
        vm.expectRevert("ERC777_NOT_SUPPORTED");
        factory.createPair(address(gran), address(tokenB));
    }

    function test_F06_stealth_erc777_bypasses_detection() public {
        // POC: A stealth ERC-777 token bypasses all three checks
        // because ERC-1820 is not deployed on the test chain
        StealthERC777 stealth = new StealthERC777();
        address pair = factory.createPair(address(stealth), address(tokenB));
        assertTrue(pair != address(0), "Stealth ERC-777 bypassed detection");
    }

    function test_F06_reverting_erc165_passes() public {
        RevertingERC165Token rev = new RevertingERC165Token();
        address pair = factory.createPair(address(rev), address(tokenB));
        assertTrue(pair != address(0));
    }

    function test_F06_overly_compliant_blocked() public {
        OverlyCompliantToken ovc = new OverlyCompliantToken();
        vm.expectRevert("ERC777_NOT_SUPPORTED");
        factory.createPair(address(ovc), address(tokenB));
    }

    // ============================================================
    // F-07: Token blocklist only prevents NEW pairs [Low]
    // Blocking a token after pair creation does NOT disable the pair.
    // Also: setTokenBlocked has no zero-address check.
    // ============================================================

    function test_F07_blocklist_does_not_affect_existing_pairs() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        // Existing pair is NOT disabled
        assertFalse(factory.disabledPairs(pair));

        // New pairs with tokenA are blocked
        vm.expectRevert("TOKEN_BLOCKED");
        factory.createPair(address(tokenA), address(tokenC));
    }

    function test_F07_setTokenBlocked_no_zero_check() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(0), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(0));
        vm.stopPrank();
        assertTrue(factory.blockedTokens(address(0)));
    }

    function test_F07_setTokenBlocked_emits_event() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectEmit(true, false, false, true);
        emit TokenBlocked(address(tokenA), true);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();
    }

    function test_F07_proposeTokenBlocked_access_control() public {
        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.proposeTokenBlocked(address(tokenA), true);
    }

    // ============================================================
    // F-08: Pair disable timelock has expiration [Informational]
    // executePairDisabled uses MAX_PROPOSAL_VALIDITY (7 days).
    // Confirmed: stale proposals expire correctly.
    // ============================================================

    function test_F08_pair_disable_has_expiration() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        // Wait past 48h delay + 7 day validity
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        bytes32 pairKey08 = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, pairKey08));
        factory.executePairDisabled(pair);
    }

    function test_F08_pair_disable_timelock_enforced() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        bytes32 pairKey08b = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, pairKey08b));
        factory.executePairDisabled(pair);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        factory.executePairDisabled(pair);
        assertTrue(factory.disabledPairs(pair));
    }

    // ============================================================
    // F-09: proposePairDisabled has CANCEL_EXISTING_FIRST [Informational]
    // Correctly requires cancelling before re-proposing, consistent
    // with proposeFeeToChange pattern.
    // ============================================================

    function test_F09_pair_disable_no_overwrite() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.startPrank(admin);
        factory.proposePairDisabled(pair, true);

        // Cannot overwrite without cancelling
        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, pairKey));
        factory.proposePairDisabled(pair, false);
        vm.stopPrank();
    }

    // ============================================================
    // F-10: cancelPairDisabled exists and works [Informational]
    // cancelPairDisabled clears both time and value.
    // ============================================================

    function test_F10_cancelPairDisabled() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.prank(admin);
        factory.cancelPairDisabled(pair);

        assertEq(factory.pendingPairDisableTime(pair), 0);
        assertFalse(factory.pendingPairDisableValue(pair));
    }

    function test_F10_cancelPairDisabled_access_control() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.cancelPairDisabled(pair);
    }

    function test_F10_cancelPairDisabled_no_pending() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        bytes32 pairKey = keccak256(abi.encodePacked(factory.PAIR_DISABLE_CHANGE(), pair));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, pairKey));
        factory.cancelPairDisabled(pair);
    }

    // ============================================================
    // F-11: executePairDisabled does not clear pendingPairDisableValue [Informational]
    // After execution, pendingPairDisableValue retains its stale value.
    // Not exploitable since pendingPairDisableTime is cleared.
    // ============================================================

    function test_F11_stale_pending_value_after_execution() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        factory.executePairDisabled(pair);

        assertEq(factory.pendingPairDisableTime(pair), 0);
        // Value IS now cleared after execution (TimelockAdmin refactor cleans up)
        assertFalse(factory.pendingPairDisableValue(pair));
    }

    // ============================================================
    // F-12: proposeFeeToChange lifecycle [Informational]
    // ============================================================

    function test_F12_proposeFeeToChange_full_lifecycle() public {
        vm.startPrank(admin);
        factory.proposeFeeToChange(newTreasury);

        assertEq(factory.pendingFeeTo(), newTreasury);
        assertEq(factory.feeToChangeTime(), block.timestamp + 48 hours);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, factory.FEE_TO_CHANGE()));
        factory.proposeFeeToChange(makeAddr("other"));

        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();
        assertEq(factory.feeTo(), newTreasury);
        vm.stopPrank();
    }

    function test_F12_proposeFeeToChange_emits_event() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit FeeToChangeProposed(treasury, newTreasury, block.timestamp + 48 hours);
        factory.proposeFeeToChange(newTreasury);
    }

    function test_F12_proposeFeeToChange_access_control() public {
        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.proposeFeeToChange(newTreasury);
    }

    function test_F12_proposeFeeToChange_rejects_zero() public {
        vm.prank(admin);
        vm.expectRevert("ZERO_ADDRESS");
        factory.proposeFeeToChange(address(0));
    }

    // ============================================================
    // F-13: executeFeeToChange expiration [Informational]
    // ============================================================

    function test_F13_executeFeeToChange_expired() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        bytes32 feeToKey = factory.FEE_TO_CHANGE();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, feeToKey));
        factory.executeFeeToChange();
    }

    function test_F13_executeFeeToChange_at_boundary() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.warp(block.timestamp + 48 hours + 7 days);
        vm.prank(admin);
        factory.executeFeeToChange();
        assertEq(factory.feeTo(), newTreasury);
    }

    function test_F13_executeFeeToChange_clears_state() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        factory.executeFeeToChange();

        assertEq(factory.pendingFeeTo(), address(0));
        assertEq(factory.feeToChangeTime(), 0);
    }

    function test_F13_executeFeeToChange_emits_event() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit FeeToUpdated(treasury, newTreasury);
        factory.executeFeeToChange();
    }

    // ============================================================
    // F-14: cancelFeeToChange [Informational]
    // ============================================================

    function test_F14_cancelFeeToChange() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit FeeToChangeCancelled(newTreasury);
        factory.cancelFeeToChange();

        assertEq(factory.pendingFeeTo(), address(0));
        assertEq(factory.feeToChangeTime(), 0);
    }

    function test_F14_cancelFeeToChange_no_pending() public {
        bytes32 feeToKey = factory.FEE_TO_CHANGE();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, feeToKey));
        factory.cancelFeeToChange();
    }

    function test_F14_cancelFeeToChange_access_control() public {
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.cancelFeeToChange();
    }

    // ============================================================
    // F-15: proposeFeeToSetter 2-step transfer [Informational]
    // ============================================================

    function test_F15_proposeFeeToSetter_lifecycle() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        assertEq(factory.pendingFeeToSetter(), newSetter);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        assertEq(factory.feeToSetter(), newSetter);
        assertEq(factory.pendingFeeToSetter(), address(0));
        assertEq(factory.feeToSetterChangeTime(), 0);
    }

    function test_F15_proposeFeeToSetter_rejects_same() public {
        vm.prank(admin);
        vm.expectRevert("SAME_SETTER");
        factory.proposeFeeToSetter(admin);
    }

    function test_F15_proposeFeeToSetter_rejects_zero() public {
        vm.prank(admin);
        vm.expectRevert("ZERO_ADDRESS");
        factory.proposeFeeToSetter(address(0));
    }

    function test_F15_proposeFeeToSetter_no_overwrite() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.prank(admin);
        vm.expectRevert("CANCEL_EXISTING_FIRST");
        factory.proposeFeeToSetter(makeAddr("other"));
    }

    function test_F15_proposeFeeToSetter_emits_event() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit FeeToSetterProposed(admin, newSetter, block.timestamp + 48 hours);
        factory.proposeFeeToSetter(newSetter);
    }

    // ============================================================
    // F-16: acceptFeeToSetter expiration & access [Informational]
    // ============================================================

    function test_F16_acceptFeeToSetter_expired() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.prank(newSetter);
        vm.expectRevert("PROPOSAL_EXPIRED");
        factory.acceptFeeToSetter();
    }

    function test_F16_acceptFeeToSetter_before_timelock() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.prank(newSetter);
        vm.expectRevert("TIMELOCK_NOT_ELAPSED");
        factory.acceptFeeToSetter();
    }

    function test_F16_acceptFeeToSetter_wrong_caller() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(attacker);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }

    function test_F16_acceptFeeToSetter_emits_event() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(newSetter);
        vm.expectEmit(true, true, false, false);
        emit FeeToSetterAccepted(admin, newSetter);
        factory.acceptFeeToSetter();
    }

    // ============================================================
    // F-17: cancelFeeToSetterProposal [Informational]
    // (Note: user listed "cancelFeeToSetterTransfer" but actual
    //  function is cancelFeeToSetterProposal)
    // ============================================================

    function test_F17_cancelFeeToSetterProposal() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit FeeToSetterProposalCancelled(newSetter);
        factory.cancelFeeToSetterProposal();

        assertEq(factory.pendingFeeToSetter(), address(0));
        assertEq(factory.feeToSetterChangeTime(), 0);
    }

    function test_F17_cancelFeeToSetterProposal_no_pending() public {
        vm.prank(admin);
        vm.expectRevert("NO_PENDING_PROPOSAL");
        factory.cancelFeeToSetterProposal();
    }

    function test_F17_cancelFeeToSetterProposal_access_control() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.cancelFeeToSetterProposal();
    }

    // ============================================================
    // F-18: createPair event emission [Informational]
    // ============================================================

    function test_F18_createPair_emits_event() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        // Check indexed params. We cannot predict exact pair address.
        vm.expectEmit(true, true, false, false);
        emit PairCreated(t0, t1, address(0), 0);
        factory.createPair(address(tokenA), address(tokenB));
    }

    // ============================================================
    // F-19: Anyone can createPair (no access control) [Informational]
    // By design (Uniswap V2 pattern). Combined with F-06, attacker
    // can create pair with stealth ERC-777 and lure users.
    // ============================================================

    function test_F19_anyone_can_create_pair() public {
        vm.prank(attacker);
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertTrue(pair != address(0));
    }

    // ============================================================
    // F-20: proposePairDisabled accepts arbitrary addresses [Low]
    // No check that the pair was actually created by this factory.
    // ============================================================

    function test_F20_proposePairDisabled_arbitrary_address() public {
        address fakeAddr = makeAddr("fakeNotAPair");
        vm.prank(admin);
        factory.proposePairDisabled(fakeAddr, true);
        assertEq(factory.pendingPairDisableTime(fakeAddr), block.timestamp + 48 hours);
    }

    function test_F20_proposePairDisabled_rejects_zero() public {
        vm.prank(admin);
        vm.expectRevert("ZERO_ADDRESS");
        factory.proposePairDisabled(address(0), true);
    }

    function test_F20_proposePairDisabled_access_control() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.proposePairDisabled(pair, true);
    }

    // ============================================================
    // F-21: executePairDisabled access control & events [Informational]
    // ============================================================

    function test_F21_executePairDisabled_access_control() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        factory.proposePairDisabled(pair, true);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(attacker);
        vm.expectRevert("FORBIDDEN");
        factory.executePairDisabled(pair);
    }

    function test_F21_executePairDisabled_emits_events() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit PairDisableProposed(pair, true, block.timestamp + 48 hours);
        factory.proposePairDisabled(pair, true);

        vm.warp(block.timestamp + 48 hours);

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit PairDisableExecuted(pair, true);
        factory.executePairDisabled(pair);
    }

    // ============================================================
    // F-22: proposeFeeToChange allows re-proposing same feeTo [Low]
    // Unlike proposeFeeToSetter (SAME_SETTER check), no SAME_FEE_TO.
    // ============================================================

    function test_F22_proposeFeeToChange_same_address_allowed() public {
        vm.prank(admin);
        factory.proposeFeeToChange(treasury);
        assertEq(factory.pendingFeeTo(), treasury);
    }

    // ============================================================
    // F-23: Blocked token check covers both positions [Informational]
    // ============================================================

    function test_F23_blocked_token_either_position() public {
        vm.startPrank(admin);
        factory.proposeTokenBlocked(address(tokenA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        factory.executeTokenBlocked(address(tokenA));
        vm.stopPrank();

        vm.expectRevert("TOKEN_BLOCKED");
        factory.createPair(address(tokenA), address(tokenB));

        vm.expectRevert("TOKEN_BLOCKED");
        factory.createPair(address(tokenB), address(tokenA));
    }

    // ============================================================
    // F-24: Pair initialization sets correct token0/token1 [Informational]
    // ============================================================

    function test_F24_pair_initialized_correctly() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));

        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        assertEq(TegridyPair(pair).token0(), t0);
        assertEq(TegridyPair(pair).token1(), t1);
        assertEq(TegridyPair(pair).factory(), address(factory));
    }

    // ============================================================
    // F-25: allPairs array tracking [Informational]
    // ============================================================

    function test_F25_allPairs_tracking() public {
        assertEq(factory.allPairsLength(), 0);

        address pair1 = factory.createPair(address(tokenA), address(tokenB));
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair1);

        address pair2 = factory.createPair(address(tokenA), address(tokenC));
        assertEq(factory.allPairsLength(), 2);
        assertEq(factory.allPairs(1), pair2);
    }

    // ============================================================
    // F-26: Deprecated functions revert [Informational]
    // ============================================================

    function test_F26_deprecated_setFeeTo_reverts() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToChange()");
        factory.setFeeTo(newTreasury);
    }

    function test_F26_deprecated_setFeeToSetter_reverts() public {
        vm.prank(admin);
        vm.expectRevert("Use proposeFeeToSetter()");
        factory.setFeeToSetter(newSetter);
    }

    // ============================================================
    // F-27: Setter transfer then feeTo change from new setter [Informational]
    // ============================================================

    function test_F27_setter_transfer_then_feeTo_change() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        // New setter proposes feeTo change
        vm.prank(newSetter);
        factory.proposeFeeToChange(newTreasury);

        // Old admin cannot execute even after timelock
        vm.warp(block.timestamp + 49 hours);
        vm.prank(admin);
        vm.expectRevert("FORBIDDEN");
        factory.executeFeeToChange();

        // New setter executes after timelock
        vm.prank(newSetter);
        factory.executeFeeToChange();
        assertEq(factory.feeTo(), newTreasury);
    }

    // ============================================================
    // F-28: Pending feeTo change survives feeToSetter transfer [Medium]
    // If admin proposes a feeTo change then transfers feeToSetter,
    // the NEW setter can execute the old pending feeTo change that
    // was proposed by the previous setter.
    // ============================================================

    function test_F28_pending_feeTo_cleared_on_setter_transfer() public {
        // Admin proposes feeTo change
        vm.prank(admin);
        factory.proposeFeeToChange(newTreasury);

        // Admin transfers setter role
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        factory.acceptFeeToSetter();

        // FIX VERIFIED: Pending feeTo change was cleared on setter transfer
        bytes32 feeToKey = factory.FEE_TO_CHANGE();
        vm.prank(newSetter);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, feeToKey));
        factory.executeFeeToChange();
    }

    // ============================================================
    // F-29: Admin can cancel during timelock [Informational]
    // ============================================================

    function test_F29_admin_can_cancel_during_timelock() public {
        vm.prank(admin);
        factory.proposeFeeToSetter(newSetter);

        vm.warp(block.timestamp + 24 hours);
        vm.prank(admin);
        factory.cancelFeeToSetterProposal();

        vm.warp(block.timestamp + 48 hours);
        vm.prank(newSetter);
        vm.expectRevert("NOT_PENDING");
        factory.acceptFeeToSetter();
    }
}
