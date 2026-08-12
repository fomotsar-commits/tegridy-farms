# TOWELI Token Deployment

How the TOWELI ERC-20 token at `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` was deployed, and how to re-deploy a compatible token on testnets or forks.

## Canonical deployment

> 🔴 **The deployed contract is not the source in this repo.** Selector scan of `cast code` plus live
> `cast call`, 2026-08-12. What is on-chain calls itself **`Towelie`** (symbol `Toweli`) and is a
> token-generator template. [`contracts/src/Toweli.sol`](../contracts/src/Toweli.sol) is what a fresh
> deploy of this project's own source would produce — the two disagree on permit, on burn, and on
> ownership. The bullets below describe **the chain**. Anything integrating against this address must
> read Etherscan's Contract tab, never the repo file.

- **Address:** `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`
- **Chain:** Ethereum Mainnet (chainId `1`)
- **Source (this repo, NOT the deployed bytecode):** [`contracts/src/Toweli.sol`](../contracts/src/Toweli.sol)
- **Verified source (Etherscan):** [etherscan.io/token/0x420698…#code](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#code) — **treat Etherscan as the canonical reference**
- **Supply:** 1,000,000,000 TOWELI, minted once in constructor. A ceiling, not a constant — see burn below.
- **Decimals:** 18
- **Standards:** plain ERC-20. **No permit** — `permit(...)`, `DOMAIN_SEPARATOR()` and `nonces(address)` are all absent and revert. Integrations must use `approve`, not a signature.
- **Burn:** `burn(uint256)` ✅ and `burnFrom(address,uint256)` ✅ — holder-callable. No contract in the protocol calls either.
- **Mint:** `mint(address,uint256)` ✅ absent. Supply cannot rise.
- **Admin surface:** Ownable2Step is present (`owner`, `pendingOwner`, `transferOwnership`, `acceptOwnership`, `renounceOwnership`) but **`owner()` reads `0x0…0`** — ownership was renounced, so every owner-gated path reverts for everyone. No pause, no blocklist.

## Vanity address note

The `0x420698` prefix is intentional — a cultural reference (`420`, `69`, `8` whale-tier). It was obtained via CREATE2 salt-mining before mainnet deployment rather than a plain `new Toweli(...)` call.

The commit hash of the salt-mining tooling used is documented in the project's internal deploy records. For external observers: the vanity prefix is cosmetic and does not affect the contract's behaviour. **Corrected 2026-08-12:** this paragraph used to claim the bytecode at the live address was the OZ token documented in [`Toweli.sol`](../contracts/src/Toweli.sol). It is not — see the capability list above. The salt-mining story is about the *address*; it says nothing about which source produced the code.

## Redeploying on a testnet / fork

For integration tests, Sepolia deploys, or local Anvil forks, use the reference script:

```bash
cd contracts
cp .env.example .env
# Set: PRIVATE_KEY, TOKEN_TREASURY, RPC_URL (for Sepolia: ETHERSCAN_API_KEY too)
forge script script/DeployToweli.s.sol:DeployToweli \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

This produces a plain (non-vanity) deployment. The resulting address is fine for testing but will not match the `0x420698…` mainnet prefix. For mainnet vanity redeploys, see the CREATE2 salt-mining workflow below.

## CREATE2 vanity redeploy workflow (reference only)

> Only relevant if the protocol needs to redeploy the token at a new vanity address. This is an extraordinary event and requires multisig governance.

1. **Pre-compute CREATE2 salt** using a miner such as [`create2crunch`](https://github.com/0age/create2crunch) or [solady's `saltMiner`](https://github.com/Vectorized/solady). Target the desired prefix (e.g. `0x420698`).
2. **Commit the salt** into a new script (e.g. `DeployToweliVanity.s.sol`) that uses a deterministic-deployment factory (e.g. [`0x4e59b44…`](https://github.com/Arachnid/deterministic-deployment-proxy)).
3. **Simulate on a fork** to verify the resulting address matches the mined prefix.
4. **Execute the deploy** from the multisig via timelock.
5. **Document the new address** in this file and in [`constants.ts`](../frontend/src/lib/constants.ts).

## Why the source wasn't in this repo before

During the protocol's early development, the token was deployed from an external tooling repo alongside the salt-mining workflow, and only its address was referenced from this repo. [`contracts/src/Toweli.sol`](../contracts/src/Toweli.sol) was added in the 2026-04 repo cleanup to close the audit-trail gap: readers of this repo can now verify the intended behaviour without leaving the GitHub.

The live mainnet bytecode remains the authoritative reference — always verify via Etherscan's "Contract" tab.

## Ownership & treasury

The entire 1B supply was minted to `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` and has been distributed per the allocation in [`TOKENOMICS.md`](../TOKENOMICS.md).

**That address is not the treasury and never was** (corrected 2026-08-12; this paragraph called it "the project treasury" and pointed at `TREASURY_ADDRESS`, which resolves elsewhere). Read on-chain: `0xE9B7…f53e` is an **EOA carrying an EIP-7702 delegation designator** (`code == 0xef0100…`) and is one of the two owners of the treasury Safe — an owner key, not the fund sink. The protocol treasury is the Safe at [`0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`](https://etherscan.io/address/0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d) (`getThreshold() == 2` over 2 owners), which is what `TREASURY_ADDRESS` in [`constants.ts`](../frontend/src/lib/constants.ts) and `SwapFeeRouter.treasury()` both return. Never solicit or send funds to `0xE9B7…f53e`.

The token itself has a renounced owner (`owner() == 0x0…0`) and cannot be paused, minted into, or blocklisted. It **can** be burned by whoever holds it.

## Migration safety

If a future Tegridy Farms version requires migrating to a new token contract (e.g. for an ERC-20 → ERC-20+votes upgrade), this document will be updated with a burn/mint bridge address and migration window. Until then: the token at `0x420698…78F9D` is the only canonical TOWELI.

---

*Last updated: 2026-04-17.*
