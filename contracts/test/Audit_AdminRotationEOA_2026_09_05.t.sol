// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";

/// @title  [ADMIN-ROTATION-EOA] — privileged address slots must reject EOAs, on EVERY live path.
///
/// @notice THE CLASS. This repo type-filters privileged address slots against EOAs and 23-byte
///         EIP-7702 delegated EOAs (`0xef0100 ‖ addr`). The filter is applied inconsistently, and
///         the inconsistency always takes the same shape: the path someone thought of is guarded,
///         the path that is actually reachable is not.
///
///         Found by the same sweep that produced [LEND-EOA-WHITELIST]
///         (test/StakingLendingWhitelistEOA_2026_09_05.t.sol), which was the staking-registry
///         instance of this class. These are the other three that survived adversarial review:
///
///         1. SwapFeeRouter — `setSwapFeeRouterAdmin` HAS the filter but is ONE-SHOT
///            (`AdminAlreadySet`). The rotation pair `proposeAdminReplacement` /
///            `executeAdminReplacement` is therefore the ONLY live path to the slot once the
///            admin is wired, and it was the ONLY one without the filter. That slot is the
///            `onlyAdmin` authority for applyTreasury / applyReferralSplitter /
///            applyInputTokenFee / applyPremiumAccess / applyPolAccumulator /
///            applyRevenueDistributor / applyFeeSplit, and every one of those parameters'
///            timelock lives in the SwapFeeRouterAdmin SISTER, not in the router. So an EOA here
///            does not merely misconfigure the router — it replaces timelocked governance of the
///            whole fee path with one key that calls every `apply*` instantly.
///            SwapFeeRouter was the sole outlier of five admin-slot contracts: TegridyStaking,
///            TegridyRestaking, TegridyLending and TegridyNFTLending all filter BOTH halves.
///
///         2. ReferralSplitter.setRestakingContract — one-shot, no rotation path, no admin
///            sister, and unfiltered. `restakingContract` is read through a high-level `try` call
///            that expects return data; a high-level call to a CODELESS address reverts in the
///            caller's frame instead of degrading into the catch, so an EOA here makes every
///            `recordFee` revert permanently.
///
///         3. CommunityGrants.setRestakingContract — same one-shot shape; the contract's own
///            natspec already states the consequence (voting power reads 0 and every grant
///            proposal silently loses eligibility).
///
/// @notice 2 and 3 are not new ideas: the governance-gates 2026-08 batch added this exact filter
///         to the byte-identical setter in MemeBountyBoard (MBB-WIRE-01) and VoteIncentives
///         (VI-WIRE-01). These two were simply missed. The fix is that batch's code, copied.
///
/// @notice SEVERITY. All three are owner-gated, so none is a permissionless exploit. 1 is the
///         serious one (it converts timelocked governance into an instant single key and the
///         guarded path is unreachable); 2 and 3 are permanent-brick footguns on a one-shot wire.
contract Audit_AdminRotationEOA_2026_09_05_Test is Test {
    SwapFeeRouter internal router;
    ReferralSplitter internal splitter;
    CommunityGrants internal grants;

    RotationAdminStub internal goodAdmin;
    RotationAdminStub internal otherAdmin;

    address internal eve = makeAddr("rotation_eve");
    address internal treasury = makeAddr("rotation_treasury");

    /// @dev The canonical EIP-7702 delegation pointer: 0xef0100 + 20-byte delegate == 23 bytes.
    function _delegation() internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", bytes20(address(0xBEEF)));
    }

    function setUp() public {
        goodAdmin = new RotationAdminStub();
        otherAdmin = new RotationAdminStub();
        assertEq(eve.code.length, 0, "setup: eve is a bare EOA");
        assertGt(address(goodAdmin).code.length, 23, "setup: stub is a genuine contract");
    }

    // ───────────────────────── 1. SwapFeeRouter admin rotation ─────────────────────────

    /// PRE-FIX: `proposeAdminReplacement` checked only zero-address, so this SUCCEEDS and the
    ///          test fails on the missing revert.
    function test_swapFeeRouter_proposeAdminReplacement_rejectsAnEOA() public {
        _wireRouter();
        vm.expectRevert(SwapFeeRouter.InvalidAdmin.selector);
        router.proposeAdminReplacement(eve);
    }

    /// The 23-byte shape — an address that HAS code and is still fully EOA-controlled.
    /// PRE-FIX: succeeds -> test fails.
    function test_swapFeeRouter_proposeAdminReplacement_rejectsA7702DelegatedEOA() public {
        _wireRouter();
        vm.etch(eve, _delegation());
        assertEq(eve.code.length, 23, "delegation pointer is exactly 23 bytes");

        vm.expectRevert(SwapFeeRouter.InvalidAdmin.selector);
        router.proposeAdminReplacement(eve);
    }

    /// The [L-18] execute-time recheck: a candidate that was a contract at propose time and is
    /// not at execute time must not be installed. PRE-FIX: the rotation lands.
    function test_swapFeeRouter_executeAdminReplacement_rechecksAfterTheCodeVanishes() public {
        _wireRouter();
        router.proposeAdminReplacement(address(otherAdmin));
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);

        vm.etch(address(otherAdmin), hex""); // stops being a contract mid-window
        assertEq(address(otherAdmin).code.length, 0, "code is gone");

        vm.expectRevert(SwapFeeRouter.InvalidAdmin.selector);
        router.executeAdminReplacement();

        assertEq(router.swapFeeRouterAdmin(), address(goodAdmin), "admin slot must be unchanged");
    }

    /// The legitimate rotation must still work end to end — the fix must not brick governance.
    function test_swapFeeRouter_rotationToARealContractStillWorks() public {
        _wireRouter();
        router.proposeAdminReplacement(address(otherAdmin));
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        router.executeAdminReplacement();
        assertEq(router.swapFeeRouterAdmin(), address(otherAdmin), "legitimate rotation unaffected");
    }

    // ──────────────────── 2 & 3. one-shot restaking wires ────────────────────

    /// PRE-FIX: succeeds -> test fails.
    function test_referralSplitter_setRestakingContract_rejectsAnEOA() public {
        splitter = _newSplitter();
        vm.expectRevert(ReferralSplitter.NotAContract.selector);
        splitter.setRestakingContract(eve);
    }

    function test_referralSplitter_setRestakingContract_rejectsA7702DelegatedEOA() public {
        splitter = _newSplitter();
        vm.etch(eve, _delegation());
        vm.expectRevert(ReferralSplitter.NotAContract.selector);
        splitter.setRestakingContract(eve);
    }

    /// The one-shot wire must still accept a genuine contract, exactly once.
    function test_referralSplitter_setRestakingContract_acceptsAContractOnce() public {
        splitter = _newSplitter();
        splitter.setRestakingContract(address(goodAdmin));
        assertEq(splitter.restakingContract(), address(goodAdmin), "legitimate wire lands");

        vm.expectRevert(ReferralSplitter.RestakingAlreadySet.selector);
        splitter.setRestakingContract(address(otherAdmin));
    }

    /// PRE-FIX: succeeds -> test fails.
    function test_communityGrants_setRestakingContract_rejectsAnEOA() public {
        grants = _newGrants();
        vm.expectRevert(CommunityGrants.NotAContract.selector);
        grants.setRestakingContract(eve);
    }

    function test_communityGrants_setRestakingContract_rejectsA7702DelegatedEOA() public {
        grants = _newGrants();
        vm.etch(eve, _delegation());
        vm.expectRevert(CommunityGrants.NotAContract.selector);
        grants.setRestakingContract(eve);
    }

    function test_communityGrants_setRestakingContract_acceptsAContractOnce() public {
        grants = _newGrants();
        grants.setRestakingContract(address(goodAdmin));
        assertEq(grants.restakingContract(), address(goodAdmin), "legitimate wire lands");
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _wireRouter() internal {
        router = _newRouter();
        router.setSwapFeeRouterAdmin(address(goodAdmin));
        assertEq(router.swapFeeRouterAdmin(), address(goodAdmin), "setup: admin wired");
    }

    /// @dev Inert wiring: these tests exercise only the admin-slot type-filter, so every
    ///      constructor dependency is a code-bearing stub. Nothing here touches fee routing.
    /// @dev The router argument is NOT inert: SwapFeeRouter's constructor calls `WETH()` and
    ///      `factory()` on it and rejects a zero factory, so it needs a stub that answers both.
    function _newRouter() internal returns (SwapFeeRouter r) {
        r = new SwapFeeRouter(
            address(new UniRouterStub()), // _router — must answer WETH() and factory()
            treasury,
            100, // _feeBps
            address(new RotationAdminStub()), // _referralSplitter
            address(new RotationAdminStub()) // _revenueDistributor
        );
    }

    function _newSplitter() internal returns (ReferralSplitter s) {
        s = new ReferralSplitter(
            100, // _referralFeeBps (non-zero, under MAX_REFERRAL_FEE)
            address(new RotationAdminStub()), // _stakingContract
            treasury,
            address(new RotationAdminStub()) // _weth
        );
    }

    function _newGrants() internal returns (CommunityGrants g) {
        g = new CommunityGrants(
            address(new RotationAdminStub()), // _votingEscrow
            address(new RotationAdminStub()), // _toweli
            treasury, // _feeReceiver
            address(new RotationAdminStub()) // _weth
        );
    }
}

/// @dev A minimal genuine contract: runtime code comfortably longer than the 23-byte
///      EIP-7702 delegation pointer, so it passes the type-filter.
contract RotationAdminStub {
    uint256 public marker;

    function poke(uint256 v) external {
        marker = v;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @dev SwapFeeRouter's constructor is not satisfied by a bare contract: it calls `WETH()` and
///      `factory()` on the router argument and reverts `ZeroAddress` on a zero factory.
contract UniRouterStub {
    address public immutable wethAddr;
    address public immutable factoryAddr;

    constructor() {
        wethAddr = address(new RotationAdminStub());
        factoryAddr = address(new RotationAdminStub());
    }

    function WETH() external view returns (address) {
        return wethAddr;
    }

    function factory() external view returns (address) {
        return factoryAddr;
    }
}
