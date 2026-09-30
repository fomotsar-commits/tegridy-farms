#!/usr/bin/env bash
# The merge-blocking gates, run on this machine with no git host and no runner.
#   bash scripts/ci/local-gates.sh <root|frontend|contracts|solana|all>
# Each `gate` line runs a command CI runs, word for word; gitlabCi.test.ts fails if one is
# not in a workflow or .gitlab-ci.yml. A gate CI runs as an inline script is listed as
# "CI only" rather than copied here. Git Bash on Windows, or any Linux shell.
set -uo pipefail

AREA=${1:-}
case $AREA in
  root | frontend | contracts | solana | all) ;;
  *)
    echo "usage: local-gates.sh <root|frontend|contracts|solana|all>" >&2
    exit 2
    ;;
esac
ROOT=$(git rev-parse --show-toplevel) || exit 2
# A synced folder: under a OneDrive root Windows names, or a folder named OneDrive or
# "OneDrive - <org>". A path that only contains the word (agent scratch folders) is fine.
in_onedrive() {
  local p=$1 r
  command -v cygpath >/dev/null 2>&1 && p=$(cygpath -u "$p")
  for r in "${OneDrive:-}" "${OneDriveConsumer:-}" "${OneDriveCommercial:-}"; do
    [ -n "$r" ] || continue
    command -v cygpath >/dev/null 2>&1 && r=$(cygpath -u "$r")
    r=${r%/}
    case ${p,,}/ in "${r,,}"/*) return 0 ;; esac
  done
  case $p/ in */OneDrive/* | */OneDrive\ -\ */*) return 0 ;; esac
  return 1
}
if in_onedrive "$ROOT"; then
  echo "refusing: $ROOT is inside OneDrive, where placeholder files break the scanners (CLAUDE.md law 14)" >&2
  exit 2
fi
export CI=true
RESULTS=()

want() { [ "$AREA" = all ] || [ "$AREA" = "$1" ]; }
have() { command -v "$1" >/dev/null 2>&1; }
# <area> <label> <dir from the repo root> <command...>. Keep each call on one line:
# the test reads the command from this file.
gate() {
  local area=$1 label=$2 dir=$3 start=$SECONDS status
  shift 3
  want "$area" || return 0
  printf '\n=== [%s] %s  (in %s: %s)\n' "$area" "$label" "$dir" "$*"
  if (cd "$ROOT/$dir" && "$@"); then status=PASS; else status=FAIL; fi
  RESULTS+=("$area|$label|$status|$((SECONDS - start))s")
}
note() { want "$1" && RESULTS+=("$1|$2|$3|$4"); return 0; }
# A value the workflows define, read from them now so it cannot drift: <file> <sed expression>.
from_workflow() { sed -n "$2" "$ROOT/.github/workflows/$1" | head -n 1; }

# ---- root: the tools ci.yml self-tests at the repo root, and this CI's own wrapper
gate root "program constants self-test" . node scripts/verify-program-constants.mjs --self-test
gate root "pre-deploy guard self-test" . node scripts/predeploy-check.mjs --self-test
gate root "ownership verifier self-test" . node scripts/verify-ownership.mjs --self-test
gate root "one-shot guard self-test" . node scripts/oneshot-guard.mjs --self-test
gate root "monitoring rules" . node --test contracts/monitoring/lib/arbLinkage.test.mjs scripts/monitoring/lib/pausePlan.test.mjs
gate root "endpoint redaction" . node --test scripts/lib/redact-url.test.mjs
gate root "act wrapper verdict self-test" . bash scripts/ci/act-job.sh --self-test

# ---- frontend: ci.yml's Lint, Type Check & Test, Build and E2E Tests jobs
if want frontend; then
  if [ "${LOCAL_GATES_SKIP_INSTALL:-}" = 1 ]; then
    note frontend "install (npm ci)" SKIP "LOCAL_GATES_SKIP_INSTALL=1"
    rm -f "$ROOT"/frontend/node_modules/.tmp/*.tsbuildinfo # a stale one lets tsc -b skip work
  else
    gate frontend "install (npm ci)" frontend npm ci --ignore-scripts
  fi
fi
gate frontend "no npm lifecycle hooks" frontend node scripts/check-no-lifecycle-hooks.mjs
gate frontend "lint" frontend npm run lint
gate frontend "type check" frontend npx tsc -b --noEmit
gate frontend "unit tests" frontend npm test
gate frontend "discord invites resolve (network)" frontend node scripts/verify-discord-invites.mjs
gate frontend "indexer-solana tests" frontend npx vitest run --root ../indexer-solana --environment node
gate frontend "bot tests" frontend npx vitest run --root ../bot --environment node
gate frontend "address registry" frontend node scripts/verify-addresses.mjs
gate frontend "address registry self-test" frontend node scripts/verify-addresses.mjs --self-test
gate frontend "outage-as-zero ratchet" frontend node scripts/check-unread-signal.mjs
gate frontend "outage-as-zero self-test" frontend node scripts/check-unread-signal.mjs --self-test
gate frontend "build" frontend npm run build
gate frontend "playwright browsers" frontend npx playwright install --with-deps chromium webkit
gate frontend "e2e" frontend npx playwright test
note frontend "e2e on an anvil fork" "CI only" "needs Foundry at the CI pin, an archive RPC and jq"
note frontend "npm advisories" "CI only" "npm-advisories.yml, run by GitLab CI (needs the npm registry)"

# ---- contracts: contracts-ci.yml's build, slices, test matrix, fuzz and provenance jobs
if want contracts; then
  gate contracts "test-slice coverage guard" . node scripts/check-test-slice-coverage.mjs
  gate contracts "V2 provenance" . node scripts/check-v2-provenance.mjs
  if [ -e "$ROOT/contracts/.env" ]; then
    note contracts "forge gates" FAIL "contracts/.env exists and forge loads it into every test; use a checkout without it"
  elif ! have forge; then
    note contracts "forge gates" SKIP "forge is not on PATH"
  else
    pin=$(from_workflow contracts-ci.yml 's/^ *version: *\(v[0-9][0-9.]*\) *$/\1/p')
    forge_now=$(forge --version 2>/dev/null | head -n 1)
    case $forge_now in
      *"${pin#v}"*) ;;
      *) note contracts "forge version" WARN "CI pins ${pin:-?}; this is '$forge_now'" ;;
    esac
    export FOUNDRY_FUZZ_RUNS FOUNDRY_INVARIANT_RUNS FOUNDRY_INVARIANT_DEPTH FUZZ_MATCH_TEST
    FOUNDRY_FUZZ_RUNS=$(from_workflow contracts-ci.yml 's/^ *FOUNDRY_FUZZ_RUNS: *\([0-9]*\) *$/\1/p')
    FOUNDRY_INVARIANT_RUNS=$(from_workflow contracts-ci.yml 's/^ *FOUNDRY_INVARIANT_RUNS: *\([0-9]*\) *$/\1/p')
    FOUNDRY_INVARIANT_DEPTH=$(from_workflow contracts-ci.yml 's/^ *FOUNDRY_INVARIANT_DEPTH: *\([0-9]*\) *$/\1/p')
    FUZZ_MATCH_TEST=$(from_workflow contracts-ci.yml 's/^ *FUZZ_MATCH_TEST: *"\(.*\)" *$/\1/p')
    gate contracts "forge build (src)" contracts forge build --skip test --skip script
    note contracts "bytecode size budget" "CI only" "an inline step in contracts-ci.yml that needs jq"
    gate contracts "interface + ABI selector guard" contracts node ../scripts/check-interface-selectors.mjs
    gate contracts "ABI supplement regenerated" . node frontend/scripts/extract-missing-abis.mjs
    gate contracts "ABI supplement unchanged" . git diff --quiet -- frontend/src/lib/abi-supplement.ts
    # The matrix CI runs, from the command CI builds it with.
    matrix=$(cd "$ROOT" && node scripts/check-test-slice-coverage.mjs --emit-matrix |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).include)console.log([m.slice,m.pattern,m.noMatchTest].join("\t"))})')
    if [ -z "$matrix" ]; then
      note contracts "forge test matrix" FAIL "the slice manifest produced no matrix"
    fi
    while IFS=$'\t' read -r SLICE_NAME SLICE_PATTERN SLICE_NO_MATCH_TEST; do
      [ -n "$SLICE_NAME" ] || continue
      export SLICE_NAME SLICE_PATTERN SLICE_NO_MATCH_TEST
      gate contracts "slice $SLICE_NAME: file set" . node scripts/check-test-slice-coverage.mjs --verify-slice "$SLICE_NAME"
      gate contracts "slice $SLICE_NAME: forge test" contracts forge test --match-path "$SLICE_PATTERN" --no-match-test "$SLICE_NO_MATCH_TEST"
    done <<<"$matrix"
    if [ -n "$FUZZ_MATCH_TEST" ]; then
      gate contracts "fuzz + invariant harnesses" contracts forge test --match-test "$FUZZ_MATCH_TEST"
    else
      note contracts "fuzz + invariant harnesses" FAIL "could not read FUZZ_MATCH_TEST from contracts-ci.yml"
    fi
    note contracts "fuzz selection is non-empty" "CI only" "an inline step in contracts-ci.yml that needs jq"
  fi
  note contracts "slither" "CI only" "slither.yml runs it through crytic/slither-action"
fi

# ---- solana: the parts of solana-ci.yml that need only rustc and cargo
if want solana; then
  if have rustc; then
    gate solana "launch curve math: compile" solana/tegridy-amm/programs/tegridy-launch rustc --edition 2021 --test src/curve.rs -o /tmp/curve_test
    gate solana "launch curve math: run" . /tmp/curve_test
    gate solana "ladder math: compile" solana/tegridy-amm/programs/bayla-ladder rustc --edition 2021 --test src/math.rs -o /tmp/ladder_math
    gate solana "ladder math: run" . /tmp/ladder_math
  else
    note solana "curve and ladder math" SKIP "rustc is not on PATH"
  fi
  if have cargo; then
    gate solana "ladder layout pins" solana/tegridy-amm/programs/bayla-ladder cargo test --lib -- layout_tests
    gate solana "ladder layout pins (devnet)" solana/tegridy-amm/programs/bayla-ladder cargo test --lib --features devnet -- layout_tests
  else
    note solana "ladder layout pins" SKIP "cargo is not on PATH"
  fi
  note solana "diff-guard, SBF builds, validator suites" "CI only" "need the Agave and Anchor toolchains; WSL recipe in docs/CI_ON_GITLAB.md"
fi

printf '\n%-10s %-44s %-8s %s\n' AREA GATE RESULT TIME/WHY
red=0
for row in "${RESULTS[@]}"; do
  IFS='|' read -r a label status extra <<<"$row"
  printf '%-10s %-44s %-8s %s\n' "$a" "$label" "$status" "$extra"
  [ "$status" = FAIL ] && red=1
done
if [ "$red" -eq 0 ]; then echo "local gates ($AREA): no gate failed"; else echo "local gates ($AREA): RED"; fi
exit "$red"
