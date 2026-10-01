#!/usr/bin/env bash
# backup-bundles.sh on throwaway repos and a throwaway dest. Usage: bash test-backup.sh
source "$(dirname "$0")/lib.sh"
BK="$SCRIPTS/backup-bundles.sh"
sandbox t-backup
mkdir dest
count() { local f=("$SB/dest/$1"-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].bundle); echo "${#f[@]}"; }
shopt -s nullglob

G init -q -b mvp-launch alpha; G -C alpha commit -q --allow-empty -m a1; G -C alpha tag -a v1 -m v1
G -C alpha branch main
G init -q -b main beta; G -C beta commit -q --allow-empty -m b1

# 16 old fake bundles for alpha, 16 for a source that will fail, plus bystanders
for d in $(seq -w 1 16); do
  echo fake > "dest/alpha-2026-09-$d.bundle"
  echo fake > "dest/gone-2026-09-$d.bundle"
done
echo fake > dest/alpha-extra-2026-01-01.bundle   # another name that starts with "alpha-"
echo fake > dest/alpha-0-handmade.bundle          # sorts before every dated alpha bundle
echo fake > dest/manual-notes.bundle             # a hand-made bundle with no date
( cd dest && sha256sum -b alpha-2026-09-01.bundle > SHA256SUMS )

export BACKUP_SOURCES="alpha=$SB/alpha;beta=$SB/beta;gone=$SB/no-such-repo"
out=$(BACKUP_DATE=2026-09-29 bash "$BK" "$SB/dest" 2>&1); rc=$?
check "a failing source makes the run exit 1" test $rc -eq 1
check "alpha bundle written" test -f dest/alpha-2026-09-29.bundle
check "beta bundle written" test -f dest/beta-2026-09-29.bundle
check "alpha rotated to the newest 14" test "$(count alpha)" -eq 14
check "the oldest alpha bundles went first" test ! -e dest/alpha-2026-09-03.bundle -a -e dest/alpha-2026-09-04.bundle
check "failed source keeps all its old bundles" test "$(count gone)" -eq 16
check "a name sharing the prefix is untouched" test -f dest/alpha-extra-2026-01-01.bundle -a -f dest/alpha-0-handmade.bundle
check "an undated bundle is untouched" test -f dest/manual-notes.bundle
check "the bundle restores (clone + refs)" bash -c 'git clone -q --mirror "$0/dest/alpha-2026-09-29.bundle" "$0/restored.git" && test "$(git -C "$0/restored.git" rev-parse refs/tags/v1)" = "$(git -C "$0/alpha" rev-parse refs/tags/v1)" && git -C "$0/restored.git" rev-parse -q --verify refs/heads/main >/dev/null' "$SB"
check "SHA256SUMS lists every bundle" test "$(grep -c '' dest/SHA256SUMS)" -eq "$(ls dest/*.bundle | wc -l)"
check "SHA256SUMS verifies" bash -c 'cd "$0/dest" && sha256sum -c --quiet SHA256SUMS' "$SB"
check "no temp files left" test -z "$(ls dest | grep '\.tmp$')"

cp dest/SHA256SUMS sums.before
out=$(BACKUP_DATE=2026-09-29 bash "$BK" "$SB/dest" 2>&1); rc=$?
check "same-day re-run: unchanged sources are skipped" test "$(grep -c '^SAME' <<< "$out")" -eq 2
check "same-day re-run: file count unchanged" test "$(count alpha)" -eq 14
check "same-day re-run: SHA256SUMS unchanged" cmp -s sums.before dest/SHA256SUMS

export BACKUP_SOURCES="alpha=$SB/alpha;beta=$SB/beta"
G -C alpha commit -q --allow-empty -m a2
out=$(BACKUP_DATE=2026-09-30 bash "$BK" "$SB/dest" 2>&1); rc=$?
check "next day: exits 0 when every source is fine" test $rc -eq 0
check "next day: changed source gets a new bundle" test -f dest/alpha-2026-09-30.bundle
check "next day: unchanged source is skipped" test ! -e dest/beta-2026-09-30.bundle
check "next day: still 14 for alpha" test "$(count alpha)" -eq 14

echo tampered >> dest/alpha-2026-09-29.bundle
BACKUP_DATE=2026-10-01 bash "$BK" "$SB/dest" >/dev/null 2>&1
check "a bundle changed behind our back is not re-blessed" bash -c 'cd "$0/dest" && ! sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1' "$SB"

BACKUP_LOG="$SB/backup.log" BACKUP_DATE=2026-10-01 bash "$BK" "$SB/dest" > stdout.txt 2>&1
check "BACKUP_LOG takes the output" bash -c 'test ! -s "$0/stdout.txt" && grep -q "^=== backup-bundles" "$0/backup.log"' "$SB"

mkdir inst; cp "$BK" inst/backup-bundles.sh
printf '# comment\r\n\r\nbeta=%s\r\n' "$SB/beta" > inst/backup-sources.txt
mkdir dest2
( unset BACKUP_SOURCES; BACKUP_DATE=2026-10-01 bash inst/backup-bundles.sh "$SB/dest2" > sf.txt 2>&1 )
check "backup-sources.txt beside the script is used (CRLF ok)" bash -c 'test -f "$0/dest2/beta-2026-10-01.bundle" && test "$(ls "$0/dest2" | grep -c bundle)" -eq 1' "$SB"

out=$(BACKUP_KEEP=0 bash "$BK" "$SB/dest" 2>&1); rc=$?
check "BACKUP_KEEP=0 is refused" test $rc -eq 2

# ---- a working clone after the host merged an MR: its newest trunk is origin/mvp-launch only
G init -q -b mvp-launch host-src; G -C host-src commit -q --allow-empty -m base
G clone -q --bare host-src host.git
G clone -q host.git clone; G -C clone checkout -q -b feat/mine; G -C clone commit -q --allow-empty -m mine
G -C clone checkout -q mvp-launch
G clone -q host.git merger; G -C merger commit -q --allow-empty -m "merge !1, made by the host"; G -C merger push -q origin mvp-launch
G -C clone fetch -q origin
HOST_TRUNK=$(git -C host.git rev-parse mvp-launch)
mkdir dest3
export BACKUP_SOURCES="clone=$SB/clone"
out=$(BACKUP_DATE=2026-10-15 bash "$BK" "$SB/dest3" 2>&1); rc=$?
check "clone bundle: written" test $rc -eq 0 -a -f dest3/clone-2026-10-15.bundle
check "clone bundle: holds the host's trunk commit" bash -c 'git clone -q --mirror "$0/dest3/clone-2026-10-15.bundle" "$0/r3.git" && git -C "$0/r3.git" cat-file -e "$1^{commit}"' "$SB" "$HOST_TRUNK"
check "clone bundle: names it origin/mvp-launch" bash -c 'git bundle list-heads "$0" refs/remotes/origin/mvp-launch | grep -q "^$1 "' "$SB/dest3/clone-2026-10-15.bundle" "$HOST_TRUNK"
out=$(BACKUP_DATE=2026-10-15 bash "$BK" "$SB/dest3" 2>&1)
check "clone bundle: a re-run with nothing new is SAME (origin/HEAD does not count as a change)" grep -q "^SAME  clone" <<< "$out"
G -C merger commit -q --allow-empty -m "merge !2"; G -C merger push -q origin mvp-launch; G -C clone fetch -q origin
out=$(BACKUP_DATE=2026-10-16 bash "$BK" "$SB/dest3" 2>&1)
check "clone bundle: a fetch alone makes a new bundle" test -f dest3/clone-2026-10-16.bundle

# ---- a bundle that fails verify is never kept, and the run fails
mkdir shim dest4
printf '%s\n' '#!/usr/bin/env bash' \
  '[[ " $* " == *" bundle verify "* ]] && exit 1' \
  "exec '$(command -v git)' \"\$@\"" > shim/git
chmod +x shim/git
export BACKUP_SOURCES="alpha=$SB/alpha"
out=$(PATH="$SB/shim:$PATH" BACKUP_DATE=2026-10-20 bash "$BK" "$SB/dest4" 2>&1); rc=$?
check "unverifiable bundle: the run exits 1" test $rc -eq 1
check "unverifiable bundle: says FAIL" grep -q "^FAIL  alpha: bundle create or verify failed" <<< "$out"
check "unverifiable bundle: nothing kept, no temp file" test -z "$(ls dest4 | grep bundle)"

finish backup
