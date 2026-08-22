// Light mode does not get its own ground. Every art-backed page in this app paints a
// `fixed inset-0` layer at #060c1a and keeps it in BOTH themes (the art must never be
// removed), so `[data-theme="light"] body { background: #f5f3ff }` is almost never the
// pixel a reader actually sees. Anything that flips only the FOREGROUND for light mode
// therefore paints one theme's text onto the other theme's ground — that is the whole
// mechanism behind F45's app-wide ~1.4:1 light-mode contrast.
//
// This pins the half of F45 that does not depend on the unresolved product choice:
// a class that carries its OWN plate must take plate and foreground from the same
// theme, and the pair it declares must actually clear 4.5:1 once composited over the
// page ground. It deliberately does NOT assert anything about `.heading-luxury`, which
// has no plate of its own — see UNGUARDED below. The guard states its own coverage so
// a green run is never mistaken for "light mode is legible".

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(SRC, 'index.css'), 'utf-8');

/** The ground pages actually paint, in both themes. Its persistence is asserted below. */
const PAGE_GROUND: RGB = { r: 6, g: 12, b: 26 };

/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;

/**
 * A plate has to be opaque enough that the page ground behind it stops driving the
 * contrast. 0.7 is the alpha the two chips below already ship; anything thinner is the
 * "wash, not a ground" failure this guard exists to catch.
 */
const MIN_PLATE_ALPHA = 0.7;

/**
 * Classes that paint their own plate so they stay readable over arbitrary art.
 * These are the ones this guard can reason about without knowing the page ground model.
 */
const SELF_GROUNDED = ['label-pill', 'stat-value'] as const;

/**
 * UNGUARDED, on purpose. `.heading-luxury` has no plate: it always resolves against
 * whatever the page paints. Its light-theme navy is correct only if art-backed pages
 * gain a light scrim, and correct-to-remove only if they keep the dark murals. That is
 * an open product decision, so the class is named here instead of being silently
 * covered or silently skipped.
 */
const UNGUARDED = ['heading-luxury'] as const;

/**
 * Every `[data-theme="light"]` selector that pins a `color`, pinned as a set. A new one
 * appearing here fails the test until someone decides whether it belongs under the
 * contrast guard or on the UNGUARDED list — which is the review step that was missing
 * when the two chip overrides were added.
 */
/**
 * The mirror failure: `[data-theme="light"]` rules that flip a PLATE and leave the
 * foreground alone. `.glass*` is the load-bearing case — the plate goes from
 * rgba(6,12,26,0.93) to rgba(255,255,255,0.85) while every card's body copy is still
 * `text-white` at the callsite, which measures 1.39:1 in light mode. It cannot be fixed
 * from CSS in isolation (the foreground lives at ~100 callsites, not on the class), and
 * which half should move is the same unresolved art-ground decision as `.heading-luxury`.
 * Pinned so the set cannot grow while that decision is outstanding.
 */
const PLATE_FLIPPED_WITHOUT_FOREGROUND = [
  '[data-theme="light"] .btn-secondary:hover',   // paired with the .btn-secondary rule above it
  '[data-theme="light"] .card',
  '[data-theme="light"] .glass',
  '[data-theme="light"] .glass-card',
  '[data-theme="light"] .glass-card-animated',
  '[data-theme="light"] .glass-card-strong',
  '[data-theme="light"] .glass-card-subtle',
  '[data-theme="light"] .shimmer',               // no foreground at all
  '[data-theme="light"] .skeleton',              // no foreground at all
  '[data-theme="light"] ::-webkit-scrollbar-thumb',
  '[data-theme="light"] ::-webkit-scrollbar-thumb:hover',
];

const LIGHT_COLOR_SELECTORS = [
  '[data-theme="light"] .btn-secondary',        // opaque white plate declared in the same rule
  '[data-theme="light"] .heading-luxury',       // UNGUARDED — no plate of its own
  '[data-theme="light"] .nav-link',             // drawer/off-header, over the light surface bg
  '[data-theme="light"] .nav-link.active',
  '[data-theme="light"] .nav-link:hover',
  '[data-theme="light"] body',                  // the ground and its text, declared together
  '[data-theme="light"] footer a:hover',        // footer panel is dark in both themes
  '[data-theme="light"] header .nav-link',      // header is Kenny orange in light mode
  '[data-theme="light"] header .nav-link.active',
  '[data-theme="light"] header .nav-link:hover',
];

/* ── colour math ─────────────────────────────────────────────────────────── */

type RGB = { r: number; g: number; b: number };
type RGBA = RGB & { a: number };

function parseColor(raw: string): RGBA | null {
  const v = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => parseFloat(p.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

/** Paint `top` over `under` — what the eye actually receives. */
function composite(top: RGBA, under: RGB): RGB {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
  };
}

function luminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: RGB, bg: RGB): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── a very small CSS reader ─────────────────────────────────────────────── */

type Rule = { selector: string; decls: Map<string, string> };

function rules(): Rule[] {
  // Strip comments first so a selector-shaped string inside prose can't be read as a rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    const body = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i === -1) continue;
      body.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim());
    }
    // A selector list gets one entry per selector so exact matching stays simple.
    for (const sel of m[1].split(',')) {
      const s = sel.trim().replace(/\s+/g, ' ');
      if (s && !s.startsWith('@')) out.push({ selector: s, decls: body });
    }
  }
  return out;
}

const ALL = rules();

/** Merge every rule with this exact selector — the original defect split one chip's plate and its foreground across two rules 80 lines apart. */
function merged(selector: string): Map<string, string> {
  const acc = new Map<string, string>();
  for (const r of ALL) {
    if (r.selector === selector) for (const [k, v] of r.decls) acc.set(k, v);
  }
  return acc;
}

const plate = (decls: Map<string, string>): RGBA | null => {
  const raw = decls.get('background') ?? decls.get('background-color');
  return raw ? parseColor(raw) : null;
};

/* ── the guard ───────────────────────────────────────────────────────────── */

describe('light theme: foreground and ground resolve from the same token set', () => {
  it('the page ground this guard composites against is still what pages paint', () => {
    // If pages stop painting #060c1a in light mode, PAGE_GROUND above is a fiction and
    // every contrast number below is meaningless — fail loudly rather than pass falsely.
    const home = readFileSync(join(SRC, 'pages', 'HomePage.tsx'), 'utf-8');
    expect(home, 'HomePage no longer paints the #060c1a art ground').toMatch(/#060c1a/i);
    expect(css, 'light theme now overrides the page art ground — re-derive PAGE_GROUND')
      .not.toMatch(/\[data-theme="light"\][^{]*\.page-art[^{]*\{/);
  });

  it.each(SELF_GROUNDED)('.%s carries a plate opaque enough to own its contrast', (cls) => {
    const bg = plate(merged(`.${cls}`));
    expect(bg, `.${cls} declares no plate — it can no longer be treated as self-grounded`).toBeTruthy();
    expect(bg!.a).toBeGreaterThanOrEqual(MIN_PLATE_ALPHA);
  });

  it.each(SELF_GROUNDED)('.%s never gets half a theme flip in light mode', (cls) => {
    const base = merged(`.${cls}`);
    const light = merged(`[data-theme="light"] .${cls}`);
    if (light.size === 0) return; // inherits the base pair — both halves stay together

    const touchesColor = light.has('color');
    const lightPlate = plate(light);
    expect(
      touchesColor && lightPlate !== null,
      `[data-theme="light"] .${cls} changes only one half of the pair; ` +
        'a foreground without its plate (or a plate without its foreground) resolves ' +
        'against the page art ground instead',
    ).toBe(true);
    expect(
      lightPlate!.a,
      `[data-theme="light"] .${cls} thins the plate to a wash, so the page art ground drives the contrast`,
    ).toBeGreaterThanOrEqual(plate(base)!.a);
  });

  it.each(SELF_GROUNDED)('.%s clears AA in both themes over the page art ground', (cls) => {
    for (const selector of [`.${cls}`, `[data-theme="light"] .${cls}`]) {
      const decls = selector.startsWith('[')
        ? new Map([...merged(`.${cls}`), ...merged(selector)])
        : merged(selector);
      const fg = parseColor(decls.get('color') ?? '');
      const bg = plate(decls);
      // No declared foreground means the callsite supplies it; there is nothing to check.
      if (!fg || !bg) continue;
      const ratio = contrast(composite(fg, composite(bg, PAGE_GROUND)), composite(bg, PAGE_GROUND));
      expect(ratio, `${selector} measures ${ratio.toFixed(2)}:1 over the page art ground`)
        .toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it('discloses the classes it cannot cover', () => {
    // The unguarded class must still exist and still be theme-flipped; if someone
    // resolves the product choice by deleting the override, this fails and the list
    // gets shortened deliberately rather than drifting into a stale disclaimer.
    for (const cls of UNGUARDED) {
      expect(
        merged(`[data-theme="light"] .${cls}`).has('color'),
        `.${cls} is listed as UNGUARDED but no longer has a light-theme colour — update the list`,
      ).toBe(true);
      expect(plate(merged(`.${cls}`)), `.${cls} now has a plate — move it under the guard`).toBeNull();
    }
  });

  it('pins every light-theme colour override so a new one has to be triaged', () => {
    const found = [...new Set(
      ALL.filter((r) => r.selector.startsWith('[data-theme="light"]') && r.decls.has('color'))
        .map((r) => r.selector),
    )].sort();
    expect(found).toEqual([...LIGHT_COLOR_SELECTORS].sort());
  });

  it('pins every light-theme plate flip that leaves its foreground behind', () => {
    const found = [...new Set(
      ALL.filter((r) =>
        r.selector.startsWith('[data-theme="light"]') &&
        (r.decls.has('background') || r.decls.has('background-color')) &&
        !r.decls.has('color'),
      ).map((r) => r.selector),
    )].sort();
    expect(found).toEqual([...PLATE_FLIPPED_WITHOUT_FOREGROUND].sort());
  });
});
