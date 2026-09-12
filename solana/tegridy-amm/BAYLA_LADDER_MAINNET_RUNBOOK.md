# bayla-ladder — MAINNET runbook

**Status: NOT YET EXECUTED.** Written 2026-09-11. This is the mainnet half that
`BAYLA_LADDER_DEVNET_RUNBOOK.md` deliberately left unwritten. Every command below was
checked against the tool it calls (Solana CLI 4.1.1 on the operator box, the ops CLI
on trunk), and every figure says where it came from.

The steps are numbered because the order is load-bearing: two pool parameters are
permanent, and the program's deployer is compiled into the binary.

---

## 0. Preconditions — all of them, before anything costs SOL

- [ ] **The external audit report is in and every fix is merged.** Deploy the exact
      commit the auditor signed off on. Tag it (§4) and write the hash here: `________`
- [ ] **`withdraw_matured` has executed on devnet.** It is the only principal path never
      run. Position `#2` unlocks **2026-09-16 09:57:21 UTC** (read off chain 2026-09-11);
      the command is in the devnet runbook.
- [ ] **Both keyfiles are backed up offline** — the program keyfile and the deployer's.
      Not to OneDrive or any cloud folder in plaintext.
- [x] **The upgrade authority is decided** (§3), 2026-09-12: the venue's **existing Squads v4
      vault** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. Nothing to create.
- [x] **The pool parameters are decided** (§6), 2026-09-12: **100 / 2,000,000 / 5,000,000**.
      Two of the three can never be changed.
- [ ] **A keyed mainnet RPC URL.** The public endpoint throttles hard, and a program upload
      is several hundred write transactions. Never paste the URL into the repo.
- [ ] **~3 SOL in the deployer wallet** (§5 for the breakdown).

---

## 1. Identities

| what | value | notes |
| --- | --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | Generated 2026-09-11. The keyfile lives outside the repo, and is only needed until the program is deployed. |
| deployer | `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` | **Confirmed 2026-09-12.** The owner's existing BAYLA admin wallet. Compiled in: the only key that can call `initialize_pool`, and it becomes the pool's authority. |
| BAYLA mint | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` | Token-2022, 6 decimals |
| upgrade authority | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | The venue's existing Squads v4 **vault**: index 0 of multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`, threshold 2. A PDA with no private key, so the transfer needs `--skip-new-upgrade-authority-signer-check`. |

**Why a plain wallet is acceptable as the POOL authority, and not as the UPGRADE
authority.** The pool authority's instructions were read account by account:
`notify_reward` only moves tokens *from the authority's own wallet into* the reward vault;
`propose_authority`, `propose_cap_raise`, `cancel_cap_raise` and `declare_degraded` change
pool fields and name no vault at all; `execute_cap_raise` and `sweep_orphaned_penalty`
need no signer. **No pool-authority signature can move a token out of either vault.** The
upgrade authority can replace the program itself, and so everything in it.

⚠️ **The ops CLI signs from a keyfile only** (`--keypair <path-to-id.json>`). If the
deployer is a hardware wallet, `init-pool` cannot be signed with this tool — choose a
deployer you hold as a keyfile, or build a different signing path first.

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
gh workflow run solana-deploy-artifact.yml --ref bayla-ladder-mainnet -f program=bayla-ladder -f cluster=mainnet -f program_id=EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ -f deployer=GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9
```

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

Measured on mainnet 2026-09-12 by reading **every** stake entry in the lighthouse pool:
**18 open positions across 9 wallets, 3,235,286 BAYLA.**

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
  showed. Anything at or below ~1.0M would lock that holder out of migrating in full,
  with no setter to undo it. 2,000,000 fits them with room to add, and caps any one
  wallet at 40% of the opening pool, falling to 20% if the cap is later doubled.
- **`deposit_cap` must hold the migration.** 3,235,286 BAYLA sits in the lighthouse pool
  today; 5,000,000 covers it with ~1.7M of headroom, and rises 48 hours at a time.
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

## 8. Fund the first 90-day period

```powershell
node scripts\bayla-ladder-ops.mjs notify --pool <POOL> --amount <WHOLE-BAYLA> --program EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --rpc <MAINNET-RPC-URL> --keypair <deployer-keyfile>
```

- The rate is the amount divided by **7,776,000 seconds** (90 days). Below
  **7.776 BAYLA** the rate rounds to zero, and the program refuses (`RewardRateTooSmall`).
- The tokens come from the authority's own BAYLA account.
- Funding may come last: the card shows an empty reward vault as a labelled real zero.

---

## 9. Turn the card on

In Vercel → Settings → Environment Variables, for **Production**:

| name | value |
| --- | --- |
| `VITE_BAYLA_LADDER_PROGRAM` | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| `VITE_BAYLA_LADDER_POOL` | the pool address from §7 |

`VITE_` values are baked in at build time, so **redeploy** afterwards. To try it first,
set the two on **Preview** only and test on a preview URL; production stays unchanged.

Check `/farm` in the BAYLA bungalow: both pool cards render, and the ladder card shows the
pool's figures — not *"there is no account at this pool address"*, which means a wrong
value or a missing redeploy.

---

## 10. Register the addresses

Add the program, the pool, both vaults and the deployer to the `solana` array in
`frontend/scripts/addresses.json`, following the existing entries (`id`, `address`,
`role`, `custody`, `expect`). **Never a keyfile path.** Then
`node scripts\verify-addresses.mjs --onchain` must pass — from then on, CI reads these
addresses on mainnet every day.

---

## 11. Running the pool

All of these take `--program`, `--rpc` and `--keypair`, and are dry runs until
`--broadcast`. Each one refuses locally, before any fee, whatever the program would
refuse.

| task | command | who signs |
| --- | --- | --- |
| propose a higher cap | `propose-cap-raise --pool <P> --cap <WHOLE-BAYLA>` | the authority |
| apply it, 48h later | `execute-cap-raise --pool <P>` | anyone |
| abandon a proposal | `cancel-cap-raise --pool <P>` | the authority |
| hand over pool authority | `propose-authority --pool <P> --new-authority <KEY>`, then `accept-authority --pool <P>` signed by `<KEY>` | both, in turn |
| declare the pool degraded | `declare-degraded --pool <P> --confirm-permanent` | the authority — **one-way** |

A Squads vault cannot sign the CLI's `accept-authority`; that half must be run from inside
Squads. A new proposal replaces a pending one and restarts its 48-hour clock.

---

## 12. Moving the lighthouse stakers — after the audit

- **18 open positions across 9 wallets, 3,235,286 BAYLA** (read 2026-09-12). An older
  snapshot said 8 entries; more stakers have arrived since, so re-read the pool before
  announcing anything to anyone.
- A Streamflow position cannot leave before its lock ends, so each staker moves when
  their own lock opens. Nobody's tokens are moved for them.
- The largest wallet holds 1,004,000 across six positions, and `max_wallet_principal`
  fits it with room (§6).
- Whether the big position has crossed the Streamflow reward ceiling is **unverified** —
  see the devnet runbook §9 before telling its holder anything about their rewards.

---

## 13. What can go wrong, and what fixes it

| failure | effect | fix |
| --- | --- | --- |
| deploy stops partway | SOL held in a buffer account | `solana program close --buffers`, then deploy again |
| wrong deployer compiled in | `init-pool` refused (6010) | rebuild with the right deployer and upgrade — needs the upgrade authority |
| wrong `min_stake` or `max_wallet_principal` | permanent for that pool | create a second pool with `--nonce 1`; the first stays as it is |
| pool authority key lost | no new funding, no cap raises | stakers are unaffected: every exit is theirs alone |
| upgrade authority lost | the program is frozen as it is | the same as immutable |
| a transaction "failed to confirm" | it may still have landed | the CLI says so; run `read` before retrying |
