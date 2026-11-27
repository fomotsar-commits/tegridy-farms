import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cityRooms } from '../../hooks/useCityReads';
import { buildPlan } from './plan';
import { RENDER, closeUpSrc } from './render';
import FINGERPRINTS from './renderFingerprints.json';

// The city's pictures keep their names each time they are rendered again, and a browser keeps
// each for a week without asking (frontend/vercel.json). So the page links every picture by its
// contents' fingerprint, and a new picture is a new link (owner, 2026-11-21: a returning visitor
// still saw the grid island under the new layout's plaques). scripts/city-render/render_all.py
// writes the fingerprints after every render; `python render_all.py fingerprints` writes only them.
const CITY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'city');
const pictures = (): string[] => ['island.webp', 'island-half.webp', ...readdirSync(join(CITY, 'close')).filter((f) => f.endsWith('.webp')).map((f) => `close/${f}`)];
const print = (file: string): string => createHash('sha256').update(readFileSync(join(CITY, file))).digest('hex').slice(0, 10);

describe('the city links each picture by what is in it', () => {
  it('holds every picture\'s fingerprint as it is now, and none for a picture that is gone', () => {
    expect(FINGERPRINTS).toEqual(Object.fromEntries(pictures().map((f) => [f, print(f)])));
  });

  it('puts the fingerprint on the island and on every close-up', () => {
    expect(RENDER.full.src).toBe(`/city/island.webp?v=${print('island.webp')}`);
    expect(RENDER.half.src).toBe(`/city/island-half.webp?v=${print('island-half.webp')}`);
    for (const p of buildPlan(cityRooms()).plots) expect(closeUpSrc(p.id)).toBe(`/city/close/${p.id}.webp?v=${print(`close/${p.id}.webp`)}`);
  });
});
