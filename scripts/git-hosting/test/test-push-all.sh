#!/usr/bin/env bash
# push-all.sh against local bare repos standing in for hosts. Usage: bash test-push-all.sh
source "$(dirname "$0")/lib.sh"
PA="$SCRIPTS/push-all.sh"
sandbox t-push

# ---- source repo: mvp-launch (2 commits), diverged main, feature, light + annotated tags
G init -q -b mvp-launch src
G -C src commit -q --allow-empty -m base
G -C src branch main
G -C src commit -q --allow-empty -m trunk2
G -C src checkout -q main; G -C src commit -q --allow-empty -m main-only
G -C src checkout -q -b feature mvp-launch; G -C src commit -q --allow-empty -m feat
G -C src checkout -q -b other mvp-launch~1; G -C src commit -q --allow-empty -m other-diverged
G -C src checkout -q mvp-launch
G -C src tag v-light
G -C src tag -a v-ann -m annotated HEAD~1
for i in $(seq 1 130); do echo "create refs/heads/bulk/b$i $(git -C src rev-parse feature)"; done | git -C src update-ref --stdin
SRC_TRUNK=$(git -C src rev-parse mvp-launch)
SRC_MAIN=$(git -C src rev-parse main)

mkbare() { # name: a bare repo whose hook logs every push (push option + refs) to <name>.log
  git init -q --bare "$1.git"
  git -C "$1.git" config receive.advertisePushOptions true
  printf '%s\n' '#!/bin/sh' \
    'log="$(pwd)/../$(basename "$(pwd)" .git).log"' \
    'echo "PUSH opts=${GIT_PUSH_OPTION_0:-none}" >> "$log"' \
    'while read -r old new ref; do echo "  $ref" >> "$log"; done' > "$1.git/hooks/post-receive"
  chmod +x "$1.git/hooks/post-receive"
}

# ---------------------------------------------------------------- T1 dry run changes nothing
mkbare r1
out=$(bash "$PA" src "$SB/r1.git" --gitlab --dry-run 2>&1); rc=$?
check "T1 dry run exits 0" test $rc -eq 0
check "T1 dry run reports the plan" grep -q "to push: 136" <<< "$out"
check "T1 dry run leaves the host empty" test -z "$(git ls-remote "$SB/r1.git")"

# ---------------------------------------------------------------- T2 real push
out=$(bash "$PA" src "$SB/r1.git" --gitlab 2>&1); rc=$?
check "T2 exits 0" test $rc -eq 0
check "T2 says OK" grep -q "^OK: the host holds exactly the local set (136 refs)" <<< "$out"
check "T2 main arrives as archive/main" test "$(git -C r1.git rev-parse refs/heads/archive/main 2>/dev/null)" = "$SRC_MAIN"
check "T2 no main on the host" test -z "$(git ls-remote "$SB/r1.git" refs/heads/main)"
check "T2 trunk equal" test "$(git -C r1.git rev-parse refs/heads/mvp-launch)" = "$SRC_TRUNK"
check "T2 annotated tag object equal" test "$(git -C r1.git rev-parse refs/tags/v-ann)" = "$(git -C src rev-parse refs/tags/v-ann)"
check "T2 first push is the trunk alone" test "$(sed -n 2p r1.log)" = "  refs/heads/mvp-launch" -a "$(sed -n 3p r1.log | cut -c1-4)" = "PUSH"
check "T2 every push carried ci.skip" test "$(grep -c '^PUSH' r1.log)" = "$(grep -c '^PUSH opts=ci.skip' r1.log)"
check "T2 batches of at most 100" test "$(awk '/^PUSH/{if(n>m)m=n;n=0;next}{n++}END{if(n>m)m=n;print m}' r1.log)" -le 100
pushes_before=$(grep -c '^PUSH' r1.log)

# ---------------------------------------------------------------- T3 re-run is a no-op
out=$(bash "$PA" src "$SB/r1.git" --gitlab 2>&1); rc=$?
check "T3 re-run exits 0" test $rc -eq 0
check "T3 re-run plans nothing" grep -q "to push: 0" <<< "$out"
check "T3 re-run pushed nothing" test "$(grep -c '^PUSH' r1.log)" = "$pushes_before"

# ---------------------------------------------------------------- T4 refuse a divergent / unknown / newer trunk
mkbare r4a; G -C src push -q "$SB/r4a.git" other:refs/heads/mvp-launch
out=$(bash "$PA" src "$SB/r4a.git" 2>&1); rc=$?
check "T4a diverged host trunk: refuses" test $rc -ne 0
check "T4a says not an ancestor" grep -q "is not an ancestor of local mvp-launch" <<< "$out"
check "T4a pushed nothing else" test "$(git ls-remote "$SB/r4a.git" | wc -l)" -eq 1

G clone -q --bare src r4b.git
G --git-dir=r4b.git commit-tree -m unknown "$(git -C src rev-parse 'mvp-launch^{tree}')" -p mvp-launch > r4b.sha
git --git-dir=r4b.git update-ref refs/heads/mvp-launch "$(cat r4b.sha)"
out=$(bash "$PA" src "$SB/r4b.git" 2>&1); rc=$?
check "T4b unknown host trunk: refuses" test $rc -ne 0
check "T4b says it cannot prove" grep -q "cannot prove it is behind" <<< "$out"

mkbare r4c; G -C src push -q "$SB/r4c.git" feature:refs/heads/mvp-launch
out=$(bash "$PA" src "$SB/r4c.git" 2>&1); rc=$?
check "T4c host trunk ahead of local: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "not an ancestor" <<< "$1"' "$rc" "$out"

# ---------------------------------------------------------------- T5 verification catches a dropped ref
mkbare r5
echo 'git update-ref -d refs/tags/v-light 2>/dev/null || true' >> r5.git/hooks/post-receive
out=$(bash "$PA" src "$SB/r5.git" 2>&1); rc=$?
check "T5 dropped ref: exits non-zero" test $rc -ne 0
check "T5 names the missing ref" grep -q "^MISSING  refs/tags/v-light" <<< "$out"

# ---------------------------------------------------------------- T6 extra ref on the host (README-initialized main)
mkbare r6; G -C src push -q "$SB/r6.git" mvp-launch~1:refs/heads/main
out=$(bash "$PA" src "$SB/r6.git" 2>&1); rc=$?
check "T6 warns about main" grep -q "WARNING: the host already has refs/heads/main" <<< "$out"
check "T6 reports EXTRA main and exits non-zero" bash -c '[[ $0 -ne 0 ]] && grep -q "^EXTRA    refs/heads/main" <<< "$1"' "$rc" "$out"

# ---------------------------------------------------------------- T7 no force: a clashing ref is never overwritten
mkbare r7; G -C src push -q "$SB/r7.git" other:refs/heads/feature other:refs/tags/v-ann
out=$(bash "$PA" src "$SB/r7.git" --dry-run 2>&1); rc=$?
check "T7a a dry run that the host would reject exits non-zero" bash -c '[[ $0 -ne 0 ]] && grep -q "STOP: the dry run reported rejections" <<< "$1"' "$rc" "$out"
check "T7a the rejecting dry run never says nothing was pushed as if fine" bash -c '! grep -q "^DRY RUN: nothing was pushed" <<< "$0"' "$out"
out=$(bash "$PA" src "$SB/r7.git" 2>&1); rc=$?
check "T7 exits non-zero" test $rc -ne 0
check "T7 feature untouched" test "$(git -C r7.git rev-parse refs/heads/feature)" = "$(git -C src rev-parse other)"
check "T7 tag untouched" test "$(git -C r7.git rev-parse refs/tags/v-ann)" = "$(git -C src rev-parse other)"
check "T7 reports DIFFERS" grep -q "^DIFFERS  refs/heads/feature" <<< "$out"
check "T7 the rest still arrived" test "$(git -C r7.git rev-parse refs/heads/archive/main)" = "$SRC_MAIN"

# ---------------------------------------------------------------- T8 other guards
G -C src branch archive/main mvp-launch
out=$(bash "$PA" src "$SB/r1.git" --dry-run 2>&1); rc=$?
check "T8a main vs archive/main clash: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "rename one first" <<< "$1"' "$rc" "$out"
G -C src branch -D -q archive/main
G -C src remote add hostname "$SB/r1.git"
out=$(bash "$PA" src hostname 2>&1); rc=$?
check "T8b remote name instead of URL: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "is a remote name" <<< "$1"' "$rc" "$out"
G -C src remote remove hostname
out=$(bash "$PA" src "$SB/does-not-exist.git" 2>&1); rc=$?
check "T8c unreadable host: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "could not read" <<< "$1"' "$rc" "$out"
G init -q -b main lab; G -C lab commit -q --allow-empty -m lab
mkbare r8
out=$(bash "$PA" lab "$SB/r8.git" --trunk main 2>&1); rc=$?
check "T8d --trunk main pushes main as main" bash -c '[[ $0 -eq 0 ]] && git -C "$1" rev-parse -q --verify refs/heads/main >/dev/null' "$rc" "$SB/r8.git"
G clone -q src lagging; G -C lagging reset -q --hard HEAD~1
out=$(bash "$PA" lagging "$SB/r8.git" --dry-run --local-only 2>&1); rc=$?
check "T8e local trunk behind its own origin/mvp-launch: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "refs/remotes/origin/mvp-launch" <<< "$1"' "$rc" "$out"

# ---------------------------------------------------------------- T9 master goes up as archive/master too
G init -q -b mvp-launch ms; G -C ms commit -q --allow-empty -m t; G -C ms branch master
G -C ms checkout -q master; G -C ms commit -q --allow-empty -m old-master; G -C ms checkout -q mvp-launch
mkbare r9
out=$(bash "$PA" ms "$SB/r9.git" 2>&1); rc=$?
check "T9 master arrives as archive/master" bash -c '[[ $0 -eq 0 ]] && test "$(git -C "$1" rev-parse refs/heads/archive/master)" = "$(git -C "$2" rev-parse master)"' "$rc" "$SB/r9.git" "$SB/ms"
check "T9 no master on the host" test -z "$(git ls-remote "$SB/r9.git" refs/heads/master)"

# ---------------------------------------------------------------- T10 a working clone is not a full source
# The old host has three branches; the clone checked out only one of them locally.
G init -q -b mvp-launch seed; G -C seed commit -q --allow-empty -m base
for b in feat/one feat/two feat/three; do G -C seed branch "$b"; done
G clone -q --bare seed oldhost.git
G clone -q oldhost.git wc; G -C wc checkout -q -b feat/mine; G -C wc commit -q --allow-empty -m mine
G -C wc checkout -q mvp-launch; G -C wc branch -q feat/one origin/feat/one
mkbare r10
out=$(bash "$PA" wc "$SB/r10.git" 2>&1); rc=$?
check "T10 clone with remote-only branches: refuses" bash -c '[[ $0 -ne 0 ]] && grep -q "2 remote-tracking branch(es) with no local branch" <<< "$1"' "$rc" "$out"
check "T10 refusal pushed nothing" test -z "$(git ls-remote "$SB/r10.git")"
out=$(bash "$PA" wc "$SB/r10.git" --local-only 2>&1); rc=$?
check "T10 --local-only pushes the local set" bash -c '[[ $0 -eq 0 ]] && grep -q "^OK: the host holds exactly the local set (3 refs)" <<< "$1"' "$rc" "$out"
G clone -q --mirror oldhost.git oldhost-mirror.git
mkbare r10m
out=$(bash "$PA" oldhost-mirror.git "$SB/r10m.git" 2>&1); rc=$?
check "T10 a bare mirror of the host carries every branch" bash -c '[[ $0 -eq 0 ]] && test "$(git ls-remote --heads "$1" | wc -l)" -eq 4' "$rc" "$SB/r10m.git"

# ---------------------------------------------------------------- T11 a vault goes only where --vault says
G clone -q --bare src vaultlike.git
git -C vaultlike.git update-ref refs/tags/archive/a/stash-1 "$(git -C src rev-parse other)"
mkbare r11
out=$(bash "$PA" vaultlike.git "$SB/r11.git" --gitlab 2>&1); rc=$?
check "T11 a vault without --vault: refused" bash -c '[[ $0 -ne 0 ]] && grep -q "so it is a vault" <<< "$1"' "$rc" "$out"
check "T11 the refusal pushed nothing" test -z "$(git ls-remote "$SB/r11.git")"
out=$(bash "$PA" vaultlike.git "$SB/r11.git" --gitlab --dry-run 2>&1); rc=$?
check "T11 a dry run is refused too" test $rc -ne 0
out=$(bash "$PA" vaultlike.git "$SB/r11.git" --gitlab --vault 2>&1); rc=$?
check "T11 --vault pushes it, archive tags included" bash -c '[[ $0 -eq 0 ]] && git -C "$1" rev-parse -q --verify refs/tags/archive/a/stash-1 >/dev/null' "$rc" "$SB/r11.git"

# ---------------------------------------------------------------- static: no forcing flags anywhere
check "static: no --force/--mirror/--prune/--delete" bash -c '! grep -nE -- "--force|--mirror|--prune|--delete" "$0"' "$PA"
check "static: no forced (+) refspec" bash -c '! grep -nF "+refs/" "$0"' "$PA"

finish push-all
