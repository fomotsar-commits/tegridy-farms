#!/usr/bin/env bash
# Proves solana/tegridy-clmm is raydium-clmm at the pinned commit plus exactly the reviewed
# identity patch: same files, only the named files differ, the delta inside them hashes to
# the pinned value, LICENSE is upstream's, and every locked crate is one upstream locked.
#   bash solana/guards/clmm-provenance.sh <upstream dir> [<our workspace dir>]
# A missing upstream dir is cloned at the pin. Run from the repo root.
set -euo pipefail

UPSTREAM_REPO=https://github.com/raydium-io/raydium-clmm
# The live mainnet program CAMMCzo5... was last deployed at slot 451,479,902
# (2026-09-29 00:27 UTC) and carries text that first appears in this commit's tree.
UPSTREAM_COMMIT=ed1eb41519d5355755f7df52b43fa9610938b60b
# Pinned 2026-10-14: 99 changed lines in 12 files. Nine roles (program id, admin, limit-order
# admin, spare-SOL collector, fund-fee owner, protocol-fee owner, permission admin, support-mint
# owner, frozen-NFT issuer list) on both cfg arms, the security text, the position NFT's name,
# symbol and link, three memos, the placeholder gate and feature, one test literal, comments.
EXPECTED_DELTA_SHA256=387bc221b066088d66e8c28eca0413fb20ccccf22fc55816e6040d444e499a8d

UP=${1:?usage: clmm-provenance.sh <upstream dir> [<our workspace dir>]}
OURS=${2:-solana/tegridy-clmm}

if [ ! -d "$UP/.git" ]; then
  git clone --quiet "$UPSTREAM_REPO" "$UP"
  git -C "$UP" -c core.autocrlf=false checkout --quiet "$UPSTREAM_COMMIT"
fi
HEAD_NOW=$(git -C "$UP" rev-parse HEAD)
if [ "$HEAD_NOW" != "$UPSTREAM_COMMIT" ]; then
  echo "::error::$UP is at $HEAD_NOW, not the pinned $UPSTREAM_COMMIT"
  exit 1
fi

# The files the identity patch may touch, relative to the workspace. Nothing else may differ.
ALLOWED=(
  Anchor.toml
  Cargo.toml
  programs/amm/Cargo.toml
  programs/amm/src/lib.rs
  programs/amm/src/instructions/admin/create_permission_pda.rs
  programs/amm/src/instructions/admin/create_support_mint_associated.rs
  programs/amm/src/instructions/collect_remaining_rewards.rs
  programs/amm/src/instructions/decrease_liquidity.rs
  programs/amm/src/instructions/open_position.rs
  programs/amm/src/instructions/swap_v2.rs
  programs/amm/src/states/tickarray_bitmap_extension.rs
  programs/amm/src/util/token.rs
)
# Ours alone: upstream has no such file. Cargo.lock is held by the crate check below.
OURS_ONLY=(README.md)

fail=0

# 1. Our workspace holds upstream's program and root files, plus OURS_ONLY, and nothing else.
expected=$( { (cd "$UP" && find programs/amm -type f); printf '%s\n' Anchor.toml Cargo.toml Cargo.lock LICENSE "${OURS_ONLY[@]}"; } | LC_ALL=C sort)
actual=$( (cd "$OURS" && find . -type f -not -path './target/*' | sed 's|^\./||') | LC_ALL=C sort)
if [ "$expected" != "$actual" ]; then
  echo "::error::tegridy-clmm's files are not upstream's program files plus ${OURS_ONLY[*]}:"
  diff <(echo "$expected") <(echo "$actual") || true
  fail=1
fi

# 2. Outside ALLOWED, every shared file is byte for byte upstream's (line endings aside).
is_allowed() { local f; for f in "${ALLOWED[@]}"; do [ "$f" = "$1" ] && return 0; done; return 1; }
checked=0
while IFS= read -r f; do
  [ -f "$OURS/$f" ] || continue
  checked=$((checked + 1))
  if ! is_allowed "$f" && ! cmp -s <(sed 's/\r$//' "$UP/$f") <(sed 's/\r$//' "$OURS/$f"); then
    echo "::error::$f differs from upstream and is not an identity file"
    fail=1
  fi
done < <( { (cd "$UP" && find programs/amm -type f); echo LICENSE; } | LC_ALL=C sort)

# 3. Every crate our Cargo.lock names (name, version, source, checksum) is one upstream's lock
#    names: dropping the `client` member may only remove crates, never add or move one.
crates() { awk '/^\[\[package\]\]/{if(n)print n"|"v"|"s"|"c; n=v=s=c=""; next}
  /^name = /{n=$3} /^version = /{v=$3} /^source = /{s=$3} /^checksum = /{c=$3}
  END{if(n)print n"|"v"|"s"|"c}' "$1" | LC_ALL=C sort -u; }
extra=$(LC_ALL=C comm -23 <(crates "$OURS/Cargo.lock") <(crates "$UP/Cargo.lock"))
if [ -n "$extra" ]; then
  echo "::error::Cargo.lock names crates upstream's lock does not:"
  echo "$extra"
  fail=1
fi
locked=$(crates "$OURS/Cargo.lock" | wc -l)

# 4. The delta inside the identity files hashes to the reviewed value.
{
  for f in "${ALLOWED[@]}"; do
    echo "=== $f ==="
    diff <(sed 's/\r$//' "$UP/$f") <(sed 's/\r$//' "$OURS/$f") || true
  done
} > "${TMPDIR:-/tmp}/clmm-delta.txt"
ACTUAL=$(sha256sum "${TMPDIR:-/tmp}/clmm-delta.txt" | cut -d' ' -f1)
echo "--- the delta being hashed ---"
cat "${TMPDIR:-/tmp}/clmm-delta.txt"
echo "------------------------------"
if [ "$ACTUAL" != "$EXPECTED_DELTA_SHA256" ]; then
  echo "::error::the delta from upstream changed: expected $EXPECTED_DELTA_SHA256, got $ACTUAL"
  echo "Read the delta above. If it is still only addresses, names, links and memos, re-pin"
  echo "EXPECTED_DELTA_SHA256 in this file in the same pull request."
  fail=1
fi

[ "$fail" = 0 ] || exit 1
echo "tegridy-clmm = raydium-clmm @ $UPSTREAM_COMMIT plus the pinned identity delta"
echo "  ($checked upstream files compared, ${#ALLOWED[@]} may differ, $(grep -c '^[<>]' "${TMPDIR:-/tmp}/clmm-delta.txt") changed lines, $locked locked crates all upstream's)"
