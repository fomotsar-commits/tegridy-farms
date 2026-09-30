#!/usr/bin/env bash
# set-remotes.sh <clone> <primary-url> [<standby-url>] [--fix-email <address>]
# Points a clone at the hosts: origin fetches from the primary and pushes to primary + standby.
# An origin on github.com becomes remote `github`, a frozen record: `git fetch --all` skips it,
# pushes to it fail, and branches that tracked it track origin. GitHub is never primary or
# standby again (GitLab mirrors to it). Re-running with the same arguments changes nothing.
set -euo pipefail

usage() {
  echo "usage: set-remotes.sh <clone> <primary-url> [<standby-url>] [--fix-email <address>]" >&2
  exit 2
}
stop() { echo "STOP: $*" >&2; exit 1; }

CLONE='' PRIMARY='' STANDBY='' FIX_EMAIL=''
while (($#)); do
  case $1 in
    --fix-email) [[ $# -ge 2 && -n $2 ]] || usage; FIX_EMAIL=$2; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) if [[ -z $CLONE ]]; then CLONE=$1; elif [[ -z $PRIMARY ]]; then PRIMARY=$1
       elif [[ -z $STANDBY ]]; then STANDBY=$1; else usage; fi ;;
  esac
  shift
done
[[ -n $CLONE && -n $PRIMARY ]] || usage

g() { git -C "$CLONE" "$@"; }
GITHUB_RE='(^|[/@.])github\.com[:/]'
is_github() { [[ $1 =~ $GITHUB_RE ]]; }
g rev-parse --git-dir >/dev/null 2>&1 || stop "$CLONE is not a git repository"
if is_github "$PRIMARY"; then stop "GitHub is never the primary again; GitLab mirrors to it"; fi
if [[ -n $STANDBY ]]; then
  if is_github "$STANDBY"; then stop "GitHub is never the standby; GitLab mirrors to it"; fi
  [[ $STANDBY != "$PRIMARY" ]] || stop "primary and standby are the same URL"
fi

origin=$(g config --get remote.origin.url || true)
if [[ -n $origin ]] && is_github "$origin"; then
  [[ -z $(g config --get remote.github.url || true) ]] \
    || stop "origin is on GitHub but a remote named 'github' already exists; sort that out by hand"
  g remote rename origin github
  echo "renamed origin ($origin) -> github; refs/remotes/github/* is the frozen record"
  origin=''
fi

if [[ -z $origin ]]; then
  g remote add origin "$PRIMARY"
  echo "added origin: fetch $PRIMARY"
elif [[ $origin != "$PRIMARY" ]]; then
  g remote set-url origin "$PRIMARY"
  echo "origin fetch URL: $origin -> $PRIMARY"
fi
g config --unset-all remote.origin.pushurl || true
g config --add remote.origin.pushurl "$PRIMARY"
if [[ -n $STANDBY ]]; then g config --add remote.origin.pushurl "$STANDBY"; fi

gh_url=$(g config --get remote.github.url || true)
if [[ -n $gh_url ]] && is_github "$gh_url"; then
  g config remote.github.pushurl "no-push://github-is-a-downstream-mirror-see-docs/GIT_HOSTING.md"
  g config remote.github.skipFetchAll true
fi

moved=0
while read -r key value; do
  if [[ $value == github ]]; then
    b=${key#branch.}; b=${b%.remote}
    g config "branch.$b.remote" origin; moved=$((moved + 1))
  fi
done < <(g config --get-regexp '^branch\..*\.remote$' || true)
if ((moved)); then echo "branches re-pointed from github to origin: $moved"; fi

email=$(g config --get user.email || true)
if [[ -n $FIX_EMAIL ]]; then
  g config --local user.email "$FIX_EMAIL"
  echo "user.email: ${email:-<unset>} -> $FIX_EMAIL"
elif [[ $email == *@users.noreply.github.com ]]; then
  echo "WARNING: commits here are authored as $email. GitLab and Vercel cannot link that"
  echo "         address to anyone. Fix it (history is not rewritten):"
  echo "         bash scripts/git-hosting/set-remotes.sh \"$CLONE\" $PRIMARY ${STANDBY:+$STANDBY }--fix-email <the email on your GitLab account>"
fi

echo "--- remotes now"
g remote -v
