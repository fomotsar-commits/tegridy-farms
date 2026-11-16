// The Terms name the house bidder only once it runs (BUILD-SPEC 3.2, item 8).
//
// §15 promises notice of material changes, so the sentence arrives with the first wallet in
// lib/house/houseRegistry.json and not before; and the page's "Last updated" line has to move
// with it, or the Terms would change under a date that says they did not.
import { describe, it, expect, vi, afterEach } from 'vitest';
import COMMITTED from '../lib/house/houseRegistry.json';

const SENTENCE = 'The venue may run a disclosed house bidder; when it does, its wallet, rules and trades are published.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * What is wrong with the "Last updated" line for these house wallets, or null.
 *
 * The sentence arrives with the first wallet, so from then on the line must read that wallet's
 * `since` month or a later one. A later wallet changes nothing in the Terms and asks nothing
 * more. With no wallet there is no sentence, so any other change to the Terms may move the
 * date (review HR-3: this used to pin 'August 2026' exactly, which failed such a change, and
 * once the date had moved it no longer made the go-live change move it again).
 */
function lastUpdatedProblem(lastUpdated: string, wallets: readonly { since?: string }[]): string | null {
  if (wallets.length === 0) return null;
  const since = wallets.map((w) => w.since ?? '');
  if (!since.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return 'every house wallet needs a since date (YYYY-MM-DD) in houseRegistry.json';
  const firstLive = [...since].sort()[0];
  const shown = /^([A-Z][a-z]+) (\d{4})$/.exec(lastUpdated);
  if (!shown || !MONTHS.includes(shown[1])) return `TERMS_LAST_UPDATED in TermsPage.tsx must read "<Month> <YYYY>", not "${lastUpdated}"`;
  const monthOf = (year: number, monthIndex: number) => year * 12 + monthIndex;
  const live = monthOf(Number(firstLive.slice(0, 4)), Number(firstLive.slice(5, 7)) - 1);
  if (monthOf(Number(shown[2]), MONTHS.indexOf(shown[1])) >= live) return null;
  return `update TERMS_LAST_UPDATED in TermsPage.tsx to ${MONTHS[live % 12]} ${Math.floor(live / 12)} or later: the Terms gained the house bidder sentence when the first house wallet went live (${firstLive})`;
}

// A cold import of TermsPage (the launcher's config behind it) takes several seconds.
vi.setConfig({ testTimeout: 30000 });

async function termsWith(wallets: string[]) {
  vi.resetModules();
  vi.doMock('../lib/house/houseRegistry.js', async () => {
    const core = await import('../lib/house/houseRegistryCore.js');
    const house = core.createHouseRegistry({ version: 1, note: 'test', wallets: wallets.map((address) => ({ address })) });
    return { ...house, HOUSE_LABEL: core.HOUSE_LABEL, createHouseRegistry: core.createHouseRegistry };
  });
  return import('./TermsPage');
}

afterEach(() => {
  vi.doUnmock('../lib/house/houseRegistry.js');
  vi.resetModules();
});

describe('the Terms and the house bidder', () => {
  it('say nothing about it while the committed registry is empty', async () => {
    vi.resetModules();
    const { SECTIONS, HOUSE_BIDDER_SENTENCE } = await import('./TermsPage');
    expect(HOUSE_BIDDER_SENTENCE).toBe(SENTENCE);
    expect(COMMITTED.wallets).toEqual([]);
    expect(SECTIONS.map((s) => s.body).join('\n')).not.toContain('house bidder');
  });

  it('say it once, at the end of §2, as soon as a wallet is registered', async () => {
    const { SECTIONS } = await termsWith(['0x8ba1f109551bD432803012645Ac136ddd64DBA72']);
    const all = SECTIONS.map((s) => s.body).join('\n');
    expect(all.split(SENTENCE)).toHaveLength(2);
    const s2 = SECTIONS.find((s) => s.title.startsWith('2. '));
    expect(s2?.body.endsWith(` ${SENTENCE}`)).toBe(true);
  });

  it('date the "Last updated" line no earlier than the sentence', async () => {
    const { TERMS_LAST_UPDATED } = await import('./TermsPage');
    expect(lastUpdatedProblem(TERMS_LAST_UPDATED, COMMITTED.wallets)).toBeNull();
  });
});

describe('the "Last updated" rule (review HR-3)', () => {
  const first = [{ since: '2026-11-16' }];

  it('asks nothing of the date while no wallet is registered: any other change to the Terms may move it', () => {
    expect(lastUpdatedProblem('August 2026', [])).toBeNull();
    expect(lastUpdatedProblem('December 2026', [])).toBeNull();
  });

  it("once a wallet is registered, asks for its month or a later one, and says what to change", () => {
    expect(lastUpdatedProblem('November 2026', first)).toBeNull();
    expect(lastUpdatedProblem('January 2027', first)).toBeNull();
    // Moved in September for some other change: still older than the sentence.
    expect(lastUpdatedProblem('September 2026', first)).toMatch(/TERMS_LAST_UPDATED .*November 2026 or later/);
    expect(lastUpdatedProblem('August 2026', first)).toMatch(/TERMS_LAST_UPDATED .*November 2026 or later/);
  });

  it('a later wallet changes nothing in the Terms, so it asks nothing more', () => {
    expect(lastUpdatedProblem('November 2026', [...first, { since: '2027-02-01' }])).toBeNull();
  });

  it('says so when it cannot read the date or a wallet\'s since', () => {
    expect(lastUpdatedProblem('Nov 2026', first)).toMatch(/"<Month> <YYYY>"/);
    expect(lastUpdatedProblem('November 2026', [{ since: '16/11/2026' }])).toMatch(/since/);
  });
});
