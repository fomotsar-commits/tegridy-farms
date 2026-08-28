import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';

// scripts/render-bungalow-doors.mjs is deliberately self-contained (it runs
// under Vercel's Node with no TS loader), which means its DOORS manifest can
// drift from the registry. These tests are the lock-step: a bungalow that
// gains a token-first identity must gain a door unfurl in the same change,
// and a door can never point at an id or an og image that doesn't exist.

const scriptPath = resolve(process.cwd(), 'scripts/render-bungalow-doors.mjs');
const script = readFileSync(scriptPath, 'utf8');
const doorPaths = [...script.matchAll(/^\s*path: '([a-z0-9-]+)',$/gm)].map((m) => m[1]!);
const ogImages = [...script.matchAll(/^\s*image: '([^']+)',$/gm)].map((m) => m[1]!);

describe('bungalow door unfurls (scripts/render-bungalow-doors.mjs)', () => {
  it('covers every non-default bungalow that carries a token-first identity', () => {
    const needDoors = BUNGALOWS
      .filter((b) => b.live && b.identity && b.id !== DEFAULT_BUNGALOW_ID)
      .map((b) => b.id);
    for (const id of needDoors) {
      expect(doorPaths, `identity bungalow '${id}' needs a DOORS entry in the postbuild script`).toContain(id);
    }
  });

  it('covers every SETTLED token bungalow — since 2026-08-28 their doors are landings with their own unfurl', () => {
    const settled = BUNGALOWS
      .filter((b) => !b.live && b.address && b.id !== DEFAULT_BUNGALOW_ID)
      .map((b) => b.id);
    expect(settled.length).toBeGreaterThan(0);
    for (const id of settled) {
      expect(doorPaths, `settled bungalow '${id}' needs a DOORS entry in the postbuild script`).toContain(id);
    }
  });

  it('never invents a door for an id outside the island registry', () => {
    const ids = new Set(BUNGALOWS.map((b) => b.id));
    for (const p of doorPaths) {
      expect(ids.has(p), `door '${p}' is not an island slug`).toBe(true);
    }
  });

  it('ships every og image it references', () => {
    expect(ogImages.length).toBeGreaterThanOrEqual(doorPaths.length);
    for (const img of ogImages) {
      expect(existsSync(resolve(process.cwd(), `public${img}`)), `${img} must exist in public/`).toBe(true);
    }
  });

  it('keeps the vercel door cache-headers rule in step with the registry slugs', () => {
    const vercel = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');
    const rule = vercel.match(/"source": "\/\(([a-z0-9|-]+)\)",\s*\n\s*"headers": \[\s*\n\s*\{ "key": "Cache-Control", "value": "no-cache/);
    expect(rule, 'door no-cache headers rule missing from vercel.json').toBeTruthy();
    const covered = new Set(rule![1]!.split('|'));
    for (const b of BUNGALOWS) {
      expect(covered.has(b.id), `vercel door headers rule misses '${b.id}'`).toBe(true);
    }
    expect(covered.has('towelie'), 'the towelie alias needs the no-cache rule too').toBe(true);
  });
});
