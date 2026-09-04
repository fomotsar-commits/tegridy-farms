// An invoice: what a merchant is owed, in the asset they want, exactly.
//
// ─── THE DENOMINATION RULE ───────────────────────────────────────────────────
//
// `settleAmount` is denominated in `settleToken` and in nothing else. There is
// deliberately no fiat field and no `usdAmount`, because pricing an invoice in a
// currency this venue cannot read would mean quoting the buyer a token figure
// derived from an aggregator mid-price and then presenting it as the debt. The
// buyer would sign for one number and the merchant would be owed another the
// moment the price moved, and neither party could point at the quote that
// decided it. A merchant who thinks in fiat converts before they mint the
// invoice, where the conversion is theirs and is visible.
//
// ─── WHY THE AMOUNT IS EXACT AND THE PAY LEG IS THE VARIABLE ─────────────────
//
// The buyer may pay in any token. The merchant is owed exactly `settleAmount` of
// exactly `settleToken`. So the slippage of the route lands on the BUYER's side
// of the trade — they may spend a little more of their own asset — and never on
// the merchant's, who either receives the full amount or receives nothing
// because the plan refused to offer a signature. See settlement.ts.
//
// ─── SERIALISATION ──────────────────────────────────────────────────────────
//
// uint256 travels as a decimal string, never as a JSON number. The same rule the
// indexer client applies to Ponder's BigInt scalar applies here for the same
// reason: above 2^53 a JSON number silently loses precision, and the value that
// loses it is the one the buyer is about to sign for.

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Mirrors the CHECK in migration 021 and the literal in api/_lib/commerce.js. */
export const INVOICE_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/** Longest memo an invoice may carry, in characters. */
export const MAX_MEMO_LENGTH = 200;

/**
 * How long an invoice may remain payable.
 *
 * Not a policy preference. An invoice is a price the merchant committed to, and
 * a merchant who committed to a token price cannot have committed to it forever
 * — the longer the window, the more the commitment is really a free option on
 * that token written against them.
 */
export const MAX_INVOICE_TTL_SECONDS = 24 * 60 * 60;

export interface Invoice {
  /** Opaque, merchant-chosen or generated. Never derived from the amount. */
  id: string;
  /** The payee. Funds move to this address and to no intermediary. */
  merchant: `0x${string}`;
  chainId: number;
  /** The asset the merchant is owed. */
  settleToken: `0x${string}`;
  settleSymbol: string;
  settleDecimals: number;
  /** Exact, in `settleToken`'s smallest unit. The merchant gets this or nothing. */
  settleAmount: bigint;
  /** Free text shown to the buyer. Rendered as text, never as markup. */
  memo: string;
  /** Unix seconds. Past this the plan refuses rather than re-quoting. */
  expiresAt: number;
  /** Unix seconds the invoice was minted. */
  createdAt: number;
}

/** The wire shape. Every uint256 is a decimal string; see the header. */
export interface InvoiceWire {
  id: string;
  merchant: string;
  chainId: number;
  settleToken: string;
  settleSymbol: string;
  settleDecimals: number;
  settleAmount: string;
  memo: string;
  expiresAt: number;
  createdAt: number;
}

export type InvoiceProblem = string;

/**
 * Whether an invoice can be presented to a buyer at all.
 *
 * Returns EVERY problem rather than the first: a merchant fixing a malformed
 * invoice one round-trip per field is a merchant who gives up, and a buyer is
 * never shown this list — the buyer is shown "this invoice cannot be paid",
 * which is a different sentence with a different audience.
 */
export function invoiceProblems(inv: Invoice): InvoiceProblem[] {
  const problems: InvoiceProblem[] = [];

  if (!INVOICE_ID_RE.test(inv.id)) {
    problems.push('The invoice id must be 8–64 characters of lowercase letters, digits and hyphens.');
  }
  if (!ADDRESS_RE.test(inv.merchant)) {
    problems.push('The merchant address is not a 20-byte address.');
  } else if (inv.merchant.toLowerCase() === ZERO_ADDRESS) {
    // Paying the zero address is a burn wearing a merchant's name.
    problems.push('The merchant address is the zero address, which would burn the payment rather than pay anyone.');
  }
  if (!ADDRESS_RE.test(inv.settleToken)) {
    problems.push('The settlement token is not a 20-byte address.');
  }
  if (!Number.isInteger(inv.chainId) || inv.chainId <= 0) {
    problems.push('The invoice names no chain, so there is no network on which it could be paid.');
  }
  if (!Number.isInteger(inv.settleDecimals) || inv.settleDecimals < 0 || inv.settleDecimals > 36) {
    problems.push('The settlement token decimals are outside any plausible range.');
  }
  if (inv.settleAmount <= 0n) {
    // A zero invoice would render as a completed payment of nothing.
    problems.push('The invoice amount is zero or negative, so there is nothing to settle.');
  }
  if (inv.settleSymbol.trim().length === 0) {
    // The symbol is what the buyer reads in the disclosure. An unnamed asset in
    // a "you will pay X to receive Y" sentence is not a disclosure.
    problems.push('The settlement token has no symbol, so the buyer could not be told what they are paying in.');
  }
  if (inv.memo.length > MAX_MEMO_LENGTH) {
    problems.push(`The memo is longer than ${MAX_MEMO_LENGTH} characters.`);
  }
  if (!Number.isInteger(inv.createdAt) || inv.createdAt <= 0) {
    problems.push('The invoice carries no creation time.');
  }
  if (!Number.isInteger(inv.expiresAt) || inv.expiresAt <= inv.createdAt) {
    problems.push('The invoice expires at or before the moment it was created.');
  } else if (inv.expiresAt - inv.createdAt > MAX_INVOICE_TTL_SECONDS) {
    problems.push(
      `An invoice may stay payable for at most ${MAX_INVOICE_TTL_SECONDS / 3600} hours — past that the ` +
        'committed token price is a free option written against the merchant.',
    );
  }

  return problems;
}

export function isPayableInvoice(inv: Invoice): boolean {
  return invoiceProblems(inv).length === 0;
}

/**
 * How much clock skew between a merchant's machine and a buyer's is ordinary.
 *
 * Five minutes is generous for two consumer devices and far short of the window
 * a back-dated clock would need to be useful, so an invoice whose `createdAt` is
 * beyond it is describing a moment that has not happened rather than disagreeing
 * about which second it is.
 */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export type InvoiceLifecycle =
  /** Payable right now. */
  | 'open'
  /** Past `expiresAt`. Not an error and not a failure — a price that lapsed. */
  | 'expired'
  /**
   * Minted at a moment that has not arrived.
   *
   * Kept apart from `open` because a self-carrying invoice sets its own clock:
   * `createdAt` is what a receipt is bound against ("this transfer was mined
   * before the invoice existed, so it cannot be its payment"), and a document
   * free to claim any birthday could make an old, already-spent transfer look
   * like a fresh payment for a new debt.
   */
  | 'future-dated'
  /** Structurally unpayable; `invoiceProblems` says why. */
  | 'malformed';

export function invoiceLifecycle(inv: Invoice, nowSeconds: number): InvoiceLifecycle {
  if (!isPayableInvoice(inv)) return 'malformed';
  if (inv.createdAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return 'future-dated';
  return nowSeconds >= inv.expiresAt ? 'expired' : 'open';
}

/**
 * Parse a wire invoice, or return null.
 *
 * Null rather than a partially-populated object with defaults filled in. A
 * default merchant address or a default amount is a number nobody chose,
 * standing in a slot the buyer is about to sign against.
 */
export function invoiceFromWire(wire: unknown): Invoice | null {
  if (!wire || typeof wire !== 'object') return null;
  const w = wire as Record<string, unknown>;

  const str = (k: string): string | null => (typeof w[k] === 'string' ? (w[k] as string) : null);
  const num = (k: string): number | null => (typeof w[k] === 'number' && Number.isFinite(w[k] as number) ? (w[k] as number) : null);

  const id = str('id');
  const merchant = str('merchant');
  const settleToken = str('settleToken');
  const settleSymbol = str('settleSymbol');
  const rawAmount = str('settleAmount');
  const chainId = num('chainId');
  const settleDecimals = num('settleDecimals');
  const expiresAt = num('expiresAt');
  const createdAt = num('createdAt');
  const memo = typeof w.memo === 'string' ? (w.memo as string) : '';

  if (
    id === null ||
    merchant === null ||
    settleToken === null ||
    settleSymbol === null ||
    rawAmount === null ||
    chainId === null ||
    settleDecimals === null ||
    expiresAt === null ||
    createdAt === null
  ) {
    return null;
  }
  // A non-integer amount string is rejected outright rather than coerced.
  // `BigInt('12.5')` throws; `Number('12.5')` would round, and rounding a debt
  // is the failure this whole module is arranged around.
  if (!/^\d+$/.test(rawAmount)) return null;

  return {
    id,
    merchant: merchant as `0x${string}`,
    chainId,
    settleToken: settleToken as `0x${string}`,
    settleSymbol,
    settleDecimals,
    settleAmount: BigInt(rawAmount),
    memo,
    expiresAt,
    createdAt,
  };
}

export function invoiceToWire(inv: Invoice): InvoiceWire {
  return {
    id: inv.id,
    merchant: inv.merchant,
    chainId: inv.chainId,
    settleToken: inv.settleToken,
    settleSymbol: inv.settleSymbol,
    settleDecimals: inv.settleDecimals,
    settleAmount: inv.settleAmount.toString(),
    memo: inv.memo,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  };
}
