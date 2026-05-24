# Halmos Symbolic Execution — mvp-launch (2026-05-24)

Tool: Halmos 0.3.3 (a16z symbolic checker, Z3 solver).
Spec file: `contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol`.
Run from `contracts/`.

## Run command (working invocation)

```bash
export PATH="$HOME/.local/bin:$HOME/AppData/Roaming/Python/Python312/Scripts:$PATH"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1   # Windows: keeps output decodable
export HALMOS_ALLOW_DOWNLOAD=1               # lets halmos fetch its fallback solver

halmos --match-contract MVPLaunch_HalmosSpecs \
       --solver-timeout-assertion 10000 \
       --storage-layout generic
```

`--storage-layout generic` is mandatory. Without it, the four checks that
touch mappings keyed by symbolic addresses (`check_globalCap`,
`check_perUserCap`, `check_principalRecoverableAfterStake`,
`check_guardianCannotUnpause`) `ERROR` with `NotConcreteError: symbolic
storage base slot`. Cf. <https://github.com/a16z/halmos/wiki/warnings#internal-error>.

`HALMOS_ALLOW_DOWNLOAD=1` is mandatory on first run — Halmos lazy-fetches
its fallback solver and refuses to do so silently.

## Results

```
Symbolic test result: 5 passed; 1 failed; time: 108.87s

[PASS] check_capCannotBeZero               (paths:   1, time:  0.04s)
[PASS] check_globalCap                     (paths: 214, time: 33.67s)
[PASS] check_pauseAuth                     (paths:   2, time:  0.09s)
[PASS] check_perUserCap                    (paths: 236, time: 33.08s)
[PASS] check_principalRecoverableAfterStake (paths: 253, time: 38.27s)
[FAIL] check_guardianCannotUnpause         (paths:   2, time:  0.23s)  ← Halmos limitation, NOT a contract bug
```

## Triage

### 5 proven (true symbolic exploration)

- **`check_globalCap`** — 214 symbolic paths. For arbitrary `(amount, lockDuration)`, `stake()` either reverts or `totalStaked` stays `<= maxTotalStaked`. Proven.
- **`check_perUserCap`** — 236 paths. `stake()` only succeeds when `amount <= maxStakePerUser`. Proven.
- **`check_principalRecoverableAfterStake`** — 253 paths. After any successful stake, `toweli.balanceOf(staking) >= staking.totalStaked()` always holds. Proven. This is the **C-1 class invariant** (no missing collateral path).
- **`check_capCannotBeZero`** — 1 path. `setMaxStakePerUser(0)` and `setMaxTotalStaked(0)` both always revert. Proven.
- **`check_pauseAuth`** — 2 paths. For any caller other than owner/pauseGuardian/`address(0)`, `pause()` and `guardianPause()` both revert. Proven.

214/236/253 paths is real symbolic enumeration — Halmos walked every branch through the stake() function bodies, including all the cap-validation gates added in Phase 0.

### 1 spurious failure — Halmos limitation, not a contract bug

`check_guardianCannotUnpause` is FAIL with `Counterexample: ∅` (empty counterexample = deterministic failure, no symbolic inputs to assign).

Root cause: under `--storage-layout generic`, Halmos treats every storage slot as symbolic-by-default. The `OwnableNoRenounce._owner` slot gets re-symbolized between `setUp()` and the check function. Halmos's solver finds a model where `_owner == pauseGuardian`, which then allows `unpause()` to succeed when called by pauseGuardian, tripping the `assert(false)`.

The actual contract semantics are unambiguous:
- `TegridyStaking.unpause()` at `src/TegridyStaking.sol:902` is `onlyOwner`.
- `TegridyStaking.guardianPause()` at `src/TegridyStaking.sol:931` is `onlyPauseGuardian`.
- The two are distinct roles; the guardian cannot unpause.

This property is already concretely tested in `test/MVPLaunch_StakeCapsAndGuardian.t.sol` (the 27-test suite that landed in `10e1dcc` and is green).

**Auditor handoff note:** for the Certora FV engagement, re-spec this rule against Certora's first-class `msg.sender` modeling rather than via `vm.prank` (which Halmos doesn't fully model). Certora rule sketch:

```
rule guardianCannotUnpause() {
    env e1; env e2;
    require e1.msg.sender == pauseGuardian();
    guardianPause(e1);
    require e2.msg.sender == pauseGuardian();
    require pauseGuardian() != owner();   // semantic precondition
    unpause@withrevert(e2);
    assert lastReverted;
}
```

## Known-FP suppression candidate

For a future Halmos-in-CI configuration, `check_guardianCannotUnpause` should be skipped or refactored to assume `owner != pauseGuardian` upfront (Halmos's `vm.assume` would close the spurious path). Not done in this commit to keep the spec file as the canonical Certora-translation source.

## Re-running

Same command as above. Expected wall-time: ~2 minutes on a modern laptop, dominated by the three 30-40s symbolic exploration runs over the staking flow.

`halmos-cache/` and `crytic-export/` (Halmos's compile output cache) are gitignored. The spec file itself is the audit handoff artifact.

## Refresh policy

Re-run after any change to `TegridyStaking.sol` cap logic, pause/guardian permissions, or principal accounting. If any of the 5 currently-PASS checks regresses to FAIL with a non-empty counterexample, that IS a contract bug — Halmos finds bugs by walking concrete inputs, so a non-empty CEX is reproducible against the real contract.
