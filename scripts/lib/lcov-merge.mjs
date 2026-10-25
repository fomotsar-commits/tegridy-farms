// Merge several lcov.info files into one, by line.
//
// contracts-coverage.yml runs `forge coverage` once per test slice, because one run over
// the whole suite does not fit a 16 GB runner. Each slice reports the lines its own tests
// reached, so the repo's number is the union: a line is hit if any slice hit it.
//
// Only line records survive (TN, SF, DA, LF, LH). The ratchet reads lines and nothing else,
// and dropping FN/BRDA means no function or branch is ever counted twice across slices.
// LF and LH are recomputed from the merged lines, never summed from the inputs.
//
//   node scripts/lib/lcov-merge.mjs <out.info> <in.info>...

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {string[]} texts lcov.info contents @returns {Map<string, Map<number, number>>} */
export function parseLcov(texts) {
  /** @type {Map<string, Map<number, number>>} */
  const files = new Map();
  for (const text of texts) {
    let lines = null;
    for (const raw of text.split(/\r?\n/)) {
      const row = raw.trim();
      if (row.startsWith('SF:')) {
        const sf = row.slice(3);
        if (!files.has(sf)) files.set(sf, new Map());
        lines = files.get(sf);
      } else if (row.startsWith('DA:')) {
        const m = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(row);
        if (!m) throw new Error(`lcov: unreadable line record: ${row}`);
        if (!lines) throw new Error(`lcov: a DA record before any SF: ${row}`);
        const line = Number(m[1]);
        lines.set(line, (lines.get(line) ?? 0) + Number(m[2]));
      } else if (row === 'end_of_record') {
        lines = null;
      }
    }
  }
  return files;
}

/** @param {string[]} texts lcov.info contents @returns {string} one lcov.info */
export function mergeLcov(texts) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('lcov: nothing to merge');
  const files = parseLcov(texts);
  if (files.size === 0) throw new Error('lcov: no SF records in any input');
  const out = [];
  for (const sf of [...files.keys()].sort()) {
    const lines = files.get(sf);
    const nums = [...lines.keys()].sort((a, b) => a - b);
    out.push('TN:', `SF:${sf}`);
    for (const n of nums) out.push(`DA:${n},${lines.get(n)}`);
    out.push(`LF:${nums.length}`, `LH:${nums.filter((n) => lines.get(n) > 0).length}`, 'end_of_record');
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [outPath, ...inPaths] = process.argv.slice(2);
  if (!outPath || inPaths.length === 0) {
    console.error('usage: node scripts/lib/lcov-merge.mjs <out.info> <in.info>...');
    process.exit(2);
  }
  try {
    const merged = mergeLcov(inPaths.map((p) => readFileSync(p, 'utf8')));
    writeFileSync(outPath, merged);
    console.log(`merged ${inPaths.length} lcov files into ${outPath}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
