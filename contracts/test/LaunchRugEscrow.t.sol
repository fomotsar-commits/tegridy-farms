// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {LaunchRugEscrow} from "../src/LaunchRugEscrow.sol";
import {OwnableNoRenounce} from "../src/base/OwnableNoRenounce.sol";

// ─── Mock helpers ────────────────────────────────────────────────────

/// @dev ERC-20 with switches for the two failure modes the escrow must never mistake for
///      an empty wallet: a reverting `balanceOf` and a reverting `totalSupply`.
contract EscrowMockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;

    mapping(address => uint256) internal _balances;
    uint256 internal _totalSupply;
    bool public balanceOfReverts;
    bool public totalSupplyReverts;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        _totalSupply += amount;
    }

    /// @dev Third-party burn: shrinks supply without touching the tracked holders.
    function burn(address from, uint256 amount) external {
        _balances[from] -= amount;
        _totalSupply -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (balanceOfReverts) revert("TOKEN_DOWN");
        return _balances[account];
    }

    function totalSupply() external view returns (uint256) {
        if (totalSupplyReverts) revert("TOKEN_DOWN");
        return _totalSupply;
    }

    function setBalanceOfReverts(bool v) external {
        balanceOfReverts = v;
    }

    function setTotalSupplyReverts(bool v) external {
        totalSupplyReverts = v;
    }
}

contract EscrowMockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @dev Recipient that reverts on plain ETH. Must still be paid (in WETH), never bricked.
contract RejectingRecipient {
    receive() external payable {
        revert("NO_ETH");
    }
}

/// @dev Recipient that tries to re-enter `claimRefund` from `receive`.
contract ReentrantClaimer {
    LaunchRugEscrow public immutable escrow;
    uint256 public immutable escrowId;
    uint256 public immutable index;
    uint256 public immutable weight;
    bytes32[] internal proof;
    uint256 public attempts;

    constructor(LaunchRugEscrow escrow_, uint256 escrowId_, uint256 index_, uint256 weight_) {
        escrow = escrow_;
        escrowId = escrowId_;
        index = index_;
        weight = weight_;
    }

    function setProof(bytes32[] calldata p) external {
        proof = p;
    }

    function claim() external {
        escrow.claimRefund(escrowId, index, address(this), weight, proof);
    }

    receive() external payable {
        attempts += 1;
        escrow.claimRefund(escrowId, index, address(this), weight, proof);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

contract LaunchRugEscrowTest is Test {
    LaunchRugEscrow internal escrow;
    EscrowMockToken internal token;
    EscrowMockToken internal lp;
    EscrowMockWETH internal weth;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal deployerWallet = makeAddr("deployerWallet");
    address internal lpHolder = makeAddr("lpHolder");
    address internal oracle = makeAddr("oracle");
    address internal sink = makeAddr("sink");
    address internal stranger = makeAddr("stranger");
    address internal buyerA = makeAddr("buyerA");
    address internal buyerB = makeAddr("buyerB");

    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant TRACKED = 300_000e18; // 3000 bps
    uint16 internal constant MIN_BPS = 2000;
    uint64 internal constant WINDOW = 30 days;
    uint256 internal constant PRINCIPAL = 10 ether;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new EscrowMockWETH();
        escrow = new LaunchRugEscrow(address(weth), owner);

        token = new EscrowMockToken();
        token.mint(deployerWallet, TRACKED);
        token.mint(address(0xBEEF), SUPPLY - TRACKED);

        lp = new EscrowMockToken();
        lp.mint(lpHolder, 800e18);
        lp.mint(address(0xBEEF), 200e18);

        vm.prank(owner);
        escrow.setOpeningsEnabled(true);

        vm.deal(creator, 1000 ether);
    }

    // ─── Fixtures ─────────────────────────────────────────────────────

    function _tokenCovenant() internal view returns (LaunchRugEscrow.CovenantInput memory c) {
        address[] memory holders = new address[](1);
        holders[0] = deployerWallet;
        c = LaunchRugEscrow.CovenantInput({asset: address(token), minBps: MIN_BPS, holders: holders});
    }

    function _lpCovenant() internal view returns (LaunchRugEscrow.CovenantInput memory c) {
        address[] memory holders = new address[](1);
        holders[0] = lpHolder;
        c = LaunchRugEscrow.CovenantInput({asset: address(lp), minBps: 7000, holders: holders});
    }

    function _openTokenOnly() internal returns (uint256 id) {
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = _tokenCovenant();
        vm.prank(creator);
        id = escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    function _openBoth() internal returns (uint256 id) {
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](2);
        inputs[0] = _tokenCovenant();
        inputs[1] = _lpCovenant();
        vm.prank(creator);
        id = escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    /// @dev Drop the tracked wallet from 3000 bps to 1500 bps — an unambiguous breach.
    function _dump() internal {
        vm.prank(deployerWallet);
        token.transfer(stranger, 150_000e18);
    }

    function _restore() internal {
        vm.prank(stranger);
        token.transfer(deployerWallet, 150_000e18);
    }

    function _flagAndConfirm(uint256 id) internal {
        escrow.flagCovenantBreach(id, 0);
        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());
        escrow.confirmCovenantBreach(id, 0);
    }

    // ─── Merkle helpers (2-leaf tree, OZ commutative hashing) ─────────

    function _leaf(uint256 index, address account, uint256 weight) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, weight))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    // ─── Opening ──────────────────────────────────────────────────────

    function test_ShipsInertUntilOperatorEnablesOpenings() public {
        LaunchRugEscrow fresh = new LaunchRugEscrow(address(weth), owner);
        assertFalse(fresh.openingsEnabled(), "openings must be off at deploy");
        assertEq(fresh.cleanReleaseFeeBps(), 0, "fee dial must default to zero");
        assertEq(fresh.feeSink(), address(0), "sink must default to zero");

        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = _tokenCovenant();
        vm.prank(creator);
        vm.expectRevert(LaunchRugEscrow.OpeningsDisabled.selector);
        fresh.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    function test_OpenPublishesImmutableTerms() public {
        uint256 id = _openBoth();

        LaunchRugEscrow.Escrow memory e = escrow.escrowTerms(id);
        assertEq(e.creator, creator);
        assertEq(e.token, address(token));
        assertEq(e.refundOracle, oracle);
        assertEq(uint256(e.principal), PRINCIPAL);
        assertEq(e.windowEnd, uint64(block.timestamp) + WINDOW);
        assertEq(uint256(e.status), uint256(LaunchRugEscrow.Status.Active));
        assertEq(e.cleanFeeBps, 0);

        assertEq(escrow.covenantCount(id), 2);
        (address asset, uint16 minBps, uint256 snapshotSupply, address[] memory holders) = escrow.covenantAt(id, 0);
        assertEq(asset, address(token));
        assertEq(minBps, MIN_BPS);
        assertEq(snapshotSupply, SUPPLY);
        assertEq(holders.length, 1);
        assertEq(holders[0], deployerWallet);

        (bool readable, uint256 bps, uint16 floorBps, bool breachedNow, uint64 flaggedAt) = escrow.covenantStatus(id, 0);
        assertTrue(readable);
        assertEq(bps, 3000);
        assertEq(floorBps, MIN_BPS);
        assertFalse(breachedNow);
        assertEq(flaggedAt, 0);

        assertEq(address(escrow).balance, PRINCIPAL);
    }

    function test_OpenRejectsZeroOracle() public {
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = _tokenCovenant();
        vm.prank(creator);
        vm.expectRevert(LaunchRugEscrow.ZeroAddress.selector);
        escrow.open{value: PRINCIPAL}(address(token), WINDOW, address(0), inputs);
    }

    function test_OpenRejectsDuplicateHolder() public {
        address[] memory holders = new address[](2);
        holders[0] = deployerWallet;
        holders[1] = deployerWallet;
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = LaunchRugEscrow.CovenantInput({asset: address(token), minBps: MIN_BPS, holders: holders});
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRugEscrow.DuplicateHolder.selector, deployerWallet));
        escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    function test_OpenRejectsCovenantThatIsAlreadyBreached() public {
        address[] memory holders = new address[](1);
        holders[0] = deployerWallet;
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = LaunchRugEscrow.CovenantInput({asset: address(token), minBps: 9000, holders: holders});
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRugEscrow.CovenantBornBreached.selector, 0));
        escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    function test_OpenRejectsUnbreachableZeroFloor() public {
        address[] memory holders = new address[](1);
        holders[0] = deployerWallet;
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = LaunchRugEscrow.CovenantInput({asset: address(token), minBps: 0, holders: holders});
        vm.prank(creator);
        vm.expectRevert(LaunchRugEscrow.MinBpsOutOfRange.selector);
        escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);
    }

    function test_OpenRejectsWindowShorterThanTheTriggerNeeds() public {
        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = _tokenCovenant();
        vm.prank(creator);
        vm.expectRevert(LaunchRugEscrow.WindowOutOfRange.selector);
        escrow.open{value: PRINCIPAL}(address(token), 1 days, oracle, inputs);
    }

    function test_DirectPaymentRejected() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "bare ETH must not be accepted");
    }

    // ─── Clean release ────────────────────────────────────────────────

    function test_CleanReleaseReturnsFullPrincipalWhenFeeDialIsZero() public {
        uint256 id = _openTokenOnly();
        vm.warp(block.timestamp + WINDOW + 1);

        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL);
        assertEq(address(escrow).balance, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Closed));
    }

    function test_CleanReleaseFeeIsSnapshottedAtOpenAndNotRetroactive() public {
        uint256 id = _openTokenOnly(); // opened while the dial is zero

        vm.startPrank(owner);
        escrow.setFeeSink(sink);
        escrow.setCleanReleaseFee(1000);
        vm.stopPrank();

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL, "live escrow keeps its published terms");
        assertEq(sink.balance, 0);
    }

    function test_CleanReleaseFeeAppliesToEscrowsOpenedAfterTheDialMoves() public {
        vm.startPrank(owner);
        escrow.setFeeSink(sink);
        escrow.setCleanReleaseFee(1000); // 10%, the cap
        vm.stopPrank();

        uint256 id = _openTokenOnly();
        assertEq(escrow.escrowTerms(id).cleanFeeBps, 1000);

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(sink.balance, PRINCIPAL / 10);
        assertEq(creator.balance - before, PRINCIPAL - PRINCIPAL / 10);
    }

    function test_FeeWithNoSinkIsSnapshottedAsZero() public {
        vm.prank(owner);
        escrow.setCleanReleaseFee(1000); // sink still address(0)

        uint256 id = _openTokenOnly();
        assertEq(escrow.escrowTerms(id).cleanFeeBps, 0, "a fee with nowhere to go is no fee");
    }

    function test_CleanReleaseFeeIsCapped() public {
        // Read the cap first: an external call in the argument position would otherwise be
        // the call `expectRevert` arms against, and would consume the prank.
        uint16 cap = escrow.MAX_CLEAN_RELEASE_FEE_BPS();
        vm.prank(owner);
        vm.expectRevert(LaunchRugEscrow.FeeTooHigh.selector);
        escrow.setCleanReleaseFee(cap + 1);

        // And the cap itself is accepted, so the boundary is exact rather than merely low.
        vm.prank(owner);
        escrow.setCleanReleaseFee(cap);
        assertEq(escrow.cleanReleaseFeeBps(), 1000);
    }

    function test_ReleaseRevertsBeforeWindowEnd() public {
        uint256 id = _openTokenOnly();
        vm.expectRevert(LaunchRugEscrow.WindowStillOpen.selector);
        escrow.releaseToCreator(id);
    }

    function test_CreatorCannotWithdrawEarlyByAnyPath() public {
        uint256 id = _openTokenOnly();
        vm.startPrank(creator);
        vm.expectRevert(LaunchRugEscrow.WindowStillOpen.selector);
        escrow.releaseToCreator(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRugEscrow.WrongStatus.selector, LaunchRugEscrow.Status.Breached, LaunchRugEscrow.Status.Active
            )
        );
        escrow.reclaimOnOracleSilence(id);
        vm.stopPrank();
        assertEq(address(escrow).balance, PRINCIPAL);
    }

    // ─── Trigger: griefing resistance ─────────────────────────────────

    function test_FlagRevertsWhileCovenantHolds() public {
        uint256 id = _openTokenOnly();
        vm.prank(stranger);
        vm.expectRevert(LaunchRugEscrow.CovenantSatisfied.selector);
        escrow.flagCovenantBreach(id, 0);
    }

    function test_DonatingTokensCannotManufactureABreach() public {
        uint256 id = _openTokenOnly();
        // A griefer can only ADD to a tracked balance, which moves the measurement away
        // from the floor.
        vm.prank(address(0xBEEF));
        token.transfer(deployerWallet, 100_000e18);
        vm.expectRevert(LaunchRugEscrow.CovenantSatisfied.selector);
        escrow.flagCovenantBreach(id, 0);
    }

    function test_AtomicManipulationCannotSeizeTheEscrow() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        // Same block: a flash-loaned or sandwiched state cannot survive to confirmation.
        vm.expectRevert(LaunchRugEscrow.CureWindowOpen.selector);
        escrow.confirmCovenantBreach(id, 0);
        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW() - 1);
        vm.expectRevert(LaunchRugEscrow.CureWindowOpen.selector);
        escrow.confirmCovenantBreach(id, 0);
    }

    function test_ConfirmSucceedsExactlyAtTheCureBoundary() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());
        escrow.confirmCovenantBreach(id, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Breached));
    }

    function test_CuringBeforeConfirmationClearsTheFlagAndCreatorStillReleases() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        _restore();

        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());
        escrow.confirmCovenantBreach(id, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Active));
        assertEq(escrow.covenantFlaggedAt(id, 0), 0);
        assertEq(escrow.escrowTerms(id).pendingFlags, 0);

        vm.warp(block.timestamp + WINDOW);
        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL);
    }

    function test_FlagAfterWindowEndIsRejected() public {
        uint256 id = _openTokenOnly();
        vm.warp(block.timestamp + WINDOW + 1);
        _dump();
        vm.expectRevert(LaunchRugEscrow.WindowClosed.selector);
        escrow.flagCovenantBreach(id, 0);
    }

    function test_BreachOnTheLastDayStillConfirmsAfterTheWindow() public {
        uint256 id = _openTokenOnly();
        vm.warp(block.timestamp + WINDOW - 1);
        _dump();
        escrow.flagCovenantBreach(id, 0);

        // Release is blocked while the flag is unresolved, even though the window ended.
        vm.warp(block.timestamp + 2);
        vm.expectRevert(LaunchRugEscrow.FlagsPending.selector);
        escrow.releaseToCreator(id);

        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());
        escrow.confirmCovenantBreach(id, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Breached));
    }

    function test_StaleFlagCannotParkTheEscrowForever() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        vm.warp(block.timestamp + WINDOW + 1);

        vm.expectRevert(LaunchRugEscrow.FlagsPending.selector);
        escrow.releaseToCreator(id);
        vm.expectRevert(LaunchRugEscrow.FlagExpired.selector);
        escrow.confirmCovenantBreach(id, 0);

        escrow.clearStaleFlag(id, 0);
        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL, "unconfirmed flags resolve to the creator");
    }

    function test_StaleFlagNotClearableEarly() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        vm.warp(block.timestamp + escrow.CONFIRM_DEADLINE_AFTER_FLAG());
        vm.expectRevert(LaunchRugEscrow.FlagNotStale.selector);
        escrow.clearStaleFlag(id, 0);
    }

    function test_LpCovenantTriggersIndependently() public {
        uint256 id = _openBoth();
        vm.prank(lpHolder);
        lp.transfer(stranger, 200e18); // 8000 bps -> 6000 bps, floor is 7000

        escrow.flagCovenantBreach(id, 1);
        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());
        escrow.confirmCovenantBreach(id, 1);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Breached));
    }

    // ─── Supply-direction robustness (denominator favours the creator) ─

    function test_MintingDilutionDoesNotBreach() public {
        uint256 id = _openTokenOnly();
        token.mint(address(0xBEEF), SUPPLY); // supply doubles, tracked wallet untouched
        (bool readable, uint256 bps,,,) = escrow.covenantStatus(id, 0);
        assertTrue(readable);
        assertEq(bps, 3000, "denominator pinned at the open-time snapshot");
        vm.expectRevert(LaunchRugEscrow.CovenantSatisfied.selector);
        escrow.flagCovenantBreach(id, 0);
    }

    function test_ThirdPartyBurnDoesNotBreach() public {
        uint256 id = _openTokenOnly();
        token.burn(address(0xBEEF), 500_000e18); // supply halves, tracked wallet untouched
        (bool readable, uint256 bps,,,) = escrow.covenantStatus(id, 0);
        assertTrue(readable);
        assertEq(bps, 6000, "shrinking supply raises the measured share");
        vm.expectRevert(LaunchRugEscrow.CovenantSatisfied.selector);
        escrow.flagCovenantBreach(id, 0);
    }

    // ─── Honesty gating: an outage is never a breach ──────────────────

    function test_Honesty_UnreadableBalanceReportsNoDataAndCannotFlag() public {
        uint256 id = _openTokenOnly();
        token.setBalanceOfReverts(true);

        (bool readable, uint256 bps, uint16 floorBps, bool breachedNow,) = escrow.covenantStatus(id, 0);
        assertFalse(readable, "a reverting token must report NO DATA");
        assertEq(bps, 0, "zero here means unmeasured, and the flag beside it says so");
        assertEq(floorBps, MIN_BPS, "published terms stay readable during an outage");
        assertFalse(breachedNow, "an unreadable covenant is never reported as breached");

        vm.expectRevert(abi.encodeWithSelector(LaunchRugEscrow.CovenantUnreadable.selector, id, 0));
        escrow.flagCovenantBreach(id, 0);
    }

    function test_Honesty_UnreadableTotalSupplyReportsNoDataAndCannotFlag() public {
        uint256 id = _openTokenOnly();
        token.setTotalSupplyReverts(true);

        (bool readable,,, bool breachedNow,) = escrow.covenantStatus(id, 0);
        assertFalse(readable);
        assertFalse(breachedNow);

        vm.expectRevert(abi.encodeWithSelector(LaunchRugEscrow.CovenantUnreadable.selector, id, 0));
        escrow.flagCovenantBreach(id, 0);
    }

    function test_Honesty_OutageDuringConfirmationCannotSeizeAFlaggedEscrow() public {
        uint256 id = _openTokenOnly();
        _dump();
        escrow.flagCovenantBreach(id, 0);
        vm.warp(block.timestamp + escrow.BREACH_CURE_WINDOW());

        token.setBalanceOfReverts(true);
        vm.expectRevert(abi.encodeWithSelector(LaunchRugEscrow.CovenantUnreadable.selector, id, 0));
        escrow.confirmCovenantBreach(id, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Active));

        // Once the token answers again the real breach is still there and still confirmable.
        token.setBalanceOfReverts(false);
        escrow.confirmCovenantBreach(id, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Breached));
    }

    function test_Honesty_TrustModelIsPublished() public {
        string memory model = escrow.TRUST_MODEL();
        assertGt(bytes(model).length, 0, "the trust assumption must be readable on-chain");
    }

    // ─── Refund path ──────────────────────────────────────────────────

    function test_ProRataRefundsSumToPrincipal() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        // buyerA bought 3x what buyerB did.
        bytes32 leafA = _leaf(0, buyerA, 300);
        bytes32 leafB = _leaf(1, buyerB, 100);
        bytes32 root = _pair(leafA, leafB);
        vm.prank(oracle);
        escrow.postRefundRoot(id, root, 400);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        escrow.claimRefund(id, 0, buyerA, 300, proofA);
        escrow.claimRefund(id, 1, buyerB, 100, proofB);

        assertEq(buyerA.balance, (PRINCIPAL * 3) / 4);
        assertEq(buyerB.balance, PRINCIPAL / 4);
        assertEq(buyerA.balance + buyerB.balance, PRINCIPAL);
        assertEq(address(escrow).balance, 0);
    }

    function test_VenueTakesNothingOnTheRefundPath() public {
        vm.startPrank(owner);
        escrow.setFeeSink(sink);
        escrow.setCleanReleaseFee(1000);
        vm.stopPrank();

        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        escrow.claimRefund(id, 0, buyerA, 1, proofA);

        assertEq(sink.balance, 0, "no venue fee on a breach path");
    }

    function test_DoubleClaimRejected() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        escrow.claimRefund(id, 0, buyerA, 1, proofA);
        vm.expectRevert(LaunchRugEscrow.AlreadyClaimed.selector);
        escrow.claimRefund(id, 0, buyerA, 1, proofA);
    }

    function test_ForgedProofRejected() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafB;
        vm.expectRevert(LaunchRugEscrow.InvalidProof.selector);
        escrow.claimRefund(id, 2, stranger, 1, proof);
        vm.expectRevert(LaunchRugEscrow.InvalidProof.selector);
        escrow.claimRefund(id, 0, buyerA, 1_000_000, proof);
    }

    function test_OverAllocatingRootCannotDrainMoreThanThePrincipal() public {
        uint256 id = _openTokenOnly();
        uint256 other = _openTokenOnly(); // a second escrow's money must stay untouched
        _dump();
        _flagAndConfirm(id);

        // totalWeight understates the leaves: each leaf claims the whole principal.
        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 1);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        escrow.claimRefund(id, 0, buyerA, 1, proofA);
        assertEq(buyerA.balance, PRINCIPAL);
        vm.expectRevert(LaunchRugEscrow.NothingToClaim.selector);
        escrow.claimRefund(id, 1, buyerB, 1, proofB);

        assertEq(address(escrow).balance, PRINCIPAL, "the other escrow is untouched");
        assertEq(uint256(escrow.escrowTerms(other).principal), PRINCIPAL);
    }

    function test_OnlyNamedOracleCanPostTheRoot() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        vm.prank(stranger);
        vm.expectRevert(LaunchRugEscrow.NotRefundOracle.selector);
        escrow.postRefundRoot(id, bytes32(uint256(1)), 1);

        vm.prank(owner);
        vm.expectRevert(LaunchRugEscrow.NotRefundOracle.selector);
        escrow.postRefundRoot(id, bytes32(uint256(1)), 1);
    }

    function test_OracleSilenceReturnsPrincipalToTheCreator() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        vm.expectRevert(LaunchRugEscrow.DeadlineNotReached.selector);
        escrow.reclaimOnOracleSilence(id);

        vm.warp(block.timestamp + escrow.REFUND_ROOT_WINDOW() + 1);
        uint256 before = creator.balance;
        escrow.reclaimOnOracleSilence(id);
        assertEq(creator.balance - before, PRINCIPAL, "a silent oracle cannot redirect a wei");
        assertEq(address(escrow).balance, 0);

        // And it can no longer post, so the outcome is final rather than racing.
        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRugEscrow.WrongStatus.selector, LaunchRugEscrow.Status.Breached, LaunchRugEscrow.Status.Closed
            )
        );
        escrow.postRefundRoot(id, bytes32(uint256(1)), 1);
    }

    function test_LateRootRejected() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);
        vm.warp(block.timestamp + escrow.REFUND_ROOT_WINDOW() + 1);
        vm.prank(oracle);
        vm.expectRevert(LaunchRugEscrow.DeadlinePassed.selector);
        escrow.postRefundRoot(id, bytes32(uint256(1)), 1);
    }

    function test_UnclaimedRemainderSweepsToTheCreator() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        escrow.claimRefund(id, 0, buyerA, 1, proofA);

        vm.warp(block.timestamp + escrow.REFUND_CLAIM_WINDOW() + 1);
        uint256 before = creator.balance;
        escrow.sweepRemainderToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL / 2);
        assertEq(address(escrow).balance, 0);
    }

    function test_ClaimAfterDeadlineRejected() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);
        vm.warp(block.timestamp + escrow.REFUND_CLAIM_WINDOW() + 1);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.expectRevert(LaunchRugEscrow.DeadlinePassed.selector);
        escrow.claimRefund(id, 0, buyerA, 1, proofA);
    }

    // ─── Payout robustness ────────────────────────────────────────────

    function test_RecipientThatRejectsEthIsPaidInWethNotBricked() public {
        RejectingRecipient hostile = new RejectingRecipient();
        vm.deal(address(hostile), 100 ether);

        LaunchRugEscrow.CovenantInput[] memory inputs = new LaunchRugEscrow.CovenantInput[](1);
        inputs[0] = _tokenCovenant();
        vm.prank(address(hostile));
        uint256 id = escrow.open{value: PRINCIPAL}(address(token), WINDOW, oracle, inputs);

        vm.warp(block.timestamp + WINDOW + 1);
        escrow.releaseToCreator(id);
        assertEq(weth.balanceOf(address(hostile)), PRINCIPAL, "payout falls back to WETH");
        assertEq(address(escrow).balance, 0);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Closed));
    }

    function test_ReentrantClaimerCannotBePaidTwice() public {
        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        ReentrantClaimer attacker = new ReentrantClaimer(escrow, id, 0, 1);
        bytes32 leafA = _leaf(0, address(attacker), 1);
        bytes32 leafB = _leaf(1, buyerB, 1);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), 2);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        attacker.setProof(proofA);
        attacker.claim();

        uint256 paid = address(attacker).balance + weth.balanceOf(address(attacker));
        assertEq(paid, PRINCIPAL / 2, "exactly one share, however the ETH landed");
        assertEq(address(escrow).balance, PRINCIPAL / 2, "buyerB's share is still there");
        assertTrue(escrow.isRefundClaimed(id, 0));
        assertFalse(escrow.isRefundClaimed(id, 1));
    }

    // ─── Admin surface ────────────────────────────────────────────────

    function test_OwnerCannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(OwnableNoRenounce.RenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function test_OwnerHasNoPathToPrincipal() public {
        uint256 id = _openTokenOnly();
        // Disabling openings must not disturb a live escrow.
        vm.prank(owner);
        escrow.setOpeningsEnabled(false);
        assertEq(uint256(escrow.escrowTerms(id).status), uint256(LaunchRugEscrow.Status.Active));
        assertEq(address(escrow).balance, PRINCIPAL);

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 before = creator.balance;
        escrow.releaseToCreator(id);
        assertEq(creator.balance - before, PRINCIPAL);
    }

    function test_NonOwnerCannotTouchDials() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        escrow.setOpeningsEnabled(false);
        vm.expectRevert();
        escrow.setCleanReleaseFee(100);
        vm.expectRevert();
        escrow.setFeeSink(stranger);
        vm.stopPrank();
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────

    function testFuzz_ProRataNeverExceedsPrincipal(uint96 weightA, uint96 weightB) public {
        weightA = uint96(bound(weightA, 1, type(uint96).max));
        weightB = uint96(bound(weightB, 1, type(uint96).max));

        uint256 id = _openTokenOnly();
        _dump();
        _flagAndConfirm(id);

        bytes32 leafA = _leaf(0, buyerA, weightA);
        bytes32 leafB = _leaf(1, buyerB, weightB);
        vm.prank(oracle);
        escrow.postRefundRoot(id, _pair(leafA, leafB), uint256(weightA) + uint256(weightB));

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        uint256 paid;
        try escrow.claimRefund(id, 0, buyerA, weightA, proofA) {
            paid += buyerA.balance;
        } catch {}
        try escrow.claimRefund(id, 1, buyerB, weightB, proofB) {
            paid += buyerB.balance;
        } catch {}

        assertLe(paid, PRINCIPAL);
        assertEq(paid + address(escrow).balance, PRINCIPAL);
    }
}
