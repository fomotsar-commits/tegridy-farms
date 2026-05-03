#!/bin/bash
# ============================================================
# TEGRIDDY FARMS V2 -- Mainnet Deployment Script
# ============================================================
#
# RECOMMENDED USAGE (keystore — secure):
#   1. cast wallet import deployer --interactive    # one-time setup
#   2. export KEYSTORE_ACCOUNT=deployer
#   3. export ETHERSCAN_API_KEY=your_etherscan_key
#   4. bash deploy-v2.sh simulate / broadcast / verify
#
# LEGACY USAGE (raw private key — DISCOURAGED, key visible to other processes):
#   export PRIVATE_KEY=your_private_key_here
#   bash deploy-v2.sh ...
#
# WHY broadcast and verify are split: see deploy.sh comment block (audit
# B4a). tl;dr: chaining --broadcast and --verify loses the deployed
# addresses if verify fails mid-flight. Split steps keep broadcast atomic
# and make verify independently retriable via `forge script --resume
# --verify`.
#
# SECURITY: This script NEVER stores or logs your private key.
# ============================================================

set -euo pipefail
PRIVATE_KEY="${PRIVATE_KEY:-}"
KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:-}"
KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:-}"

# Non-sensitive config
export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e

FORGE="$HOME/.foundry/bin/forge"
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployV2.s.sol:DeployV2Script"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

# AUDIT FIX (deploy hardening): prefer encrypted keystore over raw cmdline key.
SIGNER_FLAGS=()
build_signer_flags() {
    if [ -n "$KEYSTORE_ACCOUNT" ]; then
        SIGNER_FLAGS=(--account "$KEYSTORE_ACCOUNT")
        if [ -n "$KEYSTORE_PASSWORD_FILE" ] && [ -f "$KEYSTORE_PASSWORD_FILE" ]; then
            SIGNER_FLAGS+=(--password-file "$KEYSTORE_PASSWORD_FILE")
        fi
    elif [ -n "$PRIVATE_KEY" ]; then
        SIGNER_FLAGS=(--private-key "$PRIVATE_KEY")
        echo "WARNING: using --private-key (raw hex on cmdline). Migrate to KEYSTORE_ACCOUNT for production." >&2
    fi
}

require_private_key() {
    build_signer_flags
    if [ ${#SIGNER_FLAGS[@]} -eq 0 ]; then
        echo ""
        echo "ERROR: no signer configured!"
        echo "  Recommended: cast wallet import deployer --interactive ; export KEYSTORE_ACCOUNT=deployer"
        echo "  Legacy:      export PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE"
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
    if [ -n "$KEYSTORE_ACCOUNT" ]; then
        echo "Deployer: $(cast wallet address --account "$KEYSTORE_ACCOUNT" 2>/dev/null || echo 'unknown')"
    elif [ -n "$PRIVATE_KEY" ]; then
        echo "Deployer: $(cast wallet address "$PRIVATE_KEY" 2>/dev/null || echo 'unknown')"
    else
        echo "Deployer: <signer not configured>"
    fi
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
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
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
        # FRESH-EYES: read from /dev/tty so piped stdin cannot bypass prompt.
        read -p "Are you sure? This will spend real ETH. Type 'yes' to confirm: " confirm </dev/tty
        if [ "$confirm" != "yes" ]; then
            echo "Aborted."
            exit 0
        fi
        $FORGE script $SCRIPT \
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
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
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
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
