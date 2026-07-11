// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

interface ITWAPBootstrap {
    function update(address pair) external payable;
    function getObservationCount(address pair) external view returns (uint256);
    function consult(address pair, address tokenIn, uint256 amountIn, uint256 period)
        external
        view
        returns (uint256 amountOut);
}

interface IRouterForWeth {
    function WETH() external view returns (address);
}

/// @title  BootstrapTWAP — record one TWAP observation + report bootstrap progress.
/// @notice The TegridyTWAP oracle needs several `update()` observations spaced
///         >= MIN_PERIOD (15 min) apart before `consult()` returns a usable price,
///         and downstream POL.accumulate must wait a further ~60 min after the
///         oracle is warm (audit H-18). A single forge run can't sleep between
///         observations, so this script records ONE observation per invocation and
///         prints how far along the bootstrap is. Run it repeatedly.
///
/// @dev    Procedure (per docs/pending — 4 observations then a 60-min cooldown):
///           1. Seed the pool (SeedLP.s.sol).
///           2. Run this script. Wait >= 15 min. Repeat until it reports the oracle
///              is WARM (>= 4 observations AND consult() succeeds) — ~4 runs / ~45+ min.
///           3. Wait a further 60 min before any POL.accumulate.
///           4. VerifyMVP.
///
/// @dev    Env vars:
///           TWAP     — TegridyTWAP address (required)
///           PAIR     — TOWELI/WETH pair address (required)
///           ROUTER   — TegridyRouter, used to derive WETH for the consult probe (required)
///           TOWELI   — TOWELI token address, the consult `tokenIn` (required)
///           MIN_OBS  — observations to consider the oracle warm (optional, default 4)
///
/// @dev    Run: forge script script/BootstrapTWAP.s.sol --rpc-url $RPC --sender $OP -vvv
///         Real: add `--broadcast --private-key $KEY`. update() is public + payable;
///         we send 0 value (no fee required; any excess is refunded on-chain anyway).
contract BootstrapTWAP is Script {
    function run() external {
        address twap = vm.envAddress("TWAP");
        address pair = vm.envAddress("PAIR");
        address router = vm.envAddress("ROUTER");
        address toweli = vm.envAddress("TOWELI");
        uint256 minObs = vm.envOr("MIN_OBS", uint256(4));

        require(twap != address(0) && pair != address(0), "TWAP + PAIR required");
        require(router != address(0) && toweli != address(0), "ROUTER + TOWELI required");

        uint256 before = ITWAPBootstrap(twap).getObservationCount(pair);
        console.log("=== BootstrapTWAP ===");
        console.log("TWAP:", twap);
        console.log("PAIR:", pair);
        console.log("Observations before:", before);

        vm.startBroadcast();
        // Records one observation. Reverts inside update() if MIN_PERIOD (15 min)
        // hasn't elapsed since the last one — that's the signal you ran too soon.
        ITWAPBootstrap(twap).update(pair);
        vm.stopBroadcast();

        uint256 nowCount = ITWAPBootstrap(twap).getObservationCount(pair);
        console.log("Observations after: ", nowCount);

        // Readiness probe: is consult() usable yet? (needs enough spaced obs + fresh data)
        address weth = IRouterForWeth(router).WETH();
        bool warm;
        try ITWAPBootstrap(twap).consult(pair, toweli, 1e18, 900) returns (uint256 out) {
            warm = true;
            console.log("consult(1e18 TOWELI, 15m) => WETH out:", out);
        } catch {
            console.log("consult() not ready yet (need more spaced observations / fresher data)");
        }

        console.log("");
        if (warm && nowCount >= minObs) {
            console.log("=== ORACLE WARM ===");
            console.log("Now WAIT 60 min (audit H-18) before any POL.accumulate. Then run VerifyMVP.");
        } else {
            console.log("=== NOT WARM YET ===");
            console.log("Wait >= 15 min, then run this script again.");
            console.log("Have / need observations:", nowCount, minObs);
        }
    }
}
