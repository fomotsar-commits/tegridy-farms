# Tegridy Swap & Liquidity — Revenue Architecture

Status: **framework draft, 2026-06-07.** Canonical reference for how the protocol earns
on swaps and hosts liquidity. Supersedes ad-hoc routing decisions in `useSwap`/`SwapFeeRouter`.

## The problem this resolves

On-chain facts verified 2026-06-07:
- The native Tegridy TOWELI/WETH pool (`0x5587…a481`) was empty until a 0.01 ETH seed; it
  loses every price race, so ~no volume → ~no LP fees.
- `SwapFeeRouter.router` points at the **internal TegridyRouter**, not real Uniswap, so it
  can only execute on our own (thin/empty) pools — it reverts, and can't skim a fee on
  deep-liquidity swaps. (This is also the "$7 gas" symptom: wallet shows a fallback estimate
  for a tx that would revert.)
- The frontend's aggregator integration (`aggregator.ts`) is **quote-only** — it shows the
  best external price, then executes on our own router. The protocol captures nothing from
  that volume.
- ~**99.9997% of the Uniswap TOWELI/WETH LP is locked in UNCX until ~2093–2094 (~69 yr)**
  (locks #0+#1, owner `0x5f1E057C…23a048`). That liquidity is permanent + routable but its
  V2 fees are **not extractable** (compound into a locked position; can't migrate to V4).

Net today: the protocol carries all the cost (UI, infra, SFR gas) and captures none of the value.

## Principles

1. **Decouple fee capture from liquidity location.** Earn on every swap from day one,
   regardless of whether execution lands on our pool, Uniswap, or an aggregator.
2. **Own the economics, route to best execution.** Never quote users a worse price to force
   volume into a young pool — route to the genuine best venue and take a modest, disclosed fee.
3. **Set up routability *before* depth accrues.** Standardize + index + list now, so accruing
   liquidity converts to routed volume instead of stranded liquidity.
4. **Minimal incremental surface.** Reuse audited contracts; new custom code only where it
   earns its keep (per the protocol's minimal-attack-surface mandate).

## The three layers

### Layer 1 — Smart front door (fee + best-execution routing) — *build first*
One canonical entry that: (a) takes a small **disclosed** protocol fee, (b) routes to the best
venue across **our own pools, Uniswap, and DefiLlama-style meta-aggregation**, (c) sends the fee
to `RevenueDistributor` → stakers / treasury / POL.
- Replaces today's fragmented "TegridyRouter (no fee) vs mis-wired SFR."
- **Routing intelligence: DefiLlama/LlamaSwap style** (extend the existing quote layer to fetch
  *executable* calldata). LlamaSwap is fee-free by design, so the fee is captured at **our**
  layer, not theirs. Keep the fee modest (~0.1–0.3%) so we stay DefiLlama-aligned (best price,
  no gouging). Spendable revenue from day one, no own-capital required.

### Layer 2 — Liquidity venue (our multi-pair AMM + Uniswap POL)
- **Our AMM (TegridyFactory/Pair/Router):** hosts arbitrary pairs (`createPair`). Earns full LP
  fee + the 1/6 protocol cut when volume routes through it. This is the sovereign-DEX product.
- **Uniswap POL:** TOWELI/WETH base depth lives on Uniswap (locked) → routable today, forever.
  New, *unlocked* POL is what we actively manage (claim fees, concentrate, migrate to V4).
- The front door (Layer 1) treats both as candidate venues.

### Layer 3 — Flywheel (bootstrap + compound)
- A fee slice → POL (`polShareBps`) → deeper own-pools → more routed volume → more fees.
- **Gauges + vote-incentives + LP farming** direct TOWELI emissions to the pairs we want deep.
  This is the engine for multi-pair liquidity (Velodrome/Aerodrome model).

## Multi-pair hosting — what "set up for success" requires

Creating a pair is trivial; making it a venue aggregators route to is the work:

1. **Interface standardization (decision required).** The pair's non-standard hot-path reverts
   (`NO_FLASH_SWAPS` rejecting callback data; `disabledPairs`/`blockedTokens`; FoT post-checks)
   can fail aggregator router simulation / break flash-callback multi-hop → pools get skipped.
   Decide per-revert: relax for routability vs keep for safety (touches audited contracts → re-audit).
2. **Discoverability.** Deterministic CREATE2 init-hash (the router currently avoids it via
   `getPair`) **or** commit to the indexer path: a live subgraph/Ponder feed publishing all
   pairs + reserves, plus DefiLlama adapters (TVL + fees/volume) and per-aggregator DEX-list
   submissions (1inch/0x/Paraswap/Kyber/LlamaSwap).
3. **Per-pair liquidity** via gauge/farming emissions — no routing without depth.
4. **Capital efficiency** — see keystone decision.

## Revenue map (where each dollar comes from)

| Source | When | Spendable? |
|---|---|---|
| Front-door interface fee (Layer 1) | Day one, on all our traffic | **Yes** — primary cash flow |
| Own-pool LP fee + 1/6 protocol cut | When our pool wins routing | **Yes** |
| Uniswap POL LP fee (new, unlocked) | When that pool is routed | Yes (on withdraw / V4 claim) |
| Locked Uniswap base LP fee | 2093–94 | **No** — routability + trust asset only |

## Keystone decision — how to host competitive multi-pair liquidity

- **(i) Own V2 factory (what's built).** Full sovereignty, your contracts, your fee/listing
  control. But capital-inefficient (full-range) and integration-heavy; loses to concentrated
  liquidity on blue-chip pairs.
- **(ii) Uniswap V4 pools + Tegridy hook (built, audit-gated).** Capital-efficient
  (concentrated), natively routable (lives in Uniswap's PoolManager), hook captures a protocol
  fee. But pools aren't in your factory (less "sovereign"), and conservative aggregators may
  skip custom-fee hooks.
- **(iii) Both.** V2 factory for long-tail/own-token pairs + bootstrapping; V4-hook pools for
  competitive/blue-chip pairs needing depth efficiency. Front door routes across all.

**Recommendation:** **(iii)**, sequenced — ship Layer 1 + standardize the existing V2 factory
for routability now; bring V4-hook pools online (post-audit) for pairs where concentration is
required to win. Gauges/farming point at whichever venue hosts each target pair.

## Build sequence

1. **Layer 1 front door** — venue-agnostic fee router + executable best-route calldata
   (DefiLlama/LlamaSwap or 0x/1inch under the hood) + fee → `RevenueDistributor`. *(no capital)*
2. **On-chain leg fix** — repoint/redeploy `SwapFeeRouter` at real Uniswap as the trustless
   fee path (it was designed for this; deploy is an operator action).
3. **Discoverability** — indexer surfaces all Tegridy pairs; submit DefiLlama + aggregator DEX
   listings; resolve the interface-standardization decision.
4. **Flywheel** — deploy the prepped LP farming; set `polShareBps`; aim gauges at target pairs.
5. **V4** — hook pools for competitive pairs (post its audit), migrate active POL.

## Open decisions
- Aggregator under the hood for Layer 1 execution (LlamaSwap routing + our-layer fee, vs 0x/1inch
  affiliate fee). *Verify LlamaSwap's API exposes executable calldata / any referral param.*
- Interface-standardization: which safety reverts to relax for aggregator routability.
- V4 timing (gated on its audit) and which pairs go V2 vs V4.
