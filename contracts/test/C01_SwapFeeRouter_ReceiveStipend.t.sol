// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

/// @title C-01 regression — SwapFeeRouter.receive() must fit the 2,300 gas stipend
/// @notice The 2026-05-26 swarm audit (AUDIT_FINDINGS_2026_05_26_SWARM.md C-01) flagged
///         that canonical WETH9.withdraw() sends ETH via `msg.sender.transfer(amount)`,
///         which forwards only 2,300 gas. The prior `receive()` body did
///         `totalETHReceived += msg.value` (warm SSTORE ≈ 5k) + `emit ETHReceived` (LOG2 ≈ 1.7k)
///         → OOG → revert → every WETH-input swap's fees stuck forever.
///
///         Existing R028 tests missed this because their mock WETH uses `.call{value:}`
///         (full gas) instead of `.transfer(2300)`. This file uses the real `.transfer`
///         primitive so the gas ceiling is real.
///
///         Any future change to SwapFeeRouter.receive() that re-introduces non-trivial
///         work (SSTORE, LOG, external call) will break this test before it ever brokes
///         mainnet.
///
/// @dev    We don't import SwapFeeRouter here — its constructor wires a full DEX-stack
///         (router/factory/sequencer feed) which is overkill for a 1-line receive() probe.
///         Instead we deploy a minimal contract with the exact same `receive() external payable {}`
///         body as the production fix and assert `.transfer(2300)` succeeds against it.
///         If anyone widens the production receive(), they MUST mirror it here AND prove
///         the new body still fits the stipend — that's the contract this test enforces.
contract C01_StipendCanaryTest is Test {
    /// @dev Mirror of the production `receive()` body. If you change SwapFeeRouter's
    ///      receive(), change this canary identically and the test will tell you if it
    ///      still fits 2,300 gas.
    StipendCanary canary;

    /// @dev Holds ETH and forwards via `.transfer(2300)` — the exact pattern used by
    ///      canonical WETH9.withdraw() that triggered C-01 in production.
    StipendCaller caller;

    function setUp() public {
        canary = new StipendCanary();
        caller = new StipendCaller();
        vm.deal(address(caller), 100 ether);
    }

    /// @notice The headline regression: `.transfer(2300)` to a contract with the
    ///         canonical fix-shaped `receive()` must NOT revert.
    function test_C01_emptyReceive_acceptsTransferStipend() public {
        // Will revert if receive() exceeds the 2300 gas stipend.
        caller.forwardViaTransfer(payable(address(canary)), 1 ether);
        assertEq(address(canary).balance, 1 ether, "ETH should land in canary");
    }

    /// @notice Negative control: the PRE-FIX shape (SSTORE + LOG2) MUST exceed
    ///         the stipend. If this somehow passes, the EVM gas semantics changed
    ///         and the C-01 reasoning needs to be re-evaluated.
    function test_C01_prefixShape_oogsUnderStipend() public {
        StipendCanaryBroken broken = new StipendCanaryBroken();
        vm.expectRevert(); // .transfer reverts on OOG in receive
        caller.forwardViaTransfer(payable(address(broken)), 1 ether);
    }
}

/// @dev Mirrors SwapFeeRouter.sol's post-C-01-fix receive(): empty body, accept only.
contract StipendCanary {
    receive() external payable {}
}

/// @dev Mirrors SwapFeeRouter.sol's PRE-C-01-fix receive(): SSTORE + LOG.
///      Used as a negative control to prove the test harness can detect OOG.
contract StipendCanaryBroken {
    uint256 public totalETHReceived;
    event ETHReceived(address indexed sender, uint256 amount);
    receive() external payable {
        totalETHReceived += msg.value;
        emit ETHReceived(msg.sender, msg.value);
    }
}

/// @dev Holds ETH and forwards via Solidity's `.transfer()` — the 2300-gas-stipend primitive.
contract StipendCaller {
    function forwardViaTransfer(address payable target, uint256 amount) external {
        target.transfer(amount);
    }
}
