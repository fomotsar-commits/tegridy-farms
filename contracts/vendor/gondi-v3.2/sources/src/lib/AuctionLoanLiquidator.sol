// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

import "@openzeppelin/utils/structs/EnumerableSet.sol";
import "@solmate/utils/FixedPointMathLib.sol";
import "@solmate/utils/ReentrancyGuard.sol";
import "@solmate/utils/SafeTransferLib.sol";
import "@solmate/tokens/ERC20.sol";
import "@solmate/tokens/ERC721.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import "../interfaces/ILiquidationDistributor.sol";
import "../interfaces/IAuctionLoanLiquidator.sol";
import "../interfaces/ILoanLiquidator.sol";
import "../interfaces/loans/IMultiSourceLoan.sol";
import "./AddressManager.sol";
import "./InputChecker.sol";
import "./utils/TwoStepOwned.sol";
import "./utils/Hash.sol";

/// @title Auction Loan Liquidator
/// @author Florida St
/// @notice Receives an NFT to be auctioned when a loan defaults.
///         Mainly taking Zora's implementation.
contract AuctionLoanLiquidator is
    ERC721TokenReceiver,
    IAuctionLoanLiquidator,
    ILoanLiquidator,
    TwoStepOwned,
    ReentrancyGuard
{
    using EnumerableSet for EnumerableSet.AddressSet;
    using FixedPointMathLib for uint256;
    using Hash for Auction;
    using Hash for IMultiSourceLoan.Loan;
    using InputChecker for address;
    using SafeTransferLib for ERC20;

    /// @notice The maximum trigger fee expressed in bps.
    uint256 public constant MAX_TRIGGER_FEE = 500;
    /// @notice The minimum increment expressed in bps to become highest bid.
    uint256 public constant MIN_INCREMENT_BPS = 500;
    /// @notice BPS definition.
    uint256 internal constant _BPS = 10000;
    /// @notice The minimum time that must pass after the last bid before the auction can be settled.
    uint96 private constant _MIN_NO_ACTION_MARGIN = 10 minutes;
    /// @notice Max extension for an auction.
    uint96 public immutable getMaxExtension;
    /// @notice The Liquidation Distributor.
    ILiquidationDistributor private _liquidationDistributor;
    /// @notice The currency manager.
    AddressManager private immutable _currencyManager;
    /// @notice The collection manager.
    AddressManager private immutable _collectionManager;
    /// @notice The trigger fee.
    uint256 private _triggerFee;
    /// @notice The valid loan contracts.
    EnumerableSet.AddressSet private _validLoanContracts;

    mapping(address nftAddress => mapping(uint256 tokenId => bytes32 auctionEncoded)) internal _auctions;

    /// @notice Per-currency min bid cap. Acts as an upper-bound on auction reserve
    ///         to prevent principal-inflation attacks.
    mapping(address currency => uint256 minBid) private _minBidByCurrency;

    /// @notice Pending bid refunds for outbid bidders (pull-over-push pattern).
    mapping(address bidder => mapping(address token => uint256 amount)) private _pendingRefunds;

    event LoanContractAdded(address loan);

    event LoanContractRemoved(address loan);

    event LiquidationDistributorUpdated(address liquidationDistributor);

    event LoanLiquidationStarted(address collection, uint256 tokenId, Auction auction);

    event BidPlaced(
        address collection, uint256 tokenId, address newBidder, uint256 bid, address loanAddress, uint256 loanId
    );

    event AuctionSettled(
        address loanContract,
        uint256 loanId,
        address collection,
        uint256 tokenId,
        address asset,
        uint256 proceeds,
        address settler,
        uint256 triggerFee
    );

    event TriggerFeeUpdated(uint256 triggerFee);

    event BidRefundPending(address indexed bidder, address indexed asset, uint256 amount);

    event BidRefundWithdrawn(address indexed bidder, address indexed asset, uint256 amount);

    error InvalidHashAuctionError();

    error InvalidLoanHashError();

    error NFTNotOwnedError(address _owner);

    error MinBidError(uint256 _minBid);

    error AuctionOverError(uint96 _expiration);

    error AuctionNotOverError(uint96 _expiration);

    error AuctionAlreadyInProgressError();

    error NoBidsError();

    error CurrencyNotWhitelistedError();

    error CollectionNotWhitelistedError();

    error LoanNotAcceptedError(address _loan);

    error InvalidTriggerFee(uint256 triggerFee);

    error CouldNotModifyValidLoansError();

    error MinBidForCurrencyNotSetError(address currency);

    error AuctionNotExpiredError(uint96 expiration);

    error AuctionHasBidsError();

    event MinBidForCurrencyUpdated(address currency, uint256 minBid);

    event AuctionCancelled(
        address loanContract, uint256 loanId, address collection, uint256 tokenId, address recipient
    );

    /// @param liquidationDistributor Contract that distributes the proceeds of an auction.
    /// @param currencyManager The address manager for currencies (check whitelisting).
    /// @param collectionManager The address manager for collections (check whitelisting).
    /// @param triggerFee The trigger fee. Given to the originator/settler of an auction. Expressed in bps.
    /// @param maxExtension The maximum extension for an auction.
    /// @param minWaitTime The minimum time to wait before a new owner can be confirmed.
    constructor(
        address liquidationDistributor,
        address currencyManager,
        address collectionManager,
        uint256 triggerFee,
        uint96 maxExtension,
        uint256 minWaitTime
    ) TwoStepOwned(msg.sender, minWaitTime) {
        liquidationDistributor.checkNotZero();
        currencyManager.checkNotZero();
        collectionManager.checkNotZero();

        _liquidationDistributor = ILiquidationDistributor(liquidationDistributor);
        _currencyManager = AddressManager(currencyManager);
        _collectionManager = AddressManager(collectionManager);
        _updateTriggerFee(triggerFee);
        getMaxExtension = maxExtension;
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function addLoanContract(address _loanContract) external onlyOwner {
        if (!_validLoanContracts.add(_loanContract)) {
            revert CouldNotModifyValidLoansError();
        }

        emit LoanContractAdded(_loanContract);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function removeLoanContract(address _loanContract) external onlyOwner {
        if (!_validLoanContracts.remove(_loanContract)) {
            revert CouldNotModifyValidLoansError();
        }

        emit LoanContractRemoved(_loanContract);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function getValidLoanContracts() external view returns (address[] memory) {
        return _validLoanContracts.values();
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function updateLiquidationDistributor(address __liquidationDistributor) external onlyOwner {
        __liquidationDistributor.checkNotZero();

        _liquidationDistributor = ILiquidationDistributor(__liquidationDistributor);

        emit LiquidationDistributorUpdated(__liquidationDistributor);
    }

    /// @return The liquidation distributor address.
    function getLiquidationDistributor() external view returns (address) {
        return address(_liquidationDistributor);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function updateTriggerFee(uint256 triggerFee) external onlyOwner {
        _updateTriggerFee(triggerFee);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function getTriggerFee() external view returns (uint256) {
        return _triggerFee;
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function setMinBidForCurrency(address _currency, uint256 _minBid) external onlyOwner {
        _minBidByCurrency[_currency] = _minBid;

        emit MinBidForCurrencyUpdated(_currency, _minBid);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function getMinBidForCurrency(address _currency) external view returns (uint256) {
        return _minBidByCurrency[_currency];
    }

    /// @inheritdoc ILoanLiquidator
    function liquidateLoan(
        uint256 _loanId,
        IMultiSourceLoan.Loan calldata _loan,
        uint96 _duration,
        uint256 _minBid,
        address _originator
    ) external override nonReentrant returns (bytes memory) {
        address _nftAddress = _loan.nftCollateralAddress;
        uint256 _tokenId = _loan.nftCollateralTokenId;
        address _asset = _loan.principalAddress;

        address _owner = ERC721(_nftAddress).ownerOf(_tokenId);
        if (_owner != address(this)) {
            revert NFTNotOwnedError(_owner);
        }

        if (!_validLoanContracts.contains(msg.sender)) {
            revert LoanNotAcceptedError(msg.sender);
        }

        if (_auctions[_nftAddress][_tokenId] != bytes32(0)) {
            revert AuctionAlreadyInProgressError();
        }

        if (_minBidByCurrency[_asset] == 0) {
            revert MinBidForCurrencyNotSetError(_asset);
        }

        uint96 currentTimestamp = uint96(block.timestamp);
        Auction memory auction = Auction(
            msg.sender,
            _loanId,
            0,
            _triggerFee,
            _minBid,
            address(0),
            _duration,
            _asset,
            currentTimestamp,
            _originator,
            currentTimestamp,
            _loan.hash(),
            _getBuyoutWindow(_loan)
        );
        _auctions[_nftAddress][_tokenId] = auction.hash();
        emit LoanLiquidationStarted(_nftAddress, _tokenId, auction);

        return abi.encode(auction);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function placeBid(address _nftAddress, uint256 _tokenId, Auction memory _auction, uint256 _bid)
        external
        nonReentrant
        returns (Auction memory)
    {
        _placeBidChecks(_nftAddress, _tokenId, _auction, _bid);

        uint256 currentHighestBid = _auction.highestBid;

        uint256 currentTime = block.timestamp;
        uint96 expiration = _auction.startTime + _auction.duration;
        uint96 withMargin = _auction.lastBidTime + _MIN_NO_ACTION_MARGIN;
        uint96 maxExtension = expiration + getMaxExtension;
        uint96 minWithMarginMaxExtension = withMargin > maxExtension ? maxExtension : withMargin;
        /// @dev max (min(withMargin, maxExtension), expiration)
        uint96 max = minWithMarginMaxExtension > expiration ? minWithMarginMaxExtension : expiration;
        if (max <= currentTime && currentHighestBid != 0) {
            revert AuctionOverError(max);
        }

        ERC20 token = ERC20(_auction.asset);
        if (currentHighestBid != 0) {
            // Optimistic push: try to refund the outbid bidder inline.
            // If the transfer reverts (e.g. USDC/USDT blacklist) or returns false,
            // fall back to pull-over-push so the auction is never blocked.
            bool ok = SafeERC20.trySafeTransfer(IERC20(_auction.asset), _auction.highestBidder, currentHighestBid);
            if (!ok) {
                _pendingRefunds[_auction.highestBidder][_auction.asset] += currentHighestBid;
                emit BidRefundPending(_auction.highestBidder, _auction.asset, currentHighestBid);
            }
        }

        address newBidder = msg.sender;
        token.safeTransferFrom(newBidder, address(this), _bid);

        _auction.highestBidder = newBidder;
        _auction.highestBid = _bid;
        _auction.lastBidTime = uint96(currentTime);

        _auctions[_nftAddress][_tokenId] = _auction.hash();

        emit BidPlaced(_nftAddress, _tokenId, newBidder, _bid, _auction.loanAddress, _auction.loanId);
        return _auction;
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function settleAuction(Auction calldata _auction, IMultiSourceLoan.Loan calldata _loan) external nonReentrant {
        address collateralAddress = _loan.nftCollateralAddress;
        uint256 tokenId = _loan.nftCollateralTokenId;
        _checkAuction(collateralAddress, tokenId, _auction);
        _checkLoanHash(_auction, _loan);

        if (_auction.highestBidder == address(0)) {
            revert NoBidsError();
        }

        uint256 currentTime = block.timestamp;
        uint96 expiration = _auction.startTime + _auction.duration;
        uint96 withMargin = _auction.lastBidTime + _MIN_NO_ACTION_MARGIN;
        uint96 maxExtension = expiration + getMaxExtension;
        if ((withMargin > currentTime && currentTime < maxExtension) || (currentTime < expiration)) {
            uint96 minWithMarginMaxExtension = withMargin > maxExtension ? maxExtension : withMargin;
            uint96 max = minWithMarginMaxExtension > expiration ? minWithMarginMaxExtension : expiration;
            revert AuctionNotOverError(max);
        }

        ERC721(collateralAddress).transferFrom(address(this), _auction.highestBidder, tokenId);

        uint256 highestBid = _auction.highestBid;
        uint256 triggerFee = highestBid.mulDivDown(_auction.triggerFee, _BPS);
        uint256 proceeds = highestBid - 2 * triggerFee;
        ERC20 asset = ERC20(_auction.asset);

        asset.safeTransfer(_auction.originator, triggerFee);
        asset.safeTransfer(msg.sender, triggerFee);
        asset.approve(address(_liquidationDistributor), proceeds);
        _liquidationDistributor.distribute(_auction.loanAddress, proceeds, _loan);
        emit AuctionSettled(
            _auction.loanAddress,
            _auction.loanId,
            collateralAddress,
            tokenId,
            _auction.asset,
            proceeds,
            msg.sender,
            triggerFee
        );

        /// @dev Save gas + allow for future auctions for the same NFT
        delete _auctions[collateralAddress][tokenId];
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function claimRefund(address _token) external nonReentrant {
        uint256 amount = _pendingRefunds[msg.sender][_token];
        if (amount == 0) {
            return;
        }
        _pendingRefunds[msg.sender][_token] = 0;
        ERC20(_token).safeTransfer(msg.sender, amount);
        emit BidRefundWithdrawn(msg.sender, _token, amount);
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function getPendingRefunds(address _bidder, address _token) external view returns (uint256) {
        return _pendingRefunds[_bidder][_token];
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function cancelAuction(Auction calldata _auction, IMultiSourceLoan.Loan calldata _loan)
        external
        onlyOwner
        nonReentrant
    {
        address collateralAddress = _loan.nftCollateralAddress;
        uint256 tokenId = _loan.nftCollateralTokenId;
        _checkAuction(collateralAddress, tokenId, _auction);
        _checkLoanHash(_auction, _loan);

        if (_auction.highestBidder != address(0)) {
            revert AuctionHasBidsError();
        }

        uint96 expiration = _auction.startTime + _auction.duration;
        if (uint96(block.timestamp) < expiration) {
            revert AuctionNotExpiredError(expiration);
        }

        address recipient = owner;
        ERC721(collateralAddress).transferFrom(address(this), recipient, tokenId);

        emit AuctionCancelled(_auction.loanAddress, _auction.loanId, collateralAddress, tokenId, recipient);

        /// @dev Save gas + allow for future auctions for the same NFT
        delete _auctions[collateralAddress][tokenId];
    }

    /// @inheritdoc IAuctionLoanLiquidator
    function getAuctionHash(address _nftAddress, uint256 _tokenId) external view returns (bytes32) {
        return _auctions[_nftAddress][_tokenId];
    }

    /// @dev check it the auction provided matches the one saved (using hashes)
    function _checkAuction(address _nftAddress, uint256 _tokenId, Auction memory _auction) internal view {
        if (_auctions[_nftAddress][_tokenId] != _auction.hash()) {
            revert InvalidHashAuctionError();
        }
    }

    /// @dev Ensure the caller-supplied loan matches the hash captured at liquidation
    ///      start. Settlement flows rely on `_loan.tranche` for distribution, so without
    ///      this check a caller could forge tranches.
    function _checkLoanHash(Auction memory _auction, IMultiSourceLoan.Loan memory _loan) internal pure {
        if (_loan.hash() != _auction.loanHash) {
            revert InvalidLoanHashError();
        }
    }

    /// @dev Returns the buyout window duration to snapshot into the auction at creation.
    ///      Override in subclasses that implement a buyout mechanism.
    function _getBuyoutWindow(IMultiSourceLoan.Loan calldata) internal view virtual returns (uint96) {
        return 0;
    }

    function _placeBidChecks(address _nftAddress, uint256 _tokenId, Auction memory _auction, uint256 _bid)
        internal
        view
        virtual
    {
        _checkAuction(_nftAddress, _tokenId, _auction);
        uint256 currencyMinBid = _minBidByCurrency[_auction.asset];
        /// @dev Effective min bid is min(auction.minBid, currencyMinBid) to cap
        ///      inflated loan-derived reserves at bid time. Reading the map here
        ///      lets the owner adjust the cap mid-auction if a loan is stuck.
        ///      If currencyMinBid is 0 (unset / zeroed), fall back to auction.minBid
        ///      to avoid locking NFTs in the contract.
        uint256 effectiveMinBid =
            (currencyMinBid != 0 && currencyMinBid < _auction.minBid) ? currencyMinBid : _auction.minBid;
        if ((_bid < effectiveMinBid) || (_auction.highestBid.mulDivDown(_BPS + MIN_INCREMENT_BPS, _BPS) >= _bid)) {
            revert MinBidError(_bid);
        }
    }

    function _updateTriggerFee(uint256 triggerFee) private {
        if (triggerFee > MAX_TRIGGER_FEE) {
            revert InvalidTriggerFee(triggerFee);
        }
        _triggerFee = triggerFee;

        emit TriggerFeeUpdated(triggerFee);
    }
}
