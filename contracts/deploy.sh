#!/bin/bash
# ============================================================
# TEGRIDDY FARMS -- Mainnet Deployment Script (AuditFixes batch)
# ============================================================
#
# RECOMMENDED USAGE (keystore — secure, key never on cmdline):
#   1. One-time setup: cast wallet import deployer --interactive
#      (paste your key once; it's stored encrypted in ~/.foundry/keystores/)
#   2. export KEYSTORE_ACCOUNT=deployer
#      (optionally) export KEYSTORE_PASSWORD_FILE=/path/to/pwd  # avoid stdin prompt
#   3. export ETHERSCAN_API_KEY=your_etherscan_key
#   4. bash deploy.sh simulate      (dry-run first!)
#   5. bash deploy.sh broadcast     (on-chain only, NO verify)
#   6. bash deploy.sh verify        (separate Etherscan verification)
#
# LEGACY USAGE (raw private key — DISCOURAGED, key visible in /proc/<pid>/cmdline):
#   export PRIVATE_KEY=your_private_key_here
#   bash deploy.sh simulate
#   ...
#
# WHY KEYSTORE > PRIVATE_KEY:
#   Pre-fix `--private-key $PRIVATE_KEY` exposes the deployer key to any
#   process on the host that can read `/proc/<pid>/cmdline` (Linux) or
#   `ps -ef`. On a multi-user dev box, in CI runners with parallel jobs, or
#   any environment with co-tenants, this is a real exfiltration surface.
#   `--account` reads the encrypted keystore and never puts the key on the
#   command line — Foundry's recommended path for production deploys.
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

set -euo pipefail
PRIVATE_KEY="${PRIVATE_KEY:-}"
KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:-}"
KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:-}"

# AUDIT FIX (deploy hardening): build a SIGNER_FLAGS array that prefers
# `--account <name>` (encrypted keystore) over `--private-key <hex>` (raw key
# on cmdline). Keystore avoids exposing the key via /proc/<pid>/cmdline / ps.
# Falls back to PRIVATE_KEY only if KEYSTORE_ACCOUNT is unset.
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

# Non-sensitive config
export MULTISIG=0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
export LP_TOKEN=0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d

FORGE="$HOME/.foundry/bin/forge"
# Use multiple RPC fallbacks -- publicnode was timing out during broadcast
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SCRIPT="script/DeployAuditFixes.s.sol:DeployAuditFixesScript"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

require_signer() {
    build_signer_flags
    if [ ${#SIGNER_FLAGS[@]} -eq 0 ]; then
        echo ""
        echo "ERROR: no signer configured!"
        echo ""
        echo "RECOMMENDED — keystore (no key on cmdline):"
        echo "  cast wallet import deployer --interactive    # one-time"
        echo "  export KEYSTORE_ACCOUNT=deployer"
        echo ""
        echo "LEGACY — raw private key (visible to other processes):"
        echo "  export PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE"
        echo ""
        exit 1
    fi
}
# Backward-compat alias so existing call sites keep working.
require_private_key() { require_signer; }

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
    # AUDIT FIX (deploy hardening): resolve deployer address via the keystore
    # account name (no raw key on cmdline) when KEYSTORE_ACCOUNT is set;
    # fall back to `cast wallet address $PRIVATE_KEY` for legacy mode.
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
        echo "Simulation complete. Review output above."
        echo "If everything looks good:"
        echo "  bash deploy.sh broadcast"
        ;;

    broadcast)
        require_private_key
        print_header
        echo "MODE: LIVE BROADCAST TO MAINNET (NO verify in this step)"
        echo ""
        # FRESH-EYES: read from /dev/tty so `yes | bash deploy.sh broadcast`
        # cannot bypass the confirmation by piping stdin.
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
        echo "BROADCAST COMPLETE."
        echo "Deployed addresses are in the forge output above and in:"
        echo "  contracts/broadcast/DeployAuditFixes.s.sol/1/run-latest.json"
        echo ""
        echo "NEXT STEPS:"
        echo "  1. Verify on Etherscan (separate, retry-safe):"
        echo "       bash deploy.sh verify"
        echo "  2. Deploy TegridyLending + TegridyLendingAdmin (factored out to"
        echo "     keep DeployAuditFixes under the Yul stack-too-deep ceiling):"
        echo "       export LP_TOKEN=<TOWELI/WETH pair from output above>"
        echo "       export TWAP=<TegridyTWAP oracle address>"
        echo "       bash deploy-lending.sh simulate"
        echo "       bash deploy-lending.sh broadcast"
        echo "       bash deploy-lending.sh verify"
        echo "  3. Multisig acceptOwnership() on all 11 contracts + lending pair"
        echo "     within 14 days (OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY)."
        echo "  4. Run script/Verify.s.sol to confirm INV-1..INV-9 pass."
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
        echo "Usage: bash deploy.sh [simulate|broadcast|verify]"
        echo ""
        echo "  simulate   Dry run against mainnet fork (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH!), NO Etherscan verify"
        echo "  verify     Retry-safe Etherscan verification of the last broadcast"
        echo ""
        echo "Typical flow: simulate -> broadcast -> verify"
        ;;
esac
