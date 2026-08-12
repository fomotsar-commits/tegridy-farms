// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import "../../src/TegridyStakingAdmin.sol";
import {StakingMonitorView} from "../../src/StakingMonitorView.sol";

/// @title Staking invariant suite (R061)
/// @notice Stateful invariants for `TegridyStaking` complementing the unit
///         tests in R018_Staking.t.sol. Targets:
///           - `accruedRewards <= totalRewardsFunded` (no over-distribute)
///           - `totalUnsettledRewards == sum(unsettledRewards[user])` per actor
///           - [staking-attribution] the per-(tokenId, holder) LEDGER:
///               sum_holders(_unsettledByTokenIdHolder[t][h]) == unsettledRewardsByTokenId[t]
///               sum_tokenIds(_unsettledByTokenIdHolder[t][h]) <= unsettledRewards[h]
///
///         EXTENDED 2026-08 [staking-attribution]. The handler previously had ZERO
///         tracked-holder coverage — no lending contract, no restaking contract, so
///         every per-tokenId attribution path in `StakingRewardLib` was unreachable and
///         any invariant over them would have been vacuous. The handler now escrows the
///         position at one of two whitelisted lending contracts, books real shortfall
///         credits, and drains them (including cross-holder attempts).
///         `test_nonVacuity_handlerReachesAttributionPaths` proves the paths are
///         actually reached rather than trusting the fuzzer.

contract StakingR061Token is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract StakingR061NFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }
}

/// @notice Stand-in for a TRACKED holder (lending escrow / restaking contract): holds a
///         position NFT, is flagged via `applyLendingContract`, and forwards calls so
///         `msg.sender == address(this)`.
contract StakingR061Escrow {
    TegridyStaking public immutable staking;
    constructor(TegridyStaking _staking) { staking = _staking; }

    function callGetReward(uint256 tokenId) external returns (uint256) {
        return staking.getReward(tokenId);
    }
    function callClaim(uint256 tokenId, address recipient) external returns (uint256) {
        return staking.claimUnsettledForTokenId(tokenId, recipient);
    }
    function callTransfer(address to, uint256 tokenId) external {
        staking.transferFrom(address(this), to, tokenId);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @notice Handler: stake / withdraw / escrow / claim.
///         `notifyRewardAmount` is deliberately NOT exposed — the whole funding path is
///         fixed in setUp so `invariant_accruedLEUnclaimedPool` keeps a stable upper
///         bound. Shortfalls (which is what produces per-tokenId attribution) are
///         reached instead by baking accrual at a healthy pool and then shrinking the
///         free pool, exactly as they arise in production.
contract StakingR061Handler is Test {
    TegridyStaking public staking;
    StakingMonitorView monitor;
    StakingR061Token public token;
    address public actor;
    address public actor2;
    StakingR061Escrow public escrowA;
    StakingR061Escrow public escrowB;

    /// @notice The escrowable position (actor's). 0 when there is none.
    uint256 public tokenIdMain;
    /// @notice The anchor position (actor2's). Never escrowed; its owner-only
    ///         `getReward` is what BAKES `rewardPerTokenStored` at the live pool.
    uint256 public tokenIdAnchor;
    /// @notice Current custodian of `tokenIdMain`: `actor` or one of the escrows.
    address public custodian;

    // ─── ghosts: non-vacuity evidence for the attribution invariants ───
    uint256 public ghostPerTokenCredits;   // times an escrow booked a per-tokenId credit
    uint256 public ghostDrainsPaid;        // times a per-tokenId drain paid > 0
    uint256 public ghostCrossHolderCalls;  // times a NON-custodian escrow called the drain
    uint256 public ghostUnattributedPaid;  // times a NEVER-CREDITED holder was paid (must stay 0)
    uint256 public ghostKicks;             // successful permissionless kicks

    /// @dev "has this holder ever been credited on this tokenId?" — the ONLY sound
    ///      definition of "entitled". Custody is NOT it: the documented C-1 pattern has
    ///      a holder legitimately draining AFTER handing the NFT back, so
    ///      `escrow != custodian` says nothing about entitlement.
    mapping(uint256 => mapping(address => bool)) public everCredited;

    uint256[] private _knownTokenIds;
    mapping(uint256 => bool) private _seenTokenId;

    constructor(
        TegridyStaking _staking,
        StakingMonitorView _monitor,
        StakingR061Token _token,
        address _actor,
        address _actor2,
        StakingR061Escrow _escrowA,
        StakingR061Escrow _escrowB
    ) {
        staking = _staking;
        monitor = _monitor;
        token = _token;
        actor = _actor;
        actor2 = _actor2;
        escrowA = _escrowA;
        escrowB = _escrowB;
    }

    function allKnownTokenIds() external view returns (uint256[] memory) {
        return _knownTokenIds;
    }

    function _record(uint256 tokenId) internal {
        if (tokenId != 0 && !_seenTokenId[tokenId]) {
            _seenTokenId[tokenId] = true;
            _knownTokenIds.push(tokenId);
        }
    }

    /// @dev The free reward pool: balance - totalStaked - totalUnsettledRewards.
    function freePool() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _escrow(uint256 seed) internal view returns (StakingR061Escrow) {
        return seed % 2 == 0 ? escrowA : escrowB;
    }

    // ─── position lifecycle ───────────────────────────────────────────

    function doStake(uint256 amount, uint256 lockDays) external {
        if (tokenIdMain != 0) return;
        amount = bound(amount, 100 ether, 100_000 ether);
        uint256 lock = bound(lockDays, 7, 365) * 1 days;
        vm.startPrank(actor);
        try staking.stake(amount, lock) {
            tokenIdMain = staking.userTokenId(actor);
            custodian = actor;
            _record(tokenIdMain);
        } catch {}
        vm.stopPrank();
    }

    /// @notice The anchor position. Its existence is what lets the pool be consumed by
    ///         a party OTHER than the escrowed position — the realistic way a shortfall
    ///         arises for the escrowed one.
    function doStakeAnchor(uint256 amount, uint256 lockDays) external {
        if (tokenIdAnchor != 0) return;
        amount = bound(amount, 100 ether, 100_000 ether);
        uint256 lock = bound(lockDays, 7, 365) * 1 days;
        vm.startPrank(actor2);
        try staking.stake(amount, lock) {
            tokenIdAnchor = staking.userTokenId(actor2);
            _record(tokenIdAnchor);
        } catch {}
        vm.stopPrank();
    }

    function doWarp(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 1 hours, 30 days);
        vm.warp(block.timestamp + secondsAhead);
    }

    function doIncrease(uint256 extra) external {
        if (tokenIdMain == 0 || custodian != actor) return;
        extra = bound(extra, 1 ether, 10_000 ether);
        vm.startPrank(actor);
        try staking.increaseAmount(tokenIdMain, extra) {} catch {}
        vm.stopPrank();
    }

    function doExtend(uint256 lockDays) external {
        if (tokenIdMain == 0 || custodian != actor) return;
        uint256 lock = bound(lockDays, 7, 365) * 1 days;
        vm.startPrank(actor);
        try staking.extendLock(tokenIdMain, lock) {} catch {}
        vm.stopPrank();
    }

    function doWithdraw() external {
        if (tokenIdMain == 0 || custodian != actor) return;
        vm.startPrank(actor);
        try staking.withdraw(tokenIdMain) {
            tokenIdMain = 0;
            custodian = address(0);
        } catch {}
        vm.stopPrank();
    }

    function doClaim() external {
        if (staking.unsettledRewards(actor) == 0) return;
        vm.prank(actor);
        try staking.claimUnsettled() {} catch {}
    }

    // ─── the baker + the pool-consumption lever ───────────────────────

    /// @notice `getReward` is `updateReward`-decorated, so this BAKES all elapsed
    ///         emission into `rewardPerTokenStored` at the CURRENT (healthy) pool and
    ///         then pays the anchor out of it. Accrual is pool-capped
    ///         (`StakingRewardLib.accumulateRewards`), so without a bake at a healthy
    ///         pool no shortfall can ever exist.
    function doAnchorClaim() external {
        if (tokenIdAnchor == 0) return;
        vm.prank(actor2);
        try staking.getReward(tokenIdAnchor) {} catch {}
    }

    /// @notice Consume part of the FREE reward pool. Models emission consumed by the
    ///         stakers this narrow harness does not model; bounded to `freePool()` so
    ///         `balance >= totalStaked + totalUnsettledRewards` always still holds and
    ///         no solvency invariant can be weakened by it.
    function doConsumePool(uint256 bps) external {
        uint256 pool = freePool();
        if (pool == 0) return;
        bps = bound(bps, 1, 10_000);
        uint256 amt = (pool * bps) / 10_000;
        if (amt == 0) return;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), amt);
    }

    // ─── tracked-holder escrow paths (the attribution surface) ────────

    /// @dev Record that `creditedHolder` was credited on `tokenId` if the aggregate grew.
    ///      `creditedHolder` is always unambiguous at the call sites below: every
    ///      per-tokenId credit in `StakingRewardLib` goes to the position's owner
    ///      (`getReward` / `kick`) or to the transfer's `from` (`settleRewardsOnTransfer`).
    function _noteCredit(uint256 tokenId, address creditedHolder, uint256 aggBefore) internal {
        if (staking.unsettledRewardsByTokenId(tokenId) > aggBefore) {
            everCredited[tokenId][creditedHolder] = true;
            ghostPerTokenCredits++;
        }
    }

    function doEscrow(uint256 seed) external {
        if (tokenIdMain == 0 || custodian != actor) return;
        StakingR061Escrow e = _escrow(seed);
        uint256 aggBefore = staking.unsettledRewardsByTokenId(tokenIdMain);
        vm.startPrank(actor);
        try staking.transferFrom(actor, address(e), tokenIdMain) {
            custodian = address(e);
            // `from` is the untracked actor, so this must NOT credit — noted anyway so a
            // future change cannot silently create an unrecorded credit.
            _noteCredit(tokenIdMain, actor, aggBefore);
        } catch {}
        vm.stopPrank();
    }

    /// @notice ADDED 2026-08 [KICK-DoS]. The handler never exercised `kick`, so
    ///         the expiry-decay path had ZERO fuzz coverage — and the 2026-08 fix
    ///         makes that path CREDIT the residual to `unsettledRewards[holder]`
    ///         while deliberately bypassing `maxUnsettledRewards`. A cap bypass is
    ///         only safe if a harder bound still holds, and it does:
    ///         `invariant_accruedLEUnclaimedPool` pins `totalUnsettledRewards <=
    ///         totalRewardsFunded`, because every wei of pending traces back to a
    ///         `rewardPerTokenStored` bump that `accumulateRewards` already capped
    ///         to the unreserved pool. This action is what makes that invariant
    ///         actually reach the force-settle branch.
    ///         Permissionless by design — kicked from a non-actor address.
    ///         Distinct from `doKick` below: this one targets the ACTOR's own
    ///         position and proves a third party can kick it, whereas `doKick`
    ///         targets `tokenIdMain` and records the ghost credit the
    ///         attribution-ledger invariants read.
    function doKickThirdParty() external {
        uint256 tokenId = staking.userTokenId(actor);
        if (tokenId == 0) return;
        vm.prank(address(0xC1CC)); // arbitrary third-party kicker
        try staking.kick(tokenId) {} catch {}
    }

    function doUnescrow() external {
        if (tokenIdMain == 0 || custodian == actor || custodian == address(0)) return;
        address outgoing = custodian;
        uint256 aggBefore = staking.unsettledRewardsByTokenId(tokenIdMain);
        try StakingR061Escrow(outgoing).callTransfer(actor, tokenIdMain) {
            custodian = actor;
            // `_settleRewardsOnTransfer(tokenId, from = outgoing)` credits the OUTGOING
            // tracked holder — this is the C-1 pattern that makes a later drain by a
            // non-custodian entirely legitimate.
            _noteCredit(tokenIdMain, outgoing, aggBefore);
        } catch {}
    }

    /// @notice The escrow claims. When the pool has been consumed since the last bake
    ///         this books a per-tokenId credit into the escrow's ledger entry.
    function doEscrowClaimReward() external {
        if (tokenIdMain == 0 || custodian == actor || custodian == address(0)) return;
        address holder = custodian;
        uint256 aggBefore = staking.unsettledRewardsByTokenId(tokenIdMain);
        try StakingR061Escrow(holder).callGetReward(tokenIdMain) {
            _noteCredit(tokenIdMain, holder, aggBefore);
        } catch {}
    }

    /// @notice Drain the per-tokenId ledger. `seed` picks EITHER escrow, so a large
    ///         share of the calls are a tracked holder reaching for a tokenId it was
    ///         never credited on — the exact DIVERSION / DESTRUCTION attempt the fix
    ///         must neuter.
    function doEscrowDrain(uint256 seed, uint256 recipientSeed) external {
        if (tokenIdMain == 0) return;
        StakingR061Escrow e = _escrow(seed);
        address recipient = recipientSeed % 2 == 0 ? address(e) : actor;
        bool entitled = everCredited[tokenIdMain][address(e)];
        if (!entitled) ghostCrossHolderCalls++;
        try e.callClaim(tokenIdMain, recipient) returns (uint256 paid) {
            if (paid > 0) {
                ghostDrainsPaid++;
                if (!entitled) ghostUnattributedPaid++;
            }
        } catch {}
    }

    /// @notice Permissionless kick on an expired position. When the position is escrowed
    ///         this is the third-party route into `_creditByTokenId`.
    function doKick() external {
        if (tokenIdMain == 0) return;
        address holder;
        try staking.ownerOf(tokenIdMain) returns (address o) { holder = o; } catch { return; }
        uint256 aggBefore = staking.unsettledRewardsByTokenId(tokenIdMain);
        try staking.kick(tokenIdMain) {
            ghostKicks++;
            _noteCredit(tokenIdMain, holder, aggBefore);
        } catch {}
    }
}

contract StakingInvariantsTest is Test {
    TegridyStaking public staking;
    TegridyStakingAdmin public admin;
    StakingMonitorView public monitor;
    StakingR061Token public token;
    StakingR061NFT public nft;
    StakingR061Handler public handler;
    StakingR061Escrow public escrowA;
    StakingR061Escrow public escrowB;

    address public treasury = makeAddr("r061_staking_treasury");
    address public actor = makeAddr("r061_staking_actor");
    address public actor2 = makeAddr("r061_staking_actor2");

    uint256 internal constant FUND = 10_000_000 ether;

    /// @dev Storage slot of `TegridyStaking._unsettledByTokenIdHolder` (an `internal`
    ///      mapping — a public nested-mapping getter does not fit in the contract's
    ///      ~239 B of EIP-170 headroom, so the invariants read it with `vm.load`).
    ///
    ///      A WRONG value here CANNOT make the invariants pass vacuously: it would make
    ///      every ledger read return 0 while `unsettledRewardsByTokenId` is non-zero, so
    ///      `invariant_perTokenIdLedgerSumsToAggregate` FAILS the moment any credit
    ///      exists — and `test_nonVacuity_handlerReachesAttributionPaths` proves credits
    ///      do exist. It is also pinned directly by `test_ledgerSlotPin`.
    uint256 internal constant LEDGER_SLOT = 28;

    function setUp() public {
        token = new StakingR061Token();
        nft = new StakingR061NFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        escrowA = new StakingR061Escrow(staking);
        escrowB = new StakingR061Escrow(staking);

        // Whitelist both escrows so `_isTrackedHolder` is true for them, and raise the
        // L-06 unsettled cap so real shortfalls book in full instead of being forfeited.
        admin.proposeLendingContract(address(escrowA), true);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        admin.executeLendingContract();
        admin.proposeLendingContract(address(escrowB), true);
        admin.proposeMaxUnsettledRewards(10_000_000 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        admin.executeLendingContract();
        admin.executeMaxUnsettledRewards();

        // Seed actors with stakeable tokens.
        token.transfer(actor, 50_000_000 ether);
        token.transfer(actor2, 50_000_000 ether);
        vm.prank(actor);
        token.approve(address(staking), type(uint256).max);
        vm.prank(actor2);
        token.approve(address(staking), type(uint256).max);

        // Fund rewards once. Handler MUST NOT call notifyRewardAmount so the
        // "accrued <= funded" invariant has a stable upper bound.
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(FUND);

        handler = new StakingR061Handler(staking, monitor, token, actor, actor2, escrowA, escrowB);
        targetContract(address(handler));

        bytes4[] memory sel = new bytes4[](15);
        sel[0] = StakingR061Handler.doStake.selector;
        sel[1] = StakingR061Handler.doStakeAnchor.selector;
        sel[2] = StakingR061Handler.doWarp.selector;
        sel[3] = StakingR061Handler.doIncrease.selector;
        sel[4] = StakingR061Handler.doExtend.selector;
        sel[5] = StakingR061Handler.doWithdraw.selector;
        sel[6] = StakingR061Handler.doClaim.selector;
        sel[7] = StakingR061Handler.doAnchorClaim.selector;
        sel[8] = StakingR061Handler.doConsumePool.selector;
        sel[9] = StakingR061Handler.doEscrow.selector;
        sel[10] = StakingR061Handler.doUnescrow.selector;
        sel[11] = StakingR061Handler.doEscrowClaimReward.selector;
        sel[12] = StakingR061Handler.doEscrowDrain.selector;
        sel[13] = StakingR061Handler.doKick.selector;
        sel[14] = StakingR061Handler.doKickThirdParty.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ─── ledger read helper ───────────────────────────────────────────

    /// @dev `_unsettledByTokenIdHolder[tokenId][holder]` via raw storage.
    function _ledger(uint256 tokenId, address holder) internal view returns (uint256) {
        bytes32 outer = keccak256(abi.encode(tokenId, LEDGER_SLOT));
        return uint256(vm.load(address(staking), keccak256(abi.encode(holder, outer))));
    }

    function _holders() internal view returns (address[] memory h) {
        h = new address[](5);
        h[0] = address(escrowA);
        h[1] = address(escrowB);
        h[2] = actor;
        h[3] = actor2;
        h[4] = treasury;
    }

    // ═══════════════════ pre-existing invariants ═══════════════════

    /// @notice invariant_accruedLEUnclaimedPool — total reward debt accumulated
    ///         (still-unsettled + already-claimed) cannot exceed the rewards
    ///         actually funded. Guards against an `earned()` math bug
    ///         silently minting phantom rewards.
    function invariant_accruedLEUnclaimedPool() public view {
        uint256 funded = staking.totalRewardsFunded();
        uint256 unsettled = staking.totalUnsettledRewards();
        assertLe(unsettled, funded, "R061 unsettled exceeds funded pool");
    }

    /// @notice invariant_totalUnsettledMatchesActors — `totalUnsettledRewards` must
    ///         equal the sum of every bucket this harness can credit. EXTENDED 2026-08:
    ///         the two tracked-holder escrows now accrue buckets of their own, so
    ///         omitting them would have turned this into an always-false assertion the
    ///         moment the attribution paths were reached.
    function invariant_totalUnsettledMatchesActors() public view {
        address[] memory h = _holders();
        uint256 sum;
        for (uint256 i = 0; i < h.length; i++) sum += staking.unsettledRewards(h[i]);
        assertEq(staking.totalUnsettledRewards(), sum, "R061 unsettled accounting drift");
    }

    /// @notice invariant_totalStakedBounded — staked principal can never exceed
    ///         the token balance the staking contract actually custodies.
    function invariant_totalStakedBounded() public view {
        assertLe(
            staking.totalStaked(),
            token.balanceOf(address(staking)),
            "R061 totalStaked exceeds custodied balance"
        );
    }

    /// @notice invariant_totalStakedEqSumPositions — `totalStaked` exactly tracks the
    ///         sum of every live position's principal. REWRITTEN 2026-08: the old form
    ///         read `staking.userTokenId(actor)`, which the escrow paths zero the moment
    ///         the NFT moves to a tracked holder; it now sums over every tokenId the
    ///         handler has ever minted (burned/withdrawn positions read back as 0).
    function invariant_totalStakedEqSumPositions() public view {
        uint256[] memory known = handler.allKnownTokenIds();
        uint256 sum;
        for (uint256 i = 0; i < known.length; i++) {
            (uint256 amount,,,,,) = monitor.getPosition(known[i]);
            sum += amount;
        }
        assertEq(staking.totalStaked(), sum, "R061 totalStaked != position sum");
    }

    // ═══════════ [staking-attribution] per-(tokenId, holder) LEDGER ═══════════

    /// @notice INV-LEDGER-SUMS-TO-AGGREGATE:
    ///           sum_holders(_unsettledByTokenIdHolder[t][h]) == unsettledRewardsByTokenId[t]
    ///
    ///         This is the property that makes the public aggregate meaningful and that
    ///         makes every drain safe: a credit writes BOTH sides through the single
    ///         `StakingRewardLib._creditByTokenId` choke-point, and both the paid branch
    ///         and the L-16 zombie-cleanup branch of `claimUnsettledForTokenId`
    ///         decrement BOTH by the same amount. If any path ever touched one side
    ///         alone, either value would be strandable — a holder could hold an entry the
    ///         aggregate does not back, or the aggregate could outlive every entry.
    function invariant_perTokenIdLedgerSumsToAggregate() public view {
        uint256[] memory known = handler.allKnownTokenIds();
        address[] memory h = _holders();
        for (uint256 i = 0; i < known.length; i++) {
            uint256 sum;
            for (uint256 j = 0; j < h.length; j++) sum += _ledger(known[i], h[j]);
            assertEq(
                sum,
                staking.unsettledRewardsByTokenId(known[i]),
                "INV-LEDGER-SUMS-TO-AGGREGATE violated"
            );
        }
    }

    /// @notice INV-LEDGER-LE-BUCKET:
    ///           sum_tokenIds(_unsettledByTokenIdHolder[t][h]) <= unsettledRewards[h]
    ///
    ///         The holder bucket is the BACKING for that holder's ledger entries. Every
    ///         entry credit is paired with a `_settleUnsettled` bucket credit of the same
    ///         amount in the same call, and the drain decrements both by `paid`. A
    ///         violation would mean a holder is attributed more than it can ever pay —
    ///         i.e. one of its borrowers/restakers is unbacked.
    function invariant_perTokenIdLedgerNeverExceedsBucket() public view {
        uint256[] memory known = handler.allKnownTokenIds();
        address[] memory h = _holders();
        for (uint256 j = 0; j < h.length; j++) {
            uint256 sum;
            for (uint256 i = 0; i < known.length; i++) sum += _ledger(known[i], h[j]);
            assertLe(sum, staking.unsettledRewards(h[j]), "INV-LEDGER-LE-BUCKET violated");
        }
    }

    /// @notice INV-NO-UNATTRIBUTED-DRAIN: a tracked holder that has NEVER been credited
    ///         on a tokenId can never be paid out of it. This is the direct statement of
    ///         the fix — pre-fix, `_isTrackedHolder(msg.sender)` was the only gate and
    ///         such a holder could both drain (DIVERSION) and, with an empty bucket,
    ///         erase (DESTRUCTION) the entry.
    ///
    ///         Entitlement is "was ever credited", NOT "currently custodies the NFT":
    ///         the documented C-1 pattern has a holder legitimately draining AFTER
    ///         handing the NFT back, so a custody-based ghost false-positives on exactly
    ///         the behaviour requirement 1 protects (confirmed empirically — a
    ///         custody-based version of this invariant failed on a benign
    ///         escrow -> unescrow -> drain sequence).
    function invariant_noUnattributedHolderEverPaid() public view {
        assertEq(handler.ghostUnattributedPaid(), 0, "a never-credited tracked holder was paid");
    }

    // ═══════════════════ non-vacuity + slot pin ═══════════════════

    /// @notice The invariants above are worthless if the fuzzer never reaches the
    ///         attribution paths — an earlier lane found this handler had ZERO kick
    ///         coverage and had to prove reachability explicitly. This drives the
    ///         handler through a deterministic script and asserts the ghosts move.
    function test_nonVacuity_handlerReachesAttributionPaths() public {
        handler.doStake(50_000 ether, 365);
        handler.doStakeAnchor(50_000 ether, 365);
        assertGt(handler.tokenIdMain(), 0, "main position must exist");
        assertGt(handler.tokenIdAnchor(), 0, "anchor position must exist");

        // Past TRANSFER_COOLDOWN, then escrow the main position at escrowA (seed even).
        handler.doWarp(30 days);
        handler.doEscrow(0);
        assertEq(handler.custodian(), address(escrowA), "main position must be escrowed");

        // Accrue, BAKE at a healthy pool (anchor's owner-only getReward is
        // `updateReward`-decorated), then consume the whole free pool.
        handler.doWarp(30 days);
        handler.doAnchorClaim();
        handler.doConsumePool(10_000);
        assertEq(handler.freePool(), 0, "pool must be starved for a shortfall to exist");

        // The escrow now claims into a dry pool => real per-tokenId credit.
        handler.doEscrowClaimReward();
        assertGt(handler.ghostPerTokenCredits(), 0, "NON-VACUITY: no per-tokenId credit booked");

        uint256 id = handler.tokenIdMain();
        assertGt(staking.unsettledRewardsByTokenId(id), 0, "aggregate must be credited");
        assertGt(_ledger(id, address(escrowA)), 0, "escrowA ledger entry must be credited");
        assertEq(_ledger(id, address(escrowB)), 0, "escrowB must have no entry");

        // A NEVER-CREDITED tracked holder reaching for it must be paid nothing (seed odd
        // selects escrowB, which has no entry on this tokenId).
        handler.doEscrowDrain(1, 0);
        assertGt(handler.ghostCrossHolderCalls(), 0, "NON-VACUITY: no unattributed call made");
        assertEq(
            handler.ghostUnattributedPaid(), 0, "never-credited tracked holder must not be paid"
        );

        // The rightful holder drains once the pool is replenished by the anchor's exit.
        vm.prank(actor2);
        token.transfer(address(staking), 1_000_000 ether);
        handler.doEscrowDrain(0, 0);
        assertGt(handler.ghostDrainsPaid(), 0, "NON-VACUITY: no per-tokenId drain ever paid");

        // The kick path (third-party route into _creditByTokenId) is reachable too:
        // warp past the 365-day lock so the position becomes kickable.
        for (uint256 i = 0; i < 13; i++) handler.doWarp(30 days);
        handler.doKick();
        assertGt(handler.ghostKicks(), 0, "NON-VACUITY: kick never succeeded");

        // Finally, the invariants must hold on this concrete, non-empty state.
        invariant_perTokenIdLedgerSumsToAggregate();
        invariant_perTokenIdLedgerNeverExceedsBucket();
        invariant_totalUnsettledMatchesActors();
        invariant_totalStakedEqSumPositions();
    }

    /// @notice Pins `LEDGER_SLOT`. If the storage layout of TegridyStaking ever shifts,
    ///         this fails loudly instead of letting the ledger invariants read zeros.
    function test_ledgerSlotPin() public {
        handler.doStake(50_000 ether, 365);
        handler.doStakeAnchor(50_000 ether, 365);
        handler.doWarp(30 days);
        handler.doEscrow(0);
        handler.doWarp(30 days);
        handler.doAnchorClaim();
        handler.doConsumePool(10_000);
        handler.doEscrowClaimReward();

        uint256 id = handler.tokenIdMain();
        assertEq(
            _ledger(id, address(escrowA)),
            staking.unsettledRewardsByTokenId(id),
            "LEDGER_SLOT is stale: update it from `forge inspect TegridyStaking storage-layout`"
        );
    }
}
