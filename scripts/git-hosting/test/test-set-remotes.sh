#!/usr/bin/env bash
# set-remotes.sh on clone-shaped throwaway repos. No test touches the network. Usage: bash test-set-remotes.sh
source "$(dirname "$0")/lib.sh"
SR="$SCRIPTS/set-remotes.sh"
sandbox t-remotes
GL=https://gitlab.com/memetics/tegridy-farms.git
BB=https://bitbucket.org/memetics/tegridy-farms.git
GH=https://github.com/fomotsar-commits/tegridy-farms.git

# ---- a clone shaped like clone A: GitHub origin, tracking branches, a no-reply email
G init -q -b mvp-launch seed; G -C seed commit -q --allow-empty -m base
G -C seed branch feat/x; G -C seed branch fix/y
G clone -q --bare seed gh.git
G clone -q gh.git clone
G -C clone checkout -q -b feat/x origin/feat/x; G -C clone checkout -q mvp-launch
G -C clone remote set-url origin "$GH"
G -C clone config user.email fomotsar-commits@users.noreply.github.com
before_refs=$(git -C clone for-each-ref --format='%(objectname)' refs/remotes/origin/ | sort)

out=$(bash "$SR" clone "$GL" "$BB" 2>&1); rc=$?
check "exits 0" test $rc -eq 0
check "origin was renamed to github" test "$(git -C clone config remote.github.url)" = "$GH"
check "refs/remotes/github/* kept as the record" test "$(git -C clone for-each-ref --format='%(objectname)' refs/remotes/github/ | sort)" = "$before_refs"
check "no refs/remotes/origin/* left over" test -z "$(git -C clone for-each-ref refs/remotes/origin/)"
check "origin fetches from GitLab" test "$(git -C clone config remote.origin.url)" = "$GL"
check "origin pushes to GitLab then Bitbucket" test "$(git -C clone config --get-all remote.origin.pushurl | tr '\n' ' ')" = "$GL $BB "
check "origin keeps a normal fetch refspec" test "$(git -C clone config remote.origin.fetch)" = "+refs/heads/*:refs/remotes/origin/*"
check "github push is disabled" bash -c 'git -C "$0" config remote.github.pushurl | grep -q "^no-push://"' clone
check "github skipped by fetch --all" test "$(git -C clone config remote.github.skipFetchAll)" = true
check "tracking branches point at origin" test "$(git -C clone config branch.feat/x.remote)$(git -C clone config branch.mvp-launch.remote)" = originorigin
check "no-reply email warned about" grep -q "WARNING: commits here are authored as fomotsar-commits@users.noreply.github.com" <<< "$out"
check "email not changed silently" test "$(git -C clone config user.email)" = fomotsar-commits@users.noreply.github.com
check "a push to github fails" bash -c '! git -C "$0" push -q github mvp-launch 2>/dev/null' clone

snap=$(git -C clone config --local --list)
out=$(bash "$SR" clone "$GL" "$BB" 2>&1); rc=$?
check "re-run exits 0" test $rc -eq 0
check "re-run changes nothing" test "$(git -C clone config --local --list)" = "$snap"

out=$(bash "$SR" clone "$GL" "$BB" --fix-email owner@example.com 2>&1); rc=$?
check "--fix-email sets the address" test "$(git -C clone config --local user.email)" = owner@example.com

out=$(bash "$SR" clone "$GH" 2>&1); rc=$?
check "GitHub as primary: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "never the primary" <<< "$1"' "$rc" "$out"
out=$(bash "$SR" clone "$GL" git@github.com:fomotsar-commits/tegridy-farms.git 2>&1); rc=$?
check "GitHub as standby (ssh form): refused" test $rc -ne 0
out=$(bash "$SR" clone "$GL" "$GL" 2>&1); rc=$?
check "same primary and standby: refused" test $rc -ne 0
check "refusals left config alone" test "$(git -C clone config --get-all remote.origin.pushurl | tr '\n' ' ')" = "$GL $BB "

# ---- drill: GitLab gone, Bitbucket becomes primary with no standby
out=$(bash "$SR" clone "$BB" 2>&1); rc=$?
check "failover exits 0" test $rc -eq 0
check "failover: origin fetches from Bitbucket" test "$(git -C clone config remote.origin.url)" = "$BB"
check "failover: origin pushes only to Bitbucket" test "$(git -C clone config --get-all remote.origin.pushurl)" = "$BB"
check "failover: github record untouched" test "$(git -C clone config remote.github.url)" = "$GH"

# ---- a GitHub origin next to an existing remote named github: stop, change nothing
G clone -q gh.git both; G -C both remote set-url origin "$GH"
G -C both remote add github https://github.com/someone-else/fork.git
snap=$(git -C both config --local --list)
out=$(bash "$SR" both "$GL" "$BB" 2>&1); rc=$?
check "existing github remote: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "a remote named .github. already exists" <<< "$1"' "$rc" "$out"
check "existing github remote: config untouched" test "$(git -C both config --local --list)" = "$snap"

# ---- one push lands on both hosts (local bare repos stand in for GitLab and Bitbucket)
G init -q --bare primary.git; G init -q --bare standby.git
G clone -q gh.git c2; G -C c2 remote set-url origin "$GH"
bash "$SR" c2 "$SB/primary.git" "$SB/standby.git" >/dev/null 2>&1
G -C c2 push -q origin mvp-launch 2>/dev/null
check "one push reaches the primary" git -C primary.git rev-parse -q --verify refs/heads/mvp-launch
check "one push reaches the standby" git -C standby.git rev-parse -q --verify refs/heads/mvp-launch
G -C c2 fetch -q origin
check "fetch reads the primary" git -C c2 rev-parse -q --verify refs/remotes/origin/mvp-launch

# ---- a clone that never had a GitHub origin
G init -q fresh; G -C fresh commit -q --allow-empty -m x
bash "$SR" fresh "$GL" >/dev/null 2>&1
check "no origin: adds one" test "$(git -C fresh config remote.origin.url)" = "$GL"
check "no origin: no github remote invented" test -z "$(git -C fresh config remote.github.url)"

finish set-remotes
