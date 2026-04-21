#!/bin/bash
# Deploy VoteIncentives pointing to the current staking contract.
#
# USAGE:
#   export PRIVATE_KEY=0x...
#   export ETHERSCAN_API_KEY=...
#   bash deploy-vote-incentives.sh simulate   # dry-run
#   bash deploy-vote-incentives.sh broadcast  # deploy only (no verify)
#   bash deploy-vote-incentives.sh verify     # retry-safe Etherscan verify
#
# Why broadcast and verify are split: see deploy.sh (audit B4a). Chained
# --broadcast --verify loses the deployed address if verify fails mid-flight.

set -e

export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
FORGE="$HOME/.foundry/bin/forge"
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployVoteIncentives.s.sol:DeployVoteIncentivesScript"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

require_private_key() {
    if [ -z "$PRIVATE_KEY" ]; then
        echo "ERROR: export PRIVATE_KEY=0x... first"
        exit 1
    fi
}

require_etherscan_key() {
    if [ -z "$ETHERSCAN_KEY" ]; then
        echo "ERROR: export ETHERSCAN_API_KEY=... first"
        exit 1
    fi
}

case "$1" in
    simulate)
        require_private_key
        echo "=== VoteIncentives — SIMULATE ==="
        $FORGE script $SCRIPT \
            --rpc-url $RPC_URL \
            --private-key $PRIVATE_KEY \
            -vvvv
        ;;

    broadcast)
        require_private_key
        echo "=== VoteIncentives — BROADCAST (no verify) ==="
        echo "Staking: 0xc2072846A493b92E2722dEE8eAFA78690f099bBD (new)"
        read -p "Broadcast to mainnet? Type 'yes' to confirm: " confirm
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
        echo "BROADCAST COMPLETE. Next:"
        echo "  bash deploy-vote-incentives.sh verify"
        echo "Then update VOTE_INCENTIVES_ADDRESS in frontend/src/lib/constants.ts"
        ;;

    verify)
        require_private_key
        require_etherscan_key
        echo "=== VoteIncentives — VERIFY (retry-safe) ==="
        $FORGE script $SCRIPT \
            --rpc-url $RPC_URL \
            --private-key $PRIVATE_KEY \
            --resume \
            --verify \
            --etherscan-api-key $ETHERSCAN_KEY \
            -vvvv
        echo ""
        echo "VERIFY COMPLETE (or already up-to-date)."
        ;;

    *)
        echo "Usage: bash deploy-vote-incentives.sh [simulate|broadcast|verify]"
        echo ""
        echo "  simulate   Dry run (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH), no verify"
        echo "  verify     Separate, retry-safe Etherscan verify step"
        ;;
esac
