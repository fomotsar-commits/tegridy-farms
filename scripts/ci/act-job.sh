#!/usr/bin/env bash
# Runs ONE .github/workflows file, unchanged, under act on our GitLab runner.
# The gates live in that file. This wrapper replays the event GitLab saw, pins act, and
# refuses a green that did not run: a non-zero act exit, a failed job, a listed job with
# no result (the "matrix ran nothing" shape), or zero jobs. See docs/CI_ON_GITLAB.md.
#   act-job.sh <workflow>.yml    inside a GitLab job      act-job.sh --self-test    no Docker
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=runner/pins.env
. "$HERE/runner/pins.env"
TRUNK=mvp-launch
ZERO_SHA=0000000000000000000000000000000000000000

die() { echo "act-job: $*" >&2; exit 1; }
is_sha() { [[ $1 =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; }

# A JSON string literal. Git allows " and \ in branch names; control characters are refused
# before any value gets here (check_text).
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}
check_text() { case $2 in *[[:cntrl:]]*) die "$1 contains a control character" ;; esac; }

# The event act replays: the fields act reads (number, refs, shas) and the ones our
# workflows read (pull_request.number, head.repo.full_name). Inputs are the EV_* globals.
event_json() {
  local repo owner name repository
  repo=$(json_str "$EV_REPO")
  owner=$(json_str "${EV_REPO%%/*}")
  name=$(json_str "${EV_REPO##*/}")
  repository="{\"full_name\":$repo,\"name\":$name,\"owner\":{\"login\":$owner},\"default_branch\":$(json_str "$TRUNK")}"
  if [ "$EVENT" = pull_request ]; then
    printf '{"action":"synchronize","number":%s,"pull_request":{"number":%s,"base":{"sha":%s,"ref":%s,"repo":{"full_name":%s}},"head":{"sha":%s,"ref":%s,"repo":{"full_name":%s}}},"repository":%s}\n' \
      "$EV_IID" "$EV_IID" "$(json_str "$EV_BASE")" "$(json_str "$EV_TGT")" "$repo" \
      "$(json_str "$EV_HEAD")" "$(json_str "$EV_SRC")" "$repo" "$repository"
  else
    printf '{"ref":%s,"before":%s,"after":%s,"head_commit":{"id":%s},"repository":%s}\n' \
      "$(json_str "$EV_REF")" "$(json_str "$EV_BEFORE")" "$(json_str "$EV_HEAD")" \
      "$(json_str "$EV_HEAD")" "$repository"
  fi
}

# Job ids from `act -l`: its rows start with a stage number; the header and warnings do not.
list_job_ids() { awk '$1 ~ /^[0-9]+$/ && NF >= 2 { print $2 }' | sort -u; }

# The verdict, from act's JSON log. jobResult is a top-level logrus field; the same text
# inside a step's output is JSON-escaped (\"), so a workflow cannot print its way to a pass.
# Skips are logged only at debug level, which is why act runs with --verbose.
verdict() {  # <listed job ids file> <act json log> <act exit code> <job needs file>
  local ids=$1 log=$2 rc=$3 needs=$4 bad=0 runs=0 unreached=0 table table_bad
  if [ ! -s "$ids" ]; then
    echo "  RED: act lists no job of this workflow for this event (a wiring error)"
    bad=1
  fi
  # act expands a matrix before it looks at the job's needs, so a matrix job whose needs were
  # skipped logs a matrix error and never starts, where GitHub would skip it. Such a job is
  # "not reached"; any other job with no result line at all is red.
  table=$(grep -o '"jobID":"[^"]*","jobResult":"[a-z]*"' "$log" |
    sed 's/^"jobID":"\([^"]*\)","jobResult":"\([a-z]*\)"$/\1 \2/' |
    awk 'phase == "ids" { if ($0 != "") order[++n] = $0; next }
      phase == "needs" { for (k = 2; k <= NF; k++) need[$1] = need[$1] " " $k; next }
      NF == 2 { c[$1, $2]++ }
      END {
        for (i = 1; i <= n; i++) {
          id = order[i]
          state[id] = c[id, "failure"] ? "failed" : c[id, "success"] ? "passed" : c[id, "skipped"] ? "skipped" : "none"
        }
        do {
          changed = 0
          for (i = 1; i <= n; i++) {
            id = order[i]
            if (state[id] != "none") continue
            m = split(need[id], ns, " ")
            for (k = 1; k <= m; k++) if (state[ns[k]] == "skipped" || state[ns[k]] == "unreached") { state[id] = "unreached"; changed = 1; break }
          }
        } while (changed)
        for (i = 1; i <= n; i++) {
          id = order[i]; ok = c[id, "success"] + 0; fail = c[id, "failure"] + 0
          runs += ok + fail
          if (state[id] == "failed") { printf "  %-30s FAILED (%d failed, %d passed)\n", id, fail, ok; bad = 1 }
          else if (state[id] == "passed") printf "  %-30s passed x%d\n", id, ok
          else if (state[id] == "skipped") printf "  %-30s skipped by its if:\n", id
          else if (state[id] == "unreached") { printf "  %-30s not reached: a job it needs was skipped\n", id; unreached++ }
          else { printf "  %-30s NEVER STARTED: no result line, and its needs ran\n", id; bad = 1 }
        }
        printf "#totals %d %d %d\n", runs + 0, bad + 0, unreached + 0
      }' phase=ids "$ids" phase=needs "$needs" phase=results - || true)
  # No totals line (awk itself failed) reads as red.
  printf '%s\n' "$table" | grep -v '^#totals ' || true
  read -r _ runs table_bad unreached <<<"$(printf '%s\n' "$table" | grep '^#totals ')"
  [ "${table_bad:-1}" -eq 0 ] || bad=1
  if [ "${runs:-0}" -eq 0 ]; then
    echo "  RED: act ran zero jobs"
    bad=1
  fi
  if grep -qF -e 'Error while evaluating matrix' -e "Error while get job's matrix" "$log" &&
    [ "${unreached:-0}" -eq 0 ]; then
    echo "  RED: act could not expand a matrix, and no skipped need explains it"
    bad=1
  fi
  if grep -qF 'Skipping unsupported platform' "$log"; then
    echo "  RED: act skipped a job whose runs-on label it could not map, and still exits 0"
    bad=1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "  RED: act exited $rc"
    bad=1
  fi
  return "$bad"
}

# A readable view of the JSON log: "[job] message", debug lines dropped. Display only;
# the verdict reads the raw log.
render() {
  awk '
    !/^\{/ { print; next }
    /"level":"debug"/ && !/"jobResult":/ { next }
    {
      job = ""; msg = ""
      if (match($0, /"job":"([^"\\]|\\.)*"/)) job = substr($0, RSTART + 7, RLENGTH - 8)
      if (match($0, /"msg":"([^"\\]|\\.)*"/)) msg = substr($0, RSTART + 7, RLENGTH - 8)
      sub(/(\\r)?\\n$/, "", msg)
      gsub(/\\u001b\[[0-9;]*m/, "", msg)
      gsub(/\\t/, "\t", msg)
      gsub(/\\"/, "\"", msg)
      print (job == "" ? "" : "[" job "] ") msg
    }'
}

self_test() {
  local t pass=0 failed=0
  t=$(mktemp -d)
  line() { printf '{"dryrun":false,"job":"W/%s","jobID":"%s","jobResult":"%s","level":"%s","matrix":{},"msg":"%s","time":"t"}\n' "$1" "$1" "$2" "${3:-info}" "${4:-Job done}"; }
  expect() {  # <name> <pass|fail> <ids> <log> <rc> [needs]
    local got=fail
    if verdict "$3" "$4" "$5" "${6:-$t/no-needs}" >"$t/out" 2>&1; then got=pass; fi
    if [ "$got" = "$2" ]; then pass=$((pass + 1)); else
      failed=$((failed + 1))
      echo "self-test FAILED: $1 (expected $2, got $got)"
      sed 's/^/    /' "$t/out"
    fi
  }
  : >"$t/no-needs"
  printf 'scope\nbuild\ntest\nall\n' >"$t/ids"
  { line scope success; line build success; line test success; line test success; line all success; } >"$t/green"
  expect "every listed job passed" pass "$t/ids" "$t/green" 0
  grep -v '"jobID":"test"' "$t/green" >"$t/no-test"
  expect "a matrix job that never started" fail "$t/ids" "$t/no-test" 0
  { cat "$t/green"; line build failure; } >"$t/failed"
  expect "a failed job" fail "$t/ids" "$t/failed" 0
  : >"$t/empty-log"
  expect "zero jobs ran" fail "$t/ids" "$t/empty-log" 0
  expect "act exit code non-zero" fail "$t/ids" "$t/green" 1
  { cat "$t/ids"; echo deploy; } >"$t/ids-plus"
  { cat "$t/green"; line deploy skipped debug "Skipping job"; } >"$t/skipped"
  expect "a job skipped by its if:" pass "$t/ids-plus" "$t/skipped" 0
  { cat "$t/green"; echo '{"level":"error","msg":"Error while evaluating matrix: bad","time":"t"}'; } >"$t/matrix"
  expect "a matrix act could not evaluate" fail "$t/ids" "$t/matrix" 0
  { cat "$t/green"; line scope success info 'Skipping unsupported platform -- Try running with -P'; } >"$t/platform"
  expect "an unmapped runs-on label" fail "$t/ids" "$t/platform" 0
  { cat "$t/no-test"; line build success info 'stdout: \"jobID\":\"test\",\"jobResult\":\"success\"'; } >"$t/forged"
  expect "a step printing a fake result" fail "$t/ids" "$t/forged" 0
  : >"$t/no-ids"
  expect "no job listed for the event" fail "$t/no-ids" "$t/green" 0
  printf 'scope\nbuild\n' >"$t/ids-two"
  { line scope skipped debug "Skipping job"; line build skipped debug "Skipping job"; } >"$t/all-skipped"
  expect "every job skipped, none ran" fail "$t/ids-two" "$t/all-skipped" 0
  # contracts-ci out of scope: build and slices skipped, the matrix job `test` and the job
  # `report` that needs it never start, act logs a matrix error. GitHub skips both.
  printf 'scope\nbuild\nslices\ntest\nreport\nall\n' >"$t/ids-m"
  printf 'scope \nbuild scope\nslices scope\ntest build slices\nreport test\nall scope build slices test\n' >"$t/needs-m"
  { line scope success; line build skipped debug "Skipping job"; line slices skipped debug "Skipping job"
    echo '{"level":"error","msg":"Error while evaluating matrix: Invalid JSON","time":"t"}'; line all success; } >"$t/unreached"
  expect "a matrix job whose needs were skipped" pass "$t/ids-m" "$t/unreached" 0 "$t/needs-m"
  expect "the same, with the needs unreadable" fail "$t/ids-m" "$t/unreached" 0 "$t/no-needs"
  { line scope success; line build success; line slices success
    echo '{"level":"error","msg":"Error while evaluating matrix: Invalid JSON","time":"t"}'; line all success; } >"$t/lost-matrix"
  expect "a matrix error whose needs all ran" fail "$t/ids-m" "$t/lost-matrix" 0 "$t/needs-m"

  local got
  got=$(json_str 'a"b\c')
  if [ "$got" = '"a\"b\\c"' ]; then pass=$((pass + 1)); else
    failed=$((failed + 1)); echo "self-test FAILED: json_str gave $got"
  fi
  got=$(printf '%s\n' 'Stage  Job ID  Job name  Workflow name  Workflow file  Events' \
    'WARN  something' '0      scope   scope     CI             ci.yml         push,pull_request' \
    '1      build   Build     CI             ci.yml         push,pull_request' \
    '1      build   Build     CI             ci.yml         push,pull_request' | list_job_ids | tr '\n' ' ')
  if [ "$got" = 'build scope ' ]; then pass=$((pass + 1)); else
    failed=$((failed + 1)); echo "self-test FAILED: list_job_ids gave '$got'"
  fi
  EVENT=pull_request EV_REPO='grp/repo' EV_IID=7 EV_TGT=$TRUNK EV_SRC='fix/a"b' \
    EV_BASE=$ZERO_SHA EV_HEAD=1111111111111111111111111111111111111111
  got=$(event_json)
  case $got in
    *'"number":7,"pull_request":{"number":7,'*'"head":{"sha":"1111111111111111111111111111111111111111","ref":"fix/a\"b"'*) pass=$((pass + 1)) ;;
    *) failed=$((failed + 1)); echo "self-test FAILED: event_json gave $got" ;;
  esac
  rm -rf "$t"
  echo "act-job self-test: $pass passed, $failed failed"
  [ "$failed" -eq 0 ]
}

main() {
  [ $# -eq 1 ] || die "usage: act-job.sh <workflow>.yml | --self-test"
  if [ "$1" = --self-test ]; then self_test; return; fi
  local wf=$1 repo
  [[ $wf =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || die "not a workflow file name: $wf"
  repo=$(git rev-parse --show-toplevel)
  cd "$repo"
  [ -f ".github/workflows/$wf" ] || die "no such workflow: .github/workflows/$wf"

  # Preconditions. Each one is a way a run could test something other than what GitLab asked.
  [ "$(id -u)" -ne 0 ] || die "refusing to run CI as root"
  [ ! -e .actrc ] || die "a committed .actrc would add act flags this wrapper does not control"
  local have
  have=$(act --version 2>/dev/null | awk '{ print $NF }') || true
  [ "$have" = "$ACT_VERSION" ] || die "act is '${have:-missing}', the pin is $ACT_VERSION (scripts/ci/runner/pins.env)"
  local security
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null) ||
    die "Docker is not reachable (DOCKER_HOST=${DOCKER_HOST:-unset})"
  case $security in
    *rootless*) ;;
    *) [ "${ACT_ALLOW_ROOTFUL_DOCKER:-}" = 1 ] ||
      die "Docker is not rootless: a job with a rootful daemon is root on this host (docs/CI_ON_GITLAB.md)" ;;
  esac
  EV_HEAD=${CI_COMMIT_SHA:-}
  is_sha "$EV_HEAD" || die "CI_COMMIT_SHA is not a commit sha: '$EV_HEAD'"
  [ "$(git rev-parse HEAD)" = "$EV_HEAD" ] || die "the checkout is not CI_COMMIT_SHA"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout has modified tracked files"

  EV_REPO=${CI_PROJECT_PATH:-}
  [[ $EV_REPO == */* ]] || die "CI_PROJECT_PATH is not group/project: '$EV_REPO'"
  case ${CI_PIPELINE_SOURCE:-} in
    merge_request_event)
      EVENT=pull_request
      EV_IID=${CI_MERGE_REQUEST_IID:-}
      [[ $EV_IID =~ ^[0-9]+$ ]] || die "CI_MERGE_REQUEST_IID is not a number: '$EV_IID'"
      EV_BASE=${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}
      is_sha "$EV_BASE" || { echo "act-job: no diff base sha; the scope jobs will run everything"; EV_BASE=""; }
      EV_SRC=${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-}
      EV_TGT=${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}
      ;;
    push)
      EVENT=push
      [ "${CI_COMMIT_BRANCH:-}" = "$TRUNK" ] || die "push pipelines replay only $TRUNK"
      EV_REF="refs/heads/$TRUNK"
      EV_BEFORE=${CI_COMMIT_BEFORE_SHA:-}
      is_sha "$EV_BEFORE" || EV_BEFORE=$ZERO_SHA
      ;;
    *) die "pipeline source '${CI_PIPELINE_SOURCE:-}' is not replayed (merge requests and $TRUNK pushes only)" ;;
  esac
  check_text CI_PROJECT_PATH "$EV_REPO"
  check_text "the source branch" "${EV_SRC:-}"
  check_text "the target branch" "${EV_TGT:-}"

  local jobs=${ACT_CONCURRENT_JOBS:-1} slot=${CI_CONCURRENT_ID:-0}
  [[ $jobs =~ ^[1-9][0-9]?$ ]] || die "ACT_CONCURRENT_JOBS must be 1-99, got '$jobs'"
  [[ $slot =~ ^[0-9]+$ ]] || slot=0
  local state=${ACT_STATE_DIR:-$HOME/.cache/tegridy-act}
  local run out="${CI_PROJECT_DIR:-$repo}/.act-out/${wf%.*}"
  run=$(mktemp -d "${TMPDIR:-/tmp}/act-job.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$run'" EXIT
  mkdir -p "$state/actions" "$state/cache" "$run/home" "$run/xdg" "$run/artifacts"
  : >"$run/empty"

  # With one job at a time (ACT_EXCLUSIVE_RUNNER, set by the runner setup), every act
  # container still present was left by a cancelled job.
  if [ "${ACT_EXCLUSIVE_RUNNER:-}" = 1 ]; then
    local stale
    stale=$(docker ps -aq --filter 'name=^act-') || stale=""
    if [ -n "$stale" ]; then
      echo "act-job: removing act containers left by a cancelled job"
      # shellcheck disable=SC2086
      docker rm -f $stale >/dev/null
    fi
  fi

  local tag img
  tag=$(cat "$HERE/act/Dockerfile" "$HERE/act/gh" | sha256sum | cut -c1-16)
  img="tegridy-act-platform:$tag"
  docker image inspect "$img" >/dev/null 2>&1 || docker build -t "$img" "$HERE/act"

  if [ "$EVENT" = push ]; then
    local inscope
    inscope=$(docker run --rm --network none -v "$repo:/w:ro" -w /w \
      -e BEFORE="$EV_BEFORE" -e AFTER="$EV_HEAD" "$img" \
      bash -c 'set -a; . /etc/environment; set +a; exec bash scripts/ci/act/push-paths.sh "$1"' \
      _ ".github/workflows/$wf") || inscope=true
    if [ "$inscope" = false ]; then
      mkdir -p "$out"
      echo "act-job: this push changes nothing under the on.push.paths of $wf, so GitHub would not start it. Not run." |
        tee "$out/not-run.txt"
      return 0
    fi
  fi

  docker run --rm --network none -v "$repo:/w:ro" -w /w "$img" \
    bash -c 'set -a; . /etc/environment; set +a; exec bash scripts/ci/act/job-needs.sh "$1"' \
    _ ".github/workflows/$wf" >"$run/needs" 2>/dev/null || : >"$run/needs"
  event_json >"$run/event.json"
  local common=(
    -W ".github/workflows/$wf"
    -P "ubuntu-latest=$img"
    --env-file "$run/empty" --secret-file "$run/empty"
    --var-file "$run/empty" --input-file "$run/empty"
  )
  HOME="$run/home" XDG_CONFIG_HOME="$run/xdg" act "$EVENT" "${common[@]}" -l >"$run/list.txt" 2>&1 ||
    { cat "$run/list.txt"; die "act -l failed"; }
  list_job_ids <"$run/list.txt" >"$run/ids"

  # --container-daemon-socket -: job containers never get the Docker socket. With it, job
  # code could start a container that mounts this host. No secret or token is passed.
  local args=(
    "${common[@]}"
    -e "$run/event.json"
    --pull=false
    --container-daemon-socket -
    --container-architecture linux/amd64
    --artifact-server-path "$run/artifacts"
    --artifact-server-port "$((34567 + slot))"
    --cache-server-path "$state/cache"
    --action-cache-path "$state/actions"
    --concurrent-jobs "$jobs"
    --defaultbranch "$TRUNK"
    --env "GITHUB_REPOSITORY=$EV_REPO"
    --env "GITHUB_REPOSITORY_OWNER=${EV_REPO%%/*}"
    --rm
    --json
    --verbose
  )
  local ref
  for ref in $(grep -o 'github/codeql-action/upload-sarif@[0-9a-f]\{40\}' ".github/workflows/$wf" | sed 's/.*@//' | sort -u); do
    args+=(--local-repository "github/codeql-action@$ref=$HERE/act/codeql-action-stub")
  done

  echo "act-job: act $ACT_VERSION, $EVENT, .github/workflows/$wf, image $img"
  local rc
  set +e
  (env -u GITHUB_TOKEN -u GH_TOKEN HOME="$run/home" XDG_CONFIG_HOME="$run/xdg" \
    act "$EVENT" "${args[@]}" 2>&1) | tee --output-error=warn-nopipe "$run/act.jsonl" | render
  rc=${PIPESTATUS[0]}
  set -e
  # Written only now: act copies the checkout into every job container.
  mkdir -p "$out"
  cp "$run/act.jsonl" "$run/event.json" "$out/"
  cp -R "$run/artifacts" "$out/" 2>/dev/null || true

  echo "act-job: verdict for $wf ($EVENT)"
  if verdict "$run/ids" "$run/act.jsonl" "$rc" "$run/needs"; then
    echo "act-job: GREEN"
  else
    echo "act-job: RED (full log: .act-out/${wf%.*}/act.jsonl)"
    return 1
  fi
}

main "$@"
