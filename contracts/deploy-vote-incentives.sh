#!/bin/bash
# Deploy VoteIncentives pointing to new staking contract
# Usage: export PRIVATE_KEY=0x... && bash deploy-vote-incentives.sh
set -e

export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
FORGE="$HOME/.foundry/bin/forge"
RPC_URL="https://ethereum-rpc.publicnode.com"

if [ -z "$PRIVATE_KEY" ]; then
    echo "ERROR: export PRIVATE_KEY=0x... first"
    exit 1
fi

echo "=== Deploying VoteIncentives ==="
echo "Staking: 0xc2072846A493b92E2722dEE8eAFA78690f099bBD (new)"
echo ""

$FORGE script script/DeployVoteIncentives.s.sol:DeployVoteIncentivesScript \
    --rpc-url $RPC_URL \
    --private-key $PRIVATE_KEY \
    --broadcast \
    --verify \
    --etherscan-api-key ${ETHERSCAN_API_KEY:-} \
    -vvvv

echo ""
echo "Done! Update VOTE_INCENTIVES_ADDRESS in frontend/src/lib/constants.ts"
