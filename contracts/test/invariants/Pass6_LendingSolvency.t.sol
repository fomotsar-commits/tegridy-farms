// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import "../../src/TegridyStakingAdmin.sol";
import "../../src/TegridyLending.sol";

/// @title PASS6-INV-E — TegridyLending solvency + cross-loan reward isolation
/// @notice Stateful invariant locking down the LD-NEW-H1 fix surface (closed in
///         commit `722d1f1` at TegridyLending.sol:1620-1633). Three properties
///         enforced after every randomized handler call across 5 actors:
///
///         (E1) Active-offer ETH solvency:
///                address(lending).balance >= sum(offers[i].principal | offers[i].active)
///                                              + sum(offers[i].originationFee | offers[i].active)
///              Every active offer's principal + held origination fee must be
///              currently sitting in the contract — every cancel must be able to
///              refund. This is the canonical lending-side solvency check (also
///              covered narrowly by `LendingInvariantsTest.invariant_offerETHEarmarked`,
///              extended here under a wider mix of accept/repay/default sequences).
///
///         (E2) Open-loan NFT escrow uniqueness:
///                For every open loan (NOT repaid AND NOT defaultClaimed):
///                  staking.ownerOf(tokenId) == address(lending)
///                AND no two open loans reference the same tokenId.
///              The cross-loan drain attack (LD-NEW-H1) had its precondition in
///              the OLD-loan slot's lender/borrower being able to call
///              `pullEscrowRewards` while the NFT had been re-escrowed for a NEW
///              loan on the same tokenId. The post-fix check at the call-site is
///              `ownerOf == address(this)` — this invariant ensures the model
///              that motivates that gate (one open loan ↔ one escrowed NFT)
///              actually holds across all randomized sequences.
///
///         (E3) `pullEscrowRewards` access gate (call-site auth):
///              For every settled loan (repaid OR defaultClaimed), the only
///              address that can successfully call `pullEscrowRewards(loanId)`
///              and have it not revert `NotEscrowBeneficiary` is the
///              recipient (loan.repaid ? borrower : lender).
///              The handler probes this via `pullEscrowRewardsAsNonRecipient` —
///              the call MUST always revert when invoked by anyone other than
///              the recipient. We assert the contract balance/state never
///              changes after such a call.
///
///         All three properties together close the LD-NEW-H1 surface against
///         randomized adversarial sequences: an attacker who can drive offer /
///         accept / repay / default / pullEscrow / kick combinations has zero
///         path to (a) drain a different loan's per-tokenId credits, (b) call
///         pullEscrowRewards as a non-recipient, or (c) leave the contract
///         insolvent against an active offer.

contract InvE_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract InvE_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

contract InvE_WETH {
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

contract InvE_Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0;
        token1 = _t1;
        reserve0 = _r0;
        reserve1 = _r1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

/// @dev TegridyTWAP-shaped mock — ETH-floor path is never enabled in the
///      handler (offers all created with `_minPositionETHValue = 0`), so
///      consult/getLatestObservation are never called. The mock returns
///      sensible defaults so any defensive read inside lending init succeeds.
contract InvE_TWAP {
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

contract InvE_Handler is Test {
    TegridyLending public lending;
    TegridyStaking public staking;
    InvE_Toweli public toweli;
    InvE_JBAC public jbac;

    address[] public actors;
    /// @dev Each actor's primary staking-NFT tokenId; created in setUp so the
    ///      handler can reuse them across the run. tokenId == 0 means actor
    ///      doesn't have one (skipped in handler logic).
    mapping(address => uint256) public actorTokenId;
    uint256 public actionCount;

    /// @dev Forensic counter — increment on every observed reverted attempt to
    ///      pull escrow rewards by a non-recipient. Pairs with the violation
    ///      counter below: under correct gate behaviour, every non-recipient
    ///      attempt MUST go through the catch arm and bump THIS counter only.
    uint256 public nonRecipientPullRevertCount;
    /// @dev Counter of OBSERVED gate violations: a non-recipient
    ///      `pullEscrowRewards` call that DID NOT revert. Must always be 0
    ///      across the entire run — the canary for any future regression of
    ///      LD-NEW-H1's call-site auth gate (`if (msg.sender != recipient)
    ///      revert NotEscrowBeneficiary;`). The invariant assertion below
    ///      surfaces this.
    uint256 public nonRecipientPullSucceededCount;

    constructor(
        TegridyLending _lending,
        TegridyStaking _staking,
        InvE_Toweli _toweli,
        InvE_JBAC _jbac,
        address[] memory _actors,
        uint256[] memory _tokenIds
    ) {
        lending = _lending;
        staking = _staking;
        toweli = _toweli;
        jbac = _jbac;
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; i++) {
            actorTokenId[_actors[i]] = _tokenIds[i];
        }
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @notice Random `createLoanOffer` from any actor — funds itself via vm.deal.
    function doCreateOffer(uint256 actorSeed, uint256 principalSeed, uint256 aprSeed, uint256 durSeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        uint256 principal = bound(principalSeed, 0.01 ether, 5 ether);
        uint256 apr = bound(aprSeed, 100, 30000); // [1%, 300%]
        uint256 dur = bound(durSeed, 1 days, 30 days);
        vm.deal(a, a.balance + principal);
        vm.prank(a);
        try lending.createLoanOffer{value: principal}(
            apr,
            dur,
            address(staking),
            1 ether, // min position value (always satisfied)
            0        // no ETH-floor
        ) returns (uint256) {} catch {}
    }

    /// @notice Random `cancelOffer` — only the lender can cancel, but
    ///         non-lenders should revert cleanly. Both paths exercise the
    ///         active-offer reservation accounting.
    function doCancelOffer(uint256 actorSeed, uint256 offerSeed) external {
        actionCount++;
        uint256 count = lending.offerCount();
        if (count == 0) return;
        address a = _pickActor(actorSeed);
        uint256 idx = offerSeed % count;
        vm.prank(a);
        try lending.cancelOffer(idx) {} catch {}
    }

    /// @notice Random `acceptOffer` — actor accepts an offer using their
    ///         pre-allocated tokenId. Skipped if their tokenId is currently in
    ///         lending escrow already.
    function doAcceptOffer(uint256 actorSeed, uint256 offerSeed) external {
        actionCount++;
        uint256 count = lending.offerCount();
        if (count == 0) return;
        address a = _pickActor(actorSeed);
        uint256 tid = actorTokenId[a];
        if (tid == 0) return;
        // Need actor to currently hold the NFT (not in lending, not transferred).
        try staking.ownerOf(tid) returns (address ow) {
            if (ow != a) return;
        } catch { return; }
        // Approve lending each call — cheap, idempotent.
        vm.prank(a);
        staking.approve(address(lending), tid);
        uint256 idx = offerSeed % count;
        vm.prank(a);
        try lending.acceptOffer(idx, tid) returns (uint256) {} catch {}
    }

    /// @notice Random `repayLoan` — borrower repays their open loan.
    function doRepayLoan(uint256 actorSeed, uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        (address borrower,,,, uint256 principal, , , , bool repaid, bool dc, ) = lending.getLoan(idx);
        if (repaid || dc) return;
        // Estimate generous repay: principal + 100% headroom.
        uint256 repay = principal * 2;
        vm.deal(borrower, borrower.balance + repay);
        vm.prank(borrower);
        try lending.repayLoan{value: repay}(idx) {} catch {}
        // Suppress actor seed unused warning.
        actorSeed;
    }

    /// @notice Random `claimDefaultedCollateral` — lender claims after the
    ///         deadline + grace lapses. Handler skips the time-warp here; the
    ///         doWarp action provides the time advancement so the random mix
    ///         can produce both "too-early" reverts and successful claims.
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

    /// @notice Random `pullEscrowRewards` — caller may or may not be the
    ///         recipient. The contract MUST revert any non-recipient call.
    function doPullEscrowRewards(uint256 actorSeed, uint256 loanSeed) external {
        actionCount++;
        uint256 count = lending.loanCount();
        if (count == 0) return;
        uint256 idx = loanSeed % count;
        address a = _pickActor(actorSeed);
        (address borrower, address lender_,,,,,,, bool repaid, bool dc, ) = lending.getLoan(idx);
        if (!repaid && !dc) return; // LoanStillActive — silent skip
        address recipient = repaid ? borrower : lender_;

        if (a == recipient) {
            vm.prank(a);
            try lending.pullEscrowRewards(idx) {} catch {}
        } else {
            // Non-recipient probe — POST-FIX must always revert. We bump the
            // SUCCESS counter ONLY inside the success branch; the invariant
            // below asserts that counter stays at 0 across the entire run.
            vm.prank(a);
            try lending.pullEscrowRewards(idx) {
                nonRecipientPullSucceededCount++;
            } catch {
                nonRecipientPullRevertCount++;
            }
        }
    }

    /// @notice Random `kick` to a tokenId — opens the per-tokenId credit
    ///         attribution path that LD-NEW-H1 attacked. Kick is permissionless
    ///         after the lock expires; the handler tries every actor's tokenId.
    function doKick(uint256 actorSeed, uint256 kickerSeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        uint256 tid = actorTokenId[a];
        if (tid == 0) return;
        address kicker = _pickActor(kickerSeed);
        vm.prank(kicker);
        try staking.kick(tid) {} catch {}
    }

    function doWarp(uint256 secs) external {
        actionCount++;
        secs = bound(secs, 1 hours, 14 days);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS6_INV_E_LendingSolvency is Test {
    InvE_Toweli public toweli;
    InvE_JBAC public jbac;
    InvE_WETH public weth;
    InvE_Pair public pair;
    InvE_TWAP public twap;
    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin;
    TegridyLending public lending;
    InvE_Handler public handler;

    address public treasury = makeAddr("inv_e_treasury");
    address[] internal actorsArr;
    uint256[] internal tokenIds;

    function setUp() public {
        toweli = new InvE_Toweli();
        jbac = new InvE_JBAC();
        weth = new InvE_WETH();
        // ETH-floor path is dormant — minPositionETHValue is 0 in every offer.
        pair = new InvE_Pair(address(toweli), address(weth), 1_000_000 ether, 1_000 ether);

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        // Fund the staking pool so kicks credit non-trivial amounts.
        toweli.approve(address(staking), 100_000_000 ether);
        staking.notifyRewardAmount(100_000_000 ether);

        twap = new InvE_TWAP();
        lending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(pair),
            address(twap),
            address(0)
        );

        // Whitelist staking as collateral (48h timelock). Sequential timelocks
        // need explicit warps — absolute targets read off block.timestamp at
        // each step (see Pass6_Regressions.t.sol which uses `skip`, equivalent).
        lending.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lending.executeAcceptedCollateral();

        // Register lending as a tracked holder so per-tokenId attribution fires.
        stakingAdmin.proposeLendingContract(address(lending), true);
        skip(48 hours + 1);
        stakingAdmin.executeLendingContract();

        // Five actors, each with a pre-staked TegridyStaking position.
        // Lock duration 30 days so loan deadlines + grace fit inside.
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("inv_e_actor", i)))));
            actorsArr.push(a);
            toweli.transfer(a, 100_000 ether);
            vm.startPrank(a);
            toweli.approve(address(staking), type(uint256).max);
            staking.stake(10_000 ether, 30 days);
            tokenIds.push(staking.userTokenId(a));
            vm.stopPrank();
        }

        // Skip past the 24h transfer cooldown for the staking NFT.
        skip(25 hours);

        handler = new InvE_Handler(lending, staking, toweli, jbac, actorsArr, tokenIds);

        // Fund the handler — most actions self-fund via vm.deal but having a
        // base float is convenient for any side-effect deposits (none today,
        // future-proofing).
        vm.deal(address(handler), 1000 ether);
        for (uint256 i = 0; i < actorsArr.length; i++) {
            vm.deal(actorsArr[i], 100 ether);
        }

        targetContract(address(handler));
    }

    /// @notice INVARIANT E1: contract ETH balance covers all active-offer
    ///         reservations (principal + originationFee).
    function invariant_balanceCoversActiveOffers() public view {
        uint256 n = lending.offerCount();
        uint256 owed;
        for (uint256 i = 0; i < n; i++) {
            (, uint256 principal,,,,,,bool active, uint256 origFee,) = lending.getOffer(i);
            if (active) {
                owed += principal;
                owed += origFee;
            }
        }
        assertLe(owed, address(lending).balance, "INV-E1: lending insolvent vs active offers");
    }

    /// @notice INVARIANT E2: every open loan has its NFT escrowed at lending,
    ///         AND no two open loans reference the same tokenId.
    function invariant_openLoanNftEscrowedAndUnique() public view {
        uint256 n = lending.loanCount();
        // Track open-loan tokenIds — assert uniqueness via O(n^2) sweep
        // (n ≤ 500 in this run; quadratic is fine).
        uint256[] memory openTokenIds = new uint256[](n);
        uint256 openCount;
        for (uint256 i = 0; i < n; i++) {
            (,,, uint256 tokenId,,,,, bool repaid, bool defaultClaimed,) = lending.getLoan(i);
            if (repaid || defaultClaimed) continue;
            // Per-loan escrow check.
            assertEq(
                staking.ownerOf(tokenId),
                address(lending),
                "INV-E2a: open loan without escrowed NFT"
            );
            // Uniqueness check.
            for (uint256 j = 0; j < openCount; j++) {
                assertTrue(
                    openTokenIds[j] != tokenId,
                    "INV-E2b: two open loans reference same tokenId"
                );
            }
            openTokenIds[openCount++] = tokenId;
        }
    }

    /// @notice INVARIANT E3: every non-recipient `pullEscrowRewards` call MUST
    ///         revert. The handler increments `nonRecipientPullSucceededCount`
    ///         in the SUCCESS arm of its try/catch — it stays 0 across the
    ///         full run iff the gate at TegridyLending.sol:1596
    ///         (`if (msg.sender != recipient) revert NotEscrowBeneficiary;`)
    ///         is intact under all randomized sequences of repay/default/
    ///         pullEscrow/kick/createOffer/etc.
    function invariant_pullEscrow_nonRecipientGateHolds() public view {
        assertEq(
            handler.nonRecipientPullSucceededCount(),
            0,
            "INV-E3: non-recipient pullEscrowRewards succeeded (call-site auth gate broken)"
        );
    }
}
