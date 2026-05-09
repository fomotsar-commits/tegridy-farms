// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol"; // AUDIT FIX (pass-8): EIP170-01 split

/// @title PASS7-LENDING-02 — TegridyLending.repayLoan outbound silent-no-op
///
/// @notice Sibling site to PASS7-LENDING-01. The pass-6 LD-NEW-H2 fix added
///         `_safeOutboundTransfer` to TegridyNFTLending.repayLoan / claimDefault
///         so a silent-no-op `transferFrom(this, recipient, tokenId)` settles the
///         loan AND seeds `stuckCollateralRecipient` for recovery.
///
///         TegridyLending.repayLoan (line 902) issues
///         `staking.transferFrom(address(this), borrower, tokenId)` with NO
///         post-condition `ownerOf` check and NO recovery map. A whitelisted
///         staking-shaped contract that no-ops transferFrom on the OUTBOUND
///         leg causes:
///           1. borrower pays principal + interest to lending
///           2. lending sends lender their cut, treasury its fee
///           3. `staking.transferFrom(this, borrower, tokenId)` silently no-ops
///           4. loan.repaid = true (already CEI'd before the transfer)
///           5. NFT stays escrowed at lending FOREVER
///         The borrower has paid in full but cannot recover the staking
///         position — there is NO `stuckCollateralRecipient` mapping on
///         TegridyLending, NO `claimStuckCollateral` function, NO admin
///         sweep for stuck NFTs.
///
///         Symmetric severity to PASS7-LENDING-01 (HIGH) and to LD-NEW-H2 on
///         the NFT side. The threat model is identical: a
///         governance-whitelisted but later-discovered-malicious staking
///         contract. The architectural defense (post-condition check +
///         stuck-recovery map) was applied to NFTLending but not to
///         TegridyLending.

contract PASS7_LENDING_02_MockToweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract PASS7_LENDING_02_MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract PASS7_LENDING_02_MockPair {
    address public immutable token0;
    address public immutable token1;
    constructor(address _t0, address _t1) { token0 = _t0; token1 = _t1; }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (uint112(1e24), uint112(1e21), uint32(block.timestamp));
    }
}

contract PASS7_LENDING_02_MockTWAP {
    struct Observation {
        uint32 timestamp;
        bool bypassed;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }
    function consult(address, address, uint256 amountIn, uint256) external pure returns (uint256) {
        return amountIn / 1000;
    }
    function getLatestObservation(address) external view returns (Observation memory o) {
        o.timestamp = uint32(block.timestamp);
    }
    function lastBypassUsed(address) external pure returns (uint256) { return 0; }
}

/// @notice Adversarial staking-shaped collateral whose `transferFrom`
///         silently no-ops only on the OUTBOUND leg (from = lending). The
///         INBOUND leg succeeds normally so the loan can open and settle
///         the money flow before the NFT-return leg is exercised.
contract PASS7_LENDING_02_OutboundNoOpStaking is ERC721 {
    uint256 private _id = 1;
    address public lending;
    bool public outboundNoop;

    constructor() ERC721("OutNoOp", "ONO") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
    function setLending(address _lending) external { lending = _lending; }
    function arm(bool on) external { outboundNoop = on; }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (outboundNoop && from == lending) {
            return; // silent no-op on outgoing-from-lending only
        }
        super.transferFrom(from, to, tokenId);
    }

    // ─── ITegridyStaking surface required by TegridyLending ──────────────

    function getPosition(uint256)
        external
        view
        returns (
            uint256 amount,
            uint256 boostBps,
            uint256 lockEnd,
            uint256 lockDuration,
            bool autoMaxLock,
            bool canWithdraw
        )
    {
        return (
            1_000_000 ether,
            10_000,
            block.timestamp + 365 days,
            365 days,
            false,
            true
        );
    }
    function unsettledRewards(address) external pure returns (uint256) { return 0; }
    function claimUnsettled() external pure {}
    function claimUnsettledForTokenId(uint256, address) external pure returns (uint256) { return 0; }
    /// @notice PASS7-LENDING-03 FIX: read by acceptOffer snapshot.
    function unsettledRewardsByTokenId(uint256) external pure returns (uint256) { return 0; }
}

contract PASS7_LENDING_02_RepayLoanNoOpTest is Test {
    PASS7_LENDING_02_MockToweli toweli;
    PASS7_LENDING_02_MockWETH weth;
    PASS7_LENDING_02_MockPair pair;
    PASS7_LENDING_02_MockTWAP twap;
    PASS7_LENDING_02_OutboundNoOpStaking malStaking;
    TegridyLending lending;
    TegridyLendingAdmin lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // lender
    address bob = makeAddr("bob");     // borrower

    uint256 bobTokenId;

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        vm.warp(1_700_000_000);

        toweli = new PASS7_LENDING_02_MockToweli();
        weth = new PASS7_LENDING_02_MockWETH();
        pair = new PASS7_LENDING_02_MockPair(address(toweli), address(weth));
        twap = new PASS7_LENDING_02_MockTWAP();
        malStaking = new PASS7_LENDING_02_OutboundNoOpStaking();

        lending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(pair),
            address(twap),
            address(0)
        );

        malStaking.setLending(address(lending));

        // AUDIT FIX (pass-8): EIP170-01 split — wire admin sister.
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        lendingAdmin.proposeAcceptedCollateral(address(malStaking), true);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();

        bobTokenId = malStaking.mint(bob);
        vm.prank(bob);
        malStaking.approve(address(lending), bobTokenId);

        vm.deal(alice, 100 ether);
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-LENDING-02 fix.
    ///         repayLoan now wraps the outbound staking.transferFrom in
    ///         `_safeOutboundTransferStaking` which detects the no-op via
    ///         post-`ownerOf` and records `stuckCollateralRecipient[loanId] =
    ///         borrower`. Borrower can then recover the NFT via
    ///         `claimStuckCollateral(loanId)` once the staking contract
    ///         becomes honest. Lender still gets paid; loan still marked
    ///         repaid. Sister to TegridyNFTLending L743+L721.
    function test_PASS7_LENDING_02_repayLoan_silentNoOpOutbound_loses_NFT_no_recovery() public {
        vm.prank(alice);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(malStaking), 10 ether, 0
        );

        vm.prank(bob);
        uint256 loanId = lending.acceptOffer(offerId, bobTokenId);

        assertEq(malStaking.ownerOf(bobTokenId), address(lending), "NFT escrowed at lending");
        skip(2 days);

        // Arm silent no-op for outbound. Models malicious staking contract.
        malStaking.arm(true);

        uint256 repayAmount = lending.getRepaymentAmount(loanId) + 0.01 ether;
        vm.deal(bob, repayAmount);
        uint256 aliceBefore = alice.balance;

        // Bob repays. The fix detects the no-op via post-ownerOf, sets
        // stuckCollateralRecipient[loanId] = bob, emits CollateralStuck.
        // Loan still marked repaid; lender still paid (CEI is preserved).
        vm.prank(bob);
        lending.repayLoan{value: repayAmount}(loanId);

        assertGt(alice.balance, aliceBefore, "lender received principal + interest");
        (,,,, , , , , bool repaid, , ) = lending.getLoan(loanId);
        assertTrue(repaid, "loan marked repaid");

        // FIX: stuckCollateralRecipient is now populated for bob to recover.
        assertEq(
            lending.stuckCollateralRecipient(loanId),
            bob,
            "FIX: bob recorded as stuck-collateral recipient"
        );

        // NFT is still at lending (no-op didn't move it).
        assertEq(malStaking.ownerOf(bobTokenId), address(lending), "NFT still at lending");

        // Mute the no-op (model: staking contract becomes honest later).
        malStaking.arm(false);

        // FIX: bob recovers the NFT via the new claimStuckCollateral function.
        vm.prank(bob);
        lending.claimStuckCollateral(loanId);

        assertEq(malStaking.ownerOf(bobTokenId), bob, "FIX: bob recovered the NFT");
        assertEq(lending.stuckCollateralRecipient(loanId), address(0), "FIX: mapping cleared on success");

        emit log_string("PASS7-LENDING-02 FIX VALIDATED: stuck-collateral recovery scaffolding works");
    }
}
