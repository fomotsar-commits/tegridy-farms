// The app is DARK-ONLY. This guards that, and guards the one fact the deleted
// light-mode contrast suite was actually built on.
//
// ─── WHAT THIS FILE USED TO BE ──────────────────────────────────────────────
//
// `lightThemeContrast.test.ts` pinned the half of F45 (the app-wide ~1.4:1
// light-mode contrast defect) that did not depend on an unresolved product
// choice. Its mechanism was worth recording even though the theme is gone:
//
//   Every art-backed page paints a `fixed inset-0` layer at #060c1a and keeps it
//   in BOTH themes, because the art must never be removed. So a rule that flipped
//   only the FOREGROUND for light mode painted one theme's text onto the other
//   theme's ground. That is where the 1.4:1 came from — not from any single
//   badly-chosen colour, but from half-flips composited over a ground that never
//   changed.
//
// On 2026-08-23 the operator chose to DROP light mode rather than re-tune every
// surface for it. The 23 `[data-theme="light"]` rule blocks were removed from
// index.css, ThemeContext pins dark and clears any stored 'light' choice, and the
// header toggle is gone.
//
// ─── WHY THIS FILE STILL EXISTS ─────────────────────────────────────────────
//
// Deleting the suite outright would have removed a live assertion (the page
// ground is still real and still load-bearing for every contrast decision in the
// app) and left nothing standing between the repo and someone re-adding light CSS
// without re-doing the contrast work. Both are guarded below.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const cssRaw = readFileSync(join(SRC, 'index.css'), 'utf-8');
/**
 * Comments stripped before scanning. The note left where the light block used to
 * live NAMES `[data-theme="light"]` in prose, and the first version of the tripwire
 * below matched it — a guard that fires on its own documentation is a guard nobody
 * keeps. Scan the rules, not the reasons.
 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the app is dark-only', () => {
  it('ships no light-theme CSS', () => {
    // The tripwire. Re-adding `[data-theme="light"]` rules without re-deriving the
    // contrast work reintroduces F45 exactly — a foreground flip over a page ground
    // that does not flip. If light mode genuinely comes back, restore the contrast
    // suite from git history (it was `lightThemeContrast.test.ts`) in the same
    // change, do not just delete this assertion.
    const rules = [...css.matchAll(/\[data-theme="light"\][^{]*\{/g)].map((m) => m[0].trim());
    expect(rules, 'light-theme CSS is back but the contrast guard that covered it is not').toEqual([]);
  });

  it('pins the theme to dark and clears any stored light choice', () => {
    // A returning visitor who had toggled light still has `tegridy-theme: 'light'`
    // in localStorage. Ignoring it is not enough — the value must be REMOVED, or a
    // future light implementation under different rules inherits a stale opt-in.
    const ctx = readFileSync(join(SRC, 'contexts', 'ThemeContext.tsx'), 'utf-8');
    expect(ctx, 'ThemeContext no longer pins data-theme="dark"').toMatch(/setAttribute\('data-theme', 'dark'\)/);
    expect(ctx, 'the stored light choice is no longer cleared').toMatch(/removeItem\(STORAGE_KEY\)/);
    expect(ctx, 'a theme toggle is back without light CSS behind it').not.toMatch(/toggleTheme/);
  });

  it('still paints the #060c1a art ground every contrast decision assumes', () => {
    // Kept verbatim from the old suite. This is the fact the whole F45 analysis
    // rested on, and it is just as load-bearing dark-only: components that declare a
    // translucent plate composite against THIS, not against `body`.
    const home = readFileSync(join(SRC, 'pages', 'HomePage.tsx'), 'utf-8');
    expect(home, 'HomePage no longer paints the #060c1a art ground').toMatch(/#060c1a/i);
  });
});
