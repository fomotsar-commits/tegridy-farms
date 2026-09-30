#!/usr/bin/env bash
# Sets up the GitLab runner in a DEDICATED WSL2 distro (or a plain Ubuntu 24.04 VPS). The
# owner runs it as root inside that distro, never in the everyday one. Phase 1 (WSL only)
# cuts the distro off from Windows and stops; restart it and run the copy left in /root.
# Phase 2 installs rootless Docker and the pinned act, gitleaks and gitlab-runner, runs
# jobs as the unprivileged user `ci`, and registers the runner. See docs/CI_ON_GITLAB.md.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nsetup-wsl-runner: %s\n' "$*" >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -f "$HERE/pins.env" ] || die "pins.env must sit next to this script"
# shellcheck source=pins.env
. "$HERE/pins.env"
GITLAB_URL=${GITLAB_URL:-https://gitlab.com}
CI_USER=ci
STAGE=/root/tegridy-runner-setup

[ "$(id -u)" -eq 0 ] || die "run as root: wsl -d <distro> -u root -- bash <path to this file>"
grep -q 'VERSION_ID="24.04"' /etc/os-release || die "this script targets Ubuntu 24.04"
[ "$(uname -m)" = x86_64 ] || die "the pins are for x86_64"

is_wsl=false
grep -qi microsoft /proc/version && is_wsl=true

# ---------------------------------------------------------------- phase 1 (WSL only)
# automount off: Windows drives (and the keys on them) are not mounted. interop off:
# nothing in here can start a Windows program. systemd: rootless Docker needs a user
# manager. This only takes effect after `wsl --terminate`, so phase 1 stops here.
if $is_wsl && ! grep -q '^# tegridy-runner isolation' /etc/wsl.conf 2>/dev/null; then
  say "phase 1: isolating this distro from Windows"
  if [ -n "$(ls -A /home 2>/dev/null)" ]; then
    echo "note: /home is not empty ($(ls /home | tr '\n' ' ')). Use a FRESH distro for the runner, never a copy of an everyday one."
  fi
  cat >/etc/wsl.conf <<'EOF'
# tegridy-runner isolation (scripts/ci/runner/setup-wsl-runner.sh)
[boot]
systemd=true

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false
EOF
  mkdir -p "$STAGE"
  tr -d '\r' <"$HERE/setup-wsl-runner.sh" >"$STAGE/setup-wsl-runner.sh"
  tr -d '\r' <"$HERE/pins.env" >"$STAGE/pins.env"
  chmod 0700 "$STAGE" "$STAGE/setup-wsl-runner.sh"
  distro=${WSL_DISTRO_NAME:-<this distro>}
  say "phase 1 done. In PowerShell on Windows, run:"
  echo "    wsl --terminate $distro"
  echo "    wsl -d $distro -u root -- bash $STAGE/setup-wsl-runner.sh"
  exit 0
fi

# A Windows drive: a drvfs mount, or anything mounted at /mnt/<letter>. (WSL's read-only
# GPU driver folder under /usr/lib/wsl is a different mount and is expected.)
windows_drives() { awk '$3 == "drvfs" || $4 ~ /aname=drvfs/ || $2 ~ /^\/mnt\/[a-z]$/' /proc/mounts; }

# ---------------------------------------------------------------- phase 2
# These must match scripts/ci/runner/pins.env on trunk, or every job refuses to run.
say "phase 2: act $ACT_VERSION, gitleaks $GITLEAKS_VERSION, gitlab-runner $GITLAB_RUNNER_VERSION (from $HERE/pins.env)"
if $is_wsl; then
  say "checking the isolation is live"
  if [ -n "$(windows_drives)" ]; then
    windows_drives
    die "a Windows drive is still mounted. Run 'wsl --terminate <distro>' from PowerShell, then this again."
  fi
  if ls /proc/sys/fs/binfmt_misc/ 2>/dev/null | grep -qi wslinterop; then
    die "Windows interop is still on. Run 'wsl --terminate <distro>' from PowerShell, then this again."
  fi
  [ -d /run/systemd/system ] || die "systemd is not running; check [boot] systemd=true in /etc/wsl.conf and restart the distro"
  if [ -d /mnt/wsl ] && [ -n "$(ls -A /mnt/wsl 2>/dev/null)" ]; then
    echo "note: /mnt/wsl (shared by every WSL distro) has files; root in any distro can read them."
  fi
fi

say "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg uidmap dbus-user-session slirp4netns systemd-container >/dev/null

say "Docker Engine from Docker's signed apt repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras >/dev/null
# No root daemon at all: a job that can reach a root Docker daemon is root on this host.
systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
rm -f /var/run/docker.sock

say "the job user '$CI_USER': no sudo, no docker group"
id "$CI_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$CI_USER"
for group in sudo docker adm lxd; do gpasswd -d "$CI_USER" "$group" >/dev/null 2>&1 || true; done
rm -f "/etc/sudoers.d/$CI_USER"
grep -q "^$CI_USER:" /etc/subuid || usermod --add-subuids 300000-365535 "$CI_USER"
grep -q "^$CI_USER:" /etc/subgid || usermod --add-subgids 300000-365535 "$CI_USER"
CI_UID=$(id -u "$CI_USER")
CI_HOME=$(getent passwd "$CI_USER" | cut -d: -f6)
RUNTIME=/run/user/$CI_UID

say "open-file limit for the solana test validator"
mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nLimitNOFILE=1048576\n' >/etc/systemd/system/user@.service.d/limits.conf
systemctl daemon-reload
loginctl enable-linger "$CI_USER"
systemctl restart "user@$CI_UID.service"
for _ in $(seq 1 20); do [ -S "$RUNTIME/bus" ] && break; sleep 1; done
[ -S "$RUNTIME/bus" ] || die "the user manager for $CI_USER did not start"

# Ubuntu 24.04 may block unprivileged user namespaces, which rootless Docker needs.
# Docker's documented fix: an AppArmor profile that allows them for rootlesskit only.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  say "allowing user namespaces for rootlesskit (AppArmor)"
  cat >/etc/apparmor.d/usr.bin.rootlesskit <<'EOF'
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/usr.bin.rootlesskit>
}
EOF
  systemctl restart apparmor.service
fi

as_ci() { runuser -u "$CI_USER" -- env HOME="$CI_HOME" XDG_RUNTIME_DIR="$RUNTIME" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME/bus" "$@"; }

say "rootless Docker for $CI_USER"
as_ci dockerd-rootless-setuptool.sh install >/dev/null
as_ci mkdir -p "$CI_HOME/.config/docker"
cat >"$CI_HOME/.config/docker/daemon.json" <<'EOF'
{
  "default-ulimits": { "nofile": { "Name": "nofile", "Hard": 1048576, "Soft": 1048576 } }
}
EOF
chown "$CI_USER:$CI_USER" "$CI_HOME/.config/docker/daemon.json"
as_ci systemctl --user enable docker.service >/dev/null
as_ci systemctl --user restart docker.service
as_ci env DOCKER_HOST="unix://$RUNTIME/docker.sock" docker info --format '{{json .SecurityOptions}}' | grep -q rootless ||
  die "Docker for $CI_USER is not rootless"

# fetch <url> <sha256> <file>: download and refuse anything whose hash is not the pin.
fetch() {
  curl -fsSL "$1" -o "$3"
  echo "$2  $3" | sha256sum -c --quiet - || die "sha256 mismatch for $1"
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

say "act $ACT_VERSION"
fetch "https://github.com/nektos/act/releases/download/v$ACT_VERSION/act_Linux_x86_64.tar.gz" \
  "$ACT_LINUX_X86_64_SHA256" "$work/act.tar.gz"
tar -xzf "$work/act.tar.gz" -C "$work" act
install -m 0755 "$work/act" /usr/local/bin/act

say "gitleaks $GITLEAKS_VERSION"
fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  "$GITLEAKS_LINUX_X64_SHA256" "$work/gitleaks.tar.gz"
tar -xzf "$work/gitleaks.tar.gz" -C "$work" gitleaks
install -m 0755 "$work/gitleaks" /usr/local/bin/gitleaks

say "gitlab-runner $GITLAB_RUNNER_VERSION"
fetch "https://gitlab-runner-downloads.s3.amazonaws.com/v$GITLAB_RUNNER_VERSION/binaries/gitlab-runner-linux-amd64" \
  "$GITLAB_RUNNER_LINUX_AMD64_SHA256" "$work/gitlab-runner"
install -m 0755 "$work/gitlab-runner" /usr/local/bin/gitlab-runner

# The runner runs as ci, never root, and cannot gain privileges (no setuid, no sudo).
say "runner service"
cat >/etc/systemd/system/tegridy-gitlab-runner.service <<EOF
[Unit]
Description=GitLab Runner for tegridy-farms (shell executor, user $CI_USER)
After=network-online.target user@$CI_UID.service
Wants=network-online.target
Requires=user@$CI_UID.service

[Service]
User=$CI_USER
Group=$CI_USER
Environment=HOME=$CI_HOME
Environment=XDG_RUNTIME_DIR=$RUNTIME
Environment=DOCKER_HOST=unix://$RUNTIME/docker.sock
ExecStart=/usr/local/bin/gitlab-runner run --working-directory $CI_HOME --config $CI_HOME/.gitlab-runner/config.toml
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$CI_HOME $RUNTIME
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

CONFIG=$CI_HOME/.gitlab-runner/config.toml
if [ ! -s "$CONFIG" ]; then
  say "register the runner"
  echo "In GitLab: the project > Settings > CI/CD > Runners > New project runner."
  echo "  Tags: tegridy-runner. Run untagged jobs: OFF. Maximum job timeout: 3 hours (10800)."
  echo "Paste the runner authentication token (starts with glrt-). It is not echoed."
  read -rs -p "token: " token
  echo
  [[ $token == glrt-* ]] || die "that is not a runner authentication token (glrt-...)"
  as_ci mkdir -p "$CI_HOME/.gitlab-runner"
  as_ci gitlab-runner register --non-interactive --token "$token" \
    --config "$CONFIG" --url "$GITLAB_URL" --executor shell --shell bash \
    --name "tegridy-runner-$(hostname)" --output-limit 65536 \
    --env "ACT_EXCLUSIVE_RUNNER=1" --env "DOCKER_HOST=unix://$RUNTIME/docker.sock" \
    --env "XDG_RUNTIME_DIR=$RUNTIME" >/dev/null
  unset token
fi
# One job at a time: the act containers share one network, and memory is shared with Windows.
sed -i 's/^concurrent = .*/concurrent = 1/' "$CONFIG"
chown -R "$CI_USER:$CI_USER" "$CI_HOME/.gitlab-runner"
chmod 0600 "$CONFIG"
systemctl enable --now tegridy-gitlab-runner.service >/dev/null

say "checks"
printf '  %-34s %s\n' "act" "$(act --version)"
printf '  %-34s %s\n' "gitleaks" "$(gitleaks version)"
printf '  %-34s %s\n' "gitlab-runner" "$(gitlab-runner --version | head -n 1)"
printf '  %-34s %s\n' "rootful docker daemon" "$(systemctl is-active docker.service 2>/dev/null || true)"
printf '  %-34s %s\n' "groups of $CI_USER" "$(id -nG "$CI_USER")"
printf '  %-34s %s\n' "runner service" "$(systemctl is-active tegridy-gitlab-runner.service)"
if $is_wsl; then
  printf '  %-34s %s\n' "Windows drives mounted" "$(windows_drives | wc -l)"
fi
say "done. Push a branch, open a merge request, and watch the pipeline-exists job pick up."
