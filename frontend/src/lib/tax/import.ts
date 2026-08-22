// Importing the acquisitions, disposals and income a filer already holds.
//
// WHY THIS EXISTS. lib/tax/events.ts explains that this venue's indexer records
// no swap output amount and no historical price, so a report built from indexed
// history alone has an unpriced row for every disposal. The matcher in lots.ts
// is real arithmetic and works the moment it is given real numbers; this is the
// door those numbers come through. Nothing here is a price feed and nothing here
// guesses — every value in the output was typed by the person filing.
//
// ─── ALL OR NOTHING, DELIBERATELY ───────────────────────────────────────────
//
// A single malformed line fails the WHOLE import and every error is reported at
// once. Importing the rows that happened to parse is the fabricated-zero failure
// in its most expensive form: the report would come out looking complete, with a
// transaction silently missing, and the totals would be wrong in a document
// somebody files. Partial success is not offered.
//
// ─── NO FLOATING POINT ANYWHERE ─────────────────────────────────────────────
//
// Quantities and values are parsed from decimal STRINGS straight into integers
// by digit shifting. `parseFloat('0.1') + parseFloat('0.2')` is the reason: a
// rounding artefact in a cost basis is a wrong number in a filing, and it would
// be invisible. A value with more fractional digits than its declared scale is
// an ERROR, not a rounding opportunity.

import type { IncomeEvent } from './events';
import type { TaxLotEvent } from './lots';

/** Minor-unit scale of the quote currency every `value` column is expressed in. */
export const VALUE_SCALE = 2;

export const IMPORT_COLUMNS = [
  'kind',
  'asset',
  'symbol',
  'decimals',
  'quantity',
  'value',
  'timestamp',
  'txhash',
  'id',
  'nominates',
] as const;

export const IMPORT_TEMPLATE =
  'kind,asset,symbol,decimals,quantity,value,timestamp,txhash,id,nominates\n' +
  'acquire,0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,USDC,6,1000.00,1000.00,2025-01-14T10:00:00Z,0x…,lot-1,\n' +
  'dispose,0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,USDC,6,400.00,455.10,2025-06-02T14:30:00Z,0x…,sale-1,lot-1\n' +
  'income,0x0000000000000000000000000000000000000000,TOWELI,18,12.5,,2025-03-01T00:00:00Z,0x…,reward-1,\n';

export interface ImportError {
  /** 1-based line in the pasted text, counting the header. */
  line: number;
  message: string;
}

export interface ImportResult {
  lotEvents: TaxLotEvent[];
  income: IncomeEvent[];
  errors: ImportError[];
}

/**
 * Exact decimal string → integer of `scale` digits.
 *
 * Returns null on anything it cannot convert without losing information,
 * INCLUDING a value with too many fractional digits. Silently truncating
 * `1.005` to `1.00` here would be a cent off a cost basis, which compounds
 * across a year of rows into a number nobody can reconcile.
 */
export function parseScaledDecimal(raw: string, scale: number): bigint | null {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [whole, frac = ''] = body.split('.');
  if (frac.length > scale) return null;
  const padded = frac.padEnd(scale, '0');
  const value = BigInt(whole + padded);
  return negative ? -value : value;
}

/** ISO-8601 or unix seconds → unix seconds. Null when neither. */
export function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (/^\d{1,11}$/.test(s)) {
    const n = Number(s);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** Minimal RFC4180 line splitter — quoted fields, doubled quotes, no newlines inside. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a pasted CSV into events.
 *
 * `errors` non-empty means NOTHING was imported — the event arrays are empty.
 * Callers must not render a partial result; see the header.
 */
export function importTaxRows(text: string): ImportResult {
  const errors: ImportError[] = [];
  const lotEvents: TaxLotEvent[] = [];
  const income: IncomeEvent[] = [];

  const lines = text.split(/\r?\n/).filter((l, i) => i === 0 || l.trim().length > 0);
  if (lines.length === 0 || lines[0]!.trim().length === 0) {
    return { lotEvents: [], income: [], errors: [{ line: 1, message: 'Nothing was pasted.' }] };
  }

  const header = splitRow(lines[0]!).map((h) => h.trim().toLowerCase());
  for (const col of IMPORT_COLUMNS) {
    if (!header.includes(col)) {
      errors.push({ line: 1, message: `The header is missing the "${col}" column.` });
    }
  }
  if (errors.length > 0) return { lotEvents: [], income: [], errors };

  const idx = (name: string) => header.indexOf(name);
  const seenIds = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cells = splitRow(lines[i]!);
    const get = (name: string) => (cells[idx(name)] ?? '').trim();

    const kind = get('kind').toLowerCase();
    if (kind !== 'acquire' && kind !== 'dispose' && kind !== 'income') {
      errors.push({ line: lineNo, message: `kind must be acquire, dispose or income — got "${kind}".` });
      continue;
    }

    const asset = get('asset').toLowerCase();
    if (asset.length === 0) {
      errors.push({ line: lineNo, message: 'asset is empty.' });
      continue;
    }
    const symbol = get('symbol') || asset.slice(0, 10);

    const decimalsRaw = get('decimals');
    const decimals = Number(decimalsRaw);
    if (!/^\d{1,2}$/.test(decimalsRaw) || !Number.isInteger(decimals) || decimals > 36) {
      errors.push({ line: lineNo, message: `decimals must be an integer 0–36 — got "${decimalsRaw}".` });
      continue;
    }

    const quantity = parseScaledDecimal(get('quantity'), decimals);
    if (quantity === null || quantity <= 0n) {
      errors.push({
        line: lineNo,
        message:
          `quantity "${get('quantity')}" is not a positive decimal with at most ${decimals} fractional ` +
          'digits. It was not rounded — fix the row.',
      });
      continue;
    }

    const valueRaw = get('value');
    let value: bigint | null = null;
    if (valueRaw.length > 0) {
      value = parseScaledDecimal(valueRaw, VALUE_SCALE);
      if (value === null) {
        errors.push({
          line: lineNo,
          message: `value "${valueRaw}" is not a decimal with at most ${VALUE_SCALE} fractional digits.`,
        });
        continue;
      }
    }

    const timestamp = parseTimestamp(get('timestamp'));
    if (timestamp === null) {
      errors.push({ line: lineNo, message: `timestamp "${get('timestamp')}" is neither ISO-8601 nor unix seconds.` });
      continue;
    }

    const id = get('id') || `${kind}:${lineNo}`;
    if (seenIds.has(id)) {
      // Duplicate ids would make a spec-id nomination ambiguous and would let one
      // row be consumed twice.
      errors.push({ line: lineNo, message: `id "${id}" appears more than once.` });
      continue;
    }
    seenIds.add(id);

    const txHash = get('txhash');
    const nominates = get('nominates')
      .split(/[;| ]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (kind === 'acquire') {
      lotEvents.push({
        kind: 'acquire',
        id,
        asset,
        assetSymbol: symbol,
        quantity,
        decimals,
        costBasis: value,
        timestamp,
        txHash,
      });
    } else if (kind === 'dispose') {
      lotEvents.push({
        kind: 'dispose',
        id,
        asset,
        assetSymbol: symbol,
        quantity,
        decimals,
        proceeds: value,
        timestamp,
        txHash,
        nominatedLotIds: nominates.length > 0 ? nominates : undefined,
      });
    } else {
      income.push({
        id,
        asset,
        assetSymbol: symbol,
        quantity,
        decimals,
        value,
        timestamp,
        txHash,
        kind: 'other',
        source: 'supplied',
      });
    }
  }

  // See the header: a partial import is the failure this guard exists for.
  if (errors.length > 0) return { lotEvents: [], income: [], errors };
  return { lotEvents, income, errors: [] };
}
