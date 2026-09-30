#!/usr/bin/env bash
# consolidate-refs.sh on throwaway clones, then push-all.sh from the vault. Usage: bash test-consolidate.sh
source "$(dirname "$0")/lib.sh"
sandbox t-consolidate
reachable() { test -n "$(git -C "$1" for-each-ref --contains "$2" refs/heads refs/tags | head -1)"; }
build() { # vault clone-a clone-b extra-clones: run consolidate-refs.sh, output in $out, exit in $rc
  out=$(VAULT="$SB/$1" CLONE_A="$SB/$2" CLONE_B="$SB/$3" EXTRA_CLONES="$4" BUNDLE_DIRS="${5:-}" \
        bash "$SCRIPTS/consolidate-refs.sh" 2>&1); rc=$?
}

# "GitHub" as it was: trunk, a diverged main, two feature branches, a tag
G init -q -b mvp-launch seed
for i in 1 2 3; do G -C seed commit -q --allow-empty -m "trunk $i"; done
G -C seed branch main HEAD~2; G -C seed checkout -q main; G -C seed commit -q --allow-empty -m main-only
G -C seed checkout -q -b feat/a mvp-launch~1; G -C seed commit -q --allow-empty -m a
G -C seed checkout -q -b feat/b mvp-launch; G -C seed commit -q --allow-empty -m b
G -C seed checkout -q mvp-launch; G -C seed tag t1 HEAD~1
G clone -q --bare seed gh.git

# clone A: stale local trunk, feat/a diverged, feat/b ahead, a PR head, a detached worktree
# commit, and three stash entries (only stash@{0} is a ref; the other two live in its reflog)
G clone -q gh.git A
G -C A reset -q --hard HEAD~1
G -C A checkout -q -b feat/a origin/feat/a~1; G -C A commit -q --allow-empty -m a-local
G -C A checkout -q -b feat/b origin/feat/b; G -C A commit -q --allow-empty -m b-ahead
G -C A checkout -q mvp-launch
G -C A commit-tree -m pr-7 -p origin/mvp-launch "$(git -C A rev-parse 'HEAD^{tree}')" > pr7.sha
G -C A update-ref refs/remotes/pr/7 "$(cat pr7.sha)"
G -C A worktree add -q --detach "$SB/A-wt" mvp-launch
G -C "$SB/A-wt" commit -q --allow-empty -m detached-only
for i in 1 2 3; do echo "wip $i" > A/wip.txt; G -C A add wip.txt; G -C A stash -q; done
mapfile -t STASHES < <(git -C A reflog show --format=%H refs/stash)

# clone B: one branch nobody else has, and a tag
G clone -q gh.git B; G -C B checkout -q -b dev/only-b; G -C B commit -q --allow-empty -m only-b; G -C B tag tb

# an extra clone and a bundle, each holding one commit found nowhere else
G clone -q gh.git X; G -C X checkout -q -b x/only; G -C X commit -q --allow-empty -m only-x
mkdir bundles; G clone -q gh.git Y; G -C Y checkout -q -b y/only; G -C Y commit -q --allow-empty -m only-y
G -C Y bundle create -q "$SB/bundles/y.bundle" --all 2>/dev/null
UNIQUE=( "$(git -C A-wt rev-parse HEAD)" "$(cat pr7.sha)" "$(git -C A rev-parse feat/a)" "$(git -C A rev-parse feat/b)"
         "$(git -C B rev-parse dev/only-b)" "$(git -C X rev-parse x/only)" "$(git -C Y rev-parse y/only)" )

build vault.git A B "x=$SB/X;missing=$SB/nope" "$SB/bundles"
check "vault build exits 0" test $rc -eq 0
check "vault proves 0 lost" grep -q "staged commits NOT reachable from refs/heads+refs/tags: 0" <<< "$out"
check "a missing extra clone is only a warning" grep -q "WARN: $SB/nope missing, skipped" <<< "$out"
check "the bundle dir was read" grep -q "staged 1 bundles" <<< "$out"
check "trunk is GitHub's, not A's stale copy" test "$(git -C vault.git rev-parse mvp-launch)" = "$(git -C gh.git rev-parse mvp-launch)"
check "A's diverged feat/a renamed, not overwritten" test "$(git -C vault.git rev-parse clone-a/feat/a)" = "$(git -C A rev-parse feat/a)" -a "$(git -C vault.git rev-parse feat/a)" = "$(git -C gh.git rev-parse feat/a)"
check "PR head archived as a tag" test "$(git -C vault.git rev-parse refs/tags/archive/github-pr/7)" = "$(cat pr7.sha)"
for c in "${UNIQUE[@]}"; do check "unique commit ${c:0:8} is reachable" reachable vault.git "$c"; done
check "clone A has 3 stash entries" test "${#STASHES[@]}" -eq 3
for s in "${STASHES[@]}"; do check "stash entry ${s:0:8} is reachable" reachable vault.git "$s"; done

out2=$(VAULT="$SB/vault.git" CLONE_A="$SB/A" CLONE_B="$SB/B" EXTRA_CLONES="" BUNDLE_DIRS="" bash "$SCRIPTS/consolidate-refs.sh" 2>&1); rc=$?
check "never reuses a vault" bash -c '[[ $0 -ne 0 ]] && grep -q "already exists" <<< "$1"' "$rc" "$out2"

git init -q --bare host.git
out=$(bash "$SCRIPTS/push-all.sh" "$SB/vault.git" "$SB/host.git" 2>&1); rc=$?
check "vault -> host push verifies" test $rc -eq 0
check "host main is archived" test -z "$(git ls-remote "$SB/host.git" refs/heads/main)" -a -n "$(git ls-remote "$SB/host.git" refs/heads/archive/main)"

# ---- clone A with no stash at all (after `git stash clear`, or a fresh clone)
G clone -q gh.git A0
build v-nostash.git A0 B ""
check "no stash: the build still exits 0 and says OK" bash -c '[[ $0 -eq 0 ]] && grep -q "^OK vault=" <<< "$1"' "$rc" "$out"

# ---- after set-remotes.sh: origin is the new host, GitHub's refs are the frozen github/* record
# (A1 and A2 each hold one stash, so these cases never stop on the no-stash path above)
G clone -q gh.git A1; echo w > A1/w.txt; G -C A1 add w.txt; G -C A1 stash -q
git -C A1 remote set-url origin https://github.com/example/tegridy-farms.git
G init -q --bare newhost.git; G -C seed push -q "$SB/newhost.git" mvp-launch feat/b
git --git-dir=gh.git update-ref refs/heads/gh-only "$(G --git-dir=gh.git commit-tree -m gh-only -p mvp-launch 'mvp-launch^{tree}')"
G -C A1 fetch -q "$SB/gh.git" '+refs/heads/*:refs/remotes/origin/*'   # A1's last view of GitHub
GHONLY=$(git -C A1 rev-parse refs/remotes/origin/gh-only)
bash "$SCRIPTS/set-remotes.sh" "$SB/A1" "$SB/newhost.git" >/dev/null 2>&1
G -C A1 fetch -q origin
G clone -q --bare newhost.git B1.git
build v-frozen.git A1 B1.git ""
check "frozen record: the build exits 0" test $rc -eq 0
check "frozen record: a commit only in refs/remotes/github/* is kept" reachable v-frozen.git "$GHONLY"

# ---- a detached HEAD that cannot be staged fails the run instead of printing OK
G clone -q gh.git A2; echo w > A2/w.txt; G -C A2 add w.txt; G -C A2 stash -q
G -C A2 worktree add -q --detach "$SB/A2-wt" mvp-launch
G -C "$SB/A2-wt" commit -q --allow-empty -m will-vanish
gone=$(git -C A2-wt rev-parse HEAD)
rm -f "A2/.git/objects/${gone:0:2}/${gone:2}"
build v-broken.git A2 B ""
check "unstageable HEAD: exits non-zero" test $rc -ne 0
check "unstageable HEAD: says it could not stage" grep -q "WARN: could not stage $gone" <<< "$out"
check "unstageable HEAD: never ends OK" bash -c '! grep -q "^OK vault=" <<< "$0"' "$out"

# ---- an older vault as a source: keeps what the clones lost, adds nothing they still have
G -C B checkout -q mvp-launch; G -C B branch -q -D dev/only-b; G -C B tag -d tb >/dev/null
check "older vault: the fixture really deleted B's branch" bash -c '! git -C "$0" rev-parse -q --verify refs/heads/dev/only-b >/dev/null' "$SB/B"
build vault2.git A B "old=$SB/vault.git;self=$SB/vault2.git" "$SB/bundles"
check "older vault: the build exits 0" test $rc -eq 0
check "older vault: a branch deleted since is kept" reachable vault2.git "${UNIQUE[4]}"
check "older vault: the vault being built is skipped" grep -q "skipped self: it is the vault being built" <<< "$out"
# only dev/only-b (deleted from B) and x/only (X is no source this time) are the old vault's alone
check "older vault: no duplicate archive tag for what a live source has" \
  test "$(git -C vault2.git for-each-ref refs/tags/archive/x-old/ | wc -l)" -eq 2

finish consolidate
