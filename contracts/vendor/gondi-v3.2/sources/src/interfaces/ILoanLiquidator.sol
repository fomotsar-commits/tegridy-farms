// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import "../interfaces/loans/IMultiSourceLoan.sol";

/// @title Liquidates Collateral for Defaulted Loans
/// @author Florida St
/// @notice It liquidates collateral corresponding to defaulted loans
///         and sends back the proceeds to the loan contract for distribution.
interface ILoanLiquidator {
    /// @notice Given a loan, it takes posession of the NFT and liquidates it.
    /// @param _loanId The loan id.
    /// @param _loan The loan being liquidated. The liquidator hashes it and
    ///              persists the hash so settlement flows can validate the
    ///              caller-supplied loan against on-chain state. Also used to
    ///              inspect tranche lenders at auction creation.
    /// @param _duration The liquidation duration.
    /// @param _minBid The minimum bid.
    /// @param _originator The address that trigger the liquidation.
    /// @return encodedAuction Encoded struct.
    function liquidateLoan(
        uint256 _loanId,
        IMultiSourceLoan.Loan calldata _loan,
        uint96 _duration,
        uint256 _minBid,
        address _originator
    ) external returns (bytes memory);
}
