#!/bin/sh
# git-hosting pre-push hook. set-remotes.sh installs it as the clone's pre-push; re-run it to update.
# git pushes to each push URL in turn, and goes on after one refuses: a push GitHub's secret
# scanning blocked would still reach the public standby. So every push URL after a remote's first
# takes a ref only when the first URL already holds it exactly as pushed (or, for a delete, not at all).
first=$(git remote get-url --push --all "$1" 2>/dev/null | head -n 1)
if [ -z "$first" ] || [ "$2" = "$first" ]; then exit 0; fi

held=$(mktemp) || exit 1
trap 'rm -f "$held"' EXIT
if ! git ls-remote --refs "$first" > "$held" < /dev/null; then
  echo "pre-push: nothing sent to $2: could not read $first, so it may not hold this push." >&2
  exit 1
fi
# stdin, one line per ref: <local ref> <local sha> <remote ref> <remote sha>; all zeros: a delete.
FIRST=$first TO=$2 HELD=$held awk 'BEGIN { while ((getline l < ENVIRON["HELD"]) > 0) { split(l, f, "\t"); has[f[2]] = f[1] } }
  { want = ($2 ~ /[^0]/) ? $2 : ""; now = ($3 in has) ? has[$3] : ""
    if (now != want) { bad = 1
      printf "pre-push: %s not sent to %s: %s holds %s there, not %s.\n", $3, ENVIRON["TO"],
        ENVIRON["FIRST"], (now == "" ? "nothing" : now), (want == "" ? "nothing" : want) } }
  END { if (bad) {
      printf "pre-push: %s refused this push or moved since. The mirror copies only what it took\n", ENVIRON["FIRST"]
      print "          (docs/GIT_HOSTING.md, section 3). Never retry with force."; exit 1 } }' >&2
