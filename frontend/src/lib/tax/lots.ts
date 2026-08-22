// The lot matcher. Quantities always; money only when the money is known.
//
// ─── THE RULE THAT SHAPES EVERY BRANCH BELOW ────────────────────────────────
//
// An unknown is never a zero. Three unknowns turn up constantly in on-chain
// history and each has a tempting, wrong default:
//
//   a disposal with no acquiring lot  → tempting default: zero cost basis,
//                                       which reports the entire proceeds as
//                                       gain. That is the WORST possible guess
//                                       for the filer and it looks authoritative.
//   a lot with no recorded cost       → tempting default: zero, same problem.
//   a disposal with no recorded
//   proceeds                          → tempting default: zero, which reports a
//                                       total loss on an asset that may have
//                                       been sold at a profit.
//
// None of them is taken. Quantity matching still happens — that part is knowable
// — and the resulting row carries `gain: null` with a stated reason, is counted
// in `incompleteRows`, and is EXCLUDED from `totals`. `totals.complete` is false
// whenever any row was excluded, so a caller cannot render a headline number
// that quietly omits the rows it could not price.
//
// ─── HOLDING PERIOD IS REPORTED, NOT CLASSIFIED ─────────────────────────────
//
// `heldDays` is arithmetic. "Long-term" is a jurisdiction's threshold applied to
// it, and this file does not know anybody's jurisdiction, so it does not label
// one. See lib/tax/methods.ts, NOT_TAX_ADVICE.
//
// ─── VALUE UNITS ────────────────────────────────────────────────────────────
//
// `costBasis` and `proceeds` are integers in the minor unit of ONE quote
// currency, named once per report by `TaxLotInput.quoteCurrency`. They are not
// derived here from any price feed: this venue has no historical price oracle,
// so a value is present only when the caller genuinely had one, and is null
// otherwise. See lib/tax/events.ts for what the indexer can and cannot supply.

import type { CostBasisMethod } from './methods';

export interface AcquisitionEvent {
  kind: 'acquire';
  /** Stable per-event id. `spec-id` nominations point at these. */
  id: string;
  /** Contract address, lowercased, or a chain-native symbol. */
  asset: string;
  assetSymbol: string;
  /** Smallest-unit quantity acquired. */
  quantity: bigint;
  decimals: number;
  /** Total cost of the whole lot, in the report's quote currency. Null when unrecorded. */
  costBasis: bigint | null;
  /** Unix seconds. */
  timestamp: number;
  txHash: string;
}

export interface DisposalEvent {
  kind: 'dispose';
  id: string;
  asset: string;
  assetSymbol: string;
  quantity: bigint;
  decimals: number;
  /** Total proceeds, in the report's quote currency. Null when unrecorded. */
  proceeds: bigint | null;
  timestamp: number;
  txHash: string;
  /**
   * Acquisition ids this disposal nominates, in the order they should be
   * consumed. Only read under `spec-id`; under every other method the matcher's
   * own ordering is the method, and honouring a nomination would silently make
   * the report a different method than its own header claims.
   */
  nominatedLotIds?: string[];
}

export type TaxLotEvent = AcquisitionEvent | DisposalEvent;

/** Why a row could not be given a gain figure. Null when it could. */
export type IncompleteReason =
  /** No acquiring lot covered part or all of the quantity disposed. */
  | 'no-acquiring-lot'
  /** A consumed lot had no recorded cost. */
  | 'lot-cost-unrecorded'
  /** The disposal had no recorded proceeds. */
  | 'proceeds-unrecorded'
  /** `spec-id` and the disposal nominated nothing, or nominated a lot that is gone. */
  | 'no-nomination';

export const INCOMPLETE_REASON_TEXT: Record<IncompleteReason, string> = {
  'no-acquiring-lot':
    'No acquisition in the covered period accounts for this quantity, so its cost basis is unknown. It is NOT zero.',
  'lot-cost-unrecorded':
    'The acquiring lot has no recorded cost, so no gain can be computed. It is NOT a zero-cost lot.',
  'proceeds-unrecorded':
    'The venue records what was sent into this trade and never what came back, so the proceeds are unknown. They are NOT zero.',
  'no-nomination':
    'Specific identification was selected and this disposal nominates no surviving lot, so it is left unmatched rather than being matched by a fallback rule.',
};

export interface ConsumedLot {
  lotId: string;
  acquiredAt: number;
  quantity: bigint;
  /** Apportioned share of the lot's cost, or null when the lot had none. */
  costBasis: bigint | null;
}

export interface MatchedDisposal {
  disposalId: string;
  asset: string;
  assetSymbol: string;
  decimals: number;
  disposedAt: number;
  txHash: string;
  quantity: bigint;
  /** Quantity no lot covered. Never silently dropped and never assigned a basis. */
  unmatchedQuantity: bigint;
  lots: ConsumedLot[];
  proceeds: bigint | null;
  /** Sum of `lots[].costBasis`, or null when any consumed lot had none. */
  costBasis: bigint | null;
  /** `proceeds - costBasis`, or null. Null is not zero. */
  gain: bigint | null;
  /** Whole days between the earliest consumed lot and the disposal, or null. */
  heldDays: number | null;
  /** Empty when the row is fully priced. */
  incompleteReasons: IncompleteReason[];
}

export interface LotTotals {
  /** Sum of `gain` over rows that have one. */
  realisedGain: bigint;
  proceeds: bigint;
  costBasis: bigint;
  /** Rows that contributed to the sums above. */
  countedRows: number;
  /** Rows excluded because something in them was unknown. */
  incompleteRows: number;
  /**
   * False whenever `incompleteRows > 0`.
   *
   * The flag a surface must branch on before printing a headline. A total that
   * silently omits the rows it could not price is a smaller, cleaner, wrong
   * number, and it is the one a reader would quote.
   */
  complete: boolean;
}

export interface TaxLotInput {
  events: TaxLotEvent[];
  method: CostBasisMethod;
  /** Named once, stamped on the export. Values are minor units of this. */
  quoteCurrency: string;
}

export interface TaxLotResult {
  method: CostBasisMethod;
  quoteCurrency: string;
  disposals: MatchedDisposal[];
  totals: LotTotals;
  /** Lots still open at the end of the covered period. Not a gain of any kind. */
  openLots: { lotId: string; asset: string; assetSymbol: string; quantity: bigint; costBasis: bigint | null; acquiredAt: number }[];
}

interface OpenLot {
  id: string;
  asset: string;
  assetSymbol: string;
  decimals: number;
  remaining: bigint;
  /** Original lot size — the denominator for apportioning cost. */
  original: bigint;
  costBasis: bigint | null;
  acquiredAt: number;
}

const DAY = 86_400;

/**
 * Pick the next lot to consume, per method.
 *
 * The ordering IS the method, which is why it lives in one switch rather than
 * being spread across the loop: a method that is really two behaviours in two
 * places is a method that can drift from the label on the export.
 */
function pickLot(open: OpenLot[], method: CostBasisMethod, nominated: string[] | undefined): number {
  if (method === 'spec-id') {
    if (!nominated || nominated.length === 0) return -1;
    for (const id of nominated) {
      const idx = open.findIndex((l) => l.id === id && l.remaining > 0n);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  let best = -1;
  for (let i = 0; i < open.length; i++) {
    const lot = open[i]!;
    if (lot.remaining <= 0n) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const cur = open[best]!;
    if (method === 'fifo') {
      if (lot.acquiredAt < cur.acquiredAt) best = i;
    } else if (method === 'lifo') {
      if (lot.acquiredAt > cur.acquiredAt) best = i;
    } else {
      // HIFO — highest cost PER UNIT, not highest total. Comparing totals would
      // rank a large cheap lot above a small expensive one and would not be HIFO.
      // A lot with no recorded cost is never "highest": it is unknown, and
      // treating unknown as infinite (or as zero) would let the method choice
      // silently depend on a missing field. Known cost outranks unknown; among
      // unknowns the older lot wins so the result stays deterministic.
      const a = unitCost(lot);
      const b = unitCost(cur);
      if (a === null && b === null) {
        if (lot.acquiredAt < cur.acquiredAt) best = i;
      } else if (b === null) {
        best = i;
      } else if (a !== null && (a > b || (a === b && lot.acquiredAt < cur.acquiredAt))) {
        best = i;
      }
    }
  }
  return best;
}

/**
 * Cost per unit, scaled so integer division does not collapse small lots to
 * zero and reorder the whole method. Null when the lot has no recorded cost.
 */
function unitCost(lot: OpenLot): bigint | null {
  if (lot.costBasis === null || lot.original <= 0n) return null;
  return (lot.costBasis * 1_000_000_000_000n) / lot.original;
}

/**
 * Match disposals against acquisitions.
 *
 * Events are sorted by timestamp before matching, with acquisitions ahead of
 * disposals at an equal timestamp: a buy and a sell in the same block must let
 * the buy be available to the sell, or a same-block round trip reports as an
 * unmatched disposal and an open lot instead of as the wash it is.
 */
export function matchLots(input: TaxLotInput): TaxLotResult {
  const events = [...input.events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.kind !== b.kind) return a.kind === 'acquire' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const openByAsset = new Map<string, OpenLot[]>();
  const disposals: MatchedDisposal[] = [];

  for (const ev of events) {
    if (ev.kind === 'acquire') {
      if (ev.quantity <= 0n) continue;
      const list = openByAsset.get(ev.asset) ?? [];
      list.push({
        id: ev.id,
        asset: ev.asset,
        assetSymbol: ev.assetSymbol,
        decimals: ev.decimals,
        remaining: ev.quantity,
        original: ev.quantity,
        costBasis: ev.costBasis,
        acquiredAt: ev.timestamp,
      });
      openByAsset.set(ev.asset, list);
      continue;
    }

    const open = openByAsset.get(ev.asset) ?? [];
    let remaining = ev.quantity;
    const consumed: ConsumedLot[] = [];
    const reasons = new Set<IncompleteReason>();

    while (remaining > 0n) {
      const idx = pickLot(open, input.method, ev.nominatedLotIds);
      if (idx === -1) break;
      const lot = open[idx]!;
      const take = lot.remaining < remaining ? lot.remaining : remaining;

      // Apportion the lot's cost by the fraction taken. Integer division rounds
      // the basis DOWN, which rounds the reported gain UP — the direction that
      // never understates a gain by a rounding artefact.
      let share: bigint | null = null;
      if (lot.costBasis === null) {
        reasons.add('lot-cost-unrecorded');
      } else {
        share = take === lot.original ? lot.costBasis : (lot.costBasis * take) / lot.original;
      }

      consumed.push({ lotId: lot.id, acquiredAt: lot.acquiredAt, quantity: take, costBasis: share });
      lot.remaining -= take;
      remaining -= take;
    }

    if (remaining > 0n) {
      reasons.add(input.method === 'spec-id' && (ev.nominatedLotIds?.length ?? 0) === 0 ? 'no-nomination' : 'no-acquiring-lot');
    }
    if (ev.proceeds === null) reasons.add('proceeds-unrecorded');

    const costBasis = consumed.every((c) => c.costBasis !== null) && remaining === 0n && consumed.length > 0
      ? consumed.reduce((sum, c) => sum + (c.costBasis ?? 0n), 0n)
      : null;

    const gain = costBasis !== null && ev.proceeds !== null ? ev.proceeds - costBasis : null;

    const earliest = consumed.length > 0 ? Math.min(...consumed.map((c) => c.acquiredAt)) : null;

    disposals.push({
      disposalId: ev.id,
      asset: ev.asset,
      assetSymbol: ev.assetSymbol,
      decimals: ev.decimals,
      disposedAt: ev.timestamp,
      txHash: ev.txHash,
      quantity: ev.quantity,
      unmatchedQuantity: remaining,
      lots: consumed,
      proceeds: ev.proceeds,
      costBasis,
      gain,
      heldDays: earliest === null ? null : Math.max(0, Math.floor((ev.timestamp - earliest) / DAY)),
      incompleteReasons: [...reasons],
    });

    // Drop exhausted lots so `pickLot` stays linear in what is actually open.
    openByAsset.set(ev.asset, open.filter((l) => l.remaining > 0n));
  }

  let realisedGain = 0n;
  let proceeds = 0n;
  let costBasis = 0n;
  let countedRows = 0;
  let incompleteRows = 0;
  for (const d of disposals) {
    if (d.gain === null || d.proceeds === null || d.costBasis === null) {
      incompleteRows++;
      continue;
    }
    realisedGain += d.gain;
    proceeds += d.proceeds;
    costBasis += d.costBasis;
    countedRows++;
  }

  const openLots: TaxLotResult['openLots'] = [];
  for (const list of openByAsset.values()) {
    for (const lot of list) {
      if (lot.remaining <= 0n) continue;
      openLots.push({
        lotId: lot.id,
        asset: lot.asset,
        assetSymbol: lot.assetSymbol,
        quantity: lot.remaining,
        // Apportioned to what is left, so an open-lot table does not report the
        // full purchase cost of a position that is mostly sold.
        costBasis:
          lot.costBasis === null || lot.original <= 0n ? null : (lot.costBasis * lot.remaining) / lot.original,
        acquiredAt: lot.acquiredAt,
      });
    }
  }
  openLots.sort((a, b) => a.acquiredAt - b.acquiredAt);

  return {
    method: input.method,
    quoteCurrency: input.quoteCurrency,
    disposals,
    totals: {
      realisedGain,
      proceeds,
      costBasis,
      countedRows,
      incompleteRows,
      complete: incompleteRows === 0,
    },
    openLots,
  };
}
