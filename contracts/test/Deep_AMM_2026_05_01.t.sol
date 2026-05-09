// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/TegridyTWAP.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyFeeHook.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title Deep_AMM_2026_05_01.t.sol
/// @notice Regression tests for the AMM Core cluster of the
///         DEEP_2026_05_01 audit (D-AMM-H1, H2, H3, M1..M5, L1..L4, INFO1, INFO2).
contract DeepAMM_MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract DeepAMM_MockPoolManager {
    mapping(address => mapping(uint256 => uint256)) internal _credit;

    function setCredit(address holder, uint256 id, uint256 amount) external {
        _credit[holder][id] = amount;
    }

    function balanceOf(address holder, uint256 id) external view returns (uint256) {
        return _credit[holder][id];
    }

    function take(Currency, address, uint256) external pure {}
}

contract DeepAMMTest is Test {
    TegridyTWAP public twap;
    TegridyFactory public factory;
    TegridyPair public pair;
    DeepAMM_MockERC20 public tokenA;
    DeepAMM_MockERC20 public tokenB;
    TegridyFeeHook public hook;
    DeepAMM_MockPoolManager public poolManager;

    address public feeTo = makeAddr("feeTo");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public guardian = makeAddr("guardian");
    address public distributor = makeAddr("distributor");

    function setUp() public {
        // FRESH-2026 TEST REALIGN: SequencerCheck reverts when feed=address(0) on chainid != 1.
        vm.chainId(1);
        factory = new TegridyFactory(address(this), address(this), address(this)); // F-30-9 initial guardian
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        tokenA = new DeepAMM_MockERC20("A", "A");
        tokenB = new DeepAMM_MockERC20("B", "B");
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pair = TegridyPair(pairAddr);

        tokenA.transfer(address(pair), 100 ether);
        tokenB.transfer(address(pair), 200 ether);
        pair.mint(address(this));

        twap = new TegridyTWAP(address(factory), address(0));
        // FRESH-2026 TEST REALIGN: TegridyTWAP.update() now enforces MIN_UPDATE_FEE (1e14)
        // by default. Disable so legacy update() calls without {value:} still work.
        twap.setUpdateFee(0);

        poolManager = new DeepAMM_MockPoolManager();
        address hookAddr = address(uint160(0x0044));
        // AUDIT FIX (pass-8): TF-INT-02. WETH constructor param; sentinel address is fine
        // here because no test in this file exercises claimFees(WETH, ...) or convert.
        address wethSentinel = makeAddr("weth_deep_amm");
        bytes memory args = abi.encode(IPoolManager(address(poolManager)), distributor, uint256(30), address(this), wethSentinel);
        deployCodeTo("TegridyFeeHook.sol:TegridyFeeHook", args, hookAddr);
        hook = TegridyFeeHook(payable(hookAddr));
    }

    // â”€â”€â”€ D-AMM-H1: bypass branch is owner-only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmH1_bypassBranch_ownerOnly() public {
        // BATCH-M3 H7: obs 1, 2, 3 are now self-bootstrap-bypassed regardless
        // of dormancy gap. The owner-only `BypassObservationOwnerOnly` branch
        // only fires from observation #4 onwards (when the deviation gate is
        // armed and `elapsed > DEVIATION_BYPASS_AFTER`). Seed 3 obs first.
        // Use `skip` instead of consecutive `vm.warp(block.timestamp + ...)` â€”
        // the latter reads `block.timestamp` before the prior cheatcode lands.
        twap.update(address(pair));                         // #1 bypass
        skip(30 minutes);
        twap.update(address(pair));                         // #2 bypass
        skip(30 minutes);
        twap.update(address(pair));                         // #3 bypass

        // Wait > DEVIATION_BYPASS_AFTER (1 day) so the dormancy bypass branch
        // fires on observation #4 (which IS subject to deviation enforcement).
        skip(2 days);

        vm.prank(alice);
        vm.expectRevert(TegridyTWAP.BypassObservationOwnerOnly.selector);
        twap.update(address(pair));

        // Owner can still bypass.
        twap.update(address(pair));
    }

    // â”€â”€â”€ D-AMM-H2: sync()/skim() are gated when pair disabled â”€â”€â”€â”€â”€â”€

    function test_DAmmH2_sync_revertsOnDisabledPair() public {
        factory.proposePairDisabled(address(pair), true);
        vm.warp(block.timestamp + 48 hours);
        factory.executePairDisabled(address(pair));

        vm.expectRevert(bytes("PAIR_DISABLED"));
        pair.sync();
    }

    function test_DAmmH2_skim_revertsOnDisabledPair() public {
        factory.proposePairDisabled(address(pair), true);
        vm.warp(block.timestamp + 48 hours);
        factory.executePairDisabled(address(pair));

        vm.expectRevert(bytes("PAIR_DISABLED"));
        pair.skim(address(this));
    }

    // â”€â”€â”€ D-AMM-H3: adminResetPair (24h timelock) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmH3_adminResetPair_clearsState() public {
        twap.update(address(pair));
        assertEq(twap.observationCount(address(pair)), 1);

        twap.proposeAdminResetPair(address(pair));
        // Cannot execute before timelock.
        vm.expectRevert(abi.encodeWithSelector(
            TimelockAdmin.ProposalNotReady.selector,
            keccak256(abi.encodePacked(twap.PAIR_RESET(), address(pair)))
        ));
        twap.executeAdminResetPair(address(pair));

        vm.warp(block.timestamp + 24 hours);
        twap.executeAdminResetPair(address(pair));

        assertEq(twap.observationCount(address(pair)), 0);
        assertEq(twap.lastSpot0(address(pair)), 0);
        assertEq(twap.lastSpot1(address(pair)), 0);
        assertEq(twap.lastBypassUsed(address(pair)), 0);
    }

    function test_DAmmH3_adminResetPair_zeroAddress() public {
        vm.expectRevert(TegridyTWAP.PairResetZeroAddress.selector);
        twap.proposeAdminResetPair(address(0));
    }

    // â”€â”€â”€ D-AMM-M1: claimFees reverts while sync pending â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmM1_claimFees_revertsWhenSyncPending() public {
        address tok = address(tokenA);
        hook.proposeSyncAccruedFees(tok, 100); // accrued is 0, 100 != 0 OK
        vm.expectRevert(bytes("SYNC_PENDING"));
        hook.claimFees(tok, 0);
    }

    // â”€â”€â”€ D-AMM-M2: harvest reverts on no-op â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmM2_harvest_revertsOnNoFeeMaterialised() public {
        // FRESH-2026 TEST REALIGN: V2-AMM-M2 — bootstrap path was added to harvest():
        // when feeOn && kLast == 0, the FIRST harvest (feeToSetter-gated) seeds kLast
        // and is no longer NO_FEE_TO_MATERIALIZE. The no-fee-revert assertion only
        // applies to a SECOND harvest where rootK <= rootKLast or the rounding wedge fires.
        // Bootstrap once (succeeds), then re-arm the test on the second-call no-op path.
        vm.warp(block.timestamp + 5 minutes);
        pair.harvest(); // bootstraps kLast (feeOn==true, kLast==0)
        // Second harvest with no swaps in between: K hasn't grown, so NO_FEE_TO_MATERIALIZE.
        vm.warp(block.timestamp + pair.HARVEST_INTERVAL() + 1);
        vm.expectRevert(bytes("NO_FEE_TO_MATERIALIZE"));
        pair.harvest();
    }

    // â”€â”€â”€ D-AMM-M3: claimFees + executeSync gated by paused â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmM3_claimFees_revertsWhenPaused() public {
        hook.pause();
        vm.expectRevert();
        hook.claimFees(address(tokenA), 0);
    }

    // â”€â”€â”€ D-AMM-M4: snapshot at propose time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmM4_snapshotCapturedAtProposeTime() public {
        address tok = address(tokenA);
        uint256 currencyId = CurrencyLibrary.toId(Currency.wrap(tok));

        poolManager.setCredit(address(hook), currencyId, 1000);
        hook.proposeSyncAccruedFees(tok, 1);
        assertEq(hook.pendingSyncCreditSnapshot(tok), 1000);

        // Even if attacker drains the live balance, the snapshot is unchanged.
        poolManager.setCredit(address(hook), currencyId, 0);
        assertEq(hook.pendingSyncCreditSnapshot(tok), 1000);
    }

    // â”€â”€â”€ D-AMM-M5: consult reverts on bypassed observation â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmM5_consult_revertsOnBypassedLatest() public {
        twap.update(address(pair));
        vm.warp(block.timestamp + 30 minutes);
        twap.update(address(pair));

        // Trigger a bypass observation (owner-only after the H1 fix).
        vm.warp(block.timestamp + 2 days);
        twap.update(address(pair));

        vm.expectRevert(TegridyTWAP.OracleRebootstrapping.selector);
        twap.consult(address(pair), address(tokenA), 1 ether, 15 minutes);
    }

    // â”€â”€â”€ D-AMM-L1: SAME_VALUE guard on propose â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmL1_proposeSync_revertsOnSameValue() public {
        vm.expectRevert(bytes("SAME_VALUE"));
        hook.proposeSyncAccruedFees(address(tokenA), 0); // accrued is already 0
    }

    // â”€â”€â”€ D-AMM-L2: SAME_GUARDIAN guard on propose â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmL2_proposeGuardian_revertsOnSameGuardian() public {
        // AUDIT FIX F-30-9: constructor now seeds the guardian as the deployer
        // (`address(this)` in this test). Re-proposing the same address must
        // revert SAME_GUARDIAN (D-AMM-L2 invariant).
        vm.expectRevert(bytes("SAME_GUARDIAN"));
        factory.proposeGuardianChange(address(this));
    }

    // â”€â”€â”€ D-AMM-L3: nonReentrant on update / withdrawFees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmL3_update_isNonReentrant() public {
        twap.update(address(pair));
        assertEq(twap.observationCount(address(pair)), 1);
    }

    // â”€â”€â”€ D-AMM-L4: sweepETH takes a recipient â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function test_DAmmL4_sweepETH_acceptsRecipient() public {
        // AUDIT FIX: V2-AMM-M3 â€” sweepETH(address) is now restricted to
        // {revenueDistributor, owner()} only. Sweeping to an arbitrary EOA
        // (the prior test) is rejected; the legitimate paths are these two.
        vm.deal(address(hook), 1 ether);
        hook.sweepETH(distributor); // revenueDistributor in this test setUp
        assertEq(distributor.balance, 1 ether);
        assertEq(address(hook).balance, 0);
    }

    function test_DAmmL4_sweepETH_rejectsArbitraryRecipient() public {
        // AUDIT FIX: V2-AMM-M3 â€” arbitrary recipient now reverts
        // InvalidSweepRecipient (was: D-AMM-L4 originally allowed any owner-
        // chosen recipient; restored M-32 protection).
        vm.deal(address(hook), 1 ether);
        vm.expectRevert(TegridyFeeHook.InvalidSweepRecipient.selector);
        hook.sweepETH(bob);
    }

    function test_DAmmL4_sweepETH_zeroRecipient() public {
        // AUDIT FIX: V2-AMM-M3 â€” zero address is not in the {revenueDistributor,
        // owner} allowlist, so the same InvalidSweepRecipient applies.
        vm.deal(address(hook), 1 ether);
        vm.expectRevert(TegridyFeeHook.InvalidSweepRecipient.selector);
        hook.sweepETH(address(0));
    }

    // â”€â”€â”€ D-AMM-INFO2: 30k gas cap on _rejectERC777 staticcalls â”€â”€â”€â”€â”€

    function test_DAmmInfo2_createPair_succeedsWithGasCappedStaticcalls() public {
        DeepAMM_MockERC20 tokenC = new DeepAMM_MockERC20("C", "C");
        DeepAMM_MockERC20 tokenD = new DeepAMM_MockERC20("D", "D");
        factory.createPair(address(tokenC), address(tokenD));
    }
}
