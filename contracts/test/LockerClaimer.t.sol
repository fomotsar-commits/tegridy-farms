// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/LockerClaimer.sol";

// ─── Mock Contracts ────────────────────────────────────────────────────────

contract MockLC20 is ERC20 {
    constructor() ERC20("Launched", "LNCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Faithful stand-in for the DEPLOYED StreamableFeesLocker's payout semantics
///      (0xe24FC2F7191e850e2D4514aBb4d39305b1871eC6, V1 shape). The three properties
///      this contract exists to reproduce, all read off the verified source:
///        1. `releaseFees` is beneficiary-gated (`InvalidBeneficiary()`) and pays
///           `msg.sender` ONLY — never a passed-in recipient.
///        2. Native payout is Uniswap v4 `CurrencyLibrary.transfer`'s branch
///           `call(gas(), to, amount, 0,0,0,0)` — FULL gas, and it REVERTS the whole
///           release when the receiver fails. (Verified against the deployed runtime:
///           4 CALL sites, all preceded by GAS; the 2300 constant 0x08fc is absent.)
///        3. The locker's own Solady `nonReentrant` is HELD while it pays out, so a
///           beneficiary's `receive()` cannot call back into the locker.
///      currency0 (ETH) is paid before currency1 (the token), matching `_releaseFees`.
contract MockLocker {
    error PositionNotFound();
    error InvalidBeneficiary();
    error NativeTransferFailed();
    error Reentrancy();

    address public immutable token;
    bool private _entered;

    mapping(uint256 => bool) public positionExists;
    mapping(uint256 => mapping(address => bool)) public isBeneficiary;
    mapping(uint256 => mapping(address => uint256)) public ethClaims;
    mapping(uint256 => mapping(address => uint256)) public tokenClaims;

    constructor(address token_) {
        token = token_;
    }

    receive() external payable {}

    function credit(uint256 tokenId, address beneficiary, uint256 ethAmount, uint256 tokenAmount) external {
        positionExists[tokenId] = true;
        isBeneficiary[tokenId][beneficiary] = true;
        ethClaims[tokenId][beneficiary] += ethAmount;
        tokenClaims[tokenId][beneficiary] += tokenAmount;
    }

    function releaseFees(uint256 tokenId) external {
        if (_entered) revert Reentrancy();
        _entered = true;

        if (!positionExists[tokenId]) revert PositionNotFound();
        if (!isBeneficiary[tokenId][msg.sender]) revert InvalidBeneficiary();

        uint256 amount0 = ethClaims[tokenId][msg.sender];
        uint256 amount1 = tokenClaims[tokenId][msg.sender];
        ethClaims[tokenId][msg.sender] = 0;
        tokenClaims[tokenId][msg.sender] = 0;

        if (amount0 > 0) {
            (bool ok,) = msg.sender.call{value: amount0}("");
            if (!ok) revert NativeTransferFailed();
        }
        if (amount1 > 0) {
            ERC20(token).transfer(msg.sender, amount1);
        }

        _entered = false;
    }
}

/// @dev Mirrors the LIVE RevenueDistributor.receive(): warm SSTORE + LOG2 (~7k gas).
///      Deliberately NOT a bare `receive()` — a claimer that forwarded with a 2,300-gas
///      `transfer` would OOG against this and the test would catch it.
contract MockRevenueDistributor {
    uint256 public totalETHReceived = 1; // pre-warmed, like the real contract
    event ETHReceived(address indexed sender, uint256 amount);

    receive() external payable {
        unchecked {
            totalETHReceived += msg.value;
        }
        emit ETHReceived(msg.sender, msg.value);
    }
}

/// @dev A destination that refuses ETH — used to prove `claim` is atomic: if the push to
///      RevenueDistributor fails, the locker release must roll back too.
contract RejectingReceiver {
    receive() external payable {
        revert("NOPE");
    }
}

/// @dev Forwards via Solidity `.transfer()` (2,300-gas stipend) — used to prove the
///      claimer's `receive()` is bare enough to survive even a stipend-bound sender.
contract StipendSender {
    function send2300(address payable target, uint256 amount) external {
        target.transfer(amount);
    }
}

/// @dev ERC20 whose `transfer` calls back into the claimer. Models the arbitrary-external-call
///      surface `sweepToken(address)` necessarily has. The re-entry is wrapped in try/catch and
///      its outcome recorded, because Solady's `safeTransfer` masks an inner revert as its own
///      `TransferFailed()` — asserting on the recorded error is what actually proves the
///      reentrancy guard (rather than some incidental failure) rejected the call.
contract ReentrantToken is ERC20 {
    LockerClaimer public claimer;
    uint256 public mode; // 0 = none, 1 = re-enter sweepToken, 2 = re-enter claim
    uint256 public reentryTokenId;

    bool public reentryAttempted;
    bool public reentryReverted;
    bytes4 public reentryErrorSelector;

    constructor() ERC20("Hostile", "HOST") {}

    function arm(LockerClaimer claimer_, uint256 mode_, uint256 tokenId_) external {
        claimer = claimer_;
        mode = mode_;
        reentryTokenId = tokenId_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 1) {
            reentryAttempted = true;
            try claimer.sweepToken(address(this)) {}
            catch (bytes memory err) {
                reentryReverted = true;
                reentryErrorSelector = bytes4(err);
            }
        }
        if (mode == 2) {
            reentryAttempted = true;
            try claimer.claim(reentryTokenId) {}
            catch (bytes memory err) {
                reentryReverted = true;
                reentryErrorSelector = bytes4(err);
            }
        }
        return super.transfer(to, amount);
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

/// @title LockerClaimer — the protocol fee line's route back to veTOWELI stakers
/// @notice The locker is pull-based and self-addressed: it pays `msg.sender` and nobody else,
///         so RevenueDistributor (which has no arbitrary-call surface) can never be named as a
///         beneficiary directly. LockerClaimer is the smallest thing that CAN originate the
///         claim and forward the proceeds. These tests pin the behaviours that make that safe:
///         the ETH actually lands at the distributor, the ERC20 leg lands at the Safe rather
///         than at an ETH-only contract, the destinations cannot be redirected, a failed push
///         rolls the release back rather than consuming the credit, and — the one that would be
///         unrecoverable in production — `receive()` stays bare so it can never revert the
///         locker's payout. (Recovery would need the locker's `updateBeneficiary`, which this
///         contract deliberately cannot call, so from here a reverting `receive()` is terminal.)
contract LockerClaimerTest is Test {
    LockerClaimer internal claimer;
    MockLocker internal locker;
    MockRevenueDistributor internal revenueDistributor;
    MockLC20 internal token;

    address internal treasury = address(0x7D26);
    address internal keeper = makeAddr("keeper");

    uint256 internal constant TOKEN_ID = 42;

    event FeesForwarded(address indexed caller, uint256 amount);
    event TokenSwept(address indexed token, address indexed caller, uint256 amount);

    function setUp() public {
        token = new MockLC20();
        locker = new MockLocker(address(token));
        revenueDistributor = new MockRevenueDistributor();
        claimer = new LockerClaimer(address(locker), address(revenueDistributor), treasury);

        vm.deal(address(locker), 100 ether);
        token.mint(address(locker), 1_000_000 ether);
    }

    // ─── Constructor / immutability ────────────────────────────────────

    function test_constructor_wiresImmutablesAndExposesNoAdminSurface() public view {
        assertEq(address(claimer.locker()), address(locker), "locker");
        assertEq(claimer.revenueDistributor(), address(revenueDistributor), "revenueDistributor");
        assertEq(claimer.treasury(), treasury, "treasury");
    }

    function test_constructor_rejectsZeroLocker() public {
        vm.expectRevert(LockerClaimer.ZeroAddress.selector);
        new LockerClaimer(address(0), address(revenueDistributor), treasury);
    }

    function test_constructor_rejectsZeroRevenueDistributor() public {
        vm.expectRevert(LockerClaimer.ZeroAddress.selector);
        new LockerClaimer(address(locker), address(0), treasury);
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(LockerClaimer.ZeroAddress.selector);
        new LockerClaimer(address(locker), address(revenueDistributor), address(0));
    }

    // ─── claim: the headline behaviour ─────────────────────────────────

    /// @notice The whole point: ETH credited to the claimer inside the locker ends up at
    ///         RevenueDistributor, with nothing retained here.
    function test_claim_forwardsClaimedETHToRevenueDistributor() public {
        locker.credit(TOKEN_ID, address(claimer), 3 ether, 0);

        vm.expectEmit(true, false, false, true, address(claimer));
        emit FeesForwarded(keeper, 3 ether);

        vm.prank(keeper);
        claimer.claim(TOKEN_ID);

        assertEq(address(revenueDistributor).balance, 3 ether, "distributor should hold the fee");
        assertEq(address(claimer).balance, 0, "claimer must retain nothing");
    }

    /// @notice `claim` is permissionless — the money has exactly one destination, so an
    ///         unknown caller cannot redirect anything.
    function test_claim_isPermissionlessAndCannotRedirect() public {
        locker.credit(TOKEN_ID, address(claimer), 1 ether, 0);
        address stranger = address(0xBEEF);

        vm.prank(stranger);
        claimer.claim(TOKEN_ID);

        assertEq(address(revenueDistributor).balance, 1 ether, "distributor");
        assertEq(stranger.balance, 0, "caller must gain nothing");
    }

    /// @notice The locker's own guards bubble up rather than being swallowed — a keeper must
    ///         never see a successful tx for a claim that collected nothing.
    // A locker revert must propagate UNWRAPPED. A review flagged these two as vacuous because
    // they survived eight mutations; that was a gap in the mutation set, not in the tests. The
    // load-bearing assertion is the SELECTOR: wrapping the call in
    // `try locker.releaseFees(id) {} catch { revert ForwardFailed(); }` turns both red
    // (`ForwardFailed() != InvalidBeneficiary()`), i.e. they do pin "never mask the locker's own
    // error", which matters because a keeper reading our error instead of the locker's would
    // misdiagnose why a claim failed.
    //
    // The balance assertions below are SECONDARY and deliberately weak: the call reverts, so
    // state rolls back and they hold trivially. They are kept as documentation of the intended
    // post-condition, not as the thing under test. Do not mistake them for coverage.
    function test_claim_bubblesLockerRevertWhenNotBeneficiary() public {
        locker.credit(TOKEN_ID, address(0xCAFE), 1 ether, 0);
        uint256 sinkBefore = address(revenueDistributor).balance;
        uint256 lockerBefore = address(locker).balance;

        vm.expectRevert(MockLocker.InvalidBeneficiary.selector);
        claimer.claim(TOKEN_ID);

        assertEq(address(revenueDistributor).balance, sinkBefore, "no ETH may reach the sink");
        assertEq(address(locker).balance, lockerBefore, "locker must keep the funds");
        assertEq(address(claimer).balance, 0, "claimer must hold nothing");
        // The other beneficiary's credit is untouched — we never consumed someone else's slot.
        assertEq(locker.ethClaims(TOKEN_ID, address(0xCAFE)), 1 ether, "third-party credit intact");
    }

    function test_claim_bubblesLockerRevertForUnknownPosition() public {
        uint256 sinkBefore = address(revenueDistributor).balance;

        vm.expectRevert(MockLocker.PositionNotFound.selector);
        claimer.claim(999);

        assertEq(address(revenueDistributor).balance, sinkBefore, "no ETH may reach the sink");
        assertEq(address(claimer).balance, 0, "claimer must hold nothing");
    }

    /// @notice Atomicity: if the push to the distributor fails, the locker release must roll
    ///         back with it. Otherwise the credit would be consumed while the ETH sat in a
    ///         contract that had already zeroed its claim.
    function test_claim_revertsAndPreservesLockerCreditWhenForwardFails() public {
        RejectingReceiver bad = new RejectingReceiver();
        LockerClaimer brokenClaimer = new LockerClaimer(address(locker), address(bad), treasury);
        locker.credit(TOKEN_ID, address(brokenClaimer), 5 ether, 0);

        vm.expectRevert(LockerClaimer.ForwardFailed.selector);
        brokenClaimer.claim(TOKEN_ID);

        assertEq(locker.ethClaims(TOKEN_ID, address(brokenClaimer)), 5 ether, "credit must survive");
        assertEq(address(brokenClaimer).balance, 0, "nothing retained");
        assertEq(address(bad).balance, 0, "nothing delivered");
    }

    /// @notice A claim that releases only the ERC20 leg must not emit a phantom ETH forward.
    function test_claim_withNoETHLeg_emitsNoForward() public {
        locker.credit(TOKEN_ID, address(claimer), 0, 1_000 ether);

        vm.recordLogs();
        claimer.claim(TOKEN_ID);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(claimer)) {
                assertTrue(
                    logs[i].topics[0] != keccak256("FeesForwarded(address,uint256)"),
                    "must not report a zero-value forward"
                );
            }
        }
        assertEq(address(revenueDistributor).balance, 0, "no ETH should move");
    }

    // ─── receive(): the unrecoverable failure mode ─────────────────────

    /// @notice REGRESSION CANARY. The locker pays out through v4's `CurrencyLibrary.transfer`,
    ///         which reverts the ENTIRE `releaseFees` if the beneficiary's `receive()` fails —
    ///         and a launch's beneficiary set can never be re-pointed. So `receive()` must stay
    ///         a bare, cannot-possibly-revert body. `.transfer()`'s 2,300-gas stipend is the
    ///         strictest sender any future locker version could use; surviving it proves the
    ///         body carries no SSTORE, no LOG, no guard and no external call.
    ///
    ///         If you add ANYTHING to `LockerClaimer.receive()`, this test fails. That is the
    ///         intended outcome — do not relax it.
    function test_receive_staysBareEnoughForA2300GasStipend() public {
        StipendSender sender = new StipendSender();
        vm.deal(address(sender), 1 ether);

        sender.send2300(payable(address(claimer)), 1 ether);

        assertEq(address(claimer).balance, 1 ether, "bare receive must accept a stipend send");
    }

    /// @notice The claimer must not try to call back into the locker while the locker's own
    ///         reentrancy guard is held (i.e. from `receive()`), or every claim would revert.
    ///         MockLocker holds `_entered` across its payout exactly like the real Solady guard.
    function test_claim_succeedsWhileLockerReentrancyGuardIsHeld() public {
        locker.credit(TOKEN_ID, address(claimer), 2 ether, 500 ether);

        claimer.claim(TOKEN_ID); // reverts with Reentrancy() if receive() re-enters the locker

        assertEq(address(revenueDistributor).balance, 2 ether, "ETH leg delivered");
        assertEq(token.balanceOf(address(claimer)), 500 ether, "token leg parked pending sweep");
    }

    // ─── forwardETH: no ETH can be stranded ────────────────────────────

    /// @notice The contract has no owner and no rescue, so ETH that arrives WITHOUT a claim
    ///         (selfdestruct push, block reward, stray send) must still have a way out.
    function test_forwardETH_flushesETHThatArrivedOutsideAClaim() public {
        vm.deal(address(claimer), 7 ether);

        vm.prank(keeper);
        claimer.forwardETH();

        assertEq(address(revenueDistributor).balance, 7 ether, "stray ETH must reach the distributor");
        assertEq(address(claimer).balance, 0, "nothing stranded");
    }

    /// @notice A zero balance is a silent no-op, not a revert and not a zero-value event —
    ///         so a keeper batching over several positions is never blocked by an empty one.
    function test_forwardETH_zeroBalanceIsASilentNoOp() public {
        vm.recordLogs();
        claimer.forwardETH();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(claimer), "no event for an empty flush");
        }
    }

    // ─── sweepToken: the ERC20 leg ─────────────────────────────────────

    /// @notice RevenueDistributor distributes `address(this).balance` only — an ERC20 pushed
    ///         there is invisible to it and is NOT staker yield. The non-ETH fee leg therefore
    ///         has to go to the Safe.
    function test_sweepToken_sendsTheERC20LegToTreasuryNotTheDistributor() public {
        locker.credit(TOKEN_ID, address(claimer), 1 ether, 250_000 ether);
        claimer.claim(TOKEN_ID);

        vm.expectEmit(true, true, false, true, address(claimer));
        emit TokenSwept(address(token), keeper, 250_000 ether);

        vm.prank(keeper);
        claimer.sweepToken(address(token));

        assertEq(token.balanceOf(treasury), 250_000 ether, "treasury receives the token leg");
        assertEq(token.balanceOf(address(revenueDistributor)), 0, "ETH-only contract must get no tokens");
        assertEq(token.balanceOf(address(claimer)), 0, "nothing retained");
    }

    /// @notice An exotic (TOWELI-numeraire) launch has NO native leg at all — both currencies
    ///         are ERC20 and both must route to the Safe.
    function test_sweepToken_handlesBothLegsBeingERC20() public {
        MockLC20 toweli = new MockLC20();
        toweli.mint(address(claimer), 10 ether);
        locker.credit(TOKEN_ID, address(claimer), 0, 400 ether);
        claimer.claim(TOKEN_ID);

        claimer.sweepToken(address(token));
        claimer.sweepToken(address(toweli));

        assertEq(token.balanceOf(treasury), 400 ether, "launched token to treasury");
        assertEq(toweli.balanceOf(treasury), 10 ether, "numeraire token to treasury");
    }

    function test_sweepToken_zeroBalanceIsASilentNoOp() public {
        vm.recordLogs();
        claimer.sweepToken(address(token));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(claimer), "no event for an empty sweep");
        }
    }

    /// @notice `token` is caller-supplied, so a non-contract address must no-op rather than
    ///         revert or, worse, be treated as a successful transfer.
    function test_sweepToken_nonContractAddressIsANoOp() public {
        claimer.sweepToken(address(0));
        claimer.sweepToken(address(0xD00D));
    }

    /// @notice `sweepToken` is the contract's only arbitrary external call. A hostile token
    ///         must not be able to re-enter — even though the fixed destinations mean there is
    ///         nothing to steal, the guard keeps that conclusion from depending on an argument.
    function test_sweepToken_cannotBeReenteredByAHostileToken() public {
        ReentrantToken hostile = new ReentrantToken();
        hostile.mint(address(claimer), 100 ether);
        hostile.arm(claimer, 1, 0);

        claimer.sweepToken(address(hostile));

        assertTrue(hostile.reentryAttempted(), "the mock must actually have tried to re-enter");
        assertTrue(hostile.reentryReverted(), "re-entrant sweepToken must be rejected");
        assertEq(
            hostile.reentryErrorSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "rejected by the reentrancy guard, not by chance"
        );
        assertEq(hostile.balanceOf(treasury), 100 ether, "the outer sweep still completes, once");
    }

    /// @notice The cross-function leg: a hostile token must not be able to re-enter `claim`
    ///         from inside a sweep.
    function test_sweepToken_cannotReenterClaim() public {
        ReentrantToken hostile = new ReentrantToken();
        hostile.mint(address(claimer), 100 ether);
        locker.credit(TOKEN_ID, address(claimer), 1 ether, 0);
        hostile.arm(claimer, 2, TOKEN_ID);

        claimer.sweepToken(address(hostile));

        assertTrue(hostile.reentryReverted(), "re-entrant claim must be rejected");
        assertEq(
            hostile.reentryErrorSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "rejected by the reentrancy guard"
        );
        assertEq(locker.ethClaims(TOKEN_ID, address(claimer)), 1 ether, "locker credit untouched");
        assertEq(address(revenueDistributor).balance, 0, "no ETH moved during the sweep");
    }
}
