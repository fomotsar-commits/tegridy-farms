#!/bin/bash
# ============================================================
# TEGRIDDY FARMS -- Mainnet Deployment Script (AuditFixes batch)
# ============================================================
#
# USAGE:
#   1. Open a terminal in the contracts/ directory
#   2. Run: export PRIVATE_KEY=your_private_key_here
#   3. Run: export ETHERSCAN_API_KEY=your_etherscan_key
#   4. Run: bash deploy.sh simulate      (dry-run first!)
#   5. Run: bash deploy.sh broadcast     (on-chain only, NO verify)
#   6. Run: bash deploy.sh verify        (separate Etherscan verification)
#
# WHY broadcast and verify are split (audit B4a):
#   The previous script chained --broadcast and --verify in one forge
#   invocation. If verify failed mid-flight (Etherscan rate limit, stale API
#   response), the contracts landed on-chain with no published source and the
#   script exited with a non-zero status BEFORE printing the deployed
#   addresses. You'd then be debugging Etherscan drift without knowing which
#   addresses needed verification. Splitting the steps keeps broadcast atomic
#   (addresses always printed on success) and makes verify independently
#   retriable via `forge script --resume --verify`.
#
# ROLLBACK:
#   Contract deployments to mainnet are NOT reversible. "Rollback" means
#   choosing not to flip the frontend/indexer to the new addresses, leaving
#   the prior live contracts as the canonical surface. If broadcast completed
#   but verify fails repeatedly, the deployment is still live — only the
#   Etherscan source view is missing. Retry verify any time.
#
# SECURITY: This script NEVER stores or logs your private key.
# ============================================================

set -e

# Non-sensitive config
export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
export LP_TOKEN=0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d

FORGE="$HOME/.foundry/bin/forge"
# Use multiple RPC fallbacks -- publicnode was timing out during broadcast
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployAuditFixes.s.sol:DeployAuditFixesScript"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

require_private_key() {
    if [ -z "$PRIVATE_KEY" ]; then
        echo ""
        echo "ERROR: PRIVATE_KEY not set!"
        echo ""
        echo "Run this first (replace with your actual key):"
        echo "  export PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE"
        echo ""
        exit 1
    fi
}

require_etherscan_key() {
    if [ -z "$ETHERSCAN_KEY" ]; then
        echo ""
        echo "ERROR: ETHERSCAN_API_KEY not set!"
        echo ""
        echo "Run:"
        echo "  export ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY"
        echo ""
        exit 1
    fi
}

print_header() {
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
        echo "Simulation complete. Review output above."
        echo "If everything looks good:"
        echo "  bash deploy.sh broadcast"
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
        echo "BROADCAST COMPLETE."
        echo "Deployed addresses are in the forge output above and in:"
        echo "  contracts/broadcast/DeployAuditFixes.s.sol/1/run-latest.json"
        echo ""
        echo "NEXT STEP — verify on Etherscan (separate, retry-safe):"
        echo "  bash deploy.sh verify"
        ;;

    verify)
        require_private_key
        require_etherscan_key
        print_header
        echo "MODE: ETHERSCAN VERIFICATION (no new txs, reads last broadcast)"
        echo ""
        # --resume tells forge to reuse the prior broadcast JSON. If a contract
        # is already verified, Etherscan returns early; safe to re-run.
        $FORGE script $SCRIPT \
            --rpc-url $RPC_URL \
            --private-key $PRIVATE_KEY \
            --resume \
            --verify \
            --etherscan-api-key $ETHERSCAN_KEY \
            -vvvv
        echo ""
        echo "VERIFICATION COMPLETE (or already up-to-date)."
        ;;

    *)
        echo "Usage: bash deploy.sh [simulate|broadcast|verify]"
        echo ""
        echo "  simulate   Dry run against mainnet fork (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH!), NO Etherscan verify"
        echo "  verify     Retry-safe Etherscan verification of the last broadcast"
        echo ""
        echo "Typical flow: simulate -> broadcast -> verify"
        ;;
esac
