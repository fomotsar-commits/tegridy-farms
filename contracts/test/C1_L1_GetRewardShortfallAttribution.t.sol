// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";

contract C1L1MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract C1L1MockNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @notice A minimal stand-in for a TRACKED holder (lending escrow / restaking
///         contract). It only needs to (a) hold a staking position NFT, (b) be
///         flagged via `applyLendingContract` so `_isTrackedHolder(this)` is true,
///         and (c) be able to forward `getReward` / `claimUnsettledForTokenId`
///         calls to the staking contract so `msg.sender == this`.
contract TrackedHolderMock {
    TegridyStaking public immutable staking;
    constructor(TegridyStaking _staking) { staking = _staking; }

    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function callClaimUnsettledForTokenId(uint256 tokenId, address recipient)
        external
        returns (uint256)
    {
        return staking.claimUnsettledForTokenId(tokenId, recipient);
    }

    // Solady ERC721 `transferFrom` does not invoke onERC721Received, so a receiver
    // hook is not strictly required for the staking-NFT inbound transfer. Provided
    // defensively in case any internal path uses a safe transfer.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}

/// @title C1_L1 — `_getReward` per-tokenId shortfall attribution for tracked holders
/// @notice Regression test for AUDIT FIX L1 in `TegridyStaking._getReward`.
///
///         THE FIX (src/TegridyStaking.sol, ~L1728):
///           uint256 actualSettled = _settleUnsettled(recipient, shortfall);
///           if (actualSettled > 0 && _isTrackedHolder(recipient)) {
///               unsettledRewardsByTokenId[tokenId] += actualSettled;   // <-- L1
///           }
///
///         WHY IT MATTERS: when the reward pool is under-funded AND the reward
///         recipient is a TRACKED holder (restaking contract or whitelisted
///         lending escrow), the shortfall is booked to
///         `unsettledRewards[recipient]`. Pre-fix it was NOT mirrored per-tokenId,
///         so the credit was permanently stranded:
///           * `claimUnsettledFor(trackedHolder)` reverts (tracked-holder guard,
///             see TegridyStaking.claimUnsettledFor L1891), and
///           * `claimUnsettledForTokenId(tokenId, …)` read a ZERO
///             `unsettledRewardsByTokenId[tokenId]` (L1944-1945 early-returns 0).
///         `kick()` (L1344) and `_settleRewardsOnTransfer()` (L1783/L1817) already
///         did this per-tokenId write; `_getReward` was the missing sibling.
///
///         This test proves the fund-recovery path end-to-end: the shortfall is
///         recorded per-tokenId by THIS `getReward` call, and is then recoverable
///         via `claimUnsettledForTokenId` once the pool is refunded.
contract C1L1GetRewardShortfallAttributionTest is Test {
    TegridyStaking public staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin public admin;
    C1L1MockToken public token;
    C1L1MockNFT public nft;
    TrackedHolderMock public mock;

    address public treasury = makeAddr("c1l1_treasury");
    address public alice = makeAddr("c1l1_alice");      // original staker -> escrows to mock
    address public squeezer = makeAddr("c1l1_squeezer"); // big co-staker used to starve the pool
    address public eoaCtrl = makeAddr("c1l1_eoaCtrl");   // control: a plain EOA recipient
    address public payee = makeAddr("c1l1_payee");        // recipient of the recovered shortfall

    uint256 internal constant START_RATE = 1 ether; // 1 TOWELI / second

    function setUp() public {
        token = new C1L1MockToken();
        nft = new C1L1MockNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, START_RATE);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        mock = new TrackedHolderMock(staking);

        // Fund actors.
        token.transfer(alice, 10_000_000 ether);
        token.transfer(squeezer, 500_000_000 ether);
        token.transfer(eoaCtrl, 10_000_000 ether);

        vm.prank(alice);    token.approve(address(staking), type(uint256).max);
        vm.prank(squeezer); token.approve(address(staking), type(uint256).max);
        vm.prank(eoaCtrl);  token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        // Two timelocked admin changes are needed before the test body:
        //   (1) whitelist the mock as a lending contract so
        //       `_isTrackedHolder(address(mock)) == true`, and
        //   (2) raise the unsettled cap so a ~100k-ether shortfall books in full
        //       without the L-06 `maxUnsettledRewards` cap (default 100_000e18)
        //       clipping it and confounding the per-tokenId attribution. Same
        //       idiom as R018 / TegridyRestaking shortfall tests.
        // Propose BOTH, warp ONCE past the shared 48h timelock, then execute both.
        admin.proposeLendingContract(address(mock), true);
        admin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeLendingContract();
        admin.executeMaxUnsettledRewards();
        assertTrue(staking.isLendingContract(address(mock)), "mock must be a tracked lending holder");
    }

    /// @dev Force `_accumulateRewards()` to bake all elapsed emission into
    ///      `rewardPerTokenStored` at the CURRENT (healthy) pool, then advance
    ///      `lastUpdateTime` to now. Calling `notifyRewardAmount` is the simplest
    ///      trigger (it carries the `updateReward` modifier). This is the crux of
    ///      the isolation: the pending must be locked in BEFORE we drain the pool,
    ///      otherwise `_accumulateRewards` (which itself caps to the pool) would
    ///      simply never accrue the pending and there would be no shortfall.
    function _bakeAccrualAtHealthyPool() internal {
        token.approve(address(staking), 1_000 ether);
        staking.notifyRewardAmount(1_000 ether); // MIN_NOTIFY_AMOUNT
        assertEq(staking.lastUpdateTime(), block.timestamp, "accrual baked: lastUpdateTime == now");
    }

    // ───────────────────────── helpers ─────────────────────────

    /// @dev Move a freshly-created position into the mock with a SHORTFALL-FREE
    ///      transfer, then have the mock claim once so the position's reward state
    ///      is fully current (rewardDebt advanced, per-tokenId mapping == 0).
    ///      This is the ISOLATION step: it guarantees any later per-tokenId credit
    ///      can ONLY come from the `_getReward` call under test, never from the
    ///      transfer-time `_settleRewardsOnTransfer`.
    function _seedMockPositionClean(uint256 principal) internal returns (uint256 tokenId) {
        // Fully fund so the transfer-settle and the first getReward both pay out
        // in full (no shortfall anywhere during seeding).
        token.approve(address(staking), 50_000_000 ether);
        staking.notifyRewardAmount(50_000_000 ether);

        // Alice stakes, waits out the 24h transfer cooldown, then escrows to mock.
        vm.prank(alice);
        staking.stake(principal, 365 days);
        tokenId = staking.userTokenId(alice);

        vm.warp(block.timestamp + 24 hours + 1);

        // On this inbound transfer `_settleRewardsOnTransfer(tokenId, alice)`
        // settles to ALICE (the EOA `from`), and only writes per-tokenId when
        // `_isTrackedHolder(from)` — which is false for the EOA. So the inbound
        // leg cannot touch `unsettledRewardsByTokenId[tokenId]`. We still verify
        // it is zero immediately after.
        vm.prank(alice);
        staking.transferFrom(alice, address(mock), tokenId);
        assertEq(staking.ownerOf(tokenId), address(mock), "mock should own the position");
        assertEq(
            staking.unsettledRewardsByTokenId(tokenId), 0,
            "ISOLATION: inbound transfer must not write per-tokenId credit"
        );

        // Mock claims once with the pool fully funded: pays out the transfer-window
        // accrual, advances rewardDebt to current, leaves per-tokenId mapping at 0.
        mock.callGetReward(tokenId);
        assertEq(
            staking.unsettledRewardsByTokenId(tokenId), 0,
            "ISOLATION: clean baseline - per-tokenId credit is 0 before the under-funded getReward"
        );
    }

    // ───────────────────────── main regression ─────────────────────────

    /// @notice Core proof: an under-funded `getReward` by a TRACKED holder records
    ///         the shortfall per-tokenId (L1 fix), and that credit is then
    ///         recoverable via `claimUnsettledForTokenId`.
    function test_C1L1_getRewardShortfall_attributesPerTokenId_forTrackedHolder() public {
        uint256 tokenId = _seedMockPositionClean(100_000 ether);

        // ── Phase B: accrue NEW rewards with the pool still healthy, with the
        //    mock as the SOLE booster so the full emission is owed to its tokenId.
        //    `rewardRate` is 1 TOWELI/s; with the mock the only booster the whole
        //    emission accrues to its tokenId, so pending ~= dt ether.
        uint256 dt = 100_000; // ~100_000 ether pending
        vm.warp(block.timestamp + dt);

        // Lock the elapsed emission into rewardPerTokenStored at the HEALTHY pool
        // (see helper natspec — this is what makes the later drain produce a real
        // shortfall instead of a never-accrued no-op).
        _bakeAccrualAtHealthyPool();

        uint256 pendingBefore = monitor.earned(tokenId);
        assertGt(pendingBefore, 0, "mock position must have accrued pending rewards");

        // ── Phase C: STARVE the pool. The mock's `pending` is already locked into
        //    `rewardPerTokenStored` (it was accrued while the pool was healthy).
        //    We now DRAIN the reward token out of the staking contract so that, at
        //    getReward time, `balance - reserved < pending`. This directly models a
        //    pool that has been depleted (e.g. paid out to other claimants) after
        //    the accrual — the exact precondition for the `_getReward` shortfall
        //    branch. Draining balance (vs. inflating reserved) is the clean lever:
        //    a stake's principal is added to BOTH balance and `totalStaked`, so it
        //    cannot shrink the pool. `_settleUnsettled`'s cap (maxUnsettledRewards,
        //    raised to 10M in setUp) comfortably covers the shortfall booked below.
        uint256 reserved0 = staking.totalStaked() + staking.totalUnsettledRewards();
        uint256 bal0 = token.balanceOf(address(staking));
        // Leave only a thin reward pool (`reserved0 + leftoverPool`) so the shortfall
        // is a large, clearly-non-trivial fraction of pending but the pay-out is
        // still > 0 (partial pay, not zero pay).
        uint256 leftoverPool = 1_000 ether; // pool can cover ~1_000 of the ~100_000 pending
        uint256 drain = bal0 - reserved0 - leftoverPool;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), drain);

        // Sanity: the reward pool is now smaller than the mock's pending → the
        // upcoming getReward MUST hit the shortfall branch.
        uint256 available = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        uint256 rewardPool = available > reserved ? available - reserved : 0;
        assertLt(rewardPool, pendingBefore, "pool must be under-funded vs pending to force the shortfall");
        assertGt(rewardPool, 0, "pool must still allow a partial pay-out (non-zero)");

        // Snapshot the per-tokenId credit and the tracked-holder bucket right
        // before the getReward under test (same block → no extra accrual happens
        // inside getReward beyond the Phase-B pending).
        uint256 perTokenBefore = staking.unsettledRewardsByTokenId(tokenId);
        uint256 holderBucketBefore = staking.unsettledRewards(address(mock));
        assertEq(perTokenBefore, 0, "baseline per-tokenId credit must be 0");

        // ── The call under test: tracked holder claims into an under-funded pool.
        uint256 paidOut = mock.callGetReward(tokenId);

        uint256 perTokenAfter = staking.unsettledRewardsByTokenId(tokenId);
        uint256 holderBucketAfter = staking.unsettledRewards(address(mock));

        // L1 FIX ASSERTION: the shortfall from THIS getReward was attributed to the
        // tokenId. Pre-fix this delta would be 0 (the credit landed only in
        // `unsettledRewards[mock]` with no per-tokenId mirror) and the funds would
        // be permanently stranded.
        uint256 perTokenCredit = perTokenAfter - perTokenBefore;
        assertGt(perTokenCredit, 0, "L1: shortfall must be recorded in unsettledRewardsByTokenId");

        // The per-tokenId credit must exactly equal the holder-bucket credit booked
        // on this same call — they are written in lockstep by the fix.
        uint256 bucketCredit = holderBucketAfter - holderBucketBefore;
        assertEq(perTokenCredit, bucketCredit, "per-tokenId credit must mirror the holder-bucket credit");

        // The shortfall accounting must reconcile: pending == paidOut + perTokenCredit
        // (the whole owed amount is either paid now or booked for later recovery).
        // Allow 1 wei for ACC_PRECISION integer rounding in the accumulator.
        assertApproxEqAbs(
            paidOut + perTokenCredit, pendingBefore, 1,
            "paid + booked-shortfall must reconcile to the pending owed"
        );
        // And it really was a shortfall (pool couldn't cover the whole pending).
        assertLt(paidOut, pendingBefore, "this must be the under-funded (partial-pay) path");

        // ── Phase D: top up the pool, then recover the stranded slice via the
        //    per-tokenId claim path. Pre-fix this returned 0 (mapping was 0) and
        //    the funds were unrecoverable.
        token.approve(address(staking), 50_000_000 ether);
        staking.notifyRewardAmount(50_000_000 ether);

        uint256 payeeBefore = token.balanceOf(payee);
        uint256 paid = mock.callClaimUnsettledForTokenId(tokenId, payee);

        assertEq(paid, perTokenCredit, "claimUnsettledForTokenId must pay the full recovered shortfall");
        assertEq(
            token.balanceOf(payee) - payeeBefore, perTokenCredit,
            "recovered shortfall must land at `recipient`"
        );
        assertEq(
            staking.unsettledRewardsByTokenId(tokenId), 0,
            "per-tokenId mapping must be decremented to 0 after recovery"
        );
        // Holder bucket decremented in lockstep.
        assertEq(
            staking.unsettledRewards(address(mock)), holderBucketBefore,
            "holder bucket must be decremented by the recovered amount"
        );
    }

    // ───────────────────────── control: scoped to tracked holders ─────────────────────────

    /// @notice Control: a normal EOA recipient hitting the SAME under-funded
    ///         shortfall does NOT get a per-tokenId entry. It uses the regular
    ///         `unsettledRewards` / `claimUnsettled` path. This confirms the L1
    ///         fix is scoped to tracked holders only (`_isTrackedHolder` guard).
    function test_C1L1_getRewardShortfall_noPerTokenIdEntry_forNormalEOA() public {
        // Fund generously, then have a normal EOA accrue pending.
        token.approve(address(staking), 50_000_000 ether);
        staking.notifyRewardAmount(50_000_000 ether);

        vm.prank(eoaCtrl);
        staking.stake(100_000 ether, 365 days);
        uint256 tokenId = staking.userTokenId(eoaCtrl);
        assertFalse(staking.isLendingContract(eoaCtrl), "control EOA must NOT be a tracked holder");

        vm.warp(block.timestamp + 100_000);
        // Bake the elapsed emission into rewardPerTokenStored at the healthy pool,
        // then drain so the EOA's getReward hits the same under-funded shortfall
        // branch the tracked-holder test exercises.
        _bakeAccrualAtHealthyPool();

        uint256 pendingBefore = monitor.earned(tokenId);
        assertGt(pendingBefore, 0, "control EOA must have accrued pending");

        // Drain the reward pool down to a thin sliver (same lever as the main test).
        uint256 reserved0 = staking.totalStaked() + staking.totalUnsettledRewards();
        uint256 bal0 = token.balanceOf(address(staking));
        uint256 drain = bal0 - reserved0 - 1_000 ether;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), drain);

        uint256 available = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        uint256 rewardPool = available > reserved ? available - reserved : 0;
        assertLt(rewardPool, pendingBefore, "pool must be under-funded for the control too");
        assertGt(rewardPool, 0, "control: pool must still allow a partial pay-out");

        uint256 holderBucketBefore = staking.unsettledRewards(eoaCtrl);

        vm.prank(eoaCtrl);
        uint256 paidOut = staking.getReward(tokenId);

        // The shortfall went to the regular per-user bucket...
        uint256 bucketCredit = staking.unsettledRewards(eoaCtrl) - holderBucketBefore;
        assertGt(bucketCredit, 0, "control: shortfall still booked to the regular unsettled bucket");
        assertLt(paidOut, pendingBefore, "control: must be the under-funded path");

        // ...but NO per-tokenId attribution was made (fix is tracked-holder-scoped).
        assertEq(
            staking.unsettledRewardsByTokenId(tokenId), 0,
            "control: a normal EOA must NOT get a per-tokenId entry"
        );

        // And the EOA recovers via the regular claimUnsettled path after a top-up.
        token.approve(address(staking), 50_000_000 ether);
        staking.notifyRewardAmount(50_000_000 ether);
        uint256 eoaBefore = token.balanceOf(eoaCtrl);
        vm.prank(eoaCtrl);
        staking.claimUnsettled();
        assertEq(
            token.balanceOf(eoaCtrl) - eoaBefore, bucketCredit,
            "control: EOA recovers the shortfall via claimUnsettled"
        );
    }

    receive() external payable {}
}
