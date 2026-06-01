// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";

/// @title AUDIT R-014 M-1 â€” Semantic rename of pairFeeBps â†’ inputTokenFeeBps.
/// @notice Verifies the additive rename is fully ABI-compatible:
///         - both old (`pairFeeBps`) and new (`inputTokenFeeBps`) getters return
///           the same value after a write;
///         - both apply paths (`applyInputTokenFee` and `applyPairFee`) produce
///           the same on-chain effect;
///         - the deprecation event fires when the legacy entry-point is invoked
///           on either the router (`ApplyPairFeeDeprecated`) or the admin
///           contract (`ProposePairFeeChangeDeprecated`).

// â”€â”€â”€â”€â”€â”€â”€â”€ Mocks (minimal â€” we don't exercise the swap path here) â”€â”€â”€â”€â”€

contract MockERC20_R014 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1e30);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Stub Uniswap V2 router â€” only `WETH()` and `factory()` are consumed by the
///      SwapFeeRouter constructor (the latter added by SFR-H-01 for the per-token
///      TWAP-floor minETHOut). Swap paths are unreachable in these unit tests.
contract MockUniRouter_R014 {
    address public immutable WETH_ADDR;
    address public constant FACTORY_STUB = address(0xFAC7);
    constructor(address _weth) { WETH_ADDR = _weth; }
    function WETH() external view returns (address) { return WETH_ADDR; }
    function factory() external pure returns (address) { return FACTORY_STUB; }
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

        sfr = new SwapFeeRouter(address(uniRouter), treasury, FEE_BPS, address(0), address(uint160(uint256(keccak256("MOCK_REV_DIST")))));
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  1. Storage parity â€” both getters reflect the same write
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /// @dev After applyInputTokenFee, `inputTokenFeeBps(token)` and
    ///      `pairFeeBps(token)` return the same value. Same for the override flag.
    function test_M1_getters_parity_after_canonical_write() public {
        // Drive the canonical setter end-to-end through the admin timelock so
        // we exercise the full propose â†’ execute flow.
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

    /// @dev AUDIT SFR-M-03 (MEDIUM, 2026-04-28): the legacy mutative aliases now
    ///      revert with `DeprecatedUseInputTokenFee`. Confirm propose/execute/cancel
    ///      all fail loudly so any in-flight automation breaks instead of silently
    ///      inheriting canonical behaviour. The view getters
    ///      (pairFeeBps/hasPairFeeOverride) remain â€” they're harmless.
    function test_SFRM03_legacy_propose_reverts() public {
        vm.expectRevert(SwapFeeRouterAdmin.DeprecatedUseInputTokenFee.selector);
        sfrAdmin.proposePairFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
    }

    function test_SFRM03_legacy_execute_reverts() public {
        // First land a real proposal via the canonical path so the timelock state
        // is loaded. `executePairFeeChange` should still revert independent of state.
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        skip(sfrAdmin.PAIR_FEE_CHANGE_DELAY());
        vm.expectRevert(SwapFeeRouterAdmin.DeprecatedUseInputTokenFee.selector);
        sfrAdmin.executePairFeeChange();
    }

    function test_SFRM03_legacy_cancel_reverts() public {
        sfrAdmin.proposeInputTokenFeeChange(address(tokenA), OVERRIDE_FEE_BPS, false);
        vm.expectRevert(SwapFeeRouterAdmin.DeprecatedUseInputTokenFee.selector);
        sfrAdmin.cancelPairFeeChange();
    }

    function test_SFRM03_router_legacy_applyPairFee_reverts() public {
        // Even when called by the wired admin (the only address that previously
        // satisfied the onlyAdmin gate), the function must hard-revert.
        vm.prank(address(sfrAdmin));
        vm.expectRevert(SwapFeeRouter.DeprecatedUseInputTokenFee.selector);
        sfr.applyPairFee(address(tokenA), OVERRIDE_FEE_BPS, false);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  3. Deprecation events (now RETIRED â€” aliases revert hard)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //
    // SFR-M-03 (MEDIUM, 2026-04-28): the prior `test_M1_*_emits_deprecation_event`
    // tests are removed because the deprecated aliases now revert before any event
    // fires. The deprecation events themselves remain on the contract ABI for
    // indexer compatibility, but they are no longer emit-reachable.

    /// @dev Conversely, the canonical entry-points must NOT emit the deprecation
    ///      events â€” we use `vm.recordLogs` to capture every emission and assert
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  4. Both events emit on a single write â€” ABI-compat indexer story
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
