#!/usr/bin/env bash
# push-all.sh <repo> <remote-url> [--gitlab] [--dry-run] [--trunk <branch>] [--local-only]
# Pushes every branch and tag of <repo> (the vault, or a bare mirror of a host) to one host, then
# proves the host holds exactly that set. Never forces, mirrors, prunes or deletes. main/master go
# up as archive/<name> (Vercel picks main as production on connect). The trunk goes first. A clone
# whose remote-tracking branches have no local branch is refused: those branches would be left out.
# --local-only pushes its local set anyway.
set -euo pipefail

usage() {
  echo "usage: push-all.sh <repo> <remote-url> [--gitlab] [--dry-run] [--trunk <branch>] [--local-only]" >&2
  exit 2
}
stop() { echo "STOP: $*" >&2; exit 1; }

REPO='' URL='' GITLAB=0 DRY=0 TRUNK=mvp-launch LOCAL_ONLY=0
while (($#)); do
  case $1 in
    --gitlab) GITLAB=1 ;;
    --dry-run) DRY=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    --trunk) [[ $# -ge 2 ]] || usage; TRUNK=$2; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) if [[ -z $REPO ]]; then REPO=$1; elif [[ -z $URL ]]; then URL=$1; else usage; fi ;;
  esac
  shift
done
[[ -n $REPO && -n $URL ]] || usage

g() { git -C "$REPO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || stop "$REPO is not a git repository"
# A remote NAME may carry two push URLs but ls-remote reads only one; check each host on its own.
if g remote | grep -qxF -- "$URL"; then stop "'$URL' is a remote name; pass the host URL itself"; fi

# ------------------------------------------------------------------ what the host should hold
declare -A WANT SRC REMOTE LOCAL
while read -r sha ref; do
  dst=$ref
  if [[ $ref == refs/heads/* ]]; then LOCAL[${ref#refs/heads/}]=1; fi
  case $ref in
    refs/heads/main|refs/heads/master)
      [[ ${ref#refs/heads/} == "$TRUNK" ]] || dst="refs/heads/archive/${ref#refs/heads/}" ;;
  esac
  if [[ -n ${WANT[$dst]+x} && ${WANT[$dst]} != "$sha" ]]; then
    stop "$REPO has both ${SRC[$dst]} and $ref for $dst at different commits; rename one first"
  fi
  WANT[$dst]=$sha; SRC[$dst]=$ref
done < <(g for-each-ref --format='%(objectname) %(refname)' refs/heads/ refs/tags/)

remote_only=0 example=''
while read -r ref; do
  r=${ref#refs/remotes/}; name=${r#*/}
  [[ $name == HEAD || -n ${LOCAL[$name]+x} ]] && continue
  remote_only=$((remote_only + 1)); example=${example:-$ref}
done < <(g for-each-ref --format='%(refname)' refs/remotes/)
if ((remote_only && !LOCAL_ONLY)); then
  stop "$REPO has $remote_only remote-tracking branch(es) with no local branch (first: $example)." \
    "Pushing it would leave them off the host. Seed from the vault or a mirror clone of a host" \
    "(docs/GIT_HOSTING.md), or pass --local-only to push the local set anyway."
fi

TRUNK_REF="refs/heads/$TRUNK"
[[ -n ${WANT[$TRUNK_REF]+x} ]] || stop "$REPO has no $TRUNK_REF"
LOCAL_TRUNK=${WANT[$TRUNK_REF]}

read_remote() {
  local out sha ref
  out=$(g ls-remote --heads --tags "$URL") || stop "could not read $URL (auth or network); nothing was pushed"
  REMOTE=()
  while read -r sha ref; do
    [[ -z $ref || $ref == *'^{}' ]] && continue   # peeled tag lines repeat the tag's commit
    REMOTE[$ref]=$sha
  done <<< "$out"
}
read_remote

# ------------------------------------------------------------------ refuse a stale trunk
behind_or_equal() { # label sha: sha must be LOCAL_TRUNK or one of its ancestors
  [[ $2 == "$LOCAL_TRUNK" ]] && return 0
  g cat-file -e "$2^{commit}" 2>/dev/null \
    || stop "$1 is $2, which $REPO does not have; cannot prove it is behind local $TRUNK"
  g merge-base --is-ancestor "$2" "$LOCAL_TRUNK" \
    || stop "$1 ($2) is not an ancestor of local $TRUNK ($LOCAL_TRUNK); this copy is missing trunk commits"
}
if [[ -n ${REMOTE[$TRUNK_REF]+x} ]]; then behind_or_equal "the host's $TRUNK" "${REMOTE[$TRUNK_REF]}"; fi
while read -r sha ref; do
  r=${ref#refs/remotes/}
  if [[ ${r#*/} == "$TRUNK" ]]; then behind_or_equal "$ref" "$sha"; fi
done < <(g for-each-ref --format='%(objectname) %(refname)' refs/remotes/)
for name in main master; do
  if [[ $name != "$TRUNK" && -n ${REMOTE[refs/heads/$name]+x} ]]; then
    echo "WARNING: the host already has refs/heads/$name. Vercel would pick it as production;"
    echo "         delete it on the host before connecting Vercel."
  fi
done

# ------------------------------------------------------------------ push only what differs
PLAN=()
add() { [[ ${REMOTE[$1]:-} == "${WANT[$1]}" ]] || PLAN+=("${SRC[$1]}:$1"); }
add "$TRUNK_REF"
while read -r dst; do [[ $dst == "$TRUNK_REF" ]] || add "$dst"; done \
  < <(printf '%s\n' "${!WANT[@]}" | grep '^refs/heads/' | LC_ALL=C sort)
while read -r dst; do add "$dst"; done \
  < <(printf '%s\n' "${!WANT[@]}" | grep '^refs/tags/' | LC_ALL=C sort)

echo "source: $REPO   host: $URL   trunk: $TRUNK = $LOCAL_TRUNK"
echo "local set: ${#WANT[@]} refs; already on the host: $(( ${#WANT[@]} - ${#PLAN[@]} )); to push: ${#PLAN[@]}"

OPTS=(--no-follow-tags --recurse-submodules=no)
if ((GITLAB)); then OPTS+=(-o ci.skip); fi
if ((DRY)); then OPTS+=(--dry-run); fi
failed=0
push_batch() {
  echo "push $# ref(s), first: $1"
  g push "${OPTS[@]}" "$URL" "$@" || { failed=1; echo "FAILED: the batch starting at $1" >&2; }
}
start=0
if ((${#PLAN[@]})) && [[ ${PLAN[0]} == *":$TRUNK_REF" ]]; then   # trunk alone, first
  push_batch "${PLAN[0]}"; start=1
fi
for ((i = start; i < ${#PLAN[@]}; i += 100)); do push_batch "${PLAN[@]:i:100}"; done

if ((DRY)); then
  if ((failed)); then stop "the dry run reported rejections (see above)"; fi
  echo "DRY RUN: nothing was pushed."
  exit 0
fi

# ------------------------------------------------------------------ prove host == local set
read_remote
diffs=0
for dst in "${!WANT[@]}"; do
  if [[ -z ${REMOTE[$dst]+x} ]]; then echo "MISSING  $dst (local ${WANT[$dst]})"; diffs=$((diffs + 1))
  elif [[ ${REMOTE[$dst]} != "${WANT[$dst]}" ]]; then
    echo "DIFFERS  $dst (host ${REMOTE[$dst]}, local ${WANT[$dst]})"; diffs=$((diffs + 1)); fi
done
for ref in "${!REMOTE[@]}"; do
  if [[ -z ${WANT[$ref]+x} ]]; then echo "EXTRA    $ref (only on the host, ${REMOTE[$ref]})"; diffs=$((diffs + 1)); fi
done
if ((diffs || failed)); then stop "the host does not match the local set ($diffs difference(s))"; fi
echo "OK: the host holds exactly the local set (${#WANT[@]} refs)."
