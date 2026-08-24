# NOTICE — Third-Party Attributions & Fair Use

Tegridy Farms is licensed under the MIT License (see [LICENSE](LICENSE)), **except `solana/tegridy-amm/`, which is Apache-2.0 (see [`solana/tegridy-amm/LICENSE`](solana/tegridy-amm/LICENSE)) because it derives from Apache-2.0 upstream.** This file documents third-party code, design patterns, intellectual property considerations, and fair-use rationale for the project.

## Smart contract code & patterns

| Component | Source | License | Attribution |
|---|---|---|---|
| **Raydium CP-Swap (CPMM)** | [raydium-io/raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) @ `78f254e` | **Apache-2.0** | [`solana/tegridy-amm/programs/cp-swap/`](solana/tegridy-amm/programs/cp-swap/) is a fork. **Changes made (Apache-2.0 §4(b)):** four authority/identity constants only — the program id in `lib.rs` and the admin / fee-receiver / support-mint-owner constants; all swap, curve and fee math is unmodified. The delta is enforced by the `diff-guard` job in `.github/workflows/solana-ci.yml`. Apache-2.0 text retained at [`solana/tegridy-amm/LICENSE`](solana/tegridy-amm/LICENSE). **Upstream's MadShield audit and Raydium's Immunefi bounty do NOT cover this fork.** |
| **Raydium CLMM concentrated-liquidity math** | [raydium-io/raydium-clmm](https://github.com/raydium-io/raydium-clmm) @ `bf7c241` | **Apache-2.0** | ⚠️ **NO LONGER VENDORED — removed 2026-08-23.** Seven library files (`big_num`, `fixed_point_64`, `full_math`, `liquidity_math`, `sqrt_price_math`, `tick_math`, `unsafe_math`) lived at `solana/tegridy-amm/programs/tegridy-launch/src/vendor/` to price the segmented bonding curve. Segmented mode was deleted before the redeploy (it carried two HIGH audit findings), and the vendored maths went with it — ~1,495 lines that upstream's audits did not cover. The `clmm-vendor-guard` CI job that enforced the delta was removed in the same change, since it guarded a directory that no longer exists. **Nothing in this repo now derives from raydium-clmm.** Kept in this table as the record of code that WAS shipped, not as a live dependency. |
| **OpenZeppelin Contracts** | [OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | MIT | Imported via npm/Foundry. Used for ERC20, ERC721, ReentrancyGuard, Pausable, SafeERC20, etc. Licence inherited. |
| **Synthetix StakingRewards** | [Synthetixio/synthetix](https://github.com/Synthetixio/synthetix) | MIT | [`TegridyLPFarming.sol`](contracts/src/TegridyLPFarming.sol) adapts the StakingRewards reward-math pattern. Attribution in source comment. |
| **Curve GaugeController** | [curvefi/curve-dao-contracts](https://github.com/curvefi/curve-dao-contracts) | MIT | [`GaugeController.sol`](contracts/src/GaugeController.sol) adapts Curve's gauge-voting + emission-direction pattern. Attribution in source comment. |
| **Meteora Dynamic Bonding Curve** *(design only — no code)* | Meteora's **public documentation** | Meteora's program source is under a **non-commercial** licence | ⚠️ **PROVENANCE RECORD — read before assuming a clean-room claim.** The retired segmented curve mode implemented a 16-point `(sqrt_price, liquidity)` shape described in Meteora's public docs. **Nothing was derived from Meteora's program source**, deliberately: that source is non-commercially licensed ([`docs/CURVE_FORK_EVALUATION.md`](docs/CURVE_FORK_EVALUATION.md)), so paraphrasing it would risk a derivative-work claim. Concepts are not protectable; their expression is — and the expression shipped was Raydium's Apache-2.0 maths plus our own segment loop. This paragraph was the header of `programs/tegridy-launch/src/segmented.rs`, deleted 2026-08-23; it is preserved here because deleting the legal defence alongside the code is how a derivative-work claim becomes hard to answer. The Meteora DBC *rail* was separately retired the same day. |
| **Uniswap V2 core + periphery** | [Uniswap/v2-core](https://github.com/Uniswap/v2-core), [Uniswap/v2-periphery](https://github.com/Uniswap/v2-periphery) | BUSL-1.1 (core), GPL-3.0-or-later (periphery) | [`TegridyFactory.sol`](contracts/src/TegridyFactory.sol), [`TegridyPair.sol`](contracts/src/TegridyPair.sol), [`TegridyRouter.sol`](contracts/src/TegridyRouter.sol) adapt the V2 AMM architecture. The BUSL-1.1 licence change date (2023-04-01) has passed; V2 code is now effectively GPL-2.0 under the conversion clause. Tegridy Farms fork integrates this code under GPL-compatible MIT fallback. Attribution in source comments. |
| **Solmate / Solady patterns** | Various | MIT | Minor utility helpers may reference these gas-optimised patterns. Licence inherited (MIT). |

### SPDX coverage

All Solidity files in `contracts/src/` and `contracts/src/base/` declare `// SPDX-License-Identifier: MIT`. No files are missing SPDX headers.

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

*Last updated: 2026-08-01.*
