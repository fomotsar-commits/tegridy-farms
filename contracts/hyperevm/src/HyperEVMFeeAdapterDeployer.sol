// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {IV3OpenFeeAdapter} from "protocol-fees/interfaces/IV3OpenFeeAdapter.sol";

/// @title HyperEVMFeeAdapterDeployer
/// @notice Deploys and configures Uniswap's V3OpenFeeAdapter for OUR Uniswap V3 factory on HyperEVM,
///         in one transaction, so no address but our admin Safe ever holds a role on it.
/// @dev This is step 7 of Uniswap's own `OPStackDeployer` (Uniswap/protocol-fees @
///      eacc9c013cf74316263cfae7a00b3361a1644795, script/deployers/OPStackDeployer.sol), copied line
///      for line. The only changes:
///        - Uniswap's TokenJar is replaced by our treasury Safe (`_treasury`): the adapter's
///          `collect` can only ever send the venue's cut there (TOKEN_JAR is immutable).
///        - Steps 1-6 (TokenJar + the UNI-burning releaser) are left out: we do not burn anything.
///        - The owner is our admin Safe instead of Uniswap's CrossChainAccount.
///      The fee defaults are Uniswap's own mainnet schedule, unchanged. The admin Safe (the fee setter)
///      can change them later with `setFeeTierDefault`.
///      The factory is NOT handed to the adapter here. The admin Safe does that with one
///      `factory.setOwner(adapter)` after reading this deploy back, the same order Uniswap's
///      governance used when it switched the Ethereum fee on.
contract HyperEVMFeeAdapterDeployer {
  error ZeroAddress();

  IV3OpenFeeAdapter public immutable V3_OPEN_FEE_ADAPTER;

  bytes32 public constant SALT_FEE_ADAPTER = bytes32(uint256(3));

  // Protocol fee defaults — same as Uniswap mainnet (OPStackDeployer)
  uint8 constant DEFAULT_FEE_100 = 4 << 4 | 4; // 1/4 for 0.01% tier
  uint8 constant DEFAULT_FEE_500 = 4 << 4 | 4; // 1/4 for 0.05% tier
  uint8 constant DEFAULT_FEE_3000 = 6 << 4 | 6; // 1/6 for 0.30% tier
  uint8 constant DEFAULT_FEE_10000 = 6 << 4 | 6; // 1/6 for 1.00% tier

  /// @param _treasury Our treasury Safe on this chain: the only place the venue's cut can go
  /// @param _owner Our admin Safe on this chain: owner and fee setter of the adapter
  /// @param _v3Factory Our Uniswap V3 Factory on this chain
  constructor(address _treasury, address _owner, address _v3Factory) {
    require(_treasury != address(0), ZeroAddress());
    require(_owner != address(0), ZeroAddress());
    require(_v3Factory != address(0), ZeroAddress());

    /// 7. Deploy and configure V3OpenFeeAdapter
    V3OpenFeeAdapter feeAdapter = new V3OpenFeeAdapter{salt: SALT_FEE_ADAPTER}(_v3Factory, _treasury);

    // Configure fee tier defaults
    feeAdapter.setFeeSetter(address(this));

    // Set default fee (applied when no tier or pool override is set)
    feeAdapter.setDefaultFee(DEFAULT_FEE_100);

    // Set fee tier defaults
    feeAdapter.setFeeTierDefault(100, DEFAULT_FEE_100);
    feeAdapter.setFeeTierDefault(500, DEFAULT_FEE_500);
    feeAdapter.setFeeTierDefault(3000, DEFAULT_FEE_3000);
    feeAdapter.setFeeTierDefault(10_000, DEFAULT_FEE_10000);

    // Store fee tiers
    feeAdapter.storeFeeTier(100);
    feeAdapter.storeFeeTier(500);
    feeAdapter.storeFeeTier(3000);
    feeAdapter.storeFeeTier(10_000);

    // Transfer feeSetter and ownership to our admin Safe
    feeAdapter.setFeeSetter(_owner);
    feeAdapter.transferOwnership(_owner);

    V3_OPEN_FEE_ADAPTER = IV3OpenFeeAdapter(address(feeAdapter));
  }
}
