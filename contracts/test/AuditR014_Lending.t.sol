// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyLendingAdmin.sol"; // AUDIT FIX (pass-8): EIP170-01 split
import "../src/TegridyNFTLending.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";

// ─── Mocks ──────────────────────────────────────────────────────────

contract R014MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract R014MockJBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _id++;
        _mint(to, id);
        return id;
    }
}

contract R014MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "insufficient");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @dev Configurable TegridyPair-shaped reserve mock used by the floor / TWAP.
contract R014MockPair {
    uint256 private constant Q112 = 2 ** 112;

    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    // AUDIT R014 oracle layer: TegridyTWAP.update() now reads pair-native
    // `price{0,1}CumulativeLast` and computes `elapsedSinceLastPairTouch`
    // from `blockTimestampLast`. We mirror TegridyPair._update()'s wrap
    // arithmetic so cumulatives advance the same way the real pair does.
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0; token1 = _t1;
        reserve0 = _r0; reserve1 = _r1;
        blockTimestampLast = uint32(block.timestamp);
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
    function setReserves(uint112 _r0, uint112 _r1) external {
        // Integrate pre-update reserves over the elapsed window — canonical V2 pattern.
        uint32 nowTs = uint32(block.timestamp);
        uint32 elapsed;
        unchecked { elapsed = nowTs - blockTimestampLast; }
        if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            unchecked {
                price0CumulativeLast += (uint256(reserve1) * Q112 / reserve0) * uint256(elapsed);
                price1CumulativeLast += (uint256(reserve0) * Q112 / reserve1) * uint256(elapsed);
            }
        }
        reserve0 = _r0;
        reserve1 = _r1;
        blockTimestampLast = nowTs;
    }
}

/// @dev TWAP shim returning a synthetic `lastBypassUsed` so we can drive the
///      bypass-cooldown branch without warping past DEVIATION_BYPASS_AFTER.
contract R014BypassTWAP {
    // AUDIT R014 oracle layer: Observation cumulatives widened to uint256 +
    // a `bypassed` flag tagging dormancy-rebootstrap samples. Mirror the
    // ITegridyTWAP layout used by TegridyLending so abi.decode matches.
    struct Observation {
        uint32 timestamp;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
        bool bypassed;
    }
    address public immutable pair;
    address public immutable toweli;
    uint256 public constant ETH_PER_TOWELI_NUM = 1; // 1 TOWELI = 0.001 ETH
    uint256 public constant ETH_PER_TOWELI_DEN = 1000;
    uint256 public _lastBypass;
    uint32 public _lastObsTs;

    constructor(address _pair, address _toweli) {
        pair = _pair;
        toweli = _toweli;
        _lastObsTs = uint32(block.timestamp);
    }
    function setBypass(uint256 ts) external { _lastBypass = ts; }
    function setLatestObsTs(uint32 ts) external { _lastObsTs = ts; }
    function lastBypassUsed(address /*p*/) external view returns (uint256) {
        return _lastBypass;
    }
    function getLatestObservation(address /*p*/) external view returns (Observation memory o) {
        o.timestamp = _lastObsTs == 0 ? uint32(block.timestamp) : _lastObsTs;
    }
    function consult(address, address tokenIn, uint256 amountIn, uint256 /*period*/)
        external view returns (uint256)
    {
        require(tokenIn == toweli, "wrong token");
        return (amountIn * ETH_PER_TOWELI_NUM) / ETH_PER_TOWELI_DEN;
    }
}

/// @dev AUDIT R014 oracle layer: minimal TegridyFactory stub for tests bypassing the real
///      factory. TegridyTWAP.update() now requires `factory.isPair(target) == true`. Mirror
///      of MockFactoryForTWAP in TegridyLending_ETHFloor.t.sol — duplicated to keep this
///      suite self-contained without cross-file imports.
contract R014MockFactoryForTWAP {
    mapping(address => bool) public isPair;
    // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): FRESH-EYES H-2 — TegridyTWAP.update
    // now reads `factory.disabledPairs(pair)` to refuse observations during a
    // frozen-reserve disable window. Mock surfaces the same mapping (default false)
    // so test pairs are always "live". Mirror of MockFactoryForTWAP in
    // TegridyLending_ETHFloor.t.sol.
    mapping(address => bool) public disabledPairs;
    function tagPair(address _pair) external {
        isPair[_pair] = true;
    }
    function setDisabled(address _pair, bool _disabled) external {
        disabledPairs[_pair] = _disabled;
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────

/// @title AuditR014_Lending — Wave-014 baseline + R014 audit coverage
/// @notice One test per finding in the R014 lending bundle:
///         1. Escrow rewards recovery (TegridyLending.pullEscrowRewards)
///         2. MIN_PRINCIPAL state + propose/execute/cancel
///         3. pullEscrowRewards proportional payout
///         4. Pause-aware effectiveDeadline (both lending contracts)
///         5. Collateral whitelist on TegridyLending
///         6. TWAP bypass-cooldown gate inside _positionETHValue
///         7. NFTLending blocks createOffer during pending whitelist removal
contract AuditR014LendingTest is Test {
    R014MockToweli public toweli;
    R014MockJBAC public jbac;
    R014MockWETH public weth;
    R014MockPair public pair;
    TegridyStaking public staking;
    TegridyStakingAdmin public stakingAdmin; // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 timelocked admin path
    TegridyLending public lending;
    TegridyLendingAdmin public lendingAdmin; // AUDIT FIX (pass-8): EIP170-01 split
    TegridyTWAP public twap;
    TegridyNFTLending public nftLending;
    R014MockJBAC public collection;

    address public treasury = makeAddr("r014_treasury");
    address public alice = makeAddr("r014_alice"); // borrower
    address public bob = makeAddr("r014_bob");     // lender
    address public carol = makeAddr("r014_carol"); // unaffiliated third party

    uint256 public aliceTokenId;

    function setUp() public {
        // Seed the chain to a realistic non-zero timestamp so wraparound math doesn't trip.
        vm.warp(1_700_000_000);

        toweli = new R014MockToweli();
        jbac = new R014MockJBAC();
        weth = new R014MockWETH();
        pair = new R014MockPair(
            address(toweli),
            address(weth),
            1_000_000 ether,
            1_000 ether
        );

        // 0.001 ether/sec rate keeps the reward pool alive across the multi-hour
        // setup warps so escrow-rewards tests can observe non-zero attribution.
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 0.001 ether);

        // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 — install the staking
        // admin so we can register the lending contract as a tracked holder. Without
        // this, `staking.claimUnsettledForTokenId(tokenId, borrower)` reverts with
        // Unauthorized() because `_isTrackedHolder(lending) == false`, leaving
        // borrower escrow-reward attribution at 0.
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        // Bootstrap the TWAP with three observations so consult() over 30 minutes is well-defined.
        // AUDIT R014 oracle layer: TegridyTWAP now requires a factory whose isPair() vouches
        // for every `update()` target — see MockFactoryForTWAP in TegridyLending_ETHFloor.t.sol.
        // We mirror the same pattern inline so this test stays self-contained.
        R014MockFactoryForTWAP fac = new R014MockFactoryForTWAP();
        fac.tagPair(address(pair));
        twap = new TegridyTWAP(address(fac), address(0));
        twap.update(address(pair));
        skip(16 minutes);
        twap.update(address(pair));
        skip(30 minutes);
        twap.update(address(pair));

        lending = new TegridyLending(treasury, 500, address(weth), address(pair), address(twap), address(0));

        // AUDIT FIX (pass-8): EIP170-01 split — wire TegridyLendingAdmin sister.
        lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));

        // AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 — register lending as a
        // tracked holder so `claimUnsettledForTokenId` (called from repay/default)
        // can drain the per-tokenId escrow rewards. 48h timelock matches the lending
        // accepted-collateral timelock so both execute in the same warp window.
        stakingAdmin.proposeLendingContract(address(lending), true);

        // Whitelist the staking contract via the new R014 collateral admin path.
        lendingAdmin.proposeAcceptedCollateral(address(staking), true);
        // Roll the timelock forward in chunks below DEVIATION_BYPASS_AFTER (1 day) so
        // the TWAP never trips its dormancy bypass during setup.
        skip(22 hours); twap.update(address(pair));
        skip(22 hours); twap.update(address(pair));
        skip(4 hours + 1); twap.update(address(pair));
        lendingAdmin.executeAcceptedCollateral();
        stakingAdmin.executeLendingContract();

        // Fund alice and have her stake to mint a position NFT.
        toweli.transfer(alice, 100_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        aliceTokenId = staking.userTokenId(alice);
        vm.stopPrank();

        // Past the staking-NFT 24h transfer cooldown — chunk the warp again.
        skip(22 hours); twap.update(address(pair));
        skip(3 hours);  twap.update(address(pair));

        vm.prank(alice);
        staking.approve(address(lending), aliceTokenId);

        // Seed the staking pool with a fat TOWELI reward bag so claimUnsettled actually
        // pays out during repay/default settlement. Notifying AFTER the long setup
        // warps prevents `_accumulateRewards` from draining the pool against an empty
        // user base. We then warp another 30 days inside each test before triggering
        // settlement so the loan-period delta is comfortably non-zero.
        toweli.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);

        // Fund the lender with ETH for offers.
        vm.deal(bob, 100 ether);

        // Stand up the NFT lending contract for the pause-aware deadline test
        // and the pending-removal-block test.
        collection = new R014MockJBAC();
        nftLending = new TegridyNFTLending(treasury, 500, address(weth), address(0));
        nftLending.proposeWhitelistCollection(address(collection));
        skip(25 hours);
        nftLending.executeWhitelistCollection();
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 1: Escrow rewards recovery
    // ═══════════════════════════════════════════════════════════════════

    /// @notice After the borrower repays, the contract attributes the loan-period
    ///         reward delta directly to the borrower via the new per-tokenId path.
    /// @dev AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 — `repayLoan` no
    ///      longer populates `escrowRewardsOwed[loanId]` (the snapshot/delta path
    ///      against the shared bucket was the cross-loan drain primitive). It now
    ///      pays the borrower's per-tokenId slice directly via
    ///      `staking.claimUnsettledForTokenId` (two-phase: pre + post transferFrom).
    ///      Test now asserts the borrower's TOWELI balance grew during repay and
    ///      that the legacy accumulator stayed at zero.
    function test_R014_escrowRewards_recoveredOnRepay() public {
        uint256 offerId = _createDefaultOffer();

        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Let rewards accrue against the position while it sits in escrow.
        skip(7 days);

        // Borrower repays in full and receives escrow rewards inline.
        uint256 owed = lending.getRepaymentAmount(loanId);
        uint256 aliceBefore = toweli.balanceOf(alice);
        vm.deal(alice, owed);
        vm.prank(alice);
        lending.repayLoan{value: owed}(loanId);

        // Direct payout — borrower's TOWELI balance must reflect the loan-period
        // reward delta credited via the per-tokenId path.
        uint256 paidToBorrower = toweli.balanceOf(alice) - aliceBefore;
        assertGt(paidToBorrower, 0, "borrower receives escrow rewards inline on repay (D-LD-H1)");

        // Legacy accumulator path remains zero — populated only when the staking
        // contract is paused and the inline claim defers (try/catch fallback).
        assertEq(lending.escrowRewardsOwed(loanId), 0, "legacy escrowRewardsOwed not used on happy path");
        assertEq(lending.totalEscrowRewardsOwed(), 0, "legacy global counter not used on happy path");

        // pullEscrowRewards on a fully-paid loan reverts with NoEscrowRewards
        // (no deferred legacy balance, no per-tokenId residue).
        vm.prank(alice);
        vm.expectRevert(TegridyLending.NoEscrowRewards.selector);
        lending.pullEscrowRewards(loanId);
    }

    /// @notice Defaulted loans route the escrowed rewards directly to the lender.
    /// @dev AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 — see
    ///      test_R014_escrowRewards_recoveredOnRepay. `claimDefaultedCollateral`
    ///      now pays the lender directly via per-tokenId claim instead of
    ///      populating `escrowRewardsOwed[loanId]`.
    function test_R014_escrowRewards_recoveredOnDefault() public {
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        // Let rewards accrue, blow past deadline + grace, lender claims default.
        skip(31 days);
        skip(2 hours); // past GRACE_PERIOD (1h)

        uint256 bobBefore = toweli.balanceOf(bob);
        vm.prank(bob);
        lending.claimDefaultedCollateral(loanId);

        // Lender received attribution inline via per-tokenId claim.
        uint256 paidToLender = toweli.balanceOf(bob) - bobBefore;
        assertGt(paidToLender, 0, "lender receives default attribution inline (D-LD-H1)");

        // Legacy accumulator stays at 0 on the happy path.
        assertEq(lending.escrowRewardsOwed(loanId), 0, "legacy escrowRewardsOwed not used on happy path");

        // pullEscrowRewards is a no-op on the happy path (no deferred balance).
        vm.prank(bob);
        vm.expectRevert(TegridyLending.NoEscrowRewards.selector);
        lending.pullEscrowRewards(loanId);

        // Borrower (non-beneficiary) still rejected even on the no-op path.
        vm.prank(alice);
        vm.expectRevert(TegridyLending.NotEscrowBeneficiary.selector);
        lending.pullEscrowRewards(loanId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 2: MIN_PRINCIPAL state + 48h timelocked admin path
    // ═══════════════════════════════════════════════════════════════════

    function test_R014_minPrincipal_floor_andTimelock() public {
        // Default minPrincipal is 0.001 ether.
        assertEq(lending.minPrincipal(), 0.001 ether);

        // Below-floor offer reverts with PrincipalTooSmall.
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.PrincipalTooSmall.selector);
        lending.createLoanOffer{value: 0.0005 ether}(1000, 30 days, address(staking), 1000 ether, 0);

        // Floor exactly is fine.
        vm.prank(bob);
        lending.createLoanOffer{value: 0.001 ether}(1000, 30 days, address(staking), 1000 ether, 0);

        // Cap is enforced.
        vm.expectRevert(TegridyLending.InvalidCapValue.selector);
        lendingAdmin.proposeMinPrincipal(2 ether); // > MAX_MIN_PRINCIPAL (1 ether)

        // Zero is rejected.
        vm.expectRevert(TegridyLending.ZeroAmount.selector);
        lendingAdmin.proposeMinPrincipal(0);

        // 48h-timelocked propose → execute.
        lendingAdmin.proposeMinPrincipal(0.5 ether);
        assertEq(lendingAdmin.pendingMinPrincipal(), 0.5 ether);
        assertGt(lendingAdmin.minPrincipalChangeReadyAt(), 0);

        // Execute too early reverts.
        vm.expectRevert();
        lendingAdmin.executeMinPrincipalChange();

        // Wait the full timelock and execute.
        vm.warp(block.timestamp + 48 hours + 1);
        lendingAdmin.executeMinPrincipalChange();
        assertEq(lending.minPrincipal(), 0.5 ether);
        assertEq(lendingAdmin.pendingMinPrincipal(), 0);

        // Cancel path.
        lendingAdmin.proposeMinPrincipal(0.25 ether);
        lendingAdmin.cancelMinPrincipalChange();
        assertEq(lendingAdmin.pendingMinPrincipal(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 3: pullEscrowRewards proportional payout
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Legacy proportional-payout branch in `pullEscrowRewards`: when the
    ///         contract holds less TOWELI than the total claim, payouts shrink
    ///         proportionally to `(owed * available) / total`. Surfaces only via
    ///         the legacy `escrowRewardsOwed[loanId]` accumulator path (e.g.
    ///         migration data or a pre-D-LD-H1 deferred-claim entry).
    /// @dev AUDIT FIX REALIGNMENT (pass-6, 2026-05-03): D-LD-H1 — `repayLoan` no
    ///      longer populates `escrowRewardsOwed[loanId]` on the happy path (now
    ///      pays via per-tokenId direct claim). To exercise the proportional
    ///      branch we synthesize a legacy entry via storage poking. The
    ///      proportional-payout math itself is unchanged and still relevant for
    ///      pre-fix migration entries that may exist in production storage.
    function test_R014_pullEscrowRewards_proportionalPayout() public {
        // Run a normal repay-cycle so the loan exists and is in the settled state.
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);
        skip(14 days);
        uint256 owedTotal = lending.getRepaymentAmount(loanId);
        vm.deal(alice, owedTotal);
        vm.prank(alice);
        lending.repayLoan{value: owedTotal}(loanId);

        // Synthesize a legacy `escrowRewardsOwed[loanId]` entry. Pre-D-LD-H1 a
        // settled loan would have a populated entry; we replicate that here by
        // poking storage so the legacy branch is reachable.
        uint256 owed = 100 ether;
        uint256 inflatedTotal = owed * 2; // forces the proportional shrink branch
        bytes32 perLoanSlot = _findEscrowRewardsOwedSlot(loanId);
        bytes32 totalSlot = _findTotalEscrowSlot();
        vm.store(address(lending), perLoanSlot, bytes32(owed));
        vm.store(address(lending), totalSlot, bytes32(inflatedTotal));
        assertEq(lending.escrowRewardsOwed(loanId), owed, "per-loan poke landed");
        assertEq(lending.totalEscrowRewardsOwed(), inflatedTotal, "total poke landed");

        // Ensure the contract has a non-zero TOWELI balance so the proportional
        // branch fires (rather than the available==0 short-circuit).
        toweli.transfer(address(lending), owed);

        uint256 available = toweli.balanceOf(address(lending));
        // Proportional formula: payout = owed * available / total.
        uint256 expectedPayout = (owed * available) / inflatedTotal;
        assertLt(expectedPayout, owed, "proportional payout shrinks vs owed");

        uint256 aliceBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        lending.pullEscrowRewards(loanId);
        uint256 paid = toweli.balanceOf(alice) - aliceBefore;
        assertEq(paid, expectedPayout, "payout matches owed * available / total");
        assertEq(lending.escrowRewardsOwed(loanId), owed - paid, "leftover stays claimable");
    }

    /// @dev Locate the storage slot of `totalEscrowRewardsOwed`. The contract layout
    ///      shifts as new audits land, so we probe by writing a sentinel and reading
    ///      back through the public getter.
    function _findTotalEscrowSlot() internal returns (bytes32) {
        for (uint256 i = 0; i < 128; ++i) {
            bytes32 slot = bytes32(i);
            bytes32 prev = vm.load(address(lending), slot);
            bytes32 sentinel = bytes32(uint256(0xDEADBEEF));
            vm.store(address(lending), slot, sentinel);
            if (lending.totalEscrowRewardsOwed() == uint256(sentinel)) {
                vm.store(address(lending), slot, prev);
                return slot;
            }
            vm.store(address(lending), slot, prev);
        }
        revert("totalEscrowRewardsOwed slot not found");
    }

    /// @dev Locate `escrowRewardsOwed[_loanId]`. The mapping's base slot is found
    ///      by sentinel-probing, then the actual entry is at
    ///      keccak256(abi.encode(_loanId, baseSlot)).
    function _findEscrowRewardsOwedSlot(uint256 _loanId) internal returns (bytes32) {
        for (uint256 i = 0; i < 128; ++i) {
            bytes32 baseSlot = bytes32(i);
            bytes32 entrySlot = keccak256(abi.encode(_loanId, baseSlot));
            bytes32 prev = vm.load(address(lending), entrySlot);
            bytes32 sentinel = bytes32(uint256(0xDEADBEEF));
            vm.store(address(lending), entrySlot, sentinel);
            if (lending.escrowRewardsOwed(_loanId) == uint256(sentinel)) {
                vm.store(address(lending), entrySlot, prev);
                return entrySlot;
            }
            vm.store(address(lending), entrySlot, prev);
        }
        revert("escrowRewardsOwed slot not found");
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 4: Pause-aware effectiveDeadline (both lending contracts)
    // ═══════════════════════════════════════════════════════════════════

    function test_R014_pauseAwareDeadline_extendsBothSides() public {
        uint256 offerId = _createDefaultOffer();
        vm.prank(alice);
        uint256 loanId = lending.acceptOffer(offerId, aliceTokenId);

        ( , , , , , , , uint256 deadline, , ,) = lending.getLoan(loanId);
        assertEq(lending.effectiveDeadline(loanId), deadline, "no pause yet means deadline unchanged");

        // Owner pauses for ~3 days, then unpauses.
        lending.pause();
        skip(3 days);
        // While paused, effectiveDeadline reflects the in-flight pause window.
        assertEq(
            lending.effectiveDeadline(loanId),
            deadline + 3 days,
            "paused window flows into effectiveDeadline live"
        );
        lending.unpause();

        // After unpause the cumulative paused duration sticks.
        assertEq(
            lending.effectiveDeadline(loanId),
            deadline + 3 days,
            "totalPausedDuration retained post-unpause"
        );

        // Walk forward to where the *original* deadline + grace would have expired.
        // Without pause-extension, the lender could now claim. With the extension,
        // claimDefaultedCollateral must still revert.
        vm.warp(deadline + 1 hours + 1);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.DeadlineNotReached.selector);
        lending.claimDefaultedCollateral(loanId);

        // Borrower can still repay through the extended window.
        uint256 owed = lending.getRepaymentAmount(loanId);
        vm.deal(alice, owed);
        vm.prank(alice);
        lending.repayLoan{value: owed}(loanId);

        ( , , , , , , , , bool repaid, ,) = lending.getLoan(loanId);
        assertTrue(repaid, "borrower repaid through extended window");
    }

    /// @notice Same invariant on TegridyNFTLending. Independent fixture using
    ///         a generic ERC-721 collection.
    function test_R014_NFTLending_pauseAwareDeadline() public {
        uint256 tokenId = collection.mint(alice);
        vm.prank(alice);
        collection.approve(address(nftLending), tokenId);

        // Lender (bob) creates an offer pinned to alice's tokenId.
        vm.prank(bob);
        uint256 offerId = nftLending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(collection), tokenId, uint64(block.timestamp + 30 days)
        );

        // Alice accepts the offer to lock the loan in.
        vm.prank(alice);
        uint256 loanId = nftLending.acceptOffer(offerId);

        ( , , , , , , , , uint256 deadline, , ) = nftLending.getLoan(loanId);
        assertEq(nftLending.effectiveDeadline(loanId), deadline);

        nftLending.pause();
        skip(2 days);
        nftLending.unpause();

        assertEq(
            nftLending.effectiveDeadline(loanId),
            deadline + 2 days,
            "NFT lending tracks paused window symmetrically"
        );

        // claimDefault past the original deadline still blocked.
        vm.warp(deadline + 1 hours + 1);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.LoanNotDefaulted.selector);
        nftLending.claimDefault(loanId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 5: Collateral whitelist on TegridyLending
    // ═══════════════════════════════════════════════════════════════════

    function test_R014_collateralWhitelist_required() public {
        // A second staking contract that nobody has whitelisted.
        TegridyStaking otherStaking = new TegridyStaking(
            address(toweli), address(jbac), treasury, 1 ether
        );

        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyLending.CollateralNotAccepted.selector);
        lending.createLoanOffer{value: 0.5 ether}(
            1000, 30 days, address(otherStaking), 1000 ether, 0
        );

        // Whitelist via timelock.
        lendingAdmin.proposeAcceptedCollateral(address(otherStaking), true);
        // Cannot execute before delay.
        vm.expectRevert();
        lendingAdmin.executeAcceptedCollateral();

        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();
        assertTrue(lending.acceptedCollateralContracts(address(otherStaking)));

        // Now the offer succeeds.
        vm.prank(bob);
        lending.createLoanOffer{value: 0.5 ether}(
            1000, 30 days, address(otherStaking), 1000 ether, 0
        );

        // Removal also goes through the timelock.
        lendingAdmin.proposeAcceptedCollateral(address(otherStaking), false);
        skip(48 hours + 1);
        lendingAdmin.executeAcceptedCollateral();
        assertFalse(lending.acceptedCollateralContracts(address(otherStaking)));

        // Cancel path.
        lendingAdmin.proposeAcceptedCollateral(address(otherStaking), true);
        lendingAdmin.cancelAcceptedCollateral();
        assertEq(lendingAdmin.pendingAcceptedCollateral(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 6: TWAP bypass-cooldown gate inside _positionETHValue
    // ═══════════════════════════════════════════════════════════════════

    /// @notice When the TWAP just absorbed a dormancy-bypass observation,
    ///         _positionETHValue refuses to value collateral for `TWAP_PERIOD * 2`
    ///         (60 minutes) so a single attacker-chosen post-bypass observation
    ///         cannot sole-source the ETH-floor read.
    function test_R014_twapBypassCooldown() public {
        // Stand up a fresh lending instance pointed at our scriptable TWAP shim.
        R014BypassTWAP shim = new R014BypassTWAP(address(pair), address(toweli));
        TegridyLending lendingShim = new TegridyLending(
            treasury, 500, address(weth), address(pair), address(shim), address(0)
        );
        // AUDIT FIX (pass-8): EIP170-01 split — local admin sister for the shim instance.
        TegridyLendingAdmin lendingShimAdmin = new TegridyLendingAdmin(address(lendingShim));
        lendingShim.setLendingAdmin(address(lendingShimAdmin));
        lendingShimAdmin.proposeAcceptedCollateral(address(staking), true);
        skip(48 hours + 1);
        lendingShimAdmin.executeAcceptedCollateral();

        // Bob posts an offer with a non-trivial ETH floor so _positionETHValue is invoked.
        vm.deal(bob, 5 ether);
        vm.prank(bob);
        uint256 offerId = lendingShim.createLoanOffer{value: 0.5 ether}(
            1000, 30 days, address(staking), 1000 ether, 5 ether
        );

        // Re-approve the NFT to the new lending contract.
        vm.prank(alice);
        staking.approve(address(lendingShim), aliceTokenId);

        // Set the TWAP shim's `lastBypassUsed` to NOW — cooldown window is open.
        shim.setBypass(block.timestamp);
        shim.setLatestObsTs(uint32(block.timestamp));

        // acceptOffer trips the bypass-cooldown branch ⇒ OracleStale revert.
        vm.prank(alice);
        vm.expectRevert(TegridyLending.OracleStale.selector);
        lendingShim.acceptOffer(offerId, aliceTokenId);

        // Roll past TWAP_PERIOD * 2 (60 minutes) — read becomes valid.
        skip(61 minutes);
        shim.setLatestObsTs(uint32(block.timestamp));
        vm.prank(alice);
        lendingShim.acceptOffer(offerId, aliceTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FINDING 7: NFTLending blocks createOffer during pending whitelist removal
    // ═══════════════════════════════════════════════════════════════════

    function test_R014_NFTLending_blocksOffersDuringPendingRemoval() public {
        uint256 tokenId = collection.mint(alice);
        vm.prank(alice);
        collection.approve(address(nftLending), tokenId);

        // Owner proposes removal. The 24h timelock has not yet elapsed.
        nftLending.proposeRemoveCollection(address(collection));
        assertEq(nftLending.pendingWhitelistRemove(), address(collection));

        // While the proposal is pending, fresh offers against the targeted collection revert.
        vm.deal(bob, 5 ether);
        vm.prank(bob);
        vm.expectRevert(TegridyNFTLending.CollectionPendingRemoval.selector);
        nftLending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(collection), tokenId, uint64(block.timestamp + 30 days)
        );

        // Owner cancels the removal — offers can be created again.
        nftLending.cancelRemoveCollection();
        vm.prank(bob);
        nftLending.createOffer{value: 1 ether}(
            1 ether, 1000, 30 days, address(collection), tokenId, uint64(block.timestamp + 30 days)
        );
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _createDefaultOffer() internal returns (uint256) {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        return lending.createLoanOffer{value: 1 ether}(
            1000, 30 days, address(staking), 1000 ether, 0
        );
    }
}
