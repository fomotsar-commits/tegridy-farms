import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import { parseAllocationCsv } from './csv';

/**
 * The failure this file guards: a CSV parser that drops what it cannot understand.
 *
 * A creator pastes 1,000 rows, 40 of them malformed, and gets a root over 960 — a
 * perfectly valid tree for a campaign that quietly excludes forty people, funded with
 * a total that looks right because it was computed from the same truncated list.
 * Every rejection here is therefore returned with its line number, and the count of
 * rejections is part of the result rather than a log line.
 */

describe('parseAllocationCsv reports what it rejected', () => {
  it('parses a plain two-column list', () => {
    const r = parseAllocationCsv(
      '0x1111111111111111111111111111111111111111,100\n0x2222222222222222222222222222222222222222,2.5',
      18,
    );
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.amount).toBe(parseEther('100'));
    expect(r.entries[1]!.amount).toBe(parseEther('2.5'));
  });

  it('detects and skips a header row without counting it as data', () => {
    const r = parseAllocationCsv('address,amount\n0x1111111111111111111111111111111111111111,1', 18);
    expect(r.headerDetected).toBe(true);
    expect(r.rowsSeen).toBe(1);
    expect(r.entries).toHaveLength(1);
  });

  it('reports a bad address with its line number instead of dropping the row', () => {
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,1\nnot-an-address,5', 18);
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.reason).toMatch(/not an Ethereum address/);
  });

  it('refuses scientific notation rather than letting parseUnits mangle it', () => {
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,1e18', 18);
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]!.reason).toMatch(/plain decimal number/);
  });

  it('refuses thousands separators, which would silently truncate the amount', () => {
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,"1,000"', 18);
    expect(r.entries).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
  });

  it('refuses more decimal places than the token has', () => {
    // 6-decimal token, 8 decimal places supplied: parseUnits would round it away and
    // the creator would never learn that two of their digits stopped existing.
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,1.12345678', 6);
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]!.reason).toMatch(/6/);
  });

  it('scales by the token decimals it was given, not by 18', () => {
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,1.5', 6);
    expect(r.entries[0]!.amount).toBe(1_500_000n);
  });

  it('refuses an amount that rounds to zero base units', () => {
    const r = parseAllocationCsv('0x1111111111111111111111111111111111111111,0', 18);
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]!.reason).toMatch(/zero/);
  });

  it('refuses an implausible decimals value outright', () => {
    expect(() => parseAllocationCsv('0x1111111111111111111111111111111111111111,1', -1)).toThrow();
    expect(() => parseAllocationCsv('0x1111111111111111111111111111111111111111,1', 200)).toThrow();
  });

  it('accounts for every non-blank line: entries + errors === rowsSeen', () => {
    const csv = [
      'address,amount',
      '0x1111111111111111111111111111111111111111,1',
      'garbage',
      '',
      '0x2222222222222222222222222222222222222222,2',
      '0x3333333333333333333333333333333333333333,',
    ].join('\n');
    const r = parseAllocationCsv(csv, 18);
    expect(r.entries.length + r.errors.length).toBe(r.rowsSeen);
    expect(r.entries).toHaveLength(2);
    expect(r.errors).toHaveLength(2);
  });
});
