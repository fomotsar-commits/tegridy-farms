// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";

/// @title AUDIT R-014 M-1 — Semantic rename of pairFeeBps → inputTokenFeeBps.
/// @notice Verifies the additive rename is fully ABI-compatible:
///         - both old (`pairFeeBps`) and new (`inputTokenFeeBps`) getters return
///           the same value after a write;
///         - both apply paths (`applyInputTokenFee` and `applyPairFee`) produce
///           the same on-chain effect;
///         - the deprecation event fires when the legacy entry-point is invoked
///           on either the router (`ApplyPairFeeDeprecated`) or the admin
///           contract (`ProposePairFeeChangeDeprecated`).

// ──────── Mocks (minimal — we don't exercise the swap path here) ─────

contract MockERC20_R014 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1e30);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Stub Uniswap V2 router — only `WETH()` is consumed by the SwapFeeRouter
///      constructor. Swap paths are unreachable in these unit tests.
contract MockUniRouter_R014 {
    address public immutable WETH_ADDR;
    constructor(address _weth) { WETH_ADDR = _weth; }
    function WETH() external view returns (address) { return WETH_ADDR; }
    receive() external payable {}
}

contract AuditR014_SwapFeeRouter is Test {
    SwapFeeRouter public sfr;
    SwapFeeRouterAdmin public sfrAdmin;
    MockUniRouter_R014 public uniRouter;
    MockERC20_R014 public weth;
    MockERC20_R014 public tokenA;

    address public treasury = makeAddr("treasury");

    uint256 constant FEE_BPS = 30; // 0.3%
    uint256 constant OVERRIDE_FEE_BPS = 50; // 0.5%

    // Mirror of the events under test (so vm.expectEmit can match by signature).
    event InputTokenFeeApplied(address indexed inputToken, uint256 newFeeBps, bool removal);
    event PairFeeUpdated(address indexed pair, uint256 feeBps, bool removed);
    event ApplyPairFeeDeprecated();
    event InputTokenFeeChangeProposed(address indexed inputToken, uint256 feeBps, bool removal, uint256 executeAfter);
    event PairFeeChangeProposed(address indexed pair, uint256 feeBps, bool removal, uint256 executeAfter);
    event ProposePairFeeChangeDeprecated();

    function setUp() public {
        weth = new MockERC20_R014("WETH", "WETH");
        tokenA = new MockERC20_R014("TokenA", "TKA");
        uniRouter = new MockUniRouter_R014(address(weth));

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. Storage parity — both getters reflect the same write
    // ═══════════════════════════════════════════════════════════════

    /// @dev After applyInputTokenFee, `inputTokenFeeBps(token)` and
    ///      `pairFeeBps(token)` return the same value. Same for the override flag.
    function test_M1_getters_parity_after_canonical_write() public {
        // Drive the canonical setter end-to-end through the admin timelock so
        // we exercise the full propose → execute flow.
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        sfrAdmin.executeInputTokenFeeChange();

        // New getter
        assertEq(sfr.inputTokenFeeBps(address(tokenA)), OVERRIDE_FEE_BPS, "canonical getter mismatch");
        assertTrue(sfr.hasInputTokenFeeOverride(address(tokenA)), "canonical flag mismatch");

        // Legacy ABI-compat getter must return the same value
        assertEq(sfr.pairFeeBps(address(tokenA)), OVERRIDE_FEE_BPS, "legacy getter mismatch");
        assertTrue(sfr.hasPairFeeOverride(address(tokenA)), "legacy flag mismatch");

        // Both getters must agree after a removal too
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), 0, true);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        sfrAdmin.executeInputTokenFeeChange();

        assertEq(sfr.inputTokenFeeBps(address(tokenA)), 0, "canonical getter after removal");
        assertFalse(sfr.hasInputTokenFeeOverride(address(tokenA)), "canonical flag after removal");
        assertEq(sfr.pairFeeBps(address(tokenA)), 0, "legacy getter after removal");
        assertFalse(sfr.hasPairFeeOverride(address(tokenA)), "legacy flag after removal");
    }

    /// @dev Symmetric: drive the legacy `proposePairFeeChange` and confirm both
    ///      getters reflect the write. This is the path callers will hit if they
    ///      haven't migrated yet.
    function test_M1_getters_parity_after_legacy_write() public {
        sfrAdmin.proposePairFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        sfrAdmin.executePairFeeChange();

        assertEq(sfr.inputTokenFeeBps(address(tokenA)), OVERRIDE_FEE_BPS, "canonical getter mismatch");
        assertEq(sfr.pairFeeBps(address(tokenA)), OVERRIDE_FEE_BPS, "legacy getter mismatch");
        assertTrue(sfr.hasInputTokenFeeOverride(address(tokenA)), "canonical flag mismatch");
        assertTrue(sfr.hasPairFeeOverride(address(tokenA)), "legacy flag mismatch");
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. Same effect — both apply* setters produce identical state
    // ═══════════════════════════════════════════════════════════════

    /// @dev Two routers seeded identically. One reaches the override via the
    ///      canonical setter, the other via the legacy alias. Storage and the
    ///      effective-fee view must match bit-for-bit.
    function test_M1_apply_paths_produce_identical_effect() public {
        // Spin up a parallel router/admin pair so we can compare.
        SwapFeeRouter sfrLegacy = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0));
        SwapFeeRouterAdmin adminLegacy = new SwapFeeRouterAdmin(address(sfrLegacy));
        sfrLegacy.setSwapFeeRouterAdmin(address(adminLegacy));

        // Canonical path (sfr / sfrAdmin)
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        sfrAdmin.executeInputTokenFeeChange();

        // Legacy path (sfrLegacy / adminLegacy)
        adminLegacy.proposePairFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(adminLegacy.PAIR_FEE_CHANGE_DELAY());
        adminLegacy.executePairFeeChange();

        // Storage parity
        assertEq(
            sfr.inputTokenFeeBps(address(tokenA)),
            sfrLegacy.inputTokenFeeBps(address(tokenA)),
            "canonical storage diverged across apply paths"
        );
        assertEq(
            sfr.hasInputTokenFeeOverride(address(tokenA)) ? uint256(1) : uint256(0),
            sfrLegacy.hasInputTokenFeeOverride(address(tokenA)) ? uint256(1) : uint256(0),
            "override flag diverged across apply paths"
        );

        // Effective-fee view parity (covers the `_getEffectiveFeeBps` consumer too)
        assertEq(
            sfr.getEffectiveFeeBps(address(tokenA), address(0xBEEF)),
            sfrLegacy.getEffectiveFeeBps(address(tokenA), address(0xBEEF)),
            "effective fee diverged across apply paths"
        );
        // …and the value should be the override, not the global
        assertEq(
            sfr.getEffectiveFeeBps(address(tokenA), address(0xBEEF)),
            OVERRIDE_FEE_BPS,
            "effective fee did not pick up override"
        );
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. Deprecation events fire when legacy names are used
    // ═══════════════════════════════════════════════════════════════

    /// @dev Calling the legacy `applyPairFee` (router-level) must emit the
    ///      `ApplyPairFeeDeprecated()` warning event. Off-chain monitors use this
    ///      to detect callers that haven't migrated. We invoke `applyPairFee`
    ///      directly from the wired admin contract address via `vm.prank` so we
    ///      satisfy the `onlyAdmin` gate.
    function test_M1_applyPairFee_emits_deprecation_event() public {
        vm.expectEmit(true, false, false, true);
        emit ApplyPairFeeDeprecated();
        // The canonical event is also emitted alongside; we only assert on the
        // deprecation event here for focus.
        vm.prank(address(sfrAdmin));
        sfr.applyPairFee(address(tokenA), OVERRIDE_FEE_BPS, false);

        // And the write took effect (sanity)
        assertEq(sfr.inputTokenFeeBps(address(tokenA)), OVERRIDE_FEE_BPS, "write did not land");
    }

    /// @dev Calling the legacy `proposePairFeeChange` on the admin contract must
    ///      emit `ProposePairFeeChangeDeprecated()`.
    function test_M1_proposePairFeeChange_emits_deprecation_event() public {
        vm.expectEmit(true, false, false, true);
        emit ProposePairFeeChangeDeprecated();
        sfrAdmin.proposePairFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
    }

    /// @dev Conversely, the canonical entry-points must NOT emit the deprecation
    ///      events — we use `vm.recordLogs` to capture every emission and assert
    ///      neither deprecation topic appears.
    function test_M1_canonical_paths_do_not_emit_deprecation() public {
        bytes32 routerDepTopic = keccak256("ApplyPairFeeDeprecated()");
        bytes32 adminDepTopic = keccak256("ProposePairFeeChangeDeprecated()");

        vm.recordLogs();
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        sfrAdmin.executeInputTokenFeeChange();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != routerDepTopic,
                "canonical path leaked router deprecation event"
            );
            assertTrue(
                logs[i].topics[0] != adminDepTopic,
                "canonical path leaked admin deprecation event"
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. Both events emit on a single write — ABI-compat indexer story
    // ═══════════════════════════════════════════════════════════════

    /// @dev `applyInputTokenFee` (or any path that ends up at it) must emit
    ///      BOTH `InputTokenFeeApplied` (canonical) and `PairFeeUpdated` (legacy)
    ///      so both indexer generations stay in sync until the legacy is retired.
    function test_M1_dual_event_emission() public {
        vm.expectEmit(true, false, false, true);
        emit InputTokenFeeApplied(address(tokenA), OVERRIDE_FEE_BPS, false);
        vm.expectEmit(true, false, false, true);
        emit PairFeeUpdated(address(tokenA), OVERRIDE_FEE_BPS, false);
        vm.prank(address(sfrAdmin));
        sfr.applyInputTokenFee(address(tokenA), OVERRIDE_FEE_BPS, false);
    }
}
