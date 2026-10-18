#!/usr/bin/env bash
# ============================================================================
# mutate-ladder-exit.sh: prove the 75% exit is pinned by a test that FAILS on
# the retired 25% build (CLAUDE.md law 7, the mutation half).
#
# What it does, from contracts/:
#   1. sets LighthouseLadder.sol's EARLY_EXIT_PENALTY_BPS to 2_500 (the mutant)
#   2. runs the three test files that watch the exit and EXPECTS them to go red
#   3. restores the file from HEAD and proves the restore (git diff --quiet)
#   4. runs the same tests on the restored source and expects green
#
# Exit 0 only when the mutant was caught AND the real source passes AND the
# source is byte-identical to HEAD afterwards. A run cut short leaves the
# mutant on disk: the trap restores it, but always re-check `git status`.
#
#   FOUNDRY_SPARSE_MODE=true ./script/mutate-ladder-exit.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

SRC="src/LighthouseLadder.sol"
TESTS="test/vendor/{LighthouseLadder,FundLighthouseGuard,DeployLighthouseLadderGate}.t.sol"
LINE='uint256 public constant EARLY_EXIT_PENALTY_BPS = 7_500;'

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
grep -qF "$LINE" "$SRC" || { echo "anchor not found in $SRC: $LINE" >&2; exit 2; }

trap restore EXIT

echo "== mutant: EARLY_EXIT_PENALTY_BPS = 2_500 =="
sed -i 's/EARLY_EXIT_PENALTY_BPS = 7_500;/EARLY_EXIT_PENALTY_BPS = 2_500;/' "$SRC"
grep -qF 'EARLY_EXIT_PENALTY_BPS = 2_500;' "$SRC" || { echo "mutation did not apply" >&2; exit 2; }

set +e
forge test --match-path "$TESTS" > /tmp/mutant.txt 2>&1
MUTANT_EXIT=$?
set -e
grep -E "^\[(FAIL|PASS)" /tmp/mutant.txt | sed 's/^/   /' | head -40 || true
if [ "$MUTANT_EXIT" -eq 0 ]; then
  echo "MUTANT SURVIVED: the tests pass with a 25% exit. The pin is vacuous." >&2
  exit 1
fi
CAUGHT=$(grep -cE "^\[FAIL" /tmp/mutant.txt || true)
echo "mutant caught: $CAUGHT failing test(s)"

restore
trap - EXIT

echo "== real source: EARLY_EXIT_PENALTY_BPS = 7_500 =="
forge test --match-path "$TESTS" > /tmp/real.txt 2>&1 || {
  grep -E "^\[FAIL" /tmp/real.txt >&2 || true
  echo "the real source does not pass its own tests" >&2
  exit 1
}
grep -E "Suite result|tests passed" /tmp/real.txt | sed 's/^/   /' || true
echo "OK: 25% is caught, 75% passes, source restored."
