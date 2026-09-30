#!/usr/bin/env bash
# backup-bundles.sh [<dest>]: one verified bundle per source repo per day, holding its branches,
# tags and remote-tracking refs (a clone's newest trunk is origin/mvp-launch, not mvp-launch).
# Sources: $BACKUP_SOURCES ("name=path;..."), else backup-sources.txt beside this script (one
# name=path per line), else DEFAULT_SOURCES. A source equal to its newest bundle is skipped. The
# newest $BACKUP_KEEP (14) dated bundles stay; older ones go only after that source's run
# succeeded. Refreshes SHA256SUMS. Exits 1 if any source failed. BACKUP_LOG appends output.
set -euo pipefail
shopt -s nullglob

DEST=${1:-/c/Users/jimbo/OneDrive/git-vault}
KEEP=${BACKUP_KEEP:-14}
TODAY=${BACKUP_DATE:-$(date +%F)}   # BACKUP_DATE exists for tests
if [[ -n ${BACKUP_LOG:-} ]]; then exec >>"$BACKUP_LOG" 2>&1; fi
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || { echo "STOP: BACKUP_KEEP must be a positive whole number"; exit 2; }
[[ $TODAY =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "STOP: bad date '$TODAY'"; exit 2; }

DEFAULT_SOURCES=(
  "tegridy-farms-ALL=/c/Users/jimbo/git-vault/tegridy-farms.git"
  "tegridy-farms-devclone=/c/Users/jimbo/dev/tegridy-farms"
  "tegridy-farms-onedrive=/c/Users/jimbo/OneDrive/Desktop/tegriddy farms"
  "memetic-fun-lab-proxy=/c/Users/jimbo/OneDrive/Desktop/memetic.fun/lab-proxy"
  "nakamigos-app=/c/Users/jimbo/OneDrive/Desktop/nakamigos-app"
  "sartoshisiding.com=/c/Users/jimbo/OneDrive/Desktop/siding/website"
)
SOURCES_FILE="$(dirname "$0")/backup-sources.txt"
if [[ -n ${BACKUP_SOURCES+x} ]]; then
  IFS=';' read -r -a SOURCES <<< "$BACKUP_SOURCES"
elif [[ -f $SOURCES_FILE ]]; then
  mapfile -t SOURCES < <(tr -d '\r' < "$SOURCES_FILE" | grep -vE '^[[:space:]]*(#|$)')
else
  SOURCES=("${DEFAULT_SOURCES[@]}")
fi
((${#SOURCES[@]})) || { echo "STOP: no sources to back up"; exit 2; }

echo "=== backup-bundles $(date '+%F %T')  dest=$DEST  keep=$KEEP"
mkdir -p "$DEST"

dated() { # the <name>-YYYY-MM-DD.bundle files of one source, oldest first
  local f=("$DEST/$1"-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].bundle)
  if ((${#f[@]})); then printf '%s\n' "${f[@]}" | LC_ALL=C sort; fi
}
rotate() {
  local files n i
  mapfile -t files < <(dated "$1")
  n=${#files[@]}
  for ((i = 0; i < n - KEEP; i++)); do
    rm -f -- "${files[i]}"
    echo "ROTATE removed $(basename "${files[i]}")"
  done
}

declare -A WROTE
fails=0
for s in "${SOURCES[@]}"; do
  name=${s%%=*} src=${s#*=}
  if [[ $name == "$s" || ! $name =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "FAIL  '$s': expected name=path"; fails=$((fails + 1)); continue
  fi
  if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
    echo "FAIL  $name: $src is not a readable git repository"; fails=$((fails + 1)); continue
  fi
  # the set `bundle create --branches --tags --remotes` writes; it leaves out symbolic refs (origin/HEAD)
  refs=$(git -C "$src" for-each-ref --format='%(if)%(symref)%(then)%(else)%(objectname) %(refname)%(end)' \
    refs/heads/ refs/tags/ refs/remotes/ | grep . | LC_ALL=C sort || true)
  if [[ -z $refs ]]; then echo "FAIL  $name: no branches, tags or remote-tracking refs"; fails=$((fails + 1)); continue; fi

  newest=$(dated "$name" | tail -n 1)
  if [[ -n $newest ]]; then
    have=$(git -C "$src" bundle list-heads "$newest" 2>/dev/null | grep -v ' HEAD$' | LC_ALL=C sort || true)
    if [[ $have == "$refs" ]]; then
      echo "SAME  $name: unchanged since $(basename "$newest")"; rotate "$name"; continue
    fi
  fi

  out="$DEST/$name-$TODAY.bundle" tmp="$DEST/$name-$TODAY.bundle.tmp"
  rm -f -- "$tmp"
  if git -C "$src" bundle create -q "$tmp" --branches --tags --remotes \
     && git -C "$src" bundle verify -q "$tmp" >/dev/null 2>&1; then
    mv -f -- "$tmp" "$out"
    WROTE[$(basename "$out")]=1
    echo "OK    $name -> $(basename "$out")  ($(wc -l <<< "$refs") refs, $(du -h "$out" | cut -f1))"
    rotate "$name"
  else
    rm -f -- "$tmp"
    echo "FAIL  $name: bundle create or verify failed"; fails=$((fails + 1))
  fi
done

# SHA256SUMS: keep each recorded hash unless this run rewrote that file, so a bundle changed
# behind our back fails `sha256sum -c SHA256SUMS` instead of being re-blessed.
declare -A OLD
if [[ -f $DEST/SHA256SUMS ]]; then
  while read -r h f; do if [[ -n $f ]]; then OLD[${f#\*}]=$h; fi; done < <(tr -d '\r' < "$DEST/SHA256SUMS")
fi
(
  cd "$DEST"
  for f in *.bundle; do
    if [[ -n ${OLD[$f]+x} && -z ${WROTE[$f]+x} ]]; then echo "${OLD[$f]} *$f"; else sha256sum -b "$f"; fi
  done
) > "$DEST/SHA256SUMS.tmp"
mv -f "$DEST/SHA256SUMS.tmp" "$DEST/SHA256SUMS"

echo "done: $fails failure(s)"
exit $((fails > 0 ? 1 : 0))
