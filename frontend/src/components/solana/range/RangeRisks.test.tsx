// THE RANGE RISKS IN THE POOLS' WORDS (2026-11-25). The range lists still said what the pools
// lists stopped saying on 2026-11-14 (#1253): "2 of 2 keys", a read date from 2026-10-21 with
// plain hyphens (a 390px line can split it), no outside review twice, the 48-hour wait and the
// withdrawals switch-off twice, no arrow on the closed Risks box, and apostrophes of two kinds
// in one list. The deployed range build lets the vault switch off fee and reward collection on
// a pool (update_pool_status, CollectFee and CollectReward), and the first line did not say so.
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import { RANGE_RISK_SHORT, RangeReviewDisclosure, RangeRisks } from './RangeRisks';

const LISTS = {
  'beside the deposit': () => <RangeRisks />,
  'on the review': () => <RangeReviewDisclosure />,
};
const said = (text: string, phrase: RegExp) => (text.match(new RegExp(phrase.source, `g${phrase.flags}`)) ?? []).length;
/** Every way the lists have said that no one outside checked the changes. */
const NO_REVIEW = /unaudited|independent review|outside review|outside firm|outside audit/i;
const lines = (c: HTMLElement) => [...c.querySelectorAll('li, p')].map((e) => e.textContent ?? '');

describe('the first range line, as the pools say it', () => {
  it('names the read date with non-breaking hyphens, the wait after both keys approve, and every money switch-off', () => {
    expect(RANGE_RISK_SHORT).toContain('48 hours after both keys approve (read on chain 2026‑11‑25)');
    expect(RANGE_RISK_SHORT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(RANGE_RISK_SHORT).toContain('switch off withdrawals or the collection of fees and rewards');
    expect(RANGE_RISK_SHORT).toContain("Our changes to Raydium's program have no outside audit.");
    expect(RANGE_RISK_SHORT).not.toMatch(/2 of 2|two signatures|as read on chain on/);
    expect(RANGE_RISK_SHORT.split(/\s+/).length).toBeLessThanOrEqual(50);
    expect(RANGE_RISK_SHORT).not.toContain('—');
  });
});

describe('each range Risks list says each thing once, in one wording', () => {
  for (const [where, draw] of Object.entries(LISTS)) {
    it(`${where}: one afford-to-lose, one no-review, one wait, one name for the vault`, () => {
      const text = render(draw()).container.textContent ?? '';
      expect(said(text, /afford to lose/)).toBe(1);
      expect(said(text, NO_REVIEW)).toBe(1);
      expect(said(text, /48 hours/)).toBe(1);
      expect(said(text, /switch(ed)? off withdrawals/)).toBe(2); // the power, then what it does to a deposit
      expect(text).toContain(RANGE_RISK_SHORT);
      expect(text).not.toMatch(/pause|2 of 2|two signatures|needs two/i);
      expect(text).not.toMatch(/venue.s vault|shared wallet|pool.s vault/);
    });

    it(`${where}: risk line, vault line, program line, rates line`, () => {
      const view = render(draw());
      const l = lines(view.container);
      const at = (start: string) => l.findIndex((x) => x.startsWith(start));
      expect(at(RANGE_RISK_SHORT)).toBeGreaterThanOrEqual(0);
      expect(at("The team's vault is a Squads multisig. It can also switch off deposits or swaps")).toBe(at(RANGE_RISK_SHORT) + 1);
      expect(at("The range program is Raydium's")).toBe(at(RANGE_RISK_SHORT) + 2);
      expect(at("A change to a fee tier's rates")).toBe(at(RANGE_RISK_SHORT) + 3);
    });

    it(`${where}: one kind of apostrophe`, () => {
      const text = render(draw()).container.textContent ?? '';
      expect(text).not.toContain('’');
    });
  }

  it('beside the deposit while the review is on screen: only what the review does not say', () => {
    const text = render(<RangeRisks reviewing />).container.textContent ?? '';
    expect(text).not.toContain(RANGE_RISK_SHORT);
    expect(text).not.toMatch(/Squads multisig|The range program is Raydium's|A change to a fee tier's rates/);
    expect(text).toContain('Jupiter does not send trades to range pools.');
    expect(text).toContain("If a pool runs a reward, the team's vault can lower its rate or end it early.");
  });
});

describe('a closed range Risks box says it opens', () => {
  it("its summary draws the small print's arrow, and hides the browser's own marker", () => {
    const view = render(<RangeRisks />);
    const summary = within(view.container).getByText('Risks');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.querySelector('svg[aria-hidden="true"] path')).toHaveAttribute('d', 'M9 6l6 6-6 6');
    expect(summary.className).toMatch(/\blist-none\b/);
    expect(summary.className).toContain('[&::-webkit-details-marker]:hidden');
  });
});

// One name for the Squads vault everywhere a visitor meets it, as the pools lists say it.
describe('the vault has one name in the copy', () => {
  it('no visitor text calls it the venue’s vault, and the earn lines do not call it a shared wallet', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const src = join(process.cwd(), 'src');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|js)$/.test(e.name) && !/\.(test|fixture|stories)\./.test(e.name) ? [join(d, e.name)] : [],
      );
    const venueVault = walk(src).filter((f) => /venue[’']s vault/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f));
    expect(venueVault).toEqual([]);
    // "Vault" is the team's: the range page's own words call a pool's token accounts something else.
    const rangeDir = join(src, 'components/solana/range');
    const poolVault = walk(rangeDir).filter((f) => /<p>[^<]*pool[’']s vaults?/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f));
    expect(poolVault).toEqual([]);
    for (const f of ['lib/solana/lp/earnCopy.ts', 'lib/solana/clmm/venueEarns.ts', '../api/_lib/position.js']) {
      expect(readFileSync(join(src, f), 'utf8'), f).not.toMatch(/shared wallet|two signatures/);
    }
  });
});
