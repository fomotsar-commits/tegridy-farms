import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A rule of the pools sheet that only a browser measures, and CI's Solana walk does
// (e2e-solana/fixtures/ui.ts expectPressableAtSizes): every button in the LP section is at
// least 44px tall. It failed on PR #1288's first run; this pins the line of CSS that answers it.
const pools = readFileSync(join(process.cwd(), 'src/styles/dwg-pools.css'), 'utf8');

describe('the price button on the pools sheet', () => {
  it('keeps a 44px press area where its line is under 16px', () => {
    // PriceFlip makes 44px from 28px of padding on a 16px line; the sheet sets a row's facts
    // 11px on 1.45 (15.95px), which left every row's price 43.94px tall.
    const rule = /([^{}]*\[data-testid='lp-price-flip'\][^{}]*)\{([^}]*)\}/.exec(pools);
    expect(rule, 'the sheet has a rule for the price button').not.toBeNull();
    expect(rule![1]).toContain(".dwg-sheet[data-sheet='P']");
    expect(rule![2]!.replace(/\s+/g, '')).toContain('min-height:44px');
  });
});
