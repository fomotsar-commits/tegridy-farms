import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACES } from '../lib/artSurfaces';

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
// Only STATIC string pageIds are checked; `pageId={someVar}` can't be registered and
// is intentionally skipped.

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
