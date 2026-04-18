# TOWELI Token Deployment

How the TOWELI ERC-20 token at `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` was deployed, and how to re-deploy a compatible token on testnets or forks.

## Canonical deployment

- **Address:** `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D`
- **Chain:** Ethereum Mainnet (chainId `1`)
- **Source (this repo):** [`contracts/src/Toweli.sol`](../contracts/src/Toweli.sol)
- **Verified source (Etherscan):** [etherscan.io/token/0x420698…#code](https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#code) — **treat Etherscan as the canonical reference**
- **Supply:** 1,000,000,000 TOWELI, minted once in constructor, fixed
- **Decimals:** 18
- **Standards:** ERC-20, ERC-2612 (permit)
- **Admin surface:** None — no owner, no mint, no burn entrypoint, no pause, no blocklist

## Vanity address note

The `0x420698` prefix is intentional — a cultural reference (`420`, `69`, `8` whale-tier). It was obtained via CREATE2 salt-mining before mainnet deployment rather than a plain `new Toweli(...)` call.

The commit hash of the salt-mining tooling used is documented in the project's internal deploy records. For external observers: the vanity prefix is cosmetic and does not affect the contract's behaviour. The bytecode at the live address is the standard OZ ERC-20 + ERC-2612 permit, as documented in [`Toweli.sol`](../contracts/src/Toweli.sol).

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

The entire 1B supply was minted to the project treasury at `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` (see `TREASURY_ADDRESS` in [`constants.ts`](../frontend/src/lib/constants.ts)) and has been distributed per the allocation in [`TOKENOMICS.md`](../TOKENOMICS.md). The token itself has no owner and cannot be paused, minted into, or blocklisted.

## Migration safety

If a future Tegridy Farms version requires migrating to a new token contract (e.g. for an ERC-20 → ERC-20+votes upgrade), this document will be updated with a burn/mint bridge address and migration window. Until then: the token at `0x420698…78F9D` is the only canonical TOWELI.

---

*Last updated: 2026-04-17.*
