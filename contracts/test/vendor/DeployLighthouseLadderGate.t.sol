// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployLighthouseLadderScript} from "../../script/DeployLighthouseLadder.s.sol";
import {LighthouseLadder} from "../../src/LighthouseLadder.sol";

contract GateToken is ERC20 {
    constructor() ERC20("Room", "ROOM") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// @dev A Safe stand-in: it has code, and the code is not an EIP-7702 designator.
contract GateSafe {}

/// @title  The ladder deploy script's gates: which chains, and which build.
/// @notice Owner, 2026-10-18: the room ladders keep the ladder's law on Ethereum,
///         Base and Robinhood: the exit is the time left over four years, capped
///         at 75%. The same script serves all three rails and refuses any build
///         whose exit is a flat rate or another cap (L-INV-13 to 16), so neither
///         retired flat build can come back by accident on any of them.
contract DeployLighthouseLadderGateTest is Test {
    DeployLighthouseLadderScript script;
    GateToken token;
    GateSafe safe;

    function setUp() public {
        script = new DeployLighthouseLadderScript();
        token = new GateToken();
        safe = new GateSafe();
    }

    function _cfg(uint256 chain) internal view returns (DeployLighthouseLadderScript.Config memory c) {
        c.expectedChainId = chain;
        c.stakingToken = address(token);
        c.rewardsDistribution = address(safe);
    }

    function test_deploysOnEthereumBaseAndRobinhood_withTheLaddersLaw() public {
        uint256[3] memory chains = [uint256(1), 8453, 4663];
        for (uint256 i; i < 3; i++) {
            vm.chainId(chains[i]);
            DeployLighthouseLadderScript.Deployed memory d = script.runForTest(_cfg(chains[i]));
            LighthouseLadder pool = LighthouseLadder(d.pool);
            assertEq(pool.MAX_EARLY_EXIT_PENALTY_BPS(), 7_500, "the 75% cap on every rail");
            assertEq(pool.penaltyFor(1e18, uint64(block.timestamp + 365 days)), 0.25e18, "one year left: 25%");
            uint256 one = 1e18;
            assertEq(pool.penaltyFor(one, uint64(block.timestamp + 7 days)), (one * 7) / 1460, "seven days: 7/1460");
            assertEq(pool.rewardsDistribution(), address(safe));
            assertEq(address(pool.stakingToken()), address(token));
        }
    }

    function test_refusesAnyOtherChain() public {
        vm.chainId(10);
        vm.expectRevert(
            bytes("EXPECTED_CHAIN_ID: island lighthouses deploy on Ethereum (1), Base (8453) or Robinhood (4663) only")
        );
        script.runForTest(_cfg(10));
    }

    function test_refusesAChainMismatch() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("wrong chain for EXPECTED_CHAIN_ID"));
        script.runForTest(_cfg(1));
    }
}
