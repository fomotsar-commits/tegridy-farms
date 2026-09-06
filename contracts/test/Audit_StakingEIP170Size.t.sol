// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";

/// @title  Staking EIP-170 regression guard + size RATCHET
///
/// @notice TegridyStaking is the tightest contract in this repo and it is LIVE and on the
///         redeploy list. It has spent most of 2026 within ~250 B of the 24,576-byte EVM
///         contract-size ceiling, and at one point within 22 B — less than one line of code.
///
/// @dev    WHY A RATCHET AND NOT JUST A LIMIT. The CI size job
///         (.github/workflows/contracts-ci.yml) hard-fails only ABOVE 24,576 B. Between its
///         conservative 24,000 B floor and that ceiling it consults FLOOR_EXCEPTIONS and merely
///         WARNS — and TegridyStaking is on that list. So a change that eats the entire
///         remaining margin ships GREEN. That is exactly how the recorded figure drifted twice
///         before: it read 24,337 B / 239 B while the truth was 24,554 B / 22 B, and the repo
///         found out by measuring, not by a failing gate.
///
///         The sibling file Audit_RestakingEIP170Size.t.sol exists for the same reason and
///         states the principle: "an allowlist entry cannot soften an assertion in the test
///         matrix". It covers only the three restaking contracts. TegridyStaking was covered by
///         nothing until this file.
///
///         The restaking file's BUDGET_FLOOR assertion does NOT transfer — TegridyStaking is
///         legitimately above 24,000 B and cannot be brought under it without an architectural
///         split. The RATCHET replaces it: the contract may shrink freely, but it may not grow
///         past its last measured size without someone deliberately editing the number here and
///         justifying it.
///
/// @dev    Measurement is `address(c).code.length` — the deployed runtime bytecode the EVM
///         actually checks at CREATE, the same quantity forge reports as `deployedBytecode`.
///         Constructor bytecode is deliberately not counted; EIP-170 bounds runtime code.
///
/// @dev    The harness is dependency-free on purpose. TegridyStaking's constructor performs
///         only zero-address and rate-range checks and probes no external contract, so plain
///         non-zero placeholders suffice. Keeping it inert means this guard goes red on real
///         bytecode growth and on nothing else.
contract Audit_StakingEIP170SizeTest is Test {
    /// @notice EIP-170's hard ceiling on deployed runtime bytecode.
    uint256 internal constant EIP170_LIMIT = 24_576;

    /// @notice RATCHET — TegridyStaking's runtime size measured on 2026-09-05, after both
    ///         security fixes of that date landed:
    ///           24,554 B  baseline (22 B margin)
    ///           24,508 B  [LEND-EOA-WHITELIST]     -46  three inline `code.length == 0 || == 23`
    ///                     copies folded into one `_requireContract` helper, which FUNDED a new
    ///                     contract-check in `applyLendingContract` and still returned bytes
    ///           24,521 B  [LEND-RESIDUE-DEADLOCK]  +13  lending residue guard made
    ///                     unconditional (cheaper — it deletes a condition) and the mirror guard
    ///                     added on applyRestakingContract's INCOMING address
    ///         Net: two security fixes shipped and 33 B RETURNED. Margin 22 B -> 55 B.
    ///
    ///         This constant was briefly wrong during that work — it was set to 24,508 before
    ///         the second fix was measured, and this assertion is what caught it. That is the
    ///         job: the number is verified by the test matrix, not by a comment.
    ///
    ///         Raising it is a deliberate act, not a merge conflict to resolve. The standing
    ///         rule in contracts/foundry.toml is: extract to StakingViewLib / StakingRewardLib
    ///         or to the StakingMonitorView sister FIRST, and do not spend the remaining margin.
    ///         If you are here because this went red, that rule is what it is asking you to apply.
    uint256 internal constant STAKING_RATCHET = 24_521;

    TegridyStaking internal staking;
    TegridyStakingAdmin internal stakingAdmin;
    TegridyStakingJbacVault internal vault;
    StakingMonitorView internal monitorView;

    function setUp() public {
        staking = new TegridyStaking(address(0xA11CE), address(0xB0B), address(0xC0FFEE), 0);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        vault = new TegridyStakingJbacVault(address(0xB0B), address(staking));
        monitorView = new StakingMonitorView(address(staking));
    }

    /// @notice The hard EVM bound. If this fails the contract cannot be deployed at all.
    function test_stakingHost_isUnderEIP170() public view {
        assertLt(
            address(staking).code.length,
            EIP170_LIMIT,
            "TegridyStaking exceeds EIP-170 (24,576 B) and is undeployable - extract to StakingViewLib or the StakingMonitorView sister, do not raise this bound"
        );
    }

    /// @notice The real guard. CI only WARNS in this band, so the assertion lives here.
    function test_stakingHost_doesNotGrowPastTheLastMeasuredSize() public view {
        assertLe(
            address(staking).code.length,
            STAKING_RATCHET,
            "TegridyStaking grew past its 2026-09-05 measurement of 24,521 B. CI's FLOOR_EXCEPTIONS entry only WARNS below 24,576 B, so this test is the gate. Extract to a lib or the monitor sister rather than spending the margin - see contracts/foundry.toml."
        );
    }

    /// @notice A sister that outgrows the limit relocates the problem instead of solving it,
    ///         so every half of the split is gated too.
    function test_stakingAdminSister_isUnderEIP170() public view {
        assertLt(
            address(stakingAdmin).code.length, EIP170_LIMIT, "TegridyStakingAdmin exceeds EIP-170 and is undeployable"
        );
    }

    function test_stakingJbacVaultSister_isUnderEIP170() public view {
        assertLt(
            address(vault).code.length, EIP170_LIMIT, "TegridyStakingJbacVault exceeds EIP-170 and is undeployable"
        );
    }

    function test_stakingMonitorViewSister_isUnderEIP170() public view {
        assertLt(
            address(monitorView).code.length, EIP170_LIMIT, "StakingMonitorView exceeds EIP-170 and is undeployable"
        );
    }

    /// @notice Emits the measured sizes so a CI log records the headroom at the commit that
    ///         CHANGED it, not only at the commit that finally broke it. This is the artifact
    ///         that would have caught both historical drifts.
    function test_reportStakingBytecodeSizes() public view {
        uint256 host = address(staking).code.length;
        console2.log("TegridyStaking          bytes:", host);
        console2.log("  headroom under EIP-170:     ", host < EIP170_LIMIT ? EIP170_LIMIT - host : 0);
        console2.log("  OVERAGE (0 = under):        ", host > EIP170_LIMIT ? host - EIP170_LIMIT : 0);
        console2.log("  slack under the ratchet:    ", host < STAKING_RATCHET ? STAKING_RATCHET - host : 0);
        console2.log("TegridyStakingAdmin     bytes:", address(stakingAdmin).code.length);
        console2.log("TegridyStakingJbacVault bytes:", address(vault).code.length);
        console2.log("StakingMonitorView      bytes:", address(monitorView).code.length);
    }
}
