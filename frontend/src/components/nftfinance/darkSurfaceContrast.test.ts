// Black text on the dark NFT-finance surfaces.
//
// A find/replace pass swapped a batch of `text-white` tokens for `text-black`
// on panels whose backgrounds are dark in both themes. The result is not a
// styling nit: the mint page rendered its phase label black inside a
// `bg-black/60` tile, the lending stats bar turned its own numbers black on
// hover, and the live mint feed hid the per-mint quantity. A figure that is
// present but unreadable is worse than an admitted gap — the surface looks
// like it is telling you something while telling you nothing.
//
// `text-black` is legitimate over an opaque light fill (a solid emerald
// button). It is never legitimate over a translucent fill or bare, because
// every surface underneath these components is dark. That is the rule pinned
// here, checked against source so a future sweep can't quietly reintroduce it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'nftfinance/LendingSection.tsx',
  'nftfinance/NFTLendingSection.tsx',
  'nftfinance/AMMSection.tsx',
  'launchpad/launchpadShared.tsx',
  'launchpad/CollectionDetailV2.tsx',
  'launchpad/OwnerAdminPanelV2.tsx',
  'launchpad/wizard/WizardStepper.tsx',
];

/** An opaque light fill on the same class string — the one place black reads. */
const OPAQUE_LIGHT_FILL = /\bbg-(emerald|amber|yellow|white|purple|blue)-[1-5]00\b(?!\/)/;

function offendingLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => /\btext-black\b|\btext-black\/\d+\b/.test(line))
    .filter((line) => !OPAQUE_LIGHT_FILL.test(line));
}

describe('dark-surface text contrast', () => {
  for (const rel of FILES) {
    it(`${rel} uses no black text without an opaque light fill behind it`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(offendingLines(src)).toEqual([]);
    });
  }

  it('still allows black on a solid button fill', () => {
    // Guard the guard: the rule must not be so blunt that it forces white
    // text onto a solid emerald button, where black is the readable choice.
    expect(offendingLines('className="bg-emerald-500 text-black"')).toEqual([]);
    expect(offendingLines('className="bg-emerald-500/40 text-black"')).toHaveLength(1);
    expect(offendingLines('className="text-black/60"')).toHaveLength(1);
  });
});
