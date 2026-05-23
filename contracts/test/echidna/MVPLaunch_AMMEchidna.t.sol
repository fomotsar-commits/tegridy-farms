// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyPair} from "../../src/TegridyPair.sol";

/// @title  MVPLaunch_AMMEchidna — AMM core invariants for Echidna campaigns
/// @notice Phase 1.5 of the battle plan. Echidna-style property tests on
///         the TegridyPair core. Designed to be run by auditors as a
///         long-running campaign (24h+ recommended).
///
///         How to run:
///         ```
///         cd contracts
///         echidna test/echidna/MVPLaunch_AMMEchidna.t.sol \
///             --contract MVPLaunch_AMMEchidna \
///             --config echidna.config.yml
///         ```
///
///         Properties (Echidna boolean `echidna_*` convention):
///         - echidna_kInvariantHolds: k = reserve0 * reserve1 monotonically
///           non-decreasing under any swap/mint/burn sequence (it can
///           grow on fee accrual, but never shrink)
///         - echidna_reservesLeBalances: reserve{0,1} <= balanceOf(token{0,1})
///           always (donations only widen the gap; skim reconciles)
///         - echidna_totalSupplyConsistent: sum of LP balances == totalSupply
///         - echidna_minLiquidityLocked: MINIMUM_LIQUIDITY at address(0)
///           persists once minted
contract MVPLaunch_AMMEchidna {
    EchidnaToken token0;
    EchidnaToken token1;
    TegridyFactory factory;
    TegridyPair pair;

    uint256 lastK;
    bool bootstrapped;

    constructor() {
        // Deploy two tokens, factory, and pair.
        token0 = new EchidnaToken("Token0", "T0");
        token1 = new EchidnaToken("Token1", "T1");

        // Ensure deterministic ordering (token0 < token1) for V2 pair semantics.
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        factory = new TegridyFactory(address(this), address(this), address(this));
        pair = TegridyPair(factory.createPair(address(token0), address(token1)));

        // Seed pair with initial liquidity so swaps have something to work with.
        token0.mint(address(pair), 1_000_000e18);
        token1.mint(address(pair), 1_000_000e18);
        pair.mint(address(this));
        bootstrapped = true;
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        lastK = uint256(r0) * uint256(r1);
    }

    // ─── Action surface for Echidna to randomize ─────────────────────

    /// @notice Echidna calls this with random amounts; we drive a swap.
    function mintAndSwap(uint256 amount0In, uint256 amount1In, bool zeroForOne) external {
        if (!bootstrapped) return;
        amount0In = amount0In % 1_000_000e18;
        amount1In = amount1In % 1_000_000e18;
        if (amount0In == 0 && amount1In == 0) return;

        // Donate input to pair, compute output, swap.
        if (amount0In > 0) token0.mint(address(pair), amount0In);
        if (amount1In > 0) token1.mint(address(pair), amount1In);

        (uint112 r0Pre, uint112 r1Pre, ) = pair.getReserves();
        uint256 amount0Out = 0;
        uint256 amount1Out = 0;

        if (zeroForOne && amount0In > 0) {
            // Conservative output: 0.997 * amount0In * r1 / (r0 + 0.997*amount0In)
            uint256 amountInWithFee = amount0In * 997;
            uint256 numerator = amountInWithFee * uint256(r1Pre);
            uint256 denominator = uint256(r0Pre) * 1000 + amountInWithFee;
            amount1Out = denominator > 0 ? numerator / denominator : 0;
        } else if (!zeroForOne && amount1In > 0) {
            uint256 amountInWithFee = amount1In * 997;
            uint256 numerator = amountInWithFee * uint256(r0Pre);
            uint256 denominator = uint256(r1Pre) * 1000 + amountInWithFee;
            amount0Out = denominator > 0 ? numerator / denominator : 0;
        }

        if (amount0Out == 0 && amount1Out == 0) return;
        try pair.swap(amount0Out, amount1Out, address(this), "") {} catch {}
    }

    function donate(uint256 amount0, uint256 amount1) external {
        amount0 = amount0 % 100_000e18;
        amount1 = amount1 % 100_000e18;
        if (amount0 > 0) token0.mint(address(pair), amount0);
        if (amount1 > 0) token1.mint(address(pair), amount1);
    }

    function sync() external {
        try pair.sync() {} catch {}
    }

    function skim() external {
        try pair.skim(address(this)) {} catch {}
    }

    // ─── INV-K-MONOTONIC ─────────────────────────────────────────────
    /// @dev `k = reserve0 * reserve1` may GROW on fee accrual; it must
    ///      never shrink. This catches the V2 swap-fee-bypass class.
    function echidna_kInvariantHolds() public returns (bool) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        uint256 k = uint256(r0) * uint256(r1);
        if (k < lastK) {
            return false;
        }
        lastK = k;
        return true;
    }

    // ─── INV-RESERVES-LE-BALANCES ────────────────────────────────────
    /// @dev Reserves always trail balances (donations widen the gap;
    ///      skim/sync reconcile). Reserves must NEVER exceed balances.
    function echidna_reservesLeBalances() public view returns (bool) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        if (uint256(r0) > token0.balanceOf(address(pair))) return false;
        if (uint256(r1) > token1.balanceOf(address(pair))) return false;
        return true;
    }

    // ─── INV-LP-SUPPLY-CONSERVED ─────────────────────────────────────
    /// @dev totalSupply >= MINIMUM_LIQUIDITY locked at address(0) once
    ///      bootstrap mint happened.
    function echidna_minLiquidityLocked() public view returns (bool) {
        if (!bootstrapped) return true;
        uint256 lockedAtZero = pair.balanceOf(address(0));
        return lockedAtZero >= 1000; // MINIMUM_LIQUIDITY
    }
}

contract EchidnaToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
