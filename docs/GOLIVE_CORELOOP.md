# Core-Loop Go-Live — verified on-chain 2026-07-11

Read directly from mainnet (`ethereum-rpc.publicnode.com`) + forge-simulated
against live state. Supersedes the "empty pool / seed LP first" assumption in the
older memory — **the native pool is already seeded.**

## Verified state
| Fact | Value |
|---|---|
| Native TOWELI/WETH pool (`0x5587…a481`) | **SEEDED**: 776,678 TOWELI + 0.0203 WETH |
| Native price vs Uniswap | ~38.26M TOWELI/ETH — **0.28% off Uniswap** (aligned, no arb) |
| Native pool depth | ~$73 (Uniswap ~$26,400 — **360× deeper**) |
| Native LP ownership | 125.0 of 125.7 LP (99.5%) staked in LP Farming — farming is live |
| TWAP observations | **0** (not bootstrapped) |
| TWAP reserve floor | **10 WETH per side** (`effectiveMinReserveFloor`, no override) |
| Deployer `0x1489…456E` | 0.004 ETH ($7) + 680,152 TOWELI ($32) |
| Treasury Safe `0x7D26…Bd7d` | **0 TOWELI**, protocol-controlled TOWELI ≈ 680K total |
| Gas | ~0.08 gwei (ops cost ~$0; deployer ETH is plenty for signing txs) |

## Already live / done (no action)
- **Swap** (native pool seeded at market price — native route no longer reverts),
  **Staking**, **LP Farming**, **Revenue Distribution**, **Referrals**. The
  swap/stake/farm half of the loop is LIVE. `SeedLP.s.sol` correctly aborts now
  (pool already seeded — the safety check works).

## 🚧 THE GATE: oracle-dependent features are blocked on pool depth
`TWAP.update()` rejects the pool with **`ReservesBelowFloor()`** — the WETH side
(0.0203) is ~500× below the 10-WETH floor (an anti-manipulation guard). So the
**TWAP can't bootstrap**, which blocks everything that consumes the oracle:
**NFT lending, token lending, POL accumulate.**

**Clearing the 10-WETH floor at the current price needs ~10 WETH ($18k) + ~382M
TOWELI ($18k). 382M TOWELI = 38% of supply — the protocol holds ~680K (treasury
is empty), and that much TOWELI is not market-buyable.** This is a real strategic
constraint, not a scripting gap.

### Options for the oracle track (operator decision)
1. **Owner supplies TOWELI from a personal stash** (if one exists off-treasury) +
   ~10 WETH → deepen → bootstrap → full, safe oracle. Best if the TOWELI exists.
2. **Lower the reserve floor** to an achievable depth via `proposeAdminMinReserveFloor(pair, floor)`
   → wait 24h → `executeAdminMinReserveFloor(pair)`, then deepen to that floor.
   ⚠️ A lower floor = a thinner pool the TWAP trusts = more manipulable; launch
   NFT-lending with conservative LTVs or keep it gated. Even a 1-WETH floor needs
   ~38M TOWELI (3.8% of supply) the protocol doesn't currently hold.
3. **Keep the oracle track gated** (default). Ship everything below that doesn't
   need the oracle; revisit NFT-finance when TOWELI liquidity is resolved.

## Turnkey sequence

### Track A — ships NOW, no capital needed (recommended first)
- **A1. Deploy the current frontend to prod** (fixes the stale build + all the
  motion/donut/pool-card work). CLI from repo root — see `docs/…VERCEL…` / memory
  `reference_vercel_deploy_procedure`. 🌐 outward-facing — confirm before publishing.
- **A2. Ownership handoff** — rebuild the 3 Safe signer sets, then re-initiate
  (the 14-day window expired Jun 21) and accept. Full tx data in
  [`GOLIVE_HANDOFF.md`](GOLIVE_HANDOFF.md). 🔑 deployer + multisig. Gas ~$0.
- **A3. VerifyMVP** after A2 (`script/VerifyMVP.s.sol`).

### Track B — oracle unlock, gated on the capital decision above
- **B1. Deepen the native pool** to ≥ the (possibly-lowered) reserve floor. The
  pool is seeded, so `SeedLP.s.sol` aborts — deepen via `Router.addLiquidityETH`
  at the current ratio (approve TOWELI → `addLiquidityETH{value:eth}` with tight
  mins, via a Flashbots-protect RPC). Ask me to write a `DeepenLP.s.sol` once you
  fix the target depth + have the TOWELI. 🔑💰
- **B2. Bootstrap the TWAP** — `script/BootstrapTWAP.s.sol` (dry-run-verified;
  pays the 0.0001-ETH update fee, guards the reserve floor with a clear error).
  Run 4× ≥15 min apart until it reports ORACLE WARM, then wait 60 min before any
  `POL.accumulate` (audit H-18). 🔑 deployer.
  ```bash
  cd contracts
  export RPC=https://ethereum-rpc.publicnode.com
  export TWAP=0xdFdd6D72539A425dC917F49FB834901105cA98c9
  export PAIR=0x55875887B43C2E23aE424AF0FC8606Fdb058a481
  export ROUTER=0xE9F83A07b071748E795d2489651d5310fA098Db8
  export TOWELI=0x420698CFdEDdEa6bc78D59bC17798113ad278F9D
  # dry-run (no key needed):
  forge script script/BootstrapTWAP.s.sol --rpc-url $RPC --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E -vvv
  # real, repeat 4×, ≥15 min apart:
  forge script script/BootstrapTWAP.s.sol --rpc-url $RPC --broadcast --private-key $DEPLOYER_KEY -vvv
  ```
- **B3. Deploy the oracle-gated features** (NFT lending, token lending) per their
  audit-wave order once the oracle is warm.

## Bottom line
The swap/stake/farm loop is **live**; ship it to prod + hand off ownership (Track
A, no capital). The NFT-finance loop is **capital-gated** on TOWELI the protocol
doesn't hold — that's a strategy call (supply the bag, lower the floor, or wait),
not a code fix.
