// Explorer rows → a wallet ledger → tax events. Pure, and deliberately timid.
//
// ─── WHAT CHANGED, AND WHY IT IS THE WHOLE SURFACE ──────────────────────────
//
// lib/tax/events.ts explains that the venue's own indexer records what went
// INTO a swap and never what came back, so every disposal derived from it has
// null proceeds. The explorer does not have that hole: `txlist`,
// `txlistinternal` and `tokentx` are three views of the SAME transaction, so a
// sale of USDC for ETH appears as a token row leaving and an internal row
// arriving, in one hash. Netting them gives BOTH legs, and both legs is exactly
// what a proceeds figure is. Nothing here is priced from a feed, a quote or an
// average — a figure exists only when the counter-leg was read from the same
// transaction.
//
// ─── THE THREE REFUSALS ─────────────────────────────────────────────────────
//
// 1. PROVENANCE BEFORE CLASSIFICATION. A 1-out/1-in transaction is a trade only
//    when the wallet SENT it (a `txlist` row with `from` === the wallet) or the
//    outgoing asset is one from DEFAULT_TOKENS. Anyone can deploy a contract
//    that emits `Transfer(from: victim, …)` and forwards a wei back; without
//    this rule a stranger could write a disposal — with proceeds — into
//    somebody else's tax report by spending gas. Those transactions are listed
//    with their legs and never classified.
//
// 2. HALF-READ TRANSACTIONS ARE NOT CLASSIFIED. The read is bounded (4 pages of
//    500 per list). When any list truncates, `cut` is the NEWEST of the
//    truncation boundaries and every transaction older than it is dropped from
//    classification entirely — because for such a transaction one list may have
//    supplied a leg while another ran out, and pricing a sale from the half we
//    happened to read is how a wrong number gets into a filing. They are
//    counted, and the stretch is a declared coverage gap.
//
// 3. NOTHING IS SPLIT OR ASSUMED. Multi-leg transactions (LP adds, batched
//    routers) are listed, not divided into invented trades. Transfers with no
//    counter-leg are listed, never a zero-cost buy or a zero-proceeds sale.
//    Reverted transactions contribute a fee row and nothing else.
//
// ─── WETH ───────────────────────────────────────────────────────────────────
//
// WETH counts as the ETH quote. This is not a market assumption: `deposit()`
// and `withdraw()` mint and burn 1:1 by the contract's own code, so a WETH leg
// IS an ETH amount. It is stamped as `settle-leg-weth` rather than `settle-leg`
// so a reader can tell which of the two was actually in the transaction, and a
// wrap or unwrap itself is informational — moving between two spellings of the
// same asset is not a disposal.

import { WETH_ADDRESS } from '../constants';
import { DEFAULT_TOKENS } from '../tokenList';
import { categorizeTx, formatGasEth, type ExplorerAction, type TokenTxRow, type TxRecord } from '../txHistory';
import {
  CHAIN_SCOPE_ETH_ONLY_LIMITATION,
  EXPLORER_WINDOW_LIMITATION,
  MULTI_LEG_UNCLASSIFIED_LIMITATION,
  THIRD_PARTY_UNCLASSIFIED_LIMITATION,
  assetLabel,
  type AdapterLimitation,
  type IncomeEvent,
  type InformationalLeg,
  type InformationalRow,
  type TaxEventSet,
} from './events';
import type { AcquisitionEvent, DisposalEvent, EventInitiator, TaxLotEvent, ValueSource } from './lots';

/** The chain-native asset's key in a ledger. Not an address, because it is not a contract. */
export const NATIVE_ASSET = 'eth';

/**
 * The assets a figure may be denominated in.
 *
 * ETH and WETH only, and see the header for why WETH belongs. Everything else
 * needs a price this deployment does not have, so a trade between two of them
 * is listed with null figures rather than valued.
 */
const QUOTE_ASSETS: ReadonlySet<string> = new Set([NATIVE_ASSET, WETH_ADDRESS.toLowerCase()]);

/**
 * A contract-claimed ticker may be shown only if it looks like a ticker.
 *
 * Anything else — a sentence, a URL, `=HYPERLINK("http://x")` — is rejected and
 * the row is labelled by its address instead. lib/tax/csv.ts ALSO neutralises
 * formula-leading cells, and both guards are wanted: this one keeps the screen
 * readable, that one keeps a spreadsheet from executing the token's name.
 */
export const SAFE_SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export type SymbolSource = 'token-list' | 'contract-claimed' | 'rejected';

export interface Leg {
  /** `eth`, or the lowercased contract address. Identity, never the symbol. */
  asset: string;
  /** Signed smallest-unit change for the wallet. Negative left the wallet. */
  delta: bigint;
  symbol: string;
  symbolSource: SymbolSource;
  /** Null when the token declared no readable scale. DISPLAY ONLY — see below. */
  decimals: number | null;
}

export interface LedgerTx {
  hash: string;
  /** Unix seconds. */
  timestamp: number;
  initiator: EventInitiator;
  /** The transaction reverted: its legs are dropped, its fee is not. */
  failed: boolean;
  /** gasUsed × gasPrice, when the explorer reported both. */
  gasWei: bigint | null;
  legs: Leg[];
  functionName: string;
  to: string;
}

export interface LedgerTruncation {
  action: ExplorerAction;
  /** Unix seconds of the oldest row that list DID return. */
  oldestRowAt: number;
}

export interface WalletLedger {
  wallet: string;
  /** Newest first. Every transaction the read could see WHOLE. */
  txs: LedgerTx[];
  /**
   * Unix seconds before which nothing is classified, or null when every list
   * was read to its end. See refusal 2 in the header.
   */
  cut: number | null;
  /** Transactions dropped by that cut. Reported, never silently discarded. */
  belowCut: number;
  truncated: LedgerTruncation[];
  /** Asset movements read, across every transaction. For the status line. */
  transferCount: number;
  /**
   * Rows the explorer returned that no schema here could read.
   *
   * Almost always zero. Carried because the alternative is dropping a
   * transaction from somebody's tax report with nothing on the file saying a
   * row went missing — and a count a filer can see is the difference between a
   * report with a hole and a report that lies about having one.
   */
  unreadRows: number;
}

export interface BuildLedgerInput {
  wallet: string;
  txlist: TxRecord[];
  internal: TxRecord[];
  tokentx: TokenTxRow[];
  truncated: LedgerTruncation[];
  /** Rows the explorer returned and the schemas refused. Declared, not hidden. */
  unreadRows?: number;
}

interface TokenDraft {
  delta: bigint;
  claimedSymbol: string;
  claimedDecimals: string;
}

interface Draft {
  hash: string;
  timestamp: number;
  initiator: EventInitiator;
  failed: boolean;
  gasWei: bigint | null;
  functionName: string;
  to: string;
  native: bigint;
  tokens: Map<string, TokenDraft>;
  transfers: number;
}

const TOKEN_LIST = new Map<string, { symbol: string; decimals: number }>(
  DEFAULT_TOKENS.map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }]),
);

function toSeconds(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function draftFor(map: Map<string, Draft>, hash: string, timestamp: number): Draft {
  const key = hash.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    // Every view of one transaction carries the same timestamp; keep the first
    // readable one so a malformed row cannot zero it.
    if (existing.timestamp === 0) existing.timestamp = timestamp;
    return existing;
  }
  const created: Draft = {
    hash: key,
    timestamp,
    initiator: 'third-party',
    failed: false,
    gasWei: null,
    functionName: '',
    to: '',
    native: 0n,
    tokens: new Map(),
    transfers: 0,
  };
  map.set(key, created);
  return created;
}

function safeBigInt(raw: string): bigint | null {
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Decimals for DISPLAY. Never used in arithmetic — every quantity is smallest units. */
function readDecimals(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
}

function resolveLeg(asset: string, delta: bigint, claimedSymbol: string, claimedDecimals: string): Leg {
  if (asset === NATIVE_ASSET) {
    return { asset, delta, symbol: 'ETH', symbolSource: 'token-list', decimals: 18 };
  }
  const known = TOKEN_LIST.get(asset);
  if (known) {
    return { asset, delta, symbol: known.symbol, symbolSource: 'token-list', decimals: known.decimals };
  }
  const decimals = readDecimals(claimedDecimals);
  if (SAFE_SYMBOL_RE.test(claimedSymbol)) {
    return { asset, delta, symbol: claimedSymbol, symbolSource: 'contract-claimed', decimals };
  }
  // The truncated-address form from events.ts — a label nobody chose over a
  // ticker the token chose for itself.
  return { asset, delta, symbol: assetLabel(asset, undefined), symbolSource: 'rejected', decimals };
}

/**
 * Group three explorer views of a wallet's history into one transaction ledger.
 *
 * Native legs come from `txlist` (the transaction's own value) AND from
 * `txlistinternal` — that second list is not optional. A router selling a token
 * for ETH returns the ETH as an INTERNAL transfer, so a ledger built without it
 * sees the token leave and nothing arrive, and reports a sale with no proceeds.
 */
export function buildLedger(input: BuildLedgerInput): WalletLedger {
  const wallet = input.wallet.toLowerCase();
  const drafts = new Map<string, Draft>();

  for (const row of input.txlist) {
    const d = draftFor(drafts, row.hash, toSeconds(row.timeStamp));
    d.functionName = row.functionName;
    d.to = row.to.toLowerCase();
    if (row.from?.toLowerCase() === wallet) d.initiator = 'self';
    if (row.isError === '1') d.failed = true;
    if (row.gasUsed && row.gasPrice) {
      const used = safeBigInt(row.gasUsed);
      const price = safeBigInt(row.gasPrice);
      if (used !== null && price !== null) d.gasWei = used * price;
    }
    const value = safeBigInt(row.value);
    if (value === null || value === 0n || row.isError === '1') continue;
    if (row.from?.toLowerCase() === wallet) {
      d.native -= value;
      d.transfers++;
    }
    if (row.to.toLowerCase() === wallet) {
      d.native += value;
      d.transfers++;
    }
  }

  for (const row of input.internal) {
    const d = draftFor(drafts, row.hash, toSeconds(row.timeStamp));
    // A reverted internal call moved nothing; its parent may still have succeeded.
    if (row.isError === '1') continue;
    const value = safeBigInt(row.value);
    if (value === null || value === 0n) continue;
    if (row.from?.toLowerCase() === wallet) {
      d.native -= value;
      d.transfers++;
    }
    if (row.to.toLowerCase() === wallet) {
      d.native += value;
      d.transfers++;
    }
  }

  for (const row of input.tokentx) {
    const d = draftFor(drafts, row.hash, toSeconds(row.timeStamp));
    const asset = row.contractAddress.toLowerCase();
    const value = safeBigInt(row.value);
    if (value === null) continue;
    const entry = d.tokens.get(asset) ?? {
      delta: 0n,
      claimedSymbol: row.tokenSymbol,
      claimedDecimals: row.tokenDecimal,
    };
    if (entry.claimedSymbol === '' && row.tokenSymbol !== '') entry.claimedSymbol = row.tokenSymbol;
    if (entry.claimedDecimals === '' && row.tokenDecimal !== '') entry.claimedDecimals = row.tokenDecimal;
    if (row.from.toLowerCase() === wallet) {
      entry.delta -= value;
      d.transfers++;
    }
    if (row.to.toLowerCase() === wallet) {
      entry.delta += value;
      d.transfers++;
    }
    d.tokens.set(asset, entry);
  }

  // The NEWEST truncation boundary wins. Taking the oldest would leave a window
  // in which one list had run out while another had not, and a transaction in
  // that window would be classified from the legs that survived — refusal 2.
  const cut = input.truncated.length > 0 ? Math.max(...input.truncated.map((t) => t.oldestRowAt)) : null;

  const txs: LedgerTx[] = [];
  let belowCut = 0;
  let transferCount = 0;

  for (const d of drafts.values()) {
    if (cut !== null && d.timestamp < cut) {
      belowCut++;
      continue;
    }
    const legs: Leg[] = [];
    if (!d.failed) {
      if (d.native !== 0n) legs.push(resolveLeg(NATIVE_ASSET, d.native, '', ''));
      for (const [asset, t] of d.tokens) {
        if (t.delta === 0n) continue;
        legs.push(resolveLeg(asset, t.delta, t.claimedSymbol, t.claimedDecimals));
      }
    }
    transferCount += d.failed ? 0 : d.transfers;
    txs.push({
      hash: d.hash,
      timestamp: d.timestamp,
      initiator: d.initiator,
      failed: d.failed,
      gasWei: d.gasWei,
      legs,
      functionName: d.functionName,
      to: d.to,
    });
  }

  txs.sort((a, b) => (b.timestamp - a.timestamp) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  return {
    wallet,
    txs,
    cut,
    belowCut,
    truncated: input.truncated,
    transferCount,
    unreadRows: input.unreadRows ?? 0,
  };
}

/** Venue calls whose inbound legs are income rather than a purchase. */
const INCOME_TYPES: ReadonlySet<string> = new Set(['Claim', 'Revenue', 'Referral', 'Claim Bribe']);

export interface LedgerToEventsOptions {
  /** The only quote PR-1 supports. Named so a USD mode cannot arrive silently. */
  quote: 'eth';
  /** Injected so a test can pin classification without the constants table. */
  categorize?: (tx: TxRecord) => { type: string; color: string };
}

/**
 * wei → an ETH string, through the one formatter this app already has.
 *
 * `formatGasEth` multiplies gasUsed by gasPrice, so a price of 1 makes it a
 * plain wei formatter. Reused rather than reimplemented: a second wei-to-ETH
 * routine is a second rounding convention waiting to disagree with the first.
 */
function weiToEth(wei: bigint): string {
  return formatGasEth(wei.toString(), '1') || '0';
}

function legToInformational(leg: Leg): InformationalLeg {
  return { asset: leg.asset, symbol: leg.symbol, delta: leg.delta, decimals: leg.decimals };
}

function describeLegs(legs: Leg[]): string {
  return legs
    .map((l) => `${l.delta > 0n ? '+' : ''}${l.delta.toString()} ${l.symbol} (smallest units)`)
    .join(', ');
}

function quoteSourceFor(asset: string): ValueSource {
  return asset === NATIVE_ASSET ? 'settle-leg' : 'settle-leg-weth';
}

/**
 * A wallet ledger → tax events, refusing everything in the header.
 *
 * The classification order matters and is not arbitrary: a venue income receipt
 * is decided BEFORE the 1-out/1-in trade rule, because a `claim()` that pays
 * ETH would otherwise read as an acquisition of ETH at the cost of the gas, and
 * the inbound leg is consumed so the same receipt is never also listed as a
 * transfer-in.
 */
export function ledgerToEvents(ledger: WalletLedger, opts: LedgerToEventsOptions): TaxEventSet {
  const categorize = opts.categorize ?? categorizeTx;
  const lotEvents: TaxLotEvent[] = [];
  const income: IncomeEvent[] = [];
  const informational: InformationalRow[] = [];
  const limitations: AdapterLimitation[] = [CHAIN_SCOPE_ETH_ONLY_LIMITATION];
  let sawMultiLeg = false;
  let sawThirdParty = false;

  for (const tx of ledger.txs) {
    const feeRow = (): void => {
      if (tx.initiator !== 'self' || tx.gasWei === null || tx.gasWei === 0n) return;
      informational.push({
        id: `${tx.hash}:fee`,
        timestamp: tx.timestamp,
        txHash: tx.hash,
        source: 'explorer',
        category: 'fee',
        label: `Transaction fee — ${weiToEth(tx.gasWei)} ETH`,
        detail:
          'Gas paid on this transaction, listed separately. Whether a fee adds to a cost basis, reduces ' +
          'proceeds or is not deductible at all is a jurisdiction’s question, so it is reported and not ' +
          'folded into any figure here.',
      });
    };

    if (tx.failed) {
      informational.push({
        id: `${tx.hash}:reverted`,
        timestamp: tx.timestamp,
        txHash: tx.hash,
        source: 'explorer',
        category: 'fee',
        label: 'Reverted transaction — fee only',
        detail:
          'This transaction reverted, so nothing moved and it is not a trade. The gas was still spent: ' +
          `${tx.gasWei === null ? 'the explorer did not report it' : `${weiToEth(tx.gasWei)} ETH`}.`,
      });
      continue;
    }

    const inLegs = tx.legs.filter((l) => l.delta > 0n);
    const outLegs = tx.legs.filter((l) => l.delta < 0n);

    // ── Venue income ─────────────────────────────────────────────────────────
    const venueType = tx.to.length > 0
      ? categorize({
          hash: tx.hash,
          to: tx.to,
          timeStamp: String(tx.timestamp),
          value: '0',
          functionName: tx.functionName,
          isError: '0',
        }).type
      : 'Other';
    if (tx.initiator === 'self' && INCOME_TYPES.has(venueType) && inLegs.length > 0) {
      for (const leg of inLegs) {
        const priced = QUOTE_ASSETS.has(leg.asset);
        income.push({
          id: `${tx.hash}:income:${leg.asset}`,
          asset: leg.asset,
          assetSymbol: leg.symbol,
          quantity: leg.delta,
          decimals: leg.decimals ?? 18,
          value: priced ? leg.delta : null,
          valueSource: priced ? quoteSourceFor(leg.asset) : undefined,
          timestamp: tx.timestamp,
          txHash: tx.hash,
          kind: venueType === 'Claim' ? 'staking-reward' : 'revenue-share',
          source: 'explorer',
        });
      }
      feeRow();
      continue;
    }

    if (outLegs.length === 1 && inLegs.length === 1) {
      const out = outLegs[0]!;
      const inn = inLegs[0]!;
      const outQuote = QUOTE_ASSETS.has(out.asset);
      const inQuote = QUOTE_ASSETS.has(inn.asset);

      if (outQuote && inQuote) {
        informational.push({
          id: `${tx.hash}:wrap`,
          timestamp: tx.timestamp,
          txHash: tx.hash,
          source: 'explorer',
          category: 'wrap-unwrap',
          label: 'Wrap or unwrap between ETH and WETH',
          detail:
            'WETH is minted and burned one-for-one against ETH by the contract’s own code, so moving ' +
            'between them is not a disposal and no gain arises here.',
          legs: tx.legs.map(legToInformational),
        });
        feeRow();
        continue;
      }

      const tradeable = tx.initiator === 'self' || TOKEN_LIST.has(out.asset);
      if (tradeable) {
        if (inQuote) {
          const disposal: DisposalEvent = {
            kind: 'dispose',
            id: `${tx.hash}:d:${out.asset}`,
            asset: out.asset,
            assetSymbol: out.symbol,
            quantity: -out.delta,
            decimals: out.decimals ?? 18,
            proceeds: inn.delta,
            proceedsSource: quoteSourceFor(inn.asset),
            initiator: tx.initiator,
            timestamp: tx.timestamp,
            txHash: tx.hash,
          };
          lotEvents.push(disposal);
        } else if (outQuote) {
          const acquisition: AcquisitionEvent = {
            kind: 'acquire',
            id: `${tx.hash}:a:${inn.asset}`,
            asset: inn.asset,
            assetSymbol: inn.symbol,
            quantity: inn.delta,
            decimals: inn.decimals ?? 18,
            costBasis: -out.delta,
            costSource: quoteSourceFor(out.asset),
            initiator: tx.initiator,
            timestamp: tx.timestamp,
            txHash: tx.hash,
          };
          lotEvents.push(acquisition);
        } else {
          // Token for token. Both halves really happened and neither has a
          // figure this deployment can defend, so both are emitted UNPRICED
          // rather than one being valued from the other at a rate nobody read.
          lotEvents.push({
            kind: 'dispose',
            id: `${tx.hash}:d:${out.asset}`,
            asset: out.asset,
            assetSymbol: out.symbol,
            quantity: -out.delta,
            decimals: out.decimals ?? 18,
            proceeds: null,
            initiator: tx.initiator,
            timestamp: tx.timestamp,
            txHash: tx.hash,
          });
          lotEvents.push({
            kind: 'acquire',
            id: `${tx.hash}:a:${inn.asset}`,
            asset: inn.asset,
            assetSymbol: inn.symbol,
            quantity: inn.delta,
            decimals: inn.decimals ?? 18,
            costBasis: null,
            initiator: tx.initiator,
            timestamp: tx.timestamp,
            txHash: tx.hash,
          });
        }
        feeRow();
        continue;
      }

      sawThirdParty = true;
      informational.push({
        id: `${tx.hash}:third-party`,
        timestamp: tx.timestamp,
        txHash: tx.hash,
        source: 'explorer',
        category: 'third-party-tx',
        label: 'Assets moved without this wallet sending the transaction',
        detail:
          `Two legs moved (${describeLegs(tx.legs)}) but the wallet did not send this transaction and the ` +
          'outgoing asset is not one this venue recognises, so it is NOT recorded as a sale. A contract ' +
          'can emit a transfer that claims a wallet sent something; classifying this would let a stranger ' +
          'write a disposal into your report.',
        legs: tx.legs.map(legToInformational),
      });
      feeRow();
      continue;
    }

    if (tx.legs.length === 0) {
      feeRow();
      continue;
    }

    if (inLegs.length === 1 && outLegs.length === 0) {
      const leg = inLegs[0]!;
      informational.push({
        id: `${tx.hash}:in:${leg.asset}`,
        timestamp: tx.timestamp,
        txHash: tx.hash,
        source: 'explorer',
        category: 'transfer-in',
        label: `Received ${leg.symbol} with nothing paid for it in this transaction`,
        detail:
          'Nothing left the wallet here, so this is not a purchase and it is NOT given a zero cost basis. ' +
          'It may be an airdrop, a gift, a withdrawal from somewhere else or a transfer between your own ' +
          'wallets — only you know which. Paste it back with its real basis if it is a lot.',
        legs: tx.legs.map(legToInformational),
      });
      feeRow();
      continue;
    }

    if (outLegs.length === 1 && inLegs.length === 0) {
      const leg = outLegs[0]!;
      informational.push({
        id: `${tx.hash}:out:${leg.asset}`,
        timestamp: tx.timestamp,
        txHash: tx.hash,
        source: 'explorer',
        category: 'transfer-out',
        label: `Sent ${leg.symbol} with nothing received for it in this transaction`,
        detail:
          'Nothing arrived here, so this is not a sale and it is NOT given zero proceeds. It may be a ' +
          'transfer to your own wallet, a deposit, a gift or a payment — only you know which.',
        legs: tx.legs.map(legToInformational),
      });
      feeRow();
      continue;
    }

    sawMultiLeg = true;
    informational.push({
      id: `${tx.hash}:multi`,
      timestamp: tx.timestamp,
      txHash: tx.hash,
      source: 'explorer',
      category: 'multi-leg',
      label: `${tx.legs.length} assets moved in one transaction`,
      detail:
        `The legs were: ${describeLegs(tx.legs)}. Splitting this into trades would mean apportioning a ` +
        'value across legs that no part of the transaction states, so it is listed and left unclassified.',
      legs: tx.legs.map(legToInformational),
    });
    feeRow();
  }

  if (sawMultiLeg) limitations.push(MULTI_LEG_UNCLASSIFIED_LIMITATION);
  if (sawThirdParty) limitations.push(THIRD_PARTY_UNCLASSIFIED_LIMITATION);
  if (ledger.truncated.length > 0) limitations.push(EXPLORER_WINDOW_LIMITATION);
  if (ledger.unreadRows > 0) {
    limitations.push({
      code: 'explorer-rows-unread',
      detail:
        `${ledger.unreadRows} row(s) the explorer returned were in a shape this venue could not read and ` +
        'are NOT represented anywhere in this report. They are not zero and they are not absent from the ' +
        'chain — they are transactions nobody here accounted for, and a figure that should include them ' +
        'may be short.',
    });
  }

  return { lotEvents, income, informational, limitations };
}
