/**
 * THE PAGE COLUMN IS ONE RULE (owner, 2026-10-19): page-column in index.css, 1200px and then
 * wider as the screen is. Every 1200px host, the bar, the menu's rows, the footer and the first
 * frame's .ff-wrap (index.html) read it, so a wide screen's hero does not move when React takes
 * over and the bar's logo stays over the page's edge. This pins the steps, the frame's copy of
 * them, the room's grid flipping on the first step, and that no page carries a column of its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(FRONTEND, p), 'utf8');

/** The design: [from this window width, the column is this wide]. The base is 1200px. */
const BASE = 1200;
const STEPS: Array<[from: number, column: number]> = [
  [1536, 1360],
  [1920, 1600],
  [2560, 1800],
];

const css = read('src/index.css');
const utility = /@utility page-column \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

describe('page-column (index.css)', () => {
  it('is 1200px, then 1360px from 1536px, 1600px from 1920px and 1800px from 2560px', () => {
    expect(utility, 'index.css declares @utility page-column').not.toBe('');
    expect(/^\s*max-width:\s*(\d+)px;/m.exec(utility)?.[1]).toBe(String(BASE));
    const steps = [...utility.matchAll(/@media \(width >= (\d+)(rem|px)\) \{ max-width: (\d+)px; \}/g)]
      .map((m) => [m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]), Number(m[3])]);
    expect(steps).toEqual(STEPS);
  });

  it("takes its first step where Tailwind's 2xl does, which is where the room's cards take the grid", () => {
    // The theme is not redefined here; the variant and the utility must flip on one width.
    expect(css).not.toMatch(/--breakpoint-2xl/);
    const theme = read('node_modules/tailwindcss/theme.css');
    const twoXl = /--breakpoint-2xl:\s*(\d+)rem/.exec(theme)?.[1];
    expect(Number(twoXl) * 16).toBe(STEPS[0]![0]);
    const home = read('src/pages/HomePage.tsx');
    expect(home).toMatch(/2xl:grid 2xl:grid-cols-12/);
    expect(home).toMatch(/pb-8 2xl:col-span-8" id=\{ROOM_STOPS\.market\.id\}/);
    expect(home).toMatch(/contents 2xl:block 2xl:col-span-4/);
    expect(home).toMatch(/pb-16 2xl:col-span-12" id=\{ROOM_STOPS\.lore\.id\}/);
    // The two cards with stat tiles are told they sit in the grid; elsewhere they are as wide as the page.
    // Their second step is 120rem, not 1920px: Tailwind sorts min-width variants only within one unit.
    expect(home).toMatch(/<BungalowMarket bungalow=\{bungalowIdentity\} wideGrid \/>/);
    expect(home).toMatch(/<BungalowHolders bungalow=\{bungalowIdentity\} wideGrid=\{Boolean\(bungalowIdentity\.market\)\} \/>/);
    expect(read('src/components/bungalow/BungalowMarket.tsx')).toMatch(/lg:grid-cols-6 gap-3 mb-5\$\{wideGrid \? ' 2xl:grid-cols-3 min-\[120rem\]:grid-cols-6' : ''\}/);
    expect(read('src/components/bungalow/BungalowHolders.tsx')).toMatch(/md:grid-cols-4 gap-3\$\{wideGrid \? ' 2xl:grid-cols-2 min-\[120rem\]:grid-cols-4' : ''\}/);
  });

  it("the first frame's .ff-wrap (index.html) has the same base and the same steps", () => {
    const html = read('index.html');
    const style = html.replace(/\s+/g, '');
    expect(style).toMatch(new RegExp(`\\.ff-wrap\\{[^}]*max-width:${BASE}px`));
    const steps = [...style.matchAll(/@media\(min-width:(\d+)px\)\{\.ff-wrap\{max-width:(\d+)px\}\}/g)]
      .map((m) => [Number(m[1]), Number(m[2])]);
    expect(steps).toEqual(STEPS);
  });

  it('no page, host or layout file sets a 1200px column of its own', () => {
    const files = readdirSync(join(FRONTEND, 'src'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name))
      .map((d) => join(d.parentPath, d.name));
    const strays = files
      .filter((f) => readFileSync(f, 'utf8').includes('max-w-[1200px]'))
      .map((f) => relative(FRONTEND, f).replace(/\\/g, '/'));
    expect(strays).toEqual([]);
  });
});
