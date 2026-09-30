#!/usr/bin/env bash
# mirror-to-gitlab.sh against throwaway bare repos: gh.git stands in for GitHub, gl.git for the
# GitLab standby, and a fresh clone of gh.git for the workflow's checkout. The URL and the pinned
# host key are read from the workflow file itself, and fake-ssh.sh, first on PATH, checks the SSH
# options before it serves gl.git. No test touches the network. Usage: bash test-mirror.sh
source "$(dirname "$0")/lib.sh"
MIR="$SCRIPTS/mirror-to-gitlab.sh"
WF="$(cd "$HERE/../../.." && pwd)/.github/workflows/mirror-to-gitlab.yml"
HOST_KEY=$(sed -n "s/^ *GITLAB_HOST_KEY: '\(.*\)'\$/\1/p" "$WF")
HOST_FP=$(sed -n "s/^ *GITLAB_HOST_KEY_SHA256: '\(.*\)'\$/\1/p" "$WF")
WF_URL=$(sed -n 's/^ *MIRROR_URL: \(.*\)$/\1/p' "$WF")
sandbox t-mirror
mkdir -p fakebin; cp "$HERE/fake-ssh.sh" fakebin/ssh; chmod +x fakebin/ssh

# run <label> <event> [ref] [deleted]: a fresh checkout of gh.git, then the script; sets out, rc
run() {
  rm -rf co; git clone -q gh.git co 2>/dev/null; mkdir -p "$SB/tmp"
  out=$(cd "$SB" && PATH="$SB/fakebin:$PATH" FAKE_SSH_REPO=${STANDBY_REPO-$SB/gl.git} FAKE_SSH_LOG="$SB/ssh.log" \
        FAKE_SSH_KEY=${KEY-dummy-private-key} FAKE_SSH_HOST_KEY=$HOST_KEY FAKE_SSH_HOST=${WF_URL%%:*} \
        TMPDIR="$SB/tmp" MIRROR_REPO=co MIRROR_URL=$WF_URL MIRROR_EVENT=$2 MIRROR_REF=${3:-} \
        MIRROR_DELETED=${4:-false} GITLAB_MIRROR_SSH_KEY=${KEY-dummy-private-key} \
        GITLAB_HOST_KEY=${HK-$HOST_KEY} GITLAB_HOST_KEY_SHA256=${FP-$HOST_FP} bash "$MIR" 2>&1); rc=$?
}
gl() { git -C "$SB/gl.git" rev-parse -q --verify "$1" 2>/dev/null || echo none; }
gh() { git -C "$SB/gh.git" rev-parse -q --verify "$1" 2>/dev/null || echo none; }
pushes() { grep -c '^PUSH' gl.log 2>/dev/null || echo 0; }

check "the workflow pins a host key line" test -n "$HOST_KEY"
check "the workflow pins a fingerprint" test -n "$HOST_FP"

# ---- GitHub: trunk (2 commits), diverged main, features, a light and an annotated tag
G init -q -b mvp-launch w
G -C w commit -q --allow-empty -m base; G -C w branch main
G -C w commit -q --allow-empty -m trunk2
G -C w checkout -q main; G -C w commit -q --allow-empty -m main-only
G -C w checkout -q -b feat/a mvp-launch; G -C w commit -q --allow-empty -m a
G -C w checkout -q -b feat/b mvp-launch; G -C w commit -q --allow-empty -m b
G -C w checkout -q mvp-launch; G -C w tag v-light; G -C w tag -a v-ann -m ann HEAD~1
G clone -q --bare w gh.git
# ---- the standby: logs each push (push option + refs); an update hook can refuse a ref
git init -q --bare gl.git
git -C gl.git config receive.advertisePushOptions true
printf '%s\n' '#!/bin/sh' 'echo "PUSH opts=${GIT_PUSH_OPTION_0:-none}" >> ../gl.log' \
  'while read -r old new ref; do echo "  $ref" >> ../gl.log; done' > gl.git/hooks/post-receive
printf '%s\n' '#!/bin/sh' 'if [ -f ../refuse ] && grep -qxF "$1" ../refuse; then echo "protected: $1" >&2; exit 1; fi' \
  > gl.git/hooks/update
chmod +x gl.git/hooks/post-receive gl.git/hooks/update

# ================================================================ first daily run: everything
run full schedule
check "full: exits 0" test $rc -eq 0
check "full: says OK" grep -q '^OK: ' <<< "$out"
check "full: trunk equal" test "$(gl refs/heads/mvp-launch)" = "$(gh refs/heads/mvp-launch)"
check "full: every feature branch equal" test "$(gl refs/heads/feat/a)$(gl refs/heads/feat/b)" = "$(gh refs/heads/feat/a)$(gh refs/heads/feat/b)"
check "full: annotated tag object equal" test "$(gl refs/tags/v-ann)" = "$(gh refs/tags/v-ann)"
check "full: light tag equal" test "$(gl refs/tags/v-light)" = "$(gh refs/tags/v-light)"
check "full: main arrives as archive/main" test "$(gl refs/heads/archive/main)" = "$(gh refs/heads/main)"
check "full: no main on the standby" test "$(gl refs/heads/main)" = none
check "full: the trunk goes first, alone" test "$(sed -n 2p gl.log)|$(sed -n 3p gl.log | cut -c1-4)" = "  refs/heads/mvp-launch|PUSH"
check "full: every push carried ci.skip" test "$(grep -c '^PUSH' gl.log)" = "$(grep -c '^PUSH opts=ci.skip' gl.log)"
check "full: a clean first run warns about nothing" bash -c '! grep -q "^::" <<< "$0"' "$out"
check "full: the private key never reaches the log" bash -c '! grep -q dummy-private-key <<< "$0"' "$out"
check "full: the private key file is gone afterwards" test -z "$(grep -rl dummy-private-key "$SB/tmp" 2>/dev/null)"
check "full: every push went through the fake ssh, which refused nothing" \
  bash -c 'grep -q "^OK receive-pack" ssh.log && grep -q "^OK upload-pack" ssh.log && ! grep -q "^REFUSED" ssh.log'
n=$(pushes)
run again schedule
check "full re-run: exits 0 and plans nothing" bash -c '[[ $0 -eq 0 ]] && grep -q "to push: 0" <<< "$1"' "$rc" "$out"
check "full re-run: pushed nothing" test "$(pushes)" = "$n"

# ================================================================ push events
G -C w checkout -q -b feat/new mvp-launch; G -C w commit -q --allow-empty -m new; G -C w checkout -q mvp-launch
G -C w push -q "$SB/gh.git" feat/new
run new-branch push refs/heads/feat/new
check "event: a new branch arrives" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(gl refs/heads/feat/new)" "$(gh refs/heads/feat/new)"
check "event: a new branch sends only itself" test "$(tail -n 2 gl.log | tr -d '\n')" = "PUSH opts=ci.skip  refs/heads/feat/new"

G -C w tag -a v-event -m event feat/new; G -C w push -q "$SB/gh.git" v-event
run new-tag push refs/tags/v-event
check "event: a new annotated tag arrives as the same object" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(gl refs/tags/v-event)" "$(gh refs/tags/v-event)"

G -C w commit -q --allow-empty -m trunk3; G -C w push -q "$SB/gh.git" mvp-launch
run ff-trunk push refs/heads/mvp-launch
check "event: a fast-forward trunk moves the standby" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(gl refs/heads/mvp-launch)" "$(gh refs/heads/mvp-launch)"
run ff-trunk-again push refs/heads/mvp-launch
check "event: the same trunk push again (a re-run) is green" bash -c '[[ $0 -eq 0 ]] && ! grep -q "^::error::" <<< "$1"' "$rc" "$out"

G -C w push -q "$SB/gh.git" main
run main push refs/heads/main
check "event: main goes to archive/main" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(gl refs/heads/archive/main)" "$(gh refs/heads/main)"

# ---- a deleted branch: nothing is deleted on the standby, on the event or on the next full run
kept=$(gl refs/heads/feat/b)
git -C gh.git update-ref -d refs/heads/feat/b
n=$(pushes)
run deleted push refs/heads/feat/b true
check "deleted: exits 0" test $rc -eq 0
check "deleted: says the standby keeps it" grep -q '^::notice::GitHub has no refs/heads/feat/b' <<< "$out"
check "deleted: pushed nothing" test "$(pushes)" = "$n"
check "deleted: the standby still has it" test "$(gl refs/heads/feat/b)" = "$kept"
run deleted-flag-wins push refs/heads/feat/a true
check "deleted flag: pushes nothing even while GitHub has the ref again" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(pushes)" "$n"
run deleted-late push refs/heads/feat/b false
check "deleted before the checkout: exits 0, nothing pushed" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(pushes)" "$n"
run full-after-delete schedule
check "deleted: a full run does not delete it either" bash -c '[[ $0 -eq 0 ]] && test "$1" = "$2"' "$rc" "$(gl refs/heads/feat/b)" "$kept"
run deleted-trunk push refs/heads/mvp-launch true
check "deleted trunk: exits 1, and the standby keeps it" bash -c '[[ $0 -eq 1 ]] && grep -q "^::error::GitHub has no refs/heads/mvp-launch" <<< "$1" && test "$2" != none' "$rc" "$out" "$(gl refs/heads/mvp-launch)"

# ---- a force-pushed feature branch: a warning, and the standby keeps its version
old=$(gl refs/heads/feat/a)
G -C w checkout -q feat/a; G -C w reset -q --hard mvp-launch; G -C w commit -q --allow-empty -m rewritten; G -C w checkout -q mvp-launch
G -C w push -q -f "$SB/gh.git" feat/a
run forced push refs/heads/feat/a
check "forced feature: exits 0" test $rc -eq 0
check "forced feature: warns, naming the ref" grep -q '^::warning::refs/heads/feat/a: diverged' <<< "$out"
check "forced feature: the standby keeps its version" test "$(gl refs/heads/feat/a)" = "$old"
run full-forced schedule
check "forced feature: a full run warns and stays green" bash -c '[[ $0 -eq 0 ]] && grep -q "^::warning::refs/heads/feat/a: diverged" <<< "$1"' "$rc" "$out"
check "forced feature: a full run keeps the standby's version" test "$(gl refs/heads/feat/a)" = "$old"

G -C w tag -f -a v-ann -m moved HEAD 2>/dev/null; G -C w push -q -f "$SB/gh.git" v-ann
old_tag=$(gl refs/tags/v-ann)
run moved-tag push refs/tags/v-ann
check "moved tag: warns, exits 0, the standby keeps its tag" bash -c '[[ $0 -eq 0 ]] && grep -q "^::warning::refs/tags/v-ann" <<< "$1" && test "$2" = "$3"' "$rc" "$out" "$(gl refs/tags/v-ann)" "$old_tag"

# ---- a trunk that is not a fast-forward: red, and the standby's trunk stays
gl_trunk=$(gl refs/heads/mvp-launch)
G -C w checkout -q -b rewrite mvp-launch~1; G -C w commit -q --allow-empty -m rewritten-trunk
G -C w push -q -f "$SB/gh.git" rewrite:mvp-launch; G -C w checkout -q mvp-launch
run nff-trunk push refs/heads/mvp-launch
check "non-fast-forward trunk: exits 1" test $rc -eq 1
check "non-fast-forward trunk: an error names it" grep -q '^::error::the standby did not take mvp-launch: diverged' <<< "$out"
check "non-fast-forward trunk: the standby's trunk stays" test "$(gl refs/heads/mvp-launch)" = "$gl_trunk"
G -C w checkout -q -b feat/c mvp-launch; G -C w commit -q --allow-empty -m c; G -C w checkout -q mvp-launch
G -C w push -q "$SB/gh.git" feat/c
run nff-trunk-full schedule
check "non-fast-forward trunk, full run: exits 1" test $rc -eq 1
check "non-fast-forward trunk, full run: the other refs still arrive" test "$(gl refs/heads/feat/c)" = "$(gh refs/heads/feat/c)"
check "non-fast-forward trunk, full run: the standby's trunk stays" test "$(gl refs/heads/mvp-launch)" = "$gl_trunk"
G -C w push -q -f "$SB/gh.git" "$gl_trunk":refs/heads/mvp-launch   # GitHub's trunk put back

# ---- the standby's own rules refuse a ref
G -C w commit -q --allow-empty -m trunk4; G -C w push -q "$SB/gh.git" mvp-launch
G -C w checkout -q feat/c; G -C w commit -q --allow-empty -m c2; G -C w checkout -q mvp-launch; G -C w push -q "$SB/gh.git" feat/c
printf '%s\n' refs/heads/feat/c refs/heads/mvp-launch > refuse
run refused-feature push refs/heads/feat/c
check "refused feature: warns and exits 0" bash -c '[[ $0 -eq 0 ]] && grep -q "^::warning::refs/heads/feat/c: refused" <<< "$1"' "$rc" "$out"
run refused-trunk push refs/heads/mvp-launch
check "refused trunk: exits 1 with an error" bash -c '[[ $0 -eq 1 ]] && grep -q "^::error::the standby did not take mvp-launch: refused" <<< "$1"' "$rc" "$out"
rm -f refuse

# ---- the key is missing: red for the trunk and the daily run, a warning elsewhere, nothing pushed
n=$(pushes)
KEY='' run no-key-feature push refs/heads/feat/c
check "no key, feature push: a warning, exits 0" bash -c '[[ $0 -eq 0 ]] && grep -q "^::warning::the GitHub secret GITLAB_MIRROR_SSH_KEY is not set" <<< "$1"' "$rc" "$out"
KEY='' run no-key-trunk push refs/heads/mvp-launch
check "no key, trunk push: an error, exits 1" bash -c '[[ $0 -eq 1 ]] && grep -q "^::error::the GitHub secret GITLAB_MIRROR_SSH_KEY is not set" <<< "$1"' "$rc" "$out"
KEY='' run no-key-daily schedule
check "no key, daily run: exits 1" test $rc -eq 1
KEY='' run no-key-tag push refs/tags/v-event
check "no key, tag push: exits 0" test $rc -eq 0
check "no key: nothing was pushed" test "$(pushes)" = "$n"

# ---- the pinned host key and its fingerprint disagree: no connection at all
FP='SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' run bad-fp push refs/heads/feat/c
check "fingerprint mismatch: exits 1 before any push" bash -c '[[ $0 -eq 1 ]] && grep -q "pinned host key.s fingerprint" <<< "$1" && test "$2" = "$3"' "$rc" "$out" "$(pushes)" "$n"
HK='gitlab.com ssh-ed25519 not-a-key' run no-fp push refs/heads/feat/c
check "a host key with no readable fingerprint: exits 1 before any push" bash -c '[[ $0 -eq 1 ]] && test "$1" = "$2"' "$rc" "$(pushes)" "$n"

# ---- the standby cannot be reached
STANDBY_REPO="$SB/gone.git" run unreach-feature push refs/heads/feat/c
check "unreachable, feature push: a warning, exits 0" bash -c '[[ $0 -eq 0 ]] && grep -q "^::warning::refs/heads/feat/c: failed" <<< "$1"' "$rc" "$out"
STANDBY_REPO="$SB/gone.git" run unreach-trunk push refs/heads/mvp-launch
check "unreachable, trunk push: exits 1" test $rc -eq 1
STANDBY_REPO="$SB/gone.git" run unreach-daily schedule
check "unreachable, daily run: exits 1" bash -c '[[ $0 -eq 1 ]] && grep -q "could not read the standby" <<< "$1"' "$rc" "$out"

# ---- inputs it refuses
run pull-ref push refs/pull/1/head
check "a ref that is not a branch or tag: exits 2" test $rc -eq 2
run odd-event pull_request refs/heads/feat/c
check "an unknown event: exits 2" test $rc -eq 2

# ================================================================ the ping step, as the workflow has it
PING_BODY=$(awk '/- name: Ping the gitlab-standby check/ { f = 1 } f && /run: \|/ { r = 1; next }
  r && $0 != "" && substr($0, 1, 10) != "          " { exit } r { print substr($0, 11) }' "$WF")
check "ping: the step's script was found" grep -q 'curl' <<< "$PING_BODY"
mkdir -p fakecurl
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" > "$FAKE_CURL_DIR/curl.argv"; cat > "$FAKE_CURL_DIR/curl.config"' > fakecurl/curl
chmod +x fakecurl/curl
ping_run() { # ping_run <needs.mirror.result> [url]: sets out, rc; the fake curl leaves curl.config
  rm -f curl.argv curl.config
  out=$(PATH="$SB/fakecurl:$PATH" FAKE_CURL_DIR="$SB" HC_PING_URL=${2-https://hc-ping.invalid/check-id} \
        MIRROR_RESULT=$1 bash -e -c "$PING_BODY" 2>&1); rc=$?
}
ping_run success
check "ping: a passed run pings the check" test "$(cat curl.config 2>/dev/null)" = 'url = "https://hc-ping.invalid/check-id"'
check "ping: the URL never reaches curl's command line" bash -c '[[ -s $0 ]] && ! grep -q hc-ping "$0"' curl.argv
for result in failure cancelled skipped ''; do
  ping_run "$result"
  check "ping: a run that is '$result' pings /fail" test "$(cat curl.config 2>/dev/null)" = 'url = "https://hc-ping.invalid/check-id/fail"'
done
ping_run success ''
check "ping: no secret is a warning, exit 0, nothing sent" bash -c '[[ $0 -eq 0 && ! -e curl.config ]] && grep -q "^::warning::" <<< "$1"' "$rc" "$out"
ping_run success 'https://hc-ping.invalid/a"b'
check "ping: a URL that is not plain https is refused" bash -c '[[ $0 -eq 1 && ! -e curl.config ]]' "$rc"

# ---------------------------------------------------------------- static: nothing that can rewrite or delete
code=$(grep -v '^[[:space:]]*#' "$MIR")
check "static: no --force, --mirror, --prune, --delete or --all" bash -c '! grep -nE -- "--(force|mirror|prune|delete|all)\b" <<< "$0"' "$code"
check "static: no forced (+) refspec" bash -c '! grep -nE "[\"'"'"' ]\+refs/" <<< "$0"' "$code"
check "static: host keys are checked, never scanned" bash -c 'grep -q "StrictHostKeyChecking=yes" <<< "$0" && ! grep -qiE "ssh-keyscan|StrictHostKeyChecking=(no|accept-new)" <<< "$0"' "$code"

finish mirror
