# Agent 084 — Indexer Audit (AUDIT-ONLY)

**Mission:** Forensic audit of `indexer/src/index.ts` and `indexer/*` config.
Cross-referenced against Agent 039's events report (263 events across 24 contracts; 9 contracts subscribed; 23 event handlers).

## Files Inspected
- `indexer/src/index.ts` (480 LOC, 23 handlers)
- `indexer/ponder.config.ts` (423 LOC, 9 contracts, 9 inline ABIs)
- `indexer/ponder.schema.ts` (256 LOC, 14 tables)
- `indexer/package.json` (ponder ^0.8.30, viem ^2.21.0)

## Summary Counts
- **HIGH:** 5
- **MEDIUM:** 7
- **LOW:** 4
- **INFO:** 3
- **Total:** 19 findings
- Subscribed contracts: 9 / 24 (37.5% coverage)
- Subscribed events: 23 / 263 (8.7% coverage)
- Tables: 14 (all use `primaryKey()`; no explicit UNIQUE composites)

---

## HIGH

### IDX-H1 — GaugeController entirely unsubscribed (commented-out "deferred")
- **Loc:** `ponder.config.ts:419-420` ("MemeBountyBoardExtras + CommunityGrantsExtras + GaugeController registrations deferred")
- **Cross-ref:** Agent 039 H-EVT-05.
- **Impact:** Voter dashboard impossible. `Voted`, `VoteCommitted`, `VoteRevealed`, `GaugeAdded/Removed`, `EmissionBudgetUpdated` all silently dropped.
- **Severity:** HIGH — gauge governance is core to the protocol value flow.

### IDX-H2 — TegridyPair (DEX core LP) entirely unsubscribed
- **Cross-ref:** Agent 039 H-EVT-02. No `Mint`, `Burn`, `Swap`, `Sync` indexed.
- **Impact:** All DEX volume / TVL / per-pool history is irrecoverable from the indexer. Frontend price charts must fall back to raw RPC, which will throttle and break under load. `SwapFeeRouter:SwapExecuted` only covers fee-routed swaps, **not** direct router calls.

### IDX-H3 — No reorg/finality / confirmations setting in config
- **Loc:** `ponder.config.ts:354-359` chain config has only `id` and `rpc`. No `pollingInterval`, no `maxRequestsPerSecond`, **no explicit finality block depth.**
- **Impact:** Ponder's default reorg handling is shallow on mainnet. A 2–7 block reorg can double-count `stakingAction` / `swap` / `lpFarmAction` rows because the handlers `insert` directly with `id = event.log.id` — but reorged logs reuse the SAME log id only if Ponder's reorg layer rewinds correctly. If reorg detection lags, a re-emitted event lands as `INSERT … (id collision)` and either silently overwrites or throws, depending on Ponder's reconciler.
- **Recommendation:** Add explicit `chains.mainnet.disableCache: false` and document expected finality (mainnet ≥12 blocks). Verify Ponder 0.8.30 default `safeBlock` semantics.

### IDX-H4 — Paused/Unpaused not subscribed for ANY of 13 pausable contracts
- **Cross-ref:** Agent 039 H-EVT-01.
- **Impact:** Frontend cannot render "protocol paused" banner from indexed data. Users hit `EnforcedPause()` reverts blind. Currently zero handlers exist for `Paused(address)` / `Unpaused(address)` (the OZ defaults).

### IDX-H5 — Schema mismatch: `EarlyWithdrawn` ABI declares 4 args, handler reads 3
- **Loc:** `ponder.config.ts:30-34` declares `(user, tokenId, amount, penalty)` (4 args). `index.ts:81-83` destructures only `{ user, tokenId, amount }` — the `penalty` field is **silently dropped** and never written. The contract emits `penalty` (per Agent 039), so frontend has no path to display the slashing penalty actually charged on early withdrawals.

---

## MEDIUM

### IDX-M1 — `Restaked` ABI declares `positionAmount` but handler doesn't store it
- **Loc:** `ponder.config.ts:69-74` declares `(user, tokenId, positionAmount)`. `index.ts:186-201` reads only `{ user, tokenId }`. The `restakingPosition` table has no `amount` column at all. Cross-ref Agent 039 H-EVT-03: emergency reconciliation depends on this.

### IDX-M2 — `restakingPosition` upsert with `Unrestaked` does NOT clear `user`, only zeroes `depositTime`
- **Loc:** `index.ts:203-216`. After unrestake, the `user` field still points to the prior owner — anyone querying `WHERE user=X AND depositTime=0` cannot distinguish "currently empty" from "never restaked."

### IDX-M3 — `stakingPosition` upsert on `Withdrawn` / `EarlyWithdrawn` zeros position but keeps row
- **Loc:** `index.ts:49-79`, `81-111`. A withdrawn position is `amount=0` but row remains; UI must filter `amount > 0n` everywhere. Better: set a `closed: bool` flag or actually delete.

### IDX-M4 — Backfill startBlock 24500000 may be too low/old for some contracts
- **Loc:** `ponder.config.ts:368, 374, 380, 386, 398, 404, 410, 416` all use `startBlock: 24500000` for 8 of 9 contracts. Only LPFarming uses `24910270` (the post-redeploy block). If TegridyStaking v1 (the deprecated `0x65D8...a421`) was deployed BEFORE 24500000 and v2 (`0x6266...4819`) AFTER, the indexer is fine. But **if any contract address listed was deployed AFTER 24500000**, Ponder still attempts `eth_getLogs` for blocks where the contract didn't exist, wasting RPC calls (cheap empty responses). If **deployed before**, history is missing. **Verify each address's deploy block.**

### IDX-M5 — No idempotency guard beyond primary-key collision
- **Loc:** All handlers `insert(...).values({ id: event.log.id, ... })` without `.onConflictDoNothing()` for action-log tables (`stakingAction`, `revenueClaim`, `gaugeVote`, `bribeDeposit`, `bribeClaim`, `swap`, `lpFarmAction`, `proposalVote`, `restakingClaim`).
- **Impact:** On a Ponder retry after partial commit (RPC blip mid-batch), re-processing the same log raises a duplicate-key error, halting sync. `event.log.id` is the right idempotency key but the `INSERT` is not idempotent.
- **Fix:** Add `.onConflictDoNothing()` on the action-log inserts.

### IDX-M6 — RPC fallback list trusts the RPC implicitly
- **Loc:** `ponder.config.ts:328-345`. `fallback([http(url1), http(url2), ...])` returns `eth_getLogs` from whichever responds first. No log-hash cross-validation between providers. A compromised RPC can spoof `eth_getLogs` for a target address — Ponder will index forged events as truth.
- **Impact:** Indexer is a single-source-of-truth oracle for the frontend; spoofed `Claimed`/`SwapExecuted` would corrupt user history.
- **Mitigation:** Use only authenticated, trusted-vendor RPC (Alchemy/Infura/QuickNode); document in deploy README.

### IDX-M7 — RevenueDistributor cumulative tracking missing
- Cross-ref Agent 039 M-EVT-05. Each `Claimed` row has `(fromEpoch, toEpoch, ethAmount)` but no aggregate per-user lifetime claimed. A `revenueClaimSummary` rollup table (or a view) would make dashboards O(1).

---

## LOW

### IDX-L1 — `bounty.winner` is nullable but never validated
- **Loc:** `ponder.schema.ts:255` `winner: t.hex()` (no `.notNull()`). Insert with `winner: null` (line 469). `BountyCompleted` update sets winner. OK pattern, just confirm UI handles nullable.

### IDX-L2 — No explicit composite UNIQUE on `bribeDeposit (epoch, pair, depositor)` or `gaugeVote (user, epoch, pair)`
- A single `(user, epoch, pair)` should appear at most once per `GaugeVoted`. Currently keyed only by `event.log.id`. If contract emits twice (bug or replay), two rows survive.

### IDX-L3 — Timestamp source is `event.block.timestamp` — relies on RPC honesty
- A spoofed RPC could lie about `block.timestamp`. Indexer trusts it directly for `timestamp` in 14 tables. No epoch-window validation.

### IDX-L4 — package.json double `engines` block
- **Loc:** `package.json:6-8` AND `package.json:24-26` both define `engines.node`. The second overrides. Version mismatch (`>=20.0.0` vs `>=18.0.0`).

---

## INFO

### IDX-I1 — Ponder's built-in /health and /ready endpoints are sufficient (per audit comment line 347-351). No custom HTTP server needed. Confirmed.

### IDX-I2 — Inline ABIs (event-only, no functions) — clean separation, no risk of accidental write encoding.

### IDX-I3 — Helpful audit annotations already present (`AUDIT INDEXER-H1`, `M1`, `M2`, `OBS`, `SEC`) showing prior hardening passes.

---

## Cross-Reference With Agent 039's Events Report

Agent 039 found **263 events across 24 contracts**; this indexer subscribes only **9 contracts / 23 event handlers**. The Top-5 missing event subscriptions (impact-ranked, drawn from Agent 039's own Top-5 + this audit's evidence) are below.

---

## Top-5 Missing Event Subscriptions (returned to caller)

1. **`TegridyPair:Swap` / `Mint` / `Burn`** — DEX volume & TVL unrecoverable.
2. **`Paused` / `Unpaused`** across all 13 pausable contracts — UI cannot render "paused" state.
3. **`GaugeController:*`** (entire surface, deferred) — gauge votes & emission budget changes invisible.
4. **`VoteIncentives:VoteCommitted/VoteRevealed/EpochAdvanced`** — commit-reveal voting & epoch boundaries not indexed (note `EpochAdvanced` IS in the ABI but has NO handler in `index.ts`).
5. **`TegridyRestaking:PositionRefreshed / BoostRevalidated / EmergencyForceReturn`** — admin reconciliation desyncs `restakingPosition` from chain reality.

---

## Recommendations (priority order)
1. Add idempotency `.onConflictDoNothing()` on all action-log inserts (IDX-M5).
2. Subscribe `Paused/Unpaused` and `GaugeController` (IDX-H1, H4).
3. Fix `EarlyWithdrawn` schema mismatch — add `penalty` column (IDX-H5).
4. Add `EpochAdvanced` handler (ABI declared but no handler exists).
5. Verify each contract's deploy block matches `startBlock` (IDX-M4).
6. Document required RPC providers as authenticated only (IDX-M6).
7. Subscribe `TegridyPair` for DEX surface (IDX-H2).
