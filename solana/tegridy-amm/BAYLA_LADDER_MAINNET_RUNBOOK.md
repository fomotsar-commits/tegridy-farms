# bayla-ladder — MAINNET runbook

**Status: NOT YET EXECUTED.** Written 2026-09-11. This is the mainnet half that
`BAYLA_LADDER_DEVNET_RUNBOOK.md` deliberately left unwritten. Every command below was
checked against the tool it calls (Solana CLI 4.1.1 on the operator box, the ops CLI
on trunk), and every figure says where it came from.

The steps are numbered because the order is load-bearing: two pool parameters are
permanent, the 75% early-exit penalty is a compile-time constant with no setter, and the
program's deployer is compiled into the binary.

> ⚠️ **2026-09-17 — the program is being rebuilt, and this runbook was updated for it.**
> The ladder's early-exit penalty is **75% forfeited** (the leaver keeps 25%; the EVM
> `LighthouseLadder.sol` stays 25%), and `notify_reward` refuses a mid-window reload that
> would lower the rate (§8). The deployer is **rotated** (key rotation option A), the pool
> authority is **a multisig before any funds** (§1), and the Streamflow pool is a
> **separate product** with no migration (§12). The mainnet artifact `fada8148…` from CI
> run 34712334698 is **SUPERSEDED — do not deploy it**: it carries the 25% penalty, no rate
> guard, and the hot faucet key as its deployer. Decisions and gates:
> `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md`.

---

## 0. Preconditions — all of them, before anything costs SOL

- [ ] **The external audit report is in and every fix is merged.** Deploy the exact
      commit the auditor signed off on. Tag it (§4) and write the hash here: `________`
      **The audited commit must contain the 75% penalty constant and the `notify_reward`
      rate guard.** A sign-off on code from before that change, or on the superseded
      `fada8148…` build, does not satisfy this box.
- [x] **`withdraw_matured` has executed on devnet.** Done **2026-09-17**, finalized, tx
      `4AYtGTnHvSV3bCuaq4nhQPSLnvbc6pnJJfaNY7SqC2FeR2QYQK3ukdwJbAzFjEXNynWYxpBHP9pgRkPYSyAZWeAf`:
      500 back, penalty 0, `penalty_collected_cumulative` unchanged, accounting reconciled
      to the raw unit — measured on the superseded 25% build. The matured door passes a
      zero penalty whatever the rate (`withdraw_matured` calls
      `exit_with_penalty(ctx, now, 0)`), so that result carries over; nothing has been
      measured at 75%. Evidence and the working command (the one recorded before
      omitted `--program`) are in `docs/TODO_OPERATOR.md` O-0909-1.
- [ ] **Both keyfiles are backed up offline** — the program keyfile and the deployer's.
      Not to OneDrive or any cloud folder in plaintext.
- [x] **The upgrade authority is decided** (§3), 2026-09-12: the venue's **existing Squads v4
      vault** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. Nothing to create.
- [x] **The pool parameters are decided** (§6), 2026-09-12: **100 / 2,000,000 / 5,000,000**.
      Two of the three can never be changed.
- [x] **The early-exit penalty is decided**, 2026-09-17: **75%** forfeited
      (`EARLY_EXIT_PENALTY_BPS = 7_500`; 25% of principal returned). `emergency_withdraw`
      charges the same while locked; both early doors charge 0 once the pool is
      `degraded`. Compile-time, no setter (§6).
- [x] **The deployer is decided**, 2026-09-17: **rotate** (option A). A fresh key,
      generated outside any cloud-synced folder, replaces `GCCSLE7d…` (§1). Its pubkey
      goes into §1 before the §4 build.
- [ ] **The pool authority is a multisig before any funds** (decided 2026-09-17): the
      handover in §8 completes before the first `notify`.
- [ ] **A keyed mainnet RPC URL.** The public endpoint throttles hard, and a program upload
      is several hundred write transactions. Never paste the URL into the repo.
- [ ] **~3 SOL in the deployer wallet** — the rotated deployer, not `GCCSLE7d…` (§5 for
      the breakdown).

---

## 1. Identities

| what | value | notes |
| --- | --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | Generated 2026-09-11. The keyfile lives outside the repo, and is only needed until the program is deployed. |
| deployer | ~~`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`~~ → **a rotated key, pubkey not yet recorded** | **SUPERSEDED 2026-09-17 (key rotation option A).** `GCCSLE7d…` was confirmed 2026-09-12 as the owner's existing BAYLA admin wallet; it is also the devnet faucet bot's hot key in a cloud-synced folder (`docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md` §1). The rebuild compiles a fresh key generated outside any cloud-synced folder — write its pubkey here before §4, and never build with `GCCSLE7d…`. Compiled in: the only key that can call `initialize_pool`, and it becomes the pool's first authority. |
| BAYLA mint | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` | Token-2022, 6 decimals |
| upgrade authority | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | The venue's existing Squads v4 **vault**: index 0 of multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`, threshold 2. A PDA with no private key, so the transfer needs `--skip-new-upgrade-authority-signer-check`. |

**Why a plain wallet is acceptable as the POOL authority, and not as the UPGRADE
authority.** The pool authority's instructions were read account by account:
`notify_reward` only moves tokens *from the authority's own wallet into* the reward vault;
`propose_authority`, `propose_cap_raise`, `cancel_cap_raise` and `declare_degraded` change
pool fields and name no vault at all; `execute_cap_raise` and `sweep_orphaned_penalty`
need no signer. **No pool-authority signature can move a token out of either vault.** The
upgrade authority can replace the program itself, and so everything in it.

**DECIDED 2026-09-17: the pool authority is nonetheless a multisig before any funds.** The
argument above bounds what a stolen authority key can TAKE, not what it can DO. It can
`declare_degraded` — one-way: it closes the pool to new stakes and waives the 75% penalty
on both early doors, including on any locked position the thief holds. And once a window
has ended, the rate guard (§8) no longer applies, so it can restart rewards at a tiny rate.
So: create the pool with the deployer (§7), hand the authority to the multisig with
`propose-authority` / `accept-authority` (§11), and only then fund (§8).

⚠️ **The ops CLI signs from a keyfile only** (`--keypair <path-to-id.json>`). If the
deployer is a hardware wallet, `init-pool` cannot be signed with this tool — choose a
deployer you hold as a keyfile, or build a different signing path first. **The same limit
applies to every authority command once the authority is a multisig:** `notify` refuses
unless the keyfile IS the pool authority (`bayla-ladder-ops.mjs:820-822`), so after the
handover each reload (§8) has to be built and signed inside the multisig's own app. Settle
that path before the handover, not at the first reload.

---

## 2. Re-check the mint on the day

The mint's authorities can change until the pool exists, and the program refuses a mint
with a mint authority, a freeze authority, or any extension other than `metadataPointer`
and `tokenMetadata` (`token.rs:117-136`).

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump",{"encoding":"jsonParsed"}]}'
$info = (Invoke-RestMethod -Uri https://api.mainnet-beta.solana.com -Method Post -ContentType 'application/json' -Body $body).result.value.data.parsed.info
$info | Select-Object mintAuthority, freezeAuthority, decimals; $info.extensions.extension
```

Both authorities must be empty, decimals `6`, and the extensions exactly
`metadataPointer` and `tokenMetadata`. **Measured 2026-09-11: all four hold.** The
`init-pool` dry run in §7 re-checks this against the program itself.

---

## 3. Upgrade authority — DECIDED: the venue's existing Squads vault

**Chosen 2026-09-12, and it already exists — there is nothing to create.** Deploy with
the deployer as the upgrade authority, verify the bytes on chain (§5), then transfer.

| | address | |
| --- | --- | --- |
| multisig | `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` | Squads v4 config account. **Never the upgrade authority.** |
| vault, index 0 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | **This is the upgrade authority.** |

Verified on mainnet 2026-09-12 rather than copied from a note:

- the multisig is owned by the Squads v4 program
  `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, carries the `Multisig` Anchor
  discriminator, and reads **threshold 2** at offset 72;
- the vault exists, System-owned with zero data — the shape of a vault PDA; and
- re-deriving `["multisig", <multisig>, "vault", 0]` under the Squads program reproduces
  the vault address exactly, while indexes 1 and 2 give entirely different addresses.
  `squadsRegistry.test.ts` pins that derivation so the two registry entries cannot drift.

⚠️ **Use the VAULT, never the multisig account.** `addresses.json` records what happened
the last time the two were confused: the cp-swap binary baked the *multisig* account as
its admin — an account that can neither sign (v4 signs CPIs as the vault) nor be
debited — and that is what bricked graduation. They look equally like *the Squads
address* in a command; only the derivation tells them apart.

**Still to confirm in the Squads app before the transfer:** the **member set** (who can
actually sign) and the **time lock**, which is what stops a stolen signer pushing an
upgrade instantly. Threshold 2 is confirmed on chain; those two are not readable from
the registry.

**Immutable (`--final`) was the alternative, and was not taken.** It is the stronger
promise to stakers, but the program is new: an audit follow-up would otherwise need a
new program id, a new pool, and a migration of every staker.

**Not acceptable:** leaving the upgrade authority on a single hot wallet.

---

## 4. Build — in CI, from the audited commit

`workflow_dispatch` takes a branch or tag, not a bare commit, so tag the audited commit
first. The tag is also the permanent record of what was deployed.

```powershell
git tag bayla-ladder-mainnet <AUDITED-COMMIT>
git push origin bayla-ladder-mainnet
gh workflow run solana-deploy-artifact.yml --ref bayla-ladder-mainnet -f program=bayla-ladder -f cluster=mainnet -f program_id=EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ -f deployer=<ROTATED-DEPLOYER-PUBKEY>
```

⚠️ **`deployer` is the rotated key from §1, never `GCCSLE7d…`** (key rotation option A,
2026-09-17). The artifact from CI run 34712334698 (`.so` sha256 `fada8148…`) was built
with `GCCSLE7d…`, the 25% penalty and no rate guard: it is **SUPERSEDED** and must not be
deployed. This command, run on the audited commit, is the rebuild that replaces it.

When it finishes:

```powershell
gh run list --workflow solana-deploy-artifact.yml --limit 1
gh run download <RUN-ID>
```

That gives `deploy\bayla_ladder.so` and `idl\bayla_ladder.json`. The run's summary page
prints the `.so`'s **sha256**, the exact rent for this build, and the deploy command.
Write the sha256 down — §5 checks the deployed bytes against it. The job refuses up front
if `deployer` equals the program id (audit L-5). **GitHub deletes the artifact after 30
days,** so keep the `.so` and its hash.

---

## 5. Deploy the program

```powershell
solana config set --url <MAINNET-RPC-URL> --keypair <deployer-keyfile>
solana --version
solana balance
solana program deploy deploy\bayla_ladder.so --program-id <program-keyfile> --upgrade-authority <deployer-keyfile> --with-compute-unit-price <MICRO-LAMPORTS> --max-sign-attempts 50
```

**Cost.** CLI 4.1.1's own `--help` says `--max-len` defaults to *"the length of the
original deployed program"* (1×), and that upgrades **auto-extend** unless
`--no-auto-extend` is passed. So a plain deploy rents exactly the binary and stays
upgradeable. The devnet build was 512,504 bytes → **2.60 SOL** (`solana rent 512504`);
the CI summary gives the figure for this build. Add transaction fees and ~0.01 SOL for the
pool accounts: budget **3 SOL**. `solana --version` must be 4.1.1 or newer; older CLIs
default to 2× and cost about 5.2 SOL.

**Priority fee.** Set `--with-compute-unit-price` from a current reading on the day.
Measured 2026-09-11, the fee paid by recent transactions touching BAYLA and the lighthouse
pool was **zero in all 150 slots sampled**. That is BAYLA-local, though, and an upload
competes network-wide, so a modest non-zero value is reasonable.

**If it stops partway**, the SOL is sitting in a buffer account, not lost:

```powershell
solana program show --buffers
solana program close --buffers
```

Then run the deploy again.

**Verify it before anything else touches it.**

```powershell
solana program show EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ
solana program dump EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ onchain.so
Get-FileHash onchain.so -Algorithm SHA256
Get-FileHash deploy\bayla_ladder.so -Algorithm SHA256
```

The two hashes must match: that is the proof that the audited bytes are what is live.
`program show` must name the deployer as the authority, until the next step.

**Then hand over the upgrade authority** — option A:

```powershell
solana program set-upgrade-authority EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --new-upgrade-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd --skip-new-upgrade-authority-signer-check
solana program show EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ
```

The skip flag is needed because a vault is a PDA and cannot co-sign. The second command
must now show the vault as the authority. For option B instead:
`solana program set-upgrade-authority EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --final`.

---

## 6. Pool parameters — TWO OF THE THREE ARE PERMANENT

`min_stake` and `max_wallet_principal` are written once, in `initialize_pool`
(`lib.rs:381-383`), and **no instruction ever changes them**. Only `deposit_cap` moves:
upward only, 48 hours after it is proposed.

| parameter | what the program enforces | changeable later? | **decided 2026-09-12** |
| --- | --- | --- | --- |
| `min_stake` | at least **100 whole tokens** | **no** | **100 BAYLA** |
| `max_wallet_principal` | between `min_stake` and the **initial** `deposit_cap` | **no** — later cap raises do not lift it | **2,000,000 BAYLA** |
| `deposit_cap` | at least `min_stake` | up only, 48h after `propose-cap-raise` | **5,000,000 BAYLA** |

**Not a pool parameter, and just as fixed: the early-exit penalty.**
`EARLY_EXIT_PENALTY_BPS = 7_500` — 75% of principal forfeited, 25% returned — is compiled
into the binary (`math.rs`), charged identically by `early_exit` and by
`emergency_withdraw` while locked (0 in a `degraded` pool), stored in no account, and has
no setter. Only a program upgrade through the Squads vault (§3) could change it, and
because no account stores it, an upgrade would change it for every position already open.
The forfeited share is not paid to anyone on the way out: it goes to the reward pool, is
scheduled into a later window by the operator (§8), and is then shared by weight among
whoever is staked then.

**Also disclosed, not changed (decided 2026-09-17): a matured position keeps its full
boost indefinitely.** Weight is `amount × boost`, frozen at stake time
(`state.rs:132-133`) and written only by `stake` (`lib.rs:479`), and there is no forced
maturity, decay or kick (`state.rs:51-52`), so a 4-year position that has matured and
never withdraws keeps earning at 4.00x. A future upgrade MAY reset matured weight to the
0.40x floor; nothing does today.

Sizing reference, measured on mainnet 2026-09-12 by reading **every** stake entry in the
**separate** Streamflow lighthouse pool: **18 open positions across 9 wallets,
3,235,286 BAYLA.** Nothing moves from that pool to this one (§12); it is the best measure
of demand available.

| wallet | positions | total BAYLA |
| --- | --- | --- |
| `6JMP6s..Wgkc` | 6 | 1,004,000 |
| `Upmhw8..CdEd` | 2 | 1,003,000 |
| `2rg2q9..HM85` | 1 | 535,000 |
| `GFzq6H..UQwZ` | 1 | 369,369 |
| `FdS6on..XR2o` | 1 | 171,330 |
| `C16P97..LduK` | 2 | 79,587 |
| `3ptKrP..vqeH` | 3 | 60,000 |
| `GdAYNN..oR2r` | 1 | 10,000 |
| `6VHowW..u2tY` | 1 | 3,000 |

What the three numbers rest on:

- ⚠️ **The per-wallet limit is on a wallet's TOTAL, and the largest wallet holds
  1,004,000 across six positions** — not the 1,000,000 single position an older snapshot
  showed. Anything at or below ~1.0M would cap a holder of that size below what they
  already stake elsewhere, with no setter to undo it. 2,000,000 fits them with room to
  add, and caps any one wallet at 40% of the opening pool, falling to 20% if the cap is
  later doubled.
- **`deposit_cap` was sized against the Streamflow pool as a demand reference.**
  3,235,286 BAYLA sat in that separate pool on 2026-09-12; 5,000,000 covers a pool of that
  size with ~1.7M of headroom, and rises 48 hours at a time. Nothing migrates.
- **`min_stake` at the program floor** keeps the pool open to the small holders already
  here — the smallest open position is 3,000 BAYLA. It cannot be raised later by design:
  that would lift the I-11 burn threshold above positions already open.
- **If these ever prove wrong**, the escape hatch is a second pool at `--nonce 1` with
  different parameters. The first pool keeps running; nothing is stranded.

---

## 7. Create the pool

Run from the repo's `frontend` folder. **The ops CLI defaults to DEVNET — every mainnet
command needs `--rpc`.** A dry run simulates against the real mint and the real program,
so it is also the final mint check.

```powershell
node scripts\bayla-ladder-ops.mjs init-pool --mint 7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump --nonce 0 --min-stake 100 --deposit-cap 5000000 --max-wallet 2000000 --program EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --rpc <MAINNET-RPC-URL> --keypair <deployer-keyfile>
```

It prints the pool address (a PDA) — **record it**; everything after this needs it. If the
simulation passes, run the same line with `--broadcast`. `initialize_pool` measured 35,031
CU on devnet.

If the simulation fails with **`NotDeployAuthority` (6010)**, the keyfile is not the
deployer compiled into this build: use the right key, or rebuild (§4) and upgrade.

Then confirm:

```powershell
node scripts\bayla-ladder-ops.mjs read --pool <POOL> --program EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --rpc <MAINNET-RPC-URL>
```

---

## 8. Fund the first 90-day period — and every one after it

**Two things happen before the first `notify`, in this order:**

1. **Hand the pool authority to the multisig** (decided 2026-09-17: a multisig before any
   funds). `propose-authority --pool <POOL> --new-authority <MULTISIG>` signed by the
   deployer, then `accept-authority` from inside the multisig's app (§11). Confirm with
   `read` that `authority` is the multisig and no `pending authority` remains.
2. **Turn the card on (§9) and let stakers arrive.** Never fund an empty pool: a second in
   which nothing is staked emits nothing (`math::reward_per_weight_with_residue` returns
   the accumulator unchanged while `total_weighted` is 0, and `checkpoint` still moves the
   clock), so a window funded ahead of its stakers spends its clock on nobody. Those tokens
   stay in the vault, reachable only by a later `from_budget` reload.

```powershell
node scripts\bayla-ladder-ops.mjs notify --pool <POOL> --amount <WHOLE-BAYLA> --program EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --rpc <MAINNET-RPC-URL> --keypair <authority-keyfile>
```

(After the handover the authority is the multisig. The line above shows the instruction's
arguments, but the CLI refuses it — dry run included — unless `--keypair` IS the pool
authority (§1), so the transaction is built and signed in the multisig's app.)

- The rate is the amount divided by **7,776,000 seconds** (90 days). Below
  **7.776 BAYLA** the rate rounds to zero, and the program refuses (`RewardRateTooSmall`).
- The tokens come from the authority's own BAYLA account.
- The card shows an empty reward vault as a labelled real zero, so the card can go live
  before the first window is funded.
- **Keep the first window small.** Every token loaded is one-way (no instruction returns
  BAYLA to the authority), and the rate guard below means a rate set too high cannot be
  lowered until that window's `period_finish` — up to 90 days. The only way down is to
  let a window reach `period_finish` and reload at the lower rate right then.
- **The rate guard.** While `now < period_finish`, `notify_reward` refuses with
  **6028 `RewardRateWouldDecrease`** any reload whose folded rate
  `(scheduled + (period_finish − now) × reward_rate) / 7,776,000` is below the current
  `reward_rate` (`math::rate_change_allowed`). In operator terms: **a mid-window reload
  must schedule at least `reward_rate × seconds elapsed since the last notify`**, i.e.
  `reward_rate × (now − (period_finish − 7,776,000))`, where `scheduled` is `--amount`
  plus `--from-budget`. Exactly that holds the rate; more raises it. **At or after
  `period_finish` any rate is allowed.** The ops CLI's `notify` does not pre-check this,
  and the rate it prints ignores the fold-in (`bayla-ladder-ops.mjs:807-830`). With a
  multisig authority the CLI cannot simulate the reload at all, so compute the minimum by
  hand from `read`'s `reward rate` (raw units per second) and `period finish` before the
  multisig signs.

### Reload policy — funding never stops

The ladder's reward funding **never stops**: no sunset, no wind-down, no lapse. This is
operator policy; the program does not enforce it.

- **Reload every ~60–75 days, BEFORE `period_finish`,** with an amount that holds the rate
  — at least `reward_rate × seconds elapsed since the last notify` (at day 60 that is two
  thirds of `reward_rate × 7,776,000`; at day 75, five sixths). Each reload starts a
  fresh 90 days, so the pool never reaches `period_finish` and never lapses to a zero rate.
  Reloading at day 60–75 rather than day 89 leaves room for a multisig signing round.
- **Recycle penalties at the regular reload**, as `--from-budget` beside the fresh
  `--amount`. A penalty-only reload inside a window is refused unless the penalty alone
  covers `reward_rate × elapsed`, so do not plan on one. An `emergency_withdraw`
  penalty sits in the stake vault as `orphaned_penalty` until the permissionless `sweep`
  moves it to the reward vault; sweep before scheduling it.
- **Keep the undeployed reward runway in the multisig, not the vault.** Anything in the
  reward vault is committed forever; tokens in the multisig can still be re-planned.
- **Publish dates, never rates or APRs.** Say when the next reload is due. The per-staker
  yield of a fixed pool-wide budget moves with every stake and exit, so a quoted rate or
  APR is wrong the moment TVL moves.
- ⚠️ **Before any LATER top-up, do not read solvency off `read`'s "outstanding owed".**
  `rewards_emitted` is banked only when an instruction runs `checkpoint()`, so on a quiet
  pool that line omits every second of emission since the last interaction. Measured on
  devnet 2026-09-17: it showed **0.019 BAYLA** owed against a true **~4,275 BAYLA**. The
  program itself is safe — `notify_reward` checkpoints before its solvency checks — but an
  operator sizing a top-up from that number would be off by the whole accrual. Compute
  `rewards_emitted + reward_rate × (min(now, period_finish) − last_update_time) −
  rewards_paid` instead. (Right after `init-pool` in §7 nothing has emitted yet, so the
  `read` there is accurate.)

---

## 9. Turn the card on

In Vercel → Settings → Environment Variables, for **Production**:

| name | value |
| --- | --- |
| `VITE_BAYLA_LADDER_PROGRAM` | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| `VITE_BAYLA_LADDER_POOL` | the pool address from §7 |

`VITE_` values are baked in at build time, so **redeploy** afterwards. To try it first,
set the two on **Preview** only and test on a preview URL; production stays unchanged.

⚠️ **The build must carry the 75% penalty.** The card quotes every early exit from its own
constant, `frontend/src/lib/ladder/program.ts:76` (`2_500` on trunk), because nothing on
chain exposes the rate. It ships at `7_500` in lockstep with this deploy. And a Preview
pointed at the devnet program must wait until devnet runs the 75% build — `HzxzfSQ…`
still runs the superseded 25% one.

Check `/farm` in the BAYLA bungalow: both pool cards render, and the ladder card shows the
pool's figures — not *"there is no account at this pool address"*, which means a wrong
value or a missing redeploy.

---

## 10. Register the addresses

Add the program, the pool, both vaults and the deployer to the `solana` array in
`frontend/scripts/addresses.json`, following the existing entries (`id`, `address`,
`role`, `custody`, `expect`). **Never a keyfile path.** If you copy a lighthouse ladder
entry's `role` as a template, change its penalty: the EVM `LighthouseLadder.sol` entries
say 25%, and this program's role string must say **75% early-exit penalty**. Then
`node scripts\verify-addresses.mjs --onchain` must pass — from then on, CI reads these
addresses on mainnet every day.

---

## 11. Running the pool

All of these take `--program`, `--rpc` and `--keypair`, and are dry runs until
`--broadcast`. Each one refuses locally, before any fee, whatever the program would
refuse.

| task | command | who signs |
| --- | --- | --- |
| reload the next 90-day window — every window, ~60–75 days in, never lapse (§8) | `notify --pool <P> --amount <WHOLE-BAYLA> [--from-budget <WHOLE-BAYLA>]` — before `period_finish` the scheduled total must be at least `reward_rate × seconds since the last notify`, or it is refused with 6028 | the authority (built in the multisig's app — §1) |
| move a hatch penalty into the reward vault, before a reload schedules it | `sweep --pool <P>` | anyone |
| propose a higher cap | `propose-cap-raise --pool <P> --cap <WHOLE-BAYLA>` | the authority |
| apply it, 48h later | `execute-cap-raise --pool <P>` | anyone |
| abandon a proposal | `cancel-cap-raise --pool <P>` | the authority |
| hand over pool authority | `propose-authority --pool <P> --new-authority <KEY>`, then `accept-authority --pool <P>` signed by `<KEY>` | both, in turn |
| declare the pool degraded | `declare-degraded --pool <P> --confirm-permanent` | the authority — **one-way** |

A Squads vault cannot sign the CLI's `accept-authority`; that half must be run from inside
Squads. A new proposal replaces a pending one and restarts its 48-hour clock.

---

## 12. The Streamflow lighthouse pool is a separate product — no migration

**DECIDED 2026-09-17.** The Streamflow BAYLA lighthouse pool
(`EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`) and this ladder are **separate products**.
There is no migration and no integration between them.

- The Streamflow pool keeps running and keeps its stakers — **18 open positions across 9
  wallets, 3,235,286 BAYLA** when read on 2026-09-12. Nothing in this runbook moves,
  contacts or re-announces them.
- **The Streamflow pool still needs its own reward funding, through its last lock.**
  Funding the ladder does not fund it, and the ladder's reload policy (§8) does not cover
  it. Its locks cannot be ended early, so its funding obligation runs until the last one
  matures.
- Anyone, including a Streamflow staker, may stake in the ladder on their own.
- The 2026-09-12 reading is used only to size the ladder's parameters (§6).

(This section used to plan moving the Streamflow stakers into the ladder, and warned that
the big position's claims might have crossed a Streamflow "reward ceiling". There is no
migration, and the ceiling does not exist — see the 2026-09-12 correction in
`docs/TODO_OPERATOR.md`.)

---

## 13. What can go wrong, and what fixes it

| failure | effect | fix |
| --- | --- | --- |
| deploy stops partway | SOL held in a buffer account | `solana program close --buffers`, then deploy again |
| wrong deployer compiled in | `init-pool` refused (6010) | rebuild with the right deployer and upgrade — needs the upgrade authority |
| wrong `min_stake` or `max_wallet_principal` | permanent for that pool | create a second pool with `--nonce 1`; the first stays as it is |
| pool authority key lost | no new funding, no cap raises — which breaks the commitment that funding never stops | stakers' exits are unaffected: every exit is theirs alone. This is why the authority is a multisig before any funds (§1) |
| a mid-window reload refused with 6028 `RewardRateWouldDecrease` | the scheduled total is below `reward_rate × seconds since the last notify` | add to `--amount` until it covers that; lowering the rate has to wait for `period_finish` (§8) |
| upgrade authority lost | the program is frozen as it is | the same as immutable |
| a transaction "failed to confirm" | it may still have landed | the CLI says so; run `read` before retrying |
