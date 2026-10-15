// DO NOT MERGE before staking release 1 is deployed AND funded.
//
// The site, the address registry and the docs point at the staking contracts of staking
// release 1 (docs/STAKING_RELEASE_1_WIRING.md). Those do not exist until the owner deploys
// them, so their addresses are placeholders, and the first test below FAILS until
// scripts/fill-staking-release.mjs has written the real ones from the deploy receipt and an
// on-chain read-back. A merge in between would ship a staking address that is not an
// address: every stake, claim and exit on the Farm page would fail.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS, FILES, MARKER, OWNER, REPO, TOKENS, fillText, releaseFromRun } from './fill-staking-release.mjs';

const SELF = ['frontend/scripts/fill-staking-release.mjs', 'frontend/scripts/fill-staking-release.test.mjs'];

/** Tracked files that contain the marker, the helper and this test aside. */
function filesWithMarker() {
  let out;
  try {
    out = execFileSync('git', ['grep', '-l', '-F', MARKER], { cwd: REPO, encoding: 'utf-8' });
  } catch (e) {
    if (e.status === 1) return []; // git grep: no match
    throw e;
  }
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !SELF.includes(l));
}

describe('staking release 1', () => {
  it('is filled in: no placeholder is left (fails until the release is deployed, funded and filled)', () => {
    const left = filesWithMarker().map((f) => {
      const hits = readFileSync(join(REPO, f), 'utf-8').split('\n')
        .map((l, i) => (l.includes(MARKER) ? i + 1 : 0)).filter(Boolean);
      return `${f}:${hits.join(',')}`;
    });
    expect(
      left,
      'DO NOT MERGE before staking release 1 is deployed and funded. Then, from frontend/: ' +
        'node scripts/fill-staking-release.mjs',
    ).toEqual([]);
  });

  it('the helper fills every file that holds a placeholder', () => {
    const missed = filesWithMarker().filter((f) => !FILES.includes(f));
    expect(missed, 'a placeholder sits in a file the helper does not fill: add it to FILES').toEqual([]);
  });

  it('every file the helper fills exists, and each placeholder in it is one the helper knows', () => {
    expect(FILES.filter((f) => !existsSync(join(REPO, f)))).toEqual([]);
    const known = new Set(Object.values(TOKENS));
    for (const f of FILES) {
      const found = readFileSync(join(REPO, f), 'utf-8').match(new RegExp(`(?:0x)?${MARKER}_[A-Z_]+`, 'g')) ?? [];
      expect(found.filter((t) => !known.has(t)), f).toEqual([]);
    }
  });
});

describe('fillText', () => {
  const values = {
    ...Object.fromEntries(Object.values(CONTRACTS).map((k, i) => [k, `0x${String(i + 1).repeat(40).slice(0, 40)}`])),
    receipt: 'run-1.json',
    date: '2026-10-20',
  };

  it('fills every placeholder and leaves no marker', () => {
    const text = Object.values(TOKENS).map((t) => `[${t}]`).join(' ');
    const out = fillText(text, values);
    expect(out).not.toContain(MARKER);
    expect(out).toContain('[run-1.json] [2026-10-20]');
    // The longer token is never eaten by the shorter one it starts with.
    expect(fillText(TOKENS.admin, values)).toBe(values.admin);
    expect(fillText(TOKENS.staking, values)).toBe(values.staking);
  });

  it('refuses a placeholder it does not know rather than leaving it', () => {
    expect(() => fillText(`x 0x${MARKER}_SOMETHING_ELSE y`, values)).toThrow(/unknown placeholder/);
  });

  it('refuses to fill with a missing value', () => {
    expect(() => fillText(TOKENS.date, { ...values, date: '' })).toThrow(/no value/);
  });

  it('refuses a bare marker it cannot replace', () => {
    expect(() => fillText(`reads ${MARKER}: still`, values)).toThrow(/left after filling/);
  });
});

describe('releaseFromRun reads the deploy receipt, not a person', () => {
  // The shape forge writes (the 2026-10-14 fork rehearsal's run, cut down).
  const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const names = Object.keys(CONTRACTS);
  const run = (over = {}) => {
    const transactions = names.map((name, i) => ({
      hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      transactionType: name.endsWith('Lib') ? 'CREATE2' : 'CREATE',
      contractName: name,
      contractAddress: addr(i + 1),
      transaction: { from: OWNER.toLowerCase() },
    }));
    transactions.push({ hash: `0x${'f'.repeat(64)}`, transactionType: 'CALL', contractName: null, function: 'proposeRevenueDistributor(address)', transaction: { from: OWNER.toLowerCase() } });
    const receipts = transactions.map((t, i) => ({ transactionHash: t.hash, status: '0x1', blockNumber: `0x${(100 + i).toString(16)}` }));
    return { transactions, receipts, ...over };
  };

  it('takes all ten addresses and the first block from a finished run', () => {
    const r = releaseFromRun(run());
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.addresses).sort()).toEqual(Object.values(CONTRACTS).sort());
    expect(r.addresses.staking.toLowerCase()).toBe(addr(names.indexOf('TegridyStaking') + 1));
    expect(r.firstBlock).toBe(100n);
  });

  it('refuses a run where any transaction did not succeed: a half-wired release', () => {
    const bad = run();
    bad.receipts[bad.receipts.length - 1].status = '0x0';
    expect(releaseFromRun(bad).problems.join(' ')).toMatch(/proposeRevenueDistributor.*status 0x0/);
  });

  it('refuses a run sent by anyone but the owner key', () => {
    const bad = run();
    bad.transactions[names.indexOf('TegridyStaking')].transaction.from = addr(999);
    expect(releaseFromRun(bad).problems.join(' ')).toMatch(/TegridyStaking was sent by/);
  });

  it('refuses a run that is missing one of the ten', () => {
    const bad = run();
    bad.transactions = bad.transactions.filter((t) => t.contractName !== 'ReferralSplitter');
    expect(releaseFromRun(bad).problems).toContain('the run created no ReferralSplitter');
  });

  it('is not a release when the run deployed no TegridyStaking (the fund or re-point run)', () => {
    expect(releaseFromRun({ transactions: [{ transactionType: 'CALL', contractName: 'TegridyStaking' }], receipts: [] })).toBeNull();
  });
});
