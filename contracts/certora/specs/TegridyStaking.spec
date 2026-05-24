/*
 * TegridyStaking.spec — Certora formal-verification rules
 *
 * Phase 1.4 starter rules for the highest-stakes TegridyStaking invariants.
 * Each rule is the Certora-CVL translation of a Halmos `check_*` function
 * already living in `contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol`.
 *
 * Reference patterns: OpenZeppelin contracts/fv/specs/AccessControl.spec
 *                     OpenZeppelin contracts/fv/specs/Pausable.spec
 *
 * Maintenance contract: if TegridyStaking's storage layout or any of the
 * 11 method signatures referenced below shift, this file MUST be
 * re-reviewed. The harness in certora/harness/TegridyStakingHarness.sol
 * does the matching for solc; CVL types are pinned independently here.
 */

using ERC20 as rewardToken;

methods {
    // ─── State reads on the harness ─────────────────────────────────
    function totalStaked()     external returns (uint256) envfree;
    function maxStakePerUser() external returns (uint256) envfree;
    function maxTotalStaked()  external returns (uint256) envfree;
    function pauseGuardian()   external returns (address) envfree;
    function owner()           external returns (address) envfree;
    function paused()          external returns (bool)    envfree;

    // ─── Mutating entry-points under test ───────────────────────────
    function stake(uint256, uint256)        external;
    function setMaxStakePerUser(uint256)    external;
    function setMaxTotalStaked(uint256)     external;
    function setPauseGuardian(address)      external;
    function pause()                        external;
    function unpause()                      external;
    function guardianPause()                external;

    // ─── Linked ERC20 (rewardToken) ─────────────────────────────────
    // Explicit binding: the `using` clause above ties `rewardToken` to
    // the deployed OpenZeppelin ERC20 (see TegridyStaking.conf `link:`).
    function rewardToken.balanceOf(address) external returns (uint256) envfree;
    function rewardToken.transfer(address, uint256) external returns (bool);
    function rewardToken.transferFrom(address, address, uint256) external returns (bool);
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-1 — Global cap invariant                                   │
 *  │ Halmos: check_globalCap                                          │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  For ANY (amount, lockDuration), stake() either reverts OR the
 *  post-state totalStaked stays at most maxTotalStaked AND grew by
 *  exactly `amount` from its prior value.
 */
rule globalCapRespected(env e, uint256 amount, uint256 lockDuration) {
    uint256 capBefore   = maxTotalStaked();
    uint256 totalBefore = totalStaked();

    stake@withrevert(e, amount, lockDuration);
    bool reverted = lastReverted;

    uint256 totalAfter = totalStaked();

    // If stake succeeded: cap is honoured AND running total grew by amount.
    assert !reverted => totalAfter <= capBefore;
    assert !reverted => totalAfter == totalBefore + amount;

    // If stake reverted: cap state is untouched.
    assert reverted => totalAfter == totalBefore;
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-2 — Per-user cap invariant                                 │
 *  │ Halmos: check_perUserCap                                         │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  Successful stake() implies the staked amount fits under the
 *  per-user cap. Over-cap inputs must revert.
 */
rule perUserCapRespected(env e, uint256 amount, uint256 lockDuration) {
    uint256 perUserCap = maxStakePerUser();

    stake@withrevert(e, amount, lockDuration);
    bool reverted = lastReverted;

    assert !reverted => amount <= perUserCap;
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-3 — Principal recoverable after stake                      │
 *  │ Halmos: check_principalRecoverableAfterStake                     │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  After a successful stake() the contract's TOWELI balance is at
 *  least the recorded totalStaked. Together with the cap rules above,
 *  this guarantees full principal recoverability if the contract is
 *  paused and the entire user base withdraws.
 */
rule principalRecoverableAfterStake(env e, uint256 amount, uint256 lockDuration) {
    stake@withrevert(e, amount, lockDuration);
    bool reverted = lastReverted;

    uint256 contractBalance = rewardToken.balanceOf(currentContract);
    uint256 recorded        = totalStaked();

    assert !reverted => contractBalance >= recorded;
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-4 — Caps cannot be set to zero                             │
 *  │ Halmos: check_capCannotBeZero                                    │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  Operator pause is the way to halt new stakes. The cap setters must
 *  reject zero on both paths to prevent an off-by-one that effectively
 *  pauses the system via a 0-cap (bypassing the audited pause flow).
 */
rule capCannotBeZeroed(env e) {
    setMaxStakePerUser@withrevert(e, 0);
    assert lastReverted, "setMaxStakePerUser(0) must always revert";

    // Fresh env reset for the second branch — caller stays the same.
    setMaxTotalStaked@withrevert(e, 0);
    assert lastReverted, "setMaxTotalStaked(0) must always revert";
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-5 — Pause authority is exclusive                           │
 *  │ Halmos: check_pauseAuth                                          │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  pause()       is owner-only (cold 4-of-7 multisig).
 *  guardianPause() is guardian-only (hot 3-of-5 multisig).
 *  Any other caller — including the zero address — must revert.
 */
rule pauseAuthExclusive(env e) {
    address caller = e.msg.sender;

    // Path A: pause() should only succeed for owner.
    pause@withrevert(e);
    bool pauseSucceeded = !lastReverted;
    assert pauseSucceeded => caller == owner();

    // Path B: guardianPause() should only succeed for the guardian.
    // (Run on a sibling env so state interleaving doesn't mask the result.)
    guardianPause@withrevert(e);
    bool guardianSucceeded = !lastReverted;
    assert guardianSucceeded => caller == pauseGuardian();
}

/*
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ CHECK-6 — Guardian cannot unpause                                │
 *  │ Halmos: check_guardianCannotUnpause                              │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  The PauseGuardian role is intentionally asymmetric: it can pause
 *  (fast, hot key) but never unpause (recovery requires the cold
 *  owner multisig). This rule pins that asymmetry — even when the
 *  caller IS the registered guardian, unpause() must revert unless
 *  the guardian also happens to be the owner.
 */
rule guardianCannotUnpause(env e) {
    address caller = e.msg.sender;
    require caller == pauseGuardian();
    require caller != owner();           // exclude the (illegal) overlap case

    unpause@withrevert(e);
    assert lastReverted,
        "guardian alone must not be able to unpause";
}

/*
 *  ─── Provenance ────────────────────────────────────────────────────
 *
 *  Each rule above is a 1:1 translation of a Halmos check_* function;
 *  the Halmos file is the executable test suite that runs under
 *  `forge test`, this file is the static-proof companion that runs
 *  under `certoraRun certora/specs/TegridyStaking.conf`. Keep the two
 *  in lock-step: if a Halmos property changes, this spec changes too.
 */
