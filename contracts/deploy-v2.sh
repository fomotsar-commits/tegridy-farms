#!/bin/bash
# ============================================================
# TEGRIDDY FARMS V2 -- Mainnet Deployment Script
# ============================================================
#
# USAGE:
#   1. Open a terminal in the contracts/ directory
#   2. Run: export PRIVATE_KEY=your_private_key_here
#   3. Run: export ETHERSCAN_API_KEY=your_etherscan_key
#   4. Run: bash deploy-v2.sh simulate     (dry-run first!)
#   5. Run: bash deploy-v2.sh broadcast    (on-chain only, NO verify)
#   6. Run: bash deploy-v2.sh verify       (separate Etherscan verification)
#
# WHY broadcast and verify are split: see deploy.sh comment block (audit
# B4a). tl;dr: chaining --broadcast and --verify loses the deployed
# addresses if verify fails mid-flight. Split steps keep broadcast atomic
# and make verify independently retriable via `forge script --resume
# --verify`.
#
# SECURITY: This script NEVER stores or logs your private key.
# ============================================================

set -e

# Non-sensitive config
export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e

FORGE="$HOME/.foundry/bin/forge"
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployV2.s.sol:DeployV2Script"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

require_private_key() {
    if [ -z "$PRIVATE_KEY" ]; then
        echo ""
        echo "ERROR: PRIVATE_KEY not set!"
        echo ""
        echo "Run: export PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE"
        exit 1
    fi
}

require_etherscan_key() {
    if [ -z "$ETHERSCAN_KEY" ]; then
        echo ""
        echo "ERROR: ETHERSCAN_API_KEY not set!"
        echo ""
        echo "Run: export ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY"
        exit 1
    fi
}

print_header() {
    echo ""
    echo "========================================="
    echo "  TEGRIDDY FARMS V2 DEPLOYMENT"
    echo "========================================="
    echo "Chain:    Ethereum Mainnet (ID: 1)"
    echo "Multisig: $MULTISIG"
    echo "Deployer: $(cast wallet address $PRIVATE_KEY 2>/dev/null || echo 'unknown')"
    echo "========================================="
    echo ""
}

case "$1" in
    simulate)
        require_private_key
        print_header
        echo "MODE: DRY-RUN SIMULATION (no gas spent)"
        echo ""
        $FORGE script $SCRIPT \
            --rpc-url $RPC_URL \
            --private-key $PRIVATE_KEY \
            -vvvv
        echo ""
        echo "Simulation complete. If everything looks good:"
        echo "  bash deploy-v2.sh broadcast"
        ;;

    broadcast)
        require_private_key
        print_header
        echo "MODE: LIVE BROADCAST TO MAINNET (NO verify in this step)"
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
            --slow \
            -vvvv
        echo ""
        echo "V2 BROADCAST COMPLETE."
        echo "Deployed addresses in: contracts/broadcast/DeployV2.s.sol/1/run-latest.json"
        echo ""
        echo "NEXT STEP — verify:"
        echo "  bash deploy-v2.sh verify"
        ;;

    verify)
        require_private_key
        require_etherscan_key
        print_header
        echo "MODE: ETHERSCAN VERIFICATION (no new txs, reads last broadcast)"
        echo ""
        $FORGE script $SCRIPT \
            --rpc-url $RPC_URL \
            --private-key $PRIVATE_KEY \
            --resume \
            --verify \
            --etherscan-api-key $ETHERSCAN_KEY \
            -vvvv
        echo ""
        echo "V2 VERIFICATION COMPLETE (or already up-to-date)."
        ;;

    *)
        echo "Usage: bash deploy-v2.sh [simulate|broadcast|verify]"
        echo ""
        echo "  simulate   Dry run against mainnet fork (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH!), NO Etherscan verify"
        echo "  verify     Retry-safe Etherscan verification of the last broadcast"
        ;;
esac
