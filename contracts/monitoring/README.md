# Monitoring

Operational, read-only monitors. They NEVER sign; they observe on-chain state and
emit a status + exit code an operator hook / cron / alerting pipeline can act on.

## `arbLinkageMonitor.mjs`

The load-bearing safety condition for the core-loop **oracle unlock**
([`docs/GOLIVE_CORELOOP.md`](../../docs/GOLIVE_CORELOOP.md), condition 3 / B4).

The TWAP reads the **native** TOWELI/WETH pool. That pool is safe from price
manipulation **only while the deeper, arb-linked Uniswap pool keeps it honest**
(pump the native pool → arbitrageurs bridge price from Uniswap → a sustained TWAP
dislocation is EV-negative). The review's load-bearing assumption is *"the native
pool is not the only liquid venue."* This monitor makes that observable.

It compares WETH depth of the two pools and exits:

| Status | Exit | Meaning / action |
|---|---|---|
| ✅ GO | 0 | Uniswap WETH ≥ 4× native, native ≥ live floor — linkage healthy |
| ⚠️ WARN | 1 | ratio < 4×, or native below the 1.0-WETH live floor — react/deepen |
| 🛑 HALT | 2 | ratio **< 3×** or native empty — **emergency-pause** oracle features (NFT-lending, token-lending, `POL.accumulate`) |
| 🛑 ERROR | 2 | monitor couldn't read chain — fails LOUD (never reads as healthy) |

**Run**
```bash
node arbLinkageMonitor.mjs            # human-readable; exit code = severity
node arbLinkageMonitor.mjs --json     # one JSON line for alerting/cron
```

**Cron (every 5 min, page on HALT — exit ≥ 2):**
```bash
*/5 * * * * cd .../contracts/monitoring && node arbLinkageMonitor.mjs --json >> arb.log 2>&1 || page-oncall
```

Dependency-free (raw JSON-RPC over `fetch`, node ≥ 18). Keyless RPC roster with
fallback (publicnode/drpc/merkle). Tunable via env: `HALT_RATIO` (default 3),
`WARN_RATIO` (4), `LIVE_FLOOR_WETH` (1.0), `NATIVE_PAIR`, `UNISWAP_PAIR`, `WETH`, `RPC`.

**The auto-pause half** is a separate operator hook that consumes a HALT (exit 2 /
`{"status":"HALT"}`) and calls the relevant `PauseGuardian` — kept out of this
read-only monitor by design (the monitor holds no keys).

Verified against live mainnet 2026-07-18: native 0.0203 WETH (pre-deepen) →
WARN (below the 1.0 floor); after B1 deepens native to ~1.33 WETH the ratio is
~5.5× → GO.
