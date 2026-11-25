# VWAP order program: how it would be deployed

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). The program and its design:
> [docs/VWAP_ORDER_PROGRAM.md](VWAP_ORDER_PROGRAM.md). Nothing here has been run.

Every step that holds a key or moves SOL is the owner's, on the owner's word, by hand. A session
never makes the key, never holds it, and never sends on mainnet.

## Before any step

1. **The in-house audit of 2026-11-24** (owner, 2026-11-21: "plan an audit for this by us for
   tuesday"), and every finding fixed in source with a test that fails first, on the program's
   branch. Said plainly: an audit by our own reviewers is not an outside audit, and the program
   stays our own code, not copied proven code.
2. The owner's word to merge pull request #1302. Merging moves `mvp-launch`, which counts as a
   production deploy (CLAUDE.md law 15), though the pull request changes no site file.
3. The owner's word to deploy, and one choice made before it: who may upgrade the program
   (step 6).

## The steps

### 1. The program's key (owner, on the owner's computer)

```powershell
solana-keygen new --no-bip39-passphrase --outfile "<your keys folder>\vwap_order-program-keypair.json"
```

It only claims the address at the first deploy, and is inert after it. Keep it with the other
program keys, never in the repo. Its address is the program id in every step below.

### 2. The key check names this program (a pull request of its own)

On trunk after #1302: `solana/guards/allowed-keys.json` gets the committed placeholder
`VwapPLACEHo1DERnotDep1oyed11111111111111111` under "ours" (as bayla-ladder's placeholder is), the
key-guard step of `solana-ci.yml` gains `--ours solana/vwap-order`, and the `vwap-order` job drops
the placeholder it names alone today. A guard change may touch nothing else (`provenance.mjs
--pr-files`).

### 3. Build the binary from trunk (anyone may start it; it holds no key)

```powershell
gh workflow run solana-deploy-artifact.yml --ref mvp-launch -f program=vwap-order -f cluster=mainnet -f program_id=<PROGRAM_ID>
```

The `vwap-order-deployable` job refuses a malformed id or the placeholder, pins the id in the one
`declare_id!` and fails if the source differs from the commit by anything else, builds with
Solana 2.3.0, refuses a stack-frame overflow or a binary without its security text, and publishes
`vwap_order.so` with its sha256 and size. Download it and check the file's hash against the run's
summary:

```powershell
gh run download <RUN_ID> -n vwap-order-mainnet-<COMMIT>
```

```powershell
Get-FileHash vwap_order.so -Algorithm SHA256
```

### 4. Fund the deployer wallet (owner)

The deployer pays the program's rent and is its upgrade authority until step 6. Its key never
goes to CI. Ask the chain the day of the deploy:

```powershell
solana rent <SIZE + 45> --url https://api.mainnet-beta.solana.com
```

Read 2026-11-21 for that day's build (341,976 bytes): 1,738,116,920 lamports for the program's data
and 833,120 for the program account, so about 1.739 SOL. The audit's fixes of 2026-11-24 made the
build 358,512 bytes: at the same rate, 1,822,119,800 + 833,120 lamports, about 1.823 SOL (worked
out, not read again). Read it again on the day, and send about 0.02 SOL more than it says to
leave room for the upload's transaction fees.

### 5. Deploy (owner)

```powershell
solana program deploy vwap_order.so --program-id "<your keys folder>\vwap_order-program-keypair.json" --keypair <DEPLOYER_KEYPAIR> --max-len <SIZE> --with-compute-unit-price 100000 --url https://api.mainnet-beta.solana.com
```

`--max-len` is the file's size: a larger account costs more rent, and an upgrade can extend it
later. If the upload stops part way, its SOL waits in a buffer: `solana program show --buffers`
lists it and `solana program close --buffers` returns it to the deployer.

### 6. Hand over who may upgrade it (owner, straight after step 5)

Whoever may upgrade it can replace it and take every escrow, so the deployer keeps that power
for minutes only. Recommended: the venue's Squads vault, whose 48-hour lock gives people time to
close their orders before any upgrade lands:

```powershell
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd --skip-new-upgrade-authority-signer-check --keypair <DEPLOYER_KEYPAIR> --url https://api.mainnet-beta.solana.com
```

The other choice is nobody (`--final` instead of `--new-upgrade-authority ...`): then a bug can
never be fixed, only avoided, and the 1.74 SOL of rent can never come back.

### 7. Check it (read-only, anyone)

```powershell
solana program show <PROGRAM_ID> --url https://api.mainnet-beta.solana.com
```

Authority must be the vault (or none), Data Length the file's size. Then dump it and compare the
first `<SIZE>` bytes' sha256 with the artifact's, and read its security text on an explorer. The
program has no IDL instructions, so there is no IDL record to claim (test
`nobody_can_claim_the_programs_idl_record`).

### 8. Record it (a pull request)

Two rows in `frontend/scripts/addresses.json`: the program (`expect` executable) and its program
data account, with the build's hash, as cp-swap's rows carry theirs.

## What the deploy alone does not give anyone

Nobody can place an order until two more pieces exist, each its own piece of work after the
audit: the site's open and close screens (one transaction each; SOL wrapped and unwrapped inside
it), and the keeper's slice loop on a key of its own, never the price robot's (the program refuses
the pool's keeper). Until then the program sits unused and costs nothing beyond its rent.
