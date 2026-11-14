// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.20;

import "./loans/IMultiSourceLoan.sol";

/// @title Liquidates Collateral for Defaulted Loans using English Auctions.
/// @author Florida St
/// @notice It liquidates collateral corresponding to defaulted loans
///         and sends back the proceeds to the loan contract for distribution.
interface IAuctionLoanLiquidator {
    /// @notice The auction struct.
    /// @param loanAddress The loan contract address.
    /// @param loanId The loan id.
    /// @param highestBid The highest bid.
    /// @param triggerFee The trigger fee.
    /// @param minBid The minimum bid.
    /// @param highestBidder The highest bidder.
    /// @param duration The auction duration.
    /// @param asset The asset address.
    /// @param startTime The auction start time.
    /// @param originator The address that triggered the liquidation.
    /// @param lastBidTime The last bid time.
    /// @param loanHash Hash of the Loan struct at liquidation start; used to validate
    ///                 the caller-supplied `_loan` in settlement flows.
    /// @param buyoutWindow Snapshotted buyout window duration at auction creation time.
    struct Auction {
        address loanAddress;
        uint256 loanId;
        uint256 highestBid;
        uint256 triggerFee;
        uint256 minBid;
        address highestBidder;
        uint96 duration;
        address asset;
        uint96 startTime;
        address originator;
        uint96 lastBidTime;
        bytes32 loanHash;
        uint96 buyoutWindow;
    }

    /// @notice Add a loan contract to the list of accepted contracts.
    /// @param _loanContract The loan contract to be added.
    function addLoanContract(address _loanContract) external;

    /// @notice Remove a loan contract from the list of accepted contracts.
    /// @param _loanContract The loan contract to be removed.
    function removeLoanContract(address _loanContract) external;

    /// @return The loan contracts that are accepted by this liquidator.
    function getValidLoanContracts() external view returns (address[] memory);

    /// @notice Update liquidation distributor.
    /// @param _liquidationDistributor The new liquidation distributor.
    function updateLiquidationDistributor(address _liquidationDistributor) external;

    /// @return liquidationDistributor The liquidation distributor address.
    function getLiquidationDistributor() external view returns (address);

    /// @notice Called by the owner to update the trigger fee.
    /// @param triggerFee The new trigger fee.
    function updateTriggerFee(uint256 triggerFee) external;

    /// @return triggerFee The trigger fee.
    function getTriggerFee() external view returns (uint256);

    /// @notice When a bid is placed, the contract takes possesion of the bid, and
    ///         if there was a previous bid, it attempts to return that capital to the
    ///         original bidder immediately. If the transfer fails (e.g. token blacklist),
    ///         the refund is stored and the outbid bidder must claim it via claimRefund.
    /// @param _contract The nft contract address.
    /// @param _tokenId The nft id.
    /// @param _auction The auction struct.
    /// @param _bid The bid amount.
    /// @return auction The updated auction struct.
    function placeBid(address _contract, uint256 _tokenId, Auction memory _auction, uint256 _bid)
        external
        returns (Auction memory);

    /// @notice On settlement, the NFT is sent to the highest bidder.
    ///         Calls loan liquidated for accounting purposes.
    /// @param _auction The auction struct.
    /// @param _loan The loan struct.
    function settleAuction(Auction calldata _auction, IMultiSourceLoan.Loan calldata _loan) external;

    /// @notice The contract has hashes of all auctions to save space (not the actual struct)
    /// @param _contract The nft contract address.
    /// @param _tokenId The nft id.
    /// @return auctionHash The auction hash.
    function getAuctionHash(address _contract, uint256 _tokenId) external view returns (bytes32);

    /// @notice Claims the pending bid refund for the caller.
    ///         Uses pull-over-push to avoid DoS when a token blacklists a previous bidder.
    /// @param _token The token address to claim.
    function claimRefund(address _token) external;

    /// @notice Returns the pending refund amount for a given bidder and token.
    /// @param _bidder The bidder address.
    /// @param _token The token address.
    /// @return The pending refund amount.
    function getPendingRefunds(address _bidder, address _token) external view returns (uint256);

    /// @notice Set the minimum bid cap for a given currency.
    ///         When an auction is created the effective minBid is
    ///         min(currencyMinBid, loanDerivedMinBid) so this acts as
    ///         an upper-bound on reserve preventing principal-inflation attacks.
    /// @param _currency The currency address.
    /// @param _minBid The minimum bid cap for the currency.
    function setMinBidForCurrency(address _currency, uint256 _minBid) external;

    /// @notice Get the minimum bid cap for a given currency.
    /// @param _currency The currency address.
    /// @return minBid The minimum bid cap for the currency.
    function getMinBidForCurrency(address _currency) external view returns (uint256);

    /// @notice Called by the owner to cancel an expired auction that received no bids.
    ///         Rescues the locked NFT (sent to owner) and clears the auction entry.
    /// @param _auction The auction struct.
    /// @param _loan The loan struct.
    function cancelAuction(Auction calldata _auction, IMultiSourceLoan.Loan calldata _loan) external;
}
