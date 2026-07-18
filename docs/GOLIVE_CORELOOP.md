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

### DECIDED (owner has 50M TOWELI) — deepen + lower the floor to 1.0 WETH
The owner holds ~50M TOWELI off-treasury. At the current ratio that pairs with
~1.31 ETH and lifts the native pool to **~50.8M TOWELI + ~1.33 WETH** (~$4,800 =
65× current, 18% of Uniswap). That's below the 10-WETH default floor, so the
**WETH-side floor is lowered to exactly 1.0 WETH** (24h timelock) to accept it.

**Adversarial safety review (2026-07-11, 4-agent, read the real code) verdict:
GO-WITH-CONDITIONS.** A ~1.33-WETH pool at floor 1.0 is NOT exploitable for
over-valuation — the oracle fails *closed*:
- `consult()` reads only stored ≥15-min observations → single-block spot pumps
  can't move it; `_assertSpotWithinTWAP` (50 bps) blocks the pumped-spot origination.
- consult()-time floor re-check → a drained pool reverts (never serves a stale price).
- The multi-block TWAP grind is defeated by the deep arb-linked Uniswap pool
  (~$26k, ~100% UNCX-locked to ~2093): sustaining a 2× dislocation for the 30-min
  window costs ~3.6 WETH of double-peg capital vs a few-$k loan → EV negative.
- Only residual: a transient, self-healing DoS (Low) if someone drains below floor.

**Conditions to satisfy before enabling NFT-lending collateral:**
1. Set the WETH-side floor to **exactly 1.0 WETH** — not lower (lower widens the
   manipulable band for no safety gain).
2. Launch NFT-lending at **≤ 50% LTV** (hard ceiling 60%; keep 1/LTV well above 1.5).
3. Wire an **arb-linkage monitor + auto-pause**: alert/emergency-disable if the
   Uniswap TOWELI/WETH WETH depth drops below ~3× the native pool (the one
   load-bearing assumption is that the native pool is not the only liquid venue).
   **The monitor is built** — `contracts/monitoring/arbLinkageMonitor.mjs`
   (read-only; GO/WARN/HALT + exit code; run on a 5-min cron and page on HALT).
   The auto-pause hook (consumes a HALT → `PauseGuardian`) is the remaining wire-up.
4. Deepen further over time (the real robustness lever) as more TOWELI is available.

## Turnkey sequence

### Track A — ships NOW, no capital needed (recommended first)
- **A1. Deploy the current frontend to prod** (fixes the stale build + all the
  motion/donut/pool-card work). CLI from repo root — see `docs/…VERCEL…` / memory
  `reference_vercel_deploy_procedure`. 🌐 outward-facing — confirm before publishing.
- **A2. Ownership handoff** — rebuild the 3 Safe signer sets, then re-initiate
  (the 14-day window expired Jun 21) and accept. Full tx data in
  [`GOLIVE_HANDOFF.md`](GOLIVE_HANDOFF.md). 🔑 deployer + multisig. Gas ~$0.
- **A3. VerifyMVP** after A2 (`script/VerifyMVP.s.sol`).

### Track B — oracle unlock (owner: ~50M TOWELI + ~1.31 ETH + 24h). ALL dry-run-verified.
Start B0 now (24h clock); B1 anytime; B2 after 24h; then B3/B4.
`RPC=https://ethereum-rpc.publicnode.com`, `TWAP=0xdFdd…98c9`, `PAIR=0x5587…a481`,
`ROUTER=0xE9F8…8Db8`, `TOWELI=0x4206…8F9D`.

> **✅ Pre-flight re-verified on-chain 2026-07-18** (nothing drifted; B0–B4 valid as written):
> - Native pair `0x5587…a481`: **776,678 TOWELI + 0.0203 WETH** (unchanged; deepen still needed).
> - TWAP floor `effectiveMinReserveFloor(PAIR)` = **10 WETH** (`1e19`) — B0 not yet started.
> - TWAP `owner()` = **`0x1489…456E`** (deployer EOA) — can call `proposeAdminMinReserveFloor1`
>   / `executeAdminMinReserveFloor1` (both exist; `FloorTooLow` guard is `< 1000` wei, so 1.0 WETH passes).
> - Arb venue (Uniswap `0x6682…104D`) = **7.26 WETH** → post-B1 native ~1.33 WETH gives a **~5.5× ratio**,
>   above the 3× safety floor. The **arb-linkage monitor is built + live-tested**:
>   `contracts/monitoring/arbLinkageMonitor.mjs` (run it before B4 and on a 5-min cron).
> - Owner-side precondition to confirm YOURSELF: the signing wallet holds ≥50M TOWELI + ~1.35 ETH.

> **Private send-path (anti-sandwich).** `flashbots` and `mevblocker` are now named RPC
> endpoints in `contracts/foundry.toml`, so any BROADCAST below can use `--rpc-url flashbots`
> directly (no `$FLASHBOTS_RPC` export needed — that var is the same URL). Route every
> `--broadcast` that MOVES the pool or TOUCHES the oracle (B1 deepen, B3 TWAP) through it so
> it can't be sandwiched/front-run; keep dry-runs and reads on the public `$RPC`. Private txs
> land in a few blocks — add `--slow` and expect slower receipt polling. (See docs/SECURITY_TOOLING.md.)

**B0 — Propose the floor lower to 1.0 WETH** (starts the 24h timelock). From the
TWAP owner (deployer EOA today; multisig after handoff): 🔑
```bash
cast send $TWAP "proposeAdminMinReserveFloor1(address,uint256)" $PAIR 1000000000000000000 \
  --rpc-url $RPC --private-key $OWNER_KEY        # 1e18 = 1.0 WETH
```

**B1 — Deepen the pool** with the 50M TOWELI — `script/DeepenLP.s.sol` (dry-run-
verified). From the wallet holding the TOWELI + ETH, via a Flashbots-Protect RPC: 🔑💰
```bash
cd contracts
export TO=<treasury Safe 0x7D26…Bd7d for protocol-owned LP, or your wallet>
export TOWELI_AMOUNT=50000000000000000000000000    # 50,000,000 TOWELI
export ETH_AMOUNT=1350000000000000000              # 1.35 ETH buffer (~1.31 used, rest refunded)
forge script script/DeepenLP.s.sol --rpc-url $FLASHBOTS_RPC --sender <wallet> -vvv   # dry-run
forge script script/DeepenLP.s.sol --rpc-url $FLASHBOTS_RPC --broadcast --private-key $KEY -vvv
```
Pool → ~50.8M TOWELI + ~1.33 WETH.

**B2 — Execute the floor lower** (after 24h): 🔑
```bash
cast send $TWAP "executeAdminMinReserveFloor1(address)" $PAIR --rpc-url $RPC --private-key $OWNER_KEY
```

**B3 — Bootstrap the TWAP** — `script/BootstrapTWAP.s.sol` (dry-run-verified; pays
the 0.0001-ETH fee, guards the floor). Run 4× ≥15 min apart until it reports ORACLE
WARM, then wait 60 min before any `POL.accumulate` (audit H-18). 🔑
```bash
forge script script/BootstrapTWAP.s.sol --rpc-url $RPC --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E -vvv  # dry-run (public RPC ok)
forge script script/BootstrapTWAP.s.sol --rpc-url flashbots --broadcast --slow --private-key $DEPLOYER_KEY -vvv  # ×4 — private send-path
```

**B4 — Deploy NFT-lending / token-lending at ≤ 50% LTV** with the arb-linkage
monitor + auto-pause wired (safety conditions above). Per each feature's audit wave.

## Bottom line
The swap/stake/farm loop is **live**; ship it to prod + hand off ownership (Track
A, no capital). The NFT-finance loop is **capital-gated** on TOWELI the protocol
doesn't hold — that's a strategy call (supply the bag, lower the floor, or wait),
not a code fix.
