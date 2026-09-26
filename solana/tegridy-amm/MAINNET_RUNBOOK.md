# Tegridy CP-AMM — Mainnet Runbook

Step-by-step to take the audited fork live. **Do not start before the diff-audit is
complete** (`AUDIT_RFQ.md`). Every signing step is the operator's. Every authority that
must later sign goes to the Squads **vault PDA** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`,
never to the multisig account `EVGSnRZ…` (see "Which Squads address" in §0). Devnet dry-run
first (`deploy-devnet.sh`).

> **This runbook has been executed once, and the result was closed.** Both programs went
> to mainnet on 2026-08-08 ahead of the diff-audit this document opens by requiring, and
> both were closed on 2026-08-13 (`docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`). Their ids
> are spent; ~8.2M lamports are stranded in accounts nothing can sign for. Read the
> `admin::ID` post-mortem in §0 and the fail-closed warning in §2 before following any step
> below — several of them are the steps that produced that outcome, and they have been
> corrected in place rather than deleted, so the trap stays visible.

> ✅ **REBUILT (later on 2026-09-26): the platform reserve is now paid AT LAUNCH.**
> Owner decision, the same on every chain: `create_launch` pays the 3.69% platform reserve to
> the treasury's token account (the ATA of `global.fee_recipient`) in the same instruction,
> and `release_platform_reserve` no longer exists. That changed `tegridy-launch`'s bytes. The
> escrow build (`tegridy_launch.mainnet.so` sha256 `9b78be02…`, 483,288 B) is **superseded:
> never deploy it**. The replacement is sha256 `a3c41afa…` (470,728 B), built twice
> byte-identical with Agave 2.3.0 from tag `wip/solana-reserve-at-create`, and rehearsed on
> those exact bytes: locally 108 of 108 checks (Agave 2.3.0 and 3.1.11), and on devnet by
> upgrading `64WBTe…` to them. cp-swap is unchanged (`88b98aa9…`, rebuilt byte-identical).
> The go-live checklist carries the new hashes, sizes and steps.
>
> ⛔ **2026-09-26: for the restart, do NOT follow the steps below — follow the go-live
> checklist instead.** It lives with the release files, off-repo:
> `C:\Users\jimbo\solana-launch-release-2026-09-26\MAINNET_GO_LIVE.md`. The keys, the build
> and the rehearsal are already done, and several steps below would now undo them:
> - **Do not generate keys** (§3). The new ids are chosen and committed at `dd9e367d`: cp-swap
>   `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, tegridy-launch
>   `64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2`, deployer
>   `CqcVvaMvesrSKrUSbqBqr9mLjKLJuYqhaXg1gXpR41cg`, cp-swap admin = the vault `GRMtSx…`.
> - **Do not rebuild either program.** Deploy the rehearsed cp_swap.mainnet.so (sha256
>   `88b98aa9…`) and tegridy_launch.mainnet.so (sha256 `a3c41afa…`), both built with Agave
>   2.3.0. (The escrow build `9b78be02…` is superseded: see the banner above.) A
>   `solana-verify` build made now would produce different bytes that nobody rehearsed.
> - The deploy command below has no `--keypair` or `--upgrade-authority`, so the CLI's
>   default key would pay and become the upgrade authority. The checklist's command has both.
> - The vault needs **at least 4,572,000 lamports** before the two cp-swap admin steps, not
>   ~0.0019 SOL. Both steps are Squads proposals now, because `admin::ID` is the vault.
> - The whole flow passed on a local validator (the exact mainnet bytes, through a stand-in of
>   the real 2-of-2 multisig) and on devnet at the real program ids.

Legend: 🔑 = needs a key/signature · 💰 = costs SOL · 🌐 = external submission

---

## THE RESTART, IN ORDER (added 2026-08-22 — the zero-toll directive)

The owner's standing decision: relaunch on our own curve and keep **100% of the 1% trade
fee in-house** (split with the launch creator per §5b — settled 50/50), instead of
Meteora DBC's 20% carve. This is a RESTART, not a top-up: both prior program ids are spent
(§4/§5b banners), so everything program-shaped regenerates while the Squads-side
identities survive. The sequence, threading the sections below:

| step | what | where | survives / regenerates |
|---|---|---|---|
| R1 | Confirm float on hand: **~5.91 SOL deploy rent at today's rate (§0, re-quoted 2026-09-26: cp-swap ~3.51 SOL + tegridy-launch ~2.39 SOL + fees ~0.01, the measured mainnet builds) + pool seed + fee buffer**. Re-measure any rebuild before deploying. Rent is lamport-denominated — a SOL price move changes the dollar cost, never the SOL needed; the RATE can change, so re-read it on the day | §0 | — |
| R2 | 🔑 Generate **two fresh program keypairs** + the tegridy-launch deploy authority. Back all three up OFFLINE before the first build — the 08-01 identities were gitignored and UNBACKED-UP, which is one machine failure away from a re-restart | §1 | REGENERATES (old ids spent) |
| R3 | Re-derive (never trust the table) the Squads multisig / **vault PDA** / fee-receiver WSOL ATA. All three exist and survive the restart | §0 identities | SURVIVES |
| R4 | 🔑 Patch the 4 authority constants — cp-swap `admin::ID` = an address **proven to sign AND pay on mainnet first** (the §0 post-mortem; the multisig account address bricked the last deploy), fee receiver = the vault's WSOL **token account**, both `declare_id!`s, tegridy-launch `deployer::ID` (fail-closed sentinel otherwise) | §2, §5b step 1 | — |
| R5 | Build verifiably, **read the linker output**: an SBF stack-frame overflow is a linker WARNING that `cargo check` never surfaces — a warned build ships and then faults at runtime | §3 | — |
| R6 | 🔑💰 Deploy both programs; move upgrade authority to the **vault PDA** `GRMtSx…` (never the multisig account — it cannot sign, so the program would be frozen for good) | §4 | — |
| R7 | 🔑 `create_amm_config` (cp-swap) and `initialize_global` (tegridy-launch), then hand `GlobalConfig.authority` to the vault PDA with `update-global --new-authority GRMtSx…`. The four non-free parameters in §5b — creator share, platform reserve, migration reserve, **computed** graduation target — decide whether every launch lists at its curve price or gaps | §5, §5b | — |
| R7b | 🔑 `create-permission` (cp-swap admin): the `Permission` account for tegridy-launch's migration authority `["migauth"]`. **Without it every graduation fails `MigrationPermissionMissing` (6021)**, after the launch has already filled. Once per program, not per launch | §5c | — |
| R8 | 🔑💰 Seed the flagship pool; graduation flows land in **our** `[b"launchpool", mint]` PDA (the canonical-PDA squat is why graduation never targets the stock cp-swap pool address) | §6 | — |
| R9 | 🌐 Jupiter DEX-integration submission + frontend wiring (assistant task once addresses exist) | §8, §9 | — |
| R10 | Per funded launch: `migrate` (permissionless). The platform reserve needs no step: every `create_launch` already paid it to the treasury's token account, whether or not the launch ever graduates | §5c | — |

Two program-behavior notes an operator reading logs will want: creator fee legs FOLD into
the trade instead of crediting a drained wallet (crediting into the band between 1 lamport
and `minimum_balance(0)` — 650,240 lamports at today's rate — would revert the whole tx;
the fold is the fix, not a bug), and lamport
mutations reconcile per-CPI, so the first CPI in an instruction names every account it
will touch. Both are inside the audited program; neither needs operator action.

---

## 0. Prereqs

### DEPLOY FLOAT — **~5.91 SOL** at today's rent rate (re-quoted 2026-09-26)

Mainnet rent today is **(bytes + 128) × 5,080 lamports**. Read on 2026-09-25 from
`getMinimumBalanceForRentExemption`: 0 bytes → **650,240** (the old 890,880 figure is the
previous rate), 165 bytes (a token account) → 1,488,440. Every rent figure in this runbook
written before that date used the old rate of about 6,960 lamports per byte, so re-read
the rate on the day rather than trusting any number here:

Both program rows are **Agave 2.3.0** builds with default features: the `Anchor.toml` and
CI pin, which is what `anchor build` and the deploy artifact use. A newer toolchain builds a
different size (3.1.11 made tegridy_launch about 4.4 KB smaller), so measure with the pinned
one. Rent assumes an exact `--max-len` (ProgramData = binary + 45 B header).

| program | ProgramData account | rent at 5,080/byte |
|---|---|---|
| `raydium_cp_swap` | binary **691,640 B** → ProgramData **691,685 B**: `cp_swap.mainnet.so` sha256 `88b98aa9…`, the rehearsed mainnet build (the 2026-08-08 deploy put ~701,925 B on chain, but the restart deploys a fresh binary; not the 793,824 in `solana-ci.yml` either) | **~3.51 SOL** |
| `tegridy_launch` | binary **470,728 B** → ProgramData **470,773 B**: `tegridy_launch.mainnet.so` sha256 `a3c41afa…`, the reserve-paid-at-create mainnet build (tag `wip/solana-reserve-at-create`), built twice byte-identical. Mainnet quoted 2,392,177,080 lamports for it on 2026-09-26. (The escrow build it replaces was 483,288 B.) | **~2.39 SOL** |
| fee-receiver WSOL ATA | already exists (`2sa31zce…`) | 0 |
| tx fees | | ~0.01 SOL |
| | **TOTAL** | **~5.91 SOL** |

**One copy of the rent, not two.** The upgradeable loader's deploy drains the write
buffer's lamports back to the payer *before* it funds the ProgramData account, so the
payer never holds both at once: a deploy needs about one copy of the program's rent plus
fees. The comment in `.github/workflows/solana-ci.yml` ("peak = buffer + programdata",
and the "peak float" rows its deploy-cost step prints) is wrong for the same reason; it
overstates the float. That file is not edited here, so read its peak rows with this in
mind. What DOES double the cost is a ProgramData account sized larger than the program:
pass an explicit `--max-len` equal to the binary size, then check `solana program show`
before trusting any figure.

**Three wrong numbers preceded this one, all from reasoning instead of measuring:**

1. *"~5 SOL rent"* per program — a guess written before the binaries existed.
2. *"~17.3 SOL"* — I assumed `solana program deploy` reserves **2× the binary**, doubled
   the rent, and wrote it down. It does not. A real devnet deploy of the 514,320-byte
   binary produced `Data Length: 514320` and `Balance: 3.58087128 SOL` — **exact size**.
   The 2× reservation happens only when you pass `--max-len`.
3. *"~8.4 SOL, MEASURED"* — this table's 2026-08-08 form. It priced a 691,640-byte cp-swap
   at the old rent rate; what went on chain was ~701,925 bytes, and the rate has since
   fallen to 5,080 lamports per byte.

So: deploy with no headroom (an explicit `--max-len` equal to the binary size), and if a
later build is larger, grow the account with
`solana program extend <PROGRAM_ID> <additional_bytes>` rather than paying for
headroom up front.

Verify before spending, on the artifact you are actually deploying:

```bash
solana rent $(stat -c%s target/deploy/tegridy_launch.so) --url mainnet-beta
```

Rent is **recoverable** by closing the program — but NOT if §4's burn-the-upgrade-
authority option is taken, and closing SPENDS the program id forever (that is how both
2026-08 ids were lost). Decide knowing that.

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

> ### Which Squads address goes where
>
> Squads v4 signs every transaction it executes **as the vault PDA**
> (`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`, System-owned, 0 bytes). The multisig
> account `EVGSnRZ…` is a Squads-owned data account: nothing can ever sign as it. So every
> role that must later SIGN goes to the vault:
>
> - **both programs' upgrade authority** (§4) — the loader's upgrade needs the authority's
>   signature; set to the multisig account, the program can never be upgraded again, a burn
>   nobody chose;
> - **`GlobalConfig.authority`** (§5b) — `update_global` is `has_one = authority` with the
>   authority as a `Signer`; set to the multisig account, `global` is frozen for good: no
>   pause, no fee change, no AMM addresses. `update-global --new-authority` refuses a
>   program-owned address for this reason;
> - **`global.fee_recipient`** — the vault too; it receives trade fees, migration residuals
>   and every platform reserve (paid at launch), and only a signer can spend them. Its
>   token account for each launch's reserve is created with it as the owner, so a
>   program-owned address would strand every reserve paid to it. `init-global --fee-recipient` and
>   `update-global --fee-recipient` both refuse a program-owned address, like
>   `--new-authority`.
>
> The multisig account is the right address for exactly one thing: deriving the vault. It is
> also a **2-of-2** today (threshold 2, 2 members, time lock 0, read 2026-09-25), so moving
> anything the vault holds needs both keys; `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`
> records doubts about the second member's ability to sign. Confirm both can sign before the
> vault is made an authority of anything.

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
compiles fine and then makes **every `create_pool` fail**. The ATA `2sa31zce…` was created
on 2026-08-08 and still exists (read 2026-09-25: Tokenkeg-owned, 165 bytes), so this step
is only needed if the treasury changes.

```bash
spl-token create-account So11111111111111111111111111111111111111112   --owner GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd --url mainnet-beta
```
Costs ~0.0015 SOL of rent at today's rate (it cost 0.00204 at the 2026-08 rate) — this is
**not** part of the deploy float (see §0). Verify it
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
solana program deploy <artifact>.so --program-id keys/mainnet-program.json --max-len <binary bytes>   # see §0 for real rent
# Move upgrade authority to the Squads VAULT PDA — NOT the multisig account EVGSnRZ…,
# which can never sign an upgrade (§0 "Which Squads address"). The vault cannot sign
# this handover either, hence the skip flag. Or burn it if you want immutability.
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd \
  --skip-new-upgrade-authority-signer-check
solana program show <PROGRAM_ID>   # verify authority == GRMtSx… + last-deployed slot
```
> Optionally publish a verifiable build so explorers show source == bytecode.

## 5. 🔑 Create the AmmConfig (this is where Tegridy's fee is set)

> ⚠️ **`create_config` is signed by `admin::ID` and PAYS the AmmConfig rent from it.**
> Whoever you baked in at step 2 must therefore be a system-owned, funded account. If
> `admin::ID` is a Squads **vault**, this is a 2-of-N vault transaction and the vault needs
> ~0.0019 SOL (236 bytes at today's rate). If it is a plain wallet, it is an ordinary single-key transaction. If it is
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

`create_config` sets **`protocol_owner = fund_owner = the admin caller`** (the `admin::ID` key) —
there is no treasury parameter. To hand fee-collection authority to a *distinct* treasury, call
`update_config` (param 3 = new protocol owner, param 4 = new fund owner) after this. Fees land at
whatever token account you name at collection time regardless.

### ⚖️ OWNER DECISION — who holds `admin::ID`, knowing what it can do

`admin::ID` is baked into the binary, so choosing it is choosing, for the life of the
program, who holds these powers. They reach **graduated launches**, not just fee settings,
and burning the LP does not protect a pool from any of them:

- **Freeze any pool** — `update_pool_status` sets a pool's status bits (deposit, withdraw,
  swap) with no other check. That includes every graduated launch's pool, whose LP is burned:
  burned LP means nobody can pull the liquidity, not that nobody can stop the trading.
- **Close the migration permission** — `close_permission_pda` deletes the account from §5c.
  Every graduation then fails `MigrationPermissionMissing` (6021) until it is re-created.
- **Change `create_pool_fee`** — `update_config` param 5, with no bound. Migration pays that
  fee out of each curve's migration reserve, which was snapshotted at creation, so a fee above
  `migration_reserve − 42,156,720` bricks the graduation of **every pending curve** at once.
  (`create-amm-config` checks this ceiling at creation; nothing checks it on a later update.)
- **Disable pool creation** — `update_config` param 6 sets `disable_create_pool`, and
  `initialize_with_permission` then refuses every pool, so every graduation fails until it is
  set back. Same effect as closing the permission.
- **Reprice every pool on the config** — `update_config` params 0 and 7 change the trade fee
  and the creator fee, and swaps read both live. The only bound is trade + creator < 100%. This
  reaches graduated burned-LP pools too.
- **Sweep accrued protocol and fund fees** to any recipient (the fallback collector).

Today the source bakes a single operator-held key (the comment on `admin::ID` in
`programs/cp-swap/src/lib.rs` says why: to prove graduation before a 2-of-N ceremony). A
single key holding the powers above is a decision the owner makes explicitly, with a
date to move it — not a default the build inherits. Moving it later is a program upgrade.

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
   until you set a real key). Build, deploy, move upgrade authority to the Squads
   **vault PDA** `GRMtSx…` (§4 — never the multisig account).
2. Call `initialize_global` (`init-global` on the operator harness). **Four parameters
   are not free choices — get them wrong and the launcher misbehaves in ways nothing
   will warn you about later.** Then hand `GlobalConfig.authority` to the vault PDA:
   `update-global --new-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. The
   deployer key signs `initialize_global`, so until this handover a single key holds
   the protocol.
3. ~~Publish the segmented curve with `set-curve-segments`.~~ **REMOVED 2026-08-23.**
   Segmented (Meteora-shaped) mode is gone from the program — `segmented.rs` and the
   vendored Raydium CLMM math were deleted before the redeploy. The command, the mode
   flag and the `curve.json` schema no longer exist, and `global` has no `segment_count`
   field to set. Two HIGH findings lived entirely in that mode and are retired with it.
   Every launch is ConstantProduct. **Renumber nothing below — the step count changed,
   the order did not.**

### `creator_fee_share_bps` — the volume magnet; settled at **5_000** (50% of the fee)

> **Settled 2026-08-23: `creator_fee_share_bps = 5000`** with `trade_fee_bps = 100` —
> creator nets 50 bps, protocol nets 50 bps (`docs/TODO_OPERATOR.md`, "The curve numbers
> are settled — a flat 100 bps, 50/50 split"). This section used to recommend 4,800. Its
> whole argument was parity with the Meteora partner rail, and the same day the owner
> retired every Meteora rail ("0 Meteora"), so there is nothing left to be at parity with.
> The 4,800 reasoning below is kept as the record of why it was once recommended; do not
> pass 4800.

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
> at 50/50 on purpose (the settled value above): the Rust program has one house
> bucket (a Rust treasury bucket is a program change + re-audit, out of scope for
> the restart). On Solana the treasury funding therefore comes OUT OF the 50%
> protocol share off-chain — same three stakeholders funded, one fewer on-chain
> bucket. If you later add a Solana treasury bucket, align it to the EVM 40/25/35.

Snapshotted per launch like the fee itself; `update_global` moves future launches
only. Bounded at 10_000 (100% of the fee).

⚠️ **Divergence from the spec, deliberate and reconciled 2026-08-04.**
`CREATOR_FEE_SPEC.md` §1 prescribed a *compile-time constant*; the implementation
uses a governable `GlobalConfig` field. The field is kept because the per-curve
snapshot already delivers the spec's actual goal — no signature can reprice a
launch people have bought into — while leaving the ratio tunable for FUTURE
launches without a program upgrade. The spec's value (4,800) was adopted verbatim, and
superseded by the settled 5,000 above.

### ⚠️ `platform_reserve_bps` — **369** (3.69% of each launch's supply), and it must be disclosed

The owner's intent: the platform receives 3.69% of every token's supply **when the token
is created**, on every chain (owner decision 2026-09-26). How the program does it:

- **Carved AND paid at `create_launch`.** `floor(supply × bps / 10,000)` tokens are left out
  of `real_token_reserves` and, in the same instruction, sent to `global.fee_recipient`'s
  associated token account (classic SPL Token). The curve can never sell them, and migration
  never puts them in the pool. At 369 bps on a 1e15 supply that is 36,900,000,000,000 base
  units. A launch that never graduates has still paid it. Same 10% cap
  (`MAX_PLATFORM_RESERVE_BPS = 1000`) as the EVM launcher.
- **The creator pays the treasury ATA's rent** (1,488,440 lamports at mainnet rent) when the
  account does not exist yet, on top of the curve and vault rent: about 5,613,240 lamports per
  launch including fees, up from 4,124,800. A stranger pre-creating that ATA cannot block a
  launch; a wrong recipient fails `Unauthorized` (6008).
- **Snapshotted per launch as an amount**, like the fee; `update_global` moves new launches
  only. The **recipient is read at create time**: rotating `fee_recipient` changes where
  future launches pay; nothing already paid moves.
- **Required, no default** on `init-global`, for the same reason as the creator share.
- Errors 6022 and 6023 (`PlatformReserveLocked`, `PlatformReserveAlreadyReleased`) are
  retired: nothing returns them, and they keep their slots so 6024 keeps its number.

**Scale `initial_virtual_token` with it, at `initialize_global`.** The program runs every
config check against the curve supply (supply minus the reserve). Pass
`initial_virtual_token × (1 − b)`: for the operator example, 1,073,000,000,000,000 becomes
**1,033,406,300,000,000**, and the graduation target (and the SOL raise) stays the same to the
lamport. Leave it unscaled and the pool lists at **10,488 bps** of the final curve price —
inside the ±5% band, so `initialize_global` does NOT reject it, and every pool opens ~4.9%
above the curve. `check-config` prints the recipe and warns when the target is the no-reserve
book's. `update_global` has no argument for `initial_virtual_token`, so this works on day one
only; a later reserve change must be absorbed by virtual SOL, the target or the migration
reserve (and `update_global` re-runs the economics check even for a reserve-only change).

With the scaled book, a graduating launch splits **sold 56.11% / pool 40.20% / reserve
3.69%** of supply. The reserve is about **9.2% of the pool's token side**: selling all of it
into the pool at a ~75 SOL target returns ~6.3 SOL and leaves the price at ~84% of listing.

**Disclosure — do not launch without it.** The launch page's terms must say it in plain
words: *"Platform reserve: the platform receives 3.69% of supply when the token is created.
It goes to the platform treasury, which is a multisig."* A holder scanner will show the
treasury holding 3.69% of **every** launched token from its first block, graduated or not.

⚖️ **Treasury policy — the program no longer enforces this.** The escrow design guaranteed
the treasury could never sell into a live curve against its own buyers. Paid at launch, the
treasury holds 3.69% before anyone has bought, and a sell into the curve would take SOL that
buyers put in (at the planned 25 SOL book, roughly 2.2 SOL at the opening price — an
estimate). Only policy stops that now: publish the rule (the EVM intent is LP incentives,
bounties and bribes), or lock the reserves. The recipient is the Squads vault, a 2-of-2
today (§0), so both keys are needed to move any of it.

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

`S` there is the **curve** supply — the whole supply minus the platform reserve — because
that is what the program checks against. With a reserve, either scale `Vt` as in the
platform-reserve section above or recompute `T` on the curve supply; `check-config` does
both sums.

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
   Also confirm, right after `create_launch`, that the treasury's token account holds
   exactly `platform_reserve_tokens` and the curve vault holds exactly
   `real_token_reserves`.

## 5c. 🔑 The migration permission, then per-launch graduation

**Before any launch can graduate: cp-swap's `Permission` account for our migration
authority.** Graduation calls cp-swap's `initialize_with_permission`, which requires an
existing `Permission` account at `["permission", payer]` — and the payer there is
tegridy-launch's migration authority, the PDA `["migauth"]` (ONE per program, no mint).
Only cp-swap's `admin::ID` can create it, and it pays the rent (~0.0021 SOL at today's
rate). Without it **every `migrate_to_amm` fails `MigrationPermissionMissing` (6021)** —
discovered when the first launch fills, not before. The 2026-08-08 sequence had no such
step. (Until 2026-09-25 the frontend also derived the authority as `["migauth", mint]`,
which is not the address the program checks; the harness now refuses to build against a
derivation that disagrees with the program's.)

```bash
SOLANA_RPC_URL=… OPERATOR_KEYPAIR=/abs/path/admin.json \
node scripts/tegridy-launch-operator.mjs create-permission \
  --cp-swap-program <cp-swap id> --program-id <tegridy-launch id>
```

It simulates, then prints a partial-signed transaction; `--send` broadcasts. It refuses on
the same signer checks as `create-amm-config` (`admin::ID` in the deployed bytecode,
System-owned, funded), and does nothing if the account already exists. `status` reads the
account and names it as the next step while it is missing.

**Per launch, once it is funded: `migrate`.** Permissionless. The harness sets the
400,000 compute-unit limit, reads every precondition first (not paused, AMM set, funded to
`target + reserve`, the permission account, a WSOL `--create-pool-fee-account`), and
simulates unless `--send`. The payer fronts two token-account rents plus the migration
authority's **seed top-up** to `minimum_balance(0)` (650,240 lamports today) and gets it
back at the end; the unspent migration reserve goes to `fee_recipient`, never the caller.

**No release step.** The platform reserve left the curve vault at `create_launch`, paid to
`global.fee_recipient`'s token account (the creator covered its ~0.0015 SOL rent). After
migration the vault holds only any dust a stranger donated to the migration authority.

## 6. 🔑💰 Create + seed a pool
Via `client/` (`initialize` / `initialize_customizable`): pick the Solana-native pair, seed
with treasury capital. Withdrawable — you keep the LP position (no permanent lock). Keep it
deep enough to stay above Jupiter's routing threshold (§8).

## 7. 🔑 Collect fees (recurring)
`collect_protocol_fee` → treasury (the fee owner signs — through the vault if it is the vault). Protocol fee accrues on every swap.

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
- Program upgrade authority at the Squads vault PDA can patch a bug (or was burned for immutability).
- Positions are **withdrawable** — treasury can pull capital from any pool at any time.
- If a pool underperforms, withdraw + redeploy capital elsewhere; the program keeps running.
