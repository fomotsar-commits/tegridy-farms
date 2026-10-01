#!/usr/bin/env bash
# Prints one line per job of a workflow: "<job id> <need> <need> ...". Runs inside the act
# image (it has yq). act-job.sh uses it to tell a job that never started because a need was
# skipped (GitHub skips it too) from one that never started for no reason. Prints nothing
# when it cannot read the file, which makes every never-started job count as red.
set -uo pipefail
yq '.jobs | to_entries | .[] | .key + " " + ([.value.needs // []] | flatten | join(" "))' "$1" 2>/dev/null |
  tr -d '\r' || true
