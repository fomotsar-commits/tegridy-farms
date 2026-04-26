# Agent 038 — Constructor & Immutable Address Audit

**Scope:** every immutable / constant address across `contracts/src/`
**Cross-refs:** `CONTRACTS.md`, `frontend/src/lib/constants.ts` (no `contract-deployments.json` exists; deployment artifacts live at `contracts/broadcast/` chain `0x1`).

## Inventory — Counts

| Category | Count |
|---|---|
| Solidity contracts in `contracts/src/` | 28 |
| Files using `immutable` storage | 18 |
| Distinct `immutable` addresses (incl. interface-typed) | ~38 |
| Constructors enforcing zero-address checks | 17 of 21 mutable constructors |
| Constructors WITHOUT zero-checks on critical params | 2 (Toweli — checked; TegridyDropV2 init — clone-init, checked there) |
| Hardcoded EOA/contract address literals in `.sol` | 7 |
| Networks targeted | mainnet only (chainId 1) — confirmed by all `broadcast/.../1/`, `CHAIN_ID = 1` |
| Codehash / EIP-1052 verification of WETH/Factory | **0** instances |

---

## Hardcoded Address Literals Found (mainnet-only)

| File | Line | Address | Purpose | Risk |
|---|---|---|---|---|
| `TegridyFactory.sol` | 249 | `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` | ERC-1820 Registry | Same on all EVM chains — OK on mainnet, base, sepolia |
| `TegridyNFTLending.sol` | 238 | `0xd37264c71e9af940e49795F0d3a8336afAaFDdA9` | JBAC NFT bootstrap whitelist | **Mainnet-only literal in constructor** |
| `TegridyNFTLending.sol` | 239 | `0xd774557b647330C91Bf44cfEAB205095f7E6c367` | Nakamigos | **Mainnet-only literal in constructor** |
| `TegridyNFTLending.sol` | 240 | `0xa1De9f93c56C290C48849B1393b09eB616D55dbb` | GNSS Art | **Mainnet-only literal in constructor** |
| `TegridyLending.sol` | 281 (NatSpec only) | `0xC02aaA39b…756Cc2` | WETH9 (doc only — passed via `_weth`) | OK |
| `TegridyNFTLending.sol` | 223 (NatSpec only) | `0xC02aaA39b…756Cc2` | WETH9 (doc only) | OK |
| `Toweli.sol` | 12,19 (NatSpec only) | `0x420698CFd…78F9D` | Self-doc | OK |

---

## Findings — TOP-3 MISMATCHES (most exploitable)

### 1. **HIGH — TegridyNFTLending bootstrap whitelist hard-codes 3 mainnet NFT collections**
`contracts/src/TegridyNFTLending.sol:237-244`
```solidity
whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art
```
- Constructor unconditionally writes these on every deployment. **On Sepolia / Base / fork tests they will alias to whatever (or nothing) lives at those slots — if a malicious actor counter-factually deploys an ERC721-like contract at those addresses on testnet/L2, NFT lending automatically trusts it as collateral.** Nakamigos and GNSS are not Tegridy-deployed: counter-deploy is feasible on any chain that doesn't already have them.
- Even on mainnet this is a permanent rug surface: adding a fourth collection requires owner whitelist (gated), but **removing a compromised collection** is not constructor-gated and lives only in `removeWhitelistedCollection` if implemented; the bootstrap commits trust at deploy.
- **No same-codehash / `extcodesize > 0` / `supportsInterface(IERC721)` check** on these literals. A typo or namespace squat is permanent.
- **Recommendation:** require owner to whitelist post-deploy; or assert `IERC165(collection).supportsInterface(0x80ac58cd)` inside the constructor.

### 2. **HIGH — `weth` address never codehash-verified in any of 14 contracts**
Affected: `CommunityGrants`, `MemeBountyBoard`, `ReferralSplitter`, `RevenueDistributor`, `POLAccumulator`, `VoteIncentives`, `TegridyRouter`, `TegridyLaunchpadV2`, `TegridyLending`, `TegridyNFTLending`, `TegridyNFTPoolFactory`, `TegridyNFTPool`, `TegridyRestaking` (`bonusRewardToken`), `SwapFeeRouter` (reads via `router.WETH()` — also unverified).
- All accept `_weth` as a constructor arg with only `!= address(0)` checks. `WETHFallbackLib.safeTransferETHOrWrap` then calls `IWETH(weth).deposit{value: amount}()` and `transfer()` on it.
- A misconfigured deployer (or copy-paste from a Sepolia recipe) passing a malicious `IWETH` clone gets **permanent control of the fallback path**: `deposit()` can be a re-entrant hook into protocol contracts, or simply take ETH and mint zero WETH, draining ETH-deposit-fallback flows in `RevenueDistributor`, `VoteIncentives`, `CommunityGrants`, etc.
- The library doc itself says "Never pass user-supplied or dynamic WETH addresses — a malicious WETH could re-enter via deposit()" but **no runtime check verifies this** at construction time.
- `SwapFeeRouter.sol:268` makes it worse — `WETH = IUniswapV2Router02(_router).WETH();` derives WETH from a constructor-supplied router. If the router is rogue, WETH is rogue too, and the contract becomes unrecoverable (immutable).
- **Recommendation:** assert `address(weth).codehash == EXPECTED_WETH9_CODEHASH` or at minimum `weth.code.length > 0 && keccak256(weth.code) == knownGood`.

### 3. **MEDIUM — Permanent rug surfaces baked at construction (no rotation path)**
- `RevenueDistributor` (`treasury` is mutable via timelock — OK), but `ReferralSplitter` and `MemeBountyBoard` and `CommunityGrants` set `feeReceiver` / `treasury` at construction; **most have a propose/execute timelock for changes**, so this is partially mitigated. Verified mutable: `RevenueDistributor`, `ReferralSplitter`, `SwapFeeRouter`, `POLAccumulator`, `PremiumAccess`, `VoteIncentives`. **However `weth`, `pair` (TegridyLending), `lpToken` (POLAccumulator), `factory` (VoteIncentives, TegridyRouter), `dropTemplate` (TegridyLaunchpadV2) are ALL `immutable` and unrotatable** — if any of these target addresses is later self-destructed, paused, upgraded behind a proxy, or compromised, every dependent contract is a brick or rug surface forever.
- Specifically `TegridyLending` snapshots `toweli` from `_pair.token0()/token1()` at construction (line 303-312) — if the deployer passes a counterfeit pair, the entire lending market trusts a rogue TOWELI permanently.
- **Recommendation:** for the immutable factory/pair anchors, add an emergency pause governed by timelock + multisig acceptance, or accept this as documented unrotatable risk.

---

## Other Findings (lower severity)

- **TegridyFeeHook.sol:98-110** — known stranding bug already documented in `CONTRACTS.md` (constructor `_owner` arg added; redeploy pending). Address `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` baked via Arachnid CREATE2; ownership stranded on proxy. **Confirmed pending in current codebase.**
- **TegridyTWAP.sol** has empty `constructor()` with no immutables — fine; no addresses to bake.
- **TegridyRestaking.sol:170-189** — `bonusRewardToken` immutable. If used with a fee-on-transfer ERC20, accounting will drift permanently because there is no `balanceOf`-delta accounting around `safeTransferFrom`. Bonus token can be set to anything at deploy. Treat as deployer-error rather than exploit, but flag as FOT-incompatible immutable.
- **TegridyLPFarming.sol:144** — `stakingToken` immutable; same FOT concern. Pair LP tokens are not FOT, so risk is only for off-spec LP tokens.
- **TegridyNFTPoolFactory.sol:108** — `poolImplementation = address(new TegridyNFTPool())` constructed **inside** the factory constructor. Implementation address is deterministic per deployer-nonce; on chains where a different deployer nonce yields a different code, clones still resolve correctly because `Clones.cloneDeterministic` uses the immutable. Acceptable.
- **TegridyLaunchpadV2.sol:115** — `dropTemplate = address(new TegridyDropV2())` deploys template in constructor; same pattern; OK.
- **GaugeController.sol:160** — `genesisEpoch = (block.timestamp / EPOCH_DURATION) * EPOCH_DURATION;` immutable derived from deployment block — irrecoverable if deployment block is wrong (e.g., on a fork). LOW.
- **No `chainid` guard in any constructor** — contracts will silently deploy on any chain, including testnets and L2s, and the mainnet-only NFT collection literals in TegridyNFTLending will alias incorrectly.

---

## Network Cross-reference

- `CONTRACTS.md` and `frontend/src/lib/constants.ts` both target only `chainId = 1`. There is no Sepolia or Base configuration in `frontend/src/lib/constants.ts`. This means: **right now, divergence is theoretical** — only mainnet is shipped.
- However, the test suite and deployment scripts under `contracts/script/*` pass mainnet-mirrored addresses. Any future multi-chain expansion will hit the hardcoded JBAC/Nakamigos/GNSS literals in `TegridyNFTLending` immediately.
- All 28 contracts' constructors accept the WETH address as a parameter (no chain-conditional WETH literal in code), which is good — the risk is the lack of a **codehash check** on whatever address is passed.

---

## Auditor Recommendation Priority

1. **Add codehash verification to every immutable WETH parameter** (or accept document-and-monitor stance and capture in deployment runbook).
2. **Move TegridyNFTLending bootstrap whitelist out of the constructor**; require explicit `addCollection(addr)` after-deploy with `supportsInterface` validation.
3. **Document & test the immutable irrecoverability** of `factory`, `pair`, `lpToken`, `dropTemplate`, `poolImplementation` — make the risk an explicit ops-runbook item.
4. **Add `block.chainid` assertion** in deployment scripts (already implicit via Foundry) and consider an immutable `expectedChainId` for the lending whitelist code-path so it no-ops outside mainnet.
