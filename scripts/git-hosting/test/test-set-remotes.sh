#!/usr/bin/env bash
# set-remotes.sh on clone-shaped throwaway repos. url.<path>.insteadOf sends the real-looking host
# URLs to local bare repos, so pushes and fetches are real and nothing touches the network.
source "$(dirname "$0")/lib.sh"
SR="$SCRIPTS/set-remotes.sh"
sandbox t-remotes
GH=https://github.com/fomotsar-commits/tegridy-farms.git
GL=https://gitlab.com/memetics/tegridy-farms.git
BB=https://bitbucket.org/memetics/tegridy-farms.git
cfg() { git -C "$1" config --get "$2" || true; }
pushurls() { git -C "$1" config --get-all remote.origin.pushurl | tr '\n' ' '; }
redirect() { # clone: GH -> gh.git, GL -> gl.git, BB -> bb.git
  git -C "$1" config "url.$SB/gh.git.insteadOf" "$GH"
  git -C "$1" config "url.$SB/gl.git.insteadOf" "$GL"
  git -C "$1" config "url.$SB/bb.git.insteadOf" "$BB"
}

# ---- hosts, and a clone shaped like clone A: GitHub origin, tracking branches, a no-reply email
G init -q -b mvp-launch seed; G -C seed commit -q --allow-empty -m base
G -C seed branch feat/x; G -C seed branch fix/y
G clone -q --bare seed gh.git; G clone -q --bare seed gl.git; G init -q --bare bb.git
G clone -q gh.git clone
G -C clone checkout -q -b feat/x origin/feat/x; G -C clone checkout -q mvp-launch
G -C clone remote set-url origin "$GH"; redirect clone
G -C clone config user.email fomotsar-commits@users.noreply.github.com
origin_refs=$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/origin/ | sort)

# ================================================================ day to day: GitHub primary, GitLab standby
out=$(bash "$SR" clone "$GH" "$GL" 2>&1); rc=$?
check "day: exits 0" test $rc -eq 0
check "day: origin still fetches from GitHub" test "$(cfg clone remote.origin.url)" = "$GH"
check "day: origin pushes to GitHub, then GitLab" test "$(pushurls clone)" = "$GH $GL "
check "day: origin keeps its tracking refs" test "$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/origin/ | sort)" = "$origin_refs"
check "day: a gitlab remote fetches the standby" test "$(cfg clone remote.gitlab.url)" = "$GL"
check "day: gitlab has the normal fetch refspec" test "$(cfg clone remote.gitlab.fetch)" = "+refs/heads/*:refs/remotes/gitlab/*"
check "day: gitlab is not frozen" test -z "$(cfg clone remote.gitlab.pushurl)$(cfg clone remote.gitlab.skipFetchAll)"
check "day: no github remote invented" test -z "$(cfg clone remote.github.url)"
check "day: branches still track origin" test "$(cfg clone branch.feat/x.remote)$(cfg clone branch.mvp-launch.remote)" = originorigin
check "day: no e-mail warning while GitHub is primary" bash -c '! grep -q WARNING <<< "$0"' "$out"

snap=$(git -C clone config --local --list)
out=$(bash "$SR" clone "$GH" "$GL" 2>&1); rc=$?
check "day: re-run exits 0" test $rc -eq 0
check "day: re-run changes nothing" test "$(git -C clone config --local --list)" = "$snap"

G -C clone checkout -q feat/x; G -C clone commit -q --allow-empty -m on-feat; G -C clone checkout -q mvp-launch
G -C clone push -q origin feat/x 2>/dev/null
tip=$(git -C clone rev-parse feat/x)
check "day: one push reaches GitHub" test "$(git -C gh.git rev-parse refs/heads/feat/x)" = "$tip"
check "day: the same push reaches GitLab" test "$(git -C gl.git rev-parse refs/heads/feat/x)" = "$tip"
G -C clone fetch -q gitlab
check "day: fetch gitlab reads the standby" test "$(git -C clone rev-parse refs/remotes/gitlab/feat/x)" = "$tip"

# ---- GitHub refuses a push (its secret scanning does): git still tries GitLab, and the hook stops it
check "day: the pre-push hook is installed" cmp -s "$SCRIPTS/pre-push-standby.sh" clone/.git/hooks/pre-push
printf '%s\n' '#!/bin/sh' 'while read -r o n r; do if [ -f ../gh-refuse ] && grep -qxF "$r" ../gh-refuse; then echo "push protection: $r" >&2; exit 1; fi; done' \
  > gh.git/hooks/pre-receive
chmod +x gh.git/hooks/pre-receive
glref() { git -C gl.git rev-parse -q --verify "$1" 2>/dev/null || echo none; }
G -C clone checkout -q -b feat/leak; G -C clone commit -q --allow-empty -m leak; G -C clone checkout -q mvp-launch
echo refs/heads/feat/leak > gh-refuse
out=$(G -C clone push origin feat/leak 2>&1); rc=$?
check "refused by GitHub: the push fails" test $rc -ne 0
check "refused by GitHub: GitLab never gets it" test "$(glref refs/heads/feat/leak)" = none
check "refused by GitHub: the hook says why" grep -q "pre-push: refs/heads/feat/leak not sent" <<< "$out"
rm gh-refuse
G -C clone push -q origin feat/leak 2>/dev/null
check "taken by GitHub: GitLab gets it too" test "$(glref refs/heads/feat/leak)" = "$(git -C clone rev-parse feat/leak)"
G -C clone tag -a v-hook -m v feat/leak; G -C clone push -q origin v-hook 2>/dev/null
check "an annotated tag reaches GitLab as the same object" test "$(glref refs/tags/v-hook)" = "$(git -C clone rev-parse v-hook)"
echo refs/heads/feat/leak > gh-refuse
G -C clone push -q origin --delete feat/leak 2>/dev/null
check "a delete GitHub refuses: GitLab keeps the branch" test "$(glref refs/heads/feat/leak)" != none
rm gh-refuse
G -C clone push -q origin --delete feat/leak 2>/dev/null
check "a delete GitHub takes: GitLab deletes it too" test "$(glref refs/heads/feat/leak)" = none
G init -q --bare gh-empty.git; G init -q --bare gl-empty.git; cp gh.git/hooks/pre-receive gh-empty.git/hooks/
G init -q -b mvp-launch first; G -C first commit -q --allow-empty -m first
bash "$SR" first "$SB/gh-empty.git" "$SB/gl-empty.git" >/dev/null 2>&1
echo refs/heads/mvp-launch > gh-refuse
G -C first push -q origin mvp-launch 2>/dev/null
check "a first host with no refs at all refuses: the standby still gets nothing" test -z "$(git -C gl-empty.git for-each-ref)"
rm gh-refuse
G -C first push -q origin mvp-launch 2>/dev/null
check "a first host with no refs at all takes it: so does the standby" test -n "$(git -C gl-empty.git for-each-ref)"

# ---- guards: each refusal leaves the config as it was
snap=$(git -C clone config --local --list)
out=$(bash "$SR" clone "$GH" "$GH" 2>&1); rc=$?
check "same primary and standby: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "the same URL" <<< "$1"' "$rc" "$out"
out=$(bash "$SR" clone "$GL" https://gitlab.com/memetics/tegridy-farms-vault.git 2>&1); rc=$?
check "primary and standby on one host: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "must outlive the primary" <<< "$1"' "$rc" "$out"
out=$(bash "$SR" clone git@github.com:fomotsar-commits/tegridy-farms.git "$GH" 2>&1); rc=$?
check "one host in ssh and https form: refused" test $rc -ne 0
out=$(bash "$SR" "$SB/not-a-repo" "$GH" "$GL" 2>&1); rc=$?
check "not a repository: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "not a git repository" <<< "$1"' "$rc" "$out"
check "refusals left config alone" test "$(git -C clone config --local --list)" = "$snap"

# ================================================================ failover drill: GitHub gone, GitLab primary
gitlab_refs=$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/gitlab/ | sort)
github_view=$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/origin/ | sort)
out=$(bash "$SR" clone "$GL" 2>&1); rc=$?
check "failover: exits 0" test $rc -eq 0
check "failover: origin fetches from GitLab" test "$(cfg clone remote.origin.url)" = "$GL"
check "failover: origin pushes only to GitLab" test "$(pushurls clone)" = "$GL "
check "failover: origin took over the gitlab refs" test "$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/origin/ | sort)" = "$gitlab_refs"
check "failover: no gitlab remote left over" test -z "$(cfg clone remote.gitlab.url)$(git -C clone for-each-ref refs/remotes/gitlab/)"
check "failover: GitHub kept as the github record" test "$(cfg clone remote.github.url)" = "$GH"
check "failover: refs/remotes/github/* is the last view of GitHub" test "$(git -C clone for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/github/ | sort)" = "$github_view"
check "failover: github push disabled" bash -c 'git -C "$0" config remote.github.pushurl | grep -q "^no-push://"' clone
check "failover: github skipped by fetch --all" test "$(cfg clone remote.github.skipFetchAll)" = true
check "failover: branches that tracked GitHub track origin" test "$(cfg clone branch.feat/x.remote)$(cfg clone branch.mvp-launch.remote)" = originorigin
check "failover: the no-reply e-mail is warned about" grep -q "WARNING: commits here are authored as fomotsar-commits@users.noreply.github.com" <<< "$out"
check "failover: e-mail not changed silently" test "$(cfg clone user.email)" = fomotsar-commits@users.noreply.github.com
check "failover: a push to github fails" bash -c '! git -C "$0" push -q github mvp-launch 2>/dev/null' clone
gh_before=$(git -C gh.git for-each-ref | sort)
G -C clone checkout -q feat/x; G -C clone commit -q --allow-empty -m after-failover; G -C clone checkout -q mvp-launch
G -C clone push -q origin feat/x 2>/dev/null
check "failover: a push reaches GitLab" test "$(git -C gl.git rev-parse refs/heads/feat/x)" = "$(git -C clone rev-parse feat/x)"
check "failover: a push leaves GitHub alone" test "$(git -C gh.git for-each-ref | sort)" = "$gh_before"
snap=$(git -C clone config --local --list)
out=$(bash "$SR" clone "$GL" 2>&1); rc=$?
check "failover: re-run changes nothing" test $rc -eq 0 -a "$(git -C clone config --local --list)" = "$snap"
out=$(bash "$SR" clone "$GL" "$BB" --fix-email owner@example.com 2>&1); rc=$?
check "failover: --fix-email sets the address" test "$(cfg clone user.email)" = owner@example.com
check "failover: a new standby joins the push list" test "$(pushurls clone)" = "$GL $BB "
check "failover: the new standby gets a bitbucket remote" test "$(cfg clone remote.bitbucket.url)" = "$BB"
check "failover: github stays frozen" test "$(cfg clone remote.github.skipFetchAll)" = true

# ================================================================ GitHub back as primary, GitLab standby again
G -C clone remote remove bitbucket
out=$(bash "$SR" clone "$GH" "$GL" 2>&1); rc=$?
check "back: exits 0" test $rc -eq 0
check "back: origin fetches from GitHub" test "$(cfg clone remote.origin.url)" = "$GH"
check "back: origin pushes to GitHub, then GitLab" test "$(pushurls clone)" = "$GH $GL "
check "back: origin is fetched by fetch --all again" test -z "$(cfg clone remote.origin.skipFetchAll)"
check "back: gitlab fetches the standby and may be pushed to" test "$(cfg clone remote.gitlab.url)|$(cfg clone remote.gitlab.pushurl)|$(cfg clone remote.gitlab.skipFetchAll)" = "$GL||"
check "back: no github remote left over" test -z "$(cfg clone remote.github.url)"
check "back: branches track origin" test "$(cfg clone branch.feat/x.remote)$(cfg clone branch.mvp-launch.remote)" = originorigin

# ---- a name that is taken: stop before any change
G clone -q gh.git both; G -C both remote set-url origin "$GH"
G -C both remote add github https://github.com/someone-else/fork.git
snap=$(git -C both config --local --list)
out=$(bash "$SR" both "$GL" 2>&1); rc=$?
check "taken name github: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "that name is taken" <<< "$1"' "$rc" "$out"
check "taken name github: config untouched" test "$(git -C both config --local --list)" = "$snap"
G clone -q gh.git other; G -C other remote set-url origin "$GH"
G -C other remote add gitlab https://example.com/some/other.git
snap=$(git -C other config --local --list)
out=$(bash "$SR" other "$GH" "$GL" 2>&1); rc=$?
check "gitlab remote on another host: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "another host than the standby" <<< "$1"' "$rc" "$out"
check "gitlab remote on another host: config untouched" test "$(git -C other config --local --list)" = "$snap"
G clone -q gh.git hooked; G -C hooked remote set-url origin "$GH"
printf '%s\n' '#!/bin/sh' 'exit 0' > hooked/.git/hooks/pre-push
snap=$(git -C hooked config --local --list)
out=$(bash "$SR" hooked "$GH" "$GL" 2>&1); rc=$?
check "a pre-push hook of its own: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "not the git-hosting hook" <<< "$1"' "$rc" "$out"
check "a pre-push hook of its own: config and hook untouched" \
  test "$(git -C hooked config --local --list)|$(cat hooked/.git/hooks/pre-push)" = "$snap|$(printf '%s\n' '#!/bin/sh' 'exit 0')"
G clone -q gh.git hookspath; G -C hookspath remote set-url origin "$GH"; G -C hookspath config core.hooksPath my-hooks
bash "$SR" hookspath "$GH" "$GL" >/dev/null 2>&1
check "core.hooksPath: the hook goes where git runs hooks" cmp -s "$SCRIPTS/pre-push-standby.sh" hookspath/my-hooks/pre-push

# ---- the GitLab group is renamed: the standby URL changes, nothing else does
G clone -q gh.git renamed; G -C renamed remote set-url origin "$GH"
OLD=https://gitlab.com/memetics-finance-group/tegridy-farms.git
bash "$SR" renamed "$GH" "$OLD" >/dev/null 2>&1
out=$(bash "$SR" renamed "$GH" "$GL" 2>&1); rc=$?
check "group rename: exits 0" test $rc -eq 0
check "group rename: gitlab fetches the new URL" test "$(cfg renamed remote.gitlab.url)" = "$GL"
check "group rename: origin pushes to the new URL" test "$(pushurls renamed)" = "$GH $GL "

# ---- a clone with no origin
G init -q fresh; G -C fresh commit -q --allow-empty -m x
bash "$SR" fresh "$GH" "$GL" >/dev/null 2>&1
check "no origin: adds one" test "$(cfg fresh remote.origin.url)" = "$GH"
check "no origin: adds the standby" test "$(cfg fresh remote.gitlab.url)" = "$GL"
check "no origin: no frozen record invented" test -z "$(git -C fresh config --get-regexp 'skipfetchall' || true)"

finish set-remotes
