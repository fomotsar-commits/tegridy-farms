// DO NOT MERGE before the launchpad redeploy.
//
// The site, the address registry and the docs point at the NFT launchpad that replaces
// 0xa6149B4d… (its template has audit finding F1). That launchpad does not exist until
// the owner deploys it, so its address is a placeholder carrying PENDING_REDEPLOY, and
// the first test below FAILS until scripts/fill-launchpad-redeploy.mjs has written the
// real address from the deploy receipt and an on-chain read-back. A merge in between
// would ship a launchpad address that is not an address.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILES, MARKER, REPO, TOKENS, fillText } from './fill-launchpad-redeploy.mjs';

const SELF = ['frontend/scripts/fill-launchpad-redeploy.mjs', 'frontend/scripts/fill-launchpad-redeploy.test.mjs'];

/** Tracked files that contain the marker, the helper and this test aside. */
function filesWithMarker() {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', '-F', MARKER], { cwd: REPO, encoding: 'utf-8' });
  } catch (e) {
    if (e.status === 1) return []; // git grep: no match
    throw e;
  }
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !SELF.includes(l));
}

describe('the launchpad redeploy', () => {
  it('is filled in: no placeholder is left (fails until the new launchpad is deployed and filled)', () => {
    const left = filesWithMarker().map((f) => {
      const hits = readFileSync(join(REPO, f), 'utf-8').split('\n')
        .map((l, i) => (l.includes(MARKER) ? i + 1 : 0)).filter(Boolean);
      return `${f}:${hits.join(',')}`;
    });
    expect(
      left,
      'DO NOT MERGE before the launchpad redeploy. After the deploy, run from frontend/: ' +
        'node scripts/fill-launchpad-redeploy.mjs <new launchpad address>',
    ).toEqual([]);
  });

  it('the helper fills every file that holds a placeholder', () => {
    const missed = filesWithMarker().filter((f) => !FILES.includes(f));
    expect(missed, 'a placeholder sits in a file the helper does not fill: add it to FILES').toEqual([]);
  });

  it('every file the helper fills exists', () => {
    expect(FILES.filter((f) => !existsSync(join(REPO, f)))).toEqual([]);
  });
});

describe('fillText', () => {
  const values = {
    launchpad: '0x1111111111111111111111111111111111111111',
    template: '0x2222222222222222222222222222222222222222',
    receipt: 'run-1.json',
    block: '26,200,000',
    date: '2026-10-20',
  };

  it('fills every placeholder and leaves no marker', () => {
    const text = Object.values(TOKENS).map((t) => `[${t}]`).join(' ');
    const out = fillText(text, values);
    expect(out).toBe(`[${values.launchpad}] [${values.template}] [run-1.json] [26,200,000] [2026-10-20]`);
    expect(out).not.toContain(MARKER);
  });

  it('refuses a placeholder it does not know rather than leaving it', () => {
    expect(() => fillText(`x ${MARKER}_SOMETHING_ELSE y`, values)).toThrow(/unknown placeholder/);
  });

  it('refuses to fill with a missing value', () => {
    expect(() => fillText(TOKENS.date, { ...values, date: '' })).toThrow(/no value/);
  });

  it('refuses a bare marker it cannot replace', () => {
    expect(() => fillText(`reads ${MARKER}: still`, values)).toThrow(/left after filling/);
  });
});
