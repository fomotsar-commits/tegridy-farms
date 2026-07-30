// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";

/// @title CommunityGrants ⇄ TegridyStaking ABI-integration regression suite
///
/// @notice WHY THIS FILE EXISTS
///         `test/CommunityGrants.t.sol` exercises CommunityGrants against
///         `MockVEGrants`, a hand-written mock that declares EVERY member of
///         `IVotingEscrowGrants` as `external`. That mock is a perfect stand-in
///         for the *interface* and a useless stand-in for the *deployed callee*:
///         it cannot observe that TegridyStaking stopped exporting a selector.
///
///         On 2026-05-31 (commit b5c12f7, the "2026-05-29 EIP-170 golf" pass)
///         `TegridyStaking.userPositionCount` was lowered `external -> internal`
///         under a comment asserting "verified zero on-chain/script/test callers
///         via repo-wide grep". The grep missed
///         `CommunityGrants.sol:335`, added three weeks earlier by the BATCH-E
///         H11 sybil fix (commit 2f0470e, 2026-05-06).
///
///         Because `userPositionCount` is `internal`, it is absent from
///         TegridyStaking's compiled ABI. A call to a non-existent selector on a
///         contract with no `fallback()` reverts with empty returndata, so
///         `createProposal` reverted unconditionally — every grant proposal was
///         un-creatable against a real staking deployment.
///
///         These tests bind CommunityGrants to a REAL TegridyStaking (exactly
///         how `script/DeployCommunityGrants.s.sol` wires it: `votingEscrow =
///         vm.envAddress("STAKING")`), so the ABI surface is the thing under
///         test rather than a mock's restatement of it.
// ─── Mocks ───────────────────────────────────────────────────────────────────

contract MockToweliCGI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
}

contract MockJbacCGI is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) { _mint(to, _id); return _id++; }
}

contract MockWethCGI {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
    receive() external payable { balanceOf[msg.sender] += msg.value; }
}

/// @dev A CONTRACT holder, so it can legally hold >1 staking position.
///      `StakingRewardLib.afterTokenTransfer` reverts `AlreadyHasPosition` for
///      EOA receivers (`code.length == 0 || == 23`), so a multi-position
///      proposer can only ever be a contract. Used to prove the BATCH-E H11
///      "exactly one position" rule still bites after the fix.
contract MultiPositionStakerCGI {
    function approve(ERC20 token, address spender, uint256 amt) external {
        token.approve(spender, amt);
    }
    function stake(TegridyStaking staking, uint256 amt, uint256 lock) external {
        staking.stake(amt, lock);
    }
    function createProposal(CommunityGrants grants, address recipient, uint256 amt, string calldata desc) external {
        grants.createProposal(recipient, amt, desc);
    }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

contract CommunityGrantsRealStakingIntegrationTest is Test {
    MockToweliCGI token;
    MockJbacCGI nft;
    MockWethCGI weth;
    TegridyStaking staking;
    CommunityGrants grants;

    address treasury = makeAddr("treasury");
    address alice    = makeAddr("alice");
    address artist   = makeAddr("artist");

    uint256 constant STAKE_AMT   = 500_000 ether;
    uint256 constant LOCK        = 30 days;
    uint256 constant GRANT_AMT   = 1 ether;
    // CommunityGrants.PROPOSAL_FEE
    uint256 constant PROPOSAL_FEE = 42_069 ether;

    function setUp() public {
        // CommunityGrants.createProposal reads `block.timestamp - SNAPSHOT_LOOKBACK`
        // (1 hours). Foundry's default timestamp of 1 would take the genesis
        // fallback branch; warp somewhere realistic first.
        vm.warp(365 days);

        token = new MockToweliCGI();
        nft   = new MockJbacCGI();
        weth  = new MockWethCGI();

        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        staking.setJbacVault(address(new TegridyStakingJbacVault(address(nft), address(staking))));

        // Exactly the production wiring: votingEscrow == the staking contract.
        grants = new CommunityGrants(address(staking), address(token), treasury, address(weth));

        // Grants vault needs ETH — createProposal caps `_amount` at
        // MAX_GRANT_PERCENT_BPS (50%) of the unencumbered balance.
        vm.deal(address(grants), 100 ether);

        token.transfer(alice, 5_000_000 ether);
        vm.startPrank(alice);
        token.approve(address(staking), type(uint256).max);
        token.approve(address(grants), type(uint256).max);
        vm.stopPrank();

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(50_000_000 ether);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 1. THE REGRESSION TEST
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice A staker with exactly one position must be able to create a grant
    ///         proposal against a real TegridyStaking.
    ///
    /// @dev    PRE-FIX this FAILS with `EvmError: Revert` — `createProposal`
    ///         reverts with empty returndata at the single-position check,
    ///         because selector `userPositionCount(address)` is absent from
    ///         TegridyStaking's compiled ABI.
    ///
    ///         This asserts the INVARIANT (a single-position holder can propose)
    ///         rather than a specific revert payload, so it stays meaningful
    ///         regardless of how the single-position check is sourced.
    function test_createProposal_singlePositionHolder_succeedsAgainstRealStaking() public {
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK);

        // Exactly one position — the precondition BATCH-E H11 wants.
        assertEq(staking.balanceOf(alice), 1, "alice should hold exactly one staking NFT");
        assertTrue(staking.userTokenId(alice) != 0, "userTokenId pointer must be set");

        vm.prank(alice);
        grants.createProposal(artist, GRANT_AMT, "fund the towel mural");

        assertEq(grants.proposalCount(), 1, "proposal must be created");
        assertEq(grants.activeProposalCount(), 1, "proposal must be active");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. THE GENERALIZED GUARD — catches this whole bug CLASS
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice EVERY member declared on `IVotingEscrowGrants` must exist on the
    ///         real TegridyStaking ABI.
    ///
    /// @dev    THE GENERALIZED GUARD. Probes with raw `staticcall` — a missing
    ///         selector hits no `fallback()` and returns `success == false` with
    ///         zero returndata, which is precisely the failure mode that bricked
    ///         createProposal. This test does not care WHY a selector vanished
    ///         (EIP-170 golf, refactor, rename); it fails the moment the ABI
    ///         contract between these two contracts is broken again.
    ///
    ///         It deliberately covers the WHOLE interface, not just the members
    ///         currently reached at runtime: a declaration that no longer
    ///         resolves is a loaded gun for the next caller added to this file.
    ///
    ///         KEEP THIS LIST IN SYNC WITH `IVotingEscrowGrants`
    ///         (the interface block at the top of CommunityGrants.sol).
    function test_stakingExposesEveryDeclaredVotingEscrowSelector() public view {
        _assertSelectorLive(abi.encodeWithSignature("votingPowerOf(address)", alice), "votingPowerOf(address)");
        _assertSelectorLive(
            abi.encodeWithSignature("votingPowerAtTimestamp(address,uint256)", alice, block.timestamp - 1),
            "votingPowerAtTimestamp(address,uint256)"
        );
        _assertSelectorLive(abi.encodeWithSignature("totalBoostedStake()"), "totalBoostedStake()");
        _assertSelectorLive(
            abi.encodeWithSignature("totalBoostedStakeAtTimestamp(uint256)", block.timestamp - 1),
            "totalBoostedStakeAtTimestamp(uint256)"
        );
        _assertSelectorLive(abi.encodeWithSignature("userTokenId(address)", alice), "userTokenId(address)");
        _assertSelectorLive(
            abi.encodeWithSignature("holdsToken(address,uint256)", alice, uint256(1)),
            "holdsToken(address,uint256)"
        );
        _assertSelectorLive(abi.encodeWithSignature("balanceOf(address)", alice), "balanceOf(address)");
    }

    function _assertSelectorLive(bytes memory payload, string memory sig) internal view {
        (bool ok, bytes memory ret) = address(staking).staticcall(payload);
        assertTrue(ok, string.concat("TegridyStaking is missing selector: ", sig));
        assertGt(ret.length, 0, string.concat("selector returned no data: ", sig));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. THE SECURITY PROPERTY THE FIX MUST PRESERVE (BATCH-E H11)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice A proposer holding MORE than one position is still rejected.
    ///         This is the sybil-vote bypass BATCH-E H11 closed; whatever
    ///         surface supplies the count, this must keep reverting.
    /// @dev `stake()` reverts `AlreadyStaked` when `userTokenId[msg.sender] != 0`,
    ///      so NOBODY can stake twice directly. The only route to a multi-position
    ///      holder is a transfer-in, and only a CONTRACT can receive one (the
    ///      `AlreadyHasPosition` guard rejects EOA receivers that already hold a
    ///      position). That is exactly the sybil setup BATCH-E H11 targets.
    function test_multiPositionProposer_stillRejected() public {
        MultiPositionStakerCGI holder = new MultiPositionStakerCGI();
        token.transfer(address(holder), 5_000_000 ether);
        holder.approve(token, address(staking), type(uint256).max);
        holder.approve(token, address(grants), type(uint256).max);

        // Position #1: the contract stakes for itself.
        holder.stake(staking, STAKE_AMT, LOCK);
        // Position #2: alice stakes and routes her NFT into the contract.
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK);
        uint256 aliceId = staking.userTokenId(alice);

        vm.warp(vm.getBlockTimestamp() + 2 days); // clear TRANSFER_COOLDOWN
        vm.prank(alice);
        staking.transferFrom(alice, address(holder), aliceId);

        assertEq(staking.balanceOf(address(holder)), 2, "contract holder should hold two positions");
        assertTrue(staking.userTokenId(address(holder)) != 0, "pointer set, so the count check is what bites");

        vm.expectRevert(CommunityGrants.ProposerMustHaveSinglePosition.selector);
        holder.createProposal(grants, artist, GRANT_AMT, "sybil attempt");
    }

    /// @notice A proposer holding ZERO positions is rejected before the count
    ///         check, by the NEW-G7 pointer guard.
    function test_zeroPositionProposer_rejected() public {
        vm.expectRevert(CommunityGrants.ProposerMissingStakingPointer.selector);
        vm.prank(alice);
        grants.createProposal(artist, GRANT_AMT, "no stake");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. THE SUBSTITUTION IS SOUND — balanceOf ≡ per-owner position cardinality
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice `balanceOf(user)` must track the per-owner position set across
    ///         every position-cardinality transition: mint, transfer, burn.
    ///
    /// @dev    JUSTIFIES THE FIX. `_positionsByOwner[user]` is mutated ONLY in
    ///         `StakingRewardLib.afterTokenTransfer` — `remove(id)` when
    ///         `from != 0`, `add(id)` when `to != 0`. Solady's ERC721 fires
    ///         `_afterTokenTransfer` on all five balance-mutating paths
    ///         (`transferFrom`, `_mint`, `_safeMint`, `_transfer`, `_burn`), and
    ///         adjusts `_balanceOf` under identical conditions. The two counters
    ///         are therefore updated by the same hook under the same guards, so
    ///         `balanceOf(u) == _positionsByOwner[u].length()` is an invariant.
    ///         This test pins that equivalence behaviourally.
    function test_balanceOfTracksPositionCardinality() public {
        assertEq(staking.balanceOf(alice), 0, "starts at zero");

        // mint
        vm.prank(alice);
        staking.stake(STAKE_AMT, LOCK);
        assertEq(staking.balanceOf(alice), 1, "mint increments");

        // transfer out (clears TRANSFER_COOLDOWN of 24h first)
        uint256 id = staking.userTokenId(alice);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        address bob = makeAddr("bob");
        vm.prank(alice);
        staking.transferFrom(alice, bob, id);
        assertEq(staking.balanceOf(alice), 0, "transfer-out decrements sender");
        assertEq(staking.balanceOf(bob), 1, "transfer-in increments receiver");

        // burn — withdraw after the lock matures
        vm.warp(vm.getBlockTimestamp() + LOCK + 1);
        vm.prank(bob);
        staking.withdraw(id);
        assertEq(staking.balanceOf(bob), 0, "burn decrements");
    }
}
