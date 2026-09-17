// THE FILM, AND NOWHERE ELSE - answer ten, ruling 1, pinned at the source.
//
// This file replaces curtain.test.ts, and it is a rewrite rather than a deletion.
// The curtain was the short pass-through arrival the layout mounted over every
// cold visit; the island ruled it off the arrival ("the venue opens straight to
// the home page"), and it is deleted, not left dormant. What that file pinned
// about the FILM - its untouched timings, its phase wiring, Escape as its only
// keyboard exit, Mute and Skip - still holds and is kept here. What it pinned
// about the curtain - the pass-through, the input lift, the deadline, the
// 3,000 ms budget - described an overlay no route mounts any more, and goes.
//
// THE NEW HALF is the ruling itself, as structure: no module the layout loads can
// reach the overlay, the only thing that mounts it is the Island page's tap, and
// the arrival record that decided whether it played is gone with every reader
// and writer at once. Behaviour (a cold route mounts nothing in 5 s, "Skip intro"
// paints only on /island) is e2e/arrival.spec.ts's job; this pins the decisions.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { FILM_TIMING, T_VOID_END, T_ART_COUNT, T_ART_DURATION } from './constants';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', '..');
const src = readFileSync(join(here, 'AppLoader.tsx'), 'utf8');

/** The overlay's own style block. Scoped so a comment can never satisfy it. */
const overlayStyle = src.slice(src.indexOf('ref={overlayRef}'), src.indexOf('<canvas'));

describe('the film is the only arrival there is', () => {
  it('has no curtain variant to fall back into', () => {
    // The old default was the curtain: `full = false`. Any <AppLoader onComplete>
    // written without the prop would have put it back on a stranger's first
    // seconds. With no prop there is no default to get wrong.
    expect(src).not.toMatch(/\bfull\b\s*[=?:]/);
    expect(src).toContain('data-arrival="film"');
    expect(src).not.toContain("'curtain'");
  });

  it('takes pointer events, because click-to-crack is part of the art', () => {
    expect(overlayStyle).toContain("pointerEvents: 'auto'");
    expect(overlayStyle).not.toContain("cursor: 'pointer'");
  });

  it('keeps its controls: Mute, and a labelled Skip', () => {
    expect(src.indexOf('toggleMute()'), 'the Mute control is gone').toBeGreaterThan(0);
    expect(src).toContain('aria-label="Skip intro animation"');
  });

  it('ends only on Escape from the keyboard, so a stray key or scroll cannot dismiss it', () => {
    const lift = src.slice(src.indexOf('const lift = (e: Event) =>'), src.indexOf('}, [visible, skipIntro]);'));
    expect(lift).toContain("e.key === 'Escape'");
    expect(lift).toContain("addEventListener('keydown'");
    for (const type of ['pointerdown', 'touchstart', 'wheel', "'scroll'"]) {
      expect(lift, `${type} would dismiss a deliberate viewing`).not.toContain(type);
    }
  });

  it('arms no deadline: it is a viewing somebody chose, not a promise about time', () => {
    expect(src).not.toContain('goneBy');
    expect(src).not.toContain('overlay.animate');
  });
});

describe('the film is left exactly as it was', () => {
  it('keeps its original timings, which is the art-preservation pin', () => {
    expect(FILM_TIMING).toEqual({
      voidEnd: T_VOID_END,
      artCount: T_ART_COUNT,
      artDuration: T_ART_DURATION,
      textForm: 2000,
    });
  });

  it('spends every leg from its timing, never a retyped literal', () => {
    for (const leg of ['timing.voidEnd', 'timing.artDuration', 'timing.artCount', 'timing.textForm']) {
      expect(src).toContain(leg);
    }
    expect(src).toContain('SKIP_DISSOLVE_MS');
  });

  it('goes art -> shatter, and wordmark -> hold, with no other branch', () => {
    const artEnd = src.slice(src.indexOf('if (pieceIdx >= s.images.length) {'), src.indexOf('const img = s.images[pieceIdx]!'));
    expect(artEnd).toContain("s.phase = 'shatter';");
    expect(artEnd).not.toContain('} else {');
    const textFormEnd = src.slice(src.indexOf('if (drawTextFormPhase('), src.indexOf('/* HOLD */'));
    expect(textFormEnd).toContain("s.phase = 'hold';");
    expect(textFormEnd).not.toContain("s.phase = 'skip';");
  });
});

// ── Structure: who can reach the overlay ────────────────────────────────────
//
// Same resolution approach as components/componentsAreMounted.test.ts: static
// imports, re-exports and dynamic import() alike, because the film is lazy.

const isTest = (p: string) => /\.(test|spec)\.[tj]sx?$/.test(p);
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.[tj]sx?$/.test(p) && !/\.d\.ts$/.test(p) && !isTest(p)) acc.push(p);
  }
  return acc;
}
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}
function resolveSpecifier(fromFile: string, spec: string): string | null {
  // '@/' is the configured alias for src (vite.config.ts and vitest.config.ts). A
  // resolver that skipped it would let `import('@/components/loader/AppLoader')`
  // put the film back on every route with both guards below still green.
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const LOADER_DIR = join(SRC, 'components', 'loader') + sep;
const importsOf = (file: string) =>
  specifiersIn(readFileSync(file, 'utf8'))
    .map((s) => resolveSpecifier(file, s))
    .filter((p): p is string => p !== null);

describe('no route mounts the overlay (ruling 1)', () => {
  it('resolves every way the app can name a module: relative and the @/ alias', () => {
    const film = join(SRC, 'components', 'loader', 'AppLoader.tsx');
    const layout = join(SRC, 'components', 'layout', 'AppLayout.tsx');
    expect(resolveSpecifier(layout, '../loader/AppLoader')).toBe(film);
    expect(resolveSpecifier(layout, '@/components/loader/AppLoader')).toBe(film);
    expect(specifiersIn("const F = lazy(() => import('@/components/loader/AppLoader'));")).toEqual(['@/components/loader/AppLoader']);
  });

  it('the layout and the app shell import nothing from components/loader', () => {
    for (const shell of ['components/layout/AppLayout.tsx', 'App.tsx', 'main.tsx']) {
      const fromLoader = importsOf(join(SRC, shell)).filter((p) => p.startsWith(LOADER_DIR));
      expect(fromLoader.map(rel), `${shell} reaches the loader`).toEqual([]);
    }
  });

  it('the Island page is the only module that imports the film', () => {
    const appLoader = join(SRC, 'components', 'loader', 'AppLoader.tsx');
    const importers = walk(SRC)
      .filter((f) => !f.startsWith(LOADER_DIR))
      .filter((f) => importsOf(f).includes(appLoader))
      .map(rel);
    expect(importers).toEqual(['pages/IslandPage.tsx']);
  });

  it('the arrival record is retired with every reader and writer at once', () => {
    // `tf_loaded` decided whether the curtain played. Retiring the reader and
    // leaving a writer (the film's exits, the studios' seeds) would be a record
    // nothing reads - the half-retirement the island said never to do. Quoted
    // literals only, so a comment recording the retirement cannot trip this.
    const writers = walk(SRC).filter((f) => /['"]tf_loaded['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(writers).toEqual([]);
  });

  it('the picker opens only when asked: nothing else decides it', () => {
    // The auto-open leg used the curtain as its only delay. With no curtain it
    // would have opened over a cold TOWELI page at mount.
    const layout = readFileSync(join(SRC, 'components', 'layout', 'AppLayout.tsx'), 'utf8');
    const decision = layout.slice(layout.indexOf('const pickerOpen'), layout.indexOf('const closePicker'));
    expect(decision.trim()).toBe('const pickerOpen = pickerRequested;');
  });

  it('no welcome opens itself: every OnboardingModal the layout mounts is invited', () => {
    const layout = readFileSync(join(SRC, 'components', 'layout', 'AppLayout.tsx'), 'utf8');
    // Sliced to each mount's own "/>", not matched with [^>]*: the props carry
    // arrow functions, and the first ">" of an "=>" ends a naive match early.
    const mounts: string[] = [];
    for (let at = layout.indexOf('<OnboardingModal'); at !== -1; at = layout.indexOf('<OnboardingModal', at + 1)) {
      mounts.push(layout.slice(at, layout.indexOf('/>', at) + 2));
    }
    expect(mounts.length).toBeGreaterThan(0);
    // The boolean prop itself. A substring match passed on `invitedOpen` alone, and
    // OnboardingModal opens by its own first-visit rule unless `invited` is set.
    const invited = /\sinvited(?:=\{true\})?(?=[\s/>])/;
    expect('<OnboardingModal invitedOpen={x} onInvitedClose={() => y()} />').not.toMatch(invited);
    expect('<OnboardingModal invited invitedOpen={x} />').toMatch(invited);
    for (const m of mounts) expect(m, 'a welcome that opens unasked').toMatch(invited);
  });
});
