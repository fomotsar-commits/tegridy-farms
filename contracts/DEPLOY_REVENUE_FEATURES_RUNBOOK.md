# Deploy Runbook — Revenue Features (post-relaunch)

**Scope (deploy these):** TegridyLaunchpadV2 (+ DropV2 template), TegridyNFTPoolFactory
(+ NFTPool template), TegridyNFTLending (+ Admin), TegridyLending (+ Admin), PremiumAccess.

**Deliberately EXCLUDED (cost-centers / not-ready):** GaugeController, VoteIncentives,
CommunityGrants, MemeBountyBoard (emission/ETH-outflow — hold until a revenue line funds
them), TegridyRestaking (EIP-170 split unfinished, Phase 7).

---

## 0. Pre-flight (verified 2026-06-08)

- ✅ **DropV2 ALLOWLIST free-mint (06-05 MEDIUM): CLOSED** — `ZeroPricePostMint` gate covers
  PUBLIC *and* ALLOWLIST (`TegridyDropV2.sol:716-719`), direct `setMintPrice` disabled
  (`:796`), timelocked `executeMintPrice` also gated (`:825`). Fix predates the audit flag →
  re-flag false positive.
- ✅ **Lending TWAP gate (06-05 MEDIUM): CLOSED** — `_positionETHValue` calls
  `_assertSpotWithinTWAP()` (50-bps spot-vs-TWAP gate) (`TegridyLending.sol:2011`); origination-
  only read, liquidation is time-based.
- ✅ **Source blocker fixed** — `DeployLaunchpadV2.s.sol:14` TREASURY re-pointed from the stale
  pre-relaunch `0xE9B7…f53e` to the relaunch Safe `0x7D26…Bd7d` (this commit).
- ⚠️ Confirm CI is green on the deploy branch before broadcasting.

## 1. Environment (export before each `forge script`)

| Var | Value | Notes |
|---|---|---|
| `TREASURY` | `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` | relaunch 2-of-2 Safe |
| `MULTISIG` | the Safe that owns the live MVP contracts | verify on Etherscan (owner of `0xcaDc…` Staking); likely the same `0x7D26…` Safe |
| `WETH` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | canonical WETH9 |
| `TOWELI` | `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` | Premium only |
| `JBAC_NFT` | `0xd37264c71e9af940e49795F0d3a8336afAaFDdA9` | Premium only |
| `PAIR` | `0x55875887B43C2E23aE424AF0FC8606Fdb058a481` | **GOTCHA: native TegridyPair, NOT Uniswap `0x6682…`** (Lending only) |
| `TWAP` | `0xdFdd6D72539A425dC917F49FB834901105cA98c9` | Lending only |
| `SEQUENCER_FEED` | *(unset)* | `address(0)` on mainnet |
| `MONTHLY_FEE` | **DECIDE** (TOWELI-wei/month) | Premium only — economic param, must be > 0 |

Prior `broadcast/*.json` artifacts carry the OLD treasury `0xE9B7…f53e` — they're historical
run logs, not inputs. Ignore them.

## 2. Deploy sequence

Each script ends by initiating ownership transfer to `MULTISIG` (except NFTPoolFactory,
which sets owner in the constructor). All are env-driven and clean except the LaunchpadV2
treasury, now fixed.

1. `forge script script/DeployNFTPoolFactory.s.sol --rpc-url $RPC --account <key> --broadcast`
   - owner = MULTISIG in ctor → **no accept needed**. Deploys NFTPool template internally.
2. `forge script script/DeployLaunchpadV2.s.sol ...` — deploys DropV2 template internally.
3. `forge script script/DeployNFTLending.s.sol ...` — deploys NFTLending + Admin, wires
   `setNftLendingAdmin`, transfers both to MULTISIG.
4. `forge script script/DeployTegridyLending.s.sol ...` — **set `PAIR` + `TWAP`** — deploys
   Lending + Admin, wires `setLendingAdmin`, transfers both to MULTISIG.
5. `forge script script/DeployPremiumAccess.s.sol ...` — **set `MONTHLY_FEE`**.

## 3. Post-deploy (from the multisig)

- **`acceptOwnership()`** (2-step) on: LaunchpadV2, NFTLending **and** NFTLendingAdmin,
  Lending **and** LendingAdmin, PremiumAccess.
  ⚠️ For Lending/NFTLending you must accept on **BOTH** the main contract and the Admin
  sister — miss the Admin and all timelocked governance stays owned by the deployer EOA.
  (NFTPoolFactory needs no accept.)
- **Verify on Etherscan:** each contract + the two internally-deployed templates
  (`factory.dropTemplate()`, `factory.poolImplementation()`).
- **Un-gate the frontend** — set the 5 addresses in `frontend/src/lib/constants.ts`
  (currently `0x0`): `TEGRIDY_LAUNCHPAD_V2_ADDRESS` (L67), `TEGRIDY_NFT_POOL_FACTORY_ADDRESS`
  (L50), `TEGRIDY_NFT_LENDING_ADDRESS` (L54), `TEGRIDY_LENDING_ADDRESS` (L47),
  `PREMIUM_ACCESS_ADDRESS` (L42). Each auto-un-gates via `isDeployed()`.
- ⚠️ **Vercel function cap:** un-gating NFT-lending/launchpad may add API routes. Hobby caps
  at 12; main is at 9 (3 headroom). Watch the function count when wiring frontend endpoints.

## 4. Operator decisions to make BEFORE deploy

1. **PremiumAccess `MONTHLY_FEE`** — TOWELI/month price (economic).
2. **NFTLending whitelist** — hardcoded in `TegridyNFTLending.sol:576-582`: JBAC ✅,
   Nakamigos `0xd774…c367`, GNSS `0xa1De…5dbb`. Confirm these are the intended launch set.
3. **Lending ETH-floor is the ONLY thing that needs the deep pool.** The optional
   `minPositionETHValue` collateral floor reads the TWAP, which is only trustworthy once the
   native pool is seeded deep + the TWAP has ≥4 spaced observations. Until then, lenders must
   leave `minPositionETHValue = 0` (the default — disables the floor). Everything else (P2P
   ETH-denominated loans, lender-set APR) works immediately. Enable/advertise the ETH-floor
   after the pool-seed runbook completes.
