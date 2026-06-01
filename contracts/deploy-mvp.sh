#!/bin/bash
# ============================================================
# TEGRIDDY FARMS — Canonical MVP-launch deploy wrapper
# ============================================================
#
# Wraps the ONLY supported mainnet deploy path:
#   script/DeployMVP.s.sol:DeployMVPScript   (deploy the 15 MVP contracts)
#   script/VerifyMVP.s.sol:VerifyMVPScript   (post-deploy invariant check)
#
# This replaces the prior deploy.sh / deploy-v2.sh / deploy-lending.sh /
# deploy-vote-incentives.sh / verify.sh, ALL of which pointed at scripts that
# no longer exist (DeployAuditFixes / DeployV2 / DeployLending /
# DeployVoteIncentives) and hardcoded pre-relaunch addresses. (audit 2026-05-24 M8)
#
# IMPORTANT — library linking: TegridyStaking is delegatecall-linked against
# StakingViewLib + StakingRewardLib (the C1 EIP-170 split). The `forge script
# --broadcast --verify` flow below deploys those libraries and records their
# addresses in the broadcast JSON, so Etherscan verification links them
# automatically. Do NOT hand-verify TegridyStaking with `forge verify-contract`
# without `--libraries` — it will fail.
#
# ── REQUIRED ENV (deploy: simulate / broadcast) ──
#   KEYSTORE_ACCOUNT   encrypted keystore account name (PREFERRED; key never on
#                      cmdline). One-time: cast wallet import deployer --interactive
#     (legacy fallback) PRIVATE_KEY  raw hex — DISCOURAGED, visible via /proc.
#   TREASURY           cold multisig holding protocol funds
#   MULTISIG           cold multisig holding Ownable on every contract (disjoint)
#   PAUSE_GUARDIAN     hot multisig holding pause()-only capability (disjoint)
#   ETHERSCAN_API_KEY  (broadcast/verify only) Etherscan v2 API key
#   ETH_RPC_URL        (optional) mainnet RPC; defaults to a public node
#   SEQUENCER_FEED     (optional) L2 sequencer-uptime feed; address(0) on L1
#
# ── REQUIRED ENV (check: post-deploy invariants) ──
#   TREASURY, MULTISIG, PAUSE_GUARDIAN  (as above) PLUS the deployed addresses:
#   STAKING JBAC_VAULT STAKING_ADMIN FACTORY ROUTER PAIR TWAP
#   REVENUE_DISTRIBUTOR REFERRAL_SPLITTER SWAP_FEE_ROUTER SWAP_FEE_ROUTER_ADMIN
#   POL_ACCUMULATOR
#
# ── FLOW ──
#   bash deploy-mvp.sh simulate    # dry run, no gas
#   bash deploy-mvp.sh broadcast   # deploy + Etherscan verify (spends ETH)
#   bash deploy-mvp.sh verify      # retry Etherscan verify (reads last broadcast)
#   bash deploy-mvp.sh check       # run VerifyMVP invariants after acceptOwnership()
#
# SECURITY: this script NEVER stores or logs your private key.
# ============================================================

set -euo pipefail

PRIVATE_KEY="${PRIVATE_KEY:-}"
KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:-}"
KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:-}"

FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
RPC_URL="${ETH_RPC_URL:-https://ethereum-rpc.publicnode.com}"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:-}"

DEPLOY_SCRIPT="script/DeployMVP.s.sol:DeployMVPScript"
VERIFY_SCRIPT="script/VerifyMVP.s.sol:VerifyMVPScript"

# Prefer --account (encrypted keystore) over --private-key (raw hex on cmdline).
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

require_signer() {
    build_signer_flags
    if [ ${#SIGNER_FLAGS[@]} -eq 0 ]; then
        echo "ERROR: no signer configured. Set KEYSTORE_ACCOUNT (preferred) or PRIVATE_KEY." >&2
        echo "  cast wallet import deployer --interactive   # one-time" >&2
        echo "  export KEYSTORE_ACCOUNT=deployer" >&2
        exit 1
    fi
}

require_roles() {
    : "${TREASURY:?Set TREASURY (cold multisig holding protocol funds)}"
    : "${MULTISIG:?Set MULTISIG (cold multisig holding Ownable; disjoint from TREASURY)}"
    : "${PAUSE_GUARDIAN:?Set PAUSE_GUARDIAN (hot pause-only multisig; disjoint from both)}"
}

require_etherscan_key() {
    : "${ETHERSCAN_API_KEY:?Set ETHERSCAN_API_KEY (Etherscan v2 API key)}"
}

print_header() {
    echo ""
    echo "========================================="
    echo "  TEGRIDDY FARMS — MVP DEPLOY"
    echo "========================================="
    echo "Script:    $DEPLOY_SCRIPT"
    echo "Chain:     Ethereum Mainnet (ID: 1)"
    echo "Treasury:  ${TREASURY:-<unset>}"
    echo "Multisig:  ${MULTISIG:-<unset>}"
    echo "Guardian:  ${PAUSE_GUARDIAN:-<unset>}"
    if [ -n "$KEYSTORE_ACCOUNT" ]; then
        echo "Deployer:  $("$CAST" wallet address --account "$KEYSTORE_ACCOUNT" 2>/dev/null || echo 'unknown')"
    elif [ -n "$PRIVATE_KEY" ]; then
        echo "Deployer:  $("$CAST" wallet address "$PRIVATE_KEY" 2>/dev/null || echo 'unknown')"
    else
        echo "Deployer:  <signer not configured>"
    fi
    echo "========================================="
    echo ""
}

case "${1:-}" in
    simulate)
        require_signer
        require_roles
        print_header
        echo "MODE: DRY-RUN SIMULATION (no gas spent)"
        "$FORGE" script "$DEPLOY_SCRIPT" --rpc-url "$RPC_URL" "${SIGNER_FLAGS[@]}" -vvvv
        echo ""
        echo "Simulation complete. If it looks good:  bash deploy-mvp.sh broadcast"
        ;;

    broadcast)
        require_signer
        require_roles
        require_etherscan_key
        print_header
        echo "MODE: LIVE BROADCAST TO MAINNET + Etherscan verify (libraries auto-linked)"
        # Read confirmation from /dev/tty so `yes | bash ...` cannot bypass it.
        read -p "Spend real ETH and deploy to mainnet? Type 'yes' to confirm: " confirm </dev/tty
        [ "$confirm" = "yes" ] || { echo "Aborted."; exit 0; }
        "$FORGE" script "$DEPLOY_SCRIPT" \
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
            --broadcast --slow \
            --verify --etherscan-api-key "$ETHERSCAN_KEY" \
            -vvvv
        echo ""
        echo "BROADCAST COMPLETE. Addresses in forge output + broadcast/DeployMVP.s.sol/1/run-latest.json"
        echo "NEXT: multisig acceptOwnership() within the OwnableNoRenounce expiry, then:"
        echo "  export STAKING=... JBAC_VAULT=... STAKING_ADMIN=... FACTORY=... ROUTER=... PAIR=... TWAP=..."
        echo "  export REVENUE_DISTRIBUTOR=... REFERRAL_SPLITTER=... SWAP_FEE_ROUTER=... SWAP_FEE_ROUTER_ADMIN=... POL_ACCUMULATOR=..."
        echo "  bash deploy-mvp.sh check"
        ;;

    verify)
        require_signer
        require_etherscan_key
        print_header
        echo "MODE: ETHERSCAN VERIFICATION (retry; reads last broadcast, libraries auto-linked)"
        "$FORGE" script "$DEPLOY_SCRIPT" \
            --rpc-url "$RPC_URL" \
            "${SIGNER_FLAGS[@]}" \
            --resume --verify --etherscan-api-key "$ETHERSCAN_KEY" \
            -vvvv
        echo "VERIFICATION COMPLETE (or already up-to-date)."
        ;;

    check)
        require_roles
        echo "MODE: POST-DEPLOY INVARIANT CHECK (VerifyMVP, read-only)"
        echo "      Requires the deployed-address env vars (see header). Any INV-* failure halts."
        "$FORGE" script "$VERIFY_SCRIPT" --rpc-url "$RPC_URL" -vvvv
        echo "INVARIANTS PASSED."
        ;;

    *)
        echo "Usage: bash deploy-mvp.sh [simulate|broadcast|verify|check]"
        echo ""
        echo "  simulate   Dry run against mainnet (no gas)"
        echo "  broadcast  Deploy to mainnet (costs ETH!) + Etherscan verify"
        echo "  verify     Retry Etherscan verification of the last broadcast"
        echo "  check      Run VerifyMVP invariants (after multisig acceptOwnership)"
        echo ""
        echo "Typical flow: simulate -> broadcast -> (acceptOwnership) -> check"
        ;;
esac
