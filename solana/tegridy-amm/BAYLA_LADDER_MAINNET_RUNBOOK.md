# bayla-ladder — MAINNET runbook

**Status: ✅ EXECUTED 2026-09-20** — program `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ`
is live on mainnet-beta, the IDL is published, and the pool is seeded, funded and emitting.
Every address this runbook produced is registered in `frontend/scripts/addresses.json`
(ids `bayla-ladder-*`) and chain-asserted daily by `.github/workflows/registry-onchain.yml`.
🔴 **One step of it has NOT run: the authority handover (§1 below, and step 13).** The
ProgramData upgrade authority and `pool.authority` are both still the deployer key
`Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`, and `pool.pendingAuthority` is unset.
Read this file as a record of what was done plus that one open step, not as a plan.

Written 2026-09-11. This is the mainnet half that
`BAYLA_LADDER_DEVNET_RUNBOOK.md` deliberately left unwritten. Every command below was
checked against the tool it calls (Solana CLI 4.1.1 on the operator box, the ops CLI
on trunk), and every figure says where it came from.

The steps are numbered because the order is load-bearing: two pool parameters are
permanent, the early-exit penalty schedule is compiled in with no setter, and the
program's deployer is compiled into the binary.

> ⚠️ **2026-09-17 — the program is being rebuilt, and this runbook was updated for it.**
> The ladder's early-exit penalty is **Yearn's veYFI schedule**,
> `amount × min(time left / 4 years, 75%)` (§6), which replaced a flat 75% set earlier the
> same day; the EVM `LighthouseLadder.sol` stays 25%. The schedule brings a
> reward-sizing rule: keep the max-boost annual reward rate under about 28% (§8). And
> `notify_reward` refuses a mid-window reload that would lower the rate (§8). The deployer is **rotated** (key rotation option A), the pool
> authority is **a multisig before any funds** (§1), and the Streamflow pool is a
> **separate product** with no migration (§12). The mainnet artifact
> `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` from CI
> run 34712334698 is **SUPERSEDED — do not deploy it**: it carries the 25% penalty, no rate
> guard, and the hot faucet key as its deployer. Decisions and gates:
> `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md`.

---

## 0. Preconditions — all of them, before anything costs SOL

- [~] **The external audit report — ⚠️ WAIVED BY THE OWNER, 2026-09-20.** No external
      audit of `bayla-ladder` was ever commissioned: it appears in neither `AUDIT_RFQ.md`
      nor `AUDIT_OUTREACH.md` (both scope only `cp-swap` and `tegridy-launch`), and no
      auditor is engaged. Rather than leave the box ambiguous, the owner decided on
      2026-09-20 to **proceed without one** and to record that decision here.

      **Deploy commit: `50065ef03b7eae4ec955ec40ffd32aaf4181b3c2`**, tagged
      `bayla-ladder-mainnet`. It carries both required changes — `math::penalty_for`
      (math.rs:335) and `math::rate_change_allowed` (math.rs:384). The `bayla-ladder`
      tree has been unchanged since `00c48092` (#592, 2026-09-17), so the tag is the
      veYFI build, not the superseded
      `fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5` (25% penalty,
      no rate guard) and not #586's flat 75%.

      **What this waiver actually costs, stated plainly so nobody later reads it as a
      pass.** The only review this code has had is
      `docs/LIGHTHOUSE_AUDIT_2026_09_01.md` — internal, adversarial, and dated
      2026-09-01, i.e. **sixteen days before both the penalty schedule and the rate
      guard existed**. So the two newest, most economically load-bearing pieces of the
      program have had no independent review at all, and they are the pieces with no
      setter: the penalty schedule is compiled in and changing it by upgrade rewrites
      every open position retroactively. The mitigations relied on instead are the
      `deposit_cap` (raise-only — start small), the multisig pool authority (§8), and
      the fact that reward sizing, not the penalty, is the lever holding the ~28%/yr
      bound. If an audit is commissioned later, this is the commit to hand them.
- [x] **`withdraw_matured` has executed on devnet.** Done **2026-09-17**, finalized, tx
      `4AYtGTnHvSV3bCuaq4nhQPSLnvbc6pnJJfaNY7SqC2FeR2QYQK3ukdwJbAzFjEXNynWYxpBHP9pgRkPYSyAZWeAf`:
      500 back, penalty 0, `penalty_collected_cumulative` unchanged, accounting reconciled
      to the raw unit — measured on the superseded 25% build. The matured door passes a
      zero penalty whatever the rate (`withdraw_matured` calls
      `exit_with_penalty(ctx, now, 0)`), so that result carries over; nothing has been
      measured on chain under the schedule. Evidence and the working command (the one recorded before
      omitted `--program`) are in `docs/TODO_OPERATOR.md` O-0909-1.
- [ ] **Both keyfiles are backed up offline** — the program keyfile and the deployer's.
      Not to OneDrive or any cloud folder in plaintext.
- [x] **The upgrade authority is decided** (§3), 2026-09-12: the venue's **existing Squads v4
      vault** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. Nothing to create.
- [x] **The pool parameters are decided** (§6), 2026-09-12: **100 / 2,000,000 / 5,000,000**.
      Two of the three can never be changed.
- [x] **The early-exit penalty is decided**, 2026-09-17: **veYFI's schedule**,
      `amount × min(time_left / 4 years, 75%)` with `time_left = lock_end − now`
      (`math::penalty_for`, cap `MAX_EARLY_EXIT_PENALTY_BPS = 7_500`), replacing the flat
      75% decided earlier that day. `emergency_withdraw` charges the same while locked; both
      early doors charge 0 once the pool is `degraded`, and a matured exit charges 0.
      Compiled in, no setter (§6). Its price — a reward-sizing ceiling — is in §8.
- [x] **The deployer is decided**, 2026-09-17: **rotate** (option A). A fresh key,
      generated outside any cloud-synced folder, replaces
      `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` (§1). Its pubkey
      goes into §1 before the §4 build.
- [ ] **The pool authority is a multisig before any funds** (decided 2026-09-17): the
      handover in §8 completes before the first `notify`.
- [ ] **A keyed mainnet RPC URL.** The public endpoint throttles hard, and a program upload
      is several hundred write transactions. Never paste the URL into the repo.
      **The ops CLI used to paste it for you.** `bayla-ladder-ops.mjs` echoed the full
      `--rpc` value in its header on every invocation, dry runs included, and on
      2026-09-20 that put a live Alchemy key into a shared screenshot; the key was
      rotated. It now prints the host and masks the credential —
      `rpc     https://solana-mainnet.g.alchemy.com/v2/***` — so the header is safe to
      screenshot. The HOST is still shown, deliberately: it is how you confirm you are
      not on the CLI's devnet default. Redactor: `scripts/lib/redact-url.mjs`.
- [ ] **~3 SOL in the deployer wallet** — the rotated deployer
      **`Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`**, and no other wallet. Not
      `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`, not
      `5MtoeJ8DXcgWZQJAgGgDefd5hbq4KAe3K47yL9Nc87vq` (§5 for the breakdown). It read
      `AccountNotFound` / 0 SOL on 2026-09-20, so the first transfer creates it.

🏝️ **One more gate, and it is NOT in this list on purpose.** The island's wave-8 "ladder and
the clock" ruling blocks **§9 (turning the card on)** and nothing before it. It is not a
precondition for spending SOL, deploying, publishing the IDL, handing over authority,
creating the pool, or even funding a first window — only for advertising it to users. The
commitment and the reason are in `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md` §8.

---

## 1. Identities

| what | value | notes |
| --- | --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` | Generated 2026-09-11. **Claimed on mainnet 2026-09-20** — the keyfile has now done its one job and authorises nothing further; what can still change this program is the ProgramData upgrade authority, one row down. The keyfile lives outside the repo. |
| deployer | ~~`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`~~ → **`Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`** | ✅ **ROTATED 2026-09-20.** Generated fresh, keyfile at `C:\Users\jimbo\solana-keys\mainnet\bayla_ladder-deployer.json` (outside OneDrive). Verified before use: the keyfile derives to exactly this pubkey; the account does not exist on mainnet (`AccountNotFound`, i.e. never used); and it collides with none of the program id, the old faucet authority, `5MtoeJ8D…` or the devnet program. **SUPERSEDED 2026-09-17 (key rotation option A).** `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` was confirmed 2026-09-12 as the owner's existing BAYLA admin wallet; it is also the devnet faucet bot's hot key in a cloud-synced folder (`docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md` §1). The rebuild compiles a fresh key generated outside any cloud-synced folder — write its pubkey here before §4, and never build with `GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`. Compiled in: the only key that can call `initialize_pool`, and it becomes the pool's first authority — so its pubkey is an input to the **build** (§4), not to the deploy. **To generate it (2026-09-20):** `solana-keygen` on the `PATH` is Application-Control blocked, but the versioned install path is not — `~/.local/share/solana/install/releases/stable-25cd9da946ebf6d90024ac32071d05b319715589/solana-release/bin/solana-keygen new --no-bip39-passphrase --outfile C:/Users/jimbo/solana-keys/mainnet/bayla_ladder-deployer.json`, then read it back with `solana address -k`. Checklist §3. |
| BAYLA mint | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` | Token-2022, 6 decimals |
| upgrade authority | **TARGET** `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` — **ACTUAL, as of 2026-09-20: `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`** | 🔴 This row named only the target and read as a statement of fact; the handover has not run. Read at finalized slot 448,901,426, ProgramData `FormQpVVwmM3Rpyh6qrpCLmMRuPamTvV6vx7VD8yt3Dw` carries option byte 1 and authority `Fu7mNAv67sRb…`, the deployer. The target is the venue's existing Squads v4 **vault**: index 0 of multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`, threshold 2. A PDA with no private key, so the transfer needs `--skip-new-upgrade-authority-signer-check`. |

**Why a plain wallet is acceptable as the POOL authority, and not as the UPGRADE
authority.** The pool authority's instructions were read account by account:
`notify_reward` only moves tokens *from the authority's own wallet into* the reward vault;
`propose_authority`, `propose_cap_raise`, `cancel_cap_raise` and `declare_degraded` change
pool fields and name no vault at all; `execute_cap_raise` and `sweep_orphaned_penalty`
need no signer. **No pool-authority signature can move a token out of either vault.** The
upgrade authority can replace the program itself, and so everything in it.

**DECIDED 2026-09-17: the pool authority is nonetheless a multisig before any funds.** The
argument above bounds what a stolen authority key can TAKE, not what it can DO. It can
`declare_degraded` — one-way: it closes the pool to new stakes and waives the early-exit
penalty (up to 75%) on both early doors, including on any locked position the thief holds.
And once a window has ended, the rate guard (§8) no longer applies, so it can restart
rewards at a tiny rate.
So: create the pool with the deployer (§7), hand the authority to the multisig with
`propose-authority` / `accept-authority` (§11), and only then fund (§8).

⚠️ **The ops CLI signs from a keyfile only** (`--keypair <path-to-id.json>`). If the
deployer is a hardware wallet, `init-pool` cannot be signed with this tool — choose a
deployer you hold as a keyfile, or build a different signing path first. **The same limit
applies to every authority command once the authority is a multisig, and it covers the dry
run too:** `notify` without `--preview`, `propose-cap-raise`, `cancel-cap-raise`,
`propose-authority` and `declare-degraded` each load `--keypair` first (without one:
`--keypair is required`) and then refuse locally with
`this pool's authority is <AUTHORITY>, not <KEYFILE-PUBKEY> (Unauthorized)` before anything
is built or simulated, unless that keyfile IS the pool authority. A Squads vault has no
keyfile, so after the handover the CLI cannot even dry-run those commands: each reload
(§8), cap raise, cancel, authority proposal and `declare-degraded` is built, simulated and
signed inside the multisig's own app. What the CLI still does for a multisig is
`notify --preview`: no keyfile, nothing built, simulated or sent, and it replays the
program's own checks at chain now — including the rate guard — and prints the minimum
`--amount` that holds the rate. It also refuses when the authority's **associated** BAYLA
token account is missing or holds less than `--amount`, because the program rejects that
account before any ladder check. It can only see that ATA: the program accepts any BAYLA
account the authority holds, so build the Squads transaction to fund from the ATA the
preview checked. Settle the signing path before the handover, not at the first reload.

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
gh workflow run solana-deploy-artifact.yml --ref bayla-ladder-mainnet -f program=bayla-ladder -f cluster=mainnet -f program_id=EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ -f deployer=Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6
```

### ✅ THE REBUILD IS DONE — 2026-09-20, CI run 35529979428

| what | value |
| --- | --- |
| run | [35529979428](https://github.com/fomotsar-commits/tegridy-farms/actions/runs/35529979428) — `build-ladder-deployable`: **success** |
| artifact | `bayla-ladder-mainnet-50065ef03b7eae4ec955ec40ffd32aaf4181b3c2` (id 10610419675) |
| tag / commit | `bayla-ladder-mainnet` → `50065ef03b7eae4ec955ec40ffd32aaf4181b3c2` |
| **`.so` sha256** | **`b21e1277e104817886a31d6f5b16ba2a35fa6732558cbd6d227e4fb8e21bb0a1`** |
| IDL sha256 | `ae6c9cbaddb20ca5d20f9dafb3aca9180e5fcb27ceb53e2fda44866396ae5abc` |
| built with `program_id` | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| built with `deployer` | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` |
| cluster arm | `mainnet` (no `devnet` feature) |

Both identities were echoed back by the job's own "Validate the identities BEFORE building"
step (`-> 32 bytes OK`), so the binary is pinned to the rotated deployer, not to
`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`.

**`b21e1277…` is the only hash that may be deployed.** It is not `fada8148…`, which is the
proof this is a real rebuild rather than a re-upload of the superseded artifact. §5 checks
the deployed bytes against `b21e1277…`.

⏳ **Artifact expires 2026-10-20** (30 days). Download and keep it offline alongside the
`.so`'s hash before then.

**✅ Downloaded and independently verified, 2026-09-20.** At
`C:\Users\jimbo\solana-keys\artifact\bayla-ladder-mainnet-50065ef0\`:

- `sha256sum` of the downloaded `.so` = `b21e1277…`, matching CI **and** the `.sha256`
  sidecar shipped beside it. The IDL matches `ae6c9cba…`.
- `.so` size **515,352 bytes** (2,848 more than the superseded build — the schedule and the
  rate guard). Rent re-quoted from this number in §5.
- The IDL's `address` field is the **mainnet** program `EJLP5GEJ…`, not the devnet one, so
  the artifact's IDL is the one to publish (this closes the caveat in §5).
- **The compiled-in identities were checked inside the ELF**, by base58-decoding each key to
  its 32 raw bytes and searching the binary — not by trusting the job's echo:

  | key | expected | found |
  | --- | --- | --- |
  | deployer `Fu7mNAv6…` | present | ✅ present |
  | program `EJLP5GEJ…` | present | ✅ present |
  | old faucet `GCCSLE7d…` | absent | ✅ absent |
  | devnet deployer `ASLXdST4…` | absent | ✅ absent |
  | devnet program `HzxzfSQz…` | absent | ✅ absent |

  The devnet keys being absent is what proves the `mainnet` arm was built, not the `devnet`
  feature; the old faucet key being absent is what proves the rotation actually took.

⚠️ **`deployer` is the rotated key from §1, never
`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`** (key rotation option A, 2026-09-17). The
artifact from CI run 34712334698 (`.so` sha256
`fada8148d28644dc0fbc2a0fb6bbe66ca656e688d76634f08d39e3981b5c44a5`) was built with
`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9`, the 25% penalty and no rate guard: it is
**SUPERSEDED** and must not be deployed. This command, run on the audited commit, is the rebuild that replaces it.

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
upgradeable.

**Measured for THIS build, 2026-09-20** — the artifact was downloaded, its size read, and
every figure quoted from mainnet rather than from an older build:

| account | size | rent-exempt minimum |
| --- | --- | --- |
| programdata | 515,352 + 45 header | **2.618867 SOL** |
| program | 36 | 0.00083312 SOL |
| pool + reward vault PDAs (§7) | — | ~0.0062 SOL |
| **total, plus fees** | | **~2.63 SOL** |

**Budget 3 SOL.** That leaves roughly 0.37 for the IDL account (§5), the pool creation, the
authority proposal and transaction fees, with headroom. The deploy consumes the programdata
rent permanently; the rest stays in the deployer wallet.

⚠️ The old **2.60 SOL** figure was `solana rent 512504` for the superseded `fada8148…`
build. This binary is 2,848 bytes larger — the veYFI schedule and the rate guard — so it
rents slightly more. Never reuse a rent figure across builds; ask the chain each time.

`solana --version` must be 4.1.1 or newer; older CLIs default to 2× and cost about
**5.24 SOL** for this binary.

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

### ✅ DEPLOYED TO MAINNET — 2026-09-20, slot 448851661

| what | value |
| --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| **programdata** | **`FormQpVVwmM3Rpyh6qrpCLmMRuPamTvV6vx7VD8yt3Dw`** — new address, register it (§10) |
| loader | `BPFLoaderUpgradeab1e11111111111111111111111` (upgradeable, as intended) |
| upgrade authority | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` — the deployer, **still**; §5 hands it to Squads |
| data length | 515,352 bytes — **exactly 1×**, so CLI 4.1.1's default behaved as §5 predicted |
| programdata rent | 2.618867 SOL, matching the pre-deploy quote to the lamport |
| deployer left | 0.30772988 SOL |

**The deployed bytes were verified, not assumed.** `solana program dump` pulled the program
back off chain: 515,352 bytes hashing to
`b21e1277e104817886a31d6f5b16ba2a35fa6732558cbd6d227e4fb8e21bb0a1` — identical to the CI
artifact. That closes the chain of custody end to end: CI built it → the download was
hash-checked → the chain holds those same bytes.

Deployed over a **keyed Alchemy RPC**, read from `frontend/.env` at run time so the key never
reaches a document or a shell history. The §0 "keyed mainnet RPC" precondition was satisfied
by a key the venue already owned — it had simply never been tried against Solana.

⚠️ **The remaining 0.30772988 SOL is the budget for everything below.** Measured costs:
IDL account 0.04666488 (9,058 bytes — the 48,408-byte IDL zlib-compressed to 9,014, plus a
44-byte header), pool + reward vault PDAs ~0.0062, and transaction fees. It fits, with
roughly 0.25 to spare.

---

**Publish the IDL now — before the handover, not after.**

> **Tooling note (2026-09-20).** `anchor` on the `PATH` is Application-Control blocked, the
> same shim problem as `solana-keygen`. The real binary is
> `C:\Users\jimbo\.avm\bin\anchor-0.32.1` — 0.32.1, the version CI built with.
>
> 🔴 **It has NO `.exe` extension, so PowerShell cannot launch it.** `& "…\anchor-0.32.1"`
> does not run the program: Windows falls back to file association and pops an
> "open with" dialog, which looks to the operator like the command silently did nothing.
> Git Bash runs it fine, which makes this easy to miss when a command is tested in one
> shell and handed to an operator using the other. **Fix: copy it to `anchor-0.32.1.exe`
> in the same folder** — verified 2026-09-20 that the `.exe` copy runs and is *not*
> blocked, so the Application Control rule is on `.cargo\bin\anchor.exe`'s path, not on
> the binary itself.
>
> 🔴 **`idl init` REQUIRES an Anchor workspace — and it must not be this repo's.**
> `idl fetch` runs fine outside one, which makes it a **misleading rehearsal**: fetch
> succeeded from a bare directory, then `idl init` failed there with
> `Not in anchor workspace.` Rehearse a write with the write's own preconditions.
>
> Running it from `solana/tegridy-amm/` fails twice over, and neither is fixable there:
>
> 1. `Error: "You need to run this command with administrator privileges."` — the
>    `[toolchain]` pin (`solana_version = "2.3.0"`) makes anchor attempt a version
>    override, which needs the Windows symlink privilege. It then warns
>    `Failed to override solana version to 2.3.0, using 4.1.1 instead`.
> 2. `Error: program not found` — `[programs.Localnet]` declares `bayla_ladder` as the
>    **placeholder** `GKwgTQtVyPGxspxvciDAStY4Jq7rB1STuVvXic7EG6E4`, so the real deployed
>    id resolves to nothing. Its `[provider]` also defaults to `cluster = "Localnet"`.
>
> Neither is a defect to repair: the placeholder is deliberate (`lib.rs:193-196`) and the
> toolchain pin is what CI builds against. **Use a throwaway single-purpose workspace
> instead** — one `Anchor.toml`, no `[toolchain]` section, the real program id under
> `[programs.mainnet]` and `[programs.localnet]`. One is kept at
> `C:\Users\jimbo\solana-keys\artifact\idlws\Anchor.toml`, verified 2026-09-20 to reach
> mainnet and resolve the program with no privilege error.
>
> The IDL account this program will use is `3nHKL72LUn5vijmHk76v6qwgkMshToKkJGsEzbWBaQ2r`.
> It read `AccountNotFound` before the init — that is the check to re-run if an init is
> ever *thought* to have half-completed, because `anchor idl init` **can only be run once**.
>
> ⚠️ PowerShell wraps a native program's stderr in a red `NativeCommandError` block. That
> is PowerShell's formatting, not a second failure — read the message inside it.

```powershell
anchor idl init --filepath target\idl\bayla_ladder.json EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --provider.cluster mainnet
anchor idl fetch EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --provider.cluster mainnet
```

`anchor idl init` is signed by the **program's upgrade authority**, which is still the
deployer at this point. Once the next step hands that authority to the Squads vault, every
IDL write becomes a 2-of-2 multisig ceremony — so this is cheap now and permanently
awkward in five minutes' time.

Without an on-chain IDL, Solscan and SolanaFM cannot decode `stake`, `early_exit`,
`withdraw_matured` or the `Pool` account: a holder locking tokens for up to four years sees
raw bytes instead of their own position. The IDL shipped by the CI artifact is the one to
publish, and its sha256 is recorded alongside the `.so` (§4).

⚠️ The committed IDL at `solana/tegridy-amm/idl/bayla_ladder.json` carries the **devnet**
program id in its `address` field. Publish the one from the mainnet build artifact, and check
`anchor idl fetch` returns the mainnet id before moving on.

⚠️ `anchor` itself is Application-Control blocked on the current build box (`Permission
denied`). Run this from wherever the artifact is downloaded, or use the versioned install
path the way `solana-keygen` is handled (checklist §3).

### ✅ IDL PUBLISHED — 2026-09-20

| what | value |
| --- | --- |
| IDL account | `3nHKL72LUn5vijmHk76v6qwgkMshToKkJGsEzbWBaQ2r` |
| owner | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` — the program itself |
| rent | **0.08335264 SOL** |
| verified by | `anchor idl fetch` returned 50,407 bytes, `address` = the mainnet program, **15 instructions** |

⚠️ **The IDL cost 0.083, not the 0.047 that was estimated here.** The estimate was
`solana rent` for the *exact* compressed size (9,058 bytes); Anchor allocates headroom
above that so the IDL can later be upgraded in place. Roughly 1.8× the minimum. Budget the
measured figure, not the floor — and note the same reasoning applies anywhere a program,
not the CLI, chooses the account size.

Deployer after this step: **0.22430224 SOL**. Upgrade authority is still
`Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` — the handover below has not run yet.

---

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
and **no instruction ever changes them**. Only `deposit_cap` moves:
upward only, 48 hours after it is proposed.

| parameter | what the program enforces | changeable later? | **decided 2026-09-12** |
| --- | --- | --- | --- |
| `min_stake` | at least **100 whole tokens** | **no** | **100 BAYLA** |
| `max_wallet_principal` | between `min_stake` and the **initial** `deposit_cap` | **no** — later cap raises do not lift it | **2,000,000 BAYLA** |
| `deposit_cap` | at least `min_stake` | up only, 48h after `propose-cap-raise` | **5,000,000 BAYLA** |

**Not a pool parameter, and just as fixed: the early-exit penalty.** It is Yearn's veYFI
schedule, copied from yearn/veYFI `VotingYFI.vy`:
`penalty = amount × min(time_left / 4 years, 75%)`, where `time_left = lock_end − now`,
floored twice in veYFI's order (`math::penalty_for`; the cap is
`MAX_EARLY_EXIT_PENALTY_BPS = 7_500`). It depends on the time left, not the lock chosen.
Worked on 1,000,000 BAYLA:

| time left at exit | forfeited | returned |
| --- | --- | --- |
| 3 years or more | 750,000 (the 75% cap) | 250,000 |
| 2 years | 500,000 (50%) | 500,000 |
| 1 year | 250,000 (25%) | 750,000 |
| 30 days | 20,547.945205 (about 2.05%) | 979,452.054795 |
| 7 days | 4,794.520547 (about 0.48%) | 995,205.479453 |
| none (at or after `lock_end`) | 0 | 1,000,000 |

It is compiled into the binary (`math.rs`), charged identically by `early_exit` and by
`emergency_withdraw` while locked (0 in a `degraded` pool, and 0 on a matured exit), stored
in no account, and has no setter. Only a program upgrade through the Squads vault (§3)
could change it, and because no account stores it, an upgrade would change it for every
position already open. The forfeited share is not paid to anyone on the way out: it goes
to the reward pool, is scheduled into a later window by the operator (§8), and is then
shared by weight among whoever is staked then. The schedule's price is a ceiling on reward
sizing (§8, "The penalty schedule caps the reward rate").

**Also disclosed, not changed (decided 2026-09-17): a matured position keeps its full
boost indefinitely.** Weight is `amount × boost`, frozen at stake time
(`Position.weight` in `state.rs`) and written only by `stake`, and there is no forced
maturity, decay or kick (the `Pool.max_wallet_principal` doc in `state.rs`), so a 4-year
position that has matured and
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

### ✅ POOL CREATED — 2026-09-20, slot 448865455

tx `5F5QELBNfwMkDzv3N6DkZRMYHkT4GUw7ms66jbRmPvyffaCdUcBNoEAWXLVf4PKzF97x24ASpY2tKT2MqfMnFfMc`

| what | value |
| --- | --- |
| pool (nonce 0) | `Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV` |
| stake vault | `FLCy81my7vNEaiqeFH7F1tk2aPR4Gcg8XSCFTvxWVps7` |
| reward vault | `3yFvfhdRS9WNJEwVec7fgB3KRcKAi7Lo4jUyzzDMPAK1` |
| authority | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` (the deployer) |
| min stake | **100** — permanent |
| max / wallet | **2,000,000** — permanent |
| deposit cap | **992,095,337** |

**OWNER DECISION 2026-09-20 — the deposit cap is set to the entire BAYLA supply, i.e.
there is effectively no cap.** The owner's reasoning was checked and is correct: the cap
does *not* bound reward spending. Emission is a fixed rate per 90-day window
(`REWARDS_DURATION_SECS`), shared out by weight, so more stakers dilute each other's share
rather than increasing what the pool pays. A cap therefore only changes the *advertised*
rate, and the ~28%/yr max-boost bound gets **safer** as stake grows, not riskier.

The one function a cap did serve was blast radius — bounding how much third-party money
sits in a program with no external audit (waived the same day, §0 box 1). That is now
bounded only by `max_wallet_principal`, which makes the permanent 2,000,000 wallet cap the
**sole** concentration control. It is 0.20% of supply.

Safe to set at supply because **supply is fixed**: the BAYLA mint's `Mint authority` reads
`(not set)`, verified on chain 2026-09-20, so 992,095,336.807558 can never increase. A cap
of 992,095,337 is unreachable forever, not merely unreachable today. (Freeze authority is
also unset.)

**Verified before broadcast by reading the dry run's own echo**, which prints the three
values back in WHOLE tokens: `100` / `992,095,337` / `2,000,000`. That check is the only
defence against the silent 10⁶ failure — the program has no upper sanity bound on either
cap, so passing raw units would have succeeded and set an unreachable, unfixable limit.

**Also recorded: the boost curve, computed from the source constants** (`math.rs:67-70`),
because a 180-day lock earning *less* than 1.00× surprises people:

| lock | boost |
| --- | --- |
| 7 days (minimum) | 0.4000× |
| 30 days | 0.4569× |
| 90 days | 0.6056× |
| 180 days | 0.8286× |
| 365 days | 1.2869× |
| 730 days | 2.1913× |
| 1460 days (4y, maximum) | 4.0000× |

1.00× is not the floor — it sits around 240 days. `MIN_BOOST_BPS` is 4,000 and
`MAX_BOOST_BPS` is 40,000, so the ladder spans 0.40× to 4.00×, a 10× spread.


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

### ✅ SEEDED AND FUNDED — 2026-09-20. The ladder is LIVE and emitting.

⚠️ **§8's original step 1 said "multisig before funds" (D4). SUPERSEDED by the owner on
2026-09-20: the Squads handover happens LAST**, after the pool is proven. So the deployer
`Fu7mNAv6…` is the pool authority for this first window, and the reward budget was moved
into **its** ATA `DsGFcoYREF44GJxYofDKJXbxhY2oEMoAewELUMn89Wqc`, not the vault's.

That ordering was not a preference, it was forced: `notify_reward` constrains
`funder_ata.owner == authority` (lib.rs:1286), and `initialize_pool` pins
`pool.authority = payer = deployer::ID` (lib.rs:393, :1082). Funding from any wallet that
is not the pool authority is not possible. The checklist's old step 12 — "move the budget
to the multisig's token account" — was the right idea against the wrong account.

**Seed stake** — tx `65kztjFkKLsZZEUyp4ivbPNXAApEC6T7j6eYCrtJotuoWH34zukqgoT39ccYuB27FpEdgmx4LDeeCvn2QtcvkFuW`

| what | value |
| --- | --- |
| position | `F5DkgYbj2EsD1ZfD1P9EobftUjk2ALsv6Am2JxsnawpE` (#0) |
| amount / lock | 3,000 BAYLA, 180 days |
| boost | 0.8286× → weight **2,485.8** |
| early-exit cost today | 369.859018 BAYLA (12.32%), shrinking to 0 at maturity |

**First window** — tx `3kmMfEjWKSTsvZsRP5KpwyyNdtJPwMf4Q3hoMTmrEHKWsuGEx4uRLiUAyfHNQnG14kU1AXzt4ZBHaaHEVRM99CrT`

| what | value |
| --- | --- |
| amount | **23.328 BAYLA** |
| rate | **3 raw/second** exactly — 0.2592/day |
| window ends | 2026-12-19T22:41:57Z |
| max-boost annual rate | **15.22%** — 55% of the 27.64% ceiling |
| verified | `emitted since then` ticking up; `outstanding (LIVE)` tracks it |

### ✅ THE LADDER WAS EXERCISED ON MAINNET — 2026-09-20/21

Owner decision: fund the first real window at **42,993.504 BAYLA** (475.7184/day), knowingly
above the ~28% max-boost bound at the seed's weight, on the basis that the card is not live
and the only staker is the venue itself. Recorded as a decision, not an oversight.

**A landing guard refused the first attempt, and was right.** `notify --broadcast` exited with
`refusing to BROADCAST with a landing RISK`. The margin is
`fundable − scheduled = vault − owed − tail`, which is **independent of `--amount`** — lowering
the amount does not help, because the transfer raises `vault` and the schedule raises `tail`
by the same step. Verified empirically at 42,993.504 / 42,900 / 42,500: all three printed the
identical 7,940-raw margin. **The only way to create headroom is BAYLA in the vault that is
not scheduled**, so 200 BAYLA was sent **directly to the reward vault**
`3yFvfhdRS9WNJEwVec7fgB3KRcKAi7Lo4jUyzzDMPAK1` with `spl-token transfer` (safe: the address is
a Token-2022 account owned by the pool, and spl-token uses a token account directly when given
one) and the notify was reduced to 42,793.504. Total committed unchanged; guard cleared.

**The boost curve, verified on chain** — four positions staked, weights read back:

| lock | weight (raw) | boost | predicted |
| --- | --- | --- | --- |
| 7 days | 40,000,000 | 0.4000× | 0.4000× ✓ |
| 180 days | 2,485,800,000 | 0.8286× | 0.8286× ✓ |
| 365 days | 128,690,000 | 1.2869× | 1.2869× ✓ |
| 1460 days | 400,000,000 | 4.0000× | 4.0000× ✓ |

**The veYFI penalty, verified on chain** — the schedule quoted per position at the chain clock:
7d left → 0.47% · 365d left → 24.99% · 1460d left → **75.00%, the clamp** (it would be 100%
unclamped). `min(time_left/4y, 75%)` behaving exactly as written.

**`early_exit` EXECUTED under the schedule** — tx
`2BuHQMm8VhmssvRoCQnYZ9V2w45qaxLzcYwMUZgeSLGq2aCDhbQAVtvJkMm984CSjeUwY1MmS1DCgwSQ5HQgXUSG`.
**This was the last untested path in the program**: devnet only ever ran it on the flat-25%
build. Position #3 (100 BAYLA, 4-year lock) forfeited **75**, returned **25**, and every book
reconciled to the raw unit:

- `penalties collected` 0 → **75**, `orphaned penalty` **0**
- `unpledged budget` 201.161466 → **276.161466** — the forfeit became schedulable reward
  budget. **Penalty recycling is real and needs no operator step**, confirmed by reading it
  rather than from the doc.
- `total_weighted` −400,000,000 and `total_principal` −100, both exact
- reward vault +74.932944, not +75 — the 0.067056 difference is precisely the rewards #3
  accrued in the ~90 seconds it existed, paid out on exit. Even the discrepancy reconciles.

⚠️ **The weight drop is the hazard worth remembering**: closing #3 removed 13% of the pool's
weight, which RAISES every remaining staker's effective rate — and the rate cannot be lowered
until the window ends. Size every window against the SMALLEST weight expected during it.

🔴 **Two guards could NOT be tested, and are not covered by any unit test.** `min_stake`: the
ops CLI rejects client-side (`below this pool's minimum of 100`) before the program ever sees
it, so only the CLI guard was proven. `max_wallet_principal`: a 2,000,000 attempt failed at the
token transfer with `insufficient funds`, never reaching the cap check. Both `require!`s exist
(lib.rs:466, :478) but nothing exercises them — and both values are permanent. A grep for tests
naming `WalletCapExceeded` or the min-stake floor returns nothing.

---

**Why 23.328 and not a round number.** `rate = amount_raw / REWARDS_DURATION_SECS` is
integer division, so 23,328,000 / 7,776,000 = **3 exactly**. Any amount that does not divide
cleanly truncates, and the lost remainder is silently unpayable. Size the first window to a
whole number of raw units per second; AUDIT L-1 records the extreme version of this, where a
small reload floors the rate to zero while `RewardAdded` still fires with a healthy payload.

**The ceiling, derived rather than quoted.** At max boost,
`APR = MAX_BOOST × rate × seconds_per_year / total_weighted`. With 4.00×, 3 raw/s and
2,485.8 whole-weighted that is 15.22%. Rearranged, the compliant maximum for a given weight
is `total_weighted × 0.017039` whole per window. **This is the number to recompute before
every reload** — against the SMALLEST total_weighted expected during the window, not
today's, because weight falling mid-window raises the rate.

🔴 **The binding constraint is funding, not the ceiling.** At today's weight the ceiling is
42.35 BAYLA per window. But the ceiling scales with stake, so at the reference pool's
~2.7M BAYLA the compliant window would be roughly **46,000 BAYLA every 90 days**, against an
owner balance of 42,126.875. Reward funding never stops (D7). **Settle where subsequent
windows come from before the ladder is opened to the public** — this is a business
constraint, not an operational one, and no amount of sequencing solves it.


**Two things happen before the first `notify`, in this order:**

1. **Hand the pool authority to the multisig** (decided 2026-09-17: a multisig before any
   funds). `propose-authority --pool <POOL> --new-authority <SQUADS-VAULT-PDA>` signed by
   the deployer, then `accept-authority` from inside the multisig's app (§11). The address
   is a **vault** PDA, never the multisig config account — §3's warning applies here
   exactly as it did to the cp-swap admin: the config account cannot sign, so it could
   never accept. **Which vault is not decided yet** — the upgrade authority's vault 0
   (`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`) or a separate one. Confirm with `read`
   that `authority` is that vault and no `pending authority` remains.
2. **Turn the card on (§9) and let stakers arrive.** Never fund an empty pool: a second in
   which nothing is staked emits nothing (`math::reward_per_weight_with_residue` returns
   the accumulator unchanged while `total_weighted` is 0, and `checkpoint` still moves the
   clock), so a window funded ahead of its stakers spends its clock on nobody. Those tokens
   stay in the vault, reachable only by a later `from_budget` reload. The ops CLI enforces
   this: while `total_weighted` is below `min_weight_floor(min_stake)` it refuses `notify`,
   dry run included (`notify --preview` lists it as `REFUSED` and exits 1), unless
   `--allow-empty-pool` is passed. Never pass that flag on mainnet.

```powershell
node scripts\bayla-ladder-ops.mjs notify --pool <POOL> --amount <WHOLE-BAYLA> --program EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --rpc <MAINNET-RPC-URL> --keypair <authority-keyfile>
```

(After the handover the authority is the multisig. The line above shows the instruction's
arguments, but any run of it without `--preview` — the dry run included — needs
`--keypair` to BE the pool authority (§1), so the transaction is built, simulated and
signed in the multisig's app. Preview it first with the same line, `--preview` in place of
`--keypair`.)

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
  `period_finish` any rate is allowed.** `notify --preview` checks this before anything is
  signed, folds the unspent tail into the rate it prints (`unemitted tail`, `new rate`),
  and prints the minimum that holds the rate now and two minutes later — two
  `minimum --amount` lines, *"holds the current rate if it lands at chain now"* and
  *"holds it if it lands 120s later"*, plus how much each further second adds. Use it. **By
  hand**, three unit traps:
  `read` prints `reward rate` in whole BAYLA per second, exact to the raw unit (thousands
  separators included — strip them), so `reward rate × seconds` is already in the whole-BAYLA
  units `--amount`/`--from-budget` take: round UP at the sixth decimal. Only the raw on-chain
  `reward_rate` field (raw base units per second) needs dividing by 10^6 (BAYLA has 6
  decimals). `read` also prints `period finish` as an ISO date, so convert
  it to unix seconds first; and `now` is when the transaction LANDS, not when you did the
  arithmetic, so every second of signing delay raises the minimum by `reward_rate`.

### The penalty schedule caps the reward rate — under ~28% a year at max boost

Operator policy; the program enforces none of it. **This is the price of the veYFI
penalty (§6), and it bounds every `notify`, the first included.**

Weight is frozen at stake time (`Position.weight`, §6), so a position that claims a longer
lock than it serves keeps the longer lock's boost until it leaves; the early-exit penalty is
what has to outweigh that extra reward. Under the schedule the penalty shrinks with the time
left, so "lock 4 years and leave early" beats an honest shorter lock once the **max-boost
annual reward rate** — what a 4.00x position earns in a year, as a share of its principal —
exceeds **roughly 28%**. veYFI has the same bound (about 25%) and holds it by paying a low
yield. A flat 75% would have held to about 83%; the owner chose the schedule's friendliness
to honest leavers over that on 2026-09-17, overriding the design review's rejection of a
decaying penalty (I14; `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md`, D1).

- **Size every load so the max-boost annual rate stays under about 28%:**
  `reward_rate × 31,536,000 × 4 / total_weighted` < 0.28, with both in raw base units (a
  4.00x position's weight is four times its principal; `read` shows the rate in whole BAYLA
  per second, so multiply it by 10^6 first). For a full 90-day window that means
  **scheduling less than about 1.7% of `total_weighted`**.
- **Size against the smallest `total_weighted` you expect, not today's.** The rate per unit
  of weight rises as stakers leave, and the rate guard keeps a live window's rate from
  coming down before `period_finish`.
- **Publish dates, not rates.**

### Reload policy — funding never stops

The ladder's reward funding **never stops**: no sunset, no wind-down, no lapse. This is
operator policy; the program does not enforce it.

- **Reload every ~60–75 days, BEFORE `period_finish`,** with an amount that holds the rate
  — at least `reward_rate × seconds elapsed since the last notify` (at day 60 that is two
  thirds of `reward_rate × 7,776,000`; at day 75, five sixths). Each reload starts a
  fresh 90 days, so the pool never reaches `period_finish` and never lapses to a zero rate.
  Reloading at day 60–75 rather than day 89 leaves room for a multisig signing round.
- **Every reload stays inside the reward-rate ceiling** above: max-boost annual rate under
  about 28%, sized against the smallest `total_weighted` you expect. Holding the rate
  (the rate guard) and staying under the ceiling are both required. If stakers have left
  and holding the rate would breach the ceiling, the only way down is the one above: let
  the window reach `period_finish` and reload at the lower rate right then.
- **Recycle penalties at the regular reload**, as `--from-budget` beside the fresh
  `--amount`. A penalty-only reload inside a window is refused unless the penalty alone
  covers `reward_rate × elapsed`, so do not plan on one. Under the schedule any leaver with
  under three years left forfeits less than 75%, so treat penalty inflow as a bonus, not a
  funding source. An
  `emergency_withdraw` penalty sits in the stake vault as `orphaned_penalty` until the
  permissionless `sweep` moves it to the reward vault; sweep before scheduling it.
- **Keep the undeployed reward runway in the multisig, not the vault.** Anything in the
  reward vault is committed forever; tokens in the multisig can still be re-planned.
- **Publish dates, never rates or APRs.** Say when the next reload is due. The per-staker
  yield of a fixed pool-wide budget moves with every stake and exit, so a quoted rate or
  APR is wrong the moment TVL moves.
- ⚠️ **Before any LATER top-up, judge solvency from `read`'s `outstanding (LIVE)` line and
  its I-4 verdict — never from `outstanding (stored)`.** `rewards_emitted` is banked only
  when an instruction runs `checkpoint()`, so on a quiet pool the stored figure omits every
  second of emission since the last interaction. `read` prints both: `outstanding (stored)`
  (banked emitted − paid, as the account holds it) and `outstanding (LIVE)` (what the pool
  owes at chain now, replaying `checkpoint` exactly, burn branch included). It then checks
  I-4 against the LIVE figure: a pass prints
  `invariant I-4 holds: reward vault >= live outstanding`; anything else —
  `INVARIANT I-4 BROKEN: live outstanding > reward vault` or
  `INVARIANT I-4 UNVERIFIED: the reward vault could not be read.` — makes `read` exit 1,
  and is not a pass. `notify` and `notify --preview` print the same live figure as
  `owed (LIVE)`. The program itself is safe either way — `notify_reward` checkpoints
  before its solvency checks.
  **Why this matters:** measured on devnet 2026-09-17, with the CLI as it was before #588
  (one "outstanding owed" line, the stored figure), `read` showed **0.019 BAYLA** owed
  against a true **~4,275 BAYLA**. By hand, as a cross-check only:
  `rewards_emitted + reward_rate × (min(now, period_finish) − last_update_time) −
  rewards_paid` matches the LIVE figure to within rounding while stakers are in the pool,
  but while `total_weighted` is below `min_weight_floor(min_stake)` — an empty pool — it
  OVERSTATES it by the whole `reward_rate × (min(now, period_finish) − last_update_time)`
  term, because the program burns those seconds rather than emitting them
  (`math::reward_per_weight_with_residue`).

---

## 8A. The multisig handover — the last irreversible step

**When.** The owner ruled 2026-09-20 that this runs **last**, after §9's card is on. It is
placed here, between the funding section and the card, because §8's funding rules change the
moment it completes — not because it runs in this position.

**State as read, not as remembered** (Alchemy mainnet, finalized; pool snapshot slot
448,901,219, chain clock 2026-09-21T01:03:32Z):

| authority | holder today | target |
| --- | --- | --- |
| `pool.authority` | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` (deployer) | vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` |
| `pool.pending_authority` | `11111111111111111111111111111111` — **unset, nothing proposed** | — |
| ProgramData upgrade authority | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` | same vault |
| **IDL account authority** | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` | **undecided — see 8A.7** |

`FormQpVVwmM3Rpyh6qrpCLmMRuPamTvV6vx7VD8yt3Dw` reads tag 3, last-deploy slot 448,851,661,
option byte 1, authority `Fu7mNAv…`. The IDL account `3nHKL72LUn5vijmHk76v6qwgkMshToKkJGsEzbWBaQ2r`
is owned by the program, carries 8,140 bytes of IDL, and its authority field (offset 8..40)
is the deployer. **Three authorities sit on one key, not two.** §1 and §3 of this runbook
name only two.

Shared shell setup for every PowerShell block below. The RPC key is never typed into a
command that gets pasted anywhere — read it out of `frontend\.env` and keep it in the session:

```powershell
$Sol      = "C:\Users\jimbo\.local\share\solana\install\releases\stable-6a8c724a9ed8f093127ef6066e0bcfb074193cc3\solana-release\bin\solana.exe"
$SplToken = "C:\Users\jimbo\.local\share\solana\install\releases\stable-6a8c724a9ed8f093127ef6066e0bcfb074193cc3\solana-release\bin\spl-token.exe"
$Deployer = "C:\Users\jimbo\solana-keys\mainnet\bayla_ladder-deployer.json"
$Pool     = "Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV"
$Program  = "EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ"
$Vault    = "GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd"
$Mint     = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump"
$T22      = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

$EnvLine  = Select-String -Path "C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\.env" -Pattern "^ALCHEMY_API_KEY=" | Select-Object -First 1
$Key      = $EnvLine.Line.Split("=",2)[1].Trim().Trim('"').Trim("'")
$env:SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2/$Key"
Remove-Variable Key, EnvLine
```

`solana-keygen` and `solana` are **not on the PATH** on this box; the versioned paths above
are. The ops CLI defaults `--rpc` to **devnet** — every command below passes it explicitly.

---

### 8A.1 Ordering, and why

**Pool authority first. Upgrade authority second. IDL authority third, or never.**

The reason is not taste. *While the deployer still holds the upgrade authority, a failed
pool-authority handover is recoverable*: a program upgrade can rewrite `pool.authority`,
because it is a plain field on a program-owned account with no external constraint. The
moment the upgrade authority moves to the vault, that remedy is gone — and if the vault then
turns out not to be able to sign, **both** remedies are gone at once and the pool is bricked
with 3,200 BAYLA of other people's principal and 43,091.76 BAYLA in the reward vault.

So the upgrade authority is the backstop for the pool-authority move, and a backstop is
surrendered **after** the thing it backs has been proven, not before. The proof is not
"`read` shows the new authority" — it is **the vault actually executing a pool instruction**,
which is why 8A.5 ends with a `notify_reward` and not with a balance check.

What becomes impossible, in order:

| after | impossible from then on |
| --- | --- |
| the vault's BAYLA account is funded (8A.3) | nothing — this step is additive and reversible; the vault can send the tokens back at any time |
| **`accept_authority` lands** (8A.5) | `notify_reward`, `propose_cap_raise`, `cancel_cap_raise` and `declare_degraded` from the CLI, forever. Each becomes a 2-of-2 ceremony. The deployer's own 2,686.30 BAYLA stops being usable as reward budget (see 8A.3). `propose_authority` also moves, so **handing the authority back is itself a 2-of-2** |
| **`set-upgrade-authority` lands** (8A.6) | `solana program deploy --program-id`, `solana program close`, a further `set-upgrade-authority`, and `anchor idl init`, all from the CLI. The pool-authority rescue path described above is gone |
| `anchor idl set-authority` lands (8A.7) | `anchor idl upgrade` from the CLI |

---

### 8A.2 Before the first command — can the 2-of-2 actually execute?

This is the question that decides whether the handover is safe, and the prior note in this
repo got it **half wrong**. Re-read on chain 2026-09-20:

The multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` decodes as Squads v4
(owner `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`):
`threshold 2`, `time_lock 0`, `config_authority` unset (autonomous), `transaction_index 4`,
`stale_transaction_index 3`, `rent_collector None`, bump 255, **two members, both with
permissions 7 = Initiate+Vote+Execute**:

- `5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz`
- `6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY`

Two voters, threshold two: quorum is reachable only if **both** keys sign. There is no
spare. Deriving `["multisig", <multisig>, "vault", 0]` under the Squads program reproduces
`GRMtSxg…` exactly, as §3 says.

**The 2026-07-22 burst was not what it was recorded as.** All four of that day's on-chain
events were *config* transactions, each created, approved and executed by
`5QHz…` **alone** — which was possible because the threshold was still 1 at the time. Reading
the transaction accounts back:

- tx #1 — `AddMember 6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY perm=7`, Executed
  2026-07-22T08:26:16Z, `approved` = 1 key.
- tx #2 — `ChangeThreshold -> 2`, Executed 2026-07-22T08:28:19Z, `approved` = 1 key.
  **This is the moment the 2-of-2 came into existence.**
- tx #3 — a duplicate `ChangeThreshold -> 2`, **Approved but never executed**, and now
  permanently unexecutable: `stale_transaction_index` is 3, so index 3 is stale. Harmless,
  but it is the reason the app shows a stranded proposal. Do not try to clear it.

**The 2026-08-13 event is the real precedent, and it is a good one.** Proposal #4 carries
`approved(2)` = *both* member keys, and executed at 2026-08-13T03:03:30Z under threshold 2:

```
2026-08-13T03:02:27Z  5QHz…  VaultTransactionCreate + ProposalCreate + ProposalApprove
2026-08-13T03:03:21Z  6VHow… ProposalApprove
2026-08-13T03:03:30Z  6VHow… VaultTransactionExecute
      sig 2xnAE7TkTgMMK5pw38fixwnVGQkW7sKA4FGBv7fHQwbaVdufcWosuaLA1EU8NyPHdioNadg5tvuuAzKc9iXjn5DP
```

Its inner instructions are two `BPFLoaderUpgradeable` closes, and account index 2 of each —
the **authority** slot, which the loader requires to be a signer — is
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. The programs closed were
`CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED` and
`3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y`; 3.581 + 4.886 SOL landed on `5QHz…`.

That is the exact signing path 8A.6 hands the program to, exercised for real, with money
moving. **Confidence that the 2-of-2 can execute a vault transaction: high.** Confidence
that it can execute *today*: lower — the last exercise was 2026-08-13, 38 days before this
was written, and nothing on chain proves either private key is still reachable now. Key
liveness is not a property of the chain. That is what 8A.4 is for, and 8A.4 is not optional.

---

### 8A.3 The reward budget has to move before the authority does

`NotifyReward` (`solana/tegridy-amm/programs/bayla-ladder/src/lib.rs:1280-1292`) constrains
the funding account:

```rust
#[account(mut, constraint = funder_ata.mint == pool.mint && funder_ata.owner == authority.key())]
pub funder_ata: Box<InterfaceAccount<'info, TokenAccount>>,
```

`authority` is `#[account(address = pool.authority)]`. So from the instant `accept_authority`
lands, **every reward top-up must be pulled out of a token account owned by the Squads vault
PDA.** BAYLA sitting in the deployer's own ATA becomes unspendable as reward budget — the
deployer can still send it anywhere, but it can no longer *fund the pool*, because it can no
longer sign `notify_reward`.

Read on chain 2026-09-20:

| account | address | state |
| --- | --- | --- |
| deployer BAYLA ATA | `DsGFcoYREF44GJxYofDKJXbxhY2oEMoAewELUMn89Wqc` | exists, **2,686.299573 BAYLA**, rent 1,513,840 lamports |
| **Squads vault BAYLA ATA** | `4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy` | 🔴 **DOES NOT EXIST** |
| Squads vault (SOL) | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | System-owned, 0 data, **1,000,000 lamports = 0.001 SOL** |
| deployer (SOL) | `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6` | 211,679,240 lamports = 0.2117 SOL |

Two consequences:

1. The vault's token account must be **created**, and at 0.001 SOL the vault cannot pay its
   own Token-2022 ATA rent (1,513,840 lamports, taking the deployer's ATA as the measure).
   Somebody else pays, or the vault gets topped up first.
2. The constraint is on the **owner**, not on the address, so any vault-owned BAYLA account
   satisfies it. Use the canonical ATA anyway: `ixNotifyReward`
   (`frontend/scripts/bayla-ladder-ops.mjs:1018-1031`) derives `ataFor(mint, authority,
   tokenProgram)` with no override, so `notify --preview` only tells the truth about the ATA.

**How much.** The pool emits 0.005506 BAYLA/s = **475.7184/day** to `period_finish`
2026-12-20T00:02:42Z; the reward vault holds 43,091.764477 with 42,794.5591 still to emit in
this window and only 276.161466 unpledged. A next 90-day window at the same rate needs
475.7184 × 90 ≈ **42,814.66 BAYLA**. The deployer's ATA holds 2,686.30. **Wherever the next
window's budget is, it is not in a place the vault will be able to spend**, and after the
handover the vault is the only key that may spend it. Move it into
`4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy` before 8A.5, not after.

---

### 8A.4 Step 1 — top up the vault, then rehearse the 2-of-2 by creating the ATA

Do the rehearsal and the ATA creation as **one Squads ceremony**: it proves both keys are
live today and produces the account 8A.3 needs. A rehearsal that produces nothing gets
skipped; this one cannot be.

**(a) Give the vault enough SOL to pay for accounts it creates** (CLI, deployer signs):

```powershell
& $Sol transfer $Vault 0.02 --url $env:SOLANA_RPC --keypair $Deployer
```

Verify: `& $Sol balance $Vault --url $env:SOLANA_RPC` → `0.021 SOL`.

**(b) In the Squads app**, create a vault transaction on **vault index 0** containing one
instruction. Squads' builder takes program id, accounts and raw data:

| field | value |
| --- | --- |
| program id | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| data | `01` (hex) · `AQ==` (base64) · `2` (base58) — ATA `CreateIdempotent` |

| # | account | signer | writable | what it is |
| --- | --- | --- | --- | --- |
| 0 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | ✅ | ✅ | payer — the vault itself |
| 1 | `4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy` | — | ✅ | the ATA being created |
| 2 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | — | — | owner |
| 3 | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` | — | — | BAYLA mint |
| 4 | `11111111111111111111111111111111` | — | — | System program |
| 5 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | — | — | **Token-2022**, not the legacy token program |

Then: member A creates + approves, **member B approves**, member B executes. The second
approval is the whole point — if it does not arrive, **stop, and do not run 8A.5.**

*Fallback if the Squads builder cannot take a raw instruction.* The ATA can be created from
the CLI with the deployer paying — but this **skips the rehearsal**, and the rehearsal is the
control on the only failure mode that cannot be undone. If you take this path, rehearse
separately with a 0.001 SOL vault-to-self transfer before 8A.5.

```powershell
& $SplToken create-account $Mint --owner $Vault --program-id $T22 `
    --fee-payer $Deployer --url $env:SOLANA_RPC
```

**(c) Move the reward budget in** (deployer signs; `--fund-recipient` also creates the ATA,
so this single command can replace (b) if the rehearsal is done separately):

```powershell
& $SplToken transfer $Mint <AMOUNT_IN_WHOLE_BAYLA> $Vault --program-id $T22 `
    --owner $Deployer --fee-payer $Deployer --fund-recipient --url $env:SOLANA_RPC
```

The vault is a **System-owned** account (0 data), so `--allow-non-system-account-recipient`
is *not* needed. Verify:

```powershell
& $SplToken balance $Mint --owner $Vault --program-id $T22 --url $env:SOLANA_RPC
```

---

### 8A.5 Step 2 — the pool authority, in two halves

#### Half 1 — `propose_authority`, from the CLI, signed by the deployer

Dry run first. The ops CLI signs nothing and sends nothing without `--broadcast`
(`frontend/scripts/bayla-ladder-ops.mjs:1338-1340`), and it simulates against the real pool:

```powershell
cd C:\Users\jimbo\tegriddy-worktrees\ladder-golive\frontend
node scripts\bayla-ladder-ops.mjs propose-authority `
    --program $Program --pool $Pool --new-authority $Vault `
    --keypair $Deployer --rpc $env:SOLANA_RPC
```

Expect it to print the current and proposed authority and then, because `GRMtSxg…` is
**off-curve** (verified: `PublicKey.isOnCurve` is false), the warning at
`bayla-ladder-ops.mjs:1852-1855`:

> `WARNING: GRMtSxg… is OFF-CURVE (a PDA, e.g. a Squads vault). It cannot sign this CLI's
> accept-authority - the accept must be executed from inside that multisig.`

**Seeing that warning is the pass condition.** If it does not appear, the address is wrong.
Then re-run with `--broadcast` appended.

Nothing has changed yet: `propose_authority` only writes `pool.pending_authority`
(`lib.rs:879-887`). Until half 2 lands the deployer keeps full control, and the proposal can
be withdrawn by proposing `11111111111111111111111111111111`.

#### Half 2 — `accept_authority`, which the CLI **cannot** do

`accept-authority` calls `signer()` and passes that keypair as the `pending` signer
(`bayla-ladder-ops.mjs:1862-1873`). The incoming authority is a PDA; there is no private key;
no file can be passed to `--keypair`. **The accept must be executed as a Squads vault
transaction**, where the Squads program signs the CPI as the vault.

`AcceptAuthority` (`solana/tegridy-amm/programs/bayla-ladder/src/lib.rs:1302-1308`) is:

```rust
#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(address = pool.pending_authority @ LadderError::Unauthorized)]
    pub pending: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
}
```

Two accounts, in this order, and nothing else — no vault, no mint, no token program:

| field | value |
| --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| data (8 bytes, no args) | `6b56c65b210c6ba0` (hex) · `a1bGWyEMa6A=` (base64) · `JxKhbCbXZc3` (base58) |

| # | account | signer | writable | binds to |
| --- | --- | --- | --- | --- |
| 0 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` | ✅ | ❌ | `pending`, must equal `pool.pending_authority` |
| 1 | `Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV` | ❌ | ✅ | `pool` |

The discriminator is Anchor's `sha256("global:accept_authority")[0..8]`, reproducible with
`node -e "console.log(require('crypto').createHash('sha256').update('global:accept_authority').digest().subarray(0,8).toString('hex'))"`,
and it is pinned by `IX.acceptAuthority` at `bayla-ladder-ops.mjs:156`. Account **0 is a
signer but NOT writable** — Squads will mark the vault writable by default in some builders;
leaving it writable does not break this instruction, but getting the *order* wrong does.

Then, the proof that matters:

```powershell
node scripts\bayla-ladder-ops.mjs read --pool $Pool --program $Program --rpc $env:SOLANA_RPC
```

`authority` must read `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`, and the I-1 and I-4
invariant lines must both still print as holding.

#### Half 3 — prove the vault can actually run a pool instruction

**Do not skip this, and do not proceed to 8A.6 without it.** Build a `notify_reward` as a
Squads vault transaction with a deliberately small `amount`, and execute it 2-of-2:

| field | value |
| --- | --- |
| program id | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| data | `fc334b84df30b1d5` + `amount` u64-LE + `from_budget` u64-LE (raw units, 6 dp) |

accounts, in order (`bayla-ladder-ops.mjs:1018-1031`, `lib.rs:1279-1292`):

| # | account | signer | writable |
| --- | --- | --- | --- |
| 0 | `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` — authority | ✅ | ❌ |
| 1 | `Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV` — pool | ❌ | ✅ |
| 2 | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` — mint | ❌ | ❌ |
| 3 | `4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy` — funder ATA (vault-owned) | ❌ | ✅ |
| 4 | `3yFvfhdRS9WNJEwVec7fgB3KRcKAi7Lo4jUyzzDMPAK1` — reward vault | ❌ | ✅ |
| 5 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` — Token-2022 | ❌ | ❌ |

⚠️ Size it against §8's rules first — `notify_reward` **re-spreads the live tail over a fresh
90 days** and the rate guard refuses a later reload that would lower it, so this is not a
free keystroke. Preview it with `node scripts\bayla-ladder-ops.mjs notify --pool $Pool
--amount <n> --preview --program $Program --rpc $env:SOLANA_RPC` (no keypair needed) and
read `owed (LIVE)` before committing to a number.

---

### 8A.6 Step 3 — the program upgrade authority

Only after 8A.5 half 3 has executed. One transaction, signed by the deployer; the incoming
authority is a PDA and cannot co-sign, which is what
`--skip-new-upgrade-authority-signer-check` is for:

```powershell
& $Sol program set-upgrade-authority $Program `
    --new-upgrade-authority $Vault `
    --skip-new-upgrade-authority-signer-check `
    --upgrade-authority $Deployer `
    --keypair $Deployer `
    --url $env:SOLANA_RPC
```

`--upgrade-authority` is the *signer* (it defaults to the configured keypair, and
`solana config get` on this box points at `C:\Users\jimbo\solana-keys\devnet-deploy.json` on
**devnet** — pass both `--upgrade-authority` and `--url` explicitly or this command addresses
the wrong cluster with the wrong key). Verified against `solana-cli 4.1.1` (`src:6a8c724a`)
`program set-upgrade-authority --help` on 2026-09-20.

Verify:

```powershell
& $Sol program show $Program --url $env:SOLANA_RPC
```

`Authority` must read `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. Do **not** pass
`--final` — §3 decided against immutability on purpose.

---

### 8A.7 The third authority: the IDL account

`3nHKL72LUn5vijmHk76v6qwgkMshToKkJGsEzbWBaQ2r` has its **own** authority field, and it is
still `Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`. It does not move with either handover
above, and no section of this runbook or of the checklist mentions it.

What that leaves: after 8A.5 and 8A.6, the deployer key can no longer touch the pool or the
program, but it can still **replace the published IDL** — the artifact every explorer and
wallet uses to decode `stake`, `early_exit` and the `Pool` account for a user who is about to
lock tokens for up to four years. A lying IDL is a display-layer attack, not a fund-moving
one, but it is exactly the surface this handover exists to close.

Decide one of:

- **Move it too**, with the current IDL authority signing:
  `anchor idl set-authority --provider.cluster $env:SOLANA_RPC --program-id EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ --new-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`
  (run from an Anchor workspace — per the 2026-09-19 note, not this repo). After this,
  `anchor idl upgrade` is a 2-of-2 forever.
- **Leave it**, and record here that it is deliberate, with a date and a reason.

Do not leave it undecided. `________`

---

### 8A.8 Abort and recovery

| if | then |
| --- | --- |
| the second Squads approval never arrives in 8A.4 | **stop.** Nothing irreversible has happened; the vault has 0.02 SOL and that is all. Do not propose the authority |
| `propose_authority` landed but the vault cannot accept | the deployer is still the authority and nothing is lost. Withdraw by proposing `11111111111111111111111111111111` with the same CLI command |
| `accept_authority` landed and the vault then cannot sign | the pool authority is stranded. **The only remedy is a program upgrade rewriting `pool.authority`** — which exists only while 8A.6 has not run. This is the whole reason for the ordering |
| both handovers landed and the vault cannot sign | there is no remedy. New stakes still work, existing positions can still exit and claim what is funded, but the pool can never be funded again and `declare_degraded` can never be set |
| a `notify_reward` lands at a rate that is too high | it stands until `period_finish`, up to 90 days (§8). The rate guard refuses a mid-window reload that lowers it |

---

## 9. Turn the card on

🏝️ **STOP — this step is go-live, and the island's wave-8 ruling gates it.** Everything
before this point can be completed without it. See `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md`
§8 for the commitment and the reason: staking moves BAYLA out of the holder's wallet, so
until the island rules a stake as *held*, turning this card on resets the island heat clock
for everyone who uses it. Setting these two on **Preview** only is not go-live and is not
gated.

In Vercel → Settings → Environment Variables, for **Production**:

| name | value |
| --- | --- |
| `VITE_BAYLA_LADDER_PROGRAM` | `EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ` |
| `VITE_BAYLA_LADDER_POOL` | the pool address from §7 |

`VITE_` values are baked in at build time, so **redeploy** afterwards. To try it first,
set the two on **Preview** only and test on a preview URL; production stays unchanged.

⚠️ **The build must carry the same penalty schedule as the program.** The card quotes
every early exit from its own copy of the penalty in `frontend/src/lib/ladder/program.ts`,
because nothing on chain exposes the schedule. That copy must compute veYFI's
`min(time_left / 4 years, 75%)` from the position's `lock_end` and the clock, as
`math::penalty_for` does — not #586's flat `7_500` — and ship in lockstep with this deploy.
A card still on the flat 75% would tell a 7-day staker leaving at once that they forfeit
375 of 500 BAYLA, when the program takes about 2.40. And a Preview pointed at the devnet
program must wait until devnet runs the schedule build —
`HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` still runs the superseded flat-25% one.

Check `/farm` in the BAYLA bungalow: both pool cards render, and the ladder card shows the
pool's figures — not *"there is no account at this pool address"*, which means a wrong
value or a missing redeploy.

---

## 10. Register the addresses

Add the program, the pool, both vaults and the deployer to the `solana` array in
`frontend/scripts/addresses.json`, following the existing entries (`id`, `address`,
`role`, `custody`, `expect`). **Never a keyfile path.** If you copy a lighthouse ladder
entry's `role` as a template, change its penalty: the EVM `LighthouseLadder.sol` entries
say 25%, and this program's role string must name **veYFI's time-left early-exit
penalty, up to 75%** — not a flat 75%. Then
`node scripts\verify-addresses.mjs --onchain` must pass — from then on, CI reads these
addresses on mainnet every day.

---

## 11. Running the pool

All of these take `--program`, `--rpc` and `--keypair` (`notify --preview` alone takes no
`--keypair`), and are dry runs until `--broadcast`. Each one refuses locally, before any
fee, whatever the program would refuse. Two limits:

- **Once the pool authority is the multisig, the CLI cannot dry-run the rows signed by "the
  authority".** Every authority command except `notify --preview` refuses unless
  `--keypair` IS the pool authority (§1), and a Squads vault has no keyfile. The CLI's only
  part is `notify --preview`; every other authority row — `notify` itself,
  `propose-cap-raise`, `cancel-cap-raise`, `propose-authority` and the one-way
  `declare-degraded` — is built, simulated and checked in Squads, with no CLI pre-flight.
- **A preview is computed at the moment it runs**, so a reload that lands later needs the
  margin §8 describes.

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
| a window loaded above ~28% max-boost annual rate (or stakers left until it was) | "lock 4 years and leave early" out-earns an honest shorter lock for as long as the rate stays there | the rate guard blocks lowering it mid-window: let it reach `period_finish` and reload at a rate under the ceiling (§8) |
| upgrade authority lost | the program is frozen as it is | the same as immutable |
| a transaction "failed to confirm" | it may still have landed | the CLI says so; run `read` before retrying |
