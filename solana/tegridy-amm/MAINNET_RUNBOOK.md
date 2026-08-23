# Tegridy CP-AMM — Mainnet Runbook

Step-by-step to take the audited fork live. **Do not start before the diff-audit is
complete** (`AUDIT_RFQ.md`). Every signing step is the operator's; a Squads multisig
should hold all authorities. Devnet dry-run first (`deploy-devnet.sh`).

> **This runbook has been executed once, and the result was closed.** Both programs went
> to mainnet on 2026-08-08 ahead of the diff-audit this document opens by requiring, and
> both were closed on 2026-08-13 (`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`). Their ids
> are spent; ~8.2M lamports are stranded in accounts nothing can sign for. Read the
> `admin::ID` post-mortem in §0 and the fail-closed warning in §2 before following any step
> below — several of them are the steps that produced that outcome, and they have been
> corrected in place rather than deleted, so the trap stays visible.

Legend: 🔑 = needs a key/signature · 💰 = costs SOL · 🌐 = external submission

---

## THE RESTART, IN ORDER (added 2026-08-22 — the zero-toll directive)

The owner's standing decision: relaunch on our own curve and keep **100% of the 1% trade
fee in-house** (split with the launch creator per §5b — recommended 48/52), instead of
Meteora DBC's 20% carve. This is a RESTART, not a top-up: both prior program ids are spent
(§4/§5b banners), so everything program-shaped regenerates while the Squads-side
identities survive. The sequence, threading the sections below:

| step | what | where | survives / regenerates |
|---|---|---|---|
| R1 | Confirm float on hand: **~8.4 SOL deploy rent (MEASURED, §0) + pool seed + fee buffer ≈ 13.4 SOL total**. Rent is lamport-denominated — a SOL price move changes the dollar cost, never the SOL needed | §0 | — |
| R2 | 🔑 Generate **two fresh program keypairs** + the tegridy-launch deploy authority. Back all three up OFFLINE before the first build — the 08-01 identities were gitignored and UNBACKED-UP, which is one machine failure away from a re-restart | §1 | REGENERATES (old ids spent) |
| R3 | Re-derive (never trust the table) the Squads multisig / **vault PDA** / fee-receiver WSOL ATA. All three exist and survive the restart | §0 identities | SURVIVES |
| R4 | 🔑 Patch the 4 authority constants — cp-swap `admin::ID` = an address **proven to sign AND pay on mainnet first** (the §0 post-mortem; the multisig account address bricked the last deploy), fee receiver = the vault's WSOL **token account**, both `declare_id!`s, tegridy-launch `deployer::ID` (fail-closed sentinel otherwise) | §2, §5b step 1 | — |
| R5 | Build verifiably, **read the linker output**: an SBF stack-frame overflow is a linker WARNING that `cargo check` never surfaces — a warned build ships and then faults at runtime | §3 | — |
| R6 | 🔑💰 Deploy both programs; move upgrade authority to the vault PDA | §4 | — |
| R7 | 🔑 `create_amm_config` (cp-swap) and `initialize_global` (tegridy-launch). The three non-free parameters in §5b — creator share, migration reserve, **computed** graduation target — decide whether every launch lists at its curve price or gaps | §5, §5b | — |
| R8 | 🔑💰 Seed the flagship pool; graduation flows land in **our** `[b"launchpool", mint]` PDA (the canonical-PDA squat is why graduation never targets the stock cp-swap pool address) | §6 | — |
| R9 | 🌐 Jupiter DEX-integration submission + frontend wiring (assistant task once addresses exist) | §8, §9 | — |

Two program-behavior notes an operator reading logs will want: creator fee legs FOLD into
the trade instead of crediting a drained wallet (crediting into the 1..890,879-lamport
rent band would revert the whole tx — the fold is the fix, not a bug), and lamport
mutations reconcile per-CPI, so the first CPI in an instruction names every account it
will touch. Both are inside the audited program; neither needs operator action.

---

## 0. Prereqs

### DEPLOY FLOAT — **~8.4 SOL**, MEASURED

Corrected twice on 2026-08-08. Get this from a measurement, not from arithmetic:

| program | binary | on-chain account | rent |
|---|---|---|---|
| `tegridy_launch` | 514,320 B | 514,320 B | **3.5809 SOL** ← measured on devnet |
| `raydium_cp_swap` | 691,640 B | 691,640 B | **4.8154 SOL** (same rate) |
| fee-receiver WSOL ATA | | | 0.0020 SOL |
| tx fees | | | ~0.0100 SOL |
| | | **TOTAL** | **~8.4 SOL** |

**Two wrong numbers preceded this one, both from reasoning instead of measuring:**

1. *"~5 SOL rent"* per program — a guess written before the binaries existed.
2. *"~17.3 SOL"* — I assumed `solana program deploy` reserves **2× the binary**, doubled
   the rent, and wrote it down. It does not. A real devnet deploy of the 514,320-byte
   binary produced `Data Length: 514320` and `Balance: 3.58087128 SOL` — **exact size**.
   The 2× reservation happens only when you pass `--max-len`.

So: deploy at the default, and if a later build is larger, grow the account with
`solana program extend <PROGRAM_ID> <additional_bytes>` rather than paying for
headroom up front.

Verify before spending, on the artifact you are actually deploying:

```bash
solana rent $(stat -c%s target/deploy/tegridy_launch.so) --url mainnet-beta
```

Rent is **recoverable** by closing the program — but NOT if §4's burn-the-upgrade-
authority option is taken. Decide knowing that.

- Diff-audit passed; findings (if any) fixed and re-diffed (CI `diff-guard` still green).
- `solana` CLI installed; `solana config set --url mainnet-beta`.

### The identities, and which already exist

Verified on mainnet 2026-08-01. The first two exist **now**; do not regenerate them.

| # | Identity | Value | State |
|---|---|---|---|
| 1 | Squads multisig | `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` | **Exists.** Owner `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, **threshold = 2** (u16 at data offset 72) |
| 2 | ⚠️ **Admin — re-decide this before the build** | see the note below | This row named the Squads **vault PDA** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. It exists, but `admin::ID` is a **payer** (`CreateAmmConfig` has `payer = owner`) as well as a signer, and the 2026-08 deploy proved that getting this wrong is unrecoverable |
| 3 | Fee receiver = vault's **WSOL ATA** | `2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa` | **Exists** — created on-chain 2026-08-08 (0.00204 SOL). This row read "DOES NOT EXIST YET" for eleven days after it did |
| 4 | cp-swap program keypair | — | Must be generated (§1) |
| 5 | `tegridy-launch` program keypair | — | Must be generated (§1) |
| 6 | `tegridy-launch` deploy authority | — | Must be generated (§1). A plain wallet: it is `Signer` **and** `payer` for `initialize_global`, so it must hold SOL |

Re-derive any vault address rather than trusting this table — the derivation is what binds
it to the multisig. Checking "owner == System Program" is **not** sufficient; every
ordinary wallet is System-owned too.

> ### The `admin::ID` post-mortem — read before filling row 2
>
> On the 2026-08-08 deploy, `admin::ID` was baked as the Squads **multisig account**
> `EVGSnRZ…`. That account is owned by the Squads program: the System Program cannot debit
> it, and a Squads v4 transaction signs as its **vault PDA**, a different address again.
> `create_amm_config` therefore could not be called by anyone, `migrate_to_amm` sat on
> `AmmNotConfigured` (6015), and because the constant is baked into the binary the only
> fixes were an upgrade or a redeploy. The program was closed instead, which spent the id
> permanently. Three distinct addresses were being treated as one, and the registry entry
> for the vault (`frontend/scripts/addresses.json`, `squads-vault`) carries the full
> correction.
>
> Whatever goes in row 2 must be **proved, before the build, to (a) produce a real
> signature on mainnet and (b) hold SOL**. "It is System-owned" and "it belongs to the
> multisig" are both insufficient. Prove it by having the candidate sign and pay something
> trivial on mainnet first — a nonce ≥ 1 — exactly as `docs/SAFE_REHOME_RUNBOOK.md`
> requires of an EVM Safe before anything relies on it.

```bash
SQUADS_MULTISIG=EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK SQUADS_VAULT_INDEX=0   node frontend/scripts/solana-dbc-operator.mjs derive-vault
```

## 1. 🔑 Generate the mainnet program keypair
```bash
solana-keygen new -o keys/mainnet-program.json     # keep OFFLINE / in the vault; this IS the program address
solana-keygen pubkey keys/mainnet-program.json
```

## 2. 🔑 Set the mainnet authority constants (the 4-constant diff, mainnet side)

⚠️ **NOTHING IN THIS TREE IS FAIL-CLOSED ANY MORE. Do not skim this step.** This preamble
used to say the three authority constants ship as System-Program sentinels (`1111…1111`)
on the `#[cfg(not(feature = "devnet"))]` arm, so that a mainnet build could not function
until you replaced them. **That is no longer true of any of them:** the non-devnet arms
now carry the committed live values from the 2026-08-08 deploy — `declare_id!` holds
`3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y` (a **closed, permanently unusable** program
id, so a default build today produces a binary that cannot be deployed at all) and
`admin::ID` holds the deploy authority. A build that silently inherits either of these is
a build nobody reviewed. Replace all four explicitly, every time, and re-read the
constants out of the source rather than out of this list.
- `programs/cp-swap/src/lib.rs`
  - `declare_id!(…)` → the pubkey from step 1. Mandatory, not optional: the committed
    non-devnet value is a spent id, and Solana rejects a redeploy at a closed program id.
  - `admin::ID` → **a plain, system-owned wallet you have proved can sign and can hold
    SOL.** ⚠️ **NOT the multisig account.** That line once said "Squads multisig", it was
    followed literally, and the result shipped to mainnet on 2026-08-08 and **bricked
    graduation**: `create_amm_config` takes this address as `Signer` *and* `payer`, and the
    multisig account is a Squads-owned data account that can do neither (Squads v4 signs
    CPIs as the **vault**; the System Program can only debit a data-less account it owns).
    There was no cheap fix — the constant is resolved at compile time, so correcting it
    needed an upgrade or a redeploy, and the program was **closed** on 2026-08-13 instead,
    spending the id forever. Sanity-check before building — the vault reads
    `owner: 11111111111111111111111111111111`, `space: 0`; the multisig reads
    `owner: SQDS4ep65T…` with a few hundred bytes:
    ```
    solana account <the-address-you-are-about-to-bake-in> -u m
    ```
  - `create_pool_fee_reveiver::ID` → the treasury's **WSOL associated-token-account** (a
    native-SOL *token account*, NOT the treasury wallet — the create path consumes it as a
    `TokenAccount`; derive it with `spl-token address --token So111…112 --owner <treasury>`)
- `programs/cp-swap/src/instructions/admin/create_support_mint_associated.rs`
  - `create_support_mint_associated_owner::ID` → a **system-owned** account (vault PDA or
    wallet), same rule as `admin::ID`. It is an OR-fallback alongside `admin::ID`, so it may
    be left at its current unsignable value without blocking anything.

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
Costs ~0.00204 SOL of rent — this is **not** part of the deploy float (see §0). Verify it
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
solana program deploy <artifact>.so --program-id keys/mainnet-program.json   # see §0 for real rent
# Move upgrade authority to the multisig (or burn it if you want immutability):
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG>
solana program show <PROGRAM_ID>   # verify authority + last-deployed slot
```
> Optionally publish a verifiable build so explorers show source == bytecode.

## 5. 🔑 Create the AmmConfig (this is where Tegridy's fee is set)

> ⚠️ **`create_config` is signed by `admin::ID` and PAYS the AmmConfig rent from it.**
> Whoever you baked in at step 2 must therefore be a system-owned, funded account. If
> `admin::ID` is a Squads **vault**, this is a 2-of-N vault transaction and the vault needs
> ~0.0026 SOL. If it is a plain wallet, it is an ordinary single-key transaction. If it is
> the multisig **account**, this step is impossible and the only fix is a program upgrade —
> which is exactly what happened here on 2026-08-08.

### The tooling — it exists now

`create-amm-config` on the operator harness builds and (optionally) sends this instruction.
Run it from `frontend/`:

```bash
SOLANA_RPC_URL=https://your-keyed-rpc \
OPERATOR_KEYPAIR=/abs/path/admin.json \
node scripts/tegridy-launch-operator.mjs create-amm-config \
  --index 0 --trade-fee-rate 2500 --protocol-fee-rate 120000 \
  --fund-fee-rate 0 --create-pool-fee 150000000 --creator-fee-rate 0
```

Default is **print** — a partial-signed base64 transaction for out-of-band co-signing. Add
`--send` to broadcast. It refuses, before touching a key, on:

- **cp-swap not deployed / unreadable** at the target id. An unreadable RPC is reported as
  unreadable, never as "not deployed".
- **the signer is not `admin::ID`.** `admin::ID` is a compile-time constant — no account holds
  it, no explorer shows it — so the check searches the DEPLOYED bytecode for the key's raw 32
  bytes. An absent key is conclusive: it cannot be what the gate compares against. This is the
  gate the 2026-08-08 attempt failed *after* a Squads ceremony.
- **the signer cannot be debited.** `payer = owner`, and the System Program can only debit an
  account it owns with no data. The multisig account fails on both counts.
- **the AmmConfig for that index already exists.** `init`, so once per index, forever.
- **rates outside the bounds `update_config` will later enforce.** `create_amm_config` itself
  validates *nothing* (`create_config.rs:32-53` assigns all six numbers straight onto the
  account), but `update_config` asserts each new value against the STORED counterpart, and
  `assert!` panics rather than erroring. A config created out of bounds can be unfixable, and
  the index is burned.
- **`create_pool_fee` above `migration_reserve - MIN_MIGRATION_RESERVE_LAMPORTS`**, read from
  the LIVE `global` rather than from this document. See the ceiling note below.

To see which keys the live binary actually carries — the only check that survives a rebuild,
because a reproducible build of a *wrong* constant still reproduces and still hashes correctly:

```bash
SOLANA_RPC_URL=… node scripts/verify-program-constants.mjs --deployed <cp-swap program id>
# or, BEFORE spending rent:
node scripts/verify-program-constants.mjs --so target/deploy/raydium_cp_swap.so
```

As of 2026-08-12 that reports `admin::ID` **ABSENT** from the live cp-swap binary: the #281
source fix is not in the deployed bytecode, so this step remains blocked on a program upgrade.

> The repo's Rust `client/` crate still only *decodes* `CreateAmmConfig`
> (`client/src/instructions/events_instructions_parse.rs`) and has no builder. The encoder used
> above lives in `frontend/src/lib/launcher/solana/curve/ix.ts`, where it is unit-tested byte by
> byte — Borsh with no IDL fails silently, and the failure is not an error, it is the program
> applying your value to a different field.

`create_config` is **admin-only**. All fee rates use denominator **1_000_000** (`curve/fees.rs`):
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

> ⛔ **DONE 2026-08-08, AND CLOSED 2026-08-13.** It ran at
> `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED` (slot 438,055,726) with
> `initialize_global` complete and upgrade authority at the Squads vault, and its
> ProgramData account `6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS` was then deleted.
> **That id is spent and cannot be redeployed**; the `global` PDA it owns is stranded with
> its rent. Verified on two RPCs — `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`, and the
> registry carries the ProgramData address as an `expect: absent` entry so CI re-checks it.
>
> This line read "Live at …" for six days after the close, which is the failure mode the
> whole runbook is written against: a note recording what someone did is not a read of what
> is there. `verify-program-constants --deployed` cannot help here either — it byte-searches
> a binary, and there is no longer a binary to search.
>
> Steps 1-2 below are kept as the record of what was done and what a re-deploy would have to
> repeat, starting from a **new keypair**. **Note that trunk's source still carries the
> placeholder id and the sentinel** — those patches are made at build time and never
> committed, which is exactly why reading lib.rs tells you nothing about what is live.

A **separate program** from cp-swap, deliberately — folding it in would break
`diff-guard` and turn a cheap four-constant diff-audit into a full AMM audit.

1. Generate its own mainnet keypair, then patch **both** `declare_id!(...)` and
   `deployer::ID` (the `#[cfg(not(feature = "devnet"))]` arm, which ships a
   fail-closed System-Program sentinel so a mainnet binary refuses to initialize
   until you set a real key). Build, deploy, move upgrade authority to the multisig.
2. Call `initialize_global`. **Three parameters are not free choices — get them
   wrong and the launcher misbehaves in ways nothing will warn you about later.**
3. *(Only if you intend to offer the Meteora-shaped mode)* publish the segmented curve with
   `set-curve-segments`. Launches created in the default ConstantProduct mode do not need it,
   and `global.segment_count` is 0 until it runs.

   ```bash
   SOLANA_RPC_URL=… OPERATOR_KEYPAIR=/abs/path/authority.json \
   node scripts/tegridy-launch-operator.mjs set-curve-segments --segments-file curve.json
   ```

   `curve.json` is `{ "sqrtPriceStartX64": "…", "segments": [{ "sqrtPriceUpperX64": "…",
   "liquidity": "…" }, …] }`, up to 16 segments, **all values as decimal strings** — a JSON
   number above 2^53 loses precision silently, and a wrong Q64.64 sqrt price is not a smaller
   price, it is a different curve. Re-runnable: the program validates the whole table before
   writing, so a rejected table cannot leave a half-updated config behind. Read it back with
   `status` afterwards; a successful send is not evidence the table decoded the way you meant.

### `creator_fee_share_bps` — the volume magnet; recommended **4_800** (48% of the fee)

The creator's share OF THE TRADE FEE, paid instantly and non-custodially to the
launch creator on every buy and sell (2026-08-02 economics synthesis). Every
surviving launchpad pays creators a streaming cut — pump.fun 0.30%/vol on-curve,
the Meteora-partner rail 0.48%/vol — and a curve that pays zero loses its
launches to the rails that pay.

**Why 4,800 and not a round 5,000** (`CREATOR_FEE_SPEC.md` §1): at
`trade_fee_bps = 100` it is **exact parity with the live Meteora partner config's
48 bps**, so the creator-facing claim is checkable against something public rather
than taken on trust. The protocol nets **52 bps** here versus **32 bps** on the DBC
rail — because there is no Meteora leg to pay — so moving a creator from our DBC
rail to our own curve is **+62.5% revenue per trade at zero cost to the creator**.
That argument only exists while the share is held AT parity rather than bid above
it; raising it to 5,000 buys 2 bps of creator goodwill and forfeits the
like-for-like comparison.

> **Deliberate divergence from the EVM curve (2026-08-23, `docs/CURVE_ECONOMICS.md`).**
> The EVM `TegridyCurveLauncher` runs a THREE-way split — 40% creator / 25% Jungle
> Bay treasury / 35% protocol — because the owner wanted an explicit on-chain
> treasury stream and the EVM contract has the surface for it. Solana STAYS 2-way
> at 48/52 on purpose: the Rust program has one house bucket, and 48% is held at
> Meteora parity for the checkable claim above (a Rust treasury bucket is a
> program change + re-audit, out of scope for the restart). On Solana the treasury
> funding therefore comes OUT OF the 52% protocol share off-chain — same three
> stakeholders funded, one fewer on-chain bucket. If you later add a Solana
> treasury bucket, align it to the EVM 40/25/35 and drop the parity claim.

Snapshotted per launch like the fee itself; `update_global` moves future launches
only. Bounded at 10_000 (100% of the fee).

⚠️ **Divergence from the spec, deliberate and reconciled 2026-08-04.**
`CREATOR_FEE_SPEC.md` §1 prescribed a *compile-time constant*; the implementation
uses a governable `GlobalConfig` field. The field is kept because the per-curve
snapshot already delivers the spec's actual goal — no signature can reprice a
launch people have bought into — while leaving the ratio tunable for FUTURE
launches without a program upgrade. The spec's value (4,800) is adopted verbatim.

### ⚠️ `migration_reserve_lamports` — minimum **192,156,720** (~0.1922 SOL)

Raised from traders on top of the target, and it pays cp-swap's costs at migration:
0.15 SOL `create_pool_fee` plus 42,156,720 lamports of rent for the five accounts
cp-swap creates (`observation_state` alone is 29.25M — 70% of the rent). Derived
from cp-swap's own `LEN` constants, not estimated. **Recommended: 0.25 SOL** for
headroom.

> ⚠️ **Corrected 2026-08-08 — the previous advice made a real leak bigger.**
> This used to read *"the surplus is swept back to whoever calls migration, so
> over-provisioning costs nothing but a slightly larger raise."* Wrong twice over.
> Migration is **permissionless**, so "whoever calls migration" meant any bot, not
> the operator; and the surplus is **traders' money**, because the reserve is raised
> on top of the graduation target. Over-provisioning did not cost nothing — it sized
> a standing MEV bounty paid out of buyers' funds at every graduation.
>
> The residual now goes to `global.fee_recipient` (lib.rs, the sweep at the end of
> `migrate_to_amm`), so over-provisioning is no longer exploitable. It is still
> charged to buyers and banked by the protocol rather than returned to them, so
> **size this to the real cost plus a modest margin, not generously.**

Too small and migration fails *after* the pool exists — the worst possible moment.

### ⚠️ `graduation_target_lamports` — computed, NOT chosen

**Recommended raise ≈ 75 SOL** (`docs/CURVE_ECONOMICS.md`, 2026-08-23 research). pump.fun
graduates at ~85 SOL (~$12–15k) and under 2% of tokens ever graduate; sitting slightly
BELOW that lifts the graduation rate — more up-and-coming projects actually reach a real
pool — while ~75 SOL still clears Jupiter's routing-liquidity threshold. This is the raise
target the price-continuity math below is solved AROUND; it is not a free knob (see the gap
warning). Scale `initial_virtual_sol` with it. The EVM curve's chain-tuned equivalents are
mainnet 4 ETH / Base 2 ETH / Robinhood 1.5 ETH.

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
