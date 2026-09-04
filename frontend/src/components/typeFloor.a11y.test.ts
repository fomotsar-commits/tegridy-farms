/**
 * A11Y-R16 — 9px type does not carry words on the live yield surfaces.
 *
 * The lighthouse pool and the farm render the same "Projected Earnings" block,
 * and both used `text-[9px]` for a column label ("30 Days"), a denomination
 * ("BAYLA", "TOWELI") and full explanatory sentences — including the reserve
 * runway caveat and the "zero, because the vault is empty" explanation, which
 * are the lines a reader most has to read. Nine pixels at text-white/30–/40 is
 * not readable on a 390px phone, so the honest numbers above them were being
 * presented without the words that qualify them.
 *
 * THE RULE: an 11px floor for anything that is a word or a sentence. 9px stays
 * available for uppercase status pills, whose label is duplicated in an
 * aria-label.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A RENDER: the defect is a size choice, and
 * jsdom lays nothing out — a computed-style assertion here would be measuring a
 * value nobody computed. Scanning the source is mechanical and honest about
 * what it checks.
 *
 * SCOPE: the two files this lane owns. The same pattern survives in
 * launchpad/launchpadShared.tsx, ReferralWidget.tsx, swap/CowSwapPanel.tsx and
 * swap/TwapOrderPanel.tsx. Those belong to other lanes — they are reported, not
 * silently swept, and deliberately not asserted here so this test cannot go red
 * for work that is not this lane's to do.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FILES: Record<string, string> = {
  'bungalow/LighthousePoolLive.tsx': join(HERE, 'bungalow', 'LighthousePoolLive.tsx'),
  'farm/StakingCard.tsx': join(HERE, 'farm', 'StakingCard.tsx'),
};

describe('type floor on the live yield surfaces', () => {
  for (const [name, path] of Object.entries(FILES)) {
    it(`${name} never puts text-[9px] on a paragraph`, () => {
      const offenders = readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => line.includes('text-[9px]') && line.includes('<p'));
      expect(
        offenders,
        'a <p> is prose by definition — 11px is the floor for anything a reader must read',
      ).toEqual([]);
    });
  }
});
