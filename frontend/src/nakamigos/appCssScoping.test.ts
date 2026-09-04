import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * App.css IS A GLOBAL STYLESHEET, whether or not it looks like one.
 *
 * main.tsx:30 imports './nakamigos/App.css' eagerly, AFTER './index.css' at
 * main.tsx:19 — deliberately, because importing it inside the lazy marketplace
 * chunk made Vite emit a <link rel="modulepreload"> for the CSS that 404s on the
 * Vercel edge. That fix is correct and should stay. Its consequence is that every
 * unscoped selector in this file applies to the WHOLE APP, and at equal
 * specificity it beats index.css purely on source order.
 *
 * WHAT THAT COST (found 2026-09-03, measured in-browser):
 *   .stat-value  — flattened every stat in the app to 14px Inter on desktop and
 *                  12px on phones. 31 elements on /farm alone, and `text-lg` /
 *                  `text-xl` / `text-2xl` all rendered identically because a
 *                  plain class selector outranks Tailwind's layered utilities.
 *                  `var(--display)` is only defined on .nakamigos-app, so it also
 *                  silently wiped index.css:385's JetBrains Mono face.
 *   .btn-primary — inside `@media (max-width: 480px)`, shrank EVERY primary and
 *                  secondary button in the app to 10px on phones, including the
 *                  header Connect button, while fighting index.css's own 44px
 *                  minimum tap target for those same elements.
 *
 * Both were invisible in review: the file reads as marketplace-local, the damage
 * appears on pages that never import it, and no test covered the cascade.
 *
 * WHAT THIS TEST PINS: any selector in App.css whose subject is a class name the
 * rest of the app also uses must be scoped under `.nakamigos-app` (applied at
 * App.jsx:1136). Marketplace-only names (.wallet-btn, .nav-tab, .card-price, …)
 * are unaffected and need no prefix — the guard is deliberately a small
 * allow-list of KNOWN-SHARED names rather than "scope everything", so it stays
 * quiet for ordinary marketplace work and speaks up only for a real collision.
 *
 * ADDING A NAME HERE: if you introduce a class in App.css that also exists in
 * index.css or in src/components, add it to SHARED_WITH_APP. If you are unsure,
 * grep for it outside src/nakamigos — a hit means it belongs here.
 *
 * MUTATION CHECK (verified 2026-09-03): removing the `.nakamigos-app ` prefix
 * from any one of the four scoped rule groups reds this suite, naming the line.
 */

const SHARED_WITH_APP = [
  'stat-value',
  'stat-label',
  'btn-primary',
  'btn-secondary',
];

/**
 * `.sr-only` is deliberately NOT on the list. App.css:3619 defines it, and so
 * does index.css:729 — but the two declarations are the identical
 * visually-hidden recipe, so whichever wins produces the same rendering. It is a
 * duplicate, not a collision. Kept here as a note so nobody "fixes" it and then
 * wonders what changed.
 */

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'App.css');

/**
 * Blank out /* … *\/ comments while preserving line count and column offsets, so
 * reported line numbers stay accurate and prose ABOUT a selector is never
 * mistaken for the selector. (Checking whether a line "looks like" a comment
 * does not work here: these blocks run several lines, and only the first starts
 * with a comment marker.)
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

describe('nakamigos/App.css must not leak app-wide class names', () => {
  const lines = stripComments(readFileSync(CSS_PATH, 'utf8')).split('\n');
  const rawLines = readFileSync(CSS_PATH, 'utf8').split('\n');

  for (const name of SHARED_WITH_APP) {
    it(`.${name} is only ever styled under .nakamigos-app`, () => {
      const offenders: string[] = [];

      lines.forEach((line, i) => {
        // Selector position only. A declaration value can't produce a false hit:
        // the class token must appear before the rule's `{`, and a line that is
        // purely declarations has no `{` at all.
        if (!line.includes(`.${name}`)) return;
        const selectorPart = line.includes('{') ? line.slice(0, line.indexOf('{')) : line;
        if (!selectorPart.includes(`.${name}`)) return;

        // A multi-selector rule is comma-split across lines as often as not, so
        // judge THIS line's own comma-part: the one carrying our class must also
        // carry the scope.
        const part = selectorPart.split(',').find((p) => p.includes(`.${name}`)) ?? selectorPart;

        // `.foo-bar` must not match a query for `.foo`.
        const boundary = new RegExp(`\\.${name}(?![\\w-])`);
        if (!boundary.test(part)) return;

        if (!part.includes('.nakamigos-app')) {
          offenders.push(`  App.css:${i + 1}  ${rawLines[i]!.trim()}`);
        }
      });

      expect(
        offenders,
        `.${name} is used app-wide (index.css and src/components), and App.css is imported globally at ` +
        `main.tsx:30 AFTER index.css — so an unscoped rule here restyles the entire app.\n` +
        `Prefix each of these with ".nakamigos-app ":\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('the .nakamigos-app wrapper these rules depend on still exists', () => {
    // Every scoping above is inert if the wrapper class is renamed or dropped.
    const appJsx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.jsx'), 'utf8');
    expect(appJsx).toContain('className="nakamigos-app"');
  });
});
