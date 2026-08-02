# Tegridy CP-AMM — Mainnet Runbook

Step-by-step to take the audited fork live. **Do not start before the diff-audit is
complete** (`AUDIT_RFQ.md`). Every signing step is the operator's; a Squads multisig
should hold all authorities. Devnet dry-run first (`deploy-devnet.sh`).

Legend: 🔑 = needs a key/signature · 💰 = costs SOL · 🌐 = external submission

---

## 0. Prereqs
- Diff-audit passed; findings (if any) fixed and re-diffed (CI `diff-guard` still green).
- `solana` CLI installed; `solana config set --url mainnet-beta`.

### The identities, and which already exist

Verified on mainnet 2026-08-01. The first two exist **now**; do not regenerate them.

| # | Identity | Value | State |
|---|---|---|---|
| 1 | Squads multisig | `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` | **Exists.** Owner `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, **threshold = 2** (u16 at data offset 72) |
| 2 | Admin = Squads **vault PDA**, index 0 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | **Exists.** System-owned, non-executable, 0.001 SOL |
| 3 | Fee receiver = vault's **WSOL ATA** | `2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa` | ⚠️ **DOES NOT EXIST YET** — must be created on-chain (§2b) |
| 4 | cp-swap program keypair | — | Must be generated (§1) |
| 5 | `tegridy-launch` program keypair | — | Must be generated (§1) |
| 6 | `tegridy-launch` deploy authority | — | Must be generated (§1). A plain wallet: it is `Signer` **and** `payer` for `initialize_global`, so it must hold SOL |

Re-derive #2 rather than trusting this table — the derivation is what binds it to the
multisig. Checking "owner == System Program" is **not** sufficient; every ordinary wallet
is System-owned too.

```bash
SQUADS_MULTISIG=EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK SQUADS_VAULT_INDEX=0   node frontend/scripts/solana-dbc-operator.mjs derive-vault
```

## 1. 🔑 Generate the mainnet program keypair
```bash
solana-keygen new -o keys/mainnet-program.json     # keep OFFLINE / in the vault; this IS the program address
solana-keygen pubkey keys/mainnet-program.json
```

## 2. 🔑 Set the mainnet authority constants (the 4-constant diff, mainnet side)

⚠️ **`declare_id!` is the exception — it is NOT fail-closed.** The three authority
constants ship as System-Program sentinels (`1111…1111`) on the `#[cfg(not(feature =
"devnet"))]` arm, so a mainnet build genuinely cannot function until you replace them.
`declare_id!` does **not**: both arms currently hold the same devnet throwaway
`BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL`, whose keypair is a gitignored file that
is **not present in this checkout**. Forget this one and the build succeeds and deploys
to a throwaway address someone else may hold the key to. Replace it explicitly.
- `programs/cp-swap/src/lib.rs`
  - `declare_id!(…)` → the pubkey from step 1
  - `admin::ID` → **Squads multisig**
  - `create_pool_fee_reveiver::ID` → the treasury's **WSOL associated-token-account** (a
    native-SOL *token account*, NOT the treasury wallet — the create path consumes it as a
    `TokenAccount`; derive it with `spl-token address --token So111…112 --owner <treasury>`)
- `programs/cp-swap/src/instructions/admin/create_support_mint_associated.rs`
  - `create_support_mint_associated_owner::ID` → **Squads multisig**

⚠️ **CI will FAIL on this commit, by design.** The old guard only checked *which files*
differed; since #202 it canonicalises the delta and compares
`sha256` against a pinned `EXPECTED_DELTA_SHA256` in `.github/workflows/solana-ci.yml`.
Editing any constant changes the delta and fails `diff-guard` until a human re-pins it.
That is the intended workflow, not a breakage:

1. Push the constant change. `diff-guard` fails and **prints the full delta and the actual
   hash**.
2. Read the printed delta and satisfy yourself it is still only identity constants.
3. Update `EXPECTED_DELTA_SHA256` to the printed `actual` value **in the same PR**.

The delta is 86 lines over **three** files — `lib.rs`,
`instructions/admin/create_support_mint_associated.rs`, and `Cargo.toml`.

The program id is **mirrored in two more places** that the guard does not cover; all three
must agree or the client derives PDAs that do not exist under the deployed program:
- `Anchor.toml:20` (`raydium_cp_swap = "…"`)
- `frontend/src/lib/launcher/solana/curve/program.ts:28` (`CP_SWAP_PROGRAM_ID`)

Then **manually verify** all four mainnet constants equal your multisig / WSOL-ATA /
program id — not the sentinels, not the devnet keys.

## 2b. 💰 Create the fee-receiver WSOL ATA — BEFORE any pool is created
`create_pool_fee_reveiver::ID` is consumed as `InterfaceAccount<TokenAccount>`
(`instructions/initialize.rs:131-135`). Hardcoding an address that does not yet exist
compiles fine and then makes **every `create_pool` fail**. As of 2026-08-01 the ATA
`2sa31zce…` does not exist.

```bash
spl-token create-account So11111111111111111111111111111111111111112   --owner GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd --url mainnet-beta
```
Costs ~0.00204 SOL of rent — this is **not** part of the ~12 SOL deploy float. Verify it
landed and is a token account:
```bash
solana account 2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa --url mainnet-beta
# owner MUST be TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA — NOT the System Program
```

## 3. Build the verifiable mainnet binary
The CI `tegridy-cp-amm-devnet-sbf` artifact is a **devnet** build — do NOT deploy it to mainnet.
For mainnet, do a local **verifiable build** (`solana-verify build`, default/non-devnet features
so it picks up your step-2 mainnet values) so the on-chain bytecode is provably this source.
Confirm the built program-id matches step 1 and that the sentinels are gone.

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
is **admin-only**. All fee rates use denominator **1_000_000** (`curve/fees.rs`):
- `trade_fee_rate` — total swap fee, e.g. `2500` = 0.25%.
- `protocol_fee_rate` — the protocol's **share of the trade fee**, out of 1_000_000
  (Raydium default `120000` = **12% of the trade fee** ≈ 0.03% of volume at a 0.25% trade fee).
  Enforced bound: **`protocol_fee_rate + fund_fee_rate ≤ 1_000_000`** (there is NO "≤ trade_fee_rate"
  rule — setting it to `2500` would collect ~0.0006% of volume, i.e. almost nothing).
- `fund_fee_rate`, `create_pool_fee`.
- **`create_pool_fee` receiver** must be a **WSOL token account** (`create_pool_fee_reveiver::ID`
  from step 2 = the treasury's WSOL ATA), not a wallet.

`create_config` sets **`protocol_owner = fund_owner = the admin caller`** (the multisig) — there
is no treasury parameter. To hand fee-collection authority to a *distinct* treasury, call
`update_config` (param 3 = new protocol owner, param 4 = new fund owner) after this. Fees land at
whatever token account you name at collection time regardless.

## 5b. 🔑 Deploy + configure `tegridy-launch` (the bonding curve)

A **separate program** from cp-swap, deliberately — folding it in would break
`diff-guard` and turn a cheap four-constant diff-audit into a full AMM audit.

1. Generate its own mainnet keypair, then patch **both** `declare_id!(...)` and
   `deployer::ID` (the `#[cfg(not(feature = "devnet"))]` arm, which ships a
   fail-closed System-Program sentinel so a mainnet binary refuses to initialize
   until you set a real key). Build, deploy, move upgrade authority to the multisig.
2. Call `initialize_global`. **Three parameters are not free choices — get them
   wrong and the launcher misbehaves in ways nothing will warn you about later.**

### `creator_fee_share_bps` — the volume magnet; recommended **5_000** (50% of the fee)

The creator's share OF THE TRADE FEE, paid instantly and non-custodially to the
launch creator on every buy and sell (2026-08-02 economics synthesis). Every
surviving launchpad pays creators a streaming cut — pump.fun 0.30%/vol on-curve,
the Meteora-partner rail 0.48%/vol — and a curve that pays zero loses its
launches to the rails that pay. At `trade_fee_bps = 100` and a 5_000 share, the
creator earns 0.50%/vol (best on-curve rate among the majors) and the protocol
nets 0.50%/vol — still above the 0.32% the Meteora partner rail pays us.
Snapshotted per launch like the fee itself; `update_global` moves future
launches only. Bounded at 10_000 (100% of the fee).

### ⚠️ `migration_reserve_lamports` — minimum **192,156,720** (~0.1922 SOL)

Raised from traders on top of the target, and it pays cp-swap's costs at migration:
0.15 SOL `create_pool_fee` plus 42,156,720 lamports of rent for the five accounts
cp-swap creates (`observation_state` alone is 29.25M — 70% of the rent). Derived
from cp-swap's own `LEN` constants, not estimated. **Recommended: 0.25 SOL** for
headroom; the surplus is swept back to whoever calls migration, so
over-provisioning costs nothing but a slightly larger raise.

Too small and migration fails *after* the pool exists — the worst possible moment.

### ⚠️ `graduation_target_lamports` — computed, NOT chosen

The curve prices on virtual+real reserves; the pool is seeded with real reserves
only. They coincide at exactly one target, and away from it the token **gaps at
listing** — at one earlier configuration here, the pool opened at 14% of the curve's
final price. `initialize_global` now REJECTS anything more than ±5% off
(`GraduationPriceGap`), so a wrong value fails loudly rather than shipping.

A ±5% band on price is only ~±0.7% on the target, so compute it:

```python
# T = sqrt(Vs*(Vt+S)*(Vs+R)/Vt) - Vs - R      (all in base units)
from decimal import Decimal as D, getcontext; getcontext().prec=50
Vs, Vt, S, R = D(30_000_000_000), D('1.073e15'), D('1e15'), D(500_000_000)
print(int((Vs*(Vt+S)*(Vs+R)/Vt).sqrt() - Vs - R))   # -> 11544610844
```

`curve::continuity_target` is the same calculation on-chain. Any target you actually
want stays reachable — scale `initial_virtual_sol` with it (they are proportional),
and retune both together via `update_global`.

### ⚠️ Clients MUST set a compute limit — the default is not enough

`migrate_to_amm` consumes **~264,000 CU**; Solana's default is **200,000 per
instruction**. Every caller — frontend, keeper, bot, manual runbook step — must
prepend `ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })`. Omit it and
migration fails with `Program failed to complete`, which reads like a program bug
and has already cost one debugging cycle here.

3. If you passed zeros for `cp_swap_program` / `amm_config` at init (legitimate —
   the AmmConfig is step 5 and may not exist yet), set them afterwards with
   `update_global`. Migration refuses to run while either is zero. **There is no
   other way to set them**, and `global` is a singleton PDA, so this is not optional.
4. Sanity-check on devnet first: create a launch, buy it out, migrate, confirm LP
   supply is zero and the pool exists at `[b"launchpool", mint]` — **our** PDA, not
   cp-swap's canonical derivation, which anyone can occupy to brick a graduation.

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
