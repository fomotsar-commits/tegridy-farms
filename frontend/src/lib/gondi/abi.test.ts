import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GONDI_LOAN_ABI } from './abi.js';

// The site's Gondi ABI is cut from Gondi's own build (the bytecode the deploy script ships),
// never written by hand. Every entry must be the build file's entry, unchanged.

const VENDOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/vendor/gondi-v3.2');
const BUILD = JSON.parse(
  readFileSync(resolve(VENDOR_ROOT, 'build/MultiSourceLoan.json'), 'utf8'),
) as { abi: { type: string; name?: string; inputs?: unknown[] }[] };

describe('GONDI_LOAN_ABI', () => {
  it('every entry is Gondi\'s build entry, unchanged', () => {
    for (const entry of GONDI_LOAN_ABI) {
      const match = BUILD.abi.filter((b) => b.type === entry.type && b.name === entry.name);
      expect(match, `${entry.type} ${entry.name}`).toContainEqual(entry);
    }
  });

  it('carries every error, so a revert decodes to Gondi\'s name for it', () => {
    const errors = BUILD.abi.filter((b) => b.type === 'error').length;
    expect(GONDI_LOAN_ABI.filter((e) => e.type === 'error')).toHaveLength(errors);
    expect(errors).toBeGreaterThan(10);
  });

  it('abi.d.ts types the same list abi.js holds', () => {
    const dts = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'abi.d.ts'), 'utf8');
    const literal = dts.slice(dts.indexOf('GONDI_LOAN_ABI: ') + 'GONDI_LOAN_ABI: '.length).replace(/;\s*$/, '');
    expect(JSON.parse(literal)).toEqual(GONDI_LOAN_ABI);
  });
});
