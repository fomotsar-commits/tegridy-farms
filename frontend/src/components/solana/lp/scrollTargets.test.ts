// @vitest-environment node
//
// The LP section mounts only on Pools tabs, under the pinned tab strip (PoolsHostPage).
// There the page's scroll-padding (index.css, html.has-route-tabs) already stops what is
// scrolled to 18px under the strip, and a scroll margin in here is added on top of that.
// e2e/tab-strip-clears-focus.spec.ts measures the targets that are on the page at rest;
// the forms and pool cards mount only after a chain lookup, so their source is held here.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = readdirSync(HERE).filter((f) => f.endsWith('.tsx') && !/\.(test|fixture)\./.test(f));

/** Every place a source text moves its own top scroll edge: a Tailwind class or a style. */
function topScrollMargins(source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    for (const hit of line.match(/\bscroll-m[ty]?-[\w.[\]/-]+|\bscrollMargin(?:Top|Block|BlockStart)?\b|\bscroll-margin(?:-top|-block(?:-start)?)?\s*:/g) ?? []) {
      found.push(`line ${i + 1}: ${hit}`);
    }
  });
  return found;
}

describe('the LP section leaves the tab strip to the page', () => {
  it('reads the files that hold a scroll target', () => {
    // A scan of an empty or moved folder would pass whatever it holds.
    expect(COMPONENTS).toEqual(expect.arrayContaining(['CreatePoolCard.tsx', 'PanelFrame.tsx', 'PoolCard.tsx', 'PoolFinder.tsx', 'YourPositions.tsx']));
  });

  it('sees a top scroll margin however it is written, and nothing else', () => {
    // Tailwind reads this file too and ships a rule for every whole class name in it, so
    // each class here is joined from two halves that are not classes.
    const cls = (start: string, end: string) => start + end;
    const written = [cls('scroll-m', 't-[4.5rem]'), cls('scroll-m', 't-24'), cls('scroll-m', '-4'), cls('scroll-m', 'y-2'), 'style={{ scrollMarginTop: 72 }}', 'scroll-margin-top: 72px'];
    for (const text of written) expect(topScrollMargins(`<div className="a ${text} b" />`), text).toHaveLength(1);
    const other = [cls('scroll-m', 'b-4'), cls('scroll-p', 't-4'), "el.scrollIntoView({ block: 'start' })"];
    for (const text of other) expect(topScrollMargins(text), text).toEqual([]);
  });

  it('no component here carries a scroll margin of its own', () => {
    const found = COMPONENTS.flatMap((file) => topScrollMargins(readFileSync(join(HERE, file), 'utf-8')).map((hit) => `${file} ${hit}`));
    expect(found, 'each of these lands its target that much lower than the 18px the page already leaves under the tab strip').toEqual([]);
  });
});
