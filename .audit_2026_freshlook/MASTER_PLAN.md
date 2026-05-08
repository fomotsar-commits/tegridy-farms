# Tegriddy Farms — 100-Agent Fresh-Eyes Exploit Audit (2026-05-07)

**Mandate:** Find every exploit. Do NOT fix. Ignore previous audits. Approach with fresh eyes.

## Output spec (every agent must follow)
Each agent writes: `.audit_2026_freshlook/findings/agent_<NN>_<slug>.md`

```markdown
# Agent NN — <focus>
**Scope:** <files/categories>
**Tools used:** <Read/Grep/WebSearch/etc>

## Findings

### F-NN-1 [CRITICAL|HIGH|MEDIUM|LOW|INFO] <one-line title>
- **Location:** `contracts/src/X.sol:LINE` (function `foo`)
- **Class:** <reentrancy / oracle / access control / ...>
- **Description:** What the bug is.
- **Exploit:** Step-by-step exploit walkthrough.
- **Attacker profile:** Who can run it (anyone / privileged / flash-loan / sandwich bot / etc).
- **Impact:** $/token loss, control gained.
- **PoC sketch:** Pseudocode or Foundry-style PoC.
- **References:** Links to related public exploits.

### F-NN-2 ...
```

End with `## Notes / dead-ends` for things investigated but cleared.

## Severity
- **CRITICAL** — direct loss/theft of funds, governance takeover
- **HIGH** — permissioned-only loss, large griefing, recovery cost
- **MEDIUM** — reward dilution, partial DoS, edge-case loss
- **LOW** — minor griefing, gas waste, recoverable
- **INFO** — code smell, no direct exploit

## Contract index (target surface)

| # | Contract | LOC |
|--:|---|--:|
| 1 | TegridyStaking.sol | 2224 |
| 2 | TegridyRestaking.sol | 2131 |
| 3 | SwapFeeRouter.sol | 2064 |
| 4 | TegridyLending.sol | 1972 |
| 5 | VoteIncentives.sol | 1789 |
| 6 | RevenueDistributor.sol | 1429 |
| 7 | TegridyNFTLending.sol | 1285 |
| 8 | CommunityGrants.sol | 1250 |
| 9 | TegridyDropV2.sol | 1134 |
| 10 | GaugeController.sol | 1054 |
| 11 | TegridyNFTPool.sol | 1036 |
| 12 | POLAccumulator.sol | 964 |
| 13 | MemeBountyBoard.sol | 859 |
| 14 | TegridyFeeHook.sol | 849 |
| 15 | TegridyTWAP.sol | 813 |
| 16 | ReferralSplitter.sol | 803 |
| 17 | TegridyNFTPoolFactory.sol | 677 |
| 18 | PremiumAccess.sol | 639 |
| 19 | TegridyLPFarming.sol | 571 |
| 20 | TegridyRouter.sol | 570 |
| 21 | TegridyFactory.sol | 521 |
| 22 | TegridyPair.sol | 499 |
| 23 | SwapFeeRouterAdmin.sol | 431 |
| 24 | TegridyLendingAdmin.sol | 429 |
| 25 | TegridyLaunchpadV2.sol | 427 |
| 26 | lib/SequencerCheck.sol | 365 |
| 27 | TegridyStakingAdmin.sol | 346 |
| 28 | base/TimelockAdmin.sol | 235 |
| 29 | Toweli.sol | 231 |
| 30 | TegridyTokenURIReader.sol | 214 |
| 31 | VoteIncentivesAdmin.sol | 208 |
| 32 | lib/WETHFallbackLib.sol | 171 |
| 33 | TegridyStakingJbacVault.sol | 132 |
| 34 | base/OwnableNoRenounce.sol | 104 |
| 35 | lib/VotePowerOracle.sol | 102 |
| 36 | lib/SafeERC721Call.sol | 93 |

## Agent assignments (1-100)

### Tier A — Per-contract deep dives (Agents 1-40)
Each large contract gets dedicated reviewers. Some get multiple from different angles.

| # | Focus | Contract / Angle |
|--:|---|---|
| 01 | Staking-1 | TegridyStaking.sol — reentrancy / state mutation / external calls |
| 02 | Staking-2 | TegridyStaking.sol — boost/penalty math, JBAC bonus, lock math |
| 03 | Restaking-1 | TegridyRestaking.sol — auto-compound flow, share accounting |
| 04 | Restaking-2 | TegridyRestaking.sol — reward forwarding, slippage on compound |
| 05 | SwapFeeRouter-1 | SwapFeeRouter.sol — fee path, swap routes, arbitrary call vectors |
| 06 | SwapFeeRouter-2 | SwapFeeRouter.sol — splitter accounting, sweep functions |
| 07 | Lending-1 | TegridyLending.sol — collateral health, liquidation flow |
| 08 | Lending-2 | TegridyLending.sol — interest model, kink, rate manipulation |
| 09 | Lending-3 | TegridyLending.sol — oracle integration, LTV bypass |
| 10 | VoteIncentives-1 | VoteIncentives.sol — bribe deposit/claim, epoch transitions |
| 11 | VoteIncentives-2 | VoteIncentives.sol — vote weight snapshot, double-claim |
| 12 | RevenueDist-1 | RevenueDistributor.sol — distribution math, accumulator |
| 13 | RevenueDist-2 | RevenueDistributor.sol — claim staleness, donation attacks |
| 14 | NFTLending | TegridyNFTLending.sol — NFT liquidation, valuation, grace period |
| 15 | CommunityGrants | CommunityGrants.sol — milestone gating, multisig flow |
| 16 | DropV2 | TegridyDropV2.sol — mint/refund, init params, ERC721 |
| 17 | Gauge-1 | GaugeController.sol — vote weight, gauge add/kill |
| 18 | Gauge-2 | GaugeController.sol — H-2 commit-reveal correctness |
| 19 | NFTPool | TegridyNFTPool.sol — pricing curve, NFT swap |
| 20 | POLAccum | POLAccumulator.sol — buy/LP, slippage, MEV |
| 21 | MemeBounty | MemeBountyBoard.sol — escrow, voting, payout |
| 22 | FeeHook-1 | TegridyFeeHook.sol — Uniswap V4 hook spec compliance |
| 23 | FeeHook-2 | TegridyFeeHook.sol — owner-stranded redeploy, dynamic fee math |
| 24 | TWAP | TegridyTWAP.sol — TWAP correctness, manipulation cost |
| 25 | Referral | ReferralSplitter.sol — referral flow, self-referral |
| 26 | NFTPoolFactory | TegridyNFTPoolFactory.sol — deploy pattern, salt |
| 27 | Premium | PremiumAccess.sol — sub gating, JBAC/Gold checks |
| 28 | LPFarming | TegridyLPFarming.sol — fixed-schedule, MAX_BOOST_BPS_CEILING |
| 29 | Router | TegridyRouter.sol — swap router, fee-on-transfer support |
| 30 | Factory | TegridyFactory.sol — pair create, init code |
| 31 | Pair | TegridyPair.sol — V2 pair semantics, K-invariant |
| 32 | SwapFeeAdmin | SwapFeeRouterAdmin.sol — admin escalation |
| 33 | LendingAdmin | TegridyLendingAdmin.sol — admin escalation |
| 34 | Launchpad | TegridyLaunchpadV2.sol — clone deploy, init |
| 35 | StakingAdmin | TegridyStakingAdmin.sol — admin escalation |
| 36 | Toweli | Toweli.sol — token logic, supply, transfer hooks |
| 37 | URIReader | TegridyTokenURIReader.sol — fallback, untrusted call |
| 38 | VoteIncAdmin | VoteIncentivesAdmin.sol — admin escalation |
| 39 | StakingJbacVault | TegridyStakingJbacVault.sol — JBAC bonus path |
| 40 | base+lib | base/* + lib/* (Ownable, Timelock, SequencerCheck, WETHFallbackLib, VotePowerOracle, SafeERC721Call) |

### Tier B — Cross-cutting vulnerability classes (Agents 41-75)

| # | Vuln class |
|--:|---|
| 41 | Reentrancy (classic / cross-fn / read-only / cross-contract) |
| 42 | Integer overflow/underflow (unchecked blocks, casts, downcast) |
| 43 | Access control (missing modifier, role confusion, owner-only bypass) |
| 44 | Front-running / MEV / sandwich exposure |
| 45 | Flash-loan amplification (price manipulation, governance flash) |
| 46 | Oracle manipulation (TWAP grinding, Chainlink staleness, decimal mismatch) |
| 47 | Signature replay (EIP-712 domain reuse, cross-chain replay, Permit2) |
| 48 | Storage collision / proxy upgrade safety |
| 49 | Initializer / re-initialization on clones |
| 50 | Unbounded loops / DoS via gas |
| 51 | Weird ERC20 (fee-on-transfer, rebase, blacklist, double-entry) |
| 52 | ERC777 callback abuse |
| 53 | ERC721 onReceived / safeMint reentrancy |
| 54 | ERC1155 callback exploits |
| 55 | Native ETH handling (selfdestruct force-feed, transfer/send/call patterns) |
| 56 | ECDSA malleability / EIP-2098 short-sig / signer recovery edge cases |
| 57 | Merkle tree exploits (second preimage, leaf-as-node, OZ MerkleProof) |
| 58 | Approval / Permit2 abuse (race, infinite approve, callback) |
| 59 | delegatecall safety (storage layout, execution context) |
| 60 | tx.origin usage and phishing |
| 61 | Rounding / precision loss / dust accumulation |
| 62 | First-depositor share inflation (vault inflation attack) |
| 63 | Slippage parameter abuse (zero minOut, oracle-derived bounds) |
| 64 | Donation / direct-transfer manipulation of accounting |
| 65 | Cross-contract state inconsistency / race |
| 66 | ERC20 approve race condition |
| 67 | Block timestamp / blockhash manipulation |
| 68 | Function selector clashes / signature collisions |
| 69 | Governance attacks (vote weighting, snapshot bypass, double-vote) |
| 70 | Upgradeable storage gap / __gap missing |
| 71 | Liquidation MEV / griefing / first-keeper |
| 72 | View/getter DoS (empty array, unbounded length) |
| 73 | Aggregate caps / per-user caps bypass via splits |
| 74 | L2 / sequencer downtime handling (already has SequencerCheck.sol) |
| 75 | Timelock bypass / queue replay / canceller abuse |

### Tier C — Integration / external-dep specific (Agents 76-85)

| # | Focus |
|--:|---|
| 76 | Uniswap V4 hook full spec — beforeSwap/afterSwap returns delta, callback flags, locking |
| 77 | Aerodrome / Velodrome / curve patterns referenced |
| 78 | Aave V3 patterns (sequencer, frozen, stale price) |
| 79 | Chainlink oracle (heartbeat, decimals, sequencer feed, answeredInRound) |
| 80 | WETH wrap/unwrap edge cases, WETHFallbackLib correctness |
| 81 | ERC4626 compliance (if any vault) |
| 82 | CREATE2 / factory salt collisions, frontrunning of init |
| 83 | EIP-2612 permit divergence across tokens (DAI, USDC, etc) |
| 84 | ERC20 metadata reliance (decimals(), symbol() — non-standard returns) |
| 85 | LayerZero / cross-chain messaging (any) — replay, ordering |

### Tier D — Latest exploit research using web (Agents 86-90)

| # | Focus |
|--:|---|
| 86 | Latest 2025-2026 DeFi exploits (Rekt News, Code4rena, ImmuneFi public reports) — pattern-match against codebase |
| 87 | Recent vault/staking exploits — pattern-match against TegridyStaking/Restaking/RevenueDistributor |
| 88 | Recent AMM/DEX exploits — pattern-match against TegridyPair/Router/Factory |
| 89 | Recent oracle/TWAP exploits — pattern-match against TegridyTWAP, lending oracle |
| 90 | Recent Uniswap V4 hook exploits, hook-specific CVEs — pattern-match TegridyFeeHook |

### Tier E — Cryptoeconomic / game theory (Agents 91-95)

| # | Focus |
|--:|---|
| 91 | Tokenomics — inflation, dilution, unlimited mint paths in Toweli |
| 92 | Vote-bribe wash trading / Curve-wars patterns on GaugeController + VoteIncentives |
| 93 | Reward farming / bot extraction across Staking/Restaking/Farming |
| 94 | Governance capture / whale dominance / time-locked attack windows |
| 95 | Liquidity griefing / range manipulation / pool starvation |

### Tier F — Configs / deploy / off-chain coupling (Agents 96-98)

| # | Focus |
|--:|---|
| 96 | Constructor / init args across contracts — wrong defaults, hardcoded addresses |
| 97 | Deploy scripts (script/) — fund flow, owner xfer, sequence races |
| 98 | Test coverage gaps — what's NOT tested in `contracts/test/` |

### Tier G — Meta / aggregation (Agents 99-100)

| # | Focus |
|--:|---|
| 99 | Cross-contract attack chains — combine 2+ findings into multi-step exploit (read all prior findings) |
| 100 | Final aggregation — read all findings, dedupe, rank, produce executive summary |

## Rules for every agent
1. Read the source. Don't guess.
2. Be specific: file:line, function name, exact exploit path.
3. Prefer over-reporting (LOW/INFO ok) to under-reporting.
4. **Do not edit any source file.** Audit-only.
5. Ignore prior audit docs (AUDITS*.md, FIX_STATUS.md). Fresh eyes.
6. Write findings file before returning.
