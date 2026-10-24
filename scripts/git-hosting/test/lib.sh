# Sourced by the git-hosting tests. Throwaway repos only: nothing here reads a real clone or host.
# GIT_HOSTING_TEST_DIR keeps the sandbox for a look afterwards; unset, a temp dir is used and removed.
set -uo pipefail
pass=0 fail=0
ok()  { echo "PASS $*"; pass=$((pass + 1)); }
bad() { echo "FAIL $*"; fail=$((fail + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
G() { git -c user.name=t -c user.email=t@example.com -c init.defaultBranch=mvp-launch "$@"; }
finish() { echo "$1: $pass passed, $fail failed"; exit $((fail > 0)); }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPTS=${GIT_HOSTING_SCRIPTS:-$(dirname "$HERE")}   # a mutation run points this at a copy
if [[ -n ${GIT_HOSTING_TEST_DIR:-} ]]; then
  TEST_ROOT=$GIT_HOSTING_TEST_DIR
else
  TEST_ROOT=$(mktemp -d); trap 'rm -rf "$TEST_ROOT"' EXIT
fi
sandbox() { SB="$TEST_ROOT/$1"; rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1; }
