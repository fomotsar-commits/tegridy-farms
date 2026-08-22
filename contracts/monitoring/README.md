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
| GO | 0 | Uniswap WETH ≥ 4× native, native ≥ live floor — linkage healthy |
| WARN | 1 | ratio < 4×, or native below the 1.0-WETH live floor — react/deepen |
| HALT | 2 | ratio **< 3×**, or either venue cannot quote — **pause the oracle features** |
| ERROR | 2 | the chain could not be read. **UNKNOWN, never healthy** |

**Run**
```bash
node arbLinkageMonitor.mjs            # human-readable; exit code = severity
node arbLinkageMonitor.mjs --json     # one JSON line for alerting/cron
```

Dependency-free (raw JSON-RPC over `fetch`, node ≥ 20). Keyless RPC roster with
fallback (publicnode/drpc/merkle). Tunable via env: `HALT_RATIO` (default 3),
`WARN_RATIO` (4), `LIVE_FLOOR_WETH` (1.0), `MAX_BLOCK_AGE_SEC` (600), `CHAIN_ID`
(1), `NATIVE_PAIR`, `UNISWAP_PAIR`, `WETH`, `RPC`.

### What it refuses to report

The whole point of this monitor is a verdict someone will act on, so it is built
to be incapable of a confident answer it did not read:

- **One endpoint, one block.** Every read in an observation comes from a single
  endpoint pinned to a single block. Sourcing half the reads elsewhere would
  produce a ratio between two numbers that were never simultaneously true.
- **WETH membership is verified, not assumed.** Both `token0()` and `token1()`
  are read and one of them must be WETH. A pool that holds no WETH is refused
  rather than having its other reserve reported as "WETH depth".
- **The chain id is checked.** An endpoint serving a different chain is refused.
- **A stale head is a failure.** A view more than `MAX_BLOCK_AGE_SEC` behind is
  ERROR, because depth read from an old block is not the current picture.
- **A venue that cannot quote is HALT, not a large ratio.** A pool holding 9 WETH
  and zero TOWELI divides to the healthiest-looking multiple this monitor can
  print, and arbs nothing.
- **Every endpoint failing is ERROR at exit 2**, with no depth figures at all.

The rule and the reads live in [`lib/arbLinkage.mjs`](lib/arbLinkage.mjs) so the
watcher and the pause-preparation tool cannot drift apart on what "broken" means.

```bash
node --test contracts/monitoring/lib/arbLinkage.test.mjs
```

## The auto-pause half

[`scripts/monitoring/arbPauseConsumer.mjs`](../../scripts/monitoring/arbPauseConsumer.mjs)
consumes a HALT and renders the exact privileged call — target, function,
argument, calldata, and who is currently authorised to send it, with what that
address has actually been observed to do on-chain.

**It holds no key and sends nothing**, by design: a key that can pause on a
schedule is a key living in CI, and a false HALT that pauses automatically is a
self-inflicted outage with no human in the loop. The automation ends at
preparation, so time-to-pause is bounded by a human reading a notification. That
is the trade, stated plainly.

```bash
node scripts/monitoring/arbPauseConsumer.mjs            # human report
node scripts/monitoring/arbPauseConsumer.mjs --json     # machine readable
node scripts/monitoring/arbPauseConsumer.mjs --probe    # CI; writes GITHUB_OUTPUT, never fails
```

## The cron

[`.github/workflows/arb-linkage-monitor.yml`](../../.github/workflows/arb-linkage-monitor.yml)
runs the probe every 15 minutes and opens a deduplicated `arb-linkage` issue on
HALT or on an unreadable chain. WARN is an annotation only — WARN is the standing
state until B1 deepens the native pool, and a permanently-open issue is a muted
one.

The 5-minute figure this file used to prescribe is not achievable on GitHub's
scheduler, which delays runs under load and disables schedules in a repository
idle for 60 days. If a TWAP-dependent feature ever carries real value, this
belongs on a scheduler that can be held to its interval.
