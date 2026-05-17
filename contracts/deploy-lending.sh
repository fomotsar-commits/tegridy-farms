#!/bin/bash
# Deploy TegridyLending + TegridyLendingAdmin.
#
# Why a standalone script: DeployAuditFixes.s.sol is at the Yul stack-too-deep
# ceiling (10 typed contract handles already), so lending was factored out into
# its own script. This shell mirrors deploy-vote-incentives.sh — same operator
# UX, same simulate/broadcast/verify split.
#
# Run AFTER `bash deploy.sh broadcast` (the main audit-fix deploy) so the pair
# (LP_TOKEN) exists and TWAP is wired.
#
# RECOMMENDED USAGE (keystore — secure):
#   cast wallet import deployer --interactive   # one-time
#   export KEYSTORE_ACCOUNT=deployer
#   export ETHERSCAN_API_KEY=...
#   export TREASURY=0x...     # protocol-fee recipient (often == MULTISIG)
#   export LP_TOKEN=0x...     # TOWELI/WETH pair (from deploy.sh output)
#   export TWAP=0x...         # TegridyTWAP oracle
#   # export SEQUENCER_FEED=0x... (L2 only; mainnet leaves unset)
#   bash deploy-lending.sh simulate / broadcast / verify
#
# LEGACY USAGE (raw key — DISCOURAGED):
#   export PRIVATE_KEY=0x...
#   bash deploy-lending.sh ...
#
# Why broadcast and verify are split: see deploy.sh (audit B4a). Chained
# --broadcast --verify loses the deployed address if verify fails mid-flight.

set -euo pipefail
PRIVATE_KEY="${PRIVATE_KEY:-}"
KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:-}"
KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:-}"

# Defaults match the rest of the deploy-* scripts. Operator must override
# TREASURY explicitly if it should differ from MULTISIG (recommended after
# the org-level multisig split lands).
export MULTISIG="${MULTISIG:-0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e}"
export TREASURY="${TREASURY:-$MULTISIG}"

FORGE="$HOME/.foundry/bin/forge"
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployLending.s.sol:DeployLendingScript"
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
        echo "ERROR: no signer (set KEYSTORE_ACCOUNT or PRIVATE_KEY)"
        exit 1
    fi
}

require_etherscan_key() {
    if [ -z "$ETHERSCAN_KEY" ]; then
        echo "ERROR: export ETHERSCAN_API_KEY=... first"
        exit 1
    fi
}

require_lending_envs() {
    local missing=0
    if [ -z "${LP_TOKEN:-}" ]; then
        echo "ERROR: export LP_TOKEN=<TOWELI/WETH pair address>"
        missing=1
    fi
    if [ -z "${TWAP:-}" ]; then
        echo "ERROR: export TWAP=<TegridyTWAP oracle address>"
        missing=1
    fi
    if [ "$missing" -ne 0 ]; then
        echo ""
        echo "These come from the main deploy (deploy.sh) and the standalone"
        echo "TWAP deploy. Paste them from the operator notebook before retrying."
        exit 1
    fi
}

print_header() {
    echo ""
    echo "========================================="
    echo "  TEGRIDDY LENDING DEPLOYMENT"
    echo "========================================="
    echo "Chain:          Ethereum Mainnet (ID: 1)"
    echo "Multisig:       $MULTISIG"
    echo "Treasury:       $TREASURY"
    echo "LP_TOKEN:       ${LP_TOKEN:-<unset>}"
    echo "TWAP:           ${TWAP:-<unset>}"
    echo "SEQUENCER_FEED: ${SEQUENCER_FEED:-<unset (mainnet OK)>}"
    if [ -n "$KEYSTORE_ACCOUNT" ]; then
        echo "Deployer:       $(cast wallet address --account "$KEYSTORE_ACCOUNT" 2>/dev/null || echo 'unknown')"
    elif [ -n "$PRIVATE_KEY" ]; then
        echo "Deployer:       $(cast wallet address "$PRIVATE_KEY" 2>/dev/null || echo 'unknown')"
    else
        echo "Deployer:       <signer not configured>"
    fi
    echo "========================================="
    echo ""
}

case "$1" in
    simulate)
        require_private_key
        require_lending_envs
        print_header
        echo "MODE: DRY-RUN SIMULATION (no gas spent)"
        echo ""
        $FORGE script $SCRIPT \
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
            -vvvv
        echo ""
        echo "Simulation complete. Review output above."
        echo "If everything looks good:"
        echo "  bash deploy-lending.sh broadcast"
        ;;

    broadcast)
        require_private_key
        require_lending_envs
        print_header
        echo "MODE: LIVE BROADCAST TO MAINNET (NO verify in this step)"
        echo ""
        # FRESH-EYES: read from /dev/tty so `yes | bash ...` cannot bypass prompt.
        read -p "Broadcast lending to mainnet? Type 'yes' to confirm: " confirm </dev/tty
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
        echo "BROADCAST COMPLETE."
        echo "Deployed addresses are in the forge output above and in:"
        echo "  contracts/broadcast/DeployLending.s.sol/1/run-latest.json"
        echo ""
        echo "NEXT STEPS:"
        echo "  1. Multisig: acceptOwnership() on lending + lendingAdmin"
        echo "     within 14 days (OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY)."
        echo "  2. Update Verify.s.sol LENDING + LENDING_ADMIN constants with the"
        echo "     addresses from the run-latest.json above; run Verify.s.sol."
        echo "  3. bash deploy-lending.sh verify   (separate, retry-safe)"
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
        echo "VERIFICATION COMPLETE (or already up-to-date)."
        ;;

    *)
        echo "Usage: bash deploy-lending.sh [simulate|broadcast|verify]"
        echo ""
        echo "  simulate   Dry run (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH!), NO Etherscan verify"
        echo "  verify     Retry-safe Etherscan verification of the last broadcast"
        echo ""
        echo "Required env vars: KEYSTORE_ACCOUNT (or PRIVATE_KEY), MULTISIG,"
        echo "TREASURY, LP_TOKEN, TWAP, optional SEQUENCER_FEED (L2 only)."
        echo ""
        echo "Run AFTER the main deploy.sh broadcast completes."
        ;;
esac
