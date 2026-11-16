#!/usr/bin/env bash
# Installs the Solana build tools from release files checked against the sha256 kept here, so no
# downloaded installer runs unchecked. `solana <version>` lays the Agave release out as its own
# installer does and places the platform-tools that release's cargo-build-sbf compiles with;
# `anchor <version>` places the Anchor binary and the platform-tools avm links, before avm runs.
# Usage: bash "$GITHUB_WORKSPACE/.github/scripts/solana-tools.sh" solana v2.3.0 | anchor 0.32.1
set -euo pipefail

fetch() { # <url> <sha256> <file>
  curl -sSfL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "::error::$1 does not hash to the pinned $2"; exit 1; }
}
platform_tools() { # <version> <sha256>, into the cache cargo-build-sbf and avm both read
  local dir="$HOME/.cache/solana/$1/platform-tools"
  fetch "https://github.com/anza-xyz/platform-tools/releases/download/$1/platform-tools-linux-x86_64.tar.bz2" "$2" /tmp/platform-tools.tar.bz2
  mkdir -p "$dir"
  tar -xjf /tmp/platform-tools.tar.bz2 -C "$dir"
  rm /tmp/platform-tools.tar.bz2
}

case "${1:-} ${2:-}" in
  "solana v2.3.0") release=56241fbe862495ff01b2b875195e44f94c22e9f2a504591a3ade1b9d82862730 tools=v1.48 tools_sha=a9d3157f937d5f6faf4321a35a8035e0f827114a663b0150db492e893ec27597 ;;
  "solana v3.1.10") release=a7205ff29bcf0f7199740225ecae2b85a28ea9668892d5ec21bd9749882984a1 tools=v1.52 tools_sha=8b3861e93daf085ec12b65c4fac374d9bec4587a3de16871da6b08ab0c1d907e ;;
  "anchor 0.32.1")
    mkdir -p "$HOME/.avm/bin"
    fetch "https://github.com/otter-sec/anchor/releases/download/v$2/anchor-$2-x86_64-unknown-linux-gnu" 5f25b850ce80278507a98947833fcd48423391f6d145046ffb0c5fd130dec436 "$HOME/.avm/bin/anchor-$2"
    chmod +x "$HOME/.avm/bin/anchor-$2"
    platform_tools v1.51.1 84275b66d4459ac74a5b05606e645f50603c4f5c19ab7425698f19269acfc080
    exit 0 ;;
  *) echo "::error::no pinned sha256 for \"$*\""; exit 1 ;;
esac

root="$HOME/.local/share/solana/install"
fetch "https://github.com/anza-xyz/agave/releases/download/$2/solana-release-x86_64-unknown-linux-gnu.tar.bz2" "$release" /tmp/solana-release.tar.bz2
mkdir -p "$root/releases/${2#v}"
tar -xjf /tmp/solana-release.tar.bz2 -C "$root/releases/${2#v}"
rm /tmp/solana-release.tar.bz2
ln -sfn "$root/releases/${2#v}/solana-release" "$root/active_release"
platform_tools "$tools" "$tools_sha"
