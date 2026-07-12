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
    // update() charges a keeper fee (anti-grief). Effective fee = updateFee when
    // the owner has configured it, else the MIN_UPDATE_FEE floor. Sending less
    // reverts InsufficientFee(); excess is refunded.
    function updateFee() external view returns (uint256);
    function updateFeeConfigured() external view returns (bool);
    function MIN_UPDATE_FEE() external view returns (uint256);
    function canUpdate(address pair) external view returns (bool);
    // Per-side reserve floor the TWAP enforces (anti-manipulation): update()
    // reverts ReservesBelowFloor() unless BOTH reserves clear their floor.
    // Default is 10 ether/side until an owner override is set.
    function effectiveMinReserveFloor(address pair) external view returns (uint256);
    function effectiveMinReserveFloor1(address pair) external view returns (uint256);
}

interface IPairReserves {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
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
        // Effective keeper fee that update() will charge (mirrors the on-chain
        // logic: configured value, else the MIN_UPDATE_FEE floor). Sent as
        // msg.value; underpaying reverts InsufficientFee(), overpaying is refunded.
        uint256 fee = ITWAPBootstrap(twap).updateFeeConfigured()
            ? ITWAPBootstrap(twap).updateFee()
            : ITWAPBootstrap(twap).MIN_UPDATE_FEE();

        console.log("=== BootstrapTWAP ===");
        console.log("TWAP:", twap);
        console.log("PAIR:", pair);
        console.log("Observations before:", before);
        console.log("update fee (wei):", fee);

        require(msg.sender.balance >= fee, "sender ETH balance < update fee");
        // Fail with a clear message instead of a raw PeriodNotElapsed() revert
        // mid-broadcast when run sooner than MIN_PERIOD (15 min) after the last obs.
        require(
            ITWAPBootstrap(twap).canUpdate(pair),
            "MIN_PERIOD (15 min) not elapsed since last observation - wait, then retry"
        );

        // The TWAP rejects observations from pools below its per-side reserve
        // floor (anti-manipulation: a thin pool's spot is cheap to move). Surface
        // that as a clear, actionable error here instead of a raw
        // ReservesBelowFloor() revert mid-broadcast. Default floor is 10 WETH/side.
        {
            (uint112 r0, uint112 r1,) = IPairReserves(pair).getReserves();
            uint256 f0 = ITWAPBootstrap(twap).effectiveMinReserveFloor(pair);
            uint256 f1 = ITWAPBootstrap(twap).effectiveMinReserveFloor1(pair);
            console.log("reserve0 / floor0:", uint256(r0), f0);
            console.log("reserve1 / floor1:", uint256(r1), f1);
            require(
                uint256(r0) >= f0 && uint256(r1) >= f1,
                "pool reserves below TWAP floor - DEEPEN the pool first (default 10 WETH per side)"
            );
        }

        vm.startBroadcast();
        // Records one observation. Pay the keeper fee via value; excess refunds.
        ITWAPBootstrap(twap).update{value: fee}(pair);
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
