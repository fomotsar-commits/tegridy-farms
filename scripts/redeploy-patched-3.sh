#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# redeploy-patched-3.sh — Wave 0 of the Tegriddy Farms Spartan Battle Plan.
#
# Role: one-shot redeploy helper for the three contracts whose working-tree
#       patches are not yet live on mainnet:
#         1. TegridyLPFarming   (exit() + stake-time boost refresh)
#         2. TegridyNFTLending  (GRACE_PERIOD gating on repay/claimDefault)
#         3. TegridyDrop        (MintPhase.CANCELLED + cancelSale + refund +
#                                paidPerWallet). Because TegridyDrop is the
#                                template cloned by TegridyLaunchpad, we
#                                redeploy via the DeployV3Features script
#                                which also rewires a fresh Launchpad factory.
#
# Usage (Git Bash on Windows is supported — forward slashes only):
#   export RPC_URL="https://..."
#   export PRIVATE_KEY="0x..."
#   export MULTISIG="0x..."
#   export TEGRIDY_LP="0x..."         # existing TOWELI/WETH LP pair
#   export TEGRIDY_STAKING="0x..."    # existing TegridyStaking address
#   bash scripts/redeploy-patched-3.sh
#
# After success, run scripts/diff-addresses.ts to get the constants.ts patch.
# ------------------------------------------------------------------------------

set -euo pipefail

# Resolve repo root (parent of scripts/) so the script is path-independent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTRACTS_DIR="${REPO_ROOT}/contracts"
BROADCAST_DIR="${CONTRACTS_DIR}/broadcast"

echo "=============================================================="
echo " Tegriddy Farms — Wave 0 redeploy (3 patched contracts)"
echo "=============================================================="
echo " Repo root:     ${REPO_ROOT}"
echo " Contracts dir: ${CONTRACTS_DIR}"
echo ""
echo " This script will:"
echo "   1. forge build"
echo "   2. Deploy TegridyLPFarming  (DeployTegridyLPFarming.s.sol)"
echo "   3. Deploy TegridyNFTLending (DeployNFTLending.s.sol)"
echo "   4. Deploy TegridyDrop+Launchpad (DeployV3Features.s.sol)"
echo ""
echo " Required env vars: RPC_URL, PRIVATE_KEY, MULTISIG,"
echo "                    TEGRIDY_LP, TEGRIDY_STAKING"
echo "=============================================================="
echo ""

# ─── Env sanity checks ────────────────────────────────────────────────────────
: "${RPC_URL:?RPC_URL must be set}"
: "${PRIVATE_KEY:?PRIVATE_KEY must be set}"
: "${MULTISIG:?MULTISIG must be set}"
: "${TEGRIDY_LP:?TEGRIDY_LP must be set (TOWELI/WETH pair address)}"
: "${TEGRIDY_STAKING:?TEGRIDY_STAKING must be set (existing TegridyStaking address)}"

# Optional — forwarded to --verify if set.
ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-}"
VERIFY_FLAGS="--verify"
if [ -z "${ETHERSCAN_API_KEY}" ]; then
  echo "NOTE: ETHERSCAN_API_KEY not set — verification may fail. Continuing anyway."
fi

cd "${CONTRACTS_DIR}"

# ─── Step 1: forge build ──────────────────────────────────────────────────────
echo ""
echo ">>> [1/4] forge build"
forge build

# ─── Helper: run one deploy + print broadcast path ────────────────────────────
# $1 = human label
# $2 = script path relative to contracts/  (e.g. script/Foo.s.sol)
# $3 = contract name inside the script     (e.g. FooScript)
run_deploy () {
  local label="$1"
  local script_path="$2"
  local contract_name="$3"
  local script_file="${CONTRACTS_DIR}/${script_path}"

  echo ""
  echo "=============================================================="
  echo ">>> ${label}"
  echo "    script: ${script_path}:${contract_name}"
  echo "=============================================================="

  if [ ! -f "${script_file}" ]; then
    echo "WARNING: ${script_file} does not exist — skipping ${label}."
    echo "         If this deploy is required, add the script and re-run."
    return 0
  fi

  forge script "${script_path}:${contract_name}" \
    --rpc-url "${RPC_URL}" \
    --private-key "${PRIVATE_KEY}" \
    --broadcast \
    ${VERIFY_FLAGS} \
    -vvv

  # Broadcast JSON lands at broadcast/<ScriptFile>/<chainId>/run-latest.json
  local script_basename
  script_basename="$(basename "${script_path}")"
  local broadcast_path="${BROADCAST_DIR}/${script_basename}/1/run-latest.json"
  echo ""
  echo "  -> Broadcast JSON: ${broadcast_path}"
  if [ -f "${broadcast_path}" ]; then
    echo "  -> (file exists — diff-addresses.ts will read it)"
  else
    echo "  -> WARNING: broadcast JSON not found at expected path."
    echo "     Foundry may have written it under a different chain id."
  fi
}

# ─── Step 2: TegridyLPFarming ─────────────────────────────────────────────────
run_deploy "[2/4] TegridyLPFarming (exit + stake-time boost refresh)" \
  "script/DeployTegridyLPFarming.s.sol" \
  "DeployTegridyLPFarmingScript"

# ─── Step 3: TegridyNFTLending ────────────────────────────────────────────────
run_deploy "[3/4] TegridyNFTLending (GRACE_PERIOD = 1 hours)" \
  "script/DeployNFTLending.s.sol" \
  "DeployNFTLendingScript"

# ─── Step 4: TegridyDrop (via DeployV3Features — redeploys Launchpad too) ─────
run_deploy "[4/4] TegridyDrop + Launchpad (CANCELLED phase, refund, paidPerWallet)" \
  "script/DeployV3Features.s.sol" \
  "DeployV3FeaturesScript"

echo ""
echo "=============================================================="
echo " Wave 0 redeploy complete."
echo ""
echo " Next: extract new addresses and preview the constants.ts patch:"
echo "     npx tsx scripts/diff-addresses.ts"
echo "=============================================================="
