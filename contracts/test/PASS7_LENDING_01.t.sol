// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyLending.sol";

/// @title PASS7-LENDING-01 — TegridyLending.acceptOffer / repayLoan /
///        claimDefaultedCollateral missing the LD-NEW-H2 sibling defense.
///
/// @notice Pass-6 closed LD-NEW-H2 by adding `_safeOutboundTransfer` +
///         `stuckCollateralRecipient` to TegridyNFTLending. The fix wraps
///         every staking-collection `transferFrom(this, recipient, tokenId)`
///         in a post-`ownerOf` check so a silent-no-op malicious collection
///         settles the loan without leaving the NFT permanently stuck.
///
///         The SAME attack surface is also live on TegridyLending — three
///         distinct sites that NEVER post-check the staking-collection
///         transfer:
///
///           1. acceptOffer (L769): inbound staking.transferFrom(msg.sender,
///              this, tokenId). If the staking contract's transferFrom is a
///              silent no-op, the loan record is created (CEI commit), the
///              principal ETH is sent to the borrower, but the NFT stays
///              with the borrower. The lender's principal is gone.
///
///           2. repayLoan (L902): outbound staking.transferFrom(this,
///              borrower, tokenId). Symmetric to NFTLending.repayLoan but
///              missing the silent-no-op detection. NFT permanently stuck
///              in lending; borrower's repay still moves money.
///
///           3. claimDefaultedCollateral (L1007): outbound staking.transferFrom
///              (this, lender, tokenId). Symmetric to NFTLending.claimDefault
///              but missing the silent-no-op detection. NFT permanently
///              stuck; default flag still flips.
///
///         The on-chain accepted-collateral whitelist is governance-gated
///         (48h timelock) and currently lists only TegridyStaking — but the
///         architecture EXPLICITLY allows future staking contract addition.
///         A future migration / version bump that introduces an upgradeable
///         or buggy `transferFrom` reproduces the exact LD-NEW-H2 attack
///         shape on the lending side, with no defense in place.
///
///         Severity rationale: HIGH by direct parity with LD-NEW-H2 (also
///         rated HIGH in pass-6). The whitelist gate is not the defense —
///         the post-condition check is. NFTLending got the check; lending
///         did not. The attack class is "silent no-op transferFrom on a
///         governance-whitelisted collection," which the pass-6 threat
///         model already declared an in-scope HIGH on the NFT side.
///
///         The first sub-test exercises path 1 (acceptOffer principal theft)
///         using a malicious "staking" mock that mirrors the real
///         TegridyStaking interface but no-ops `transferFrom`. The
///         realistic attacker model is a captured-admin or
///         compromised-collection scenario; the vulnerability itself is
///         the missing post-condition.

contract PASS7_LENDING_01_MockToweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract PASS7_LENDING_01_MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract PASS7_LENDING_01_MockPair {
    address public immutable token0;
    address public immutable token1;
    constructor(address _t0, address _t1) { token0 = _t0; token1 = _t1; }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (uint112(1e24), uint112(1e21), uint32(block.timestamp));
    }
}

contract PASS7_LENDING_01_MockTWAP {
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

/// @notice Adversarial "staking-shaped" collateral collection. Conforms to
///         TegridyLending's `ITegridyStaking` interface but `transferFrom` is
///         a SILENT NO-OP — returns success without moving the token. Mirrors
///         the LD-NEW-H2 attack shape on the NFT side.
contract PASS7_LENDING_01_NoOpStaking is ERC721 {
    uint256 private _id = 1;
    bool public inboundNoop;

    constructor() ERC721("NoOpStake", "NSTAKE") {}

    function mint(address to) external returns (uint256) {
        uint256 i = _id++;
        _mint(to, i);
        return i;
    }
    function arm(bool on) external { inboundNoop = on; }

    /// @dev `transferFrom(borrower, lending, tokenId)` silently no-ops while
    ///      armed. Outbound transfers honor the call so the test is focused
    ///      on the principal-theft path (acceptOffer).
    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (inboundNoop) {
            return;
        }
        super.transferFrom(from, to, tokenId);
    }

    // ─── Mock the rest of the ITegridyStaking surface ────────────────────

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
        // Anything > minPositionValue used in the offer + lockEnd far enough
        // out so the LIQUIDATION_GRACE check passes for any reasonable loan.
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

contract PASS7_LENDING_01_AcceptOfferNoOpTest is Test {
    PASS7_LENDING_01_MockToweli toweli;
    PASS7_LENDING_01_MockWETH weth;
    PASS7_LENDING_01_MockPair pair;
    PASS7_LENDING_01_MockTWAP twap;
    PASS7_LENDING_01_NoOpStaking malStaking;
    TegridyLending lending;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // lender — funds principal
    address bob = makeAddr("bob");     // borrower — owns the NoOp staking NFT

    uint256 bobTokenId;

    function setUp() public {
        vm.warp(1_700_000_000);

        toweli = new PASS7_LENDING_01_MockToweli();
        weth = new PASS7_LENDING_01_MockWETH();
        pair = new PASS7_LENDING_01_MockPair(address(toweli), address(weth));
        twap = new PASS7_LENDING_01_MockTWAP();
        malStaking = new PASS7_LENDING_01_NoOpStaking();

        lending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(pair),
            address(twap),
            address(0)
        );

        // Whitelist the malicious "staking" contract via the standard 48h
        // timelock. Models a captured-admin / compromised-collection
        // scenario where governance has been social-engineered to add a
        // hostile collateral type, OR a future-rugged upgrade of an
        // honest one.
        lending.proposeAcceptedCollateral(address(malStaking), true);
        skip(48 hours + 1);
        lending.executeAcceptedCollateral();

        bobTokenId = malStaking.mint(bob);
        vm.prank(bob);
        malStaking.approve(address(lending), bobTokenId);

        vm.deal(alice, 100 ether);
    }

    /// @notice POST-FIX REGRESSION: validates the PASS7-LENDING-01 fix.
    ///         `acceptOffer` now post-condition-checks
    ///         `staking.ownerOf(tokenId) == address(this)` after the inbound
    ///         transferFrom and reverts `CollateralNotEscrowed` if the
    ///         staking contract no-op'd. The lender's principal stays
    ///         escrowed (the entire tx reverts) — no fund loss.
    function test_PASS7_LENDING_01_acceptOffer_silentNoOpInboundDrainsPrincipal() public {
        vm.prank(alice);
        uint256 offerId = lending.createLoanOffer{value: 1 ether}(
            1000, 7 days, address(malStaking), 10 ether, 0
        );

        assertEq(address(lending).balance, 1 ether, "lender principal escrowed");

        // Arm silent no-op on INBOUND transferFrom.
        malStaking.arm(true);

        // PASS7-LENDING-01 FIX VALIDATION: acceptOffer reverts
        // CollateralNotEscrowed because the post-condition check fires.
        vm.prank(bob);
        vm.expectRevert(TegridyLending.CollateralNotEscrowed.selector);
        lending.acceptOffer(offerId, bobTokenId);

        // Lender's principal still escrowed; offer untouched.
        assertEq(address(lending).balance, 1 ether, "FIX: lender principal still escrowed after revert");
        // Bob did not receive principal.
        assertEq(bob.balance, 0, "FIX: bob received nothing");
        // Bob still has the NFT (it never moved).
        assertEq(malStaking.ownerOf(bobTokenId), bob, "NFT still with borrower (no-op)");

        emit log_string("PASS7-LENDING-01 FIX VALIDATED: silent-no-op inbound staking transferFrom reverts CollateralNotEscrowed");
    }
}
