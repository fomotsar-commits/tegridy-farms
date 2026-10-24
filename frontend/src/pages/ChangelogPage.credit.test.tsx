import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ChangelogPage, { EntryBadges } from './ChangelogPage';
import { daysFromChangelog } from '../lib/changelogDays';

// A DATED PUBLIC LINE IS THE BUILDER'S PAY, SO IT IS SPENT ON EXACTLY ONE PERSON.
//
// ChangelogEntry carried date, title and items. A piece that came in through
// the rail had nowhere to say who built it, and the venue had no way to hand a
// contributor the one asset it actually sells: proof of work, dated, in public.
//
// `by` is optional, and the half of that rule worth pinning is the ABSENT half.
// Forty-odd entries on this page were written by the venue itself and name no
// outside builder. A credit that renders its chrome unconditionally would put
// an empty badge, or a bare "built by", on every one of them, and would read as
// the venue crediting itself for its own record. That is why the second test
// asserts on the string "built by" rather than on a name: a nameless badge is
// the exact shape of this failure, and asserting a name would pass straight
// through it.
//
// SHOWN RED FIRST, as this repo requires. Against the pre-change file both
// cases fail at import: `EntryBadges` is not exported because it did not exist,
// and `ChangelogEntry` had no `by` to render. Reverting only the `by` branch
// while keeping the export turns the first test red and leaves the second green,
// which is the mutation that matters.

describe('changelog entry badges', () => {
  it('prints the builder beside the date when the entry names one', () => {
    render(<EntryBadges date="September 20, 2026" by="joeyhodl" />);

    expect(screen.getByText('September 20, 2026')).toBeTruthy();
    expect(screen.getByText(/built by/)).toBeTruthy();
    expect(screen.getByText(/joeyhodl/)).toBeTruthy();
  });

  it('prints no credit chrome at all when the entry names nobody', () => {
    const { container } = render(<EntryBadges date="August 18, 2026" />);

    expect(screen.getByText('August 18, 2026')).toBeTruthy();
    // Not `queryByText(name)` — there is no name to look for. The failure being
    // guarded is chrome with nothing in it.
    expect(screen.queryByText(/built by/)).toBeNull();
    expect(container.querySelectorAll('span')).toHaveLength(1);
  });

  it('keeps the gap under the badges identical whether or not a credit prints', () => {
    // The margin moved off the date badge onto the row. If it ever moves back,
    // a credited entry and an uncredited one drift apart vertically.
    const credited = render(<EntryBadges date="September 20, 2026" by="joeyhodl" />).container
      .firstElementChild;
    const bare = render(<EntryBadges date="August 18, 2026" />).container.firstElementChild;

    expect(credited?.className).toBe(bare?.className);
    expect(credited?.className).toContain('mb-3');
  });
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const entryLines = (file: string) =>
  readFileSync(join(REPO_ROOT, file), 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/`/g, ''));
const renderedLines = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-record="changelog"] li')].map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

// CHANGELOG.md's twin of this guard is in src/test/frontDoor.test.ts. This one reads
// the page's own list as it renders.
describe('the changelog page', () => {
  it('lists no line twice', () => {
    const lines = renderedLines(render(<ChangelogPage />).container);

    expect(lines.length).toBeGreaterThan(100);
    expect(lines.filter((l, i) => lines.indexOf(l) !== i)).toEqual([]);
  });

  // The tab once kept its own hand-written list, and it stopped at August 18 while
  // CHANGELOG.md gained a line with nearly every merge. It now reads both files.
  it('shows every line of CHANGELOG.md and of the earlier days, in file order', () => {
    const lines = renderedLines(render(<ChangelogPage />).container);
    const fromFiles = [...entryLines('CHANGELOG.md'), ...entryLines('docs/CHANGELOG_EARLIER.md')];

    expect(fromFiles.length).toBeGreaterThan(100);
    expect(lines.slice(0, fromFiles.length)).toEqual(fromFiles.map((l) => l.replace(/\s+/g, ' ').trim()));
  });
});

describe('reading a changelog file', () => {
  it('opens a day at its date heading, keeps its lines, and stops at the next ## heading', () => {
    const text = [
      '# Changelog',
      '- not a day yet',
      '## [Unreleased]',
      '### 2026-10-18',
      '',
      '- One `/path` line.',
      '- Two.',
      '### 2026-09-01',
      '### 2026-08-31',
      '- Three.',
      '## Earlier',
      '- prose, not a day',
    ].join('\n');

    expect(daysFromChangelog(text)).toEqual([
      { date: 'October 18, 2026', items: ['One /path line.', 'Two.'] },
      { date: 'August 31, 2026', items: ['Three.'] },
    ]);
  });
});
