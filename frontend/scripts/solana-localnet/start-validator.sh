# Local validator for the /curve-launch browser e2e (playwright.solana.config.ts).
# Runs INSIDE WSL. From Git Bash on Windows:
#
#   node scripts/solana-localnet/genesis-accounts.mjs          # once, writes .accounts/
#   MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash -l /mnt/c/<...>/frontend/scripts/solana-localnet/start-validator.sh
#
# It stays in the FOREGROUND (the validator is its child; Ctrl-C or stop-validator.sh
# ends both), so start it in a terminal of its own or as a background job.
#
# What it loads, and nothing else:
#   - tegridy-launch and cp-swap: the EXACT 2026-09-26 mainnet .so files, at their
#     mainnet ids, upgrade authority none. Their sha256 must match the release's
#     SHA256SUMS AND the pins below, or nothing starts.
#   - Metaplex Token Metadata, cloned from mainnet at genesis (read-only).
#   - The genesis accounts from genesis-accounts.mjs: GlobalConfig, AmmConfig index 0 and
#     index 1 (the public tier the vault is proposing; see ammConfig1Values),
#     the cp-swap Permission for ["migauth"], the vault GRMtSx… and its WSOL account,
#     and the stand-in $BAYLA mint 7hmVkPX…pump (mainnet's bytes; only its mint authority
#     is a test key, so the e2e can give makers $BAYLA for the plant).
#   - The mainnet feature set (read-only clone), so the runtime behaves as mainnet's.
# Mainnet is only ever READ, and only by the --clone* flags. No real key is used: the test
# wallets are generated and airdropped by the e2e, and the stand-in mint's key is a test key.
#
# Env (all optional):
#   TEGRIDY_RELEASE_ARTIFACTS_WSL  default /mnt/c/Users/jimbo/solana-launch-release-2026-09-26/artifacts
#   E2E_ACCOUNTS_DIR               default <this dir>/.accounts
#   E2E_LEDGER                     default $HOME/tegridy-e2e-ledger (wiped on every start)
#   SOLANA_BIN                     default the active install
#   E2E_RPC_PORT                   default 8899
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ART=${TEGRIDY_RELEASE_ARTIFACTS_WSL:-/mnt/c/Users/jimbo/solana-launch-release-2026-09-26/artifacts}
ACC=${E2E_ACCOUNTS_DIR:-$HERE/.accounts}
LEDGER=${E2E_LEDGER:-$HOME/tegridy-e2e-ledger}
PORT=${E2E_RPC_PORT:-8899}
BIN=${SOLANA_BIN:-$(dirname "$(readlink -f "$(command -v solana-test-validator)")")}
URL=http://127.0.0.1:$PORT

LAUNCH=64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2
CPSWAP=EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
PIN_LAUNCH=a3c41afaf9dce3ee5dd5d30061c09d8dfb0bf581ba8f39e1d24524dbb43d3f4d
PIN_CPSWAP=88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882

die() { echo "REFUSING: $*" >&2; exit 1; }

# ── 1. the binaries are the release, byte for byte ────────────────────────────
( cd "$ART" && grep -E ' \*?(tegridy_launch|cp_swap)\.mainnet\.so$' SHA256SUMS | sha256sum -c --strict - ) \
  || die "the .so files in $ART do not match their SHA256SUMS"
[ "$(sha256sum "$ART/tegridy_launch.mainnet.so" | cut -d' ' -f1)" = "$PIN_LAUNCH" ] || die "tegridy_launch.mainnet.so is not the pinned release build"
[ "$(sha256sum "$ART/cp_swap.mainnet.so" | cut -d' ' -f1)" = "$PIN_CPSWAP" ] || die "cp_swap.mainnet.so is not the pinned release build"

# ── 2. the genesis accounts exist and are the ones the manifest describes ─────
[ -f "$ACC/manifest.json" ] || die "no $ACC/manifest.json: run 'node scripts/solana-localnet/genesis-accounts.mjs' on Windows first"
ACCOUNT_ARGS=()
for f in global amm-config amm-config-1 permission vault fee-ata bayla-mint usdc-mint; do
  [ -f "$ACC/$f.json" ] || die "missing $ACC/$f.json"
  ACCOUNT_ARGS+=(--account - "$ACC/$f.json")
done

# ── 3. never two validators on one port ──────────────────────────────────────
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then die "something already listens on 127.0.0.1:$PORT"; fi

echo "solana-test-validator $("$BIN/solana-test-validator" --version | awk '{print $2}') · ledger $LEDGER (reset) · rpc $URL"
rm -rf "$LEDGER"; mkdir -p "$LEDGER"

"$BIN/solana-test-validator" --reset --ledger "$LEDGER" \
  --url https://api.mainnet-beta.solana.com --clone-feature-set \
  --clone-upgradeable-program "$METAPLEX" \
  --upgradeable-program "$LAUNCH" "$ART/tegridy_launch.mainnet.so" none \
  --upgradeable-program "$CPSWAP" "$ART/cp_swap.mainnet.so" none \
  "${ACCOUNT_ARGS[@]}" \
  --rpc-port "$PORT" --quiet > "$LEDGER/../tegridy-e2e-validator.out" 2>&1 &
VP=$!
trap 'kill $VP 2>/dev/null; wait $VP 2>/dev/null; echo "validator stopped"' EXIT INT TERM

for _ in $(seq 1 180); do
  "$BIN/solana" cluster-version -u "$URL" >/dev/null 2>&1 && break
  kill -0 $VP 2>/dev/null || { cat "$LEDGER/../tegridy-e2e-validator.out" >&2; die "the validator exited during startup"; }
  sleep 1
done

# ── 4. refuse a public cluster (the rehearsal's deploy.sh rule) ──────────────
G=$("$BIN/solana" genesis-hash -u "$URL")
case $G in 5eykt4*|EtWTRAB*|4uhcVJ*) die "$URL reports a PUBLIC genesis $G";; esac

# ── 5. what is running is what was asked for ─────────────────────────────────
for P in "$LAUNCH" "$CPSWAP"; do
  "$BIN/solana" program dump -u "$URL" "$P" "$LEDGER/dump-$P.so" >/dev/null
done
for pair in "$LAUNCH:$ART/tegridy_launch.mainnet.so" "$CPSWAP:$ART/cp_swap.mainnet.so"; do
  P=${pair%%:*}; SO=${pair#*:}
  LEN=$(stat -c%s "$SO")
  # A dump carries the ProgramData tail padding; compare the first LEN bytes.
  [ "$(head -c "$LEN" "$LEDGER/dump-$P.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$SO" | cut -d' ' -f1)" ] \
    || die "the program at $P is not the release binary"
done
"$BIN/solana" program show -u "$URL" "$METAPLEX" >/dev/null || die "Metaplex Token Metadata was not cloned"

echo "READY genesis=$G launch=$LAUNCH cpswap=$CPSWAP (both = release bytes; upgrade authority none) metaplex=cloned"
wait $VP
