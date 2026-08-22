// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {TegridyRestakingAdmin} from "../src/TegridyRestakingAdmin.sol";
import {RestakingMonitorView} from "../src/RestakingMonitorView.sol";

/// @title Restaking EIP-170 regression guard
/// @notice TegridyRestaking measured 26,784 B — 2,208 B OVER the 24,576-byte EVM
///         contract-size limit — and was therefore undeployable by construction.
///         The admin split brought it under. This suite exists so that it cannot
///         drift back over without a red test.
///
/// @dev    Why this is a test and not only a CI shell step: the size gate in
///         `.github/workflows/contracts-ci.yml` carries a two-tier allowlist, and
///         `TegridyRestaking` sat in its `OVER_EIP170_DEFERRED` tier — a tier that
///         WARNS instead of failing. An allowlist entry cannot soften an assertion
///         in the test matrix, so the guard is pinned here as well.
///
/// @dev    Measurement is `address(c).code.length` — the deployed runtime bytecode
///         the EVM actually checks at CREATE, which is the same quantity
///         `deployedBytecode.object` in the forge artifact reports. Constructor
///         bytecode is deliberately NOT counted: EIP-170 bounds the runtime code.
///
/// @dev    The constructors here take deliberately inert addresses (no live wiring):
///         the restaking constructor performs zero-address checks and one `decimals()`
///         probe, and touches no other contract. Keeping the harness dependency-free
///         means this guard stays green for reasons that have nothing to do with
///         staking-side behaviour, and red only on real bytecode growth.
///
/// @dev    The probe target must carry code. Solidity's `extcodesize` precheck on a
///         typed external call reverts in the CALLER's frame, so a codeless address
///         is not absorbed by the constructor's try/catch.
contract SizeProbeToken {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract Audit_RestakingEIP170SizeTest is Test {
    /// @notice EIP-170's hard ceiling on deployed runtime bytecode.
    uint256 internal constant EIP170_LIMIT = 24_576;

    /// @notice The conservative floor the CI size job uses ahead of the real limit.
    uint256 internal constant BUDGET_FLOOR = 24_000;

    TegridyRestaking internal restaking;
    TegridyRestakingAdmin internal restakingAdmin;
    RestakingMonitorView internal monitorView;

    function setUp() public {
        address staking = address(new SizeProbeToken());
        address monitor = address(new SizeProbeToken());
        address rewardToken = address(new SizeProbeToken());
        address bonusRewardToken = address(new SizeProbeToken());

        restaking = new TegridyRestaking(staking, monitor, rewardToken, bonusRewardToken, 0);
        restakingAdmin = new TegridyRestakingAdmin(address(restaking));
        monitorView = new RestakingMonitorView(address(restaking));
    }

    /// @notice The host must be deployable. This is the acceptance test for the split.
    function test_restakingHost_isUnderEIP170() public view {
        uint256 size = address(restaking).code.length;
        assertLt(
            size,
            EIP170_LIMIT,
            "TegridyRestaking exceeds EIP-170 (24,576 B) and is undeployable - extract to the admin sister or the view sister, do not raise this bound"
        );
    }

    /// @notice A sister that outgrows the limit relocates the problem instead of
    ///         solving it, so both halves are gated.
    function test_restakingAdminSister_isUnderEIP170() public view {
        assertLt(
            address(restakingAdmin).code.length,
            EIP170_LIMIT,
            "TegridyRestakingAdmin exceeds EIP-170 (24,576 B) and is undeployable"
        );
    }

    function test_restakingMonitorViewSister_isUnderEIP170() public view {
        assertLt(
            address(monitorView).code.length,
            EIP170_LIMIT,
            "RestakingMonitorView exceeds EIP-170 (24,576 B) and is undeployable"
        );
    }

    /// @notice Early warning: the host crossing the conservative CI floor means the
    ///         next security-fix wave is likely to push it over the real limit. The
    ///         split landed with more than 2 KB of headroom, so tripping this means
    ///         something substantial was added to the host and belongs on a sister.
    function test_restakingHost_staysUnderConservativeFloor() public view {
        assertLt(
            address(restaking).code.length,
            BUDGET_FLOOR,
            "TegridyRestaking crossed the 24,000 B CI floor - move the next addition to TegridyRestakingAdmin or RestakingMonitorView rather than spending the EIP-170 buffer"
        );
    }

    /// @notice Emits the measured sizes so a CI log records the headroom at the
    ///         commit that changed it, not only at the commit that broke it.
    function test_reportRestakingBytecodeSizes() public view {
        uint256 host = address(restaking).code.length;
        uint256 admin = address(restakingAdmin).code.length;
        uint256 view_ = address(monitorView).code.length;
        console2.log("TegridyRestaking       bytes:", host);
        // Clamped: when the host is OVER the limit this test must still report the
        // number rather than panic on an underflow and hide it behind a second failure.
        console2.log("  headroom under EIP-170:   ", host < EIP170_LIMIT ? EIP170_LIMIT - host : 0);
        console2.log("  OVERAGE (0 = under):      ", host > EIP170_LIMIT ? host - EIP170_LIMIT : 0);
        console2.log("TegridyRestakingAdmin  bytes:", admin);
        console2.log("RestakingMonitorView   bytes:", view_);
    }
}
