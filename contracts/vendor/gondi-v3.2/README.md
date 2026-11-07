# Gondi v3.2 — their NFT lending contracts, unchanged

This folder is **Gondi's code, not ours.** It is what our NFT lending runs on. Nothing in it
is edited, and the checks below prove it.

## What is here

| Path | What it is |
|---|---|
| `sources/` | Gondi's verified source for the loan contract, the liquidator, the liquidation distributor and the loan-manager registry. It is copied file for file from Sourcify's record of their mainnet deploys. |
| `sources-address-manager/` | The 2023 `AddressManager` (the allow-lists for currencies and collections). It has its own folder because the copy the loan contract imports is a later version of the same file. |
| `settings/` | For each contract: the exact compiler, settings and file list Gondi built with, plus their mainnet address and deploy transaction. |
| `build/` | The bytecode we deploy, built from `sources/` with `settings/`. `script/DeployGondiLending.s.sol` also pins each creation code by hash. |
| `build.mjs` | Rebuilds `build/` from source and checks it (see below). |
| `LICENSE-AGPL-3.0.txt` | The licence most of these files carry (see Licence). |

| Contract | Gondi's mainnet deploy | Deploy gas |
|---|---|---|
| MultiSourceLoan (v3.2) | `0xE365fF3cad44d19cb7aBa81df8ffd6818A66Ac0a` | 5,500,728 |
| AuctionWithBuyoutLoanLiquidator | `0xe6Ef33216348dDb2303a19Bb970e83d6508FabA5` | 2,507,790 |
| LiquidationDistributor | `0x1C495e474C63B5B095173ca0bd9DE1B9F002D75d` | 567,382 |
| AddressManager (×2: currencies, collections) | `0x4150deD32A6D3bfecAE76e7558Af480190344927`, `0x52Ac424eF7B283aA5bADB8c6254832E3280d7398` | 526,217 each |
| LoanManagerRegistry | `0x1e09403bE51029fE676e684743b6Aad2dAb7c9f5` | 220,745 |

**Not here, on purpose:** Gondi's Purchase Bundler, the "Sell & Repay" add-on behind their
exploit on 2026-03-09. NFTs locked in loans were not at risk then. We also don't use a
flash-action contract; Gondi's own live deploy doesn't either.

## How we know it is unchanged

```bash
node build.mjs                                  # source -> bytecode == build/ (CI runs this)
node build.mjs --mainnet https://eth.drpc.org   # ... and == Gondi's own mainnet deploys
```

`--mainnet` checks two things for every contract. Gondi's deploy transaction must start with our
creation code, byte for byte. Their live code must equal our runtime code, with only the
deploy-time values (immutables) masked. Last run on 2026-10-27, all six deploys matched.

It needs solc 0.8.19, 0.8.21 and 0.8.25, the versions Gondi used. Foundry installs one with
`forge build --use <version>` in any project.

## What is ours

Only the deploy settings in `script/DeployGondiLending.s.sol`. Every value there is Gondi's own,
read from their deploy transactions, except:

- **The protocol fee.** Our treasury gets 5% of the interest a lender earns. Gondi sends 20%
  to their own address. No Gondi address appears anywhere in this code, so no money can flow
  to Gondi.
- **The allow-lists.** The collections are Jungle Bay, Nakamigos and GNSS. The only currency
  is WETH.
- **The owner.** Ownership goes to our admin Safe.

`test/fork/GondiLendingForkRehearsal.t.sol` runs the deploy on a mainnet fork. Then a lender
signs, a real holder borrows, repays or defaults.

## Licence

Most of these files carry `SPDX-License-Identifier: AGPL-3.0` (38 files). The rest are MIT
(21) and CC0 (1), mostly the libraries Gondi uses. They keep their own licences, and the
AGPL text is in `LICENSE-AGPL-3.0.txt`. The deployed contracts' source is published by
verifying them on Etherscan/Sourcify. This is not legal advice.

## Updating

Don't edit these files. A new Gondi version is a new folder (`gondi-v<version>/`) fetched
the same way, from Sourcify's record of Gondi's own deploy:
`https://sourcify.dev/server/v2/contract/1/<address>?fields=stdJsonInput,compilation,deployment`.
