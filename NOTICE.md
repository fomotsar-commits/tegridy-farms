# NOTICE — Third-Party Attributions & Fair Use

Tegridy Farms is licensed under the MIT License (see [LICENSE](LICENSE)), with **three carve-outs**: `solana/tegridy-amm/` is Apache-2.0 (see [`solana/tegridy-amm/LICENSE`](solana/tegridy-amm/LICENSE)) because it derives from Apache-2.0 upstream, so is `solana/tegridy-clmm/` (see [`solana/tegridy-clmm/LICENSE`](solana/tegridy-clmm/LICENSE)), whose `vendor/uint` is MIT or Apache-2.0, and the **airdrop module is GPL-3.0-or-later** because it derives from Uniswap's `merkle-distributor` — see the row below and the per-file SPDX list under [SPDX coverage](#spdx-coverage). This file documents third-party code, design patterns, intellectual property considerations, and fair-use rationale for the project.

## Smart contract code & patterns

| Component | Source | License | Attribution |
|---|---|---|---|
| **Raydium CP-Swap (CPMM)** | [raydium-io/raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) @ `78f254e` | **Apache-2.0** | [`solana/tegridy-amm/programs/cp-swap/`](solana/tegridy-amm/programs/cp-swap/) is a fork. **Changes made (Apache-2.0 §4(b)):** four authority/identity constants (the program id in `lib.rs` and the admin / fee-receiver / support-mint-owner constants), the program's own name and contact text (the `security_txt!` block in `lib.rs` and the `description` line of `Cargo.toml`) and, since 2026-10-06, one added instruction in `lib.rs`, `create_lp_metadata`, which creates the Metaplex name record of a pool's lp token; its two helpers are adapted from [raydium-io/raydium-clmm](https://github.com/raydium-io/raydium-clmm) @ `ed7c84a` `programs/amm/src/instructions/open_position.rs` (Apache-2.0); and, since 2026-10-19, one added check in `instructions/initialize.rs`: the public `initialize` refuses fee tier 0, the launch tier, so only graduations (through `initialize_with_permission`) open pools on it. As of 2026-10-28 mainnet runs the 2026-09-29 build, which has neither addition (rolled back 2026-10-24; see [`TEGRIDY_FORK.md`](solana/tegridy-amm/TEGRIDY_FORK.md)). All swap, curve and fee math is unmodified. The delta is enforced by the `diff-guard` job in `.github/workflows/solana-ci.yml`. Apache-2.0 text retained at [`solana/tegridy-amm/LICENSE`](solana/tegridy-amm/LICENSE). **Upstream's MadShield audit and Raydium's Immunefi bounty do NOT cover this fork.** |
| **Raydium CLMM concentrated-liquidity math** | [raydium-io/raydium-clmm](https://github.com/raydium-io/raydium-clmm) @ `bf7c241` | **Apache-2.0** | ⚠️ **NO LONGER VENDORED — removed 2026-08-23.** Seven library files (`big_num`, `fixed_point_64`, `full_math`, `liquidity_math`, `sqrt_price_math`, `tick_math`, `unsafe_math`) lived at `solana/tegridy-amm/programs/tegridy-launch/src/vendor/` to price the segmented bonding curve. Segmented mode was deleted before the redeploy (it carried two HIGH audit findings), and the vendored maths went with it — ~1,495 lines that upstream's audits did not cover. The `clmm-vendor-guard` CI job that enforced the delta was removed in the same change, since it guarded a directory that no longer exists. Kept in this table as the record of code that WAS shipped. Since 2026-10-14 the whole program is copied again, as `solana/tegridy-clmm/` (next row). |
| **Raydium CLMM (range pools)** | [raydium-io/raydium-clmm](https://github.com/raydium-io/raydium-clmm) @ `ed1eb41` | **Apache-2.0** | [`solana/tegridy-clmm/`](solana/tegridy-clmm/) is a copy, deployed on Solana mainnet as program `7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso`. **Changes made (Apache-2.0 §4(b)):** every address upstream hard-codes for itself (program id, admin and fee roles) is the venue's, the program's name, contact, memos and position-NFT name and link are the venue's, the frozen-NFT issuer list is empty, and two build gates refuse a placeholder-id or test-chain build. Since 2026-10-20 (the owner's ruling), three admin powers are cut: only a fee tier's fund owner can collect its fund fees (`collect_fund_fee.rs` drops the admin bypass); fees have ceilings, the trade fee at most 4% of a swap (`MAX_FEE_RATE_NUMERATOR`, upstream 10%) and the protocol and fund shares together at most 16% of each fee (`MAX_PROTOCOL_AND_FUND_FEE_RATE`, checked in `create_amm_config.rs` and `update_amm_config.rs`); and `transfer_reward_owner.rs` moves the pool's owner only, no longer each reward's authority. Since 2026-10-25, every instruction that opens a pool charges a 0.5 SOL opening fee, paid to the vault (`CREATE_POOL_FEE` in `lib.rs`, `charge_create_pool_fee` in `util/system.rs`); as of 2026-10-28 the deployed program does not have it yet, and gets it at its next upgrade. Every other program file is unmodified. Enforced by `solana/guards/provenance.mjs` (the `clmm-guards` job). Apache-2.0 text retained at [`solana/tegridy-clmm/LICENSE`](solana/tegridy-clmm/LICENSE). Its `vendor/uint` is [raydium-io/parity-common](https://github.com/raydium-io/parity-common) @ `43a0303` `uint/` (MIT OR Apache-2.0, a fork of Parity's `uint` 0.9.5), unmodified, with both licence texts. **No audit of upstream covers this copy.** |
| **Uniswap `merkle-distributor`** | [Uniswap/merkle-distributor](https://github.com/Uniswap/merkle-distributor) @ `25a79e8e` (2022-11-21, “specify gpl license”) | **GPL-3.0-or-later** | ⚠️ **This is a copyleft carve-out from the repo's MIT default — read before shipping the airdrop rail.** [`contracts/src/vendor/uniswap-merkle-distributor/`](contracts/src/vendor/uniswap-merkle-distributor/) is a verbatim vendor of `MerkleDistributor.sol` and `interfaces/IMerkleDistributor.sol`. **Changes made:** exactly one — `pragma solidity =0.8.17` widened to `^0.8.17` so it compiles under the repo's pinned `solc = 0.8.26`; the interface file is byte-identical. Verification recipe and expected diff: [`contracts/src/vendor/uniswap-merkle-distributor/VENDOR.md`](contracts/src/vendor/uniswap-merkle-distributor/VENDOR.md) — note this vendor is **not** covered by the `v2-provenance` job (`scripts/check-v2-provenance.mjs` pins only the v2 and StakingRewards vendors), so its recipe is run by hand. Everything that inherits from or instantiates it inherits the licence — see the SPDX list below. An earlier build note called this upstream MIT; that note predates the relicense commit named here. |
| **OpenZeppelin Contracts** | [OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | MIT | Imported via npm/Foundry. Used for ERC20, ERC721, ReentrancyGuard, Pausable, SafeERC20, etc. Licence inherited. |
| **Synthetix StakingRewards** | Synthetix, vendored via [Uniswap/liquidity-staker](https://github.com/Uniswap/liquidity-staker) @ `3edce550` | MIT | Three uses. (a) *Pattern:* [`TegridyLPFarming.sol`](contracts/src/TegridyLPFarming.sol) adapts the StakingRewards reward-math pattern; attribution in source comment. (b) *Verbatim vendor:* [`contracts/src/vendor/synthetix-staking-rewards/`](contracts/src/vendor/synthetix-staking-rewards/) carries `StakingRewards.sol`, `RewardsDistributionRecipient.sol` and `interfaces/IStakingRewards.sol` copied from the pin above, with a 0.8-compiler bridge as the only divergence — mechanically pinned by `contracts/provenance/expected/*.expected.diff` and the `v2-provenance` job in `.github/workflows/contracts-ci.yml` (`scripts/check-v2-provenance.mjs:143-178`), so any further edit goes red. Provenance and the exact delta: [`contracts/src/vendor/synthetix-staking-rewards/VENDOR.md`](contracts/src/vendor/synthetix-staking-rewards/VENDOR.md). The pin is Uniswap's copy because `Synthetixio/synthetix` v2 returned 404 on GitHub when it was taken (2026-08-30); the underlying work is MIT (verified against the `synthetix` npm package's `license` field). (c) *Fork:* [`LighthouseLadder.sol`](contracts/src/LighthouseLadder.sol), the island's EVM lock ladder, is the vendored `StakingRewards` with exactly two expressions changed (`rewardPerToken()` divides by `_totalBoosted`, `earned()` multiplies by `_boosted[account]`), plus its own lock ledger beside it; attribution in source comment. |
| **Yearn veYFI early-exit penalty** *(formula only, no code)* | [yearn/veYFI](https://github.com/yearn/veYFI) `contracts/VotingYFI.vy` | MIT (`@license MIT`; authors Curve Finance, Yearn Finance) | The early-exit penalty of [`LighthouseLadder.sol`](contracts/src/LighthouseLadder.sol) and of the Solana BAYLA ladder ([`bayla-ladder/src/math.rs`](solana/tegridy-amm/programs/bayla-ladder/src/math.rs), `penalty_for`) is veYFI's schedule: the time left on the lock over four years, capped at 75%, on veYFI's `SCALE` of 1e18. Written again in Solidity and Rust; no Vyper source is copied. |
| **Curve GaugeController** | [curvefi/curve-dao-contracts](https://github.com/curvefi/curve-dao-contracts) | MIT | ⚠️ **Deleted 2026-10-27** with 20 other dead EVM contracts (PR #1041). `contracts/src/GaugeController.sol` adapted Curve's gauge-voting + emission-direction pattern; attribution was in its source comment. Kept in this table as the record of code that was shipped. |
| **Meteora Dynamic Bonding Curve** *(design only — no code)* | Meteora's **public documentation** | Meteora's program source is under a **non-commercial** licence | ⚠️ **PROVENANCE RECORD — read before assuming a clean-room claim.** The retired segmented curve mode implemented a 16-point `(sqrt_price, liquidity)` shape described in Meteora's public docs. **Nothing was derived from Meteora's program source**, deliberately: that source is non-commercially licensed ([`docs/CURVE_FORK_EVALUATION.md`](docs/CURVE_FORK_EVALUATION.md)), so paraphrasing it would risk a derivative-work claim. Concepts are not protectable; their expression is — and the expression shipped was Raydium's Apache-2.0 maths plus our own segment loop. This paragraph was the header of `programs/tegridy-launch/src/segmented.rs`, deleted 2026-08-23; it is preserved here because deleting the legal defence alongside the code is how a derivative-work claim becomes hard to answer. The Meteora DBC *rail* was separately retired the same day. |
| **Uniswap V2 core + periphery** | [Uniswap/v2-core](https://github.com/Uniswap/v2-core), [Uniswap/v2-periphery](https://github.com/Uniswap/v2-periphery) | GPL-3.0 (core and periphery) | [`TegridyFactory.sol`](contracts/src/TegridyFactory.sol), [`TegridyPair.sol`](contracts/src/TegridyPair.sol), [`TegridyRouter.sol`](contracts/src/TegridyRouter.sol) adapt the V2 AMM architecture. Both upstream repositories are GPL-3.0, read from their LICENSE files (the License note in [`contracts/provenance/PROVENANCE.md`](contracts/provenance/PROVENANCE.md)); BUSL-1.1 is Uniswap V3's licence, not V2's. These three files carry the repository's default `SPDX-License-Identifier: MIT` header. Attribution in source comments. |
| **Uniswap V4 + OpenZeppelin `uniswap-hooks`** | [Uniswap/v4-core](https://github.com/Uniswap/v4-core) @ `d153b04` (git submodule); [OpenZeppelin/uniswap-hooks](https://github.com/OpenZeppelin/uniswap-hooks) v1.1.1, vendored at [`contracts/lib/uniswap-hooks/`](contracts/lib/uniswap-hooks/) | MIT (`uniswap-hooks`; and each v4-core file the hook imports directly declares MIT) | [`TegridyV4Hook.sol`](contracts/src/v4/TegridyV4Hook.sol) inherits OZ's `LiquidityPenaltyHook` unchanged and uses its `CurrencySettler`. Its fee module is a verbatim copy of OZ's `BaseOverrideFee`, which cannot be inherited alongside `LiquidityPenaltyHook` ([`contracts/V4_MIGRATION_PLAN.md`](contracts/V4_MIGRATION_PLAN.md)), and its `_afterSwap` skim copies the mechanics of OZ's `BaseDynamicAfterFee._afterSwap`. Licence text retained at [`contracts/lib/uniswap-hooks/LICENSE`](contracts/lib/uniswap-hooks/LICENSE). |
| **Solmate / Solady patterns** | Various | MIT | Minor utility helpers may reference these gas-optimised patterns. Licence inherited (MIT). |

### SPDX coverage

Every Solidity file under `contracts/src/` (which includes `contracts/src/base/`) declares an SPDX header — 52 files, 52 headers, re-counted 2026-10-28.

**But MIT is the default, not the rule.** The previous wording of this section said every one of them declares MIT; that was wrong. Seven files across `contracts/` declare `GPL-3.0-or-later`, and a counterparty who reads MIT across the tree will be wrong about the airdrop rail and the TWAP oracle library. The complete list, as declared in the files themselves:

| File | Why it is GPL-3.0-or-later |
|---|---|
| `contracts/src/vendor/uniswap-merkle-distributor/MerkleDistributor.sol` | Verbatim vendor of GPL-3.0-or-later upstream |
| `contracts/src/vendor/uniswap-merkle-distributor/interfaces/IMerkleDistributor.sol` | Verbatim vendor of GPL-3.0-or-later upstream |
| `contracts/src/TegridyAirdropDistributor.sol` | Derives from `MerkleDistributor` |
| `contracts/test/AirdropMerkleVector.t.sol` | Test of the above |
| `contracts/test/invariants/AirdropDistributorInvariants.t.sol` | Test of the above |
| `contracts/test/TegridyNativeBuyRouter.t.sol` | ⚠️ Unexplained — the contract it tests (`contracts/src/TegridyNativeBuyRouter.sol:1`) declares MIT, and this test imports nothing GPL. Recorded as declared, not endorsed; likely a copied header, and a candidate to correct to MIT |
| `contracts/src/lib/UniswapV2OracleLibrary.sol` | Verbatim 0.8 port of Uniswap **v2-periphery** (GPL-3.0-or-later), commit `ed249913` |

Regenerate this list rather than trusting it:

```
grep -rl 'SPDX-License-Identifier: GPL' contracts --include='*.sol' | grep -v '^contracts/lib/'
```

**Operator decision, still open.** [`contracts/src/vendor/uniswap-merkle-distributor/VENDOR.md`](contracts/src/vendor/uniswap-merkle-distributor/VENDOR.md) states the choice: either accept GPL-3.0-or-later on the airdrop module — which this file now records — or replace the base with an MIT-licensed merkle-claim implementation before deploy. Recording it here is not the same as choosing it; the deploy decision is the operator's.

### Verification

The live on-chain contracts are verified on Etherscan. Readers should treat Etherscan-verified source as the canonical reference when auditing. Any divergence between the repo and Etherscan should be reported via [SECURITY.md](SECURITY.md) disclosure process.

---

## Frontend & tooling dependencies

| Package | Licence | Use |
|---|---|---|
| React, React-DOM | MIT | UI framework |
| Vite | MIT | Build tool |
| wagmi, viem | MIT | Ethereum client libraries |
| RainbowKit | MIT | Wallet connection |
| Tailwind CSS | MIT | Styling |
| Framer Motion | MIT | Animation |
| Sonner | MIT | Toast notifications |
| Supabase JS | Apache-2.0 | Backend client |

Full frontend dependency tree is declared in [`frontend/package.json`](frontend/package.json). Each package retains its own licence.

### Code copied into the site

| File | Source | Licence | What was copied |
|---|---|---|---|
| [`frontend/src/lib/solana/cpswap/math.ts`](frontend/src/lib/solana/cpswap/math.ts) | Our CP-Swap fork's `curve/` files and `states/pool.rs`, which are Raydium's code (row above) | Apache-2.0 | A BigInt port, line for line, of the program's swap and LP maths, so the site quotes what the program executes. |
| [`frontend/src/lib/solana/clmm/math.ts`](frontend/src/lib/solana/clmm/math.ts) | Our CLMM copy's `libraries/` (`tick_math`, `sqrt_price_math`, `liquidity_math`, `full_math`, `swap_math`) and `states/tick_array.rs`, which are Raydium's code | Apache-2.0 | A BigInt port by hand, line for line. Raydium's SDK is GPL-3.0 and is never read for this file. |
| [`frontend/src/lib/rainbowkitWallets.ts`](frontend/src/lib/rainbowkitWallets.ts) | `@rainbow-me/rainbowkit` 2.2.11 | MIT | The `phantomWallet` and `trustWallet` definitions and the two helpers they use, copied verbatim and typed, because importing the package's wallet list breaks the production build. |
| [`frontend/src/styles/wallet-adapter-ui.css`](frontend/src/styles/wallet-adapter-ui.css) | `@solana/wallet-adapter-react-ui` 0.9.x `styles.css` ([anza-xyz/wallet-adapter](https://github.com/anza-xyz/wallet-adapter)) | Apache-2.0 | The wallet modal's styles, with the Google Fonts `@import` removed (the CSP blocks it). |

---

## Indexer

[`indexer/`](indexer/) uses **Ponder** (MIT) for event indexing.

---

## Brand, IP & fair-use statement

### "Tegridy Farms" / "Randy Marsh" / "Towelie" / "Cartman" references

The Tegridy Farms protocol name, marketing voice, and in-product microcopy (including references to Randy Marsh, Towelie, DEA, "for the kids' college fund," "Cartman's Market," etc.) are a **satirical and transformative parody** of themes from *South Park*, a television series produced by South Park Studios (owned by Paramount Global).

- **Transformative use:** The references recontextualize satirical fiction about "fake integrity in weed farming" into a DeFi protocol satirising emission-inflation and yield-farming norms. The use is commentary on DeFi culture rather than reproduction of any *South Park* story, character art, or scripted content.
- **Non-competitive:** Tegridy Farms does not sell merchandise, stream video, or compete with any Paramount Global media property.
- **No implied endorsement:** Nothing in the protocol implies that Paramount Global, Comedy Central, South Park Studios, Trey Parker, or Matt Stone endorse, sponsor, or are affiliated with Tegridy Farms.
- **Fair-use framework:** We invoke 17 U.S.C. § 107 (transformative parody, commentary) as the legal basis for this use.
- **Takedown posture:** If contacted by rightsholders with a reasonable complaint, the project maintainers will work in good faith to rebrand. A contingency rebrand plan exists (`"Towel Farms"` / `"Randy's DeFi"` → see copy.ts centralisation) and all character-named strings are consolidated in [`frontend/src/lib/copy.ts`](frontend/src/lib/copy.ts) so a rebrand is a single-file diff.

### TOWELI token name

The token symbol "TOWELI" and name "Toweli" reference the *South Park* character Towelie under the same fair-use framework described above.

### JBAC / Jungle Bay NFT references

JBAC (Jungle Bay Apes) and JBAY Gold are external NFT collections. Tegridy Farms integrates with these collections as optional yield-boost mechanisms but does not claim ownership or issuance rights over them.

### Logos, hero art, and collage imagery

All art in [`frontend/public/art/`](frontend/public/art/) and gallery pages is original work created for the Tegridy Farms protocol by the community. If any piece is believed to infringe a third-party copyright, contact the maintainers via the process in [SECURITY.md](SECURITY.md).

---

## Contributing

Contributors agree to licence their contributions under MIT (see [CONTRIBUTING.md](CONTRIBUTING.md)). By submitting a pull request, you represent that you have the right to licence your contribution and grant the project the rights described in [LICENSE](LICENSE).

---

*Last updated: 2026-10-28.*
