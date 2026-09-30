#!/usr/bin/env bash
# consolidate-refs.sh: build ONE clean ref set (the "vault", a new bare repo) from every local
# clone, older vault and bundle: branches, tags, remote-tracking refs, every stash entry and
# detached worktree HEAD. Reads sources only, writes only inside $VAULT, never pushes. Ref writes
# are create-only; the last step proves every staged commit is reachable from refs/heads +
# refs/tags, and a commit that could not be staged fails the run. Env (absolute paths): VAULT,
# CLONE_A, CLONE_B, EXTRA_CLONES="name=path;...", BUNDLE_DIRS="dir;...". Runbook: docs/GIT_HOSTING.md.
set -euo pipefail
shopt -s nullglob

A="${CLONE_A:-/c/Users/jimbo/OneDrive/Desktop/tegriddy farms}"   # clone A (shared checkout)
B="${CLONE_B:-/c/Users/jimbo/dev/tegridy-farms}"                 # clone B (dev clone)
if [[ -n ${EXTRA_CLONES+x} ]]; then
  IFS=';' read -r -a EXTRA <<< "$EXTRA_CLONES"
else
  EXTRA=( "tgtg=/c/Users/jimbo/OneDrive/Desktop/tgtg"
          "kimi=/c/Users/jimbo/Documents/kimi/workspace/tegridy-farms"
          "memeticfun-repo=/c/Users/jimbo/OneDrive/Desktop/memetic.fun/repo"
          "vault=/c/Users/jimbo/git-vault/tegridy-farms.git" )   # the 2026-09-29 vault
fi
C="${VAULT:-/c/Users/jimbo/git-vault/tegridy-farms.git}"   # the vault, OFF OneDrive
if [[ -n ${BUNDLE_DIRS+x} ]]; then
  IFS=';' read -r -a DIRS <<< "$BUNDLE_DIRS"
  BUNDLES=()
  for d in "${DIRS[@]}"; do if [[ -n $d ]]; then BUNDLES+=("$d"/*.bundle); fi; done
else
  BUNDLES=(/c/Users/jimbo/*.bundle /c/Users/jimbo/solana-launch-release-2026-09-26/*.bundle
           /c/Users/jimbo/solana-launch-release-2026-09-26/website-release-1/*.bundle)
fi

[[ -e $C ]] && { echo "STOP: $C already exists; move it aside first (never reuse a vault)"; exit 1; }
git init --bare -q "$C"
cd "$C"
git config gc.auto 0
git config core.logAllRefUpdates always

# ---------------------------------------------------------------- stage every source
# origin/* (the host's branch set as last seen) is walked into branch names below. Every other
# remote (after set-remotes.sh, `github`, the frozen record) is kept via refs/stage/*/remotes/.
git fetch -q --no-tags --no-write-fetch-head "$A" \
  '+refs/heads/*:refs/stage/a/heads/*' \
  '+refs/tags/*:refs/stage/a/tags/*' \
  '+refs/remotes/origin/*:refs/stage/a/github/*' '^refs/remotes/origin/HEAD' \
  '+refs/remotes/*:refs/stage/a/remotes/*' '^refs/remotes/*/HEAD' \
  '+refs/remotes/pr/*:refs/stage/a/github-pr/*' \
  '+refs/prs/*:refs/stage/a/prs/*' \
  '+refs/tmp/*:refs/stage/a/tmp/*' \
  '+refs/devclone/*:refs/stage/a/devclone/*'
echo "staged A: $(git for-each-ref refs/stage/a | wc -l) refs"

git fetch -q --no-tags --no-write-fetch-head "$B" \
  '+refs/heads/*:refs/stage/b/heads/*' \
  '+refs/tags/*:refs/stage/b/tags/*' \
  '+refs/remotes/origin/*:refs/stage/b/github/*' '^refs/remotes/origin/HEAD' \
  '+refs/remotes/*:refs/stage/b/remotes/*' '^refs/remotes/*/HEAD'
echo "staged B: $(git for-each-ref refs/stage/b | wc -l) refs"

# Every stash entry (only stash@{0} is a ref; the rest live in its reflog, which no fetch copies)
# and every detached worktree HEAD is fetched by id. A miss is counted and fails the run at the end.
unstaged=0
stage_id() { # repo id dest-ref
  git fetch -q --no-tags --no-write-fetch-head \
    --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' "$1" "$2:$3" \
    || { echo "WARN: could not stage $2 from $1 (as $3)"; unstaged=$((unstaged + 1)); }
}
for R in "$A" "$B"; do
  src=$([[ $R == "$A" ]] && echo a || echo b)
  git -C "$R" rev-parse -q --verify refs/stash >/dev/null || continue
  n=0
  while read -r h; do stage_id "$R" "$h" "refs/stage/$src/stash-${h:0:12}"; n=$((n + 1)); done \
    < <(git -C "$R" reflog show --format=%H refs/stash)
  echo "staged $src stash entries: $n"
done
for R in "$A" "$B"; do
  src=$([[ $R == "$A" ]] && echo a || echo b)
  while IFS=$'\t' read -r h w; do
    stage_id "$R" "$h" "refs/stage/$src/worktree-head/$(basename "$w")-${h:0:8}"
  done < <(git -C "$R" worktree list --porcelain \
           | awk '/^worktree /{w=substr($0,10)} /^HEAD /{h=$2} /^detached/{print h"\t"w}')
done

C_REAL=$(pwd -P)
for e in "${EXTRA[@]}"; do
  name=${e%%=*}; path=${e#*=}
  [[ -d $path ]] || { echo "WARN: $path missing, skipped"; continue; }
  if [[ $(cd "$path" && pwd -P) == "$C_REAL" ]]; then echo "skipped $name: it is the vault being built"; continue; fi
  git fetch -q --no-tags --no-write-fetch-head "$path" \
    "+refs/heads/*:refs/stage/x-$name/heads/*" "+refs/tags/*:refs/stage/x-$name/tags/*"
  echo "staged $name: $(git for-each-ref "refs/stage/x-$name" | wc -l) refs"
done

for f in "${BUNDLES[@]}"; do
  stem=$(basename "$f" .bundle)
  git bundle verify -q "$f" >/dev/null 2>&1 || { echo "STOP: bundle $f does not verify"; exit 1; }
  git fetch -q --no-tags --no-write-fetch-head "$f" "+refs/*:refs/stage/bundle/$stem/*"
done
echo "staged ${#BUNDLES[@]} bundles"

# ---------------------------------------------------------------- map to final names
FMT='%(objectname) %(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end) %(refname)'
declare -A OBJ PEEL
: > plan.log; : > updates.txt

emit() { OBJ[$1]=$2; PEEL[$1]=$3; printf 'create %s %s\n' "$1" "$2" >> updates.txt; echo "NEW    $1  <=  $4" >> plan.log; }

claim() { # claim FINAL OBJ COMMIT SOURCE ALTNS
  local want=$1 obj=$2 c=$3 src=$4 alt=$5 ns
  if [[ -z ${OBJ[$want]+x} ]]; then emit "$want" "$obj" "$c" "$src"; return; fi
  if [[ ${PEEL[$want]} == "$c" ]]; then echo "SAME   $want  ==  $src" >> plan.log; return; fi
  if [[ $want == refs/heads/* ]] && git merge-base --is-ancestor "$c" "${PEEL[$want]}"; then
    echo "STALE  $src  (ancestor of $want; nothing lost)" >> plan.log; return
  fi
  case $want in
    refs/heads/*) ns="refs/heads/$alt/${want#refs/heads/}" ;;
    refs/tags/*)  ns="refs/tags/$alt/${want#refs/tags/}" ;;
  esac
  echo "RENAME $src  ->  $ns  (name taken by a different commit)" >> plan.log
  claim "$ns" "$obj" "$c" "$src" "$alt"
}

walk() { local obj c ref; while read -r obj c ref; do claim "$2${ref#"$1"}" "$obj" "$c" "$ref" "$3"; done < <(git for-each-ref --format="$FMT" "$1"); }

archive_pr() {
  local obj c ref n base want k
  while read -r obj c ref; do
    [[ $ref =~ ([0-9]+)$ ]] || continue
    n=${BASH_REMATCH[1]}; base="refs/tags/archive/github-pr/$n"; want=$base; k=1
    while [[ -n ${OBJ[$want]+x} && ${PEEL[$want]} != "$c" ]]; do
      want="$base-$2"; [[ $k -gt 1 ]] && want="$base-$2-$k"; k=$((k+1))
    done
    if [[ -n ${OBJ[$want]+x} ]]; then echo "SAME   $want  ==  $ref" >> plan.log; continue; fi
    emit "$want" "$obj" "$c" "$ref"
  done < <(git for-each-ref --format="$FMT" "$1")
}

walk refs/stage/a/github/  refs/heads/ github-a       # (1) the host's branch set as last seen (origin)
walk refs/stage/b/github/  refs/heads/ github-b
walk refs/stage/a/heads/   refs/heads/ clone-a        # (2) clone A local branches
walk refs/stage/b/heads/   refs/heads/ devclone       # (3) clone B local branches
walk refs/stage/a/tags/    refs/tags/  clone-a        # (4) tags
walk refs/stage/b/tags/    refs/tags/  devclone
archive_pr refs/stage/a/github-pr/ gh                 # (5) GitHub PR heads -> tags
archive_pr refs/stage/a/prs/       prs
archive_pr refs/stage/a/tmp/       tmp
archive_pr refs/stage/bundle/tf-branch-pass-2026-09-17/remotes/pr/ bp
archive_pr refs/stage/bundle/tf-branch-pass-2026-09-17/prs/        bpprs

git update-ref --stdin < updates.txt

# (6) anything staged that is STILL unreachable -> refs/tags/archive/<source path>, one tag per
# object (the first source by name wins, so an older vault only adds what no live source has)
git rev-list --glob='refs/stage/*' --not --branches --tags | sort > unreached.txt
git for-each-ref --format="$FMT" refs/stage/ > staged.txt
awk 'NR==FNR{u[$1]=1; next} ($2 in u) && !seen[$1]++ {r=$3; sub(/^refs\/stage\//,"",r); print "create refs/tags/archive/" r " " $1}' \
    unreached.txt staged.txt > updates2.txt
cat updates2.txt >> plan.log
git update-ref --stdin < updates2.txt

# ---------------------------------------------------------------- prove nothing is lost
missing=$(git rev-list --count --glob='refs/stage/*' --not --branches --tags)
echo "staged commits NOT reachable from refs/heads+refs/tags: $missing   (must be 0)"
echo "final branches: $(git for-each-ref refs/heads | wc -l)   final tags: $(git for-each-ref refs/tags | wc -l)"
echo "renamed on collision: $(grep -c '^RENAME' plan.log || true)   stale skipped: $(grep -c '^STALE' plan.log || true)"
echo "commits that could not be staged: $unstaged   (must be 0)"
[[ $missing == 0 ]] || { echo "STOP: something would be lost"; exit 1; }
((unstaged == 0)) || { echo "STOP: $unstaged commit(s) could not be staged (WARN lines above); this vault is incomplete"; exit 1; }
echo "OK vault=$C"
