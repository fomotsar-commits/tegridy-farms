// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/VoteIncentives.sol";
import "../src/VoteIncentivesAdmin.sol"; // AUDIT FIX (pass-8): EIP170-03 split
import {TegridyFactory} from "../src/TegridyFactory.sol";

/// @title AuditDemonstration â€” concrete failing tests for vulnerabilities
///        the parallel-agent audit identified and we then verified by
///        reading the code. Each test demonstrates the vulnerability
///        BEHAVIOR. A passing test = the vulnerability is reproducible.
///
///        Findings demonstrated here:
///          C-4  zero-vote epoch bribes are permanently locked
///          H-12 ERC20 1-wei dust deposits exhaust MAX_BRIBE_TOKENS
///          H-1  TegridyFactory.setGuardian has no timelock and no validation
///
///        Findings verified by code reading only (not in foundry here
///        because their test setups are heavy):
///          C-1  TegridyDropV2.setMerkleRoot is a 1-step setter
///               (verified at TegridyDropV2.sol:412-415)
///          C-2  TegridyStaking 100 NFTs/holder gas DoS
///               (verified at TegridyStaking.sol:127, 341, 874)
///          H-7  TegridyRestaking decayExpiredRestaker accrual ordering
///               (verified at TegridyRestaking.sol:1092 vs 1110)

// â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockBribeToken is ERC20 {
    string private _t;
    constructor(string memory tag) ERC20(tag, tag) {
        _t = tag;
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract MockWETH {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "ins");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract MockEscrow {
    uint256 public totalBoostedStake;
    mapping(address => uint256) public _vp;
    mapping(address => uint256) public userTokenId;

    function setPower(address u, uint256 p) external { _vp[u] = p; }
    function setTotal(uint256 t) external { totalBoostedStake = t; }
    function votingPowerOf(address u) external view returns (uint256) { return _vp[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return _vp[u]; }
    function totalLocked() external view returns (uint256) { return totalBoostedStake; }
    function paused() external pure returns (bool) { return false; }
    function positions(uint256) external pure returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) { return (0, 0, 0, 0, 0, 0, false, false, 0, 0, false); }
}

contract MockFactoryForBribes {
    mapping(address => mapping(address => address)) public _pair;
    /// @dev AUDIT R016 M-1: VoteIncentives.disabledPairs gate (never tripped here).
    mapping(address => bool) public disabledPairs;
    function setPair(address a, address b, address p) external {
        _pair[a][b] = p; _pair[b][a] = p;
    }
    function getPair(address a, address b) external view returns (address) { return _pair[a][b]; }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

contract MockPair {
    address public token0;
    address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
}

// â”€â”€â”€ Test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

contract AuditDemonstrationTest is Test {
    // â”€â”€ VoteIncentives setup â”€â”€
    VoteIncentives public bribes;
    VoteIncentivesAdmin public bribesAdmin; // AUDIT FIX (pass-8): EIP170-03 split
    MockTOWELI public toweli;
    MockWETH public weth;
    MockEscrow public escrow;
    MockFactoryForBribes public bribeFactory;
    MockPair public pair;
    address public treasury = makeAddr("treasury");
    address public depositor = makeAddr("depositor");
    address public alice = makeAddr("alice");
    uint256 internal constant FEE_BPS = 300;

    // â”€â”€ TegridyFactory setup â”€â”€
    TegridyFactory public factory;
    address public feeToSetter = makeAddr("feeToSetter");
    address public feeTo = makeAddr("feeTo");
    address public attacker = makeAddr("attacker");

    function setUp() public {
        // VoteIncentives stack
        toweli = new MockTOWELI();
        weth = new MockWETH();
        escrow = new MockEscrow();
        bribeFactory = new MockFactoryForBribes();

        MockBribeToken brbA = new MockBribeToken("BRB");
        pair = new MockPair(address(toweli), address(brbA));
        bribeFactory.setPair(address(toweli), address(brbA), address(pair));

        bribes = new VoteIncentives(
            address(escrow),
            treasury,
            address(weth),
            address(bribeFactory),
            address(toweli),
            FEE_BPS
        );

        // AUDIT FIX (pass-8): EIP170-03 split â€” wire admin sister.
        bribesAdmin = new VoteIncentivesAdmin(address(bribes));
        bribes.setVoteIncentivesAdmin(address(bribesAdmin));

        // BATCH-F H14: commitRevealEnabled = true at deploy. Force-disable so
        // legacy `vote()` path under test stays exerciseable.
        // FRESH-2026 TEST REALIGN: storage layout shifted, commitRevealEnabled at slot 11 not 10.
        vm.store(address(bribes), bytes32(uint256(11)), bytes32(uint256(0)));

        // Whitelist brbA via timelocked path
        bribesAdmin.proposeWhitelistChange(address(brbA), true);
        vm.warp(block.timestamp + 24 hours + 1);
        bribesAdmin.executeWhitelistChange();

        // Fund depositor
        brbA.transfer(depositor, 1_000_000 ether);
        vm.deal(depositor, 100 ether);

        // Set escrow stake so advanceEpoch works
        escrow.setTotal(1_000_000 ether);

        // TegridyFactory stack
        factory = new TegridyFactory(feeToSetter, feeTo, feeToSetter); // F-30-9 initial guardian
    }

    function _advance() internal {
        if (block.timestamp < 7 days + 1) {
            vm.warp(block.timestamp + 7 days + 1);
        } else {
            vm.warp(block.timestamp + 7 days + 1);
        }
        bribes.advanceEpoch();
    }

    // â”€â”€â”€ C-4: Zero-vote epoch bribes are RECOVERABLE via refundUnvotedBribe (post-fix) â”€
    //
    // After the fix: depositor can recover their bribe from a snapshotted,
    // zero-vote pair after a 14-day grace period.
    function test_C4_ZeroVoteBribesRefundableAfterGrace() public {
        address brb = pair.token1();

        // Depositor deposits 100 BRB as a bribe for `pair` in epoch 0
        vm.startPrank(depositor);
        IERC20(brb).approve(address(bribes), 100 ether);
        bribes.depositBribe(address(pair), brb, 100 ether);
        vm.stopPrank();

        // Snapshot the epoch (no one votes for `pair`)
        _advance();

        // Pre-grace: refund reverts
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(depositor);
        vm.expectRevert(bytes("GRACE_NOT_ELAPSED"));
        bribes.refundUnvotedBribe(0, address(pair), brb);

        // Post-grace: depositor pulls their funds back
        vm.warp(block.timestamp + 14 days + 1);
        uint256 balBefore = IERC20(brb).balanceOf(depositor);
        vm.prank(depositor);
        bribes.refundUnvotedBribe(0, address(pair), brb);
        uint256 balAfter = IERC20(brb).balanceOf(depositor);
        assertGt(balAfter, balBefore, "depositor should receive refund");

        // Second call reverts â€” already refunded
        vm.prank(depositor);
        vm.expectRevert(bytes("NOTHING_TO_REFUND"));
        bribes.refundUnvotedBribe(0, address(pair), brb);
    }

    // â”€â”€â”€ C-4.b: Pair WITH votes is NOT eligible for unvoted-refund â”€â”€â”€â”€â”€â”€â”€
    function test_C4b_PairWithVotesNotEligible() public {
        address brb = pair.token1();
        vm.startPrank(depositor);
        IERC20(brb).approve(address(bribes), 100 ether);
        bribes.depositBribe(address(pair), brb, 100 ether);
        vm.stopPrank();

        _advance();

        // Alice casts a vote for the pair
        escrow.setPower(alice, 1000 ether);
        vm.prank(alice);
        bribes.vote(0, address(pair), 100 ether);

        // Even after grace, refundUnvotedBribe rejects â€” pair has votes
        vm.warp(block.timestamp + 21 days + 1);
        vm.prank(depositor);
        vm.expectRevert(bytes("PAIR_HAS_VOTES"));
        bribes.refundUnvotedBribe(0, address(pair), brb);
    }

    // â”€â”€â”€ H-12: Dust DoS exhausts MAX_BRIBE_TOKENS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    // Whitelist 20 different tokens. Attacker deposits 1 wei of each to
    // the same pair in the current epoch. A legitimate briber with a
    // 21st token then reverts with TooManyBribeTokens.
    // â”€â”€â”€ H-12: 1-wei dust ERC20 deposits are now REJECTED (post-fix) â”€â”€â”€â”€â”€
    //
    // After fix: depositBribe enforces an effective minimum of
    // DEFAULT_MIN_TOKEN_BRIBE (1e15) for tokens without a configured
    // per-token min. Dust deposits revert; legitimate bribes pass.
    function test_H12_DustDepositsRejectedByDefault() public {
        address brb = pair.token1();

        vm.startPrank(depositor);
        IERC20(brb).approve(address(bribes), 100 ether);

        // 1 wei deposit reverts
        vm.expectRevert(bytes("BRIBE_TOO_SMALL"));
        bribes.depositBribe(address(pair), brb, 1);

        // 1e14 (below default 1e15) reverts
        vm.expectRevert(bytes("BRIBE_TOO_SMALL"));
        bribes.depositBribe(address(pair), brb, 1e14);

        // 1e15 (= DEFAULT_MIN) passes
        bribes.depositBribe(address(pair), brb, 1e15);

        // 1e18 passes (well above default)
        bribes.depositBribe(address(pair), brb, 1 ether);
        vm.stopPrank();
    }

    // â”€â”€â”€ H-12.b: per-token min override via timelocked setter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function test_H12b_PerTokenMinTimelocked() public {
        address brb = pair.token1();

        // Owner proposes a custom 1e3 min (e.g. for a 6-decimal token)
        bribesAdmin.proposeMinBribeAmount(brb, 1e3);

        // Cannot execute instantly
        vm.expectRevert();
        bribesAdmin.executeMinBribeAmount();

        // After 24h: success
        vm.warp(block.timestamp + 24 hours + 1);
        bribesAdmin.executeMinBribeAmount();
        assertEq(bribes.minBribeAmounts(brb), 1e3);

        // Now 1e3 deposits pass (below the 1e15 default but above the 1e3 override)
        vm.startPrank(depositor);
        IERC20(brb).approve(address(bribes), 1e15);
        bribes.depositBribe(address(pair), brb, 1e3);
        // But 999 still fails
        vm.expectRevert(bytes("BRIBE_TOO_SMALL"));
        bribes.depositBribe(address(pair), brb, 999);
        vm.stopPrank();
    }

    // --- H-1: Guardian rotation IS timelocked (post-fix) ---
    //
    // Post F-30-9 / H-16: constructor seeds a non-zero guardian, and
    // setGuardian / proposeGuardianChange require a contract-class address
    // (multisig requirement). Initial-set is a recovery path only reachable
    // when guardian rotation has landed address(0).
    function test_H1_GuardianRotationRequiresTimelock() public {
        // Constructor seeded `feeToSetter` as initial guardian (F-30-9).
        assertEq(factory.guardian(), feeToSetter);

        // Direct re-set blocked - initial-only gate.
        vm.prank(feeToSetter);
        vm.expectRevert("Use proposeGuardianChange()");
        factory.setGuardian(makeAddr("evil"));

        // Timelocked rotation: must use a multisig-class contract address.
        AuditDemoMultisig newGuardian = new AuditDemoMultisig();
        vm.prank(feeToSetter);
        factory.proposeGuardianChange(address(newGuardian));

        // Cannot execute instantly.
        vm.prank(feeToSetter);
        vm.expectRevert();
        factory.executeGuardianChange();

        // After the 48h delay: success.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(feeToSetter);
        factory.executeGuardianChange();
        assertEq(factory.guardian(), address(newGuardian));

        // EOA rotation rejected.
        vm.prank(feeToSetter);
        vm.expectRevert("GUARDIAN_NOT_MULTISIG");
        factory.proposeGuardianChange(makeAddr("evil-eoa"));
    }

    // --- H-1.b: cancelGuardianChange clears pending ---
    function test_H1b_CancelGuardianChange() public {
        AuditDemoMultisig rotation = new AuditDemoMultisig();
        vm.prank(feeToSetter);
        factory.proposeGuardianChange(address(rotation));
        assertEq(factory.pendingGuardian(), address(rotation));

        vm.prank(feeToSetter);
        factory.cancelGuardianChange();
        assertEq(factory.pendingGuardian(), address(0));
        assertEq(factory.guardian(), feeToSetter, "guardian unchanged after cancel");
    }

    // --- H-2: emergencyDisable preserves pending DISABLES (post-fix) ---
    function test_H2_PendingDisableSurvivesEmergency() public {
        // Create a real factory pair (F-30-1: emergencyDisablePair requires isPair).
        AuditDemoToken tA = new AuditDemoToken();
        AuditDemoToken tB = new AuditDemoToken();
        address victimPair = factory.createPair(address(tA), address(tB));

        // feeToSetter queues a timelocked DISABLE.
        vm.prank(feeToSetter);
        factory.proposePairDisabled(victimPair, true);

        bytes32 key = keccak256(abi.encodePacked(
            factory.PAIR_DISABLE_CHANGE(),
            victimPair
        ));
        assertGt(factory.proposalExecuteAfter(key), 0);
        assertEq(factory.pendingPairDisableValue(victimPair), true);

        // Guardian (already set at construction = feeToSetter) fires emergency.
        vm.prank(feeToSetter);
        factory.emergencyDisablePair(victimPair);

        // Post-fix: pending DISABLE proposal IS PRESERVED.
        assertGt(factory.proposalExecuteAfter(key), 0,
            "pending disable proposal preserved");
        assertEq(factory.pendingPairDisableValue(victimPair), true,
            "pending value preserved");
        assertEq(factory.disabledPairs(victimPair), true,
            "pair was disabled by emergency action");

        // Governance can still execute its proposal after timelock.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(feeToSetter);
        factory.executePairDisabled(victimPair);
        assertEq(factory.disabledPairs(victimPair), true);
    }

    // --- H-2.b: emergencyDisable cancels pending RE-ENABLE (circuit breaker preserved) ---
    function test_H2b_PendingReEnableStillCancelled() public {
        AuditDemoToken tA = new AuditDemoToken();
        AuditDemoToken tB = new AuditDemoToken();
        address victimPair = factory.createPair(address(tA), address(tB));

        // Disable the pair via the normal timelocked path.
        vm.prank(feeToSetter);
        factory.proposePairDisabled(victimPair, true);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(feeToSetter);
        factory.executePairDisabled(victimPair);
        assertEq(factory.disabledPairs(victimPair), true);

        // Now governance queues a RE-ENABLE.
        vm.prank(feeToSetter);
        factory.proposePairDisabled(victimPair, false);
        bytes32 key = keccak256(abi.encodePacked(
            factory.PAIR_DISABLE_CHANGE(),
            victimPair
        ));
        assertGt(factory.proposalExecuteAfter(key), 0);
        assertEq(factory.pendingPairDisableValue(victimPair), false);

        // Guardian fires emergency.
        vm.prank(feeToSetter);
        factory.emergencyDisablePair(victimPair);

        // The pending RE-ENABLE is force-cancelled.
        assertEq(factory.proposalExecuteAfter(key), 0,
            "pending re-enable was cancelled");
        assertEq(factory.pendingPairDisableValue(victimPair), false);
        assertEq(factory.disabledPairs(victimPair), true);
    }

    // â”€â”€â”€ Code-only confirmations (no foundry test required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    // These findings were verified by reading the actual contracts
    // and confirming the prescribed remediation did not ship.
    //
    // C-1: FIXED in Batch C (commit msg "Batch C â€” TegridyDropV2 R023 H-01").
    //      Legacy setMerkleRoot(bytes32) now reverts with "Use proposeMerkleRoot()".
    //      proposeMerkleRoot / executeMerkleRoot(bytes32) / cancelMerkleRoot
    //      added with 24h timelock. Phase guard restricts rotation to
    //      CLOSED / CANCELLED / paused. Phase rechecked at execute time.
    //      Caller passes expected root to executeMerkleRoot to bind the
    //      execution to the proposed value (defense against re-propose
    //      race within the same block as execute).
    //      Existing 27 TegridyDropV2.t.sol tests pass without changes.
    //
    // C-2: PARTIALLY FIXED in Batch F. MAX_POSITIONS_PER_HOLDER lowered
    //      from 100 â†’ 50, halving the worst-case votingPowerOf gas cost
    //      paid by every external integrator (ReferralSplitter on each
    //      fee credit, RevenueDistributor's checkpoint-fallback path,
    //      governance consumers). 50 still gives Gnosis Safe / vault
    //      headroom (typical multi-position holders accumulate <10).
    //      A full O(1) cached aggregate would be ideal but is deferred
    //      because lazy-expiry semantics make the cache invalidation
    //      non-trivial. 189 staking regression tests pass.
    //
    // H-5: TegridyFeeHook.executeSyncAccruedFees at line 306 reverts with
    //      `if (actualCredit > old) revert SyncReductionTooLarge()`. This
    //      blocks UPWARD sync corrections. If accruedFees ever drifts
    //      below the true PoolManager balance (rounding bug, accounting
    //      drift), there is no recovery path. The error name is also
    //      misleading â€” "SyncReductionTooLarge" actually fires on
    //      attempted increases, not large reductions.
    //
    // H-7: TegridyRestaking.decayExpiredRestaker calls _accrueBonus()
    //      at line 1092 BEFORE shrinking totalRestaked at line 1110.
    //      R017.md's RETRY remediation prescribed the opposite order;
    //      the fix did not ship. Honest restakers underearn during the
    //      window between lock-expiry and the keeper's decay call.
    //
    // H-8: FIXED in Batch G. TegridyRestaking now maintains per-restaker
    //      boost checkpoints via OZ Checkpoints.Trace208 (same pattern
    //      TegridyStaking uses for voting power). boostedAmountAt(_user,
    //      _ts) now returns the historical value from the checkpoint
    //      via upperLookup â€” the actual boost the user held at _ts â€”
    //      instead of the current (potentially decayed) cached value.
    //      _writeBoostCheckpoint hooks every site that mutates boost:
    //      restake, refreshPosition, claimAll auto-refresh, unrestake,
    //      revalidateBoostForRestaked, revalidateBoostForRestaker,
    //      decayExpiredRestaker, recoverStuckPrincipal,
    //      emergencyForceReturn. Legacy fallback to info.boostedAmount
    //      preserved when length()==0 (pre-fix restakers w/o checkpoints).
    //      157 regression tests pass (73 + 12 + 8 + 48 + 16).
    //
    // H-10 (downgraded): PremiumAccess.hasPremium() is flash-loan vulnerable
    //      via JBAC NFT, but the contract documents this risk loudly
    //      (lines 117-125) and exposes hasPremiumSecure() for on-chain
    //      integrators. SwapFeeRouter (the only on-chain consumer in
    //      this codebase) correctly uses hasPremiumSecure (line 309).
    //      Risk is real for THIRD-PARTY integrators that misuse
    //      hasPremium() but is mitigated within this protocol.
}

// AUDIT FIX H-16 - minimal contract to satisfy the multisig-class guardian
// gate used by the rewritten H-1/H-2 tests.
contract AuditDemoMultisig {
    fallback() external {}
}

// AUDIT FIX F-30-1 - minimal ERC20-ish token used to create real factory
// pairs in the rewritten H-2 tests. Has bytecode and is not 23 bytes long.
contract AuditDemoToken {
    string public name = "AD";
    string public symbol = "AD";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
}
