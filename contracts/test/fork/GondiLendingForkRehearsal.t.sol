// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";
import {
    DeployGondiLendingScript,
    IGondiTwoStepOwned,
    IGondiAddressManager
} from "../../script/DeployGondiLending.s.sol";
import {IMultiSourceLoan} from "../../vendor/gondi-v3.2/sources/src/interfaces/loans/IMultiSourceLoan.sol";
import {IBaseLoan} from "../../vendor/gondi-v3.2/sources/src/interfaces/loans/IBaseLoan.sol";

interface IGondiEip712 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function isOfferCancelled(address lender, uint256 offerId) external view returns (bool);
    function getUsedCapacity(address lender, uint256 offerId) external view returns (uint256);
}

interface IGondiProtocolFee {
    struct ProtocolFee {
        address recipient;
        uint256 fraction;
    }

    function updateProtocolFee(ProtocolFee calldata _newProtocolFee) external;
    function setProtocolFee() external;
    function getProtocolFee() external view returns (ProtocolFee memory);
}

interface ITransferOwnership2Step {
    function transferOwnership() external;
}

interface IMultiSourceLoanView {
    function getCollectionManager() external view returns (address);
    function getCurrencyManager() external view returns (address);
}

contract SafeStandIn {}

// Mainnet-fork rehearsal of the Gondi rebuild: Gondi's v3.2 loan contract and the five
// contracts it needs, deployed by script/DeployGondiLending.s.sol from Gondi's verified
// bytecode, then used the way the site will use it — a lender signs, a real holder borrows,
// repays or defaults. FORK-ONLY: self-skips without ETH_RPC_URL (CI has none). Run:
//   ETH_RPC_URL=https://eth.drpc.org forge test --match-path "test/fork/GondiLendingForkRehearsal.t.sol" -vv
contract GondiLendingForkRehearsal is Test {
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;
    address internal constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address internal constant JBAC = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address internal constant NAKAMIGOS = 0xd774557b647330C91Bf44cfEAB205095f7E6c367;
    address internal constant GNSS = 0xa1De9f93c56C290C48849B1393b09eB616D55dbb;

    // Gondi's EIP-712 types, verbatim from vendor/gondi-v3.2/sources/src/lib/utils/Hash.sol.
    // The contract accepting the signatures below is what proves this copy right.
    bytes32 internal constant VALIDATOR_TYPEHASH = keccak256("OfferValidator(address validator,bytes arguments)");
    bytes32 internal constant LOAN_OFFER_TYPEHASH = keccak256(
        "LoanOffer(uint256 offerId,address lender,uint256 fee,uint256 capacity,address nftCollateralAddress,uint256 nftCollateralTokenId,address principalAddress,uint256 principalAmount,uint256 aprBps,uint256 expirationTime,uint256 duration,uint256 maxSeniorRepayment,OfferValidator[] validators,bool lenderRefinanceDisabled,address borrower)OfferValidator(address validator,bytes arguments)"
    );

    // Not a well-known test key: those (0xA11CE, anvil's) carry EIP-7702 code on real
    // mainnet, and Gondi then checks the signature as a smart wallet's (EIP-1271).
    uint256 internal constant LENDER_KEY = uint256(keccak256("tegridy gondi fork rehearsal: lender"));
    uint256 internal constant PRINCIPAL = 1 ether;
    uint256 internal constant APR_BPS = 1000; // 10% a year
    uint256 internal constant DURATION = 30 days;

    bool internal forked;
    address internal lender;
    address internal deployer = makeAddr("deployer");
    address internal safe;
    DeployGondiLendingScript.Deployed internal d;
    IMultiSourceLoan internal loanContract;

    function setUp() public {
        string memory url = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        safe = address(new SafeStandIn());
        DeployGondiLendingScript script = new DeployGondiLendingScript();
        d = script.runForTest(
            DeployGondiLendingScript.Config({
                multisig: safe, treasury: TREASURY, weth: WETH, protocolFeeBps: script.DEFAULT_PROTOCOL_FEE_BPS()
            }),
            deployer
        );
        loanContract = IMultiSourceLoan(d.loan);

        lender = vm.addr(LENDER_KEY);
        require(lender.code.length == 0, "test lender has code on this chain");
        deal(WETH, lender, 10 ether);
        vm.prank(lender);
        IERC20(WETH).approve(d.loan, type(uint256).max);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ─── Deploy ───────────────────────────────────────────────────────────────

    function test_deploy_isGondisSetup_withOurFeeAndCollections() public onlyFork {
        // runForTest already required every read-back (fee, wiring, Gondi's values, owners).
        IGondiAddressManager collections = IGondiAddressManager(IMultiSourceLoanView(d.loan).getCollectionManager());
        assertTrue(
            collections.isWhitelisted(JBAC) && collections.isWhitelisted(NAKAMIGOS) && collections.isWhitelisted(GNSS)
        );
        assertFalse(collections.isWhitelisted(BAYC), "an unlisted collection is allowed");
        IGondiAddressManager currencies = IGondiAddressManager(IMultiSourceLoanView(d.loan).getCurrencyManager());
        assertTrue(currencies.isWhitelisted(WETH));
        assertFalse(currencies.isWhitelisted(USDC), "a second currency is allowed");
        IGondiProtocolFee.ProtocolFee memory fee = IGondiProtocolFee(d.loan).getProtocolFee();
        assertEq(fee.recipient, TREASURY);
        assertEq(fee.fraction, 500);
    }

    function test_ownership_safeTakesTheLoanContractOnlyAfterTwoDays() public onlyFork {
        vm.prank(safe);
        vm.expectRevert(bytes4(keccak256("TooSoonError()")));
        ITransferOwnership2Step(d.loan).transferOwnership();

        vm.warp(block.timestamp + 2 days);
        vm.prank(safe);
        ITransferOwnership2Step(d.loan).transferOwnership();
        vm.prank(safe);
        ITransferOwnership2Step(d.liquidator).transferOwnership();
        assertEq(IGondiTwoStepOwned(d.loan).owner(), safe);
        assertEq(IGondiTwoStepOwned(d.liquidator).owner(), safe);
    }

    function test_feeChange_needsSevenDaysNotice_andOldLoansKeepTheirRate() public onlyFork {
        (address holder, uint256 tokenId) = _holder(NAKAMIGOS);
        (uint256 loanId, IMultiSourceLoan.Loan memory loan) =
            _borrow(_collectionOffer(1, NAKAMIGOS, 0), holder, tokenId);
        assertEq(loan.protocolFee, 500, "the loan did not lock in 5%");

        vm.prank(deployer);
        IGondiProtocolFee(d.loan)
            .updateProtocolFee(IGondiProtocolFee.ProtocolFee({recipient: TREASURY, fraction: 2000}));
        vm.expectRevert(bytes4(keccak256("TooSoonError()")));
        IGondiProtocolFee(d.loan).setProtocolFee();
        vm.warp(block.timestamp + 7 days);
        IGondiProtocolFee(d.loan).setProtocolFee();
        assertEq(IGondiProtocolFee(d.loan).getProtocolFee().fraction, 2000);

        // The open loan still repays at the rate it started with.
        (, uint256 toTreasury) = _repay(loanId, loan);
        uint256 interest = _interest(PRINCIPAL, 7 days);
        assertEq(toTreasury, _mulDivUp(interest, 500, 10_000), "an open loan's fee changed");
    }

    // ─── Whole-collection offers ──────────────────────────────────────────────

    function test_collectionOffer_aRealHolderBorrowsAndRepays_venueKeeps5PctOfInterest() public onlyFork {
        (address holder, uint256 tokenId) = _holder(NAKAMIGOS);
        IMultiSourceLoan.LoanOffer memory offer = _collectionOffer(1, NAKAMIGOS, 0);
        uint256 holderWethBefore = IERC20(WETH).balanceOf(holder);

        (uint256 loanId, IMultiSourceLoan.Loan memory loan) = _borrow(offer, holder, tokenId);
        assertEq(IERC20(WETH).balanceOf(holder) - holderWethBefore, PRINCIPAL, "borrower did not get the principal");
        assertEq(IERC721(NAKAMIGOS).ownerOf(tokenId), d.loan, "NFT not locked");
        assertEq(loan.nftCollateralTokenId, tokenId, "loan is not on the borrower's pick");

        vm.warp(block.timestamp + 10 days);
        uint256 lenderBefore = IERC20(WETH).balanceOf(lender);
        (uint256 paid, uint256 toTreasury) = _repay(loanId, loan);

        uint256 interest = _interest(PRINCIPAL, 10 days);
        assertEq(paid, PRINCIPAL + interest, "borrower paid more than principal + interest for the days used");
        assertEq(toTreasury, _mulDivUp(interest, 500, 10_000), "venue did not get 5% of the interest");
        assertEq(IERC20(WETH).balanceOf(lender) - lenderBefore, PRINCIPAL + interest - toTreasury, "lender share");
        assertEq(IERC721(NAKAMIGOS).ownerOf(tokenId), holder, "NFT not returned");
    }

    function test_collectionOffer_worksForJungleBayAndGnssToo() public onlyFork {
        (address jbacHolder, uint256 jbacId) = _holder(JBAC);
        _borrow(_collectionOffer(1, JBAC, 0), jbacHolder, jbacId);
        assertEq(IERC721(JBAC).ownerOf(jbacId), d.loan);

        (address gnssHolder, uint256 gnssId) = _holder(GNSS);
        _borrow(_collectionOffer(2, GNSS, 0), gnssHolder, gnssId);
        assertEq(IERC721(GNSS).ownerOf(gnssId), d.loan);
    }

    function test_collectionOffer_isSingleUse_unlessTheLenderSetsCapacity() public onlyFork {
        (address a, uint256 aId) = _holder(NAKAMIGOS);
        (address b, uint256 bId) = _holderAfter(NAKAMIGOS, aId);
        IMultiSourceLoan.LoanOffer memory once = _collectionOffer(1, NAKAMIGOS, 0);
        _borrow(once, a, aId);
        _borrowExpectingRevert(
            once,
            b,
            bId,
            abi.encodeWithSelector(bytes4(keccak256("CancelledOrExecutedOfferError(address,uint256)")), lender, 1)
        );

        // Capacity 2 WETH at 1 WETH a loan: two loans, then full.
        IMultiSourceLoan.LoanOffer memory twice = _collectionOffer(2, NAKAMIGOS, 2 ether);
        _borrow(twice, b, bId);
        assertEq(IGondiEip712(d.loan).getUsedCapacity(lender, 2), 1 ether);
        (address c, uint256 cId) = _holderAfter(NAKAMIGOS, bId);
        _borrow(twice, c, cId);
        (address e, uint256 eId) = _holderAfter(NAKAMIGOS, cId);
        _borrowExpectingRevert(twice, e, eId, abi.encodeWithSelector(bytes4(keccak256("MaxCapacityExceededError()"))));
    }

    function test_cancelledOffer_cannotBeTaken() public onlyFork {
        (address holder, uint256 tokenId) = _holder(NAKAMIGOS);
        IMultiSourceLoan.LoanOffer memory offer = _collectionOffer(7, NAKAMIGOS, 0);
        vm.prank(lender);
        IBaseLoan(d.loan).cancelOffer(7);
        assertTrue(IGondiEip712(d.loan).isOfferCancelled(lender, 7));
        _borrowExpectingRevert(
            offer,
            holder,
            tokenId,
            abi.encodeWithSelector(bytes4(keccak256("CancelledOrExecutedOfferError(address,uint256)")), lender, 7)
        );
    }

    // ─── One-NFT offers, limits ───────────────────────────────────────────────

    function test_specificOffer_takesOnlyThatToken() public onlyFork {
        (address a, uint256 aId) = _holder(NAKAMIGOS);
        (address b, uint256 bId) = _holderAfter(NAKAMIGOS, aId);
        IMultiSourceLoan.LoanOffer memory offer = _specificOffer(3, NAKAMIGOS, aId);
        _borrowExpectingRevert(offer, b, bId, abi.encodeWithSelector(bytes4(keccak256("InvalidCollateralIdError()"))));
        _borrow(offer, a, aId);
        assertEq(IERC721(NAKAMIGOS).ownerOf(aId), d.loan);
    }

    function test_unlistedCollection_andNonWethCurrency_areRefused() public onlyFork {
        (address apeHolder, uint256 apeId) = _holder(BAYC);
        _borrowExpectingRevert(
            _collectionOffer(4, BAYC, 0),
            apeHolder,
            apeId,
            abi.encodeWithSelector(bytes4(keccak256("CollectionNotWhitelistedError()")))
        );

        (address holder, uint256 tokenId) = _holder(NAKAMIGOS);
        IMultiSourceLoan.LoanOffer memory usdcOffer = _collectionOffer(5, NAKAMIGOS, 0);
        usdcOffer.principalAddress = USDC;
        usdcOffer.principalAmount = 1000e6;
        _borrowExpectingRevert(
            usdcOffer, holder, tokenId, abi.encodeWithSelector(bytes4(keccak256("CurrencyNotWhitelistedError()")))
        );
    }

    // ─── Default ──────────────────────────────────────────────────────────────

    function test_default_singleLender_takesTheNftDirectly_noAuction() public onlyFork {
        (address holder, uint256 tokenId) = _holder(NAKAMIGOS);
        (uint256 loanId, IMultiSourceLoan.Loan memory loan) =
            _borrow(_collectionOffer(1, NAKAMIGOS, 0), holder, tokenId);

        vm.expectRevert(
            abi.encodeWithSelector(bytes4(keccak256("LoanNotDueError(uint256)")), loan.startTime + loan.duration)
        );
        loanContract.liquidateLoan(loanId, loan);

        vm.warp(loan.startTime + loan.duration + 1);
        vm.prank(makeAddr("anyone"));
        loanContract.liquidateLoan(loanId, loan);
        assertEq(IERC721(NAKAMIGOS).ownerOf(tokenId), lender, "lender did not get the NFT");
        assertEq(loanContract.getLoanHash(loanId), bytes32(0), "loan not closed");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev The approval and the prank stay outside the reverting call, so a revert leaves
    ///      no prank behind.
    function _borrowExpectingRevert(
        IMultiSourceLoan.LoanOffer memory offer,
        address holder,
        uint256 tokenId,
        bytes memory revertData
    ) internal {
        IMultiSourceLoan.LoanExecutionData memory data = _prepare(offer, holder, tokenId);
        vm.expectRevert(revertData);
        vm.prank(holder);
        loanContract.emitLoan(data);
    }

    function _collectionOffer(uint256 offerId, address collection, uint256 capacity)
        internal
        view
        returns (IMultiSourceLoan.LoanOffer memory offer)
    {
        offer = _specificOffer(offerId, collection, 0);
        // Gondi's whole-collection offer: token 0 plus one empty validator.
        offer.validators = new IBaseLoan.OfferValidator[](1);
        offer.capacity = capacity;
    }

    function _specificOffer(uint256 offerId, address collection, uint256 tokenId)
        internal
        view
        returns (IMultiSourceLoan.LoanOffer memory offer)
    {
        offer.offerId = offerId;
        offer.lender = lender;
        offer.nftCollateralAddress = collection;
        offer.nftCollateralTokenId = tokenId;
        offer.principalAddress = WETH;
        offer.principalAmount = PRINCIPAL;
        offer.aprBps = APR_BPS;
        offer.expirationTime = block.timestamp + 1 days;
        offer.duration = DURATION;
    }

    function _borrow(IMultiSourceLoan.LoanOffer memory offer, address holder, uint256 tokenId)
        internal
        returns (uint256 loanId, IMultiSourceLoan.Loan memory loan)
    {
        IMultiSourceLoan.LoanExecutionData memory data = _prepare(offer, holder, tokenId);
        vm.prank(holder);
        (loanId, loan) = loanContract.emitLoan(data);
    }

    /// @dev The borrower approves the NFT and builds the call the site will send: one offer,
    ///      the borrower's own token, the principal paid to the borrower.
    function _prepare(IMultiSourceLoan.LoanOffer memory offer, address holder, uint256 tokenId)
        internal
        returns (IMultiSourceLoan.LoanExecutionData memory data)
    {
        IMultiSourceLoan.OfferExecution[] memory exec = new IMultiSourceLoan.OfferExecution[](1);
        exec[0] = IMultiSourceLoan.OfferExecution({
            offer: offer, amount: offer.principalAmount, lenderOfferSignature: _sign(offer)
        });
        data = IMultiSourceLoan.LoanExecutionData({
            executionData: IMultiSourceLoan.ExecutionData({
                offerExecution: exec,
                loanId: 0,
                nftCollateralAddress: offer.nftCollateralAddress,
                tokenId: tokenId,
                duration: offer.duration,
                expirationTime: block.timestamp + 1 hours,
                principalReceiver: holder,
                callbackData: ""
            }),
            borrower: holder,
            borrowerOfferSignature: ""
        });
        vm.prank(holder);
        IERC721(offer.nftCollateralAddress).approve(d.loan, tokenId);
    }

    function _repay(uint256 loanId, IMultiSourceLoan.Loan memory loan)
        internal
        returns (uint256 paid, uint256 toTreasury)
    {
        deal(WETH, loan.borrower, IERC20(WETH).balanceOf(loan.borrower) + 1 ether); // covers the interest
        uint256 borrowerBefore = IERC20(WETH).balanceOf(loan.borrower);
        uint256 treasuryBefore = IERC20(WETH).balanceOf(TREASURY);
        vm.startPrank(loan.borrower);
        IERC20(WETH).approve(d.loan, type(uint256).max);
        loanContract.repayLoan(
            IMultiSourceLoan.LoanRepaymentData({
                data: IMultiSourceLoan.SignableRepaymentData({loanId: loanId, callbackData: "", shouldDelegate: false}),
                loan: loan,
                borrowerSignature: ""
            })
        );
        vm.stopPrank();
        paid = borrowerBefore - IERC20(WETH).balanceOf(loan.borrower);
        toTreasury = IERC20(WETH).balanceOf(TREASURY) - treasuryBefore;
    }

    function _sign(IMultiSourceLoan.LoanOffer memory offer) internal view returns (bytes memory) {
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IGondiEip712(d.loan).DOMAIN_SEPARATOR(), _offerHash(offer)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LENDER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _offerHash(IMultiSourceLoan.LoanOffer memory o) internal pure returns (bytes32) {
        bytes memory validators;
        for (uint256 i; i < o.validators.length; ++i) {
            validators = abi.encodePacked(
                validators,
                keccak256(
                    abi.encode(VALIDATOR_TYPEHASH, o.validators[i].validator, keccak256(o.validators[i].arguments))
                )
            );
        }
        // All static words, so two encodes concatenated equal one.
        return keccak256(
            bytes.concat(
                abi.encode(
                    LOAN_OFFER_TYPEHASH,
                    o.offerId,
                    o.lender,
                    o.fee,
                    o.capacity,
                    o.nftCollateralAddress,
                    o.nftCollateralTokenId,
                    o.principalAddress
                ),
                abi.encode(
                    o.principalAmount,
                    o.aprBps,
                    o.expirationTime,
                    o.duration,
                    o.maxSeniorRepayment,
                    keccak256(validators),
                    o.lenderRefinanceDisabled,
                    o.borrower
                )
            )
        );
    }

    // Gondi's Interest._getInterest: amount * apr * seconds / (10000 * 365 days), rounded up.
    function _interest(uint256 amount, uint256 elapsed) internal pure returns (uint256) {
        return _mulDivUp(amount, APR_BPS * elapsed, 10_000 * 365 days);
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256) {
        return (x * y + denominator - 1) / denominator;
    }

    /// @dev First token id from 1 whose owner is a plain wallet (not a vault or a loan contract).
    function _holder(address collection) internal view returns (address, uint256) {
        return _holderAfter(collection, 0);
    }

    function _holderAfter(address collection, uint256 afterId) internal view returns (address owner, uint256 tokenId) {
        for (tokenId = afterId + 1; tokenId < afterId + 200; ++tokenId) {
            try IERC721(collection).ownerOf(tokenId) returns (address o) {
                if (o != address(0) && o.code.length == 0 && o != lender) return (o, tokenId);
            } catch {}
        }
        revert("no wallet-held token found");
    }
}

