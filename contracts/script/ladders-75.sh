#!/usr/bin/env bash
# ============================================================================
# ladders-75.sh: the six room ladders, redeployed at the 75% exit, one chain
# per run. Runbook: docs/LADDER_EXIT_75_REDEPLOY.md.
#
# Every address below is public and comes from frontend/scripts/addresses.json
# (tokens) and the live pools' own rewardsDistribution() (notifiers). YOU supply
# the signer and nothing else. NEVER put a raw private key on a command line.
#
# USAGE (from contracts/, forge and cast on PATH)
#   ./script/ladders-75.sh <ethereum|base|robinhood> <dry-run|anvil|broadcast> [pool ...]
#
#   dry-run    simulate every pool against the live chain. No gas, no signer.
#              Needs ETH_RPC_URL / BASE_RPC_URL / ROBINHOOD_RPC_URL.
#   anvil      deploy onto a local fork and read each pool back. No gas, no
#              signer. Start the fork first, in another terminal:
#                anvil --fork-url "$BASE_RPC_URL" --auto-impersonate --port 8545
#              Override the fork with ANVIL_RPC (default http://127.0.0.1:8545).
#   broadcast  the real thing: one transaction per pool, your signature.
#                SIGNER="--account deployer" ./script/ladders-75.sh base broadcast
#                SIGNER="--ledger"           ./script/ladders-75.sh base broadcast
#                SIGNER="--interactive"      ./script/ladders-75.sh base broadcast
#
# An optional list of pool ids (qr mfer ...) limits a run to those pools.
# Order of the real deploy: base first (qr as the cheap rehearsal), ethereum last.
#
# ROBINHOOD CHAIN (4663): no room coin lives there yet (2026-10-18), so the chain
# has no hard-coded rows. The day one does, name its token and the same ladder
# deploys there at 75% with one command, the fee Safe as notifier:
#   ROBINHOOD_STAKING_TOKEN=0x<room token> ROBINHOOD_POOL_ID=<room> \
#     ./script/ladders-75.sh robinhood dry-run      # then anvil, then broadcast
# ============================================================================
set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/redact-url.sh
. "$_HERE/lib/redact-url.sh"
cd "$(dirname "$0")/.."   # -> contracts/

CHAIN="${1:-}"
MODE="${2:-}"
shift 2 2>/dev/null || true
ONLY=("$@")

# id|staking token|rewardsDistribution (the Safe allowed to notifyRewardAmount)
case "$CHAIN" in
  ethereum)
    CHAIN_ID=1
    RPC="${ETH_RPC_URL:-}"
    POOLS=(
      "pepe|0x6982508145454ce325ddbe47a25d4ec3d2311933|0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d"
    ) ;;
  base)
    CHAIN_ID=8453
    RPC="${BASE_RPC_URL:-}"
    POOLS=(
      "qr|0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1"
      "mfer|0xe3086852a4b125803c815a158249ae468a3254ca|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1"
      "bnkr|0x22af33fe49fd1fa80c7149773dde5890d3c76f3b|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1"
      "drb|0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1"
      "jbm|0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1"
    ) ;;
  robinhood)
    CHAIN_ID=4663
    RPC="${ROBINHOOD_RPC_URL:-}"
    # The notifier is the chain's fee-remittance Safe: the same address and the
    # same two signers as on Base, 2 of 2 (read on 4663 on 2026-10-18: 171 bytes
    # of code, threshold 2, nonce 0). The ladder checks no sequencer feed.
    if [ -n "${ROBINHOOD_STAKING_TOKEN:-}" ]; then
      case "$ROBINHOOD_STAKING_TOKEN" in
        0x[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
        *) echo "ROBINHOOD_STAKING_TOKEN must be a 0x address of 40 hex digits" >&2; exit 2 ;;
      esac
      POOLS=("${ROBINHOOD_POOL_ID:-room}|${ROBINHOOD_STAKING_TOKEN}|0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1")
    else
      POOLS=()
    fi ;;
  *)
    echo "usage: $0 <ethereum|base|robinhood> <dry-run|anvil|broadcast> [pool ...]" >&2
    exit 2 ;;
esac

case "$MODE" in
  dry-run|anvil|broadcast) ;;
  *) echo "usage: $0 <ethereum|base|robinhood> <dry-run|anvil|broadcast> [pool ...]" >&2; exit 2 ;;
esac

if [ "${#POOLS[@]}" -eq 0 ]; then
  echo "no room ladder is configured for $CHAIN; nothing to do." >&2
  [ "$CHAIN" = robinhood ] && echo "Name the room's token: ROBINHOOD_STAKING_TOKEN=0x... ROBINHOOD_POOL_ID=<room> $0 robinhood $MODE" >&2
  exit 0
fi

# Mode-specific plumbing. The anvil mode sends from a fresh codeless address the
# fork funds for us (anvil's well-known accounts carry a 7702 sweeper on real
# forks), and keeps forge's broadcast log OUT of contracts/broadcast: a fork
# keeps the real chain id, and the log would otherwise land in .../1/ or
# .../8453/ beside the real deploys.
EXTRA=()
case "$MODE" in
  dry-run)
    if [ -z "$RPC" ]; then
      echo "set ETH_RPC_URL / BASE_RPC_URL / ROBINHOOD_RPC_URL for $CHAIN" >&2
      exit 2
    fi
    ;;
  anvil)
    RPC="${ANVIL_RPC:-http://127.0.0.1:8545}"
    SENDER="${ANVIL_SENDER:-0x1111111111111111111111111111111111111111}"
    got="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
    if [ "$got" != "$CHAIN_ID" ]; then
      echo "anvil at $(redact_url "$RPC") reports chain id '${got:-none}', expected $CHAIN_ID (fork the right chain, keep its id)" >&2
      exit 2
    fi
    cast rpc --rpc-url "$RPC" anvil_setBalance "$SENDER" 0x8AC7230489E80000 > /dev/null   # 10 ETH
    export FOUNDRY_BROADCAST="${TMPDIR:-/tmp}/ladders-75-anvil-broadcast"
    EXTRA=(--broadcast --unlocked --sender "$SENDER")
    ;;
  broadcast)
    if [ -z "$RPC" ]; then
      echo "set ETH_RPC_URL / BASE_RPC_URL / ROBINHOOD_RPC_URL for $CHAIN" >&2
      exit 2
    fi
    [ -n "${SIGNER:-}" ] || { echo "set SIGNER, e.g. SIGNER=\"--account deployer\" (or --ledger, or --interactive)" >&2; exit 2; }
    case "$SIGNER" in *--private-key*) echo "refusing: never pass a raw key on the command line; use a keystore (cast wallet import), --ledger or --interactive" >&2; exit 2 ;; esac
    # shellcheck disable=SC2206
    EXTRA=(--broadcast $SIGNER)
    ;;
esac

echo "chain: $CHAIN ($CHAIN_ID)   mode: $MODE   rpc: $(redact_url "$RPC")"
echo

RESULTS=()
for row in "${POOLS[@]}"; do
  IFS='|' read -r id token notifier <<< "$row"
  if [ "${#ONLY[@]}" -gt 0 ]; then
    keep=0; for o in "${ONLY[@]}"; do [ "$o" = "$id" ] && keep=1; done
    [ "$keep" -eq 1 ] || continue
  fi
  echo "== $id: stake $token, notifier $notifier =="
  # Through tee, not into a variable: a keystore or --interactive prompt must reach
  # the terminal, and the owner should see every line forge prints before signing.
  log="$(mktemp)"
  if ! EXPECTED_CHAIN_ID="$CHAIN_ID" STAKING_TOKEN="$token" REWARDS_DISTRIBUTION="$notifier" \
       forge script script/DeployLighthouseLadder.s.sol --rpc-url "$RPC" "${EXTRA[@]}" 2>&1 | tee "$log"; then
    echo "FAILED on $id. An L-INV-13 revert means the build is not the 75% one: rebuild, do not repin." >&2
    exit 1
  fi
  echo "   --"
  grep -E "LighthouseLadder:|before the lock|L-INV|ONCHAIN EXECUTION|Error|revert" "$log" | sed 's/^/   /' || true
  addr="$(grep -oE '1\. LighthouseLadder: 0x[0-9a-fA-F]{40}' "$log" | head -1 | grep -oE '0x[0-9a-fA-F]{40}' || true)"
  rm -f "$log"
  if [ "$MODE" = "dry-run" ]; then
    RESULTS+=("$id|simulated|$addr")
    continue
  fi
  [ -n "$addr" ] || { echo "could not find the deployed address in forge's output for $id" >&2; exit 1; }
  # Read the pool back from the chain it now lives on, the way Phase C does.
  # The ladder's law, read back: the cap, and one year left quoted at the chain's own
  # clock (exactly 25% in the block it is asked in; a block of drift is noise).
  cap="$(cast call "$addr" 'MAX_EARLY_EXIT_PENALTY_BPS()(uint256)' --rpc-url "$RPC")"
  chain_now="$(cast block latest -f timestamp --rpc-url "$RPC")"
  year="$(cast call "$addr" 'penaltyFor(uint256,uint64)(uint256)' 1000000000000000000 "$((chain_now + 31536000))" --rpc-url "$RPC")"
  minstake="$(cast call "$addr" 'MIN_STAKE()(uint256)' --rpc-url "$RPC")"
  dist="$(cast call "$addr" 'rewardsDistribution()(address)' --rpc-url "$RPC")"
  stk="$(cast call "$addr" 'stakingToken()(address)' --rpc-url "$RPC")"
  RESULTS+=("$id|$addr|cap=${cap%% *} oneYearLeft=${year%% *} minStake=${minstake%% *} notifier=$dist token=$stk")
  [ "${cap%% *}" = "7500" ] || { echo "READ-BACK: $id answers MAX_EARLY_EXIT_PENALTY_BPS=$cap, not 7500" >&2; exit 1; }
  # 0.25e18 within 1e14 (about 3.5 hours of schedule): bash arithmetic overflows on wei, so node.
  node -e 'const q=BigInt(process.argv[1]),t=250000000000000000n,d=q>t?q-t:t-q; process.exit(d<=100000000000000n?0:1)' "${year%% *}" \
    || { echo "READ-BACK: $id quotes ${year%% *} for one year left, not 25% of 1e18: not the ladder's law" >&2; exit 1; }
  echo
done

echo
echo "=== $CHAIN / $MODE ==="
for r in "${RESULTS[@]}"; do
  IFS='|' read -r id addr note <<< "$r"
  printf '%-5s %-44s %s\n' "$id" "$addr" "$note"
done
case "$MODE" in
  dry-run)  echo; echo "Simulated only. Nothing was sent. Next: the anvil rehearsal, or broadcast with SIGNER set." ;;
  anvil)    echo; echo "Deployed on the local fork only. The broadcast log went to $FOUNDRY_BROADCAST, not contracts/broadcast." ;;
  broadcast)
    echo
    echo "DEPLOYED. The addresses above come from forge's own output; EIP-55 them with"
    echo "  cast to-check-sum-address <addr>"
    echo "and hand them to the agent for the repin PR (runbook, Phase D). Commit"
    echo "  broadcast/DeployLighthouseLadder.s.sol/$CHAIN_ID/run-latest.json"
    echo "with it. Key its entries by (from, nonce), never by hash." ;;
esac
