// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {MemeBountyBoard} from "../src/MemeBountyBoard.sol";
import {PremiumAccess} from "../src/PremiumAccess.sol";
import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";
import {Toweli} from "../src/Toweli.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT R014 — Misc batch remediation tests.
// One test per finding (and a couple of closely-related companion tests where
// they aid review). All seven findings are MEDIUM/LOW class fixes that harden
// existing checks rather than restructure trust assumptions.
// ─────────────────────────────────────────────────────────────────────────────

// ── Mocks ────────────────────────────────────────────────────────────────────

contract MockWETHR014 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

contract MockStakingR014 {
    mapping(address => uint256) public power;
    mapping(address => mapping(uint256 => uint256)) public powerAtTs;
    function votingPowerOf(address u) external view returns (uint256) { return power[u]; }
    function votingPowerAt(address u, uint256) external view returns (uint256) { return power[u]; }
    function votingPowerAtTimestamp(address u, uint256 ts) external view returns (uint256) {
        if (powerAtTs[u][ts] > 0) return powerAtTs[u][ts];
        return power[u];
    }
    function setPower(address u, uint256 p) external { power[u] = p; }
    function setPowerAt(address u, uint256 ts, uint256 p) external { powerAtTs[u][ts] = p; }
}

contract MockToweliR014 is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBACR014 is ERC721 {
    uint256 _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external { _mint(to, _id++); }
}

// Mock pool manager just enough for TegridyFeeHook constructor + balanceOf.
contract MockPoolManagerR014 {
    mapping(address => mapping(uint256 => uint256)) public credits;
    function setCredit(address h, uint256 id, uint256 amt) external { credits[h][id] = amt; }
    function balanceOf(address h, uint256 id) external view returns (uint256) { return credits[h][id]; }
    function take(address, address, uint256) external pure {}
}

// Mock staking matching the TegridyTokenURIReader.ITegridyStaking interface.
contract MockStakingForReader {
    struct Pos { uint256 amount; uint16 boostBps; uint64 lockEnd; uint32 lockDuration; bool autoMaxLock; bool hasJbacBoost; }
    mapping(uint256 => Pos) public p;
    function set(uint256 tokenId, uint256 amt, uint16 b, uint64 le, uint32 ld, bool aml, bool jbac) external {
        p[tokenId] = Pos(amt, b, le, ld, aml, jbac);
    }
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt,
        uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
        bool autoMaxLock, bool hasJbacBoost, uint64 stakeTimestamp,
        uint256 jbacTokenId, bool jbacDeposited
    ) {
        Pos memory pp = p[tokenId];
        return (pp.amount, 0, 0, pp.lockEnd, pp.boostBps, pp.lockDuration, pp.autoMaxLock, pp.hasJbacBoost, 0, 0, false);
    }
    function ownerOf(uint256) external pure returns (address) { return address(0xdead); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 — ReferralSplitter sybil ring detection (CIRCULAR_DEPTH=100 + path bitmap).
// ─────────────────────────────────────────────────────────────────────────────

contract AuditR014_ReferralSplitterTest is Test {
    ReferralSplitter ref;
    MockStakingR014 staking;
    MockWETHR014 weth;
    address treasury = makeAddr("treasury");

    function setUp() public {
        staking = new MockStakingR014();
        weth = new MockWETHR014();
        ref = new ReferralSplitter(1000, address(staking), treasury, address(weth));
    }

    // Confirm the depth was raised to 100 (constant exposed by the contract).
    function test_circularDepthRaisedTo100() public view {
        assertEq(ref.CIRCULAR_DEPTH(), 100, "CIRCULAR_DEPTH must be 100 post-R014");
    }

    // Build a 30-address ring A0→A1→…→A29→A0 and verify it's caught even though
    // 30 < CIRCULAR_DEPTH and 30 > the previous CIRCULAR_DEPTH=25 cap.
    function test_sybilRing30Addresses_caughtByPathBitmap() public {
        uint256 N = 30;
        address[] memory r = new address[](N);
        for (uint256 i; i < N; i++) r[i] = address(uint160(0x1000 + i));

        // Build chain: r[0]→r[1]→…→r[N-2]→r[N-1].
        for (uint256 i; i < N - 1; i++) {
            vm.prank(r[i]);
            ref.setReferrer(r[i + 1]);
        }
        // Now r[N-1] tries to set r[0] as referrer — would close a 30-address
        // ring. The path-walk check sees r[0] already on the chain (it's the
        // start), so this reverts as CircularReferral.
        vm.prank(r[N - 1]);
        vm.expectRevert(ReferralSplitter.CircularReferral.selector);
        ref.setReferrer(r[0]);
    }

    // Sanity: a non-cyclic chain of the same depth still works.
    function test_longLinearChain_succeeds() public {
        uint256 N = 30;
        address[] memory r = new address[](N);
        for (uint256 i; i < N; i++) r[i] = address(uint160(0x2000 + i));
        for (uint256 i; i < N - 1; i++) {
            vm.prank(r[i]);
            ref.setReferrer(r[i + 1]);
        }
        // r[N-1] sets a fresh, never-seen referrer → no cycle.
        address fresh = address(uint160(0xCAFE));
        vm.prank(r[N - 1]);
        ref.setReferrer(fresh);
        assertEq(ref.referrerOf(r[N - 1]), fresh);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings 2 & 3 — MemeBountyBoard creator suppression + MEV snapshot lookback.
// ─────────────────────────────────────────────────────────────────────────────

contract AuditR014_MemeBountyTest is Test {
    MemeBountyBoard board;
    MockToweliR014 token;
    MockStakingR014 staking;
    MockWETHR014 weth;
    address creator = makeAddr("creator");
    address artist = makeAddr("artist");

    function setUp() public {
        token = new MockToweliR014();
        staking = new MockStakingR014();
        weth = new MockWETHR014();
        // AUDIT FIX FRESH-2026: F-21-7 — restaking contract mandatory at construction.
        // Constructor: voteToken, staking, weth, sequencerFeed (0 = mainnet), treasury, restaking.
        board = new MemeBountyBoard(address(token), address(staking), address(weth), address(0), address(this), address(staking));
        // Warp into the future so SNAPSHOT_LOOKBACK doesn't underflow.
        vm.warp(30 days);
        vm.deal(creator, 100 ether);
    }

    // Finding 3 — SNAPSHOT_LOOKBACK is now derived from a block-count value
    // and should be ≈ 250 * 12 seconds.
    function test_snapshotLookbackBlocksConstant() public view {
        assertEq(board.SNAPSHOT_LOOKBACK_BLOCKS(), 250);
        assertEq(board.SNAPSHOT_LOOKBACK(), 250 * 12 seconds);
    }

    // Finding 2 — creator is rejected by the originalCreator snapshot field.
    function test_creatorRejected_viaOriginalCreatorSnapshot() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("desc", block.timestamp + 7 days);

        // Set creator + artist staking power. The snapshot timestamp is
        // (block.timestamp - SNAPSHOT_LOOKBACK), but the mock returns
        // `power[u]` whenever no per-timestamp override is set.
        staking.setPower(creator, 5000 ether);
        staking.setPower(artist, 5000 ether);

        // Artist submits work (artist holds enough stake to submit).
        vm.prank(artist);
        board.submitWork(0, "ipfs://hash");

        // Creator (originalCreator) attempts to vote on the artist's
        // submission — should revert with CreatorCannotVote.
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CreatorCannotVote.selector);
        board.voteForSubmission(0, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 4 — PremiumAccess MIN_HOLDING_PERIOD on cancelSubscription.
// ─────────────────────────────────────────────────────────────────────────────

contract AuditR014_PremiumAccessTest is Test {
    PremiumAccess premium;
    MockToweliR014 token;
    MockJBACR014 nft;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    uint256 constant MONTHLY_FEE = 1000 ether;

    function setUp() public {
        token = new MockToweliR014();
        nft = new MockJBACR014();
        premium = new PremiumAccess(address(token), address(nft), treasury, MONTHLY_FEE);
        token.transfer(alice, 100_000 ether);
        vm.prank(alice);
        token.approve(address(premium), type(uint256).max);
    }

    function test_cancelBeforeMinHolding_reverts() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        // Warp 2 seconds — past SAME_BLOCK_CANCEL but NOT past MIN_HOLDING_PERIOD.
        vm.warp(block.timestamp + 2);
        vm.prank(alice);
        vm.expectRevert(PremiumAccess.MinHoldingNotMet.selector);
        premium.cancelSubscription();
    }

    function test_cancelAfterMinHolding_succeeds() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        // Warp 1 day + 1 second — past MIN_HOLDING_PERIOD.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        premium.cancelSubscription();
        // Expiry collapsed to now.
        (uint256 expiresAt,,) = premium.getSubscription(alice);
        assertEq(expiresAt, block.timestamp);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 5 — TegridyFeeHook MAX_SYNC_INCREASE_BPS upward ceiling.
// The hook constructor enforces (uint160(addr) & 0x0044) == 0x0044 — we
// brute-force a deploy address whose low bits match by retrying via
// throwaway bumps.
// ─────────────────────────────────────────────────────────────────────────────

contract AuditR014_FeeHookTest is Test {
    TegridyFeeHook hook;
    MockPoolManagerR014 pm;
    address distributor = makeAddr("distributor");
    address tok = makeAddr("tok");
    address owner = address(this);

    function setUp() public {
        pm = new MockPoolManagerR014();
        // AUDIT FIX: DEEP-D-AMM-INFO1 — the hook constructor masks
        // `& 0x3FFF == 0x0044` (probability 1/16384 per try). The original
        // brute-force loop OOGs at the new mask, so use deployCodeTo at a
        // pre-mined vanity address whose lower 14 bits are 0x0044.
        // 0xCAFE0044 satisfies (& 0x3FFF == 0x0044).
        address HOOK_ADDR = address(uint160(0xCAFE0044));
        // AUDIT FIX (pass-8): TF-INT-02. Constructor now requires WETH; sentinel suffices.
        address wethSentinel = makeAddr("weth_r014_misc");
        deployCodeTo(
            "TegridyFeeHook.sol:TegridyFeeHook",
            abi.encode(IPoolManager(address(pm)), distributor, uint256(30), owner, wethSentinel),
            HOOK_ADDR
        );
        hook = TegridyFeeHook(payable(HOOK_ADDR));
    }

    function _setAccrued(address t, uint256 amt) internal {
        // accruedFees mapping at slot 7 (matches existing tests in TegridyFeeHook.t.sol).
        bytes32 s = keccak256(abi.encode(t, uint256(7)));
        vm.store(address(hook), s, bytes32(amt));
    }

    function test_upwardSyncBeyond10Pct_reverts() public {
        _setAccrued(tok, 1000);
        // PoolManager has plenty of credit so AboveOnChainCredit doesn't
        // mask the new check.
        pm.setCredit(address(hook), uint256(uint160(tok)), 5000);
        // 10% of 1000 = 100 → max allowed = 1100. 1101 must revert.
        hook.proposeSyncAccruedFees(tok, 1101);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(TegridyFeeHook.SyncIncreaseTooLarge.selector);
        hook.executeSyncAccruedFees(tok);
    }

    function test_upwardSyncAt10Pct_succeeds() public {
        _setAccrued(tok, 1000);
        pm.setCredit(address(hook), uint256(uint160(tok)), 5000);
        hook.proposeSyncAccruedFees(tok, 1100);
        vm.warp(block.timestamp + 7 days);
        hook.executeSyncAccruedFees(tok);
        assertEq(hook.accruedFees(tok), 1100);
    }
}

// Helper for the TegridyFeeHook vanity-mine loop: bumps tx-nonce by self-deploy.
contract ChurnR014 {}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 6 — Toweli _mint override + initial-mint flag.
// ─────────────────────────────────────────────────────────────────────────────

// Subclass that re-exposes _mint via a public selector. If _mint actually
// reverts post-construction (as it should), every external attempt to mint
// — via any inheriting contract path — will revert with MINT_DISABLED.
contract ToweliMintProbe is Toweli {
    constructor(address recipient) Toweli(recipient) {}
    function tryMint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract AuditR014_ToweliTest is Test {
    Toweli token;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        token = new Toweli(treasury);
    }

    function test_constructorStillMintsFullSupply() public view {
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(treasury), 1_000_000_000 ether);
    }

    function test_postConstructionMintReverts() public {
        // Subclass exposes _mint via tryMint(). Constructor mint fires
        // exactly once; any later call must revert with MINT_DISABLED.
        ToweliMintProbe probe = new ToweliMintProbe(treasury);
        vm.expectRevert(bytes("MINT_DISABLED"));
        probe.tryMint(alice, 1 ether);
        // Supply unchanged.
        assertEq(probe.totalSupply(), 1_000_000_000 ether);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 7 — TegridyTokenURIReader range checks.
// ─────────────────────────────────────────────────────────────────────────────

contract AuditR014_TokenURIReaderTest is Test {
    MockStakingForReader staking;
    TegridyTokenURIReader reader;

    function setUp() public {
        staking = new MockStakingForReader();
        reader = new TegridyTokenURIReader(address(staking));
    }

    function test_amountOOB_reverts() public {
        // 1e9 ether + 1 → just over the bound.
        staking.set(1, 1_000_000_001 ether, 10000, uint64(block.timestamp + 7 days), 7 days, false, false);
        vm.expectRevert(bytes("AMOUNT_OOB"));
        reader.tokenURI(1);
    }

    function test_boostOOB_reverts() public {
        staking.set(2, 100 ether, 50001, uint64(block.timestamp + 7 days), 7 days, false, false);
        vm.expectRevert(bytes("BOOST_OOB"));
        reader.tokenURI(2);
    }

    function test_amountAndBoostInBounds_succeeds() public view {
        // Sanity: at-bound values pass through cleanly. (calling view
        // directly without any setPosition — defaults to all-zero, which
        // is below both bounds.)
        string memory uri = reader.tokenURI(99);
        // Must be the data: prefix.
        bytes memory u = bytes(uri);
        bytes memory pfx = bytes("data:application/json;base64,");
        for (uint256 i; i < pfx.length; i++) {
            assertEq(u[i], pfx[i]);
        }
    }
}
