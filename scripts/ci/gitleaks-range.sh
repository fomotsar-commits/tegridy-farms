#!/usr/bin/env bash
# The secret scan on GitLab CI: the pinned gitleaks binary over only the commits this
# pipeline adds (never full history: a revoked historical key would go red forever).
# A change cannot loosen it with a file or a comment: config and ignore file come from the
# commit it builds on, and gitleaks:allow counts for nothing. It can still edit this script,
# as on GitHub; review catches that. To change .gitleaks.toml, merge that change first.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=runner/pins.env
. "$HERE/runner/pins.env"
die() { echo "gitleaks-range: $*" >&2; exit 1; }
is_sha() { [[ $1 =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && [[ ! $1 =~ ^0+$ ]]; }

have=$(gitleaks version 2>/dev/null | tr -d 'v\r') || true
[ "$have" = "$GITLEAKS_VERSION" ] || die "gitleaks is '${have:-missing}', the pin is $GITLEAKS_VERSION (scripts/ci/runner/pins.env)"

head=${CI_COMMIT_SHA:-}
is_sha "$head" || die "CI_COMMIT_SHA is not a commit sha: '$head'"
case ${CI_PIPELINE_SOURCE:-} in
  merge_request_event) base=${CI_MERGE_REQUEST_DIFF_BASE_SHA:-} ;;
  push) base=${CI_COMMIT_BEFORE_SHA:-} ;;
  *) die "pipeline source '${CI_PIPELINE_SOURCE:-}' has no commit range to scan" ;;
esac
# No usable base (a new branch, or history GitLab did not fetch): scan the head commit alone.
if is_sha "$base" && git cat-file -e "$base^{commit}" 2>/dev/null; then
  range="$base..$head"
  from=$base
else
  echo "gitleaks-range: no usable base commit; scanning $head alone"
  range="$head^!"
  from=$(git rev-parse --verify --quiet "$head^") || from=$head
fi
commits=$(git rev-list --count "$range")
[ "$commits" -gt 0 ] || die "the range $range holds no commits; a scan of nothing is not a pass"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/ignore"
if ! git show "$from:.gitleaks.toml" >"$work/gitleaks.toml" 2>/dev/null; then
  printf '[extend]\nuseDefault = true\n' >"$work/gitleaks.toml"
  echo "gitleaks-range: $from has no .gitleaks.toml; using gitleaks' default rules"
fi
git show "$from:.gitleaksignore" >"$work/ignore/.gitleaksignore" 2>/dev/null || rm -f "$work/ignore/.gitleaksignore"
# gitleaks also loads .gitleaksignore from the folder it scans, which here would be the
# change's own. So it scans a clone with no working tree (history is the same objects).
git clone -q --no-checkout --shared . "$work/repo"
[ ! -e "$work/repo/.gitleaksignore" ] || die "the scan folder holds a .gitleaksignore"

echo "gitleaks-range: gitleaks $have over $commits commit(s) in $range, config from ${from:0:12}"
gitleaks git --no-banner --redact --verbose --ignore-gitleaks-allow \
  --config "$work/gitleaks.toml" \
  --gitleaks-ignore-path "$work/ignore" \
  --log-opts="$range" "$work/repo"
