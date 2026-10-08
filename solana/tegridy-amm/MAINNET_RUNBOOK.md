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
2. Read the printed delta and satisfy yourself it is still only identity constants, the
   program's own name and contact text (the `security_txt!` macro and one `Cargo.toml`
   line), and the one added instruction, `create_lp_metadata` (in the delta since
   2026-10-06).
3. Update `EXPECTED_DELTA_SHA256` to the printed `actual` value **in the same PR**.

The delta is about 260 lines over **three** files: `lib.rs`,
`instructions/admin/create_support_mint_associated.rs`, and `Cargo.toml`. It was 94 lines
until 2026-10-06, when `create_lp_metadata` was added to `lib.rs`: the instruction that
gives a pool's lp token a name record (see `TEGRIDY_FORK.md`). The same day four values of
the on-chain security text changed in `lib.rs`, which left the count at 261. The binary
deployed on 2026-09-29 was built before both and has neither.

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

## 4b. The `create_lp_metadata` upgrade: the gates, the order, and what ships with it

Added 2026-10-06. Brought in line with three rehearsals on 2026-10-08. This would be cp-swap's
FIRST upgrade on mainnet, of a program that holds funded pools. Nothing has been sent. Read on
2026-10-08 (07:42 UTC): mainnet runs the old binary `88b98aa9…`, nobody has enlarged the
program account, and neither flagship share mint has a name record. The source of the new
build is on `mvp-launch` (pull request #758, merged that day at 07:40 UTC).

**One upgrade carries two changes** (decided 2026-10-06, gate A4): the instruction
`create_lp_metadata`, and the program's on-chain security text, which moves to an email and
links on `memetics.finance`.

What the instruction is, and why the vaults are out of its reach: `TEGRIDY_FORK.md`, "The one
added instruction". What the security text says and why: the same file, "The on-chain
security text".

**It has been rehearsed, on a local validator.** On 2026-10-08 the enlarge, and then the
upgrade to the larger file, were run from start to finish three times. The chain was a
`solana-test-validator` 3.1.11 started from a copy of mainnet's state: the real program, both
real pools and the real multisig account. Two things were altered so that it could run: each
program's "last deployed" slot was set to 0, and the multisig's two member keys were swapped
for throwaway keys. (Stage 1 also gave the BAYLA and USDC mints a test mint authority, so
that its proof script could fund a trader.) The vault's address comes from the multisig's
ADDRESS, so the stand-in members signed as the real vault
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. The tools were the owner's own: `solana.exe`
4.1.1 for the enlarge, the upload and the hand-over, and the local proposer page for the
proposals (its code in stage 1, its buttons in stage 2 and in the cold run).

| run | what it was | result |
|---|---|---|
| Stage 1 | The sequence, with the upgrade proposal built by the page's own code and signed from key files. Then the existing proof, every instruction that needs the vault, the rename, a roll-back and forward again, and every case that must fail. | Every phase ended as expected: 34 checks on the sequence, 130 on the proof, 48 on the vault's instructions, 24 on the rename, 33 on the roll-back, 56 on what must fail. |
| Stage 2 | The owner's pack, built, and its whole flow run in its own order. The page was driven through its buttons in a headless browser, with a test wallet standing in for each member. | 71 checks on the flow, 89 on what must be refused and on the two "only if" paths, 20 on the page reading mainnet. |
| Cold run | An operator who did not build the pack followed its paper line by line, tried 24 ways to break it, and decoded the stored proposals with separate code. | Every "you should see" line matched and no gate let a wrong build through. Verdict: ready after named fixes, not as it stood. |

**What that does not prove.**

- **Mainnet runs 4.3.0.** The local validator is 3.1.11 and does not know 28 features that
  are active on mainnet. Two of them change what was measured, the rent and the smallest
  enlarge. Both were closed by reading mainnet and by unsigned simulations on it.
- **Mainnet's loader has never been asked to take this file.** The Upgrade cannot be
  simulated there until a real buffer exists. What stands behind it is a fact, not a run: the
  deployed file came out of the same toolchain in the same format (SBPF v0), mainnet accepted
  it at slot 451,687,458, and no feature has activated on mainnet since that slot (stage 1's
  read, 2026-10-08).
- **The new build has never executed under mainnet's rules**: not the new instruction, and
  not the old instructions as rebuilt.
- **Never on devnet.** Nothing was sent to devnet, and nothing to mainnet.
- **Never with the real wallets.** A test wallet stood in for both members. No real wallet has
  approved or executed through the page, and nobody has looked at these proposals in the
  Squads app.
- **The real upload was not done**: about 720 transactions over a public connection that
  rate-limits. Expect it to stop and to need the same command again (E).

On the day the pack asks mainnet itself before each signature. The page simulates the upgrade
as the vault and refuses unless the program read back out of that simulation is the new
build. After the upgrade a script simulates a trade through both pools, and the new
instruction, before any name record is sent. None of those answers has been seen yet.

**The owner's command sheet is the pack**, not this file:
`C:\Users\jimbo\solana-launch-release-2026-09-26\pool-program-upgrade-2026-10`, starting at
`START-HERE.md`. It holds the one program file to upload, the roll-back file, the reviewed
name files, its scripts (most only read; one that sends is a dry run unless it is given
`--send` and a key file), a copy of the local proposer page with four new steps, and the
outputs of stage 1 and stage 2. This section is the gates and the facts behind them. It says
what the pack does and never its step numbers: the cold run named changes the pack needs,
another pass is making them in the pack, and its numbering moves with them. "The pack checks"
below means what the pack did in those three runs. The pack on disk was already changing
when this was written (2026-10-08, 08:02 UTC).

### A. Before the upgrade PROPOSAL is created. Every one, on the exact commit being built.

1. **The link answers, checked from outside our own network.** Both
   `https://memetics.finance/mint/BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e.json` and
   `https://memetics.finance/mint/3D3EKJxfePDQ1N8YtNwg8W6eSL4mjVpbYf57pnqgcAQx.json` return
   JSON with the four fields and a picture that loads. A mint with NO file (try any other
   address) returns the JSON default, never the app's HTML page.
   Why this gates the upgrade and not only our own two calls: anyone may call the instruction
   from the first slot after the upgrade lands, for the flagship pools and for every other
   pool. Wallets and indexers fetch the link at once and keep what they get. The first
   on-chain write is not ours to schedule.
   The pack checks this by itself. Its first script, and the page, compare the live files
   with the reviewed copies in the pack byte for byte: both flagship files, the default, and
   the three pictures. The page asks again before it offers to propose, to approve or to
   execute the upgrade. Read 2026-10-08: live and correct. The files reached production with
   pull request #757, merged that day at 04:19 UTC.
2. **CI on the exact commit.** Read the `solana-ci` run job by job: `scope`, `diff-guard`,
   `build`, `launch-curve`, `bayla-ladder`, `ladder-constraints`, `launch-constraints`,
   `migration-rehearsal`, then `all-checks-pass`. For a pull request, also
   `mergeStateStatus == CLEAN`. Never a count of green checks. (A branch that is not on the
   remote has run none of them.) Read 2026-10-08: every one of those jobs passed on pull
   request #758 at `338969f4`, which then merged into `mvp-launch` as `f0fec8a7`, and all
   nine passed again in the run on that merge commit. The gate is the run on the commit
   that is built: if trunk's `programs/` moves before the build, read it again there.
3. **Every instruction has run on the new binary.** An upgrade replaces the whole program,
   so the old instructions are new bytes too. The tables in C say what has run. Since
   2026-10-08 nothing there reads "not yet", on a local validator only.
4. **Decided: one upgrade, both changes.** The owner was asked "one upgrade or two" and
   delegated the call on 2026-10-06. The answer is one. So this upgrade also carries the
   on-chain security text of to-do `O-0929-10` (`docs/TODO_OPERATOR.md`): four values of the
   `security_txt!` macro in `lib.rs`, an email as the first contact, every link on
   `memetics.finance`. Those strings are in the binary, so the build that has them
   (`99a9e73d…`) is a different file from the build made earlier that day (`7648994d…`),
   which must never be deployed. Every hash, size and cost in this section is for
   `99a9e73d…`. Two checks come with the text:
   - **Its three links answer, checked from outside our own network, on the day.**
     `curl -sI https://memetics.finance/source/solana/tegridy-amm/SECURITY.md` and
     `curl -sI https://memetics.finance/source/solana/tegridy-amm` each answer `307`, and
     each `location` opens the real file and the real folder: not a `404` page and not the
     repo root. `https://memetics.finance/.well-known/security.txt` is the text file, and its
     `Contact:` email is the one in the macro. Read 2026-10-06: all three did. Read again
     2026-10-08: all three did.
   - **The binary says what the source says.** In the built file, and again in the bytes
     read back from the buffer (gate 6): `grep -a -c -F 'github.com' <file>` and
     `grep -a -c -F 'memetic.fun' <file>` both print `0`, and
     `grep -a -c -F 'email:fomotsar@gmail.com,link:https://memetics.finance/.well-known/security.txt' <file>`
     prints `1`. (`memetic.fun` is the old host. It is not inside `memetics.finance`.)

   Do not carry numbers across another `lib.rs` edit: rebuild, re-pin and re-run.
5. **Build from the merged commit, twice, byte for byte the same.** The result is
   `99a9e73d…` only if `programs/cp-swap/` and `Cargo.lock` are byte for byte what they
   were on 2026-10-06. If the hash differs, find out why before going on. Run
   `node scripts/verify-program-constants.mjs --so <file> --roster cp-swap` on it. Run
   `frontend/scripts/solana-localnet/prove-lp-metadata.mjs` against it on a local validator
   seeded from a fresh read of both pools.
   Read 2026-10-08: on `mvp-launch` at `f0fec8a7`, `programs/` and `Cargo.lock` are byte for
   byte what they were at `b80a6152`, the commit the rehearsal checked its inputs against.
   The file in the pack is the 2026-10-06 build, compared byte for byte with it by the cold
   run. **No build from the merged commit is recorded yet. This gate is open.**
6. **The file in the buffer is the file that was built, and only the pack's checks stand
   between a wrong file and the pools.** The mainnet build and the devnet build are the SAME
   size (724,688 bytes), so size does not catch the devnet build. The build made before the
   security text changed (`7648994d…`, 724,672 bytes) is only 16 bytes smaller and passes
   the constants check, so that check does not catch it. The sha256 catches both.
   - **The chain would install any of them.** The loader takes whatever a vault-held buffer
     holds. Simulated as the vault, it accepted the devnet build, the superseded build, and
     the new build with one letter changed. Nothing on chain compares a buffer with a
     reviewed build. That comparison lives in the pack's buffer check and in the page, and
     both were shown refusing all three.
   - **What a wrong file does**, done on purpose on the throwaway chain: the devnet build
     was deployed at the mainnet id and the loader did not object. Then every swap, deposit
     AND withdrawal failed with `DeclaredProgramIdMismatch` (4100). Nobody could trade or
     take liquidity out until a second upgrade.
   - **So an upgrade proposal is never approved and never executed anywhere but the page.**
     Not in the Squads app, not with a script. In the cold run a proposal for the devnet
     build's buffer, made and approved outside the page, sat at 2 of 2. The page offered no
     button for it, and its own simulation showed that the loader would have taken it.
   - **The buffer check, as it ran.** It reads the buffer's bytes BACK from the chain and
     checks ten things, among them the length, the sha256 against the pinned build, the
     security text in those bytes, the buffer's authority, and that the program account is
     large enough. It does not run `verify-program-constants.mjs` on them: the pack must not
     depend on a worktree, and a file with that sha256 is the file that passed that script
     in stage 1. Run the script from a worktree as well if a second opinion is wanted.
   - Upload from a folder that holds that one program file and no other: no devnet build, no
     test build, no earlier build. The pack's folder for it holds that file and its
     interface file. The roll-back file sits in a folder of its own, and the upgrade's
     checks refuse it.
7. **Ready to send the moment the upgrade lands.** Both now exist. The two
   `create_lp_metadata` calls are one of the pack's scripts: a dry run unless told to send.
   It refuses unless the upgrade is live and that mint's file is live, and it answers
   "ALREADY THERE" for a record someone else created first. Anyone can send them; whoever
   does pays 13,733,800 lamports each. The vault's rename is a step on the page (D below).
8. **Re-read on the day.** The pack's first script reads the first five.
   - **SIMD-0500**, feature `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`: no more
     deployments of SBPF v0 programs. Both our files are v0, the new build AND the roll-back
     build. It had no account on mainnet on 2026-10-08. If it is queued or active, STOP:
     neither file could be deployed. If it activates after the upgrade, the roll-back is
     gone.
   - **The rent** is still 5,080 lamports per byte. Every cost in B assumes it. The next cut
     (2,575, feature `Ftxb3ZKq7aNqgxDBbP7EonvR2RszZk9ctjdsTX38kQaz`) had no account on
     2026-10-08. At 2,575 the enlarge would cost nothing and the buffer 1.87 SOL.
   - **The program** is still what the rehearsal started from: data account
     `F475omgJMd5mnDXJFyjHTkg9zs7WSb6ek9dFoUmUvi5V` of 691,685 bytes, last deployed in slot
     451,687,458, authority the vault, program sha256 `88b98aa9…`.
   - **The enlarge is still open to an ordinary wallet**: simulate it unsigned from the
     paying wallet (B, "The enlarge").
   - **The multisig** is still 2 of 2 with no upgrade or rename proposal already open. It
     stood at 11 transactions with no time lock on 2026-10-08, so the upgrade would be #12.
   - **Any feature activated since 2026-10-08.** The pack knows the features named here and
     no others. Mainnet held 312 feature accounts that day, 309 of them active, none
     activated after slot 451,687,458 (stage 1's read). A newer activation is a reason to
     stop and read what it changes.
   - The name files (gate 1), the three security links (gate 4) and the paying wallet's
     balance (B).
9. **The pack in hand is the pack after the cold run's fixes, walked again.** The cold run's
   verdict on 2026-10-08 was "ready after named fixes", not ready as it stood. The findings
   that touch money or the pools are told in B and E as facts: the enlarge can be run twice,
   the wallet the parked SOL returns to is typed by hand, and the pack's paper did not yet
   say "only on this page".
10. **The two same-release items in C are closed**: the website wording is ready to ship with
    the execute, and the security scope (to-do `O-0929-12`) is decided. Both were open on
    2026-10-08.

### B. Order on the day

What the pack does, in its order. The commands are in the pack.

1. **Fund and check.** The paying wallet is funded, and its key file is confirmed by printing
   its address. A read-only script then checks the first five items of gate 8, the name
   files and every cost at the day's rent against each wallet's balance, and writes both
   pools down for later.
2. **Enlarge.** A read-only check says how many bytes. The paying wallet enlarges by that
   number, once. The same check then refuses, which is how it says the room is there.
3. **Upload, read back, hand over.** A one-time key file for the buffer. The upload. The
   buffer's bytes read back from the chain and hashed. Only then is the buffer handed to the
   vault, and the full buffer check is run on it.
4. **The upgrade, on the local page.** Member A proposes and approves in one signature.
   Member B approves. Member B executes, in a LATER slot than the enlarge. Before each of the
   three signatures the page reads the buffer back, hashes it, checks the name files and
   simulates the upgrade as the vault.
5. **The check after.** The program's hash, the new security text read out of the chain, both
   pools against what was written down, and an unsigned simulation of a trade through both
   pools and of the new instruction.
6. **The two name records.** A dry run, the send from the paying wallet, a read back.
7. **The rename, on the page** (D). Member A proposes, member B approves and executes. A last
   read of both names.

The wallets sign six times on the page in all: member A twice (each a proposal), member B
four times (two approvals, two executes). Member B approves and executes ON THE PAGE, which is
new. The page's seven older steps are still finished in the Squads app. On mainnet the page
lists those seven as well, and at the cold run one of them, "Unpause the launcher", read
"still to do". They are not part of this upgrade. Touch only the upgrade step and the rename
step, and the two "only if" steps when E says so.

**The enlarge.**

- **Any wallet can do it, and the vault cannot.** `solana.exe` sent one instruction with one
  signature, the paying wallet's. The upgrade authority is not named in it. Mainnet accepted
  that exact instruction from a wallet that is not the authority, in an unsigned simulation
  on 2026-10-08. A vault proposal carrying the enlarge failed at execute:
  `Program BPFLoaderUpgradeab1e11111111111111111111111 not supported by inner instructions`.
- **It is not idempotent.** `solana program extend` run a second time enlarges a second time
  and locks the rent a second time. Neither the CLI nor the chain objects. Shown twice: from
  724,733 to 757,781 bytes in stage 1, and by another 22,808 bytes in the cold run. On
  mainnet a repeat of 33,048 bytes is another 167,883,840 lamports that nobody gets back.
  The pack's check refuses once the room is there. At the cold run the enlarge command
  itself still ran when repeated. The fix being made in the pack is a script that reads the
  size, refuses when the room is there, and otherwise sends exactly the missing bytes. It
  was on disk at 08:02 UTC on 2026-10-08 and is not part of any of the three runs.
- **The amount comes from the size read on the day**: 724,733 less the data account's size at
  that moment. 691,685 means 33,048. 724,733 or more means do not enlarge. Never a number
  copied from a paper.
- **A stranger may enlarge first.** It costs them at least 10,240 bytes, 52,019,200 lamports
  at 5,080 per byte. Fewer bytes are then missing. The loader takes no step under 10,240
  (`ExtendProgram requires a minimum of 10240 additional bytes or to extend to maximum size`,
  mainnet's own words in simulation), so a remainder under 10,240 is paid as 10,240: the
  pack's check asks for the larger of the two (read in its code, not run). Shown in the cold
  run: a stranger added 10,240, the check then said 22,808, and the upgrade worked. A
  program account larger than needed does no harm: the upgrade ran with 22,808 spare bytes.
- **The gate that would make it need the authority.** This section used to say: re-read
  feature `2oMRZEDWT2tqtYMofhmmfQ8SsjqUFzT6sYXppQDavxwz`. That is the id validator 3.1.11
  knows. CLI 4.1.1 no longer lists it, and lists the same gate ("Enable ExtendProgramChecked
  instruction") under `ExtendProgCheckedWi11BeDe1eted11111111111111`, a placeholder nobody
  holds a key for. Neither id had an account on mainnet on 2026-10-08, and mainnet's loader
  refused the checked form of the instruction outright (`invalid instruction data`). An id is
  the wrong thing to watch. The direct check is to simulate the exact enlarge, unsigned, from
  the paying wallet on the day, which the pack's check does. If mainnet refuses it, stop.
- **Two traps after the enlarge, and again after a roll-back.** `solana program show` prints
  `Data Length: 724688 (0xb0ed0) bytes` while the program is still the old one: that number
  is the room, not the program. And `solana program dump` writes 724,688 bytes, the old
  program followed by 33,048 zeros, whose sha256 is
  `395940f3ea7ee70ea7a519490e0639a6ec746f506890fe867527a4f349da1f9f`, not `88b98aa9…`. A
  check that pins `88b98aa9…` on a whole dump goes red although nothing is wrong. Hash the
  first 691,640 bytes. Do not trim trailing zeros instead: the deployed file itself ends in
  15 zero bytes.
- **The one-slot gap.** The enlarge re-deploys the program in its slot. A call to the program
  in that slot fails: `Program is not deployed`, then `Unsupported program id`. One slot was
  about 0.27 seconds on mainnet on 2026-10-08. The upgrade must land in a LATER slot. In the
  same slot the loader says `Program was deployed in this block already` (`InvalidArgument`),
  and for two enlarges in one slot `Program was extended in this block already`, which
  mainnet also said in simulation. By the same rule a stranger's enlarge in the slot of our
  execute would refuse that execute. That case is reasoned from the rule and was not run. A
  failed execute does not spend the proposal (E): execute again.

**The buffer.**

- **Read back and hashed BEFORE it is handed to the vault. The hand-over comes last.** Until
  the hand-over the uploading wallet can resume the upload, or close the buffer and take the
  SOL back, alone. After it, only a vault proposal returns the SOL (E).
- **Where the parked SOL returns.** The buffer's full rent leaves the paying wallet with the
  first upload transaction. The execute returns it, to the lamport, to the wallet the
  proposal names, whoever that is. On the page that wallet is an address typed by hand. At
  the cold run the page checked that it was an existing plain wallet (it refused the vault,
  the program, its data account, the buffer itself, a token account and an address that does
  not exist) and did not compare it with the wallet that paid. A wallet the owner does not
  hold, pasted there, would keep the 3.68 SOL. Name the paying wallet and read it twice. The
  fix being made in the pack is for the page to refuse any wallet but the paying one. It was
  in the page's source at 08:02 UTC on 2026-10-08 and is not part of any of the three runs.
- **Only on the page** (gate 6). Nothing else hashes the buffer before a signature.
- The upload command as the pack prints it was run in the cold run against the local chain,
  then interrupted and resumed. Stages 1 and 2 had added a flag (`--use-rpc`) that the owner
  does not use.

**What it costs.** For the build that carries both changes, at mainnet's rent of 5,080
lamports per byte, read on chain 2026-10-08 (07:42 UTC). Re-read every one on the day: all of
them change if `lib.rs` changes or the rent does. The program account holds exactly its
minimum, with no spare bytes and no spare lamports.

| | |
|---|---|
| The build | 724,688 bytes, sha256 `99a9e73dc469755b178d8029196be0ee8f92e557bbd65e15e4511084b6a0fe25`. Built twice from clean copies, byte for byte the same. |
| Growth of the binary | 33,048 bytes (691,640 to 724,688). The security text is 16 of them: the build with the instruction alone was 724,672. |
| The enlarge | 167,883,840 lamports (0.1679 SOL), locked for good: the minimum for 724,733 bytes (3,682,293,880) less what the account holds (3,514,410,040). Mainnet's own loader took exactly that from the payer in an unsigned simulation on 2026-10-08. Every repeat pays it again. A roll-back does not give it back. |
| The upgrade buffer | 3,682,253,240 lamports (3.682 SOL) for its 724,725 bytes. Parked by the first upload transaction, returned by the execute to the wallet the proposal names. |
| The paying wallet's fees | Measured: 721 transactions (the enlarge, 719 for the upload, the hand-over) at 5,000 lamports each, 3,605,000. With the priority fee the pack sets on the upload, the upload alone cost 3,805,414 (210,414 of it priority), so about 3,815,000 in all. |
| **The paying wallet's peak** | **3,853,742,080 lamports (3.854 SOL)** before any priority fee, about 3,853,950,000 with the pack's. The two name records are paid after the buffer's SOL is back, so they do not raise the peak. (This row used to add them and say 3.88.) **Gate: read the paying wallet's balance before the day and see that it covers this.** No wallet of ours did on 2026-10-08 (07:42 UTC): the first deployer `CqcVvaMvesrSKrUSbqBqr9mLjKLJuYqhaXg1gXpR41cg` held 0.0324 SOL, the owner's wallet `Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd` 0.0220, the vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` 0.0152, member A `5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz` 0.1465 and member B `6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY` 0.0311. The pack pays from the first deployer and asks for 3.90 SOL to be sent to it first, which leaves 0.079 SOL above the peak. |
| One name record | 13,733,800 lamports from whoever calls, plus a 5,000 fee: 3,733,800 rent and Metaplex's flat 10,000,000. Two cost 27,477,600. |
| The proposals | Paid by the member who proposes, as rent for two Squads records, and not refunded (no rent collector is set): the upgrade 4,556,680 lamports (records of 378 and 262 bytes), the rename 5,247,560, "return a buffer's SOL" 3,886,120. An approval is 5,000 and an execute 5,000. The executes used 34,628 compute units (the upgrade) and 69,485 (the rename), so no compute-budget instruction is needed. On 2026-10-08 member A and member B each held enough for their part. |
| Spent for good | About 0.21 SOL in all: 0.168 locked in the program account, 0.004 of fees, 0.0275 for two name records, 0.0098 for member A's two proposals. The 3.68 SOL of the buffer is parked and comes back. |

### C. What has run on the new binary, and what ships in the same release

Run on `99a9e73d…`, the build that carries both changes. On 2026-10-06, on a local validator
with mainnet's feature set and Metaplex cloned. (Both runs had passed earlier that day on
`7648994d…`, the build with the instruction alone. They were run again because that is a
different file.) On 2026-10-08, on the rehearsal's chain, after the real enlarge and the real
Upgrade instruction had installed it. Every run is local, on 3.1.11. None is on devnet or on a
4.x validator.

| instruction | run? |
|---|---|
| `create_lp_metadata` | Yes: `prove-lp-metadata.mjs`, four pools, twenty-five refusals. Again on 2026-10-08 on the upgraded program: 130 checks passed. The control, the same script against the deployed binary, failed every check of the new instruction with 101 (`InstructionFallbackNotFound`) and wrote no record, so the proof tells the two binaries apart. |
| `initialize`, `deposit`, `withdraw`, `swap_base_input`, `swap_base_output` | Yes: the same script opens two pools, and on both real pools the deposit, the withdraw and both swaps move the exact amounts, the same amounts and the same compute units as under the deployed binary. On 2026-10-08 again after the roll-back and after going forward again. |
| `initialize_with_permission` (graduation, called by the launch program) | Yes, once through the launch program: `frontend/e2e-solana/launch-flow.spec.ts` in chromium on 2026-10-06. A launch was bought to its target, graduated into a pool through the launch program's call, and then traded in that pool. On 2026-10-08 it also ran called directly by an address the vault had permitted, and was refused once the vault closed that permission (3012 `AccountNotInitialized`). CI's `migration-rehearsal` passed on this source (pull request #758 at `338969f4`). That job builds its own devnet-shape file with CI's keys, so it is a run of the source and not of this file. |
| `collect_protocol_fee`, `collect_fund_fee`, `collect_creator_fee`, `update_pool_status`, `create_amm_config`, `update_amm_config`, `create_permission_pda`, `close_permission_pda`, `create_support_mint_associated`, `close_support_mint_associated` | Yes, all ten, on 2026-10-08: the next table. Nine went through vault proposals that the stand-in members signed as the real vault address. `collect_creator_fee` was sent by a pool's creator. Until then this row read "not yet" and said they belonged in a devnet rehearsal. A stand-in multisig on a local chain signs as the vault too. |

The instructions that need the vault, as run on the new build on 2026-10-08. Each one the
vault signs went through its own vault proposal: proposed with the page's code by one
stand-in member, approved and executed by the other.

| instruction | what happened | what the vault must have |
|---|---|---|
| `update_pool_status` to 4 and back to 0, on BAYLA/SOL | At 4 a swap was refused (6000 `NotApproved`) while deposits and withdrawals stayed on. Back at 0 a swap landed at the exact quote. | nothing |
| `update_amm_config`: the fund fee from 0 to 40,000 and back, on the fee config both pools use | Only that field changed. Swaps landed at the exact quote: the fund fee comes out of the trade fee, so a trader's amounts do not change. Set back, the fee config was byte for byte mainnet's. | nothing |
| `collect_protocol_fee`, both pools | The vault's token accounts received exactly what was owed, the pool vaults paid exactly that, and the counters read 0. Nothing else moved. | its token accounts for wrapped SOL, BAYLA and USDC. All three exist on mainnet. |
| `collect_fund_fee`, both pools | The same, for the fund fee taken while it was 40,000. | a fund fee above zero, and swaps after it |
| `create_permission_pda`, then `close_permission_pda` | The account was created for a throwaway address, and the launcher's own permission account was untouched. Closed, the account was gone and its rent was back in the vault. | rent from its own SOL, returned on close: 2,072,640 lamports on mainnet for 280 bytes |
| `create_amm_config` (index 7) | The fee config exists with the values asked for. It can never be closed. | rent from its own SOL, for good: 1,849,120 lamports on mainnet |
| `create_support_mint_associated`, then `close_support_mint_associated`, for the BAYLA mint | Created, then gone. | rent for 105 bytes from its own SOL, returned on close |
| `collect_creator_fee` (the pool's creator signs, not the vault) | In a pool opened with creator fees on, the creator received exactly what a swap had left owed. A stranger was refused (2015 `ConstraintTokenOwner`). | nothing |

Strangers were tried first on four of them and refused: `update_pool_status` with 2012
`ConstraintAddress`; `update_amm_config`, `collect_protocol_fee` and `create_permission_pda`
with 6001 `InvalidOwner`. The executes used between 21,841 and 51,504 compute units. After all
of it both real pools traded a full round to the exact amounts. The vault held 15,229,120
lamports on 2026-10-08, more than any one of those rents. What each proposal costs the member
who proposes it, at mainnet's rent: a status change 3,743,880 lamports, a fee config change
3,784,520, a permission or a support mint 4,074,080, a new fee config 4,119,800, a fee
collection 5,496,480.

In the SAME release as the upgrade (site and repo). Two of these wait on the owner and were
open on 2026-10-08 (gate A10): the website wording, which is the first two bullets, and the
security scope, which is the last. At the cold run the pack's paper had no step for either.

- `frontend/src/components/solana/lp/LpDisclosures.tsx` (`FORK_LINE`) and
  `frontend/src/components/solana/lp/SolanaLpSection.tsx` ("we changed only its admin keys"):
  both are risk lines a depositor reads, and both go false the day the program is upgraded.
  Upgrade-day wording: "Our pool program is Raydium's, with its admin keys changed and one
  added instruction that names pool share tokens. Those changes have not had their own
  independent review yet." Their tests: `CreatePoolPanel.test.tsx`, `SolanaLpWrites.test.tsx`.
  Not shipped on 2026-10-08, and no open pull request was titled for it that day. It goes
  out with the execute and not before: the test below holds today's wording in place for as
  long as the harness pins the old binary.
- `frontend/src/components/solana/VenueProgramCard.tsx`: delete the paragraph that says the
  program on Solana was built before the instruction was added.
- The pins of the deployed binary: `PIN_CPSWAP` in
  `frontend/scripts/solana-localnet/start-validator.sh`, `cp_swap.mainnet.so` in
  `genesis-accounts.mjs` (and fold the release IDL pin and the repo IDL pin back into one),
  the expected bytecode hash in `frontend/scripts/addresses.json`, and the hashes in §0 here.
  `frontend/src/test/poolProgramCopy.test.ts` fails as soon as those two harness pins move
  and any of the three lines above still has its old wording. It cannot fire if the pins are
  left alone, so move them.
- The docs that say the mainnet binary was built before the instruction: `README.md` here,
  the root `README.md` feature row, `idl/README.md`, the status note in `TEGRIDY_FORK.md`,
  `AUDIT_RFQ.md` ("Corrected again 2026-10-06") and §2 of this file.
- The docs that say the on-chain security text is waiting for the upgrade: to-do `O-0929-10`
  in `docs/TODO_OPERATOR.md` (tick it once the explorer's security tab shows the new
  values), `docs/DEPLOY_RUNBOOK.md` ("Moving the source links"), `docs/SECURITY_TOOLING.md`
  (step 3), "The on-chain security text" in `TEGRIDY_FORK.md`, `README.md` here, and
  `AUDIT_RFQ.md`.
- The security scope, to-do `O-0929-12` in `docs/TODO_OPERATOR.md`: **decide it before the
  upgrade puts the link on chain.** After the upgrade the program's second contact is a link
  to `https://memetics.finance/.well-known/security.txt`. That file's "In scope" block ends
  "Nothing else is in scope" and does not name the two Solana programs. So a researcher who
  follows the on-chain link lands on a file that says the program they came from is out of
  scope. Either add both programs to that block and to the root `SECURITY.md` list, or say
  in both that they are out of scope. The file is a static page
  (`frontend/public/.well-known/security.txt`), so the decision needs a site deploy and no
  rebuild of the program. Read 2026-10-08: still undecided. The served file names no Solana
  program, and the root `SECURITY.md` says the decision has not been made.

### D. The name records afterwards

- **Creating them.** Anyone may, from the first slot after the upgrade (gate 1). Each record
  is born with the program's own words, "Memetics Pool Share" / "MEM-LP", the link, the
  vault as editor, and editable. The new instruction used 53,348 compute units on BAYLA/SOL
  and 50,786 on BAYLA/USDC. A stranger who creates one first does no harm and saves us its
  cost. A confirmation that cannot be read is not a failure: the pack's script says "SENT,
  NOT CONFIRMED", and run again it finds the record and sends nothing.
- **The rename is built and rehearsed.** It is one step on the page: ONE proposal carrying
  two Metaplex updates (`UpdateMetadataAccountV2`). They set "BAYLA/SOL Pool Share"
  (`BAYLA-SOL`) and "BAYLA/USDC Pool Share" (`BAYLA-USDC`) and leave the link, the editor,
  "primary sale" and "mutable" alone. Those two instructions were proposed, approved and
  executed in all three runs: built with the SDK in stage 1, through the page's step in
  stage 2 and in the cold run. The cold run decoded the stored proposal with separate code:
  every field as ruled, no byte left over. Mainnet's Metaplex, under 4.3.0, accepted an
  update of the same shape in an unsigned simulation against a record that exists there
  (cold run, 2026-10-08).
- **What it costs.** The member who proposes pays 5,247,560 lamports for the proposal. The
  update itself is free: no Metaplex fee and no rent, and each record stays 607 bytes.
- **When it refuses.** The page offers no button unless both records exist, belong to
  Metaplex, hold the default words and the pinned link, name the vault as editor and are
  editable, and unless a simulation as the vault ends with both renamed and everything else
  unchanged. In stage 1 five wrong versions were refused before any proposal existed:
  "mutable" turned off, a changed link, a new editor, the two names swapped, and one update
  without the other. At the cold run, with one record already renamed some other way, the
  page stopped and the pack had no way forward. Only a vault proposal made outside the page
  can cause that.
- **Keep the record mutable.** One update signed with "mutable" turned off freezes the words
  for good. Shown on a throwaway pool's record: once frozen, the vault's next update was
  refused by Metaplex with 59 (0x3b), "Data is immutable".
- `BAYLA-USDC` is 10 bytes, exactly Metaplex's limit for a symbol. A stranger who signs the
  same update is refused by Metaplex (7, "Update Authority given does not match").
- **A roll-back does not undo name records.** Metaplex owns them. Every record written under
  the new binary, renamed or not, was still there byte for byte after the roll-back.
- The editor is copied into each record when it is created. If `admin::ID` is ever moved by
  an upgrade, or a vault is retired, every existing record keeps the old vault as its editor.
  **Hand the records over with a Metaplex update BEFORE retiring a vault.**
- Any pool anyone opens can get the house name through this instruction. The default file for
  an unknown mint must not read as us vouching for that pool.

### E. When it does not go as written

- **An execute fails.** A failed execute does not spend the proposal. In stage 1 one proposal
  was executed and refused five times, for four different reasons, and still read
  "Approved". Fix the cause and execute again.
- **The page cannot read what happened after a signature.** That is not a failure. In the
  cold run the connection was cut the moment member B's execute was forwarded. The page said
  UNKNOWN. On the chain the upgrade had landed and the buffer's SOL was back. Do not sign
  again. The pack's check after the upgrade says whether it happened.
- **The upload stops half way.** The buffer already exists at full size and holds its full
  rent. The same command with the same buffer key file carries on, and the rent is not paid
  twice. In fees the resumed upload cost the same as a clean one in the cold run, and
  150,000 lamports more in stage 1. A half-written buffer fails the hash check. That is an
  unfinished upload, not a wrong build: finish the upload and check again before taking
  anything back.
- **The upgrade is abandoned before the hand-over.** The uploading wallet closes the buffer
  alone and the rent comes back to it. Never give that command the program's address:
  closing a program cannot be undone. (Tried in the cold run. Aimed at the program, and at a
  buffer the vault already held, the command was refused because the authority did not
  match, and the program stayed as it was.)
- **The upgrade is abandoned after the hand-over.** Only the vault can return the SOL: a
  proposal carrying the loader's Close instruction (data `05000000`; the buffer, the
  recipient, the vault as signer). It is a step on the page, "return a buffer's SOL". It
  refuses a program, a program's data account and a buffer the vault does not hold. That
  instruction was run in all three runs (built with the SDK in stage 1, through the page's
  step after that) and returned the buffer's rent in full each time. It costs the proposing
  member 3,886,120 lamports.
- **Proposals: what goes stale and what does not.**
  - A change to the multisig between member A's approval and member B's kills the proposal.
    Shown with a member being added: member B's approval was refused with `StaleProposal`
    (6007, "Proposal is stale") and an execute with `InvalidProposalStatus` (6008). Make a
    new proposal. (Stage 1 names a change of threshold or time lock as the same case. Only
    the member change was run.)
  - A proposal BOTH members approved before the change survives it, and it never expires.
  - So an abandoned upgrade proposal that both approved can still be executed for as long as
    its buffer exists. Return its buffer's SOL through the vault. After that the proposal
    can do nothing (`InvalidAccountData`). It stays open in Squads for good, and the page
    shows it as a note. Cancelling it in the Squads app is tidy, not necessary.
  - One approval is never enough: an execute with one approval is refused with 6008.
  - No new upgrade while an older upgrade or rename proposal is open: the pack's first
    script refuses.
- **The roll-back.** It is a step on the page with its own pinned build, the deployed file
  `88b98aa9…`. The pack carries that file, and it was compared with the program read from
  mainnet on 2026-10-08. A roll-back is one more upload, one more hand-over and one more
  proposal. One was run in all three runs (through the page's step in stage 2 and in the
  cold run). In stage 1 both real pools then traded a full round to the exact amounts.
  - Its float: 3,514,369,400 lamports for the buffer, returned on the execute, about 0.0034
    SOL of fees, and 4,556,680 lamports from the proposing member.
  - The data account does not shrink. It stays 724,733 bytes and the enlarge's rent stays
    locked.
  - The program is then the old file followed by 33,048 zeros, so both traps of B apply:
    hash the first 691,640 bytes.
  - `create_lp_metadata` answers 101 again. Name records stay (D).
  - Going forward again was run too, in stage 1: the new build went in a second time, and
    the flagship records were unchanged through both.
  - SIMD-0500 (gate 8) would block a roll-back as it would block the upgrade.
  - The pack estimates fifteen minutes, most of it the upload, and a broken program stays
    broken that long. Uploading the roll-back buffer BEFORE the upgrade executes would make
    it about a minute, at the price of a second 3.51 SOL parked and a peak near 7.37 SOL in
    the paying wallet (this file's arithmetic, not a measured figure). The pack does not do
    that. Its buffer check would show one expected refusal until the upgrade has landed.
    **The owner's call.**
- **A frightening line that is not an error.** On Windows a script that stops right after a
  network read can print
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`.
  That is Node closing down. It was seen in stage 1 and in the cold run. It is not a chain
  error, and nothing was sent.

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
`diff-guard` and turn a cheap diff-audit (four constants, one small added instruction that
names lp tokens, and the program's own name and contact text) into a full AMM audit.

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
