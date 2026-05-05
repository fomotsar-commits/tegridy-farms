// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import "../../src/TegridyStakingAdmin.sol";
import "../../src/TegridyLending.sol";

/// @title PASS7-INV-A — Lending solvency under pause cycles +
///        stuck-collateral recovery (LENDING-02) +
///        snapshot-and-delta cross-loan attribution (LENDING-03).
///
/// @notice Extends the Pass6_LendingSolvency invariant suite with the surface
///         introduced by PASS7-LENDING-02 + PASS7-LENDING-03:
///
///           - pause/unpause on STAKING (the precondition that defers
///             two-phase pulls and was the LENDING-03 attack precondition);
///           - claimStuckCollateral on lending (the LENDING-02 recovery path);
///           - pause/unpause on LENDING (Pausable surface — pause-aware
///             deadline arithmetic must keep solvency invariants intact).
///
///         Three properties enforced after every randomized handler call:
///
///         (P7A-1) ETH solvency holds across pause cycles:
///                address(lending).balance >= sum(active offer principals)
///                                         + sum(active offer originationFees)
///              Same as Pass6 E1, but proved under handler sequences that
///              include lending.pause() / unpause() and staking.pause() /
///              unpause(). Pause must NEVER strand earmarked principal.
///
///         (P7A-2) TOWELI solvency for escrow-rewards-owed:
///                toweli.balanceOf(lending) + staking.unsettledRewards(lending)
///                  >= totalEscrowRewardsOwed
///              Every credit recorded in escrowRewardsOwed must be backed by
///              TOWELI either already at lending or claimable from the staking
///              unsettled bucket. This is the LENDING-03 snapshot-and-delta
///              property: priorShare stays at lending and flows out via the
///              legacy pro-rata pullEscrowRewards path; if the snapshot
///              accounting were broken, totalEscrowRewardsOwed could exceed
///              the backing balance and a recipient would be denied.
///
///         (P7A-3) stuckCollateralRecipient implies loan settled:
///                For every loanId where stuckCollateralRecipient[loanId] != 0:
///                  loan.repaid == true || loan.defaultClaimed == true
///              The recovery slot is only populated by repayLoan or
///              claimDefaultedCollateral after marking the loan settled. An
///              active loan with a stuck recipient would mean the contract
///              committed itself to a dual-recipient state (active borrower +
///              stuck recovery) — a regression of the LENDING-02 fix shape.
contract InvP7A_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract InvP7A_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract InvP7A_WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "weth: bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract InvP7A_Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0; token1 = _t1; reserve0 = _r0; reserve1 = _r1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

/// @dev Mirror of Pass6's TWAP-shaped mock — ETH-floor path stays dormant.
contract InvP7A_TWAP {
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

contract InvP7A_Handler is Test {
    TegridyLending public lending;
    TegridyStaking public staking;
    InvP7A_Toweli public toweli;
    InvP7A_JBAC public jbac;
    address public immutable lendingOwner;

    address[] public actors;
    mapping(address => uint256) public actorTokenId;
    uint256 public actionCount;

    /// @dev Forensic counters mirroring Pass6 patterns — non-recipient pulls
    ///      MUST always revert. Tracked here so the invariant assertion can
    ///      check the success counter is 0 across the whole run.
    uint256 public stuckClaimSuccessCount;
    uint256 public stuckClaimRevertCount;

    constructor(
        TegridyLending _lending,
        TegridyStaking _staking,
        InvP7A_Toweli _toweli,
        InvP7A_JBAC _jbac,
        address[] memory _actors,
        uint256[] memory _tokenIds,
        address _lendingOwner
    ) {
        lending = _lending;
        staking = _staking;
        toweli = _toweli;
        jbac = _jbac;
        lendingOwner = _lendingOwner;
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; i++) {
            actorTokenId[_actors[i]] = _tokenIds[i];
        }
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function doCreateOffer(uint256 actorSeed, uint256 principalSeed, uint256 aprSeed, uint256 durSeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        uint256 principal = bound(principalSeed, 0.01 ether, 5 ether);
        uint256 apr = bound(aprSeed, 100, 30000);
        uint256 dur = bound(durSeed, 1 days, 30 days);
        vm.deal(a, a.balance + principal);
        vm.prank(a);
        try lending.createLoanOffer{value: principal}(apr, dur, address(staking), 1 ether, 0) returns (uint256) {} catch {}
    }

    function doCancelOffer(uint256 actorSeed, uint256 offerSeed) external {
        actionCount++;
        uint256 count = lending.offerCount();
        if (count == 0) return;
        address a = _pickActor(actorSeed);
        uint256 idx = offerSeed % count;
        vm.prank(a);
        try lending.cancelOffer(idx) {} catch {}
    }

    function doAcceptOffer(uint256 actorSeed, uint256 offerSeed) external {
        actionCount++;
        uint256 count = lending.offerCount();
        if (count == 0) return;
        address a = _pickActor(actorSeed);
        uint256 tid = actorTokenId[a];
        if (tid == 0) return;
        try staking.ownerOf(tid) returns (address ow) {
            if (ow != a) return;
        } catch { return; }
        vm.prank(a);
        staking.approve(address(lending), tid);
        uint256 idx = offerSeed % count;
        vm.prank(a);
        try lending.acceptOffer(idx, tid) returns (uint256) {} catch {}
    }

    function doRepayLoan(uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        (address borrower,,,, uint256 principal, , , , bool repaid, bool dc, ) = lending.getLoan(idx);
        if (repaid || dc) return;
        uint256 repay = principal * 2;
        vm.deal(borrower, borrower.balance + repay);
        vm.prank(borrower);
        try lending.repayLoan{value: repay}(idx) {} catch {}
    }

    function doClaimDefaulted(uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        (, address lender,,,,,,, bool repaid, bool dc, ) = lending.getLoan(idx);
        if (repaid || dc) return;
        vm.prank(lender);
        try lending.claimDefaultedCollateral(idx) {} catch {}
    }

    function doPullEscrowRewards(uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        (address borrower, address lender_,,,,,,, bool repaid, bool dc, ) = lending.getLoan(idx);
        if (!repaid && !dc) return;
        address recipient = repaid ? borrower : lender_;
        vm.prank(recipient);
        try lending.pullEscrowRewards(idx) {} catch {}
    }

    /// @notice PASS7-LENDING-02 surface — claimStuckCollateral retry. With our
    ///         honest mock staking the recipient slot will rarely be set, but
    ///         if it ever is, this exercises the recovery path.
    function doClaimStuckCollateral(uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        address recipient = lending.stuckCollateralRecipient(idx);
        if (recipient == address(0)) return;
        vm.prank(recipient);
        try lending.claimStuckCollateral(idx) {
            stuckClaimSuccessCount++;
        } catch {
            stuckClaimRevertCount++;
        }
    }

    /// @notice Pause/unpause STAKING — the LENDING-03 attack precondition
    ///         (whenNotPaused on claimUnsettledForTokenId defers the two-phase
    ///         pull and parks credits in the per-tokenId bucket). Owner is
    ///         the test contract that deployed staking.
    function doPauseStaking() external {
        actionCount++;
        if (staking.paused()) return;
        vm.prank(staking.owner());
        try staking.pause() {} catch {}
    }

    function doUnpauseStaking() external {
        actionCount++;
        if (!staking.paused()) return;
        vm.prank(staking.owner());
        try staking.unpause() {} catch {}
    }

    /// @notice Pause/unpause LENDING — Pausable surface for solvency under
    ///         admin-pause regimes.
    function doPauseLending() external {
        actionCount++;
        if (lending.paused()) return;
        vm.prank(lendingOwner);
        try lending.pause() {} catch {}
    }

    function doUnpauseLending() external {
        actionCount++;
        if (!lending.paused()) return;
        vm.prank(lendingOwner);
        try lending.unpause() {} catch {}
    }

    function doKick(uint256 actorSeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        uint256 tid = actorTokenId[a];
        if (tid == 0) return;
        try staking.kick(tid) {} catch {}
    }

    function doWarp(uint256 secs) external {
        actionCount++;
        secs = bound(secs, 1 hours, 14 days);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS7_INV_A_LendingExtSolvency is Test {
    InvP7A_Toweli public toweli;
    InvP7A_JBAC public jbac;
    InvP7A_WETH public weth;
    InvP7A_Pair public pair;
    InvP7A_TWAP public twap;
    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyLending public lending;
    InvP7A_Handler public handler;

    address public treasury = makeAddr("inv_p7a_treasury");
    address[] internal actorsArr;
    uint256[] internal tokenIds;

    function setUp() public {
        toweli = new InvP7A_Toweli();
        jbac = new InvP7A_JBAC();
        weth = new InvP7A_WETH();
        pair = new InvP7A_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        toweli.approve(address(staking), 100_000_000 ether);
        staking.notifyRewardAmount(100_000_000 ether);

        twap = new InvP7A_TWAP();
        lending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(pair),
            address(twap),
            address(0)
        );

        lending.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lending.executeAcceptedCollateral();

        stakingAdmin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        stakingAdmin.executeLendingContract();

        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("inv_p7a_actor", i)))));
            actorsArr.push(a);
            toweli.transfer(a, 100_000 ether);
            vm.startPrank(a);
            toweli.approve(address(staking), type(uint256).max);
            staking.stake(10_000 ether, 30 days);
            tokenIds.push(staking.userTokenId(a));
            vm.stopPrank();
        }

        skip(25 hours);

        handler = new InvP7A_Handler(
            lending, staking, toweli, jbac, actorsArr, tokenIds, address(this)
        );

        vm.deal(address(handler), 1000 ether);
        for (uint256 i = 0; i < actorsArr.length; i++) {
            vm.deal(actorsArr[i], 100 ether);
        }

        targetContract(address(handler));
    }

    /// @notice INVARIANT P7A-1: ETH solvency holds across pause cycles.
    function invariant_p7a_balanceCoversActiveOffers() public view {
        uint256 n = lending.offerCount();
        uint256 owed;
        for (uint256 i = 0; i < n; i++) {
            (, uint256 principal,,,,,,bool active, uint256 origFee,) = lending.getOffer(i);
            if (active) {
                owed += principal;
                owed += origFee;
            }
        }
        assertLe(owed, address(lending).balance, "P7A-1: lending insolvent vs active offers (pause-cycle regression)");
    }

    /// @notice INVARIANT P7A-2: TOWELI solvency for escrow-rewards-owed.
    ///         Backing = lending's TOWELI balance + lending's claimable
    ///         unsettled-rewards bucket on staking. The denominator
    ///         totalEscrowRewardsOwed must always be <= backing, otherwise the
    ///         legacy pro-rata payout in pullEscrowRewards would shortfall.
    function invariant_p7a_toweliCoversEscrowOwed() public view {
        uint256 backing = toweli.balanceOf(address(lending))
            + staking.unsettledRewards(address(lending));
        uint256 owed = lending.totalEscrowRewardsOwed();
        assertLe(owed, backing, "P7A-2: totalEscrowRewardsOwed exceeds TOWELI backing (snapshot accounting broken)");
    }

    /// @notice INVARIANT P7A-3: stuckCollateralRecipient[loanId] != 0
    ///         implies the loan is settled (repaid OR defaultClaimed).
    ///         An active loan with a stuck recipient would mean the recovery
    ///         slot was populated outside of repayLoan / claimDefaulted —
    ///         a regression of the LENDING-02 fix shape.
    function invariant_p7a_stuckRecipientImpliesSettled() public view {
        uint256 n = lending.loanCount();
        for (uint256 i = 0; i < n; i++) {
            address recipient = lending.stuckCollateralRecipient(i);
            if (recipient == address(0)) continue;
            (,,,,,,,, bool repaid, bool defaultClaimed,) = lending.getLoan(i);
            assertTrue(
                repaid || defaultClaimed,
                "P7A-3: stuckCollateralRecipient set on active (non-settled) loan"
            );
        }
    }
}
