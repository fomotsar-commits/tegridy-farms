#!/bin/bash
# ============================================================
# TEGRIDDY FARMS -- Mainnet Deployment Script
# ============================================================
#
# USAGE:
#   1. Open a terminal in the contracts/ directory
#   2. Run: export PRIVATE_KEY=your_private_key_here
#   3. Run: bash deploy.sh simulate     (dry-run first!)
#   4. Run: bash deploy.sh broadcast     (actual deployment)
#
# SECURITY: This script NEVER stores or logs your private key.
# ============================================================

set -e

# Non-sensitive config
export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
export LP_TOKEN=0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d

# Check private key is set
if [ -z "$PRIVATE_KEY" ]; then
    echo ""
    echo "ERROR: PRIVATE_KEY not set!"
    echo ""
    echo "Run this first (replace with your actual key):"
    echo "  export PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE"
    echo ""
    exit 1
fi

FORGE="$HOME/.foundry/bin/forge"
# Use multiple RPC fallbacks -- publicnode was timing out during broadcast
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployAuditFixes.s.sol:DeployAuditFixesScript"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

echo ""
echo "========================================="
echo "  TEGRIDDY FARMS DEPLOYMENT"
echo "========================================="
echo "Chain:    Ethereum Mainnet (ID: 1)"
echo "Multisig: $MULTISIG"
echo "LP Token: $LP_TOKEN"
echo "Deployer: $(cast wallet address $PRIVATE_KEY 2>/dev/null || echo 'unknown')"
echo "========================================="
echo ""

if [ "$1" = "simulate" ]; then
    echo "MODE: DRY-RUN SIMULATION (no gas spent)"
    echo ""
    $FORGE script $SCRIPT \
        --rpc-url $RPC_URL \
        --private-key $PRIVATE_KEY \
        -vvvv
    echo ""
    echo "Simulation complete! Review output above."
    echo "If everything looks good, run: bash deploy.sh broadcast"

elif [ "$1" = "broadcast" ]; then
    echo "MODE: LIVE BROADCAST TO MAINNET"
    echo ""
    read -p "Are you sure? This will spend real ETH. Type 'yes' to confirm: " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Aborted."
        exit 0
    fi
    $FORGE script $SCRIPT \
        --rpc-url $RPC_URL \
        --private-key $PRIVATE_KEY \
        --broadcast \
        --verify \
        --etherscan-api-key $ETHERSCAN_KEY \
        --slow \
        -vvvv
    echo ""
    echo "DEPLOYMENT BROADCAST COMPLETE!"
    echo "Check etherscan for transaction confirmations."

else
    echo "Usage: bash deploy.sh [simulate|broadcast]"
    echo ""
    echo "  simulate  - Dry run against mainnet fork (no gas)"
    echo "  broadcast - Deploy to mainnet (costs ETH!)"
fi
