import Papa from 'papaparse';
import { getAddress, isAddress, parseUnits, type Address } from 'viem';
import type { CampaignEntry } from './campaign';

/**
 * CSV → campaign entries.
 *
 * Every rejected row is returned with its source line number. Nothing is dropped
 * silently and nothing is guessed: a file where a tenth of the rows failed to parse
 * would otherwise produce a smaller, perfectly valid-looking root, and the creator
 * would fund a campaign that quietly excludes people.
 */

export interface CsvRowError {
  /** 1-based line in the pasted text, counting the header if there was one. */
  line: number;
  raw: string;
  reason: string;
}

export interface CsvParseResult {
  entries: CampaignEntry[];
  errors: CsvRowError[];
  /** True when the first line was consumed as a header rather than as data. */
  headerDetected: boolean;
  /** Rows the parser saw, excluding blank lines. `entries.length + errors.length`. */
  rowsSeen: number;
}

const ADDRESS_HEADERS = ['address', 'account', 'wallet', 'recipient', 'holder'];
const AMOUNT_HEADERS = ['amount', 'value', 'allocation', 'qty', 'quantity', 'tokens'];

function looksLikeHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.some((c) => ADDRESS_HEADERS.includes(c)) || lower.some((c) => AMOUNT_HEADERS.includes(c));
}

/**
 * @param text     Raw CSV. Two columns: address, amount. A header row is optional
 *                 and detected, never required.
 * @param decimals Token decimals used to convert the decimal amount column into base
 *                 units. Supplying the wrong value produces a root for the wrong
 *                 numbers, which is why the create surface reads decimals from the
 *                 token contract rather than letting it be typed.
 */
export function parseAllocationCsv(text: string, decimals: number): CsvParseResult {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`csv: ${String(decimals)} is not a usable token decimals value`);
  }

  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy' });
  const rows = (parsed.data ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));

  const entries: CampaignEntry[] = [];
  const errors: CsvRowError[] = [];
  let headerDetected = false;

  rows.forEach((cells, i) => {
    const line = i + 1;
    const raw = cells.join(',');
    if (i === 0 && looksLikeHeader(cells)) {
      headerDetected = true;
      return;
    }

    const addressCell = String(cells[0] ?? '').trim();
    const amountCell = String(cells[1] ?? '').trim();

    if (!isAddress(addressCell)) {
      errors.push({ line, raw, reason: `"${addressCell}" is not an Ethereum address` });
      return;
    }
    if (amountCell === '') {
      errors.push({ line, raw, reason: 'no amount in the second column' });
      return;
    }
    // Reject scientific notation and thousands separators outright. `parseUnits`
    // would silently mangle "1e18" and "1,000"; a wrong allocation is worse than a
    // rejected line the creator can see and fix.
    if (!/^\d+(\.\d+)?$/.test(amountCell)) {
      errors.push({ line, raw, reason: `"${amountCell}" must be a plain decimal number` });
      return;
    }
    const fraction = amountCell.split('.')[1] ?? '';
    if (fraction.length > decimals) {
      errors.push({
        line,
        raw,
        reason: `"${amountCell}" has ${fraction.length} decimal places; the token has ${decimals}`,
      });
      return;
    }

    const amount = parseUnits(amountCell, decimals);
    if (amount === 0n) {
      errors.push({ line, raw, reason: 'amount rounds to zero base units' });
      return;
    }
    entries.push({ account: getAddress(addressCell) as Address, amount });
  });

  return { entries, errors, headerDetected, rowsSeen: rows.length - (headerDetected ? 1 : 0) };
}
