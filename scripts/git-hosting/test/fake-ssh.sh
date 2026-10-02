#!/usr/bin/env bash
# test-mirror.sh puts this first on PATH as `ssh`. It refuses (exit 255, like ssh) unless it gets
# every option the mirror promises: the pinned host key file, strict checking, only the deploy key,
# a key file readable by its owner alone. Then it serves FAKE_SSH_REPO for whatever path git asks.
# Each call adds one line to FAKE_SSH_LOG, so a test can prove this ran and not the real ssh.
set -u
no() { echo "fake ssh: $*" >&2; echo "REFUSED $*" >> "$FAKE_SSH_LOG"; exit 255; }
key='' kh='' opts=' '
while (($#)); do
  case $1 in
    -G) exit 0 ;;
    -i) key=$2; shift ;;
    -o) opts+="$2 "; if [[ $2 == UserKnownHostsFile=* ]]; then kh=${2#*=}; fi; shift ;;
    -p) shift ;;
    -*) ;;
    *) break ;;
  esac
  shift
done
host=${1:-} cmd=${2:-}
for o in StrictHostKeyChecking=yes BatchMode=yes IdentitiesOnly=yes HostKeyAlgorithms=ssh-ed25519; do
  [[ $opts == *" $o "* ]] || no "missing -o $o"
done
[[ -n $kh && $(cat "$kh" 2>/dev/null) == "$FAKE_SSH_HOST_KEY" ]] || no "UserKnownHostsFile is not the pinned host key"
[[ -n $key && $(cat "$key" 2>/dev/null) == "$FAKE_SSH_KEY" ]] || no "-i is not the deploy key"
if [[ $OSTYPE != msys* && $OSTYPE != cygwin* ]]; then   # Git Bash reports every file as 644
  mode=$(stat -c %a "$key"); [[ $mode == 600 ]] || no "the key file is mode $mode, not 600"
fi
[[ $host == "$FAKE_SSH_HOST" ]] || no "host '$host', not $FAKE_SSH_HOST"
case $cmd in
  "git-receive-pack '"*"'") verb=receive-pack ;;
  "git-upload-pack '"*"'") verb=upload-pack ;;
  *) no "unexpected command '$cmd'" ;;
esac
echo "OK $verb" >> "$FAKE_SSH_LOG"
exec git "$verb" "$FAKE_SSH_REPO"
