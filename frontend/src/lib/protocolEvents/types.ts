// Proof-of-life event model — the UNIFIED render shape for the Protocol Pulse feed.
//
// Originally the pulse surfaced only TOWELI buys/sells (useProtocolActivity). This
// file widens that model into `PulseItem` so more TRUE protocol events can share one
// render path: fee captures (RevenueDistributor), protocol-owned-liquidity deepening
// (POLAccumulator), gauge votes (GaugeController), and graded launches
// (/api/launcher-outcomes).
//
// HONEST-FRAMING LAW: every field is REAL or absent. A protocol-level event only ever
// exists because a real on-chain counter moved (see onchainDeltas.ts) or a real graded
// launch record exists (see launchEvents.ts). Nothing here fabricates a count, a value,
// or a timestamp — a quiet protocol yields ZERO items and the UI renders nothing.
//
// Ownership note: this pure module owns the type; src/hooks/useProtocolActivity.ts
// re-exports `PulseItem` for back-compat so the trades hook and the event adapters
// share exactly one shape.

/**
 * Pulse event kinds.
 *  - 'buy' | 'sell'  → a real TOWELI trade (GeckoTerminal). Base fields only.
 *  - 'fee'           → RevenueDistributor settled a distribution (ETH → stakers).
 *  - 'pol'           → POLAccumulator deployed ETH into protocol-owned liquidity.
 *  - 'gauge'         → GaugeController voting weight changed this epoch.
 *  - 'launch'        → a launch that met a structural tier graduated (Fact Sheet).
 */
export type PulseKind = 'buy' | 'sell' | 'fee' | 'pol' | 'gauge' | 'launch';

/**
 * One item in the proof-of-life feed. Trades populate only the base fields; the
 * protocol-level events additionally set `title`/`detail`/`href` for a headline row
 * that isn't tied to a single trader address.
 */
export interface PulseItem {
  /** Stable, collision-free id (also the React key + cross-poll dedupe key). */
  id: string;
  kind: PulseKind;
  /**
   * USD value when known (trades). 0 for protocol-level events whose value is
   * expressed in ETH via `detail` — never invent a USD figure for them.
   */
  usd: number;
  /** Trader/actor address for trades; '' for protocol-level events. */
  actor: string;
  /** Single tx hash when the event maps to one tx; '' for delta-observed events. */
  txHash: string;
  /**
   * Unix seconds. Trades: block time. Delta-observed events (fee/pol/gauge): the
   * observation time — the counter is known to have moved within the poll window,
   * which we state honestly ("just now") rather than claiming a precise block time.
   * Launches: the graduation time (launchedAt).
   */
  ts: number;
  /** Highlight flag — a sizeable move (whale trade, large distribution, deep POL add). */
  whale: boolean;

  // ── protocol-level extras (undefined for trades) ────────────────────────────
  /** Headline for a non-trade event, e.g. "Protocol fees distributed". */
  title?: string;
  /** Secondary line, e.g. "0.0123 ETH → stakers". Value strings only, never fabricated. */
  detail?: string;
  /** Etherscan link when there is no single tx (links the contract / token address). */
  href?: string;
}
