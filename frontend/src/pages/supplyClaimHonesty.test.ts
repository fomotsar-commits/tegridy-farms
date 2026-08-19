// SUPPLY-CLAIM GUARD — the tokenomics donut.
//
// The chart is five hardcoded percentages mirroring TOKENOMICS.md. Four of the
// five slices name an ALLOCATION (LP Seed, Treasury, Community, Team), which a
// reader correctly takes as policy. The fifth was labelled "Circulating" — the
// one word on the chart that reads as a live measurement of how many tokens are
// in public hands, sitting on a figure nothing reads from chain. Next to it the
// page renders a real on-chain price and a real FDV, which lends the whole panel
// the authority of the figures that were actually read.
//
// The rule: a policy figure may be published, but it must be labelled as policy,
// and the panel must state that it is not a chain read.
//
// The same distinction the revenue guard draws — a claim about STATE needs the
// read that backs it; a claim about DESIGN may be a literal.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPLY_DATA, SUPPLY_BASIS_NOTE } from './TokenomicsPage';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'TokenomicsPage.tsx'), 'utf8');

describe('supply distribution chart', () => {
  it('still sums to the whole supply', () => {
    expect(SUPPLY_DATA.reduce((a, d) => a + d.value, 0)).toBe(100);
  });

  it('labels no slice as a measured circulating supply', () => {
    for (const d of SUPPLY_DATA) {
      expect(
        /circulating/i.test(d.name),
        `slice "${d.name}" claims a circulating-supply measurement that nothing reads`,
      ).toBe(false);
    }
  });

  it('keeps the team slice honest about the absent vesting contract', () => {
    const team = SUPPLY_DATA.find((d) => /team/i.test(d.name));
    expect(team, 'the team allocation must stay on the chart').toBeDefined();
    expect(team!.name).toMatch(/vesting pending|no on-chain vesting/i);
  });
});

// HONESTY GUARD: the panel discloses its own basis, and the disclosure is
// actually rendered rather than merely declared.
describe('the basis note', () => {
  it('names the source and denies the chain read', () => {
    expect(SUPPLY_BASIS_NOTE).toMatch(/TOKENOMICS\.md/);
    expect(SUPPLY_BASIS_NOTE).toMatch(/not read from chain/i);
    expect(SUPPLY_BASIS_NOTE).toMatch(/not a live circulating-supply measurement/i);
  });

  it('is rendered on the page, not just exported', () => {
    expect(source).toMatch(/\{SUPPLY_BASIS_NOTE\}/);
  });

  it('the accessible description of the chart carries the same limit', () => {
    const aria = source.match(/aria-label="(TOWELI[^"]+)"/)?.[1] ?? '';
    expect(aria, 'the donut needs an accessible description').not.toBe('');
    expect(aria).not.toMatch(/circulating \d/i);
    expect(aria).toMatch(/not a live circulating-supply measurement/i);
  });
});
