#!/usr/bin/env bash
# mirror-to-gitlab.sh: .github/workflows/mirror-to-gitlab.yml runs it in a full checkout of GitHub.
# A push event sends that one branch or tag to the standby; a schedule or manual run sends every
# branch and tag. Never forces, deletes or prunes: a ref the standby refuses stays as it is there.
# The trunk refused, or a trunk run with no key, fails the run; any other refusal is a warning.
# main/master go up as archive/<name>. Settings are environment variables, listed below.
set -euo pipefail

REPO=${MIRROR_REPO:-.}
URL=${MIRROR_URL:?MIRROR_URL is the standby git URL}
EVENT=${MIRROR_EVENT:?MIRROR_EVENT is push, schedule or workflow_dispatch}
REF=${MIRROR_REF:-}                       # push only: refs/heads/<b> or refs/tags/<t>
DELETED=${MIRROR_DELETED:-false}          # push only: GitHub's `deleted` flag
TRUNK=${MIRROR_TRUNK:-mvp-launch}
SOURCE=${MIRROR_SOURCE_REMOTE:-origin}    # the checkout keeps GitHub's branches under this remote
PUSH_OPTION=${MIRROR_PUSH_OPTION-ci.skip} # GitLab starts no pipeline for a mirror push
TRUNK_REF=refs/heads/$TRUNK

err()  { echo "::error::$*"; }
warn() { echo "::warning::$*"; }
note() { echo "::notice::$*"; }
g() { git -C "$REPO" "$@"; }

case $EVENT in
  push)
    [[ $REF == refs/heads/?* || $REF == refs/tags/?* ]] || { err "push event for '$REF', which is not a branch or tag"; exit 2; }
    on_trunk=0; if [[ $REF == "$TRUNK_REF" ]]; then on_trunk=1; fi ;;
  schedule|workflow_dispatch) on_trunk=1 ;;
  *) err "unknown event '$EVENT'"; exit 2 ;;
esac

gone() { # the pushed ref is not on GitHub (any more): the standby keeps its copy either way
  if ((on_trunk)); then err "GitHub has no $REF. The standby keeps its copy. Find out why before anything merges."; exit 1; fi
  note "GitHub has no $REF (deleted). The standby keeps its copy: this mirror never deletes."; exit 0
}
if [[ $EVENT == push && $DELETED == true ]]; then gone; fi

if [[ -z ${GITLAB_MIRROR_SSH_KEY:-} ]]; then
  msg="the GitHub secret GITLAB_MIRROR_SSH_KEY is not set, so nothing reached the standby (docs/GIT_HOSTING.md, 2C)"
  if ((on_trunk)); then err "$msg"; exit 1; fi
  warn "$msg"; exit 0
fi

# SSH with the pinned host key only. The workflow pins the key line and its fingerprint; they
# must agree before any connection. The private key lives in a 0600 file removed on exit.
KEYDIR=''
setup_ssh() {
  local d fp
  [[ -n ${GITLAB_HOST_KEY:-} && -n ${GITLAB_HOST_KEY_SHA256:-} ]] || { err "the workflow does not pin the standby's host key"; exit 1; }
  KEYDIR=$(mktemp -d); trap 'rm -rf "$KEYDIR"' EXIT; d=$KEYDIR
  printf '%s\n' "$GITLAB_HOST_KEY" > "$d/known_hosts"
  fp=$(ssh-keygen -lf "$d/known_hosts" -E sha256 2>/dev/null | awk '{print $2}') || fp=''
  [[ -n $fp && $fp == "$GITLAB_HOST_KEY_SHA256" ]] \
    || { err "the pinned host key's fingerprint is '${fp:-unreadable}', not the pinned $GITLAB_HOST_KEY_SHA256"; exit 1; }
  (umask 077; printf '%s\n' "$GITLAB_MIRROR_SSH_KEY" | tr -d '\r' > "$d/key")
  export GIT_SSH_COMMAND="ssh -i '$d/key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$d/known_hosts' -o HostKeyAlgorithms=ssh-ed25519"
  ERRF=$d/push-stderr
}

src_of() { case $1 in refs/heads/*) echo "refs/remotes/$SOURCE/${1#refs/heads/}" ;; *) echo "$1" ;; esac; }
dst_of() {
  case $1 in
    refs/heads/main|refs/heads/master) if [[ $1 == "$TRUNK_REF" ]]; then echo "$1"; else echo "refs/heads/archive/${1#refs/heads/}"; fi ;;
    *) echo "$1" ;;
  esac
}

# One `git push --porcelain`, then one status per destination: ok, diverged (the standby holds a
# commit this ref does not contain), refused (the standby's own rules) or failed (no answer).
declare -A STATUS
OPTS=(--porcelain --no-follow-tags --recurse-submodules=no)
if [[ -n $PUSH_OPTION ]]; then OPTS+=(-o "$PUSH_OPTION"); fi
push_specs() {
  local out rc=0 flag spec summary dst
  for spec; do [[ $spec == [!+:]*:refs/* ]] || { err "refusing refspec '$spec'"; exit 2; }; done
  out=$(g push "${OPTS[@]}" "$URL" "$@" 2>"$ERRF") || rc=$?
  if ((rc)); then sed 's/^/  git: /' "$ERRF"; fi
  while IFS=$'\t' read -r flag spec summary; do
    [[ $spec == *:refs/* ]] || continue
    dst=${spec#*:}
    case $flag in
      ' '|'*'|'=') STATUS[$dst]=ok ;;
      '!') if [[ $summary == '[remote rejected]'* ]]; then STATUS[$dst]="refused $summary"; else STATUS[$dst]="diverged $summary"; fi ;;
      *) STATUS[$dst]="unexpected '$flag' $summary" ;;
    esac
  done <<< "$out"
  for spec; do dst=${spec#*:}; [[ -n ${STATUS[$dst]+x} ]] || STATUS[$dst]="failed (git exit $rc)"; done
}

report() {
  local dst st ok=0 kept=0 trunk_bad=0
  while read -r dst; do
    st=${STATUS[$dst]}
    if [[ $st == ok ]]; then ok=$((ok + 1))
    elif [[ $dst == "$TRUNK_REF" ]]; then
      err "the standby did not take $TRUNK: $st. Nothing was forced. What to do: docs/GIT_HOSTING.md, section 3."
      trunk_bad=1
    else warn "$dst: $st. The standby keeps its own version; nothing was overwritten."; kept=$((kept + 1)); fi
  done < <(printf '%s\n' "${!STATUS[@]}" | LC_ALL=C sort)
  echo "on the standby as on GitHub: $ok; kept as the standby has them: $kept"
  if ((trunk_bad)); then exit 1; fi
  echo "OK: the standby took every ref it was sent, or kept its own copy where they differ."
}

if [[ $EVENT == push ]]; then
  src=$(src_of "$REF")
  g rev-parse -q --verify "$src" >/dev/null || gone
  setup_ssh
  echo "event: $REF -> $(dst_of "$REF") on $URL"
  push_specs "$src:$(dst_of "$REF")"
  report
  exit 0
fi

# ---------------------------------------------------------------- schedule / manual: everything
declare -A WANT SRC REMOTE
while read -r sha ref; do
  case $ref in
    "refs/remotes/$SOURCE/HEAD") continue ;;
    refs/remotes/*) r="refs/heads/${ref#"refs/remotes/$SOURCE/"}" ;;
    *) r=$ref ;;
  esac
  d=$(dst_of "$r"); WANT[$d]=$sha; SRC[$d]=$ref
done < <(g for-each-ref --format='%(objectname) %(refname)' "refs/remotes/$SOURCE/" refs/tags/)
[[ -n ${WANT[$TRUNK_REF]+x} ]] || { err "the checkout has no $SOURCE/$TRUNK"; exit 1; }

setup_ssh
out=$(g ls-remote --heads --tags "$URL" 2>"$ERRF") || { sed 's/^/  git: /' "$ERRF"; err "could not read the standby; nothing was pushed"; exit 1; }
while read -r sha ref; do
  [[ -z $ref || $ref == *'^{}' ]] || REMOTE[$ref]=$sha
done <<< "$out"

PLAN=()
add() { [[ ${REMOTE[$1]:-} == "${WANT[$1]}" ]] || PLAN+=("${SRC[$1]}:$1"); }
add "$TRUNK_REF"
while read -r d; do [[ $d == "$TRUNK_REF" ]] || add "$d"; done < <(printf '%s\n' "${!WANT[@]}" | LC_ALL=C sort)
echo "GitHub: ${#WANT[@]} branches and tags; already on the standby: $(( ${#WANT[@]} - ${#PLAN[@]} )); to push: ${#PLAN[@]}"
start=0
if ((${#PLAN[@]})) && [[ ${PLAN[0]} == *":$TRUNK_REF" ]]; then push_specs "${PLAN[0]}"; start=1; fi   # trunk alone, first
for ((i = start; i < ${#PLAN[@]}; i += 100)); do push_specs "${PLAN[@]:i:100}"; done
if ((${#PLAN[@]})); then report; else echo "OK: the standby already holds every branch and tag GitHub has."; fi
