# Stops ONLY the e2e validator (the one whose ledger is $E2E_LEDGER), never a rehearsal one.
# From Git Bash: MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash -l /mnt/c/<...>/frontend/scripts/solana-localnet/stop-validator.sh
set -u
LEDGER=${E2E_LEDGER:-$HOME/tegridy-e2e-ledger}
if pkill -f -- "solana-test-validator --reset --ledger $LEDGER"; then
  for _ in $(seq 1 20); do pgrep -f -- "--ledger $LEDGER" >/dev/null || break; sleep 0.5; done
  echo "stopped the e2e validator ($LEDGER)"
else
  echo "no e2e validator was running ($LEDGER)"
fi
