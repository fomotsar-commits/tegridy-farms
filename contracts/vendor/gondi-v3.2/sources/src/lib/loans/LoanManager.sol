// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

import "@openzeppelin/utils/structs/EnumerableSet.sol";

import "../../interfaces/loans/ILoanManager.sol";
import "../../interfaces/pools/IPoolOfferHandler.sol";
import "../InputChecker.sol";
import "../utils/TwoStepOwned.sol";

/// TODO: Documentation
abstract contract LoanManager is ILoanManager, TwoStepOwned {
    using InputChecker for address;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Time to wait before a new offerHandler can be set.
    uint256 public immutable UPDATE_WAITING_TIME;

    /// @notice Set of accepted callers.
    EnumerableSet.AddressSet internal _acceptedCallers;
    /// @dev Keep this in a separate variable as well since we need the subset of loan contracts
    /// within acceptedCallers. Alternatively we could save this in a single struct but keep it
    /// this way for simplicity as we can use EnumerableSet.
    mapping(address => bool) internal _isLoanContract;
    /// @notice OfferHandler contract
    address public immutable getOfferHandler;

    /// @notice Proposed accepted callers
    ProposedCaller public getProposedCaller;
    /// @notice Time when the proposed accepted callers were set.
    uint256 public getProposedCallerSetTime;

    event CallerRequested(ProposedCaller caller);
    event CallerAdded(ProposedCaller caller);

    error CallerNotAccepted();
    error InvalidCallerError();

    constructor(address _owner, address _offerHandler, uint256 _updateWaitingTime)
        TwoStepOwned(_owner, _updateWaitingTime)
    {
        UPDATE_WAITING_TIME = _updateWaitingTime;

        getOfferHandler = _offerHandler;
    }

    /// @notice First step in d a caller to the accepted callers list. Can be a Loan Contract or Liquidator.
    /// @param caller The callers to add.
    function requestAddCaller(ILoanManager.ProposedCaller calldata caller) external onlyOwner {
        getProposedCaller = caller;
        getProposedCallerSetTime = block.timestamp;

        emit CallerRequested(caller);
    }

    /// @notice Second step in d a caller to the accepted callers list. Can be a Loan Contract or Liquidator.
    /// @dev Given repayments, we don't allow callers to be removed.
    /// @param caller The caller to add.
    function addCaller(ProposedCaller calldata caller) external onlyOwner {
        if (getProposedCallerSetTime + UPDATE_WAITING_TIME > block.timestamp) {
            revert TooSoonError();
        }

        ProposedCaller memory proposedCaller = getProposedCaller;
        if (proposedCaller.caller != caller.caller || proposedCaller.isLoanContract != caller.isLoanContract) {
            revert InvalidInputError();
        }

        _acceptedCallers.add(caller.caller);
        _isLoanContract[caller.caller] = caller.isLoanContract;

        afterCallerAdded(caller.caller);

        emit CallerAdded(caller);
    }

    /// @notice Check if a caller is accepted.
    /// @param caller The caller to check.
    /// @return Whether the caller is accepted.
    function isCallerAccepted(address caller) external view returns (bool) {
        return _acceptedCallers.contains(caller);
    }

    /// @inheritdoc ILoanManager
    function validateOffer(uint256 tokenId, bytes calldata offer, uint256 protocolFee) external virtual;

    /// @inheritdoc ILoanManager
    function loanRepayment(
        uint256 loanId,
        uint256 principalAmount,
        uint256 apr,
        uint256 accruedInterest,
        uint256 protocolFee,
        uint256 startTime
    ) external virtual;

    /// @inheritdoc ILoanManager
    function loanLiquidation(
        address loanAddress,
        uint256 loanId,
        uint256 principalAmount,
        uint256 apr,
        uint256 accruedInterest,
        uint256 protocolFee,
        uint256 received,
        uint256 startTime
    ) external virtual;

    /// @inheritdoc ILoanManager
    function hasActiveLoans() external view virtual returns (bool);

    /// @notice Perform operations after a caller is added. I.e: ERC20s approvals.
    /// @param caller The caller that was added.
    function afterCallerAdded(address caller) internal virtual;
}
