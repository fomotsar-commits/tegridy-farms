# Robinhood Chain (4663): the dry-run → cast-replay deploy method

**Why this exists:** `forge script --broadcast` HARD-FAILS on chain 4663 —
forge's broadcast path does a chain-registry lookup and dies
`Error: Chain 4663 not supported` (`--legacy` does not help). Proven on the
M.1 role-Safe deploy, 2026-08-24. `cast send` has no such lookup and works.
Every Robinhood contract leg (M.2 MVP → M.3 rail → M.16 curve → M.9/M.7
graduation stack) therefore deploys by replaying the forge DRY-RUN's
transactions with `cast send`, one by one, in order.

The M.1 Safes tolerated sloppy replay because they were **CREATE2 through the
canonical factory** — identical calldata ⇒ identical address regardless of
nonce. The contract legs are **plain CREATEs**: every address is
`f(sender, nonce)`, so the replay is only valid if the sender's nonce sequence
exactly matches the dry-run's. That is the whole discipline below.

## The procedure

1. **Dry-run with the REAL sender** (this half of forge works fine on 4663):

   ```
   forge script script/robinhood/DeployRobinhoodMVP.s.sol --rpc-url $ROBINHOOD_RPC --sender <deployer EOA> -vvv
   ```

   Output lands in `contracts/broadcast/<script>/4663/dry-run/run-latest.json`.
   Read every printed invariant. The JSON's `transactions[]` carry the exact
   calldata AND the predicted `contractAddress` for each CREATE.

2. **Freeze the sender.** From this moment until the replay completes, the
   deployer EOA sends NOTHING else on 4663 — any stray tx shifts every
   subsequent CREATE address and silently invalidates all the dry-run's
   predicted addresses and their cross-references.

3. **Assert the starting nonce matches** what the dry-run assumed:

   ```
   cast nonce <deployer EOA> --rpc-url $ROBINHOOD_RPC
   ```

   It must equal the first transaction's `nonce` in the dry-run JSON. If it
   does not, RE-RUN the dry-run (step 1) — never "adjust" by hand.

4. **Replay each `transactions[]` entry IN ORDER:**

   - CREATE entries (`transactionType: "CREATE"`, no `to`):
     `cast send --create <transaction.data> --rpc-url $ROBINHOOD_RPC --private-key $PK --legacy --gas-price 100000000`
   - CALL entries:
     `cast send <transaction.to> <transaction.data> --rpc-url $ROBINHOOD_RPC --private-key $PK --legacy --gas-price 100000000`
   - Entries with `value != 0x0`: add `--value <value>`.

   ⚠️ Gas: bare `--legacy` pulls `eth_gasPrice` ≈ the bare base fee with no
   buffer, and 2 of 4 M.1 sends were rejected `max fee per gas less than block
   base fee` on a base-fee tick. Always pass an explicit `--gas-price` ~5× base
   (0.1 gwei = 100000000 on 4663 today). Arbitrum-Orbit refunds down to the
   actual base fee, so overpaying here costs nothing.

5. **Verify after EVERY send, before the next:** receipt `status 0x1`, and for
   each CREATE, code at the PREDICTED address:

   ```
   cast code <predicted contractAddress> --rpc-url $ROBINHOOD_RPC
   ```

   Non-empty and at the predicted address, or ABORT the sequence — do not
   "continue and fix later"; every later address depends on this nonce.

   ⚠️ `additionalContracts[]` (sub-deploys a factory makes inside one tx) are
   NOT covered by checking the top-level `contractAddress` — verify each of
   those addresses too. The registry verifier is blind to them
   (`verify-addresses.mjs` reads only top-level entries; known gap).

6. **Close the leg** with the read-only Verify script (plain `forge script`,
   no broadcast — works on 4663):

   ```
   forge script script/robinhood/VerifyRobinhoodMVP.s.sol --rpc-url $ROBINHOOD_RPC -vvv
   ```

   Then register every new address in `frontend/scripts/addresses.json`
   (FULL addresses only — never truncated) and commit the
   `4663/dry-run/run-latest.json` receipts.

## PowerShell notes (the operator drives from Windows)

- `$env:ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com"` — never `export`.
- forge/cast by full path if not on PATH: `& "$HOME\.foundry\bin\cast.exe" ...`
- One command per line; no `\` continuations.
- `--interactives 1` prompts for the key rather than putting it in history.
- Explorer for eyeballing: https://robinhoodchain.blockscout.com (Etherscan v2
  does NOT serve 4663 — contract verification goes through Blockscout).
