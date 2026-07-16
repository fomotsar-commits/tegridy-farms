#!/usr/bin/env bash
# ============================================================================
# deploy-gated.sh — turn-key driver for the audited gated-feature batch.
#
# EVERYTHING is filled in except YOUR SIGNER. You provide the key; nothing else.
# NEVER put a raw private key in this file or on the command line — use a keystore
# (`cast wallet import deployer`) or a Ledger.
#
# USAGE
#   1) Rotate + export your Etherscan key:   export ETHERSCAN_API_KEY=<key>
#   2) DRY-RUN everything (no broadcast, no funds moved) — set a --sender address:
#        SIGNER="--sender 0x<your-deployer-address>" ./script/deploy-gated.sh
#   3) When the dry-run output looks right, BROADCAST for real with your signer:
#        SIGNER="--account deployer" ./script/deploy-gated.sh --broadcast     # keystore
#        SIGNER="--ledger"           ./script/deploy-gated.sh --broadcast     # hardware
#
# Runs the 8 non-oracle-gated contracts in the recommended order. TegridyLending
# is oracle-gated and printed separately (deploy it after BootstrapTWAP).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

# ── Canonical on-chain addresses (public; override any via env) ─────────────
export TOWELI="${TOWELI:-0x420698CFdEDdEa6bc78D59bC17798113ad278F9D}"
export STAKING="${STAKING:-0xcaDc93E96De58EA554c71ca609974625615E046D}"
export FACTORY="${FACTORY:-0xa24C7287eC56A7DEFDc70033803451240e267a52}"
export PAIR="${PAIR:-0x55875887B43C2E23aE424AF0FC8606Fdb058a481}"
export TWAP="${TWAP:-0xdFdd6D72539A425dC917F49FB834901105cA98c9}"
export WETH="${WETH:-0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2}"
export JBAC_NFT="${JBAC_NFT:-0xd37264c71e9af940e49795F0d3a8336afAaFDdA9}"
export TREASURY="${TREASURY:-0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d}"     # fee Safe (verified: has code)
export SEQUENCER_FEED="${SEQUENCER_FEED:-0x0000000000000000000000000000000000000000}"  # 0 on mainnet (scripts enforce)

# ── Owner Safe. Current governance Safe 0xA360 (verified: has code, passes code.length guard).
#    ⚠ Your red-team flagged its signer set as compromised-quorum — IDEALLY rebuild the Safe
#    first and `export MULTISIG=<new Safe>`. Otherwise deploy now + re-transfer after rebuild.
export MULTISIG="${MULTISIG:-0xA36053477568Fb5382492F3A5970D35Fe896b7F8}"

# ── Policy (LAST-KNOWN LIVE values — from chain / the scripts. Override to change) ──
export EMISSION_BUDGET="${EMISSION_BUDGET:-1000000000000000000000000}"    # 1,000,000 TOWELI / epoch
export BRIBE_FEE_BPS="${BRIBE_FEE_BPS:-300}"                              # 3% (max 500)
export PROTOCOL_FEE_BPS="${PROTOCOL_FEE_BPS:-500}"                        # 5% lending (max 1000)
export MONTHLY_FEE="${MONTHLY_FEE:-10000000000000000000000}"             # 10,000 TOWELI/mo (read from old PremiumAccess)
NFT_POOL_FEE_BPS="${NFT_POOL_FEE_BPS:-50}"                                # 0.5% NFTPoolFactory

# ── RPC: public read endpoint for dry-run; Flashbots private send-path for broadcast ──
export ETH_RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"

# ── Gas price (wei). 0.2 gwei is a comfortable buffer over a ~0.08 gwei base fee and lands
#    fine via Flashbots (no MEV auction on a plain deploy). BUMP IT if gas has spiked:
#    check with `cast base-fee` and set e.g. GAS_PRICE_WEI=500000000 (0.5 gwei). ──
export GAS_PRICE_WEI="${GAS_PRICE_WEI:-200000000}"   # 0.2 gwei

: "${SIGNER:?Set SIGNER — e.g. '--sender 0x<deployer>' (dry-run) or '--account deployer' / '--ledger' (broadcast)}"

BROADCAST=""; RPC="mainnet"
if [ "${1:-}" = "--broadcast" ]; then
  : "${ETHERSCAN_API_KEY:?Set ETHERSCAN_API_KEY to broadcast (rotate the leaked key first)}"
  BROADCAST="--broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY"
  RPC="flashbots"   # private send-path only when broadcasting real txs
fi
COMMON="--rpc-url $RPC --slow --with-gas-price $GAS_PRICE_WEI $SIGNER $BROADCAST"

echo "MODE: $([ -n "$BROADCAST" ] && echo 'BROADCAST (REAL MAINNET)' || echo 'DRY-RUN (safe)')  |  owner MULTISIG=$MULTISIG  |  treasury=$TREASURY"
run() { echo ""; echo "════════ $1 ════════"; forge script "$2" $COMMON; }

run "1/8 GaugeController" "script/DeployGaugeController.s.sol:DeployGaugeControllerScript"
run "2/8 VoteIncentives"  "script/DeployVoteIncentives.s.sol:DeployVoteIncentivesScript"
run "3/8 PremiumAccess"   "script/DeployPremiumAccess.s.sol:DeployPremiumAccessScript"
( export PROTOCOL_FEE_BPS="$NFT_POOL_FEE_BPS"; run "4/8 NFTPoolFactory (0.5% fee)" "script/DeployNFTPoolFactory.s.sol:DeployNFTPoolFactoryScript" )
run "5/8 NFTLending"      "script/DeployNFTLending.s.sol:DeployNFTLendingScript"
run "6/8 MemeBountyBoard" "script/DeployMemeBountyBoard.s.sol:DeployMemeBountyBoardScript"
run "7/8 CommunityGrants" "script/DeployCommunityGrants.s.sol:DeployCommunityGrantsScript"
run "8/8 LaunchpadV2"     "script/DeployLaunchpadV2.s.sol:DeployLaunchpadV2Script"

cat <<'EOF'

════════ AFTER BROADCAST ════════
• TegridyLending is ORACLE-GATED — deploy it separately AFTER BootstrapTWAP warms the TWAP:
    forge script script/DeployTegridyLending.s.sol:DeployTegridyLendingScript --rpc-url flashbots --slow \
      --with-gas-price "$GAS_PRICE_WEI" --account deployer --broadcast --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
• From the Safe, acceptOwnership() on every 2-step contract (each as its own Safe tx):
    to = <deployed contract>, value = 0, data = 0x79ba5097     (VoteIncentives, NFTLending, [TegridyLending]
    each need it on BOTH the contract AND its Admin sister). NFTPoolFactory is ctor-direct — no accept.
• Verify the LaunchpadV2 dropTemplate separately, then set every new address in frontend/src/lib/constants.ts.
See docs/GATED_DEPLOY_RUNBOOK.md for the full post-deploy checklist.
EOF
