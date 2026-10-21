#!/usr/bin/env bash
# ============================================================================
# mutate-ladder-exit.sh: prove the ladder's law is pinned by tests that FAIL on
# the two builds it replaced (CLAUDE.md law 7, the mutation half).
#
# The law (owner, 2026-10-18): leaving early costs the time left on the lock
# over four years, capped at 75%. Two mutants, each run alone from contracts/:
#   A  a FLAT 75%: the ratio line becomes `ratio = MAX_PENALTY_RATIO` whatever
#      the time left (the build this PR shipped for a few hours)
#   B  a 25% cap: MAX_EARLY_EXIT_PENALTY_BPS 7_500 -> 2_500
# For each: apply, run the three test files that watch the exit, EXPECT red,
# restore the file from HEAD and prove the restore (git diff --quiet). Then
# run the same tests on the real source and expect green.
#
# Exit 0 only when both mutants were caught AND the real source passes AND the
# source is byte-identical to HEAD afterwards. A run cut short leaves a mutant
# on disk: the trap restores it, but always re-check `git status`.
#
#   FOUNDRY_SPARSE_MODE=true ./script/mutate-ladder-exit.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

SRC="src/LighthouseLadder.sol"
TESTS="test/vendor/{LighthouseLadder,FundLighthouseGuard,DeployLighthouseLadderGate}.t.sol"
RATIO_LINE='uint256 ratio = (timeLeft * PENALTY_SCALE) / MAX_LOCK_DURATION;'
CAP_LINE='uint256 public constant MAX_EARLY_EXIT_PENALTY_BPS = 7_500;'

restore() {
  git show "HEAD:contracts/$SRC" > "$SRC"
  if git diff --quiet -- "$SRC"; then
    echo "restored: $SRC matches HEAD"
  else
    echo "RESTORE FAILED: $SRC still differs from HEAD" >&2
    exit 2
  fi
}

if ! git diff --quiet -- "$SRC"; then
  echo "refusing: $SRC has uncommitted changes; commit or stash them first" >&2
  exit 2
fi
grep -qF "$RATIO_LINE" "$SRC" || { echo "anchor not found in $SRC: $RATIO_LINE" >&2; exit 2; }
grep -qF "$CAP_LINE" "$SRC" || { echo "anchor not found in $SRC: $CAP_LINE" >&2; exit 2; }

trap restore EXIT

run_mutant() {
  local name="$1" from="$2" to="$3"
  echo "== mutant $name =="
  python - "$SRC" "$from" "$to" <<'PY'
import io, sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8', newline='').read()
assert s.count(a) == 1, (a, s.count(a))
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(a, b))
PY
  grep -qF "$to" "$SRC" || { echo "mutation $name did not apply" >&2; exit 2; }
  set +e
  forge test --match-path "$TESTS" > "/tmp/mutant-$name.txt" 2>&1
  local code=$?
  set -e
  grep -E "^\[FAIL" "/tmp/mutant-$name.txt" | sed 's/^/   /' | head -20 || true
  if [ "$code" -eq 0 ]; then
    echo "MUTANT $name SURVIVED: the tests pass. The pin is vacuous." >&2
    exit 1
  fi
  local caught
  caught=$(grep -cE "^\[FAIL" "/tmp/mutant-$name.txt" || true)
  echo "mutant $name caught: $caught failing test(s)"
  restore
}

run_mutant "A-flat-75" "$RATIO_LINE" 'uint256 ratio = MAX_PENALTY_RATIO; // MUTANT: flat'
run_mutant "B-cap-25" "$CAP_LINE" 'uint256 public constant MAX_EARLY_EXIT_PENALTY_BPS = 2_500;'
trap - EXIT

echo "== real source: the ladder's law =="
forge test --match-path "$TESTS" > /tmp/real.txt 2>&1 || {
  grep -E "^\[FAIL" /tmp/real.txt >&2 || true
  echo "the real source does not pass its own tests" >&2
  exit 1
}
grep -E "Suite result|tests passed" /tmp/real.txt | sed 's/^/   /' || true
echo "OK: both mutants caught, the law passes, source restored."
