// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TegridyLockVault} from "../../src/TegridyLockVault.sol";

/// @title  Lock vault invariant suite — build plan item #28
/// @notice Stateful invariants over the LP-lock vault under random sequences of locks,
///         top-ups, extensions, handovers, withdrawals and time travel, driven by several
///         actors including the protocol owner and an unrelated stranger.
///
///         - INV-SOLVENCY: the vault's token balance always covers `totalLocked`. If this
///           ever fails, someone was paid tokens that belonged to another lock.
///
///         - INV-ACCOUNTING: `totalLocked` equals the sum of every active lock's amount.
///           The running total is what the scanner and the fact sheets print, so a drift
///           between it and the locks themselves is a published falsehood.
///
///         - INV-NO-EARLY-RELEASE: no lock is ever marked withdrawn before its own unlock
///           timestamp. Stated over history rather than per-call, so an exotic ordering
///           cannot slip a release through.
///
///         - INV-EXPIRY-MONOTONIC: a lock's `unlockAt` never decreases. A fact sheet that
///           printed "locked until T" must never be made retroactively false.
///
///         - INV-NO-ETH-RETAINED: the vault never holds ETH; fee wei is forwarded in the
///           same call or the call reverts.
///
///         fail_on_revert stays at the foundry.toml default (false): the handler
///         deliberately drives unauthorized and premature calls, which must revert.
contract LockInvToken is ERC20 {
    constructor() ERC20("LockInv", "LINV") {
        _mint(msg.sender, 10_000_000 ether);
    }
}

contract LockVaultInvHandler is Test {
    TegridyLockVault public vault;
    LockInvToken public token;

    address[] public actors;
    uint256 public lastId;

    /// @notice Highest `unlockAt` ever observed per lock — the monotonicity witness.
    mapping(uint256 => uint64) public highWaterUnlock;
    /// @notice Set when a lock is first seen withdrawn, together with the instant it
    ///         happened, so early release can be judged after the fact.
    mapping(uint256 => bool) public sawWithdrawn;
    mapping(uint256 => uint64) public unlockAtWhenWithdrawn;
    mapping(uint256 => uint256) public withdrawnAt;

    constructor(TegridyLockVault _vault, LockInvToken _token, address[] memory _actors) {
        vault = _vault;
        token = _token;
        for (uint256 i = 0; i < _actors.length; ++i) {
            actors.push(_actors[i]);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function lock(uint256 actorSeed, uint256 amountSeed, uint256 durationSeed) public {
        address a = _actor(actorSeed);
        uint256 amount = bound(amountSeed, 1, 50_000 ether);
        uint64 duration =
            uint64(bound(durationSeed, vault.MIN_LOCK_DURATION(), uint256(vault.MAX_LOCK_DURATION())));
        uint64 unlockAt = uint64(block.timestamp) + duration;
        vm.startPrank(a);
        token.approve(address(vault), amount);
        try vault.lock(address(token), amount, unlockAt) returns (uint256 id) {
            lastId = id;
        } catch {}
        vm.stopPrank();
        _record();
    }

    function increase(uint256 actorSeed, uint256 idSeed, uint256 amountSeed) public {
        if (lastId == 0) return;
        address a = _actor(actorSeed);
        uint256 id = (idSeed % lastId) + 1;
        uint256 amount = bound(amountSeed, 1, 10_000 ether);
        vm.startPrank(a);
        token.approve(address(vault), amount);
        try vault.increase(id, amount) {} catch {}
        vm.stopPrank();
        _record();
    }

    function extend(uint256 actorSeed, uint256 idSeed, uint256 addSeed) public {
        if (lastId == 0) return;
        address a = _actor(actorSeed);
        uint256 id = (idSeed % lastId) + 1;
        uint64 target = uint64(block.timestamp) + uint64(bound(addSeed, 1, 100 days));
        vm.prank(a);
        try vault.extend(id, target) {} catch {}
        _record();
    }

    function withdraw(uint256 actorSeed, uint256 idSeed) public {
        if (lastId == 0) return;
        address a = _actor(actorSeed);
        uint256 id = (idSeed % lastId) + 1;
        vm.prank(a);
        try vault.withdraw(id) {} catch {}
        _record();
    }

    function handover(uint256 fromSeed, uint256 toSeed, uint256 idSeed) public {
        if (lastId == 0) return;
        uint256 id = (idSeed % lastId) + 1;
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        vm.prank(from);
        try vault.proposeLockOwner(id, to) {
            vm.prank(to);
            try vault.acceptLockOwner(id) {} catch {}
        } catch {}
        _record();
    }

    function warpForward(uint256 seconds_) public {
        vm.warp(block.timestamp + bound(seconds_, 1, 45 days));
        _record();
    }

    /// @dev Snapshots every lock's state after each action so the history-based
    ///      invariants (monotonic expiry, no early release) can be judged post-hoc.
    function _record() internal {
        for (uint256 id = 1; id <= lastId; ++id) {
            TegridyLockVault.LockView memory v = vault.lockView(id);
            if (v.unlockAt > highWaterUnlock[id]) highWaterUnlock[id] = v.unlockAt;
            if (v.withdrawn && !sawWithdrawn[id]) {
                sawWithdrawn[id] = true;
                unlockAtWhenWithdrawn[id] = v.unlockAt;
                withdrawnAt[id] = block.timestamp;
            }
        }
    }
}

contract LockVaultInvariantsTest is Test {
    TegridyLockVault vault;
    LockInvToken token;
    LockVaultInvHandler handler;

    address owner = makeAddr("owner");
    address[] actors;

    function setUp() public {
        vm.warp(1_700_000_000);
        vault = new TegridyLockVault(owner);
        token = new LockInvToken();

        actors.push(makeAddr("creatorA"));
        actors.push(makeAddr("creatorB"));
        actors.push(makeAddr("stranger"));
        actors.push(owner); // the protocol owner acts as an ordinary caller, deliberately
        for (uint256 i = 0; i < actors.length; ++i) {
            token.transfer(actors[i], 1_000_000 ether);
        }

        handler = new LockVaultInvHandler(vault, token, actors);
        targetContract(address(handler));
    }

    /// @notice INV-SOLVENCY
    function invariant_vaultIsSolvent() public view {
        assertGe(token.balanceOf(address(vault)), vault.totalLocked(address(token)), "vault is short");
    }

    /// @notice INV-ACCOUNTING
    function invariant_totalLockedMatchesActiveLocks() public view {
        uint256 sum;
        uint256 last = handler.lastId();
        for (uint256 id = 1; id <= last; ++id) {
            TegridyLockVault.LockView memory v = vault.lockView(id);
            if (!v.withdrawn) sum += v.amount;
        }
        assertEq(sum, vault.totalLocked(address(token)), "running total drifted from the locks");
    }

    /// @notice INV-NO-EARLY-RELEASE
    function invariant_noLockReleasedBeforeMaturity() public view {
        uint256 last = handler.lastId();
        for (uint256 id = 1; id <= last; ++id) {
            if (handler.sawWithdrawn(id)) {
                assertGe(
                    handler.withdrawnAt(id), handler.unlockAtWhenWithdrawn(id), "a lock released before maturity"
                );
            }
        }
    }

    /// @notice INV-EXPIRY-MONOTONIC
    function invariant_unlockTimeNeverDecreases() public view {
        uint256 last = handler.lastId();
        for (uint256 id = 1; id <= last; ++id) {
            assertGe(vault.lockView(id).unlockAt, handler.highWaterUnlock(id), "unlock time moved backwards");
        }
    }

    /// @notice INV-NO-ETH-RETAINED
    function invariant_noEthRetained() public view {
        assertEq(address(vault).balance, 0, "vault retained unsweepable ETH");
    }
}
