#!/usr/bin/env bash
# set-remotes.sh <clone> <primary-url> [<standby-url>] [--fix-email <address>]
# origin fetches from the primary and pushes to the primary, then the standby. A remote named for
# the standby's host (github, gitlab, bitbucket, else standby) fetches the standby. When the primary
# moves to another host, the old origin keeps its refs under its host's name: as the standby, or as
# a frozen record that `git fetch --all` skips and pushes to fail. Re-running changes nothing.
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
host_of() { # the host of a git URL, lower case; a local path is a host of its own
  if [[ $1 =~ ^[A-Za-z][A-Za-z0-9+.-]*://([^/@]*@)?([^/:]+) ]]; then echo "${BASH_REMATCH[2],,}"
  elif [[ ! $1 =~ ^[A-Za-z]:[/\\] && $1 =~ ^([^/@:]+@)?([^/:]+): ]]; then echo "${BASH_REMATCH[2],,}"
  else echo "path:$1"; fi
}
name_for() { # the remote name for a host, empty when the host has no name of its own
  case $(host_of "$1") in
    github.com) echo github ;; gitlab.com) echo gitlab ;; bitbucket.org) echo bitbucket ;; *) echo '' ;;
  esac
}
url_of() { g config --get "remote.$1.url" || true; }

g rev-parse --git-dir >/dev/null 2>&1 || stop "$CLONE is not a git repository"
if [[ -n $STANDBY ]]; then
  [[ $STANDBY != "$PRIMARY" ]] || stop "primary and standby are the same URL"
  [[ $(host_of "$STANDBY") != "$(host_of "$PRIMARY")" ]] \
    || stop "primary and standby are both on $(host_of "$PRIMARY"); a standby must outlive the primary's host"
fi

# ---------------------------------------------------------------- plan first: a refusal changes nothing
origin=$(url_of origin)
old_name=''   # where the old origin goes when the primary moves to another host
if [[ -n $origin && $origin != "$PRIMARY" && $(host_of "$origin") != "$(host_of "$PRIMARY")" ]]; then
  old_name=$(name_for "$origin"); old_name=${old_name:-old-origin}
  [[ -z $(url_of "$old_name") ]] \
    || stop "origin ($origin) would become remote '$old_name', but that name is taken ($(url_of "$old_name")); sort that out by hand"
fi
promote=''    # a remote already fetching the new primary's host becomes origin, refs and all
if [[ -z $origin || -n $old_name ]]; then
  p=$(name_for "$PRIMARY")
  if [[ -n $p && -n $(url_of "$p") && $(host_of "$(url_of "$p")") == "$(host_of "$PRIMARY")" ]]; then promote=$p; fi
fi
s_name=''
if [[ -n $STANDBY ]]; then
  s_name=$(name_for "$STANDBY"); s_name=${s_name:-standby}
  if [[ $s_name != "$old_name" && -n $(url_of "$s_name") \
        && $(host_of "$(url_of "$s_name")") != "$(host_of "$STANDBY")" ]]; then
    stop "remote '$s_name' points at $(url_of "$s_name"), another host than the standby; sort that out by hand"
  fi
fi

# ---------------------------------------------------------------- origin
if [[ -n $old_name ]]; then
  g remote rename origin "$old_name"
  echo "renamed origin ($origin) -> $old_name"
fi
if [[ -n $promote ]]; then
  g remote rename "$promote" origin
  echo "renamed $promote -> origin (it already fetched the primary's host)"
elif [[ -z $origin || -n $old_name ]]; then
  g remote add origin "$PRIMARY"
  echo "added origin: fetch $PRIMARY"
fi
now=$(url_of origin)
if [[ $now != "$PRIMARY" ]]; then g remote set-url origin "$PRIMARY"; echo "origin fetch URL: $now -> $PRIMARY"; fi
g config --unset-all remote.origin.pushurl || true
g config --add remote.origin.pushurl "$PRIMARY"
if [[ -n $STANDBY ]]; then g config --add remote.origin.pushurl "$STANDBY"; fi
g config --unset remote.origin.skipFetchAll || true

# ---------------------------------------------------------------- the standby, and a frozen old origin
if [[ -n $STANDBY ]]; then
  now=$(url_of "$s_name")
  if [[ -z $now ]]; then
    g remote add "$s_name" "$STANDBY"; echo "added $s_name: fetch $STANDBY"
  elif [[ $now != "$STANDBY" ]]; then
    g remote set-url "$s_name" "$STANDBY"; echo "$s_name fetch URL: $now -> $STANDBY"
  fi
  g config --unset-all "remote.$s_name.pushurl" || true
  g config --unset "remote.$s_name.skipFetchAll" || true
fi
if [[ -n $old_name && $old_name != "$s_name" ]]; then
  g config --replace-all "remote.$old_name.pushurl" "no-push://this-host-was-left-see-docs/GIT_HOSTING.md"
  g config "remote.$old_name.skipFetchAll" true
  echo "$old_name is a frozen record: fetch --all skips it and a push to it fails"
fi

moved=0
if [[ -n $old_name ]]; then
  while read -r key value; do
    if [[ $value == "$old_name" ]]; then
      b=${key#branch.}; b=${b%.remote}
      g config "branch.$b.remote" origin; moved=$((moved + 1))
    fi
  done < <(g config --get-regexp '^branch\..*\.remote$' || true)
fi
if ((moved)); then echo "branches re-pointed from $old_name to origin: $moved"; fi

email=$(g config --get user.email || true)
if [[ -n $FIX_EMAIL ]]; then
  g config --local user.email "$FIX_EMAIL"
  echo "user.email: ${email:-<unset>} -> $FIX_EMAIL"
elif [[ $email == *@users.noreply.github.com && $(host_of "$PRIMARY") != github.com ]]; then
  echo "WARNING: commits here are authored as $email. The primary is not GitHub, so it and"
  echo "         Vercel cannot link that address to anyone. Fix it (history is not rewritten):"
  echo "         bash scripts/git-hosting/set-remotes.sh \"$CLONE\" $PRIMARY ${STANDBY:+$STANDBY }--fix-email <the email on your account there>"
fi

echo "--- remotes now"
g remote -v
