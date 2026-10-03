// The island lobby's line for the marketplace says what can be done there.
//
// It read "Buy and sell the art." With the Jungle Bay family listed, four of
// the marketplace's nine collections trade on the venue and five are browsed
// there and trade on their own market. A door that promises buying and
// selling of everything behind it is the same over-promise green's ruling
// forbids on the marketplace itself ("never offer an action that cannot
// complete"), so the line names both halves.
//
// BLURB is not exported and the page needs the whole app shell to render, so
// this reads the one line from source, as navRouting.test.jsx does for App.jsx.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'pages', 'IslandPage.tsx'), 'utf8');
const line = /'\/nakamigos':\s*'([^']*)'/.exec(src)?.[1] ?? '';

describe("the island's marketplace line", () => {
  it('exists', () => {
    expect(line.length).toBeGreaterThan(0);
  });

  it('says how many collections trade here and that the rest can be browsed', () => {
    expect(line).toMatch(/\b(four|4)\b/i);
    expect(line).toMatch(/brows/i);
  });

  it('no longer promises buying and selling of everything', () => {
    expect(line).not.toMatch(/^Buy and sell the art\./);
  });

  it('keeps the fee honest and dash-free', () => {
    expect(line).toMatch(/1%/);
    expect(line).not.toMatch(/\u2014/);
  });
});
