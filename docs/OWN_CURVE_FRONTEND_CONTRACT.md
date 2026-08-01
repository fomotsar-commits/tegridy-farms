# `tegridy-launch` — frontend interface contract

The single source every client surface for **our own bonding curve** is built against:
the page, the read client, the quote engine, and the write client.

Program source, and the only authority for anything below:

| file | what it owns |
| --- | --- |
| `solana/tegridy-amm/programs/tegridy-launch/src/lib.rs` | instructions + account contexts |
| `solana/tegridy-amm/programs/tegridy-launch/src/state.rs` | account layouts, PDA seeds, events |
| `solana/tegridy-amm/programs/tegridy-launch/src/curve.rs` | ALL pricing math |
| `solana/tegridy-amm/programs/tegridy-launch/src/errors.rs` | error codes |
| `solana/tegridy-amm/programs/tegridy-launch/MIGRATE_DESIGN.md` | graduation decisions + measured costs |

Every line reference in this document is `file:line` against those files at the commit
that introduced this doc. If a citation and the code disagree, **the code wins** — and
this file is wrong and must be fixed.

---

## 0. Read this before you render anything

### 0.1 The program is NOT deployed. Anywhere.

`declare_id!("8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8")` (lib.rs:101) is a
**throwaway placeholder** — lib.rs:97-100 says so in as many words. It corresponds to no
key anybody holds and returns `null` on mainnet-beta.

Consequences that are not optional:

- Every surface must state, unambiguously, that this is **not live**. No price, no
  volume, no holder count, no market cap, no "0 SOL raised" — because there is no
  market to have raised zero from.
- The first thing any read client does is `getAccountInfo(PROGRAM_ID)`. `null` →
  render **not deployed**, and stop. Do not proceed to derive PDAs and render their
  absence as data.
- A non-devnet build additionally cannot be initialized at all: `deployer::ID` is
  `11111111111111111111111111111111`, the System Program sentinel (lib.rs:128-129),
  which nobody can sign for. So even after a deploy, `global` will not exist until an
  operator sets a real key and rebuilds.

### 0.2 The three states that look alike

This repo has shipped the collapse of these three more than once (a scam pool rendered
as `520607 ETH`; `Ownership renounced` printed from an `owner()` call that never
returned). Keep them strictly apart, in types, not just in copy:

1. **read it, answer is no** — a real negative finding
2. **read it, answer is yes** — a real positive finding
3. **could not read it** — *not a finding about the launch at all*

`frontend/src/lib/launcher/tokenDossier.ts:1-19` is the pattern to copy: every
classifier returns an explicit unreadable kind and the page renders it as such. Do that
here. **An RPC error is never `0`, never a green badge, never "no issues".**

### 0.3 There is no on-chain "migrating" state

Migration is **one atomic instruction** (lib.rs:693-1188, and the design note at
lib.rs:32-38 explains why splitting it was a total-loss bug). A curve is either open or
`complete`. Nothing in between exists on chain.

A UI may show "migrating…" **only** as local optimistic state while its own transaction
is in flight, and it must clear on confirmation or failure. Never derive it from account
state.

---

## 1. Program identity, and the client's obligations

| thing | value | source |
| --- | --- | --- |
| program id (PLACEHOLDER) | `8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8` | lib.rs:101 |
| Anchor version | `0.32.1` | `Anchor.toml` `[toolchain]`, `programs/tegridy-launch/Cargo.toml` |
| Solana version | `2.3.0` | `Anchor.toml` |
| SPL token program | **legacy `TOKEN_PROGRAM_ID` only** | `Program<'info, Token>` — lib.rs:1311, 1455, 1498 |
| program binary size, measured | 444,920 bytes | measured this session; not re-derived here |
| cp-swap program id (fork, placeholder) | `BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL` | `programs/cp-swap/src/lib.rs:42-44` |

**Token-2022 is not supported.** Every token program account is typed
`Program<'info, Token>`, and every mint/token account is `anchor_spl::token::{Mint,
TokenAccount}` — the legacy program. A Token-2022 mint will fail account validation. A
create-launch UI must reject one up front rather than let it revert.

### 1.1 There is no committed IDL

`solana/tegridy-amm/.gitignore` ignores `target/`, and `git ls-files` returns no IDL.
Both test suites load it from `../target/idl/tegridy_launch.json` at runtime
(`tests/tegridy-launch-constraints.test.ts:74-77`,
`tests/tegridy-launch-migration.test.ts:108-113`), which only exists after `anchor
build` — and SBF cannot be built on the Windows dev box (lib.rs:68-74).

**Therefore: do not build a client that depends on an IDL artifact existing.** Encode
the instruction layouts by hand from §2, exactly as
`frontend/src/lib/launcher/solana/dbc.ts` avoids runtime SDK weight with a type-only
import. Discriminators are in §2.0 and the account layouts in §3 are fixed byte offsets.

### 1.2 PDA auto-resolution is OFF

`Anchor.toml` has `[features] seeds = false`, so the generated IDL carries **no** PDA
seed metadata. Anchor's JS client cannot auto-derive any address here — which is why
both test suites use `.accountsPartial({...})` with every PDA passed explicitly
(`tests/tegridy-launch-migration.test.ts:191-200, 216-226, 426-450`).

**Every account address in §2 must be supplied by the client.** Derive them with §4.

### 1.3 RPC reachability — what the proxy will and will not do

The browser never talks to a Solana RPC directly; it goes through
`frontend/api/solrpc.js` (see `frontend/src/lib/solana.ts:24-35`). That proxy carries a
**method allowlist** (`frontend/api/solrpc.js:34-47`, enforced at `:131`). From it:

**Allowed** and therefore usable: `getAccountInfo`, `getMultipleAccounts`,
`getMinimumBalanceForRentExemption`, `getBalance`, `getTokenAccountsByOwner`,
`getTokenAccountBalance`, `getTokenSupply`, `getTokenLargestAccounts`,
`getLatestBlockhash`, `simulateTransaction`, `sendTransaction`, `getSignatureStatuses`,
`getTransaction`, `getSignaturesForAddress`, `getRecentPrioritizationFees`,
`getFeeForMessage`.

**NOT allowed**: `getProgramAccounts`. It is deliberately excluded as an unbounded scan.

> **This is a hard product constraint, not a detail.** There is no way to *enumerate*
> launches from the browser. A "all launches" list must come from a curated mint list or
> a new server-side route — and Vercel Hobby is at 9 of 12 functions, so it must be a
> `?resource=` branch on the existing aggregator catchall, not a new `api/*.js`. Until
> that exists, a directory page must say it is showing a **known list**, not "all
> launches".

Also note `MAX_RPC_BATCH = 20` (`frontend/api/solrpc.js:48`, enforced at `:127`) —
JSON-RPC batches must stay at or under 20 calls.

### 1.4 Compute budget — a CLIENT obligation

`migrate_to_amm` consumes **264,128 CU**, measured off the confirmed rehearsal
transaction (MIGRATE_DESIGN.md:220-239). Solana's default is **200,000 CU per
instruction**. It does not fit.

Any client that calls `migrate_to_amm` **MUST** prepend
`ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })` — the value CI uses
(`tests/tegridy-launch-migration.test.ts:425`). Omit it and the transaction fails with
`Program failed to complete`, which reads like a program bug and has already cost one
debugging cycle here.

**`buy` and `sell` CU cost is UNMEASURED.** No test in the repo measures it
(`grep ComputeBudget tests/` hits only `tests/utils/instruction.ts:11` and the migration
test). Do not state a number for them anywhere. If you set a limit, say in a comment
that it is a guess, not a measurement.

---

## 2. Instructions

Every handler returns `Result<()>`. **No instruction returns data.** A client learns the
outcome by (a) decoding the emitted event from the transaction logs (§5), or (b)
re-reading the accounts. `buy` does not hand back `tokens_out`.

### 2.0 Discriminators

Anchor's default derivation: instruction = `sha256("global:<snake_name>")[0..8]`,
account = `sha256("account:<StructName>")[0..8]`, event =
`sha256("event:<EventName>")[0..8]`. Computed here, not copied:

| name | discriminator (LE bytes) | hex |
| --- | --- | --- |
| `initialize_global` | `[47,225,15,112,86,51,190,231]` | `2fe10f705633bee7` |
| `update_global` | `[90,152,240,21,199,38,72,20]` | `5a98f015c7264814` |
| `create_launch` | `[239,223,255,134,39,121,127,62]` | `efdfff868627793e` |
| `buy` | `[102,6,61,18,1,218,235,234]` | `66063d1201daebea` |
| `sell` | `[51,230,133,164,1,127,131,173]` | `33e685a4017f83ad` |
| `migrate_to_amm` | `[207,82,192,145,254,207,145,223]` | `cf52c091fecf91df` |
| account `GlobalConfig` | `[149,8,156,202,160,252,176,217]` | `95089ccaa0fcb0d9` |
| account `BondingCurve` | `[23,183,248,55,96,216,172,96]` | `17b7f83760d8ac60` |
| event `LaunchCreated` | `[59,38,190,230,33,34,89,20]` | `3b26bee621225914` |
| event `Traded` | `[225,202,73,175,147,43,160,150]` | `e1ca49af932ba096` |
| event `Graduated` | `[51,241,66,50,140,245,156,192]` | `33f142328cf59cc0` |

⚠️ These are the **default** derivation. Anchor ≥0.30 embeds explicit discriminators in
the IDL, and a future `#[instruction(discriminator = …)]` override would silently
diverge. Re-verify against `target/idl/tegridy_launch.json` the first time a build
exists, and pin a test that asserts they match.

Args are Borsh, little-endian, appended after the 8-byte discriminator. `u64` → 8 bytes
LE. `Option<T>` → `0x00` for `None`, `0x01` followed by `T` for `Some`. `Pubkey` → 32
raw bytes. `bool` → 1 byte.

---

### 2.1 `initialize_global` — lib.rs:188-267

One-time protocol setup. **Operator/runbook only — no user-facing surface should offer
this.** Listed because a read client needs to know why `global` may be absent.

Args, in order (lib.rs:189-197):

| # | name | type |
| --- | --- | --- |
| 1 | `trade_fee_bps` | `u64` |
| 2 | `initial_virtual_sol` | `u64` |
| 3 | `initial_virtual_token` | `u64` |
| 4 | `token_total_supply` | `u64` |
| 5 | `graduation_target_lamports` | `u64` |
| 6 | `migration_reserve_lamports` | `u64` |
| 7 | `cp_swap_program` | `Pubkey` |
| 8 | `amm_config` | `Pubkey` |

Accounts, in declaration order (`InitializeGlobal`, lib.rs:1222-1240):

| # | account | signer | writable | constraint |
| --- | --- | --- | --- | --- |
| 1 | `authority` | ✅ | ✅ | `address = deployer::ID` (lib.rs:1226). Non-devnet that is the System sentinel → **cannot succeed** |
| 2 | `fee_recipient` | — | — | unchecked; address only |
| 3 | `global` | — | ✅ | `init`, PDA `["global"]` |
| 4 | `system_program` | — | — | `11111111111111111111111111111111` |

Rejects (all `LaunchError`, §6): `FeeTooHigh` if `trade_fee_bps > 1000`;
`InvalidParameter` on any zero virtual reserve / supply / target (lib.rs:203-206);
`GraduationTargetUnreachable` if `target + reserve >= max_reachable_real_sol`
(lib.rs:219-228); `MigrationReserveTooLow` if `reserve < 42_156_720`
(lib.rs:151-154, state.rs:48); `GraduationPriceGap` if the listing/curve price ratio
falls outside `10_000 ± 500` bps (lib.rs:156-169).

---

### 2.2 `update_global` — lib.rs:275-383

Authority-only. Never affects a live curve — every launch snapshots its own terms at
creation (lib.rs:426-432).

Args, all `Option<…>`, in order (lib.rs:276-285): `trade_fee_bps: Option<u64>`,
`graduation_target_lamports: Option<u64>`, `paused: Option<bool>`,
`new_authority: Option<Pubkey>`, `new_fee_recipient: Option<Pubkey>`,
`migration_reserve_lamports: Option<u64>`, `new_cp_swap_program: Option<Pubkey>`,
`new_amm_config: Option<Pubkey>`, `new_initial_virtual_sol: Option<u64>`.

Accounts (`UpdateGlobal`, lib.rs:1242-1252):

| # | account | signer | writable | constraint |
| --- | --- | --- | --- | --- |
| 1 | `global` | — | ✅ | PDA `["global"]`, `has_one = authority` |
| 2 | `authority` | ✅ | — | must equal `global.authority` |

`Pubkey::default()` is rejected for authority, fee recipient, cp-swap program and
amm_config (lib.rs:360-381) — a zero would brick the protocol or read like a setup
mistake later. `paused` is the intended kill switch.

---

### 2.3 `create_launch` — lib.rs:387-444

Mints the whole supply onto a new curve and **permanently revokes the mint authority**
in the same instruction (lib.rs:395-421).

**Args: none.** Supply, virtual reserves, fee, target and reserve are all read from
`global` and snapshotted onto the curve.

Accounts (`CreateLaunch`, lib.rs:1254-1314):

| # | account | signer | writable | constraint |
| --- | --- | --- | --- | --- |
| 1 | `creator` | ✅ | ✅ | pays rent for `curve` + `curve_vault` |
| 2 | `global` | — | — | PDA `["global"]`, `bump = global.bump` |
| 3 | `mint` | — | ✅ | `mint_authority == Some(creator)`; `supply == 0`; **`freeze_authority.is_none()`** (lib.rs:1283-1289) |
| 4 | `curve` | — | ✅ | `init`, PDA `["curve", mint]` |
| 5 | `curve_vault` | — | ✅ | `init`, PDA `["vault", mint]`, token account, mint = `mint`, authority = `curve` |
| 6 | `token_program` | — | — | `TOKEN_PROGRAM_ID` |
| 7 | `system_program` | — | — | |
| 8 | `rent` | — | — | `SYSVAR_RENT_PUBKEY` |

**Client obligations before calling:**

- Create the mint first, with the caller as mint authority and **`freezeAuthority =
  null`**. The freeze-authority rejection is load-bearing and is explained at
  lib.rs:1265-1282 — a retained freeze authority can freeze `curve_vault` (a
  deterministic, publicly-derivable PDA) and lock 100% of raised SOL forever. A create
  UI must set it to null and must say why.
- **Decimals are NOT constrained by the program.** The tests use 9
  (`tests/tegridy-launch-constraints.test.ts:103-109`) but nothing enforces it. A client
  must read decimals off the mint account; never assume 9.
- The program does **not** create Metaplex metadata. Name, symbol and image are not
  program state and never will be — see §7.
- `create_launch` blocks while `global.paused` (lib.rs:389).

Rejects: `Paused`; `Unauthorized` (wrong mint authority); `InvalidParameter` (supply
!= 0); `MintHasFreezeAuthority`.

Emits `LaunchCreated` (lib.rs:436-442).

---

### 2.4 `buy` — lib.rs:452-559

Args (lib.rs:452): `max_lamports_in: u64`, `min_tokens_out: u64`.

⚠️ **`max_lamports_in` is a CEILING, not the amount spent.** A buy that would carry the
curve past `graduation_target + migration_reserve` is **capped** at that line and the
remainder is simply never taken (design note 4, lib.rs:27-30, cap at lib.rs:466-480).
There is no refund transfer — the money never leaves the wallet.

**A UI that shows the user "you will spend `max_lamports_in`" is wrong on the last buy
of every launch.** Compute the cap (§5.2) and show the *actual* debit.

Accounts (`Trade`, lib.rs:1461-1500) — shared with `sell`:

| # | account | signer | writable | constraint |
| --- | --- | --- | --- | --- |
| 1 | `trader` | ✅ | ✅ | |
| 2 | `global` | — | — | PDA `["global"]`, `bump = global.bump` |
| 3 | `fee_recipient` | — | ✅ | `address = global.fee_recipient` (lib.rs:1470) |
| 4 | `mint` | — | — | |
| 5 | `curve` | — | ✅ | PDA `["curve", mint]`, `has_one = mint` |
| 6 | `curve_vault` | — | ✅ | PDA `["vault", mint]`, `mint == mint` |
| 7 | `trader_token_account` | — | ✅ | `mint == mint` AND `owner == trader` (lib.rs:1493-1494) |
| 8 | `token_program` | — | — | `TOKEN_PROGRAM_ID` |
| 9 | `system_program` | — | — | |

`trader_token_account` is **not** constrained to be the ATA — any token account the
trader owns works. Use the ATA, and **create it yourself first**: nothing in this
instruction creates it.

Order of operations: SOL moves first (buyer → curve principal, buyer → fee recipient,
both plain system transfers signed by the buyer, lib.rs:499-520), then tokens move
vault → buyer signed by the curve PDA (lib.rs:525-536).

Rejects, in the order they fire: `Paused` (lib.rs:453) · `AlreadyComplete`
(lib.rs:455) · `AwaitingMigration` when the curve is already fully funded
(lib.rs:479 — **this is not the same as graduated**, and an earlier version conflating
them is called out at lib.rs:476-479) · `ZeroAmount` · `SlippageExceeded` when
`tokens_out < min_tokens_out` (lib.rs:491) · `InsufficientLiquidity` when `tokens_out >
real_token_reserves` (lib.rs:492-495).

Emits `Traded { is_buy: true }` (lib.rs:548-557). Note `sol_amount` there is
`lamports_to_curve` — **net of fee**, not the total debit.

---

### 2.5 `sell` — lib.rs:565-661

Args (lib.rs:565): `tokens_in: u64`, `min_lamports_out: u64`.

Accounts: identical `Trade` context, same order.

**`sell` is deliberately NOT gated on `global.paused`** (lib.rs:563-564, design note 2 at
lib.rs:22-23). A pause stops new money entering; it must never trap holders. **A UI must
not grey out sell when paused.** It must keep sell available and say so.

`sell` is also not capped and cannot overshoot anything.

Rejects: `AlreadyComplete` · `ZeroAmount` · `SlippageExceeded` (lib.rs:578-581) ·
`InsufficientLiquidity` when `gross_lamports > real_sol_reserves` — the virtual leg is
pricing fiction and is never redeemable (lib.rs:582-587) ·
`InsufficientRentExemptBalance` when the debit would drop the curve PDA below its
rent floor (lib.rs:605-614).

Emits `Traded { is_buy: false }`. There `sol_amount` is `lamports_out` — **net of
fee** — while `token_amount` is `tokens_in`.

---

### 2.6 `migrate_to_amm` — lib.rs:693-1188

**Args: none.** Permissionless by design (lib.rs:686-692): no caller-chosen parameters,
pays the caller nothing, exactly one legal outcome. The `payer` funds account rent and
is fully reimbursed by the sweep at lib.rs:1075-1162.

Accounts (`MigrateToAmm`, lib.rs:1323-1459), **23 in declaration order**:

| # | account | signer | writable | how the client gets it |
| --- | --- | --- | --- | --- |
| 1 | `payer` | ✅ | ✅ | caller |
| 2 | `global` | — | — | PDA `["global"]` |
| 3 | `launch_mint` | — | — | the launch mint |
| 4 | `curve` | — | ✅ | PDA `["curve", launch_mint]` |
| 5 | `curve_vault` | — | ✅ | PDA `["vault", launch_mint]` |
| 6 | `wsol_mint` | — | — | `So11111111111111111111111111111111111111112` (address-checked, lib.rs:1354) |
| 7 | `migration_authority` | — | ✅ | PDA `["migauth", launch_mint]` |
| 8 | `auth_wsol` | — | ✅ | ATA(wsol_mint, migration_authority, **allowOwnerOffCurve = true**) |
| 9 | `auth_token` | — | ✅ | ATA(launch_mint, migration_authority, allowOwnerOffCurve) |
| 10 | `auth_lp` | — | ✅ | ATA(lp_mint, migration_authority, allowOwnerOffCurve) — created *inside* the CPI (lib.rs:1398-1412) |
| 11 | `cp_swap_program` | — | — | must equal `global.cp_swap_program` (lib.rs:707-711) |
| 12 | `amm_config` | — | — | must equal `global.amm_config` |
| 13 | `amm_authority` | — | — | PDA `["vault_and_lp_mint_auth_seed"]` on cp-swap |
| 14 | `pool_state` | — | ✅ | PDA `["launchpool", launch_mint]` **on tegridy-launch** |
| 15 | `lp_mint` | — | ✅ | PDA `["pool_lp_mint", pool_state]` on cp-swap |
| 16 | `token_0_vault` | — | ✅ | PDA `["pool_vault", pool_state, mint0]` on cp-swap |
| 17 | `token_1_vault` | — | ✅ | PDA `["pool_vault", pool_state, mint1]` on cp-swap |
| 18 | `create_pool_fee` | — | ✅ | cp-swap's `create_pool_fee_reveiver::ID` — a **WSOL token account**, not a wallet (`programs/cp-swap/src/lib.rs:57-68`) |
| 19 | `observation_state` | — | ✅ | PDA `["observation", pool_state]` on cp-swap |
| 20 | `token_program` | — | — | `TOKEN_PROGRAM_ID` |
| 21 | `associated_token_program` | — | — | `ATokenGPv…` |
| 22 | `system_program` | — | — | |
| 23 | `rent` | — | — | `SYSVAR_RENT_PUBKEY` |

`mint0`/`mint1` are `(wsol_mint, launch_mint)` **sorted by raw pubkey bytes** — cp-swap
constrains `token_0_mint < token_1_mint` and getting it backwards is a hard revert
(lib.rs:950-958, MIGRATE_DESIGN.md:88-92). The reference sort is
`tests/tegridy-launch-migration.test.ts:293-296`.

The working client reference for all 23 is
`tests/tegridy-launch-migration.test.ts:418-451`. Copy it; do not re-derive from memory.

**Preconditions the client must check before offering the button** (all read-only):

1. `!global.paused` (lib.rs:695)
2. `global.cp_swap_program != 0` AND `global.amm_config != 0` (lib.rs:700-703), else
   `AmmNotConfigured`
3. `!curve.complete` (lib.rs:714)
4. `curve.real_sol_reserves >= curve.graduation_target_lamports` (lib.rs:715-718), else
   `NotReadyToGraduate`
5. `curveAccountLamports - rentExempt(curve.data.len) >= graduation_target +
   migration_reserve` (lib.rs:731-743), else `MigrationReserveTooLow`

Condition 5 is the binding one in practice and it reads the **PDA's actual lamport
balance**, not the `real_sol_reserves` field. Compute it; do not infer it.

**Known stall, do not report it as a bug** (MIGRATE_DESIGN.md:294-304): on an
exactly-funded curve, a 1-lamport `sell` front-run makes migration revert until someone
buys again. `sell` is unpausable by design. It is a stall, not a brick — migration is a
retry-until-it-lands operation. A UI should present a failed migration as *retryable*,
never as "this launch is broken".

Emits `Graduated` (lib.rs:1182-1186).

---

## 3. Account layouts

Anchor accounts are `8-byte discriminator || borsh fields in declaration order`.
Everything here is fixed-width, so a client can decode by **byte offset** with a
`DataView` and no borsh library. `u64` is little-endian and **must** be read as
`BigInt` — values exceed `Number.MAX_SAFE_INTEGER` routinely (`token_total_supply` in
the tests is `1_000_000_000_000_000`).

### 3.1 `GlobalConfig` — state.rs:77-120 · PDA `["global"]` · **186 bytes**

| offset | len | field | type | notes |
| --- | --- | --- | --- | --- |
| 0 | 8 | discriminator | | `95089ccaa0fcb0d9` |
| 8 | 32 | `authority` | Pubkey | mainnet: Squads multisig, threshold ≥ 2 (state.rs:80) |
| 40 | 32 | `fee_recipient` | Pubkey | |
| 72 | 8 | `trade_fee_bps` | u64 | ≤ `MAX_FEE_BPS` = 1000 |
| 80 | 8 | `initial_virtual_sol` | u64 | |
| 88 | 8 | `initial_virtual_token` | u64 | |
| 96 | 8 | `token_total_supply` | u64 | raw base units |
| 104 | 8 | `graduation_target_lamports` | u64 | **excludes** the reserve (state.rs:91-93) |
| 112 | 8 | `migration_reserve_lamports` | u64 | |
| 120 | 32 | `cp_swap_program` | Pubkey | **may legitimately be all-zero** |
| 152 | 32 | `amm_config` | Pubkey | **may legitimately be all-zero** |
| 184 | 1 | `paused` | bool | |
| 185 | 1 | `bump` | u8 | |

`8 + InitSpace(178) = 186`. Rent exemption ≈ `(128 + 186) × 6960 = 2_185_440` lamports —
but call `getMinimumBalanceForRentExemption(186)` rather than hardcoding.

**Zero `cp_swap_program` / `amm_config` is a real, expected state**, not a read failure:
the AmmConfig is created by a cp-swap admin action *after* deploy (lib.rs:184-187). Render
it as **"graduation venue not configured yet"**, never as an address of zeros and never
as an error.

### 3.2 `BondingCurve` — state.rs:123-166 · PDA `["curve", mint]` · **162 bytes**

| offset | len | field | type | notes |
| --- | --- | --- | --- | --- |
| 0 | 8 | discriminator | | `17b7f83760d8ac60` |
| 8 | 32 | `mint` | Pubkey | |
| 40 | 32 | `creator` | Pubkey | |
| 72 | 8 | `virtual_sol_reserves` | u64 | snapshot of `global.initial_virtual_sol` |
| 80 | 8 | `virtual_token_reserves` | u64 | snapshot |
| 88 | 8 | `real_sol_reserves` | u64 | **the progress number** |
| 96 | 8 | `real_token_reserves` | u64 | tokens still on the curve |
| 104 | 8 | `trade_fee_bps` | u64 | **snapshot — quote with THIS, never `global`** |
| 112 | 8 | `graduation_target_lamports` | u64 | snapshot |
| 120 | 8 | `migration_reserve_lamports` | u64 | snapshot |
| 128 | 1 | `complete` | bool | terminal; only `migrate_to_amm` writes it |
| 129 | 32 | `pool` | Pubkey | **all-zero until migration** (state.rs:159-163) |
| 161 | 1 | `bump` | u8 | |

`8 + InitSpace(154) = 162`. Rent exemption ≈ `(128 + 162) × 6960 = 2_018_400` lamports —
again, prefer `getMinimumBalanceForRentExemption(162)`.

**The snapshot rule is a correctness requirement, not trivia.** `trade_fee_bps`,
`graduation_target_lamports` and `migration_reserve_lamports` are copied from `global`
at `create_launch` (lib.rs:430-432) precisely so governance cannot retroactively rewrite
a live launch's economics (design note 1, lib.rs:18-21). **A quote computed from
`global.trade_fee_bps` will disagree with the program on any curve created before a fee
change.** Always read the curve.

### 3.3 The curve PDA's lamport balance ≠ `real_sol_reserves`

The curve PDA holds `rent_exempt(162) + real_sol_reserves + any donated lamports`.
Anyone can send lamports to a derivable address. Two rules:

- **Progress / "SOL raised" must render `real_sol_reserves`**, the field. Not the account
  balance.
- **The migration budget check (§2.6 condition 5) reads the account balance.** Use
  `getAccountInfo(curve).lamports` there.

Do not use one where the other belongs.

### 3.4 The graduated pool account

`pool_state` is cp-swap's `PoolState` — `#[account(zero_copy(unsafe))]
#[repr(C, packed)]` (`programs/cp-swap/src/states/pool.rs:63-129`). **Anchor's borsh
account coder cannot decode it.** Decode by offset, or read the vault balances instead
via `getTokenAccountBalance(token_0_vault)` / `token_1_vault`, which is simpler and
sufficient for "what is in the pool".

`lp_supply` sits inside that struct; after a successful migration the **LP mint supply is
zero** because the LP is burned (lib.rs:1046-1073, and the burn is asserted at
lib.rs:1072-1073). `getTokenSupply(lp_mint)` returning `0` is the on-chain proof of
"liquidity permanently locked" and is the honest thing to link. If that read fails,
say it could not be verified — do not print the claim.

---

## 4. PDA derivations

All seeds are raw ASCII bytes with no null terminator. Constants: state.rs:4-21, 69.

**On `tegridy-launch`** (program id from §1):

| PDA | seeds, in order | source |
| --- | --- | --- |
| `global` | `["global"]` | state.rs:4 |
| `curve` | `["curve", mint]` | state.rs:5 |
| `curve_vault` | `["vault", mint]` | state.rs:6 |
| `migration_authority` | `["migauth", mint]` | state.rs:21 |
| `pool_state` | `["launchpool", mint]` | state.rs:69 |

`mint` is the launch mint's 32 raw bytes.

⚠️ **`pool_state` is derived from `tegridy-launch`, NOT from cp-swap's canonical
`["pool", amm_config, mint0, mint1]`.** That is a security property, not a preference:
cp-swap's `initialize` is permissionless, so the canonical address is a public brick —
anyone can occupy it for one transaction's cost and permanently prevent a launch from
graduating (state.rs:50-69, MIGRATE_DESIGN.md:158-180). The rehearsal deliberately
occupies the canonical address before migrating
(`tests/tegridy-launch-migration.test.ts:329-402`) so a regression fails CI. **A client
that derives the canonical address will point users at the wrong pool.**

**On the cp-swap fork** (`programs/cp-swap/src/states/pool.rs:6-8`,
`states/oracle.rs:8`, `lib.rs:70`):

| PDA | seeds, in order |
| --- | --- |
| `amm_authority` | `["vault_and_lp_mint_auth_seed"]` |
| `lp_mint` | `["pool_lp_mint", pool_state]` |
| `token_0_vault` | `["pool_vault", pool_state, mint0]` |
| `token_1_vault` | `["pool_vault", pool_state, mint1]` |
| `observation_state` | `["observation", pool_state]` |
| `amm_config` (index `i: u16`) | `["amm_config", be_u16(i)]` — note **big-endian** |

Working reference for every one: `tests/tegridy-launch-migration.test.ts:289-292,
442-445` and `:148-151`.

**ATAs** for `auth_wsol` / `auth_token` / `auth_lp` must be derived with
`allowOwnerOffCurve = true` — the owner is a PDA
(`tests/tegridy-launch-migration.test.ts:434-436`).

---

## 5. The curve math a UI must replicate

**This section is the one that costs users money if it drifts.** It is a line-by-line
restatement of `curve.rs`. Any difference between what the UI quotes and what the
program executes is a bug.

> **This section was verified differentially, not by eye.** `curve.rs` was compiled on
> the host (`rustc --edition 2021 --test curve.rs` — **23/23 pass**, the route lib.rs:10-12
> describes) and driven over **30,000 randomized cases** spanning the full `u64`
> magnitude range, all of `{0, 1, 25, 100, 300, 1000, 1001, 10000}` bps, and the
> below/at/above-ceiling branches. The JS below — transcribed from *this document*, not
> from the Rust — matched on **30,000/30,000, zero mismatches**.
>
> That harness was then mutation-checked: eight plausible mis-transcriptions (fee
> rounding down; `tokensOut`/`gross` rounding up; `lamports_until_target` flooring;
> dropping `dx` from the buy denominator; removing the `MAX_FEE_BPS` guard; failing to
> deduct either fee) each turned it **RED**, with 2,366–9,934 mismatching cases. So the
> agreement above is a real result.
>
> **Builders: port this harness.** When you write the real quote module, re-run it
> against your implementation before shipping. Rounding bugs here are silent and only
> show up as users getting less than the UI promised.

Non-negotiable implementation rules:

- **`BigInt` everywhere.** Never `Number`. `virtual_token_reserves` in the tests is
  `1_073_000_000_000_000` and `token_total_supply` is `1_000_000_000_000_000`; products
  of those with lamports blow past float precision instantly.
- **Rounding direction is asymmetric on purpose** (curve.rs:19-29): tokens out on a buy
  round **down**, lamports out on a sell round **down**, fees round **up**. Every
  decision favours the curve so order-slicing cannot grind value out. Getting one
  backwards produces a quote the program will refuse or beat.
- Constants: `BPS_DENOMINATOR = 10_000` (curve.rs:32), `MAX_FEE_BPS = 1_000`
  (curve.rs:37).

### 5.1 Effective reserves

```
effective_sol    = curve.virtual_sol_reserves   + curve.real_sol_reserves
effective_tokens = curve.virtual_token_reserves + curve.real_token_reserves
```

state.rs:168-183. Both legs are `virtual + real`. The pricing invariant is constant
product `x·y = k` over those effective reserves (curve.rs:5-17).

### 5.2 Fee — `fee_up`, curve.rs:91-106

```ts
function feeUp(amount: bigint, feeBps: bigint): bigint {
  if (feeBps > 1000n) throw new CurveError('FeeTooHigh');   // curve.rs:93-95
  if (feeBps === 0n) return 0n;                             // curve.rs:96-98
  const num = amount * feeBps;
  return (num + 9999n) / 10000n;                            // div_ceil, curve.rs:104
}
```

Rounds **UP**. `feeUp(1n, 1n) === 1n` and `feeUp(20000n, 100n) === 200n` (exactly
divisible is not pushed up) — pinned at curve.rs:489-496.

### 5.3 The buy cap — `lamports_until_target`, curve.rs:216-240

Called by `buy` at lib.rs:466-480 against `raise_ceiling = graduation_target_lamports +
migration_reserve_lamports` — **the target PLUS the reserve, not the target alone**
(lib.rs:459-469; capping at the target alone made the reserve unraisable and was caught
by the CI rehearsal).

```ts
// returns null when the curve is already fully funded
function lamportsUntilTarget(realSol: bigint, ceiling: bigint, feeBps: bigint): bigint | null {
  if (realSol >= ceiling) return null;                      // curve.rs:221-223
  const remaining = ceiling - realSol;                      // post-fee amount
  if (feeBps >= 10000n) throw new CurveError('FeeTooHigh'); // curve.rs:230-232
  const denom = 10000n - feeBps;
  const num = remaining * 10000n;
  return (num + denom - 1n) / denom;                        // div_ceil, curve.rs:237
}
```

`null` → the program returns **`AwaitingMigration`**, not `AlreadyComplete`
(lib.rs:476-479). Render it as *fully funded, waiting on migration* — it has **not**
graduated.

### 5.4 Buy quote — `quote_buy`, curve.rs:112-161, plus the wrapper checks in `buy`

Exact order, matching lib.rs:466-495:

```ts
function quoteBuy(curve: BondingCurve, maxLamportsIn: bigint) {
  const feeBps = curve.tradeFeeBps;                 // SNAPSHOT — not global
  const x = curve.virtualSolReserves   + curve.realSolReserves;
  const y = curve.virtualTokenReserves + curve.realTokenReserves;

  // 1. cap
  const ceiling = curve.graduationTargetLamports + curve.migrationReserveLamports;
  const limit = lamportsUntilTarget(curve.realSolReserves, ceiling, feeBps);
  if (limit === null) throw new LaunchError('AwaitingMigration');    // lib.rs:479
  const cappedIn = maxLamportsIn < limit ? maxLamportsIn : limit;    // lib.rs:474
  if (cappedIn === 0n) throw new LaunchError('ZeroAmount');          // lib.rs:481

  // 2. fee off the top  (curve.rs:125-133)
  if (x === 0n || y === 0n) throw new CurveError('InsufficientLiquidity');
  const feeLamports = feeUp(cappedIn, feeBps);
  const lamportsToCurve = cappedIn - feeLamports;
  if (lamportsToCurve === 0n) throw new CurveError('ZeroAmount');

  // 3. constant product, rounded DOWN  (curve.rs:139-145)
  //    out = (y * dx) / (x + dx)   — algebraically k/(x+dx) subtracted from y,
  //    written this way to keep intermediates small.
  const tokensOut = (y * lamportsToCurve) / (x + lamportsToCurve);

  if (tokensOut === 0n) throw new CurveError('ZeroAmount');          // curve.rs:148-150
  if (tokensOut >= y) throw new CurveError('InsufficientLiquidity'); // curve.rs:152-154 (vs EFFECTIVE)
  if (tokensOut > curve.realTokenReserves)                          // lib.rs:492-495 (vs REAL)
    throw new LaunchError('InsufficientLiquidity');

  return { cappedIn, feeLamports, lamportsToCurve, tokensOut };
}
```

Two distinct reserve checks, against two different quantities — `curve.rs:152` compares
against **effective** tokens, `lib.rs:492` against **real** tokens. Keep both.

**What the wallet is actually debited: `cappedIn`** (= `lamportsToCurve + feeLamports`),
paid as two system transfers (lib.rs:499-520). Show that number, plus network fees and
rent for the ATA if you are creating one.

`min_tokens_out` is the slippage floor, checked at lib.rs:491 → `SlippageExceeded`.
Derive it from `tokensOut` and a user-visible tolerance. It must never be sent as `0`
from a user surface — the tests do that only because they are tests
(`tests/tegridy-launch-migration.test.ts:228`).

### 5.5 Sell quote — `quote_sell`, curve.rs:164-204, plus `sell`'s checks

```ts
function quoteSell(curve: BondingCurve, tokensIn: bigint) {
  if (tokensIn === 0n) throw new CurveError('ZeroAmount');           // lib.rs:568
  const feeBps = curve.tradeFeeBps;
  const x = curve.virtualSolReserves   + curve.realSolReserves;
  const y = curve.virtualTokenReserves + curve.realTokenReserves;
  if (x === 0n || y === 0n) throw new CurveError('InsufficientLiquidity');

  // mirror of the buy branch, rounded DOWN  (curve.rs:181-184)
  const gross = (x * tokensIn) / (y + tokensIn);

  if (gross === 0n) throw new CurveError('ZeroAmount');              // curve.rs:187-189
  if (gross >= x)   throw new CurveError('InsufficientLiquidity');   // curve.rs:190-192

  const feeLamports  = feeUp(gross, feeBps);                         // curve.rs:194
  const lamportsOut  = gross - feeLamports;

  // the curve may only ever pay out REAL lamports — the virtual leg is
  // pricing fiction and is never redeemable.  (lib.rs:582-587)
  if (gross > curve.realSolReserves) throw new LaunchError('InsufficientLiquidity');

  return { gross, feeLamports, lamportsOut };
}
```

Additionally the program refuses a sell that would drop the curve PDA below rent
exemption (lib.rs:605-614 → `InsufficientRentExemptBalance`):

```
curveAccountLamports - gross >= getMinimumBalanceForRentExemption(162)
```

That reads the **account balance**, not `real_sol_reserves` (§3.3). A UI computing a
"max sell" must include it.

The seller receives `lamportsOut`. The fee goes to `global.fee_recipient`.

### 5.6 Derived numbers a UI will want, and how to get them honestly

| number | how | rounding |
| --- | --- | --- |
| spot price (lamports per base unit) | `effective_sol / effective_tokens` | this is a *display* ratio, not a trade — compute at full precision and label it "spot", since any real trade moves it |
| progress to graduation | `real_sol_reserves / (graduation_target + migration_reserve)` | that denominator is what `buy` actually caps against (lib.rs:466-469). Using `graduation_target` alone will show 100% while buys still succeed |
| SOL still needed | `lamportsUntilTarget(...)` from §5.3 | already fee-grossed-up — it is what a buyer must *send*, not what lands |
| tokens sold so far | `token_total_supply - real_token_reserves` | `token_total_supply` is on `global`, not on the curve |
| max reachable raise | `curve.rs:266-281` — `floor(virtual_sol × supply / virtual_token)` | **exclusive** upper bound (curve.rs:253-255); the true ceiling is strictly below |

Do not compute a market cap, an FDV, a USD figure, a holder count, or a 24h volume from
program state. None of them are in it. See §7.

---

## 6. Errors — `errors.rs:5-48`

Anchor numbers `#[error_code]` variants from **6000** in declaration order.

| code | name | what the UI should say |
| --- | --- | --- |
| 6000 | `Overflow` | unexpected — surface as an error, not a user mistake |
| 6001 | `InsufficientLiquidity` | the curve cannot fill this size |
| 6002 | `ZeroAmount` | amount resolves to zero (often: fee ate a dust trade) |
| 6003 | `FeeTooHigh` | config bug, not a user action |
| 6004 | `Paused` | **buys are paused; selling is still open** |
| 6005 | `AlreadyComplete` | graduated — trade on the pool instead |
| 6006 | `NotReadyToGraduate` | target not reached yet |
| 6007 | `SlippageExceeded` | price moved past your tolerance — retry |
| 6008 | `Unauthorized` | wrong signer / wrong fee recipient account |
| 6009 | `InvalidParameter` | |
| 6010 | `InsufficientRentExemptBalance` | sell too large for the curve's rent floor |
| 6011 | `MintHasFreezeAuthority` | **create-launch: mint must have no freeze authority** |
| 6012 | `NotDeployAuthority` | operator-only |
| 6013 | `GraduationTargetUnreachable` | operator config |
| 6014 | `GraduationPriceGap` | operator config |
| 6015 | `AmmNotConfigured` | graduation venue not set yet — not a launch problem |
| 6016 | `AmmMismatch` | wrong cp-swap/AmmConfig accounts passed |
| 6017 | `MigrationReserveTooLow` | curve cannot yet afford migration — **retryable** |
| 6018 | `LpNotBurned` | migration aborted rather than leave a false "locked" claim |
| 6019 | `AwaitingMigration` | **fully funded, NOT graduated** |

**6019 and 6005 must never render the same.** An earlier program version returned
`AlreadyComplete` for the fully-funded case, which told callers a curve had moved to an
AMM pool when it had not (lib.rs:476-479). That distinction is the whole reason 6019
exists.

**6004 must not grey out the sell button.** Sells are unpausable (lib.rs:563-564).

---

## 7. Graduation, and how to render each phase

### 7.1 The phase predicates — exact, in this order

Evaluate top to bottom; first match wins.

| # | predicate | phase | render |
| --- | --- | --- | --- |
| 0 | `getAccountInfo(PROGRAM_ID) === null` | **not deployed** | say so plainly. Stop here. |
| 0b | any read threw / timed out | **unreadable** | say the read failed. **Never fall through to a later row.** |
| 1 | `global` account missing | **protocol not initialized** | not an error about this launch |
| 2 | `curve` account missing | **pre-launch** | this mint has no curve. Not "0 SOL raised" |
| 3 | `curve.complete === true` | **graduated** | link `curve.pool`; trading happens on the pool now |
| 4 | `real_sol_reserves >= target + reserve` | **awaiting migration** | fully funded. Buys revert (6019); **sells still work**; anyone may call `migrate_to_amm` |
| 5 | `real_sol_reserves >= target` | **at target** | target met, still raising the migration reserve. Buys AND sells both work |
| 6 | otherwise | **trading** | bonding; show progress against `target + reserve` |

Overlay, applies to rows 4-6: `global.paused === true` → **buys halted, sells open**
(lib.rs:453 vs the deliberate omission at lib.rs:563-564). Migration is also blocked
(lib.rs:695).

Row 5 vs row 4 matters: at row 5 `migrate_to_amm` passes its `NotReadyToGraduate` check
(lib.rs:715-718) but will almost certainly fail the lamport-budget check
(lib.rs:737-743, `MigrationReserveTooLow`). Do not offer a migrate button at row 5.

### 7.2 What "graduated" actually guarantees

Set only by `migrate_to_amm`, in the same instruction that moves the liquidity
(lib.rs:678-684). At that point, atomically:

- `complete = true`, `pool` = the cp-swap pool address (lib.rs:1179-1180)
- `real_token_reserves = 0`; `real_sol_reserves -= (target + reserve)` — everything that
  left, not just the deposit (lib.rs:1167-1178; subtracting only the deposit made a
  migrated curve report a balance it did not hold)
- the pool has been created and seeded with `graduation_target_lamports` of WSOL against
  every unsold token
- **the LP has been burned to zero**, asserted (lib.rs:1069-1073)
- `payer` has been reimbursed: all three token accounts closed and the authority swept
  (lib.rs:1075-1162)

The "liquidity permanently locked" claim is **verifiable**: `getTokenSupply(lp_mint)`
must be `0`. Link that read. If it fails, say it could not be verified — do not print
the claim from the `complete` flag alone.

### 7.3 Price continuity at listing

The curve prices on `virtual + real`; the pool is seeded with **real reserves only**. Those
agree at exactly one target, and `initialize_global`/`update_global` reject any config
whose ratio falls outside `10_000 ± 500` bps (curve.rs:39-49, lib.rs:156-169).

So a UI **may** honestly say a graduating launch lists within ±5% of its final curve
price — and only that. Do not promise "no price change". The exact ratio for a live
config is `graduation_price_ratio_bps` (curve.rs:322-366) and is computable client-side
from `global` alone; the ideal target is `continuity_target` (curve.rs:376-404).

This is not decoration: this repo's original parameters (30 virtual SOL, 2 SOL target)
opened the pool at **13.95%** of the curve's final price — a ~7x drop at listing with
nothing stolen (MIGRATE_DESIGN.md:267-280, pinned as a test at curve.rs:683-687).

---

## 8. Events — `state.rs:185-214`

Emitted with `emit!` (not `emit_cpi!`), so they land in the transaction logs as
`Program data: <base64>` lines, readable from `simulateTransaction` /
`getTransaction`. Payload = 8-byte event discriminator (§2.0) followed by borsh fields.

⚠️ Logs are **truncated** by the runtime under load, and log-scraping is not a reliable
index. Treat events as a nice-to-have; **account reads are the source of truth.**

### `LaunchCreated` — state.rs:185-192
`mint: Pubkey`, `creator: Pubkey`, `virtual_sol_reserves: u64`,
`virtual_token_reserves: u64`, `token_total_supply: u64`.

### `Traded` — state.rs:194-205
`mint: Pubkey`, `trader: Pubkey`, `is_buy: bool`, `sol_amount: u64`,
`token_amount: u64`, `fee_lamports: u64`, `real_sol_reserves: u64`,
`real_token_reserves: u64`.

`sol_amount` is **net of fee in both directions** — `lamports_to_curve` on a buy
(lib.rs:552), `lamports_out` on a sell (lib.rs:655). A "volume" figure built from it
understates the gross by the fee. Say which one you are showing.

### `Graduated` — state.rs:207-214
`mint: Pubkey`, `sol_reserves: u64` (lamports deposited into the pool =
`graduation_target_lamports`), `token_reserves: u64` (tokens deposited).

---

## 9. What is NOT knowable client-side — render as unknown

Each row is a thing a builder will be tempted to invent. Do not. The required rendering
is a stated unknown, not a zero and not a placeholder value.

| # | not knowable | why | render |
| --- | --- | --- | --- |
| 1 | **whether the program is live** before an RPC read | placeholder program id, no deploy (§0.1) | "not deployed" — checked, not assumed |
| 2 | **token name / symbol / image** | the program never creates Metaplex metadata; `create_launch` takes an existing `Mint` and nothing else (lib.rs:1290) | read the Metaplex metadata PDA separately; if absent, **"unnamed token"** — never fabricate from the mint |
| 3 | **decimals** | not stored on the curve; not constrained by the program | read the mint account. If unread, show raw base units and say so. **Never assume 9** |
| 4 | **any USD figure** — price, mcap, FDV, TVL | no oracle anywhere in the program | omit, or label the off-chain source and its timestamp |
| 5 | **holder count / distribution** | `getProgramAccounts` is blocked by the proxy allowlist (`frontend/api/solrpc.js:34-48`) | `getTokenLargestAccounts` gives the **top 20 only**. Show "top 20 holders", never a total |
| 6 | **the list of all launches** | same — no enumeration path exists | "known launches" from a curated list, explicitly labelled. Needs a server route to fix |
| 7 | **volume / trade history / a price chart** | no indexer; log scraping over `getSignaturesForAddress` is paginated, rate-limited and truncatable | show what you actually fetched with its window, or show nothing. **Never render a partial scan as a total** |
| 8 | **cp-swap's `create_pool_fee`** | lives in the mutable `AmmConfig` account, not in our program (state.rs:37-42) | unknown unless `global.amm_config` is set and that account is read |
| 9 | **whether migration will succeed right now** | the budget check reads live PDA lamports and a 1-lamport sell can flip it (MIGRATE_DESIGN.md:294-304) | "eligible now" is a *momentary* claim. Present failure as retryable |
| 10 | **`buy`/`sell` compute cost** | never measured (§1.4) | do not state a number |
| 11 | **quote freshness** | a quote is computed from an account snapshot and is stale on arrival | always send a real `min_tokens_out` / `min_lamports_out`; disclose the tolerance |
| 12 | **anything about the creator** beyond `curve.creator` | the program stores one pubkey | show the pubkey. No reputation, no history, no badge |
| 13 | **pool reserves via Anchor decode** | `PoolState` is `zero_copy(unsafe)` + `repr(C, packed)` — borsh cannot read it (§3.4) | read the vault token balances, or decode by offset |
| 14 | **`global` values as a launch's terms** | every launch snapshots its own (§3.2) | quote from `curve.*`. `global.*` describes only *future* launches |

---

## 10. Checklist for the four builders

- [ ] `getAccountInfo(PROGRAM_ID)` first; `null` → "not deployed", stop.
- [ ] Every read returns an explicit `unreadable` variant. No `?? 0`, no `catch { return
      0 }`, no default-to-clean-badge.
- [ ] All PDAs derived client-side (§4). `seeds = false` means no auto-resolution.
- [ ] `pool_state` = `["launchpool", mint]` on **tegridy-launch**, never cp-swap's
      canonical derivation.
- [ ] Quotes use `curve.trade_fee_bps`, never `global.trade_fee_bps`.
- [ ] Quotes use `BigInt`, and round exactly as §5 says: tokens down, lamports down,
      fees up.
- [ ] Buy UI shows the **capped** debit, not `max_lamports_in`.
- [ ] Progress bar denominator is `target + reserve`, not `target`.
- [ ] Paused does **not** disable sell.
- [ ] `AwaitingMigration` (6019) renders differently from `AlreadyComplete` (6005).
- [ ] `migrate_to_amm` prepends `setComputeUnitLimit(400_000)`.
- [ ] Token-2022 mints rejected at create; `freezeAuthority` set to `null`.
- [ ] No fabricated price, volume, holders, mcap, or USD figure anywhere.
- [ ] Responsive on desktop, iPhone 14+, iPad; additive only — nothing existing removed
      or restyled.
