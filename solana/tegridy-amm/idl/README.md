# `idl/` — the committed interface descriptions

## Why anything is committed here

`anchor build` is the only thing that emits an IDL, and it **cannot run on the
operator's machine**: installing the SBF platform-tools needs a symlink privilege
Windows refuses (`os error 1314`). Every IDL this program has ever had was therefore
produced inside a GitHub runner.

`solana-ci`'s `ladder-constraints` job builds one and throws it away. The
`solana-deploy-artifact` workflow uploads one, and **GitHub deletes that artifact
after 30 days**. Until this directory existed, the only description of the deployed
program's interface had an expiry date — after which anyone wanting to call
`HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` would have had to reconstruct the
discriminators and account orderings by reading Rust.

---

## `bayla_ladder.json`

> **⚠️ The provenance table below describes the SUPERSEDED 25% build.** On 2026-09-17
> the program changed: the early-exit penalty went from a flat 25% to veYFI's schedule,
> `min(time left / 4 years, 75%)`, and
> `notify_reward` gained a guard that refuses to lower the rate inside a live window
> (new error `6028 RewardRateWouldDecrease`, appended last so no existing code moved).
> The committed file was edited BY HAND to match, because `anchor build` still cannot
> run on the operator's machine. It is not unchecked: `tools/check_committed_idl.py`
> compares it against the IDL CI builds from that source on every run, so a hand-edit
> that disagrees with the program fails there.
>
> So the sha256 and source commit below no longer hash to this file, and devnet
> `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` still runs the 25% binary until it is
> upgraded. Replace the table (see **Refreshing it**) from the first
> `solana-deploy-artifact` run built on the new source.

| | |
| --- | --- |
| sha256 | `187b405ac81b5350cab025621f9314da4701dd40948fdb09de437ab35128c190` |
| emitted by | `anchor build -p bayla_ladder -- --features devnet`, Anchor 0.32.1, Solana 2.3.0 |
| workflow run | [`34336193019`](https://github.com/fomotsar-commits/tegridy-farms/actions/runs/34336193019) (`solana-deploy-artifact`, `bayla-ladder` / `devnet`) |
| source commit | `ee73bb359688f73bab50105c81eaf431a222757f` |
| `address` | `HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK` |
| `initialize_pool.payer` pin | `Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj` (`deployer::ID`, devnet arm) |

### How this file was shown to describe the DEPLOYED program

Not by assertion — by hashing both ends of the chain:

1. **The deployed devnet program dumps to the artifact's binary, byte for byte.**

   ```console
   $ solana program show HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK --url devnet
   ProgramData Address: 5tQkt7P5yCSGdiy7PgdTaGf2T87D3tcwc7f38LbeJhG2
   Data Length: 512504 (0x7d1f8) bytes

   $ solana program dump HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK onchain.so --url devnet
   $ sha256sum onchain.so
   3e1b2b7b68292d92ef83e479a938c49aeda3480d4a3bbc58500cf166f6061ebd
   ```

   The artifact's own `bayla_ladder.so.sha256`, written by the runner that built it,
   is the **same** `3e1b2b7b…`, and the on-chain `Data Length` equals the artifact's
   512 504 bytes exactly (it was deployed with `--max-len 512504`).

2. **This IDL came out of that same `anchor build`**, in that same run, from that
   same compile — so it describes the binary hashed above rather than a rebuild that
   merely resembles it.

3. **That build's source is trunk's source.** `solana/tegridy-amm/programs/bayla-ladder`
   has identical git blob hashes at `ee73bb35` and at trunk; only the runbook and this
   workflow's comments moved in between.

The one thing NOT verified this way is the IDL's own bytes against the chain: an
Anchor IDL is not written on-chain by `solana program deploy`, so there is no
published copy to compare against. The correspondence argument is the binary hash
plus same-compile provenance, above.

**And the build reproduces.** Run `34312743243` built this same program source (the
`programs/bayla-ladder` blob hashes at `133a9a22` and `ee73bb35` are identical) on a
different day, against a different program id and a different deployer. Its IDL's raw
sha256 is `3e22b6ad…` — different, as it must be, because those two identities are in
the file. Put the two through `tools/check_committed_idl.py` and they are otherwise
**byte-identical**. That is the guard below tested against a real independent rebuild
rather than a synthetic one: it does not false-positive on a legitimate re-issue, and
the IDL is reproducible from source rather than an accident of one runner.

### It is the DEVNET build's IDL

Two fields are patched per build and differ in a mainnet artifact — `address`
(`declare_id!`) and `initialize_pool.payer.address` (`deployer::ID`, which is
cfg-gated and is the fail-closed `1111…` sentinel in a default build). **Nothing
else is build-dependent**: `cfg(feature = "devnet")` appears at exactly two sites in
`programs/bayla-ladder/src/lib.rs`, the two `deployer::ID` arms and one inside
`mod tests`. Every discriminator, account name, ordering, flag, arg, event, error
and type here is the same in either cluster.

So a client may use this file today; a **mainnet** deploy must replace those two
fields (or re-commit the mainnet artifact's IDL) before pointing a client at it.

### What keeps it honest

Two gates, because a committed generated file that nothing checks is a file that
silently goes stale:

* **`tools/check_committed_idl.py`**, run by `solana-ci`'s `ladder-constraints` job
  against the IDL that job has *just built*. It normalises the two patched
  identities — having first asserted both are present and that the deployer is
  neither absent nor equal to the program id — and deep-compares everything else.
* **`frontend/scripts/bayla-ladder-ops.test.mjs`**, which now reads this file
  instead of transcribing it. The operator CLI's discriminators, account orderings,
  signer/writable flags and arg lengths are checked against it on every frontend
  test run.

### Refreshing it

```bash
gh workflow run solana-deploy-artifact.yml \
  -f program=bayla-ladder -f cluster=devnet \
  -f program_id=<program id> -f deployer=<deployer wallet>
gh run download <run-id>          # -> idl/bayla_ladder.json
cp idl/bayla_ladder.json solana/tegridy-amm/idl/bayla_ladder.json
```

Then update the table above — the run id and source commit are the provenance, and a
hash with no run behind it is decoration.

---

## `tegridy_launch.json` and `raydium_cp_swap.json`

`tegridy_launch.json` is the IDL emitted with the **exact mainnet binary** of the 2026-09-26
Solana launcher restart (`tegridy_launch.mainnet.so` sha256 `a3c41afa…`, the
reserve-at-create build), copied byte for byte from that release's `artifacts/` folder.
`raydium_cp_swap.json` was that release's pool IDL (emitted with `cp_swap.mainnet.so`),
byte for byte, until 2026-10-06; since then it has one more instruction (next paragraph), and
since the pool program's upgrade it is again the IDL of the binary mainnet runs. The
earlier `tegridy_launch.json` (`d987fafe…`, from the reserve-held `9b78be02…` build) is
superseded: that program had `release_platform_reserve` and an 8-account `create_launch`. Their `address` fields are the registered restart ids
(`64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2`, `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`).
Both programs have been live on mainnet at those ids since 2026-09-29. No IDL has been
written on chain.

**`raydium_cp_swap.json` is the IDL of the pool program mainnet runs since its upgrade.** It
was re-emitted on 2026-10-06 with `anchor idl build -p raydium_cp_swap` (anchor-cli 0.32.1,
in WSL, no features) from the source that adds `create_lp_metadata`, the instruction that
gives a pool's lp token a name record. From that day until the upgrade
(`MAINNET_RUNBOOK.md`, section 4b) it was one instruction ahead of the binary on mainnet.
The upgrade installed the build made from that same source (sha256 `99a9e73d…`), so the two
agree again. Everything else in the file is as it was before: take that one instruction
out, write the rest back as two-space JSON, and the result hashes to `939bc040…`, the IDL of
the build mainnet ran until the upgrade. The same command run on the source before the
change reproduces `939bc040…` exactly, which is the control for the new value.

| file | sha256 | what it is |
| --- | --- | --- |
| `tegridy_launch.json` | `cd9e173c666940f82222a2798dc1c5bc0cf30edf7b32450530e65aa523a3cb31` | the release's `artifacts/SHA256SUMS` |
| `raydium_cp_swap.json` | `1e8fd7928c0fce6788b880703a1cbfc932e808ab5acadfd5217eb637d739f736` | the IDL of the upgraded pool program: the 2026-09-26 release's IDL (`939bc040fa0f65b6639f07545be9d23fde0492e9b5fc3d90229a313b0fcf0262`) plus `create_lp_metadata` |

**What keeps them honest:** `frontend/src/lib/launcher/solana/write/idl.test.ts` pins both
hashes, then holds every instruction the /curve-launch write path can send
(`create_launch`, 11 accounts including the treasury's token account that receives the
platform reserve, + its trailing launch-index key, `buy`, `sell`, `migrate_to_amm`, cp-swap
`swap_base_input`) against them, position by position:
account name → address, signer and writable flags, discriminator, argument order. It also
requires the frontend's error tables to equal the IDLs' code for code. A changed program
means a new IDL here, a new hash in that test, and whatever the parity check then says.
For the pool IDL it also holds the two facts above: the file minus `create_lp_metadata` is
the release's IDL byte for byte, and `create_lp_metadata` takes no argument and names nine
accounts with only the payer signing. `frontend/scripts/solana-localnet/genesis-accounts.mjs`
carries the same pin in `PINNED_SHA256`: one pin for this file and for the copy of it the
local harness keeps beside the upgraded binary.
