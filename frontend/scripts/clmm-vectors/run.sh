#!/usr/bin/env bash
# Computes the range client's test vectors with the range program's own Rust code.
#
#   bash frontend/scripts/clmm-vectors/run.sh <scratch-dir> > frontend/src/lib/solana/clmm/__fixtures__/program-vectors.json
#
# Copies solana/tegridy-clmm to <scratch-dir> (outside the repo), adds vectors.rs there as a
# test module, runs it, and prints the vectors. The repo's copy of the program is only read.
# Needs a Rust toolchain (cargo); the program's Cargo.lock pins every crate.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
scratch="${1:?usage: run.sh <scratch-dir>}"
case "$(cd "$(dirname "$scratch")" && pwd)/" in "$repo"/*) echo "scratch dir must be outside the repo" >&2; exit 2 ;; esac

rm -rf "$scratch"
mkdir -p "$scratch"
tar -C "$repo/solana/tegridy-clmm" --exclude=target --exclude=.anchor -cf - . | tar -C "$scratch" -xf -
cp "$here/vectors.rs" "$scratch/programs/amm/src/vectors.rs"
printf '\n#[cfg(test)]\nmod vectors;\n' >> "$scratch/programs/amm/src/lib.rs"
(cd "$scratch" && VECTORS_OUT="$scratch/vectors.json" cargo test --locked -p raydium-clmm --lib vectors::write_vectors -- --exact --quiet >&2)
# Which program source the vectors came from: every .rs file under programs/amm/src, by path
# then content, carriage returns dropped. quote.test.ts recomputes it from the repo's copy and
# fails when the program changes and the vectors were not made again.
src_sha="$(cd "$repo/solana/tegridy-clmm/programs/amm/src" && find . -type f -name '*.rs' | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do printf '%s\n' "$f"; tr -d '\r' < "$f"; done | sha256sum | cut -d' ' -f1)"
printf '{\n"programSource":{"sha256":"%s"},' "$src_sha"
tail -c +2 "$scratch/vectors.json"
