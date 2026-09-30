#!/usr/bin/env bash
# Prints true or false: would GitHub have started this workflow for this push?
# act ignores `on.push.paths`, so act-job.sh asks here first, inside the act image
# (it has yq, node and git). Every doubt prints true: a wrong true costs runner time,
# a wrong false skips a gate. Needs BEFORE and AFTER (commit shas) in the environment.
set -uo pipefail

wf=${1:?workflow path}
say() { printf '%s\n' "$1"; exit 0; }

sha='^[0-9a-f]{40}([0-9a-f]{24})?$'
[[ ${BEFORE:-} =~ $sha && ${AFTER:-} =~ $sha ]] || say true
[[ $BEFORE =~ ^0+$ ]] && say true                    # a new branch: nothing to compare
grep -q 'paths-ignore' "$wf" && say true              # a filter shape this file does not model
command -v yq >/dev/null && command -v node >/dev/null || say true

paths=$(yq '(.on.push.paths // [])[]' "$wf" 2>/dev/null | tr -d '\r') || say true
[ -n "$paths" ] || say true                           # no paths filter: every push runs it
files=$(git -c core.quotepath=off diff --name-only --no-renames "$BEFORE" "$AFTER" 2>/dev/null) || say true
[ -n "$files" ] || say true

# A pattern that is not a plain glob (quoted by an old yq, or a `!` negation that
# diff-scope.mjs does not model) could only ever match nothing, so it answers true.
mapfile -t patterns <<<"$paths"
for p in "${patterns[@]}"; do
  [[ $p =~ ^[A-Za-z0-9_./*?{},-]+$ ]] || say true
done
verdict=$(printf '%s\n' "$files" | node .github/scripts/diff-scope.mjs "${patterns[@]}") || say true
[ "$verdict" = false ] && say false
say true
