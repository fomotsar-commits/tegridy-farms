#!/usr/bin/env bash
# cancel-gated-pending.sh — TIME-SENSITIVE (act before ~2026-07-30).
#
# The 9 gated-batch contracts (deployed 2026-07-16) still have OPEN 14-day
# `acceptOwnership` windows to the FLAGGED Safe 0xA360…b7F8. Until they expire
# (~2026-07-30) that Safe — whose signer quorum is the red-team HIGH we're rebuilding —
# could `acceptOwnership()` and seize them. This closes that window NOW by calling
# `cancelOwnershipTransfer(reason)` from the deployer (the current owner), which clears
# the pending slot + zeros the expiry (OwnableNoRenounce.sol:205). Needs NO rebuilt Safe.
#
# ── WHEN YOU CAN SKIP THIS ──────────────────────────────────────────────────────
# If you will rebuild the Safe and run the FULL re-home (transferOwnership(newSafe))
# on these contracts BEFORE ~2026-07-30, you can skip this — transferOwnership also
# overwrites the pending 0xA360 slot. Run this only if the rebuild might slip past the
# window, or to neutralize the risk immediately regardless of rebuild timing.
#
# ── USAGE ───────────────────────────────────────────────────────────────────────
#   Dry-run (READ-ONLY — prints owner/pendingOwner/expiry, sends nothing):
#     RPC_URL=https://your-rpc  bash contracts/script/cancel-gated-pending.sh
#   Broadcast (sends cancelOwnershipTransfer from your signer):
#     RPC_URL=https://your-rpc  SIGNER="--account deployer"  \
#       bash contracts/script/cancel-gated-pending.sh --broadcast
#   Signer: --account <foundry-keystore>  OR  --ledger  (never a raw key on the CLI).
#   MEV/privacy (standing preference for admin txs): set RPC_URL to Flashbots/MEV-Blocker.
#
# Guards: mainnet-only (chainid==1); per-contract it VERIFIES owner()==deployer and
# pendingOwner()==the flagged Safe before doing anything — a contract already re-homed,
# already cancelled, or with a different pending owner is SKIPPED, never touched.
set -euo pipefail

DEPLOYER="0x14898258122C0740106391E6e8E4F17F3b6d456E"
FLAGGED="0xA36053477568Fb5382492F3A5970D35Fe896b7F8"
REASON="close stale 0xA360 pending ownership pre-Safe-rebuild"
: "${RPC_URL:?set RPC_URL to a mainnet endpoint}"
SIGNER="${SIGNER:-}"
BROADCAST=0
[ "${1:-}" = "--broadcast" ] && BROADCAST=1

# name:address — the 9 gated-batch contracts with windows OPEN until ~2026-07-30.
# (LPFarming + the 8 core MVP windows already EXPIRED ~Jun 20-22; NFTPoolFactory is
#  ctor-owned directly by 0xA360 and has no pending slot — none are in this list.)
CONTRACTS="
GaugeController:0x6c79522d47cf6d1051cb474e81d9b6f3996c1054
TegridyNFTLending:0x89BeB6cc0255B7465c01aA38a6f937efd345f14F
TegridyNFTLendingAdmin:0x693787831e9C36A98aFEDAd39f8728491F580a9C
VoteIncentives:0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF
VoteIncentivesAdmin:0xf87Ec231BA7FA3975619309bc16C698B2ea3B300
CommunityGrants:0xebc3aaf48297b8ccfa8272d9e68c1545eb9cd471
TegridyLaunchpadV2:0xa6149b4d05138a4073902a0ca0345c2d0e470df7
MemeBountyBoard:0x6d2c6ec29d97fe8b6d1471091deee36baf69d890
PremiumAccess:0x9dc2675b2017687dd9768c63d15f0ad5194fa3f5
"

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

CHAIN=$(cast chain-id --rpc-url "$RPC_URL")
[ "$CHAIN" = "1" ] || { echo "REFUSING: chainid=$CHAIN, expected 1 (mainnet)"; exit 1; }
if [ "$BROADCAST" = "1" ] && [ -z "$SIGNER" ]; then
  echo "REFUSING --broadcast without SIGNER (e.g. SIGNER=\"--account deployer\" or --ledger)"; exit 1
fi
echo "mode: $([ "$BROADCAST" = 1 ] && echo BROADCAST || echo DRY-RUN)   rpc: $RPC_URL"
echo

for entry in $CONTRACTS; do
  name="${entry%%:*}"; addr="${entry##*:}"
  owner=$(cast call "$addr" "owner()(address)" --rpc-url "$RPC_URL")
  pending=$(cast call "$addr" "pendingOwner()(address)" --rpc-url "$RPC_URL")
  expiry=$(cast call "$addr" "ownershipTransferExpiresAt()(uint256)" --rpc-url "$RPC_URL")
  printf '%-26s %s\n  owner=%s pending=%s expiresAt=%s\n' "$name" "$addr" "$owner" "$pending" "$expiry"

  if [ "$(lc "$owner")" != "$(lc "$DEPLOYER")" ]; then
    echo "  SKIP: owner is not the deployer (already re-homed or unexpected) — verify manually."; echo; continue
  fi
  if [ "$(lc "$pending")" != "$(lc "$FLAGGED")" ]; then
    echo "  SKIP: pendingOwner is not the flagged Safe (already cleared / different target)."; echo; continue
  fi

  if [ "$BROADCAST" = "1" ]; then
    echo "  -> cancelOwnershipTransfer(\"$REASON\")"
    # shellcheck disable=SC2086
    cast send "$addr" "cancelOwnershipTransfer(string)" "$REASON" --rpc-url "$RPC_URL" $SIGNER
  else
    echo "  WOULD cancelOwnershipTransfer(\"$REASON\")  (re-run with --broadcast + SIGNER to send)"
  fi
  echo
done
echo "done. After broadcast, re-run in dry-run mode to confirm pending==0x0 on each."
