/**
 * A HEADING SPLIT BY <br> NEEDS A REAL SPACE AT THE JOINT (answer ten, ruling 3).
 *
 * A <br> is not text. So an H1 written `Title.<br /><span>Line</span>` reads
 * "Title.Line" to everything that reads text rather than pixels: a screen reader's
 * heading list, a crawler, a link unfurl. Ruling 3 put the space into the venue
 * hero, and a review then found the same joint without it on every room hero
 * ("BAYLA.The muse was always here."), on the quiet door ("Unmarked.Someone is
 * building here.") and on the TOWELI home ("Farm TOWELI.Check our work.").
 *
 * So this is a sweep of every heading in src, not a list of the three: a heading
 * added tomorrow with the same shape fails here. A space before a forced break is
 * never drawn, so the fix moves nothing on screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../lib/bungalows';
import { BungalowHero } from '../components/bungalow/BungalowHero';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

/** Every <br> inside a heading whose joint has no space, as "file:line". */
function joinedBreaks(source: string, file: string): string[] {
  // JSX comments first: a <br> named inside a comment is not markup.
  const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, (c) => c.replace(/[^\n]/g, ' '));
  const out: string[] = [];
  for (const h of code.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const bodyStart = h.index! + h[0].indexOf('>') + 1;
    for (const br of h[2]!.matchAll(/<br\s*\/?>/g)) {
      const upToBreak = h[2]!.slice(0, br.index);
      // JSX drops a run of whitespace that contains a newline, so only an explicit
      // {' '} or a space on the same line as the text survives.
      const trailing = /\s*$/.exec(upToBreak)![0];
      if (upToBreak.trimEnd().endsWith("{' '}")) continue;
      if (trailing.length > 0 && !trailing.includes('\n')) continue;
      out.push(`${relative(SRC, file).replace(/\\/g, '/')}:${code.slice(0, bodyStart + br.index!).split('\n').length}`);
    }
  }
  return out;
}

describe('headings split by <br> keep a space at the joint', () => {
  it('every heading in src', () => {
    const files = tsxFiles(SRC);
    expect(files.length, 'the sweep found no source files').toBeGreaterThan(100);
    expect(files.flatMap((f) => joinedBreaks(readFileSync(f, 'utf8'), f))).toEqual([]);
  });

  it('can see the defect it sweeps for', () => {
    expect(joinedBreaks('<h1 className="x">{t}<br /><span>{l}</span></h1>', 'a.tsx')).toHaveLength(1);
    expect(joinedBreaks("<h1>\n  {t}\n  <br />\n  <span>{l}</span>\n</h1>", 'a.tsx')).toHaveLength(1);
    expect(joinedBreaks("<h1>{t}{' '}<br /><span>{l}</span></h1>", 'a.tsx')).toEqual([]);
    expect(joinedBreaks('<h1>{/* a <br /> in a comment */}{t}</h1>', 'a.tsx')).toEqual([]);
  });

  it('and the rendered text of every settled room hero reads title, space, line', () => {
    const rooms = BUNGALOWS.filter((b) => b.live && b.identity);
    expect(rooms.length).toBeGreaterThan(0);
    for (const b of rooms) {
      const { container, unmount } = render(
        <MemoryRouter>
          <BungalowHero bungalow={b as Parameters<typeof BungalowHero>[0]['bungalow']} />
        </MemoryRouter>,
      );
      expect(container.querySelector('h1')?.textContent, b.id).toBe(`${b.identity!.heroTitle} ${b.identity!.heroLine}`);
      unmount();
    }
  });
});
