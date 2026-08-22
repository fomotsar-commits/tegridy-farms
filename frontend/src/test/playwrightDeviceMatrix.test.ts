// The three-device requirement, made non-optional.
//
// The standing requirement is desktop + phone + tablet. The config carried
// Desktop Chrome and Pixel 5 — two Chromium projects and no WebKit at all, on
// a product whose users open it from an iPhone. A matrix can be quietly
// reduced back to that in one line, and nothing would have noticed.
//
// What is pinned:
//   * an iPhone project and an iPad project exist, from Playwright's own
//     device descriptors (which carry the real WebKit engine, viewport, DPR
//     and touch flags — a Chromium wearing an iPhone viewport is the matrix
//     lying about what it covers);
//   * ci.yml installs the webkit browser those projects need, or they fail
//     with "browser not installed" and someone deletes them;
//   * the WebKit exclusion list is exactly the set of tests that assert
//     `expect(pageErrors).toEqual([])` — an engine-level difference in how
//     unhandled fetch rejections are reported, documented at the list — and
//     not one test more. A broad exclusion is how a matrix becomes decorative.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config, { WEBKIT_EXCLUDED_TEST_TITLES } from '../../playwright.config';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E2E_DIR = join(FRONTEND, 'e2e');
const CI_PATH = join(FRONTEND, '..', '.github', 'workflows', 'ci.yml');

const projects = () => config.projects ?? [];
const byName = (name: string) => projects().find((p) => p.name === name);

describe('the device matrix covers three device classes', () => {
  it('has a desktop project', () => {
    expect(byName('chromium')?.use?.viewport?.width ?? 0).toBeGreaterThanOrEqual(1024);
  });

  it('has an iPhone project running WebKit', () => {
    const p = byName('iphone-safari');
    expect(p, 'no iphone-safari project — the three-device requirement is not met').toBeTruthy();
    expect(p!.use?.defaultBrowserType, 'the iPhone project is not on WebKit, which is the only engine iOS ships').toBe(
      'webkit',
    );
    expect(p!.use?.hasTouch).toBe(true);
    expect(p!.use?.viewport?.width ?? 0).toBeLessThan(768);
  });

  it('has an iPad project running WebKit at a tablet width', () => {
    const p = byName('ipad-safari');
    expect(p, 'no ipad-safari project — the three-device requirement is not met').toBeTruthy();
    expect(p!.use?.defaultBrowserType).toBe('webkit');
    expect(p!.use?.hasTouch).toBe(true);
    // At or above Tailwind's md: breakpoint but touch-only — the combination
    // neither the desktop nor the phone project produces.
    expect(p!.use?.viewport?.width ?? 0).toBeGreaterThanOrEqual(768);
  });
});

describe('ci.yml can actually run the matrix it declares', () => {
  it('installs every browser engine the projects name', () => {
    const ci = readFileSync(CI_PATH, 'utf-8');
    const installs = [...ci.matchAll(/playwright install[^\n]*/g)].map((m) => m[0]);
    expect(installs.length, 'no playwright install step found in ci.yml').toBeGreaterThan(0);
    const engines = new Set(projects().map((p) => p.use?.defaultBrowserType ?? 'chromium'));
    for (const engine of engines) {
      expect(
        installs.some((line) => line.includes(engine)),
        `playwright.config.ts declares a ${engine} project but no ci.yml step installs ${engine}; ` +
          'the job fails with "browser not installed"',
      ).toBe(true);
    }
  });
});

describe('the WebKit exclusion list cannot silently widen', () => {
  /** Every e2e test title whose body asserts `expect(pageErrors).toEqual([])`. */
  const pageErrorAssertingTitles = (): string[] => {
    const found: string[] = [];
    for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))) {
      const src = readFileSync(join(E2E_DIR, file), 'utf-8');
      const marks: { at: number; title: string }[] = [];
      const re = /^ {2}test\(\s*'([^']+)'/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) marks.push({ at: m.index, title: m[1] });
      marks.forEach((mark, i) => {
        const body = src.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : src.length);
        if (body.includes('expect(pageErrors)')) found.push(mark.title);
      });
    }
    return found.sort();
  };

  it('finds the specs at all (guards the guard)', () => {
    expect(readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts')).length).toBeGreaterThan(5);
    expect(pageErrorAssertingTitles().length).toBeGreaterThan(0);
  });

  it('excludes exactly the pageErrors assertions — no more, no fewer', () => {
    expect(
      [...WEBKIT_EXCLUDED_TEST_TITLES].sort(),
      'the WebKit exclusion list has drifted from the specs. A title that stopped asserting ' +
        'pageErrors must come off the list (it is being skipped for no reason); a title that ' +
        'started asserting it must go on, with the reasoning at the list in playwright.config.ts.',
    ).toEqual(pageErrorAssertingTitles());
  });

  it('applies the exclusion only to the WebKit projects', () => {
    for (const p of projects()) {
      const webkit = p.use?.defaultBrowserType === 'webkit';
      expect(Boolean(p.grepInvert), `${p.name} grepInvert`).toBe(webkit);
    }
  });

  it('leaves the pageErrors contract gated on the Chromium projects', () => {
    const chromium = projects().filter((p) => (p.use?.defaultBrowserType ?? 'chromium') === 'chromium');
    expect(chromium.length, 'no Chromium project still runs the excluded assertions').toBeGreaterThan(0);
    for (const p of chromium) expect(p.grepInvert).toBeUndefined();
  });
});
