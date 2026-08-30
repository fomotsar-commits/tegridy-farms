// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

/// @title  UniswapV2OracleLibrary — 0.8 port of the canonical v2-periphery library
/// @notice Remediation row 8 (docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md): the
///         fee-conversion TWAP floor previously re-derived the cumulative-price
///         counterfactual by hand inside SwapFeeRouterConvertLib. This file replaces
///         that hand-derivation with a VERBATIM port of Uniswap/v2-periphery
///         (commit ed249913) contracts/libraries/UniswapV2OracleLibrary.sol, and the
///         port is MECHANICALLY pinned against the vendored canonical source by the
///         `Contracts CI / v2-provenance` gate
///         (contracts/provenance/expected/UniswapV2OracleLibrary.expected.diff) — any
///         edit here that survives normalization goes red until deliberately re-pinned.
///
///         The ONLY deviations from canonical (each a pinned hunk + a named entry in
///         contracts/provenance/PROVENANCE.md):
///           * the uniswap-lib FixedPoint.fraction helper is inlined as `fraction(...)`,
///             returning the raw UQ112x112 uint224 (canonical reads `._x` off a struct);
///           * the minimal IUniswapV2Pair surface is declared locally rather than
///             imported from v2-core;
///           * Solidity 0.8 checked arithmetic needs an explicit `unchecked` block where
///             0.6's wrapping was implicit — the canonical comments ("subtraction/
///             addition overflow is desired") describe exactly that wrapping.
///
/// @dev    License note: v2-periphery is GPL-3.0 (verified at the pinned commit), so
///         this derived file carries the GPL-3.0-or-later identifier rather than the
///         repo-default MIT.
interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

// library with helper methods for oracles that are concerned with computing average prices
library UniswapV2OracleLibrary {
    // uniswap-lib FixedPoint.fraction, inlined: a UQ112x112 = (numerator << 112) / denominator.
    function fraction(uint112 numerator, uint112 denominator) internal pure returns (uint224) {
        require(denominator > 0, "FixedPoint: DIV_BY_ZERO");
        return uint224((uint256(numerator) << 112) / denominator);
    }

    // helper function that returns the current block timestamp within the range of uint32, i.e. [0, 2**32 - 1]
    function currentBlockTimestamp() internal view returns (uint32) {
        // SLITHER: Uniswap V2 oracle-timestamp truncation; not used as a randomness source
        // slither-disable-next-line weak-prng
        return uint32(block.timestamp % 2 ** 32);
    }

    // produces the cumulative price using counterfactuals to save gas and avoid a call to sync.
    function currentCumulativePrices(address pair)
        internal
        view
        returns (uint256 price0Cumulative, uint256 price1Cumulative, uint32 blockTimestamp)
    {
        blockTimestamp = currentBlockTimestamp();
        price0Cumulative = IUniswapV2Pair(pair).price0CumulativeLast();
        price1Cumulative = IUniswapV2Pair(pair).price1CumulativeLast();

        // if time has elapsed since the last update on the pair, mock the accumulated price values
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
        if (blockTimestampLast != blockTimestamp) {
            unchecked {
                // subtraction overflow is desired
                uint32 timeElapsed = blockTimestamp - blockTimestampLast;
                // addition overflow is desired
                // counterfactual
                // SLITHER: canonical UQ112x112 pattern — divide (inside fraction) then scale by elapsed seconds
                // slither-disable-next-line divide-before-multiply
                price0Cumulative += uint256(fraction(reserve1, reserve0)) * timeElapsed;
                // counterfactual
                // SLITHER: canonical UQ112x112 pattern — divide (inside fraction) then scale by elapsed seconds
                // slither-disable-next-line divide-before-multiply
                price1Cumulative += uint256(fraction(reserve0, reserve1)) * timeElapsed;
            }
        }
    }
}
