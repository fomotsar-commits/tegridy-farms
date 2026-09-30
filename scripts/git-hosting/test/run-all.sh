#!/usr/bin/env bash
# Runs every git-hosting test (throwaway repos only; needs git, bash 4, sha256sum, ssh-keygen). Exits 1 if any fails.
# ci.yml runs this in the "Git-hosting script tests" step.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
failed=0
for t in test-push-all.sh test-set-remotes.sh test-mirror.sh test-backup.sh test-consolidate.sh; do
  out=$(bash "$here/$t" 2>&1); rc=$?
  grep -E '^FAIL' <<< "$out" || true
  echo "$(tail -n 1 <<< "$out")   ($t exit $rc)"
  ((rc == 0)) || failed=1
done
exit "$failed"
