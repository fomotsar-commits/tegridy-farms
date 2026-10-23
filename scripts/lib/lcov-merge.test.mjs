// Proof for scripts/lib/lcov-merge.mjs, which contracts-coverage.yml uses to join the
// per-slice `forge coverage` reports into the one number the floor ratchet reads.
//
// RUN BY `node --test`, NOT VITEST, and named in .github/workflows/ci.yml (the same
// arrangement as redact-url.test.mjs next to it).
//
// The two ways a merge goes quietly wrong, and each has a test below:
//   * a slice's hits are lost (max or last-wins instead of a union), so coverage reads
//     lower than it is and the ratchet goes red for nothing; or
//   * a line is counted once per slice, so LF grows with the number of slices and the
//     percentage drifts every time a slice is added.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeLcov, parseLcov } from './lcov-merge.mjs';

const rec = (sf, lines) =>
  ['TN:', `SF:${sf}`, ...lines.map(([n, h]) => `DA:${n},${h}`), `LF:${lines.length}`,
    `LH:${lines.filter(([, h]) => h > 0).length}`, 'end_of_record'].join('\n') + '\n';

const totals = (text) => {
  let lf = 0;
  let lh = 0;
  for (const row of text.split('\n')) {
    if (row.startsWith('LF:')) lf += Number(row.slice(3));
    if (row.startsWith('LH:')) lh += Number(row.slice(3));
  }
  return { lf, lh };
};

describe('mergeLcov', () => {
  test('a line one slice hit and another missed is hit', () => {
    const a = rec('src/A.sol', [[1, 3], [2, 0], [3, 0]]);
    const b = rec('src/A.sol', [[1, 0], [2, 5], [3, 0]]);
    const merged = mergeLcov([a, b]);
    assert.deepEqual(totals(merged), { lf: 3, lh: 2 });
    assert.match(merged, /DA:1,3\nDA:2,5\nDA:3,0\n/);
  });

  test('hits add up, so a line is not lost to whichever slice came last', () => {
    const merged = mergeLcov([rec('src/A.sol', [[7, 2]]), rec('src/A.sol', [[7, 4]]), rec('src/A.sol', [[7, 0]])]);
    assert.match(merged, /DA:7,6\n/);
  });

  test('a line in every slice is counted once, not once per slice', () => {
    const one = rec('src/A.sol', [[1, 1], [2, 1]]);
    const merged = mergeLcov([one, one, one, one]);
    assert.deepEqual(totals(merged), { lf: 2, lh: 2 });
  });

  test('files that only one slice reached are kept, and every file is its own record', () => {
    const merged = mergeLcov([rec('src/A.sol', [[1, 1]]), rec('src/B.sol', [[1, 0], [2, 0]])]);
    assert.deepEqual(totals(merged), { lf: 3, lh: 1 });
    assert.equal(merged.match(/^SF:/gm).length, 2);
    assert.equal(merged.match(/^end_of_record$/gm).length, 2);
  });

  test('LF and LH come from the merged lines, not from the inputs', () => {
    // Inputs whose own LF/LH disagree with their DA rows must not leak through.
    const lying = 'TN:\nSF:src/A.sol\nDA:1,1\nDA:2,0\nLF:99\nLH:99\nend_of_record\n';
    assert.deepEqual(totals(mergeLcov([lying])), { lf: 2, lh: 1 });
  });

  test('function and branch records are dropped, so nothing is double counted', () => {
    const withFn = 'SF:src/A.sol\nFN:1,f\nFNDA:4,f\nFNF:1\nFNH:1\nDA:1,4\nBRDA:1,0,0,2\nBRF:1\nBRH:1\nLF:1\nLH:1\nend_of_record\n';
    const merged = mergeLcov([withFn, withFn]);
    assert.doesNotMatch(merged, /^(FN|BRDA|BRF|BRH)/m);
    assert.deepEqual(totals(merged), { lf: 1, lh: 1 });
  });

  test('the result does not depend on the order of the inputs', () => {
    const a = rec('src/B.sol', [[3, 1], [1, 0]]);
    const b = rec('src/A.sol', [[2, 2]]);
    assert.equal(mergeLcov([a, b]), mergeLcov([b, a]));
  });

  test('a checksum on a DA row is accepted', () => {
    assert.match(mergeLcov(['SF:src/A.sol\nDA:5,2,abcdef\nend_of_record\n']), /DA:5,2\n/);
  });

  test('it refuses to report nothing as a result', () => {
    assert.throws(() => mergeLcov([]), /nothing to merge/);
    assert.throws(() => mergeLcov(['']), /no SF records/);
    assert.throws(() => mergeLcov(['TN:\nend_of_record\n']), /no SF records/);
  });

  test('it refuses a line record it cannot read, and one outside any file', () => {
    assert.throws(() => mergeLcov(['SF:src/A.sol\nDA:x,1\nend_of_record\n']), /unreadable line record/);
    assert.throws(() => mergeLcov(['SF:src/A.sol\nDA:1,-1\nend_of_record\n']), /unreadable line record/);
    assert.throws(() => mergeLcov(['DA:1,1\n']), /before any SF/);
  });
});

describe('parseLcov', () => {
  test('reads CRLF files', () => {
    const files = parseLcov(['SF:src/A.sol\r\nDA:1,2\r\nend_of_record\r\n']);
    assert.equal(files.get('src/A.sol').get(1), 2);
  });
});

describe('the command line', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLI = join(HERE, 'lcov-merge.mjs');

  test('writes the merged file and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcov-merge-'));
    writeFileSync(join(dir, 'a.info'), rec('src/A.sol', [[1, 1], [2, 0]]));
    writeFileSync(join(dir, 'b.info'), rec('src/A.sol', [[1, 0], [2, 1]]));
    execFileSync('node', [CLI, join(dir, 'out.info'), join(dir, 'a.info'), join(dir, 'b.info')]);
    assert.deepEqual(totals(readFileSync(join(dir, 'out.info'), 'utf8')), { lf: 2, lh: 2 });
  });

  test('exits non-zero on an input with no files in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcov-merge-'));
    writeFileSync(join(dir, 'empty.info'), '');
    assert.throws(() => execFileSync('node', [CLI, join(dir, 'out.info'), join(dir, 'empty.info')], { stdio: 'pipe' }));
  });
});
