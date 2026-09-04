// Turning indexed rows into tax events — and refusing to invent the fields the
// indexer does not hold.
//
// ─── THE FIELD THAT IS NOT THERE ────────────────────────────────────────────
//
// `indexer/ponder.schema.ts`'s `swap` table records
// `{ user, tokenIn, tokenOut, amountIn, fee, timestamp, txHash }`. There is NO
// `amountOut`. That single absence decides the shape of everything below:
//
//   · A swap is a DISPOSAL of `tokenIn` at a known quantity — that part is real.
//     Its PROCEEDS are unknown, because what came back was never recorded.
//   · A swap is also an ACQUISITION of `tokenOut`, and its quantity is unknown.
//     So NO acquisition event is emitted. Emitting one at quantity zero would
//     put a phantom zero-size lot into the matcher, and a later disposal of that
//     asset would then match against nothing while looking like it had been
//     considered.
//
// The same absence is already load-bearing elsewhere in this repo:
// lib/competitions/scoring.ts refuses to rank by profit for exactly this reason.
// This module refuses to price a disposal for it.
//
// The consequence, stated rather than smoothed over: a capital-gains report
// built ONLY from this venue's indexed history has an unpriced row for every
// disposal. That is not a broken report, it is a true one — and it is why
// lib/tax/import.ts exists, so a filer can supply the basis and proceeds they
// hold and get real numbers out of the same matcher.
//
// ─── STAKING ROWS ───────────────────────────────────────────────────────────
//
// `stake` and `withdraw` move principal between a wallet and a contract the
// wallet still controls the position in. They are not dispositions and no event
// is emitted for them; a report that listed every stake as a sale would produce
// a fictional trading history out of a lock-up.
//
// `claim` rows ARE receipts of new tokens and are emitted as INCOME, at a known
// quantity and an unknown value — this venue has no historical price oracle, so
// there is no fair-market figure to attach and none is guessed. A quantity, a
// date and a transaction hash is what most tax software actually wants to be
// handed anyway; a made-up price is not.
//
// `earlyWithdraw` rows carry a `penalty` the contract really charged. It is
// surfaced as an informational row, NOT as a capital loss: whether a slashing
// penalty is deductible is a jurisdiction's question and this file does not know
// anybody's jurisdiction.
//
// `transfer` rows are the position NFT changing wallets at `amount: 0`. Skipped.

import type { IndexedSwap, IndexedStakingAction } from '../indexer/queries';
import type { AcquisitionEvent, DisposalEvent, TaxLotEvent, ValueSource } from './lots';

// Provenance types live in lots.ts (the event interfaces that carry them are
// declared there); re-exported so an adapter has one import for the whole
// vocabulary rather than two.
export type { ValueSource, EventInitiator } from './lots';

/** Where a row came from. Stamped on every export line — see lib/tax/csv.ts. */
export type EventSource = 'indexer' | 'supplied' | 'explorer';

export interface IncomeEvent {
  id: string;
  asset: string;
  assetSymbol: string;
  quantity: bigint;
  decimals: number;
  /** Fair-market value at receipt, or null. Null is never rendered as zero. */
  value: bigint | null;
  timestamp: number;
  txHash: string;
  /** Where `value` came from. Absent exactly when it is null. */
  valueSource?: ValueSource;
  /** What produced this receipt, in words a filer can categorise. */
  kind: 'staking-reward' | 'revenue-share' | 'other';
  source: EventSource;
}

/** What kind of thing an informational row is. Printed on the export. */
export type InformationalCategory =
  | 'transfer-in'
  | 'transfer-out'
  | 'third-party-tx'
  | 'multi-leg'
  | 'wrap-unwrap'
  | 'fee'
  | 'penalty';

/** One asset moving in one transaction. Signed: negative left the wallet. */
export interface InformationalLeg {
  asset: string;
  symbol: string;
  delta: bigint;
  /** Null means the token did not declare a readable scale — display only. */
  decimals: number | null;
}

export interface InformationalRow {
  id: string;
  timestamp: number;
  txHash: string;
  label: string;
  detail: string;
  /** Which read produced it. Written into the export's source column. */
  source: EventSource;
  category?: InformationalCategory;
  /**
   * What actually moved, when the row is a transaction this venue read but
   * refused to classify. Listed rather than summarised: "3 assets moved" is not
   * something a filer can reconcile, and the whole point of these rows is that
   * the reader can see what the classifier would not commit to.
   */
  legs?: InformationalLeg[];
}

/** A capability this adapter does not have. Carried onto the export verbatim. */
export interface AdapterLimitation {
  code: string;
  detail: string;
}

export interface TaxEventSet {
  lotEvents: TaxLotEvent[];
  income: IncomeEvent[];
  informational: InformationalRow[];
  limitations: AdapterLimitation[];
}

export const SWAP_PROCEEDS_LIMITATION: AdapterLimitation = {
  code: 'swap-proceeds-unrecorded',
  detail:
    'This venue’s indexer records what was sent into a swap and never what came back, so every disposal ' +
    'derived from it has unknown proceeds and unknown acquisition quantity. Those rows are listed with no ' +
    'gain figure and are excluded from the totals — they are not zero-gain trades.',
};

/**
 * The limitations of the EXPLORER read (lib/tax/ledger.ts).
 *
 * They live here, beside the indexer's, because a limitation belongs to the
 * report rather than to the adapter that noticed it: lib/tax/csv.ts writes all
 * of them into the same header block, and a reader deciding whether they can
 * use the file should not have to know which module was embarrassed by what.
 */
export const CHAIN_SCOPE_ETH_ONLY_LIMITATION: AdapterLimitation = {
  code: 'chain-scope-eth-only',
  detail:
    'History was read for ETHEREUM MAINNET only. Base, Solana and every other chain were NOT read, and ' +
    'nothing here is a statement about them. Within Ethereum, NFT transfers were not read either: an ETH ' +
    'movement below may be one leg of an NFT sale or purchase whose other leg this report never saw.',
};

export const MULTI_LEG_UNCLASSIFIED_LIMITATION: AdapterLimitation = {
  code: 'multi-leg-unclassified',
  detail:
    'Some transactions moved more than one asset in or more than one asset out — liquidity adds and ' +
    'removals, batched router calls, and similar. They are listed with the legs that moved and are NOT ' +
    'split into trades: inventing a price split across legs would put figures in this file that no ' +
    'transaction contains.',
};

export const THIRD_PARTY_UNCLASSIFIED_LIMITATION: AdapterLimitation = {
  code: 'third-party-unclassified',
  detail:
    'Some transactions moved assets in this wallet without the wallet sending them — order fills settled ' +
    'by a solver, and also address-poisoning contracts, which can emit a transfer that merely CLAIMS the ' +
    'wallet sent something. They are listed with their legs and are not classified as sales, because a ' +
    'stranger must not be able to write a disposal into somebody else’s tax report.',
};

export const EXPLORER_WINDOW_LIMITATION: AdapterLimitation = {
  code: 'explorer-window-bounded',
  detail:
    'The explorer read is bounded to 4 pages of 500 rows per transaction list. Where a list hit that ' +
    'bound, transactions older than the cut were not read at all and are not classified — and lots ' +
    'acquired before it are UNKNOWN, not zero. The cut is stated as a coverage gap above.',
};

export const NO_PRICE_ORACLE_LIMITATION: AdapterLimitation = {
  code: 'no-historical-price',
  detail:
    'There is no historical price source on this deployment, so income is reported as a quantity of a ' +
    'token on a date, with no fair-market value attached. A value of zero is never substituted.',
};

/**
 * Short label for an asset when no token list entry is available.
 *
 * A truncated address, not an invented ticker. An adapter that guessed "USDC"
 * from an address it did not resolve would put a symbol in a tax export that
 * nobody chose.
 */
export function assetLabel(address: string, symbols: Record<string, string> | undefined): string {
  const key = address.toLowerCase();
  const known = symbols?.[key];
  if (known && known.trim().length > 0) return known;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface AdapterOptions {
  /** Lowercased address → symbol. Anything absent is labelled by address. */
  symbols?: Record<string, string>;
  /** Lowercased address → decimals. Absent means unknown, and 0 is not assumed. */
  decimals?: Record<string, number>;
}

/**
 * Decimals for display only.
 *
 * Returns 18 when unknown, and the caller must treat that as a DISPLAY scale,
 * never as a fact about the token: every quantity in this module is carried as
 * a smallest-unit bigint and no arithmetic anywhere depends on this number.
 */
function decimalsFor(address: string, opts: AdapterOptions | undefined): number {
  const d = opts?.decimals?.[address.toLowerCase()];
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 36 ? d : 18;
}

/** Indexed swaps → unpriced disposals. See the header for why there is no acquisition. */
export function swapsToEvents(swaps: IndexedSwap[], opts?: AdapterOptions): TaxEventSet {
  const lotEvents: TaxLotEvent[] = [];
  for (const s of swaps) {
    if (s.amountIn <= 0n) continue;
    const disposal: DisposalEvent = {
      kind: 'dispose',
      id: `swap:${s.id}`,
      asset: s.tokenIn.toLowerCase(),
      assetSymbol: assetLabel(s.tokenIn, opts?.symbols),
      quantity: s.amountIn,
      decimals: decimalsFor(s.tokenIn, opts),
      // The field the schema does not hold. Null, forever, until it does.
      proceeds: null,
      timestamp: Number(s.timestamp),
      txHash: s.txHash,
    };
    lotEvents.push(disposal);
  }
  return {
    lotEvents,
    income: [],
    informational: [],
    limitations: lotEvents.length > 0 ? [SWAP_PROCEEDS_LIMITATION] : [],
  };
}

/** Indexed staking actions → income (claims) and informational rows (penalties). */
export function stakingToEvents(
  actions: IndexedStakingAction[],
  opts?: AdapterOptions & { rewardAsset?: string; rewardSymbol?: string },
): TaxEventSet {
  const income: IncomeEvent[] = [];
  const informational: InformationalRow[] = [];
  const asset = (opts?.rewardAsset ?? 'toweli').toLowerCase();
  const symbol = opts?.rewardSymbol ?? 'TOWELI';

  for (const a of actions) {
    if (a.type === 'claim') {
      if (a.amount <= 0n) continue;
      income.push({
        id: `claim:${a.id}`,
        asset,
        assetSymbol: symbol,
        quantity: a.amount,
        decimals: decimalsFor(asset, opts),
        value: null,
        timestamp: Number(a.timestamp),
        txHash: a.txHash,
        kind: 'staking-reward',
        source: 'indexer',
      });
      continue;
    }
    if (a.type === 'earlyWithdraw' && a.penalty !== null && a.penalty > 0n) {
      informational.push({
        id: `penalty:${a.id}`,
        timestamp: Number(a.timestamp),
        txHash: a.txHash,
        source: 'indexer',
        category: 'penalty',
        label: `Early-withdrawal penalty — ${a.penalty} ${symbol} (smallest units)`,
        detail:
          'The contract charged this penalty on an early unlock. Whether it is deductible anywhere is a ' +
          'question about your jurisdiction, so it is reported here and is NOT counted as a capital loss.',
      });
    }
  }

  return {
    lotEvents: [],
    income,
    informational,
    limitations: income.length > 0 ? [NO_PRICE_ORACLE_LIMITATION] : [],
  };
}

/** Merge adapter outputs, de-duplicating limitations by code. */
export function mergeEventSets(...sets: TaxEventSet[]): TaxEventSet {
  const byCode = new Map<string, AdapterLimitation>();
  const lotEvents: TaxLotEvent[] = [];
  const income: IncomeEvent[] = [];
  const informational: InformationalRow[] = [];
  for (const s of sets) {
    lotEvents.push(...s.lotEvents);
    income.push(...s.income);
    informational.push(...s.informational);
    for (const l of s.limitations) byCode.set(l.code, l);
  }
  return { lotEvents, income, informational, limitations: [...byCode.values()] };
}

/** Keep only what falls inside the period the report claims to be about. */
export function withinPeriod(set: TaxEventSet, from: number, to: number): TaxEventSet {
  const inRange = (t: number) => t >= from && t <= to;
  return {
    // Acquisitions BEFORE the period are kept: a lot bought in 2024 and sold in
    // 2025 has to be available to the matcher, or every 2025 disposal reports as
    // having no acquiring lot and the report invents a coverage problem it does
    // not have.
    lotEvents: set.lotEvents.filter((e) =>
      e.kind === 'acquire' ? e.timestamp <= to : inRange(e.timestamp),
    ),
    income: set.income.filter((e) => inRange(e.timestamp)),
    informational: set.informational.filter((e) => inRange(e.timestamp)),
    limitations: set.limitations,
  };
}

/** Narrowing helper for callers walking a mixed event list. */
export function isAcquisition(e: TaxLotEvent): e is AcquisitionEvent {
  return e.kind === 'acquire';
}
