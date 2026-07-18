#!/usr/bin/env bash
# rehome-ownership.sh — DEPLOYER-SIDE ownership re-home (Runbook Step B).
#
# Moves every deployer-owned privileged role off the hot deployer EOA onto the rebuilt
# ADMIN Safe. This script does ONLY the parts the DEPLOYER signs:
#   • transferOwnership(ADMIN_SAFE) on the 18 two-step OwnableNoRenounce contracts
#     (this ALSO overwrites any stale 0xA360 pending slot + re-stamps a fresh 14-day
#      window, so it works whether or not you ran cancel-gated-pending.sh first), and
#   • TegridyFactory's feeToSetter re-home (cancel a stale proposal FIRST — proposeFeeToSetter
#     reverts CANCEL_EXISTING_FIRST otherwise — then propose the ADMIN Safe).
#
# It does NOT do (see docs/SAFE_REHOME_RUNBOOK.md — these are the Safe's/other steps):
#   • acceptOwnership() — signed by the ADMIN Safe, WITHIN 14 days of each transfer.
#   • acceptFeeToSetter() — signed by the ADMIN Safe, after the FEE_TO_SETTER_DELAY,
#     within the 7-day MAX_SETTER_PROPOSAL_VALIDITY window.
#   • TegridyNFTPoolFactory — it is ctor-owned by the flagged 0xA360 Safe, so ONLY 0xA360
#     can transferOwnership it (operate the old Safe once before decommissioning it).
#   • pauseGuardian → GUARDIAN Safe + the factory guardian rotation (runbook §4.3) — done
#     separately; left out here to keep this script to owner-role calls only.
#   • VerifyMVP + the on-chain owner()/pendingOwner()==0 sweep (runbook Step C).
#
# ── USAGE ───────────────────────────────────────────────────────────────────────
#   PREREQUISITE: rebuild the 3 Safes FIRST (runbook Step A). ADMIN_SAFE must be a
#   deployed multisig CONTRACT (this script refuses an EOA / empty-code address).
#   Dry-run (READ-ONLY — prints owner/pending per contract, sends nothing):
#     RPC_URL=https://your-rpc  ADMIN_SAFE=0xYourRebuiltAdminSafe  \
#       bash contracts/script/rehome-ownership.sh
#   Broadcast:
#     RPC_URL=https://your-rpc  ADMIN_SAFE=0x...  SIGNER="--account deployer"  \
#       bash contracts/script/rehome-ownership.sh --broadcast
#   Signer: --account <foundry-keystore> OR --ledger (never a raw key on the CLI).
#   MEV/privacy (standing preference for admin txs): point RPC_URL at Flashbots/MEV-Blocker.
set -euo pipefail

DEPLOYER="0x14898258122C0740106391E6e8E4F17F3b6d456E"
: "${RPC_URL:?set RPC_URL to a mainnet endpoint}"
: "${ADMIN_SAFE:?set ADMIN_SAFE to the REBUILT admin multisig (a deployed Safe contract)}"
SIGNER="${SIGNER:-}"
BROADCAST=0
[ "${1:-}" = "--broadcast" ] && BROADCAST=1

# The 18 deployer-owned OwnableNoRenounce (Ownable2Step + 14d) contracts.
TWO_STEP="
TegridyStaking:0xcaDc93E96De58EA554c71ca609974625615E046D
TegridyStakingAdmin:0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3
TegridyTWAP:0xdFdd6D72539A425dC917F49FB834901105cA98c9
RevenueDistributor:0xF993316E2fC079de4358c489A935E01e03E23E17
SwapFeeRouter:0x6d5791A660e79175F74C6D639584C98422d5956E
SwapFeeRouterAdmin:0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060
POLAccumulator:0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2
ReferralSplitter:0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c
TegridyLPFarming:0x1171268AE5B69791c47Fd589b7825932c957e149
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
FACTORY="0xa24C7287eC56A7DEFDc70033803451240e267a52"  # feeToSetter model, handled separately
ZERO="0x0000000000000000000000000000000000000000"

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

CHAIN=$(cast chain-id --rpc-url "$RPC_URL")
[ "$CHAIN" = "1" ] || { echo "REFUSING: chainid=$CHAIN, expected 1 (mainnet)"; exit 1; }
# ADMIN_SAFE MUST be a contract (a rebuilt Safe), never an EOA — the whole point.
SAFE_CODE=$(cast code "$ADMIN_SAFE" --rpc-url "$RPC_URL")
if [ "$SAFE_CODE" = "0x" ] || [ -z "$SAFE_CODE" ]; then
  echo "REFUSING: ADMIN_SAFE ($ADMIN_SAFE) has NO code — it must be a deployed multisig, not an EOA."; exit 1
fi
if [ "$(lc "$ADMIN_SAFE")" = "$(lc "$DEPLOYER")" ]; then
  echo "REFUSING: ADMIN_SAFE == deployer. Re-home must target the rebuilt Safe."; exit 1
fi
if [ "$BROADCAST" = "1" ] && [ -z "$SIGNER" ]; then
  echo "REFUSING --broadcast without SIGNER (e.g. SIGNER=\"--account deployer\" or --ledger)"; exit 1
fi
echo "mode: $([ "$BROADCAST" = 1 ] && echo BROADCAST || echo DRY-RUN)   ADMIN_SAFE=$ADMIN_SAFE"
echo

echo "── 1) transferOwnership(ADMIN_SAFE) on the 18 two-step contracts ──────────────"
for entry in $TWO_STEP; do
  name="${entry%%:*}"; addr="${entry##*:}"
  owner=$(cast call "$addr" "owner()(address)" --rpc-url "$RPC_URL")
  pending=$(cast call "$addr" "pendingOwner()(address)" --rpc-url "$RPC_URL")
  printf '%-24s %s  owner=%s pending=%s\n' "$name" "$addr" "$owner" "$pending"
  if [ "$(lc "$owner")" = "$(lc "$ADMIN_SAFE")" ]; then
    echo "  SKIP: already owned by ADMIN_SAFE."; continue
  fi
  if [ "$(lc "$owner")" != "$(lc "$DEPLOYER")" ]; then
    echo "  SKIP: owner is neither deployer nor ADMIN_SAFE — verify manually before touching."; continue
  fi
  if [ "$BROADCAST" = "1" ]; then
    echo "  -> transferOwnership($ADMIN_SAFE)"
    # shellcheck disable=SC2086
    cast send "$addr" "transferOwnership(address)" "$ADMIN_SAFE" --rpc-url "$RPC_URL" $SIGNER
  else
    echo "  WOULD transferOwnership($ADMIN_SAFE)   then ADMIN_SAFE must acceptOwnership() within 14 days"
  fi
done
echo

echo "── 2) TegridyFactory feeToSetter re-home ($FACTORY) ───────────────────────────"
fset=$(cast call "$FACTORY" "feeToSetter()(address)" --rpc-url "$RPC_URL")
pfset=$(cast call "$FACTORY" "pendingFeeToSetter()(address)" --rpc-url "$RPC_URL")
fchg=$(cast call "$FACTORY" "feeToSetterChangeTime()(uint256)" --rpc-url "$RPC_URL")
printf '  feeToSetter=%s pendingFeeToSetter=%s changeTime=%s\n' "$fset" "$pfset" "$fchg"
if [ "$(lc "$fset")" = "$(lc "$ADMIN_SAFE")" ]; then
  echo "  SKIP: feeToSetter already ADMIN_SAFE."
elif [ "$(lc "$fset")" != "$(lc "$DEPLOYER")" ]; then
  echo "  SKIP: feeToSetter is not the deployer — verify manually."
else
  if [ "$fchg" != "0" ]; then
    echo "  A proposal is live (changeTime=$fchg). Must cancelFeeToSetterProposal() FIRST"
    echo "  (else proposeFeeToSetter reverts CANCEL_EXISTING_FIRST, TegridyFactory.sol:358)."
    if [ "$BROADCAST" = "1" ]; then
      echo "  -> cancelFeeToSetterProposal()"
      # shellcheck disable=SC2086
      cast send "$FACTORY" "cancelFeeToSetterProposal()" --rpc-url "$RPC_URL" $SIGNER
    else
      echo "  WOULD cancelFeeToSetterProposal()"
    fi
  fi
  if [ "$BROADCAST" = "1" ]; then
    echo "  -> proposeFeeToSetter($ADMIN_SAFE)"
    # shellcheck disable=SC2086
    cast send "$FACTORY" "proposeFeeToSetter(address)" "$ADMIN_SAFE" --rpc-url "$RPC_URL" $SIGNER
  else
    echo "  WOULD proposeFeeToSetter($ADMIN_SAFE)   then ADMIN_SAFE acceptFeeToSetter() after the"
    echo "  FEE_TO_SETTER_DELAY, within the 7-day validity window (TegridyFactory.sol:368)."
  fi
fi
echo

echo "── NEXT (NOT in this script — see docs/SAFE_REHOME_RUNBOOK.md) ─────────────────"
echo "  • From the ADMIN Safe: acceptOwnership() on each contract (within 14 days), then acceptFeeToSetter()."
echo "  • Re-home pauseGuardian -> GUARDIAN Safe (§4.3) + the factory guardian rotation."
echo "  • TegridyNFTPoolFactory: operate the OLD 0xA360 Safe once to transferOwnership(ADMIN_SAFE)."
echo "  • Run VerifyMVP + confirm owner()==ADMIN_SAFE and pendingOwner()==$ZERO on every contract."
echo "  • ONLY THEN set LAUNCHER_INTEGRATOR_ADDRESS = TREASURY Safe + flip LAUNCHER_ENABLED."
