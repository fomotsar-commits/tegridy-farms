// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

/// @title FRESH-2026 F3 — TegridyStaking.getReward autoMaxLock JBAC restaker-aware lookup
/// @notice POST-FIX REGRESSION (commit ad0042e).
///
///         BUG (pre-fix):
///         TegridyStaking.getReward, when an autoMaxLock position has
///         decayed and is being restored to MAX_BOOST, validates the
///         legacy JBAC bonus via:
///             jbacNFT.balanceOf(msg.sender) > 0
///         When TegridyRestaking calls `staking.getReward(tokenId)` on
///         behalf of a depositor, `msg.sender` is the restaking contract
///         — which never holds JBAC NFTs (the restaking flow custodies
///         only the staking NFT). So every legacy
///         `hasJbacBoost && !jbacDeposited` position silently lost its
///         +0.5x JBAC bonus on the FIRST decay-restore cycle that fired
///         while restaked. Once stripped, `revalidateBoost`'s LockExpired
///         guard (DS2-07) is one-way, so the bonus could never be
///         restored — a permanent silent downgrade.
///
///         FIX (TegridyStaking.sol:1086-1112):
///         When `msg.sender == restakingContract`, sibling-port from
///         `revalidateBoost` lines 1303-1309: query
///             ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId)
///         to resolve the actual depositor and use THAT address for the
///         `jbacNFT.balanceOf(...)` check. Wrapped in try/catch so a
///         broken restaking ABI doesn't brick getReward; on lookup
///         failure, the F3-PERMA-STRIP follow-on fix preserves cached
///         `hasJbacBoost` rather than stripping it on uncertainty.
///
///         POST-FIX VALIDATION (this test):
///         (1) Set up a legacy grandfathered position (hasJbacBoost=true,
///             jbacDeposited=false, autoMaxLock=true).
///         (2) Have the depositor (alice) hold a JBAC NFT in her wallet
///             (the legacy validation source).
///         (3) Transfer the staking NFT to a mock contract wired as the
///             `restakingContract`.
///         (4) Skip past lock expiry; the position is now decayed
///             (lock expired). Have the mock call
///             `staking.getReward(tokenId)`.
///         (5) Inside getReward, the autoMaxLock branch fires:
///             - lock extended to MAX
///             - boostedAmount was 0; now restoring
///             - JBAC validation: msg.sender is the mock (no JBAC),
///               but the fix queries `tokenIdToRestaker(tokenId)` which
///               returns alice (the depositor), and
///               `jbacNFT.balanceOf(alice) > 0` returns TRUE.
///             - newBoost = MAX_BOOST_BPS + JBAC_BONUS_BPS = 4.5x.
///         (6) POST-FIX assert: position.boostBps == 45000 (4.5x) AND
///             position.hasJbacBoost remains true.
///         PRE-FIX: position.boostBps would be 40000 (4.0x — JBAC bonus
///         silently stripped) AND position.hasJbacBoost would be flipped
///         to false (the pre-fix code path also strips the cached flag).
///
///         The test uses a minimal mock for the restaking contract:
///         it implements only `tokenIdToRestaker`, `restakers` (so
///         _isTrackedHolder works), `onERC721Received`, and a method to
///         call staking.getReward(tokenId) from itself. This keeps the
///         test focused on the F3 lookup path without dragging in the
///         full TegridyRestaking surface.

contract F3_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract F3_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 i = _id++; _mint(to, i); return i; }
}

/// @dev Minimal mock that pretends to be the restaking contract for the F3
///      lookup path. Implements ITegridyRestakingView (tokenIdToRestaker +
///      restakers), accepts safeTransferFrom of the staking NFT, and exposes
///      a passthrough `callGetReward` so the test can fire getReward from
///      this contract's address (= msg.sender from staking's perspective).
contract MockRestaker_F3 is IERC721Receiver {
    TegridyStaking public immutable staking;
    mapping(uint256 => address) public tokenIdToRestaker;

    struct Info { uint256 tokenId; uint256 posAmt; uint256 boosted; int256 debt; uint256 depTime; }
    mapping(address => Info) private _r;

    constructor(TegridyStaking _staking) {
        staking = _staking;
    }

    /// @dev Test helper: record the depositor for a tokenId and the
    ///      reverse map. Mirrors TegridyRestaking.restake() bookkeeping
    ///      enough for the F3 lookup + _isTrackedHolder gate.
    function recordRestaker(address user, uint256 tokenId, uint256 amount) external {
        tokenIdToRestaker[tokenId] = user;
        _r[user] = Info(tokenId, amount, amount, 0, block.timestamp);
    }

    function restakers(address u) external view returns (uint256, uint256, uint256, int256, uint256) {
        Info memory i = _r[u];
        return (i.tokenId, i.posAmt, i.boosted, i.debt, i.depTime);
    }

    /// @dev Test entrypoint: invoke staking.getReward(tokenId) from this
    ///      contract. msg.sender on the staking side is `address(this)`
    ///      (= the restaking contract address), exactly mirroring how
    ///      TegridyRestaking calls getReward inside `claimAll` / `unrestake`.
    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract FRESH2026_F3_StakingJbacRestakerLookupTest is Test {
    F3_Toweli toweli;
    F3_JBAC jbac;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    TegridyStakingJbacVault vault;
    MockRestaker_F3 mockRestaker;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    uint256 aliceTokenId;
    uint256 aliceJbacHeld;
    uint256 aliceJbacDeposited;

    /// @dev Slot of the `positions` mapping in TegridyStaking. Confirmed via
    ///      `forge inspect TegridyStaking storageLayout` — the staking
    ///      contract is mature so this slot is stable. If the storage
    ///      layout drifts, the storage layout baseline (commit 88d33cc)
    ///      will catch it.
    // mvp-launch: positions mapping moved from slot 15 to slot 17 (PauseGuardian
    // added 1 slot, maxStakePerUser + maxTotalStaked added 2). Verified via
    // `forge inspect TegridyStaking storage-layout`.
    uint256 constant POSITIONS_SLOT = 17;
    /// @dev Position.jbacDeposited is at struct slot offset 5.
    uint256 constant JBAC_DEPOSITED_OFFSET = 5;

    function setUp() public {
        toweli = new F3_Toweli();
        jbac = new F3_JBAC();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e14);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));

        // Fund staking with rewards so getReward() doesn't short-circuit.
        toweli.approve(address(staking), 100_000 ether);
        staking.notifyRewardAmount(100_000 ether);

        // Deploy mock restaking contract and wire it via the timelocked
        // admin path. Mock has code, so the propose-time NotAContract
        // gate (codeLen == 0 || codeLen == 23) passes.
        mockRestaker = new MockRestaker_F3(staking);
        admin.proposeRestakingContract(address(mockRestaker));
        skip(48 hours + 1);
        admin.executeRestakingContract();
        assertEq(staking.restakingContract(), address(mockRestaker), "mock wired as restakingContract");

        toweli.transfer(alice, 100_000 ether);
    }

    /// @notice POST-FIX REGRESSION: validates the F3 fix.
    ///         A legacy (hasJbacBoost=true, jbacDeposited=false) position
    ///         retains its +0.5x JBAC bonus through a restaked
    ///         decay-restore cycle. Pre-fix, the bonus was silently
    ///         stripped because the JBAC `balanceOf` check resolved to
    ///         the restaking contract (no JBAC) instead of the
    ///         depositor.
    function test_F3_legacyJbac_retainedThroughRestakedDecayRestore() public {
        // ── PHASE 1: Alice mints two JBACs, stakes with one (deposit). ──
        // We use stakeWithBoost to get hasJbacBoost=true, jbacDeposited=true,
        // then flip jbacDeposited to false via vm.store to simulate the
        // legacy grandfathered shape. The second JBAC stays in Alice's
        // wallet — that's the source of truth for the legacy
        // `jbacNFT.balanceOf(alice) > 0` validation.
        aliceJbacDeposited = jbac.mint(alice);
        aliceJbacHeld = jbac.mint(alice);
        assertEq(jbac.balanceOf(alice), 2, "alice has 2 JBACs pre-stake");

        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        jbac.approve(address(staking), aliceJbacDeposited);
        // Use MIN_LOCK_DURATION (7 days) so we can skip past lockEnd to
        // trigger _decayIfExpired without burning years of rewards.
        staking.stakeWithBoost(10_000 ether, 7 days, aliceJbacDeposited);
        aliceTokenId = staking.userTokenId(alice);
        // Enable autoMaxLock so the decay-restore branch in getReward
        // fires when the lock has expired.
        staking.toggleAutoMaxLock(aliceTokenId);
        vm.stopPrank();

        // ── PHASE 2: Flip jbacDeposited to false via vm.store. ──────────
        // After this, the position's shape matches the legacy
        // grandfathered profile that pre-fix the `revalidateBoost` /
        // `getReward` paths handle via `balanceOf(holder)`. The
        // physically-deposited JBAC stays at the vault, but Alice still
        // has aliceJbacHeld in her wallet — that's the validation source.
        bytes32 baseSlot = keccak256(abi.encode(aliceTokenId, POSITIONS_SLOT));
        bytes32 jbacDepositedSlot = bytes32(uint256(baseSlot) + JBAC_DEPOSITED_OFFSET);
        vm.store(address(staking), jbacDepositedSlot, bytes32(0));

        // Sanity: hasJbacBoost is still true, jbacDeposited now false.
        (
            ,uint256 boostedBefore,, uint64 lockEndBefore,
            uint16 boostBpsBefore, , bool autoMaxLockBefore, bool hasJbacBefore,
            , , bool jbacDepositedAfterFlip
        ) = staking.positions(aliceTokenId);
        assertTrue(hasJbacBefore, "legacy: hasJbacBoost remains true");
        assertFalse(jbacDepositedAfterFlip, "legacy: jbacDeposited flipped false via vm.store");
        assertTrue(autoMaxLockBefore, "autoMaxLock enabled");
        // `toggleAutoMaxLock` extends `lockDuration` to MAX_LOCK_DURATION and
        // recomputes the boost — so post-toggle the boost is 4.0x lock + 0.5x JBAC
        // = 45000 bps, NOT the 9000 bps of the original 7-day stake.
        assertEq(boostBpsBefore, 40000 + 5000, "post-toggleAutoMaxLock: 4.0x lock + 0.5x JBAC = 4.5x = 45000 bps");
        assertGt(boostedBefore, 0, "boostedAmount > 0 pre-decay");
        emit log_named_uint("pre-restake boostBps", boostBpsBefore);
        emit log_named_uint("pre-restake lockEnd", lockEndBefore);

        // ── PHASE 3: Transfer staking NFT to mock restaker contract. ────
        // The transfer's _afterTokenTransfer + _beforeTokenTransfer hooks
        // exempt the restaking contract from the rate-limit (restakingHop),
        // but the 24h cooldown still applies. Skip 25h.
        skip(25 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, address(mockRestaker), aliceTokenId);
        assertEq(staking.ownerOf(aliceTokenId), address(mockRestaker), "NFT held by mock restaker");

        // Record the depositor in the mock — exactly as TegridyRestaking
        // would set tokenIdToRestaker on a real restake.
        mockRestaker.recordRestaker(alice, aliceTokenId, 10_000 ether);

        // ── PHASE 4: Skip past lockEnd so the position decays. ──────────
        // After the safeTransferFrom, _settleRewardsOnTransfer fires which
        // doesn't decay (decay only fires inside _getReward / kick / etc).
        // We skip past the original 7-day lock expiry so the next
        // _getReward call hits _decayIfExpired and zeros boostedAmount.
        skip(8 days);

        // ── PHASE 5: Mock restaker calls staking.getReward(tokenId). ────
        // POST-FIX getReward path:
        //   1. _getReward → _decayIfExpired zeros boostedAmount
        //                → _settleUnsettled credits unsettled[mockRestaker]
        //                → returns 0 (capped pending = 0 because boost
        //                  was zeroed first; or the path settled rewards
        //                  to unsettled, doesn't matter for our boost
        //                  assertion)
        //   2. autoMaxLock branch: lockEnd = now + MAX, lockDuration = MAX
        //   3. boostedAmount == 0 && amount > 0 → fire JBAC restore branch
        //   4. msg.sender == restakingContract → resolve depositor via
        //      tokenIdToRestaker(tokenId) = alice
        //   5. jbacStillValid = p.hasJbacBoost && jbacNFT.balanceOf(alice) > 0
        //                     = true && (1) > 0
        //                     = true
        //   6. newBoost = MAX_BOOST_BPS + JBAC_BONUS_BPS = 45000 (4.5x)
        //   7. _applyNewBoost(p, 45000)
        mockRestaker.callGetReward(aliceTokenId);

        // ── POST-FIX ASSERTIONS ────────────────────────────────────────
        (
            ,uint256 boostedAfter,, uint64 lockEndAfter,
            uint16 boostBpsAfter, , , bool hasJbacAfter,
            , ,
        ) = staking.positions(aliceTokenId);
        emit log_named_uint("post-fix boostBps", boostBpsAfter);
        emit log_named_uint("post-fix boostedAmount", boostedAfter);
        emit log_named_uint("post-fix lockEnd", lockEndAfter);

        // The load-bearing assertions:
        // 1) JBAC bonus retained: 4.5x = 45000 bps (MAX_BOOST_BPS=40000 + JBAC_BONUS_BPS=5000).
        //    Pre-fix this would be 40000 (bonus stripped because the
        //    balanceOf(restakingContract) check returned 0).
        assertEq(boostBpsAfter, 40000 + 5000, "FIX: legacy JBAC bonus retained through restaked decay-restore");
        // 2) hasJbacBoost flag remains true. Pre-fix the strip path
        //    (line 1119-1123) would set p.hasJbacBoost = false because
        //    `else if (p.hasJbacBoost && lookupOk)` would clear the flag
        //    when the balanceOf check came back zero.
        assertTrue(hasJbacAfter, "FIX: hasJbacBoost preserved");
        // 3) lockEnd extended to MAX (autoMaxLock fired).
        assertApproxEqAbs(
            lockEndAfter,
            block.timestamp + staking.MAX_LOCK_DURATION(),
            2,
            "autoMaxLock extended lockEnd to now+MAX"
        );
        // 4) boostedAmount restored.
        assertGt(boostedAfter, 0, "boostedAmount restored from zero");

        emit log_string("F3 FIX VALIDATED: legacy JBAC bonus retained for restaked depositor");
    }

    /// @notice POST-FIX REGRESSION (lookup-failure preservation):
    ///         If the restaking contract's `tokenIdToRestaker` lookup
    ///         REVERTS (e.g., upgraded contract drops the function), the
    ///         F3-PERMA-STRIP follow-on fix preserves the cached
    ///         `hasJbacBoost` flag rather than silently stripping it.
    ///         Pre-fix, the catch fell through to msg.sender (=
    ///         restaking contract, no JBAC) → jbacStillValid=false →
    ///         hasJbacBoost permanently flipped to false. Post-fix the
    ///         strip-on-fail branch is skipped when lookup failed.
    ///
    ///         Approach: deploy a second mock that REVERTS on
    ///         tokenIdToRestaker(uint256), wire it as the restaking
    ///         contract, and fire getReward through it. Verify
    ///         hasJbacBoost stays true (i.e., not stripped on uncertain
    ///         lookup).
    function test_F3_lookupFailure_preservesHasJbacBoost() public {
        // Set up alice's legacy position (same as primary test).
        aliceJbacDeposited = jbac.mint(alice);
        aliceJbacHeld = jbac.mint(alice);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        jbac.approve(address(staking), aliceJbacDeposited);
        staking.stakeWithBoost(10_000 ether, 7 days, aliceJbacDeposited);
        aliceTokenId = staking.userTokenId(alice);
        staking.toggleAutoMaxLock(aliceTokenId);
        vm.stopPrank();

        bytes32 baseSlot = keccak256(abi.encode(aliceTokenId, POSITIONS_SLOT));
        bytes32 jbacDepositedSlot = bytes32(uint256(baseSlot) + JBAC_DEPOSITED_OFFSET);
        vm.store(address(staking), jbacDepositedSlot, bytes32(0));

        // Deploy a reverting mock and rotate the restaking contract.
        // M-28 guard requires the OLD restaker hold no NFTs; the original
        // mock holds none yet (we haven't transferred), so rotation works.
        RevertingRestaker revertMock = new RevertingRestaker();
        admin.proposeRestakingContract(address(revertMock));
        skip(48 hours + 1);
        admin.executeRestakingContract();
        assertEq(staking.restakingContract(), address(revertMock), "revert mock wired");

        // Transfer NFT to revert mock.
        skip(25 hours);
        vm.prank(alice);
        staking.safeTransferFrom(alice, address(revertMock), aliceTokenId);

        // Skip past lockEnd to trigger decay.
        skip(8 days);

        // Call getReward from revert mock. The tokenIdToRestaker call
        // inside the JBAC validation branch will revert; the F3-PERMA-STRIP
        // catch absorbs it and skips both the stale-flag clear AND the
        // bonus-grant. So newBoost = MAX_BOOST_BPS only (no JBAC bonus
        // on this cycle), but hasJbacBoost stays TRUE so the next cycle
        // can re-validate when the restaking contract is fixed.
        revertMock.callGetReward(staking, aliceTokenId);

        ( , , , , uint16 boostBpsAfter, , , bool hasJbacAfter, , , ) = staking.positions(aliceTokenId);
        emit log_named_uint("post-fix (lookup-fail) boostBps", boostBpsAfter);

        // POST-FIX assertion: hasJbacBoost preserved despite lookup
        // failure. Pre-fix would have stripped it permanently.
        assertTrue(hasJbacAfter, "FIX: hasJbacBoost NOT stripped on lookup failure");

        emit log_string("F3 PERMA-STRIP FIX VALIDATED: hasJbacBoost preserved on transient lookup failure");
    }
}

/// @dev Mock restaking contract whose `tokenIdToRestaker` reverts. Used to
///      verify the F3-PERMA-STRIP `lookupOk = false` path preserves the
///      cached `hasJbacBoost` flag rather than silently stripping it.
contract RevertingRestaker is IERC721Receiver {
    function tokenIdToRestaker(uint256) external pure returns (address) {
        revert("LOOKUP_FAIL");
    }

    function callGetReward(TegridyStaking staking, uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
