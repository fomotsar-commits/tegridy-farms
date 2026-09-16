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
