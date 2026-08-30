import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
});
