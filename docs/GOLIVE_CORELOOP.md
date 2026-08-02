# Core-Loop Go-Live — ⚠️ the "Verified state" table is SUPERSEDED (2026-08-01)

> **⚠️ SUPERSEDED — re-read on-chain 2026-08-01, block 25,664,356**
> (`https://ethereum-rpc.publicnode.com`; historical reads via `https://eth.drpc.org`,
> because publicnode 403s archive blocks). Everything below the horizontal rule is
> a **2026-07-11 / 07-18 historical record, not current state.** Four headline
> claims have reversed:
>
> | Claim below | Reality on 2026-08-01 | Read with |
> |---|---|---|
> | pool = 776,678 TOWELI + 0.0203 WETH, ~$73 (`Native TOWELI/WETH pool` + `Native pool depth` rows, lines 57/59) | **146,258.41 TOWELI + 0.003830891 WETH** — ≈$14 on the same ~$1.8k/ETH basis the "$73" used | `cast call $PAIR "getReserves()(uint112,uint112,uint32)"` |
> | 125.0 of 125.7 LP staked in LP Farming (`Native LP ownership` row, line 60) | **LP Farming holds 0 LP.** Pair `totalSupply` fell **138.031 → 23.666 LP (82.85 % burned)** between block 25,600,000 and 25,664,356 | `balanceOf($FARM)`=0, `totalSupply()`; archive at block 25,600,000 → 138.031 / 125.000 |
> | "farming is live" (same `Native LP ownership` row, line 60 — struck through there) | **Wrong even when written.** `periodFinish()` = `1781493095` → the reward period ended **2026-06-15**, 26 days *before* this doc was authored. LP was staked; emissions were not flowing. (Same finding: `WORKORDER_V2.md:56`.) | `cast call $FARM "periodFinish()(uint256)"` |
> | "the swap/stake/farm half of the loop is LIVE" (`Already live / done`, lines 68-71; the old "## Bottom line" said the same and has been rewritten in place) | The **contracts** are live. The **economics** are not: `SwapFeeRouter.totalETHFees()` = **0**, and that is a lifetime counter (`contracts/src/SwapFeeRouter.sol:88`, written only by `+=` at `:711/:781/:974`, never reset) — the front door has **never collected one wei of fee**. `RevenueDistributor` ETH balance = 0. | `cast call $SFR "totalETHFees()(uint256)"`; `cast balance $RD` |
>
> **Still true on 2026-08-01, re-read the same way — do not "fix" these:**
> `TegridyTWAP.effectiveMinReserveFloor($PAIR)` = `1e19` (**10 WETH**) → **B0 was never
> proposed**; the Track-B sequence below is unstarted and still valid *as a sequence*.
> `stakerShareBps()` = `10000`; `polAccumulator()` = `0x0`. Uniswap arb venue = **7.4936 WETH**
> (the 7.26 at line 139 is ~3 % stale, harmless).
>
> **What this changes about Track B:** B1's "~1.31 ETH pairs with 50M TOWELI" was derived
> from the old reserves. The *ratio* barely moved (native 3.818e7 vs the old 3.826e7
> TOWELI/ETH — the burn was proportional), so ~1.31 ETH is still the right order of
> magnitude — but **re-derive from live `getReserves()` immediately before broadcasting,
> do not trust this doc's number.** The pool is now **1,956×** shallower than Uniswap
> (was 360×) and **2,610×** below the 10-WETH floor (line 80 says ~500×).
>
> **Re-verify this banner before acting on it (read-only, ~30 s):**
> ```bash
> RPC=https://ethereum-rpc.publicnode.com
> PAIR=0x55875887B43C2E23aE424AF0FC8606Fdb058a481
> FARM=0x1171268AE5B69791c47Fd589b7825932c957e149
> SFR=0x6d5791A660e79175F74C6D639584C98422d5956E
> TWAP=0xdFdd6D72539A425dC917F49FB834901105cA98c9
> cast call $PAIR "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC
> cast call $PAIR "totalSupply()(uint256)"               --rpc-url $RPC
> cast call $PAIR "balanceOf(address)(uint256)" $FARM     --rpc-url $RPC
> cast call $FARM "periodFinish()(uint256)"               --rpc-url $RPC
> cast call $SFR  "totalETHFees()(uint256)"               --rpc-url $RPC
> cast call $TWAP "effectiveMinReserveFloor(address)(uint256)" $PAIR --rpc-url $RPC
> ```

---

**Original snapshot — written 2026-07-11, re-verified 2026-07-18. Kept verbatim as the
historical record. Every figure below is as-of those dates.**

Read directly from mainnet (`ethereum-rpc.publicnode.com`) + forge-simulated
against live state. Supersedes the "empty pool / seed LP first" assumption in the
older memory — **the native pool is already seeded.** *(true 2026-07-11; ~83 % of that
LP has since been burned — see banner)*

## Verified state *(as of 2026-07-11 / 07-18 — SUPERSEDED 2026-08-01, see banner)*
| Fact | Value |
|---|---|
| Native TOWELI/WETH pool (`0x5587…a481`) | **SEEDED**: 776,678 TOWELI + 0.0203 WETH |
| Native price vs Uniswap | ~38.26M TOWELI/ETH — **0.28% off Uniswap** (aligned, no arb) |
| Native pool depth | ~$73 (Uniswap ~$26,400 — **360× deeper**) |
| Native LP ownership | 125.0 of 125.7 LP (99.5%) staked in LP Farming — ~~farming is live~~ **← WRONG WHEN WRITTEN: `periodFinish()` = 2026-06-15, so emissions had already ended 26 days earlier. Staked LP ≠ live emissions. As of 2026-08-01 the farm holds 0 LP.** |
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

> **2026-08-01 correction.** "Live" here means *deployed and callable*, not *earning*.
> `SwapFeeRouter.totalETHFees()` is still `0` — the lifetime counter has never moved, so
> zero swap-fee ETH has ever reached `RevenueDistributor`. LP-farming emissions ended
> 2026-06-15. Read this section as a deployment inventory, not a revenue claim.

## 🚧 THE GATE: oracle-dependent features are blocked on pool depth
`TWAP.update()` rejects the pool with **`ReservesBelowFloor()`** — the WETH side
(0.0203 on 2026-07-11; **0.00383 on 2026-08-01**) is ~500× — now **~2,610×** — below the 10-WETH floor (an anti-manipulation guard). So the
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

> **⚠️ Pre-flight re-verified on-chain 2026-07-18 — the reserve figures below EXPIRED on/before 2026-08-01** (the floor / owner / arb-ratio lines still hold; see the banner at the top). B0–B4 remain valid as a *sequence*; their input amounts must be re-derived live:
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

*(rewritten 2026-08-01 against live chain state — supersedes the 2026-07-11 text)*

The swap/stake/farm contracts are **deployed and callable**; the loop is **not yet
earning**. `SwapFeeRouter.totalETHFees()` = 0 (never a single wei), LP-farming emissions
ended 2026-06-15, and the native pool has been drawn down to **0.00383 WETH** (~$14) with
**0 LP** left in the farm. Track A (ship the frontend, hand off ownership) is still capital-
free and still the right first move. The NFT-finance loop stays **capital-gated** — and the
capital ask is now *larger* than this doc's Track B says, because the pool it was sized
against no longer exists at that depth. Re-derive B1 from live `getReserves()` before
broadcasting anything.
