#!/usr/bin/env bash
# Devnet deploy for the Tegridy CP-AMM fork (Phase 0 runtime proof).
#
# Prereqs:
#   - solana CLI on PATH
#   - the CI-built DEVNET program binary at target/deploy/raydium_cp_swap.so:
#       gh run download <solana-ci run id> --name tegridy-cp-amm-devnet-sbf --dir target/deploy
#   - keys/devnet-admin.json (payer+admin) and keys/tegridy-amm-program.json (program id)
#     — both devnet throwaways generated in Phase 0 (gitignored).
#
# A ~692KB program needs ~5 SOL of rent to deploy. Devnet airdrops are rate-limited
# (~1-2 SOL/request); if the CLI faucet is dry, top up the DEPLOYER pubkey printed
# below via the web faucet: https://faucet.solana.com  (paste the pubkey).
set -euo pipefail
cd "$(dirname "$0")"

PAYER=keys/devnet-admin.json
PROGRAM_KP=keys/tegridy-amm-program.json
SO=target/deploy/raydium_cp_swap.so
NEED_SOL=5

[ -f "$SO" ] || { echo "Missing $SO — download the CI artifact first (see header)."; exit 1; }

solana config set --url devnet --keypair "$PAYER" >/dev/null
DEPLOYER=$(solana-keygen pubkey "$PAYER")
PROGRAM=$(solana-keygen pubkey "$PROGRAM_KP")
echo "Deployer (payer/admin): $DEPLOYER"
echo "Program id:             $PROGRAM"

# Top up to NEED_SOL via CLI airdrop (best-effort; web faucet is the fallback).
for _ in 1 2 3 4; do
  BAL=$(solana balance "$DEPLOYER" | awk '{print $1}')
  awk "BEGIN{exit !($BAL >= $NEED_SOL)}" && break
  echo "Balance ${BAL} SOL (< ${NEED_SOL}); requesting airdrop 2..."
  solana airdrop 2 "$DEPLOYER" || { echo "airdrop rate-limited — top up $DEPLOYER at https://faucet.solana.com then re-run"; break; }
  sleep 6
done

echo "Balance now: $(solana balance "$DEPLOYER")"
echo "Deploying..."
solana program deploy "$SO" --program-id "$PROGRAM_KP" --keypair "$PAYER"

echo "=== deployed — program account ==="
solana program show "$PROGRAM"

echo
echo "=== required: the pool-fee receiver must be a WSOL token account (create_pool_fee_reveiver) ==="
# Pool creation deserializes create_pool_fee_reveiver::ID as a WSOL TokenAccount, so it
# MUST exist on-chain or every initialize() reverts. It is the deployer's WSOL ATA.
WSOL=So11111111111111111111111111111111111111112
spl-token create-account "$WSOL" --owner "$DEPLOYER" --fee-payer "$PAYER" 2>&1 | tail -2 || \
  echo "  (WSOL ATA may already exist — ok)"
echo "  WSOL ATA (must equal create_pool_fee_reveiver::ID = 27AC7Yww…): $(spl-token address --token $WSOL --owner $DEPLOYER --verbose 2>/dev/null | awk '/Associated/{print $NF}')"

echo
echo "NEXT (smoke test, via the client/ tooling): create_config (protocol_owner is set to the"
echo "admin caller — repoint to a distinct treasury with update_config param=3 if desired),"
echo "init a pool, swap, and verify the protocol fee accrues. Adapt tests/ + Anchor.toml for"
echo "the fork program id + the WSOL create_pool_fee_reveiver to run the anchor test suite."
