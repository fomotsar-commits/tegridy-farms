import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACES, PAGE_ROUTES } from '../lib/artSurfaces';

// COVERAGE GUARD for the art-studio surface inventory.
//
// The studio's SURFACES list (lib/artSurfaces.ts, shared by /art-studio and
// /bayla-studio) is hand-maintained, so it drifts:
// a page adds an <ArtImg pageId=".."> or <PageArtBackdrop pageId=".."> and forgets
// to register it, and that card silently becomes invisible/unadjustable in the tool
// (found 9 such surfaces on 2026-07-25). This test fails the build if any statically
// referenced pageId is used in app code but missing from the inventory — so "identify
// every card in the studio" stays true automatically.
//
// The two guards in THIS block read static string pageIds only. `pageId={someVar}`
// used to be skipped everywhere, which is how venue-home:0 — the venue's own home
// hero — went unregistered; the block at the bottom of this file resolves the
// computed form and checks both directions.

// vitest runs from the frontend project root, so cwd/src is the source tree.
const SRC = join(process.cwd(), 'src');
const STUDIO_FILE = join(SRC, 'lib', 'artSurfaces.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...sourceFiles(p));
    } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|stories)\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('art-studio surface coverage', () => {
  it('every static ArtImg / pageArt / PageArtBackdrop pageId is registered in the studio SURFACES inventory', () => {
    const used = new Set<string>();
    const registered = new Set<string>();

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      // USED: JSX prop  pageId="x" | pageId='x'  (covers ArtImg + PageArtBackdrop)
      for (const m of src.matchAll(/pageId=["']([a-z0-9-]+)["']/g)) used.add(m[1]);
      // USED: pageArt('x', ...) with a string-literal id
      for (const m of src.matchAll(/pageArt\(\s*["']([a-z0-9-]+)["']/g)) used.add(m[1]);
      // REGISTERED: object-literal  pageId: 'x'  — only inside the studio inventory file
      if (file === STUDIO_FILE) {
        for (const m of src.matchAll(/pageId:\s*['"]([a-z0-9-]+)['"]/g)) registered.add(m[1]);
      }
    }

    expect(used.size, 'sanity: should find many used pageIds').toBeGreaterThan(20);
    expect(registered.size, 'sanity: SURFACES should be populated').toBeGreaterThan(20);

    const missing = [...used].filter((p) => !registered.has(p)).sort();
    expect(
      missing,
      `pageIds used in app code but NOT registered in ArtStudioPage SURFACES (add them so the studio can see these cards): ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  // The pageId-level guard above passes as soon as ONE idx of a page is
  // registered, so a page could render 8 cards while the studio listed 1 — and
  // did: on 2026-08-31 the Contracts page's 7 group cards, the Treasury page's
  // 4 stat tiles, both feature-gated Home cards and the Pools backdrop were all
  // invisible in the tool while their pageIds looked "covered".
  //
  // This guard works at (pageId, idx). Only LITERAL indices are checked —
  // `idx={groupIdx + 1}` cannot be resolved without evaluating the page, so
  // loop-driven surfaces stay the reviewer's job. That still pins every
  // hand-written surface, which is where the drift came from.
  it('every static (pageId, idx) pair is registered, not just the pageId', () => {
    const used = new Map<string, string>(); // "pageId|idx" -> first call site
    for (const file of sourceFiles(SRC)) {
      if (file === STUDIO_FILE) continue;
      const src = readFileSync(file, 'utf8');
      const where = (i: number) => `${file.split(/[\\/]/).pop()}:${src.slice(0, i).split('\n').length}`;
      const add = (id: string, idx: string, at: string) => {
        if (!/^\d+$/.test(idx)) return; // computed index — not statically knowable
        const key = `${id}|${idx}`;
        if (!used.has(key)) used.set(key, at);
      };
      // <ArtImg pageId="x" ... idx={N}> / <PageArtBackdrop pageId="x" idx={N}>
      for (const m of src.matchAll(/pageId=["']([a-z0-9-]+)["'][\s\S]{0,240}?idx=\{([^}]+)\}/g)) {
        add(m[1]!, m[2]!.trim(), where(m.index!));
      }
      // pageArt('x', N)
      for (const m of src.matchAll(/pageArt\(\s*["']([a-z0-9-]+)["']\s*,\s*([^),]+)\)/g)) {
        add(m[1]!, m[2]!.trim(), where(m.index!));
      }
    }

    const registered = new Set(SURFACES.map((s) => `${s.pageId}|${s.idx}`));
    expect(used.size, 'sanity: should find many used (pageId, idx) pairs').toBeGreaterThan(100);

    const missing = [...used.keys()].filter((k) => !registered.has(k)).sort();
    expect(
      missing,
      `surfaces rendered by app code but NOT registered in SURFACES — the studio cannot see or place these cards:\n${
        missing.map((k) => `  ${k.replaceAll('|', ' idx ')}  (${used.get(k)})`).join('\n') || '  (none)'
      }`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The OTHER direction: registered but rendered nowhere.
//
// Both guards above only ever ask "is everything the app renders in the list?".
// Nothing asked the reverse, and the list drifted the other way for months: on
// 2026-09-13 it carried 54 surfaces the app no longer rendered — 17 Solana-swap
// trending cards, 5 Deployer cards, 5 Launch-sim cards, every /exposure and
// /scan card (both routes now render TrustPage, which paints no art at all),
// and whole retired pageIds (gallery, solana-launch, upcoming-pools).
//
// A curator opening a bungalow studio saw all of them. They are worse than
// clutter: each one accepts a pick, writes an override, and paints nothing —
// so time spent placing art there is silently thrown away, and the resulting
// override key sits in bungalowArtOverrides.ts forever pointing at no surface.
//
// Two things this guard needs that the scanners above do not have, both learned
// by getting the answer wrong first:
//
//   1. FIVE components resolve art, not two. ArtCard alone has 18 call sites,
//      and pageId 'wizard' looked dead until it turned up in one of them.
//      PageArtBackdrop, FeatureNotDeployed and WrongChainScreen default idx to
//      0, so `<PageArtBackdrop pageId="x" />` renders surface (x, 0) with no
//      idx prop anywhere in the tag.
//   2. A JSX tag cannot be matched with `[^>]*`. Any prop holding an arrow
//      function contains a `>`, which truncates the match and pairs a pageId
//      with an idx belonging to a different tag entirely. TAG_AT below walks
//      the tag tracking brace and quote depth instead.
// ─────────────────────────────────────────────────────────────────────────────

/** Components that resolve art, and the idx they use when the prop is absent. */
const ART_TAGS: Record<string, { idxProp: string; defaultIdx: string | null; defaultPageId?: string }> = {
  ArtImg: { idxProp: 'idx', defaultIdx: null }, // idx is required
  ArtCard: { idxProp: 'idx', defaultIdx: null }, // idx is required
  PageArtBackdrop: { idxProp: 'idx', defaultIdx: '0' },
  FeatureNotDeployed: { idxProp: 'idx', defaultIdx: '0' },
  WrongChainScreen: { idxProp: 'artIdx', defaultIdx: '0', defaultPageId: 'admin' },
};

/** Text of the JSX tag opening at `start`, tracking braces and quotes. */
function tagAt(s: string, start: number): string | null {
  let i = start;
  let depth = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return s.slice(start, i + 1);
    i++;
  }
  return null;
}

/**
 * Every surface the app renders, resolved as far as static reading allows.
 * Returns the (pageId, idx) pairs with a call site each, plus the pageIds whose
 * idx is loop-driven and therefore cannot be enumerated without running the page.
 */
function scanRenderedSurfaces(): { rendered: Map<string, string>; computedIdx: Set<string> } {
  const rendered = new Map<string, string>(); // "pageId|idx" -> first call site
  const computedIdx = new Set<string>();

  for (const file of sourceFiles(SRC)) {
    if (file === STUDIO_FILE) continue;
    const src = readFileSync(file, 'utf8');
    const where = (i: number) => `${file.split(/[\\/]/).pop()}:${src.slice(0, i).split('\n').length}`;

    const note = (id: string, idx: string | null, at: string) => {
      if (!id || idx === null) return;
      if (!/^\d+$/.test(idx)) computedIdx.add(id);
      else if (!rendered.has(`${id}|${idx}`)) rendered.set(`${id}|${idx}`, at);
    };

    for (const [name, spec] of Object.entries(ART_TAGS)) {
      for (const m of src.matchAll(new RegExp(`<${name}(?=[\\s/>])`, 'g'))) {
        const tag = tagAt(src, m.index!);
        if (!tag) continue;
        const at = where(m.index!);
        const raw = tag.match(new RegExp(`\\b${spec.idxProp}=\\{([^}]*)\\}`))?.[1]?.trim();
        const idx = raw === undefined ? spec.defaultIdx : raw;

        const literal = tag.match(/\bpageId=["']([a-z0-9-]+)["']/)?.[1];
        if (literal) { note(literal, idx, at); continue; }

        const expr = tag.match(/\bpageId=\{([\s\S]*?)\}/)?.[1];
        if (expr === undefined) { note(spec.defaultPageId ?? '', idx, at); continue; }

        // `pageId={expr}` — a computed pageId is still a real surface, and two
        // of the app's most-seen ones are reachable ONLY this way: HomePage's
        // `? 'home' : 'venue-home'`, and the `const PAGE_ID = 'eth-curve'` on
        // both curve pages. Neither was registered before 2026-09-13 precisely
        // because every scanner here skipped the computed form.
        for (const lit of expr.matchAll(/["']([a-z0-9-]+)["']/g)) note(lit[1]!, idx, at);
        for (const ident of expr.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
          const c = src.match(new RegExp(`\\bconst\\s+${ident[1]}\\s*=\\s*["']([a-z0-9-]+)["']`));
          if (c) note(c[1]!, idx, at);
        }
        // Anything still unresolved is a plain prop forward inside the art
        // components themselves (`<ArtImg pageId={pageId} …>`); the call site
        // that supplies the real value is scanned on its own.
      }
    }

    for (const m of src.matchAll(/pageArt\(\s*["']([a-z0-9-]+)["']\s*(?:,\s*([^),]+))?\)/g)) {
      note(m[1]!, (m[2] ?? '0').trim(), where(m.index!));
    }
  }

  return { rendered, computedIdx };
}

describe('art-studio surface inventory matches what the app renders', () => {
  const { rendered, computedIdx } = scanRenderedSurfaces();

  it('resolves a plausible number of surfaces (guards the scanner itself)', () => {
    // If a refactor renames an art component or changes how idx is passed, this
    // number collapses and every check below would pass vacuously.
    expect(rendered.size).toBeGreaterThan(250);
  });

  it('every registered (pageId, idx) is actually rendered somewhere in app code', () => {
    const dead = SURFACES.filter(
      (s) => !computedIdx.has(s.pageId) && !rendered.has(`${s.pageId}|${s.idx}`),
    );
    expect(
      dead.map((s) => `${s.pageId} idx ${s.idx}`).sort(),
      `SURFACES entries that no app code renders — the studio shows these cards but a pick made ` +
        `on one paints nothing and writes a dead override key. Remove them from lib/artSurfaces.ts ` +
        `(and drop the PAGE_ROUTES entry for any pageId that loses its last surface):\n${
          dead.map((s) => `  ${s.pageId} idx ${s.idx}  [${s.group}]  ${s.label}`).join('\n') || '  (none)'
        }`,
    ).toEqual([]);
  });

  // The forward guards above only see `pageId="literal"`, so a surface reached
  // through a computed pageId could render forever without ever being listed —
  // which is exactly what happened to venue-home:0, the venue's own hero, and
  // to eth-curve:0. Both carried art picks that no studio could show or edit.
  it('every rendered surface is registered, including the ones behind a computed pageId', () => {
    const missing = [...rendered.keys()]
      .filter((k) => { const [id, idx] = k.split('|'); return !SURFACES.some((s) => s.pageId === id && s.idx === +idx); })
      .sort();
    expect(
      missing,
      `surfaces the app renders that SURFACES does not list — neither studio can see or place ` +
        `these cards:\n${
          missing.map((k) => `  ${k.replaceAll('|', ' idx ')}  (${rendered.get(k)})`).join('\n') || '  (none)'
        }`,
    ).toEqual([]);
  });

  it('every PAGE_ROUTES key still owns at least one surface', () => {
    const withSurfaces = new Set(SURFACES.map((s) => s.pageId));
    const orphaned = Object.keys(PAGE_ROUTES).filter((id) => !withSurfaces.has(id)).sort();
    expect(
      orphaned,
      `PAGE_ROUTES names pageIds that have no surface in SURFACES — a live-preview route for a ` +
        `card the studio no longer lists: ${orphaned.join(', ') || '(none)'}`,
    ).toEqual([]);
  });
});
