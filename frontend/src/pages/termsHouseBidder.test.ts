// The Terms name the house bidder only once it runs (BUILD-SPEC 3.2, item 8).
//
// §15 promises notice of material changes, so the sentence arrives with the first wallet in
// lib/house/houseRegistry.json and not before; and the page's "Last updated" line has to move
// with it, or the Terms would change under a date that says they did not.
import { describe, it, expect, vi, afterEach } from 'vitest';
import COMMITTED from '../lib/house/houseRegistry.json';

const SENTENCE = 'The venue may run a disclosed house bidder; when it does, its wallet, rules and trades are published.';

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

  it('move the "Last updated" line once the sentence is in them', async () => {
    const { TERMS_LAST_UPDATED } = await import('./TermsPage');
    if (COMMITTED.wallets.length > 0) {
      expect(TERMS_LAST_UPDATED, 'update TERMS_LAST_UPDATED in TermsPage.tsx: the Terms gained the house bidder sentence').not.toBe('August 2026');
    } else {
      expect(TERMS_LAST_UPDATED).toBe('August 2026');
    }
  });
});
