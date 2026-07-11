# Tegridy CP-AMM — Mainnet Runbook

Step-by-step to take the audited fork live. **Do not start before the diff-audit is
complete** (`AUDIT_RFQ.md`). Every signing step is the operator's; a Squads multisig
should hold all authorities. Devnet dry-run first (`deploy-devnet.sh`).

Legend: 🔑 = needs a key/signature · 💰 = costs SOL · 🌐 = external submission

---

## 0. Prereqs
- Diff-audit passed; findings (if any) fixed and re-diffed (CI `diff-guard` still green).
- Squads multisig created for **admin** and a **treasury** address chosen.
- `solana` CLI installed; `solana config set --url mainnet-beta`.

## 1. 🔑 Generate the mainnet program keypair
```bash
solana-keygen new -o keys/mainnet-program.json     # keep OFFLINE / in the vault; this IS the program address
solana-keygen pubkey keys/mainnet-program.json
```

## 2. 🔑 Set the mainnet authority constants (the 4-constant diff, mainnet side)
Edit the `#[cfg(not(feature = "devnet"))]` values only:
- `programs/cp-swap/src/lib.rs`
  - `declare_id!(…)` → the pubkey from step 1
  - `admin::ID` → **Squads multisig**
  - `create_pool_fee_reveiver::ID` → **treasury**
- `programs/cp-swap/src/instructions/admin/create_support_mint_associated.rs`
  - `create_support_mint_associated_owner::ID` → **Squads multisig**

Commit → CI `diff-guard` must stay green (proves you changed only these constants).

## 3. Build the verifiable mainnet binary
Prefer the reproducible CI build (download the `tegridy-cp-amm-sbf` artifact from the
green `solana-ci` run), or a local **verifiable build** (`solana-verify build`) so the
on-chain bytecode is provably this source. Confirm the built program-id matches step 1.

## 4. 🔑💰 Deploy + lock down the upgrade authority
```bash
solana program deploy <artifact>.so --program-id keys/mainnet-program.json   # ~5 SOL rent
# Move upgrade authority to the multisig (or burn it if you want immutability):
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG>
solana program show <PROGRAM_ID>   # verify authority + last-deployed slot
```
> Optionally publish a verifiable build so explorers show source == bytecode.

## 5. 🔑 Create the AmmConfig (this is where Tegridy's fee is set)
Use the repo's `client/` tooling (point it at mainnet + the multisig signer). `create_config`
is **admin-only** and sets, for a chosen `index`:
- `protocol_owner` → **treasury** (this is what makes every swap pay Tegridy)
- `trade_fee_rate` (e.g. 2500 = 0.25%), `protocol_fee_rate` (share of the trade fee to
  treasury; must be ≤ trade_fee_rate), `fund_fee_rate`, `create_pool_fee`
Fee rates use denominator 1_000_000 (see `curve/fees.rs`).

## 6. 🔑💰 Create + seed a pool
Via `client/` (`initialize` / `initialize_customizable`): pick the Solana-native pair, seed
with treasury capital. Withdrawable — you keep the LP position (no permanent lock). Keep it
deep enough to stay above Jupiter's routing threshold (§8).

## 7. 🔑 Collect fees (recurring)
`collect_protocol_fee` → treasury (multisig signs). Protocol fee accrues on every swap.

## 8. 🌐 Get routed + drive volume
- **Submit to Jupiter's DEX integration** — until then retail won't auto-route to our AMM.
  Our own Solana swap UI can prefer our pools immediately (Jupiter `dexes` filter / direct
  pool quote), external fallback when ours isn't ideal.
- Jupiter re-checks pool liquidity every ~30 min and de-routes under-funded pools — keep the
  pool funded.

## 9. Frontend (assistant task, after pools exist)
Wire the Solana swap to prefer our pools + a Pools/Earn surface showing TVL/vol/fees/APR and
protocol-fee accrual. Gated dark until pool addresses are configured (same pattern as the
fee-wallet env var).

---

### Rollback / safety
- Program upgrade authority at the multisig can patch a bug (or was burned for immutability).
- Positions are **withdrawable** — treasury can pull capital from any pool at any time.
- If a pool underperforms, withdraw + redeploy capital elsewhere; the program keeps running.
